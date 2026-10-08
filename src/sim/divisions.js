import { TYPES, MERGE_RANGE, MERGE_STACK, SPLIT_MIN_MEN } from '../config.js';
import { emit } from './world.js';
import { findPath } from './pathfinding.js';
import { formationSlots } from './formations.js';
import { tileOf } from './geom.js';
import { hasFactory } from './buildings.js';
import { spawnSpot, freeTileNear, claimedEnds } from './collision.js';
import { orderMove, queueRoute } from './routing.js';

/**
 * Create a division near (x, y), on the nearest free land tile. Bodies are solid, so a new division is
 * placed on clear ground instead of on top of whoever is already there.
 * @returns {object|null} the division, or null when there is no legal ground anywhere near (x, y)
 */
export function spawnDiv(world, owner, x, y, men, cap, type = 'inf') {
  const spot = spawnSpot(world, x, y);
  if (!spot) return null;
  const d = {
    id: world.nextId++, owner, type, x: spot.x, y: spot.y, px: spot.x, py: spot.y,
    men, cap: cap || men,
    path: [],            // tiles of the leg being walked (last tile = goal of this leg)
    routePoints: [],     // ordered checkpoints left to visit, as [x, y] tile centres (see routing.js)
    column: false,       // marching as part of a single-file column
    colIdx: 0,           // position in that column (0 = leader)
    colPrev: null,       // the division ahead, or null for the leader
    colSpeed: 0,         // slowest member's pace: the column's top speed
    eng: false,          // in melee this tick
    tookFire: false,     // damaged by combat this tick (the marker routing reads)
    oos: false,          // out of supply
    routing: false,      // fleeing after being mauled (see routing.js)
    routLocked: false,   // intercepted: never flees again, fights until it dies
    routClear: false,    // it has been out of contact once since the rout began
    routFoes: new Set(), // ids of the enemies it was already fighting when the rout began
    routRetryT: 0,       // earliest time to retry a break-off that found no way out
    routeResume: null,   // order saved when routing began, resumed from wherever recovery happens
    anchor: null,        // ground this body was displaced from, to walk back to (see collision.makeWay)
    returnT: 0,          // earliest time to start walking back there
    vis: true,           // visible to the human (client-side fog)
    acc: 0,              // land-capture accumulator: a fresh body banks nothing (a split half gets its share)
    aiGoal: null,
    nextThink: world.time + 1 + world.rand() * 2
  };
  world.divs.push(d);
  return d;
}

/**
 * Raise a division of `type` at `city`, paying manpower and gold. With no (valid) city, the capital is used,
 * or for factory-bound types the first city that has a Factory. Returns the division or null; failures
 * emit 'raiseFailed' with reason 'funds' (manpower), 'gold', 'nocity', 'factory' or 'space' (no free
 * ground left around the city). A failure never costs anything.
 */
export function raiseDivision(world, p, city, type = 'inf') {
  const T = TYPES[type];
  if (!p || !p.alive) return null;
  const mine = world.cities.filter(c => c.owner === p.id);
  const ok = c => !T.needs || hasFactory(world, p.id, c);
  if (!city || city.owner !== p.id) {
    city = mine.find(c => c.capital && ok(c)) || mine.find(ok) || null;
    if (!city && mine.length) { emit(world, 'raiseFailed', { player: p, reason: 'factory' }); return null; }
  } else if (!ok(city)) { emit(world, 'raiseFailed', { player: p, reason: 'factory' }); return null; }
  if (!city) { emit(world, 'raiseFailed', { player: p, reason: 'nocity' }); return null; }
  if (p.pool < T.manpower) { emit(world, 'raiseFailed', { player: p, reason: 'funds', need: T.manpower }); return null; }
  if (p.gold < T.gold) { emit(world, 'raiseFailed', { player: p, reason: 'gold', need: T.gold }); return null; }
  const spot = spawnSpot(world, city.x + .5, city.y + .5);
  if (!spot) { emit(world, 'raiseFailed', { player: p, reason: 'space' }); return null; }
  p.pool -= T.manpower; p.gold -= T.gold;
  const d = spawnDiv(world, p.id, spot.x, spot.y, T.men, T.men, type);
  if (city.rally !== null) {
    // Recruits heading for one rally point would all be sent to the same tile, and the first to arrive
    // would sit on it and block the rest for good. Each takes ground of its own beside the rally point.
    const t = freeTileNear(world, (city.rally % world.w) + .5, ((city.rally / world.w) | 0) + .5, claimedEnds(world), new Set([d]));
    if (t >= 0) orderMove(world, d, t);
  }
  return d;
}

/**
 * Send units to a world position, fanned out in a loose grid. Every unit gets its own reachable land
 * tile: a slot that lands on water, or on ground a body at rest is holding, is moved to the nearest
 * free tile, so two divisions are never sent to the same spot — and a tile somebody is already marching
 * to is left alone, since whoever gets there first would block the other for good.
 * A unit with no free tile near its slot keeps its current orders.
 */
export function issueMove(world, units, wx, wy) {
  if (!units.length) return;
  const n = units.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const us = units.slice().sort((a, b) => a.x - b.x), slots = [];
  for (let k = 0; k < n; k++) {
    const cx = k % cols, cy = (k / cols) | 0;
    slots.push([wx + (cx - (cols - 1) / 2) * 1.6, wy + (cy - (rows - 1) / 2) * 1.6]);
  }
  slots.sort((a, b) => a[0] - b[0]);
  const skip = new Set(us), used = claimedEnds(world);
  // A unit being re-ordered gives up its old claim: otherwise a unit sent to the very point it is
  // already marching to would be nudged onto a neighbouring tile, and every repeat of the order would
  // shuffle it between the two. A routing unit's route is not changing, so its claim stays put.
  for (const u of us) if (!u.routing && u.path.length) used.delete(u.path[u.path.length - 1]);
  us.forEach((d, k) => {
    const t = freeTileNear(world, slots[k][0], slots[k][1], used, skip);
    if (t < 0) return;
    used.add(t);
    // A routing division is not re-routed: the order is queued and carried out after it has recovered.
    // Substituting the escape route here would turn a withdrawal into a combat bypass. An order with no
    // route is not worth queueing either — the one already saved stays.
    if (d.routing) { queueRoute(world, d, [[(t % world.w) + .5, ((t / world.w) | 0) + .5]]); return; }
    orderMove(world, d, t);
  });
}

/**
 * Send units to a polyline formation: each unit gets its own slot from `formationSlots` and is routed
 * there with the same per-unit pathing and semantics as a point move. `points` is [[x,y], ...] with at
 * least two pairs, so a straight line is an ordinary two-point call. Slots with no reachable land are
 * left untouched.
 */
export function issueFormation(world, units, points) {
  if (!units.length) return;
  const byId = new Map(units.map(d => [d.id, d]));
  for (const { id, tile } of formationSlots(world, units, points)) {
    if (tile < 0) continue;
    const d = byId.get(id);
    // Same rule as a point move: a routing division keeps withdrawing and carries out the formation
    // slot once it is back to strength — but only if that slot has a route at all.
    if (d.routing) { queueRoute(world, d, [[(tile % world.w) + .5, ((tile / world.w) | 0) + .5]]); continue; }
    orderMove(world, d, tile);
  }
}

/** Stop where the division stands: the route it was about to walk and the ground it was heading back
 *  to are both given up, but a division that is routing keeps its escape route — halting must not
 *  strand a mauled body in the line it is leaving. */
export function haltDivs(units) {
  for (const d of units) {
    d.routeResume = null;
    if (d.routing) continue;
    d.routePoints = [];
    d.column = false;
    d.colIdx = 0;
    d.colPrev = null;
    d.colSpeed = 0;
    d.anchor = null;
    d.path = [];
  }
}

/**
 * Split one atomic unit off each division holding more than one. The peeled body is a whole atomic
 * of the type (TYPES[type].men men and nominal capacity); it takes ground next to its parent, and a
 * division with no free ground beside it is left alone, so splitting never loses men. Banked capture
 * credit follows the men it is attached to. A body of one atomic or less, a dead, inert, engaged,
 * routing or rout-locked division is refused.
 * @returns {object[]} the newly created atomic bodies
 */
export function splitDivs(world, units) {
  const added = [];
  for (const d of units) {
    if (d.merged || d.eng || d.routing || d.routLocked) continue;
    const unit = TYPES[d.type].men;
    // A split peels whole atomics: the body must hold strictly more than one atomic of men and of
    // nominal capacity, so a 10-stack splits back down to exactly ten atomics and a single atomic
    // (or any wounded fragment of one) can never be divided.
    if (d.men <= unit || d.cap <= unit) continue;
    if (d.men < SPLIT_MIN_MEN) continue;
    const spot = spawnSpot(world, d.x + .35, d.y + .2);
    if (!spot) continue;
    const credit = d.acc || 0, share = credit * (unit / d.men);
    d.men -= unit; d.cap -= unit; d.acc = credit - share;
    const n = spawnDiv(world, d.owner, spot.x, spot.y, unit, unit, d.type);
    n.acc = share;
    // The half marches to ground of its own beside its parent. Copying the parent's route would send it
    // to the parent's own tile, where it would queue up behind a body that can never be pushed off.
    const t = freeTileNear(world, d.x + 1.5, d.y, claimedEnds(world), new Set([n]));
    if (t >= 0) orderMove(world, n, t);
    added.push(n);
  }
  return added;
}

/**
 * Merge whole same-owner, same-type detachments whose centres stand within MERGE_RANGE tiles of each
 * other, provided the combined men AND combined nominal capacity still fit MERGE_STACK atomics of the
 * type (MERGE_STACK * TYPES[type].men: infantry 1000, armor 900, artillery 600). A stack merges up to
 * that ceiling and splits back down to whole atomics; merging never heals for free (men and capacity
 * are conserved) and beyond the ceiling a unit simply stays standing. Survivors are processed
 * strongest-first (id as the tie-break) and every eligible target greedily takes on whatever still
 * fits it. Banked capture credit is summed but still bounded by the bank cap of 3, the absorber keeps
 * its orders, state and ground, and absorbed donors are handed over before being zeroed (and removed
 * by the next tick), so the survivors hold the whole budget.
 * Dead, inert, engaged, routing or rout-locked divisions are refused; a healthy marching unit may merge.
 * @returns {{absorbed: object[]}}
 */
export function mergeDivs(units) {
  const absorbed = [];
  const eligible = d => !d.merged && d.men > 0 && !d.eng && !d.routing && !d.routLocked;
  for (const type of Object.keys(TYPES)) {
    const lim = TYPES[type].men * MERGE_STACK;
    const group = units.filter(d => d.type === type && eligible(d))
      .sort((a, b) => b.men - a.men || a.id - b.id);
    for (const t of group) {
      if (!eligible(t)) continue;                 // an earlier survivor already absorbed this one
      for (const d of group) {
        if (d === t || !eligible(d) || d.owner !== t.owner) continue;
        if (Math.hypot(d.x - t.x, d.y - t.y) > MERGE_RANGE) continue;
        if (t.men + d.men > lim || t.cap + d.cap > lim) continue;   // at most ten atomics in one body
        t.men += d.men; t.cap += d.cap;
        t.acc = Math.min(3, (t.acc || 0) + (d.acc || 0));               // credit sums, bank cap holds
        d.men = 0; d.cap = 0; d.acc = 0; d.merged = true;
        absorbed.push(d);
      }
    }
  }
  return { absorbed };
}
