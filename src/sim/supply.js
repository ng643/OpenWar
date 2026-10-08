import {
  LOGISTICS_DISTANCE, ISOLATED_COMBAT, REINFORCE_RATE, ROAD_LOGISTICS_COST, TCOST, WATER, TYPES
} from '../config.js';
import { tileOf } from './geom.js';

/**
 * Logistics: how well a division is connected to the cities its side holds.
 *
 * A supply path runs over friendly non-water land from a division's tile (or, for a division standing
 * on neutral/enemy ground, one initial frontier step onto an adjacent connected friendly tile) to the
 * nearest friendly city, 8-way, with the same no-corner-cut rule as unit pathfinding: a diagonal step
 * is refused when either of the two tiles it cuts the corner between cannot carry the path. "Friendly"
 * means owned by the division's owner or by a teammate (see teams.js): a side shares one logistics
 * field — a single search from every city any member holds, over every member's land — so an ally's
 * city supplies my divisions and an ally's ground conducts for me, while enemy and neutral ground
 * never conducts supply, so capturing a corridor cuts divisions off and retaking it reconnects them.
 * In FFA every enabled player is its own side (p.team === p.id), which is exactly the old one field
 * per player.
 *
 * Step cost is TCOST[terrain] * (diagonal ? 1.414 : 1) — the same scale findPath uses — and a road
 * tile carries supply for ROAD_LOGISTICS_COST of that, so roads shrink the effective distance to a
 * city. DIST = effective distance to the nearest connected owned city (0 on a city tile), Infinity
 * when nothing connects. Nothing here is a radius: a unit deep inside its own (captured) land is
 * connected, and from neutral or enemy ground a division reaches supply through its one initial
 * frontier step only, so a unit beyond the adjacent connected frontier is isolated.
 *
 * Distances are cached per world in a module-level WeakMap (so several worlds of different sizes can
 * be simulated side by side, with sparse player ids, without reallocating or mixing state) and are
 * rebuilt lazily whenever the world's ownerVersion or roadVersion changed. Every consumer therefore
 * reads a fresh value on the very next call after an ownership or road change — no stale window
 * between a capture and the damage or reinforcement that follows it.
 */
const caches = new WeakMap();

// The 8-neighbour order and diagonal scale match findPath, keeping supply geometry consistent with
// what divisions can actually walk.
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DIAG = 1.414;

/** Binary min-heap over (tile, cost); its arrays are reused between searches so rebuilds allocate nothing. */
class Heap {
  constructor() { this.cost = []; this.tile = []; }
  get size() { return this.tile.length; }
  clear() { this.tile.length = 0; this.cost.length = 0; }
  push(tile, cost) {
    const C = this.cost, T = this.tile;
    let i = C.length;
    C.push(cost); T.push(tile);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (C[p] <= C[i]) break;
      [C[p], C[i]] = [C[i], C[p]]; [T[p], T[i]] = [T[i], T[p]];
      i = p;
    }
  }
  pop() {
    const C = this.cost, T = this.tile, top = T[0], lastC = C.pop(), lastT = T.pop();
    if (T.length) {
      C[0] = lastC; T[0] = lastT;
      let i = 0; const n = T.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < n && C[l] < C[m]) m = l;
        if (r < n && C[r] < C[m]) m = r;
        if (m === i) break;
        [C[m], C[i]] = [C[i], C[m]]; [T[m], T[i]] = [T[i], T[m]];
        i = m;
      }
    }
    return top;
  }
}

/** The cache slot for `world`, (re)sized to the world's map and player slot count. */
function cacheFor(world) {
  let c = caches.get(world);
  const n = world.w * world.h, np = world.players.length;
  if (!c) {
    c = { n: 0, np: 0, heap: new Heap(), stampN: 0, ownerVersion: -1, roadVersion: -1 };
    caches.set(world, c);
  }
  if (c.n !== n || c.np !== np) {
    c.n = n; c.np = np;
    c.stamp = new Int32Array(n);
    c.closed = new Int32Array(n);
    c.ownerVersion = -1;              // fresh fields: force the next ensure to rebuild them
    layout(world, c);
  }
  return c;
}

/**
 * (Re)build the per-side distance and predecessor fields. Teammates share one field per side (see
 * teams.js): every member's `dist`/`pred` slot points at the same arrays, so one search serves the
 * whole team. A player with no side (disabled slot, or enabled without a team) gets private zeroed
 * arrays and no group, which reads as cut off everywhere — the same answer `allied` gives it.
 */
function layout(world, c) {
  const n = c.n, np = c.np;
  c.dist = new Array(np);
  c.pred = new Array(np);
  c.playerStamp = new Int32Array(np);
  c.side = new Int32Array(np + 1);    // side key per player id (0 = no side), indexed by owner id
  c.sides = [];
  const byKey = new Map();
  for (const p of world.players) {
    const k = p.enabled ? (p.team | 0) : 0;
    if (!k) {
      c.dist[p.id - 1] = new Float32Array(n);
      c.pred[p.id - 1] = new Int32Array(n);
      continue;
    }
    c.side[p.id] = k;
    let g = byKey.get(k);
    if (!g) {
      g = { k, dist: new Float32Array(n), pred: new Int32Array(n), members: [] };
      byKey.set(k, g);
      c.sides.push(g);
    }
    c.dist[p.id - 1] = g.dist;
    c.pred[p.id - 1] = g.pred;
    g.members.push(p.id - 1);
  }
}

/** True when the enabled players' sides no longer match the laid-out fields (never true mid-match). */
function teamsChanged(world, c) {
  for (const p of world.players) {
    if (c.side[p.id] !== (p.enabled ? (p.team | 0) : 0)) return true;
  }
  return false;
}

/**
 * Multi-source Dijkstra per side: from every city any member still holds, over the non-water land
 * any member owns. One computation id per side marks its tiles, so the shared stamp arrays hold one
 * run per team; teammates read the same field and the same predecessor tree.
 */
function rebuild(world, c) {
  const { w, h, owner, terr, cities } = world;
  const roads = world.roads;
  const stamp = c.stamp, closed = c.closed, heap = c.heap, side = c.side;
  for (const g of c.sides) {
    const s = ++c.stampN;
    for (const pi of g.members) c.playerStamp[pi] = s;
    const gd = g.dist, gp = g.pred, key = g.k;
    heap.clear();
    for (const city of cities) {
      const t = city.idx;
      // A city supplies only while the side still holds it: the city slot and the live tile must both
      // belong to a member (an ally's city is a source for the whole team).
      if (side[city.owner] !== key || side[owner[t]] !== key) continue;
      stamp[t] = s; gd[t] = 0; gp[t] = -1; heap.push(t, 0);     // sources are final at distance 0
    }
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur] === s) continue;                          // a later duplicate in the heap
      closed[cur] = s;
      const dc = gd[cur];
      const cx = cur % w, cy = (cur / w) | 0;
      for (let k = 0; k < 8; k++) {
        const dx = DIRS[k][0], dy = DIRS[k][1], nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (side[owner[ni]] !== key || terr[ni] === WATER) continue;
        let step = TCOST[terr[ni]];
        if (roads[ni]) step *= ROAD_LOGISTICS_COST;
        if (dx && dy) {
          // No corner cutting: both tiles the diagonal squeezes between must carry the path too.
          const c1 = cy * w + nx, c2 = ny * w + cx;
          if (side[owner[c1]] !== key || terr[c1] === WATER || side[owner[c2]] !== key || terr[c2] === WATER) continue;
          step *= DIAG;
        }
        const ng = dc + step;
        if (stamp[ni] !== s || ng < gd[ni]) { stamp[ni] = s; gd[ni] = ng; gp[ni] = cur; heap.push(ni, ng); }
      }
    }
  }
}

/** Rebuild the cached distance fields if the world changed ownership, roads or sides since the last build. */
function ensure(world) {
  const c = cacheFor(world);
  const ov = world.ownerVersion | 0, rv = world.roadVersion | 0;
  const staleSides = teamsChanged(world, c);
  if (staleSides || c.ownerVersion !== ov || c.roadVersion !== rv) {
    if (staleSides) layout(world, c);   // a side change re-groups the fields; never mid-match
    rebuild(world, c);
    c.ownerVersion = ov; c.roadVersion = rv;
  }
  return c;
}

/**
 * The neighbour a division standing on foreign ground draws supply through: the cheapest adjacent
 * friendly tile that is itself connected (stamped by the side's own computation) and reachable under
 * the frontier corner rule (a diagonal needs both shoulders side-held and dry). -1 when no reachable
 * friendly neighbour exists — foreign land never conducts supply beyond that single step.
 */
function frontierEntry(world, c, pid, tile) {
  const { w, h, owner, terr } = world;
  const roads = world.roads;
  const pi = pid - 1, key = c.side[pid];
  if (!key) return -1;                                       // no side: no friendly ground to step onto
  const pd = c.dist[pi], s = c.playerStamp[pi];
  const x = tile % w, y = (tile / w) | 0;
  let best = Infinity, bestTile = -1;
  for (let k = 0; k < 8; k++) {
    const dx = DIRS[k][0], dy = DIRS[k][1], nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const ni = ny * w + nx;
    if (c.side[owner[ni]] !== key || c.stamp[ni] !== s) continue;
    if (dx && dy) {
      // The frontier step keeps the pathfinding corner rule too: both shoulders must be conducting
      // (side-held, non-water) ground, so supply never slips diagonally past foreign land.
      const c1 = y * w + nx, c2 = ny * w + x;
      if (c.side[owner[c1]] !== key || terr[c1] === WATER || c.side[owner[c2]] !== key || terr[c2] === WATER) continue;
    }
    let step = TCOST[terr[ni]];
    if (roads[ni]) step *= ROAD_LOGISTICS_COST;
    if (dx && dy) step *= DIAG;
    const d = pd[ni] + step;
    if (d < best) { best = d; bestTile = ni; }
  }
  return bestTile;
}

/**
 * Distance for a division standing outside its side's territory: exactly one initial frontier step
 * onto an adjacent connected friendly tile (the same no-corner-cut rule applies, so a diagonal needs
 * both shoulders side-held and dry), then that tile's cached distance. Infinity when no reachable
 * friendly neighbour exists — foreign land never conducts supply beyond that single step.
 */
function frontierDistance(world, c, pid, tile) {
  const entry = frontierEntry(world, c, pid, tile);
  if (entry < 0) return Infinity;
  const { w, terr } = world;
  let step = TCOST[terr[entry]];
  if (world.roads[entry]) step *= ROAD_LOGISTICS_COST;
  if (entry % w !== tile % w && ((entry / w) | 0) !== ((tile / w) | 0)) step *= DIAG;
  return c.dist[pid - 1][entry] + step;
}

/**
 * Rebuild the per-world logistics caches if they are stale. Called at world creation and before every
 * combat step; every other reader rebuilds lazily on its own, so an ownership or road change is
 * always visible to the next consumer even without an explicit call.
 */
export function updateLogistics(world) {
  ensure(world);
}

/**
 * Effective logistics distance from `unit` to the nearest city its owner still holds, or Infinity
 * when cut off. 0 when standing on an owned city tile; roads and terrain shape the path cost.
 */
export function logisticsDistance(world, unit) {
  const c = ensure(world);
  const pi = (unit.owner | 0) - 1;
  if (pi < 0 || pi >= c.np) return Infinity;
  const tile = tileOf(world, unit);
  if (c.stamp[tile] === c.playerStamp[pi]) return c.dist[pi][tile];
  // Not on connected side land. Ground the unit's side holds but which is cut off stays cut off;
  // neutral and enemy ground is connected only through the single initial frontier step (never
  // arbitrary traversal over foreign land).
  const key = c.side[unit.owner | 0];
  if (key !== 0 && c.side[world.owner[tile]] === key) return Infinity;
  return frontierDistance(world, c, unit.owner, tile);
}

/**
 * The actual supply chain for `unit` as tile indices, from the division's own tile to the nearest
 * friendly city that supplies it — its owner's or an ally's (both ends included). Same geometry,
 * costs and tie-breaking as logisticsDistance, so the chain's step costs sum to that distance and
 * every step lands on ground the path is allowed to cross. A division outside its side's territory
 * starts with its own tile followed by the one frontier step; a division cut off from every
 * friendly city returns null (never a fabricated line). The chain is the Dijkstra predecessor tree,
 * so it is acyclic and a pure read: combat, reinforcement and healing are untouched and stay
 * allocation-free.
 */
export function logisticsPath(world, unit) {
  const c = ensure(world);
  const pid = unit.owner | 0, pi = pid - 1;
  if (pi < 0 || pi >= c.np) return null;
  const pp = c.pred[pi], s = c.playerStamp[pi];
  let tile = tileOf(world, unit);
  const path = [];
  if (c.stamp[tile] !== s) {
    // Not on connected side land: side-held but cut-off land stays cut off (null); foreign ground
    // joins through exactly the single frontier step logisticsDistance allows.
    const key = c.side[pid];
    if (key !== 0 && c.side[world.owner[tile]] === key) return null;
    const entry = frontierEntry(world, c, pid, tile);
    if (entry < 0) return null;
    path.push(tile);
    tile = entry;
  }
  path.push(tile);
  while (pp[tile] >= 0) { tile = pp[tile]; path.push(tile); }
  return path;
}

/**
 * Damage-output multiplier for `unit`: ISOLATED_COMBAT + (1 - ISOLATED_COMBAT) / (1 + D / LOGISTICS_DISTANCE),
 * i.e. 1 at a city and easing down with effective distance; exactly ISOLATED_COMBAT when disconnected.
 * Isolation never removes men — it only blunts fighting.
 */
export function combatMult(world, unit) {
  const d = logisticsDistance(world, unit);
  if (!Number.isFinite(d)) return ISOLATED_COMBAT;
  return ISOLATED_COMBAT + (1 - ISOLATED_COMBAT) / (1 + d / LOGISTICS_DISTANCE);
}

/**
 * Reinforcement rate for `unit` in men/s. The old falloff REINFORCE_RATE / (1 + D / LOGISTICS_DISTANCE)
 * is scaled by how much of a standard body it commands — min(1, max(0, unit.cap / TYPES[unit.type].men)).
 * A full standard division (cap = its type's men) reinforces exactly as before; a fragment reinforcing
 * with a fraction of the nominal cap draws that fraction. Nominal-cap budgets partition, so splitting a
 * division never multiplies the paid men/s drawn at the same supply. 0 when isolated. Callers fund the
 * men man-for-man from the reserves pool and only while the division is unengaged and below its cap.
 */
export function reinforceRate(world, unit) {
  const d = logisticsDistance(world, unit);
  if (!Number.isFinite(d)) return 0;
  const scale = Math.min(1, Math.max(0, unit.cap / TYPES[unit.type].men));
  return (REINFORCE_RATE * scale) / (1 + d / LOGISTICS_DISTANCE);
}
