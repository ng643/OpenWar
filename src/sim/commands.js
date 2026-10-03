import { TYPES, BUILDINGS, MAX_ROUTE_POINTS } from '../config.js';
import { placeBuildings } from './buildings.js';
import { cedeLand } from './cession.js';
import { placeRoads } from './roads.js';
import { raiseDivision, issueMove, issueFormation, haltDivs, splitDivs, mergeDivs } from './divisions.js';
import { issueRoute } from './routing.js';
import { nearestLand } from './pathfinding.js';
import { MAX_FORMATION_POINTS } from './formations.js';

// The single entry point for everything a player can order. The local client calls it directly;
// the server calls it for every `cmd` message. Input is untrusted: validate everything.
//
//   { k:'move',      ids:[divId...], x, y }
//   { k:'route',     ids:[divId...], points:[[x,y]...], append?, column? }  1..128 checkpoints, walked in order
//   { k:'road',      points:[[x,y]...] }                  lay a road along the polyline (2..128 points)
//   { k:'formation', ids:[divId...], points:[[x,y]...] }   arrange along the polyline (2..128 points)
//   { k:'halt',  ids }
//   { k:'split', ids }                 -> { added:[newIds] }
//   { k:'merge', ids }                 -> { absorbed:[ids] }
//   { k:'raise', type, city }          city = index into world.cities, or -1 for "capital"
//   { k:'rally', city, x, y }
//   { k:'build', type, tiles:[tileIdx...] }   -> { placed }   (farms may be painted over many tiles)
//   { k:'cede',  to, rect:[x0,y0,x1,y1] }     -> { ceded }    give the sender's own tiles in the
//                                                            inclusive rectangle to the allied seat `to`

const MAX_IDS = 400;
const MAX_TILES = 80;
const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** A formation polyline: 2..MAX_FORMATION_POINTS [x,y] pairs, each exactly two finite numbers. */
function isPolyline(v) {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_FORMATION_POINTS) return false;
  for (const p of v) if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) return false;
  return true;
}

/**
 * A route polyline: 1..MAX_ROUTE_POINTS [x,y] pairs inside the map, each exactly two finite numbers.
 * Points are world positions, so the map bound is the closed rectangle [0,w]x[0,h] — the far edge is a
 * legal click. Routing clamps to the map and snaps each point to standable land from there.
 */
function isRoute(v, world) {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_ROUTE_POINTS) return false;
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) return false;
    if (p[0] < 0 || p[1] < 0 || p[0] > world.w || p[1] > world.h) return false;
  }
  return true;
}

function ownDivs(world, playerId, ids) {
  if (!Array.isArray(ids) || ids.length > MAX_IDS) return [];
  const want = new Set();
  for (const id of ids) if (Number.isInteger(id)) want.add(id);
  return world.divs.filter(d => d.owner === playerId && want.has(d.id) && d.men > 0);
}

/** @returns {{ok:boolean, k?:string, added?:number[], absorbed?:number[], placed?:number, ceded?:number}} */
export function applyCommand(world, playerId, cmd) {
  const p = world.players[playerId - 1];
  if (!p || !p.alive || world.over || !cmd || typeof cmd !== 'object') return { ok: false };
  switch (cmd.k) {
    case 'move': {
      if (!isNum(cmd.x) || !isNum(cmd.y)) return { ok: false };
      issueMove(world, ownDivs(world, playerId, cmd.ids), cmd.x, cmd.y);
      return { ok: true, k: 'move' };
    }
    case 'route': {
      if (!isRoute(cmd.points, world)) return { ok: false };
      issueRoute(world, ownDivs(world, playerId, cmd.ids), cmd.points,
                 { append: cmd.append === true, column: cmd.column === true });
      return { ok: true, k: 'route' };
    }
    case 'road': {
      // Roads own their validation, cost and gold: the command only decides who may ask.
      const r = placeRoads(world, playerId, cmd.points);
      return { ok: r.ok, k: 'road', placed: r.placed, cost: r.cost };
    }
    case 'formation': {
      if (!isPolyline(cmd.points)) return { ok: false };
      issueFormation(world, ownDivs(world, playerId, cmd.ids), cmd.points);
      return { ok: true, k: 'formation' };
    }
    case 'halt':
      haltDivs(ownDivs(world, playerId, cmd.ids));
      return { ok: true, k: 'halt' };
    case 'split': {
      const added = splitDivs(world, ownDivs(world, playerId, cmd.ids));
      return { ok: true, k: 'split', added: added.map(d => d.id) };
    }
    case 'merge': {
      const { absorbed } = mergeDivs(ownDivs(world, playerId, cmd.ids));
      return { ok: true, k: 'merge', absorbed: absorbed.map(d => d.id) };
    }
    case 'raise': {
      if (!TYPES[cmd.type]) return { ok: false };
      const city = Number.isInteger(cmd.city) ? world.cities[cmd.city] : null;
      const d = raiseDivision(world, p, city && city.owner === playerId ? city : null, cmd.type);
      return { ok: !!d, k: 'raise' };
    }
    case 'rally': {
      const city = Number.isInteger(cmd.city) ? world.cities[cmd.city] : null;
      if (!city || city.owner !== playerId || !isNum(cmd.x) || !isNum(cmd.y)) return { ok: false };
      const t = nearestLand(world, cmd.x, cmd.y);
      if (t < 0) return { ok: false };
      city.rally = t;
      return { ok: true, k: 'rally' };
    }
    case 'build': {
      if (!BUILDINGS[cmd.type] || !Array.isArray(cmd.tiles) || cmd.tiles.length > MAX_TILES) return { ok: false };
      const { placed } = placeBuildings(world, p, cmd.type, cmd.tiles);
      return { ok: placed > 0, k: 'build', placed };
    }
    case 'cede': {
      const r = cedeLand(world, playerId, cmd.to, cmd.rect);
      return r.ok ? { ok: true, k: 'cede', ceded: r.ceded } : { ok: false };
    }
    default:
      return { ok: false };
  }
}
