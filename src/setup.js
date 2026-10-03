import { W, H, WIN_SHARE } from './config.js';
import { cityCapacity } from './sim/city-layout.js';

export const MAP_SIZES = Object.freeze({
  small: Object.freeze({ name: 'Small', w: 100, h: 64 }),
  standard: Object.freeze({ name: 'Standard', w: W, h: H }),
  large: Object.freeze({ name: 'Large', w: 200, h: 128 })
});

/** Nominal player seats a map size can offer (6 capitals + area-scaled neutral cities): 14 / 24 / 38. */
export function maxCityCapacity(mapSize) {
  if (!Object.hasOwn(MAP_SIZES, mapSize)) throw new Error('Choose a supported map size');
  const size = MAP_SIZES[mapSize];
  return cityCapacity(size.w, size.h);
}

/** The victory target is a land share; any whole percent between these bounds is legal. */
export const MIN_VICTORY_SHARE = 0.5;
export const MAX_VICTORY_SHARE = 1;

/** Accept a land share in [0.5, 1] and canonicalize it to whole percent, shedding float noise once. */
function normalizeVictoryShare(share) {
  if (typeof share !== 'number' || !Number.isFinite(share) || share < MIN_VICTORY_SHARE || share > MAX_VICTORY_SHARE) {
    throw new Error('Invalid victory target');
  }
  return Math.round(share * 100) / 100;
}

export const DEFAULT_SETTINGS = Object.freeze({
  mapSize: 'standard',
  factions: Object.freeze([1, 2, 3, 4, 5, 6]),
  bots: Object.freeze([]),
  teams: null,
  teamCount: 2,
  startingResources: 1,
  incomeMultiplier: 1,
  victoryShare: WIN_SHARE,
  fog: true,
  seed: null,
  aiDifficulty: 'medium'
});

/** AI policy difficulty presets, shared by the setup form and the authoritative lobby. */
export const AI_DIFFICULTIES = Object.freeze([
  Object.freeze({ id: 'easy', name: 'Easy' }),
  Object.freeze({ id: 'medium', name: 'Medium' }),
  Object.freeze({ id: 'hard', name: 'Hard' })
]);

export function defaultSettings() {
  const d = DEFAULT_SETTINGS;
  return { ...d, factions: [...d.factions], bots: [...d.bots], teams: d.teams && [...d.teams] };
}

/**
 * Canonical settings shared by local setup, the authoritative lobby, and world mirrors.
 * Factions are the enabled participant ids (any count up to this map's nominal capacity); `bots` are
 * the factions reserved for AI, `teams` maps each faction to a team id (null = every faction for
 * itself), and `teamCount` bounds those ids.
 */
export function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid game settings');
  const s = { ...DEFAULT_SETTINGS, ...value };
  // the new lobby fields are optional: a caller that passes them as undefined asks for their defaults
  if (s.bots === undefined) s.bots = [];
  if (s.teams === undefined) s.teams = null;
  if (s.teamCount === undefined) s.teamCount = DEFAULT_SETTINGS.teamCount;
  if (!Object.hasOwn(MAP_SIZES, s.mapSize)) throw new Error('Choose a supported map size');
  const size = MAP_SIZES[s.mapSize];
  const max = cityCapacity(size.w, size.h);
  if (!Array.isArray(s.factions) || s.factions.length < 2 ||
      s.factions.some(id => !Number.isInteger(id)) ||
      new Set(s.factions).size !== s.factions.length) throw new Error('Choose at least two distinct factions');
  if (s.factions.some(id => id < 1 || id > max)) {
    throw new Error('Faction ids must be 1 to ' + max + ' on a ' + s.mapSize + ' map');
  }
  if (!Array.isArray(s.bots) || s.bots.some(id => !Number.isInteger(id) || !s.factions.includes(id))) {
    throw new Error('Bots must be enabled factions');
  }
  if (s.teams !== null && (!Array.isArray(s.teams) || s.teams.length !== s.factions.length)) {
    throw new Error('Teams must pair with every enabled faction');
  }
  if (!Number.isInteger(s.teamCount) || s.teamCount < 2 || s.teamCount > s.factions.length) {
    throw new Error('Invalid team count');
  }
  if (s.teams !== null && s.teams.some(t => !Number.isInteger(t) || t < 1 || t > s.teamCount)) {
    throw new Error('Team ids must be 1 to ' + s.teamCount);
  }
  if (s.teams !== null && new Set(s.teams).size < 2) throw new Error('Teams must use at least two different team ids');
  if (![0.5, 1, 2].includes(s.startingResources)) throw new Error('Invalid starting resource multiplier');
  if (![0.5, 1, 2].includes(s.incomeMultiplier)) throw new Error('Invalid income multiplier');
  s.victoryShare = normalizeVictoryShare(s.victoryShare);
  if (typeof s.fog !== 'boolean') throw new Error('Invalid fog setting');
  if (s.seed !== null && (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 2147483647)) throw new Error('Seed must be a whole number from 0 to 2147483647');
  if (!AI_DIFFICULTIES.some(d => d.id === s.aiDifficulty)) throw new Error('Invalid AI difficulty');
  // faction ids and their team ids travel as pairs, so sorting one keeps the other in step
  const seats = s.factions.map((id, i) => ({ id, team: s.teams === null ? 0 : s.teams[i] }))
    .sort((a, b) => a.id - b.id);
  return {
    mapSize: s.mapSize, w: size.w, h: size.h,
    factions: seats.map(x => x.id),
    bots: [...new Set(s.bots)].sort((a, b) => a - b),
    teams: s.teams === null ? null : seats.map(x => x.team),
    teamCount: s.teamCount,
    startingResources: s.startingResources, incomeMultiplier: s.incomeMultiplier,
    victoryShare: s.victoryShare, fog: s.fog, seed: s.seed, aiDifficulty: s.aiDifficulty
  };
}
