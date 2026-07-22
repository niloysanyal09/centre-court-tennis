/**
 * Procedural player rendering.
 *
 * The figure is an articulated stick-and-capsule skeleton solved in the player's
 * OWN body frame, then flattened to screen space. Body-frame axes:
 *
 *   r — the player's right (anatomical right, before handedness mirroring)
 *   f — the direction the player faces
 *   u — up, in metres above the court surface
 *
 * FACING CONVENTION (assumption the rest of the game must match):
 *   `facing` is measured so that the world-space forward vector is
 *       f = ( sin(facing), cos(facing) )
 *   i.e. facing = 0 points up-court (+y, away from the broadcast camera) and
 *   facing = PI points at the camera. This matches atan2(dx, dy).
 *
 * FLATTENING. The broadcast camera has no yaw or roll, so the mapping from body
 * frame to screen is a pure 2x1 projection and costs two multiplies per joint:
 *
 *   screenX = originX + ( r*cos(facing) + f*sin(facing) ) * scale
 *   screenY = originY - u*scale - dY*tilt*scale
 *
 * where dY is how much further from the camera the joint sits than the player's
 * ground point. `tilt` ~ sin(camera.pitch): looking down at the court, anything
 * further away rides higher on the screen. That single term is what stops a
 * forward-planted foot from looking pasted flat onto the ground.
 *
 * Everything is derived from the avatar's `height`, so a 2.05 m player really is
 * taller, really has a longer stride, and really reaches higher on a serve. The
 * racket is a fixed 0.686 m (a real 27" frame does not grow with the player).
 *
 * No per-frame allocation: the skeleton, the IK scratch and the pose descriptor
 * are module-level singletons, mutated in place. Drawing is synchronous, so a
 * single skeleton is safe even with four players plus a UI preview.
 */

import { PLAYER } from '../sim/constants.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ─────────────────────────────────────────────────────────────────────────────
// Palettes. These live here rather than in the avatar model because rendering is
// what actually knows how to use them; avatar.js imports and re-exports them for
// the creator UI. Keeping the dependency one-way (avatar → playerdraw) avoids a
// module cycle.
// ─────────────────────────────────────────────────────────────────────────────

export const SKIN_TONES = [
  '#f6d9c2', '#eec39a', '#dda878', '#c68a5c',
  '#a9683f', '#84492b', '#5d321c', '#3f2114',
];

export const HAIR_COLORS = [
  '#141110', '#2c211a', '#4a3020', '#6b4423',
  '#8c6239', '#b98c4e', '#d9bb7a', '#8f8f92', '#e2e2e4', '#7a2c1e',
];

export const HAIR_STYLES = [
  'short', 'buzz', 'medium', 'long', 'ponytail', 'bun', 'bald', 'curly', 'headband',
];

export const RACKET_FRAMES = {
  graphite: { frame: '#1b1b1f', gloss: 0.35 },
  matte:    { frame: '#2f3238', gloss: 0.10 },
  chrome:   { frame: '#c9ced6', gloss: 0.85 },
  neon:     { frame: '#00e07a', gloss: 0.60 },
};

/** Build archetypes: shoulder/hip half-width and limb thickness, as fractions of height. */
const BUILDS = {
  lean:     { shoulder: 0.104, hip: 0.077, limb: 0.86, torso: 0.90 },
  athletic: { shoulder: 0.117, hip: 0.086, limb: 1.00, torso: 1.00 },
  powerful: { shoulder: 0.131, hip: 0.096, limb: 1.16, torso: 1.13 },
};

// Skeleton proportions as fractions of total height (anthropometric, rounded).
const P_ANKLE = 0.045;
const P_KNEE  = 0.285;
const P_HIP   = 0.520;
const P_CHEST = 0.810;   // ~1.50 m at H=1.85, matches PLAYER.SHOULDER_HEIGHT
const P_NECK  = 0.868;
// Head centre + radius put the crown at exactly 1.0 H. The radius is a touch
// larger than anatomy (a real skull is ~0.065 H) because a slightly bigger head
// is what keeps a far-court player readable at 40 px tall.
const P_HEAD  = 0.930;
const P_HEADR = 0.070;
const L_THIGH = P_HIP - P_KNEE;          // 0.235 H
const L_SHIN  = P_KNEE - P_ANKLE;        // 0.240 H
const L_UPARM = 0.175;
const L_FOREARM = 0.160;

// Racket geometry in metres, measured from the butt cap.
const RK_LEN       = 0.686;
const RK_GRIP_HOLD = 0.105;   // where the palm sits
const RK_THROAT    = 0.330;
const RK_HEAD_LEN  = RK_LEN - RK_THROAT;
const RK_HEAD_W    = 0.245;

// ─────────────────────────────────────────────────────────────────────────────
// Scratch state (allocated once)
// ─────────────────────────────────────────────────────────────────────────────

const mkJoint = () => ({ r: 0, f: 0, u: 0, x: 0, y: 0 });

const S = {
  hip: mkJoint(), chest: mkJoint(), neck: mkJoint(), head: mkJoint(),
  // D = dominant side (racket hand), N = non-dominant. Handedness mirrors r later.
  shD: mkJoint(), shN: mkJoint(),
  elD: mkJoint(), elN: mkJoint(),
  hnD: mkJoint(), hnN: mkJoint(),
  hpD: mkJoint(), hpN: mkJoint(),
  knD: mkJoint(), knN: mkJoint(),
  ftD: mkJoint(), ftN: mkJoint(),
  toeD: mkJoint(), toeN: mkJoint(),
  rkButt: mkJoint(), rkThroat: mkJoint(), rkTip: mkJoint(), rkMid: mkJoint(),
};

const JOINTS = [
  S.hip, S.chest, S.neck, S.head,
  S.shD, S.shN, S.elD, S.elN, S.hnD, S.hnN,
  S.hpD, S.hpN, S.knD, S.knN, S.ftD, S.ftN, S.toeD, S.toeN,
  S.rkButt, S.rkThroat, S.rkTip, S.rkMid,
];

/** Pose metadata that is not a joint position. */
const M = {
  dom: 1, faceOpen: 0.5, tired: 0, bothHands: false,
  limb: 1, torso: 1, headR: 0.13, H: 1.85, shW: 0.216, hpW: 0.159,
};

/** Descriptor filled by drawPlayer so the sim entity is never re-wrapped. */
const _st = {
  state: 'idle', phase: 0, facing: Math.PI, stamina: 1,
  vx: 0, vy: 0, swingType: 'forehand',
};

const _ik = { r: 0, f: 0, u: 0, tr: 0, tf: 0, tu: 0 };

// Flattening parameters for the figure currently being drawn.
let _ox = 0, _oy = 0, _sc = 1, _cf = 0, _sf = 0, _dom = 1, _tilt = 0;

const set = (j, r, f, u) => { j.r = r; j.f = f; j.u = u; };

/**
 * Two-bone IK. Given a root, a target, and two segment lengths, find the middle
 * joint. `l` is how far along the root→target line the middle joint projects
 * (law of cosines) and `h` is how far it swings off that line; the pole vector
 * decides which way it swings — forward for knees, down-and-back for elbows.
 * Writes both the middle joint and the reach-clamped target into `_ik`.
 */
function solveIK(sr, sf, su, tr, tf, tu, a, b, pr, pf, pu) {
  let dr = tr - sr, df = tf - sf, du = tu - su;
  let d = Math.sqrt(dr * dr + df * df + du * du);
  const maxD = (a + b) * 0.998;
  if (d > maxD) { const k = maxD / d; dr *= k; df *= k; du *= k; d = maxD; }
  if (d < 1e-4) { du = -1e-4; d = 1e-4; }

  const inv = 1 / d;
  const ur = dr * inv, uf = df * inv, uu = du * inv;

  const l = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - l * l));

  // Gram-Schmidt the pole hint against the limb axis so the bend plane contains
  // the limb but still leans the way we asked.
  let qr = pr, qf = pf, qu = pu;
  const dot = qr * ur + qf * uf + qu * uu;
  qr -= ur * dot; qf -= uf * dot; qu -= uu * dot;
  let qm = Math.sqrt(qr * qr + qf * qf + qu * qu);
  if (qm < 1e-4) { qr = -uu; qf = 0; qu = ur; qm = Math.sqrt(qr * qr + qu * qu) || 1; }
  const qi = h / qm;

  _ik.r = sr + ur * l + qr * qi;
  _ik.f = sf + uf * l + qf * qi;
  _ik.u = su + uu * l + qu * qi;
  _ik.tr = sr + dr; _ik.tf = sf + df; _ik.tu = su + du;
  return _ik;
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour helpers. Shading and atmospheric haze are both pure functions of
// (colour, shade index, fade step), so they memoise perfectly.
// ─────────────────────────────────────────────────────────────────────────────

const SHADES = [1.0, 0.80, 0.62];   // lit, side, shadow
const FADE_STEPS = 8;
const _tintCache = new Map();
const _rgbCache = new Map();

function parseHex(hex) {
  let v = _rgbCache.get(hex);
  if (v !== undefined) return v;
  let h = hex;
  if (h.charCodeAt(0) === 35) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  v = Number.isNaN(n) ? 0x888888 : n & 0xffffff;
  _rgbCache.set(hex, v);
  return v;
}

/**
 * shadeIdx picks the lighting tier; fadeStep (0..FADE_STEPS) is the atmospheric
 * blend toward the haze colour used as the depth cue for far-court players.
 */
function tint(color, shadeIdx, fadeStep, haze) {
  const key = color + '|' + shadeIdx + '|' + fadeStep + '|' + haze;
  let out = _tintCache.get(key);
  if (out !== undefined) return out;

  const c = parseHex(color);
  const k = SHADES[shadeIdx];
  let r = ((c >> 16) & 255) * k;
  let g = ((c >> 8) & 255) * k;
  let b = (c & 255) * k;

  if (fadeStep > 0) {
    const hz = parseHex(haze);
    const t = fadeStep / FADE_STEPS;
    r = lerp(r, (hz >> 16) & 255, t);
    g = lerp(g, (hz >> 8) & 255, t);
    b = lerp(b, hz & 255, t);
  }
  out = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  if (_tintCache.size > 6000) _tintCache.clear();
  _tintCache.set(key, out);
  return out;
}

// Live palette for the figure being drawn (avoids threading 12 args everywhere).
let _fadeStep = 0;
let _haze = '#8fa6bd';
let _hzR = 0x8f, _hzG = 0xa6, _hzB = 0xbd;   // haze split into channels for gradients
const col = (c, s) => tint(c, s, _fadeStep, _haze);

// ─────────────────────────────────────────────────────────────────────────────
// Lighting model + volumetric shading.
//
// All shading is done on the already-flattened screen-space primitives, so the
// key light is expressed as a SCREEN direction (screen y points DOWN). That makes
// a top-down floodlight invariant to the player's facing — exactly right — while
// the torso/chest highlight still slides as the player turns, because it keys off
// the projected shoulder axis, which rotates.
//
// The single trick that buys most of the "3D" is a gradient laid PERPENDICULAR to
// each limb axis: rim/terminator/mid/highlight/lit-edge. Gradients are cached by
// (colour, shade, light-perp bucket, radius tier, haze step, light signature) and
// reused via a per-limb orthonormal ctx.transform, so the hot path allocates
// nothing after warm-up.
// ─────────────────────────────────────────────────────────────────────────────

const _L = {
  dx: -0.34, dy: -0.94,     // key direction in screen space (toward the light)
  exposure: 1.0,            // overall exposure (venue.ambientLight)
  keyTint: 0xffffff, keyTintAmt: 0.06,
  rim: 0.45, rimTint: 0xdfe8f5,
  ao: 0.9,                  // AO / contact strength (from shadowAlpha)
  bounce: 0x2a2620, bounceAmt: 0.12,
  sig: 0,
};

// Radius tiers for the limb-gradient cache. A limb's true radius snaps to the
// nearest tier; the gradient is built spanning that tier so the highlight band
// lands in roughly the right place without a per-radius allocation.
const R_TIERS = [1.5, 2.2, 3, 4, 5.5, 7.5, 10, 13.5, 18, 24, 32, 44];
function rTier(R) {
  let best = 0, bd = 1e9;
  for (let i = 0; i < R_TIERS.length; i++) {
    const d = Math.abs(R_TIERS[i] - R);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

const _gradCache = new Map();

/** Derive the screen-space light rig from a venue (null → neutral studio). */
function deriveLight(venue) {
  let dx = -0.34, dy = -0.94, exposure = 1.0;
  let keyTint = 0xffffff, keyTintAmt = 0.06, rim = 0.42, rimTint = 0xdfe8f5;
  let ao = 0.85, bounce = 0x2a2620, bounceAmt = 0.12;

  if (venue) {
    const amb = venue.ambientLight != null ? venue.ambientLight : 1.0;
    exposure = clamp(amb, 0.6, 1.4);
    ao = clamp((venue.shadowAlpha != null ? venue.shadowAlpha : 0.3) * 1.7, 0.12, 1.0);
    const tod = venue.timeOfDay;
    const trim = venue.stadium && venue.stadium.wallTrim;

    if (venue.floodlit) {
      dx = -0.28; dy = -0.96;                  // steep top-down key
      if (venue.indoor) {
        rim = 0.95; rimTint = parseHex(trim || '#00c8ff');
        keyTint = 0xeef6ff; keyTintAmt = 0.11; bounce = 0x101a2a; bounceAmt = 0.10;
      } else {
        rim = 0.85; rimTint = 0xeaf2ff;
        keyTint = 0xffffff; keyTintAmt = 0.09; bounce = 0x142442; bounceAmt = 0.10;
      }
    } else if (tod === 'afternoon') {
      dx = -0.64; dy = -0.58;                   // low, raking, warm
      keyTint = 0xfff0d6; keyTintAmt = 0.17;
      rim = (venue.shadowAlpha != null && venue.shadowAlpha < 0.2) ? 0.15 : 0.5;  // London overcast → almost none
      rimTint = 0xfff2dc;
    } else {                                    // 'day' / harsh sun
      dx = -0.33; dy = -0.86;
      keyTint = 0xfff4e0; keyTintAmt = 0.15; rim = 0.55; rimTint = 0xfff2e0;
    }

    const surf = venue.surface || '';
    if (surf === 'clay') { bounce = 0xc1683a; bounceAmt = 0.20; }
    else if (surf === 'grass') { bounce = 0x3f6b3a; bounceAmt = 0.13; }
    else if (surf === 'indoor') { bounce = 0x121e2c; bounceAmt = 0.10; }
  }

  const m = Math.hypot(dx, dy) || 1;
  _L.dx = dx / m; _L.dy = dy / m;
  _L.exposure = exposure;
  _L.keyTint = keyTint; _L.keyTintAmt = keyTintAmt;
  _L.rim = rim; _L.rimTint = rimTint;
  _L.ao = ao; _L.bounce = bounce; _L.bounceAmt = bounceAmt;
  // Signature so the gradient cache never returns a colour built for another rig.
  _L.sig = ((exposure * 20) | 0) * 131 + ((rim * 20) | 0) * 17
    + (keyTint & 0xff) + ((rimTint & 0xff) << 3) + (bounce & 0xff)
    + ((_L.dx * 15) | 0) * 3 + ((_L.dy * 15) | 0);
}

/**
 * Add the five cylindrical stops to a gradient whose parameter runs from the
 * -perp silhouette edge (position 0) to the +perp edge (position 1). `s` is the
 * light projected onto that perpendicular axis, in [-1, 1].
 */
function addCylStops(g, baseInt, shadeIdx, s) {
  const sgn = s < 0 ? -1 : 1;
  const a = Math.min(1, Math.abs(s));
  const exp = _L.exposure;

  let br = (baseInt >> 16) & 255, bg = (baseInt >> 8) & 255, bb = baseInt & 255;
  if (shadeIdx === 1) {                         // far limb: desaturate + darken
    const lum = br * 0.3 + bg * 0.59 + bb * 0.11;
    br = lerp(br, lum, 0.16) * 0.86;
    bg = lerp(bg, lum, 0.16) * 0.86;
    bb = lerp(bb, lum, 0.16) * 0.86;
  }
  const peak = 0.24 + 0.36 * a;
  const fadeT = _fadeStep > 0 ? _fadeStep / FADE_STEPS : 0;

  const put = (w, k, addC, addA) => {
    let r = br * k * exp, gg = bg * k * exp, b = bb * k * exp;
    if (addC >= 0) {
      r = lerp(r, (addC >> 16) & 255, addA);
      gg = lerp(gg, (addC >> 8) & 255, addA);
      b = lerp(b, addC & 255, addA);
    }
    if (fadeT > 0) { r = lerp(r, _hzR, fadeT); gg = lerp(gg, _hzG, fadeT); b = lerp(b, _hzB, fadeT); }
    const pos = clamp((w * sgn + 1) * 0.5, 0, 1);
    g.addColorStop(pos,
      'rgb(' + (r > 255 ? 255 : r < 0 ? 0 : r | 0) + ',' +
      (gg > 255 ? 255 : gg < 0 ? 0 : gg | 0) + ',' +
      (b > 255 ? 255 : b < 0 ? 0 : b | 0) + ')');
  };

  const rimK = 0.42 + 0.55 * _L.rim;
  const rimA = 0.16 + 0.5 * _L.rim;
  put(-1.0, rimK, _L.rimTint, rimA);            // back/rim light on the shadow edge
  put(-0.5, 0.42, _L.bounce, _L.bounceAmt);     // terminator core + warm court bounce
  put(0.0, 0.72, -1, 0);
  put(peak, 1.05, _L.keyTint, _L.keyTintAmt);   // key highlight
  put(1.0, 0.9, -1, 0);                         // lit edge, curvature falloff
}

/** Cached perpendicular gradient for a limb, in the local frame (x = perp). */
function limbGrad(ctx, baseColor, shadeIdx, s, R) {
  const sBucket = Math.round(clamp(s, -1, 1) * 4);
  const rt = rTier(R);
  const key = baseColor + '|' + shadeIdx + '|' + sBucket + '|' + rt + '|' + _fadeStep + '|' + _L.sig;
  let g = _gradCache.get(key);
  if (g !== undefined) return g;

  const Rb = R_TIERS[rt];
  g = ctx.createLinearGradient(-Rb, 0, Rb, 0);
  addCylStops(g, parseHex(baseColor), shadeIdx, sBucket / 4);
  if (_gradCache.size > 4000) _gradCache.clear();
  _gradCache.set(key, g);
  return g;
}

/**
 * Draw a tapered capsule with cylindrical shading. Silhouette is identical to
 * taper(); the fill is a cached perpendicular gradient positioned by an
 * orthonormal transform (det = -1, never degenerate for a real limb).
 */
function litTaper(ctx, ax, ay, ra, bx, by, rb, baseColor, shadeIdx) {
  if (!(isFinite(ax) && isFinite(ay) && isFinite(bx) && isFinite(by))) return;
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  const R = Math.max(ra, rb);
  if (!(len > 1e-3)) { litDisc(ctx, ax, ay, R, baseColor, shadeIdx); return; }

  const ux = dx / len, uy = dy / len;           // axis
  const px = -uy, py = ux;                       // perpendicular (screen)
  const s = _L.dx * px + _L.dy * py;
  const g = limbGrad(ctx, baseColor, shadeIdx, s, R);

  ctx.save();
  try {
    // local x → perp, local y → axis. Orthonormal, |det| = 1.
    ctx.transform(px, py, ux, uy, ax, ay);
    taperPath(ctx, 0, 0, ra, 0, len, rb);
    ctx.fillStyle = g;
    ctx.fill();
  } finally {
    ctx.restore();
  }
}

/** Cached spherical (radial) gradient with the highlight offset toward the light. */
function sphereGrad(ctx, baseColor, shadeIdx, R) {
  const rt = rTier(R);
  const key = 'S|' + baseColor + '|' + shadeIdx + '|' + rt + '|' + _fadeStep + '|' + _L.sig;
  let g = _gradCache.get(key);
  if (g !== undefined) return g;

  const Rb = R_TIERS[rt];
  const hx = _L.dx * Rb * 0.42, hy = _L.dy * Rb * 0.42;
  g = ctx.createRadialGradient(hx, hy, Rb * 0.04, 0, 0, Rb * 1.03);

  let br = (parseHex(baseColor) >> 16) & 255, bg = (parseHex(baseColor) >> 8) & 255, bb = parseHex(baseColor) & 255;
  if (shadeIdx === 1) { const l = br * 0.3 + bg * 0.59 + bb * 0.11; br = lerp(br, l, 0.16) * 0.86; bg = lerp(bg, l, 0.16) * 0.86; bb = lerp(bb, l, 0.16) * 0.86; }
  const exp = _L.exposure;
  const fadeT = _fadeStep > 0 ? _fadeStep / FADE_STEPS : 0;
  const put = (pos, k, addC, addA) => {
    let r = br * k * exp, gg = bg * k * exp, b = bb * k * exp;
    if (addC >= 0) { r = lerp(r, (addC >> 16) & 255, addA); gg = lerp(gg, (addC >> 8) & 255, addA); b = lerp(b, addC & 255, addA); }
    if (fadeT > 0) { r = lerp(r, _hzR, fadeT); gg = lerp(gg, _hzG, fadeT); b = lerp(b, _hzB, fadeT); }
    g.addColorStop(pos, 'rgb(' + (r > 255 ? 255 : r | 0) + ',' + (gg > 255 ? 255 : gg | 0) + ',' + (b > 255 ? 255 : b | 0) + ')');
  };
  put(0.0, 1.08, _L.keyTint, _L.keyTintAmt);
  put(0.45, 0.82, -1, 0);
  put(0.82, 0.5, -1, 0);                         // terminator
  put(1.0, 0.44 + 0.5 * _L.rim, _L.rimTint, 0.14 + 0.4 * _L.rim);   // rim
  if (_gradCache.size > 4000) _gradCache.clear();
  _gradCache.set(key, g);
  return g;
}

function litDisc(ctx, cx, cy, R, baseColor, shadeIdx) {
  if (!(isFinite(cx) && isFinite(cy) && R > 0.2)) {
    if (isFinite(cx) && isFinite(cy) && R > 0) disc(ctx, cx, cy, R, col(baseColor, shadeIdx));
    return;
  }
  const g = sphereGrad(ctx, baseColor, shadeIdx, R);
  ctx.save();
  try {
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
  } finally {
    ctx.restore();
  }
}

// Cached ambient-occlusion falloff (black → transparent), scaled per use.
const AO_REF = 32;
let _aoGrad = null;
function aoGradient(ctx) {
  if (_aoGrad) return _aoGrad;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, AO_REF);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  _aoGrad = g;
  return g;
}

/** Soft dark contact blob (limb-into-torso, under chin, hem, etc.). */
function aoBlob(ctx, x, y, rx, ry, strength) {
  if (!(isFinite(x) && isFinite(y) && rx > 0.3 && ry > 0.3)) return;
  const a = clamp(strength * _L.ao, 0, 0.85);
  if (a < 0.02) return;
  const g = aoGradient(ctx);
  ctx.save();
  try {
    ctx.globalAlpha = a;
    ctx.translate(x, y);
    ctx.scale(rx / AO_REF, ry / AO_REF);
    ctx.beginPath();
    ctx.arc(0, 0, AO_REF, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
  } finally {
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pose construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill S/M from an avatar and an animation descriptor.
 * Poses are authored in the body frame with the DOMINANT side on +r, so a
 * left-hander is literally the mirror image (applied at flatten time).
 */
function buildPose(av, st) {
  const H = av.height || PLAYER.HEIGHT;
  const B = BUILDS[av.build] || BUILDS.athletic;
  const dom = av.handedness === 'left' ? -1 : 1;
  const tired = 1 - clamp(st.stamina == null ? 1 : st.stamina, 0, 1);
  const state = st.state || 'idle';
  const p = clamp(st.phase || 0, 0, 1);
  const swing = st.swingType || 'forehand';
  const isBack = swing === 'backhand' || swing === 'slice';
  const twoH = isBack && av.backhand === 'two' && swing !== 'slice';

  M.dom = dom; M.tired = tired; M.H = H;
  M.limb = B.limb; M.torso = B.torso;
  M.headR = P_HEADR * H;
  M.shW = B.shoulder * H;      // shoulder half-width, metres
  M.hpW = B.hip * H;           // hip half-width, metres
  M.bothHands = false;
  M.faceOpen = 0.55;

  const facing = st.facing || 0;
  const fwx = Math.sin(facing), fwy = Math.cos(facing);
  const vx = st.vx || 0, vy = st.vy || 0;
  const spd = Math.sqrt(vx * vx + vy * vy);
  const spdN = clamp(spd / PLAYER.MAX_SPEED, 0, 1);

  // Velocity in the body frame. The player's right axis in world space is
  // (cos(facing), -sin(facing)); mirroring for handedness keeps the pose honest.
  let runF = 1, runR = 0;
  if (spd > 0.08) {
    const iv = 1 / spd;
    runF = (vx * fwx + vy * fwy) * iv;
    runR = (vx * fwy - vy * fwx) * iv * dom;
  }

  // ── controls, defaulted to a neutral standing pose ─────────────────────────
  let crouch = 0.22;             // 0 = legs straight, 1 = ~0.19 H hip drop
  let stance = 0.112 * H;        // half the distance between the feet on r
  let ftDr = 0, ftDf = 0, ftDu = 0;
  let ftNr = 0, ftNf = 0, ftNu = 0;
  let leanF = 0.02 * H, leanR = 0;
  let twist = 0;                 // + rotates the dominant shoulder forward
  let hop = 0;
  let headF = 0, headR = 0, headU = 0;
  let toeSpreadD = 0.18, toeSpreadN = -0.18;   // toe-out, in radians of body yaw

  // Hand targets, absolute in the body frame.
  let hDr = 0.20 * H, hDf = 0.26 * H, hDu = 0.62 * H;
  let hNr = -0.06 * H, hNf = 0.30 * H, hNu = 0.63 * H;
  // Racket shaft direction (butt → tip); normalised during assembly.
  let rkR = 0.18, rkF = 0.55, rkU = 0.81;

  switch (state) {
    case 'idle': {
      // Slow breathing bob. Fatigue both shrinks the bob and straightens the
      // legs — a gassed player stands up tall between points instead of coiling.
      const bob = Math.sin(p * TAU * (1 - 0.35 * tired));
      crouch = 0.20 - 0.12 * tired + 0.025 * bob;
      stance = (0.115 + 0.01 * tired) * H;
      leanF = (0.02 + 0.035 * tired) * H;
      hDu = (0.60 - 0.13 * tired) * H + 0.008 * H * bob;
      hDr = (0.17 + 0.05 * tired) * H;
      hDf = (0.26 - 0.10 * tired) * H;
      hNr = -0.03 * H; hNf = 0.30 * H; hNu = (0.63 - 0.12 * tired) * H;
      // Racket droops toward the ground as the legs go.
      rkR = lerp(0.15, 0.22, tired);
      rkF = lerp(0.52, 0.72, tired);
      rkU = lerp(0.84, -0.30, tired);
      headF = 0.012 * H * tired * 2;
      headU = -0.02 * H * tired;
      M.faceOpen = 0.5;
      break;
    }

    case 'ready': {
      // Split-step: a short hop, then land wide and low. The hop arc peaks at
      // mid-phase; the crouch is shallow in the air and deep on the landing.
      const arc = Math.sin(p * Math.PI);
      hop = arc * 0.075 * H;
      crouch = 0.28 + 0.36 * p * p - 0.16 * arc;
      // Wide, but not so wide the legs straighten out and lock the IK.
      stance = (0.12 + 0.08 * p) * H;
      ftDu = ftNu = arc * 0.055 * H;
      ftDf = ftNf = -0.02 * H;
      leanF = 0.10 * H;
      toeSpreadD = 0.34; toeSpreadN = -0.34;
      hDr = 0.14 * H; hDf = 0.34 * H; hDu = 0.74 * H;
      rkR = 0.10; rkF = 0.35; rkU = 0.93;
      M.bothHands = true;
      M.faceOpen = 0.55;
      break;
    }

    case 'run': {
      // Gait cycle: at a = 0 the foot is fully back and planted; it lifts and
      // swings through a = PI/2, plants forward at a = PI, then drives back on
      // the ground for the second half. The other leg is offset by PI.
      const a = p * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      const stride = (0.19 + 0.17 * spdN) * H;
      const lift = (0.06 + 0.11 * spdN) * H;

      ftDf = -ca * stride * runF; ftDr = -ca * stride * runR;
      ftNf = ca * stride * runF;  ftNr = ca * stride * runR;
      ftDu = Math.max(0, sa) * lift;
      ftNu = Math.max(0, -sa) * lift;
      // The hips rise slightly at mid-stride, which is what sells a run.
      hop = Math.abs(sa) * 0.018 * H;
      crouch = 0.30 + 0.10 * spdN;
      stance = 0.075 * H;

      const lean = (0.06 + 0.16 * spdN) * H;
      leanF = lean * runF; leanR = lean * runR;
      headF = leanF * 0.25; headR = leanR * 0.25;

      // Contralateral arm swing; the racket arm carries the racket so it swings
      // about half as far as the free arm.
      twist = -sa * 0.30;
      hDr = 0.24 * H; hDf = (0.20 + 0.16 * sa) * H; hDu = (0.60 + 0.04 * sa) * H;
      hNr = -0.20 * H; hNf = (0.16 - 0.30 * sa) * H; hNu = (0.62 + 0.07 * -sa) * H;
      rkR = 0.30; rkF = 0.62; rkU = 0.72;
      M.faceOpen = 0.3;
      break;
    }

    case 'slide': {
      // Clay slide: lead leg extended along the travel direction, trailing leg
      // folded under, hips very low, torso upright and braced against the slide.
      crouch = 0.62 + 0.18 * p;
      stance = 0.06 * H;
      ftDf = 0.42 * H * runF; ftDr = 0.42 * H * runR;
      ftNf = -0.16 * H * runF; ftNr = -0.16 * H * runR;
      leanF = -0.05 * H * runF + 0.05 * H;
      leanR = -0.06 * H * runR;
      twist = -0.25;
      hDr = 0.34 * H; hDf = 0.30 * H; hDu = 0.66 * H;
      hNr = -0.34 * H; hNf = 0.02 * H; hNu = 0.74 * H;
      rkR = 0.45; rkF = 0.55; rkU = 0.70;
      M.faceOpen = 0.4;
      break;
    }

    case 'windup': {
      // Coil. Shoulders turn away from the intended contact point; weight loads
      // onto the back foot. p eases from a ready stance into a full takeback.
      const e = p * p * (3 - 2 * p);
      crouch = 0.34 + 0.16 * e;
      stance = (0.16 + 0.06 * e) * H;
      if (isBack) {
        twist = lerp(0, 0.85, e);
        ftDf = 0.10 * H * e; ftNf = -0.06 * H * e;
        hDr = lerp(0.18, -0.34, e) * H;
        hDf = lerp(0.30, -0.06, e) * H;
        hDu = lerp(0.70, 0.80, e) * H;
        hNr = lerp(-0.10, -0.30, e) * H;
        hNf = lerp(0.30, 0.02, e) * H;
        hNu = lerp(0.68, 0.76, e) * H;
        rkR = -0.30; rkF = -0.35; rkU = 0.89;
        M.bothHands = twoH;
      } else {
        twist = lerp(0, -0.80, e);
        ftDf = -0.08 * H * e; ftNf = 0.12 * H * e;
        hDr = lerp(0.18, 0.44, e) * H;
        hDf = lerp(0.30, -0.30, e) * H;
        hDu = lerp(0.66, 0.80, e) * H;
        hNr = lerp(-0.06, -0.36, e) * H;
        hNf = lerp(0.30, 0.24, e) * H;
        hNu = lerp(0.64, 0.72, e) * H;
        rkR = 0.35; rkF = -0.45; rkU = 0.82;
      }
      leanF = 0.06 * H;
      M.faceOpen = lerp(0.35, 0.15, e);   // frame turns edge-on in the takeback
      break;
    }

    case 'swing': {
      // Uncoil through contact. Hips lead the shoulders, so the pelvis twist
      // (applied at 35 % in assembly) always runs ahead of the arm.
      const e = p * p;
      crouch = 0.46 - 0.24 * e;
      stance = (0.21 - 0.03 * e) * H;
      if (isBack) {
        twist = lerp(0.85, -0.35, e);
        ftDf = 0.14 * H; ftNf = -0.05 * H;
        hDr = lerp(-0.34, -0.30, e) * H;
        hDf = lerp(-0.06, 0.50, e) * H;
        hDu = lerp(0.80, 0.66, e) * H;
        hNr = lerp(-0.30, -0.24, e) * H;
        hNf = lerp(0.02, 0.44, e) * H;
        hNu = lerp(0.76, 0.66, e) * H;
        rkR = lerp(-0.40, -0.62, e); rkF = lerp(-0.30, 0.55, e); rkU = 0.60;
        M.bothHands = twoH;
      } else {
        twist = lerp(-0.80, 0.42, e);
        ftDf = -0.06 * H; ftNf = 0.16 * H;
        hDr = lerp(0.44, 0.30, e) * H;
        hDf = lerp(-0.30, 0.50, e) * H;
        hDu = lerp(0.80, 0.64, e) * H;
        hNr = lerp(-0.36, -0.30, e) * H;
        hNf = lerp(0.24, -0.02, e) * H;
        hNu = lerp(0.72, 0.78, e) * H;
        rkR = lerp(0.55, 0.42, e); rkF = lerp(-0.35, 0.62, e); rkU = 0.62;
      }
      leanF = 0.09 * H;
      // The face rolls from edge-on to square right at contact.
      M.faceOpen = lerp(0.2, 0.95, Math.min(1, e * 1.6));
      break;
    }

    case 'followthrough': {
      const e = p * p * (3 - 2 * p);
      crouch = 0.24 + 0.08 * (1 - e);
      stance = 0.20 * H;
      if (isBack) {
        // One-handed backhand finish: arms thrown apart, chest open.
        twist = lerp(-0.35, -0.70, e);
        hDr = lerp(-0.30, -0.46, e) * H;
        hDf = lerp(0.50, 0.16, e) * H;
        hDu = lerp(0.66, 0.94, e) * H;
        hNr = lerp(-0.24, 0.34, e) * H;
        hNf = lerp(0.44, -0.26, e) * H;
        hNu = lerp(0.66, 0.60, e) * H;
        rkR = -0.55; rkF = 0.20; rkU = 0.80;
        M.bothHands = twoH && e < 0.5;
      } else {
        // Forehand wraps over the non-dominant shoulder.
        twist = lerp(0.42, 0.80, e);
        hDr = lerp(0.30, -0.22, e) * H;
        hDf = lerp(0.50, 0.04, e) * H;
        hDu = lerp(0.64, 1.00, e) * H;
        hNr = lerp(-0.30, -0.26, e) * H;
        hNf = lerp(-0.02, 0.10, e) * H;
        hNu = lerp(0.78, 0.70, e) * H;
        rkR = lerp(0.30, -0.35, e); rkF = lerp(0.70, -0.55, e); rkU = lerp(0.55, -0.40, e);
      }
      leanF = 0.05 * H;
      ftDf = -0.04 * H; ftNf = 0.18 * H;
      M.faceOpen = lerp(0.9, 0.35, e);
      break;
    }

    case 'serve_toss': {
      // Trophy position. Non-dominant arm goes straight up with the ball, the
      // racket hand drops down and back, and the back arches.
      const e = p * p * (3 - 2 * p);
      crouch = 0.22 + 0.42 * e;
      stance = 0.13 * H;
      ftDf = -0.14 * H; ftNf = 0.14 * H;
      ftNr = -0.02 * H;
      leanF = -0.06 * H * e;              // arch back
      twist = -0.45 * e;
      headU = 0.03 * H * e; headF = -0.02 * H * e;
      // Fully extended tossing arm: shoulder height + arm length.
      hNr = lerp(-0.10, -0.05, e) * H;
      hNf = lerp(0.24, 0.20, e) * H;
      hNu = lerp(0.70, 1.14, e) * H;
      hDr = lerp(0.22, 0.32, e) * H;
      hDf = lerp(0.20, -0.26, e) * H;
      hDu = lerp(0.62, 0.86, e) * H;
      rkR = 0.28; rkF = -0.20; rkU = 0.94;
      M.faceOpen = 0.2;
      break;
    }

    case 'serve_hit': {
      // Full extension: legs drive, body leaves the ground, racket arm straight
      // overhead. Hand height 1.13 H is the geometric limit (shoulder + arm).
      const e = Math.sin(clamp(p, 0, 1) * Math.PI * 0.5);
      hop = e * 0.10 * H;
      crouch = lerp(0.64, 0.02, e);
      stance = lerp(0.13, 0.07, e) * H;
      ftDf = lerp(-0.14, 0.02, e) * H;
      ftNf = lerp(0.14, -0.16, e) * H;
      ftDu = e * 0.05 * H; ftNu = e * 0.13 * H;
      leanF = lerp(-0.06, 0.10, e) * H;
      twist = lerp(-0.45, 0.55, e);
      headU = 0.035 * H; headF = 0.02 * H;
      hDr = lerp(0.32, 0.09, e) * H;
      hDf = lerp(-0.26, 0.16, e) * H;
      hDu = lerp(0.86, 1.13, e) * H;
      hNr = lerp(-0.05, -0.22, e) * H;
      hNf = lerp(0.20, 0.04, e) * H;
      hNu = lerp(1.14, 0.60, e) * H;     // tossing arm tucks back into the body
      rkR = lerp(0.30, 0.05, e); rkF = lerp(-0.15, 0.16, e); rkU = 0.98;
      M.faceOpen = lerp(0.25, 0.9, e);
      break;
    }

    case 'volley': {
      // Compact block: knees bent, racket punched out in front of the chest,
      // non-dominant hand supporting the throat.
      const e = p;
      crouch = 0.52;
      stance = 0.20 * H;
      ftDf = isBack ? -0.06 * H : 0.16 * H;
      ftNf = isBack ? 0.18 * H : -0.06 * H;
      leanF = 0.11 * H;
      twist = isBack ? lerp(0.40, 0.10, e) : lerp(-0.35, -0.05, e);
      const side = isBack ? -1 : 1;
      hDr = side * lerp(0.30, 0.20, e) * H;
      hDf = lerp(0.20, 0.46, e) * H;
      hDu = 0.78 * H;
      hNr = -side * 0.10 * H; hNf = lerp(0.18, 0.34, e) * H; hNu = 0.76 * H;
      rkR = side * 0.35; rkF = 0.30; rkU = 0.88;
      M.bothHands = false;
      M.faceOpen = lerp(0.5, 0.9, e);
      break;
    }

    case 'smash': {
      // Overhead. Same extension as the serve but with a scissor kick and more
      // forward lean, because the contact point is further in front.
      const e = Math.sin(clamp(p, 0, 1) * Math.PI * 0.5);
      hop = e * 0.09 * H;
      crouch = lerp(0.40, 0.06, e);
      stance = 0.10 * H;
      ftDf = lerp(-0.20, 0.22, e) * H; ftDu = 0.10 * H * e;
      ftNf = lerp(0.16, -0.24, e) * H; ftNu = 0.16 * H * e;
      leanF = lerp(-0.10, 0.14, e) * H;
      twist = lerp(-0.55, 0.50, e);
      headU = 0.03 * H;
      hDr = lerp(0.34, 0.10, e) * H;
      hDf = lerp(-0.24, 0.24, e) * H;
      hDu = lerp(0.88, 1.12, e) * H;
      hNr = lerp(-0.10, -0.24, e) * H;
      hNf = lerp(0.22, 0.02, e) * H;
      hNu = lerp(1.05, 0.58, e) * H;
      rkR = lerp(0.34, 0.06, e); rkF = lerp(-0.20, 0.28, e); rkU = 0.94;
      M.faceOpen = lerp(0.25, 0.95, e);
      break;
    }

    case 'lunge': {
      // Emergency stretch: lead leg spears out along the travel direction with a
      // deep knee bend, trailing leg straight behind, racket at full reach.
      const e = p * p * (3 - 2 * p);
      crouch = 0.55 + 0.30 * e;
      stance = 0.05 * H;
      ftDf = (0.20 + 0.42 * e) * H * runF; ftDr = (0.20 + 0.42 * e) * H * runR;
      ftNf = -0.28 * H * runF; ftNr = -0.28 * H * runR;
      leanF = (0.14 * runF + 0.04) * H; leanR = 0.16 * H * runR;
      twist = -0.30;
      const reach = 0.36 + 0.22 * e;
      hDr = reach * H * (runR >= 0 ? 1 : -0.4);
      hDf = reach * H * Math.max(0.3, runF);
      hDu = (0.52 - 0.14 * e) * H;
      hNr = -0.34 * H; hNf = -0.10 * H; hNu = 0.66 * H;
      rkR = 0.45 * (runR >= 0 ? 1 : -1); rkF = 0.62; rkU = -0.35;
      M.faceOpen = 0.75;
      break;
    }

    case 'recover': {
      // Side shuffle back to position: feet come together and apart, staying low.
      const a = p * TAU;
      const sa = Math.sin(a);
      crouch = 0.42;
      stance = (0.10 + 0.10 * Math.abs(sa)) * H;
      ftDu = Math.max(0, sa) * 0.05 * H;
      ftNu = Math.max(0, -sa) * 0.05 * H;
      ftDf = 0.05 * H * runF; ftNf = -0.02 * H * runF;
      leanF = 0.07 * H + 0.05 * H * runF;
      leanR = 0.07 * H * runR;
      hDr = 0.24 * H; hDf = 0.30 * H; hDu = 0.70 * H;
      hNr = -0.20 * H; hNf = 0.26 * H; hNu = 0.68 * H;
      rkR = 0.20; rkF = 0.45; rkU = 0.87;
      M.faceOpen = 0.3;
      break;
    }

    case 'celebrate': {
      const a = Math.sin(p * TAU * 2);
      hop = Math.max(0, Math.sin(p * TAU)) * 0.10 * H;
      crouch = 0.12;
      stance = 0.16 * H;
      ftDu = ftNu = hop * 0.35;
      leanF = -0.05 * H;
      headU = 0.03 * H; headF = -0.03 * H;
      hDr = 0.30 * H; hDf = -0.02 * H; hDu = (1.06 + 0.03 * a) * H;
      hNr = -0.30 * H; hNf = -0.02 * H; hNu = (1.04 - 0.03 * a) * H;
      rkR = 0.22; rkF = 0.05; rkU = 0.97;
      M.faceOpen = 0.6;
      break;
    }

    case 'dejected': {
      const bob = Math.sin(p * TAU * 0.5);
      crouch = 0.30;
      stance = 0.10 * H;
      leanF = 0.09 * H;
      headF = 0.055 * H; headU = -0.045 * H;
      twist = 0.10;
      hDr = 0.26 * H; hDf = 0.04 * H; hDu = (0.46 + 0.01 * bob) * H;
      hNr = -0.24 * H; hNf = 0.02 * H; hNu = 0.44 * H;
      rkR = 0.15; rkF = 0.25; rkU = -0.95;   // racket hangs toward the ground
      M.tired = Math.max(M.tired, 0.7);
      M.faceOpen = 0.35;
      break;
    }
  }

  // Fatigue slump rides on top of every state.
  const slump = M.tired;
  leanF += 0.030 * H * slump;
  headF += 0.020 * H * slump;
  headU -= 0.015 * H * slump;

  // ── assembly ──────────────────────────────────────────────────────────────
  const ankleU = P_ANKLE * H;
  const hipU = P_HIP * H - crouch * 0.19 * H + hop;
  set(S.hip, leanR * 0.25, leanF * 0.25, hipU);

  // The pelvis follows the shoulder turn at ~35 %, which is what creates the
  // separation angle that makes a groundstroke look like it has torque.
  const ht = twist * 0.35;
  const hw = B.hip * H;
  const chp = Math.cos(ht) * hw, shp = Math.sin(ht) * hw;
  set(S.hpD, S.hip.r + chp, S.hip.f + shp, hipU);
  set(S.hpN, S.hip.r - chp, S.hip.f - shp, hipU);

  set(S.ftD, stance + ftDr, ftDf, ankleU + ftDu);
  set(S.ftN, -stance + ftNr, ftNf, ankleU + ftNu);

  const thigh = L_THIGH * H, shin = L_SHIN * H;
  solveIK(S.hpD.r, S.hpD.f, S.hpD.u, S.ftD.r, S.ftD.f, S.ftD.u, thigh, shin, 0.22, 1, 0.05);
  set(S.knD, _ik.r, _ik.f, _ik.u);
  S.ftD.r = _ik.tr; S.ftD.f = _ik.tf; S.ftD.u = _ik.tu;
  solveIK(S.hpN.r, S.hpN.f, S.hpN.u, S.ftN.r, S.ftN.f, S.ftN.u, thigh, shin, -0.22, 1, 0.05);
  set(S.knN, _ik.r, _ik.f, _ik.u);
  S.ftN.r = _ik.tr; S.ftN.f = _ik.tf; S.ftN.u = _ik.tu;

  // Toes: the shoe points along facing, splayed out a little, and pitches down
  // when the heel is off the ground.
  const shoeLen = 0.145 * H;
  const heelUpD = clamp((S.ftD.u - ankleU) / (0.06 * H), 0, 1);
  const heelUpN = clamp((S.ftN.u - ankleU) / (0.06 * H), 0, 1);
  set(S.toeD,
    S.ftD.r + Math.sin(toeSpreadD) * shoeLen,
    S.ftD.f + Math.cos(toeSpreadD) * shoeLen,
    S.ftD.u - 0.010 * H - heelUpD * 0.035 * H);
  set(S.toeN,
    S.ftN.r + Math.sin(toeSpreadN) * shoeLen,
    S.ftN.f + Math.cos(toeSpreadN) * shoeLen,
    S.ftN.u - 0.010 * H - heelUpN * 0.035 * H);

  const chestU = P_CHEST * H - crouch * 0.055 * H + hop - 0.014 * H * slump;
  set(S.chest, leanR, leanF, chestU);

  const sw = B.shoulder * H;
  const cts = Math.cos(twist) * sw, sts = Math.sin(twist) * sw;
  const shDrop = 0.018 * H * slump;      // shoulders roll forward when gassed
  set(S.shD, S.chest.r + cts, S.chest.f + sts + shDrop, chestU - shDrop);
  set(S.shN, S.chest.r - cts, S.chest.f - sts + shDrop, chestU - shDrop);

  set(S.neck, S.chest.r * 0.9, S.chest.f * 0.9, P_NECK * H - crouch * 0.05 * H + hop - 0.016 * H * slump);
  set(S.head,
    S.neck.r * 0.9 + headR,
    S.neck.f * 0.9 + headF,
    P_HEAD * H - crouch * 0.05 * H + hop + headU);

  // Arms. Elbow pole points down-and-back so elbows never invert through the body.
  const ua = L_UPARM * H, fa = L_FOREARM * H;
  solveIK(S.shD.r, S.shD.f, S.shD.u, hDr, hDf, hDu, ua, fa, 0.45, -0.45, -1);
  set(S.elD, _ik.r, _ik.f, _ik.u);
  set(S.hnD, _ik.tr, _ik.tf, _ik.tu);

  // ── racket ────────────────────────────────────────────────────────────────
  let rl = Math.sqrt(rkR * rkR + rkF * rkF + rkU * rkU) || 1;
  rl = 1 / rl;
  const dr = rkR * rl, df = rkF * rl, du = rkU * rl;
  set(S.rkButt, S.hnD.r - dr * RK_GRIP_HOLD, S.hnD.f - df * RK_GRIP_HOLD, S.hnD.u - du * RK_GRIP_HOLD);
  set(S.rkThroat, S.rkButt.r + dr * RK_THROAT, S.rkButt.f + df * RK_THROAT, S.rkButt.u + du * RK_THROAT);
  set(S.rkTip, S.rkButt.r + dr * RK_LEN, S.rkButt.f + df * RK_LEN, S.rkButt.u + du * RK_LEN);
  const hm = RK_THROAT + RK_HEAD_LEN * 0.5;
  set(S.rkMid, S.rkButt.r + dr * hm, S.rkButt.f + df * hm, S.rkButt.u + du * hm);

  // Non-dominant arm: on the grip for a two-hander, otherwise free.
  if (M.bothHands) {
    // Top hand sits just above the bottom hand on the handle.
    const gh = RK_GRIP_HOLD + 0.11;
    solveIK(S.shN.r, S.shN.f, S.shN.u,
      S.rkButt.r + dr * gh, S.rkButt.f + df * gh, S.rkButt.u + du * gh,
      ua, fa, -0.45, -0.30, -1);
  } else {
    solveIK(S.shN.r, S.shN.f, S.shN.u, hNr, hNf, hNu, ua, fa, -0.45, -0.45, -1);
  }
  set(S.elN, _ik.r, _ik.f, _ik.u);
  set(S.hnN, _ik.tr, _ik.tf, _ik.tu);
}

// ─────────────────────────────────────────────────────────────────────────────
// Flattening + primitive drawing
// ─────────────────────────────────────────────────────────────────────────────

function flatten() {
  for (let i = 0; i < JOINTS.length; i++) {
    const j = JOINTS[i];
    const rd = j.r * _dom;
    j.x = _ox + (rd * _cf + j.f * _sf) * _sc;
    // dY: how much further from the camera than the ground anchor. Positive dY
    // rides higher on screen because the camera looks down at the court.
    const dY = -rd * _sf + j.f * _cf;
    j.y = _oy - j.u * _sc - dY * _tilt * _sc;
  }
}

/** Camera-space depth of a joint; larger = further away = drawn first. */
const depthOf = (j) => -(j.r * _dom) * _sf + j.f * _cf;

/**
 * Convex hull of two circles — a tapered capsule. Tangent points sit at
 * angle ± acos((ra-rb)/d) from the centre line, so the silhouette stays smooth
 * even when the two radii differ a lot (thigh → knee).
 */
function taperPath(ctx, ax, ay, ra, bx, by, rb) {
  const dx = bx - ax, dy = by - ay;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 1e-4) {
    ctx.beginPath();
    ctx.arc(ax, ay, Math.max(ra, rb), 0, TAU);
    return;
  }
  const ang = Math.atan2(dy, dx);
  const t = Math.acos(clamp((ra - rb) / d, -1, 1));
  ctx.beginPath();
  ctx.arc(ax, ay, ra, ang + t, ang - t + TAU);
  ctx.arc(bx, by, rb, ang - t + TAU, ang + t + TAU);
  ctx.closePath();
}

function taper(ctx, ax, ay, ra, bx, by, rb, fill) {
  taperPath(ctx, ax, ay, ra, bx, by, rb);
  ctx.fillStyle = fill;
  ctx.fill();
}

function disc(ctx, x, y, r, fill) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draw a player into the 3D scene.
 *
 * @param ctx     CanvasRenderingContext2D
 * @param camera  Camera instance (js/render/camera.js)
 * @param player  live sim entity { x, y, z, vx, vy, facing, animState, animPhase,
 *                swingType, stamina, isNear, team }
 * @param avatar  avatar record (see js/ui/avatar.js)
 * @param opts    optional { venue, shadow, haze, fade, alpha, tilt, lod }
 *
 * If `opts.venue` is supplied and `opts.shadow !== false` the ground shadow is
 * drawn first. Callers that batch shadows for all players (recommended, so no
 * player's shadow lands on top of another player) should pass shadow:false.
 */
export function drawPlayer(ctx, camera, player, avatar, opts) {
  const ground = camera.projectGround(player.x, player.y);
  if (!ground.visible || ground.scale <= 0) return;
  if (!(isFinite(ground.x) && isFinite(ground.y) && isFinite(ground.scale))) return;

  const scale = ground.scale;
  const figH = (avatar && avatar.height ? avatar.height : PLAYER.HEIGHT) * scale;
  if (figH < 3) return;                      // sub-pixel: not worth the draw call

  const venue = opts && opts.venue;
  if (venue && !(opts && opts.shadow === false)) drawShadow(ctx, camera, player, venue);

  // Atmospheric depth cue. The near baseline sits ~9 m from the lens and the far
  // baseline ~33 m; fading across that range is what makes the near player read
  // as physically closer rather than merely bigger.
  let fade;
  if (opts && opts.fade != null) {
    fade = clamp(opts.fade, 0, 1);
  } else {
    fade = clamp((ground.depth - 13) / 26, 0, 1) * 0.55;
  }

  let haze = (opts && opts.haze) || null;
  if (!haze && venue && venue.sky) haze = venue.sky[1] || venue.sky[0];
  if (!haze) haze = '#8fa6bd';

  deriveLight(venue || (opts && opts.lighting) || null);

  _st.state = player.animState || 'idle';
  _st.phase = player.animPhase || 0;
  _st.facing = player.facing || 0;
  _st.stamina = player.stamina == null ? 1 : player.stamina;
  _st.vx = player.vx || 0;
  _st.vy = player.vy || 0;
  _st.swingType = player.swingType || 'forehand';

  // z lifts the whole figure while the shadow stays welded to the ground — the
  // gap between the two is the only reliable "airborne" cue in a 2D projection.
  const z = player.z || 0;
  const oy = ground.y - z * scale;

  const tilt = opts && opts.tilt != null ? opts.tilt : Math.sin(camera.pitch);
  drawFigure(ctx, ground.x, oy, scale, avatar, _st, fade, haze, tilt,
    opts && opts.alpha != null ? opts.alpha : 1,
    opts && opts.lod != null ? opts.lod : -1);
}

/**
 * Camera-independent figure draw. Used by the avatar creator preview so the
 * preview can never drift from the in-game look.
 *
 * @param x,y   screen position of the player's ground contact point (between the feet)
 * @param scale pixels per world metre
 * @param pose  either an animState string, or
 *              { state, phase, facing, stamina, vx, vy, swingType }
 * @param opts  optional { fade, haze, alpha, tilt, lod }
 */
export function drawPlayerFigure(ctx, x, y, scale, avatar, pose, opts) {
  if (!(scale > 0) || !(isFinite(x) && isFinite(y))) return;
  let st;
  if (typeof pose === 'string') {
    _st.state = pose; _st.phase = 0; _st.facing = Math.PI;
    _st.stamina = 1; _st.vx = 0; _st.vy = 0; _st.swingType = 'forehand';
    st = _st;
  } else if (pose) {
    st = pose;
  } else {
    _st.state = 'idle'; _st.phase = 0; _st.facing = Math.PI;
    _st.stamina = 1; _st.vx = 0; _st.vy = 0; _st.swingType = 'forehand';
    st = _st;
  }
  deriveLight((opts && (opts.venue || opts.lighting)) || null);
  drawFigure(ctx, x, y, scale, avatar, st,
    opts && opts.fade != null ? clamp(opts.fade, 0, 1) : 0,
    (opts && opts.haze) || '#8fa6bd',
    opts && opts.tilt != null ? opts.tilt : 0.30,
    opts && opts.alpha != null ? opts.alpha : 1,
    opts && opts.lod != null ? opts.lod : -1);
}

/**
 * Ground shadow. A circle on z = 0 projects to an ellipse whose vertical
 * semi-axis is squashed by sin(pitch); softness is faked with concentric rings
 * because ctx.filter blur costs an offscreen pass per player.
 */
export function drawShadow(ctx, camera, player, venue) {
  const g = camera.projectGround(player.x, player.y);
  if (!g.visible || g.scale <= 0) return;

  const z = Math.max(0, player.z || 0);
  const base = venue && venue.shadowAlpha != null ? venue.shadowAlpha : 0.3;
  if (base <= 0.01) return;

  // Airborne: the contact patch spreads and washes out with height, and lifts
  // off the feet (drawn at the ground point while the figure rises with z).
  const lift = clamp(z / 1.6, 0, 1);
  const rw = (0.36 + 0.40 * lift) * g.scale;
  const rh = rw * Math.max(0.12, Math.sin(camera.pitch));
  if (rw < 0.6) return;

  // Anisotropy: a real shadow stretches along the ground away from the light.
  // We take the screen light direction and elongate the ellipse along it, and
  // nudge the whole patch a little to the shadow side. Softens with height.
  let ldx = -0.34, ldy = -0.86;
  if (venue) {
    if (venue.floodlit) { ldx = -0.28; ldy = -0.96; }
    else if (venue.timeOfDay === 'afternoon') { ldx = -0.64; ldy = -0.58; }
  }
  const lm = Math.hypot(ldx, ldy) || 1; ldx /= lm; ldy /= lm;
  const rot = Math.atan2(ldy, ldx);
  const stretch = 1 + (0.5 + 0.5 * lift) * (venue && (venue.indoor || venue.floodlit) ? 0.35 : 0.6);
  const offMag = rw * 0.22 * (1 - lift);
  const cx = g.x - ldx * offMag;                 // cast away from the light
  const cy = g.y - ldy * offMag * Math.max(0.2, Math.sin(camera.pitch));

  const alpha = base * (1 - 0.62 * lift);
  const sharp = venue && (venue.indoor || venue.floodlit);
  const rings = sharp ? 2 : 3;

  if (!(isFinite(cx) && isFinite(cy) && isFinite(rot) && rw > 0 && rh > 0)) return;

  ctx.save();
  try {
    for (let i = rings; i >= 1; i--) {
      const k = i / rings;
      // Outer rings are bigger and much fainter — a cheap penumbra. The support
      // foot (inner ring) stays tightest and darkest.
      const spread = 1 + (k - 1 / rings) * (sharp ? 0.34 : 0.60);
      ctx.globalAlpha = alpha * (1 / rings) * (sharp ? 1.15 : 1);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rw * spread * stretch, rh * spread, rot, 0, TAU);
      ctx.fillStyle = '#000';
      ctx.fill();
    }
  } finally {
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The actual figure renderer
// ─────────────────────────────────────────────────────────────────────────────

function drawFigure(ctx, ox, oy, scale, avatar, st, fade, haze, tilt, alpha, lodOverride) {
  const av = avatar || {};
  const H = av.height || PLAYER.HEIGHT;

  buildPose(av, st);

  // Non-finite origin/scale would poison every joint and reach a gradient
  // constructor (which throws on NaN); bail before any drawing state is touched.
  if (!(isFinite(ox) && isFinite(oy) && isFinite(scale) && scale > 0)) return;

  const facing = st.facing || 0;
  _ox = ox; _oy = oy; _sc = scale;
  _cf = Math.cos(facing);   // maps body-right → screen-x
  _sf = Math.sin(facing);   // maps body-forward → screen-x
  _dom = M.dom;
  _tilt = tilt;
  _fadeStep = Math.round(clamp(fade, 0, 1) * FADE_STEPS);
  _haze = haze;
  const hz = parseHex(haze);
  _hzR = (hz >> 16) & 255; _hzG = (hz >> 8) & 255; _hzB = hz & 255;

  flatten();

  const figH = H * scale;
  // LOD ladder: below ~34 px the face, string bed, folds and AO are noise (LOD 0
  // stays a cheap lit silhouette + rim); 34–90 px gets cylindrical shading + AO
  // (LOD 1); above that the full cloth/self-shadow/specular treatment (LOD 2).
  const lod = lodOverride >= 0 ? lodOverride : (figH < 34 ? 0 : figH < 90 ? 1 : 2);

  // "front" > 0 means we are looking at the player's chest.
  const front = -_cf;

  const skin = SKIN_TONES[clamp(av.skinTone | 0, 0, SKIN_TONES.length - 1)] || SKIN_TONES[2];
  const shirt = av.shirtColor || '#ffffff';
  const accent = av.shirtAccent || '#00e07a';
  const shorts = av.shortsColor || '#1b2430';
  const shoes = av.shoeColor || '#f2f2f2';
  const hairC = av.hairColor || HAIR_COLORS[1];
  const hatC = av.hatColor || shirt;

  const lb = M.limb * (H / 1.85) * scale;   // limb radius unit: metres → px
  const tb = M.torso * (H / 1.85) * scale;

  ctx.save();
  try {
    if (alpha < 1) ctx.globalAlpha = clamp(alpha, 0, 1);

    // Painter's order within the figure: whichever limb is further from the camera
    // goes down first. Two comparisons, no sorting, no arrays.
    const legFarIsD = depthOf(S.knD) > depthOf(S.knN);
    const armFarIsD = depthOf(S.elD) > depthOf(S.elN);

    leg(ctx, legFarIsD, 1, lb, skin, shorts, shoes, lod);

    if (armFarIsD && !M.bothHands) drawRacket(ctx, av, scale, lod, st);
    arm(ctx, armFarIsD, 1, lb, skin, shirt, accent, av, lod);

    torso(ctx, tb, shirt, accent, shorts, lod, scale);

    leg(ctx, !legFarIsD, 0, lb, skin, shorts, shoes, lod);

    // Near arm casts a soft shadow onto the chest before the head/near arm land.
    if (lod >= 2) selfShadow(ctx, armFarIsD, lb);

    head(ctx, av, skin, hairC, hatC, accent, scale, front, lod, st);

    arm(ctx, !armFarIsD, 0, lb, skin, shirt, accent, av, lod);

    if (!(armFarIsD && !M.bothHands)) drawRacket(ctx, av, scale, lod, st);
  } finally {
    ctx.restore();
  }
}

/**
 * Soft self-shadow of the near arm onto the torso, clipped to the shirt path so
 * it never spills past the silhouette. Cheap: one clipped AO blob.
 */
function selfShadow(ctx, armFarIsD, lb) {
  const nearIsDom = !armFarIsD;
  const el = nearIsDom ? S.elD : S.elN;
  const sh = nearIsDom ? S.shD : S.shN;
  // Only shadow when the arm is actually in front of / across the chest.
  const cx = (sh.x + el.x) * 0.5, cy = (sh.y + el.y) * 0.5;
  ctx.save();
  try {
    torsoPath(ctx);
    ctx.clip();
    aoBlob(ctx, cx, cy, 0.34 * lb, 0.5 * lb, 0.4);
  } finally {
    ctx.restore();
  }
}

/** shadeIdx 0 = near limb (lit), 1 = far limb (in the body's own shade). */
function leg(ctx, isDom, shadeIdx, lb, skin, shorts, shoes, lod) {
  const hp = isDom ? S.hpD : S.hpN;
  const kn = isDom ? S.knD : S.knN;
  const ft = isDom ? S.ftD : S.ftN;
  const toe = isDom ? S.toeD : S.toeN;

  // Shorts cover the top ~45 % of the thigh.
  const mx = hp.x + (kn.x - hp.x) * 0.45;
  const my = hp.y + (kn.y - hp.y) * 0.45;

  if (lod === 0) {
    const sk = col(skin, shadeIdx), sh = col(shorts, shadeIdx);
    taper(ctx, mx, my, 0.072 * lb, kn.x, kn.y, 0.058 * lb, sk);
    taper(ctx, kn.x, kn.y, 0.056 * lb, ft.x, ft.y, 0.038 * lb, sk);
    taper(ctx, hp.x, hp.y, 0.098 * lb, mx, my, 0.082 * lb, sh);
    taper(ctx, ft.x, ft.y, 0.046 * lb, toe.x, toe.y, 0.032 * lb, col(shoes, shadeIdx));
    return;
  }

  // Thigh (build-scaled bulge), shin taper, then the shorts panel over the top.
  const bulge = 0.008 * (M.limb - 1);
  litTaper(ctx, mx, my, (0.072 + bulge) * lb, kn.x, kn.y, 0.056 * lb, skin, shadeIdx);
  litTaper(ctx, kn.x, kn.y, 0.054 * lb, ft.x, ft.y, 0.038 * lb, skin, shadeIdx);
  litTaper(ctx, hp.x, hp.y, (0.098 + bulge) * lb, mx, my, (0.082 + bulge) * lb, shorts, shadeIdx);

  // AO where the thigh meets the shin (behind the knee) and under the shorts hem.
  if (lod >= 1 && shadeIdx === 0) {
    aoBlob(ctx, kn.x, kn.y, 0.05 * lb, 0.05 * lb, 0.35);
    aoBlob(ctx, mx, my, 0.08 * lb, 0.045 * lb, 0.4);
  }

  shoe(ctx, ft, toe, lb, shoes, shadeIdx, lod);
}

/** Shoe with sole, midsole stripe and a lit toe box. */
function shoe(ctx, ft, toe, lb, shoes, shadeIdx, lod) {
  litTaper(ctx, ft.x, ft.y, 0.046 * lb, toe.x, toe.y, 0.030 * lb, shoes, shadeIdx);
  if (lod < 1) return;
  const dx = toe.x - ft.x, dy = toe.y - ft.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-3) return;
  const ux = dx / d, uy = dy / d;
  // Sole: a thin dark wedge just under the shoe.
  const soleC = tint(shoes, 2, _fadeStep, _haze);
  taper(ctx, ft.x + uy * 0.028 * lb, ft.y - ux * 0.028 * lb + 0.014 * lb, 0.02 * lb,
    toe.x + uy * 0.02 * lb, toe.y - ux * 0.02 * lb + 0.012 * lb, 0.014 * lb, soleC);
  // Midsole stripe.
  if (lod >= 2) {
    ctx.save();
    try {
      ctx.strokeStyle = tint(shoes, 1, _fadeStep, _haze);
      ctx.lineWidth = Math.max(0.6, 0.012 * lb);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ft.x + ux * 0.02 * lb, ft.y + uy * 0.02 * lb + 0.006 * lb);
      ctx.lineTo(toe.x - ux * 0.02 * lb, toe.y - uy * 0.02 * lb + 0.006 * lb);
      ctx.stroke();
    } finally { ctx.restore(); }
  }
}

function arm(ctx, isDom, shadeIdx, lb, skin, shirt, accent, av, lod) {
  const sh = isDom ? S.shD : S.shN;
  const el = isDom ? S.elD : S.elN;
  const hn = isDom ? S.hnD : S.hnN;

  // Sleeve ends ~40 % down the upper arm.
  const mx = sh.x + (el.x - sh.x) * 0.42;
  const my = sh.y + (el.y - sh.y) * 0.42;
  const bulge = 0.006 * (M.limb - 1);         // bicep/forearm mass from build

  if (lod === 0) {
    const sk = col(skin, shadeIdx);
    taper(ctx, mx, my, 0.048 * lb, el.x, el.y, 0.040 * lb, sk);
    taper(ctx, el.x, el.y, 0.038 * lb, hn.x, hn.y, 0.028 * lb, sk);
    taper(ctx, sh.x, sh.y, 0.066 * lb, mx, my, 0.056 * lb, col(shirt, shadeIdx));
    disc(ctx, hn.x, hn.y, 0.033 * lb, sk);
    return;
  }

  litTaper(ctx, mx, my, (0.048 + bulge) * lb, el.x, el.y, 0.038 * lb, skin, shadeIdx);
  litTaper(ctx, el.x, el.y, (0.038 + bulge) * lb, hn.x, hn.y, 0.027 * lb, skin, shadeIdx);
  litTaper(ctx, sh.x, sh.y, (0.066 + bulge) * lb, mx, my, (0.056 + bulge) * lb, shirt, shadeIdx);

  // AO at the elbow crook and where the sleeve meets the deltoid.
  if (lod >= 1 && shadeIdx === 0) {
    aoBlob(ctx, el.x, el.y, 0.04 * lb, 0.04 * lb, 0.3);
    aoBlob(ctx, mx, my, 0.05 * lb, 0.05 * lb, 0.28);
  }

  if (av.wristbands) {
    const wx = hn.x + (el.x - hn.x) * 0.16;
    const wy = hn.y + (el.y - hn.y) * 0.16;
    litDisc(ctx, wx, wy, 0.040 * lb, accent, shadeIdx);
  }
  litDisc(ctx, hn.x, hn.y, 0.032 * lb, skin, shadeIdx);
}

/**
 * The torso is an explicit path rather than a capsule: a capsule's round end cap
 * always adds a full radius past its anchor, which on a body-width shape means
 * the shirt swallows the neck and the shorts ride up to the chest.
 *
 * The outline is driven by the projected shoulder and hip joints, so it already
 * carries the lean and the shoulder/hip separation angle for free. Widths are
 * floored at a fraction of the true width so an edge-on torso reads as a slab
 * instead of collapsing to a line — the floor is always narrower than a
 * square-on torso, so it can never look wider from the side than from the front.
 */
// Torso outline geometry, resolved from the projected shoulders/hips. Shared by
// torso() and by the self-shadow clip so both use the identical silhouette.
const _T = { shx: 0, shy: 0, hix: 0, hiy: 0, sdx: 0, sdy: 0, hdx: 0, hdy: 0, wx: 0, wy: 0, wdx: 0, wdy: 0 };

function torsoGeom(scale) {
  const shx = (S.shD.x + S.shN.x) * 0.5, shy = (S.shD.y + S.shN.y) * 0.5;
  const hix = (S.hpD.x + S.hpN.x) * 0.5, hiy = (S.hpD.y + S.hpN.y) * 0.5;
  let sdx = (S.shD.x - S.shN.x) * 0.5, sdy = (S.shD.y - S.shN.y) * 0.5;
  let hdx = (S.hpD.x - S.hpN.x) * 0.5, hdy = (S.hpD.y - S.hpN.y) * 0.5;

  const sMin = M.shW * scale * 0.46;
  const hMin = M.hpW * scale * 0.54;
  let l = Math.sqrt(sdx * sdx + sdy * sdy);
  if (l < sMin) { if (l < 1e-3) { sdx = sMin; sdy = 0; } else { const k = sMin / l; sdx *= k; sdy *= k; } }
  l = Math.sqrt(hdx * hdx + hdy * hdy);
  if (l < hMin) { if (l < 1e-3) { hdx = hMin; hdy = 0; } else { const k = hMin / l; hdx *= k; hdy *= k; } }

  _T.shx = shx; _T.shy = shy; _T.hix = hix; _T.hiy = hiy;
  _T.sdx = sdx; _T.sdy = sdy; _T.hdx = hdx; _T.hdy = hdy;
  _T.wx = shx + (hix - shx) * 0.55; _T.wy = shy + (hiy - shy) * 0.55;
  _T.wdx = (sdx + hdx) * 0.44; _T.wdy = (sdy + hdy) * 0.44;
}

/** Build the shirt outline path (no fill). Uses the last torsoGeom() result. */
function torsoPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(_T.shx - _T.sdx, _T.shy - _T.sdy);
  ctx.quadraticCurveTo(_T.wx - _T.wdx, _T.wy - _T.wdy, _T.hix - _T.hdx, _T.hiy - _T.hdy);
  ctx.lineTo(_T.hix + _T.hdx, _T.hiy + _T.hdy);
  ctx.quadraticCurveTo(_T.wx + _T.wdx, _T.wy + _T.wdy, _T.shx + _T.sdx, _T.shy + _T.sdy);
  ctx.closePath();
}

function torso(ctx, tb, shirt, accent, shorts, lod, scale) {
  torsoGeom(scale);
  const { shx, shy, hix, hiy, sdx, sdy, hdx, hdy } = _T;

  // Shirt: filled with a gradient across the shoulder axis, so the volume
  // highlight sits on whichever side faces the light and slides as the torso
  // turns. One gradient per torso (not per limb) — cheap enough to build fresh.
  torsoPath(ctx);
  if (lod === 0) {
    ctx.fillStyle = col(shirt, 0);
    ctx.fill();
  } else {
    let ax = sdx, ay = sdy;
    const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
    const s = _L.dx * ax + _L.dy * ay;
    const W = Math.max(2, al * 1.08);
    const g = ctx.createLinearGradient(shx - ax * W, shy - ay * W, shx + ax * W, shy + ay * W);
    addCylStops(g, parseHex(shirt), 0, s);
    ctx.fillStyle = g;
    ctx.fill();
  }

  // Shorts: a band across the pelvis, shaded across the hips.
  const drop = 0.075 * M.H * scale;
  ctx.beginPath();
  ctx.moveTo(hix - hdx * 1.04, hiy - hdy * 1.04);
  ctx.lineTo(hix + hdx * 1.04, hiy + hdy * 1.04);
  ctx.lineTo(hix + hdx * 0.98, hiy + hdy * 0.98 + drop);
  ctx.lineTo(hix - hdx * 0.98, hiy - hdy * 0.98 + drop);
  ctx.closePath();
  if (lod === 0) {
    ctx.fillStyle = col(shorts, 0);
    ctx.fill();
  } else {
    let hx2 = hdx, hy2 = hdy;
    const hl = Math.hypot(hx2, hy2) || 1; hx2 /= hl; hy2 /= hl;
    const s2 = _L.dx * hx2 + _L.dy * hy2;
    const W2 = Math.max(2, hl * 1.05);
    const g2 = ctx.createLinearGradient(hix - hx2 * W2, hiy - hy2 * W2, hix + hx2 * W2, hiy + hy2 * W2);
    addCylStops(g2, parseHex(shorts), 0, s2);
    ctx.fillStyle = g2;
    ctx.fill();
  }

  if (lod >= 1) {
    // Ambient occlusion: armpit hollows and the waist crease, clipped to the shirt.
    ctx.save();
    try {
      torsoPath(ctx);
      ctx.clip();
      aoBlob(ctx, shx - sdx * 0.9, shy - sdy * 0.9 + tb * 0.1, 0.5 * tb, 0.7 * tb, 0.32);
      aoBlob(ctx, shx + sdx * 0.9, shy + sdy * 0.9 + tb * 0.1, 0.5 * tb, 0.7 * tb, 0.32);
      aoBlob(ctx, _T.wx, _T.wy, Math.hypot(sdx, sdy) * 1.1, tb * 0.5, 0.24);
    } finally { ctx.restore(); }
  }

  if (lod >= 2) {
    // Cloth folds: a couple of curved lines from the shoulders toward the waist,
    // bunching on the compressed side of the current lean/turn.
    ctx.save();
    try {
      torsoPath(ctx);
      ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      ctx.lineWidth = Math.max(0.6, 0.03 * tb);
      ctx.lineCap = 'round';
      const cnx = (hix - shx), cny = (hiy - shy);
      for (let i = -1; i <= 1; i += 2) {
        const ox2 = sdx * 0.5 * i, oy2 = sdy * 0.5 * i;
        ctx.beginPath();
        ctx.moveTo(shx + ox2 * 1.2, shy + oy2 * 1.2 + tb * 0.2);
        ctx.quadraticCurveTo(_T.wx + ox2 * 0.6 - cnx * 0.05, _T.wy + oy2 * 0.6,
          _T.wx + ox2 * 0.2, _T.wy + oy2 * 0.2 + tb * 0.2);
        ctx.stroke();
      }
    } finally { ctx.restore(); }
  }

  if (lod >= 1) {
    // Accent chevron as a shaded panel, aligned to the shoulder axis.
    ctx.save();
    try {
      ctx.strokeStyle = tint(accent, _L.dy < -0.5 ? 0 : 1, _fadeStep, _haze);
      ctx.lineWidth = Math.max(1, 0.055 * tb);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const dnx = (hix - shx) * 0.30, dny = (hiy - shy) * 0.30;
      ctx.beginPath();
      ctx.moveTo(shx - sdx * 0.86 + dnx * 0.6, shy - sdy * 0.86 + dny * 0.6);
      ctx.lineTo(shx + dnx * 1.5, shy + dny * 1.5);
      ctx.lineTo(shx + sdx * 0.86 + dnx * 0.6, shy + sdy * 0.86 + dny * 0.6);
      ctx.stroke();
    } finally { ctx.restore(); }
  }
}

function head(ctx, av, skin, hairC, hatC, accent, scale, front, lod, st) {
  const R = M.headR * scale;
  const hx = S.head.x, hy = S.head.y;

  // Guard the tilt: at tilt 0 the (right, forward) plane projects to a line and
  // the brim matrix below goes singular.
  const tl = Math.abs(_tilt) < 0.06 ? 0.06 : _tilt;

  // Screen displacement produced by one HEAD RADIUS of body-forward and of
  // body-right. Deliberately not normalised — their shrinking length IS the
  // foreshortening, and it is what flattens a cap brim as the player turns.
  const ffx = _sf * R, ffy = -_cf * tl * R;
  const rrx = _cf * _dom * R, rry = _sf * _dom * tl * R;

  // 1 = looking at the back of the head, 0 = looking straight at the face.
  const backness = clamp(-front, 0, 1);
  // The hairline gap sits where the face is: mostly screen-down, biased toward
  // whichever way the player is turned.
  const faceA = Math.atan2(ffy + R * 0.85, ffx);

  const useLit = lod >= 1;
  const sk = col(skin, 0);
  const hc = col(hairC, 0);
  const hcD = col(hairC, 1);
  const hcHi = tint(hairC, 0, _fadeStep, _haze);   // highlight uses the lit tier
  const style = av.hairStyle || 'bald';

  // Long hair swings and lags behind the head with lateral movement.
  const vx = (st && st.vx) || 0, vy = (st && st.vy) || 0;
  const spd = Math.hypot(vx, vy);
  const sway = clamp((vx * _dom) / PLAYER.MAX_SPEED, -1, 1) * R * 0.6
    + clamp(spd / PLAYER.MAX_SPEED, 0, 1) * R * 0.12;

  // Neck, drawn here so it lands over the shirt collar but under the head.
  const shx = (S.shD.x + S.shN.x) * 0.5;
  const shy = (S.shD.y + S.shN.y) * 0.5;
  if (useLit) litTaper(ctx, shx, shy, R * 0.50, S.neck.x, S.neck.y, R * 0.42, skin, 1);
  else taper(ctx, shx, shy, R * 0.50, S.neck.x, S.neck.y, R * 0.42, col(skin, 1));

  // Hair mass that belongs BEHIND the skull, so it draws first.
  const vis = 0.28 + 0.72 * backness;
  if (style === 'medium' || style === 'long') {
    const drop = (style === 'long' ? R * 2.1 : R * 1.0) * vis;
    const wide = (style === 'long' ? R * 1.05 : R * 0.94) * (0.82 + 0.18 * backness);
    const tx = hx - ffx * 0.55 + sway, ty = hy - ffy * 0.55 + drop;
    if (useLit) litTaper(ctx, hx - ffx * 0.35, hy - ffy * 0.35 + R * 0.12, wide, tx, ty, wide * 0.78, hairC, 1);
    else taper(ctx, hx - ffx * 0.35, hy - ffy * 0.35 + R * 0.12, wide, tx, ty, wide * 0.78, hcD);
  } else if (style === 'ponytail') {
    const bx = hx - ffx * 0.75, by = hy - ffy * 0.75;
    const tx = bx - ffx * 0.40 + sway, ty = by + R * 1.6 * vis;
    if (useLit) litTaper(ctx, bx, by, R * 0.32, tx, ty, R * 0.18, hairC, 1);
    else taper(ctx, bx, by, R * 0.32, tx, ty, R * 0.18, hcD);
  } else if (style === 'bun') {
    if (useLit) litDisc(ctx, hx - ffx * 0.85, hy - ffy * 0.85 - R * 0.42, R * 0.44, hairC, 1);
    else disc(ctx, hx - ffx * 0.85, hy - ffy * 0.85 - R * 0.42, R * 0.44, hcD);
  }

  // Spherical skull.
  if (useLit) litDisc(ctx, hx, hy, R, skin, 0);
  else disc(ctx, hx, hy, R, sk);

  if (style !== 'bald') {
    // The gap closes completely as we swing round behind the player, so the back
    // of the head is solid hair with no stray face-coloured wedge.
    const base = style === 'buzz' ? 0.65 : style === 'curly' ? 1.00 : 0.88;
    const gap = base * (1 - backness * backness);
    const rr = style === 'buzz' ? R * 1.005 : style === 'curly' ? R * 1.15 : R * 1.06;

    ctx.beginPath();
    if (gap < 0.02) ctx.arc(hx, hy, rr, 0, TAU);
    else ctx.arc(hx, hy, rr, faceA + gap, faceA - gap + TAU);
    ctx.closePath();
    ctx.fillStyle = hcD;
    ctx.fill();

    // Hair volume: a highlight crescent on the light side over the darker mass.
    if (lod >= 1 && style !== 'buzz') {
      const lang = Math.atan2(_L.dy, _L.dx);
      ctx.save();
      try {
        ctx.beginPath();
        ctx.arc(hx + _L.dx * R * 0.12, hy + _L.dy * R * 0.12, rr * 0.98, lang - 1.0, lang + 1.0);
        ctx.strokeStyle = hcHi;
        ctx.lineWidth = Math.max(1, R * 0.34);
        ctx.lineCap = 'round';
        ctx.stroke();
      } finally { ctx.restore(); }
    }

    if (style === 'curly' && lod >= 1) {
      for (let i = 0; i < 5; i++) {
        const ang = faceA + Math.PI - 1.45 + i * 0.725;
        disc(ctx, hx + Math.cos(ang) * R * 0.95, hy + Math.sin(ang) * R * 0.95, R * 0.38, hc);
      }
    }
    if (style === 'headband') {
      ctx.save();
      ctx.strokeStyle = col(accent, 0);
      ctx.lineWidth = Math.max(1.2, R * 0.30);
      ctx.beginPath();
      ctx.arc(hx, hy - R * 0.14, R * 0.99, faceA - 1.25, faceA + 1.25);
      ctx.stroke();
      ctx.restore();
    }
  }

  const hat = av.hasHat || 'none';
  if (hat !== 'none') {
    const hcol = col(hatC, 0);
    const hcolD = col(hatC, 1);

    if (hat === 'cap' || hat === 'visor') {
      if (hat === 'cap') {
        // The crown sits ON the skull, not around it: raised anchor plus a wide
        // face gap, so the brow and eyes stay clear from the front.
        const gap = 1.30 * (1 - backness * backness) + 0.10;
        ctx.beginPath();
        ctx.arc(hx, hy - R * 0.16, R * 1.06, faceA + gap, faceA - gap + TAU);
        ctx.closePath();
        ctx.fillStyle = hcol;
        ctx.fill();
      }
      // The brim is a flat disc lying in the body's (right, forward) plane.
      // Pushing the canvas through that plane's 2x2 matrix means a circle drawn
      // there projects to the correct ellipse for free: wide from the front, a
      // jutting sliver in profile.
      // The brim is a flat disc in the body's (right, forward) plane. Guard the
      // 2x2 against non-finite / near-singular values before touching the matrix.
      const det = rrx * ffy - rry * ffx;
      if (isFinite(rrx) && isFinite(rry) && isFinite(ffx) && isFinite(ffy)
        && isFinite(hx) && isFinite(hy) && Math.abs(det) > 1e-4) {
        ctx.save();
        try {
          ctx.translate(hx, hy - R * 0.18);
          ctx.transform(rrx, rry, ffx, ffy, 0, 0);
          ctx.beginPath();
          ctx.ellipse(0, 0.62, 0.98, 0.62, 0, 0, TAU);
          ctx.fillStyle = hcolD;
          ctx.fill();
        } finally { ctx.restore(); }
      }

      if (hat === 'visor') {
        ctx.save();
        ctx.strokeStyle = hcol;
        ctx.lineWidth = Math.max(1.2, R * 0.26);
        ctx.beginPath();
        ctx.arc(hx, hy - R * 0.20, R * 1.01, faceA - 1.3, faceA + 1.3);
        ctx.stroke();
        ctx.restore();
      }
    } else if (hat === 'bandana') {
      // A wrapped band across the crown, not a swim cap: cover the top third and
      // leave the face clear.
      const gap = 1.55 * (1 - backness * backness) + 0.05;
      ctx.beginPath();
      ctx.arc(hx, hy - R * 0.30, R * 1.02, faceA + gap, faceA - gap + TAU);
      ctx.closePath();
      ctx.fillStyle = hcol;
      ctx.fill();
      // Knot and tail at the back of the head.
      disc(ctx, hx - ffx * 0.85, hy - ffy * 0.85 - R * 0.15, R * 0.22, hcolD);
    }
  }

  // Face: only when we can actually see it and the head is more than a few
  // pixels across. At far-court sizes it would be single-pixel noise.
  if (front > 0.15 && R > 4.5 && lod >= 1) {
    const eo = 0.34;                       // eye separation, in head radii
    const ex = hx + ffx * 0.45, ey = hy + ffy * 0.45 + R * 0.02;
    const er = Math.max(0.9, R * 0.12);
    disc(ctx, ex + rrx * eo, ey + rry * eo, er, '#20160f');
    disc(ctx, ex - rrx * eo, ey - rry * eo, er, '#20160f');
  }
}

function drawRacket(ctx, av, scale, lod, st) {
  const frame = RACKET_FRAMES[av.racketFrame] || RACKET_FRAMES.graphite;
  const gripC = col(av.racketColor || '#101317', 0);
  const frameC = col(frame.frame, 0);

  const bx = S.rkButt.x, by = S.rkButt.y;
  const tx = S.rkTip.x, ty = S.rkTip.y;
  const dx = tx - bx, dy = ty - by;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!(len >= 1.5) || !isFinite(S.rkMid.x) || !isFinite(S.rkMid.y)) return;

  const ang = Math.atan2(dy, dx);
  if (!isFinite(ang)) return;
  const w = Math.max(1, 0.016 * scale);   // ~1.6 cm of frame stock

  // Handle: butt → throat, with a lit overwrap.
  if (lod >= 1) litTaper(ctx, bx, by, w * 1.5, S.rkThroat.x, S.rkThroat.y, w * 1.1, av.racketColor || '#101317', 0);
  else taper(ctx, bx, by, w * 1.5, S.rkThroat.x, S.rkThroat.y, w * 1.1, gripC);
  if (lod >= 2) {
    // Overwrap: a couple of diagonal ticks along the grip.
    const gux = (S.rkThroat.x - bx) / (RK_THROAT), guy = (S.rkThroat.y - by) / (RK_THROAT);
    ctx.save();
    try {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = Math.max(0.5, w * 0.2);
      const gpx = -Math.sin(ang), gpy = Math.cos(ang);
      for (let i = 1; i <= 3; i++) {
        const t = i / 4;
        const cxg = bx + (S.rkThroat.x - bx) * t * RK_GRIP_HOLD * 6;
        const cyg = by + (S.rkThroat.y - by) * t * RK_GRIP_HOLD * 6;
        ctx.beginPath();
        ctx.moveTo(cxg + gpx * w, cyg + gpy * w);
        ctx.lineTo(cxg - gpx * w, cyg - gpy * w);
        ctx.stroke();
      }
    } finally { ctx.restore(); }
  }

  // Head. The projected shaft length carries the long-axis foreshortening; the
  // short axis is squashed by faceOpen (edge-on takeback → square at contact).
  const semiA = len * (RK_HEAD_LEN * 0.5 / RK_LEN);
  const semiB = Math.max(w * 1.2, RK_HEAD_W * 0.5 * scale * M.faceOpen);

  // Motion blur through the fast part of a swing/serve/smash.
  const state = st && st.state;
  const phase = clamp((st && st.phase) || 0, 0, 1);
  let blur = 0;
  if (state === 'swing') blur = Math.sin(phase * Math.PI);
  else if (state === 'serve_hit' || state === 'smash') blur = Math.sin(clamp(phase, 0, 1) * Math.PI * 0.5) > 0.6 ? 1 : 0;
  else if (state === 'volley') blur = 0;

  ctx.save();
  try {
    ctx.translate(S.rkMid.x, S.rkMid.y);
    ctx.rotate(ang);

    // Motion-blur ghosts: draw the frame ellipse a couple of times, offset back
    // along the swing arc, faint. Kept before the solid frame so it sits behind.
    if (blur > 0.2 && lod >= 1) {
      ctx.save();
      try {
        for (let i = 1; i <= 2; i++) {
          ctx.globalAlpha = 0.16 * blur / i;
          const off = -i * semiB * 0.9 * blur;
          ctx.beginPath();
          ctx.ellipse(0, off, semiA, semiB, 0, 0, TAU);
          ctx.strokeStyle = frameC;
          ctx.lineWidth = w * 1.4;
          ctx.stroke();
        }
      } finally { ctx.restore(); }
    }

    if (lod >= 1) {
      // String bed.
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.max(0.5, semiA - w), Math.max(0.5, semiB - w * 0.5), 0, 0, TAU);
      ctx.fillStyle = 'rgba(240,244,248,0.16)';
      ctx.fill();
      if (lod >= 2 && semiB > 3) {
        ctx.strokeStyle = 'rgba(235,240,246,0.35)';
        ctx.lineWidth = Math.max(0.5, w * 0.22);
        ctx.beginPath();
        for (let i = -1; i <= 1; i++) {
          const yy = (semiB - w) * i * 0.55;
          ctx.moveTo(-semiA + w, yy); ctx.lineTo(semiA - w, yy);
        }
        for (let i = -2; i <= 2; i++) {
          const xx = (semiA - w) * i * 0.38;
          ctx.moveTo(xx, -semiB + w); ctx.lineTo(xx, semiB - w);
        }
        ctx.stroke();
      }
    }

    // Frame: metallic cross-gradient (dark rim → bright centre → dark rim).
    let fstroke = frameC;
    if (lod >= 1 && semiB > 2) {
      const fi = parseHex(frame.frame);
      const g = ctx.createLinearGradient(0, -semiB, 0, semiB);
      const lo = 'rgb(' + (((fi >> 16) & 255) * 0.55 | 0) + ',' + (((fi >> 8) & 255) * 0.55 | 0) + ',' + ((fi & 255) * 0.55 | 0) + ')';
      const hi = frame.gloss > 0.4
        ? 'rgb(' + Math.min(255, ((fi >> 16) & 255) + 150) + ',' + Math.min(255, ((fi >> 8) & 255) + 150) + ',' + Math.min(255, (fi & 255) + 150) + ')'
        : frameC;
      g.addColorStop(0, lo); g.addColorStop(0.5, hi); g.addColorStop(1, lo);
      fstroke = g;
    }
    ctx.beginPath();
    ctx.ellipse(0, 0, semiA, semiB, 0, 0, TAU);
    ctx.strokeStyle = fstroke;
    ctx.lineWidth = w * 1.6;
    ctx.stroke();

    // Specular glint on the frame's light-facing shoulder.
    if (frame.gloss > 0.3 && lod >= 2) {
      ctx.beginPath();
      ctx.ellipse(0, 0, semiA, semiB, 0, Math.PI * 1.15, Math.PI * 1.6);
      ctx.strokeStyle = 'rgba(255,255,255,' + (frame.gloss * 0.6).toFixed(2) + ')';
      ctx.lineWidth = w * 0.6;
      ctx.stroke();
    }
  } finally {
    ctx.restore();
  }

  // Throat struts.
  if (lod >= 1) {
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    const jx = S.rkMid.x - Math.cos(ang) * semiA * 0.92;
    const jy = S.rkMid.y - Math.sin(ang) * semiA * 0.92;
    ctx.save();
    try {
      ctx.strokeStyle = frameC;
      ctx.lineWidth = w * 1.2;
      ctx.beginPath();
      ctx.moveTo(S.rkThroat.x, S.rkThroat.y);
      ctx.lineTo(jx + nx * semiB * 0.75, jy + ny * semiB * 0.75);
      ctx.moveTo(S.rkThroat.x, S.rkThroat.y);
      ctx.lineTo(jx - nx * semiB * 0.75, jy - ny * semiB * 0.75);
      ctx.stroke();
    } finally { ctx.restore(); }
  }
}
