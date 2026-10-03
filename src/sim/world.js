import { WATER, LAND, BUILD_IDS, START_POOL, START_GOLD, participantName, participantColor } from '../config.js';
import { rng } from '../util.js';
import { normalizeSettings } from '../setup.js';
import { getAIPolicy, normalizeAIPolicy } from './ai-policy.js';
import { generateCityLayout } from './city-layout.js';
import { updateLogistics } from './supply.js';
import { recount } from './buildings.js';

// ---- events: the sim never touches the DOM or sockets, it just emits events others can react to ----
export function subscribe(world, fn) {
  world.listeners.push(fn);
  return () => { world.listeners = world.listeners.filter(f => f !== fn); };
}
export function emit(world, type, data) {
  for (const fn of world.listeners) fn(type, data);
}

/**
 * Create a fresh world.
 * @param {number} seed
 * @param {{settings?: object, humans?: string[], humanIds?: number[], aiDelay?: number, aiPolicies?: object}} opts
 *   settings = canonical settings (from normalizeSettings). world.w/world.h/world.settings are the
 *              authoritative dimensions/settings for this world. Defaults to the standard map.
 *   humans  = names of human players; each takes one of the enabled factions.
 *             Pass [] for an all-AI world / spectator host (tests, balance runs).
 *   humanIds = optional explicit faction id (1..world.cityCapacity, must be enabled and not a bot
 *              seat) for each humans[i]. When omitted, humans take the first open faction ids in
 *              order — for the default all-enabled settings that is ids 1..n, the original convention.
 *   aiDelay = seconds before AIs start acting.
 *   aiPolicies = OPTIONAL trusted per-player policy overrides, keyed by faction id (1..capacity). Only
 *              headless training passes this; it is deliberately separate from `settings`, which is
 *              the network-facing object, so arbitrary policies can never arrive through a lobby.
 *              Each overriding player gets p.aiPolicy = normalizeAIPolicy(aiPolicies[id]); everyone
 *              else gets the deployed getAIPolicy(settings.aiDifficulty).
 *
 * Player fields: `enabled` = the faction participates at all; `seat` = a human sits here (permanent);
 * `human` = a human is currently in control (false while disconnected, in which case the AI plays the
 * seat); `bot` = the seat is reserved for a forced AI (settings.bots) and no human may claim it.
 * `team` = the configured team id (own id when teams are off), 0 while disabled. Disabled factions
 * are inert: alive:false, no tiles/cities/land/units, never AI-driven. `world.players.length` equals
 * `world.cityCapacity`, the number of cities this seed actually generated.
 */
export function createWorld(seed, opts = {}) {
  const { humans = ['You'], aiDelay = 40, aiPolicies } = opts;
  const settings = opts.settings && opts.settings.w && opts.settings.h
    ? opts.settings
    : normalizeSettings(opts.settings ?? {});
  const { w, h } = settings;

  if (!Array.isArray(humans)) throw new Error('humans must be an array of names');
  if (aiPolicies != null && (typeof aiPolicies !== 'object' || Array.isArray(aiPolicies))) {
    throw new Error('aiPolicies must be a per-player record');
  }

  const enabled = settings.factions;
  const bots = Array.isArray(settings.bots) ? settings.bots : [];
  const teams = Array.isArray(settings.teams) ? settings.teams : null;

  // the generated layout decides the seat count: an unlucky seed can offer fewer cities than the
  // nominal capacity of its map size, and no faction can play without an initial city
  const layout = generateCityLayout(seed, w, h);
  const capacity = layout.cities.length;
  const homeless = enabled.find(id => id > capacity);
  if (homeless !== undefined) {
    throw new Error('Map has only ' + capacity + ' player cities: faction ' + homeless + ' has no city');
  }
  // bot seats are reserved for forced AI; the remaining enabled factions are open human seats
  const open = enabled.filter(id => !bots.includes(id));
  if (humans.length > open.length) throw new Error('too many human players');
  let humanIds;
  if (opts.humanIds != null) {
    humanIds = [...opts.humanIds];
    if (humanIds.length !== humans.length) throw new Error('humanIds must match humans one for one');
    const seen = new Set();
    for (const id of humanIds) {
      if (!Number.isInteger(id) || !enabled.includes(id)) throw new Error('Human faction is not enabled');
      if (bots.includes(id)) throw new Error('Faction ' + id + ' is reserved for a bot');
      if (seen.has(id)) throw new Error('Duplicate human faction');
      seen.add(id);
    }
  } else {
    humanIds = open.slice(0, humans.length);
  }
  const seatOf = new Map(humanIds.map((id, i) => [id, humans[i]]));
  const teamOf = new Map(enabled.map((id, i) => [id, teams ? teams[i] : id]));

  const { terr, elev, landCount } = layout;
  const world = {
    seed, w, h, settings, terr, elev, landCount,
    cityCapacity: capacity,
    owner: new Uint8Array(w * h),
    cityAt: new Int16Array(w * h).fill(-1),
    ownerVersion: 0,            // bumped whenever any tile changes owner (renderer cache key)
    changes: null,              // set to [] by a server to collect [tile, owner, ...] deltas for snapshots
    bld: new Uint8Array(w * h), // building per tile: 0 none, else BUILD_IDS index + 1
    bdone: new Float32Array(w * h), // world.time at which that building is finished
    bchanges: null,             // like changes, for buildings: [tile, type, done, ...]
    roads: new Uint8Array(w * h), // road per tile: 0 none, 1 road
    roadVersion: 0,             // bumped whenever any tile gains/loses a road (logistics/renderer cache key)
    rchanges: null,             // like changes, for roads: [tile, 0|1, ...]
    forts: [],                  // finished fortresses, rebuilt by recount() — lags captures by up to 1s (see proximity.js)
    cities: [], players: [], divs: [],
    nextId: 1, time: 0, fights: [],
    endT: 0,
    recountT: 0,               // game loop timer for the periodic completed-building recount (recount())
    over: false, result: null,
    rand: rng(seed ^ 0xC0FFEE), // deterministic sim randomness
    listeners: []
  };

  // one city object per generated city; the first `enabled.length` are handed to the participants
  layout.cities.forEach((c, i) => { world.cityAt[c.idx] = i; });
  world.cities = layout.cities.map(c => ({ ...c, owner: 0, rally: null }));

  const startMul = settings.startingResources;
  for (let i = 0; i < capacity; i++) {
    const id = i + 1;
    const on = enabled.includes(id);
    const humanName = seatOf.get(id);
    const seat = on && humanName !== undefined;
    const aiPolicy = aiPolicies && Object.hasOwn(aiPolicies, id)
      ? normalizeAIPolicy(aiPolicies[id])
      : getAIPolicy(settings.aiDifficulty);
    world.players.push({
      id, name: seat ? humanName : participantName(id), color: participantColor(id),
      enabled: on, seat, human: seat, bot: on && bots.includes(id), team: on ? teamOf.get(id) : 0,
      tiles: 0, cities: 0, army: 0, alive: on, nextAI: aiDelay + i * 0.4, aiPolicy,
      pool: Math.round((seat ? START_POOL.human : START_POOL.ai) * startMul), rate: 0, // manpower and its income/s
      gold: Math.round((seat ? START_GOLD.human : START_GOLD.ai) * startMul), goldRate: 0, // gold and its income/s
      built: { farm: 0, factory: 0, fortress: 0 }, active: { farm: 0, factory: 0, fortress: 0 }
    });
  }

  // every participant takes one of the generated cities as its capital; the rest stay neutral
  const homes = enabled.map((_, i) => world.cities[i]);
  homes.forEach((city, i) => {
    const pid = enabled[i];
    const sx = city.x, sy = city.y;
    city.capital = true;
    for (let y = sy - 4; y <= sy + 4; y++) for (let x = sx - 4; x <= sx + 4; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const j = y * w + x;
      if (world.terr[j] !== WATER && Math.hypot(x - sx, y - sy) <= 3.3 && world.owner[j] === 0) setOwner(world, j, pid);
    }
    // the seat's own city always belongs to it, even where two seats end up next to each other
    if (world.owner[city.idx] !== pid) setOwner(world, city.idx, pid);
  });

  // every seat starts with a working Factory next to its capital
  homes.forEach((city, i) => {
    const pid = enabled[i];
    const sx = city.x, sy = city.y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const j = (sy + dy) * w + sx + dx;
      if (world.terr[j] === LAND && world.owner[j] === pid && world.cityAt[j] < 0) { setBuilding(world, j, BUILD_IDS.indexOf('factory') + 1, 0); break; }
    }
  });

  updateLogistics(world);
  recount(world);
  return world;
}

/** Set (or clear, type 0) the building on a tile, logging the change for snapshots. */
export function setBuilding(world, i, type, done) {
  world.bld[i] = type;
  world.bdone[i] = type ? done : 0;
  if (world.bchanges) world.bchanges.push(i, type, type ? done : 0);
}

/** Set (or clear, 0) the road on a tile, logging the change for snapshots. */
export function setRoad(world, i, value) {
  value = value ? 1 : 0;
  if (world.roads[i] === value) return;
  world.roads[i] = value;
  world.roadVersion++;
  if (world.rchanges) world.rchanges.push(i, value);
}

/**
 * Change tile ownership, keeping player tallies and city ownership in sync.
 * `capture` (default true) is the hostile path: a captured Fortress is razed and buildingLost /
 * cityCaptured fire. A peaceful cession (cedeLand) passes false so buildings, their deadlines and
 * roads simply change hands with the land, without being reported as destroyed or captured.
 */
export function setOwner(world, i, p, capture = true) {
  const o = world.owner[i];
  if (o === p) return;
  const pl = world.players;
  if (o) pl[o - 1].tiles--;
  if (p) pl[p - 1].tiles++;
  world.owner[i] = p;
  world.ownerVersion++;
  if (world.bld[i]) {
    const type = BUILD_IDS[world.bld[i] - 1];
    // A captured Fortress is razed. Farms and Factories change hands intact, keeping their original
    // completion deadline, so work the previous owner paid for finishes on schedule for the captor;
    // ownership alone re-derives their income and factory unlock (owner scan / recount). Peaceful
    // cession razes nothing and reports nothing.
    if (capture) {
      if (type === 'fortress') setBuilding(world, i, 0, 0);
      if (o && world.time > 0) emit(world, 'buildingLost', { owner: o, type });
    }
  }
  if (world.changes) world.changes.push(i, p);
  const ci = world.cityAt[i];
  if (ci >= 0) {
    const c = world.cities[ci];
    if (o) pl[o - 1].cities--;
    if (p) pl[p - 1].cities++;
    c.owner = p;
    c.rally = null;     // the previous owner's rally point never survives an ownership change
    if (capture && world.time > 0) emit(world, 'cityCaptured', { city: c, by: p, from: o });
  }
}
