/**
 * Practice: the "test and learn" mode.
 *
 * Built on the real MatchEngine rather than a simplified sandbox, so a ball fed in a
 * drill behaves exactly like a ball in a match — same physics, same timing windows,
 * same error model. A skill learned here transfers directly, which is the entire
 * point of a practice mode.
 *
 * Structure:
 *   ACADEMY  — an ordered curriculum. Each lesson teaches one mechanic, and later
 *              lessons unlock as you clear the earlier ones.
 *   DRILLS   — repeatable challenges scored out of three stars, for grinding a
 *              specific weakness.
 */

import { MatchEngine, MatchState } from '../sim/match.js';
import { COURT, SPEEDS, SPIN } from '../sim/constants.js';
import { Ball, stepBall } from '../sim/physics.js';

const PROGRESS_KEY = 'tennis.progress.v1';

/**
 * Feed patterns for the ball machine. Each returns a launch spec from the far
 * baseline toward the player's side.
 */
export const FEEDS = {
  deepCentre:   { name: 'Deep centre',     targets: [[0, -8.5]], speed: 26, spin: SPIN.TOPSPIN, height: 1.2 },
  deepForehand: { name: 'Deep forehand',   targets: [[2.8, -8.2]], speed: 26, spin: SPIN.TOPSPIN, height: 1.2 },
  deepBackhand: { name: 'Deep backhand',   targets: [[-2.8, -8.2]], speed: 26, spin: SPIN.TOPSPIN, height: 1.2 },
  alternating:  { name: 'Side to side',    targets: [[3.0, -8.0], [-3.0, -8.0]], speed: 27, spin: SPIN.TOPSPIN, height: 1.2, sequential: true },
  random:       { name: 'Random depth',    targets: [[2.5, -7], [-2.5, -9], [0, -6], [3.5, -9.5], [-3.5, -6.5]], speed: 27, spin: SPIN.TOPSPIN, height: 1.3 },
  short:        { name: 'Short ball',      targets: [[1.5, -4.5], [-1.5, -4.5]], speed: 20, spin: SPIN.TOPSPIN, height: 1.1 },
  volleyFeed:   { name: 'At the net',      targets: [[1.8, -3.0], [-1.8, -3.0]], speed: 22, spin: SPIN.FLAT, height: 1.0 },
  lobFeed:      { name: 'Lobbed',          targets: [[0, -9.5], [1.8, -9.5], [-1.8, -9.5]], speed: 17, spin: SPIN.TOPSPIN * 0.7, height: 5.5, lob: true },
  lowSlice:     { name: 'Low and skidding',targets: [[2.2, -7.5], [-2.2, -7.5]], speed: 23, spin: SPIN.SLICE, height: 0.7 },
  heavy:        { name: 'Heavy topspin',   targets: [[2.0, -8.8], [-2.0, -8.8]], speed: 30, spin: SPIN.HEAVY_TOPSPIN, height: 1.7 },
  fastFlat:     { name: 'Flat and fast',   targets: [[2.5, -8.5], [-2.5, -8.5]], speed: 36, spin: SPIN.FLAT, height: 1.0 },
};

/** Reusable target-zone layouts, in world coordinates on the far side of the net. */
export const ZONES = {
  deepCorners: [
    { x: 3.1, y: 9.6, w: 2.0, h: 3.2 },
    { x: -3.1, y: 9.6, w: 2.0, h: 3.2 },
  ],
  deepCentre: [{ x: 0, y: 9.8, w: 3.4, h: 3.0 }],
  crossCourt: [{ x: 3.2, y: 8.2, w: 2.4, h: 5.0 }],
  downTheLine: [{ x: -3.4, y: 8.8, w: 1.8, h: 4.4 }],
  shortAngles: [
    { x: 4.0, y: 3.2, w: 2.2, h: 3.0 },
    { x: -4.0, y: 3.2, w: 2.2, h: 3.0 },
  ],
  dropZone: [{ x: 0, y: 2.4, w: 6.0, h: 2.8 }],
  serveT: [
    { x: 0.7, y: 4.9, w: 1.4, h: 2.4 },
    { x: -0.7, y: 4.9, w: 1.4, h: 2.4 },
  ],
  serveWide: [
    { x: 3.3, y: 4.9, w: 1.6, h: 2.4 },
    { x: -3.3, y: 4.9, w: 1.6, h: 2.4 },
  ],
  serveBody: [
    { x: 1.9, y: 5.2, w: 1.4, h: 2.0 },
    { x: -1.9, y: 5.2, w: 1.4, h: 2.0 },
  ],
};

/**
 * The academy curriculum. Ordered; each lesson unlocks the next.
 * `check` receives the running drill stats and returns progress toward the goal.
 */
export const ACADEMY = [
  {
    id: 'a1_movement', level: 1, category: 'Fundamentals',
    name: 'Footwork and Positioning',
    teaches: 'Moving to the ball and recovering to the middle.',
    tip: 'Move with WASD. Notice that you recover toward the centre after every shot — a player caught out wide has already lost the next one.',
    feed: 'alternating', feedInterval: 3.4, feedCount: 12,
    objective: { type: 'contacts', goal: 8, stars: [8, 10, 12] },
    assists: { landingMarker: true, aimGuide: true },
  },
  {
    id: 'a2_groundstrokes', level: 1, category: 'Fundamentals',
    name: 'The Topspin Groundstroke',
    teaches: 'Charging and releasing a swing with clean timing.',
    tip: 'HOLD J to load the shot, RELEASE to swing. The racket takes a moment to reach the ball, so release slightly early. Watch the timing readout.',
    feed: 'deepCentre', feedInterval: 3.6, feedCount: 15,
    objective: { type: 'inCourt', goal: 8, stars: [8, 11, 14] },
    assists: { landingMarker: true, aimGuide: true, timingHints: true },
  },
  {
    id: 'a3_timing', level: 1, category: 'Fundamentals',
    name: 'Timing the Strike',
    teaches: 'Finding the perfect contact window.',
    tip: 'A PERFECT strike gives full pace and placement. A MISHIT sprays and sounds dead. Aim for PERFECT, not for power.',
    feed: 'deepCentre', feedInterval: 3.4, feedCount: 16,
    objective: { type: 'perfectHits', goal: 5, stars: [5, 8, 11] },
    assists: { landingMarker: true, timingHints: true },
  },
  {
    id: 'a4_placement', level: 2, category: 'Fundamentals',
    name: 'Directing the Ball',
    teaches: 'Aiming with the movement keys at contact.',
    tip: 'Hold a direction as you release the swing and the ball goes there. Hold up for depth, down to bring it shorter.',
    feed: 'deepCentre', feedInterval: 3.6, feedCount: 14,
    zones: ZONES.deepCorners,
    objective: { type: 'targets', goal: 5, stars: [5, 8, 11] },
    assists: { landingMarker: true, aimGuide: true },
  },
  {
    id: 'a5_spin', level: 2, category: 'Shot-making',
    name: 'Spin: Topspin and Slice',
    teaches: 'How spin changes flight and bounce.',
    tip: 'Topspin (J) dips into the court so you can swing harder. Slice (L) stays low and skids. Watch how differently they bounce.',
    feed: 'alternating', feedInterval: 3.5, feedCount: 16,
    objective: { type: 'spinVariety', goal: 6, stars: [6, 9, 12] },
    assists: { landingMarker: true },
  },
  {
    id: 'a6_serve', level: 2, category: 'Serving',
    name: 'The Serve',
    teaches: 'Toss, timing and placement.',
    tip: 'SPACE tosses, SPACE again strikes. Hit near the top of the toss. Hold a direction to place it wide or down the T.',
    mode: 'serve', feedCount: 14,
    zones: ZONES.serveT,
    objective: { type: 'servesIn', goal: 7, stars: [7, 10, 13] },
    assists: { landingMarker: true, aimGuide: true },
  },
  {
    id: 'a7_secondserve', level: 3, category: 'Serving',
    name: 'The Second Serve',
    teaches: 'Kick serves and playing the percentages.',
    tip: 'A kick serve clears the net by a mile and still drops in. Double faults are the most expensive mistake in tennis — take the spin.',
    mode: 'serve', serveType: 'kick', feedCount: 12,
    zones: ZONES.serveBody,
    objective: { type: 'servesIn', goal: 9, stars: [9, 11, 12] },
    assists: { landingMarker: true },
  },
  {
    id: 'a8_volley', level: 3, category: 'Net play',
    name: 'Volleys',
    teaches: 'Punching the ball out of the air at the net.',
    tip: 'Volleys are short and firm, not swung. Take the ball early, do not charge the shot. Get your body behind it.',
    feed: 'volleyFeed', feedInterval: 2.6, feedCount: 16,
    playerStart: { x: 0, y: -3.2 },
    objective: { type: 'inCourt', goal: 9, stars: [9, 12, 15] },
    assists: { landingMarker: true },
  },
  {
    id: 'a9_smash', level: 3, category: 'Net play',
    name: 'The Overhead Smash',
    teaches: 'Putting away a lob.',
    tip: 'Get under it and let it drop into your strike zone. The smash is the most violent shot in tennis and the easiest to shank.',
    feed: 'lobFeed', feedInterval: 4.0, feedCount: 12,
    playerStart: { x: 0, y: -4.0 },
    objective: { type: 'winners', goal: 5, stars: [5, 8, 10] },
    assists: { landingMarker: true },
  },
  {
    id: 'a10_defense', level: 4, category: 'Defence',
    name: 'Defending and Retrieving',
    teaches: 'Staying in the point when you are stretched.',
    tip: 'When you are pulled wide, do not go for a winner. Slice it deep, buy time, and get back to the middle.',
    feed: 'random', feedInterval: 2.4, feedCount: 18,
    objective: { type: 'consecutive', goal: 6, stars: [6, 9, 12] },
    assists: { landingMarker: true },
  },
  {
    id: 'a11_dropshot', level: 4, category: 'Shot-making',
    name: 'Drop Shots and Lobs',
    teaches: 'Changing the length of the court.',
    tip: 'A drop shot (U) against a deep opponent, a lob (I) against one at the net. Both are about disguise and touch, not power.',
    feed: 'deepCentre', feedInterval: 3.8, feedCount: 14,
    zones: ZONES.dropZone,
    objective: { type: 'targets', goal: 5, stars: [5, 7, 10] },
    assists: { landingMarker: true, aimGuide: true },
  },
  {
    id: 'a12_return', level: 4, category: 'Returning',
    name: 'Return of Serve',
    teaches: 'Reacting to a big serve.',
    tip: 'Split-step as the server strikes. Do not try to crush it — block it back deep and start the point.',
    mode: 'return', feedCount: 14,
    objective: { type: 'inCourt', goal: 7, stars: [7, 10, 12] },
    assists: { landingMarker: true },
  },
  {
    id: 'a13_pressure', level: 5, category: 'Match play',
    name: 'Point Construction',
    teaches: 'Building a point instead of swinging at everything.',
    tip: 'Hit cross-court until you get a short ball, then change direction. The down-the-line shot is the highest-risk shot in tennis — earn it.',
    feed: 'heavy', feedInterval: 2.6, feedCount: 20,
    zones: ZONES.crossCourt,
    objective: { type: 'targets', goal: 8, stars: [8, 12, 16] },
    assists: {},
  },
  {
    id: 'a14_pace', level: 5, category: 'Match play',
    name: 'Handling Pace',
    teaches: 'Absorbing and redirecting a heavy ball.',
    tip: 'Against real pace, shorten the swing. You do not need to generate power when it is already there.',
    feed: 'fastFlat', feedInterval: 2.2, feedCount: 20,
    objective: { type: 'inCourt', goal: 12, stars: [12, 15, 18] },
    assists: {},
  },
];

/** Free-play drills, unlocked from the start, for grinding one thing repeatedly. */
export const DRILLS = [
  { id: 'd_rally', name: 'Endless Rally', category: 'Consistency',
    description: 'Keep the ball in play as long as you can. No targets, no pressure, just contact.',
    feed: 'alternating', feedInterval: 3.0, feedCount: 999, endless: true,
    objective: { type: 'consecutive', goal: 999, stars: [10, 20, 35] } },

  { id: 'd_corners', name: 'Corner Hunter', category: 'Precision',
    description: 'Hit the deep corners. Twenty balls.',
    feed: 'deepCentre', feedInterval: 3.2, feedCount: 20, zones: ZONES.deepCorners,
    objective: { type: 'targets', goal: 20, stars: [6, 11, 15] } },

  { id: 'd_serve_t', name: 'Down the T', category: 'Serving',
    description: 'Fifteen serves. Find the T.',
    mode: 'serve', feedCount: 15, zones: ZONES.serveT,
    objective: { type: 'targets', goal: 15, stars: [4, 8, 11] } },

  { id: 'd_serve_wide', name: 'Out Wide', category: 'Serving',
    description: 'Fifteen serves. Drag them off the court.',
    mode: 'serve', feedCount: 15, zones: ZONES.serveWide,
    objective: { type: 'targets', goal: 15, stars: [4, 8, 11] } },

  { id: 'd_volley', name: 'Volley Wall', category: 'Net play',
    description: 'Rapid-fire volleys. Twenty balls, short intervals.',
    feed: 'volleyFeed', feedInterval: 2.0, feedCount: 20,
    playerStart: { x: 0, y: -3.0 },
    objective: { type: 'inCourt', goal: 20, stars: [10, 15, 18] } },

  { id: 'd_defense', name: 'Suicide Sprints', category: 'Defence',
    description: 'Wide, fast, relentless. How much court can you cover?',
    feed: 'random', feedInterval: 1.9, feedCount: 24,
    objective: { type: 'contacts', goal: 24, stars: [12, 18, 22] } },

  { id: 'd_angles', name: 'Short Angles', category: 'Precision',
    description: 'Open the court with sharp cross-court angles.',
    feed: 'short', feedInterval: 3.2, feedCount: 18, zones: ZONES.shortAngles,
    objective: { type: 'targets', goal: 18, stars: [5, 9, 13] } },

  { id: 'd_smash', name: 'Overhead Drill', category: 'Net play',
    description: 'Lob after lob. Put them away.',
    feed: 'lobFeed', feedInterval: 3.4, feedCount: 16,
    playerStart: { x: 0, y: -4.5 },
    objective: { type: 'winners', goal: 16, stars: [5, 9, 13] } },
];

// ── Progress ─────────────────────────────────────────────────────────────────

export function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { academy: {}, drills: {}, unlocked: [ACADEMY[0].id] };
    const p = JSON.parse(raw);
    return {
      academy: p.academy || {},
      drills: p.drills || {},
      unlocked: p.unlocked || [ACADEMY[0].id],
    };
  } catch (_) {
    return { academy: {}, drills: {}, unlocked: [ACADEMY[0].id] };
  }
}

export function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (_) { /* storage full or blocked */ }
}

export function recordResult(lessonId, stars, score) {
  const p = loadProgress();
  const isAcademy = ACADEMY.some((a) => a.id === lessonId);
  const bucket = isAcademy ? p.academy : p.drills;

  const prev = bucket[lessonId];
  if (!prev || stars > prev.stars || (stars === prev.stars && score > prev.score)) {
    bucket[lessonId] = { stars, score, at: Date.now() };
  }

  // Clearing an academy lesson unlocks the next one.
  if (isAcademy && stars > 0) {
    const idx = ACADEMY.findIndex((a) => a.id === lessonId);
    const next = ACADEMY[idx + 1];
    if (next && !p.unlocked.includes(next.id)) p.unlocked.push(next.id);
  }

  saveProgress(p);
  return p;
}

export function isUnlocked(lessonId, progress) {
  const p = progress || loadProgress();
  if (DRILLS.some((d) => d.id === lessonId)) return true;
  return p.unlocked.includes(lessonId);
}

export function totalStars(progress) {
  const p = progress || loadProgress();
  let n = 0;
  for (const v of Object.values(p.academy)) n += v.stars || 0;
  for (const v of Object.values(p.drills)) n += v.stars || 0;
  return n;
}

// ── The practice engine ──────────────────────────────────────────────────────

/**
 * A MatchEngine subclass that replaces the serve-and-score loop with a ball machine
 * and a drill objective. Everything below the point level — physics, contact, error,
 * animation — is inherited unchanged.
 */
export class PracticeEngine extends MatchEngine {
  constructor(lesson, avatar, cfg = {}) {
    super({
      doubles: false,
      bestOf: 1,
      venueId: cfg.venueId || 'practice',
      surfaceId: cfg.surfaceId,
      avatars: [avatar, avatar],
      controllers: ['human', 'ai'],
      difficulty: 'club',
      ...cfg,
    });

    this.lesson = lesson;
    this.isPractice = true;
    this.zones = (lesson.zones || []).map((z) => ({ ...z, hit: false, hitCount: 0 }));

    this.feedsRemaining = lesson.feedCount ?? 15;
    this.feedTimer = 0;
    this.feedIndex = 0;
    this.awaitingFeed = true;

    this.stats = {
      contacts: 0, inCourt: 0, outCourt: 0, netted: 0,
      perfect: 0, good: 0, mishits: 0, winners: 0,
      targetsHit: 0, consecutive: 0, bestConsecutive: 0,
      servesIn: 0, servesAttempted: 0, doubleFaults: 0,
      spinTypes: new Set(), fed: 0,
    };

    this.finished = false;
    this.result = null;

    // The opponent is scenery in most drills — park them out of the way.
    this.players[1].x = 0;
    this.players[1].y = COURT.HALF_LENGTH + 3;

    if (lesson.playerStart) {
      this.players[0].resetForPoint(lesson.playerStart.x, lesson.playerStart.y);
    }

    this.mode = lesson.mode || 'feed';
    if (this.mode === 'serve') {
      this._beginServeDrill();
    } else {
      this.state = MatchState.RALLY;
      this._ballDead = true;
    }
  }

  // ── Drill loop ───────────────────────────────────────────────────────────

  update(dt, inputs = {}) {
    if (this.finished) return [];

    if (this.mode === 'serve' || this.mode === 'return') {
      return this._updateServeDrill(dt, inputs);
    }
    return this._updateFeedDrill(dt, inputs);
  }

  _updateFeedDrill(dt, inputs) {
    this.events = [];
    this._matchTime += dt;

    // Feed timing.
    if (this._ballDead) {
      this.feedTimer -= dt;
      if (this.feedTimer <= 0) {
        if (this.feedsRemaining <= 0) { this._finish(); return this.events; }
        this._feedBall();
      }
    }

    // Run the human controller and ball physics through the inherited machinery.
    this._runControllers(dt, inputs, { allowMove: true });

    const evs = this.ball.inPlay
      ? stepBall(this.ball, dt, this.surface, this.wind, { doubles: false })
      : [];

    this._resolveContacts(dt, inputs, false);

    for (const e of evs) {
      if (e.type === 'bounce') this._onDrillBounce(e);
      else if (e.type === 'net') {
        this.stats.netted++;
        this.stats.consecutive = 0;
        this.emit('ballNet', { speed: e.speed, x: e.x, z: e.z });
        this._killBall(1.0);
      } else if (e.type === 'netcord') {
        this.emit('netCord', { speed: e.speed, x: e.x, z: e.z });
      }
      this.events.push(e.type === 'bounce' ? { type: 'bounce', ...e } : { type: e.type, ...e });
    }

    return this.events;
  }

  _onDrillBounce(e) {
    // Only judge balls the player has struck; the incoming feed's bounce is ignored.
    if (this.ball.lastHitBy !== 0) return;

    if (e.bounceIndex > 1) { this._killBall(0.6); return; }

    if (e.inBounds) {
      this.stats.inCourt++;
      this.stats.consecutive++;
      this.stats.bestConsecutive = Math.max(this.stats.bestConsecutive, this.stats.consecutive);
      this.emit('lineCall', { call: 'in', x: e.x, y: e.y, close: e.onLine });

      // Target zones.
      for (const z of this.zones) {
        if (Math.abs(e.x - z.x) <= z.w / 2 && Math.abs(e.y - z.y) <= z.h / 2) {
          z.hit = true;
          z.hitCount++;
          this.stats.targetsHit++;
          this.emit('targetHit', { x: e.x, y: e.y, zone: z });
          break;
        }
      }
    } else {
      this.stats.outCourt++;
      this.stats.consecutive = 0;
      this.emit('lineCall', { call: 'out', x: e.x, y: e.y, region: e.region });
    }
    this._killBall(0.8);
  }

  _killBall(delay) {
    this._ballDead = true;
    this.feedTimer = delay ?? 1.0;
    // Let the ball roll out naturally rather than vanishing.
    setTimeout(() => { this.ball.inPlay = false; }, 700);
  }

  /** Launch a ball from the far baseline toward the configured target. */
  _feedBall() {
    const feed = FEEDS[this.lesson.feed] || FEEDS.deepCentre;
    const targets = feed.targets;
    const t = feed.sequential
      ? targets[this.feedIndex % targets.length]
      : targets[Math.floor(Math.random() * targets.length)];

    this.feedIndex++;
    this.feedsRemaining--;
    this.stats.fed++;
    this._ballDead = false;

    const from = { x: (Math.random() * 2 - 1) * 1.5, y: COURT.HALF_LENGTH - 0.5, z: 1.1 };
    const target = { x: t[0], y: t[1] };

    // Aim the feed with a simple ballistic solve: pick an apex, derive the arc.
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dist = Math.hypot(dx, dy);
    const apex = feed.lob ? feed.height : Math.max(feed.height, 1.6);

    // Time of flight for a projectile rising to `apex` then falling to the target.
    const g = 9.81;
    const tUp = Math.sqrt(2 * Math.max(0.2, apex - from.z) / g);
    const tDown = Math.sqrt(2 * Math.max(0.2, apex) / g);
    const tTotal = tUp + tDown;

    const vz = g * tUp;
    // Drag steals a little carry, so overshoot the horizontal speed slightly.
    const vh = (dist / tTotal) * 1.12;

    this.ball.reset();
    this.ball.setPosition(from.x, from.y, from.z);
    this.ball.setVelocity((dx / dist) * vh, (dy / dist) * vh, vz);
    this.ball.setSpin(feed.spin, 0);
    this.ball.inPlay = true;
    this.ball.lastHitBy = 1;
    this.ball.lastHitTeam = 1;
    this.ball.hitCount++;
    this.ball.bounces = 0;
    this.ball.crossedNet = true;

    for (const z of this.zones) z.hit = false;

    this.emit('feed', { remaining: this.feedsRemaining, target });
    this.emit('hit', {
      player: 1, shot: 'topspin', speed: Math.hypot(vh, vz),
      power: 0.6, quality: 0.9, label: 'GOOD', isMishit: false,
      spin: feed.spin, height: from.z, x: from.x, y: from.y, z: from.z, difficulty: 0,
    });
  }

  // ── Serve drill ──────────────────────────────────────────────────────────

  _beginServeDrill() {
    this._serveBox = 'deuce';
    this.state = MatchState.PRE_POINT;
    this.stateTimer = 0;
    this.serveNumber = 1;
    this.serverIndex = 0;
    this.score.servingTeam = 0;
    this.score.pointsInGame = 0;
  }

  _updateServeDrill(dt, inputs) {
    // Reuse the inherited serve state machine wholesale; only scoring is replaced.
    const events = super.update(dt, inputs);

    for (const e of events) {
      if (e.type === 'serveHit') {
        this.stats.servesAttempted++;
      } else if (e.type === 'serveIn') {
        this.stats.servesIn++;
        this.feedsRemaining--;
      } else if (e.type === 'bounce' && this.ball.lastHitBy === 0) {
        for (const z of this.zones) {
          if (Math.abs(e.x - z.x) <= z.w / 2 && Math.abs(e.y - z.y) <= z.h / 2) {
            z.hit = true; z.hitCount++;
            this.stats.targetsHit++;
            this.emit('targetHit', { x: e.x, y: e.y, zone: z });
            break;
          }
        }
      } else if (e.type === 'doubleFault') {
        this.stats.doubleFaults++;
        this.feedsRemaining--;
      } else if (e.type === 'fault') {
        // First-serve fault just moves to the second serve.
      }
    }

    if (this.feedsRemaining <= 0) this._finish();
    return events;
  }

  /** Practice never awards points; a completed rally just resets the feed. */
  _endPoint(winningTeam, meta = {}) {
    this.serveNumber = 1;
    for (const p of this.players) p.endServe();
    this._transition(MatchState.PRE_POINT);
    for (const z of this.zones) z.hit = false;
  }

  // ── Scoring the drill ────────────────────────────────────────────────────

  /** Track shot quality as the player strikes. Called from the inherited _strike. */
  _strike(p, contact, input) {
    if (p.index === 0) {
      this.stats.contacts++;
      if (contact.quality >= 0.88) this.stats.perfect++;
      else if (contact.quality >= 0.6) this.stats.good++;
      else if (contact.quality < 0.34) this.stats.mishits++;
      this.stats.spinTypes.add(p.pendingShot);
    }
    return super._strike(p, contact, input);
  }

  get score_() {
    const o = this.lesson.objective;
    const s = this.stats;
    switch (o.type) {
      case 'contacts':    return s.contacts;
      case 'inCourt':     return s.inCourt;
      case 'targets':     return s.targetsHit;
      case 'perfectHits': return s.perfect;
      case 'consecutive': return s.bestConsecutive;
      case 'winners':     return s.inCourt;
      case 'servesIn':    return s.servesIn;
      case 'spinVariety': return s.inCourt + s.spinTypes.size * 2;
      default:            return s.inCourt;
    }
  }

  starsEarned() {
    const [s1, s2, s3] = this.lesson.objective.stars;
    const v = this.score_;
    if (v >= s3) return 3;
    if (v >= s2) return 2;
    if (v >= s1) return 1;
    return 0;
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    const stars = this.starsEarned();
    const score = this.score_;
    this.result = {
      lessonId: this.lesson.id,
      stars, score,
      goal: this.lesson.objective.stars,
      stats: { ...this.stats, spinTypes: this.stats.spinTypes.size },
      passed: stars > 0,
    };
    recordResult(this.lesson.id, stars, score);
    this.emit('drillComplete', this.result);
  }

  /** End early, keeping whatever was achieved. */
  quit() {
    if (!this.finished) this._finish();
    return this.result;
  }
}
