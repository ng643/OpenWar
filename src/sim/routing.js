// Routing is the sim's answer to a mauled division. A division wounded in combat below ROUT_FRAC of
// its strength breaks away along a seeded, enemy-avoiding escape route, keeps the order it was
// executing queued, and resumes that order from wherever it actually ends up once it has recovered to
// ROUT_RECOVER_FRAC. There is no refuge city and no healing ring any more: men come back through the
// ordinary reinforcement rules, so an escaped router simply waits out of contact until it can fight
// again, and a router that can never gain strength (or finds no way out) keeps holding its ground.
//
// A router that is cornered — a fresh enemy intercepts it, or it engages again after having broken
// contact — is locked for good: it never runs again and fights until it dies. Orders cannot undo that:
// while routing, move/halt/route orders are queued or dropped, never executed, and movement follows
// the escape route even while the division is still in melee.
//
// This module also owns explicit route orders (a polyline of checkpoints) and the single-file column
// discipline they can be issued with. A route lives on the division as `routePoints` (remaining
// checkpoints, first one = the destination of the leg currently in `path`); routing saves that state
// and recovery rebuilds it from the division's current tile, so a stale waypoint list is never
// replayed. Nothing here reroutes around traffic: the current leg's destination is the only target any
// jam recovery may take, which is why a route can never quietly skip a checkpoint.
import {
  TYPES, COLUMN_SPACING, MAX_ROUTE_POINTS,
  ROUT_FRAC, ROUT_RECOVER_FRAC, ROUT_MIN_DISTANCE, ROUT_MAX_DISTANCE
} from '../config.js';
import { tileOf } from './geom.js';
import { findPath, nearestLand } from './pathfinding.js';
import { freeTileNear, claimedEnds } from './collision.js';
import { emit } from './world.js';
import { clamp } from '../util.js';

const TWO_PI = Math.PI * 2;
/** How long a wounded division with nowhere to run waits before searching again (seconds). */
const RETRY = 5;
/** Escape candidates tried per break-off before falling back to the compass sweep. */
const FLEE_TRIES = 6;
/** How far an escape direction may stray from straight away from the enemy (radians). */
const FLEE_ARC = 0.6;
/** Whole tiles between the final checkpoints of two neighbours in a column. */
const COLUMN_STRIDE = Math.ceil(COLUMN_SPACING);

/** Tile index of a snapped checkpoint pair (values are tile centres, so truncation is exact). */
const pointTile = (world, p) => (p[1] | 0) * world.w + (p[0] | 0);

/** The centre of tile `t` as a checkpoint pair. */
const tilePoint = (world, t) => [(t % world.w) + .5, ((t / world.w) | 0) + .5];

/**
 * Turn an ordered polyline into resolvable checkpoints: each point is clamped to the map and snapped
 * to the nearest standable land, consecutive duplicates collapse, and the list is bounded by
 * MAX_ROUTE_POINTS. A point with nothing standable near it is dropped; a route with no resolvable
 * point at all is ignored, never guessed.
 */
function checkpoints(world, points) {
  const out = [];
  for (let i = 0; i < points.length && out.length < MAX_ROUTE_POINTS; i++) {
    const p = points[i];
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const t = nearestLand(world, clamp(p[0], 0, world.w - 1), clamp(p[1], 0, world.h - 1));
    if (t < 0) continue;
    const q = tilePoint(world, t);
    const last = out[out.length - 1];
    if (last && last[0] === q[0] && last[1] === q[1]) continue;
    out.push(q);
  }
  return out;
}

/**
 * Start the next leg of the ordered route: plan from the tile the division stands on to the first
 * remaining checkpoint, dropping checkpoints that are already underfoot or that no walk can reach
 * (terrain only — no body ever makes a checkpoint skippable). A no-op while a leg is still being
 * walked or while the division is busy routing somewhere else.
 */
export function advanceRoute(world, d) {
  if (d.path.length || d.routing || !d.routePoints.length) return;
  const from = tileOf(world, d);
  while (d.routePoints.length) {
    const t = pointTile(world, d.routePoints[0]);
    if (t === from) { d.routePoints.shift(); continue; }
    const path = findPath(world, from, t);
    if (!path) { d.routePoints.shift(); continue; }
    d.path = path;
    return;
  }
}

/** Drop all route state (remaining checkpoints and column membership). Position and orders are kept. */
export function clearRoute(d) {
  d.routePoints = [];
  d.column = false;
  d.colIdx = 0;
  d.colPrev = null;
  d.colSpeed = 0;
  d.colSlot = null;
  d.colTail = null;
  d.colGrp = null;
}

/**
 * The shared logical checkpoints of a column member's remaining order. A member's own staggered
 * standing slot (`d.colSlot`) is not one of them: it is only where that member parks for now, so
 * dropping it here is what re-promotes the common checkpoint behind the column when the order is
 * extended, instead of letting the member keep cutting the corner at its old shortened slot.
 */
function stripSlot(d) {
  const rp = d.routePoints;
  const last = rp[rp.length - 1];
  if (d.colSlot && last && last[0] === d.colSlot[0] && last[1] === d.colSlot[1]) return rp.slice(0, -1);
  return rp.slice();
}

/**
 * Replace a division's orders with a plain move to one tile: remaining checkpoints, column membership
 * and any pending walk back to displaced ground are all given up, and the leg is planned from where
 * the division stands. A tile no walk can reach leaves the division's orders untouched.
 * @returns {boolean} true when the order was given
 */
export function orderMove(world, d, tile) {
  const pa = findPath(world, tileOf(world, d), tile);
  if (!pa) return false;
  clearRoute(d);
  d.anchor = null;
  d.path = pa;
  d.aiGoal = null;
  return true;
}

/**
 * Put `pts` on a division as its ordered route: `append` keeps the checkpoints already queued (and,
 * when the route only exists as the leg underfoot, keeps that leg's destination as the first
 * checkpoint) and adds the new ones after them, up to the shared bound; otherwise the new list
 * replaces everything and the march starts over from the first checkpoint.
 */
function setRoute(world, d, pts, append) {
  d.anchor = null;                                  // a fresh order is the end of any pending return home
  if (append) {
    if (!d.routePoints.length && d.path.length) d.routePoints.push(tilePoint(world, d.path[d.path.length - 1]));
    for (const p of pts) if (d.routePoints.length < MAX_ROUTE_POINTS) d.routePoints.push(p);
  } else {
    clearRoute(d);
    d.routePoints = pts.slice();
    d.path = [];
    if (d.routePoints.length) advanceRoute(world, d);
  }
}

/**
 * Queue an ordered route on a routing division. The order is validated from where the division stands
 * now and becomes the intent recovery carries out; an order that cannot even be started is refused,
 * so a broken click never wipes the route the division was already holding. A column order saves more
 * than the flag: the shared membership and order (`grp`) come with it, because a group cannot be
 * rebuilt from a boolean — whoever recovers first has to be able to name every member and every
 * member's rank. An extension of a queued column keeps the column, and an extension of a queued plain
 * order stays a plain order.
 */
function queueOrder(world, d, pts, append, column = false, grp = null) {
  const from = tileOf(world, d);
  const first = pointTile(world, pts[0]);
  if (first !== from && !findPath(world, from, first)) return;
  const prior = d.routeResume;
  const merged = append && prior ? prior.routePoints.slice() : [];
  for (const p of pts) if (merged.length < MAX_ROUTE_POINTS) merged.push(p);
  const col = column === true || (append && prior ? prior.column === true : false);
  d.routeResume = {
    routePoints: merged,
    column: col,
    grp: col ? ((grp || (prior && prior.grp)) || { ids: [d.id] }) : null,
    aiGoal: null,
  };
}

/**
 * Queue ordered checkpoints on a division that is routing. Plain move and formation orders use this:
 * they cannot be executed while the division is withdrawing, so they become the intent recovery
 * carries out. An order that cannot even be started leaves the saved intent alone.
 */
export function queueRoute(world, d, points) { queueOrder(world, d, points, false); }

/**
 * Stop routing and resume the order saved when the break-off began, rebuilt from the tile the
 * division is standing on now: the saved checkpoints become the route again and the first leg is
 * planned from here, never replayed from a stale waypoint list. The scope of the saved order
 * (`aiGoal`) is restored only when there is a route to carry it.
 */
function resumeOrder(world, d) {
  const idea = d.routeResume;
  d.routing = false;
  d.routeResume = null;
  d.routFoes.clear();
  d.routClear = false;
  d.path = [];
  clearRoute(d);
  if (idea && idea.routePoints.length) {
    if (idea.column) resumeColumn(world, d, idea);
    else {
      d.routePoints = idea.routePoints.slice();
      advanceRoute(world, d);
    }
    d.aiGoal = d.path.length ? (idea.aiGoal || null) : null;
  } else {
    d.aiGoal = null;
  }
}

/**
 * Rejoin the column this division was marching when it broke off. It takes back its place in the
 * shared order — its rank is its old position in the group, so every member converges on the same
 * bends in the same sequence — and re-cuts its own staggered standing slot from the shared logical
 * route the break-off saved, at a free tile behind the member ahead rather than on the leader's tile.
 * Its pace is the slowest surviving member's, its spacing reference is the nearest surviving member
 * that was ahead of it, and members that recover at different times all rebuild the same column, each
 * landing on its own rank's slot instead of stacking on whoever got there first.
 */
function resumeColumn(world, d, idea) {
  const grp = idea.grp && Array.isArray(idea.grp.ids) && idea.grp.ids.length ? idea.grp : { ids: [d.id] };
  const ids = grp.ids.slice();
  if (!ids.includes(d.id)) ids.push(d.id);
  const rank = ids.indexOf(d.id);
  const alive = new Map();
  for (const u of world.divs) if (u.men > 0) alive.set(u.id, u);
  d.column = true;
  d.colIdx = rank;
  d.colGrp = grp;
  let slow = TYPES[d.type].speed;
  for (const id of ids) {
    const u = alive.get(id);
    if (u && TYPES[u.type].speed < slow) slow = TYPES[u.type].speed;
  }
  d.colSpeed = slow;
  d.colPrev = null;
  for (let k = rank - 1; k >= 0; k--) {
    const u = alive.get(ids[k]);
    if (u && u !== d) { d.colPrev = u; break; }
  }
  const used = claimedEnds(world);
  if (d.path.length) used.delete(d.path[d.path.length - 1]);         // its own escape destination
  if (d.anchor) used.delete((d.anchor.y | 0) * world.w + (d.anchor.x | 0));
  const skip = new Set([d]);
  for (const id of ids) { const u = alive.get(id); if (u) skip.add(u); }
  const cut = columnCut(world, d, idea.routePoints.slice(), COLUMN_STRIDE * rank, used, skip);
  d.routePoints = cut.route;
  d.colSlot = cut.slot;
  d.colTail = cut.tail;
  advanceRoute(world, d);
}

/**
 * One escape candidate: a point `dist` tiles away in direction `ang`, snapped to land and reached by
 * a real path. The tile actually snapped to has to be an honest ROUT_MIN_DISTANCE..ROUT_MAX_DISTANCE
 * away — a candidate that comes up short of a break-off is refused, and so is one whose snap leaps
 * past the bound. There is no relaxed fallback: a mauled division with no qualified ground in reach
 * holds its ground and searches again later.
 */
function tryFlee(world, d, ang, dist) {
  const t = nearestLand(world, clamp(d.x + Math.cos(ang) * dist, 0, world.w - 1),
                        clamp(d.y + Math.sin(ang) * dist, 0, world.h - 1));
  if (t < 0) return null;
  const gap = Math.hypot((t % world.w) + .5 - d.x, ((t / world.w) | 0) + .5 - d.y);
  if (gap < ROUT_MIN_DISTANCE || gap > ROUT_MAX_DISTANCE) return null;
  const path = findPath(world, tileOf(world, d), t);
  return path ? { tile: t, path } : null;
}

/**
 * Pick an escape route: a reachable land tile ROUT_MIN_DISTANCE..ROUT_MAX_DISTANCE tiles away in a
 * direction away from the enemies currently fighting the division, jittered by the seeded world RNG so
 * every host and every replay agrees on where a broken division runs. Work is bounded (a handful of
 * seeded tries, then the compass sweep); a destination is never off-map or in water, and the division
 * walks there, it never teleports.
 */
function fleeRoute(world, d) {
  let bx = 0, by = 0;
  for (const [a, b, ranged] of world.fights) {
    if (ranged) continue;
    if (a === d) { bx += d.x - b.x; by += d.y - b.y; }
    else if (b === d) { bx += d.x - a.x; by += d.y - a.y; }
  }
  const base = (bx || by) ? Math.atan2(by, bx) : world.rand() * TWO_PI;
  for (let k = 0; k < FLEE_TRIES; k++) {
    const ang = base + (world.rand() - 0.5) * 2 * FLEE_ARC;
    const want = ROUT_MIN_DISTANCE + world.rand() * (ROUT_MAX_DISTANCE - ROUT_MIN_DISTANCE);
    const r = tryFlee(world, d, ang, want);
    if (r) return r;
  }
  for (let k = 0; k < 8; k++) {                       // boxed in: try the eight compass directions
    const r = tryFlee(world, d, (k * Math.PI) / 4, ROUT_MIN_DISTANCE);
    if (r) return r;
  }
  return null;
}

/**
 * Break off: save the order the division was executing (the leg underfoot counts as its first
 * checkpoint), spend the escape route, and stamp the rout state. A column member saves the shared
 * logical route instead — its private staggered slot is not an order, so it is dropped and rebuilt
 * from rank when the member recovers. The enemies it was fighting are kept by id so that a fresh one
 * can be told apart from the melee it is leaving.
 */
function rout(world, d) {
  const flee = fleeRoute(world, d);
  if (!flee) { d.routRetryT = world.time + RETRY; return; }
  let resume;
  if (d.column) {
    resume = stripSlot(d);
    if (Array.isArray(d.colTail)) for (const p of d.colTail) resume.push(p);
  } else {
    // The order being executed: the leg underfoot's destination first (routePoints[0] by invariant),
    // then the checkpoints after it — never twice, so recovery replays the same route exactly.
    const leg = d.path.length ? d.path[d.path.length - 1] : -1;
    resume = [];
    if (leg >= 0) resume.push(tilePoint(world, leg));
    let skip = leg >= 0 && d.routePoints.length > 0 && pointTile(world, d.routePoints[0]) === leg;
    for (const p of d.routePoints) {
      if (skip && pointTile(world, p) === leg) { skip = false; continue; }
      resume.push(p);
    }
  }
  d.routeResume = {
    routePoints: resume,
    column: d.column,
    grp: d.column ? (d.colGrp || { ids: [d.id] }) : null,
    aiGoal: d.aiGoal || null,
  };
  clearRoute(d);
  d.anchor = null;
  d.routing = true;
  d.routClear = false;
  d.routFoes.clear();
  for (const [a, b, ranged] of world.fights) {
    if (ranged) continue;
    if (a === d) d.routFoes.add(b.id);
    else if (b === d) d.routFoes.add(a.id);
  }
  d.path = flee.path;
  emit(world, 'divisionRout', { div: d });
}

/**
 * The route of one member of a column: the ordered polyline cut `back` tiles before its end, so the
 * member's final checkpoint is a staggered slot of its own behind the endpoint, while the common
 * checkpoints before the cut are kept — that is what keeps the whole column single file through the
 * same bends. The cut point is snapped to the nearest free tile — not another division's claimed
 * destination, not within a column gap of a slot already handed out (the reserved halo), and not a
 * body's parking spot. The result separates the route the member walks now (`route`), the private slot
 * it parks on (`slot`, null when it stands on a common checkpoint), and the shared checkpoints still
 * beyond that slot (`tail`), which is what lets a later order promote this member's old endpoint to a
 * bend instead of re-cutting the corner from a shortened slot. A stagger reaching past the start of
 * the route walks every common bend and then steps back off the first one onto a slot of its own, so a
 * short final leg cannot hide a bend; with no free ground for that slot the member ends on the last
 * common checkpoint it can hold.
 */
function columnCut(world, d, pts, back, used, skip) {
  if (pts.length < 2) {
    if (back <= 0) return { route: pts.slice(), slot: null, tail: [] };
    const dx = pts[0][0] - d.x, dy = pts[0][1] - d.y;
    const L = Math.hypot(dx, dy);
    if (L <= back) return { route: [], slot: null, tail: pts.slice() };
    const tile = freeTileNear(world, pts[0][0] - (dx / L) * back, pts[0][1] - (dy / L) * back, used, skip, false);
    if (tile < 0) return { route: [], slot: null, tail: pts.slice() };
    reserve(world, used, tile);
    const slot = tilePoint(world, tile);
    if (slot[0] === pts[0][0] && slot[1] === pts[0][1]) return { route: [], slot: null, tail: pts.slice() };
    return { route: [slot], slot, tail: pts.slice() };
  }
  if (back <= 0) {
    // The front member walks the ordered route itself and stands on its endpoint.
    const last = pts[pts.length - 1];
    const head = pts.slice(0, -1);
    const tile = freeTileNear(world, last[0], last[1], used, skip, false);
    if (tile < 0) return { route: head, slot: null, tail: [last] };
    reserve(world, used, tile);
    const slot = tilePoint(world, tile);
    const prev = head[head.length - 1];
    if (prev && prev[0] === slot[0] && prev[1] === slot[1]) return { route: head, slot: null, tail: [last] };
    return { route: [...head, slot], slot: null, tail: [] };
  }
  let rem = back;
  for (let i = pts.length - 1; i > 0; i--) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (L < rem) { rem -= L; continue; }
    const t = L > 1e-9 ? 1 - rem / L : 1;
    const tile = freeTileNear(world, pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
                                     pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, used, skip, false);
    const head = pts.slice(0, i);
    if (tile < 0) return { route: head, slot: null, tail: pts.slice(i) };
    reserve(world, used, tile);
    const slot = tilePoint(world, tile);
    const last = head[head.length - 1];
    if (last && last[0] === slot[0] && last[1] === slot[1]) return { route: head, slot: null, tail: pts.slice(i) };
    return { route: [...head, slot], slot, tail: pts.slice(i) };
  }
  // The stagger reaches past the start of the route: this member's own slot lies on the line the
  // shared route's first leg was laid along, extended past its first checkpoint. The member walks
  // straight to that slot — its path is drawn up to the checkpoint and past it, so a short final leg
  // is never silently skipped over — because the checkpoint itself sits inside the spacing of the
  // member standing on the endpoint and so can never be stood on. The whole shared route stays as the
  // tail, so extending the order later still re-promotes every bend.
  const l0 = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
  const ux = (pts[0][0] - pts[1][0]) / l0, uy = (pts[0][1] - pts[1][1]) / l0;
  const tail = pts.slice();
  const tile = freeTileNear(world, pts[0][0] + ux * rem, pts[0][1] + uy * rem, used, skip, false);
  if (tile < 0) return { route: [], slot: null, tail };
  reserve(world, used, tile);
  return { route: [tilePoint(world, tile)], slot: tilePoint(world, tile), tail };
}

/** Keep the tile and its four neighbours out of every later member's reach: a column gap apart. */
function reserve(world, used, tile) {
  used.add(tile);
  const x = tile % world.w, y = (tile / world.w) | 0;
  if (x > 0) used.add(tile - 1);
  if (x < world.w - 1) used.add(tile + 1);
  if (y > 0) used.add(tile - world.w);
  if (y < world.h - 1) used.add(tile + world.w);
}

/**
 * Give `units` an ordered route: `points` is a polyline of [x, y] world positions, at least one and at
 * most MAX_ROUTE_POINTS. Every point becomes a real land checkpoint, and the division walks them in
 * order — one leg at a time, stopping on the last — so a multi-bend order is actually followed round
 * its bends instead of being cut down to the last click. With `append`, the points extend the route
 * the division already has; without it they replace it.
 *
 * With `column`, the units march the same checkpoints single file: they are ordered deterministically
 * (closest to the first checkpoint first, ties by id), the leader's pace is capped to the slowest
 * member of the column, every follower keeps at least COLUMN_SPACING behind the division ahead, and
 * each member's final checkpoint is staggered a whole rank behind the ordered endpoint on a free tile
 * of its own — so a mixed-speed group arrives as a spaced column, nobody overtakes, and the column
 * actually finishes instead of queueing up behind the leader's tile. A member extending its own column
 * keeps the common checkpoints it has still to walk plus the shared ones beyond its private slot, so
 * the column's old endpoint becomes an intermediate bend for the whole file instead of each follower
 * turning early at its own shortened slot.
 *
 * A division that is routing does not execute the order now: it is validated from where it stands and
 * queued as the intent recovery resumes — for a column, together with the group's membership and order
 * so the same spaced column can be rebuilt member by member as they recover.
 */
export function issueRoute(world, units, points, { append = false, column = false } = {}) {
  if (!units || !units.length || !Array.isArray(points) || !points.length) return;
  const pts = checkpoints(world, points);
  if (!pts.length) return;
  const live = [], waiting = [];
  for (const d of units) { if (d.routing) waiting.push(d); else live.push(d); }
  if (!column) {
    for (const d of waiting) queueOrder(world, d, pts, append);
    for (const d of live) setRoute(world, d, pts, append);
    return;
  }
  const alive = new Map();
  for (const u of world.divs) if (u.men > 0) alive.set(u.id, u);
  // The column's order is sticky: extending an existing column keeps its membership sequence (that is
  // what makes every rank the same rank it held before), and only genuinely new members join at the
  // back, nearest to the first checkpoint first.
  let prior = null;
  for (const d of units) {
    const g = d.colGrp || (d.routeResume && d.routeResume.grp);
    if (g && Array.isArray(g.ids)) { prior = g; break; }
  }
  // A group that has finished standing is only the same group when the order extends it: an append, or
  // the same membership, or members still under way. A genuinely new selection must not inherit ranks
  // (and pace) from an unrelated finished column.
  if (prior && !append) {
    const underWay = prior.ids.some((id) => {
      const u = alive.get(id);
      return u && (u.routing || u.path.length || u.routePoints.length);
    });
    if (!underWay && units.some((d) => !prior.ids.includes(d.id))) prior = null;
  }
  const ids = [];
  if (prior) for (const id of prior.ids) if (alive.has(id) && !ids.includes(id)) ids.push(id);
  for (const d of units.filter(d => !ids.includes(d.id)).sort((a, b) => {
    const da = (a.x - pts[0][0]) ** 2 + (a.y - pts[0][1]) ** 2;
    const db = (b.x - pts[0][0]) ** 2 + (b.y - pts[0][1]) ** 2;
    return da - db || a.id - b.id;
  })) ids.push(d.id);
  const grp = { ids };
  const rankOf = new Map(ids.map((id, k) => [id, k]));
  for (const d of waiting) queueOrder(world, d, pts, append, true, grp);
  if (!live.length) return;
  let slow = Infinity;
  for (const id of ids) {
    const u = alive.get(id);
    if (u && TYPES[u.type].speed < slow) slow = TYPES[u.type].speed;
  }
  if (!Number.isFinite(slow)) slow = TYPES[live[0].type].speed;
  const used = claimedEnds(world);
  for (const d of live) {
    if (d.path.length) used.delete(d.path[d.path.length - 1]);   // its own claim is released here
    if (d.anchor) used.delete((d.anchor.y | 0) * world.w + (d.anchor.x | 0));
  }
  const skip = new Set(units);
  const order = live.slice().sort((a, b) => rankOf.get(a.id) - rankOf.get(b.id));
  for (const d of order) {
    const rank = rankOf.get(d.id);
    let shared = pts;
    if (append) {
      shared = stripSlot(d);
      if (d.column && Array.isArray(d.colTail)) {
        for (const p of d.colTail) if (shared.length < MAX_ROUTE_POINTS) shared.push(p);
      }
      if (!shared.length && !d.column && d.path.length) shared.push(tilePoint(world, d.path[d.path.length - 1]));
      for (const p of pts) if (shared.length < MAX_ROUTE_POINTS) shared.push(p);
      const merged = [];                       // re-adding the same bend is still the same bend
      for (const p of shared) {
        const last = merged[merged.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) merged.push(p);
      }
      shared = merged;
    }
    const cut = columnCut(world, d, shared, COLUMN_STRIDE * rank, used, skip);
    d.routePoints = cut.route;
    d.path = [];
    d.anchor = null;
    d.column = true;
    d.colIdx = rank;
    d.colPrev = null;
    for (let k = rank - 1; k >= 0; k--) {
      const u = alive.get(ids[k]);
      if (u && u !== d) { d.colPrev = u; break; }
    }
    d.colSpeed = slow;
    d.colSlot = cut.slot;
    d.colTail = cut.tail;
    d.colGrp = grp;
    advanceRoute(world, d);
  }
}

/**
 * Authoritative routing pass: run every tick after combat and before movement.
 *   1. a division wounded in this step's fighting below ROUT_FRAC breaks off;
 *   2. a router that has been intercepted — engaged by a fresh enemy, or engaged again after having
 *      broken contact — is locked: no more running, it fights until it dies. Interception is judged
 *      before recovery, so a router that reaches ROUT_RECOVER_FRAC on the very tick it is caught is
 *      locked rather than quietly resuming its order;
 *   3. a router that has recovered to ROUT_RECOVER_FRAC resumes the queued order from where it stands;
 *   4. a division with checkpoints left but no leg underfoot starts the next leg (nothing to do while
 *      it is routing: that path belongs to the escape).
 */
export function updateRouting(world) {
  for (const d of world.divs) {
    if (d.routing) {
      if (d.eng) {
        let fresh = false;
        for (const [a, b, ranged] of world.fights) {
          if (ranged) continue;
          const foe = a === d ? b : b === d ? a : null;
          if (foe && !d.routFoes.has(foe.id)) { fresh = true; break; }
        }
        if (fresh || d.routClear) {
          resumeOrder(world, d);
          d.routLocked = true;
          emit(world, 'divisionCornered', { div: d });
          continue;
        }
      } else {
        d.routClear = true;                    // out of contact once: engaging again locks it
      }
      if (d.men >= d.cap * ROUT_RECOVER_FRAC) {
        resumeOrder(world, d);
        emit(world, 'divisionRecovered', { div: d });
        continue;
      }
      continue;
    }
    if (d.routLocked) { advanceRoute(world, d); continue; }
    if (d.tookFire && d.men < d.cap * ROUT_FRAC && world.time >= (d.routRetryT || 0)) {
      rout(world, d);
      continue;
    }
    advanceRoute(world, d);
  }
}
