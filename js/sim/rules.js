/**
 * Tennis scoring. Pure logic, no rendering, no side effects — you feed it points and
 * it tells you what happened.
 *
 * Implements the real thing: 15/30/40, deuce and advantage, games to six by two,
 * a seven-point tiebreak at 6–6, and the ten-point match tiebreak that all four
 * majors now use in the deciding set. Also handles the serve rotation and the
 * change-of-ends schedule, both of which are easy to get subtly wrong.
 */

import { RULES } from './constants.js';

export class MatchScore {
  /**
   * @param {object} cfg
   *   bestOf        — 3 or 5
   *   doubles       — bool
   *   finalSetTiebreak — 'ten' | 'seven' | 'advantage'
   *   noAd          — sudden-death deuce (used by the shorter practice formats)
   *   teamNames     — ['Home', 'Away']
   */
  constructor(cfg = {}) {
    this.bestOf = cfg.bestOf === 5 ? 5 : (cfg.bestOf === 1 ? 1 : 3);
    this.doubles = !!cfg.doubles;
    this.finalSetTiebreak = cfg.finalSetTiebreak || 'ten';
    this.noAd = !!cfg.noAd;
    this.setsToWin = Math.ceil(this.bestOf / 2);
    this.teamNames = cfg.teamNames || ['Player 1', 'Player 2'];

    // points[team] is an index into RULES.POINT_NAMES, or the raw count in a tiebreak.
    this.points = [0, 0];
    this.games = [0, 0];
    this.sets = [0, 0];
    this.setHistory = [];        // [[gamesA, gamesB, tiebreakScore|null], ...]

    this.advantage = -1;         // team index holding advantage, or -1
    this.inTiebreak = false;
    this.tiebreakTarget = RULES.TIEBREAK_TO;

    // Serving. servingTeam is 0 or 1; in doubles serverIndex picks which partner.
    this.servingTeam = 0;
    this.serverSlot = [0, 0];    // which partner serves next for each team
    this.receiverSlot = [0, 0];  // which partner receives in the deuce court

    this.pointsInGame = 0;
    this.gamesPlayed = 0;
    this.tiebreakPointCount = 0;
    this.endsSwapped = false;    // true when teams have changed ends

    this.finished = false;
    this.winner = -1;

    // Running statistics, per team.
    this.stats = [makeStats(), makeStats()];
  }

  /** Which side of the court the server serves from: 'deuce' (right) or 'ad' (left). */
  get serveBox() {
    const n = this.inTiebreak ? this.tiebreakPointCount : this.pointsInGame;
    return n % 2 === 0 ? 'deuce' : 'ad';
  }

  /** Is this a deciding set (i.e. one set away from the match for both teams)? */
  get isFinalSet() {
    return this.sets[0] === this.setsToWin - 1 && this.sets[1] === this.setsToWin - 1;
  }

  /** Human-readable current game score, e.g. "40–30", "Deuce", "Ad Player 1". */
  get gameScoreText() {
    if (this.inTiebreak) return `${this.points[0]}–${this.points[1]}`;
    if (this.advantage >= 0) return `Ad ${this.teamNames[this.advantage]}`;
    if (this.points[0] >= 3 && this.points[1] >= 3) {
      return this.points[0] === this.points[1] ? 'Deuce' : 'Deuce';
    }
    return `${RULES.POINT_NAMES[this.points[0]]}–${RULES.POINT_NAMES[this.points[1]]}`;
  }

  /**
   * Spoken form for the umpire, server's score first, as it is actually called.
   * e.g. "Thirty, fifteen" / "Deuce" / "Advantage Player 1" / "Game, Player 2".
   */
  get spokenScore() {
    if (this.inTiebreak) {
      const s = this.points[this.servingTeam];
      const r = this.points[1 - this.servingTeam];
      return `${s}, ${r}`;
    }
    if (this.advantage >= 0) return `Advantage ${this.teamNames[this.advantage]}`;
    if (this.points[0] >= 3 && this.points[1] >= 3 && this.points[0] === this.points[1]) {
      return 'Deuce';
    }
    const WORDS = ['Love', 'Fifteen', 'Thirty', 'Forty'];
    const s = this.points[this.servingTeam];
    const r = this.points[1 - this.servingTeam];
    if (s === r) return `${WORDS[s]} all`;
    return `${WORDS[s]}, ${WORDS[r]}`;
  }

  /** Full set score line, e.g. "6–4, 3–6, 7–6(5)". */
  get setScoreText() {
    const parts = this.setHistory.map(([a, b, tb]) =>
      tb !== null && tb !== undefined ? `${a}–${b}(${tb})` : `${a}–${b}`
    );
    if (!this.finished) parts.push(`${this.games[0]}–${this.games[1]}`);
    return parts.join(', ');
  }

  /**
   * Award a point.
   * @param {number} team  0 or 1
   * @param {object} meta  { ace, doubleFault, winner, unforcedError, forcedError, rallyLength, serve }
   * @returns {object[]}   events: pointWon, gameWon, setWon, matchWon, changeEnds,
   *                       tiebreakStart, deuce, advantage, serverChanged
   */
  awardPoint(team, meta = {}) {
    if (this.finished) return [];
    const events = [];
    const other = 1 - team;

    this._recordStats(team, meta);
    events.push({ type: 'pointWon', team, meta });

    if (this.inTiebreak) {
      this.points[team]++;
      this.tiebreakPointCount++;

      // Serve rotation in a tiebreak: one point, then alternating pairs.
      // Points 1 | 2,3 | 4,5 | 6,7 ... so the server changes on every odd total.
      if (this.tiebreakPointCount % 2 === 1) {
        this.servingTeam = 1 - this.servingTeam;
        this._rotateDoublesServer(this.servingTeam);
        events.push({ type: 'serverChanged', team: this.servingTeam });
      }
      // Ends change every six points.
      if (this.tiebreakPointCount % 6 === 0) {
        this.endsSwapped = !this.endsSwapped;
        events.push({ type: 'changeEnds', instant: true });
      }

      const a = this.points[team], b = this.points[other];
      if (a >= this.tiebreakTarget && a - b >= 2) {
        events.push(...this._winGame(team, b));
      }
      return events;
    }

    // ── Standard game scoring ────────────────────────────────────────────────
    this.pointsInGame++;

    if (this.advantage === team) {
      events.push(...this._winGame(team));
      return events;
    }
    if (this.advantage === other) {
      // Back to deuce.
      this.advantage = -1;
      events.push({ type: 'deuce' });
      return events;
    }

    if (this.points[team] < 3) {
      this.points[team]++;
      return events;
    }

    // Server or receiver is at 40.
    if (this.points[other] < 3) {
      events.push(...this._winGame(team));
      return events;
    }

    // 40–40.
    if (this.noAd) {
      events.push(...this._winGame(team));
      return events;
    }
    this.advantage = team;
    events.push({ type: 'advantage', team });
    return events;
  }

  _winGame(team, tiebreakLoserScore = null) {
    const events = [{ type: 'gameWon', team, wasTiebreak: this.inTiebreak }];
    this.games[team]++;
    this.gamesPlayed++;
    this.stats[team].gamesWon++;

    // A break of serve is the single most important event in a set.
    if (!this.inTiebreak && this.servingTeam !== team) {
      this.stats[team].breaks++;
      events.push({ type: 'breakOfServe', team });
    }

    this.points = [0, 0];
    this.advantage = -1;
    this.pointsInGame = 0;

    const wasTiebreak = this.inTiebreak;
    this.inTiebreak = false;
    this.tiebreakPointCount = 0;

    // Set complete?
    const a = this.games[team], b = this.games[1 - team];
    const needed = RULES.GAMES_PER_SET;
    const setOver = wasTiebreak || (a >= needed && a - b >= 2);

    if (setOver) {
      this.sets[team]++;
      this.setHistory.push([this.games[0], this.games[1], wasTiebreak ? tiebreakLoserScore : null]);
      events.push({ type: 'setWon', team, score: [this.games[0], this.games[1]] });
      this.games = [0, 0];
      this.gamesPlayed = 0;

      if (this.sets[team] >= this.setsToWin) {
        this.finished = true;
        this.winner = team;
        events.push({ type: 'matchWon', team });
        return events;
      }
      // Ends always change after a set with an odd number of games.
      this.endsSwapped = !this.endsSwapped;
      events.push({ type: 'changeEnds' });
    } else if (a === needed && b === needed) {
      // 6–6: start the tiebreak.
      this.inTiebreak = true;
      this.tiebreakTarget = (this.isFinalSet && this.finalSetTiebreak === 'ten')
        ? RULES.FINAL_SET_TIEBREAK_TO
        : RULES.TIEBREAK_TO;
      events.push({ type: 'tiebreakStart', target: this.tiebreakTarget });
    }

    // Serve passes to the other team for the next game.
    this.servingTeam = 1 - this.servingTeam;
    this._rotateDoublesServer(this.servingTeam);
    events.push({ type: 'serverChanged', team: this.servingTeam });

    // Change ends after every odd-numbered game of a set.
    if (!setOver && this.gamesPlayed % 2 === 1) {
      this.endsSwapped = !this.endsSwapped;
      events.push({ type: 'changeEnds' });
    }

    return events;
  }

  /** In doubles the two partners alternate service games throughout the set. */
  _rotateDoublesServer(team) {
    if (!this.doubles) return;
    this.serverSlot[team] = 1 - this.serverSlot[team];
  }

  _recordStats(team, meta) {
    const s = this.stats[team];
    const o = this.stats[1 - team];
    s.pointsWon++;

    if (meta.serve) {
      const srv = this.stats[this.servingTeam];
      if (meta.serve === 'first') {
        srv.firstServesIn++;
        if (this.servingTeam === team) srv.firstServePointsWon++;
      } else if (meta.serve === 'second') {
        if (this.servingTeam === team) srv.secondServePointsWon++;
      }
      srv.serveAttempts++;
    }
    if (meta.ace) this.stats[this.servingTeam].aces++;
    if (meta.doubleFault) this.stats[this.servingTeam].doubleFaults++;
    if (meta.winner) s.winners++;
    if (meta.unforcedError) o.unforcedErrors++;
    if (meta.rallyLength != null) {
      s.totalRallyShots += meta.rallyLength;
      s.rallies++;
      if (meta.rallyLength > s.longestRally) s.longestRally = meta.rallyLength;
    }
    if (meta.topSpeed != null && meta.topSpeed > s.fastestShot) s.fastestShot = meta.topSpeed;
  }

  /**
   * Which end of the court a team is on right now. Returns -1 (near, negative y) or
   * +1 (far, positive y). Teams swap on change of ends, so this is the only thing
   * the rest of the game should ask about court sides.
   */
  endFor(team) {
    const base = team === 0 ? -1 : 1;
    return this.endsSwapped ? -base : base;
  }

  /** Is a team serving for the match right now? Drives crowd tension and AI nerves. */
  servingForMatch() {
    if (this.finished || this.inTiebreak) return -1;
    const t = this.servingTeam;
    if (this.sets[t] !== this.setsToWin - 1) return -1;
    const a = this.games[t], b = this.games[1 - t];
    if (a >= RULES.GAMES_PER_SET - 1 && a - b >= 1) return t;
    return -1;
  }

  /** Does the returning team have a break point? Returns team index or -1. */
  breakPoint() {
    if (this.inTiebreak || this.finished) return -1;
    const r = 1 - this.servingTeam;
    if (this.advantage === r) return r;
    if (this.points[r] === 3 && this.points[this.servingTeam] < 3) return r;
    return -1;
  }

  /** Set point / match point detection, for the HUD and crowd reaction. */
  criticalPoint() {
    if (this.finished) return null;
    for (const t of [0, 1]) {
      const o = 1 - t;
      let isPoint = false;

      if (this.inTiebreak) {
        isPoint = this.points[t] >= this.tiebreakTarget - 1 &&
                  this.points[t] - this.points[o] >= 1;
      } else if (this.advantage === t) {
        isPoint = this.games[t] >= RULES.GAMES_PER_SET - 1 &&
                  this.games[t] - this.games[o] >= 1;
      } else if (this.points[t] === 3 && this.points[o] < 3) {
        isPoint = this.games[t] >= RULES.GAMES_PER_SET - 1 &&
                  this.games[t] - this.games[o] >= 1;
      }

      if (isPoint) {
        const forMatch = this.sets[t] === this.setsToWin - 1;
        return { team: t, kind: forMatch ? 'match' : 'set' };
      }
    }
    return null;
  }

  /** Compact snapshot for the netcode. */
  serialise() {
    return {
      p: this.points, g: this.games, s: this.sets,
      adv: this.advantage, tb: this.inTiebreak, tbt: this.tiebreakTarget,
      st: this.servingTeam, ss: this.serverSlot, pig: this.pointsInGame,
      tpc: this.tiebreakPointCount, gp: this.gamesPlayed, es: this.endsSwapped,
      fin: this.finished, w: this.winner, hist: this.setHistory,
    };
  }

  applySnapshot(d) {
    this.points = d.p; this.games = d.g; this.sets = d.s;
    this.advantage = d.adv; this.inTiebreak = d.tb; this.tiebreakTarget = d.tbt;
    this.servingTeam = d.st; this.serverSlot = d.ss; this.pointsInGame = d.pig;
    this.tiebreakPointCount = d.tpc; this.gamesPlayed = d.gp; this.endsSwapped = d.es;
    this.finished = d.fin; this.winner = d.w; this.setHistory = d.hist;
  }
}

function makeStats() {
  return {
    pointsWon: 0, gamesWon: 0, breaks: 0,
    aces: 0, doubleFaults: 0,
    serveAttempts: 0, firstServesIn: 0,
    firstServePointsWon: 0, secondServePointsWon: 0,
    winners: 0, unforcedErrors: 0,
    rallies: 0, totalRallyShots: 0, longestRally: 0,
    fastestShot: 0,
  };
}

/** Derived percentages for the end-of-match summary. */
export function summariseStats(s) {
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  return {
    aces: s.aces,
    doubleFaults: s.doubleFaults,
    firstServePct: pct(s.firstServesIn, s.serveAttempts),
    firstServeWonPct: pct(s.firstServePointsWon, s.firstServesIn),
    winners: s.winners,
    unforcedErrors: s.unforcedErrors,
    breaks: s.breaks,
    avgRally: s.rallies > 0 ? (s.totalRallyShots / s.rallies).toFixed(1) : '0.0',
    longestRally: s.longestRally,
    fastestShot: Math.round(s.fastestShot * 3.6),
    pointsWon: s.pointsWon,
  };
}
