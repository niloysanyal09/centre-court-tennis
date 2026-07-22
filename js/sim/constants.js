/**
 * Real-world tennis constants. All units are SI (metres, seconds, kilograms, radians).
 *
 * COORDINATE SYSTEM (right-handed, the single source of truth for the whole game):
 *
 *   x : across the court.  0 = centre line.  -x = umpire's left,  +x = umpire's right.
 *   y : along the court.   0 = the net.      -y = NEAR half (player 0 / "south"),
 *                                            +y = FAR half  (player 1 / "north").
 *   z : height above the court surface. 0 = ground.
 *
 * Every module — physics, rendering, AI, netcode — uses these axes without exception.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Court geometry (ITF Rules of Tennis, Appendix I)
// ─────────────────────────────────────────────────────────────────────────────

export const COURT = {
  // Full length 23.77 m (78 ft); each half is 11.885 m from the net to the baseline.
  HALF_LENGTH: 11.885,
  LENGTH: 23.77,

  // Singles court 8.23 m wide (27 ft) → 4.115 m either side of centre.
  SINGLES_HALF_WIDTH: 4.115,
  // Doubles court 10.97 m wide (36 ft) → 5.485 m either side of centre.
  DOUBLES_HALF_WIDTH: 5.485,

  // The alley (tramline) between singles and doubles sidelines: 1.37 m.
  ALLEY_WIDTH: 1.37,

  // Service line sits 6.40 m (21 ft) from the net.
  SERVICE_LINE: 6.4,

  // Net: 0.914 m (3 ft) at the centre, 1.07 m (3.5 ft) at the posts.
  NET_HEIGHT_CENTRE: 0.914,
  NET_HEIGHT_POST: 1.07,
  // Posts stand 0.914 m outside the doubles sideline.
  NET_POST_X: 5.485 + 0.914,
  // Net band (the white tape along the top) is 5 cm deep — used for net-cord detection.
  NET_BAND: 0.05,

  // Painted lines are 5 cm wide (baseline may be up to 10 cm). A ball is IN if any
  // part of it touches any part of the line, so lines effectively extend the court
  // by one ball radius in the in/out test.
  LINE_WIDTH: 0.05,
  BASELINE_WIDTH: 0.1,

  // Run-off space beyond the lines, for camera framing and out-wide chasing.
  RUNOFF_BACK: 6.4,
  RUNOFF_SIDE: 3.66,
};

// ─────────────────────────────────────────────────────────────────────────────
// Ball (ITF Type 2 "medium speed", the standard ball)
// ─────────────────────────────────────────────────────────────────────────────

export const BALL = {
  MASS: 0.0577,        // kg  (57.7 g, ITF legal range 56.0–59.4 g)
  RADIUS: 0.0335,      // m   (diameter 6.7 cm, ITF range 6.54–6.86 cm)
  get AREA() { return Math.PI * this.RADIUS * this.RADIUS; }, // cross-sectional, m²
};

// ─────────────────────────────────────────────────────────────────────────────
// Aerodynamics
// ─────────────────────────────────────────────────────────────────────────────

export const PHYSICS = {
  GRAVITY: 9.81,       // m/s²
  AIR_DENSITY: 1.21,   // kg/m³ at 20 °C, sea level

  // Drag coefficient of a fuzzy tennis ball, ~0.507 in the relevant Reynolds range.
  DRAG_COEFF: 0.507,

  // Magnus (lift) is modelled as Cl = 1 / (2 + v / v_spin), the standard empirical
  // fit for tennis balls, where v_spin = ω·r is the surface speed of the ball.
  // Capped because the fit breaks down at extreme spin-to-speed ratios.
  MAX_LIFT_COEFF: 0.32,

  // Spin decays slowly in flight (~2 % per second).
  SPIN_DECAY_PER_SEC: 0.02,
};

/**
 * Pre-computed drag constant so the integrator does not redo this every step.
 * a_drag = K_DRAG · |v|² , opposing the velocity vector.
 *
 *   K = ½ · ρ · Cd · A / m
 *     = ½ · 1.21 · 0.507 · 0.003526 / 0.0577  ≈ 0.01874  (1/m)
 *
 * Sanity check: at 40 m/s (144 km/h) that is ~30 m/s² of deceleration — about 3 g,
 * which is why a flat drive loses so much pace between the baselines.
 */
export const K_DRAG =
  0.5 * PHYSICS.AIR_DENSITY * PHYSICS.DRAG_COEFF * BALL.AREA / BALL.MASS;

/** Magnus scale factor: a_magnus = K_MAGNUS · Cl · |v|² · (ŵ × v̂). */
export const K_MAGNUS = 0.5 * PHYSICS.AIR_DENSITY * BALL.AREA / BALL.MASS;

// ─────────────────────────────────────────────────────────────────────────────
// Speeds and spins seen in the professional game — used to calibrate shot power
// and to keep the AI inside believable bounds.
// ─────────────────────────────────────────────────────────────────────────────

export const SPEEDS = {
  SERVE_FIRST_MAX: 61,    // m/s ≈ 220 km/h
  SERVE_FIRST_TYPICAL: 53,// m/s ≈ 190 km/h
  SERVE_SECOND: 45,       // m/s ≈ 160 km/h (heavy kick)
  GROUNDSTROKE_MAX: 42,   // m/s ≈ 151 km/h
  GROUNDSTROKE_TYPICAL: 33,
  VOLLEY: 26,
  SMASH: 55,
  DROP: 12,
  LOB: 18,
};

export const SPIN = {
  // Angular velocity in rad/s. 1 rpm = 0.10472 rad/s.
  FLAT: 40,          // ~380 rpm, a "flat" ball still carries a little topspin
  TOPSPIN: 290,      // ~2800 rpm, standard modern forehand
  HEAVY_TOPSPIN: 480,// ~4600 rpm, Nadal territory
  SLICE: -220,       // ~-2100 rpm backspin
  KICK_SERVE: 360,   // topspin + sidespin component
  MAX: 550,
};

// ─────────────────────────────────────────────────────────────────────────────
// Players
// ─────────────────────────────────────────────────────────────────────────────

export const PLAYER = {
  HEIGHT: 1.85,            // m, for rendering and reach
  SHOULDER_HEIGHT: 1.5,
  REACH: 1.05,             // arm + racket, from the body centre
  CONTACT_HEIGHT_LOW: 0.35,// lowest reachable contact (a dug-out half volley)
  CONTACT_HEIGHT_COMFORT: 0.95,
  CONTACT_HEIGHT_HIGH: 2.6,// full stretch overhead / smash

  // Movement. Elite players cover ~4–7 m/s on court with rapid direction changes.
  MAX_SPEED: 6.6,          // m/s sprint
  ACCEL: 22,               // m/s² — tennis is all short explosive bursts
  DECEL: 26,
  // Split-step timing gives a brief burst of extra acceleration.
  SPLIT_STEP_BONUS: 1.35,
  SPLIT_STEP_WINDOW: 0.22, // s before opponent contact to earn the bonus

  // Recovery to the middle after a shot.
  RECOVERY_SPEED_FACTOR: 0.85,
};

export const STAMINA = {
  MAX: 100,
  SPRINT_DRAIN: 4.2,       // per second at full sprint
  IDLE_RECOVER: 2.6,       // per second when stationary
  BETWEEN_POINTS_RECOVER: 14,
  SHOT_COST: 1.1,
  SERVE_COST: 1.8,
  // Below this fraction, speed and accuracy start to degrade noticeably.
  FATIGUE_THRESHOLD: 0.55,
  MIN_SPEED_FACTOR: 0.72,  // how slow a fully gassed player gets
};

// ─────────────────────────────────────────────────────────────────────────────
// Shot timing. The heart of the "feel" — how forgiving the game is.
// ─────────────────────────────────────────────────────────────────────────────

export const TIMING = {
  // Seconds around the ideal contact moment. Hitting inside PERFECT gives full
  // power and placement; outside GOOD is a mishit that sprays.
  PERFECT: 0.055,
  GOOD: 0.13,
  OK: 0.22,
  // Beyond OK the swing whiffs or frames the ball entirely.
  MISHIT_POWER_FACTOR: 0.55,
  MISHIT_SPRAY_DEG: 13,
  // Charging a shot: how long to hold to reach maximum power.
  MAX_CHARGE: 0.62,
  MIN_CHARGE_POWER: 0.45,
};

// ─────────────────────────────────────────────────────────────────────────────
// Match rules
// ─────────────────────────────────────────────────────────────────────────────

export const RULES = {
  POINT_NAMES: ['0', '15', '30', '40'],
  GAMES_PER_SET: 6,
  TIEBREAK_AT: 6,          // 6–6
  TIEBREAK_TO: 7,          // win by 2
  // Since 2022 all four majors play a 10-point tiebreak at 6–6 in the deciding set.
  FINAL_SET_TIEBREAK_TO: 10,
  SERVE_CLOCK: 25,         // seconds between points
  CHALLENGES_PER_SET: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// Simulation loop
// ─────────────────────────────────────────────────────────────────────────────

export const SIM = {
  // Fixed timestep. 120 Hz keeps fast serves from tunnelling through the net
  // and makes the physics deterministic across machines (important for netcode).
  DT: 1 / 120,
  MAX_STEPS_PER_FRAME: 8,  // spiral-of-death guard
  NET_SNAPSHOT_HZ: 25,     // host → guest state broadcast rate
};

/** Convert m/s to km/h, for the speed readouts on the HUD. */
export const toKmh = (mps) => mps * 3.6;
/** Convert m/s to mph. */
export const toMph = (mps) => mps * 2.23694;
