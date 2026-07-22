/**
 * Ball physics.
 *
 * This is a real flight model, not a parabola with a fudge factor. Three forces act
 * on the ball in the air:
 *
 *   gravity  — constant, downward.
 *   drag     — opposes velocity, proportional to v². At 200 km/h this is about 3 g,
 *              which is why a flat serve loses so much pace crossing the court.
 *   Magnus   — perpendicular to both spin axis and velocity. Topspin pushes the ball
 *              DOWN (letting you swing hard and still land it in), slice pushes it UP
 *              (so it floats and hangs), sidespin curves it laterally.
 *
 * The bounce is a rigid-sphere impulse model with Coulomb friction. That single piece
 * of maths is what makes surfaces feel different for free: on high-friction clay the
 * ball grips and topspin converts into a high kicking bounce, while on low-friction
 * grass it slides through low and fast. Nothing is special-cased per surface — the
 * friction and restitution numbers in surfaces.js do all the work.
 */

import { BALL, PHYSICS, K_DRAG, K_MAGNUS, COURT } from './constants.js';

// Moment of inertia of a hollow-ish sphere. A tennis ball is a pressurised shell, so
// it sits between a solid sphere (2/5) and a thin shell (2/3); 0.55 is the measured fit.
const INERTIA_FACTOR = 0.55;
// Impulse ratio that takes a sliding ball to pure rolling: 1 / (1 + 1/INERTIA_FACTOR).
const ROLL_IMPULSE_RATIO = 1 / (1 + 1 / INERTIA_FACTOR);

export class Ball {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    // Angular velocity vector, rad/s.
    this.wx = 0; this.wy = 0; this.wz = 0;

    this.inPlay = false;
    this.bounces = 0;          // bounces since the last strike
    this.lastHitBy = -1;       // player index
    this.lastHitTeam = -1;
    this.hitCount = 0;         // strikes in this rally
    this.crossedNet = false;
    this.touchedNet = false;
    this.maxHeightSinceHit = 0;
    this.launchSpeed = 0;

    // Trail sampling for the render layer.
    this.trail = [];
    this._trailTimer = 0;
  }

  get speed() {
    return Math.hypot(this.vx, this.vy, this.vz);
  }

  get spinRate() {
    return Math.hypot(this.wx, this.wy, this.wz);
  }

  /**
   * Signed topspin relative to the current direction of travel.
   * Positive = topspin, negative = backspin/slice. Used by the HUD and the AI.
   */
  get topspin() {
    const hs = Math.hypot(this.vx, this.vy);
    if (hs < 0.01) return 0;
    // Topspin axis for travel direction v̂ is ẑ × v̂.
    const ax = -this.vy / hs;
    const ay = this.vx / hs;
    return this.wx * ax + this.wy * ay;
  }

  setPosition(x, y, z) { this.x = x; this.y = y; this.z = z; }

  setVelocity(vx, vy, vz) {
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.launchSpeed = Math.hypot(vx, vy, vz);
  }

  /**
   * Apply spin expressed the way a player thinks about it: an amount of topspin
   * (negative for slice) and an amount of sidespin, relative to where the ball is
   * currently heading.
   */
  setSpin(topspin, sidespin = 0) {
    const hs = Math.hypot(this.vx, this.vy);
    if (hs < 0.01) {
      this.wx = 0; this.wy = 0; this.wz = sidespin;
      return;
    }
    // Topspin rotates about the axis ẑ × v̂ (horizontal, perpendicular to travel).
    const ax = -this.vy / hs;
    const ay = this.vx / hs;
    this.wx = ax * topspin;
    this.wy = ay * topspin;
    this.wz = sidespin;
  }
}

/**
 * Advance the ball by one fixed timestep.
 *
 * Returns an array of events the caller (match engine, audio, FX) reacts to:
 *   { type: 'bounce', x, y, z, speed, inBounds, onLine, region }
 *   { type: 'net',      x, z, speed }          — buried in the net
 *   { type: 'netcord',  x, z, speed }          — clipped the tape and carried on
 *   { type: 'post',     x, z, speed }
 *   { type: 'crossnet', direction }
 *
 * @param {Ball} ball
 * @param {number} dt
 * @param {object} surface  entry from surfaces.js
 * @param {object} wind     { speed, direction } — direction in radians, 0 = toward +y
 * @param {object} opts     { doubles, gust }
 */
export function stepBall(ball, dt, surface, wind, opts = {}) {
  const events = [];
  if (!ball.inPlay) return events;

  const prevY = ball.y;
  const prevZ = ball.z;

  // ── Aerodynamics ──────────────────────────────────────────────────────────
  // Work in air-relative velocity so wind actually pushes the ball around.
  let arx = ball.vx;
  let ary = ball.vy;
  const arz = ball.vz;

  if (wind && wind.speed > 0) {
    const wx = Math.sin(wind.direction) * wind.speed;
    const wy = Math.cos(wind.direction) * wind.speed;
    arx -= wx;
    ary -= wy;
  }

  const airSpeed = Math.hypot(arx, ary, arz);

  let ax = 0, ay = 0, az = -PHYSICS.GRAVITY;

  if (airSpeed > 0.01) {
    const inv = 1 / airSpeed;
    const ux = arx * inv, uy = ary * inv, uz = arz * inv;

    // Drag: a = -K · |v|² · v̂
    const dragMag = K_DRAG * airSpeed * airSpeed;
    ax -= dragMag * ux;
    ay -= dragMag * uy;
    az -= dragMag * uz;

    // Magnus: a = K · Cl · |v|² · (ŵ × v̂)
    const spinRate = ball.spinRate;
    if (spinRate > 1) {
      // Empirical lift coefficient for a tennis ball: Cl = 1 / (2 + v/v_spin),
      // where v_spin = ω·r is the ball's surface speed.
      const vSpin = spinRate * BALL.RADIUS;
      let cl = 1 / (2 + airSpeed / Math.max(vSpin, 0.001));
      if (cl > PHYSICS.MAX_LIFT_COEFF) cl = PHYSICS.MAX_LIFT_COEFF;

      const iw = 1 / spinRate;
      const wux = ball.wx * iw, wuy = ball.wy * iw, wuz = ball.wz * iw;

      // ŵ × v̂
      const cx = wuy * uz - wuz * uy;
      const cy = wuz * ux - wux * uz;
      const cz = wux * uy - wuy * ux;

      const mag = K_MAGNUS * cl * airSpeed * airSpeed;
      ax += mag * cx;
      ay += mag * cy;
      az += mag * cz;
    }
  }

  // Semi-implicit Euler: stable at 120 Hz and cheap.
  ball.vx += ax * dt;
  ball.vy += ay * dt;
  ball.vz += az * dt;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.z += ball.vz * dt;

  // Spin bleeds off slowly in flight.
  const spinDecay = 1 - PHYSICS.SPIN_DECAY_PER_SEC * dt;
  ball.wx *= spinDecay;
  ball.wy *= spinDecay;
  ball.wz *= spinDecay;

  if (ball.z > ball.maxHeightSinceHit) ball.maxHeightSinceHit = ball.z;

  // ── Net plane crossing ────────────────────────────────────────────────────
  if ((prevY < 0 && ball.y >= 0) || (prevY > 0 && ball.y <= 0)) {
    // Interpolate to the exact crossing point so a fast ball cannot tunnel through.
    const t = Math.abs(prevY) / Math.max(Math.abs(prevY - ball.y), 1e-9);
    const crossX = ball.x - ball.vx * dt * (1 - t);
    const crossZ = prevZ + (ball.z - prevZ) * t;

    const netTop = netHeightAt(crossX);
    const halfWidth = opts.doubles ? COURT.DOUBLES_HALF_WIDTH : COURT.SINGLES_HALF_WIDTH;

    if (Math.abs(crossX) > COURT.NET_POST_X) {
      // Outside the posts entirely — legal if it lands in, a spectacular shot.
      ball.crossedNet = true;
      events.push({ type: 'crossnet', direction: Math.sign(ball.vy), aroundPost: true });
    } else if (Math.abs(Math.abs(crossX) - COURT.NET_POST_X) < 0.06 && crossZ < COURT.NET_HEIGHT_POST) {
      // Struck the post.
      ball.vx *= -0.35; ball.vy *= -0.42; ball.vz *= 0.5;
      ball.y = Math.sign(prevY) * 0.05;
      ball.touchedNet = true;
      events.push({ type: 'post', x: crossX, z: crossZ, speed: ball.speed });
    } else if (crossZ - BALL.RADIUS < netTop) {
      if (crossZ + BALL.RADIUS > netTop) {
        // Clipped the tape: heavy energy loss, deflection upward, spin killed.
        // Whether it drops over or falls back is then decided by physics, exactly
        // as in the real game.
        ball.vx *= 0.62;
        ball.vy *= 0.42;
        ball.vz = Math.abs(ball.vz) * 0.28 + 0.9;
        ball.wx *= 0.25; ball.wy *= 0.25; ball.wz *= 0.25;
        ball.z = netTop + BALL.RADIUS;
        ball.touchedNet = true;
        ball.crossedNet = true;
        events.push({ type: 'netcord', x: crossX, z: crossZ, speed: ball.speed });
      } else {
        // Buried in the net. The mesh absorbs almost everything.
        ball.x = crossX;
        ball.y = Math.sign(prevY) * 0.04;
        ball.z = crossZ;
        ball.vx *= 0.12;
        ball.vy = -Math.sign(ball.vy) * Math.abs(ball.vy) * 0.08;
        ball.vz *= 0.15;
        ball.wx = ball.wy = ball.wz = 0;
        ball.touchedNet = true;
        events.push({ type: 'net', x: crossX, z: crossZ, speed: Math.hypot(ball.vx, ball.vy, ball.vz) });
      }
    } else {
      ball.crossedNet = true;
      events.push({ type: 'crossnet', direction: Math.sign(ball.vy) });
    }
  }

  // ── Ground ────────────────────────────────────────────────────────────────
  if (ball.z <= BALL.RADIUS && ball.vz < 0) {
    // Rewind to the exact contact moment for an accurate bounce mark.
    const overshoot = (BALL.RADIUS - ball.z) / Math.max(-ball.vz, 1e-9);
    const bx = ball.x - ball.vx * overshoot;
    const by = ball.y - ball.vy * overshoot;

    ball.x = bx;
    ball.y = by;
    ball.z = BALL.RADIUS;

    const impactSpeed = Math.abs(ball.vz);
    const call = judgeBounce(bx, by, opts.doubles, opts.serveBox);

    bounce(ball, surface);
    ball.bounces++;

    events.push({
      type: 'bounce',
      x: bx, y: by, z: BALL.RADIUS,
      speed: impactSpeed,
      inBounds: call.inBounds,
      onLine: call.onLine,
      region: call.region,
      bounceIndex: ball.bounces,
    });
  }

  // Rolling / dying ball after the point is over.
  if (ball.z <= BALL.RADIUS + 1e-4 && Math.abs(ball.vz) < 0.35) {
    ball.z = BALL.RADIUS;
    ball.vz = 0;
    const roll = Math.exp(-surface.friction * 2.4 * dt);
    ball.vx *= roll;
    ball.vy *= roll;
  }

  // Trail sampling, capped so it cannot grow without bound.
  ball._trailTimer += dt;
  if (ball._trailTimer >= 0.016) {
    ball._trailTimer = 0;
    ball.trail.push(ball.x, ball.y, ball.z);
    if (ball.trail.length > 90) ball.trail.splice(0, 3);
  }

  return events;
}

/**
 * Rigid-sphere bounce with Coulomb friction.
 *
 * The key insight: friction acts on the velocity of the ball's CONTACT POINT, not its
 * centre. A topspinning ball's contact point is already moving backwards relative to
 * the centre, so friction has less to fight and can even fling the ball forward and
 * upward — that is the clay-court kick. A slicing ball's contact point races forward,
 * so friction bites hard and the ball skids low and slow.
 */
function bounce(ball, surface) {
  const r = BALL.RADIUS;
  const mu = surface.friction;

  // Heavy topspin compresses the ball harder into the court and comes off livelier.
  const topspin = ball.topspin;
  const spinBoost = 1 + Math.max(0, topspin) * 0.00022;
  let e = surface.restitution * spinBoost;
  if (e > 0.95) e = 0.95;

  // Vertical: straightforward restitution.
  const vzIn = ball.vz;
  ball.vz = -vzIn * e;

  // Normal impulse magnitude per unit mass.
  const jn = -(1 + e) * vzIn;

  // Contact-point velocity: u = v + ω × (−r·ẑ)
  //   ω × ẑ = (wy, −wx, 0)   →   u_horiz = (vx − r·wy, vy + r·wx)
  const ux = ball.vx - r * ball.wy;
  const uy = ball.vy + r * ball.wx;
  const uMag = Math.hypot(ux, uy);

  if (uMag > 1e-5) {
    // Impulse needed to reach pure rolling versus what friction can actually supply.
    const jRoll = ROLL_IMPULSE_RATIO * uMag;
    const jFric = mu * jn;
    const jt = Math.min(jRoll, jFric);

    const dirX = ux / uMag;
    const dirY = uy / uMag;

    // Friction opposes the contact-point motion.
    ball.vx -= jt * dirX;
    ball.vy -= jt * dirY;

    // Angular response: Δω = (−r·ẑ) × J / (I/m),  with J = −jt·û
    //   (0,0,−r) × (jx, jy, 0) = (r·jy, −r·jx, 0)
    const jx = -jt * dirX;
    const jy = -jt * dirY;
    const inertia = INERTIA_FACTOR * r * r;
    ball.wx += (r * jy) / inertia;
    ball.wy += (-r * jx) / inertia;
  }

  // Sidespin scrubs against the court and curls the ball after the bounce.
  if (Math.abs(ball.wz) > 1) {
    const curl = ball.wz * r * mu * 0.16;
    const hs = Math.hypot(ball.vx, ball.vy);
    if (hs > 0.1) {
      // Push perpendicular to travel. Cache the components first — updating vx in
      // place before reading it for vy would skew the deflection.
      const px = -ball.vy / hs;
      const py = ball.vx / hs;
      ball.vx += px * curl;
      ball.vy += py * curl;
    }
    ball.wz *= 0.72;
  }

  // Surfaces are not perfectly uniform. Grass wears, clay has loose granules.
  if (surface.badBounceChance > 0 && Math.random() < surface.badBounceChance) {
    const m = surface.badBounceMagnitude;
    ball.vx += (Math.random() * 2 - 1) * m * 3;
    ball.vz *= 1 + (Math.random() * 2 - 1) * m;
    ball.badBounce = true;
  } else {
    ball.badBounce = false;
  }
}

/** Net height at a given x. The cord sags, so it is a curve, not a straight line. */
export function netHeightAt(x) {
  const t = Math.min(Math.abs(x) / COURT.NET_POST_X, 1);
  // Quadratic approximation of the catenary sag between the posts.
  return COURT.NET_HEIGHT_CENTRE +
    (COURT.NET_HEIGHT_POST - COURT.NET_HEIGHT_CENTRE) * t * t;
}

/**
 * In or out?
 *
 * A ball is IN if any part of it touches any part of a line, so the effective
 * boundary is the painted edge plus one ball radius. This is exactly why so many
 * calls are close enough to need a review.
 *
 * @param serveBox  when serving, { side: -1|1, box: 'deuce'|'ad' } to require the
 *                  ball land in the correct service box.
 */
export function judgeBounce(x, y, doubles, serveBox = null) {
  const halfWidth = doubles ? COURT.DOUBLES_HALF_WIDTH : COURT.SINGLES_HALF_WIDTH;
  const r = BALL.RADIUS;

  if (serveBox) {
    // The service box: net to service line, centre line to singles sideline.
    // The alleys are never in play on a serve, even in doubles.
    const nearSide = serveBox.side;   // -1 = ball must land in the far court, etc.
    const minY = nearSide > 0 ? 0 : -COURT.SERVICE_LINE;
    const maxY = nearSide > 0 ? COURT.SERVICE_LINE : 0;

    const inY = y > minY - r && y < maxY + r;
    const xIn = serveBox.box === 'deuce'
      // Deuce box is to the receiver's right, which flips with the end of the court.
      ? (nearSide > 0 ? (x > -r && x < COURT.SINGLES_HALF_WIDTH + r)
                      : (x < r && x > -COURT.SINGLES_HALF_WIDTH - r))
      : (nearSide > 0 ? (x < r && x > -COURT.SINGLES_HALF_WIDTH - r)
                      : (x > -r && x < COURT.SINGLES_HALF_WIDTH + r));

    const inBounds = inY && xIn;
    const onLine = inBounds && (
      Math.abs(Math.abs(y) - COURT.SERVICE_LINE) < r + COURT.LINE_WIDTH ||
      Math.abs(Math.abs(x) - COURT.SINGLES_HALF_WIDTH) < r + COURT.LINE_WIDTH ||
      Math.abs(x) < r + COURT.LINE_WIDTH
    );
    return { inBounds, onLine, region: 'service' };
  }

  const inX = Math.abs(x) < halfWidth + r;
  const inY = Math.abs(y) < COURT.HALF_LENGTH + r;
  const inBounds = inX && inY;

  // "On the line" drives the tighter line-call sound and the review animation.
  const onLine = inBounds && (
    Math.abs(halfWidth - Math.abs(x)) < r + COURT.LINE_WIDTH ||
    Math.abs(COURT.HALF_LENGTH - Math.abs(y)) < r + COURT.BASELINE_WIDTH
  );

  let region = 'in';
  if (!inBounds) {
    if (!inY && Math.abs(y) >= COURT.HALF_LENGTH) region = 'long';
    else region = 'wide';
  }

  return { inBounds, onLine, region };
}

/**
 * How close the call was, 0 (dead centre of the court) to 1 (right on the paint).
 * Used to decide whether the crowd gasps and whether a challenge is plausible.
 */
export function callMargin(x, y, doubles) {
  const halfWidth = doubles ? COURT.DOUBLES_HALF_WIDTH : COURT.SINGLES_HALF_WIDTH;
  const dx = Math.abs(halfWidth - Math.abs(x));
  const dy = Math.abs(COURT.HALF_LENGTH - Math.abs(y));
  const d = Math.min(dx, dy);
  return Math.max(0, 1 - d / 0.35);
}

/**
 * Predict where a ball will next cross a given height, by running the real
 * integrator forward on a scratch copy. The AI uses this to move to the ball, and
 * the aiming assist uses it to draw the landing marker. Accuracy matters more than
 * speed here, so it uses the same physics rather than a closed-form parabola.
 *
 * @returns { x, y, z, t, willBounce, landX, landY, landT } or null
 */
export function predictBall(ball, surface, wind, opts = {}, maxTime = 4, targetZ = null) {
  const sim = new Ball();
  Object.assign(sim, {
    x: ball.x, y: ball.y, z: ball.z,
    vx: ball.vx, vy: ball.vy, vz: ball.vz,
    wx: ball.wx, wy: ball.wy, wz: ball.wz,
    inPlay: true,
  });
  sim.trail = [];

  const dt = 1 / 120;
  let t = 0;
  let landX = null, landY = null, landT = null;
  let result = null;

  while (t < maxTime) {
    const prevZ = sim.z;
    const evs = stepBall(sim, dt, surface, wind, opts);
    t += dt;

    for (const e of evs) {
      if (e.type === 'bounce' && landT === null) {
        landX = e.x; landY = e.y; landT = t;
      }
      if (e.type === 'net') {
        return { x: sim.x, y: sim.y, z: sim.z, t, hitNet: true, landX, landY, landT };
      }
    }

    // Descending through the requested contact height.
    //
    // `opts.afterBounce` matters enormously for the AI. Without it, the first match
    // is the descent on the way INTO the bounce — which is a half-volley at the
    // player's shoelaces, not a groundstroke. Groundstrokes want the descent after
    // the ball has come back up off the court; volleys want the first crossing.
    const bounceOk = !opts.afterBounce || sim.bounces >= 1;
    if (targetZ !== null && result === null && bounceOk &&
        sim.vz < 0 && prevZ >= targetZ && sim.z <= targetZ) {
      result = { x: sim.x, y: sim.y, z: sim.z, t };
    }

    if (sim.bounces >= 2) break;
    if (Math.abs(sim.y) > COURT.HALF_LENGTH + COURT.RUNOFF_BACK) break;
  }

  if (result) return { ...result, landX, landY, landT, willBounce: landT !== null };
  if (landT !== null) {
    return { x: landX, y: landY, z: 0, t: landT, landX, landY, landT, willBounce: true };
  }
  return null;
}

/**
 * Where should a player actually move to hit this ball?
 *
 * Targeting a fixed height-crossing is not good enough — it produces contact points
 * the player physically cannot reach in time, which is how you end up with an AI
 * that swings at thin air. This walks the real predicted trajectory and scores every
 * sample where the ball is inside the strike zone, keeping only those the player can
 * get to given their top speed and the time available.
 *
 * Preference order, encoded in the score: a comfortable contact height, after the
 * bounce, inside the court, and not so early that it becomes a half-volley — while
 * still leaving enough margin to arrive.
 *
 * @returns { x, y, z, t, bounces, reachable, urgency } or null if the ball is dead.
 *          `reachable: false` means the best-effort chase point, so the AI still runs
 *          for a ball it will probably not get — which is what a real player does.
 */
export function solveIntercept(ball, surface, wind, opts, from, maxSpeed, cfg = {}) {
  const zLow = cfg.zLow ?? 0.42;
  const zHigh = cfg.zHigh ?? 2.0;
  const idealZ = cfg.idealZ ?? 0.95;
  const reachRadius = cfg.reach ?? 0.95;
  const maxTime = cfg.maxTime ?? 3.2;
  const preferAfterBounce = cfg.preferAfterBounce !== false;

  const sim = new Ball();
  Object.assign(sim, {
    x: ball.x, y: ball.y, z: ball.z,
    vx: ball.vx, vy: ball.vy, vz: ball.vz,
    wx: ball.wx, wy: ball.wy, wz: ball.wz,
    inPlay: true,
  });
  sim.trail = [];

  const dt = 1 / 120;
  let t = 0;
  let best = null;
  let bestScore = Infinity;
  let fallback = null;
  let fallbackScore = Infinity;
  let landX = null, landY = null, landT = null;

  const yLimit = COURT.HALF_LENGTH + COURT.RUNOFF_BACK;
  const xLimit = COURT.DOUBLES_HALF_WIDTH + COURT.RUNOFF_SIDE;

  while (t < maxTime) {
    const evs = stepBall(sim, dt, surface, wind, opts);
    t += dt;

    for (const e of evs) {
      if (e.type === 'bounce' && landT === null) { landX = e.x; landY = e.y; landT = t; }
      if (e.type === 'net') { t = maxTime; }
    }
    if (sim.bounces >= 2) break;
    if (Math.abs(sim.y) > yLimit + 2) break;

    // Sample every other step; 60 Hz resolution is far finer than any decision needs.
    if (((t * 120) | 0) % 2) continue;
    if (sim.z < zLow || sim.z > zHigh) continue;

    const dist = Math.hypot(sim.x - from.x, sim.y - from.y);
    // How far the player can travel before the ball gets there, plus their reach.
    const canCover = maxSpeed * t + reachRadius;
    const shortfall = dist - canCover;

    // Score: lower is better.
    let score = Math.abs(sim.z - idealZ) * 1.4;
    if (preferAfterBounce && sim.bounces === 0) score += 1.6;   // avoid half-volleys
    if (Math.abs(sim.y) > COURT.HALF_LENGTH + 1.2) score += 1.1; // avoid deep chases
    if (Math.abs(sim.x) > xLimit - 0.5) score += 2.0;
    // Leave a little arrival margin rather than cutting it to the millisecond.
    score += Math.max(0, shortfall + 0.25) * 3.0;
    // Mild preference for taking the ball sooner, so the AI does not drift backwards.
    score += t * 0.22;

    if (shortfall <= 0) {
      if (score < bestScore) {
        bestScore = score;
        best = { x: sim.x, y: sim.y, z: sim.z, t, bounces: sim.bounces, reachable: true };
      }
    } else if (score < fallbackScore) {
      fallbackScore = score;
      fallback = { x: sim.x, y: sim.y, z: sim.z, t, bounces: sim.bounces, reachable: false };
    }
  }

  const chosen = best || fallback;
  if (!chosen) return null;

  return { ...chosen, landX, landY, landT };
}
