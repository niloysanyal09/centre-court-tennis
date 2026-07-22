/**
 * Menus and front-end screens.
 *
 * DOM-based rather than canvas-drawn: real focus handling, real keyboard navigation,
 * real text rendering, and it stays legible on a Retina display without any work.
 * The canvas is only for the court.
 */

import { VENUE_LIST, getVenue } from '../data/venues.js';
import { SURFACES, getSurface } from '../data/surfaces.js';
import { DIFFICULTY_LIST, DIFFICULTIES } from '../sim/ai.js';
import { loadSettings, saveSettings, ASSIST_PRESETS } from '../core/state.js';
import { ACADEMY, DRILLS, loadProgress, isUnlocked, totalStars } from './practice.js';
import { listAvatars, saveAvatar, deleteAvatar, getAvatar, openAvatarCreator, createAvatar, randomAvatar } from './avatar.js';
import { summariseStats } from '../sim/rules.js';
import { CONTROL_REFERENCE } from '../core/input.js';

export class Menu {
  /** @param {HTMLElement} root  the overlay container */
  constructor(root, hooks = {}) {
    this.root = root;
    this.hooks = hooks;
    this.screen = null;
    this.stack = [];
    this._pendingConfig = null;
  }

  // ── Screen plumbing ────────────────────────────────────────────────────────

  show(screen, data) {
    this.screen = screen;
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');
    this.root.dataset.screen = screen;

    const builder = this[`_${screen}`];
    if (typeof builder === 'function') builder.call(this, data);

    // Move focus into the panel so keyboard users land somewhere sensible.
    const first = this.root.querySelector('button, input, select, [tabindex]');
    if (first) first.focus({ preventScroll: true });
  }

  hide() {
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
    this.screen = null;
  }

  push(screen, data) {
    if (this.screen) this.stack.push(this.screen);
    this.show(screen, data);
  }

  back() {
    const prev = this.stack.pop();
    this.show(prev || 'main');
  }

  // ── Screens ────────────────────────────────────────────────────────────────

  _title() {
    const wrap = el('div', 'tn-title-screen');
    wrap.innerHTML = `
      <div class="tn-title-mark">
        <div class="tn-title-ball"></div>
        <h1>CENTRE&nbsp;COURT</h1>
        <p class="tn-title-sub">A tennis simulation</p>
      </div>
      <button class="tn-btn tn-btn-primary tn-btn-lg" data-act="start">Press to begin</button>
      <p class="tn-title-hint">Sound is a big part of this game. Headphones recommended.</p>
    `;
    wrap.querySelector('[data-act="start"]').addEventListener('click', () => {
      this.hooks.onFirstGesture?.();
      this.show('main');
    });
    this.root.appendChild(wrap);
  }

  _main() {
    const progress = loadProgress();
    const stars = totalStars(progress);
    const s = loadSettings();
    const avatar = s.activeAvatarId ? getAvatar(s.activeAvatarId) : null;

    const panel = el('div', 'tn-panel tn-main');
    panel.innerHTML = `
      <header class="tn-main-head">
        <div>
          <h1>Centre Court</h1>
          <p class="tn-muted">${avatar ? `Playing as <strong>${escapeHtml(avatar.name)}</strong>` : 'No avatar selected'} · ${stars} ★ earned</p>
        </div>
      </header>
      <nav class="tn-menu-grid">
        ${menuCard('quick', 'Quick Match', 'Singles or doubles against the AI. Pick a venue and play.', '🎾')}
        ${menuCard('online', 'Play Online', 'Host a room or join with a code. Two to four players.', '🌐')}
        ${menuCard('academy', 'Academy', 'Learn the game step by step. Fourteen lessons.', '🎓')}
        ${menuCard('drills', 'Drills', 'Sharpen one skill at a time. Chase three stars.', '🎯')}
        ${menuCard('avatars', 'Players', 'Create and edit your avatars.', '👤')}
        ${menuCard('settings', 'Settings', 'Audio, assists, camera and controls.', '⚙️')}
      </nav>
    `;
    panel.querySelectorAll('[data-nav]').forEach((b) => {
      b.addEventListener('click', () => this.push(b.dataset.nav));
    });
    this.root.appendChild(panel);
  }

  // ── Quick match setup ──────────────────────────────────────────────────────

  _quick() {
    const s = loadSettings();
    const cfg = this._pendingConfig = {
      doubles: s.doubles,
      venueId: s.venueId,
      surfaceId: null,
      difficulty: s.difficulty,
      bestOf: s.bestOf,
      avatarId: s.activeAvatarId,
    };

    const panel = el('div', 'tn-panel tn-setup');
    panel.innerHTML = `
      <header class="tn-head">
        <button class="tn-back" data-act="back">←</button>
        <h2>Quick Match</h2>
      </header>
      <div class="tn-setup-body">
        <section>
          <h3>Format</h3>
          <div class="tn-seg" data-group="mode">
            <button data-val="singles" class="${!cfg.doubles ? 'on' : ''}">Singles</button>
            <button data-val="doubles" class="${cfg.doubles ? 'on' : ''}">Doubles</button>
          </div>
          <h3>Match length</h3>
          <div class="tn-seg" data-group="bestOf">
            <button data-val="1" class="${cfg.bestOf === 1 ? 'on' : ''}">One set</button>
            <button data-val="3" class="${cfg.bestOf === 3 ? 'on' : ''}">Best of 3</button>
            <button data-val="5" class="${cfg.bestOf === 5 ? 'on' : ''}">Best of 5</button>
          </div>
          <h3>Opponent</h3>
          <div class="tn-diff-list" data-group="difficulty">
            ${DIFFICULTY_LIST.map((d) => `
              <button data-val="${d.id}" class="tn-diff ${cfg.difficulty === d.id ? 'on' : ''}">
                <span class="tn-diff-rating">${'●'.repeat(d.rating)}<span class="dim">${'●'.repeat(5 - d.rating)}</span></span>
                <span class="tn-diff-name">${d.name}</span>
                <span class="tn-diff-blurb">${d.blurb}</span>
              </button>`).join('')}
          </div>
        </section>
        <section>
          <h3>Venue</h3>
          <div class="tn-venue-list" data-group="venue">
            ${VENUE_LIST.filter((v) => v.id !== 'practice').map((v) => {
              const surf = getSurface(v.surface);
              return `
              <button data-val="${v.id}" class="tn-venue ${cfg.venueId === v.id ? 'on' : ''}">
                <span class="tn-venue-swatch" style="background:${surf.courtColor};border-color:${surf.outerColor}"></span>
                <span class="tn-venue-text">
                  <strong>${v.name}</strong>
                  <em>${v.subtitle} · ${surf.name} · ${surf.paceRating}</em>
                  <span class="tn-venue-blurb">${v.blurb}</span>
                </span>
              </button>`;
            }).join('')}
          </div>
        </section>
      </div>
      <footer class="tn-foot">
        <div class="tn-avatar-pick" data-act="pickAvatar"></div>
        <button class="tn-btn tn-btn-primary" data-act="play">Play</button>
      </footer>
    `;

    // Segmented controls
    panel.querySelectorAll('[data-group] button').forEach((b) => {
      b.addEventListener('click', () => {
        const group = b.closest('[data-group]').dataset.group;
        b.parentElement.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        const v = b.dataset.val;
        if (group === 'mode') cfg.doubles = v === 'doubles';
        else if (group === 'bestOf') cfg.bestOf = Number(v);
        else if (group === 'difficulty') cfg.difficulty = v;
        else if (group === 'venue') cfg.venueId = v;
      });
    });

    panel.querySelector('[data-act="back"]').addEventListener('click', () => this.back());
    panel.querySelector('[data-act="play"]').addEventListener('click', () => {
      saveSettings({
        doubles: cfg.doubles, bestOf: cfg.bestOf,
        difficulty: cfg.difficulty, venueId: cfg.venueId,
      });
      this.hooks.onStartMatch?.(cfg);
    });

    this._mountAvatarPicker(panel.querySelector('[data-act="pickAvatar"]'), (id) => { cfg.avatarId = id; });
    this.root.appendChild(panel);
  }

  /** A compact avatar selector reused across setup screens. */
  _mountAvatarPicker(host, onChange) {
    const s = loadSettings();
    const render = () => {
      const avatars = listAvatars();
      const active = s.activeAvatarId && avatars.find((a) => a.id === s.activeAvatarId);
      host.innerHTML = `
        <span class="tn-muted">Playing as</span>
        <select class="tn-select">
          ${avatars.map((a) => `<option value="${a.id}" ${active && a.id === active.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`).join('')}
          ${avatars.length === 0 ? '<option value="">No avatars yet</option>' : ''}
        </select>
        <button class="tn-btn tn-btn-ghost tn-btn-sm" data-act="newAvatar">${avatars.length ? 'Edit' : 'Create'}</button>
      `;
      const sel = host.querySelector('select');
      sel.addEventListener('change', () => {
        saveSettings({ activeAvatarId: sel.value });
        s.activeAvatarId = sel.value;
        onChange?.(sel.value);
      });
      host.querySelector('[data-act="newAvatar"]').addEventListener('click', async () => {
        const existing = sel.value ? getAvatar(sel.value) : null;
        const result = await openAvatarCreator({ avatar: existing });
        if (result) {
          saveAvatar(result);
          saveSettings({ activeAvatarId: result.id });
          s.activeAvatarId = result.id;
          onChange?.(result.id);
          render();
        }
      });
    };
    render();
  }

  // ── Online ─────────────────────────────────────────────────────────────────

  _online() {
    const s = loadSettings();
    const panel = el('div', 'tn-panel tn-online');
    panel.innerHTML = `
      <header class="tn-head">
        <button class="tn-back" data-act="back">←</button>
        <h2>Play Online</h2>
      </header>
      <div class="tn-online-body">
        <div class="tn-online-card">
          <h3>Host a match</h3>
          <p class="tn-muted">You get a room code. Share it and your friends join you. Your machine runs the simulation, so host on the fastest connection.</p>
          <div class="tn-seg" data-group="netmode">
            <button data-val="singles" class="on">Singles (2)</button>
            <button data-val="doubles">Doubles (4)</button>
          </div>
          <button class="tn-btn tn-btn-primary" data-act="host">Create room</button>
        </div>
        <div class="tn-online-card">
          <h3>Join a match</h3>
          <p class="tn-muted">Enter the five-character code from whoever is hosting.</p>
          <input class="tn-code-input" data-act="code" maxlength="5" placeholder="ABC12" autocomplete="off" spellcheck="false">
          <button class="tn-btn tn-btn-primary" data-act="join">Join</button>
        </div>
      </div>
      <p class="tn-note">Peer-to-peer over WebRTC. The connection is browser to browser; only the initial handshake goes through a public signalling server. If it fails, a firewall or VPN is the usual culprit — local play always works.</p>
      <div class="tn-error" data-act="error" hidden></div>
    `;

    let doubles = false;
    panel.querySelectorAll('[data-group="netmode"] button').forEach((b) => {
      b.addEventListener('click', () => {
        panel.querySelectorAll('[data-group="netmode"] button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        doubles = b.dataset.val === 'doubles';
      });
    });

    const codeInput = panel.querySelector('[data-act="code"]');
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') panel.querySelector('[data-act="join"]').click();
    });

    const errBox = panel.querySelector('[data-act="error"]');
    const showErr = (msg) => { errBox.hidden = false; errBox.textContent = msg; };

    panel.querySelector('[data-act="back"]').addEventListener('click', () => this.back());
    panel.querySelector('[data-act="host"]').addEventListener('click', () => {
      this.hooks.onHost?.({ doubles, venueId: s.venueId, bestOf: s.bestOf }, showErr);
    });
    panel.querySelector('[data-act="join"]').addEventListener('click', () => {
      const code = codeInput.value.trim();
      if (code.length !== 5) { showErr('A room code is five characters.'); return; }
      this.hooks.onJoin?.(code, showErr);
    });

    this.root.appendChild(panel);
  }

  /** The waiting room, shown to host and guests alike. */
  _lobby(data) {
    const { code, isHost, lobby, config } = data;
    const panel = el('div', 'tn-panel tn-lobby');
    panel.innerHTML = `
      <header class="tn-head">
        <button class="tn-back" data-act="leave">←</button>
        <h2>${isHost ? 'Your room' : 'Joined room'}</h2>
      </header>
      ${isHost ? `
        <div class="tn-code-display">
          <span class="tn-muted">Room code</span>
          <div class="tn-code">${code}</div>
          <button class="tn-btn tn-btn-ghost tn-btn-sm" data-act="copy">Copy</button>
        </div>` : `
        <div class="tn-code-display"><span class="tn-muted">Room</span><div class="tn-code">${code}</div></div>`}
      <div class="tn-lobby-list" data-act="list"></div>
      <footer class="tn-foot">
        ${isHost
          ? '<button class="tn-btn tn-btn-primary" data-act="start" disabled>Waiting for players…</button>'
          : '<button class="tn-btn tn-btn-primary" data-act="ready">I\'m ready</button>'}
      </footer>
    `;

    panel.querySelector('[data-act="leave"]').addEventListener('click', () => this.hooks.onLeaveRoom?.());
    panel.querySelector('[data-act="copy"]')?.addEventListener('click', (e) => {
      navigator.clipboard?.writeText(code);
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1400);
    });
    panel.querySelector('[data-act="start"]')?.addEventListener('click', () => this.hooks.onStartOnline?.());
    let ready = false;
    panel.querySelector('[data-act="ready"]')?.addEventListener('click', (e) => {
      ready = !ready;
      e.target.textContent = ready ? 'Ready ✓' : "I'm ready";
      e.target.classList.toggle('tn-btn-ghost', ready);
      this.hooks.onReady?.(ready);
    });

    this.root.appendChild(panel);
    this.updateLobby(lobby, isHost, config);
  }

  updateLobby(lobby, isHost, config) {
    const list = this.root.querySelector('[data-act="list"]');
    if (!list) return;
    const needed = config?.doubles ? 4 : 2;

    list.innerHTML = '';
    for (let i = 0; i < needed; i++) {
      const p = lobby?.find((l) => l.slot === i);
      const row = el('div', 'tn-lobby-row' + (p ? '' : ' empty'));
      const team = i % 2 === 0 ? 'Near' : 'Far';
      row.innerHTML = p
        ? `<span class="tn-lobby-slot">${team}</span>
           <span class="tn-lobby-name">${escapeHtml(p.name)}${p.isHost ? ' <em>host</em>' : ''}</span>
           <span class="tn-lobby-ping ${pingClass(p.ping)}">${p.isHost ? '' : (p.ping ? p.ping + ' ms' : '…')}</span>
           <span class="tn-lobby-ready">${p.ready ? '✓' : '·'}</span>`
        : `<span class="tn-lobby-slot">${team}</span><span class="tn-lobby-name tn-muted">Waiting for a player…</span>`;
      list.appendChild(row);
    }

    const startBtn = this.root.querySelector('[data-act="start"]');
    if (startBtn && isHost) {
      const filled = (lobby || []).length >= needed;
      startBtn.disabled = !filled;
      startBtn.textContent = filled ? 'Start match' : `Waiting for players… (${(lobby || []).length}/${needed})`;
    }
  }

  // ── Academy and drills ─────────────────────────────────────────────────────

  _academy() {
    const progress = loadProgress();
    const panel = el('div', 'tn-panel tn-academy');

    const byLevel = new Map();
    for (const lesson of ACADEMY) {
      if (!byLevel.has(lesson.level)) byLevel.set(lesson.level, []);
      byLevel.get(lesson.level).push(lesson);
    }

    panel.innerHTML = `
      <header class="tn-head">
        <button class="tn-back" data-act="back">←</button>
        <h2>Academy</h2>
        <span class="tn-muted">${totalStars(progress)} ★</span>
      </header>
      <p class="tn-note">Fourteen lessons, in order. Each one teaches a single mechanic and unlocks the next. The physics here are identical to a real match, so what you learn transfers.</p>
      <div class="tn-lesson-groups">
        ${[...byLevel.entries()].map(([level, lessons]) => `
          <section>
            <h3>Level ${level}</h3>
            <div class="tn-lesson-grid">
              ${lessons.map((l) => lessonCard(l, progress)).join('')}
            </div>
          </section>`).join('')}
      </div>
    `;

    panel.querySelector('[data-act="back"]').addEventListener('click', () => this.back());
    panel.querySelectorAll('[data-lesson]').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.classList.contains('locked')) return;
        const lesson = ACADEMY.find((l) => l.id === b.dataset.lesson);
        this.hooks.onStartLesson?.(lesson);
      });
    });
    this.root.appendChild(panel);
  }

  _drills() {
    const progress = loadProgress();
    const panel = el('div', 'tn-panel tn-academy');
    panel.innerHTML = `
      <header class="tn-head">
        <button class="tn-back" data-act="back">←</button>
        <h2>Drills</h2>
      </header>
      <p class="tn-note">Repeatable challenges. Three stars each. Nothing is locked — grind whatever is letting you down.</p>
      <div class="tn-lesson-grid">
        ${DRILLS.map((d) => lessonCard(d, progress, true)).join('')}
      </div>
    `;
    panel.querySelector('[data-act="back"]').addEventListener('click', () => this.back());
    panel.querySelectorAll('[data-lesson]').forEach((b) => {
      b.addEventListener('click', () => {
        const drill = DRILLS.find((l) => l.id === b.dataset.lesson);
        this.hooks.onStartLesson?.(drill);
      });
    });
    this.root.appendChild(panel);
  }

  // ── Avatars ────────────────────────────────────────────────────────────────

  _avatars() {
    const s = loadSettings();
    const panel = el('div', 'tn-panel tn-avatars');

    const render = () => {
      const avatars = listAvatars();
      panel.innerHTML = `
        <header class="tn-head">
          <button class="tn-back" data-act="back">←</button>
          <h2>Players</h2>
          <button class="tn-btn tn-btn-primary tn-btn-sm" data-act="create">New avatar</button>
        </header>
        <p class="tn-note">Attributes share a budget of 40 points, so every avatar is a set of trade-offs. A big server who cannot move is a real archetype, and so is a counterpuncher with no weapons.</p>
        <div class="tn-avatar-grid">
          ${avatars.length === 0
            ? '<p class="tn-empty">No avatars yet. Create one to get started.</p>'
            : avatars.map((a) => avatarCard(a, a.id === s.activeAvatarId)).join('')}
        </div>
      `;
      panel.querySelector('[data-act="back"]').addEventListener('click', () => this.back());
      panel.querySelector('[data-act="create"]').addEventListener('click', async () => {
        const result = await openAvatarCreator({});
        if (result) { saveAvatar(result); saveSettings({ activeAvatarId: result.id }); s.activeAvatarId = result.id; render(); }
      });
      panel.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
        const result = await openAvatarCreator({ avatar: getAvatar(b.dataset.edit) });
        if (result) { saveAvatar(result); render(); }
      }));
      panel.querySelectorAll('[data-select]').forEach((b) => b.addEventListener('click', () => {
        saveSettings({ activeAvatarId: b.dataset.select });
        s.activeAvatarId = b.dataset.select;
        render();
      }));
      panel.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', () => {
        if (!confirm('Delete this avatar?')) return;
        deleteAvatar(b.dataset.delete);
        render();
      }));
    };

    render();
    this.root.appendChild(panel);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  _settings() {
    const s = loadSettings();
    const panel = el('div', 'tn-panel tn-settings');
    panel.innerHTML = `
      <header class="tn-head">
        <button class="tn-back" data-act="back">←</button>
        <h2>Settings</h2>
      </header>
      <div class="tn-settings-body">
        <section>
          <h3>Audio</h3>
          ${slider('masterVolume', 'Master', s.masterVolume)}
          ${slider('sfxVolume', 'Ball and court', s.sfxVolume)}
          ${slider('crowdVolume', 'Crowd', s.crowdVolume)}
          ${slider('voiceVolume', 'Umpire and line calls', s.voiceVolume)}
          ${toggle('muted', 'Mute everything', s.muted)}
        </section>

        <section>
          <h3>Assists</h3>
          <div class="tn-preset-row">
            ${Object.entries(ASSIST_PRESETS).map(([k, p]) => `
              <button class="tn-preset" data-preset="${k}">
                <strong>${p.name}</strong><span>${p.blurb}</span>
              </button>`).join('')}
          </div>
          ${toggle('autoSwing', 'Swing for me', s.autoSwing, 'The game times the swing. You just steer with the arrows.')}
          ${toggle('landingMarker', 'Landing marker', s.landingMarker, 'A ring showing where the ball will bounce.')}
          ${toggle('aimGuide', 'Aim guide', s.aimGuide, 'An arc showing your target while charging a shot.')}
          ${toggle('timingHints', 'Timing feedback', s.timingHints, 'PERFECT / GOOD / MISHIT call-outs at contact.')}
          ${toggle('autoPosition', 'Positioning help', s.autoPosition, 'Nudges you toward the ball automatically.')}
        </section>

        <section>
          <h3>Presentation</h3>
          <label class="tn-field"><span>Camera</span>
            <select class="tn-select" data-set="cameraPreset">
              <option value="broadcast" ${s.cameraPreset === 'broadcast' ? 'selected' : ''}>Broadcast</option>
              <option value="low" ${s.cameraPreset === 'low' ? 'selected' : ''}>Low and close</option>
              <option value="high" ${s.cameraPreset === 'high' ? 'selected' : ''}>High tactical</option>
            </select>
          </label>
          <label class="tn-field"><span>Speed units</span>
            <select class="tn-select" data-set="units">
              <option value="kmh" ${s.units === 'kmh' ? 'selected' : ''}>km/h</option>
              <option value="mph" ${s.units === 'mph' ? 'selected' : ''}>mph</option>
            </select>
          </label>
          ${toggle('ballTrail', 'Ball trail', s.ballTrail)}
          ${toggle('screenShake', 'Screen shake', s.screenShake)}
          ${toggle('showFps', 'Show frame rate', s.showFps)}
        </section>

        <section>
          <h3>Controls</h3>
          ${controlsTable()}
        </section>
      </div>
    `;

    panel.querySelector('[data-act="back"]').addEventListener('click', () => this.back());

    panel.querySelectorAll('[data-slider]').forEach((input) => {
      input.addEventListener('input', () => {
        const patch = { [input.dataset.slider]: Number(input.value) / 100 };
        saveSettings(patch);
        input.parentElement.querySelector('.tn-slider-val').textContent = input.value + '%';
        this.hooks.onSettingsChanged?.(patch);
      });
    });

    panel.querySelectorAll('[data-toggle]').forEach((input) => {
      input.addEventListener('change', () => {
        const patch = { [input.dataset.toggle]: input.checked };
        saveSettings(patch);
        this.hooks.onSettingsChanged?.(patch);
      });
    });

    panel.querySelectorAll('[data-set]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const patch = { [sel.dataset.set]: sel.value };
        saveSettings(patch);
        this.hooks.onSettingsChanged?.(patch);
      });
    });

    panel.querySelectorAll('[data-preset]').forEach((b) => {
      b.addEventListener('click', () => {
        const preset = ASSIST_PRESETS[b.dataset.preset];
        saveSettings(preset.settings);
        this.hooks.onSettingsChanged?.(preset.settings);
        this.show('settings');
      });
    });

    this.root.appendChild(panel);
  }

  // ── Results ────────────────────────────────────────────────────────────────

  _results(data) {
    const { match, winnerName } = data;
    const score = match.score;
    const a = summariseStats(score.stats[0]);
    const b = summariseStats(score.stats[1]);

    const rows = [
      ['Aces', a.aces, b.aces],
      ['Double faults', a.doubleFaults, b.doubleFaults],
      ['First serve %', a.firstServePct + '%', b.firstServePct + '%'],
      ['Points won on first serve', a.firstServeWonPct + '%', b.firstServeWonPct + '%'],
      ['Winners', a.winners, b.winners],
      ['Unforced errors', a.unforcedErrors, b.unforcedErrors],
      ['Breaks of serve', a.breaks, b.breaks],
      ['Total points won', a.pointsWon, b.pointsWon],
      ['Average rally', a.avgRally, b.avgRally],
      ['Longest rally', a.longestRally, b.longestRally],
      ['Fastest shot', a.fastestShot + ' km/h', b.fastestShot + ' km/h'],
    ];

    const panel = el('div', 'tn-panel tn-results');
    panel.innerHTML = `
      <div class="tn-results-head">
        <p class="tn-muted">Match complete</p>
        <h1>${escapeHtml(winnerName)}</h1>
        <div class="tn-final-score">${score.setScoreText}</div>
      </div>
      <table class="tn-stats">
        <thead><tr><th>${escapeHtml(score.teamNames[0])}</th><th></th><th>${escapeHtml(score.teamNames[1])}</th></tr></thead>
        <tbody>
          ${rows.map(([label, x, y]) => `<tr><td>${x}</td><th>${label}</th><td>${y}</td></tr>`).join('')}
        </tbody>
      </table>
      <footer class="tn-foot">
        <button class="tn-btn tn-btn-ghost" data-act="menu">Main menu</button>
        <button class="tn-btn tn-btn-primary" data-act="rematch">Rematch</button>
      </footer>
    `;
    panel.querySelector('[data-act="menu"]').addEventListener('click', () => {
      this.stack.length = 0;
      this.show('main');
      this.hooks.onExitMatch?.();
    });
    panel.querySelector('[data-act="rematch"]').addEventListener('click', () => this.hooks.onRematch?.());
    this.root.appendChild(panel);
  }

  /** Drill completion summary. */
  _drillResult(data) {
    const { result, lesson } = data;
    const s = result.stats;
    const panel = el('div', 'tn-panel tn-results');
    panel.innerHTML = `
      <div class="tn-results-head">
        <p class="tn-muted">${escapeHtml(lesson.category || 'Drill')}</p>
        <h1>${escapeHtml(lesson.name)}</h1>
        <div class="tn-stars big">${starString(result.stars)}</div>
        <p class="tn-score-line">Score <strong>${result.score}</strong> · targets ${result.goal.join(' / ')}</p>
      </div>
      <div class="tn-drill-stats">
        ${stat('Contacts', s.contacts)}
        ${stat('In court', s.inCourt)}
        ${stat('Perfect strikes', s.perfect)}
        ${stat('Mishits', s.mishits)}
        ${stat('Best streak', s.bestConsecutive)}
        ${lesson.zones ? stat('Targets hit', s.targetsHit) : ''}
        ${lesson.mode === 'serve' ? stat('Serves in', s.servesIn) : ''}
        ${lesson.mode === 'serve' ? stat('Double faults', s.doubleFaults) : ''}
      </div>
      ${lesson.tip ? `<p class="tn-tip"><strong>Tip</strong> ${escapeHtml(lesson.tip)}</p>` : ''}
      <footer class="tn-foot">
        <button class="tn-btn tn-btn-ghost" data-act="menu">Back</button>
        <button class="tn-btn tn-btn-primary" data-act="retry">Try again</button>
      </footer>
    `;
    panel.querySelector('[data-act="menu"]').addEventListener('click', () => {
      this.hooks.onExitMatch?.();
      this.show(ACADEMY.some((l) => l.id === lesson.id) ? 'academy' : 'drills');
    });
    panel.querySelector('[data-act="retry"]').addEventListener('click', () => this.hooks.onStartLesson?.(lesson));
    this.root.appendChild(panel);
  }

  /** In-match pause overlay. */
  _pause(data) {
    const panel = el('div', 'tn-panel tn-pause');
    panel.innerHTML = `
      <h2>Paused</h2>
      ${data?.tip ? `<p class="tn-tip">${escapeHtml(data.tip)}</p>` : ''}
      ${controlsTable()}
      <footer class="tn-foot">
        <button class="tn-btn tn-btn-ghost" data-act="quit">Quit match</button>
        <button class="tn-btn tn-btn-primary" data-act="resume">Resume</button>
      </footer>
    `;
    panel.querySelector('[data-act="resume"]').addEventListener('click', () => this.hooks.onResume?.());
    panel.querySelector('[data-act="quit"]').addEventListener('click', () => this.hooks.onQuitMatch?.());
    this.root.appendChild(panel);
  }
}

// ── Template helpers ─────────────────────────────────────────────────────────

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function menuCard(nav, title, blurb, icon) {
  return `<button class="tn-card" data-nav="${nav}">
    <span class="tn-card-icon">${icon}</span>
    <strong>${title}</strong>
    <span>${blurb}</span>
  </button>`;
}

function lessonCard(lesson, progress, isDrill = false) {
  const bucket = isDrill ? progress.drills : progress.academy;
  const rec = bucket[lesson.id];
  const locked = !isDrill && !isUnlocked(lesson.id, progress);
  return `<button class="tn-lesson ${locked ? 'locked' : ''} ${rec ? 'done' : ''}" data-lesson="${lesson.id}" ${locked ? 'disabled' : ''}>
    <span class="tn-lesson-top">
      <strong>${escapeHtml(lesson.name)}</strong>
      <span class="tn-stars">${locked ? '🔒' : starString(rec?.stars || 0)}</span>
    </span>
    <span class="tn-lesson-cat">${escapeHtml(lesson.category || '')}</span>
    <span class="tn-lesson-desc">${escapeHtml(lesson.teaches || lesson.description || '')}</span>
  </button>`;
}

function avatarCard(a, active) {
  const attrs = a.attributes || {};
  const top = Object.entries(attrs).sort((x, y) => y[1] - x[1]).slice(0, 3);
  return `<div class="tn-avatar-card ${active ? 'active' : ''}">
    <div class="tn-avatar-kit" style="--shirt:${a.shirtColor};--shorts:${a.shortsColor}"></div>
    <strong>${escapeHtml(a.name)}</strong>
    <span class="tn-muted">${a.playstyle || 'all-court'} · ${a.handedness === 'left' ? 'Left' : 'Right'}-handed · ${a.backhand === 'one' ? 'One' : 'Two'}-handed backhand</span>
    <div class="tn-avatar-attrs">${top.map(([k, v]) => `<span>${k} <strong>${v}</strong></span>`).join('')}</div>
    <div class="tn-avatar-actions">
      ${active ? '<span class="tn-badge">Selected</span>' : `<button class="tn-btn tn-btn-ghost tn-btn-sm" data-select="${a.id}">Select</button>`}
      <button class="tn-btn tn-btn-ghost tn-btn-sm" data-edit="${a.id}">Edit</button>
      <button class="tn-btn tn-btn-ghost tn-btn-sm danger" data-delete="${a.id}">Delete</button>
    </div>
  </div>`;
}

function slider(key, label, value) {
  const pct = Math.round(value * 100);
  return `<label class="tn-field tn-slider">
    <span>${label}</span>
    <input type="range" min="0" max="100" value="${pct}" data-slider="${key}">
    <span class="tn-slider-val">${pct}%</span>
  </label>`;
}

function toggle(key, label, checked, hint) {
  return `<label class="tn-field tn-toggle">
    <span>${label}${hint ? `<em>${hint}</em>` : ''}</span>
    <input type="checkbox" ${checked ? 'checked' : ''} data-toggle="${key}">
    <span class="tn-switch"></span>
  </label>`;
}

function stat(label, value) {
  return `<div class="tn-stat"><strong>${value}</strong><span>${label}</span></div>`;
}

function starString(n) {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function pingClass(p) {
  if (!p) return '';
  if (p < 60) return 'good';
  if (p < 130) return 'fair';
  return 'poor';
}

function controlsTable() {
  return `<p class="tn-controls-lead"><strong>Arrows move. Numbers hit. That is it.</strong></p>
  <table class="tn-controls">
    <tbody>${CONTROL_REFERENCE.map(([action, keys, hint]) =>
      action === '—'
        ? '<tr class="tn-controls-gap"><td colspan="3"></td></tr>'
        : `<tr><th>${action}</th><td>${keys.map((k) => `<kbd>${k}</kbd>`).join(' ')}</td><td class="tn-controls-hint">${hint || ''}</td></tr>`
    ).join('')}</tbody>
  </table>
  <p class="tn-note">Every player uses these same controls on their own machine. <strong>Tap</strong> a number for a normal shot, or <strong>hold</strong> it to hit harder. Steer the ball by holding an arrow as you hit — hold left and it goes left. If the timing feels hard, turn on <em>Swing for me</em> in Settings and just steer. The numbers also work on a numeric keypad, and a gamepad works too.</p>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
