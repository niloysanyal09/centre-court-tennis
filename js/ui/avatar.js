/**
 * Avatar data model + creator UI.
 *
 * The model is deliberately dumb data: a flat, JSON-serialisable object with no
 * methods, so it can be persisted to localStorage, sent over the wire to a
 * multiplayer peer, or dropped straight into the renderer.
 *
 * `validateAvatar` is the single choke point. Anything arriving from
 * localStorage, from the network, or from a half-finished creator session goes
 * through it and comes out safe to render. It also enforces the 40-point
 * attribute budget, which is what makes character creation a set of trade-offs
 * rather than a slider party.
 *
 * The colour palettes live in ../render/playerdraw.js (the module that knows how
 * to use them) and are re-exported here for convenience. The dependency is
 * strictly one-way — avatar.js → playerdraw.js — so there is no module cycle.
 */

import {
  drawPlayerFigure,
  SKIN_TONES,
  HAIR_COLORS,
  HAIR_STYLES,
  RACKET_FRAMES,
} from '../render/playerdraw.js';

export { SKIN_TONES, HAIR_COLORS, HAIR_STYLES };

export const AVATAR_STORAGE_KEY = 'tennis.avatars.v1';

// ─────────────────────────────────────────────────────────────────────────────
// Enumerations and palettes
// ─────────────────────────────────────────────────────────────────────────────

export const BUILDS = ['lean', 'athletic', 'powerful'];
export const HATS = ['none', 'cap', 'visor', 'bandana'];
export const HANDS = ['right', 'left'];
export const BACKHANDS = ['one', 'two'];
export const RACKET_FRAME_KEYS = Object.keys(RACKET_FRAMES);

export const HEIGHT_MIN = 1.65;
export const HEIGHT_MAX = 2.05;

export const ATTR_KEYS = [
  'power', 'speed', 'stamina', 'accuracy', 'serve', 'volley', 'defense', 'mental',
];
export const ATTR_LABELS = {
  power: 'Power', speed: 'Speed', stamina: 'Stamina', accuracy: 'Accuracy',
  serve: 'Serve', volley: 'Volley', defense: 'Defense', mental: 'Mental',
};
export const ATTR_MIN = 1;
export const ATTR_MAX = 10;
/** Eight attributes, 1..10 each, 40 points total. Average 5 — every point up costs a point down. */
export const ATTR_BUDGET = 40;

export const PLAYSTYLES = {
  'baseliner':             { power: 6, speed: 5, stamina: 6, accuracy: 6, serve: 4, volley: 3, defense: 5, mental: 5 },
  'aggressive-baseliner':  { power: 8, speed: 5, stamina: 4, accuracy: 5, serve: 6, volley: 3, defense: 3, mental: 6 },
  'serve-volley':          { power: 5, speed: 5, stamina: 4, accuracy: 5, serve: 8, volley: 8, defense: 3, mental: 2 },
  'counterpuncher':        { power: 3, speed: 7, stamina: 7, accuracy: 5, serve: 3, volley: 3, defense: 8, mental: 4 },
  'all-court':             { power: 5, speed: 5, stamina: 5, accuracy: 5, serve: 5, volley: 5, defense: 5, mental: 5 },
};
export const PLAYSTYLE_KEYS = Object.keys(PLAYSTYLES);
export const PLAYSTYLE_LABELS = {
  'baseliner': 'Baseliner',
  'aggressive-baseliner': 'Aggressive Baseliner',
  'serve-volley': 'Serve & Volley',
  'counterpuncher': 'Counterpuncher',
  'all-court': 'All-Court',
};

/** Curated kit swatches. Custom colours are still allowed via the picker. */
export const KIT_COLORS = [
  '#ffffff', '#f2f4f7', '#c9ced6', '#8b929c', '#4a515b', '#232a33', '#0d1117', '#000000',
  '#00e07a', '#12b886', '#0ea5e9', '#2563eb', '#4f46e5', '#7c3aed', '#c026d3', '#e11d48',
  '#ef4444', '#f97316', '#f59e0b', '#facc15', '#84cc16', '#14b8a6', '#0f766e', '#1e3a5f',
  '#7f1d1d', '#831843', '#3f2d20', '#a16207', '#d9c8a9', '#f0abfc',
];

export const SHOE_COLORS = [
  '#ffffff', '#f2f2f2', '#d8d8d8', '#1a1a1a', '#2b3440',
  '#00e07a', '#0ea5e9', '#e11d48', '#f97316', '#facc15',
];

// ─────────────────────────────────────────────────────────────────────────────
// Model
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_AVATAR = Object.freeze({
  id: '',
  name: 'Player',
  country: '',

  // Appearance
  skinTone: 2,
  hairStyle: 'short',
  hairColor: HAIR_COLORS[1],
  build: 'athletic',
  height: 1.85,

  // Kit
  shirtColor: '#ffffff',
  shirtAccent: '#00e07a',
  shortsColor: '#1b2430',
  shoeColor: '#f2f2f2',
  hasHat: 'none',
  hatColor: '#ffffff',
  wristbands: false,
  racketColor: '#101317',
  racketFrame: 'graphite',

  // Play
  handedness: 'right',
  backhand: 'two',
  playstyle: 'all-court',

  // Attributes (sum must equal ATTR_BUDGET)
  power: 5, speed: 5, stamina: 5, accuracy: 5,
  serve: 5, volley: 5, defense: 5, mental: 5,
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const oneOf = (v, list, fallback) => (list.indexOf(v) >= 0 ? v : fallback);

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
function safeColor(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  if (!HEX_RE.test(s)) return fallback;
  if (s.length === 4) {
    return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
  }
  return s.toLowerCase();
}

let _idSeq = 0;
function newId() {
  _idSeq = (_idSeq + 1) % 4096;
  return 'av_' + Date.now().toString(36) + '_' +
    Math.floor(Math.random() * 1679616).toString(36) + _idSeq.toString(36);
}

/**
 * Force the attribute block onto exactly ATTR_BUDGET points, every value inside
 * [ATTR_MIN, ATTR_MAX].
 *
 * The rescale is proportional rather than greedy. A greedy "shave the biggest"
 * pass destroys exactly what the caller was trying to express — ask for a
 * 9-power baseliner and you get a flat row of 5s, because the 9 is shaved first
 * every single time. Instead every attribute is squeezed toward the floor (or
 * stretched toward the ceiling) by the same factor, so the SHAPE of the build
 * survives and only its magnitude changes. The leftover integer points then go
 * to whichever attributes lost the most to rounding (largest-remainder method).
 */
function balanceAttributes(target) {
  const N = ATTR_KEYS.length;
  let total = 0;
  for (let i = 0; i < N; i++) {
    const k = ATTR_KEYS[i];
    const v = Math.round(Number(target[k]));
    target[k] = Number.isFinite(v) ? clamp(v, ATTR_MIN, ATTR_MAX) : 5;
    total += target[k];
  }
  if (total === ATTR_BUDGET) return target;

  const floors = new Array(N);
  const fracs = new Array(N);
  let sum = 0;

  for (let i = 0; i < N; i++) {
    const v = target[ATTR_KEYS[i]];
    let t;
    if (total > ATTR_BUDGET) {
      const room = total - N * ATTR_MIN;
      const want = ATTR_BUDGET - N * ATTR_MIN;
      t = room > 0 ? ATTR_MIN + (v - ATTR_MIN) * (want / room) : ATTR_BUDGET / N;
    } else {
      const room = N * ATTR_MAX - total;
      const want = N * ATTR_MAX - ATTR_BUDGET;
      t = room > 0 ? ATTR_MAX - (ATTR_MAX - v) * (want / room) : ATTR_BUDGET / N;
    }
    t = clamp(t, ATTR_MIN, ATTR_MAX);
    floors[i] = Math.floor(t);
    fracs[i] = t - floors[i];
    sum += floors[i];
  }

  // Largest-remainder distribution of whatever is left over.
  let guard = N * (ATTR_MAX - ATTR_MIN) + N + 4;
  while (sum < ATTR_BUDGET && guard-- > 0) {
    let best = -1, bestF = -1;
    for (let i = 0; i < N; i++) {
      if (floors[i] < ATTR_MAX && fracs[i] > bestF) { bestF = fracs[i]; best = i; }
    }
    if (best < 0) break;
    floors[best]++; fracs[best] = -1; sum++;
  }
  guard = N * (ATTR_MAX - ATTR_MIN) + N + 4;
  while (sum > ATTR_BUDGET && guard-- > 0) {
    let best = -1, bestF = 2;
    for (let i = 0; i < N; i++) {
      if (floors[i] > ATTR_MIN && fracs[i] < bestF) { bestF = fracs[i]; best = i; }
    }
    if (best < 0) break;
    floors[best]--; fracs[best] = 2; sum--;
  }

  for (let i = 0; i < N; i++) target[ATTR_KEYS[i]] = floors[i];
  return target;
}

/** Points still available to spend, given the current allocation. */
export function attributeTotal(a) {
  let t = 0;
  for (let i = 0; i < ATTR_KEYS.length; i++) t += a[ATTR_KEYS[i]] || 0;
  return t;
}
export function attributePointsLeft(a) {
  return ATTR_BUDGET - attributeTotal(a);
}

/**
 * Repair any avatar-shaped input into something safe to render and to store.
 * Never throws, never returns null, never mutates the input.
 */
export function validateAvatar(a) {
  const src = (a && typeof a === 'object') ? a : {};
  const out = {};

  out.id = (typeof src.id === 'string' && src.id) ? src.id.slice(0, 64) : newId();

  let name = typeof src.name === 'string' ? src.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) name = 'Player';
  out.name = name.slice(0, 16);

  const c = typeof src.country === 'string' ? src.country.trim().toUpperCase() : '';
  out.country = /^[A-Z]{2}$/.test(c) ? c : '';

  const st = Math.round(Number(src.skinTone));
  out.skinTone = Number.isFinite(st) ? clamp(st, 0, SKIN_TONES.length - 1) : DEFAULT_AVATAR.skinTone;
  out.hairStyle = oneOf(src.hairStyle, HAIR_STYLES, DEFAULT_AVATAR.hairStyle);
  out.hairColor = safeColor(src.hairColor, DEFAULT_AVATAR.hairColor);
  out.build = oneOf(src.build, BUILDS, DEFAULT_AVATAR.build);

  const h = Number(src.height);
  out.height = Number.isFinite(h)
    ? Math.round(clamp(h, HEIGHT_MIN, HEIGHT_MAX) * 100) / 100
    : DEFAULT_AVATAR.height;

  out.shirtColor = safeColor(src.shirtColor, DEFAULT_AVATAR.shirtColor);
  out.shirtAccent = safeColor(src.shirtAccent, DEFAULT_AVATAR.shirtAccent);
  out.shortsColor = safeColor(src.shortsColor, DEFAULT_AVATAR.shortsColor);
  out.shoeColor = safeColor(src.shoeColor, DEFAULT_AVATAR.shoeColor);
  out.hasHat = oneOf(src.hasHat, HATS, DEFAULT_AVATAR.hasHat);
  out.hatColor = safeColor(src.hatColor, out.shirtColor);
  out.wristbands = !!src.wristbands;
  out.racketColor = safeColor(src.racketColor, DEFAULT_AVATAR.racketColor);
  out.racketFrame = oneOf(src.racketFrame, RACKET_FRAME_KEYS, DEFAULT_AVATAR.racketFrame);

  out.handedness = oneOf(src.handedness, HANDS, DEFAULT_AVATAR.handedness);
  out.backhand = oneOf(src.backhand, BACKHANDS, DEFAULT_AVATAR.backhand);
  out.playstyle = oneOf(src.playstyle, PLAYSTYLE_KEYS, DEFAULT_AVATAR.playstyle);

  for (let i = 0; i < ATTR_KEYS.length; i++) {
    const k = ATTR_KEYS[i];
    out[k] = src[k];
  }
  balanceAttributes(out);

  return out;
}

/**
 * Build a fresh, valid avatar. Overrides are applied over DEFAULT_AVATAR.
 *
 * Asking for a playstyle without also naming attributes applies that preset's
 * spread — the playstyle IS the attribute preset. Pass any attribute explicitly
 * and the caller is assumed to know what it wants, so the preset stays out of it.
 */
export function createAvatar(overrides) {
  const base = {};
  for (const k in DEFAULT_AVATAR) base[k] = DEFAULT_AVATAR[k];
  if (overrides && typeof overrides === 'object') {
    for (const k in overrides) {
      if (overrides[k] !== undefined) base[k] = overrides[k];
    }
    const preset = PLAYSTYLES[overrides.playstyle];
    if (preset) {
      let explicit = false;
      for (let i = 0; i < ATTR_KEYS.length; i++) {
        if (overrides[ATTR_KEYS[i]] !== undefined) { explicit = true; break; }
      }
      if (!explicit) {
        for (let i = 0; i < ATTR_KEYS.length; i++) base[ATTR_KEYS[i]] = preset[ATTR_KEYS[i]];
      }
    }
  }
  if (!base.id) base.id = newId();
  return validateAvatar(base);
}

/** Apply a playstyle preset's attribute spread (already budget-exact). */
export function applyPlaystyle(avatar, style) {
  const preset = PLAYSTYLES[style];
  if (!preset) return avatar;
  avatar.playstyle = style;
  for (let i = 0; i < ATTR_KEYS.length; i++) {
    const k = ATTR_KEYS[i];
    avatar[k] = preset[k];
  }
  balanceAttributes(avatar);
  return avatar;
}

// ─────────────────────────────────────────────────────────────────────────────
// Randomisation (deterministic when seeded, so a lobby can generate the same
// AI opponent on every peer)
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  'Rafa', 'Mika', 'Yuki', 'Nico', 'Aria', 'Luca', 'Sami', 'Talia', 'Bruno', 'Ines',
  'Kai', 'Zora', 'Emil', 'Nadia', 'Otto', 'Priya', 'Dario', 'Lena', 'Marco', 'Tess',
];
const LAST_NAMES = [
  'Vance', 'Okoro', 'Sato', 'Reyes', 'Haas', 'Novak', 'Bahar', 'Lindqvist', 'Duarte',
  'Kovac', 'Meyer', 'Rossi', 'Nilsen', 'Abbas', 'Torres', 'Winter', 'Farah', 'Cole',
];
const COUNTRIES = ['ES', 'FR', 'US', 'AU', 'JP', 'IT', 'DE', 'AR', 'RS', 'GB', 'CA', 'BR', 'SE', 'NL'];

/**
 * A plausible random avatar. Correlations are intentional: a tall powerful
 * player gets serve-heavy attributes, a short lean one gets speed and defence,
 * so the randomiser produces characters instead of noise.
 */
export function randomAvatar(seed) {
  const rnd = mulberry32(
    Number.isFinite(seed) ? seed : (Math.random() * 0xffffffff) | 0
  );
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

  const height = Math.round((HEIGHT_MIN + rnd() * (HEIGHT_MAX - HEIGHT_MIN)) * 100) / 100;
  const tallness = (height - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN);   // 0..1

  const build = tallness > 0.72 ? (rnd() < 0.7 ? 'powerful' : 'athletic')
    : tallness < 0.28 ? (rnd() < 0.65 ? 'lean' : 'athletic')
      : pick(BUILDS);

  const style = tallness > 0.75 ? (rnd() < 0.55 ? 'serve-volley' : 'aggressive-baseliner')
    : tallness < 0.3 ? (rnd() < 0.6 ? 'counterpuncher' : 'baseliner')
      : pick(PLAYSTYLE_KEYS);

  const shirt = pick(KIT_COLORS);
  let accent = pick(KIT_COLORS);
  if (accent === shirt) accent = '#00e07a';

  const a = createAvatar({
    id: newId(),
    name: (pick(FIRST_NAMES) + ' ' + pick(LAST_NAMES)[0] + '.').slice(0, 16),
    country: pick(COUNTRIES),
    skinTone: Math.floor(rnd() * SKIN_TONES.length),
    hairStyle: pick(HAIR_STYLES),
    hairColor: pick(HAIR_COLORS),
    build,
    height,
    shirtColor: shirt,
    shirtAccent: accent,
    shortsColor: pick(KIT_COLORS),
    shoeColor: pick(SHOE_COLORS),
    hasHat: rnd() < 0.45 ? pick(HATS) : 'none',
    hatColor: rnd() < 0.6 ? shirt : pick(KIT_COLORS),
    wristbands: rnd() < 0.5,
    racketColor: pick(KIT_COLORS),
    racketFrame: pick(RACKET_FRAME_KEYS),
    handedness: rnd() < 0.14 ? 'left' : 'right',
    backhand: rnd() < 0.35 ? 'one' : 'two',
    playstyle: style,
  });

  applyPlaystyle(a, style);

  // Jitter the preset by a few swaps so two random players of the same style are
  // not identical, then re-balance back onto the budget.
  const swaps = 3 + Math.floor(rnd() * 4);
  for (let i = 0; i < swaps; i++) {
    const up = ATTR_KEYS[Math.floor(rnd() * ATTR_KEYS.length)];
    const down = ATTR_KEYS[Math.floor(rnd() * ATTR_KEYS.length)];
    if (up === down) continue;
    if (a[up] < ATTR_MAX && a[down] > ATTR_MIN) { a[up]++; a[down]--; }
  }
  balanceAttributes(a);
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence. localStorage can throw (Safari private mode, quota, disabled
// storage), so every access is guarded and failures degrade to an empty list.
// ─────────────────────────────────────────────────────────────────────────────

function readStore() {
  try {
    const raw = window.localStorage.getItem(AVATAR_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeStore(list) {
  try {
    window.localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    return false;
  }
}

/** All saved avatars, validated. Corrupt entries are dropped silently. */
export function listAvatars() {
  const raw = readStore();
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    out.push(validateAvatar(item));
  }
  return out;
}

export function getAvatar(id) {
  if (!id) return null;
  const list = listAvatars();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** Upsert by id. Returns the stored (validated) avatar. */
export function saveAvatar(avatar) {
  const a = validateAvatar(avatar);
  const list = listAvatars();
  let found = false;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === a.id) { list[i] = a; found = true; break; }
  }
  if (!found) list.push(a);
  writeStore(list);
  return a;
}

export function deleteAvatar(id) {
  if (!id) return false;
  const list = listAvatars();
  const next = [];
  let removed = false;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) { removed = true; continue; }
    next.push(list[i]);
  }
  if (removed) writeStore(next);
  return removed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Creator UI
// ─────────────────────────────────────────────────────────────────────────────

const CSS_ID = 'tnav-styles';
const ACCENT = '#00e07a';

const CSS = `
.tnav-overlay{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;
 justify-content:center;padding:24px;background:rgba(4,7,10,.72);
 -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
 font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,"Helvetica Neue",Arial,sans-serif;
 color:#e8edf3;font-size:13px;line-height:1.4;-webkit-font-smoothing:antialiased;
 animation:tnav-fade .18s ease-out}
@keyframes tnav-fade{from{opacity:0}to{opacity:1}}
@keyframes tnav-pop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
@keyframes tnav-shake{10%,90%{transform:translateX(-2px)}30%,70%{transform:translateX(3px)}50%{transform:translateX(-3px)}}
.tnav-panel{display:flex;width:min(1020px,100%);max-height:100%;overflow:hidden;
 background:linear-gradient(180deg,rgba(19,24,31,.96),rgba(12,15,20,.97));
 border:1px solid rgba(255,255,255,.10);border-radius:18px;
 box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 0 1px rgba(0,0,0,.4);
 animation:tnav-pop .22s cubic-bezier(.2,.9,.3,1)}
.tnav-left{width:300px;flex:none;padding:22px 20px;display:flex;flex-direction:column;gap:14px;
 border-right:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.018)}
.tnav-right{flex:1;min-width:0;display:flex;flex-direction:column}
.tnav-head{padding:20px 24px 12px;border-bottom:1px solid rgba(255,255,255,.07)}
.tnav-title{margin:0;font-size:17px;font-weight:650;letter-spacing:.2px}
.tnav-sub{margin:3px 0 0;font-size:12px;color:#8d98a6}
.tnav-body{flex:1;overflow-y:auto;padding:16px 24px 20px;scrollbar-width:thin}
.tnav-body::-webkit-scrollbar{width:9px}
.tnav-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.13);border-radius:9px;border:3px solid transparent;background-clip:content-box}
.tnav-foot{display:flex;gap:10px;align-items:center;padding:14px 24px;
 border-top:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.22)}
.tnav-stage{position:relative;border-radius:14px;overflow:hidden;
 background:radial-gradient(120% 90% at 50% 18%,#28313d 0%,#141a22 55%,#0b0e13 100%);
 border:1px solid rgba(255,255,255,.07)}
.tnav-stage canvas{display:block;width:100%;height:auto}
.tnav-badge{position:absolute;left:10px;top:10px;font-size:10px;letter-spacing:.9px;
 text-transform:uppercase;color:#93a0ae;background:rgba(0,0,0,.42);
 padding:3px 8px;border-radius:99px;border:1px solid rgba(255,255,255,.08)}
.tnav-sec{margin:0 0 18px}
.tnav-sec:last-child{margin-bottom:4px}
.tnav-legend{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
 margin:0 0 9px;font-size:10.5px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;color:#7b8794}
.tnav-legend em{font-style:normal;color:${ACCENT};font-weight:650;letter-spacing:.4px;text-transform:none;font-size:12px}
.tnav-row{display:flex;align-items:center;gap:10px;margin:0 0 9px;flex-wrap:wrap}
.tnav-lab{width:96px;flex:none;font-size:11.5px;color:#9aa5b2}
.tnav-grow{flex:1;min-width:150px}
.tnav-input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:9px;
 background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.11);color:#eef2f7;
 font:inherit;font-size:13px;outline:none;transition:border-color .12s,background .12s}
.tnav-input:focus{border-color:${ACCENT};background:rgba(0,224,122,.07)}
.tnav-input.tnav-bad{border-color:#ff5a5a;animation:tnav-shake .3s}
.tnav-seg{display:inline-flex;flex-wrap:wrap;gap:4px;padding:3px;border-radius:11px;
 background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08)}
.tnav-seg button{appearance:none;border:0;background:transparent;color:#98a3b1;font:inherit;
 font-size:12px;padding:5px 11px;border-radius:8px;cursor:pointer;transition:.12s;white-space:nowrap}
.tnav-seg button:hover{color:#e6ecf3;background:rgba(255,255,255,.06)}
.tnav-seg button.on{background:${ACCENT};color:#04150d;font-weight:640}
.tnav-seg button:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}
.tnav-sw{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.tnav-sw i{width:19px;height:19px;border-radius:6px;cursor:pointer;display:block;
 border:1px solid rgba(255,255,255,.16);box-shadow:inset 0 1px 0 rgba(255,255,255,.16);
 transition:transform .1s}
.tnav-sw i:hover{transform:scale(1.14)}
.tnav-sw i.on{outline:2px solid ${ACCENT};outline-offset:2px;transform:scale(1.1)}
.tnav-custom{position:relative;width:19px;height:19px;border-radius:6px;overflow:hidden;
 cursor:pointer;border:1px dashed rgba(255,255,255,.35);display:grid;place-items:center;
 font-size:12px;color:#cfd6de;line-height:1}
.tnav-custom input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;border:0;padding:0}
.tnav-slider{-webkit-appearance:none;appearance:none;height:4px;border-radius:4px;
 background:rgba(255,255,255,.15);outline:none;flex:1;min-width:140px}
.tnav-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;
 background:${ACCENT};cursor:pointer;border:2px solid #0d1117;box-shadow:0 0 0 1px ${ACCENT}}
.tnav-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:${ACCENT};
 cursor:pointer;border:2px solid #0d1117}
.tnav-val{width:64px;flex:none;text-align:right;font-variant-numeric:tabular-nums;color:#dfe6ee;font-size:12px}
.tnav-attr{display:grid;grid-template-columns:74px 26px 1fr 26px 22px;gap:7px;align-items:center;margin-bottom:6px}
.tnav-attr .n{font-size:11.5px;color:#9aa5b2}
.tnav-attr .v{font-size:12px;text-align:center;font-variant-numeric:tabular-nums;color:#e8eef5}
.tnav-attr button{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);
 color:#cbd4dd;width:24px;height:24px;border-radius:7px;cursor:pointer;font:inherit;font-size:14px;
 line-height:1;padding:0;transition:.12s}
.tnav-attr button:hover:not(:disabled){background:${ACCENT};color:#04150d;border-color:${ACCENT}}
.tnav-attr button:disabled{opacity:.28;cursor:default}
.tnav-bar{height:7px;border-radius:5px;background:rgba(255,255,255,.08);overflow:hidden}
.tnav-bar span{display:block;height:100%;border-radius:5px;
 background:linear-gradient(90deg,#0a9c60,${ACCENT});transition:width .14s ease-out}
.tnav-pts{font-variant-numeric:tabular-nums}
.tnav-pts.zero{color:#8d98a6}
.tnav-pts.over{color:#ff6b6b}
.tnav-btn{appearance:none;font:inherit;font-size:13px;font-weight:600;padding:9px 18px;border-radius:10px;
 cursor:pointer;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.06);color:#e5ebf2;
 transition:.13s}
.tnav-btn:hover{background:rgba(255,255,255,.12)}
.tnav-btn:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}
.tnav-btn.primary{background:${ACCENT};color:#04150d;border-color:${ACCENT};box-shadow:0 6px 18px rgba(0,224,122,.22)}
.tnav-btn.primary:hover{filter:brightness(1.08)}
.tnav-spacer{flex:1}
.tnav-err{color:#ff6b6b;font-size:12px;min-height:16px}
.tnav-hint{font-size:11px;color:#78838f;margin-top:2px}
@media (max-width:840px){
 .tnav-panel{flex-direction:column;overflow-y:auto}
 .tnav-left{width:auto;border-right:0;border-bottom:1px solid rgba(255,255,255,.07)}
}
`;

function injectStyles(doc) {
  if (doc.getElementById(CSS_ID)) return;
  const s = doc.createElement('style');
  s.id = CSS_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * Open the avatar creator.
 *
 * @param options {
 *   avatar?      avatar to edit (a copy is made; the original is untouched)
 *   title?       heading text
 *   subtitle?    sub-heading text
 *   persist?     default true — save to localStorage on confirm
 *   onChange?    called with the working avatar on every edit
 * }
 * @returns Promise<avatar|null>  null when cancelled.
 */
export function openAvatarCreator(options) {
  const opts = options || {};
  const doc = document;
  injectStyles(doc);

  // Working copy. Editing never touches the caller's object.
  const a = opts.avatar ? validateAvatar(opts.avatar) : createAvatar();

  return new Promise((resolve) => {
    let closed = false;
    let raf = 0;
    const syncFns = [];
    const prevFocus = doc.activeElement;

    const overlay = el('div', 'tnav-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', opts.title || 'Create player');
    overlay.tabIndex = -1;

    const panel = el('div', 'tnav-panel');
    overlay.appendChild(panel);

    // ── left column: live preview ────────────────────────────────────────────
    const left = el('div', 'tnav-left');
    const stage = el('div', 'tnav-stage');
    const badge = el('span', 'tnav-badge', 'Live preview');
    const canvas = doc.createElement('canvas');
    stage.appendChild(canvas);
    stage.appendChild(badge);
    left.appendChild(stage);

    const nameWrap = el('div');
    const nameLbl = el('div', 'tnav-legend');
    nameLbl.appendChild(el('span', null, 'Name'));
    const nameInput = doc.createElement('input');
    nameInput.className = 'tnav-input';
    nameInput.type = 'text';
    nameInput.maxLength = 16;
    nameInput.placeholder = 'Player name';
    nameInput.value = a.name;
    nameInput.setAttribute('aria-label', 'Player name');
    nameInput.addEventListener('input', () => {
      a.name = nameInput.value.slice(0, 16);
      nameInput.classList.remove('tnav-bad');
      err.textContent = '';
      changed();
    });
    nameWrap.appendChild(nameLbl);
    nameWrap.appendChild(nameInput);

    const countryInput = doc.createElement('input');
    countryInput.className = 'tnav-input';
    countryInput.type = 'text';
    countryInput.maxLength = 2;
    countryInput.placeholder = 'Country code (e.g. ES)';
    countryInput.value = a.country;
    countryInput.setAttribute('aria-label', 'Two letter country code');
    countryInput.addEventListener('input', () => {
      countryInput.value = countryInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
      a.country = countryInput.value;
      changed();
    });
    const countryWrap = el('div');
    countryWrap.style.marginTop = '8px';
    countryWrap.appendChild(countryInput);
    nameWrap.appendChild(countryWrap);

    const err = el('div', 'tnav-err');
    nameWrap.appendChild(err);
    left.appendChild(nameWrap);

    const statLine = el('div', 'tnav-hint');
    left.appendChild(statLine);
    panel.appendChild(left);

    // ── right column ─────────────────────────────────────────────────────────
    const right = el('div', 'tnav-right');
    const head = el('div', 'tnav-head');
    head.appendChild(el('h2', 'tnav-title', opts.title || 'Create your player'));
    head.appendChild(el('p', 'tnav-sub',
      opts.subtitle || 'Forty attribute points. Every strength has to be paid for.'));
    right.appendChild(head);

    const body = el('div', 'tnav-body');
    right.appendChild(body);
    panel.appendChild(right);

    // ── control builders ─────────────────────────────────────────────────────
    function section(label, extraNode) {
      const s = el('div', 'tnav-sec');
      const lg = el('div', 'tnav-legend');
      lg.appendChild(el('span', null, label));
      if (extraNode) lg.appendChild(extraNode);
      s.appendChild(lg);
      body.appendChild(s);
      return s;
    }

    function row(parent, label) {
      const r = el('div', 'tnav-row');
      if (label) r.appendChild(el('div', 'tnav-lab', label));
      parent.appendChild(r);
      return r;
    }

    function segmented(parent, label, values, labels, get, setter) {
      const r = row(parent, label);
      const wrap = el('div', 'tnav-seg');
      wrap.setAttribute('role', 'group');
      if (label) wrap.setAttribute('aria-label', label);
      const btns = [];
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const b = doc.createElement('button');
        b.type = 'button';
        b.textContent = labels ? (labels[v] || v) : v;
        b.addEventListener('click', () => { setter(v); changed(); });
        wrap.appendChild(b);
        btns.push(b);
      }
      r.appendChild(wrap);
      syncFns.push(() => {
        const cur = get();
        for (let i = 0; i < values.length; i++) btns[i].classList.toggle('on', values[i] === cur);
      });
      return wrap;
    }

    function swatches(parent, label, palette, get, setter, allowCustom) {
      const r = row(parent, label);
      const wrap = el('div', 'tnav-sw tnav-grow');
      wrap.setAttribute('role', 'group');
      if (label) wrap.setAttribute('aria-label', label);
      const chips = [];
      for (let i = 0; i < palette.length; i++) {
        const c = palette[i];
        const chip = doc.createElement('i');
        chip.style.background = c;
        chip.tabIndex = 0;
        chip.setAttribute('role', 'button');
        chip.setAttribute('aria-label', label + ' ' + c);
        const apply = () => { setter(c); changed(); };
        chip.addEventListener('click', apply);
        chip.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); }
        });
        wrap.appendChild(chip);
        chips.push(chip);
      }
      let picker = null;
      if (allowCustom !== false) {
        const custom = el('label', 'tnav-custom', '+');
        custom.title = 'Custom colour';
        picker = doc.createElement('input');
        picker.type = 'color';
        picker.setAttribute('aria-label', label + ' custom colour');
        picker.addEventListener('input', () => { setter(picker.value); changed(); });
        custom.appendChild(picker);
        wrap.appendChild(custom);
      }
      r.appendChild(wrap);
      syncFns.push(() => {
        const cur = (get() || '').toLowerCase();
        for (let i = 0; i < palette.length; i++) {
          chips[i].classList.toggle('on', palette[i].toLowerCase() === cur);
        }
        if (picker && /^#[0-9a-f]{6}$/.test(cur)) picker.value = cur;
      });
    }

    function toggle(parent, label, get, setter) {
      segmented(parent, label, ['on', 'off'], { on: 'On', off: 'Off' },
        () => (get() ? 'on' : 'off'),
        (v) => setter(v === 'on'));
    }

    // ── Identity ─────────────────────────────────────────────────────────────
    const secLook = section('Appearance');
    swatches(secLook, 'Skin', SKIN_TONES,
      () => SKIN_TONES[a.skinTone],
      (c) => { const i = SKIN_TONES.indexOf(c); if (i >= 0) a.skinTone = i; },
      false);
    segmented(secLook, 'Hair', HAIR_STYLES, null,
      () => a.hairStyle, (v) => { a.hairStyle = v; });
    swatches(secLook, 'Hair colour', HAIR_COLORS,
      () => a.hairColor, (c) => { a.hairColor = c; });
    segmented(secLook, 'Build', BUILDS, { lean: 'Lean', athletic: 'Athletic', powerful: 'Powerful' },
      () => a.build, (v) => { a.build = v; });

    // Height genuinely changes the drawn figure and the reach, so it is a real
    // trade-off rather than cosmetic: taller means a higher serve contact point.
    const hRow = row(secLook, 'Height');
    const hSlider = doc.createElement('input');
    hSlider.type = 'range';
    hSlider.className = 'tnav-slider';
    hSlider.min = String(HEIGHT_MIN);
    hSlider.max = String(HEIGHT_MAX);
    hSlider.step = '0.01';
    hSlider.value = String(a.height);
    hSlider.setAttribute('aria-label', 'Height in metres');
    const hVal = el('div', 'tnav-val');
    hSlider.addEventListener('input', () => {
      a.height = clamp(parseFloat(hSlider.value) || 1.85, HEIGHT_MIN, HEIGHT_MAX);
      changed();
    });
    hRow.appendChild(hSlider);
    hRow.appendChild(hVal);
    syncFns.push(() => {
      hSlider.value = String(a.height);
      const cm = Math.round(a.height * 100);
      const ft = Math.floor(cm / 30.48);
      const inch = Math.round((cm / 2.54) - ft * 12);
      hVal.textContent = cm + ' cm';
      hVal.title = ft + "'" + inch + '"';
    });

    // ── Kit ──────────────────────────────────────────────────────────────────
    const secKit = section('Kit');
    swatches(secKit, 'Shirt', KIT_COLORS, () => a.shirtColor, (c) => { a.shirtColor = c; });
    swatches(secKit, 'Accent', KIT_COLORS, () => a.shirtAccent, (c) => { a.shirtAccent = c; });
    swatches(secKit, 'Shorts', KIT_COLORS, () => a.shortsColor, (c) => { a.shortsColor = c; });
    swatches(secKit, 'Shoes', SHOE_COLORS, () => a.shoeColor, (c) => { a.shoeColor = c; });
    segmented(secKit, 'Headwear', HATS,
      { none: 'None', cap: 'Cap', visor: 'Visor', bandana: 'Bandana' },
      () => a.hasHat, (v) => { a.hasHat = v; });
    swatches(secKit, 'Hat colour', KIT_COLORS, () => a.hatColor, (c) => { a.hatColor = c; });
    toggle(secKit, 'Wristbands', () => a.wristbands, (v) => { a.wristbands = v; });
    swatches(secKit, 'Grip', KIT_COLORS, () => a.racketColor, (c) => { a.racketColor = c; });
    segmented(secKit, 'Frame', RACKET_FRAME_KEYS,
      { graphite: 'Graphite', matte: 'Matte', chrome: 'Chrome', neon: 'Neon' },
      () => a.racketFrame, (v) => { a.racketFrame = v; });

    // ── Play ─────────────────────────────────────────────────────────────────
    const secPlay = section('Style of play');
    segmented(secPlay, 'Hand', HANDS, { right: 'Right', left: 'Left' },
      () => a.handedness, (v) => { a.handedness = v; });
    segmented(secPlay, 'Backhand', BACKHANDS, { one: 'One-handed', two: 'Two-handed' },
      () => a.backhand, (v) => { a.backhand = v; });
    segmented(secPlay, 'Preset', PLAYSTYLE_KEYS, PLAYSTYLE_LABELS,
      () => a.playstyle, (v) => { applyPlaystyle(a, v); });
    const presetHint = el('div', 'tnav-hint',
      'Presets rewrite the attribute spread. Adjust freely afterwards.');
    secPlay.appendChild(presetHint);

    // ── Attributes ───────────────────────────────────────────────────────────
    const ptsBadge = el('em', 'tnav-pts');
    const secAttr = section('Attributes', ptsBadge);
    const attrRows = [];
    for (let i = 0; i < ATTR_KEYS.length; i++) {
      const k = ATTR_KEYS[i];
      const r = el('div', 'tnav-attr');
      const n = el('div', 'n', ATTR_LABELS[k]);
      const minus = doc.createElement('button');
      minus.type = 'button'; minus.textContent = '−';
      minus.setAttribute('aria-label', 'Decrease ' + ATTR_LABELS[k]);
      const bar = el('div', 'tnav-bar');
      const fill = el('span');
      bar.appendChild(fill);
      const plus = doc.createElement('button');
      plus.type = 'button'; plus.textContent = '+';
      plus.setAttribute('aria-label', 'Increase ' + ATTR_LABELS[k]);
      const v = el('div', 'v');

      minus.addEventListener('click', () => {
        if (a[k] > ATTR_MIN) { a[k]--; changed(); }
      });
      plus.addEventListener('click', () => {
        // Spending is gated on the remaining budget, so the total is always 40.
        if (a[k] < ATTR_MAX && attributePointsLeft(a) > 0) { a[k]++; changed(); }
      });

      r.appendChild(n); r.appendChild(minus); r.appendChild(bar); r.appendChild(plus); r.appendChild(v);
      secAttr.appendChild(r);
      attrRows.push({ k, minus, plus, fill, v });
    }
    syncFns.push(() => {
      const remaining = attributePointsLeft(a);
      ptsBadge.textContent = remaining + ' point' + (remaining === 1 ? '' : 's') + ' left';
      ptsBadge.className = 'tnav-pts' + (remaining === 0 ? ' zero' : remaining < 0 ? ' over' : '');
      for (let i = 0; i < attrRows.length; i++) {
        const rw = attrRows[i];
        const val = a[rw.k];
        rw.v.textContent = String(val);
        rw.fill.style.width = ((val - ATTR_MIN) / (ATTR_MAX - ATTR_MIN) * 100).toFixed(1) + '%';
        rw.minus.disabled = val <= ATTR_MIN;
        rw.plus.disabled = val >= ATTR_MAX || remaining <= 0;
      }
    });

    // ── footer ───────────────────────────────────────────────────────────────
    const foot = el('div', 'tnav-foot');
    const randBtn = el('button', 'tnav-btn', 'Randomise');
    randBtn.type = 'button';
    randBtn.addEventListener('click', () => {
      const r = randomAvatar();
      const keepId = a.id;
      for (const k in r) a[k] = r[k];
      a.id = keepId;
      nameInput.value = a.name;
      countryInput.value = a.country;
      nameInput.classList.remove('tnav-bad');
      err.textContent = '';
      changed();
    });

    const cancelBtn = el('button', 'tnav-btn', 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => close(null));

    const saveBtn = el('button', 'tnav-btn primary', 'Save player');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => {
      const nm = nameInput.value.replace(/\s+/g, ' ').trim();
      if (!nm) {
        err.textContent = 'Give your player a name.';
        // Drop the class and force a reflow first, otherwise a second click on
        // an already-invalid field would not restart the shake animation.
        nameInput.classList.remove('tnav-bad');
        void nameInput.offsetWidth;
        nameInput.classList.add('tnav-bad');
        nameInput.focus();
        return;
      }
      a.name = nm.slice(0, 16);
      const finished = validateAvatar(a);
      if (opts.persist !== false) saveAvatar(finished);
      close(finished);
    });

    foot.appendChild(randBtn);
    foot.appendChild(el('div', 'tnav-spacer'));
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);
    right.appendChild(foot);

    // ── preview rendering ────────────────────────────────────────────────────
    const PREV_W = 260, PREV_H = 330;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(PREV_W * dpr);
    canvas.height = Math.round(PREV_H * dpr);
    canvas.style.aspectRatio = PREV_W + ' / ' + PREV_H;
    const pctx = canvas.getContext('2d');

    // Cycle a couple of poses so the kit and the racket hand are both legible.
    const PREVIEW_POSES = ['ready', 'idle', 'swing', 'serve_hit'];
    const pose = {
      state: 'ready', phase: 0, facing: Math.PI,
      stamina: 1, vx: 0, vy: 0, swingType: 'forehand',
    };

    let t0 = 0;
    function frame(now) {
      if (closed) return;
      if (!t0) t0 = now;
      const t = (now - t0) / 1000;

      pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pctx.clearRect(0, 0, PREV_W, PREV_H);

      // Ground shadow, drawn by hand here because the preview has no camera.
      const groundY = PREV_H * 0.90;
      const scale = (PREV_H * 0.74) / a.height;   // pixels per metre
      pctx.save();
      pctx.globalAlpha = 0.34;
      pctx.beginPath();
      pctx.ellipse(PREV_W / 2, groundY + 2, 0.40 * scale, 0.40 * scale * 0.3, 0, 0, Math.PI * 2);
      pctx.fillStyle = '#000';
      pctx.fill();
      pctx.restore();

      // Rotate about the front so the face is visible most of the time.
      pose.facing = Math.PI + Math.sin(t * 0.55) * 1.85;
      const seg = Math.floor(t / 3.2) % PREVIEW_POSES.length;
      pose.state = PREVIEW_POSES[seg];
      const local = (t / 3.2) % 1;
      // Swings play once then hold; cyclic states loop.
      pose.phase = (pose.state === 'idle' || pose.state === 'ready')
        ? (t % 1.6) / 1.6
        : Math.min(1, local * 2.2);

      drawPlayerFigure(pctx, PREV_W / 2, groundY, scale, a, pose, { tilt: 0.30 });
      raf = window.requestAnimationFrame(frame);
    }
    raf = window.requestAnimationFrame(frame);

    // ── sync / lifecycle ─────────────────────────────────────────────────────
    function changed() {
      // Keep the model legal at all times so the preview can never render junk.
      a.height = clamp(a.height, HEIGHT_MIN, HEIGHT_MAX);
      for (let i = 0; i < syncFns.length; i++) syncFns[i]();
      const cm = Math.round(a.height * 100);
      statLine.textContent = a.build.charAt(0).toUpperCase() + a.build.slice(1) +
        ' · ' + cm + ' cm · ' +
        (a.handedness === 'left' ? 'Left' : 'Right') + '-handed · ' +
        (a.backhand === 'two' ? 'Two' : 'One') + '-handed BH';
      if (typeof opts.onChange === 'function') opts.onChange(a);
    }

    function focusables() {
      return overlay.querySelectorAll(
        'button, [href], input, select, textarea, i[tabindex], [tabindex]:not([tabindex="-1"])'
      );
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: wrap at both ends of the dialog.
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && doc.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && doc.activeElement === last) {
        e.preventDefault(); first.focus();
      } else if (!overlay.contains(doc.activeElement)) {
        e.preventDefault(); first.focus();
      }
    }

    overlay.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);   // click the backdrop to cancel
    });

    doc.body.appendChild(overlay);
    changed();
    nameInput.focus();
    nameInput.select();

    function close(result) {
      if (closed) return;
      closed = true;
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      overlay.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      syncFns.length = 0;
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (e) { /* element may be gone */ }
      }
      resolve(result);
    }
  });
}
