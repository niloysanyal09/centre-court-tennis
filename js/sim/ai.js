/**
 * AI opponents.
 *
 * Design rule: the AI does not cheat. It goes through exactly the same PlayerEntity
 * API a human does — the same movement, the same charge-and-release swing, the same
 * error model. Difficulty is expressed only as human limitations:
 *
 *   reaction    — how long before it starts moving to the ball
 *   prediction  — how much noise corrupts its read of where the ball is going
 *   timing      — how precisely it releases the swing
 *   footwork    — how much of its top speed it actually uses, and how well it recovers
 *   tactics     — how well it picks targets and exploits court position
 *
 * A beginner-level AI genuinely mistimes shots and genuinely nets balls. That makes
 * winning feel earned, and it makes the practice ladder mean something.
 */

import { COURT, PLAYER } from './constants.js';
import { predictBall, solveIntercept } from './physics.js';
import { SHOT_TYPES, SERVE_TYPES } from './shots.js';
import { SwingState } from './player.js';

const SWING_TO_CONTACT = 0.145;

export const DIFFICULTIES = {
  rookie: {
    id: 'rookie', name: 'Rookie', rating: 1,
    blurb: 'Learning the game. Slow to react, sprays balls, will hand you free points.',
    reaction: [0.42, 0.62],
    predictionNoise: 1.5,      // metres of error in reading the bounce
    timingNoise: 0.115,        // seconds of release jitter
    footwork: 0.68,            // fraction of top speed used
    recovery: 0.5,             // how diligently it returns to position
    aggression: 0.25,
    lineTargeting: 0.25,       // 0 = aims at the middle, 1 = paints lines
    netApproach: 0.04,
    varietyRate: 0.08,
    attributes: { power: 4, speed: 4, stamina: 5, accuracy: 3, serve: 3, volley: 3, defense: 4, mental: 3 },
    secondServeSafety: 0.9,
  },
  club: {
    id: 'club', name: 'Club Player', rating: 2,
    blurb: 'Solid, consistent, no weapons. Will rally all day but rarely hurts you.',
    reaction: [0.28, 0.42],
    predictionNoise: 0.9,
    timingNoise: 0.078,
    footwork: 0.79,
    recovery: 0.68,
    aggression: 0.38,
    lineTargeting: 0.4,
    netApproach: 0.1,
    varietyRate: 0.16,
    attributes: { power: 5, speed: 5, stamina: 6, accuracy: 5, serve: 4, volley: 4, defense: 5, mental: 5 },
    secondServeSafety: 0.8,
  },
  challenger: {
    id: 'challenger', name: 'Challenger', rating: 3,
    blurb: 'Genuinely competitive. Finds angles, punishes short balls, makes you move.',
    reaction: [0.19, 0.28],
    predictionNoise: 0.5,
    timingNoise: 0.05,
    footwork: 0.88,
    recovery: 0.82,
    aggression: 0.52,
    lineTargeting: 0.58,
    netApproach: 0.18,
    varietyRate: 0.24,
    attributes: { power: 6, speed: 6, stamina: 6, accuracy: 6, serve: 6, volley: 5, defense: 6, mental: 6 },
    secondServeSafety: 0.7,
  },
  tour: {
    id: 'tour', name: 'Tour Pro', rating: 4,
    blurb: 'Constructs points deliberately, defends brilliantly, and closes when you give it a chance.',
    reaction: [0.13, 0.19],
    predictionNoise: 0.26,
    timingNoise: 0.031,
    footwork: 0.95,
    recovery: 0.92,
    aggression: 0.66,
    lineTargeting: 0.75,
    netApproach: 0.26,
    varietyRate: 0.3,
    attributes: { power: 7, speed: 7, stamina: 7, accuracy: 7, serve: 7, volley: 7, defense: 7, mental: 7 },
    secondServeSafety: 0.6,
  },
  elite: {
    id: 'elite', name: 'Grand Slam Champion', rating: 5,
    blurb: 'Barely misses, covers everything, and takes the ball early to steal your time.',
    reaction: [0.08, 0.13],
    predictionNoise: 0.12,
    timingNoise: 0.017,
    footwork: 1.0,
    recovery: 0.98,
    aggression: 0.78,
    lineTargeting: 0.9,
    netApproach: 0.32,
    varietyRate: 0.36,
    attributes: { power: 8, speed: 8, stamina: 8, accuracy: 9, serve: 8, volley: 8, defense: 9, mental: 9 },
    secondServeSafety: 0.5,
  },
};

export const DIFFICULTY_LIST = Object.values(DIFFICULTIES);

export class AIController {
  /**
   * @param {PlayerEntity} player
   * @param {object} difficulty  entry from DIFFICULTIES
   */
  constructor(player, difficulty) {
    this.player = player;
    this.diff = difficulty || DIFFICULTIES.club;

    this.reactionTimer = 0;
    this.hasReacted = false;
    this.target = null;          // predicted intercept
    this.plannedShot = 'topspin';
    this.plannedTarget = { x: 0, y: 0 };
    this.desiredCharge = 0.3;
    this.swingArmed = false;
    this.lastBallHitCount = -1;
    this.splitStepDone = false;
    this.wantsNet = false;
    this.serveTimer = 0;
    this.servePhase = 'idle';
  }

  /**
   * Produce this frame's control input.
   * @returns { moveX, moveY, sprint }
   */
  update(dt, ctx) {
    const { ball, surface, wind, opponents, partner, doubles, rally } = ctx;
    const p = this.player;

    if (p.isServer) return this._updateServe(dt, ctx);

    const incoming = this._ballIsMine(ctx);

    if (!incoming) {
      this.hasReacted = false;
      this.reactionTimer = 0;
      this.swingArmed = false;
      this.target = null;
      return this._recover(dt, ctx);
    }

    // React — a human does not move the instant the opponent's racket makes contact.
    if (!this.hasReacted) {
      if (this.lastBallHitCount !== ball.hitCount) {
        this.lastBallHitCount = ball.hitCount;
        const [lo, hi] = this.diff.reaction;
        this.reactionTimer = lo + Math.random() * (hi - lo);
        this.splitStepDone = false;
        this.swingArmed = false;
        this.target = null;
      }
      this.reactionTimer -= dt;
      if (this.reactionTimer > 0) {
        // Split-step while waiting. Better AIs time it well.
        if (!this.splitStepDone && this.reactionTimer < 0.12) {
          p.splitStep(0.05 + Math.random() * 0.1 * (1 - this.diff.footwork));
          this.splitStepDone = true;
        }
        return { moveX: 0, moveY: 0, sprint: false };
      }
      this.hasReacted = true;
      this._planIntercept(ctx);
    }

    // The prediction is only re-run a few times a second, so the time-to-contact must
    // tick down every frame in between. Without this it is stale by up to a quarter
    // of a second — which, since the swing itself takes 145 ms, means the racket
    // arrives long after the ball has gone past. That is a guaranteed whiff.
    if (this.target) this.target.t -= dt;

    // Refresh the read periodically — a good player adjusts as the ball develops.
    this._refreshTimer = (this._refreshTimer || 0) - dt;
    if (this._refreshTimer <= 0) {
      this._planIntercept(ctx);
      this._refreshTimer = 0.08 + (1 - this.diff.footwork) * 0.25;
    }

    if (!this.target) return this._recover(dt, ctx);

    // ── Move to the intercept ────────────────────────────────────────────────
    const dx = this.target.x - p.x;
    const dy = this.target.y - p.y;
    const dist = Math.hypot(dx, dy);

    let moveX = 0, moveY = 0;
    if (dist > 0.12) {
      moveX = (dx / dist) * this.diff.footwork;
      moveY = (dy / dist) * this.diff.footwork;
    }

    // ── Arm and fire the swing ───────────────────────────────────────────────
    const tContact = this.target.t;

    if (!this.swingArmed && p.swing === SwingState.IDLE && p.canHit) {
      // Start the windup early enough to charge the intended amount. The jitter is
      // rolled ONCE per swing and reused at release, so it models a single decision
      // being slightly early or late rather than fresh noise on every frame.
      this._chooseShot(ctx);
      this._swingJitter = this._timingJitter();
      const lead = SWING_TO_CONTACT + this.desiredCharge;
      // Below half a swing's worth of warning there is no point starting: the ball is
      // already past. Better to not swing at all than to flail at nothing.
      if (tContact <= lead && tContact > SWING_TO_CONTACT * 0.5) {
        p.startSwing(this.plannedShot);
        this.swingArmed = true;
      }
    }

    if (this.swingArmed && p.swing === SwingState.WINDUP) {
      // Release so the racket arrives exactly as the ball reaches the strike zone.
      if (tContact <= SWING_TO_CONTACT + this._swingJitter) {
        p.releaseSwing();
        this.swingArmed = false;
      }
    }

    // The ball is gone. Clear the arm flag so the next ball gets a fresh decision
    // instead of inheriting a stale one.
    if (tContact < -0.3) this.swingArmed = false;

    // Aim is read by the match engine when contact resolves.
    p.aim = this.plannedTarget;

    const sprint = dist > 1.6;
    return { moveX, moveY, sprint };
  }

  /**
   * Is this ball mine to play? In doubles the partner with the shorter path takes it,
   * with a bias toward whoever is on the ball's side of the court.
   */
  _ballIsMine(ctx) {
    const { ball, doubles, partner } = ctx;
    const p = this.player;

    if (!ball.inPlay) return false;
    // The ball must be heading to my end and not already dead.
    if (Math.sign(ball.vy) !== p.side && Math.abs(ball.y) < COURT.HALF_LENGTH) {
      if (Math.sign(ball.y) !== p.side) return false;
    }
    if (ball.lastHitBy === p.index) return false;
    if (ball.bounces >= 2) return false;

    if (!doubles || !partner) return true;

    // Whoever is closer to the projected landing point calls it.
    const pred = this.target || predictBall(ball, ctx.surface, ctx.wind, { doubles: true }, 3, p.contactHeight);
    if (!pred) return true;
    const myDist = Math.hypot(pred.x - p.x, pred.y - p.y);
    const partnerDist = Math.hypot(pred.x - partner.x, pred.y - partner.y);
    // Small hysteresis so the two do not swap back and forth mid-point.
    return myDist <= partnerDist + 0.35;
  }

  _planIntercept(ctx) {
    const { ball, surface, wind, doubles } = ctx;
    const p = this.player;

    // Solve for a contact point this player can physically get to, rather than a
    // fixed height-crossing they may have no chance of reaching. A baseline player
    // prefers to let the ball bounce; someone at the net takes it out of the air.
    const atNet = Math.abs(p.y) < COURT.SERVICE_LINE + 0.5;
    const speed = p.maxSpeed(surface) * this.diff.footwork;

    const pred = solveIntercept(ball, surface, wind, { doubles }, { x: p.x, y: p.y }, speed, {
      idealZ: p.contactHeight,
      zLow: 0.42,
      zHigh: 2.2,
      reach: p.reach,
      preferAfterBounce: !atNet,
    });
    if (!pred) { this.target = null; return; }

    // A ball that would only be reachable behind the run-off is not worth chasing to
    // the exact metre; clamp so the AI does not sprint into the back wall.
    const yLimit = COURT.HALF_LENGTH + COURT.RUNOFF_BACK - 0.5;

    // Corrupt the read with level-appropriate noise. This is the main reason a
    // rookie gets wrong-footed and an elite AI does not.
    const noise = this.diff.predictionNoise;
    const nx = (Math.random() * 2 - 1) * noise;
    const ny = (Math.random() * 2 - 1) * noise * 0.6;

    // Stand a little BEHIND the contact point — further from the net — so the strike
    // happens out in front of the body. p.side is -1 at the near end and +1 at the
    // far end, so multiplying by it moves away from the net at either end.
    const behind = 0.35 * p.side;

    this.target = {
      x: pred.x + nx,
      y: clamp(pred.y + ny + behind, -yLimit, yLimit),
      t: pred.t,
      landY: pred.landY,
      landX: pred.landX,
      reachable: pred.reachable,
      contactZ: pred.z,
    };
  }

  /** Pick a shot and a target, given the tactical situation. */
  _chooseShot(ctx) {
    const { ball, opponents, doubles } = ctx;
    const p = this.player;
    const d = this.diff;

    const oppSide = -p.side;
    const opp = this._primaryOpponent(ctx);

    const contactHeight = this.target ? Math.max(0.4, ball.z) : 1.0;
    const myDepth = Math.abs(p.y);           // distance from the net
    const atNet = myDepth < COURT.SERVICE_LINE * 0.85;
    const stretched = this.target
      ? Math.hypot(this.target.x - p.x, this.target.y - p.y) > 2.4
      : false;

    // ── Shot type ────────────────────────────────────────────────────────────
    let shot = 'topspin';

    if (contactHeight > 2.0 && atNet) {
      shot = 'smash';
    } else if (atNet) {
      shot = 'volley';
    } else if (stretched) {
      // Under pressure, defend: slice or a high loopy ball to buy time.
      shot = Math.random() < 0.5 ? 'slice' : 'heavy';
    } else if (contactHeight < 0.5) {
      shot = 'slice';
    } else {
      // Attack if the ball sits up and we are inside the baseline.
      const shortBall = this.target && Math.abs(this.target.y) < COURT.HALF_LENGTH - 1.2;
      if (shortBall && Math.random() < d.aggression) {
        shot = Math.random() < 0.35 ? 'flat' : 'topspin';
        this.wantsNet = Math.random() < d.netApproach;
      } else {
        shot = 'topspin';
      }
    }

    // Occasional variety: a drop shot when the opponent is deep, a lob when they rush.
    if (Math.random() < d.varietyRate) {
      const oppDepth = opp ? Math.abs(opp.y) : COURT.HALF_LENGTH;
      if (opp && oppDepth < COURT.SERVICE_LINE && contactHeight > 0.6 && !stretched) {
        shot = 'lob';
      } else if (oppDepth > COURT.HALF_LENGTH - 0.5 && !stretched && Math.abs(p.y) < COURT.HALF_LENGTH) {
        shot = 'drop';
      }
    }

    this.plannedShot = shot;
    const def = SHOT_TYPES[shot];

    // ── Target placement ─────────────────────────────────────────────────────
    const halfWidth = doubles ? COURT.DOUBLES_HALF_WIDTH : COURT.SINGLES_HALF_WIDTH;
    // Safety margin from the lines, shrinking as skill rises.
    const margin = 0.35 + (1 - d.lineTargeting) * 1.5;
    const maxX = halfWidth - margin;

    let tx, ty;

    if (shot === 'drop') {
      tx = (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 1.8);
      ty = oppSide * (1.6 + Math.random() * 1.4);
    } else if (shot === 'lob') {
      tx = (Math.random() * 2 - 1) * maxX * 0.6;
      ty = oppSide * (COURT.HALF_LENGTH - 0.8 - Math.random() * 1.2);
    } else if (shot === 'smash') {
      // Away from the opponent, steeply down.
      tx = opp ? -Math.sign(opp.x || 0.1) * (1.5 + Math.random() * 2.5) : 0;
      ty = oppSide * (2.5 + Math.random() * 3.5);
    } else {
      // Hit behind or away from the opponent, weighted by skill.
      const oppX = opp ? opp.x : 0;
      // Aim to the open side; better AIs commit harder to the corner.
      const awaySign = oppX > 0 ? -1 : 1;
      const commitment = 0.35 + d.lineTargeting * 0.65;
      tx = awaySign * maxX * commitment * (0.7 + Math.random() * 0.3);

      // Occasionally go behind them, which is what a smart player does when you
      // start anticipating.
      if (Math.random() < d.lineTargeting * 0.22) tx = -tx * 0.7;

      // Depth: deeper is safer and more effective, but riskier.
      const depthFrac = 0.62 + d.aggression * 0.3 + Math.random() * 0.12;
      ty = oppSide * (COURT.HALF_LENGTH * depthFrac + 1.5);
    }

    this.plannedTarget = { x: clamp(tx, -maxX, maxX), y: ty };

    // ── Charge ───────────────────────────────────────────────────────────────
    // Aggressive AIs load up; defensive situations get a shorter, safer swing.
    let charge = 0.25 + d.aggression * 0.5;
    if (stretched) charge *= 0.45;
    if (shot === 'drop' || shot === 'lob' || shot === 'volley') charge *= 0.5;
    if (shot === 'smash') charge = 0.9;
    this.desiredCharge = clamp(charge * 0.62, 0.05, 0.62);
  }

  _primaryOpponent(ctx) {
    const { opponents } = ctx;
    if (!opponents || !opponents.length) return null;
    // In doubles, react to whichever opponent is further from our intended target.
    return opponents[0];
  }

  /** Return toward the position that best covers the opponent's likely replies. */
  _recover(dt, ctx) {
    const p = this.player;
    const { ball, doubles, partner } = ctx;

    let homeX = 0;
    let homeY = p.side * (COURT.HALF_LENGTH + 0.5);

    if (doubles) {
      // One up, one back is the default; both back when defending a lob.
      const isNetPlayer = Math.abs(p.y) < COURT.SERVICE_LINE;
      if (isNetPlayer) {
        homeX = p.doublesSlot === 0 ? 2.4 * -p.side : -2.4 * -p.side;
        homeY = p.side * 3.4;
      } else {
        homeX = p.doublesSlot === 0 ? -2.0 : 2.0;
        homeY = p.side * (COURT.HALF_LENGTH + 0.4);
      }
    } else if (this.wantsNet && ball.lastHitBy === p.index) {
      // Following a shot in to the net.
      homeY = p.side * (COURT.SERVICE_LINE * 0.55);
      homeX = ball.x * 0.35;
    } else {
      // Bisect the opponent's possible angles rather than blindly returning to centre.
      const oppX = ball.inPlay ? ball.x : 0;
      homeX = -oppX * 0.22;
    }

    const dx = homeX - p.x;
    const dy = homeY - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.3) return { moveX: 0, moveY: 0, sprint: false };

    const eff = this.diff.recovery * PLAYER.RECOVERY_SPEED_FACTOR;
    return {
      moveX: (dx / dist) * eff,
      moveY: (dy / dist) * eff,
      sprint: dist > 3,
    };
  }

  /** Serve routine: settle, toss, strike. */
  _updateServe(dt, ctx) {
    const p = this.player;
    this.serveTimer += dt;

    if (p.swing === SwingState.SERVE_READY) {
      // Pause before serving, like a real player going through their routine.
      if (this.serveTimer > 0.8 + Math.random() * 0.6) {
        this._chooseServe(ctx);
        ctx.requestToss?.(p.index);
        this.serveTimer = 0;
      }
    } else if (p.swing === SwingState.SERVE_TOSS) {
      // Strike near the top of the toss. Weaker AIs mistime this and shank serves.
      const targetDelay = 0.62 + this._timingJitter() * 1.6;
      if (this.serveTimer > targetDelay) {
        ctx.requestServeHit?.(p.index);
        this.serveTimer = 0;
      }
    }
    return { moveX: 0, moveY: 0, sprint: false };
  }

  _chooseServe(ctx) {
    const p = this.player;
    const d = this.diff;
    const isSecond = ctx.serveNumber === 2;

    if (isSecond) {
      // Second serve: spin, safety, and a much bigger margin over the net.
      p.serveType = Math.random() < d.secondServeSafety ? 'kick' : 'slice';
    } else {
      const r = Math.random();
      p.serveType = r < 0.45 + d.aggression * 0.2 ? 'flat' : (r < 0.85 ? 'slice' : 'kick');
    }

    // Target inside the service box: T, body, or wide.
    const side = -p.side;
    const box = ctx.serveBox || 'deuce';
    const patterns = ['T', 'body', 'wide'];
    const weights = isSecond ? [0.3, 0.45, 0.25] : [0.42, 0.18, 0.4];
    const pattern = weightedPick(patterns, weights);

    // The deuce box sits on the receiver's right; the ad box on their left.
    const boxSign = box === 'deuce' ? 1 : -1;
    const dirSign = side > 0 ? boxSign : -boxSign;

    let tx;
    if (pattern === 'T') tx = dirSign * (0.25 + Math.random() * 0.5);
    else if (pattern === 'body') tx = dirSign * (1.5 + Math.random() * 0.7);
    else tx = dirSign * (2.6 + Math.random() * 1.1);

    // Safety margin: weaker servers aim further inside the box.
    const safety = isSecond ? 1.0 : (0.55 + (1 - d.lineTargeting) * 0.8);
    const depth = COURT.SERVICE_LINE - safety - Math.random() * 0.6;

    p.aim = { x: clamp(tx, -3.9, 3.9), y: side * depth };
    this.plannedTarget = p.aim;
  }

  _timingJitter() {
    return (Math.random() * 2 - 1) * this.diff.timingNoise;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function weightedPick(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** Build an avatar-shaped object for an AI so it renders and plays like any player. */
export function aiAvatar(difficulty, name, overrides = {}) {
  const palette = [
    { shirtColor: '#e8433a', shortsColor: '#1a1a1a' },
    { shirtColor: '#2f6fd0', shortsColor: '#ffffff' },
    { shirtColor: '#f5f5f5', shortsColor: '#1f4a8a' },
    { shirtColor: '#18c07a', shortsColor: '#101010' },
    { shirtColor: '#f0a020', shortsColor: '#2a2a2a' },
  ];
  const kit = palette[difficulty.rating % palette.length];
  return {
    id: `ai_${difficulty.id}`,
    name: name || difficulty.name,
    skinTone: Math.floor(Math.random() * 8),
    hairStyle: ['short', 'medium', 'buzz', 'ponytail', 'headband'][Math.floor(Math.random() * 5)],
    hairColor: ['#2a1f18', '#4a3524', '#8a6a3a', '#1a1a1a', '#c8a860'][Math.floor(Math.random() * 5)],
    build: 'athletic',
    height: 1.78 + Math.random() * 0.16,
    ...kit,
    shirtAccent: '#ffffff',
    shoeColor: '#ffffff',
    hasHat: Math.random() < 0.35 ? 'cap' : 'none',
    hatColor: kit.shirtColor,
    wristbands: Math.random() < 0.5,
    racketColor: '#101010',
    racketFrame: '#d0d0d0',
    handedness: Math.random() < 0.14 ? 'left' : 'right',
    backhand: Math.random() < 0.7 ? 'two' : 'one',
    playstyle: 'all-court',
    attributes: { ...difficulty.attributes },
    ...overrides,
  };
}
