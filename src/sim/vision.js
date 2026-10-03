import { VISION, CITY_VIS } from '../config.js';
import { allied } from './teams.js';

/**
 * The divisions `viewerId` can see: their own and their allies' (shared vision: an ally's body is
 * visible wherever it stands, and allied divisions and cities spot exactly like one's own), plus
 * enemies within VISION of one of those divisions or CITY_VIS of one of those cities. With fog off,
 * everything. Used by the server to filter snapshots per player, and by the local client to set
 * `vis` flags.
 */
export function visibleDivs(world, viewerId, fogOn) {
  if (!fogOn) return world.divs.slice();
  const mine = [], cs = [], out = [];
  for (const d of world.divs) if (allied(world, d.owner, viewerId)) mine.push(d);
  for (const c of world.cities) if (allied(world, c.owner, viewerId)) cs.push(c);
  for (const d of world.divs) {
    if (allied(world, d.owner, viewerId)) { out.push(d); continue; }
    let v = false;
    for (const m of mine) {
      if (Math.abs(m.x - d.x) < VISION && Math.abs(m.y - d.y) < VISION && Math.hypot(m.x - d.x, m.y - d.y) < VISION) { v = true; break; }
    }
    if (!v) for (const c of cs) if (Math.hypot(c.x + .5 - d.x, c.y + .5 - d.y) < CITY_VIS) { v = true; break; }
    if (v) out.push(d);
  }
  return out;
}

/** Local (single-player) rendering: set each division's `vis` flag from the viewer's point of view. */
export function updateVisibility(world, viewerId, fogOn) {
  const seen = new Set(visibleDivs(world, viewerId, fogOn));
  for (const d of world.divs) d.vis = seen.has(d);
}
