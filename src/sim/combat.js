import { RANGE, ART_RANGE, TYPES, MOUNTAIN, FORT_RANGE, FORT_DEF, SPEED, PUSH_BASE } from '../config.js';
import { tileOf } from './geom.js';
import { nearFriendly } from './proximity.js';
import { combatMult } from './supply.js';
import { allied } from './teams.js';
import { indexBodies, slideTowards, stepLength } from './collision.js';

/**
 * Damage per second `att` deals to `def`. `f` scales it (range penalty etc). How hard an attacker
 * fights depends on its logistics: output eases down with the effective distance to the nearest city
 * its owner still holds and is halved when cut off (combatMult), so isolation never deletes troops.
 */
export function hit(world, att, def, f) {
  const ti = tileOf(world, def);
  let m = f * TYPES[att.type].atk * TYPES[def.type].taken;
  if (world.terr[ti] === MOUNTAIN) m *= 0.6;           // defender on high ground
  if (world.owner[ti] === def.owner) m *= 0.85;        // defending home soil
  if (nearFriendly(world, def, 'fortress', FORT_RANGE)) m *= FORT_DEF;  // covered by a friendly finished fortress
  m *= combatMult(world, att);                         // cut-off attackers fight worse, never at zero
  return (att.men * 0.14 * (0.6 + world.rand() * 0.8) + 1.0) * m;
}

/**
 * The direction `att` is marching in: the next step of the route it is following, or, on the last
 * waypoint of a leg, the bearing to that ordered checkpoint itself. Just the bearing to the next
 * breadcrumb from wherever the body stands would do on foot, but a body carried along by its own
 * push drifts past breadcrumbs the melee lock never lets it spend, and that bearing would flip to
 * point behind it and stall the very push it just won.
 */
function marchHeading(world, att) {
  const w = world.w, path = att.path;
  if (path.length > 1) {
    const hx = (path[1] % w) - (path[0] % w), hy = ((path[1] / w) | 0) - ((path[0] / w) | 0);
    if (hx !== 0 || hy !== 0) return { hx, hy };
  }
  const t = path[0];
  return { hx: (t % w) + .5 - att.x, hy: ((t / w) | 0) + .5 - att.y };
}

/**
 * A melee attacker with an order — and only such a one — carries its weight forward: an ordered
 * division advancing on an enemy shoves it back at
 *   max(0, SPEED * attacker top speed − SPEED * defender top speed + PUSH_BASE)   tiles/s
 * and steps into the ground that shove vacates, so a sustained push walks the pair forward as one
 * body instead of driving the enemy out of contact and making the attacker stride after it every few
 * ticks. Nothing is pushed automatically the other way: a defender without an order of its own never
 * shoves back ("defender" is not silently treated as an attacker), so an equal fight simply holds.
 * The push and the follow are pure displacement inside the same swept, solid constraints as any
 * walk — terrain, water, the map edge and every other body stop them, and a blocked push simply
 * makes no progress, the attacker gaining no ground with it. The follow is bounded by the attacker's
 * own feet: in one step it never covers more than the enemy was actually displaced nor more than one
 * walking stride, however many enemies it is shoving. Breadcrumbs the follow carries the attacker
 * past are spent the way a walk spends them, so the route under its nose stays the route it resumes;
 * the ordered checkpoint at the end of a leg is still only reached on foot. The shoved body keeps
 * its path and its intentions; when the push moves it out of contact it walks on as ordered.
 */
function shove(world, att, def, dt, carried) {
  if (!att.path.length || att.men <= 0 || def.men <= 0) return;
  const { hx, hy } = marchHeading(world, att);
  const hl = Math.hypot(hx, hy);
  if (hl < 1e-9) return;
  const dx = def.x - att.x, dy = def.y - att.y, dist = Math.hypot(dx, dy);
  if (dist < 1e-9 || dist > RANGE) return;
  if (dx * hx + dy * hy <= 0) return;                  // this attacker is not advancing on that enemy
  const p = SPEED * (TYPES[att.type].speed - TYPES[def.type].speed) + PUSH_BASE;
  if (p <= 0) return;
  const moved = slideTowards(world, def, def.x + dx / dist, def.y + dy / dist, p * dt);
  if (!moved) return;
  const mx = moved.x - def.x, my = moved.y - def.y;
  def.x = moved.x; def.y = moved.y;                    // the shove is displacement, not a proposal
  const ml = Math.hypot(mx, my);
  if (ml < 1e-9) return;                               // blocked push: nobody moves
  // The attacker follows into the ground its own push just won. Without the follow the pair separates
  // past RANGE, the melee lock drops and the attacker lunges a whole stride back in: that stop-start
  // cycle reads as jitter and skips a damage exchange every cycle.
  const room = stepLength(world, att, dt) - (carried.get(att) || 0);
  if (room <= 1e-9) return;
  const ax = att.x, ay = att.y;
  const follow = slideTowards(world, att, ax + mx, ay + my, Math.min(ml, room));
  if (!follow) return;
  att.x = follow.x; att.y = follow.y;
  carried.set(att, (carried.get(att) || 0) + Math.hypot(follow.x - ax, follow.y - ay));
  // Bookkeeping catches up with the body: a breadcrumb the follow has carried the attacker past is
  // spent, exactly as walking over it would spend it, so the leg underfoot keeps describing the
  // ground ahead and the attacker resumes on its route rather than walking back down it. The last
  // waypoint of a leg is never spent here — the ordered checkpoint is reached on foot, and once the
  // carry puts the attacker level with it the heading above stops the push instead of overrunning
  // the order.
  const path = att.path;
  while (path.length > 1) {
    const a = path[0], b = path[1];
    const cx = (a % world.w) + .5, cy = ((a / world.w) | 0) + .5;
    const sx = (b % world.w) - (a % world.w), sy = ((b / world.w) | 0) - ((a / world.w) | 0);
    if ((att.x - cx) * sx + (att.y - cy) * sy <= 0) break;
    path.shift();
  }
}

/**
 * Resolve one step of fighting. Opposing divisions within RANGE are locked in melee: both stop to
 * fight, keeping whatever path they were following, and carry on the moment the enemy is gone.
 * Artillery additionally shells enemies up to ART_RANGE away without being engaged. Teammates are
 * never opposing (see teams.js): no melee, no shelling and no push between allies, so world.fights
 * — the only source routing reads for foes and interception — never holds an allied pair either.
 * world.fights is rebuilt for the renderer: [a, b, isRanged]. Divisions damaged this step carry
 * `tookFire`, the marker routing reads to tell combat wounds from any other loss of strength.
 */
export function combat(world, dt) {
  const { divs, fights } = world;
  fights.length = 0;
  const dmg = new Map();
  const add = (d, v) => dmg.set(d, (dmg.get(d) || 0) + v);
  for (const d of divs) { d.eng = false; d.tookFire = false; }

  for (let i = 0; i < divs.length; i++) {
    const a = divs[i];
    for (let j = i + 1; j < divs.length; j++) {
      const b = divs[j];
      if (allied(world, a.owner, b.owner)) continue;
      const dx = a.x - b.x;
      if (dx > ART_RANGE || dx < -ART_RANGE) continue;
      const dist = Math.hypot(dx, a.y - b.y);
      if (dist <= RANGE) {
        a.eng = b.eng = true;
        // Engagement cancels a pending return to nudged-aside ground: a body that is fighting holds
        // the ground it stands on, and an anchor it no longer walks back to must not be resurrected.
        a.anchor = null; b.anchor = null;
        fights.push([a, b, 0]);
        add(b, hit(world, a, b, a.type === 'art' ? 0.7 : 1) * dt);
        add(a, hit(world, b, a, b.type === 'art' ? 0.7 : 1) * dt);
      } else if (dist <= ART_RANGE) {
        let shot = false;
        if (a.type === 'art' && a.men >= 10) { add(b, hit(world, a, b, 0.55) * dt); shot = true; }
        if (b.type === 'art' && b.men >= 10) { add(a, hit(world, b, a, 0.55) * dt); shot = true; }
        if (shot) fights.push([a, b, 1]);
      }
    }
  }
  for (const [d, v] of dmg) { d.men -= v; d.tookFire = true; }

  // Physical displacement comes after the damage exchange, so it sees who is still standing.
  if (fights.length) {
    indexBodies(world);
    const carried = new Map();     // follow-through already spent this step, per attacker
    for (let k = 0; k < fights.length; k++) {
      const [a, b, ranged] = fights[k];
      if (ranged) continue;
      shove(world, a, b, dt, carried);
      shove(world, b, a, dt, carried);
    }
  }
}
