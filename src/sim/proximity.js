import { BUILD_IDS } from '../config.js';
import { allied } from './teams.js';

const FORT_ID = BUILD_IDS.indexOf('fortress') + 1;

/**
 * Is `unit` within `range` tiles (inclusive) of a friendly installation of `kind`? Friendly means the
 * unit's own or a teammate's (see teams.js); neutral and enemy property never covers.
 *
 * Shared owner-aware proximity checks for city centres and completed fortress cover.
 * Distances are inclusive and squared; no allocation or sqrt on this hot path.
 *
 * Cities are tested from their tile centre (c.x + .5, c.y + .5). Fortresses come from world.forts,
 * but that list is only rebuilt by the ~1s recount, so it can be stale right after a fortress is
 * captured or destroyed: every candidate is therefore re-checked against the live tile, which must
 * still hold a fortress that has finished (bdone <= world.time) and be held by the unit's side. A
 * dead, unfinished or enemy-held fort never protects, and the check costs nothing once the tile is
 * verified.
 *
 * @param {object} world
 * @param {{x:number, y:number, owner:number}} unit
 * @param {'city'|'fortress'} kind
 * @param {number} range  tiles, inclusive
 * @returns {boolean}
 */
export function nearFriendly(world, unit, kind, range) {
  const r2 = range * range, x = unit.x, y = unit.y, owner = unit.owner;
  if (kind === 'fortress') {
    for (const f of world.forts) {
      if (!allied(world, f.owner, owner)) continue;
      const dx = f.x - x, dy = f.y - y;
      if (dx * dx + dy * dy > r2) continue;
      const t = ((f.y - .5) | 0) * world.w + ((f.x - .5) | 0);   // world.forts entries are tile centres
      if (world.bld[t] === FORT_ID && allied(world, world.owner[t], owner) && world.bdone[t] <= world.time) return true;
    }
    return false;
  }
  for (const c of world.cities) {
    if (!allied(world, c.owner, owner)) continue;
    const dx = c.x + .5 - x, dy = c.y + .5 - y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}
