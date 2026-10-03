import { LAND, BUILD_RADIUS, BUILDINGS, BUILD_IDS, COST_GROWTH } from '../config.js';
import { emit, setBuilding } from './world.js';

/** True once a building has finished construction. */
export const isActive = (world, t) => world.bld[t] !== 0 && world.bdone[t] <= world.time;

/** Within BUILD_RADIUS of a city owned by `pid`? */
export function nearOwnCity(world, pid, t) {
  const x = t % world.w, y = (t / world.w) | 0;
  for (const c of world.cities) {
    if (c.owner === pid && Math.hypot(c.x - x, c.y - y) <= BUILD_RADIUS) return true;
  }
  return false;
}

/**
 * Can `pid` place a building of `type` on tile `t`? (ignores money)
 * Farms: any owned plain land. Factory / Fortress: also within BUILD_RADIUS of an owned city.
 * Never on cities, water, mountains or occupied tiles.
 */
export function canBuild(world, pid, type, t) {
  if (!BUILDINGS[type] || !Number.isInteger(t) || t < 0 || t >= world.w * world.h) return false;
  if (world.terr[t] !== LAND || world.owner[t] !== pid || world.cityAt[t] >= 0 || world.bld[t] !== 0) return false;
  return type === 'farm' || nearOwnCity(world, pid, t);
}

export function countBuilt(world, pid, type) {
  const id = BUILD_IDS.indexOf(type) + 1;
  let n = 0;
  for (let i = 0; i < world.w * world.h; i++) if (world.bld[i] === id && world.owner[i] === pid) n++;
  return n;
}

/** Gold price of the next building of this type (Factories and Fortresses get dearer as you build more). */
export function buildCost(world, pid, type) {
  const base = BUILDINGS[type].gold;
  return type === 'farm' ? base : Math.round(base * (1 + COST_GROWTH * countBuilt(world, pid, type)));
}

/**
 * Place buildings on the given tiles, paying gold for each, stopping when money runs out.
 * @returns {{placed:number}}
 */
export function placeBuildings(world, p, type, tiles) {
  const id = BUILD_IDS.indexOf(type) + 1;
  let placed = 0;
  for (const t of tiles) {
    if (!canBuild(world, p.id, type, t)) continue;
    const cost = buildCost(world, p.id, type);
    if (p.gold < cost) {
      if (!placed) emit(world, 'buildFailed', { player: p, reason: 'gold', need: cost });
      break;
    }
    p.gold -= cost;
    setBuilding(world, t, id, world.time + BUILDINGS[type].time);
    if (p.built) p.built[type]++;
    placed++;
  }
  return { placed };
}

/** A working Factory within BUILD_RADIUS of this city (needed to raise Armor / Artillery there). */
export function hasFactory(world, pid, city) {
  const id = BUILD_IDS.indexOf('factory') + 1;
  const r = Math.ceil(BUILD_RADIUS);
  for (let y = Math.max(0, city.y - r); y <= Math.min(world.h - 1, city.y + r); y++) {
    for (let x = Math.max(0, city.x - r); x <= Math.min(world.w - 1, city.x + r); x++) {
      const t = y * world.w + x;
      if (world.bld[t] === id && world.owner[t] === pid && world.bdone[t] <= world.time && Math.hypot(x - city.x, y - city.y) <= BUILD_RADIUS) return true;
    }
  }
  return false;
}

/**
 * Tally buildings per player (server / local sim only; run about once a second). Fills
 * p.built (all, incl. under construction), p.active (finished) and world.forts (finished Fortresses).
 */
export function recount(world) {
  for (const p of world.players) {
    p.built = { farm: 0, factory: 0, fortress: 0 };
    p.active = { farm: 0, factory: 0, fortress: 0 };
  }
  world.forts = [];   // finished fortress tile centres; consumers must re-check the live tile (see proximity.js)
  for (let i = 0; i < world.w * world.h; i++) {
    const b = world.bld[i];
    if (!b) continue;
    const o = world.owner[i];
    if (!o) continue;
    const type = BUILD_IDS[b - 1], p = world.players[o - 1];
    p.built[type]++;
    if (world.bdone[i] <= world.time) {
      p.active[type]++;
      if (type === 'fortress') world.forts.push({ x: (i % world.w) + .5, y: ((i / world.w) | 0) + .5, owner: o });
    }
  }
}
