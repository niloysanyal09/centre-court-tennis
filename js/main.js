/**
 * Application controller.
 *
 * Owns the loop, the canvas, and the transitions between menu, match, practice and
 * online play. Everything else is a module it wires together:
 *
 *   MatchEngine  simulates            → emits events
 *   this         translates events    → audio, effects, HUD
 *   Renderer     draws the world      ← camera, effects, HUD
 *   NetworkManager moves state        ↔ remote peers
 */

import { GameLoop } from './core/loop.js';
import { InputManager } from './core/input.js';
import { loadSettings, saveSettings } from './core/state.js';
import { Camera } from './render/camera.js';
import { Renderer } from './render/renderer.js';
import { MatchEngine, MatchState } from './sim/match.js';
import { PracticeEngine, ACADEMY } from './ui/practice.js';
import { AudioEngine } from './audio/audio.js';
import { NetworkManager, NetRole, NetState } from './net/p2p.js';
import { Menu } from './ui/menu.js';
import { getAvatar, createAvatar, randomAvatar, listAvatars, saveAvatar } from './ui/avatar.js';
import { aiAvatar, DIFFICULTIES } from './sim/ai.js';
import { predictBall, solveIntercept } from './sim/physics.js';
import { SIM, COURT } from './sim/constants.js';
import { getSurface } from './data/surfaces.js';

const Mode = { MENU: 'menu', MATCH: 'match', PRACTICE: 'practice', PAUSED: 'paused' };

class Game {
  constructor() {
    this.canvas = document.getElementById('court');
    this.overlay = document.getElementById('overlay');
    this.settings = loadSettings();

    this.camera = new Camera();
    this.renderer = new Renderer(this.canvas, this.camera);
    this.input = new InputManager();
    this.audio = new AudioEngine();
    this.net = new NetworkManager();

    this.match = null;
    this.mode = Mode.MENU;
    this.localPlayers = [0];
    this.lessonInProgress = null;

    this._snapTimer = 0;
    this._footAccum = [];
    this._prediction = null;
    this._predictionTimer = 0;
    this._slideHandles = {};

    this.menu = new Menu(this.overlay, this._menuHooks());
    this.loop = new GameLoop(
      (dt) => this.fixedUpdate(dt),
      (dt, alpha) => this.render(dt, alpha)
    );

    this._bind();
    this._resize();
    this.camera.setPreset(this.settings.cameraPreset);
    this.menu.show('title');
    this.loop.start();
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  _bind() {
    this.input.attach(window);
    window.addEventListener('resize', () => this._resize());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        if (this.mode === Mode.MATCH || this.mode === Mode.PRACTICE) this.pause();
        else if (this.mode === Mode.PAUSED) this.resume();
      }
      // Skip the pause between points or a changeover.
      if (e.code === 'Enter' && this.match && this.mode === Mode.MATCH) {
        this.match.skipWait?.();
      }
    });

    // Pausing on tab-away is basic courtesy, and it stops the loop eating battery.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (this.mode === Mode.MATCH || this.mode === Mode.PRACTICE)) {
        // An online match cannot pause — the other players are still playing.
        if (this.net.role === NetRole.NONE) this.pause();
      }
    });

    this.net.on('state', ({ state, error }) => this._onNetState(state, error));
    this.net.on('lobby', (lobby) => {
      this.menu.updateLobby(lobby, this.net.role === NetRole.HOST, this.net.matchConfig);
    });
    this.net.on('start', (cfg) => this._beginOnlineMatch(cfg));
    this.net.on('events', (events) => this._handleEvents(events, true));
    this.net.on('disconnected', () => {
      this._toast('Disconnected from the host');
      this.exitMatch();
    });
    this.net.on('warning', (msg) => this._toast(msg));
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.resize(w, h);
  }

  async _initAudio() {
    if (this.audio.ready) return;
    await this.audio.init();
    this._applyAudioSettings();
  }

  _applyAudioSettings() {
    const s = this.settings;
    this.audio.setVolumes({
      master: s.masterVolume, sfx: s.sfxVolume,
      crowd: s.crowdVolume, voice: s.voiceVolume,
    });
    this.audio.setMuted(s.muted);
  }

  // ── Menu hooks ─────────────────────────────────────────────────────────────

  _menuHooks() {
    return {
      onFirstGesture: () => this._initAudio(),

      onStartMatch: (cfg) => this.startLocalMatch(cfg),

      onStartLesson: (lesson) => this.startLesson(lesson),

      onHost: async (cfg, onError) => {
        try {
          await this._initAudio();
          const code = await this.net.host(cfg, this._profile());
          this.menu.show('lobby', {
            code, isHost: true, lobby: this.net.lobby, config: cfg,
          });
        } catch (e) {
          onError?.(this.net.error || e.message);
        }
      },

      onJoin: async (code, onError) => {
        try {
          await this._initAudio();
          await this.net.join(code, this._profile());
          this.menu.show('lobby', {
            code, isHost: false, lobby: this.net.lobby, config: this.net.matchConfig,
          });
        } catch (e) {
          onError?.(this.net.error || e.message);
        }
      },

      onReady: (ready) => this.net.setReady(ready),
      onStartOnline: () => this._hostStartOnline(),
      onLeaveRoom: () => { this.net.close(); this.menu.show('online'); },

      onResume: () => this.resume(),
      onQuitMatch: () => this.exitMatch(),
      onExitMatch: () => this.exitMatch(),
      onRematch: () => this._rematch(),

      onSettingsChanged: (patch) => {
        this.settings = loadSettings();
        this._applyAudioSettings();
        if (patch.cameraPreset) this.camera.setPreset(patch.cameraPreset);
        this._applyAssists();
      },
    };
  }

  _profile() {
    const s = loadSettings();
    const avatar = s.activeAvatarId ? getAvatar(s.activeAvatarId) : null;
    return {
      name: avatar?.name || s.playerName || 'Player',
      avatar: avatar || createAvatar({ name: s.playerName || 'Player' }),
    };
  }

  _applyAssists() {
    const s = this.settings;
    this.renderer.showLandingMarker = s.landingMarker;
    this.renderer.showAimGuide = s.aimGuide;
    this.renderer.showTrail = s.ballTrail;
    this.renderer.hud.units = s.units;
  }

  // ── Starting matches ───────────────────────────────────────────────────────

  startLocalMatch(cfg) {
    this._initAudio();

    const playerAvatar = cfg.avatarId
      ? getAvatar(cfg.avatarId)
      : (listAvatars()[0] || createAvatar({ name: this.settings.playerName || 'Player' }));

    const difficulty = DIFFICULTIES[cfg.difficulty] || DIFFICULTIES.club;
    const count = cfg.doubles ? 4 : 2;

    const avatars = [];
    const controllers = [];
    for (let i = 0; i < count; i++) {
      if (i === 0) {
        avatars.push(playerAvatar);
        controllers.push('human');
      } else {
        avatars.push(aiAvatar(difficulty, AI_NAMES[(i - 1) % AI_NAMES.length]));
        controllers.push('ai');
      }
    }

    this.match = new MatchEngine({
      doubles: cfg.doubles,
      bestOf: cfg.bestOf,
      venueId: cfg.venueId,
      difficulty: cfg.difficulty,
      avatars,
      controllers,
    });

    this.localPlayers = [0];
    this.input.localSlots = [0, -1];
    this._lastMatchConfig = cfg;
    this._enterMatch(Mode.MATCH);
  }

  startLesson(lesson) {
    this._initAudio();
    const s = loadSettings();
    const avatar = s.activeAvatarId
      ? getAvatar(s.activeAvatarId)
      : (listAvatars()[0] || createAvatar({ name: s.playerName || 'Player' }));

    this.match = new PracticeEngine(lesson, avatar, {});
    this.lessonInProgress = lesson;
    this.localPlayers = [0];
    this.input.localSlots = [0, -1];

    // Lessons can force assists on so the mechanic being taught is visible.
    const a = lesson.assists || {};
    this.renderer.showLandingMarker = a.landingMarker ?? this.settings.landingMarker;
    this.renderer.showAimGuide = a.aimGuide ?? this.settings.aimGuide;
    this.renderer.targetZones = this.match.zones.length ? this.match.zones : null;

    this._enterMatch(Mode.PRACTICE);
    if (lesson.tip) {
      this.renderer.hud.announce(lesson.name, { sub: lesson.tip, life: 4.5, big: false });
    }
  }

  _hostStartOnline() {
    const cfg = { ...this.net.matchConfig };
    const lobby = this.net.lobby;
    const count = cfg.doubles ? 4 : 2;

    const avatars = [];
    const controllers = [];
    for (let i = 0; i < count; i++) {
      const entry = lobby.find((l) => l.slot === i);
      if (entry) {
        avatars.push(entry.avatar || aiAvatar(DIFFICULTIES.club, entry.name));
        controllers.push(i === 0 ? 'human' : 'remote');
      } else {
        // Any unfilled slot is played by the AI so the match can still run.
        avatars.push(aiAvatar(DIFFICULTIES.tour, AI_NAMES[i]));
        controllers.push('ai');
      }
    }

    cfg.avatars = avatars;
    cfg.controllers = controllers;

    this.match = new MatchEngine(cfg);
    this.localPlayers = [0];
    this.input.localSlots = [0, -1];
    this.net.startMatch(cfg);
    this._enterMatch(Mode.MATCH);
  }

  _beginOnlineMatch(cfg) {
    // Guests build a local mirror of the match purely for rendering; the host's
    // snapshots overwrite it every frame.
    this.match = new MatchEngine({ ...cfg, controllers: cfg.controllers.map(() => 'remote') });
    const slot = this.net.localSlots[0] ?? 1;
    this.localPlayers = [slot];
    this.input.localSlots = [slot, -1];
    this._enterMatch(Mode.MATCH);
  }

  _enterMatch(mode) {
    this.mode = mode;
    this.menu.hide();
    // The idle menu backdrop slowly pans the camera by writing to baseX. Put it back
    // before play starts, or the whole match runs off-centre.
    this.camera.baseX = 0;
    this.camera.sway = 0;
    this.camera.zoom = 1;
    this.renderer.fx.clear();
    this.renderer.hud.announcements.length = 0;
    this._footAccum = this.match.players.map(() => 0);
    this._applyAssists();

    this.audio.setVenue(this.match.venue);
    this.audio.setSurface(this.match.surface.id);
    this.audio.startAmbience();
    this.loop.resume();
  }

  exitMatch() {
    this.audio.stopAmbience();
    for (const h of Object.values(this._slideHandles)) this.audio.stopSlide(h);
    this._slideHandles = {};

    if (this.net.role !== NetRole.NONE) this.net.close();

    this.match = null;
    this.lessonInProgress = null;
    this.renderer.targetZones = null;
    this.mode = Mode.MENU;
    this.loop.resume();
    if (!this.menu.screen) this.menu.show('main');
  }

  _rematch() {
    if (this._lastMatchConfig) this.startLocalMatch(this._lastMatchConfig);
    else { this.exitMatch(); this.menu.show('main'); }
  }

  pause() {
    if (this.mode !== Mode.MATCH && this.mode !== Mode.PRACTICE) return;
    this._prevMode = this.mode;
    this.mode = Mode.PAUSED;
    this.loop.pause();
    this.audio.stopAmbience();
    this.menu.show('pause', { tip: this.lessonInProgress?.tip });
  }

  resume() {
    if (this.mode !== Mode.PAUSED) return;
    this.mode = this._prevMode || Mode.MATCH;
    this.menu.hide();
    this.audio.startAmbience();
    this.loop.resume();
  }

  // ── Simulation ─────────────────────────────────────────────────────────────

  fixedUpdate(dt) {
    this.net.tick(dt);
    if (!this.match || this.mode === Mode.PAUSED) return;

    if (this.net.role === NetRole.GUEST) {
      this._guestUpdate(dt);
      return;
    }

    // Local and host: the authoritative simulation.
    const inputs = this.input.pollAll();
    if (this.net.role === NetRole.HOST) {
      Object.assign(inputs, this.net.collectRemoteInputs());
    }
    if (this.settings.autoSwing) this._applyAutoSwing(inputs, dt);

    const events = this.match.update(dt, inputs);
    this._handleEvents(events, false);
    this._trackFootsteps(dt);

    if (this.net.role === NetRole.HOST) {
      this.net.sendEvents(events);
      this._snapTimer += dt;
      if (this._snapTimer >= 1 / SIM.NET_SNAPSHOT_HZ) {
        this._snapTimer = 0;
        this.net.sendSnapshot(this.match.snapshot());
      }
    }

    this.input.endFrame();
  }

  /**
   * Auto-swing assist.
   *
   * The hardest thing for a new player is not choosing a shot, it is releasing the
   * swing 145 ms before contact. With this on, we solve for the interception the same
   * way the AI does and synthesise the press and release at the right moment — so the
   * player only steers with the arrows and picks a shot if they want one.
   *
   * It never overrides a real key press, so the moment you start swinging yourself it
   * gets out of the way.
   */
  _applyAutoSwing(inputs, dt) {
    const match = this.match;
    if (!match || !match.ball.inPlay) return;

    for (const slot of this.localPlayers) {
      const p = match.players[slot];
      const input = inputs[slot];
      if (!p || !input) continue;
      if (input.shotDown || input.shotUp) continue;   // the player is doing it themselves
      if (p.swing !== 'idle' && p.swing !== 'windup') continue;
      if (!p.canHit) continue;
      // The ball has to be coming to us.
      if (match.ball.lastHitBy === p.index) continue;

      const hit = solveIntercept(
        match.ball, match.surface, match.wind, { doubles: match.doubles },
        { x: p.x, y: p.y }, p.maxSpeed(match.surface),
        { idealZ: p.contactHeight, reach: p.reach, preferAfterBounce: Math.abs(p.y) > COURT.SERVICE_LINE }
      );
      if (!hit || !hit.reachable) continue;

      // Charge a short, safe swing, then release so the racket meets the ball.
      const SWING_LEAD = 0.145;
      if (p.swing === 'idle' && hit.t <= SWING_LEAD + 0.22 && hit.t > SWING_LEAD * 0.5) {
        input.shotDown = true;
        input.shotType = input.shotType || 'topspin';
      } else if (p.swing === 'windup' && hit.t <= SWING_LEAD) {
        input.shotUp = true;
      }
    }
  }

  /**
   * Guests do not simulate. They send input, apply the host's interpolated state, and
   * locally predict only their own player's movement so it feels immediate.
   */
  _guestUpdate(dt) {
    const inputs = this.input.pollAll();
    const slot = this.localPlayers[0];
    const localInput = inputs[slot];

    if (localInput) this.net.sendInput(localInput);

    const state = this.net.interpolatedState();
    if (state) {
      const me = this.match.players[slot];
      const predX = me.x, predY = me.y;

      this.match.applySnapshot(state);

      // Reconcile: if the host broadly agrees, keep our smoother local position and
      // ease toward theirs. If it disagrees badly, the host is right — snap.
      const err = Math.hypot(this.match.players[slot].x - predX, this.match.players[slot].y - predY);
      if (err < 2.2) {
        const blend = 0.14;
        me.x = predX + (me.x - predX) * blend;
        me.y = predY + (me.y - predY) * blend;
      }
    }

    // Predict our own movement forward so the controls feel local.
    if (localInput) {
      const me = this.match.players[slot];
      me.move(localInput, dt, this.match.surface);
    }

    this._trackFootsteps(dt);
    this.input.endFrame();
  }

  // ── Events → audio, effects, HUD ───────────────────────────────────────────

  _handleEvents(events, remote) {
    if (!events || !this.match) return;
    const fx = this.renderer.fx;
    const hud = this.renderer.hud;
    const surface = this.match.surface;
    const shakeOn = this.settings.screenShake;

    for (const e of events) {
      switch (e.type) {
        case 'hit': {
          const isLocal = this.localPlayers.includes(e.player);
          this.audio.hit({
            type: e.shot, power: e.power ?? 0.6,
            quality: e.quality, spin: e.spin, height: e.height,
          });
          // A genuinely bad mishit gets the graphite crack on top of the dead thud.
          if (e.isMishit && e.quality < 0.2) this.audio.frameHit({ power: e.power });
          if (e.power > 0.55) {
            this.audio.grunt({ effort: Math.min(1, e.power * (0.7 + e.difficulty)), voiceId: e.player });
          }

          fx.impact(e.x, e.y, e.z, e.power ?? 0.6, e.quality);
          if (shakeOn && e.shot === 'smash') this.camera.shake(7);
          else if (shakeOn && e.power > 0.85) this.camera.shake(2.5);

          if (isLocal && this.settings.timingHints) hud.showTiming(e.label, e.quality);
          if (e.shot === 'smash' || e.speed > 38) hud.showSpeed(e.speed, e.shot);

          hud.rallyCount = this.match.rallyShots ?? 0;
          hud.showRally = true;
          break;
        }

        case 'serveHit':
          this.audio.hit({ type: 'serve', power: e.power ?? 0.9, quality: e.quality, spin: 0, height: 2.7 });
          this.audio.grunt({ effort: 0.8, voiceId: e.player });
          hud.showSpeed(e.speed, e.serveNumber === 1 ? '1st serve' : '2nd serve');
          if (shakeOn) this.camera.shake(3);
          break;

        case 'bounce':
          this.audio.bounce({ speed: e.speed, surfaceId: surface.id, onLine: e.onLine });
          fx.bounceDust(e.x, e.y, e.speed, surface);
          if (e.close) this.audio.crowd('ooh');
          break;

        case 'ballNet':
          this.audio.netHit({ speed: e.speed });
          if (shakeOn) this.camera.shake(1.5);
          break;

        case 'netCord':
          this.audio.netCord({ speed: e.speed });
          this.audio.crowd('ooh');
          fx.text('NET CORD', e.x, 0, 1.4, { color: '#ffd23f', life: 1.2, size: 0.8 });
          break;

        case 'ballPost':
          this.audio.netHit({ speed: e.speed });
          break;

        case 'whiff':
          this.audio.whiff();
          break;

        case 'lineCall':
          if (e.call === 'out') {
            this.audio.call('Out', { urgency: 0.95 });
            fx.text('OUT', e.x, e.y, 0.6, { color: '#ff5a5a', life: 1.3 });
            if (e.close) this.audio.crowd('gasp');
          } else if (e.call === 'fault') {
            this.audio.call('Fault', { urgency: 0.95 });
            fx.text('FAULT', e.x, e.y, 0.6, { color: '#ff5a5a', life: 1.2 });
          } else if (e.close) {
            fx.text('IN', e.x, e.y, 0.6, { color: '#00e07a', life: 0.9, size: 0.8 });
            this.audio.crowd('ooh');
          }
          break;

        case 'let':
          this.audio.call(this.match.venue.netCall || 'Let', { urgency: 0.8 });
          hud.announce('LET', { life: 1.4, big: false, color: '#ffd23f' });
          break;

        case 'fault':
          hud.announce('FAULT', { life: 1.2, big: false, color: '#ff5a5a' });
          break;

        case 'doubleFault':
          this.audio.call('Double fault', { urgency: 0.9 });
          hud.announce('DOUBLE FAULT', { life: 1.8, color: '#ff5a5a' });
          this.audio.crowd('gasp');
          break;

        case 'targetHit':
          this.audio.crowd('cheer');
          fx.text('TARGET', e.x, e.y, 1.0, { color: '#00e07a', life: 1.1 });
          break;

        case 'pointEnd':
          this._onPointEnd(e);
          break;

        case 'score':
          this._onScoreEvent(e);
          break;

        case 'matchOver':
          this._onMatchOver(e);
          break;

        case 'changeover':
          hud.announce('CHANGE OF ENDS', { life: 2.0, big: false });
          this.audio.crowd('applause');
          break;

        case 'serveReady':
          if (e.score && this.match.state !== MatchState.MATCH_OVER) {
            this.audio.announceScore(e.score);
          }
          break;

        case 'drillComplete':
          this._onDrillComplete(e);
          break;

        case 'feed':
          hud.rallyCount = 0;
          break;
      }
    }
  }

  _onPointEnd(e) {
    const hud = this.renderer.hud;
    hud.showRally = false;

    if (e.ace) {
      hud.announce('ACE', { life: 1.8, color: '#00e07a' });
      this.audio.crowd('aceReaction');
    } else if (e.winner) {
      hud.announce('WINNER', { life: 1.5, color: '#00e07a', big: false });
      this.audio.crowd('cheer');
    } else if (e.rallyLength > 12) {
      this.audio.crowd('applause');
    } else {
      this.audio.crowd('pointWon');
    }
  }

  _onScoreEvent(e) {
    const hud = this.renderer.hud;
    const match = this.match;
    if (!match) return;

    switch (e.type) {
      case 'gameWon': {
        const name = match.score.teamNames[e.team];
        hud.announce('GAME', { sub: name, life: 2.0 });
        this.audio.call(`Game, ${name}`, { urgency: 0.4 });
        this.audio.crowd('applause');
        break;
      }
      case 'breakOfServe':
        hud.announce('BREAK', { life: 1.8, color: '#ffd23f', big: false });
        this.audio.crowd('cheer');
        break;
      case 'setWon': {
        const name = match.score.teamNames[e.team];
        hud.announce('SET', { sub: `${name} — ${e.score[0]}–${e.score[1]}`, life: 2.6 });
        this.audio.crowd('applause');
        break;
      }
      case 'tiebreakStart':
        hud.announce('TIEBREAK', { sub: `First to ${e.target}`, life: 2.4, color: '#ffd23f' });
        break;
      case 'advantage':
      case 'deuce':
        break;
    }
  }

  _onMatchOver(e) {
    const match = this.match;
    this.audio.crowd('cheer');
    this.renderer.hud.announce('GAME, SET, MATCH', {
      sub: match.score.teamNames[e.winner],
      life: 4,
    });
    setTimeout(() => {
      if (!this.match) return;
      this.menu.show('results', {
        match,
        winnerName: match.score.teamNames[e.winner],
      });
      this.mode = Mode.MENU;
    }, 3200);
  }

  _onDrillComplete(result) {
    const lesson = this.lessonInProgress;
    this.audio.crowd(result.stars > 0 ? 'cheer' : 'applause');
    setTimeout(() => {
      if (!this.match) return;
      this.menu.show('drillResult', { result, lesson });
      this.mode = Mode.MENU;
    }, 1600);
  }

  /**
   * Footsteps are not events — they are derived from how far each player has actually
   * run, so the cadence matches the animation and the surface.
   */
  _trackFootsteps(dt) {
    if (!this.match) return;
    const surface = this.match.surface;

    for (let i = 0; i < this.match.players.length; i++) {
      const p = this.match.players[i];
      const speed = Math.hypot(p.vx, p.vy);

      // Sliding is a continuous sound, so it is handled as a start/stop handle.
      if (p.sliding && speed > 2.5) {
        if (!this._slideHandles[i]) {
          this._slideHandles[i] = this.audio.slide({
            surfaceId: surface.id,
            intensity: Math.min(1, speed / 6),
          });
          this.renderer.fx.footScuff(p.x, p.y, surface, 1);
        }
        continue;
      }
      if (this._slideHandles[i]) {
        this.audio.stopSlide(this._slideHandles[i]);
        this._slideHandles[i] = null;
      }

      if (speed < 0.8) { this._footAccum[i] = 0.5; continue; }

      this._footAccum[i] = (this._footAccum[i] || 0) + speed * dt;
      // Roughly one step per 0.85 m of travel.
      if (this._footAccum[i] >= 0.85) {
        this._footAccum[i] -= 0.85;
        this.audio.footstep({
          surfaceId: surface.id,
          intensity: Math.min(1, speed / 6.5),
        });
        if (speed > 4.5) this.renderer.fx.footScuff(p.x, p.y, surface, speed / 6.5);
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(dt, alpha) {
    if (!this.match) {
      // Idle menu backdrop: an empty court, slowly drifting.
      this._renderIdle(dt);
      return;
    }

    const match = this.match;
    const ball = match.ball;

    // Camera follows the ball while it is live, and recentres between points.
    if (match.isLive || ball.inPlay) this.camera.follow(ball.x, ball.y, dt);
    else this.camera.recentre(dt);

    // Landing prediction, recomputed a few times a second rather than every frame —
    // it runs the full integrator and there is no need for per-frame precision.
    this._predictionTimer -= dt;
    if (this._predictionTimer <= 0 && ball.inPlay) {
      this._predictionTimer = 0.06;
      this._prediction = predictBall(ball, match.surface, match.wind, { doubles: match.doubles }, 3);
    } else if (!ball.inPlay) {
      this._prediction = null;
    }

    this.renderer.fx.update(dt);
    this.renderer.hud.update(dt);

    // The aim guide previews where a charging shot is headed.
    let aimPreview = null;
    const me = match.players[this.localPlayers[0]];
    if (this.renderer.showAimGuide && me && me.swing === 'windup' && me.charge > 0.05) {
      const input = this.input.poll(0);
      const halfWidth = match.doubles ? COURT.DOUBLES_HALF_WIDTH : COURT.SINGLES_HALF_WIDTH;
      const oppSide = -me.side;
      const depth = Math.max(0.15, Math.min(0.97, 0.72 + (input.aimY || 0) * 0.26));
      aimPreview = {
        from: { x: me.x, y: me.y },
        to: { x: (input.aimX || 0) * (halfWidth - 0.5), y: oppSide * COURT.HALF_LENGTH * depth },
        power: me.charge,
      };
    }

    this.renderer.render(match, {
      dt,
      localPlayer: this.localPlayers[0],
      prediction: this._prediction,
      aimPreview,
      overlay: (ctx, W, H) => this._drawOverlay(ctx, W, H),
    });
  }

  _renderIdle(dt) {
    // A quiet court behind the menus, so the front end is not a dead screen.
    if (!this._idleMatch) {
      this._idleMatch = new MatchEngine({
        venueId: this.settings.venueId,
        controllers: ['ai', 'ai'],
        difficulty: 'tour',
        bestOf: 1,
      });
    }
    this._idlePhase = (this._idlePhase || 0) + dt * 0.12;
    this.camera.baseX = Math.sin(this._idlePhase) * 2.2;
    this.camera.recentre(dt);
    this.renderer.fx.update(dt);
    this.renderer.render(this._idleMatch, { dt, localPlayer: -1 });
  }

  _drawOverlay(ctx, W, H) {
    // Connection quality indicator for online play.
    if (this.net.role !== NetRole.NONE) {
      const q = this.net.connectionQuality;
      const colors = { good: '#00e07a', fair: '#ffd23f', poor: '#ff8c42', lost: '#ff5a5a' };
      ctx.save();
      ctx.fillStyle = colors[q] || '#888';
      ctx.beginPath();
      ctx.arc(W - 22, 22, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(`${this.net.latency} ms`, W - 34, 26);
      ctx.restore();
    }

    // Drill progress.
    if (this.mode === Mode.PRACTICE && this.match?.lesson) {
      const m = this.match;
      ctx.save();
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      const goal = m.lesson.objective.stars;
      ctx.fillText(
        `${m.lesson.name}  —  ${m.score_} / ${goal[0]} ★  ·  ${goal[1]} ★★  ·  ${goal[2]} ★★★`,
        W / 2, 28
      );
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(`${m.feedsRemaining} balls remaining`, W / 2, 46);
      ctx.restore();
    }

    if (this.settings.showFps) {
      ctx.save();
      ctx.font = '600 11px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.textAlign = 'left';
      ctx.fillText(`${this.loop.fps} fps · ${this.loop.stepsLastFrame} steps`, 24, H - 12);
      ctx.restore();
    }
  }

  _onNetState(state, error) {
    if (state === NetState.ERROR && error) this._toast(error);
  }

  _toast(msg) {
    let box = document.getElementById('toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => box.classList.remove('show'), 3600);
  }
}

const AI_NAMES = ['Alvarez', 'Novak', 'Sinclair', 'Rune', 'Medved', 'Tsits', 'Fritz', 'Hurk'];

// Boot once the DOM is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { window.game = new Game(); });
} else {
  window.game = new Game();
}
