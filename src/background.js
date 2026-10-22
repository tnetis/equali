/**
 * Service worker: owns the capture session and brokers messages between the
 * popup and the offscreen document that actually processes the audio.
 */

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_REASONS = ['USER_MEDIA', 'AUDIO_PLAYBACK'];
const OFFSCREEN_JUSTIFICATION =
  'Procesar el audio de la pestaña con el ecualizador y reproducirlo.';

/** Open UI ports, used to push spectrum frames at ~10 Hz. */
const uiPorts = new Set();

/** Tab currently captured, mirrored into storage.session so it survives a SW restart. */
let activeTabId = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hasOffscreen() {
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!chrome.offscreen) {
    throw new Error(
      'Este navegador no soporta documentos offscreen (Chromium 109+). Actualiza Chrome, Brave o Helium.'
    );
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: OFFSCREEN_REASONS,
    justification: OFFSCREEN_JUSTIFICATION
  });
}

/**
 * The offscreen document loads asynchronously, so the first message can land
 * before its listener exists. Retry instead of racing.
 */
async function sendToOffscreen(message, attempts = 25) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
    } catch (error) {
      lastError = error;
      await sleep(80);
    }
  }
  throw lastError ?? new Error('El documento de audio no responde.');
}

async function setBadge(on) {
  try {
    await chrome.action.setBadgeText({ text: on ? 'EQ' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dda14f' });
  } catch {
    /* badge is cosmetic */
  }
}

async function getStatus() {
  const present = await hasOffscreen();

  if (!present) {
    if (activeTabId !== null) {
      activeTabId = null;
      await chrome.storage.session.remove('activeTabId');
    }
    return { active: false, tabId: null };
  }

  // The service worker can be terminated while the offscreen document keeps
  // playing, so recover the tab id instead of reporting "not capturing".
  if (activeTabId === null) {
    const stored = await chrome.storage.session.get('activeTabId');
    activeTabId = typeof stored.activeTabId === 'number' ? stored.activeTabId : null;
  }

  return { active: activeTabId !== null, tabId: activeTabId };
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch {
    /* already gone */
  }
}

async function startCapture(tabId, streamId, settings) {
  if (!tabId || !streamId) throw new Error('Faltan datos de la pestaña.');

  if (activeTabId !== null && activeTabId !== tabId) {
    await stopCapture();
  }

  await ensureOffscreen();

  let result;
  try {
    result = await sendToOffscreen({ type: 'START', streamId, settings });
  } catch (error) {
    await closeOffscreen();
    throw error;
  }

  if (!result?.ok) {
    // Do not leave an idle offscreen document behind on failure.
    await closeOffscreen();
    throw new Error(result?.error || 'No se pudo iniciar la captura.');
  }

  activeTabId = tabId;
  await chrome.storage.session.set({ activeTabId: tabId });
  if (settings) await chrome.storage.local.set({ eqSettings: settings });
  await setBadge(true);
  return { ok: true, active: true, tabId };
}

async function stopCapture() {
  try {
    await sendToOffscreen({ type: 'STOP' }, 3);
  } catch {
    /* document may already be gone */
  }
  await closeOffscreen();
  activeTabId = null;
  await chrome.storage.session.remove('activeTabId');
  await setBadge(false);
  return { ok: true, active: false, tabId: null };
}

async function broadcastStatus() {
  const status = await getStatus();
  for (const port of uiPorts) {
    try {
      port.postMessage({ type: 'STATUS', ...status });
    } catch {
      uiPorts.delete(port);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  if (message.target === 'offscreen') return; // addressed elsewhere

  switch (message.type) {
    case 'GET_STATUS':
      getStatus().then(sendResponse);
      return true;

    case 'START':
      startCapture(message.tabId, message.streamId, message.settings)
        .then((reply) => {
          broadcastStatus();
          sendResponse(reply);
        })
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;

    case 'STOP':
      stopCapture()
        .then((reply) => {
          broadcastStatus();
          sendResponse(reply);
        })
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;

    case 'SETTINGS':
      // The popup owns persistence; writing here too would double every slider
      // move into chrome.storage.
      if (message.settings) {
        sendToOffscreen({ type: 'SETTINGS', settings: message.settings }, 3).catch(() => {});
      }
      sendResponse({ ok: true });
      return true;

    // ---- from the offscreen document -------------------------------------
    case 'SPECTRUM': {
      if (!uiPorts.size) return;
      const payload = { type: 'SPECTRUM', bins: message.bins };
      for (const port of uiPorts) {
        try {
          port.postMessage(payload);
        } catch {
          uiPorts.delete(port);
        }
      }
      return;
    }

    case 'TRACK_ENDED':
      stopCapture().then(broadcastStatus);
      return;

    case 'CAPTURE_ERROR':
      stopCapture().then(broadcastStatus);
      return;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'eq-ui') return;
  uiPorts.add(port);
  sendToOffscreen({ type: 'MONITOR', on: true }, 3).catch(() => {});
  getStatus().then((status) => {
    try {
      port.postMessage({ type: 'STATUS', ...status });
    } catch {
      /* popup already gone */
    }
  });

  port.onDisconnect.addListener(() => {
    uiPorts.delete(port);
    if (!uiPorts.size) sendToOffscreen({ type: 'MONITOR', on: false }, 3).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) stopCapture().then(broadcastStatus);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session
    .get('activeTabId')
    .then(({ activeTabId: stored }) => {
      activeTabId = typeof stored === 'number' ? stored : null;
      return getStatus();
    })
    .then((status) => setBadge(status.active));
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('eqSettings').then(({ eqSettings }) => {
    if (!eqSettings) {
      chrome.storage.local.set({
        eqSettings: {
          enabled: true,
          preamp: 0,
          gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          limiter: true,
          preset: 'flat',
          customPresets: {}
        }
      });
    }
  });
});
