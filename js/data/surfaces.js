/**
 * Court surfaces.
 *
 * Two numbers do almost all the work in making surfaces feel different:
 *
 *   friction    — how much horizontal pace the bounce scrubs off, and how hard the
 *                 ball "grips" and converts spin into direction change. High friction
 *                 (clay) = slow court, big topspin kick. Low friction (grass) = the
 *                 ball skids through low and fast.
 *
 *   restitution — the coefficient of restitution, i.e. how much vertical speed
 *                 survives the bounce. High (clay) = ball sits up. Low (grass) =
 *                 ball stays under the hitting zone and rushes you.
 *
 * These map onto the ITF Court Pace Rating: clay is Category 1 (slow), the hard
 * courts sit at Category 3 (medium), grass is Category 5 (fast).
 */

export const SURFACES = {
  grass: {
    id: 'grass',
    name: 'Grass',
    paceRating: 'Fast',
    cpr: 47,
    friction: 0.52,
    restitution: 0.72,

    // Multiplies player top speed. Grass is slick — you slide, you cannot brake hard.
    tractionFactor: 0.94,
    // Chance per bounce of an unpredictable deviation. Grass wears out and gets patchy.
    badBounceChance: 0.045,
    badBounceMagnitude: 0.16,
    // Sliding into shots is a clay/hard-court skill; grass punishes it.
    slideFactor: 0.35,

    // Visual
    courtColor: '#3d7a37',
    courtColorAlt: '#43853c',   // mown stripes
    outerColor: '#2f6b2c',
    lineColor: '#ffffff',
    stripes: true,
    // Audio: footwork sounds soft and muffled, ball impact is dull.
    footstepTone: 'soft',
    bounceTone: 'muted',
    dustColor: null,            // grass does not puff
  },

  clay: {
    id: 'clay',
    name: 'Clay',
    paceRating: 'Slow',
    cpr: 24,
    friction: 0.72,
    restitution: 0.85,

    tractionFactor: 0.90,       // you slide a lot, but it is a controlled slide
    badBounceChance: 0.02,
    badBounceMagnitude: 0.09,
    slideFactor: 1.0,           // full sliding recovery available

    courtColor: '#c1683a',
    courtColorAlt: '#b85f33',
    outerColor: '#a8542c',
    lineColor: '#f2f0eb',
    stripes: false,
    footstepTone: 'gritty',
    bounceTone: 'dull',
    dustColor: 'rgba(196, 118, 68, 0.55)', // the puff that settles ball-mark arguments
  },

  hard_us: {
    id: 'hard_us',
    name: 'DecoTurf (Hard)',
    paceRating: 'Medium-Fast',
    cpr: 38,
    friction: 0.62,
    restitution: 0.80,

    tractionFactor: 1.0,
    badBounceChance: 0.008,
    badBounceMagnitude: 0.06,
    slideFactor: 0.55,

    courtColor: '#2f6fa8',
    courtColorAlt: '#2f6fa8',
    outerColor: '#3c8a5a',      // US Open's green surround
    lineColor: '#ffffff',
    stripes: false,
    footstepTone: 'squeak',
    bounceTone: 'crisp',
    dustColor: null,
  },

  hard_ao: {
    id: 'hard_ao',
    name: 'GreenSet (Hard)',
    paceRating: 'Medium',
    cpr: 34,
    friction: 0.66,
    restitution: 0.81,

    tractionFactor: 0.99,
    badBounceChance: 0.008,
    badBounceMagnitude: 0.06,
    slideFactor: 0.6,

    courtColor: '#3a6ea8',
    courtColorAlt: '#3a6ea8',
    outerColor: '#1f4d7a',
    lineColor: '#ffffff',
    stripes: false,
    footstepTone: 'squeak',
    bounceTone: 'crisp',
    dustColor: null,
  },

  indoor: {
    id: 'indoor',
    name: 'Indoor Hard',
    paceRating: 'Fast',
    cpr: 44,
    friction: 0.56,
    restitution: 0.79,

    tractionFactor: 1.02,       // best grip of any surface, no wind, no sun
    badBounceChance: 0.003,
    badBounceMagnitude: 0.04,
    slideFactor: 0.4,

    courtColor: '#2b4a6f',
    courtColorAlt: '#2b4a6f',
    outerColor: '#1a2c42',
    lineColor: '#ffffff',
    stripes: false,
    footstepTone: 'squeak',
    bounceTone: 'sharp',
    dustColor: null,
  },
};

export const SURFACE_LIST = Object.values(SURFACES);
export const getSurface = (id) => SURFACES[id] || SURFACES.hard_us;
