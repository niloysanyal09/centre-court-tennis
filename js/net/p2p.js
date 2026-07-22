/**
 * Peer-to-peer online play.
 *
 * ARCHITECTURE: host-authoritative.
 *   The host runs the one true simulation. Guests send input and render what the host
 *   tells them. There is exactly one physics timeline, so the ball can never disagree
 *   about whether it landed in.
 *
 * WHY THAT IS ENOUGH FOR TENNIS: the ball spends most of a point in the air, and you
 * commit to a swing ~145 ms before contact. A 60 ms round trip is comfortably inside
 * the natural timing window of the sport, which is not true of, say, a fighting game.
 *
 * TWO THINGS HIDE THE REMAINING LATENCY:
 *   1. Client-side prediction — the guest moves their own player locally the instant
 *      they press a key, then smoothly reconciles against the host's authoritative
 *      position. Movement feels instant even though it is being confirmed remotely.
 *   2. Snapshot interpolation — everything else renders ~90 ms in the past, blended
 *      between the two nearest host snapshots, so remote players glide instead of
 *      teleporting.
 *
 * SIGNALLING: uses the public PeerJS broker to exchange the WebRTC handshake. Once
 * connected, all gameplay traffic is direct browser-to-browser. If the broker is
 * unreachable the game says so plainly and local play still works.
 */

const ROOM_PREFIX = 'tnnsv1-';
// Ambiguous characters removed: no O/0, no I/1, no S/5.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';
const CODE_LENGTH = 5;

export const NetRole = { NONE: 'none', HOST: 'host', GUEST: 'guest' };
export const NetState = {
  IDLE: 'idle',
  STARTING: 'starting',
  WAITING: 'waiting',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  IN_MATCH: 'in_match',
  ERROR: 'error',
  CLOSED: 'closed',
};

/** How far in the past guests render remote entities, in seconds. */
const INTERP_DELAY = 0.09;
/** Snapshot buffer length. */
const MAX_BUFFER = 24;

export class NetworkManager {
  constructor() {
    this.role = NetRole.NONE;
    this.state = NetState.IDLE;
    this.roomCode = null;
    this.peer = null;
    this.error = null;

    /** Host: map of peerId → { conn, slot, profile, lastInput, ping } */
    this.clients = new Map();
    /** Guest: the connection to the host. */
    this.hostConn = null;

    /** Which player index this machine controls (guests are told by the host). */
    this.localSlots = [0];

    this.profile = { name: 'Player', avatar: null };
    this.lobby = [];          // [{ slot, name, avatar, ready, isHost, ping }]

    this._listeners = new Map();
    this._snapshots = [];     // guest-side interpolation buffer
    this._clock = 0;
    this._lastSnapshotAt = 0;
    this._seq = 0;
    this._pingTimer = 0;
    this._inputAccum = null;

    this._peerLibPromise = null;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, data) {
    const s = this._listeners.get(event);
    if (s) for (const fn of s) { try { fn(data); } catch (e) { console.error(e); } }
  }

  _setState(state, error = null) {
    this.state = state;
    this.error = error;
    this._emit('state', { state, error });
  }

  // ── Library loading ────────────────────────────────────────────────────────

  /**
   * PeerJS ships as a UMD bundle and is vendored into the repo, so there is no
   * runtime CDN dependency. Loaded lazily: a purely local match never touches it.
   */
  async _loadPeerLib() {
    if (window.Peer) return window.Peer;
    if (this._peerLibPromise) return this._peerLibPromise;

    this._peerLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/peerjs.min.js';
      s.async = true;
      s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS failed to initialise')));
      s.onerror = () => reject(new Error('Could not load the networking library'));
      document.head.appendChild(s);
    });
    return this._peerLibPromise;
  }

  // ── Hosting ────────────────────────────────────────────────────────────────

  /**
   * Open a room. Resolves with the room code that other players type in.
   * @param {object} cfg  match configuration shared with joiners
   */
  async host(cfg, profile) {
    this.role = NetRole.HOST;
    this.profile = profile || this.profile;
    this.matchConfig = cfg;
    this._setState(NetState.STARTING);

    const Peer = await this._loadPeerLib().catch((e) => {
      this._setState(NetState.ERROR, e.message);
      throw e;
    });

    // Retry on ID collision — two people can pick the same five characters.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        await this._openPeer(Peer, ROOM_PREFIX + code);
        this.roomCode = code;
        break;
      } catch (e) {
        if (e.type === 'unavailable-id' && attempt < 4) continue;
        this._setState(NetState.ERROR, describePeerError(e));
        throw e;
      }
    }

    this.peer.on('connection', (conn) => this._onClientConnect(conn));

    this.localSlots = [0];
    this.lobby = [{ slot: 0, name: this.profile.name, avatar: this.profile.avatar, isHost: true, ready: true, ping: 0 }];
    this._setState(NetState.WAITING);
    this._emit('lobby', this.lobby);

    return this.roomCode;
  }

  _openPeer(Peer, id) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(id, { debug: 0 });
      const timeout = setTimeout(() => {
        reject(new Error('Timed out reaching the signalling server'));
        try { peer.destroy(); } catch (_) {}
      }, 12000);

      peer.on('open', () => {
        clearTimeout(timeout);
        this.peer = peer;
        peer.on('error', (e) => this._onPeerError(e));
        peer.on('disconnected', () => {
          // The broker link dropped; existing WebRTC connections survive, but no new
          // players can join until it reconnects.
          this._emit('warning', 'Lost contact with the signalling server');
          try { peer.reconnect(); } catch (_) {}
        });
        resolve(peer);
      });

      peer.on('error', (e) => {
        clearTimeout(timeout);
        reject(e);
      });
    });
  }

  _onClientConnect(conn) {
    const maxPlayers = this.matchConfig?.doubles ? 4 : 2;
    const used = new Set(this.lobby.map((l) => l.slot));

    // Find the next free slot.
    let slot = -1;
    for (let i = 0; i < maxPlayers; i++) {
      if (!used.has(i)) { slot = i; break; }
    }

    if (slot < 0) {
      conn.on('open', () => {
        conn.send({ t: 'full' });
        setTimeout(() => conn.close(), 200);
      });
      return;
    }

    conn.on('open', () => {
      this.clients.set(conn.peer, { conn, slot, profile: null, lastInput: null, ping: 0, lastSeen: performance.now() });
      conn.send({ t: 'welcome', slot, cfg: this.matchConfig, host: this.profile });
    });

    conn.on('data', (msg) => this._onHostMessage(conn.peer, msg));

    conn.on('close', () => this._removeClient(conn.peer));
    conn.on('error', () => this._removeClient(conn.peer));
  }

  _onHostMessage(peerId, msg) {
    const client = this.clients.get(peerId);
    if (!client) return;
    client.lastSeen = performance.now();

    switch (msg.t) {
      case 'hello':
        client.profile = msg.profile;
        this._rebuildLobby();
        this._broadcast({ t: 'lobby', lobby: this.lobby });
        break;

      case 'in':
        // Latest input wins; we do not queue, because a stale input is worthless.
        client.lastInput = msg.d;
        client.inputSeq = msg.seq;
        break;

      case 'ready': {
        const entry = this.lobby.find((l) => l.slot === client.slot);
        if (entry) entry.ready = !!msg.ready;
        this._broadcast({ t: 'lobby', lobby: this.lobby });
        this._emit('lobby', this.lobby);
        break;
      }

      case 'ping':
        client.conn.send({ t: 'pong', ts: msg.ts });
        break;

      case 'pong': {
        const rtt = performance.now() - msg.ts;
        client.ping = Math.round(rtt);
        const entry = this.lobby.find((l) => l.slot === client.slot);
        if (entry) entry.ping = client.ping;
        break;
      }

      case 'chat':
        this._emit('chat', { slot: client.slot, text: String(msg.text || '').slice(0, 140) });
        this._broadcast({ t: 'chat', slot: client.slot, text: String(msg.text || '').slice(0, 140) });
        break;
    }
  }

  _removeClient(peerId) {
    const client = this.clients.get(peerId);
    if (!client) return;
    this.clients.delete(peerId);
    this._rebuildLobby();
    this._broadcast({ t: 'lobby', lobby: this.lobby });
    this._emit('lobby', this.lobby);
    this._emit('playerLeft', { slot: client.slot });
  }

  _rebuildLobby() {
    const existing = new Map(this.lobby.map((l) => [l.slot, l]));
    this.lobby = [{
      slot: 0, name: this.profile.name, avatar: this.profile.avatar,
      isHost: true, ready: true, ping: 0,
    }];
    for (const c of this.clients.values()) {
      const prev = existing.get(c.slot);
      this.lobby.push({
        slot: c.slot,
        name: c.profile?.name || 'Player',
        avatar: c.profile?.avatar || null,
        isHost: false,
        ready: prev ? prev.ready : false,
        ping: c.ping,
      });
    }
    this.lobby.sort((a, b) => a.slot - b.slot);
  }

  // ── Joining ────────────────────────────────────────────────────────────────

  async join(code, profile) {
    this.role = NetRole.GUEST;
    this.profile = profile || this.profile;
    this.roomCode = String(code || '').trim().toUpperCase();
    this._setState(NetState.CONNECTING);

    const Peer = await this._loadPeerLib().catch((e) => {
      this._setState(NetState.ERROR, e.message);
      throw e;
    });

    await this._openPeer(Peer, undefined).catch((e) => {
      this._setState(NetState.ERROR, describePeerError(e));
      throw e;
    });

    return new Promise((resolve, reject) => {
      const conn = this.peer.connect(ROOM_PREFIX + this.roomCode, {
        reliable: true,
        serialization: 'json',
      });

      const timeout = setTimeout(() => {
        this._setState(NetState.ERROR, 'No room found with that code');
        reject(new Error('No room found with that code'));
      }, 14000);

      conn.on('open', () => {
        clearTimeout(timeout);
        this.hostConn = conn;
        conn.send({ t: 'hello', profile: this.profile });
        this._setState(NetState.CONNECTED);
        resolve();
      });

      conn.on('data', (msg) => this._onGuestMessage(msg));

      conn.on('close', () => {
        this._setState(NetState.CLOSED, 'The host closed the match');
        this._emit('disconnected', {});
      });

      conn.on('error', () => {
        clearTimeout(timeout);
        this._setState(NetState.ERROR, 'Connection failed');
        reject(new Error('Connection failed'));
      });
    });
  }

  _onGuestMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        this.localSlots = [msg.slot];
        this.matchConfig = msg.cfg;
        this._emit('welcome', { slot: msg.slot, cfg: msg.cfg });
        break;

      case 'full':
        this._setState(NetState.ERROR, 'That match is already full');
        break;

      case 'lobby':
        this.lobby = msg.lobby;
        this._emit('lobby', this.lobby);
        break;

      case 'start':
        this.matchConfig = msg.cfg;
        this._snapshots.length = 0;
        this._setState(NetState.IN_MATCH);
        this._emit('start', msg.cfg);
        break;

      case 'snap':
        this._pushSnapshot(msg.d, msg.ts);
        break;

      case 'ev':
        this._emit('events', msg.d);
        break;

      case 'ping':
        this.hostConn?.send({ t: 'pong', ts: msg.ts });
        break;

      case 'pong':
        this.ping = Math.round(performance.now() - msg.ts);
        break;

      case 'chat':
        this._emit('chat', { slot: msg.slot, text: msg.text });
        break;

      case 'end':
        this._emit('matchEnded', msg.d);
        break;
    }
  }

  // ── Match lifecycle ────────────────────────────────────────────────────────

  /** Host: begin the match for everyone. */
  startMatch(cfg) {
    if (this.role !== NetRole.HOST) return;
    this.matchConfig = cfg;
    this._broadcast({ t: 'start', cfg });
    this._setState(NetState.IN_MATCH);
  }

  /** Host: push authoritative state. Called at SIM.NET_SNAPSHOT_HZ, not every frame. */
  sendSnapshot(snapshot) {
    if (this.role !== NetRole.HOST) return;
    this._broadcast({ t: 'snap', d: snapshot, ts: performance.now() });
  }

  /** Host: forward gameplay events (sounds, calls, announcements) immediately. */
  sendEvents(events) {
    if (this.role !== NetRole.HOST || !events.length) return;
    // Strip anything not needed remotely to keep packets small.
    const slim = events.filter((e) => RELAYED_EVENTS.has(e.type));
    if (slim.length) this._broadcast({ t: 'ev', d: slim });
  }

  /** Guest: send this frame's input. */
  sendInput(input) {
    if (this.role !== NetRole.GUEST || !this.hostConn || this.hostConn.open !== true) return;
    this._seq++;
    this.hostConn.send({ t: 'in', d: compactInput(input), seq: this._seq });
  }

  /** Host: collect the most recent input from every remote player. */
  collectRemoteInputs() {
    const out = {};
    for (const c of this.clients.values()) {
      if (c.lastInput) out[c.slot] = expandInput(c.lastInput);
    }
    return out;
  }

  setReady(ready) {
    if (this.role === NetRole.GUEST) this.hostConn?.send({ t: 'ready', ready });
  }

  sendChat(text) {
    const msg = { t: 'chat', text: String(text).slice(0, 140) };
    if (this.role === NetRole.HOST) {
      this._broadcast({ ...msg, slot: 0 });
      this._emit('chat', { slot: 0, text: msg.text });
    } else {
      this.hostConn?.send(msg);
    }
  }

  _broadcast(msg) {
    for (const c of this.clients.values()) {
      if (c.conn && c.conn.open) {
        try { c.conn.send(msg); } catch (_) { /* connection dying; cleanup handles it */ }
      }
    }
  }

  // ── Snapshot interpolation (guest side) ────────────────────────────────────

  _pushSnapshot(snap, ts) {
    this._snapshots.push({ snap, at: performance.now() });
    while (this._snapshots.length > MAX_BUFFER) this._snapshots.shift();
    this._lastSnapshotAt = performance.now();
  }

  /**
   * Produce the state to render right now, blended between the two host snapshots
   * that bracket (now − INTERP_DELAY).
   *
   * @returns {object|null} an interpolated snapshot, or null if we have nothing yet
   */
  interpolatedState() {
    const buf = this._snapshots;
    if (buf.length === 0) return null;
    if (buf.length === 1) return buf[0].snap;

    const target = performance.now() - INTERP_DELAY * 1000;

    // Find the bracketing pair.
    let a = null, b = null;
    for (let i = buf.length - 1; i > 0; i--) {
      if (buf[i - 1].at <= target && buf[i].at >= target) {
        a = buf[i - 1];
        b = buf[i];
        break;
      }
    }

    // Running ahead of the buffer (packet loss or a stall) — hold the newest state
    // rather than rewinding, which would look like the ball stuttering backwards.
    if (!a || !b) return buf[buf.length - 1].snap;

    const span = b.at - a.at;
    const f = span > 0 ? (target - a.at) / span : 0;
    return lerpSnapshot(a.snap, b.snap, f);
  }

  /** Round-trip time in ms, for the connection indicator. */
  get latency() {
    if (this.role === NetRole.GUEST) return this.ping ?? 0;
    let worst = 0;
    for (const c of this.clients.values()) worst = Math.max(worst, c.ping || 0);
    return worst;
  }

  get connectionQuality() {
    const p = this.latency;
    const stale = performance.now() - this._lastSnapshotAt;
    if (this.role === NetRole.GUEST && stale > 1500) return 'lost';
    if (p < 60) return 'good';
    if (p < 130) return 'fair';
    return 'poor';
  }

  /** Call every frame: keeps ping fresh and drops silent peers. */
  tick(dt) {
    this._pingTimer -= dt;
    if (this._pingTimer <= 0) {
      this._pingTimer = 2;
      const ts = performance.now();
      if (this.role === NetRole.HOST) {
        this._broadcast({ t: 'ping', ts });
        // Drop anyone who has gone quiet for 12 seconds.
        const now = performance.now();
        for (const [id, c] of this.clients) {
          if (now - c.lastSeen > 12000) this._removeClient(id);
        }
      } else if (this.hostConn?.open) {
        this.hostConn.send({ t: 'ping', ts });
      }
    }
  }

  _onPeerError(e) {
    const msg = describePeerError(e);
    if (e.type === 'peer-unavailable') {
      this._setState(NetState.ERROR, 'No room found with that code');
    } else if (e.type === 'network' || e.type === 'server-error') {
      this._emit('warning', msg);
    } else {
      this._setState(NetState.ERROR, msg);
    }
  }

  close() {
    try {
      if (this.role === NetRole.HOST) this._broadcast({ t: 'end', d: {} });
      for (const c of this.clients.values()) { try { c.conn.close(); } catch (_) {} }
      this.hostConn?.close();
      this.peer?.destroy();
    } catch (_) { /* already gone */ }

    this.clients.clear();
    this.hostConn = null;
    this.peer = null;
    this.role = NetRole.NONE;
    this.roomCode = null;
    this._snapshots.length = 0;
    this.lobby = [];
    this._setState(NetState.IDLE);
  }
}

// ── Snapshot blending ────────────────────────────────────────────────────────

const lerp = (a, b, f) => a + (b - a) * f;

function lerpSnapshot(a, b, f) {
  // Discrete fields (state, score, who is serving) always take the newer value —
  // blending them would produce nonsense like a half-scored point.
  const out = {
    t: b.t, st: b.st, sn: b.sn, si: b.si, ri: b.ri,
    s: b.s, w: b.w,
    b: { ...b.b },
    p: [],
  };

  // Ball position blends; velocity takes the newer value so trails point correctly.
  if (a.b && b.b && a.b.ip === b.b.ip) {
    out.b.x = lerp(a.b.x, b.b.x, f);
    out.b.y = lerp(a.b.y, b.b.y, f);
    out.b.z = lerp(a.b.z, b.b.z, f);
  }

  for (let i = 0; i < b.p.length; i++) {
    const pb = b.p[i];
    const pa = a.p.find((q) => q.i === pb.i);
    if (!pa) { out.p.push(pb); continue; }
    out.p.push({
      ...pb,
      x: lerp(pa.x, pb.x, f),
      y: lerp(pa.y, pb.y, f),
      z: lerp(pa.z, pb.z, f),
      f: lerpAngle(pa.f, pb.f, f),
      // Animation phase can wrap from 1 back to 0; blending across the wrap would
      // play the stride backwards, so snap instead.
      p: Math.abs(pb.p - pa.p) > 0.5 ? pb.p : lerp(pa.p, pb.p, f),
    });
  }
  return out;
}

function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

// ── Wire format ──────────────────────────────────────────────────────────────

/** Inputs go out at 60 Hz, so they are packed tightly. */
function compactInput(i) {
  return [
    Math.round((i.moveX || 0) * 100),
    Math.round((i.moveY || 0) * 100),
    (i.sprint ? 1 : 0) | (i.shotDown ? 2 : 0) | (i.shotUp ? 4 : 0) |
      (i.serveAction ? 8 : 0) | (i.splitStep ? 16 : 0),
    SHOT_INDEX[i.shotType] ?? -1,
    Math.round((i.aimX || 0) * 100),
    Math.round((i.aimY || 0) * 100),
  ];
}

function expandInput(a) {
  const flags = a[2] || 0;
  return {
    moveX: (a[0] || 0) / 100,
    moveY: (a[1] || 0) / 100,
    sprint: !!(flags & 1),
    shotDown: !!(flags & 2),
    shotUp: !!(flags & 4),
    serveAction: !!(flags & 8),
    splitStep: !!(flags & 16),
    shotType: SHOT_NAMES[a[3]] ?? null,
    aimX: (a[4] || 0) / 100,
    aimY: (a[5] || 0) / 100,
  };
}

const SHOT_NAMES = ['topspin', 'flat', 'slice', 'lob', 'drop'];
const SHOT_INDEX = Object.fromEntries(SHOT_NAMES.map((n, i) => [n, i]));

/** Events worth the bandwidth to relay: everything that makes a sound or a caption. */
const RELAYED_EVENTS = new Set([
  'hit', 'bounce', 'ballNet', 'netCord', 'ballPost', 'lineCall', 'let',
  'fault', 'doubleFault', 'serveHit', 'serveToss', 'serveIn', 'whiff',
  'pointEnd', 'score', 'matchOver', 'changeover', 'doubleBounce', 'pointSetup',
  'serveReady', 'crossNet',
]);

// ── helpers ──────────────────────────────────────────────────────────────────

function generateCode() {
  let s = '';
  const buf = new Uint8Array(CODE_LENGTH);
  (window.crypto || window.msCrypto).getRandomValues(buf);
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  }
  return s;
}

function describePeerError(e) {
  switch (e?.type) {
    case 'browser-incompatible': return 'This browser does not support peer-to-peer play';
    case 'peer-unavailable':     return 'No room found with that code';
    case 'unavailable-id':       return 'That room code is already taken';
    case 'network':              return 'Could not reach the signalling server. Check your connection.';
    case 'server-error':         return 'The signalling server is unavailable. Try local play, or try again later.';
    case 'ssl-unavailable':      return 'A secure connection is required. Open the game over HTTPS.';
    case 'webrtc':               return 'WebRTC failed. A firewall or VPN may be blocking the connection.';
    default:                     return e?.message || 'Connection error';
  }
}

export { generateCode };
