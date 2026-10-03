import { MANPOWER, GOLD } from '../config.js';
import { reinforceRate } from './supply.js';

/**
 * Per-tick economy. Two resources, both fed by a baseline trickle plus territory and *completed* buildings
 * (p.active, not p.built) — a building under construction contributes nothing until it finishes:
 *
 *   manpower (p.rate -> p.pool): base + owned land + cities + completed Farms, soft-capped by a manpower
 *     ceiling (base garrison + land + cities + Farms). As reserves + fielded army approach that ceiling the
 *     rate fades to zero, so stacking buildings still raises income but never past what the holdings support.
 *   gold (p.goldRate -> p.gold): base + owned land + cities + completed Factories; no cap.
 *
 * Divisions below strength then reinforce from the manpower pool, man-for-man, while unengaged: the rate
 * is set by how well the division is connected to the nearest city its owner holds (reinforceRate — roads
 * shorten the effective distance, enemy ground cuts it). A division standing at a connected city draws up
 * to REINFORCE_RATE men/s; a distant but connected one draws proportionally less. An isolated division
 * receives nothing — and loses no men either, since isolation only blunts fighting (combatMult), never
 * strength.
 */
export function economy(world, dt) {
  const { players, divs } = world;
  const mult = world.settings.incomeMultiplier;
  for (const p of players) p.army = 0;
  for (const d of divs) players[d.owner - 1].army += d.men;
  for (const p of players) {
    if (!p.alive) continue;
    const cap = 300 + p.tiles * 6 + p.cities * 250 + p.active.farm * 40; // reserves+army ceiling income fades toward
    p.rate = (MANPOWER.base + p.tiles * MANPOWER.perTile + p.cities * MANPOWER.perCity + p.active.farm * MANPOWER.perFarm) * Math.max(0, 1 - (p.pool + p.army) / cap) * mult;
    p.pool += p.rate * dt;
    p.goldRate = (GOLD.base + p.tiles * GOLD.perTile + p.cities * GOLD.perCity + p.active.factory * GOLD.perFactory) * mult;
    p.gold += p.goldRate * dt;
  }
  for (const d of divs) {
    // Reinforce only unengaged divisions below their cap; every man comes out of the reserves pool.
    if (d.eng || d.men >= d.cap) continue;
    const p = players[d.owner - 1], t = Math.min(reinforceRate(world, d) * dt, d.cap - d.men, p.pool);
    if (t > 0) { d.men += t; p.pool -= t; }
  }
}
