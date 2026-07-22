/**
 * Venues. Each one pairs a surface with a visual identity, a crowd, and weather.
 *
 * Named by city rather than by tournament — these are homages, not licensed courts.
 * Wind is real here: it is applied to ball flight in physics.js, so a breezy day in
 * New York genuinely pushes your topspin lob long.
 */

export const VENUES = {
  london: {
    id: 'london',
    name: 'London',
    subtitle: 'Centre Court',
    surface: 'grass',
    blurb: 'Low, skidding bounces on worn grass. Serve-and-volley is rewarded here more than anywhere else.',

    sky: ['#7c9dc4', '#b8cbdd', '#dfe6ec'],   // soft overcast English light
    ambientLight: 0.88,
    shadowAlpha: 0.16,                        // weak shadows under cloud
    stadium: {
      wall: '#0f4630',      // dark green
      wallTrim: '#3d2b56',  // purple
      seats: ['#1d5c3e', '#174d33'],
      roof: '#e8e8e6',
      hasRoof: true,
    },
    crowdDensity: 0.94,
    crowdPalette: ['#e8dcc8', '#c9b8a0', '#8a9bb0', '#d4d4d4', '#6b7a8f', '#f0e6d2'],
    crowdVolume: 0.72,       // reserved, respectful, then explosive
    crowdEnthusiasm: 0.65,

    wind: { speed: 1.6, direction: 0.4 },     // m/s, radians (0 = +y, toward far end)
    windGust: 0.9,
    timeOfDay: 'afternoon',

    // Umpire line-call flavour
    umpireVoice: 'british',
    netCall: 'Let',
  },

  paris: {
    id: 'paris',
    name: 'Paris',
    subtitle: 'Court Central',
    surface: 'clay',
    blurb: 'The great equaliser. High kicking bounces, long rallies, and sliding defence. Points are constructed, not ended.',

    sky: ['#4f86c6', '#87b3dd', '#c7dcee'],
    ambientLight: 1.0,
    shadowAlpha: 0.3,
    stadium: {
      wall: '#1e4a3a',
      wallTrim: '#c1683a',
      seats: ['#2a6b4f', '#225840'],
      roof: '#d8d5cc',
      hasRoof: true,
    },
    crowdDensity: 0.9,
    crowdPalette: ['#e0d5c0', '#b56b4a', '#7a8fa8', '#d9cfc0', '#4a6b8a', '#e8e0d0'],
    crowdVolume: 0.85,
    crowdEnthusiasm: 0.9,     // loud, partisan, whistles

    wind: { speed: 1.2, direction: 2.1 },
    windGust: 0.7,
    timeOfDay: 'afternoon',

    umpireVoice: 'french',
    netCall: 'Filet',
  },

  newyork: {
    id: 'newyork',
    name: 'New York',
    subtitle: 'Arthur Ashe Night Session',
    surface: 'hard_us',
    blurb: 'Fast, true bounces under the lights, and the loudest crowd in tennis. Nothing about this place is calm.',

    sky: ['#0a1428', '#132244', '#1d3358'],   // night session
    ambientLight: 0.95,
    shadowAlpha: 0.42,                        // hard stadium floodlights
    floodlit: true,
    stadium: {
      wall: '#12233d',
      wallTrim: '#3c8a5a',
      seats: ['#1b3a5c', '#16304d'],
      roof: '#2a3d54',
      hasRoof: true,
    },
    crowdDensity: 0.97,
    crowdPalette: ['#d8d8d8', '#4a5a7a', '#c04a4a', '#e8c85a', '#8a8a9a', '#f0f0f0'],
    crowdVolume: 1.0,
    crowdEnthusiasm: 1.0,

    wind: { speed: 2.4, direction: 1.2 },     // Ashe's notorious swirl
    windGust: 1.8,
    timeOfDay: 'night',

    umpireVoice: 'american',
    netCall: 'Let',
  },

  melbourne: {
    id: 'melbourne',
    name: 'Melbourne',
    subtitle: 'Centre Court',
    surface: 'hard_ao',
    blurb: 'Brutal heat and a medium-paced court. Rallies are long, the ball sits up, and stamina decides the fifth set.',

    sky: ['#2e7ec4', '#6fb0e0', '#bfe0f2'],
    ambientLight: 1.15,                       // harsh summer sun
    shadowAlpha: 0.45,
    heat: 1.0,                                // extra stamina drain
    stadium: {
      wall: '#123a5c',
      wallTrim: '#4a9fd8',
      seats: ['#1a4d78', '#154063'],
      roof: '#c8ccd0',
      hasRoof: true,
    },
    crowdDensity: 0.88,
    crowdPalette: ['#f0e8d8', '#4a9fd8', '#d8b84a', '#c8c8c8', '#7a9ab0', '#e8dcc0'],
    crowdVolume: 0.88,
    crowdEnthusiasm: 0.85,

    wind: { speed: 1.0, direction: 4.7 },
    windGust: 0.5,
    timeOfDay: 'day',

    umpireVoice: 'australian',
    netCall: 'Let',
  },

  turin: {
    id: 'turin',
    name: 'Indoor Arena',
    subtitle: 'Season Finals',
    surface: 'indoor',
    blurb: 'No wind, no sun, perfect bounces. The purest test of ball-striking, and the fastest conditions in the game.',

    sky: ['#05070d', '#0a0f1a', '#0d1420'],
    ambientLight: 1.0,
    shadowAlpha: 0.5,
    floodlit: true,
    indoor: true,
    stadium: {
      wall: '#0a0f1a',
      wallTrim: '#00c8ff',
      seats: ['#101828', '#0c1220'],
      roof: '#080c14',
      hasRoof: true,
    },
    crowdDensity: 0.85,
    crowdPalette: ['#2a3548', '#3a4a68', '#c8c8d8', '#1e2838', '#5a6a88'],
    crowdVolume: 0.8,
    crowdEnthusiasm: 0.75,

    wind: { speed: 0, direction: 0 },         // sealed arena
    windGust: 0,
    timeOfDay: 'night',

    umpireVoice: 'neutral',
    netCall: 'Let',
  },

  practice: {
    id: 'practice',
    name: 'Practice Court',
    subtitle: 'Academy',
    surface: 'hard_us',
    blurb: 'Empty, quiet, and forgiving. Where the work actually gets done.',

    sky: ['#5a92c8', '#96bfe0', '#cde2f0'],
    ambientLight: 1.0,
    shadowAlpha: 0.3,
    stadium: {
      wall: '#4a5a4a',
      wallTrim: '#6a7a6a',
      seats: ['#3a4a3a', '#334233'],
      roof: null,
      hasRoof: false,
    },
    crowdDensity: 0.06,       // a few coaches and a bored sibling
    crowdPalette: ['#8a8a8a', '#6a7a8a', '#9a8a7a'],
    crowdVolume: 0.15,
    crowdEnthusiasm: 0.3,

    wind: { speed: 0.6, direction: 1.5 },
    windGust: 0.3,
    timeOfDay: 'day',

    umpireVoice: 'neutral',
    netCall: 'Let',
  },
};

export const VENUE_LIST = Object.values(VENUES);
export const getVenue = (id) => VENUES[id] || VENUES.newyork;
