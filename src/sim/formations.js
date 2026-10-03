import { freeTileNear } from './collision.js';

/** Shared bound on a formation polyline, enforced by the authoritative command and by the client. */
export const MAX_FORMATION_POINTS = 128;

const clampX = (world, v) => v < 0 ? 0 : v > world.w - 1 ? world.w - 1 : v;
const clampY = (world, v) => v < 0 ? 0 : v > world.h - 1 ? world.h - 1 : v;

/**
 * Polyline formation geometry, shared by the client preview and the authoritative order.
 * `points` is [[x,y], ...] with at least two pairs; a straight line is just two points.
 * Every point is clamped to the map. Unit targets sit at equal spacing by TOTAL ARC LENGTH along the
 * clamped polyline, both endpoints included; a lone unit takes the arc midpoint. Repeated and
 * zero-length segments are allowed (they add no length). Each unit is assigned a target in order of
 * its nearest projection onto the polyline, keyed by cumulative arc distance from the start
 * (ascending, id breaks ties). A two-point line uses the plain unbounded projection instead, so
 * straight formations keep exactly the ordering they always had. Every target is snapped to the
 * nearest free land tile: land that is not water and that no body at rest is holding, with each tile
 * used at most once per call, so a compressed or degenerate polyline still spreads its units over
 * distinct ground instead of stacking them. x/y stay the raw intended position on the polyline, so the
 * preview draws the shape the player drew. Assignment depends only on the polyline and each unit's
 * id/position, so client and server agree. No pathfinding happens here.
 * @returns {{id:number, tile:number, x:number, y:number}[]} one slot per unit in draw order;
 *   x/y = intended world position on the polyline, tile = nearest free land or -1 when none is near.
 */
export function formationSlots(world, units, points) {
  const n = points.length;
  const px = new Float64Array(n), py = new Float64Array(n);
  for (let i = 0; i < n; i++) { px[i] = clampX(world, points[i][0]); py[i] = clampY(world, points[i][1]); }
  const cum = new Float64Array(n);                       // arc length from the start up to each vertex
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
  const total = cum[n - 1];

  // Ordering key: cumulative arc distance of the unit's nearest projection onto the polyline.
  let key;
  if (n === 2) {
    const dx = px[1] - px[0], dy = py[1] - py[0], len2 = dx * dx + dy * dy;
    key = d => len2 > 0 ? ((d.x - px[0]) * dx + (d.y - py[0]) * dy) / len2 : 0;
  } else {
    key = d => {
      let best = 0, bd = Infinity;
      for (let i = 1; i < n; i++) {
        const ax = px[i - 1], ay = py[i - 1];
        const ex = px[i] - ax, ey = py[i] - ay, len2 = ex * ex + ey * ey;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((d.x - ax) * ex + (d.y - ay) * ey) / len2)) : 0;
        const qx = ax + ex * t - d.x, qy = ay + ey * t - d.y, dd = qx * qx + qy * qy;
        if (dd < bd) { bd = dd; best = cum[i - 1] + (cum[i] - cum[i - 1]) * t; }
      }
      return best;
    };
  }
  const keys = new Map();
  for (const d of units) keys.set(d, key(d));            // one scan per unit, never inside the comparator
  const us = units.slice().sort((a, b) => keys.get(a) - keys.get(b) || a.id - b.id);

  // World position at arc distance `s` (zero-length segments are skipped, so degenerate input is safe).
  const at = s => {
    if (total <= 0 || s <= 0) return [px[0], py[0]];
    if (s >= total) return [px[n - 1], py[n - 1]];
    for (let i = 1; i < n; i++) {
      const seg = cum[i] - cum[i - 1];
      if (seg <= 0 || cum[i] < s) continue;
      const t = (s - cum[i - 1]) / seg;
      return [px[i - 1] + (px[i] - px[i - 1]) * t, py[i - 1] + (py[i] - py[i - 1]) * t];
    }
    return [px[n - 1], py[n - 1]];
  };

  const m = us.length, used = new Set(), skip = new Set(us);
  return us.map((d, k) => {
    const [x, y] = at(m > 1 ? (k / (m - 1)) * total : total * 0.5);
    const tile = freeTileNear(world, x, y, used, skip);
    if (tile >= 0) used.add(tile);
    return { id: d.id, tile, x, y };
  });
}
