/**
 * audio.js — fully synthesized audio engine for the tennis game.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SYNTHESIS APPROACH
 * ─────────────────────────────────────────────────────────────────────────────
 * There are ZERO audio assets. Everything is generated at runtime with the Web
 * Audio API. Three primitives do almost all the work:
 *
 *   1. NOISE BURSTS. A few seconds of white/pink noise are rendered into
 *      AudioBuffers once during init(). Every impact sound is a short slice of
 *      that noise pushed through a biquad filter with a fast gain envelope.
 *      Filter type + centre frequency + Q + envelope length is what makes a
 *      "pock" a pock and a net hit a net hit. A real tennis strike is an ~8-14 ms
 *      broadband transient, so these envelopes are extremely short; anything
 *      longer than ~25 ms immediately reads as a mishit or a scrape.
 *
 *   2. PITCHED PARTIALS. Oscillators supply the resonant components: the string
 *      bed ring (450-800 Hz), the body thump (~180 Hz), the net-cord "tink"
 *      (~3 kHz), the inharmonic graphite crack of a frame hit. Resonance is the
 *      single strongest cue for "did I middle it" — a clean hit has a ring, a
 *      mishit has none. quality drives the amplitude of the pitched layer more
 *      than anything else.
 *
 *   3. FILTERED NOISE BEDS. The crowd is not voices. A murmur is pink noise
 *      through a lowpass with slow random LFO modulation; applause is a
 *      pre-rendered buffer of Poisson-distributed 2-4 ms noise claps that gets
 *      re-triggered from a random offset with a swell envelope. Rendering the
 *      claps into one buffer at init() means a stadium ovation costs a single
 *      BufferSourceNode instead of four hundred of them.
 *
 * Space comes from a ConvolverNode fed a procedurally generated impulse response
 * (decaying noise + sparse early reflections, one-pole lowpassed to taste). The
 * IR is rebuilt per venue: length and darkness scale with the size of the bowl,
 * an enclosed arena gets a shorter but brighter and wetter tail, a practice
 * court is nearly dry. Sfx and crowd have independent sends into it.
 *
 * Officiating uses window.speechSynthesis (no assets, real voice), with a
 * synthesized two-tone attention beep as the fallback when speech is missing.
 *
 * BUDGET: nodes are created per event and released when their envelope finishes;
 * nothing is pooled or retained except the ambience bed, active slides and the
 * shared buffers. A voice cap (MAX_VOICES) drops new one-shots rather than
 * letting a 60 fps game loop bury the audio thread.
 *
 * Every public method is wrapped so a failure degrades to silence, never a throw.
 */

import { SPEEDS, SPIN, PLAYER } from '../sim/constants.js';
import { getSurface } from '../data/surfaces.js';

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(Number.isFinite(v) ? v : 0, 0, 1);
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;

/** Hash a string to a stable 0..1 so a given voiceId always grunts the same. */
function hash01(str) {
  let h = 2166136261;
  const s = String(str == null ? 'default' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Maximum simultaneous one-shot voices before new sounds are dropped. */
const MAX_VOICES = 24;
/** Priority sounds (hits, calls) may overshoot the cap by this much. */
const PRIORITY_HEADROOM = 6;

/** Public methods that get the try/catch guard. */
const GUARDED = [
  'init', 'resume', 'setVenue', 'setSurface', 'setVolumes', 'setMuted',
  'hit', 'bounce', 'netCord', 'netHit', 'frameHit', 'whiff', 'bounceOffGround',
  'footstep', 'slide', 'stopSlide', 'grunt',
  'call', 'announceScore',
  'crowd', 'startAmbience', 'stopAmbience',
  'dispose',
];

/** Language preferences per venue umpireVoice tag, best match first. */
const VOICE_PREFS = {
  british:    { langs: ['en-GB', 'en_GB', 'en-IE'], names: ['daniel', 'kate', 'serena', 'oliver', 'arthur'] },
  french:     { langs: ['fr-FR', 'fr_FR', 'fr-CA'], names: ['thomas', 'amelie', 'aurelie', 'audrey'] },
  american:   { langs: ['en-US', 'en_US'],          names: ['alex', 'samantha', 'fred', 'victoria'] },
  australian: { langs: ['en-AU', 'en_AU', 'en-NZ'], names: ['karen', 'lee', 'catherine'] },
  neutral:    { langs: ['en-US', 'en-GB', 'en'],    names: [] },
};

// ─────────────────────────────────────────────────────────────────────────────

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this._ready = false;
    this._initPromise = null;
    this._disposed = false;
    this._muted = false;
    this._errCount = 0;

    this._vol = { master: 0.9, sfx: 1.0, crowd: 0.75, voice: 0.9 };

    this.surface = getSurface('hard_us');
    this.venue = null;
    this._crowdVolume = 0.7;
    this._crowdEnthusiasm = 0.6;
    this._umpireVoice = 'neutral';
    this._reverb = { seconds: 1.6, decay: 2.4, brightness: 0.55, wet: 0.22, sfxSend: 0.5, crowdSend: 0.85 };

    // Runtime state
    this._voices = 0;
    this._slides = new Map();
    this._slideSeq = 0;
    this._ambience = null;
    this._ambienceTarget = 0;
    this._irCache = new Map();
    this._voiceList = [];
    this._pickedVoice = null;
    this._speech = null;
    this._resumePending = false;

    // Bind guards so no public entry point can throw into the game loop.
    for (const name of GUARDED) {
      const orig = this[name];
      if (typeof orig !== 'function') continue;
      this[name] = (...args) => {
        try {
          const r = orig.apply(this, args);
          if (r && typeof r.then === 'function') {
            return r.then(undefined, (err) => { this._fail(name, err); return false; });
          }
          return r;
        } catch (err) {
          this._fail(name, err);
          return undefined;
        }
      };
    }
  }

  get ready() {
    return this._ready && !this._disposed && !!this.ctx;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create the AudioContext and build every shared buffer. Must be called from a
   * user gesture (click / keydown) or the context stays suspended on Safari and
   * Chrome. Safe to call repeatedly — subsequent calls just resume.
   */
  async init() {
    if (this._disposed) return false;
    if (this._initPromise) {
      await this._initPromise;
      this.resume();
      return this._ready;
    }
    this._initPromise = this._doInit();
    await this._initPromise;
    return this._ready;
  }

  async _doInit() {
    const Ctor = (typeof window !== 'undefined')
      ? (window.AudioContext || window.webkitAudioContext)
      : null;
    if (!Ctor) return false;

    this.ctx = new Ctor();

    // Resume immediately: if init() came from a gesture this unlocks audio now.
    try { await this.ctx.resume(); } catch (_) { /* stays suspended, fine */ }

    const ctx = this.ctx;

    // ── Bus graph ────────────────────────────────────────────────────────────
    // The compressor is a safety limiter: a smash landing on top of applause and
    // a crowd swell can easily sum past 0 dBFS and hard-clip.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : this._vol.master;
    this.master.connect(this.limiter);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this._vol.sfx;
    this.sfxBus.connect(this.master);

    this.crowdBus = ctx.createGain();
    this.crowdBus.gain.value = this._vol.crowd;
    this.crowdBus.connect(this.master);

    this.voiceBus = ctx.createGain(); // only used by the fallback attention tone
    this.voiceBus.gain.value = this._vol.voice;
    this.voiceBus.connect(this.master);

    this.convolver = ctx.createConvolver();
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = this._reverb.wet;
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.master);

    this.sfxSend = ctx.createGain();
    this.sfxSend.gain.value = this._reverb.sfxSend;
    this.sfxBus.connect(this.sfxSend);
    this.sfxSend.connect(this.convolver);

    this.crowdSend = ctx.createGain();
    this.crowdSend.gain.value = this._reverb.crowdSend;
    this.crowdBus.connect(this.crowdSend);
    this.crowdSend.connect(this.convolver);

    // ── Shared buffers (generated ONCE) ──────────────────────────────────────
    this._whiteBuf = this._makeWhiteBuffer(2.0);
    this._pinkBuf = this._makePinkBuffer(4.0);      // seamless loop for the murmur bed
    this._applauseBuf = this._makeApplauseBuffer(3.5);
    this._satCurve = this._makeSaturationCurve(2.6); // smash/serve soft clip
    this._hardCurve = this._makeSaturationCurve(6.0); // frame hit nastiness

    this.convolver.buffer = this._getIR(this._reverb);

    this._initSpeech();

    this._ready = true;
    return true;
  }

  /** Resume a context suspended by the browser's autoplay policy. */
  resume() {
    if (!this.ctx || this._disposed) return;
    if (this.ctx.state === 'suspended') {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
  }

  dispose() {
    this._disposed = true;
    try { this.stopAmbience(); } catch (_) {}
    for (const h of Array.from(this._slides.values())) {
      try { this._killSlide(h); } catch (_) {}
    }
    this._slides.clear();
    try {
      if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (_) {}
    if (this._voicesChangedHandler && typeof window !== 'undefined' && window.speechSynthesis) {
      try { window.speechSynthesis.removeEventListener('voiceschanged', this._voicesChangedHandler); } catch (_) {}
      this._voicesChangedHandler = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      try { this.master && this.master.disconnect(); } catch (_) {}
      try { if (ctx.close) ctx.close(); } catch (_) {}
    }
    this._ready = false;
    this.ctx = null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Configuration
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Take reverb size and crowd character from a venue object.
   * Reads (all optional, all defensively defaulted): crowdVolume,
   * crowdEnthusiasm, umpireVoice, capacity/seats, indoor/roof, reverbSeconds.
   */
  setVenue(venue) {
    this.venue = venue || null;
    const v = venue || {};

    this._crowdVolume = Number.isFinite(v.crowdVolume) ? clamp01(v.crowdVolume) : 0.7;
    this._crowdEnthusiasm = Number.isFinite(v.crowdEnthusiasm) ? clamp01(v.crowdEnthusiasm) : 0.6;
    this._umpireVoice = VOICE_PREFS[v.umpireVoice] ? v.umpireVoice : 'neutral';
    this._pickedVoice = null; // force re-selection against the new accent

    this._reverb = this._reverbParamsFor(v);

    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.convolver.buffer = this._getIR(this._reverb);
    this._ramp(this.wetGain.gain, this._reverb.wet, t, 0.25);
    this._ramp(this.sfxSend.gain, this._reverb.sfxSend, t, 0.25);
    this._ramp(this.crowdSend.gain, this._reverb.crowdSend, t, 0.25);

    // A bigger, fuller house murmurs louder.
    if (this._ambience) {
      this._ambienceTarget = 0.16 * this._crowdVolume;
      this._ramp(this._ambience.gain.gain, this._ambienceTarget, t, 1.2);
    }
  }

  /**
   * Derive reverb geometry from whatever the venue object happens to expose.
   * A 23k-seat open bowl at night is long and dark; a sealed indoor arena is
   * shorter but brighter and much wetter (hard walls, low ceiling, no sky to
   * swallow the energy); a practice court is essentially dry.
   */
  _reverbParamsFor(v) {
    const indoor = v.indoor === true || v.roof === 'closed' || v.roofClosed === true ||
      v.surface === 'indoor' || v.surfaceId === 'indoor' || /indoor|arena/i.test(String(v.id || v.name || ''));
    const practice = /practice|club|park/i.test(String(v.id || v.name || ''));

    let seconds;
    if (Number.isFinite(v.reverbSeconds)) seconds = v.reverbSeconds;
    else if (v.reverb && Number.isFinite(v.reverb.seconds)) seconds = v.reverb.seconds;
    else if (Number.isFinite(v.reverbSize)) seconds = lerp(0.4, 2.9, clamp01(v.reverbSize));
    else {
      const cap = Number.isFinite(v.capacity) ? v.capacity
        : Number.isFinite(v.seats) ? v.seats
        : Number.isFinite(v.seatingCapacity) ? v.seatingCapacity : null;
      if (cap != null) seconds = clamp(0.45 + (cap / 23000) * 2.3, 0.4, 2.9);
      else if (practice) seconds = 0.4;
      else if (indoor) seconds = 1.35;
      else seconds = 1.7;
    }
    seconds = clamp(seconds, 0.25, 3.2);

    // Indoors: less air absorption, so the tail keeps its highs and decays flatter.
    const brightness = indoor ? 0.78 : clamp(0.72 - seconds * 0.12, 0.28, 0.7);
    const decay = indoor ? 1.9 : lerp(3.2, 2.0, clamp01((seconds - 0.4) / 2.5));
    const size01 = clamp01((seconds - 0.4) / 2.5);

    return {
      seconds,
      decay,
      brightness,
      wet: practice ? 0.07 : clamp(lerp(0.12, 0.3, size01) + (indoor ? 0.1 : 0), 0.05, 0.42),
      sfxSend: practice ? 0.25 : clamp(lerp(0.35, 0.62, size01) + (indoor ? 0.1 : 0), 0.2, 0.8),
      crowdSend: practice ? 0.3 : clamp(lerp(0.6, 1.0, size01), 0.3, 1.0),
    };
  }

  setSurface(surfaceId) {
    this.surface = getSurface(surfaceId);
  }

  /** Any subset of { master, sfx, crowd, voice }, each 0..1. */
  setVolumes(vols) {
    if (!vols || typeof vols !== 'object') return;
    for (const k of ['master', 'sfx', 'crowd', 'voice']) {
      if (Number.isFinite(vols[k])) this._vol[k] = clamp01(vols[k]);
    }
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._ramp(this.master.gain, this._muted ? 0 : this._vol.master, t, 0.06);
    this._ramp(this.sfxBus.gain, this._vol.sfx, t, 0.06);
    this._ramp(this.crowdBus.gain, this._vol.crowd, t, 0.06);
    this._ramp(this.voiceBus.gain, this._vol.voice, t, 0.06);
  }

  setMuted(muted) {
    this._muted = !!muted;
    if (this._muted) {
      try {
        if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
      } catch (_) {}
    }
    if (!this.ready) return;
    this._ramp(this.master.gain, this._muted ? 0 : this._vol.master, this.ctx.currentTime, 0.04);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ball / racket events
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The core racket strike.
   * @param {object} opts
   *   type    'flat'|'topspin'|'slice'|'serve'|'volley'|'smash'|'drop'|'lob'|'block'
   *   power   0..1
   *   quality 0..1 timing quality — the dominant parameter. <0.35 is a mishit.
   *   spin    rad/s signed (+ topspin, - slice)
   *   height  contact height in metres
   */
  hit(opts) {
    if (!this._gate()) return;
    const o = opts || {};
    const type = typeof o.type === 'string' ? o.type : 'flat';
    const power = clamp01(Number.isFinite(o.power) ? o.power : 0.6);
    const quality = clamp01(Number.isFinite(o.quality) ? o.quality : 0.85);
    const spin = Number.isFinite(o.spin) ? o.spin : 0;
    const height = Number.isFinite(o.height) ? o.height : PLAYER.CONTACT_HEIGHT_COMFORT;

    const mishit = quality < 0.35;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.001;

    // Per-type character. len = noise transient length, cf = bandpass centre,
    // ring = amplitude of the string-bed partial, lvl = overall level.
    let cf, len, Q, lvl, ringAmt, ringBase, thumpF, thumpAmt, sat = null, snap = 0, brush = 0;

    switch (type) {
      case 'smash':
        // The most violent sound in the game: low centre, long-ish body, saturated.
        cf = 780; len = 0.016; Q = 0.9; lvl = 1.0;
        ringAmt = 0.5; ringBase = 430; thumpF = 96; thumpAmt = 1.0;
        sat = this._satCurve; snap = 0.45; brush = 0.1;
        break;
      case 'serve':
        // Like a smash but cleaner, with a distinct high-frequency snap on top.
        cf = 1150; len = 0.012; Q = 1.1; lvl = 0.95;
        ringAmt = 0.62; ringBase = 520; thumpF = 130; thumpAmt = 0.72;
        sat = this._satCurve; snap = 0.7; brush = 0.12;
        break;
      case 'slice':
        // Short, dry, high, quiet, with the ball skidding across the string bed.
        cf = 1750; len = 0.007; Q = 1.6; lvl = 0.6;
        ringAmt = 0.3; ringBase = 690; thumpF = 200; thumpAmt = 0.25;
        snap = 0.2; brush = 0.55;
        break;
      case 'volley':
        cf = 1250; len = 0.008; Q = 1.5; lvl = 0.66;
        ringAmt = 0.34; ringBase = 610; thumpF = 175; thumpAmt = 0.4;
        snap = 0.2; brush = 0.06;
        break;
      case 'block':
        // Absorbing pace: no swing, so almost no ring and a duller centre.
        cf = 900; len = 0.010; Q = 1.1; lvl = 0.55;
        ringAmt = 0.18; ringBase = 540; thumpF = 165; thumpAmt = 0.42;
        brush = 0.08;
        break;
      case 'drop':
        cf = 820; len = 0.011; Q = 1.0; lvl = 0.38;
        ringAmt = 0.16; ringBase = 560; thumpF = 170; thumpAmt = 0.22;
        brush = 0.3;
        break;
      case 'lob':
        cf = 880; len = 0.013; Q = 0.95; lvl = 0.6;
        ringAmt = 0.42; ringBase = 470; thumpF = 155; thumpAmt = 0.6;
        brush = 0.2;
        break;
      case 'topspin':
        // Brushed contact: slightly longer transient and more noise texture.
        cf = 1000; len = 0.012; Q = 1.15; lvl = 0.85;
        ringAmt = 0.6; ringBase = 490; thumpF = 178; thumpAmt = 0.7;
        brush = 0.4;
        break;
      case 'flat':
      default:
        cf = 1150; len = 0.010; Q = 1.25; lvl = 0.9;
        ringAmt = 0.72; ringBase = 505; thumpF = 182; thumpAmt = 0.75;
        snap = 0.18; brush = 0.12;
        break;
    }

    // Power: louder, brighter transient.
    cf *= lerp(0.86, 1.22, power);
    lvl *= lerp(0.45, 1.0, 0.25 + power * 0.75);

    // Quality: a flushed ball is tight and resonant; a mishit is dull and long.
    if (mishit) {
      const m = quality / 0.35;                 // 0 = catastrophic, 1 = borderline
      cf = lerp(300, 520, m);                   // collapse toward the dead zone
      Q = 0.6;                                  // broad = no focus, no pop
      len = lerp(0.075, 0.038, m);              // smeared, not a transient
      ringAmt *= 0.06 * m;                      // the ring is what's missing
      thumpAmt *= lerp(0.35, 0.7, m);
      lvl *= lerp(0.42, 0.68, m);
      brush = Math.max(brush, 0.25);
      snap = 0;
      sat = null;
    } else {
      const q = (quality - 0.35) / 0.65;         // 0..1 across the good range
      cf *= lerp(0.82, 1.06, q);
      Q *= lerp(0.75, 1.45, q);                  // tighter = more "pop"
      len *= lerp(1.5, 1.0, q);
      ringAmt *= lerp(0.25, 1.0, q * q);         // resonance is the sweet-spot cue
      lvl *= lerp(0.6, 1.0, q);
    }

    // Contact height: overhead contact is brighter and has less body; a dug-out
    // low ball is darker and thuddier.
    const hN = clamp01((height - PLAYER.CONTACT_HEIGHT_LOW) /
      (PLAYER.CONTACT_HEIGHT_HIGH - PLAYER.CONTACT_HEIGHT_LOW));
    cf *= lerp(0.9, 1.12, hN);
    thumpAmt *= lerp(1.15, 0.8, hN);

    // Spin: heavy brushing adds noise texture; backspin skews it drier/higher.
    const spinN = clamp01(Math.abs(spin) / SPIN.MAX);
    brush = clamp(brush + spinN * 0.35, 0, 1);
    const brushF = spin < 0 ? 3400 : 2300;

    const total = Math.max(len, 0.02) + (mishit ? 0.06 : 0.16);
    if (!this._take(total, 1)) return;

    const dest = sat ? this._saturator(sat, lerp(0.55, 0.9, power)) : this.sfxBus;
    const out = dest.node || dest;

    // 1. Broadband transient — the body of the "POCK".
    this._noise(t0, len, {
      type: 'bandpass', freq: cf, Q, gain: 0.85 * lvl,
      attack: 0.0006, dest: out,
      endFreq: mishit ? cf * 0.72 : cf * 0.9,
    });

    // 2. String-bed ring. Frequency rises with power because a harder strike
    //    excites the bed higher up, but it glides DOWN through the ring as the
    //    strings, deflected deeper, relax back — that glide is the "pock" tail.
    if (ringAmt > 0.02) {
      const f = (ringBase + 330 * power) * rand(0.96, 1.05);
      const ringDur = 0.045 + 0.085 * quality;
      this._tone(t0 + 0.0008, ringDur, {
        type: 'triangle', freq: f, endFreq: f * lerp(0.94, 0.86, power),
        gain: 0.3 * ringAmt * lvl, attack: 0.0012, dest: out,
      });
      // A quiet second partial keeps it from sounding like a test tone.
      this._tone(t0 + 0.001, ringDur * 0.55, {
        type: 'sine', freq: f * 2.41, gain: 0.09 * ringAmt * lvl, attack: 0.001, dest: out,
      });
    }

    // 3. Body thump — the racket frame and the ball's own mass.
    if (thumpAmt > 0.02) {
      const tf = (mishit ? thumpF * 0.7 : thumpF) * rand(0.94, 1.07);
      this._tone(t0, 0.045 + 0.03 * power, {
        type: 'sine', freq: tf, endFreq: tf * 0.7,
        gain: 0.34 * thumpAmt * lvl * lerp(0.5, 1.0, power), attack: 0.0015, dest: out,
      });
    }

    // 4. High snap: the crack above the fundamental that sells a big serve.
    if (snap > 0.02) {
      this._noise(t0, 0.0055, {
        type: 'highpass', freq: 4200, Q: 0.7,
        gain: 0.3 * snap * lvl, attack: 0.0004, dest: out,
      });
    }

    // 5. Brushed texture: the ball dragging across the strings.
    if (brush > 0.03) {
      this._noise(t0 + 0.002, 0.03 + 0.05 * brush, {
        type: 'bandpass', freq: brushF, Q: 0.9,
        gain: 0.09 * brush * lvl, attack: 0.004, dest: out,
      });
    }
  }

  /** Ball bounce on the court. opts: { speed, surfaceId, onLine } */
  bounce(opts) {
    if (!this._gate()) return;
    const o = opts || {};
    const surf = o.surfaceId ? getSurface(o.surfaceId) : this.surface;
    const speed = Number.isFinite(o.speed) ? o.speed : SPEEDS.GROUNDSTROKE_TYPICAL;
    const v = clamp01(speed / SPEEDS.SERVE_FIRST_MAX);
    const lvl = lerp(0.16, 0.8, Math.pow(v, 0.7));

    if (!this._take(0.16, 0)) return;
    const t0 = this.ctx.currentTime + 0.001;
    const tone = surf.bounceTone || 'crisp';

    let cf, len, Q, ringF, ringAmt, grit;
    switch (tone) {
      case 'sharp':  // indoor hard: the tightest, brightest tick of the lot
        cf = 2000; len = 0.014; Q = 1.9; ringF = 1100; ringAmt = 0.34; grit = 0; break;
      case 'muted':  // grass: soft, low and short, the ball skids more than it bites
        cf = 760;  len = 0.024; Q = 0.9; ringF = 520;  ringAmt = 0.14; grit = 0.12; break;
      case 'dull':   // clay: lowest, with a gritty tail as the ball scuffs the topdressing
        cf = 470;  len = 0.032; Q = 0.75; ringF = 360; ringAmt = 0.08; grit = 0.5; break;
      case 'crisp':
      default:
        cf = 1550; len = 0.017; Q = 1.6; ringF = 950;  ringAmt = 0.3; grit = 0.05; break;
    }

    // Faster ball = brighter, tighter contact patch.
    cf *= lerp(0.8, 1.3, v);
    len *= lerp(1.25, 0.85, v);

    if (o.onLine) {
      // Paint is harder and flatter than the surrounding surface: less resonance,
      // more of a bare tick. This is the audible tell for a line-clipping shot.
      cf *= 1.18;
      Q *= 0.8;
      len *= 0.8;
      ringAmt *= 0.5;
      grit *= 0.4;
      this._noise(t0, 0.004, {
        type: 'highpass', freq: 3200, Q: 0.7, gain: 0.22 * lvl, attack: 0.0004,
      });
    }

    this._noise(t0, len, {
      type: 'bandpass', freq: cf, Q, gain: 0.7 * lvl, attack: 0.0006, endFreq: cf * 0.75,
    });

    if (ringAmt > 0.02) {
      const f = ringF * rand(0.93, 1.08);
      this._tone(t0, 0.03 + 0.02 * v, {
        type: 'sine', freq: f, endFreq: f * 0.85, gain: 0.18 * ringAmt * lvl, attack: 0.001,
      });
    }

    // Low thump: the court itself responding.
    this._tone(t0, 0.05, {
      type: 'sine', freq: rand(120, 150), endFreq: 85,
      gain: 0.14 * lvl * (tone === 'dull' ? 1.3 : 1.0), attack: 0.002,
    });

    if (grit > 0.05) {
      this._noise(t0 + 0.004, 0.06 + 0.05 * grit, {
        type: 'bandpass', freq: 2600, Q: 0.7, gain: 0.055 * grit * lvl, attack: 0.006,
      });
    }
  }

  /** Ball clips the net tape and trickles over. opts: { speed } */
  netCord(opts) {
    if (!this._gate()) return;
    if (!this._take(0.7, 1)) return;
    const o = opts || {};
    const v = clamp01((Number.isFinite(o.speed) ? o.speed : 25) / SPEEDS.GROUNDSTROKE_MAX);
    const t0 = this.ctx.currentTime + 0.001;
    const lvl = lerp(0.4, 0.9, v);

    // The tell: the tape is a taut vinyl-covered cable, so it rings THIN and HIGH
    // rather than thudding. Two close inharmonic partials give it the metallic edge.
    const f = rand(2750, 3250);
    this._tone(t0, 0.09, { type: 'triangle', freq: f, endFreq: f * 0.93, gain: 0.3 * lvl, attack: 0.0007 });
    this._tone(t0, 0.06, { type: 'sine', freq: f * 1.47, gain: 0.13 * lvl, attack: 0.0007 });
    this._noise(t0, 0.004, { type: 'highpass', freq: 3800, Q: 0.8, gain: 0.28 * lvl, attack: 0.0004 });

    // Then the ball drops off the tape and settles: soft, dark, unhurried.
    const t1 = t0 + 0.1 + rand(0, 0.06);
    this._noise(t1, 0.05, { type: 'lowpass', freq: 620, Q: 0.7, gain: 0.16 * lvl, attack: 0.003 });
    this._tone(t1, 0.06, { type: 'sine', freq: 150, endFreq: 100, gain: 0.1 * lvl, attack: 0.003 });

    // A faint mesh shiver behind it.
    this._noise(t0 + 0.012, 0.16, { type: 'bandpass', freq: 1500, Q: 1.2, gain: 0.045 * lvl, attack: 0.01 });
  }

  /** Ball buried into the net. opts: { speed } */
  netHit(opts) {
    if (!this._gate()) return;
    if (!this._take(0.28, 0)) return;
    const o = opts || {};
    const v = clamp01((Number.isFinite(o.speed) ? o.speed : 25) / SPEEDS.GROUNDSTROKE_MAX);
    const t0 = this.ctx.currentTime + 0.001;
    const lvl = lerp(0.3, 0.85, v);

    // Almost all the energy is absorbed by the mesh, so: low-mid, no resonance,
    // and a decay short enough that it reads as "dead" rather than "muffled".
    this._noise(t0, 0.055, {
      type: 'bandpass', freq: lerp(260, 400, v), Q: 0.65,
      gain: 0.6 * lvl, attack: 0.0015, endFreq: 190,
    });
    this._tone(t0, 0.05, { type: 'sine', freq: 118, endFreq: 78, gain: 0.22 * lvl, attack: 0.003 });

    // Nylon rattle: a handful of tiny bright ticks as the cords slap each other.
    const ticks = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < ticks; i++) {
      this._noise(t0 + 0.008 + Math.random() * 0.07, 0.0035, {
        type: 'highpass', freq: rand(2400, 4200), Q: 0.8,
        gain: 0.05 * lvl * rand(0.4, 1.0), attack: 0.0004,
      });
    }
  }

  /** Shanked off the racket frame. opts: { power } */
  frameHit(opts) {
    if (!this._gate()) return;
    if (!this._take(0.2, 1)) return;
    const o = opts || {};
    const p = clamp01(Number.isFinite(o.power) ? o.power : 0.6);
    const t0 = this.ctx.currentTime + 0.001;
    const lvl = lerp(0.45, 1.0, p);
    const out = this._saturator(this._hardCurve, 0.55).node;

    // Graphite is stiff and thin-walled: the crack sits 2.5-4 kHz, and the two
    // partials are deliberately at an irrational ratio so it beats unpleasantly.
    const f = rand(2600, 3900);
    this._noise(t0, 0.008, { type: 'bandpass', freq: f, Q: 3.2, gain: 0.7 * lvl, attack: 0.0004, dest: out });
    this._tone(t0, 0.035, { type: 'square', freq: f, endFreq: f * 0.88, gain: 0.16 * lvl, attack: 0.0005, dest: out });
    this._tone(t0, 0.03, { type: 'square', freq: f * 1.618, gain: 0.09 * lvl, attack: 0.0005, dest: out });
    // A tiny bit of low so it still feels like the ball was struck, not just the frame.
    this._tone(t0, 0.03, { type: 'sine', freq: 210, endFreq: 150, gain: 0.12 * lvl, attack: 0.002 });
    // No ring, no sustain — that absence is the point.
  }

  /** Swung and missed entirely: pure air. */
  whiff(opts) {
    if (!this._gate()) return;
    if (!this._take(0.3, 0)) return;
    const o = opts || {};
    const p = clamp01(Number.isFinite(o.power) ? o.power : 0.7);
    const t0 = this.ctx.currentTime + 0.001;
    const dur = lerp(0.22, 0.14, p);
    // Doppler-ish swoosh: the band sweeps down as the racket head passes.
    this._noise(t0, dur, {
      type: 'bandpass', freq: lerp(900, 1500, p), endFreq: 380, Q: 1.1,
      gain: 0.12 * lerp(0.6, 1.0, p), attack: dur * 0.42,
    });
    this._noise(t0, dur * 0.8, {
      type: 'highpass', freq: 2600, Q: 0.7, gain: 0.035 * p, attack: dur * 0.4,
    });
  }

  /** Ball dying after the point: a few decaying bounces, then a roll. */
  bounceOffGround(opts) {
    if (!this._gate()) return;
    if (!this._take(2.0, 0)) return;
    const o = opts || {};
    const surf = o.surfaceId ? getSurface(o.surfaceId) : this.surface;
    const tone = surf.bounceTone || 'crisp';
    const t0 = this.ctx.currentTime + 0.001;
    let lvl = clamp01(Number.isFinite(o.intensity) ? o.intensity : 0.5) * 0.6 + 0.12;

    // Geometric bounce series: intervals shrink by the coefficient of restitution,
    // which is exactly what makes a dropped ball sound like a dropped ball.
    let t = t0;
    let gap = 0.42 * surf.restitution;
    const n = 5 + Math.floor(Math.random() * 3);
    const cfBase = tone === 'dull' ? 470 : tone === 'muted' ? 700 : 1400;
    for (let i = 0; i < n; i++) {
      this._noise(t, 0.016 * lerp(1.4, 0.9, i / n), {
        type: 'bandpass', freq: cfBase * rand(0.9, 1.15), Q: 1.3,
        gain: 0.5 * lvl, attack: 0.0006,
      });
      this._tone(t, 0.03, { type: 'sine', freq: rand(120, 160), endFreq: 90, gain: 0.1 * lvl, attack: 0.002 });
      t += gap;
      gap *= surf.restitution;
      lvl *= 0.62;
      if (gap < 0.02 || lvl < 0.02) break;
    }

    // ...then it stops bouncing and rolls. Low, continuous, surface-flavoured.
    const rollF = tone === 'dull' ? 240 : tone === 'muted' ? 320 : 420;
    this._noise(t, 0.55, {
      type: 'bandpass', freq: rollF, endFreq: rollF * 0.5, Q: 1.6,
      gain: 0.055 * (tone === 'dull' ? 1.4 : 1.0), attack: 0.03,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Movement
  // ───────────────────────────────────────────────────────────────────────────

  /** opts: { surfaceId, intensity } */
  footstep(opts) {
    if (!this._gate()) return;
    const o = opts || {};
    const surf = o.surfaceId ? getSurface(o.surfaceId) : this.surface;
    const it = clamp01(Number.isFinite(o.intensity) ? o.intensity : 0.6);
    if (it < 0.03) return;
    if (!this._take(0.28, 0)) return;

    // Small random offset so a sprint never lands on a perfect grid — a metronomic
    // footfall is the fastest way to make a running player sound synthetic.
    const t0 = this.ctx.currentTime + 0.001 + Math.random() * 0.012;
    const lvl = lerp(0.12, 0.5, it) * rand(0.82, 1.18);
    const pitch = rand(0.86, 1.16);
    const tone = surf.footstepTone || 'squeak';

    if (tone === 'squeak') {
      // Rubber sticking and releasing on acrylic: a narrow resonance that bends up
      // as the shoe loads, then falls away as it breaks free.
      const f = rand(1500, 2500) * pitch;
      const dur = lerp(0.07, 0.17, it);
      this._noise(t0, dur, {
        type: 'bandpass', freq: f, Q: 11 + it * 8,
        gain: 0.55 * lvl, attack: 0.006, bend: [f * 1.32, 0.25, f * 0.72],
      });
      // The shoe still has to land: a dull low thud underneath the squeal.
      this._noise(t0, 0.02, { type: 'lowpass', freq: 320, Q: 0.7, gain: 0.4 * lvl, attack: 0.002 });
    } else if (tone === 'gritty') {
      // Clay: crushed brick under the sole. Broadband scrape, no pitch.
      this._noise(t0, lerp(0.05, 0.11, it), {
        type: 'bandpass', freq: rand(900, 1900) * pitch, Q: 1.3,
        gain: 0.5 * lvl, attack: 0.004, endFreq: 700,
      });
      this._noise(t0, 0.03, { type: 'lowpass', freq: 260, Q: 0.7, gain: 0.35 * lvl, attack: 0.003 });
    } else {
      // Grass: turf and soil absorb almost everything above 500 Hz.
      this._noise(t0, lerp(0.04, 0.075, it), {
        type: 'lowpass', freq: rand(340, 520) * pitch, Q: 0.9,
        gain: 0.55 * lvl, attack: 0.004,
      });
      this._tone(t0, 0.05, { type: 'sine', freq: rand(80, 105), endFreq: 60, gain: 0.16 * lvl, attack: 0.004 });
    }
  }

  /**
   * Start a continuous slide scrape. Returns a handle to pass to stopSlide().
   * The handle also exposes update(intensity) so a slide can breathe over its life.
   * opts: { surfaceId, intensity }
   */
  slide(opts) {
    if (!this._gate()) return null;
    const o = opts || {};
    const surf = o.surfaceId ? getSurface(o.surfaceId) : this.surface;
    const it = clamp01(Number.isFinite(o.intensity) ? o.intensity : 0.6);
    if (this._slides.size >= 4) return null;

    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this._whiteBuf;
    src.loop = true;
    src.playbackRate.value = rand(0.9, 1.1);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // Clay slides wide and dark; hard-court slides are shorter and squeakier.
    const clayness = clamp01(surf.slideFactor != null ? surf.slideFactor : 0.5);
    bp.frequency.value = lerp(2200, 900, clayness) * lerp(0.75, 1.15, it);
    bp.Q.value = lerp(2.4, 0.9, clayness);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lerp(1800, 5200, it);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(this._slideLevel(it, clayness), t0 + 0.05);

    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(this.sfxBus);
    src.start(t0, Math.random() * 1.0);

    const id = ++this._slideSeq;
    const handle = {
      id, src, gain: g, bp, lp, clayness,
      update: (nextIntensity) => {
        try {
          const ni = clamp01(nextIntensity);
          const t = this.ctx.currentTime;
          this._ramp(g.gain, this._slideLevel(ni, clayness), t, 0.08);
          this._ramp(lp.frequency, lerp(1800, 5200, ni), t, 0.08);
        } catch (_) {}
      },
    };
    this._slides.set(id, handle);

    // Hard safety net: a slide that never gets stopped still dies after 4 s.
    handle._timer = setTimeout(() => { try { this.stopSlide(handle); } catch (_) {} }, 4000);
    return handle;
  }

  _slideLevel(intensity, clayness) {
    return lerp(0.02, 0.16, intensity) * lerp(0.55, 1.0, clayness);
  }

  stopSlide(handle) {
    if (!handle) return;
    const h = (typeof handle === 'object') ? handle : this._slides.get(handle);
    if (!h || !this.ctx) return;
    this._killSlide(h);
  }

  _killSlide(h) {
    if (h._timer) { clearTimeout(h._timer); h._timer = null; }
    this._slides.delete(h.id);
    const t = this.ctx.currentTime;
    try {
      h.gain.gain.cancelScheduledValues(t);
      h.gain.gain.setValueAtTime(Math.max(h.gain.gain.value, 0.0001), t);
      h.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      h.src.stop(t + 0.16);
      h.src.onended = () => {
        try { h.src.disconnect(); h.bp.disconnect(); h.lp.disconnect(); h.gain.disconnect(); } catch (_) {}
      };
    } catch (_) {
      try { h.src.disconnect(); h.gain.disconnect(); } catch (_) {}
    }
  }

  /**
   * Synthesized exertion — a source/filter vocal model, NOT speech.
   * A sawtooth glottal source through two bandpass "formants" reads as a human
   * vowel; F1/F2 around 700/1150 Hz gives an open "ahh". Breath noise on top
   * carries the effort. opts: { effort, voiceId }
   */
  grunt(opts) {
    if (!this._gate()) return;
    const o = opts || {};
    const effort = clamp01(Number.isFinite(o.effort) ? o.effort : 0.6);
    if (effort < 0.08) return;
    if (!this._take(0.7, 0)) return;

    const seed = hash01(o.voiceId);
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.002;

    // Voice identity: fundamental from ~105 Hz (low male) to ~235 Hz (high female).
    const f0 = lerp(105, 235, seed) * lerp(0.92, 1.18, effort);
    const dur = lerp(0.16, 0.42, effort) * rand(0.88, 1.12);
    const lvl = lerp(0.06, 0.3, effort * effort);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0 * 0.86, t0);
    osc.frequency.linearRampToValueAtTime(f0 * 1.06, t0 + dur * 0.22); // pitch rises on the strike
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, f0 * 0.62), t0 + dur);

    // Formant pair. Shifting them with the seed changes the vowel colour, which is
    // what makes two players sound like two different people.
    const f1 = lerp(600, 830, seed);
    const f2 = lerp(1000, 1420, 1 - seed);

    const b1 = ctx.createBiquadFilter();
    b1.type = 'bandpass'; b1.frequency.value = f1; b1.Q.value = 5;
    const b2 = ctx.createBiquadFilter();
    b2.type = 'bandpass'; b2.frequency.value = f2; b2.Q.value = 7;
    const mix = ctx.createGain();
    const g2 = ctx.createGain(); g2.gain.value = 0.45;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(lvl, t0 + Math.min(0.03, dur * 0.14));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(b1); osc.connect(b2);
    b1.connect(mix); b2.connect(g2); g2.connect(mix);
    mix.connect(g); g.connect(this.sfxBus);

    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    osc.onended = () => {
      try { osc.disconnect(); b1.disconnect(); b2.disconnect(); g2.disconnect(); mix.disconnect(); g.disconnect(); } catch (_) {}
    };

    // Breath: the air being forced out. Without this it sounds like a synth pad.
    this._noise(t0, dur * 0.85, {
      type: 'bandpass', freq: lerp(1100, 2100, effort), Q: 0.8,
      gain: lvl * 0.5, attack: Math.min(0.025, dur * 0.12), endFreq: 700,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Officiating (SpeechSynthesis)
  // ───────────────────────────────────────────────────────────────────────────

  _initSpeech() {
    this._speech = (typeof window !== 'undefined' && window.speechSynthesis) ? window.speechSynthesis : null;
    if (!this._speech) return;
    const refresh = () => {
      try {
        this._voiceList = this._speech.getVoices() || [];
        this._pickedVoice = null;
      } catch (_) { this._voiceList = []; }
    };
    refresh();
    // getVoices() is commonly empty until voiceschanged fires (Chrome always,
    // Safari on a cold start), so we re-read and invalidate the cached pick.
    this._voicesChangedHandler = refresh;
    try { this._speech.addEventListener('voiceschanged', refresh); } catch (_) {
      try { this._speech.onvoiceschanged = refresh; } catch (_) {}
    }
  }

  _selectVoice() {
    if (this._pickedVoice) return this._pickedVoice;
    if (!this._speech) return null;
    if (!this._voiceList || !this._voiceList.length) {
      try { this._voiceList = this._speech.getVoices() || []; } catch (_) { this._voiceList = []; }
    }
    const list = this._voiceList;
    if (!list.length) return null; // fall back to the platform default voice

    const pref = VOICE_PREFS[this._umpireVoice] || VOICE_PREFS.neutral;
    const norm = (s) => String(s || '').toLowerCase().replace('_', '-');

    // 1. Preferred named voice on this platform.
    for (const n of pref.names) {
      const v = list.find((x) => norm(x.name).includes(n));
      if (v) return (this._pickedVoice = v);
    }
    // 2. Exact language tag.
    for (const l of pref.langs) {
      const v = list.find((x) => norm(x.lang) === norm(l));
      if (v) return (this._pickedVoice = v);
    }
    // 3. Language prefix (en-*, fr-*).
    for (const l of pref.langs) {
      const base = norm(l).split('-')[0];
      const v = list.find((x) => norm(x.lang).startsWith(base));
      if (v) return (this._pickedVoice = v);
    }
    // 4. Anything English, then anything at all.
    const en = list.find((x) => norm(x.lang).startsWith('en'));
    return (this._pickedVoice = en || list[0]);
  }

  /**
   * A line call or umpire call: fast, clipped, loud.
   * opts: { voice, urgency }  — voice overrides the venue accent, urgency 0..1.
   */
  call(phrase, opts) {
    if (this._disposed || this._muted) return;
    const o = opts || {};
    const urgency = clamp01(Number.isFinite(o.urgency) ? o.urgency : 0.7);
    const text = String(phrase == null ? '' : phrase).trim();
    if (!text) return;

    if (o.voice && VOICE_PREFS[o.voice] && o.voice !== this._umpireVoice) {
      this._umpireVoice = o.voice;
      this._pickedVoice = null;
    }

    this._speak(text, {
      rate: lerp(1.15, 1.6, urgency),   // "OUT!" is barked, not narrated
      pitch: lerp(0.95, 1.15, urgency),
      volume: clamp01(this._vol.voice * this._vol.master * lerp(0.85, 1.0, urgency)),
      interrupt: urgency > 0.55,        // a late call cuts off whatever came before
    });
  }

  /** Score announcement: slower and more measured than a line call. */
  announceScore(text) {
    if (this._disposed || this._muted) return;
    const t = String(text == null ? '' : text).trim();
    if (!t) return;
    this._speak(t, {
      rate: 0.92,
      pitch: 0.98,
      volume: clamp01(this._vol.voice * this._vol.master * 0.85),
      interrupt: false,
    });
  }

  _speak(text, o) {
    const synth = this._speech || (typeof window !== 'undefined' ? window.speechSynthesis : null);
    if (!synth || typeof window === 'undefined' || !window.SpeechSynthesisUtterance) {
      this._attentionTone(o.rate > 1.1 ? 0.9 : 0.4);
      return;
    }
    try {
      if (o.interrupt) synth.cancel();
      const u = new window.SpeechSynthesisUtterance(text);
      const v = this._selectVoice();
      if (v) { u.voice = v; if (v.lang) u.lang = v.lang; }
      u.rate = clamp(o.rate, 0.1, 2);
      u.pitch = clamp(o.pitch, 0, 2);
      u.volume = clamp01(o.volume);
      u.onerror = () => { this._attentionTone(0.5); };
      synth.speak(u);
    } catch (err) {
      this._attentionTone(0.5);
    }
  }

  /** Fallback when speech is unavailable: a short two-tone attention beep. */
  _attentionTone(urgency) {
    if (!this._gate()) return;
    if (!this._take(0.35, 1)) return;
    const t0 = this.ctx.currentTime + 0.001;
    const u = clamp01(urgency);
    const f = lerp(660, 940, u);
    const dest = this.voiceBus;
    this._tone(t0, 0.09, { type: 'square', freq: f, gain: 0.11, attack: 0.004, dest });
    this._tone(t0 + 0.12, 0.11, { type: 'square', freq: f * (u > 0.5 ? 0.75 : 1.26), gain: 0.1, attack: 0.004, dest });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Crowd
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * @param {string} event 'ambient'|'applause'|'cheer'|'gasp'|'ooh'|'hush'|
   *                       'rallyBuild'|'pointWon'|'aceReaction'
   * @param {object} [opts] { intensity, duration }
   */
  crowd(event, opts) {
    if (!this._gate()) return;
    const o = opts || {};
    const enth = this._crowdEnthusiasm;
    const vol = this._crowdVolume;
    const it = clamp01(Number.isFinite(o.intensity) ? o.intensity : 0.6);

    switch (event) {
      case 'ambient':
        this.startAmbience();
        break;

      case 'applause':
        this._applause({ dur: lerp(2.0, 3.4, it * enth), level: 0.5 * vol * lerp(0.6, 1.15, it), swell: 0.28 });
        break;

      case 'pointWon':
        this._applause({ dur: lerp(2.2, 3.6, it * enth), level: 0.55 * vol * lerp(0.7, 1.2, it), swell: 0.22 });
        break;

      case 'cheer':
        this._applause({ dur: lerp(2.4, 4.0, enth), level: 0.6 * vol * lerp(0.8, 1.25, it), swell: 0.18 });
        this._crowdVoiceSwell({ dur: lerp(1.6, 2.8, enth), level: 0.34 * vol * lerp(0.7, 1.2, it), from: 380, to: 900, bright: true });
        break;

      case 'aceReaction':
        // Short, sharp, immediate: the noise arrives before people can organise it.
        this._applause({ dur: 1.9, level: 0.55 * vol * lerp(0.8, 1.2, enth), swell: 0.06 });
        this._crowdVoiceSwell({ dur: 1.1, level: 0.3 * vol * enth, from: 500, to: 1000, bright: true, attack: 0.05 });
        break;

      case 'gasp':
        // Sharp intake: fast up-sweep, then a quick fall as it catches in the throat.
        this._crowdVoiceSwell({ dur: 0.9, level: 0.4 * vol, from: 420, to: 980, attack: 0.14, bright: true });
        break;

      case 'ooh':
        // Slower, lower, more rueful than a gasp.
        this._crowdVoiceSwell({ dur: 1.6, level: 0.33 * vol, from: 250, to: 470, attack: 0.4 });
        break;

      case 'hush':
        this._duckAmbience(lerp(2.5, 1.2, it), 0.28);
        break;

      case 'rallyBuild':
        this._rallyBuild(it, Number.isFinite(o.duration) ? o.duration : 3.0);
        break;

      default:
        break;
    }
  }

  /**
   * One BufferSource replays the pre-rendered clap field with a swell envelope.
   * A random start offset (and a slight rate offset) means no two ovations are
   * the same, at the cost of exactly one node.
   */
  _applause(o) {
    if (!this._gate()) return;
    const dur = clamp(o.dur, 0.4, 4.5);
    if (!this._take(dur + 0.3, 0)) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.005;
    const buf = this._applauseBuf;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rand(0.94, 1.07);
    const maxOff = Math.max(0, buf.duration - dur / src.playbackRate.value - 0.05);
    const off = Math.random() * maxOff;

    // Rolling off the extreme top keeps it from sounding like white noise; the
    // highpass removes the rumble that would otherwise mask the ball sounds.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 380; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(6500, t0);
    lp.frequency.exponentialRampToValueAtTime(2600, t0 + dur); // energy dies from the top down

    const g = ctx.createGain();
    const swell = clamp(o.swell != null ? o.swell : 0.25, 0.02, dur * 0.5);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(clamp01(o.level), t0 + swell);
    // Hold at the peak briefly before the decay; never schedule the hold before
    // the swell has finished or the ramp gets truncated into a step.
    g.gain.setValueAtTime(clamp01(o.level), t0 + Math.max(swell, Math.min(dur * 0.45, swell + 0.5)));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this.crowdBus);
    src.start(t0, off, dur + 0.05);
    src.stop(t0 + dur + 0.05);
    src.onended = () => { try { src.disconnect(); hp.disconnect(); lp.disconnect(); g.disconnect(); } catch (_) {} };
  }

  /**
   * A wordless crowd vocalisation built from filtered noise: a band sweeping up
   * then back down through the vowel region. Never voices — just the envelope
   * shape the ear reads as "ooooh".
   */
  _crowdVoiceSwell(o) {
    if (!this._gate()) return;
    const dur = clamp(o.dur, 0.2, 4.0);
    if (!this._take(dur + 0.2, 0)) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.005;

    const src = ctx.createBufferSource();
    src.buffer = this._pinkBuf;
    src.loop = true;
    src.playbackRate.value = rand(0.95, 1.06);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = o.bright ? 1.6 : 1.1;
    bp.frequency.setValueAtTime(o.from, t0);
    bp.frequency.exponentialRampToValueAtTime(o.to, t0 + dur * 0.45);
    bp.frequency.exponentialRampToValueAtTime(Math.max(120, o.from * 0.8), t0 + dur);

    // A second, higher band adds the "many throats" quality without any voices.
    const bp2 = ctx.createBiquadFilter();
    bp2.type = 'bandpass'; bp2.Q.value = 2.2;
    bp2.frequency.setValueAtTime(o.from * 2.3, t0);
    bp2.frequency.exponentialRampToValueAtTime(o.to * 2.1, t0 + dur * 0.5);
    const g2 = ctx.createGain(); g2.gain.value = 0.35;

    const g = ctx.createGain();
    const att = clamp(o.attack != null ? o.attack : dur * 0.3, 0.02, dur * 0.7);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(clamp01(o.level), t0 + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(bp); bp.connect(g);
    src.connect(bp2); bp2.connect(g2); g2.connect(g);
    g.connect(this.crowdBus);
    src.start(t0, Math.random() * 2.0);
    src.stop(t0 + dur + 0.05);
    src.onended = () => { try { src.disconnect(); bp.disconnect(); bp2.disconnect(); g2.disconnect(); g.disconnect(); } catch (_) {} };
  }

  /** Continuous low crowd murmur. Idempotent. */
  startAmbience() {
    if (!this._gate()) return;
    if (this._ambience) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this._pinkBuf;
    src.loop = true;

    // Around 600-800 Hz is where a distant crowd lives: above it you start hearing
    // individual consonants (which would need real voices), below it it is rumble.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 140; hp.Q.value = 0.7;

    const g = ctx.createGain();
    this._ambienceTarget = 0.16 * this._crowdVolume;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(this._ambienceTarget, t0 + 1.5);

    // Two slow, mutually-prime LFOs so the bed never settles into an audible cycle.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 240;
    lfo.connect(lfoAmt); lfoAmt.connect(lp.frequency);

    const lfo2 = ctx.createOscillator();
    lfo2.type = 'sine'; lfo2.frequency.value = 0.031;
    const lfo2Amt = ctx.createGain(); lfo2Amt.gain.value = 0.035;
    lfo2.connect(lfo2Amt); lfo2Amt.connect(g.gain);

    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this.crowdBus);
    src.start(t0);
    lfo.start(t0);
    lfo2.start(t0);

    this._ambience = { src, lp, hp, gain: g, lfo, lfoAmt, lfo2, lfo2Amt };
  }

  stopAmbience() {
    const a = this._ambience;
    if (!a || !this.ctx) { this._ambience = null; return; }
    this._ambience = null;
    if (a._duckTimer) { clearTimeout(a._duckTimer); a._duckTimer = null; }
    const t = this.ctx.currentTime;
    try {
      a.gain.gain.cancelScheduledValues(t);
      a.gain.gain.setValueAtTime(Math.max(a.gain.gain.value, 0.0001), t);
      a.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      a.src.stop(t + 0.7);
      a.lfo.stop(t + 0.7);
      a.lfo2.stop(t + 0.7);
      a.src.onended = () => {
        try {
          a.src.disconnect(); a.hp.disconnect(); a.lp.disconnect(); a.gain.disconnect();
          a.lfo.disconnect(); a.lfoAmt.disconnect(); a.lfo2.disconnect(); a.lfo2Amt.disconnect();
        } catch (_) {}
      };
    } catch (_) {}
  }

  _duckAmbience(seconds, factor) {
    const a = this._ambience;
    if (!a) return;
    const t = this.ctx.currentTime;
    this._ramp(a.gain.gain, Math.max(0.0002, this._ambienceTarget * factor), t, 0.35);
    // Ducking also closes the filter: a hushed crowd is darker, not just quieter.
    this._ramp(a.lp.frequency, 380, t, 0.35);
    if (a._duckTimer) clearTimeout(a._duckTimer);
    a._duckTimer = setTimeout(() => {
      try {
        if (this._ambience !== a || !this.ctx) return;
        const t2 = this.ctx.currentTime;
        this._ramp(a.gain.gain, this._ambienceTarget, t2, 1.0);
        this._ramp(a.lp.frequency, 700, t2, 1.0);
      } catch (_) {}
    }, Math.max(200, seconds * 1000));
  }

  /** Long rally: swell the murmur and open it up. Great tension cue. */
  _rallyBuild(intensity, duration) {
    let a = this._ambience;
    if (!a) { this.startAmbience(); a = this._ambience; }
    if (!a) return;
    const t = this.ctx.currentTime;
    const dur = clamp(duration, 0.5, 12);
    const peak = clamp01(this._ambienceTarget * lerp(1.4, 3.2, intensity * this._crowdEnthusiasm));
    this._ramp(a.gain.gain, peak, t, dur * 0.85);
    this._ramp(a.lp.frequency, lerp(900, 1700, intensity), t, dur * 0.85);
    if (a._duckTimer) clearTimeout(a._duckTimer);
    a._duckTimer = setTimeout(() => {
      try {
        if (this._ambience !== a || !this.ctx) return;
        const t2 = this.ctx.currentTime;
        this._ramp(a.gain.gain, this._ambienceTarget, t2, 1.6);
        this._ramp(a.lp.frequency, 700, t2, 1.6);
      } catch (_) {}
    }, dur * 1000);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Low-level synthesis primitives
  // ───────────────────────────────────────────────────────────────────────────

  /** True if we can make sound right now. Also nudges a suspended context awake. */
  _gate() {
    if (!this._ready || this._disposed || !this.ctx || this._muted) return false;
    if (this.ctx.state === 'suspended') {
      // Autoplay policy: the first in-game event after a gesture unlocks us.
      if (!this._resumePending) {
        this._resumePending = true;
        const p = this.ctx.resume();
        const done = () => { this._resumePending = false; };
        if (p && p.then) p.then(done, done); else done();
      }
      return false;
    }
    return true;
  }

  /**
   * Reserve a voice slot for `dur` seconds. Returns false when the cap is hit so
   * the caller bails out instead of piling nodes onto the audio thread.
   */
  _take(dur, priority) {
    const cap = MAX_VOICES + (priority >= 1 ? PRIORITY_HEADROOM : 0);
    if (this._voices >= cap) return false;
    this._voices++;
    setTimeout(() => { this._voices = Math.max(0, this._voices - 1); },
      Math.max(30, (dur + 0.12) * 1000));
    return true;
  }

  _ramp(param, value, t, seconds) {
    try {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + seconds);
    } catch (_) {
      try { param.value = value; } catch (_) {}
    }
  }

  /**
   * Filtered slice of a pre-generated noise buffer with an AD envelope.
   * opts: { type, freq, endFreq, Q, gain, attack, dest, buffer, playbackRate,
   *         bend: [peakFreq, peakFraction, endFreq] }
   */
  _noise(t0, dur, opts) {
    const ctx = this.ctx;
    if (!ctx || dur <= 0 || !(opts.gain > 0)) return null;
    const buf = opts.buffer || this._whiteBuf;
    const rate = opts.playbackRate || 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const span = Math.min(dur * rate + 0.05, buf.duration - 0.001);
    const off = Math.random() * Math.max(0, buf.duration - span - 0.001);

    const f = ctx.createBiquadFilter();
    f.type = opts.type || 'bandpass';
    const freq = clamp(opts.freq, 20, Math.min(20000, ctx.sampleRate * 0.45));
    f.frequency.setValueAtTime(freq, t0);
    f.Q.value = clamp(opts.Q != null ? opts.Q : 1, 0.0001, 40);
    if (opts.bend) {
      const [pf, pfrac, ef] = opts.bend;
      f.frequency.linearRampToValueAtTime(clamp(pf, 20, 20000), t0 + dur * clamp01(pfrac));
      f.frequency.exponentialRampToValueAtTime(clamp(ef, 20, 20000), t0 + dur);
    } else if (opts.endFreq) {
      f.frequency.exponentialRampToValueAtTime(clamp(opts.endFreq, 20, 20000), t0 + dur);
    }

    const g = ctx.createGain();
    const att = clamp(opts.attack != null ? opts.attack : 0.001, 0.0002, Math.max(0.0003, dur * 0.9));
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(clamp(opts.gain, 0.0002, 4), t0 + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + att + dur);

    src.connect(f); f.connect(g); g.connect(opts.dest || this.sfxBus);
    src.start(t0, off, span);
    src.stop(t0 + att + dur + 0.02);
    src.onended = () => { try { src.disconnect(); f.disconnect(); g.disconnect(); } catch (_) {} };
    return src;
  }

  /** Single pitched partial with an AD envelope and an optional glide. */
  _tone(t0, dur, opts) {
    const ctx = this.ctx;
    if (!ctx || dur <= 0 || !(opts.gain > 0)) return null;

    const osc = ctx.createOscillator();
    osc.type = opts.type || 'sine';
    const f = clamp(opts.freq, 10, Math.min(20000, ctx.sampleRate * 0.45));
    osc.frequency.setValueAtTime(f, t0);
    if (opts.endFreq) {
      osc.frequency.exponentialRampToValueAtTime(clamp(opts.endFreq, 10, 20000), t0 + dur);
    }

    const g = ctx.createGain();
    const att = clamp(opts.attack != null ? opts.attack : 0.001, 0.0002, Math.max(0.0003, dur * 0.9));
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(clamp(opts.gain, 0.0002, 4), t0 + att);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + att + dur);

    osc.connect(g); g.connect(opts.dest || this.sfxBus);
    osc.start(t0);
    osc.stop(t0 + att + dur + 0.02);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch (_) {} };
    return osc;
  }

  /**
   * A short-lived waveshaper chain for the sounds that should feel over-driven.
   * Returns { node } to connect into; it tears itself down after a second.
   */
  _saturator(curve, drive) {
    const ctx = this.ctx;
    const pre = ctx.createGain();
    pre.gain.value = 1 + drive * 3;
    const ws = ctx.createWaveShaper();
    ws.curve = curve;
    if ('oversample' in ws) ws.oversample = '2x';
    const post = ctx.createGain();
    post.gain.value = 1 / (1 + drive * 1.6); // makeup, keeps saturation from just being "louder"
    pre.connect(ws); ws.connect(post); post.connect(this.sfxBus);
    setTimeout(() => { try { pre.disconnect(); ws.disconnect(); post.disconnect(); } catch (_) {} }, 1200);
    return { node: pre };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Buffer generation (all of this runs exactly once, in init())
  // ───────────────────────────────────────────────────────────────────────────

  _makeWhiteBuffer(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * Pink noise (Paul Kellet's economy filter). Pink, not white, because crowd and
   * air noise both have roughly -3 dB/octave spectra; white noise reads as hiss.
   * The tail is cross-faded into the head so it loops without a seam click.
   */
  _makePinkBuffer(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    const xfade = Math.min(Math.floor(ctx.sampleRate * 0.25), Math.floor(n / 4));

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      // Seamless loop: fade the last `xfade` samples into the first `xfade`.
      for (let i = 0; i < xfade; i++) {
        const t = i / xfade;
        const head = d[i];
        const tail = d[n - xfade + i];
        d[n - xfade + i] = tail * (1 - t) + head * t;
      }
    }
    return buf;
  }

  /**
   * A dense field of individual claps rendered offline. Each clap is a 1-4 ms
   * exponentially-decaying noise grain; start times are uniform-random, which for
   * this density is indistinguishable from a Poisson process and much cheaper.
   * Playing a slice of this back with a swell envelope is a whole ovation for the
   * price of one node.
   */
  _makeApplauseBuffer(seconds) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, n, sr);
    const clapsPerSecond = 850; // dense enough to read as "a full stadium"

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const count = Math.floor(seconds * clapsPerSecond);
      for (let k = 0; k < count; k++) {
        const start = Math.floor(Math.random() * (n - 400));
        const amp = 0.15 + Math.random() * 0.85;
        // Nearer hands are louder AND longer; distant ones are short ticks.
        const decay = Math.floor((0.0008 + Math.random() * 0.0032) * sr);
        const inv = 1 / (decay * 0.32);
        for (let j = 0; j < decay; j++) {
          d[start + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j * inv);
        }
      }
      // Normalise to leave headroom; the swell envelope does the loudness work.
      let peak = 0;
      for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
      if (peak > 0) {
        const s = 0.7 / peak;
        for (let i = 0; i < n; i++) d[i] *= s;
      }
    }
    return buf;
  }

  _makeSaturationCurve(amount) {
    const n = 1024;
    const c = new Float32Array(n);
    const k = Math.tanh(amount);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * amount) / k;
    }
    return c;
  }

  _getIR(p) {
    const key = `${p.seconds.toFixed(2)}|${p.decay.toFixed(2)}|${p.brightness.toFixed(2)}`;
    const hit = this._irCache.get(key);
    if (hit) return hit;
    const ir = this._makeIR(p.seconds, p.decay, p.brightness);
    // Keep the cache tiny; venues change rarely and each IR is a few hundred kB.
    if (this._irCache.size > 5) this._irCache.clear();
    this._irCache.set(key, ir);
    return ir;
  }

  /**
   * Procedural impulse response: exponentially-decaying noise, one-pole lowpassed
   * so the tail darkens (air absorption), plus a handful of sparse early
   * reflections in the first ~60 ms. The early reflections are what actually
   * communicate room SIZE; the tail communicates reverberance.
   * `brightness` is the one-pole coefficient (higher = brighter, harder walls).
   */
  _makeIR(seconds, decay, brightness) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.max(64, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(2, n, sr);
    const b = clamp(brightness, 0.05, 0.95);

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const env = Math.pow(1 - t, decay);
        const s = (Math.random() * 2 - 1) * env;
        lp += (s - lp) * b;
        d[i] = lp;
      }
      // Early reflections: 6-10 discrete taps, decorrelated per channel for width.
      const taps = 6 + Math.floor(Math.random() * 5);
      for (let k = 0; k < taps; k++) {
        // Larger rooms have later first reflections.
        const at = Math.floor(sr * (0.004 + Math.random() * 0.055 * clamp(seconds, 0.3, 2.0)));
        if (at < n) d[at] += (Math.random() * 2 - 1) * 0.55 * Math.pow(1 - at / n, decay);
      }
      // 4 ms fade-in avoids a click at the head of the convolution.
      const fade = Math.floor(sr * 0.004);
      for (let i = 0; i < fade && i < n; i++) d[i] *= i / fade;
    }
    return buf;
  }

  // ───────────────────────────────────────────────────────────────────────────

  _fail(where, err) {
    if (this._errCount > 8) return;   // never spam the console from a 60 fps loop
    this._errCount++;
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[AudioEngine] ${where} failed (audio degraded to silence):`, err);
      }
    } catch (_) {}
  }
}

export default AudioEngine;
