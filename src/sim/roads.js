import { MAX_ROUTE_POINTS, ROAD_GOLD, WATER } from '../config.js';
import { emit, setRoad } from './world.js';
import { findPath } from './pathfinding.js';

/**
 * Road points are canonical `[x, y]` pairs in tile/world coordinates: finite numbers, 2..MAX_ROUTE_POINTS
 * of them (the command layer enforces the same bound; this is module safety for direct callers).
 */
function canonicalPoints(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_ROUTE_POINTS) return false;
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
  }
  return true;
}

/** Tile index of the point, or -1 when it is off-map or water (roads never run through water). */
function tileAt(world, x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) return -1;
  const t = ty * world.w + tx;
  return world.terr[t] === WATER ? -1 : t;
}

/**
 * The road route for a polyline of points: the deduplicated tiles of every segment, in order, including
 * tiles that already carry a road. Routing is restricted to `playerId`'s own land — foreign territory
 * is impassable, so a road can never shortcut through enemy/neutral tiles (and diagonals cannot cut
 * such corners either, since findPath treats blocked tiles exactly like water corners).
 * @returns {number[]|null} route tiles (at least one) or null when the points are invalid, land on
 *   water/foreign tiles, or a segment is unreachable through own land.
 */
export function roadTiles(world, playerId, points) {
  if (!canonicalPoints(points)) return null;
  const { owner, w, h } = world;
  const blocked = new Set();
  for (let i = 0, n = w * h; i < n; i++) if (owner[i] !== playerId) blocked.add(i);

  const out = [], seen = new Set();
  const push = t => { if (!seen.has(t)) { seen.add(t); out.push(t); } };
  let prev = -1;
  for (const p of points) {
    const t = tileAt(world, p[0], p[1]);
    if (t < 0 || owner[t] !== playerId) return null;
    if (prev < 0) push(t);
    else {
      const seg = findPath(world, prev, t, blocked);
      if (!seg) return null;
      for (const s of seg) push(s);
    }
    prev = t;
  }
  return out;
}

/**
 * Build a road along the polyline, charging ROAD_GOLD for every tile that does not already carry a
 * road. All-or-nothing: ownership/water/unreachable routes and insufficient gold build nothing.
 * @returns {{ok: boolean, placed: number, cost: number}} tiles built and gold charged (0 on failure).
 */
export function placeRoads(world, playerId, points) {
  const tiles = roadTiles(world, playerId, points);
  if (!tiles) return { ok: false, placed: 0, cost: 0 };
  const p = world.players[playerId - 1];
  if (!p || !p.enabled || !p.alive) return { ok: false, placed: 0, cost: 0 };
  let fresh = 0;
  for (const t of tiles) if (!world.roads[t]) fresh++;
  const cost = fresh * ROAD_GOLD;
  if (p.gold < cost) {
    emit(world, 'buildFailed', { player: p, reason: 'gold', need: cost });
    return { ok: false, placed: 0, cost: 0 };
  }
  for (const t of tiles) if (!world.roads[t]) setRoad(world, t, 1);
  p.gold -= cost;
  return { ok: true, placed: fresh, cost };
}
