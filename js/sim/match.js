/**
 * The match engine. This is the orchestrator: it owns the ball, the players, the
 * scoreboard, and the state machine that runs a point from the serve to the call.
 *
 * It emits events rather than touching audio or rendering directly, so the same
 * engine drives local play, AI play, and the authoritative host in an online match.
 *
 * POINT STATE MACHINE
 *   PRE_POINT  → players walk to position, umpire announces the score
 *   SERVE_READY→ server holds the ball, waiting for the toss
 *   SERVE_TOSS → ball is in the air, waiting for the strike
 *   SERVE_FLY  → serve struck, must land in the correct box
 *   RALLY      → ball live, normal rules apply
 *   POINT_OVER → call made, brief pause, stats recorded
 *   CHANGEOVER → ends swapped
 *   MATCH_OVER
 */

import { Ball, stepBall, judgeBounce, callMargin, predictBall } from './physics.js';
import { MatchScore } from './rules.js';
import { PlayerEntity, SwingState, servePosition, returnPosition, doublesNetPosition } from './player.js';
import { AIController, DIFFICULTIES, aiAvatar } from './ai.js';
import { SHOT_TYPES, SERVE_TYPES, solveShot, applyShotError, timingLabel } from './shots.js';
import { COURT, SIM, STAMINA, PHYSICS, BALL } from './constants.js';
import { getSurface } from '../data/surfaces.js';
import { getVenue } from '../data/venues.js';

export const MatchState = {
  PRE_POINT: 'pre_point',
  SERVE_READY: 'serve_ready',
  SERVE_TOSS: 'serve_toss',
  SERVE_FLY: 'serve_fly',
  RALLY: 'rally',
  POINT_OVER: 'point_over',
  CHANGEOVER: 'changeover',
  MATCH_OVER: 'match_over',
};

export class MatchEngine {
  /**
   * @param {object} cfg
   *   doubles      — bool
   *   bestOf       — 1 | 3 | 5
   *   venueId      — key from venues.js
   *   avatars      — array of avatar objects, length 2 or 4
   *   controllers  — array of 'human' | 'ai' | 'remote', parallel to avatars
   *   difficulty   — key from DIFFICULTIES, applied to all AI players
   *   noAd         — bool
   */
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.doubles = !!cfg.doubles;
    this.venue = getVenue(cfg.venueId || 'newyork');
    this.surface = getSurface(cfg.surfaceId || this.venue.surface);
    this.wind = { ...this.venue.wind };
    this._windPhase = 0;

    const count = this.doubles ? 4 : 2;
    this.controllers = cfg.controllers || (this.doubles
      ? ['human', 'ai', 'ai', 'ai']
      : ['human', 'ai']);

    const difficulty = DIFFICULTIES[cfg.difficulty] || DIFFICULTIES.club;
    this.difficulty = difficulty;

    // Teams: players 0,(2) are team 0 (near); players 1,(3) are team 1 (far).
    this.players = [];
    this.ai = [];
    for (let i = 0; i < count; i++) {
      const team = i % 2;
      const avatar = (cfg.avatars && cfg.avatars[i]) ||
        aiAvatar(difficulty, `Player ${i + 1}`);
      const p = new PlayerEntity(i, team, avatar, {
        isNear: team === 0,
        doubles: this.doubles,
        doublesSlot: Math.floor(i / 2),
      });
      this.players.push(p);
      this.ai.push(this.controllers[i] === 'ai' ? new AIController(p, difficulty) : null);
    }

    this.score = new MatchScore({
      bestOf: cfg.bestOf ?? 3,
      doubles: this.doubles,
      noAd: cfg.noAd,
      teamNames: [
        this.players[0].avatar.name || 'Team 1',
        this.players[1].avatar.name || 'Team 2',
      ],
    });

    this.ball = new Ball();
    this.state = MatchState.PRE_POINT;
    this.stateTimer = 0;
    this.serveNumber = 1;
    this.rallyShots = 0;
    this.topSpeedThisPoint = 0;
    this.lastCall = null;
    this.events = [];
    this.pointHistory = [];

    // Who is serving, as a player index (not a team index).
    this.serverIndex = 0;
    this.receiverIndex = 1;

    this._pointStartedAt = 0;
    this._matchTime = 0;
    this._lastTouchedBy = -1;
    this._ballWasReachable = false;

    this._setupPoint();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Advance the simulation one fixed step.
   * @param {number} dt      fixed timestep
   * @param {object} inputs  map of playerIndex → input
   *   input: { moveX, moveY, sprint, shotDown, shotUp, shotType, aimX, aimY,
   *            serveAction, splitStep }
   * @returns {object[]} events emitted this step
   */
  update(dt, inputs = {}) {
    this.events = [];
    this._matchTime += dt;
    this._updateWind(dt);

    this.stateTimer += dt;

    switch (this.state) {
      case MatchState.PRE_POINT:   this._updatePrePoint(dt, inputs); break;
      case MatchState.SERVE_READY: this._updateServeReady(dt, inputs); break;
      case MatchState.SERVE_TOSS:  this._updateServeToss(dt, inputs); break;
      case MatchState.SERVE_FLY:   this._updateLive(dt, inputs, true); break;
      case MatchState.RALLY:       this._updateLive(dt, inputs, false); break;
      case MatchState.POINT_OVER:  this._updatePointOver(dt, inputs); break;
      case MatchState.CHANGEOVER:  this._updateChangeover(dt, inputs); break;
      case MatchState.MATCH_OVER:  break;
    }

    return this.events;
  }

  emit(type, data = {}) {
    this.events.push({ type, ...data });
  }

  get servingTeam() { return this.score.servingTeam; }
  get isLive() {
    return this.state === MatchState.RALLY || this.state === MatchState.SERVE_FLY;
  }

  // ── Point setup ────────────────────────────────────────────────────────────

  _setupPoint() {
    const box = this.score.serveBox;
    const team = this.score.servingTeam;
    const side = this.score.endFor(team);

    // Pick the serving player. In doubles the partners alternate service games.
    this.serverIndex = this.doubles
      ? team + this.score.serverSlot[team] * 2
      : team;

    // The receiver is the opponent standing in the box being served to.
    const rTeam = 1 - team;
    if (this.doubles) {
      // Receivers hold their side for the whole set: slot 0 takes the deuce court.
      this.receiverIndex = rTeam + (box === 'deuce' ? 0 : 1) * 2;
    } else {
      this.receiverIndex = rTeam;
    }

    for (const p of this.players) {
      p.side = this.score.endFor(p.team);
      p.resetForPoint(0, p.side * (COURT.HALF_LENGTH + 0.5));
      p.isServer = false;
    }

    const server = this.players[this.serverIndex];
    const sPos = servePosition(server.side, box, this.doubles);
    server.resetForPoint(sPos.x, sPos.y);

    const receiver = this.players[this.receiverIndex];
    const rPos = returnPosition(receiver.side, box, this.doubles);
    receiver.resetForPoint(rPos.x, rPos.y);

    if (this.doubles) {
      // The server's partner takes the net; the receiver's partner sits at the
      // service line, ready to move in or retreat.
      const serverPartner = this.players[this._partnerOf(this.serverIndex)];
      const np = doublesNetPosition(serverPartner.side, box);
      serverPartner.resetForPoint(np.x, np.y);

      const recvPartner = this.players[this._partnerOf(this.receiverIndex)];
      recvPartner.resetForPoint(
        box === 'deuce' ? recvPartner.side * 2.2 : recvPartner.side * -2.2,
        recvPartner.side * (COURT.SERVICE_LINE + 0.4)
      );
    }

    this.ball.reset();
    this.ball.inPlay = false;
    this.rallyShots = 0;
    this.topSpeedThisPoint = 0;
    this._lastTouchedBy = -1;
    this._ballWasReachable = false;
    this.lastCall = null;

    for (const c of this.ai) if (c) { c.wantsNet = false; c.serveTimer = 0; c.hasReacted = false; }

    this.emit('pointSetup', {
      server: this.serverIndex,
      receiver: this.receiverIndex,
      box,
      serveNumber: this.serveNumber,
    });
  }

  _partnerOf(index) {
    // Team 0 is players 0 and 2; team 1 is players 1 and 3.
    return index < 2 ? index + 2 : index - 2;
  }

  _updatePrePoint(dt, inputs) {
    // Players recover a little between points, then the server takes the ball.
    for (const p of this.players) p.recoverBetweenPoints(dt);

    if (this.stateTimer > 0.9) {
      this.players[this.serverIndex].beginServe('flat');
      this._transition(MatchState.SERVE_READY);
      this.emit('serveReady', {
        server: this.serverIndex,
        serveNumber: this.serveNumber,
        score: this.score.spokenScore,
      });
    }
  }

  // ── Serve ──────────────────────────────────────────────────────────────────

  _updateServeReady(dt, inputs) {
    const server = this.players[this.serverIndex];
    this._runControllers(dt, inputs, { allowMove: true });

    // Hold the ball at the server's hand until the toss.
    const cp = server.contactPoint();
    this.ball.setPosition(cp.x, cp.y, 1.1);
    this.ball.setVelocity(0, 0, 0);
    this.ball.inPlay = false;

    const input = inputs[this.serverIndex];
    const wantsToss = (input && input.serveAction) || this._tossRequested === this.serverIndex;
    this._tossRequested = -1;

    if (wantsToss) {
      const h = server.tossBall();
      if (h !== null) {
        // Launch the toss to reach the requested apex: v = sqrt(2·g·h).
        const vz = Math.sqrt(2 * PHYSICS.GRAVITY * (h - 1.1));
        this.ball.setPosition(cp.x + Math.sin(server.facing) * 0.35, cp.y, 1.1);
        this.ball.setVelocity(0, server.side * -0.15, vz);
        this.ball.setSpin(0, 0);
        this.ball.inPlay = true;
        this.ball.bounces = 0;
        this._transition(MatchState.SERVE_TOSS);
        this.emit('serveToss', { player: this.serverIndex });
      }
    }
  }

  _updateServeToss(dt, inputs) {
    const server = this.players[this.serverIndex];
    this._runControllers(dt, inputs, { allowMove: false });

    // The toss flies under gravity only — no drag worth modelling at 3 m/s.
    this.ball.vz -= PHYSICS.GRAVITY * dt;
    this.ball.x += this.ball.vx * dt;
    this.ball.y += this.ball.vy * dt;
    this.ball.z += this.ball.vz * dt;

    const input = inputs[this.serverIndex];
    const wantsHit = (input && input.serveAction) || this._serveHitRequested === this.serverIndex;
    this._serveHitRequested = -1;

    if (wantsHit) {
      const res = server.hitServe(this.ball.z, this.ball.vz);
      if (res) {
        this._executeServe(server, res);
        return;
      }
    }

    // Dropped toss: the ball hits the ground. Players are allowed to let a toss go,
    // so this simply restarts the service motion rather than costing a fault.
    if (this.ball.z <= BALL.RADIUS) {
      server.swing = SwingState.SERVE_READY;
      server.animState = 'idle';
      this.ball.inPlay = false;
      this._transition(MatchState.SERVE_READY);
      this.emit('tossDropped', { player: this.serverIndex });
    }
  }

  _executeServe(server, contact) {
    const box = this.score.serveBox;
    const side = server.side;
    const serveDef = SERVE_TYPES[server.serveType] || SERVE_TYPES.flat;

    // Where is the serve aimed?
    let aim = server.aim && server.aim.y !== 0 ? server.aim : null;
    if (!aim) {
      // Human default: middle of the correct service box, adjusted by held direction.
      const boxSign = box === 'deuce' ? 1 : -1;
      const dirSign = -side > 0 ? boxSign : -boxSign;
      const input = this._lastInputs?.[this.serverIndex];
      const lateral = input ? (input.aimX || 0) : 0;
      aim = {
        x: dirSign * (1.6 + lateral * 2.0),
        y: -side * (COURT.SERVICE_LINE - 1.0),
      };
    }

    const from = {
      x: this.ball.x,
      y: this.ball.y,
      z: Math.max(contact.contactHeight, this.ball.z),
    };

    // Second serves are deliberately safer: more spin, more net clearance, less pace.
    const isSecond = this.serveNumber === 2;
    const power = (isSecond ? 0.55 : 0.85) * (0.8 + server.attrs.serve / 10 * 0.4);

    const shotDef = {
      ...serveDef,
      baseSpeed: serveDef.speed * (isSecond ? 0.82 : 1),
      maxSpeed: serveDef.maxSpeed * (isSecond ? 0.85 : 1),
      netClearance: serveDef.netClearance + (isSecond ? 0.25 : 0),
    };

    const solved = solveShot(from, aim, shotDef, power, this.surface, this.wind, this.doubles);

    if (!solved) {
      // Could not find a trajectory — treat as a fault rather than stalling.
      this._serveFault(server, 'long');
      return;
    }

    const errored = applyShotError(solved, contact.quality, {
      accuracy: server.attrs.accuracy,
      fatigue: server.fatigue,
      difficulty: 0,
      errorScale: serveDef.errorScale * (isSecond ? 0.6 : 1),
    });

    this.ball.setPosition(from.x, from.y, from.z);
    this.ball.setVelocity(errored.vx, errored.vy, errored.vz);
    this.ball.setSpin(errored.spinTop, errored.spinSide);
    this.ball.inPlay = true;
    this.ball.bounces = 0;
    this.ball.crossedNet = false;
    this.ball.touchedNet = false;
    this.ball.lastHitBy = server.index;
    this.ball.lastHitTeam = server.team;
    this.ball.hitCount = 1;
    this.ball.maxHeightSinceHit = from.z;

    this._lastTouchedBy = server.index;
    this.rallyShots = 1;
    this.topSpeedThisPoint = Math.max(this.topSpeedThisPoint, this.ball.speed);

    this._transition(MatchState.SERVE_FLY);

    this.emit('serveHit', {
      player: server.index,
      speed: this.ball.speed,
      quality: contact.quality,
      isMishit: errored.isMishit,
      serveType: server.serveType,
      serveNumber: this.serveNumber,
      power,
    });

    // Everyone else split-steps as the serve is struck.
    for (const c of this.ai) {
      if (c && c.player.index !== server.index) c.splitStepDone = false;
    }
  }

  _serveFault(server, region) {
    this.ball.inPlay = false;
    server.endServe();

    if (this.serveNumber === 1) {
      this.serveNumber = 2;
      this.emit('fault', { player: server.index, region });
      this._transition(MatchState.PRE_POINT);
      this.stateTimer = 0.3;   // shorter pause between first and second serve
    } else {
      this.emit('doubleFault', { player: server.index, region });
      this._endPoint(1 - server.team, {
        doubleFault: true,
        reason: 'doubleFault',
        serve: 'second',
      });
    }
  }

  // ── Live ball ──────────────────────────────────────────────────────────────

  _updateLive(dt, inputs, isServe) {
    this._runControllers(dt, inputs, { allowMove: true });

    const serveBox = isServe
      ? { side: -this.players[this.serverIndex].side, box: this.score.serveBox }
      : null;

    const evs = stepBall(this.ball, dt, this.surface, this.wind, {
      doubles: this.doubles,
      serveBox,
    });

    if (this.ball.speed > this.topSpeedThisPoint) {
      this.topSpeedThisPoint = this.ball.speed;
    }

    // Resolve swings that reached contact this step.
    this._resolveContacts(dt, inputs, isServe);

    for (const e of evs) {
      if (this.state === MatchState.POINT_OVER) break;

      switch (e.type) {
        case 'net':
          this.emit('ballNet', { speed: e.speed, x: e.x, z: e.z });
          if (isServe) {
            this._serveFault(this.players[this.serverIndex], 'net');
          } else {
            this._endPoint(1 - this.ball.lastHitTeam, {
              reason: 'net',
              unforcedError: true,
              forcedBy: this._ballWasReachable,
            });
          }
          break;

        case 'netcord':
          this.emit('netCord', { speed: e.speed, x: e.x, z: e.z });
          break;

        case 'post':
          this.emit('ballPost', { speed: e.speed });
          this._endPoint(1 - this.ball.lastHitTeam, { reason: 'post', unforcedError: true });
          break;

        case 'crossnet':
          this.emit('crossNet', { aroundPost: !!e.aroundPost });
          break;

        case 'bounce':
          this._handleBounce(e, isServe);
          break;
      }
    }
  }

  _handleBounce(e, isServe) {
    const margin = callMargin(e.x, e.y, this.doubles);
    this.emit('bounce', {
      x: e.x, y: e.y, speed: e.speed,
      inBounds: e.inBounds, onLine: e.onLine,
      close: margin > 0.55,
      surface: this.surface.id,
      index: e.bounceIndex,
    });

    if (isServe) {
      if (e.bounceIndex > 1) return;    // second bounce handled by the rally branch

      if (!this.ball.crossedNet) {
        this._serveFault(this.players[this.serverIndex], 'net');
        return;
      }
      if (e.inBounds) {
        if (this.ball.touchedNet) {
          // Clipped the tape and still landed in: a let, replayed.
          this.emit('let', { serveNumber: this.serveNumber });
          this.players[this.serverIndex].endServe();
          this.ball.inPlay = false;
          this._transition(MatchState.PRE_POINT);
          return;
        }
        // Good serve. From here it is an ordinary rally.
        this.lastCall = { call: 'in', x: e.x, y: e.y, margin };
        this._transition(MatchState.RALLY);
        this.emit('serveIn', { onLine: e.onLine, close: margin > 0.55 });
        return;
      }
      // Out of the box.
      this.lastCall = { call: 'out', x: e.x, y: e.y, margin, region: e.region };
      this.emit('lineCall', { call: 'fault', x: e.x, y: e.y, close: margin > 0.55 });
      this._serveFault(this.players[this.serverIndex], e.region);
      return;
    }

    // ── Rally bounce ─────────────────────────────────────────────────────────
    const hitter = this.ball.lastHitTeam;

    // A second bounce ALWAYS ends the point, and it must be tested before the
    // in/out check. A ball that lands in and then bounces again past the baseline
    // is still a won point — checking "out" first would let it fall through and
    // leave the ball rolling around a live court forever.
    if (e.bounceIndex >= 2) {
      this.emit('doubleBounce', { x: e.x, y: e.y });
      this._endPoint(hitter, {
        reason: 'winner',
        winner: !this._ballWasReachable,
        forcedError: this._ballWasReachable,
      });
      return;
    }

    if (!e.inBounds) {
      this.lastCall = { call: 'out', x: e.x, y: e.y, margin, region: e.region };
      this.emit('lineCall', { call: 'out', x: e.x, y: e.y, close: margin > 0.55, region: e.region });
      this._endPoint(1 - hitter, {
        reason: e.region === 'long' ? 'long' : 'wide',
        unforcedError: !this._ballWasHard,
        forcedError: this._ballWasHard,
      });
      return;
    }

    // Landed in on the first bounce.
    {
      this.lastCall = { call: 'in', x: e.x, y: e.y, margin };
      if (e.onLine || margin > 0.6) {
        this.emit('lineCall', { call: 'in', x: e.x, y: e.y, close: true });
      }
      // Which side did it land on? Whoever defends that side must now play it.
      this._ballWasReachable = this._isReachable(e.x, e.y);
    }
  }

  /** Was anybody actually close enough that the shot was gettable? Drives winner vs. error. */
  _isReachable(x, y) {
    const side = Math.sign(y) || 1;
    for (const p of this.players) {
      if (p.side !== side) continue;
      if (Math.hypot(p.x - x, p.y - y) < 3.0) return true;
    }
    return false;
  }

  // ── Contact resolution ─────────────────────────────────────────────────────

  _resolveContacts(dt, inputs, isServe) {
    for (const p of this.players) {
      const result = p.updateSwing(dt);
      if (result !== 'contact') continue;

      // You cannot hit the ball twice in a row, or hit it on the opponent's side.
      if (this.ball.lastHitBy === p.index && this.ball.hitCount > 0 && !this.ball.crossedNet) {
        this.emit('whiff', { player: p.index });
        continue;
      }
      if (Math.sign(this.ball.y) !== p.side && Math.abs(this.ball.y) > 0.5) {
        this.emit('whiff', { player: p.index, reason: 'wrongSide' });
        continue;
      }
      if (this.ball.bounces >= 2) {
        this.emit('whiff', { player: p.index, reason: 'tooLate' });
        continue;
      }

      const contact = p.evaluateContact(this.ball);
      if (!contact) {
        this.emit('whiff', { player: p.index });
        continue;
      }

      this._strike(p, contact, inputs[p.index]);
    }
  }

  _strike(p, contact, input) {
    // A ball played before it bounces is a volley; the shot type adapts.
    const isVolley = this.ball.bounces === 0;
    let shotId = p.pendingShot || 'topspin';

    // Overheads and volleys override the chosen stroke, as they must in real tennis.
    if (contact.overhead && isVolley && this.ball.z > 1.9) {
      shotId = 'smash';
    } else if (isVolley && Math.abs(p.y) < COURT.SERVICE_LINE + 1.0 && shotId !== 'lob' && shotId !== 'drop') {
      shotId = 'volley';
    }

    const shot = SHOT_TYPES[shotId] || SHOT_TYPES.topspin;
    p.swingType = shotId;

    // ── Where is it aimed? ───────────────────────────────────────────────────
    const oppSide = -p.side;
    let aim;

    if (p.isAI || (this.ai[p.index] && !input)) {
      aim = p.aim;
    } else {
      // Human aiming: the direction held at contact places the ball. Lateral input
      // moves it cross-court or down the line; vertical input controls depth.
      const halfWidth = this.doubles ? COURT.DOUBLES_HALF_WIDTH : COURT.SINGLES_HALF_WIDTH;
      const aimX = input ? (input.aimX ?? input.moveX ?? 0) : 0;
      const aimY = input ? (input.aimY ?? input.moveY ?? 0) : 0;

      const lateral = aimX * (halfWidth - 0.5);
      let depthFrac = 0.72 + aimY * 0.26;
      if (shotId === 'drop') depthFrac = 0.16;
      if (shotId === 'lob') depthFrac = 0.94;
      depthFrac = Math.max(0.12, Math.min(0.98, depthFrac));

      aim = { x: lateral, y: oppSide * COURT.HALF_LENGTH * depthFrac };
    }

    if (!aim || (aim.x === 0 && aim.y === 0)) {
      aim = { x: 0, y: oppSide * COURT.HALF_LENGTH * 0.72 };
    }

    const from = {
      x: this.ball.x,
      y: this.ball.y,
      z: Math.max(0.25, this.ball.z),
    };

    const power = p.shotPower();
    const solved = solveShot(from, aim, shot, power, this.surface, this.wind, this.doubles);

    if (!solved) {
      this.emit('whiff', { player: p.index });
      return;
    }

    const errored = applyShotError(solved, contact.quality, {
      accuracy: p.attrs.accuracy,
      fatigue: p.fatigue,
      difficulty: contact.difficulty,
      errorScale: shot.errorScale,
    });

    this.ball.setPosition(from.x, from.y, from.z);
    this.ball.setVelocity(errored.vx, errored.vy, errored.vz);
    this.ball.setSpin(errored.spinTop, errored.spinSide);
    this.ball.bounces = 0;
    this.ball.crossedNet = false;
    this.ball.touchedNet = false;
    this.ball.lastHitBy = p.index;
    this.ball.lastHitTeam = p.team;
    this.ball.hitCount++;
    this.ball.maxHeightSinceHit = from.z;
    this.ball.inPlay = true;

    this._lastTouchedBy = p.index;
    this._ballWasHard = contact.difficulty > 0.5;
    this.rallyShots++;

    p.stamina -= shot.staminaCost * (1 + power * 0.5);
    p.lastContactQuality = contact.quality;

    const speed = this.ball.speed;
    if (speed > this.topSpeedThisPoint) this.topSpeedThisPoint = speed;

    this.emit('hit', {
      player: p.index,
      shot: shotId,
      speed,
      power,
      quality: contact.quality,
      label: timingLabel(contact.quality),
      isMishit: errored.isMishit,
      spin: errored.spinTop,
      height: from.z,
      x: from.x, y: from.y, z: from.z,
      difficulty: contact.difficulty,
    });

    // Opponents split-step off this contact.
    for (const c of this.ai) {
      if (c && c.player.team !== p.team) c.splitStepDone = false;
    }
  }

  // ── Controllers ────────────────────────────────────────────────────────────

  _runControllers(dt, inputs, opts) {
    this._lastInputs = inputs;

    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const ctrl = this.controllers[i];
      let input;

      if (ctrl === 'ai' && this.ai[i]) {
        input = this.ai[i].update(dt, {
          ball: this.ball,
          surface: this.surface,
          wind: this.wind,
          doubles: this.doubles,
          opponents: this.players.filter((o) => o.team !== p.team),
          partner: this.doubles ? this.players[this._partnerOf(i)] : null,
          serveBox: this.score.serveBox,
          serveNumber: this.serveNumber,
          rally: this.rallyShots,
          requestToss: (idx) => { this._tossRequested = idx; },
          requestServeHit: (idx) => { this._serveHitRequested = idx; },
        });
      } else {
        input = inputs[i] || { moveX: 0, moveY: 0, sprint: false };

        // Human swing buttons.
        if (input.shotDown && p.canHit && p.swing === SwingState.IDLE) {
          p.startSwing(input.shotType || 'topspin');
        }
        if (input.shotUp && p.swing === SwingState.WINDUP) {
          p.releaseSwing();
        }
        if (input.splitStep) {
          const pred = this.ball.inPlay
            ? predictBall(this.ball, this.surface, this.wind, { doubles: this.doubles }, 2, p.contactHeight)
            : null;
          p.splitStep(pred ? pred.t : 1);
        }
      }

      if (opts.allowMove) {
        p.move(input, dt, this.surface);
      } else {
        p.move({ moveX: 0, moveY: 0 }, dt, this.surface);
      }
    }
  }

  // ── Point / game flow ──────────────────────────────────────────────────────

  _endPoint(winningTeam, meta = {}) {
    if (this.state === MatchState.POINT_OVER || this.state === MatchState.MATCH_OVER) return;

    // An ace is a serve the receiver never touched. Testing the state does not work
    // here: a serve that lands in has already moved the engine into RALLY by the time
    // the point ends, so the shot count is the reliable signal.
    const isAce = meta.reason === 'winner' && this.rallyShots === 1 && this.serveNumber >= 1;

    const fullMeta = {
      ...meta,
      ace: isAce,
      rallyLength: this.rallyShots,
      topSpeed: this.topSpeedThisPoint,
      serve: this.serveNumber === 1 ? 'first' : 'second',
    };

    const scoreEvents = this.score.awardPoint(winningTeam, fullMeta);

    this.pointHistory.push({
      winner: winningTeam,
      rally: this.rallyShots,
      reason: meta.reason,
      duration: this._matchTime - this._pointStartedAt,
    });
    this._pointStartedAt = this._matchTime;

    this.emit('pointEnd', {
      team: winningTeam,
      reason: meta.reason,
      rallyLength: this.rallyShots,
      topSpeed: this.topSpeedThisPoint,
      ace: isAce,
      winner: !!meta.winner,
      unforcedError: !!meta.unforcedError,
      scoreText: this.score.gameScoreText,
      spoken: this.score.spokenScore,
    });

    for (const ev of scoreEvents) this.emit('score', ev);

    // Reset the serve count for the next point.
    this.serveNumber = 1;
    for (const p of this.players) p.endServe();

    this._pendingScoreEvents = scoreEvents;
    this._transition(MatchState.POINT_OVER);
  }

  _updatePointOver(dt, inputs) {
    // Let the ball roll to a stop and the crowd react.
    if (this.ball.inPlay) {
      stepBall(this.ball, dt, this.surface, this.wind, { doubles: this.doubles });
      if (this.ball.speed < 0.4) this.ball.inPlay = false;
    }
    for (const p of this.players) {
      p.move({ moveX: 0, moveY: 0 }, dt, this.surface);
      p.recoverBetweenPoints(dt * 0.5);
    }

    const events = this._pendingScoreEvents || [];
    const matchOver = events.some((e) => e.type === 'matchWon');
    const changeEnds = events.some((e) => e.type === 'changeEnds' && !e.instant);

    const wait = matchOver ? 2.5 : (events.some((e) => e.type === 'gameWon') ? 2.2 : 1.5);

    if (this.stateTimer > wait) {
      this._pendingScoreEvents = null;

      if (matchOver) {
        this._transition(MatchState.MATCH_OVER);
        this.emit('matchOver', {
          winner: this.score.winner,
          score: this.score.setScoreText,
        });
        return;
      }
      if (changeEnds) {
        this._transition(MatchState.CHANGEOVER);
        this.emit('changeover', {});
        return;
      }
      this._setupPoint();
      this._transition(MatchState.PRE_POINT);
    }
  }

  _updateChangeover(dt, inputs) {
    for (const p of this.players) p.recoverBetweenPoints(dt);
    // A short breather, not a full 90 seconds — nobody wants to wait for that.
    if (this.stateTimer > 3.0) {
      this._setupPoint();
      this._transition(MatchState.PRE_POINT);
    }
  }

  _transition(state) {
    this.state = state;
    this.stateTimer = 0;
  }

  /** Skip a changeover or the gap between points. */
  skipWait() {
    if (this.state === MatchState.CHANGEOVER) this.stateTimer = 99;
    if (this.state === MatchState.POINT_OVER) this.stateTimer = 99;
  }

  // ── Wind ───────────────────────────────────────────────────────────────────

  _updateWind(dt) {
    const base = this.venue.wind;
    if (!base || base.speed <= 0) return;
    this._windPhase += dt;
    // Slow, wandering gusts. Ashe swirls; an indoor arena does nothing at all.
    const gust = this.venue.windGust || 0;
    const s = Math.sin(this._windPhase * 0.31) * 0.6 + Math.sin(this._windPhase * 0.73) * 0.4;
    this.wind.speed = Math.max(0, base.speed + s * gust);
    this.wind.direction = base.direction + Math.sin(this._windPhase * 0.17) * 0.4;
  }

  // ── Netcode support ────────────────────────────────────────────────────────

  /** Authoritative snapshot for guests. */
  snapshot() {
    return {
      t: Math.round(this._matchTime * 1000),
      st: this.state,
      sn: this.serveNumber,
      si: this.serverIndex,
      ri: this.receiverIndex,
      b: {
        x: r3(this.ball.x), y: r3(this.ball.y), z: r3(this.ball.z),
        vx: r2(this.ball.vx), vy: r2(this.ball.vy), vz: r2(this.ball.vz),
        wx: r1(this.ball.wx), wy: r1(this.ball.wy), wz: r1(this.ball.wz),
        ip: this.ball.inPlay, bn: this.ball.bounces, lh: this.ball.lastHitBy,
      },
      p: this.players.map((p) => p.serialise()),
      s: this.score.serialise(),
      w: { s: r2(this.wind.speed), d: r2(this.wind.direction) },
    };
  }

  applySnapshot(snap) {
    this.state = snap.st;
    this.serveNumber = snap.sn;
    this.serverIndex = snap.si;
    this.receiverIndex = snap.ri;

    const b = snap.b;
    this.ball.x = b.x; this.ball.y = b.y; this.ball.z = b.z;
    this.ball.vx = b.vx; this.ball.vy = b.vy; this.ball.vz = b.vz;
    this.ball.wx = b.wx; this.ball.wy = b.wy; this.ball.wz = b.wz;
    this.ball.inPlay = b.ip; this.ball.bounces = b.bn; this.ball.lastHitBy = b.lh;

    for (const pd of snap.p) {
      const p = this.players[pd.i];
      if (p) p.applySnapshot(pd);
    }
    this.score.applySnapshot(snap.s);
    this.wind.speed = snap.w.s;
    this.wind.direction = snap.w.d;
  }
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
