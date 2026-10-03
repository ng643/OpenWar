import { participantColor } from '../config.js';
import { generateMap } from '../sim/mapgen.js';
import { TYPE_IDS, F_ENG, F_OOS, F_MOVING, F_ROUTING, F_ROUT_LOCKED, F_COLUMN } from '../net/protocol.js';

/**
 * A read-mostly mirror of the server's world, shaped like the sim world so the renderer, HUD and
 * input code work unchanged. The terrain is regenerated locally from the seed and the exact
 * dimensions chosen in the lobby (it is deterministic), so only ownership, divisions and player
 * stats ever travel over the wire.
 *
 * The mirror is strict about the roster it is handed: every seat 1..cityCapacity is present, ids are
 * dense, and ownership never names a seat outside it. Colours come from the init (falling back to the
 * shared participant palette) so ids past the original six still render.
 */
export function createViewWorld(init) {
  const w = init.w, h = init.h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new Error('init is missing map dimensions');
  const { terr, elev, landCount } = generateMap(init.seed, w, h);
  const owner = Uint8Array.from(init.owner);
  if (owner.length !== w * h) throw new Error('init ownership does not match its map dimensions');
  if (!Array.isArray(init.players) || init.players.length < 2) throw new Error('init is missing its player roster');
  if (init.cityCapacity != null && init.cityCapacity !== init.players.length) throw new Error('init city capacity does not match its roster');
  const players = init.players.map((p, i) => {
    if (p.id !== i + 1) throw new Error('init player ids must be dense from 1');
    return {
      id: p.id, name: p.name, color: p.color || participantColor(p.id), seat: !!p.seat, human: !!p.human,
      enabled: !!p.enabled, team: p.team ?? 0, bot: !!p.bot,
      tiles: 0, cities: 0, pool: -1, army: -1, alive: !!p.enabled, rate: 0, gold: -1, goldRate: 0,
      built: { farm: 0, factory: 0, fortress: 0 }, active: { farm: 0, factory: 0, fortress: 0 }
    };
  });
  const cityAt = new Int16Array(w * h).fill(-1);
  const cities = init.cities.map((c, i) => {
    cityAt[c.idx] = i;
    return { idx: c.idx, x: c.idx % w, y: (c.idx / w) | 0, owner: c.owner, capital: c.capital, rally: null };
  });
  const bld = new Uint8Array(w * h), bdone = new Float32Array(w * h);
  for (let k = 0; k + 2 < (init.bld || []).length; k += 3) { bld[init.bld[k]] = init.bld[k + 1]; bdone[init.bld[k]] = init.bld[k + 2]; }
  // Roads arrive as a flat list of road tiles; the Uint8Array matches the sim world so travel and
  // logistics helpers (and their version caches) work unchanged on the mirror.
  const roads = new Uint8Array(w * h);
  for (const t of init.roads || []) roads[t] = 1;
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i];
    if (!o) continue;
    if (o > players.length) throw new Error('init ownership references player ' + o + ' outside its roster');
    players[o - 1].tiles++;
  }
  for (const c of cities) {
    if (!c.owner) continue;
    if (c.owner > players.length) throw new Error('init city ownership references player ' + c.owner + ' outside its roster');
    players[c.owner - 1].cities++;
  }
  return {
    seed: init.seed, w, h, cityCapacity: players.length, settings: init.settings,
    terr, elev, landCount, owner, cityAt, ownerVersion: 1, bld, bdone, buildVersion: 1, forts: [],
    roads, roadVersion: init.roadVersion ?? 1,
    cities, players, divs: [], fights: [], time: init.time || 0,
    over: !!init.result, result: init.result || null, byId: new Map()
  };
}

/**
 * Fold one `snap` message into the view world.
 * Division objects keep their identity across snapshots (selection, control groups and the
 * renderer's interpolation all hold references), and px/py is set to where the division is
 * currently drawn so motion stays continuous even when a snapshot lands mid-interpolation.
 */
export function applySnapshot(world, snap, alpha = 1) {
  const ch = snap.ch;
  if (ch && ch.length) {
    for (let k = 0; k < ch.length; k += 2) {
      const t = ch[k], o = ch[k + 1], prev = world.owner[t];
      if (prev === o) continue;
      world.owner[t] = o;
      const ci = world.cityAt[t];
      if (ci >= 0) { world.cities[ci].owner = o; world.cities[ci].rally = null; }
    }
    world.ownerVersion++;
  }

  const bch = snap.bch;
  if (bch && bch.length) {
    for (let k = 0; k + 2 < bch.length; k += 3) { world.bld[bch[k]] = bch[k + 1]; world.bdone[bch[k]] = bch[k + 1] ? bch[k + 2] : 0; }
    world.buildVersion++;
  }

  // Road deltas are public like buildings, so they travel the same way. Road tiles survive capture:
  // the ownership change (ch) and the road itself are independent.
  const rch = snap.rch;
  if (rch && rch.length) {
    for (let k = 0; k + 1 < rch.length; k += 2) world.roads[rch[k]] = rch[k + 1];
    world.roadVersion++;
  }

  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const next = [], byId = new Map();
  for (const row of snap.divs) {
    const [id, ownerId, ty, x, y, men, cap, flags, path, route, anchor] = row;
    let d = world.byId.get(id);
    if (!d) {
      d = {
        id, owner: ownerId, type: TYPE_IDS[ty], x, y, px: x, py: y, men, cap, path: [], routePoints: [],
        anchor: null, vis: true, moving: false, routing: false, routLocked: false, column: false
      };
    } else {
      d.px = d.px + (d.x - d.px) * a;
      d.py = d.py + (d.y - d.py) * a;
      d.x = x; d.y = y;
    }
    d.owner = ownerId; d.type = TYPE_IDS[ty]; d.men = men; d.cap = cap;
    d.eng = !!(flags & F_ENG); d.oos = !!(flags & F_OOS); d.moving = !!(flags & F_MOVING);
    d.routing = !!(flags & F_ROUTING); d.routLocked = !!(flags & F_ROUT_LOCKED); d.column = !!(flags & F_COLUMN);
    // Own divisions carry wire data past the flags: the current leg at [8], the remaining multipoint
    // checkpoints at [9] and the saved home at [10] (the exact spot a body traffic displaced is
    // walking back to). A visible ally's row carries only its home at [10], padded with empty slots
    // at [8]/[9]; an enemy row stops at the flags, so neither a route nor a home ever leaks. The
    // object is reused so a moving home re-uses one allocation, and an absent home clears the field:
    // released ground must stop being reserved for the preview at once.
    d.path = path || [];
    d.routePoints = route || [];
    if (anchor) {
      if (d.anchor) { d.anchor.x = anchor[0]; d.anchor.y = anchor[1]; }
      else d.anchor = { x: anchor[0], y: anchor[1] };
    } else d.anchor = null;
    byId.set(id, d); next.push(d);
  }
  world.divs = next;
  world.byId = byId;

  world.fights = [];
  for (const [ia, ib, ranged] of snap.fights) {
    const da = byId.get(ia), db = byId.get(ib);
    if (da && db) world.fights.push([da, db, ranged]);
  }

  snap.pl.forEach((r, i) => {
    const p = world.players[i];
    p.tiles = r[0]; p.cities = r[1]; p.alive = !!r[2]; p.pool = r[3]; p.rate = r[4]; p.army = r[5];
    p.gold = r[6]; p.goldRate = r[7];
  });
  world.time = snap.time;
}
