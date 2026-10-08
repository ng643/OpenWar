import { TYPES, WATER, MOUNTAIN, COLUMN_SPACING } from '../config.js';
import { setOwner } from './world.js';
import { allied } from './teams.js';
import { indexBodies, stepAround, blockingBody, makeWay, stepLength, slideTowards, MIN_SEP } from './collision.js';
import { advanceRoute } from './routing.js';

/**
 * Move every division along its route for one fixed step. Movement is swept and solid: a step stops at
 * the first contact and slides along it, side-stepping bodies it has to give way to, so bodies never
 * enter each other and only friendly traffic ever nudges one aside (a body that is merely holding
 * ground is pushed out of the way for a moment and walks back to the exact spot it was holding — see
 * collision.makeWay). Engaged divisions hold their ground (see combat) and keep their route, so they
 * carry on the moment the fight ends — except a division that is routing: its escape route is followed
 * even in melee, so a mauled body can break contact instead of standing in the line until it dies.
 * Batched here so the contact index is built once per tick instead of once per division, and with one
 * walking budget handed to each body for the tick: everything that moves a body — its step, a shove
 * out of friendly traffic's way, its walk home (see collision.stepLength) — draws on the same budget,
 * so no tick can move it further than its own feet could carry it.
 */
export function moveDivs(world, dt) {
  indexBodies(world);
  const divs = world.divs;
  for (let i = 0; i < divs.length; i++) {
    const d = divs[i];
    d.stepUsed = 0;
    d.stepMax = d.eng && !d.routing ? 0 : stepLength(world, d, dt);
  }
  for (let i = 0; i < divs.length; i++) stepAlong(world, divs[i], dt);
}

/**
 * Follow the route for one step. The next waypoint is reached exactly, or not at all.
 * A waypoint a body is already sitting on is nudged clear first when that body is only holding ground
 * (see collision.makeWay), and counts as reached once the division hugs it otherwise, so two divisions
 * meeting on the same tile still get through instead of orbiting each other. The last waypoint of a leg
 * — the ordered checkpoint itself — is never skipped, and a skipped waypoint is taken back when only
 * terrain blocks the way on. When a leg runs out the next ordered checkpoint starts (routing.advanceRoute);
 * a division with no route at all walks back to ground it was displaced from, and one with nothing left
 * to do simply holds.
 */
function stepAlong(world, d, dt) {
  if (d.eng && !d.routing) return;                      // in melee: hold the ground and keep the route
  let mv = d.stepMax;                                   // the tick's budget, set by moveDivs
  if (!d.path.length) {
    if (d.anchor) stepHome(world, d, mv);
    else advanceRoute(world, d);
    return;
  }
  if (d.column && d.colPrev && d.colPrev.men > 0) {
    // Single file: never close inside COLUMN_SPACING of the body ahead, so the column keeps its
    // spacing and nobody overtakes anybody — when the one ahead stops, everyone behind stops with it.
    // Only a step that actually closes the gap is cut short, so a member whose own staggered final
    // checkpoint (routing.issueRoute) lies back down the line still gets to walk to it.
    const t0 = d.path[0];
    const wx = (t0 % world.w) + .5 - d.x, wy = ((t0 / world.w) | 0) + .5 - d.y;
    const wl = Math.hypot(wx, wy);
    const px = d.colPrev.x - d.x, py = d.colPrev.y - d.y;
    const pl = Math.hypot(px, py);
    const rad = wl > 1e-9 && pl > 1e-9 ? (px * wx + py * wy) / (pl * wl) : 0;
    if (rad > 0) {
      const room = (pl - COLUMN_SPACING) / rad;
      if (room <= 1e-9) return;
      if (room < mv) mv = room;
    }
  }
  let skipped = -1;
  for (let pass = 0; pass < 2 && d.path.length; pass++) {
    const t = d.path[0], tx = (t % world.w) + .5, ty = ((t / world.w) | 0) + .5;
    const dx = tx - d.x, dy = ty - d.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-9) { d.path.shift(); advanceRoute(world, d); return; }   // standing on the waypoint
    const ux = dx / dist, uy = dy / dist, step = dist < mv ? dist : mv;
    let held = blockingBody(world, d, ux, uy, step);
    if (pass === 0 && held && d.path.length > 1 && dist <= MIN_SEP) {
      // A body is sitting on the waypoint: nudge it aside when it is only holding ground, and only
      // write the waypoint off when even that leaves nothing to walk to.
      if (!makeWay(world, d, held, ux, uy, step, dt)) { skipped = d.path.shift(); continue; }
      held = blockingBody(world, d, ux, uy, step);
    }
    const p = stepAround(world, d, ux, uy, step, dt);
    if (p) {
      d.x = p.x; d.y = p.y;
      if (step === dist && Math.abs(p.x - tx) < 1e-9 && Math.abs(p.y - ty) < 1e-9) {
        d.path.shift();
        advanceRoute(world, d);
      }
      return;
    }
    if (skipped >= 0 && !held) d.path.unshift(skipped);  // boxed in by terrain: wait with the full path
    return;                                             // boxed in: hold and keep the route
  }
}

/**
 * Walk back to the exact ground this body was displaced from. The way home is walked under the same
 * constraints as any other step — nobody is displaced here, and water and the map edge still hold — so
 * a body wedged on its way waits, moves on when the traffic has passed, and settles only once it
 * stands exactly on its spot. The walk home draws on the same tick budget as everything else that
 * moved the body (see collision.stepLength), so a nudge and the walk back together still never move it
 * further than its own feet could carry it in one tick, and the spot itself is held off every other
 * order while the body is away (collision.clearSpot), so nothing can settle onto it in the meantime.
 */
function stepHome(world, d, mv) {
  if (world.time < (d.returnT || 0)) return;
  const room = mv - (d.stepUsed || 0);
  if (room <= 1e-9) return;                             // budget spent: the walk home waits for next tick
  const p = slideTowards(world, d, d.anchor.x, d.anchor.y, room);
  if (!p) return;
  const moved = Math.hypot(p.x - d.x, p.y - d.y);
  d.x = p.x; d.y = p.y;
  d.stepUsed = (d.stepUsed || 0) + moved;
  if (p.arrived) { d.x = d.anchor.x; d.y = d.anchor.y; d.anchor = null; }
}

/**
 * Seize land around the division, one tile at a time at a rate set by its strength as a fraction of
 * one atomic of its type. The division never reaches beyond its own tile and the four cardinal
 * neighbours of that tile — no diagonal or distant painting — so one body holds one atomic
 * footprint however tall the stack stands: strength is clamped to one atomic for the rate, and an
 * idle division banks no free capture credit. Tiles must touch existing own or allied land (or be
 * directly underfoot); ground a teammate holds is never taken (see teams.js). Taking enemy land
 * costs men.
 */
// The five tiles a division may capture: its own tile and the four cardinal neighbours, in fixed
// underfoot/N/W/E/S order. Hoisted so a capture tick allocates nothing.
const CAPTURE_DX = [0, 0, -1, 1, 0];
const CAPTURE_DY = [0, -1, 0, 0, 1];

export function captureStep(world, d, dt) {
  const T = TYPES[d.type];
  if (d.men < 10 || !T.capt) return;
  const { terr, owner, cityAt } = world;
  const cx = d.x | 0, cy = d.y | 0, me = d.owner;
  const strength = Math.min(1, Math.max(0, d.men / T.men));           // one atomic unit, never more
  d.acc = Math.min(d.acc + dt * strength * (0.7 + T.men / 120) * T.capt, 3);
  if (d.acc < 1) return;
  while (d.acc >= 1) {
    let best = -1, bs = 1e9;
    for (let k = 0; k < CAPTURE_DX.length; k++) {
      const x = cx + CAPTURE_DX[k], y = cy + CAPTURE_DY[k];
      if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
      const i = y * world.w + x;
      if (terr[i] === WATER || allied(world, owner[i], me)) continue;   // never take own or allied ground
      const dd = (x + .5 - d.x) ** 2 + (y + .5 - d.y) ** 2;
      const here = x === cx && y === cy;
      if (!here && !((x > 0 && allied(world, owner[i - 1], me)) || (x < world.w - 1 && allied(world, owner[i + 1], me)) ||
                     (y > 0 && allied(world, owner[i - world.w], me)) || (y < world.h - 1 && allied(world, owner[i + world.w], me)))) continue;
      const sc = dd + world.rand() * 0.4 - (cityAt[i] >= 0 ? 1.5 : 0);
      if (sc < bs) { bs = sc; best = i; }
    }
    if (best < 0) { d.acc = 0; return; }                              // idle: bank nothing
    const cost = (owner[best] ? 0.25 : 0.04) * (terr[best] === MOUNTAIN ? 2 : 1) * (cityAt[best] >= 0 ? 3 : 1);
    d.acc -= 1; d.men -= cost;
    setOwner(world, best, me);
    if (d.men < 10) return;
  }
}
