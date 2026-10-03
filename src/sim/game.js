import { emit } from './world.js';
import { updateLogistics, logisticsDistance } from './supply.js';
import { recount } from './buildings.js';
import { combat } from './combat.js';
import { updateRouting } from './routing.js';
import { moveDivs, captureStep } from './movement.js';
import { economy } from './economy.js';
import { aiThink } from './ai.js';

/**
 * Advance the simulation by one fixed step. Logistics are refreshed before the fight (the oos flag
 * each division carries and the damage multiplier combat reads both come from that cache), then
 * combat, then routing (wounded divisions break off after the exchange that mauled them, before the
 * movement pass that carries them away), then movement, land capture, casualties, economy and AI.
 */
export function tick(world, dt) {
  if (world.over) return;
  world.time += dt;

  world.recountT += dt;
  if (world.recountT >= 1) { world.recountT = 0; recount(world); }

  updateLogistics(world);
  for (const d of world.divs) {
    d.px = d.x; d.py = d.y;
    d.oos = !Number.isFinite(logisticsDistance(world, d));   // isolation is reported, never attrition
  }

  combat(world, dt);

  updateRouting(world);

  moveDivs(world, dt);

  for (const d of world.divs) if (!d.eng && !d.routing) captureStep(world, d, dt);

  let anyDead = false;
  for (const d of world.divs) {
    if (d.men < 3 && !d.merged) {
      d.men = 0;
      emit(world, 'divisionDestroyed', { div: d });
    }
    if (d.men <= 0) anyDead = true;
  }
  if (anyDead) world.divs = world.divs.filter(d => d.men > 0);

  economy(world, dt);

  for (const p of world.players) {
    if (!p.human && p.alive && world.time >= p.nextAI) { p.nextAI = world.time + 1.2; aiThink(world, p); }
  }

  world.endT += dt;
  if (world.endT > 1) { world.endT = 0; checkEnd(world); }
}

/**
 * Eliminate landless players and detect the end of the game. Elimination stays per player, but
 * victory is per side (see teams.js): a side's land is its members' land added up, and the match
 * keeps running while any member of a human's team still stands. result.reason is one of:
 *   'land'   - one side holds the configured victoryShare of the land
 *   'last'   - only one side is left standing
 *   'humans' - every human seat's side has been eliminated (winnerId null)
 * Results also carry the winning side for the HUD: winnerTeam (its team id — in FFA the winner's own
 * id, since there a player is its own side) and teamMembers (its faction ids, sorted; [] when no side
 * won). winnerId is the winning side's representative faction: its largest landholder.
 */
export function checkEnd(world) {
  for (const p of world.players) {
    if (p.alive && p.tiles === 0) {
      p.alive = false;
      world.divs = world.divs.filter(d => d.owner !== p.id);
      emit(world, 'playerEliminated', { player: p });
    }
  }
  const alive = world.players.filter(p => p.alive);
  // Aggregate the survivors into sides: a team's land is its members' land added up.
  const sides = new Map();
  for (const p of alive) {
    const k = p.team | 0;
    let g = sides.get(k);
    if (!g) { g = { key: k, tiles: 0, members: [] }; sides.set(k, g); }
    g.tiles += p.tiles;
    g.members.push(p);
  }
  const share = world.settings.victoryShare;
  let leader = null;
  for (const g of sides.values()) {
    if (g.tiles >= world.landCount * share) { leader = g; break; }
  }
  if (leader || sides.size === 1) {
    const g = leader || [...sides.values()][0];
    // The winning side speaks through its largest landholder (lowest id on a tie).
    const w = g.members.reduce((a, b) =>
      (b.tiles > a.tiles || (b.tiles === a.tiles && b.id < a.id)) ? b : a);
    return endGame(world, w, leader ? 'land' : 'last', g);
  }
  if (world.players.some(p => p.seat) && !world.players.some(p => p.seat && sideAlive(world, p))) {
    endGame(world, null, 'humans');
  }
}

/** Whether the seat's side still has a living member (the seat itself counts). */
function sideAlive(world, p) {
  const k = p.team | 0;
  for (const q of world.players) if (q.alive && (q.team | 0) === k) return true;
  return false;
}

function endGame(world, winner, reason, side) {
  world.over = true;
  world.result = {
    winnerId: winner ? winner.id : null,
    reason,
    pct: winner ? Math.round(side.tiles / world.landCount * 100) : 0,
    winnerTeam: winner ? side.key : null,
    teamMembers: winner ? side.members.map(m => m.id).sort((a, b) => a - b) : [],
  };
  emit(world, 'gameOver', world.result);
}
