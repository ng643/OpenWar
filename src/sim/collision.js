// Solid division bodies: bodies keep a minimum centre distance, movement is swept (a step is clipped,
// slid sideways or refused before it could enter anyone) and nothing is shoved out of the way — a
// blocked division holds its ground and keeps its path, except that friendly traffic — the same
// owner or a teammate (see teams.js) — nudges a body that is only holding ground aside for a moment
// and it walks back to the exact spot afterwards.
// A nudge is taken out of the same per-tick walking budget as a step of the nudged body's own, so
// traffic can never displace it faster than its own feet could carry it. Everything here is
// deterministic: fixed candidate order, no randomness, no frame time beyond the step itself, so
// client, server and replays agree.
import { DIV_RADIUS, SPEED, STEP, TYPES, WATER } from '../config.js';
import { findPath } from './pathfinding.js';
import { tileOf } from './geom.js';
import { moveCost } from './travel.js';
import { allied } from './teams.js';

/** Minimum centre distance between two division bodies (tiles). */
export const MIN_SEP = DIV_RADIUS * 2;
// Contacts are judged a hair inside MIN_SEP: purely numerical slack so a grazing step is not refused by
// rounding — never a geometric allowance, so no two bodies ever come closer than MIN_SEP.
const CONTACT = MIN_SEP - 1e-9;
// Numerical slack for step arithmetic: one step may cover `len` plus this much, never more.
const EPS = 1e-7;
// Extra slack on the sagitta a swept step is allowed to dip inside a contact: the allowance is exact
// geometry, this is the floating-point hair on top of it so a step that slides along a contact is
// never refused. Far below anything that can be seen, and body positions stay outside CONTACT anyway.
const GRAZE = 1e-6;
// A body pinned by other bodies has its route rebuilt around them (see `reroute`) once it has spent
// this many ticks without moving. Each rebuild doubles the wait up to STUCK_MAX, so a jam costs a
// bounded handful of searches instead of one every tick, and a body that walks freely for STUCK_MAX
// ticks gets the short wait back.
const STUCK_TICKS = 24;
const STUCK_MAX = 180;
// How many jammed bodies may have their route rebuilt in one movement phase: a global jam rebuilds a
// few per tick instead of hammering A* hundreds of times at once, and the stall count is kept so the
// rest are served on the ticks that follow.
const REPLANS_PER_PHASE = 4;

// Uniform grid over the map, used for the contact queries of a movement phase. Bodies are bucketed by
// their live position in movement order, so a sweep sees earlier movers already advanced. CELL must
// stay above CONTACT + one step + one stale step (~1.2 tiles on plain land), so a 3x3 block around any
// point of interest can never miss a body that touches it. One grid per world, so worlds of different
// sizes can be simulated interleaved without reallocating or corrupting each other's buckets.
const CELL = 1.5;
const NO_DIVS = [];                // stand-in for worlds that have no divisions (geometry-only callers)
export const grids = new WeakMap();
export function gridFor(world) {
  let g = grids.get(world);
  if (!g) {
    const CW = Math.ceil(world.w / CELL), CH = Math.ceil(world.h / CELL);
    g = { CW, CH, head: new Int32Array(CW * CH), link: new Int32Array(0), linked: null, replansLeft: 0 };
    grids.set(world, g);
  }
  return g;
}

/** Bucket every division by position for the contact queries of this movement phase. */
export function indexBodies(world) {
  const divs = world.divs, g = gridFor(world), { CW, CH, head } = g;
  if (g.link.length < divs.length) g.link = new Int32Array(divs.length * 2);
  const link = g.link;
  head.fill(-1);
  for (let i = 0; i < divs.length; i++) {
    const d = divs[i];
    let cx = (d.x / CELL) | 0, cy = (d.y / CELL) | 0;
    if (cx < 0) cx = 0; else if (cx >= CW) cx = CW - 1;
    if (cy < 0) cy = 0; else if (cy >= CH) cy = CH - 1;
    const c = cy * CW + cx;
    link[i] = head[c]; head[c] = i;
  }
  g.linked = divs;
  g.replansLeft = REPLANS_PER_PHASE;
}

/** Terrain of the tile a world position falls in. */
const terrAt = (world, x, y) => world.terr[(y | 0) * world.w + (x | 0)];

/**
 * Is the body on the move? Real divisions say so with the path they follow; a client mirror, which is
 * never told anyone's route, says so with the `moving` flag it is given instead — a preview that
 * classified bodies differently from the server would hand out different ground. A body that is
 * walking back to ground it was temporarily displaced from (`anchor`) counts as moving too: the spot
 * it stands on is not its own while it is away, and the mirror must fold `anchor` into the same flag.
 * A body with checkpoints still to walk (`routePoints`) is on the move even between legs, so a route
 * that is only waiting for its next leg is never classified as parked.
 */
export function moving(d) {
  return (d.path ? d.path.length > 0 : false) || d.moving === true || d.anchor != null ||
         (d.routePoints ? d.routePoints.length > 0 : false);
}

/** A body that is only holding ground: no route of its own, not fighting. These are the bodies that
 *  friendly traffic may nudge aside for a moment (see `displace`). */
function holding(u) { return (!u.path || u.path.length === 0) && (!u.routePoints || u.routePoints.length === 0) && !u.eng; }

/** Is the body holding its ground? Bodies at rest, and anyone in melee, are not going anywhere. */
function parked(u) { return !moving(u) || u.eng; }

// --- contact queries -----------------------------------

/** Nearest body to (x, y) closer than the contact floor, or null. */
function nearestTouch(world, d, x, y) {
  const divs = world.divs, g = gridFor(world), { CW, CH, head, link } = g;
  const cx = (x / CELL) | 0, cy = (y / CELL) | 0;
  let best = null, bd = CONTACT;
  for (let j = cy - 1; j <= cy + 1; j++) {
    if (j < 0 || j >= CH) continue;
    for (let i = cx - 1; i <= cx + 1; i++) {
      if (i < 0 || i >= CW) continue;
      for (let k = head[j * CW + i]; k >= 0; k = link[k]) {
        const u = divs[k];
        if (u === d || u.men <= 0) continue;
        const dx = u.x - x, dy = u.y - y, dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < bd) { bd = dd; best = u; }
      }
    }
  }
  return best;
}

/**
 * Would the straight segment from the division's position to (x, y) come too close to a body?
 * A body already inside the floor must not be approached any further, everything else must stay
 * clear of the floor.
 */
function sweepHit(world, d, x, y) {
  const divs = world.divs, g = gridFor(world), { CW, CH, head, link } = g;
  const ex = x - d.x, ey = y - d.y, l2 = ex * ex + ey * ey;
  // A straight step between two points that are both clear of a body still dips inside its circle by
  // the chord's sagitta; allow that much — the formula is itself approximate, so a percent on top, and
  // a hair for floating point — so a step that slides along a contact is never refused. All of it is
  // far below anything visible, and the step's endpoints stay outside CONTACT regardless.
  const floor = l2 / (8 * CONTACT) * 1.01 + GRAZE;
  const cx = (d.x / CELL) | 0, cy = (d.y / CELL) | 0;
  for (let j = cy - 1; j <= cy + 1; j++) {
    if (j < 0 || j >= CH) continue;
    for (let i = cx - 1; i <= cx + 1; i++) {
      if (i < 0 || i >= CW) continue;
      for (let k = head[j * CW + i]; k >= 0; k = link[k]) {
        const u = divs[k];
        if (u === d || u.men <= 0) continue;
        const wx = u.x - d.x, wy = u.y - d.y, start = Math.sqrt(wx * wx + wy * wy);
        let t = l2 > 0 ? (wx * ex + wy * ey) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = wx - ex * t, qy = wy - ey * t;
        if (Math.sqrt(qx * qx + qy * qy) < (start < CONTACT ? start : CONTACT) - floor) return true;
      }
    }
  }
  return false;
}

/**
 * The body that stops the intended step first, or null. Used to decide whether the blocker is one the
 * mover has to give way to (a body at rest, or a higher-id mover coming towards it), and by movement to
 * tell "someone is standing in the way" from "the line runs into water" — a waypoint a body occupies is
 * only ever written off while a body is what blocks it.
 */
export function blockingBody(world, d, ux, uy, len) {
  const divs = world.divs, g = gridFor(world), { CW, CH, head, link } = g;
  const cx = (d.x / CELL) | 0, cy = (d.y / CELL) | 0;
  let best = null, bestS = Infinity;
  for (let j = cy - 1; j <= cy + 1; j++) {
    if (j < 0 || j >= CH) continue;
    for (let i = cx - 1; i <= cx + 1; i++) {
      if (i < 0 || i >= CW) continue;
      for (let k = head[j * CW + i]; k >= 0; k = link[k]) {
        const u = divs[k];
        if (u === d || u.men <= 0) continue;
        const ex = d.x - u.x, ey = d.y - u.y, c = ex * ex + ey * ey - CONTACT * CONTACT;
        let s = 0;
        if (c > 0) {
          const b = ex * ux + ey * uy;
          if (b >= 0) continue;                       // heading away from it
          const disc = b * b - c;
          if (disc < 0) continue;                     // passes it by
          s = -b - Math.sqrt(disc);
          if (s > len) continue;                      // it is beyond this step
        }
        if (s < bestS) { bestS = s; best = u; }
      }
    }
  }
  return best;
}

// --- step resolution -----------------------------------

/**
 * Does the segment (x0,y0)->(x1,y1) pass through any water tile? Walks the grid the way the line does
 * (Amanatides & Woo), so a step that only clips a water corner is caught too — checking the endpoint
 * alone would let a body cut across a bay. Bounded: a step spans a couple of tiles at most.
 */
function sweepsWater(world, x0, y0, x1, y1) {
  const terr = world.terr, w = world.w, h = world.h;
  const dx = x1 - x0, dy = y1 - y0, adx = Math.abs(dx), ady = Math.abs(dy);
  let tx = x0 | 0, ty = y0 | 0;
  const ex = x1 | 0, ey = y1 | 0;
  const tdx = adx > 0 ? 1 / adx : Infinity, tdy = ady > 0 ? 1 / ady : Infinity;
  let tmx = adx > 0 ? (dx > 0 ? tx + 1 - x0 : x0 - tx) / adx : Infinity;
  let tmy = ady > 0 ? (dy > 0 ? ty + 1 - y0 : y0 - ty) / ady : Infinity;
  for (let n = 0; n < 32; n++) {
    if (tx === ex && ty === ey) return false;
    if (tmx < tmy) { tx += dx < 0 ? -1 : 1; tmx += tdx; } else { ty += dy < 0 ? -1 : 1; tmy += tdy; }
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
    if (terr[ty * w + tx] === WATER) return true;
  }
  return false;
}

/**
 * Resolve one candidate direction against every nearby body.
 * The endpoint is pushed straight out of any body it would enter, never backwards and never further
 * than a step, and the swept segment must stay clear — otherwise the candidate is refused.
 * @returns {{x:number, y:number, gain:number}|null} resolved endpoint and its progress along `ux, uy`
 */
function attempt(world, d, ux, uy, len) {
  let x = d.x + ux * len, y = d.y + uy * len;
  let u = nearestTouch(world, d, x, y);
  for (let pass = 0; u && pass < 4; pass++) {
    const wx = x - u.x, wy = y - u.y, wd = Math.sqrt(wx * wx + wy * wy);
    if (wd < 1e-9) return null;                       // dead centre: no direction to slide out along
    x = u.x + (wx / wd) * MIN_SEP; y = u.y + (wy / wd) * MIN_SEP;
    const mx = x - d.x, my = y - d.y;
    if (mx * ux + my * uy < -1e-9) return null;       // would give up ground already gained
    if (mx * mx + my * my > (len + EPS) * (len + EPS)) return null;   // never further than one step
    u = nearestTouch(world, d, x, y);
  }
  if (u) return null;                                 // still touching after the passes
  if (x < 0 || y < 0 || x >= world.w || y >= world.h) return null;  // stays on the map
  if (terrAt(world, d.x, d.y) !== WATER && sweepsWater(world, d.x, d.y, x, y)) return null;  // never crosses water
  if (sweepHit(world, d, x, y)) return null;          // the way there is blocked
  return { x, y, gain: (x - d.x) * ux + (y - d.y) * uy };
}

// Directions tried when the straight line is stopped by a body the mover has to give way to. A fixed
// right-hand-first order keeps the detour identical for client, server and replays.
const TURN = Math.PI / 6;
const SIDESTEP = [TURN, -TURN, 2 * TURN, -2 * TURN, 3 * TURN, -3 * TURN];
// A division within this much of its destination stops side-stepping around *parked* bodies and waits
// instead, so it never circles a body sitting on its goal. A body still on the move is walked around
// even inside this range: two divisions ordered past each other near their targets have to get by.
const GIVE_WAY = 2;

/**
 * Do we have to give way to `u`? A body at rest always wins; between two movers the higher id gives
 * way, but only to one that is coming towards it — a stable tie-break that never lets two divisions
 * lock each other head-on while keeping columns behind a leader in line.
 */
function yields(world, d, u, ux, uy) {
  if (parked(u)) return true;
  if (u.id > d.id) return false;                      // the lower id has right of way
  const t = u.path[0];
  return (((t % world.w) + .5) - u.x) * ux + ((((t / world.w) | 0) + .5) - u.y) * uy < 0;
}

/**
 * Pick the displacement for one movement step: the straight line first, then — if something the mover
 * has to give way to stops it dead — a side-step around it. Candidates are judged by how far they get
 * the mover towards the waypoint it is walking to, never by their own sideways length: a body pinned on
 * a contact would otherwise slide back the way it came and orbit the obstacle for good.
 * A friendly body that is only holding ground makes way here (see `makeWay`): traffic nudges it aside
 * and the step is retried, so a parked body is rarely a wall for more than a moment.
 * Only the mover ever gives ground; no body is pushed and the mover's own displacement never exceeds
 * `len` — the body that makes way spends its walking budget like any body taking a step (see
 * `stepLength`).
 * @param {number} [dt] seconds this step covers, shaping the walking budget of a body making way
 * @returns {{x:number, y:number}|null} the new position, or null when the division must hold
 */
export function stepAround(world, d, ux, uy, len, dt) {
  const g = gridFor(world);
  if (g.linked !== world.divs) indexBodies(world);
  noteStall(world, d);
  let straight = attempt(world, d, ux, uy, len);
  if (straight && straight.gain >= len * 0.5) return straight;
  let b = blockingBody(world, d, ux, uy, len);
  if (b) {
    if (makeWay(world, d, b, ux, uy, len, dt)) {
      const retry = attempt(world, d, ux, uy, len);
      if (retry && retry.gain >= len * 0.5) return retry;
      if (retry) straight = retry;
      b = blockingBody(world, d, ux, uy, len);
    }
    if (b && yields(world, d, b, ux, uy) && (farFromTarget(world, d) || !targetHeld(world, d))) {
      let best = null, bestFwd = straight ? straight.gain : 0;
      for (let k = 0; k < SIDESTEP.length; k++) {
        const a = SIDESTEP[k], ca = Math.cos(a), sa = Math.sin(a);
        const c = attempt(world, d, ux * ca - uy * sa, ux * sa + uy * ca, len);
        if (!c) continue;
        const fwd = (c.x - d.x) * ux + (c.y - d.y) * uy;
        if (fwd > bestFwd + 1e-9) { bestFwd = fwd; best = c; }
      }
      if (best) return best;
    }
  }
  return straight;
}

// --- traffic displacement ------------------------------

// A friendly body that is only holding ground gives way to traffic: the mover nudges it aside and the
// body walks back to the exact spot it was holding once the way is clear. The nudge is bounded — a
// body is never left further than DISPLACE_MAX from the ground it returns to — and deterministic (the
// side that leaves it best placed wins, left first on a tie). Enemies, fighters, and bodies with orders
// of their own are never displaced: their ground is theirs.
const DISPLACE_MAX = 2.5;
/** Seconds a displaced body waits before walking back to the ground it was nudged off. */
export const RETURN_DELAY = 0.5;

/**
 * How far a division may walk in `dt` seconds on the ground underfoot: its type's top speed, capped to
 * the pace of the column it marches in (a column moves as one body, at its slowest member's pace), on
 * road or open ground. A tick hands out one such budget per body, and everything that moves the body
 * draws on it — its own step, a shove out of traffic's way, the walk back to its ground — so no two
 * of them together ever move it further than its feet could carry it in one tick.
 */
export function stepLength(world, d, dt) {
  const speed = TYPES[d.type].speed;
  const mul = d.column && d.colSpeed > 0 && d.colSpeed < speed ? d.colSpeed : speed;
  return SPEED * mul / moveCost(world, tileOf(world, d)) * dt;
}

/**
 * Nudge a friendly body that is only holding ground out of the mover's way: sideways, far enough that
 * the step the mover is about to take is clear of it, to the side the body already leans (a body dead
 * on the step's line picks the side closest to its own ground). The shove spends the body's own
 * walking budget for the tick — the same budget its step and its walk home draw on (see `stepLength`) — so traffic can displace a body no
 * faster than its feet could carry it: when the whole step cannot be cleared in one go the body is
 * moved as far as the budget still allows and the rest is finished over the ticks that follow, and a
 * body that has spent its budget stands fast until the next tick. The shove is still the mover's
 * primary way past a parked body (a side-step only happens when the shove itself is blocked), and the
 * first shove remembers the ground it was holding (`anchor`) so the body can walk back to it later —
 * never left further than DISPLACE_MAX from that ground.
 * @param {number} [dt] seconds this step covers, sizing the budget for a body that has none set yet;
 *   defaults to one tick's walking distance
 * @returns {boolean} true when the body was moved aside
 */
export function makeWay(world, d, u, ux, uy, len, dt) {
  if (d.anchor != null || !allied(world, u.owner, d.owner) || !holding(u)) return false;
  // Where the body sits relative to the step: `f` along the mover's heading, `s` to the side (positive
  // to the mover's left). The step sweeps [0, len] along the heading, so the body is clear of it once
  // its sideways offset reaches `need` — the offset that puts it a hair beyond the contact floor from
  // the step's far end, which clears the rest of the sweep as well (a step never exceeds ~0.2 tiles).
  const wx = u.x - d.x, wy = u.y - d.y;
  const f = wx * ux + wy * uy;
  const s = wy * ux - wx * uy;
  const back = f > len ? f - len : 0;
  const need = Math.sqrt(Math.max(0, (MIN_SEP + 0.02) * (MIN_SEP + 0.02) - back * back));
  if (Math.abs(s) >= need) return false;               // already clear of the step: nothing to do
  const budget = u.stepMax != null ? u.stepMax
    : TYPES[u.type] ? stepLength(world, u, dt != null ? dt : STEP) : 0;
  const room = budget - (u.stepUsed || 0);             // the tick's budget, minus what it has already spent
  if (room <= 1e-9) return false;                      // spent: it can be nudged further next tick
  // Yield the way the body already leans: a body that picked a side afresh every tick would tremble on
  // either side of the step instead of clearing it — it and the mover would stay wedged for good. So a
  // body already off the step's line keeps to the side it is on (the other side only when that one is
  // blocked), and only a body sitting dead on the line picks a side, the one closest to its own ground.
  const lean = s > 1e-6 ? 1 : s < -1e-6 ? -1 : 0;
  let best = null, bestKey = Infinity, bestMoved = 0;
  for (let k = 0; k < 2 && best === null; k++) {
    const side = lean ? (k === 0 ? lean : -lean) : (k === 0 ? 1 : -1);
    const want = Math.abs(side * need - s);
    const p = attempt(world, u, -uy * side, ux * side, want < room ? want : room);
    if (!p) continue;
    bestKey = u.anchor ? Math.hypot(p.x - u.anchor.x, p.y - u.anchor.y) : k;
    best = p;
    bestMoved = Math.hypot(p.x - u.x, p.y - u.y);
  }
  if (!best) return false;
  if (!u.anchor) u.anchor = { x: u.x, y: u.y };
  else if (bestKey > DISPLACE_MAX) return false;      // never shoved away from home for good
  u.x = best.x; u.y = best.y;
  u.stepUsed = (u.stepUsed || 0) + bestMoved;         // the walk home draws on what is left of the budget
  u.returnT = world.time + RETURN_DELAY;
  return true;
}

/**
 * Slide a body at most `len` tiles straight towards a world point with every firm constraint applied
 * (the contact floor, water, the map edge, other bodies) — used by the combat push and by a displaced
 * body walking back to its ground. The result never gives up ground already gained towards the point
 * and never ends further from it than the body started.
 * @returns {{x:number, y:number, arrived:boolean}|null} new position, or null when it cannot move
 */
export function slideTowards(world, d, tx, ty, len) {
  const g = gridFor(world);
  if (g.linked !== world.divs) indexBodies(world);
  const dx = tx - d.x, dy = ty - d.y, dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-9 || len <= 0) return { x: d.x, y: d.y, arrived: dist < 1e-9 };
  const ux = dx / dist, uy = dy / dist;
  const p = attempt(world, d, ux, uy, dist < len ? dist : len);
  if (!p) return null;
  if ((p.x - d.x) * dx + (p.y - d.y) * dy < -1e-9) return null;
  const nd = Math.hypot(tx - p.x, ty - p.y);
  if (nd > dist + 1e-9) return null;
  return { x: p.x, y: p.y, arrived: nd < 1e-9 };
}

/**
 * Jam bookkeeping for one step. A body counts as stalled while it is not getting closer to the
 * waypoint it is walking to: one jittering against a contact makes no progress, while one taking a
 * detour round a body still closes on its next waypoint, and reaching a waypoint starts the count
 * over. Once the wait is over its route is rebuilt around the bodies in the way; every rebuild doubles
 * the wait, so a jam no route can fix settles into rare retries. A phase's rebuild budget defers the
 * rest to the next tick — the stall count is kept, so nobody is skipped, and the whole map is never
 * searched more than REPLANS_PER_PHASE times in one tick. Path and order survive a failed rebuild.
 */
function noteStall(world, d) {
  const wp = d.path[0];
  if (wp === undefined) { d.stuck = 0; return; }
  const w = world.w;
  const dx = (wp % w) + .5 - d.x, dy = ((wp / w) | 0) + .5 - d.y;
  const dd = dx * dx + dy * dy;
  if (d.wp !== wp || dd < (d.wpBest || 1e9) - 1e-7) { d.wp = wp; d.wpBest = dd; d.stuck = 0; return; }
  d.stuck = (d.stuck || 0) + 1;
  const wait = d.stuckWait || STUCK_TICKS;
  if (d.stuck < wait || gridFor(world).replansLeft <= 0) return;
  gridFor(world).replansLeft--;
  d.stuck = 0;
  reroute(world, d);
  d.stuckWait = Math.min(wait * 2, STUCK_MAX);
}

/**
 * Rebuild a pinned division's route to the same destination, walking around the bodies in its way:
 * every other living body's tile is impassable and diagonals between two of them are not cut, so a
 * body wedged in a pinch can back out of the pocket instead of holding forever. The centre of its own
 * tile becomes the first waypoint — that is what lets the escape step point away from the goal for a
 * moment without the order or the destination ever changing. No route (the destination itself held,
 * say) leaves the old path alone: the division waits, which is the right answer for a held goal.
 */
function reroute(world, d) {
  const goal = d.path[d.path.length - 1], from = tileOf(world, d);
  const route = findPath(world, from, goal, blockedTiles(world, d));
  if (!route) return false;
  d.path = route.length ? [from, ...route] : [goal];
  return true;
}

/** Tile of every living body other than `d`: bodies are solid, so a rebuilt route walks around them. */
function blockedTiles(world, d) {
  const tiles = new Set(), divs = world.divs || NO_DIVS;
  for (let i = 0; i < divs.length; i++) {
    const u = divs[i];
    if (u !== d && u.men > 0) tiles.add(tileOf(world, u));
  }
  return tiles;
}

/**
 * Is the destination itself held by a body at rest? Waiting only achieves anything when the mover is
 * about to arrive where somebody is already sitting — nothing will move that body off the goal.
 */
function targetHeld(world, d) {
  const f = d.path[d.path.length - 1], w = world.w;
  const u = nearestTouch(world, d, (f % w) + .5, ((f / w) | 0) + .5);
  return !!u && parked(u);
}

/** Is the division still far enough from its destination to walk around a body instead of waiting? */
function farFromTarget(world, d) {
  const f = d.path[d.path.length - 1], w = world.w;
  const dx = ((f % w) + .5) - d.x, dy = (((f / w) | 0) + .5) - d.y;
  return dx * dx + dy * dy > GIVE_WAY * GIVE_WAY;
}

// --- placement -----------------------------------

/**
 * Is (x, y) clear of every living body other than `skip` members? Linear scan: used outside the
 * movement phase (raising, splitting, slot picking), where the contact buckets are not current.
 * The ground a displaced body is walking back to counts as occupied as well: its saved anchor stays
 * clear of any spot within the contact floor of it, even while the body itself is off the spot and
 * even when only bodies at rest would otherwise be counted — otherwise an order could settle somebody
 * onto the tile the body must return to, and the body would be blocked off its own ground for good.
 * `skip` members are ignored body and anchor alike: they are the ones being moved away.
 * @param {Set<object>|null} [skip] bodies that do not count as obstacles (nor their saved ground)
 * @param {boolean} [all] true = any living body blocks, false = only bodies at rest do
 */
export function clearSpot(world, x, y, skip = null, all = true) {
  const divs = world.divs || NO_DIVS;
  for (let i = 0; i < divs.length; i++) {
    const u = divs[i];
    if (u.men <= 0 || (skip && skip.has(u))) continue;
    if (!all && !parked(u) && u.anchor == null) continue;  // a body that is away still holds its ground
    const dx = u.x - x, dy = u.y - y;
    if (dx * dx + dy * dy < MIN_SEP * MIN_SEP) return false;
    if (u.anchor) {
      const ax = u.anchor.x - x, ay = u.anchor.y - y;
      if (ax * ax + ay * ay < MIN_SEP * MIN_SEP) return false;
    }
  }
  return true;
}

/**
 * Nearest land tile to a world point whose centre is clear of bodies and not already handed out.
 * Deterministic outward ring search; -1 when nothing legal is near. Shared by spawn placement and
 * formation slots, so two divisions are never sent to the same tile.
 * @param {Set<number>|null} [used] tile indices already assigned
 * @param {Set<object>|null} [skip] bodies that do not count (the units being ordered)
 * @param {boolean} [all] true = any living body blocks the tile, false = only bodies at rest do
 */
export function freeTileNear(world, x, y, used = null, skip = null, all = false) {
  const terr = world.terr, divs = world.divs || NO_DIVS, w = world.w, h = world.h;
  const cx = Math.max(0, Math.min(w - 1, x | 0)), cy = Math.max(0, Math.min(h - 1, y | 0));
  for (let r = 0; r < 14; r++) {
    let best = -1, bd = 1e9;
    for (let j = cy - r; j <= cy + r; j++) {
      if (j < 0 || j >= h) continue;
      const inner = r > 0 && j > cy - r && j < cy + r;
      for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || i >= w) continue;
        if (inner && i > cx - r && i < cx + r) continue;    // ring only: nearer rings were checked
        const t = j * w + i;
        if (terr[t] === WATER || (used && used.has(t))) continue;
        if (!clearSpot(world, i + .5, j + .5, skip, all)) continue;
        const dd = Math.sqrt((i - cx) * (i - cx) + (j - cy) * (j - cy));
        if (dd < bd) { bd = dd; best = t; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * Tiles already promised as somebody's destination: the last waypoint of every live path. Orders avoid
 * them, so two divisions are never sent to the same tile — the first to arrive would otherwise sit on
 * it and block the other for good, since nothing may be pushed off its ground. The ground a displaced
 * body is walking back to is not a tile here: it is kept clear as a spot instead, with the contact
 * floor around it (see `clearSpot`), because a saved anchor need not sit on a tile centre.
 */
export function claimedEnds(world) {
  const ends = new Set(), divs = world.divs || NO_DIVS;
  for (let i = 0; i < divs.length; i++) {
    const p = divs[i].path;
    if (p && p.length) ends.add(p[p.length - 1]);
  }
  return ends;
}

/**
 * Ground for a new body near (x, y): the centre of the nearest free land tile, or null when there is
 * nowhere legal. New divisions land on clear ground, so a raise or split can never stack bodies.
 * @param {object} world
 * @param {number} x
 * @param {number} y
 * @param {Set<object>|null} [skip] bodies that do not count as obstacles
 */
export function spawnSpot(world, x, y, skip = null) {
  const t = freeTileNear(world, x, y, null, skip, true);
  if (t < 0) return null;
  return { x: (t % world.w) + .5, y: ((t / world.w) | 0) + .5 };
}
