/**
 * Persistent settings and the currently-selected profile.
 *
 * Everything lives in localStorage, so the game keeps your avatar, your assists and
 * your key bindings between sessions without any account or server.
 */

const SETTINGS_KEY = 'tennis.settings.v1';

export const DEFAULT_SETTINGS = {
  // Audio
  masterVolume: 0.85,
  sfxVolume: 1.0,
  crowdVolume: 0.7,
  voiceVolume: 0.9,
  muted: false,

  // Assists — the difficulty dial that new players actually feel.
  landingMarker: true,   // ring showing where the ball will bounce
  aimGuide: true,        // arc showing your intended target while charging
  timingHints: true,     // PERFECT / GOOD / MISHIT call-outs
  autoPosition: false,   // nudges you toward the ball automatically
  autoSwing: false,      // swings for you at the right moment; you only steer and aim

  // Presentation
  cameraPreset: 'broadcast',
  units: 'kmh',
  ballTrail: true,
  screenShake: true,
  showFps: false,

  // Match defaults
  bestOf: 3,
  difficulty: 'club',
  venueId: 'newyork',
  doubles: false,

  // Profile
  activeAvatarId: null,
  playerName: 'Player',
};

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    cache = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch (_) {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export function saveSettings(patch) {
  const s = loadSettings();
  Object.assign(s, patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) { /* blocked */ }
  return s;
}

export function resetSettings() {
  cache = { ...DEFAULT_SETTINGS };
  try { localStorage.removeItem(SETTINGS_KEY); } catch (_) {}
  return cache;
}

/**
 * Assist presets. Rather than making players tune six toggles, offer three honest
 * points on the spectrum and let the tinkerers open the individual switches.
 */
export const ASSIST_PRESETS = {
  full: {
    name: 'Learning',
    blurb: 'Just steer with the arrows — the game swings for you. Every guide on.',
    settings: {
      landingMarker: true, aimGuide: true, timingHints: true,
      autoPosition: true, autoSwing: true,
    },
  },
  standard: {
    name: 'Standard',
    blurb: 'You swing. Landing marker and timing feedback stay on to help.',
    settings: {
      landingMarker: true, aimGuide: true, timingHints: true,
      autoPosition: false, autoSwing: false,
    },
  },
  simulation: {
    name: 'Simulation',
    blurb: 'No assists. Read the ball, judge the bounce, own the mistake.',
    settings: {
      landingMarker: false, aimGuide: false, timingHints: false,
      autoPosition: false, autoSwing: false,
    },
  },
};
