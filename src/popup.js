/**
 * Popup controller: renders the EQ, talks to the service worker, keeps an undo
 * history of the curve and draws the live curve + spectrum.
 */

import {
  BANDS,
  PRESETS,
  PRESET_GROUPS,
  DEFAULT_STATE,
  MIN_GAIN,
  MAX_GAIN,
  clamp,
  bandLabel,
  normalizeSettings,
  isSafePresetName
} from './eq-engine.js';

const CUSTOM = '__custom';
const CUSTOM_PREFIX = 'custom:';
const HISTORY_LIMIT = 60;

const els = {
  power: document.getElementById('power'),
  status: document.getElementById('status'),
  captureBtn: document.getElementById('captureBtn'),
  captureHint: document.getElementById('captureHint'),
  canvas: document.getElementById('curve'),
  bands: document.getElementById('bands'),
  presetSelect: document.getElementById('presetSelect'),
  savePreset: document.getElementById('savePreset'),
  deletePreset: document.getElementById('deletePreset'),
  preamp: document.getElementById('preamp'),
  preampOut: document.getElementById('preampOut'),
  limiter: document.getElementById('limiter'),
  reset: document.getElementById('reset'),
  abBtn: document.getElementById('abBtn'),
  undoBtn: document.getElementById('undoBtn'),
  redoBtn: document.getElementById('redoBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),
  toast: document.getElementById('toast'),
  saveDialog: document.getElementById('saveDialog'),
  presetName: document.getElementById('presetName'),
  cancelSave: document.getElementById('cancelSave'),
  confirmSave: document.getElementById('confirmSave')
};

const ctx2d = els.canvas.getContext('2d');
const W = els.canvas.width;
const H = els.canvas.height;
const PAD_X = 32;
const PAD_Y = 14;

// Built once: the spectrum uses the same vertical ramp for every bar.
const spectrumFill = ctx2d.createLinearGradient(0, H - PAD_Y, 0, PAD_Y);
spectrumFill.addColorStop(0, 'rgba(221, 161, 79, 0.015)');
spectrumFill.addColorStop(0.55, 'rgba(221, 161, 79, 0.075)');
spectrumFill.addColorStop(1, 'rgba(221, 161, 79, 0.16)');

let settings = normalizeSettings(DEFAULT_STATE);
let status = { active: false, tabId: null };
let activeTab = null;
let spectrum = new Array(28).fill(0);
let lastSpectrum = 0;
let bandEls = [];
let dragging = -1;
let selectedBand = -1;
let toastTimer = null;
let persistTimer = null;
let settingsTimer = null;
let lastPersistAt = 0;
let drawTimer = 0;
let spectrumUntil = 0;

/* Undo history of the curve (not of the capture session). */
let history = [];
let redoStack = [];
let historyTimer = null;
let lastCommitted = snapshot();

const send = (message) => chrome.runtime.sendMessage(message);

function snapshot() {
  return { gains: [...settings.gains], preamp: settings.preamp, preset: settings.preset };
}

/* ------------------------------------------------------------------ utils */

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'pestaña';
  } catch {
    return 'pestaña';
  }
}

function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
  }, 2400);
}

/**
 * Persistence is throttled to at most one write per ~1.2 s while the user drags,
 * and flushed on release, so a two-second gesture costs two writes instead of
 * eleven.
 */
function persistSoon() {
  if (persistTimer) return;
  const wait = Math.max(0, 1200 - (Date.now() - lastPersistAt));
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, wait);
}

function persistNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  lastPersistAt = Date.now();
  chrome.storage.local.set({ eqSettings: settings }).catch(() => {});
}

/** Coalesces SETTINGS messages so a drag sends ~16/s instead of ~120/s. */
function pushSettings(immediate = false) {
  if (immediate) {
    if (settingsTimer) {
      clearTimeout(settingsTimer);
      settingsTimer = null;
    }
    send({ type: 'SETTINGS', settings }).catch(() => {});
    return;
  }
  if (settingsTimer) return;
  settingsTimer = setTimeout(() => {
    settingsTimer = null;
    send({ type: 'SETTINGS', settings }).catch(() => {});
  }, 60);
}

function friendlyError(message) {
  const text = String(message || '');
  if (/chrome:\/\//i.test(text) || /cannot capture/i.test(text)) {
    return 'Esta página no se puede capturar (chrome://, Web Store o extensiones).';
  }
  if (/not allowed|permission/i.test(text)) {
    return 'Chrome bloqueó la captura. Cierra y vuelve a abrir el popup.';
  }
  if (/no capture|stream|missing/i.test(text)) {
    return 'No se pudo capturar el audio de esta pestaña.';
  }
  return text.length > 92 ? `${text.slice(0, 92)}…` : text || 'Error desconocido';
}

/* --------------------------------------------------------------- history */

function scheduleHistory() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(commitHistory, 350);
  updateHistoryButtons();
}

function commitHistory() {
  clearTimeout(historyTimer);
  historyTimer = null;
  const current = snapshot();
  if (JSON.stringify(current) === JSON.stringify(lastCommitted)) {
    updateHistoryButtons();
    return;
  }
  history.push(lastCommitted);
  if (history.length > HISTORY_LIMIT) history.shift();
  redoStack = [];
  lastCommitted = current;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  els.undoBtn.disabled = history.length === 0 && !historyTimer;
  els.redoBtn.disabled = redoStack.length === 0;
}

function applySnapshot(snap) {
  settings.gains = [...snap.gains];
  settings.preamp = snap.preamp;
  settings.preset = snap.preset;
  commit({ history: false });
}

function undo() {
  commitHistory();
  if (!history.length) return;
  redoStack.push(snapshot());
  applySnapshot(history.pop());
  lastCommitted = snapshot();
  updateHistoryButtons();
}

function redo() {
  commitHistory();
  if (!redoStack.length) return;
  history.push(snapshot());
  applySnapshot(redoStack.pop());
  lastCommitted = snapshot();
  updateHistoryButtons();
}

/* --------------------------------------------------------------- rendering */

function buildBands() {
  els.bands.textContent = '';
  bandEls = BANDS.map((frequency, index) => {
    const band = document.createElement('div');
    band.className = 'band';

    const value = document.createElement('output');
    value.className = 'bandVal';
    value.textContent = '0.0';

    const track = document.createElement('div');
    track.className = 'track';

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'bandRange';
    input.min = String(MIN_GAIN);
    input.max = String(MAX_GAIN);
    input.step = '0.5';
    input.value = '0';
    input.setAttribute('aria-label', `${bandLabel(frequency)} hercios`);

    input.addEventListener('input', () => {
      settings.gains[index] = Number(input.value);
      markCustom();
      persistSoon();
      pushSettings();
      scheduleHistory();
      setBandValue(index);
      requestDraw();
    });

    input.addEventListener('change', () => commit());

    track.append(input);

    const label = document.createElement('span');
    label.className = 'bandFreq';
    label.textContent = bandLabel(frequency);

    band.append(value, track, label);
    els.bands.append(band);

    return { band, input, value };
  });
}

const formatDb = (value) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}`;

function setBandValue(index) {
  const entry = bandEls[index];
  if (!entry) return;
  const gain = settings.gains[index];
  const show = index === selectedBand || Math.abs(gain) > 0.01;
  entry.input.value = String(gain);
  entry.value.textContent = show
    ? gain > 0
      ? `+${gain.toFixed(1)}`
      : gain < 0
        ? `−${Math.abs(gain).toFixed(1)}`
        : '0.0'
    : '';
  entry.value.classList.toggle('up', gain > 0.01);
  entry.value.classList.toggle('down', gain < -0.01);
}

function renderValues() {
  bandEls.forEach((_, index) => setBandValue(index));
}

function renderPower() {
  els.power.setAttribute('aria-checked', String(settings.enabled));
  els.power.title = settings.enabled
    ? 'Ecualizador activo (clic para desactivar)'
    : 'Ecualizador en bypass (clic para activar)';
}

function renderStatus() {
  const sameTab = status.active && activeTab && status.tabId === activeTab.id;
  let text = 'Sin capturar';
  let on = false;

  if (!activeTab) {
    text = 'Sin pestaña activa';
  } else if (sameTab) {
    text = `Capturando · ${hostOf(activeTab.url)}`;
    on = true;
  } else if (status.active) {
    text = 'Activo en otra pestaña';
    on = true;
  }

  els.status.textContent = text;
  els.status.classList.toggle('on', on);

  if (sameTab) {
    els.captureBtn.textContent = 'Detener captura';
    els.captureBtn.classList.add('stop');
    els.captureHint.textContent =
      'El audio de esta pestaña está pasando por el ecualizador en tiempo real.';
  } else {
    els.captureBtn.textContent = status.active ? 'Mover aquí' : 'Activar en esta pestaña';
    els.captureBtn.classList.remove('stop');
    els.captureHint.textContent =
      'Captura el audio de la pestaña activa: YouTube, Twitch, Spotify web o cualquier página con sonido.';
  }
}

function rebuildPresets() {
  const select = els.presetSelect;
  select.textContent = '';

  const custom = document.createElement('option');
  custom.value = CUSTOM;
  custom.textContent = 'Personalizado';
  select.append(custom);

  for (const group of PRESET_GROUPS) {
    const entries = Object.entries(PRESETS).filter(([, preset]) => preset.group === group);
    if (!entries.length) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = group;
    for (const [id, preset] of entries) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = preset.name;
      optgroup.append(option);
    }
    select.append(optgroup);
  }

  const names = Object.keys(settings.customPresets);
  if (names.length) {
    const mine = document.createElement('optgroup');
    mine.label = 'Mis presets';
    for (const name of names) {
      const option = document.createElement('option');
      option.value = CUSTOM_PREFIX + name;
      option.textContent = name;
      mine.append(option);
    }
    select.append(mine);
  }

  select.value = settings.preset || CUSTOM;
  if (select.value !== settings.preset) select.value = CUSTOM;
}

function render() {
  renderPower();
  renderStatus();
  renderValues();
  if (els.presetSelect.value !== (settings.preset || CUSTOM)) {
    els.presetSelect.value = settings.preset || CUSTOM;
  }
  els.preamp.value = String(settings.preamp);
  els.preampOut.textContent = `${formatDb(settings.preamp)} dB`;
  els.limiter.checked = settings.limiter;
  els.deletePreset.disabled = !settings.preset.startsWith(CUSTOM_PREFIX);
  updateHistoryButtons();
  requestDraw();
}

/* ------------------------------------------------------------------ canvas */

const xFor = (index) => PAD_X + ((index + 0.5) / BANDS.length) * (W - PAD_X * 2);
const yFor = (gain) =>
  H - PAD_Y - ((gain - MIN_GAIN) / (MAX_GAIN - MIN_GAIN)) * (H - PAD_Y * 2);
const gainForY = (y, snapToZero = false) => {
  const t = (H - PAD_Y - y) / (H - PAD_Y * 2);
  let gain = Math.round(clamp(t * (MAX_GAIN - MIN_GAIN) + MIN_GAIN, MIN_GAIN, MAX_GAIN) * 2) / 2;
  if (snapToZero && Math.abs(gain) <= 1) gain = 0;
  return gain;
};
const bandForX = (x) => {
  const raw = (x - PAD_X) / ((W - PAD_X * 2) / BANDS.length) - 0.5;
  return clamp(Math.round(raw), 0, BANDS.length - 1);
};

/**
 * Repaint on demand, capped at ~18 fps. Nothing runs while the audio is silent
 * and the settings are idle, which keeps the popup at 0% CPU when it is open
 * but nothing is happening.
 */
function requestDraw() {
  if (drawTimer) return;
  drawTimer = setTimeout(() => {
    drawTimer = 0;
    draw();
    if (performance.now() < spectrumUntil) requestDraw();
  }, 55);
}

function draw() {
  const now = performance.now();
  const stale = now - lastSpectrum > 260;
  if (stale && spectrum.some((value) => value > 0.01)) {
    for (let i = 0; i < spectrum.length; i++) spectrum[i] *= 0.88;
  }

  ctx2d.clearRect(0, 0, W, H);

  // Live spectrum, drawn behind the curve. One gradient per frame, reused by
  // every bar, so this stays allocation-free in the common case.
  ctx2d.fillStyle = spectrumFill;
  const barWidth = W / spectrum.length;
  for (let i = 0; i < spectrum.length; i++) {
    const value = spectrum[i];
    if (value <= 0.01) continue;
    const height = value * (H - PAD_Y * 2);
    ctx2d.fillRect(i * barWidth + 1, H - PAD_Y - height, barWidth - 2, height);
  }

  // Grid.
  ctx2d.lineWidth = 1.4;
  for (const gain of [MAX_GAIN, 6, 0, -6, MIN_GAIN]) {
    const y = yFor(gain);
    ctx2d.strokeStyle = gain === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.045)';
    ctx2d.beginPath();
    ctx2d.moveTo(PAD_X, y);
    ctx2d.lineTo(W - PAD_X, y);
    ctx2d.stroke();
  }
  ctx2d.strokeStyle = 'rgba(255,255,255,0.032)';
  for (let i = 0; i < BANDS.length; i++) {
    ctx2d.beginPath();
    ctx2d.moveTo(xFor(i), PAD_Y * 0.35);
    ctx2d.lineTo(xFor(i), H - PAD_Y * 0.35);
    ctx2d.stroke();
  }

  // Curve.
  const points = settings.gains.map((gain, index) => ({ x: xFor(index), y: yFor(gain) }));
  const tracePath = () => {
    ctx2d.beginPath();
    ctx2d.moveTo(PAD_X, points[0].y);
    ctx2d.lineTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const current = points[i];
      const midX = (prev.x + current.x) / 2;
      ctx2d.bezierCurveTo(midX, prev.y, midX, current.y, current.x, current.y);
    }
    const last = points[points.length - 1];
    ctx2d.lineTo(W - PAD_X, last.y);
  };

  const zero = yFor(0);
  tracePath();
  ctx2d.lineTo(W - PAD_X, zero);
  ctx2d.lineTo(PAD_X, zero);
  ctx2d.closePath();
  const fill = ctx2d.createLinearGradient(0, PAD_Y, 0, H - PAD_Y);
  const disabled = !settings.enabled;
  fill.addColorStop(0, disabled ? 'rgba(147,160,171,0.06)' : 'rgba(221, 161, 79, 0.17)');
  fill.addColorStop(1, disabled ? 'rgba(147,160,171,0.01)' : 'rgba(221, 161, 79, 0.015)');
  ctx2d.fillStyle = fill;
  ctx2d.fill();

  tracePath();
  ctx2d.lineWidth = 2.4;
  ctx2d.strokeStyle = disabled ? '#4a5058' : '#dda14f';
  ctx2d.lineJoin = 'round';
  ctx2d.stroke();

  // Nodes.
  points.forEach((point, index) => {
    const isSelected = index === selectedBand;
    ctx2d.beginPath();
    ctx2d.arc(point.x, point.y, isSelected ? 7 : 5.2, 0, Math.PI * 2);
    ctx2d.fillStyle = '#0e0f11';
    ctx2d.fill();
    ctx2d.lineWidth = isSelected ? 2.6 : 1.8;
    ctx2d.strokeStyle = disabled ? '#4a5058' : isSelected ? '#efc07c' : '#c98d42';
    ctx2d.stroke();
  });
}

function canvasPoint(event) {
  const rect = els.canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * W,
    y: ((event.clientY - rect.top) / rect.height) * H
  };
}

function pointerDown(event) {
  const { x, y } = canvasPoint(event);
  dragging = bandForX(x);
  selectedBand = dragging;
  els.canvas.setPointerCapture(event.pointerId);
  settings.gains[dragging] = gainForY(y, event.shiftKey);
  markCustom();
  persistSoon();
  pushSettings();
  scheduleHistory();
  renderValues();
  requestDraw();
}

function pointerMove(event) {
  if (dragging < 0) return;
  const { y } = canvasPoint(event);
  const next = gainForY(y, event.shiftKey);
  if (next === settings.gains[dragging]) return;
  settings.gains[dragging] = next;
  persistSoon();
  pushSettings();
  scheduleHistory();
  setBandValue(dragging);
  requestDraw();
}

function pointerUp(event) {
  if (dragging < 0) return;
  dragging = -1;
  try {
    els.canvas.releasePointerCapture(event.pointerId);
  } catch {
    /* already released */
  }
  commit();
}

function canvasKey(event) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  if (selectedBand < 0) selectedBand = 0;
  if (event.key === 'ArrowLeft') selectedBand = clamp(selectedBand - 1, 0, BANDS.length - 1);
  if (event.key === 'ArrowRight') selectedBand = clamp(selectedBand + 1, 0, BANDS.length - 1);
  if (event.key === 'ArrowUp') {
    settings.gains[selectedBand] = clamp(settings.gains[selectedBand] + 0.5, MIN_GAIN, MAX_GAIN);
  }
  if (event.key === 'ArrowDown') {
    settings.gains[selectedBand] = clamp(settings.gains[selectedBand] - 0.5, MIN_GAIN, MAX_GAIN);
  }
  markCustom();
  commit();
}

/* ------------------------------------------------------------------- state */

function markCustom() {
  settings.preset = CUSTOM;
  els.presetSelect.value = CUSTOM;
  els.deletePreset.disabled = true;
}

function commit({ history: track = true, flush = false } = {}) {
  persistNow();
  pushSettings(true);
  if (track) {
    // Discrete actions (preset, reset) close their own undo step; drags coalesce.
    if (flush) commitHistory();
    else scheduleHistory();
  }
  render();
}

function applyPreset(value) {
  if (value === CUSTOM) return;

  let gains = null;
  let preamp = 0;

  if (value.startsWith(CUSTOM_PREFIX)) {
    const saved = settings.customPresets[value.slice(CUSTOM_PREFIX.length)];
    if (saved) {
      gains = saved.gains;
      preamp = Number(saved.preamp) || 0;
    }
  } else if (PRESETS[value]) {
    gains = PRESETS[value].gains;
    preamp = Number(PRESETS[value].preamp) || 0;
  }
  if (!gains) return;

  settings.gains = gains.map((gain) => clamp(Number(gain) || 0, MIN_GAIN, MAX_GAIN));
  settings.preamp = preamp;
  settings.preset = value;
  commit({ flush: true });
}

/* ------------------------------------------------------------------ events */

els.captureBtn.addEventListener('click', async () => {
  if (!activeTab) {
    toast('No hay ninguna pestaña activa.', true);
    return;
  }

  const sameTab = status.active && status.tabId === activeTab.id;
  els.captureBtn.disabled = true;

  try {
    if (sameTab) {
      const reply = await send({ type: 'STOP' });
      if (!reply?.ok) throw new Error(reply?.error);
      status = { active: false, tabId: null };
      toast('Captura detenida');
      return;
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
    const reply = await send({
      type: 'START',
      tabId: activeTab.id,
      streamId,
      settings
    });
    if (!reply?.ok) throw new Error(reply?.error);
    status = { active: true, tabId: activeTab.id };
    toast('Ecualizador activo');
  } catch (error) {
    toast(friendlyError(error?.message || error), true);
  } finally {
    els.captureBtn.disabled = false;
    renderStatus();
  }
});

els.power.addEventListener('click', () => {
  settings.enabled = !settings.enabled;
  commit();
});

els.presetSelect.addEventListener('change', () => applyPreset(els.presetSelect.value));

els.savePreset.addEventListener('click', () => {
  els.saveDialog.hidden = false;
  els.presetName.value = suggestName();
  els.presetName.focus();
  els.presetName.select();
});

els.cancelSave.addEventListener('click', () => {
  els.saveDialog.hidden = true;
});

els.confirmSave.addEventListener('click', () => {
  const name = els.presetName.value.trim().slice(0, 40);
  if (!name) {
    toast('Escribe un nombre.', true);
    return;
  }
  if (!isSafePresetName(name)) {
    toast('Ese nombre no es válido.', true);
    return;
  }
  settings.customPresets[name] = { gains: [...settings.gains], preamp: settings.preamp };
  settings.preset = CUSTOM_PREFIX + name;
  els.saveDialog.hidden = true;
  rebuildPresets();
  commit({ flush: true });
  toast(`Preset «${name}» guardado`);
});

els.presetName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') els.confirmSave.click();
  if (event.key === 'Escape') els.saveDialog.hidden = true;
});

els.deletePreset.addEventListener('click', () => {
  if (!settings.preset.startsWith(CUSTOM_PREFIX)) return;
  const name = settings.preset.slice(CUSTOM_PREFIX.length);
  delete settings.customPresets[name];
  settings.preset = CUSTOM;
  rebuildPresets();
  commit({ flush: true });
  toast(`Preset «${name}» eliminado`);
});

els.preamp.addEventListener('input', () => {
  settings.preamp = Number(els.preamp.value);
  persistSoon();
  pushSettings();
  scheduleHistory();
  els.preampOut.textContent = `${formatDb(settings.preamp)} dB`;
});

els.preamp.addEventListener('change', () => {
  markCustom();
  commit();
});

els.limiter.addEventListener('change', () => {
  settings.limiter = els.limiter.checked;
  settings.limiterUserSet = true;
  commit({ history: false });
});

els.reset.addEventListener('click', () => {
  settings.gains = [...DEFAULT_STATE.gains];
  settings.preamp = 0;
  settings.preset = 'flat';
  settings.enabled = true;
  settings.limiter = DEFAULT_STATE.limiter;
  settings.limiterUserSet = DEFAULT_STATE.limiterUserSet;
  rebuildPresets();
  commit({ flush: true });
  toast('Ecualizador restablecido');
});

els.undoBtn.addEventListener('click', undo);
els.redoBtn.addEventListener('click', redo);

/* A/B: hold to hear the untouched audio. */
let abPrevious = null;
function abStart() {
  if (abPrevious !== null) return;
  abPrevious = settings.enabled;
  settings.enabled = !abPrevious;
  els.abBtn.classList.add('active');
  els.power.setAttribute('aria-checked', String(settings.enabled));
  pushSettings(true);
}
function abEnd() {
  if (abPrevious === null) return;
  settings.enabled = abPrevious;
  abPrevious = null;
  els.abBtn.classList.remove('active');
  els.power.setAttribute('aria-checked', String(settings.enabled));
  pushSettings(true);
}
els.abBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  abStart();
});
els.abBtn.addEventListener('pointerup', abEnd);
els.abBtn.addEventListener('pointerleave', abEnd);
els.abBtn.addEventListener('pointercancel', abEnd);
window.addEventListener('blur', abEnd);

/* --------------------------------------------------------- preset sharing */

els.exportBtn.addEventListener('click', () => {
  const payload = {
    app: 'equali',
    version: 1,
    exportedAt: new Date().toISOString(),
    customPresets: settings.customPresets,
    current: { gains: settings.gains, preamp: settings.preamp, preset: settings.preset }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'equali-presets.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Presets exportados');
});

els.importBtn.addEventListener('click', () => els.importFile.click());

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files?.[0];
  els.importFile.value = '';
  if (!file) return;

  try {
    const data = JSON.parse(await file.text());
    const incoming = data?.customPresets;
    if (!incoming || typeof incoming !== 'object') throw new Error('formato');

    let count = 0;
    for (const [name, value] of Object.entries(incoming)) {
      if (!isSafePresetName(name)) continue;
      const gains = Array.isArray(value) ? value : value?.gains;
      if (!Array.isArray(gains) || gains.length !== BANDS.length) continue;
      settings.customPresets[String(name).slice(0, 40)] = {
        gains: gains.map((gain) => clamp(Number(gain) || 0, MIN_GAIN, MAX_GAIN)),
        preamp: clamp(Number(value?.preamp) || 0, MIN_GAIN, MAX_GAIN)
      };
      count += 1;
    }
    if (!count) throw new Error('vacío');

    rebuildPresets();
    commit({ history: false });
    toast(`${count} preset(s) importado(s)`);
  } catch {
    toast('El archivo no contiene presets válidos.', true);
  }
});

/* ------------------------------------------------------------- interaction */

els.canvas.addEventListener('pointerdown', pointerDown);
els.canvas.addEventListener('pointermove', pointerMove);
els.canvas.addEventListener('pointerup', pointerUp);
els.canvas.addEventListener('pointercancel', pointerUp);
els.canvas.addEventListener('keydown', canvasKey);
els.canvas.addEventListener('dblclick', (event) => {
  const { x } = canvasPoint(event);
  const index = bandForX(x);
  settings.gains[index] = 0;
  markCustom();
  commit();
});

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  }
  if (mod && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
  }
});

function suggestName() {
  let index = 1;
  let name = 'Mi preset';
  while (settings.customPresets[name]) {
    index += 1;
    name = `Mi preset ${index}`;
  }
  return name;
}

/* --------------------------------------------------------------- bootstrap */

function connectPort() {
  try {
    const port = chrome.runtime.connect({ name: 'eq-ui' });
    port.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'SPECTRUM' && Array.isArray(message.bins)) {
        spectrum = message.bins;
        lastSpectrum = performance.now();
        spectrumUntil = lastSpectrum + 900;
        requestDraw();
      }
      if (message.type === 'STATUS') {
        status = { active: Boolean(message.active), tabId: message.tabId ?? null };
        renderStatus();
      }
    });
  } catch {
    /* direct tab (tests) without chrome.runtime */
  }
}

async function init() {
  buildBands();
  rebuildPresets();
  render();

  try {
    const [stored, currentStatus, tabs] = await Promise.all([
      chrome.storage.local.get('eqSettings'),
      send({ type: 'GET_STATUS' }),
      chrome.tabs.query({ active: true, currentWindow: true })
    ]);
    settings = normalizeSettings(stored?.eqSettings || DEFAULT_STATE);
    status = { active: Boolean(currentStatus?.active), tabId: currentStatus?.tabId ?? null };
    activeTab = tabs?.[0] ?? null;
  } catch {
    /* keep defaults */
  }

  lastCommitted = snapshot();
  rebuildPresets();
  render();
  connectPort();
  requestDraw();
}

init();
