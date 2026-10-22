/**
 * Offscreen audio processor.
 *
 * The tab is captured with tabCapture and its audio is *moved* into this
 * document, so we must play it back ourselves through the AudioContext
 * destination. Chain:
 *
 *   source -> preamp -> [10 peaking filters] -> limiter? -> soft clip -> master -> out
 *
 * The soft clip + master ceiling are always on: they are the hearing/speaker
 * protection and cannot be disabled from the UI.
 */

import { BANDS, BAND_Q, MIN_GAIN, MAX_GAIN, clamp, normalizeSettings } from './eq-engine.js';

const SPECTRUM_BINS = 28;
/** 10 fps is plenty for a meter and halves the message traffic. */
const METER_INTERVAL_MS = 100;
/** -1 dBFS. Everything the user hears is attenuated by this ceiling. */
const SAFETY_CEILING = 0.89;
const RAMP = 0.03;

/** Reused across frames: no allocation in the hot path. */
let fftData = new Uint8Array(512);
const binsOut = new Array(SPECTRUM_BINS).fill(0);
let lastWasSilent = true;

/** @type {null | object} */
let audio = null;
let meterTimer = null;
let monitor = false;

const dbToGain = (db) => Math.pow(10, db / 20);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * tanh curve normalised so |x| <= 1 maps to |y| <= 1. Anything the filters
 * push past full scale lands flat on the curve instead of wrapping around.
 */
function makeSoftClipCurve(samples = 2048) {
  const curve = new Float32Array(samples);
  const drive = 1.6;
  const norm = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

/**
 * Offscreen documents can start with a suspended AudioContext. Retry until it
 * actually runs, otherwise the tab is captured but silent.
 */
async function resumeContext(ctx) {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (ctx.state === 'running') return;
    try {
      await ctx.resume();
    } catch {
      /* retry below */
    }
    if (ctx.state === 'running') return;
    await sleep(150);
  }
}

function post(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function start(streamId, rawSettings) {
  await stop();

  const settings = normalizeSettings(rawSettings);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await resumeContext(ctx);

  const source = ctx.createMediaStreamSource(stream);

  const preamp = ctx.createGain();
  preamp.gain.value = 1;

  const filters = BANDS.map((frequency) => {
    const filter = ctx.createBiquadFilter();
    filter.type = 'peaking';
    filter.frequency.value = frequency;
    filter.Q.value = BAND_Q;
    filter.gain.value = 0;
    return filter;
  });

  // Optional compressor. It shapes the sound; the safety stage below is what
  // actually guarantees the level.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;

  const safety = ctx.createWaveShaper();
  safety.curve = makeSoftClipCurve();
  safety.oversample = 'none';

  const master = ctx.createGain();
  const now = ctx.currentTime;
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(SAFETY_CEILING, now + 0.25); // fade in, no pop

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.82;

  audio = {
    ctx,
    stream,
    source,
    preamp,
    filters,
    limiter,
    safety,
    master,
    analyser,
    settings,
    routing: ''
  };

  lastWasSilent = true;
  apply(settings);

  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      stop();
      post({ type: 'TRACK_ENDED' });
    });
  }

  if (monitor) startMeter();
  return { ok: true };
}

async function stop() {
  stopMeter();
  if (!audio) return { ok: true };

  const current = audio;
  audio = null;

  // Fade out before cutting the graph, otherwise stopping pops.
  try {
    const now = current.ctx.currentTime;
    current.master.gain.cancelScheduledValues(now);
    current.master.gain.setTargetAtTime(0, now, 0.015);
    await sleep(70);
  } catch {
    /* context may already be closed */
  }

  try {
    current.source.disconnect();
    current.preamp.disconnect();
    for (const filter of current.filters) filter.disconnect();
    current.limiter.disconnect();
    current.safety.disconnect();
    current.master.disconnect();
    current.analyser.disconnect();
  } catch {
    /* nodes may already be torn down */
  }
  try {
    for (const track of current.stream.getTracks()) track.stop();
  } catch {
    /* ignore */
  }
  try {
    await current.ctx.close();
  } catch {
    /* ignore */
  }
  return { ok: true };
}

/** Rebuild the node graph only when the topology actually changes. */
function route() {
  if (!audio) return;
  const { source, preamp, filters, limiter, safety, master, analyser, settings, ctx } = audio;
  // The analyser is only needed while the popup is watching, so it leaves the
  // path when the meter is off (saves an FFT per audio block).
  const wanted = `${settings.enabled ? 'on' : 'off'}:${settings.limiter ? 'lim' : 'raw'}:${
    monitor ? 'meter' : 'quiet'
  }`;
  if (audio.routing === wanted) return;

  try {
    source.disconnect();
    preamp.disconnect();
    for (const filter of filters) filter.disconnect();
    limiter.disconnect();
    safety.disconnect();
    master.disconnect();
    analyser.disconnect();
  } catch {
    /* first build: nothing connected yet */
  }

  source.connect(preamp);
  let node = preamp;
  for (const filter of filters) {
    node.connect(filter);
    node = filter;
  }
  if (settings.enabled && settings.limiter) {
    node.connect(limiter);
    node = limiter;
  }

  // Always: soft clip -> ceiling. This is the ear/speaker protection.
  node.connect(safety);
  safety.connect(master);

  if (monitor) {
    master.connect(analyser);
    analyser.connect(ctx.destination);
  } else {
    master.connect(ctx.destination);
  }

  audio.routing = wanted;
}

function apply(rawSettings) {
  const settings = normalizeSettings(rawSettings);
  if (!audio) return { ok: true };

  audio.settings = settings;
  route();

  const now = audio.ctx.currentTime;
  const preampGain = settings.enabled ? dbToGain(settings.preamp) : 1;
  audio.preamp.gain.setTargetAtTime(preampGain, now, RAMP);

  audio.filters.forEach((filter, index) => {
    const value = settings.enabled ? clamp(settings.gains[index], MIN_GAIN, MAX_GAIN) : 0;
    filter.gain.setTargetAtTime(value, now, RAMP);
  });

  return { ok: true };
}

function startMeter() {
  if (meterTimer) return;
  meterTimer = setInterval(sampleSpectrum, METER_INTERVAL_MS);
}

function stopMeter() {
  if (!meterTimer) return;
  clearInterval(meterTimer);
  meterTimer = null;
}

function sampleSpectrum() {
  if (!audio) return;
  const { analyser, ctx } = audio;
  if (fftData.length !== analyser.frequencyBinCount) {
    fftData = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteFrequencyData(fftData);

  const nyquist = ctx.sampleRate / 2;
  const logMin = Math.log(30);
  const logMax = Math.log(16000);
  let peakAll = 0;

  for (let b = 0; b < SPECTRUM_BINS; b++) {
    const f0 = Math.exp(logMin + ((logMax - logMin) * b) / SPECTRUM_BINS);
    const f1 = Math.exp(logMin + ((logMax - logMin) * (b + 1)) / SPECTRUM_BINS);
    const i0 = Math.max(0, Math.floor((f0 / nyquist) * fftData.length));
    const i1 = Math.min(fftData.length - 1, Math.ceil((f1 / nyquist) * fftData.length));
    let peak = 0;
    for (let i = i0; i <= i1; i++) {
      if (fftData[i] > peak) peak = fftData[i];
    }
    binsOut[b] = Math.round((peak / 255) * 100) / 100;
    if (peak > peakAll) peakAll = peak;
  }

  // Silence -> one final zero frame, then stay quiet: no wakeups while paused.
  if (peakAll === 0 && lastWasSilent) return;
  lastWasSilent = peakAll === 0;

  post({ type: 'SPECTRUM', bins: binsOut });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return;

  switch (message.type) {
    case 'START':
      start(message.streamId, message.settings)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ ok: false, error: String(error?.message || error) });
          post({ type: 'CAPTURE_ERROR' });
        });
      return true;

    case 'STOP':
      stop()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;

    case 'SETTINGS':
      sendResponse(apply(message.settings));
      return true;

    case 'MONITOR':
      monitor = Boolean(message.on);
      if (monitor) {
        startMeter();
      } else {
        stopMeter();
      }
      // Re-route so the analyser leaves the graph when nobody is looking.
      route();
      sendResponse({ ok: true });
      return true;
  }
});
