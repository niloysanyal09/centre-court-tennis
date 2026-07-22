/**
 * Shot types and the aiming solver.
 *
 * The interesting problem here: given where the player makes contact and where they
 * are aiming, what launch velocity produces that shot? With drag and Magnus in play
 * there is no closed-form answer, so we bisect on the launch angle and run the real
 * integrator to evaluate each candidate. It costs a fraction of a millisecond and it
 * happens once per strike, not once per frame — and it means the trajectory you see
 * is the trajectory the solver actually planned.
 *
 * Every shot then gets ERROR applied on top: timing quality, player accuracy, fatigue
 * and shot difficulty all spray the ball. That error is the entire skill curve. A
 * perfectly-solved shot with sloppy timing still finds the bottom of the net.
 */

import { Ball, stepBall, netHeightAt } from './physics.js';
import { COURT, SPEEDS, SPIN, TIMING, BALL } from './constants.js';

/**
 * Shot definitions.
 *   netClearance — target height over the net, in metres. The single biggest lever
 *                  on risk: a flat drive skimming the tape is 8 cm from disaster.
 *   angleRange   — search bounds for the launch elevation, radians.
 *   highArc      — solve for the lobbed branch of the trajectory instead of the drive.
 *   errorScale   — how much the shot punishes bad timing.
 */
export const SHOT_TYPES = {
  flat: {
    id: 'flat', name: 'Flat Drive',
    baseSpeed: SPEEDS.GROUNDSTROKE_TYPICAL, maxSpeed: SPEEDS.GROUNDSTROKE_MAX,
    topspin: SPIN.FLAT, sidespin: 0,
    netClearance: 0.42, angleRange: [-0.12, 0.5], highArc: false,
    errorScale: 1.25, staminaCost: 1.2, recovery: 0.42,
  },
  topspin: {
    id: 'topspin', name: 'Topspin',
    baseSpeed: SPEEDS.GROUNDSTROKE_TYPICAL * 0.94, maxSpeed: SPEEDS.GROUNDSTROKE_MAX * 0.95,
    topspin: SPIN.TOPSPIN, sidespin: 0,
    netClearance: 1.05, angleRange: [0.02, 0.62], highArc: false,
    errorScale: 0.85, staminaCost: 1.15, recovery: 0.45,
  },
  heavy: {
    id: 'heavy', name: 'Heavy Topspin',
    baseSpeed: SPEEDS.GROUNDSTROKE_TYPICAL * 0.86, maxSpeed: SPEEDS.GROUNDSTROKE_MAX * 0.88,
    topspin: SPIN.HEAVY_TOPSPIN, sidespin: 0,
    netClearance: 1.7, angleRange: [0.06, 0.72], highArc: false,
    errorScale: 0.72, staminaCost: 1.5, recovery: 0.52,
  },
  slice: {
    id: 'slice', name: 'Slice',
    baseSpeed: SPEEDS.GROUNDSTROKE_TYPICAL * 0.72, maxSpeed: SPEEDS.GROUNDSTROKE_MAX * 0.7,
    topspin: SPIN.SLICE, sidespin: 0,
    netClearance: 0.6, angleRange: [-0.05, 0.4], highArc: false,
    errorScale: 0.78, staminaCost: 0.85, recovery: 0.36,
  },
  lob: {
    id: 'lob', name: 'Lob',
    baseSpeed: SPEEDS.LOB, maxSpeed: SPEEDS.LOB * 1.4,
    topspin: SPIN.TOPSPIN * 0.8, sidespin: 0,
    // Kept entirely above 45° so carry decreases monotonically with elevation,
    // which is what makes the high-branch bisection in solveShot well behaved.
    netClearance: 4.2, angleRange: [0.80, 1.25], highArc: true,
    errorScale: 1.0, staminaCost: 0.9, recovery: 0.4,
  },
  drop: {
    id: 'drop', name: 'Drop Shot',
    baseSpeed: SPEEDS.DROP, maxSpeed: SPEEDS.DROP * 1.5,
    topspin: SPIN.SLICE * 1.3, sidespin: 0,
    netClearance: 0.55, angleRange: [0.1, 0.75], highArc: false,
    errorScale: 1.5, staminaCost: 0.7, recovery: 0.3,
  },
  volley: {
    id: 'volley', name: 'Volley',
    baseSpeed: SPEEDS.VOLLEY, maxSpeed: SPEEDS.VOLLEY * 1.35,
    topspin: SPIN.SLICE * 0.5, sidespin: 0,
    netClearance: 0.35, angleRange: [-0.35, 0.3], highArc: false,
    errorScale: 1.1, staminaCost: 0.6, recovery: 0.22,
  },
  smash: {
    id: 'smash', name: 'Smash',
    baseSpeed: SPEEDS.SMASH, maxSpeed: SPEEDS.SMASH * 1.15,
    topspin: SPIN.FLAT, sidespin: 0,
    netClearance: 0.5, angleRange: [-0.55, 0.12], highArc: false,
    errorScale: 1.3, staminaCost: 2.2, recovery: 0.5,
  },
  block: {
    id: 'block', name: 'Block Return',
    baseSpeed: SPEEDS.VOLLEY * 0.8, maxSpeed: SPEEDS.VOLLEY,
    topspin: SPIN.SLICE * 0.4, sidespin: 0,
    netClearance: 0.8, angleRange: [-0.1, 0.45], highArc: false,
    errorScale: 0.6, staminaCost: 0.5, recovery: 0.25,
  },
};

/** Serve variants. Contact is overhead, so these solve on a mostly-downward angle. */
export const SERVE_TYPES = {
  flat: {
    id: 'flat', name: 'Flat Serve',
    speed: SPEEDS.SERVE_FIRST_TYPICAL, maxSpeed: SPEEDS.SERVE_FIRST_MAX,
    topspin: SPIN.FLAT, sidespin: 0,
    // Tuned against measured first-serve percentage in the headless harness: a
    // 14 cm margin over the tape produced a ~45 % first-serve rate, well below the
    // ~62 % the professional game actually returns. Nineteen centimetres lands it
    // in the right band without making the flat serve free.
    netClearance: 0.19, angleRange: [-0.30, 0.10],
    errorScale: 1.15, risk: 1.0,
  },
  slice: {
    id: 'slice', name: 'Slice Serve',
    speed: SPEEDS.SERVE_FIRST_TYPICAL * 0.9, maxSpeed: SPEEDS.SERVE_FIRST_MAX * 0.92,
    topspin: SPIN.FLAT * 1.5, sidespin: 260,
    netClearance: 0.26, angleRange: [-0.26, 0.14],
    errorScale: 0.95, risk: 0.75,
  },
  kick: {
    id: 'kick', name: 'Kick Serve',
    speed: SPEEDS.SERVE_SECOND, maxSpeed: SPEEDS.SERVE_SECOND * 1.12,
    topspin: SPIN.KICK_SERVE, sidespin: -160,
    netClearance: 0.62, angleRange: [-0.12, 0.30],
    errorScale: 0.7, risk: 0.4,
  },
};

/**
 * Simulate a candidate launch and report where it lands.
 * Returns { landX, landY, netClear, hitNet, apex } — netClear is the height above
 * the net tape at the crossing, which is what the solver constrains.
 */
function evaluateLaunch(from, vel, spinTop, spinSide, surface, wind, doubles) {
  const b = new Ball();
  b.inPlay = true;
  b.x = from.x; b.y = from.y; b.z = from.z;
  b.vx = vel.vx; b.vy = vel.vy; b.vz = vel.vz;
  b.setSpin(spinTop, spinSide);
  b.trail = [];

  const dt = 1 / 120;
  let t = 0;
  let netClear = null;
  let hitNet = false;
  let apex = from.z;

  while (t < 5) {
    const prevY = b.y;
    const prevZ = b.z;

    // Sample the net crossing height before physics resolves the collision.
    if ((prevY < 0 && b.y + b.vy * dt >= 0) || (prevY > 0 && b.y + b.vy * dt <= 0)) {
      const frac = Math.abs(prevY) / Math.max(Math.abs(b.vy * dt), 1e-9);
      const zAt = prevZ + b.vz * dt * frac;
      const xAt = b.x + b.vx * dt * frac;
      netClear = zAt - netHeightAt(xAt);
    }

    const evs = stepBall(b, dt, surface, wind, { doubles });
    t += dt;
    if (b.z > apex) apex = b.z;

    for (const e of evs) {
      if (e.type === 'net' || e.type === 'post') hitNet = true;
      if (e.type === 'bounce') {
        return { landX: e.x, landY: e.y, netClear, hitNet, apex, flightTime: t };
      }
    }
    if (hitNet) return { landX: b.x, landY: b.y, netClear, hitNet, apex, flightTime: t };
  }
  return { landX: b.x, landY: b.y, netClear, hitNet, apex, flightTime: t };
}

/**
 * Solve for a launch velocity that sends the ball from `from` to `target`.
 *
 * Strategy: point the azimuth straight at the target, then bisect the elevation
 * angle. Landing distance increases monotonically with elevation up to ~45°, so a
 * bisection on the low branch is well behaved; lobs search the high branch instead.
 * If the target is out of reach at the requested speed, we scale speed up rather
 * than let the shot fall hopelessly short.
 *
 * @returns { vx, vy, vz, spinTop, spinSide, speed, predicted }
 */
export function solveShot(from, target, shot, power, surface, wind, doubles) {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const horizDist = Math.hypot(dx, dy);
  if (horizDist < 0.3) return null;

  const azX = dx / horizDist;
  const azY = dy / horizDist;

  const maxSpeed = shot.maxSpeed !== undefined ? shot.maxSpeed : shot.speed;
  const baseSpeed = shot.baseSpeed !== undefined ? shot.baseSpeed : shot.speed;

  const spinTop = shot.topspin;
  const spinSide = shot.sidespin || 0;
  const [aMin, aMax] = shot.angleRange;
  const requiredClear = shot.netClearance ?? 0.2;
  const highArc = !!shot.highArc;

  /** Fire one candidate and measure carry along the aiming axis. */
  const trial = (speed, ang) => {
    const ch = Math.cos(ang), sh = Math.sin(ang);
    const vel = { vx: azX * speed * ch, vy: azY * speed * ch, vz: speed * sh };
    const r = evaluateLaunch(from, vel, spinTop, spinSide, surface, wind, doubles);
    r.travelled = (r.landX - from.x) * azX + (r.landY - from.y) * azY;
    return { vel, result: r, ang, speed, err: r.travelled - horizDist };
  };

  let best = null;
  let bestScore = Infinity;

  const consider = (c) => {
    // Rank candidates by landing error, but treat a netted ball as a hard failure —
    // a shot that never crosses is worse than one that lands two metres long.
    const penalty = c.result.hitNet ? 40 : 0;
    // Missing the intended net clearance is a soft penalty: it means the shot is
    // riskier than the stroke intends, not that it is wrong.
    const clearMiss = c.result.netClear !== null && c.result.netClear < requiredClear
      ? (requiredClear - c.result.netClear) * 1.6
      : 0;
    const score = Math.abs(c.err) + penalty + clearMiss;
    if (score < bestScore) { bestScore = score; best = c; }
    return score;
  };

  // Speed bisection bounds. Carry increases monotonically with speed at fixed angle,
  // so the outer search is well behaved.
  let speedLo = baseSpeed * 0.5;
  let speedHi = maxSpeed * 1.35;
  let speed = clamp(baseSpeed + (maxSpeed - baseSpeed) * clamp01(power), speedLo, speedHi);

  for (let sIter = 0; sIter < 7; sIter++) {
    // ── Step 1: the lowest angle that still clears the net by the required margin.
    // Net clearance rises monotonically with launch angle, so this bisects cleanly.
    let angFloor = aMin;
    {
      let lo = aMin, hi = aMax;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        const c = trial(speed, mid);
        consider(c);
        const clear = c.result.hitNet ? -1 : (c.result.netClear ?? 99);
        if (clear < requiredClear) lo = mid; else hi = mid;
      }
      angFloor = hi;
    }

    // ── Step 2: bisect the launch angle for carry, inside the legal band.
    let lo = highArc ? Math.max(angFloor, aMin) : angFloor;
    let hi = aMax;
    if (lo > hi) lo = hi;

    let converged = null;
    for (let i = 0; i < 15; i++) {
      const ang = (lo + hi) / 2;
      const c = trial(speed, ang);
      consider(c);
      converged = c;

      if (c.result.hitNet) { lo = ang; continue; }

      if (highArc) {
        // Above 45° more elevation means SHORTER carry, so the comparison flips.
        if (c.err > 0) lo = ang; else hi = ang;
      } else {
        if (c.err < 0) lo = ang; else hi = ang;
      }
      if (Math.abs(c.err) < 0.1) break;
    }

    if (best && Math.abs(best.err) < 0.15 && !best.result.hitNet) break;

    // ── Step 3: the angle search bottomed out, so adjust pace and try again.
    // Short at every legal angle → hit it harder. Long at every angle → take pace off.
    const err = converged ? converged.err : 0;
    if (err < 0) {
      speedLo = speed;
      speed = Math.min(speedHi, speed * 1.18);
    } else {
      speedHi = speed;
      speed = Math.max(speedLo, speed * 0.86);
    }
    if (speedHi - speedLo < 0.4) break;
  }

  if (!best) return null;

  return {
    vx: best.vel.vx, vy: best.vel.vy, vz: best.vel.vz,
    spinTop, spinSide,
    speed: Math.hypot(best.vel.vx, best.vel.vy, best.vel.vz),
    angle: best.ang,
    predicted: best.result,
  };
}

/**
 * Apply execution error to a solved shot.
 *
 * This is where skill lives. Four things degrade a shot:
 *   timing     — how close to the ideal contact moment the swing landed
 *   accuracy   — the player's attribute
 *   fatigue    — a gassed player sprays
 *   difficulty — reaching, stretching, or hitting on the run
 *
 * A mishit (timing outside the good window) additionally loses a big chunk of pace
 * and picks up a wild lateral spray, which is exactly how a shanked ball behaves.
 *
 * @param solved   output of solveShot
 * @param quality  0..1 timing quality
 * @param ctx      { accuracy 1..10, fatigue 0..1, difficulty 0..1, errorScale }
 * @returns { vx, vy, vz, spinTop, spinSide, isMishit, quality }
 */
export function applyShotError(solved, quality, ctx) {
  const accuracy = (ctx.accuracy ?? 5) / 10;
  const fatigue = ctx.fatigue ?? 0;
  const difficulty = ctx.difficulty ?? 0;
  const scale = ctx.errorScale ?? 1;

  // Aggregate error magnitude, 0 = perfect.
  const timingError = 1 - clamp01(quality);
  const skillFloor = (1 - accuracy) * 0.42;
  const err = (timingError * 0.85 + skillFloor + fatigue * 0.35 + difficulty * 0.5) * scale;

  const isMishit = quality < 0.34;

  // Lateral spray, in radians. A clean shot from a good player is within ~1°.
  let sprayRad = gaussian() * err * 0.085;
  // Vertical error translates into net clearance, the difference between a winner
  // and a ball into the tape.
  let pitchRad = gaussian() * err * 0.062;
  let speedFactor = 1 - err * 0.16 + gaussian() * err * 0.06;

  if (isMishit) {
    sprayRad += gaussian() * (TIMING.MISHIT_SPRAY_DEG * Math.PI / 180);
    pitchRad += gaussian() * 0.11;
    speedFactor *= TIMING.MISHIT_POWER_FACTOR + Math.random() * 0.2;
  }

  speedFactor = Math.max(0.25, Math.min(1.25, speedFactor));

  // Rotate the horizontal components by the spray angle.
  const cs = Math.cos(sprayRad), sn = Math.sin(sprayRad);
  let vx = solved.vx * cs - solved.vy * sn;
  let vy = solved.vx * sn + solved.vy * cs;
  let vz = solved.vz;

  // Pitch: tilt the velocity vector up or down.
  const hs = Math.hypot(vx, vy);
  const currentPitch = Math.atan2(vz, hs);
  const newPitch = currentPitch + pitchRad;
  const totalSpeed = Math.hypot(hs, vz) * speedFactor;
  const nh = Math.cos(newPitch) * totalSpeed;
  if (hs > 1e-6) {
    vx = (vx / hs) * nh;
    vy = (vy / hs) * nh;
  }
  vz = Math.sin(newPitch) * totalSpeed;

  // A mishit imparts far less spin — you never get the strings on it properly.
  const spinFactor = isMishit ? 0.35 + Math.random() * 0.3 : 0.85 + quality * 0.15;

  return {
    vx, vy, vz,
    spinTop: solved.spinTop * spinFactor,
    spinSide: solved.spinSide * spinFactor + (isMishit ? gaussian() * 90 : 0),
    isMishit,
    quality,
    errorMagnitude: err,
  };
}

/**
 * Grade the timing of a swing against the ideal contact moment.
 * Returns 0..1, where 1 is dead centre of the perfect window.
 */
export function gradeTiming(offsetSeconds) {
  const t = Math.abs(offsetSeconds);
  if (t <= TIMING.PERFECT) return 1 - (t / TIMING.PERFECT) * 0.12;      // 1.00 → 0.88
  if (t <= TIMING.GOOD) {
    const f = (t - TIMING.PERFECT) / (TIMING.GOOD - TIMING.PERFECT);
    return 0.88 - f * 0.28;                                             // 0.88 → 0.60
  }
  if (t <= TIMING.OK) {
    const f = (t - TIMING.GOOD) / (TIMING.OK - TIMING.GOOD);
    return 0.60 - f * 0.32;                                             // 0.60 → 0.28
  }
  return Math.max(0, 0.28 - (t - TIMING.OK) * 1.4);
}

export function timingLabel(quality) {
  if (quality >= 0.88) return 'PERFECT';
  if (quality >= 0.6) return 'GOOD';
  if (quality >= 0.34) return 'OK';
  return 'MISHIT';
}

/**
 * How hard was this ball to hit? Feeds the error model.
 * Reaching wide, taking it above the shoulder or below the knee, and hitting while
 * sprinting all make the shot harder.
 */
export function shotDifficulty(player, ball, contactHeight) {
  const reach = Math.hypot(ball.x - player.x, ball.y - player.y);
  const reachFactor = clamp01((reach - 0.6) / 1.1);

  // Comfortable strike zone is roughly hip-to-shoulder.
  let heightFactor = 0;
  if (contactHeight < 0.55) heightFactor = clamp01((0.55 - contactHeight) / 0.45);
  else if (contactHeight > 1.5) heightFactor = clamp01((contactHeight - 1.5) / 1.0);

  const speedFactor = clamp01(Math.hypot(player.vx, player.vy) / 6.5) * 0.6;
  const paceFactor = clamp01((ball.speed - 22) / 26) * 0.5;

  return clamp01(reachFactor * 0.45 + heightFactor * 0.3 + speedFactor * 0.15 + paceFactor * 0.2);
}

/** Choose a sensible default shot for the situation, used by the AI and by autoplay. */
export function suggestShot(player, ball, contactHeight, opponentPos) {
  if (contactHeight > 2.0 && ball.z > 1.8) return 'smash';
  if (Math.abs(player.y) < COURT.SERVICE_LINE * 0.72) return 'volley';
  if (contactHeight < 0.5) return 'slice';
  if (contactHeight > 1.55) return 'heavy';
  return 'topspin';
}

// ── helpers ──────────────────────────────────────────────────────────────────

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Box–Muller, clamped to ±3σ so a freak roll cannot produce an absurd shank. */
let _spare = null;
function gaussian() {
  if (_spare !== null) { const s = _spare; _spare = null; return s; }
  let u = 0, v = 0, s = 0;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  const mul = Math.sqrt((-2 * Math.log(s)) / s);
  _spare = Math.max(-3, Math.min(3, v * mul));
  return Math.max(-3, Math.min(3, u * mul));
}
