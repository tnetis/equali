/**
 * Shared definitions for the equalizer: bands, presets and state normalisation.
 * Imported by both the popup and the offscreen audio processor, so it must stay
 * free of chrome.* API calls.
 */

/** Centre frequencies in Hz, low to high. */
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Q of each peaking filter. ~1.1 gives smooth, musical bands. */
export const BAND_Q = 1.1;

export const MIN_GAIN = -12;
export const MAX_GAIN = 12;

/** Order of the optgroups in the preset dropdown. */
export const PRESET_GROUPS = ['Graves', 'Música', 'Cine y juegos', 'Voz', 'Especiales'];

/**
 * Built-in presets. `gains` is low -> high (31 Hz -> 16 kHz), 10 values.
 * `preamp` is applied together with the curve so loud presets do not clip.
 */
export const PRESETS = {
  // ---------------------------------------------------------------- Graves
  bassBoost:    { group: 'Graves', name: 'Refuerzo de graves', gains: [9, 8, 7, 4, 1, 0, 0, 0, 0, 0], preamp: 0 },
  bassExtreme:  { group: 'Graves', name: 'Bass Booster Xtreme', gains: [12, 12, 10, 6, 2, 0, 0, 0, 0, 0], preamp: -1 },
  subwoofer:    { group: 'Graves', name: 'Subwoofer', gains: [10, 9, 7, 4, 1, 0, 0, 0, 0, 0], preamp: -1 },
  bassCut:      { group: 'Graves', name: 'Reductor de graves', gains: [-9, -8, -7, -4, -1, 0, 0, 0, 0, 0], preamp: 1 },

  // ---------------------------------------------------------------- Música
  flat:         { group: 'Música', name: 'Plano', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0 },
  acoustic:     { group: 'Música', name: 'Acústico', gains: [4, 4, 3, 1, 1, 1, 2, 3, 4, 4], preamp: 0 },
  classic:      { group: 'Música', name: 'Clásica', gains: [4, 3, 2, 0, 0, 0, -1, -2, -2, -3], preamp: 0 },
  dance:        { group: 'Música', name: 'Dance', gains: [7, 6, 4, 0, 0, -2, -1, 2, 4, 4], preamp: 0 },
  party:        { group: 'Música', name: 'Party', gains: [8, 7, 5, 2, 0, -1, 0, 2, 5, 6], preamp: 1 },
  club:         { group: 'Música', name: 'Club', gains: [9, 8, 6, 3, 0, -1, 1, 3, 5, 5], preamp: -1 },
  deep:         { group: 'Música', name: 'Deep', gains: [7, 6, 5, 3, 1, 0, -1, -2, -3, -4], preamp: 0 },
  electronic:   { group: 'Música', name: 'Electrónica', gains: [6, 5, 3, 0, -2, 2, 1, 1, 3, 4], preamp: 0 },
  hiphop:       { group: 'Música', name: 'Hip-hop', gains: [7, 6, 4, 2, -1, -1, 1, 2, 3, 3], preamp: 0 },
  rnb:          { group: 'Música', name: 'R&B', gains: [6, 5, 3, 0, -1, -2, 0, 2, 3, 3], preamp: 0 },
  jazz:         { group: 'Música', name: 'Jazz', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3], preamp: 0 },
  latin:        { group: 'Música', name: 'Latina', gains: [5, 4, 2, 1, 0, 0, 1, 2, 3, 4], preamp: 0 },
  piano:        { group: 'Música', name: 'Piano', gains: [3, 3, 2, 1, 0, 0, 1, 2, 3, 3], preamp: 0 },
  pop:          { group: 'Música', name: 'Pop', gains: [2, 3, 4, 3, 0, -1, -1, 0, 2, 3], preamp: 0 },
  rock:         { group: 'Música', name: 'Rock', gains: [5, 4, 3, 1, -1, -2, 0, 2, 3, 4], preamp: 0 },
  live:         { group: 'Música', name: 'Directo', gains: [4, 3, 2, 1, 0, 0, 1, 2, 3, 3], preamp: 0 },
  concert:      { group: 'Música', name: 'Concierto', gains: [6, 5, 4, 2, 0, -1, 0, 2, 4, 5], preamp: 1 },
  karaoke:      { group: 'Música', name: 'Karaoke', gains: [2, 3, 4, 3, 1, 0, 0, 1, 2, 2], preamp: 0 },
  lofi:         { group: 'Música', name: 'Lo-fi', gains: [4, 5, 3, 1, -1, -2, -1, 1, 2, 1], preamp: -1 },
  vintage:      { group: 'Música', name: 'Vintage', gains: [3, 4, 2, 0, -1, -1, 0, 1, 2, 1], preamp: 0 },
  vocal:        { group: 'Música', name: 'Voz', gains: [-3, -2, -1, 1, 4, 5, 4, 2, 0, -1], preamp: 1 },
  loudness:     { group: 'Música', name: 'Volumen', gains: [6, 5, 4, 3, 2, 1, 1, 2, 3, 4], preamp: -1 },
  hall:         { group: 'Música', name: 'Sala', gains: [4, 3, 2, 0, -1, -1, 0, 1, 2, 2], preamp: 0 },

  // --------------------------------------------------------- Cine y juegos
  cinema:       { group: 'Cine y juegos', name: 'Cine', gains: [6, 5, 4, 2, 0, 0, 1, 2, 3, 4], preamp: 1 },
  action:       { group: 'Cine y juegos', name: 'Acción', gains: [7, 6, 4, 2, 0, -1, 0, 1, 3, 4], preamp: 1 },
  night:        { group: 'Cine y juegos', name: 'Noche', gains: [-2, -2, -1, 0, 1, 2, 3, 4, 5, 5], preamp: 1 },
  gaming:       { group: 'Cine y juegos', name: 'Gaming', gains: [5, 4, 2, 0, -1, 1, 3, 4, 4, 3], preamp: 1 },
  tv:           { group: 'Cine y juegos', name: 'TV', gains: [4, 3, 2, 1, 0, 1, 2, 3, 3, 2], preamp: 0 },

  // ------------------------------------------------------------------- Voz
  speech:       { group: 'Voz', name: 'Voz / Podcast', gains: [-4, -3, -2, 0, 3, 5, 5, 4, 2, 0], preamp: 2 },
  podcast:      { group: 'Voz', name: 'Podcast', gains: [-3, -2, -1, 0, 3, 4, 5, 4, 2, 0], preamp: 2 },

  // ------------------------------------------------------------- Especiales
  smallSpeakers:{ group: 'Especiales', name: 'Altavoces pequeños', gains: [-8, -7, -5, -2, 0, 1, 2, 3, 4, 3], preamp: 0 },
  headphones:   { group: 'Especiales', name: 'Auriculares', gains: [3, 2, 1, 0, 0, 1, 2, 3, 4, 5], preamp: 0 },
  car:          { group: 'Especiales', name: 'Coche', gains: [5, 4, 3, 1, 0, 0, 1, 2, 3, 3], preamp: 1 },
  trebleBoost:  { group: 'Especiales', name: 'Refuerzo de agudos', gains: [0, 0, 0, 0, 0, 0, 2, 4, 6, 7], preamp: 0 },
  trebleCut:    { group: 'Especiales', name: 'Reductor de agudos', gains: [0, 0, 0, 0, 0, 0, -2, -4, -6, -7], preamp: 0 }
};

export const DEFAULT_STATE = {
  enabled: true,
  preamp: 0,
  gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  limiter: false,
  limiterUserSet: false,
  preset: 'flat',
  customPresets: {}
};

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Preset names become object keys. `__proto__` and friends do not create an own
 * property, they mutate the object's prototype, so they are rejected instead of
 * silently doing something weird.
 */
export function isSafePresetName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '__proto__' &&
    name !== 'constructor' &&
    name !== 'prototype'
  );
}

export function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Frequencies are shown as 31, 125, 1k, 16k. */
export function bandLabel(freq) {
  return freq >= 1000 ? `${freq / 1000}k` : String(freq);
}

/**
 * Defensive copy: guarantees ten numeric gains in range, a sane preamp and a
 * plain object of custom presets. Used on anything that comes from storage.
 */
export function normalizeSettings(raw) {
  const base = {
    ...DEFAULT_STATE,
    gains: [...DEFAULT_STATE.gains],
    customPresets: {}
  };
  if (!raw || typeof raw !== 'object') return base;

  base.enabled = raw.enabled !== false;
  // Old versions shipped with the compressor on by default. Only keep it on
  // when the user has explicitly toggled it since.
  base.limiterUserSet = raw.limiterUserSet === true;
  base.limiter = base.limiterUserSet && raw.limiter === true;
  base.preamp = clamp(Number(raw.preamp) || 0, MIN_GAIN, MAX_GAIN);

  if (Array.isArray(raw.gains)) {
    base.gains = BANDS.map((_, i) => {
      const value = Number(raw.gains[i]);
      return Number.isFinite(value) ? clamp(value, MIN_GAIN, MAX_GAIN) : 0;
    });
  }

  if (typeof raw.preset === 'string') base.preset = raw.preset;

  if (raw.customPresets && typeof raw.customPresets === 'object') {
    for (const [name, value] of Object.entries(raw.customPresets)) {
      if (!isSafePresetName(name)) continue;

      // New shape: {gains, preamp}. Legacy shape: a bare gains array.
      const isObject = value && typeof value === 'object' && !Array.isArray(value);
      const rawGains = isObject ? value.gains : value;
      if (!Array.isArray(rawGains)) continue;

      const clean = BANDS.map((_, i) => {
        const gain = Number(rawGains[i]);
        return Number.isFinite(gain) ? clamp(gain, MIN_GAIN, MAX_GAIN) : 0;
      });
      const preamp = isObject ? clamp(Number(value.preamp) || 0, MIN_GAIN, MAX_GAIN) : 0;

      base.customPresets[String(name).slice(0, 40)] = { gains: clean, preamp };
    }
  }

  return base;
}
