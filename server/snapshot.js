import { visibleDivs } from '../src/sim/vision.js';
import { allied } from '../src/sim/teams.js';
import { moving } from '../src/sim/collision.js';
import { TYPE_IDS, F_ENG, F_OOS, F_MOVING, F_ROUTING, F_ROUT_LOCKED, F_COLUMN, stridePath } from '../src/net/protocol.js';

/** Everything a client needs to (re)build the world at game start or on reconnect. */
export function buildInit(world, playerId) {
  return {
    t: 'init',
    seed: world.seed,
    me: playerId,
    w: world.w,
    h: world.h,
    cityCapacity: world.cityCapacity,
    settings: world.settings,
    time: world.time,
    result: world.result,
    players: world.players.map(p => ({
      id: p.id, name: p.name, color: p.color, seat: !!p.seat, human: !!p.human, enabled: !!p.enabled,
      team: p.team, bot: !!p.bot
    })),
    cities: world.cities.map(c => ({ idx: c.idx, capital: c.capital, owner: c.owner })),
    owner: Array.from(world.owner),
    bld: buildingList(world),
    roads: roadList(world),
    roadVersion: world.roadVersion
  };
}

/** Flat list of the tiles carrying a road; roads are public, so (re)connect always gets the full set. */
function roadList(world) {
  const out = [];
  for (let i = 0; i < world.roads.length; i++) if (world.roads[i]) out.push(i);
  return out;
}

/** Flat [tile, type, doneAt, ...] list of every building on the map. */
function buildingList(world) {
  const out = [];
  for (let i = 0; i < world.bld.length; i++) if (world.bld[i]) out.push(i, world.bld[i], round(world.bdone[i], 2));
  return out;
}

/**
 * A fogged view of the world for one player. Enemy divisions outside their vision are simply not
 * sent, so a modified client cannot reveal them. `viewerId` 0 is a spectator: the full map with
 * every economy visible. Eliminated players spectate the same way. Foreign division routes are
 * never sent to anyone; a visible ally's saved home is (and nothing else of theirs), because
 * allocation must agree on the ground they occupy. settings.fog=false turns fog off for every viewer.
 *
 * @param changes flat [tile, owner, tile, owner, ...] ownership deltas since the previous snapshot
 * @param bchanges flat [tile, type, doneAt, ...] building deltas since the previous snapshot
 * @param rchanges flat [tile, 0|1, ...] road deltas since the previous snapshot
 */
export function buildSnapshot(world, viewerId, changes, bchanges = [], rchanges = []) {
  const viewer = viewerId > 0 ? world.players[viewerId - 1] : null;
  const fog = !!viewer && viewer.alive && !world.over && world.settings.fog !== false;
  const vis = visibleDivs(world, viewerId, fog);
  const ids = new Set(vis.map(d => d.id));
  // Allies are visible to each other (shared vision), and their exact saved homes are shared with
  // them so every client's allocation reserves the same physical ground. The relation itself stays
  // in sim/teams.js — this only names the allies once per snapshot instead of per row.
  const allies = new Set();
  if (viewerId > 0) for (const p of world.players) if (p.id !== viewerId && allied(world, viewerId, p.id)) allies.add(p.id);

  const divs = vis.map(d => {
    // "Under way" covers every state the local prediction must not treat as holding ground: a current
    // leg, remaining multipoint checkpoints, or walking back to ground traffic displaced it from. The
    // sim's own classifier is the single source of truth for the path/hold part, so a mirror preview
    // and the authoritative collision pass agree.
    const route = d.routePoints && d.routePoints.length ? d.routePoints : null;
    const underWay = moving(d) || route !== null || d.anchor != null;
    const flags = (d.eng ? F_ENG : 0) | (d.oos ? F_OOS : 0) | (underWay ? F_MOVING : 0)
      | (d.routing ? F_ROUTING : 0) | (d.routLocked ? F_ROUT_LOCKED : 0) | (d.column ? F_COLUMN : 0);
    const row = [d.id, d.owner, TYPE_IDS.indexOf(d.type), round(d.x, 2), round(d.y, 2), round(d.men, 1), Math.round(d.cap), flags];
    if (d.owner === viewerId) {
      // Only the owner's own rows carry routes: the current leg at [8] and the remaining multipoint
      // checkpoints at [9]. A foreign row stops at the flags, so no enemy route ever reaches the wire.
      if (d.path.length) row.push(stridePath(d.path));
      if (route) { if (!d.path.length) row.push([]); row.push(route); }
      // The saved home of a body traffic displaced is owner-only too: it reserves that exact ground
      // against every later order, so the owner's preview must reserve it the same way. Sent raw (no
      // rounding) because the placement pass tests distances against the exact spot, and padded with
      // empty route slots when needed so a row with a home always carries it at [10]. A row without a
      // home keeps the old shape, and a foreign row never grows past the flags.
      if (d.anchor != null) {
        while (row.length < 10) row.push([]);
        row.push([d.anchor.x, d.anchor.y]);
      }
    } else if (allies.has(d.owner) && d.anchor != null) {
      // A visible ally's saved home is shared: both sides must reserve the exact same spot, or their
      // previews would allocate different tiles for the same order. Their current leg and remaining
      // checkpoints stay private exactly like an enemy's, so the row carries only the home, padded to
      // [10] so a reader finds it at the same index as on its own rows.
      while (row.length < 10) row.push([]);
      row.push([d.anchor.x, d.anchor.y]);
    }
    return row;
  });
  const fights = [];
  for (const [a, b, ranged] of world.fights) if (ids.has(a.id) && ids.has(b.id)) fights.push([a.id, b.id, ranged]);

  // [tiles, cities, alive, manpower, manpowerRate, army, gold, goldRate]; rivals' economy is hidden while fogged (-1 = unknown)
  const pl = world.players.map(p => (p.id === viewerId || !fog)
    ? [p.tiles, p.cities, p.alive ? 1 : 0, Math.floor(p.pool), round(p.rate, 2), Math.round(p.army), Math.floor(p.gold), round(p.goldRate, 2)]
    : [p.tiles, p.cities, p.alive ? 1 : 0, -1, 0, -1, -1, 0]);

  return { t: 'snap', time: round(world.time, 2), ch: changes, bch: bchanges, rch: rchanges, divs, fights, pl, fog };
}

function round(v, n) {
  const m = 10 ** n;
  return Math.round(v * m) / m;
}
