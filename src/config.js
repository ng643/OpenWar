// Central tunables. Everything gameplay-relevant lives here so balance changes are one-file edits.

// --- map ---
export const W = 150;           // map width in tiles
export const H = 96;            // map height in tiles
export const TS = 4;            // overlay pixels per tile (render only)
export const WATER = 0, LAND = 1, MOUNTAIN = 2;
export const TCOST = [99, 1, 2.4];   // movement cost per terrain type

// --- players ---
// Seat identity is derived from the seat id alone: ids 1..6 keep the original colours and callsigns,
// later seats get generated ones. There is no fixed player count any more — a world stores exactly
// as many seats as its generated map offers (see `maxCityCapacity` in setup.js, `cityCapacity` in
// sim/city-layout.js), so these tables just span the largest map (6 capitals + 32 neutral cities).
const BASE_COLORS = ['#3b82f6', '#e5484d', '#30b765', '#e8b923', '#a560e8', '#f07d2e'];
const BASE_NAMES = ['Azure', 'Crimson', 'Verdant', 'Gilded', 'Violet', 'Ember'];
const EXTRA_NAMES = ['Cobalt', 'Coral', 'Jade', 'Amber', 'Indigo', 'Rust', 'Teal', 'Onyx', 'Ivory',
  'Slate', 'Mauve', 'Cyan', 'Magenta', 'Olive', 'Maroon', 'Tangerine', 'Turquoise', 'Lavender',
  'Emerald', 'Ruby', 'Sapphire', 'Topaz', 'Amethyst', 'Pearl', 'Bronze', 'Copper', 'Saffron',
  'Lilac', 'Mint', 'Rose', 'Cider', 'Steel'];
const SEATS = BASE_COLORS.length + EXTRA_NAMES.length;

/** HSL (h degrees, s/l in 0..1) to '#rrggbb'. Pure arithmetic, so every client derives the same table. */
function hslHex(h, s, l) {
  const chan = n => {
    const k = (n + h / 30) % 12;
    const v = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return '#' + chan(0) + chan(8) + chan(4);
}

/** Stable colour for a seat id of any size of world. Always '#rrggbb' so callers can append an alpha byte. */
export function participantColor(id) {
  if (id >= 1 && id <= BASE_COLORS.length) return BASE_COLORS[id - 1];
  // Later seats: golden-angle hues spread the newcomers around the wheel instead of clustering, and the
  // 67° phase keeps the early extra seats clear of the six base hues on the small/standard rosters.
  return hslHex((((id - 7) * 137.508 + 67) % 360 + 360) % 360, 0.6, 0.5);
}

/** Stable callsign for a seat id of any size of world. */
export function participantName(id) {
  if (id >= 1 && id <= BASE_NAMES.length) return BASE_NAMES[id - 1];
  const extra = id - 7;
  const lap = Math.floor(extra / EXTRA_NAMES.length);
  return EXTRA_NAMES[extra % EXTRA_NAMES.length] + (lap ? ' ' + (lap + 1) : '');
}

export const COLORS = Array.from({ length: SEATS }, (_, i) => participantColor(i + 1));
export const NAMES = Array.from({ length: SEATS }, (_, i) => participantName(i + 1));
export const WIN_SHARE = 0.6;   // land share needed for victory

// --- simulation ---
export const STEP = 0.05;       // fixed sim step (s)
export const SPEED = 1.7;       // base tiles/s on plain land
export const RANGE = 1.8;       // melee engagement distance (tiles)
// A division is a solid body. Friendly traffic can displace holders temporarily, and combat can
// push defenders back, but every displacement still respects this radius, terrain and map bounds.
export const DIV_RADIUS = 0.425;
// An atomic unit is one normal division: TYPES[type].men men. A merge stacks whole same-owner,
// same-type detachments up to MERGE_STACK atomics (infantry 1000, armor 900, artillery 600 men),
// and a split peels one atomic back off. Centres must stand within MERGE_RANGE tiles.
export const MERGE_STACK = 10;
export const MERGE_RANGE = 1.5;
export const SPLIT_MIN_MEN = 20;  // a division below this many men is too small to split an atomic off
export const ART_RANGE = 5;     // artillery shelling distance (tiles)
export const VISION = 10;       // tiles a division can see (fog of war)

// --- logistics, roads & routing ---
// Owned land connects divisions to owned cities. Roads lower the effective logistics distance;
// isolation halves fighting output and prevents reinforcement without deleting troops.
export const LOGISTICS_DISTANCE = 20;
export const ISOLATED_COMBAT = 0.5;
export const REINFORCE_RATE = 3;       // men/s at a city, paid from reserves
export const ROAD_GOLD = 2;           // gold per newly built road tile
export const ROAD_SPEED = 1.5;        // normal movement multiplier on a road
export const ROAD_LOGISTICS_COST = 0.25;
export const ROUT_FRAC = 0.4;         // combat-wounded divisions flee below this strength
export const ROUT_RECOVER_FRAC = 0.7; // recover from an uninterrupted rout at this strength
export const ROUT_MIN_DISTANCE = 6;
export const ROUT_MAX_DISTANCE = 12;
export const PUSH_BASE = 0.25;        // combat push speed = max(0, attacker top speed - defender + base)
export const COLUMN_SPACING = 1.2;    // tiles between divisions travelling single-file
export const MAX_ROUTE_POINTS = 128;
export const CITY_VIS = 7;      // tiles a city can see

// --- division types ---
// manpower: reserves spent to raise it (= its starting strength); gold: equipment cost;
// needs: 'factory' = can only be raised at a city with a working Factory nearby;
// speed/atk/taken: multipliers; capt: land-capture rate multiplier (0 = cannot capture)
export const TYPES = {
  inf: { name: 'Infantry',  tag: 'INF', manpower: 100, gold: 30,  men: 100, speed: 1,    atk: 1,   taken: 1,   capt: 1 },
  arm: { name: 'Armor',     tag: 'ARM', manpower: 90,  gold: 160, men: 90,  speed: 1.8,  atk: 1.6, taken: 1,   capt: 1.3, needs: 'factory' },
  art: { name: 'Artillery', tag: 'ART', manpower: 60,  gold: 120, men: 60,  speed: 0.75, atk: 1.3, taken: 1.5, capt: 0,   needs: 'factory' }
};

// --- economy ---
// Two resources. Manpower (p.pool) comes from land and Farms and is spent on soldiers and reinforcements.
// Gold (p.gold) comes from cities and Factories and is spent on equipment (division gold cost) and buildings.
export const MANPOWER = { base: 0.5, perTile: 0.005, perCity: 1, perFarm: 1 };
export const GOLD = { base: 0.25, perTile: 0.002, perCity: 0.75, perFactory: 4 };
export const START_POOL = { human: 300, ai: 250 };
export const START_GOLD = { human: 220, ai: 160 };

// --- buildings ---
// Farms can go on any owned land. Factories and Fortresses can only be placed within BUILD_RADIUS
// tiles of one of your cities. Buildings take `time` seconds to finish. When a tile changes hands a
// Fortress is destroyed, while a Farm or Factory changes hands intact.
export const BUILD_RADIUS = 5;
export const COST_GROWTH = 0.15;       // each extra Factory / Fortress costs this much more than the last
export const FORT_RANGE = 3;           // divisions within this many tiles of a Fortress take less damage
export const FORT_DEF = 0.6;           // damage multiplier for defenders covered by a Fortress
export const BUILDINGS = {
  farm:     { name: 'Farm',     gold: 25,  time: 6,  info: 'Manpower income on any of your land' },
  factory:  { name: 'Factory',  gold: 140, time: 20, info: 'Gold income; unlocks Armor and Artillery nearby' },
  fortress: { name: 'Fortress', gold: 110, time: 15, info: 'Defenders within 3 tiles take 40% less damage' }
};
export const BUILD_IDS = ['farm', 'factory', 'fortress'];   // world.bld stores index + 1 (0 = nothing)
