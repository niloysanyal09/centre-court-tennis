/**
 * The player entity: movement, stamina, and the swing state machine.
 *
 * SWING MODEL (this is the core of how the game feels):
 *
 *   press  → WINDUP.  Power charges while held, up to TIMING.MAX_CHARGE.
 *   release→ SWING.   The racket takes SWING_TO_CONTACT seconds to reach the ball.
 *   contact→ graded.  Quality comes from how well the ball sits in the strike zone at
 *                     the exact moment the racket arrives.
 *
 * So you are not timing a button against a ball — you are timing a *swing* against a
 * ball, which is what real tennis actually asks of you. Release too early and the
 * racket arrives before the ball; too late and the ball is already past you. Both
 * produce a mishit, and they sound and behave differently from a clean strike.
 */

import { PLAYER, STAMINA, TIMING, COURT, SIM } from './constants.js';
import { gradeTiming, shotDifficulty } from './shots.js';

/** Time from releasing the button to the racket meeting the ball. */
const SWING_TO_CONTACT = 0.145;
/** How long the follow-through locks you out of moving freely. */
const FOLLOW_THROUGH = 0.19;

export const SwingState = {
  IDLE: 'idle',
  WINDUP: 'windup',
  SWING: 'swing',
  FOLLOW: 'followthrough',
  SERVE_READY: 'serve_ready',
  SERVE_TOSS: 'serve_toss',
  SERVE_HIT: 'serve_hit',
};

export class PlayerEntity {
  /**
   * @param {number} index  0..3
   * @param {number} team   0 or 1
   * @param {object} avatar avatar object (attributes, handedness, height)
   * @param {object} cfg    { isNear, isAI, doubles, doublesSlot }
   */
  constructor(index, team, avatar, cfg = {}) {
    this.index = index;
    this.team = team;
    this.avatar = avatar;
    this.isAI = !!cfg.isAI;
    this.doubles = !!cfg.doubles;
    this.doublesSlot = cfg.doublesSlot || 0;   // 0 = deuce side, 1 = ad side

    // Which end of the court this player defends: -1 = near, +1 = far.
    this.side = cfg.isNear === false ? 1 : -1;

    this.x = 0;
    this.y = this.side * (COURT.HALF_LENGTH + 0.6);
    this.z = 0;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;

    this.facing = this.side > 0 ? Math.PI : 0;

    this.stamina = STAMINA.MAX;
    this.swing = SwingState.IDLE;
    this.swingTimer = 0;
    this.charge = 0;
    this.chargeHeld = false;
    this.pendingShot = 'topspin';
    this.aim = { x: 0, y: 0 };
    this.lastContactQuality = 1;

    // Serve state
    this.isServer = false;
    this.serveType = 'flat';
    this.tossTime = 0;
    this.tossHeight = 0;

    // Split-step: a small hop timed to the opponent's contact that buys you a
    // burst of acceleration. Rewarding it teaches real footwork.
    this.splitStepTimer = -1;
    this.splitStepBonus = 1;

    this.sliding = false;
    this.slideTimer = 0;

    // Animation, read by the renderer.
    this.animState = 'idle';
    this.animPhase = 0;
    this.animTimer = 0;
    this.swingType = 'topspin';

    this.canHit = true;         // false during follow-through
    this.lastHitTime = -99;
    this.reactionLock = 0;      // AI reaction delay
  }

  get attrs() {
    return this.avatar?.attributes || {
      power: 5, speed: 5, stamina: 5, accuracy: 5,
      serve: 5, volley: 5, defense: 5, mental: 5,
    };
  }

  get staminaFrac() { return this.stamina / STAMINA.MAX; }

  /** Fatigue 0 (fresh) → 1 (spent). Non-linear: you feel fine until suddenly you do not. */
  get fatigue() {
    const f = this.staminaFrac;
    if (f >= STAMINA.FATIGUE_THRESHOLD) return 0;
    return Math.pow(1 - f / STAMINA.FATIGUE_THRESHOLD, 1.5);
  }

  /** Top speed, modified by the speed attribute, fatigue, and the surface. */
  maxSpeed(surface) {
    const attrBonus = 0.82 + (this.attrs.speed / 10) * 0.36;   // 0.82 → 1.18
    const fatiguePenalty = 1 - this.fatigue * (1 - STAMINA.MIN_SPEED_FACTOR);
    const traction = surface?.tractionFactor ?? 1;
    return PLAYER.MAX_SPEED * attrBonus * fatiguePenalty * traction * this.splitStepBonus;
  }

  get reach() {
    // Taller players genuinely reach further.
    const heightScale = (this.avatar?.height || 1.85) / 1.85;
    return PLAYER.REACH * heightScale;
  }

  /** Comfortable contact height, scaled by player height. */
  get contactHeight() {
    return PLAYER.CONTACT_HEIGHT_COMFORT * ((this.avatar?.height || 1.85) / 1.85);
  }

  // ── Movement ───────────────────────────────────────────────────────────────

  /**
   * @param {object} input  { moveX, moveY, sprint }  moveX/moveY in -1..1, screen-relative
   * @param {object} surface
   */
  move(input, dt, surface) {
    // Screen-relative controls: pressing "up" always moves the player up the screen,
    // regardless of which end they are defending. Anything else is disorienting.
    let mx = input.moveX || 0;
    let my = input.moveY || 0;

    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }

    const speedCap = this.maxSpeed(surface) * (input.sprint ? 1.0 : 0.88);

    // During the follow-through you are rooted; that is the cost of a big swing.
    const locked = this.swing === SwingState.FOLLOW ||
                   this.swing === SwingState.SWING ||
                   this.swing === SwingState.SERVE_TOSS ||
                   this.swing === SwingState.SERVE_HIT;
    const control = locked ? 0.18 : 1;

    if (mag > 0.01) {
      const targetVx = mx * speedCap;
      const targetVy = my * speedCap;
      const accel = PLAYER.ACCEL * control * (surface?.tractionFactor ?? 1);
      this.vx += clampMag(targetVx - this.vx, accel * dt);
      this.vy += clampMag(targetVy - this.vy, accel * dt);

      // Face the direction of travel while running.
      if (!locked) this.facing = Math.atan2(mx, my);
    } else {
      // Decelerate. On clay you keep sliding; indoors you stop dead.
      const slideResist = 1 - (surface?.slideFactor ?? 0.5) * 0.35;
      const decel = PLAYER.DECEL * slideResist * dt;
      this.vx -= clampMag(this.vx, decel);
      this.vy -= clampMag(this.vy, decel);
    }

    // Clamp to the cap (diagonal movement must not be faster).
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > speedCap) {
      this.vx = (this.vx / sp) * speedCap;
      this.vy = (this.vy / sp) * speedCap;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Keep players inside the run-off area — you cannot chase a ball into the stands.
    const xLimit = COURT.DOUBLES_HALF_WIDTH + COURT.RUNOFF_SIDE;
    const yLimit = COURT.HALF_LENGTH + COURT.RUNOFF_BACK;
    if (this.x < -xLimit) { this.x = -xLimit; this.vx = 0; }
    if (this.x > xLimit) { this.x = xLimit; this.vx = 0; }
    // Players may not cross the net.
    const yMin = this.side > 0 ? 0.35 : -yLimit;
    const yMax = this.side > 0 ? yLimit : -0.35;
    if (this.y < yMin) { this.y = yMin; this.vy = 0; }
    if (this.y > yMax) { this.y = yMax; this.vy = 0; }

    // Sliding detection, for the sound and the animation.
    const wantsSlide = mag < 0.15 && sp > 3.2 && (surface?.slideFactor ?? 0) > 0.5;
    this.sliding = wantsSlide;

    this._updateStamina(sp, speedCap, dt);
    this._updateSplitStep(dt);
    this._updateAnimation(dt, sp, speedCap);
  }

  _updateStamina(speed, cap, dt) {
    const enduranceBonus = 0.75 + (this.attrs.stamina / 10) * 0.5;
    const effort = cap > 0 ? speed / cap : 0;

    if (effort > 0.25) {
      this.stamina -= STAMINA.SPRINT_DRAIN * Math.pow(effort, 1.6) * dt / enduranceBonus;
    } else {
      this.stamina += STAMINA.IDLE_RECOVER * dt * enduranceBonus;
    }
    this.stamina = Math.max(0, Math.min(STAMINA.MAX, this.stamina));
  }

  _updateSplitStep(dt) {
    if (this.splitStepTimer >= 0) {
      this.splitStepTimer -= dt;
      if (this.splitStepTimer <= 0) {
        this.splitStepTimer = -1;
        this.splitStepBonus = 1;
      }
    }
  }

  /**
   * Call when the player split-steps. If it lands close to the opponent's contact
   * it grants a burst of acceleration for the first step — the real benefit of the
   * move, and worth teaching in the practice mode.
   */
  splitStep(timeToOpponentContact) {
    if (this.splitStepTimer >= 0) return 0;
    const err = Math.abs(timeToOpponentContact);
    if (err < PLAYER.SPLIT_STEP_WINDOW) {
      const q = 1 - err / PLAYER.SPLIT_STEP_WINDOW;
      this.splitStepBonus = 1 + (PLAYER.SPLIT_STEP_BONUS - 1) * q;
      this.splitStepTimer = 0.55;
      return q;
    }
    this.splitStepBonus = 1;
    this.splitStepTimer = 0.3;
    return 0;
  }

  recoverBetweenPoints(dt) {
    const enduranceBonus = 0.75 + (this.attrs.stamina / 10) * 0.5;
    this.stamina = Math.min(STAMINA.MAX,
      this.stamina + STAMINA.BETWEEN_POINTS_RECOVER * dt * enduranceBonus);
  }

  // ── Swing ──────────────────────────────────────────────────────────────────

  /** Begin charging a shot. */
  startSwing(shotType) {
    if (this.swing !== SwingState.IDLE) return false;
    this.swing = SwingState.WINDUP;
    this.charge = 0;
    this.chargeHeld = true;
    this.pendingShot = shotType;
    this.swingType = shotType;
    this.animState = 'windup';
    this.animTimer = 0;
    return true;
  }

  /** Release the shot. The racket now travels toward the ball. */
  releaseSwing() {
    if (this.swing !== SwingState.WINDUP) return false;
    this.swing = SwingState.SWING;
    this.swingTimer = 0;
    this.chargeHeld = false;
    this.animState = 'swing';
    this.animTimer = 0;
    return true;
  }

  /**
   * Advance the swing clock.
   * @returns 'contact' on the frame the racket reaches the ball, else null.
   */
  updateSwing(dt) {
    switch (this.swing) {
      case SwingState.WINDUP:
        if (this.chargeHeld) {
          this.charge = Math.min(1, this.charge + dt / TIMING.MAX_CHARGE);
        }
        // Holding forever is not a strategy — the swing auto-releases.
        if (this.charge >= 1) {
          this.releaseSwing();
        }
        return null;

      case SwingState.SWING:
        this.swingTimer += dt;
        if (this.swingTimer >= SWING_TO_CONTACT) {
          this.swing = SwingState.FOLLOW;
          this.swingTimer = 0;
          this.animState = 'followthrough';
          this.animTimer = 0;
          this.canHit = false;
          return 'contact';
        }
        return null;

      case SwingState.FOLLOW:
        this.swingTimer += dt;
        if (this.swingTimer >= FOLLOW_THROUGH) {
          this.swing = SwingState.IDLE;
          this.swingTimer = 0;
          this.canHit = true;
          this.animState = 'ready';
        }
        return null;

      default:
        return null;
    }
  }

  /** Power for the pending shot: charge, plus the power attribute. */
  shotPower() {
    const attrBonus = 0.78 + (this.attrs.power / 10) * 0.44;
    const charged = TIMING.MIN_CHARGE_POWER + this.charge * (1 - TIMING.MIN_CHARGE_POWER);
    return Math.min(1.15, charged * attrBonus);
  }

  /**
   * Can this player reach the ball right now, and how cleanly?
   *
   * Returns null if out of reach, otherwise:
   *   { quality 0..1, contactHeight, difficulty, distance, overhead }
   */
  evaluateContact(ball) {
    const dx = ball.x - this.x;
    const dy = ball.y - this.y;
    const horiz = Math.hypot(dx, dy);

    // Vertical reach: from a dug-out half volley to a full-stretch overhead.
    const heightScale = (this.avatar?.height || 1.85) / 1.85;
    const zMin = PLAYER.CONTACT_HEIGHT_LOW;
    const zMax = PLAYER.CONTACT_HEIGHT_HIGH * heightScale;
    if (ball.z < zMin - 0.1 || ball.z > zMax) return null;

    // Horizontal reach shrinks when stretching high or scraping low.
    const idealZ = this.contactHeight;
    const zErr = Math.abs(ball.z - idealZ);
    const effectiveReach = this.reach * (1 - Math.min(0.4, zErr * 0.22)) + 0.35;
    if (horiz > effectiveReach) return null;

    // Positional quality: how close the ball is to the sweet spot in front of the body.
    const posErr = Math.hypot(horiz - 0.55, zErr * 0.7);

    // Timing quality: convert the positional miss into an equivalent time error using
    // the ball's speed, so a fast ball demands tighter timing than a slow one.
    const ballSpeed = Math.max(6, ball.speed);
    const timeErr = posErr / ballSpeed * 2.4;
    let quality = gradeTiming(timeErr);

    // Reaching outside the comfortable zone caps how clean the strike can be.
    quality *= 1 - Math.min(0.45, Math.max(0, horiz - 0.9) * 0.5);

    const difficulty = shotDifficulty(this, ball, ball.z);
    const overhead = ball.z > 1.9 * heightScale;

    return {
      quality: Math.max(0, Math.min(1, quality)),
      contactHeight: ball.z,
      difficulty,
      distance: horiz,
      overhead,
    };
  }

  /** Where the racket meets the ball, for FX and audio positioning. */
  contactPoint() {
    const fx = Math.sin(this.facing);
    const fy = Math.cos(this.facing);
    return {
      x: this.x + fx * 0.5,
      y: this.y + fy * 0.5,
      z: this.contactHeight,
    };
  }

  // ── Serve ──────────────────────────────────────────────────────────────────

  beginServe(serveType) {
    this.isServer = true;
    this.serveType = serveType || 'flat';
    this.swing = SwingState.SERVE_READY;
    this.animState = 'idle';
    this.tossTime = 0;
    this.tossHeight = 0;
    this.charge = 0;
  }

  /** Toss the ball. Returns the toss apex height so the caller can launch the ball. */
  tossBall() {
    if (this.swing !== SwingState.SERVE_READY) return null;
    this.swing = SwingState.SERVE_TOSS;
    this.animState = 'serve_toss';
    this.animTimer = 0;
    this.tossTime = 0;
    // A taller player tosses higher and strikes higher.
    const heightScale = (this.avatar?.height || 1.85) / 1.85;
    this.tossHeight = 3.15 * heightScale;
    return this.tossHeight;
  }

  /**
   * Strike the serve. Quality depends on how close the ball is to the ideal contact
   * height at the moment you swing — the whole skill of a serve in one number.
   */
  hitServe(ballZ, ballVz) {
    if (this.swing !== SwingState.SERVE_TOSS) return null;
    const heightScale = (this.avatar?.height || 1.85) / 1.85;
    const ideal = 2.72 * heightScale;

    const zErr = Math.abs(ballZ - ideal);
    // Striking on the way down is fine; striking on the way up is a timing error.
    const risingPenalty = ballVz > 1.2 ? 0.18 : 0;

    let quality = Math.max(0, 1 - zErr / 0.75) - risingPenalty;
    // The serve attribute raises the floor: a great server rarely shanks a toss.
    const serveAttr = this.attrs.serve / 10;
    quality = quality * (0.72 + serveAttr * 0.28) + serveAttr * 0.12;
    quality = Math.max(0, Math.min(1, quality));

    this.swing = SwingState.SERVE_HIT;
    this.animState = 'serve_hit';
    this.animTimer = 0;
    this.lastContactQuality = quality;
    this.stamina -= STAMINA.SERVE_COST;

    return { quality, contactHeight: ideal };
  }

  endServe() {
    this.isServer = false;
    this.swing = SwingState.IDLE;
    this.animState = 'ready';
    this.canHit = true;
  }

  resetForPoint(x, y) {
    this.x = x;
    this.y = y;
    this.z = 0;
    this.vx = 0;
    this.vy = 0;
    this.swing = SwingState.IDLE;
    this.charge = 0;
    this.chargeHeld = false;
    this.canHit = true;
    this.sliding = false;
    this.animState = 'ready';
    this.animPhase = 0;
    this.splitStepTimer = -1;
    this.splitStepBonus = 1;
    this.facing = this.side > 0 ? Math.PI : 0;
  }

  // ── Animation ──────────────────────────────────────────────────────────────

  _updateAnimation(dt, speed, cap) {
    this.animTimer += dt;

    // Swing animations own the state machine; movement only drives the idle/run blend.
    if (this.swing === SwingState.IDLE || this.swing === SwingState.SERVE_READY) {
      if (this.sliding) {
        this.animState = 'slide';
        this.animPhase = Math.min(1, this.animTimer / 0.5);
      } else if (speed > 0.6) {
        this.animState = 'run';
        // Stride frequency scales with speed so fast running does not look floaty.
        const strideHz = 1.6 + (speed / Math.max(cap, 0.1)) * 2.4;
        this.animPhase = (this.animPhase + dt * strideHz) % 1;
      } else {
        this.animState = 'ready';
        this.animPhase = (this.animPhase + dt * 0.8) % 1;
      }
    } else if (this.swing === SwingState.WINDUP) {
      this.animPhase = this.charge;
    } else if (this.swing === SwingState.SWING) {
      this.animPhase = Math.min(1, this.swingTimer / SWING_TO_CONTACT);
    } else if (this.swing === SwingState.FOLLOW) {
      this.animPhase = Math.min(1, this.swingTimer / FOLLOW_THROUGH);
    } else if (this.swing === SwingState.SERVE_TOSS) {
      this.animPhase = Math.min(1, this.animTimer / 0.9);
    } else if (this.swing === SwingState.SERVE_HIT) {
      this.animPhase = Math.min(1, this.animTimer / 0.45);
      if (this.animPhase >= 1) this.endServe();
    }
  }

  /** Compact snapshot for the netcode. */
  serialise() {
    return {
      i: this.index,
      x: r2(this.x), y: r2(this.y), z: r2(this.z),
      vx: r2(this.vx), vy: r2(this.vy),
      f: r2(this.facing),
      a: this.animState, p: r2(this.animPhase),
      s: r1(this.stamina), sw: this.swing, st: this.swingType,
    };
  }

  applySnapshot(d) {
    this.x = d.x; this.y = d.y; this.z = d.z;
    this.vx = d.vx; this.vy = d.vy;
    this.facing = d.f;
    this.animState = d.a; this.animPhase = d.p;
    this.stamina = d.s; this.swing = d.sw; this.swingType = d.st;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clampMag(v, max) {
  if (v > max) return max;
  if (v < -max) return -max;
  return v;
}

const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Standard court positions. Used to place players at the start of a point and as
 * the AI's recovery targets.
 */
export function servePosition(side, box, doubles, slot = 0) {
  // The server stands just behind the baseline, a little to one side of the centre mark.
  const x = box === 'deuce' ? (side > 0 ? -1.1 : 1.1) : (side > 0 ? 1.1 : -1.1);
  return { x, y: side * (COURT.HALF_LENGTH + 0.45) };
}

export function returnPosition(side, box, doubles) {
  // The returner stands wide of the singles sideline, deep behind the baseline.
  const x = box === 'deuce' ? (side > 0 ? -2.5 : 2.5) : (side > 0 ? 2.5 : -2.5);
  return { x, y: side * (COURT.HALF_LENGTH + 1.1) };
}

export function doublesNetPosition(side, box) {
  // The server's partner stands at the net on the opposite side of the centre line.
  const x = box === 'deuce' ? (side > 0 ? 2.6 : -2.6) : (side > 0 ? -2.6 : 2.6);
  return { x, y: side * 3.2 };
}
