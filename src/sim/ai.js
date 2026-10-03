import {
  TYPES, WATER, BUILD_RADIUS, ART_RANGE, RANGE, FORT_RANGE,
  ROUT_FRAC, LOGISTICS_DISTANCE, ROAD_GOLD
} from '../config.js';
import { canBuild, placeBuildings, hasFactory, buildCost } from './buildings.js';
import { findPath } from './pathfinding.js';
import { raiseDivision, issueMove, issueFormation } from './divisions.js';
import { logisticsDistance } from './supply.js';
import { roadTiles, placeRoads } from './roads.js';
import { tileOf } from './geom.js';
import { BASE_AI_POLICY, getAIPolicy } from './ai-policy.js';
import { allied } from './teams.js';
import { cedeLand } from './cession.js';

// --- AI tuning: every number here is a function of world state, never of elapsed time ------------
// The per-player decision knobs live in the deployed policy (p.aiPolicy, seeded by createWorld from
// ai-policy.js difficulty profiles); the constants below are the shared baseline those profiles
// default to, kept exported for callers and tests.
/** Tiles between two slots of one line - wider than the firm-collision body radius. */
export const LINE_SPACING = 1.6;
/** lineDemand() at/above this an army fights in lines instead of scattering to capture land. */
export const LINE_DEMAND = BASE_AI_POLICY.lineDemand;
/** No line is wider than this, so groups stay compact instead of spanning the continent. */
export const MAX_LINE_WIDTH = 14;
/** Divisions in one line before the army forms another line behind it. */
export const RANK_MAX = 8;

const GROUP_RADIUS = 7;             // a group is the divisions within this of its running centre
const THREAT_RANGE = 16;            // enemy divisions this close are a group's immediate threat
const SEARCH_RANGE = 60;            // how far a group looks for an enemy city to march on
const ECHELON = 6;                  // distance between successive lines of a large army
const ART_BACK = ART_RANGE * 0.6;   // artillery stands behind the front but inside its fire range
const RANK_MAX_THREAT = 6;          // tighter lines when nearby enemy mass matches our own
const CAPTURE_SAMPLES = 30;         // candidate tiles sampled per capturing division
const ROAD_NEED_DIST = LOGISTICS_DISTANCE;  // supply distance past which a front is worth a paid road
export const ROAD_MAX_NEW = 32;     // fresh tiles one project may pave: bounded spending per think
const ROAD_CANDIDATES = 3;          // front/city-link candidates examined per think (each routes once)
const ROAD_SNAP = 6;                // how far a road end may snap from a front onto owned ground

/** The policy one player thinks with: world-seeded per player by createWorld (p.aiPolicy), the
 * deployed medium profile when a caller hands in a bare player. The returned object is frozen and
 * shared - a think-pass reads it, never copies or mutates it. */
const policyOf = (world, p) => p.aiPolicy || getAIPolicy(world.settings && world.settings.aiDifficulty);

/** True when participant `owner` is hostile to `p`: a real owner that is neither neutral ground (0),
 * nor p, nor a teammate. The shared `allied` relation is the only source of team truth, so a
 * teammate's divisions are never threats and its cities are never enemy city targets. */
const isFoe = (world, p, owner) => owner !== 0 && owner !== p.id && !allied(world, p.id, owner);

/** True when tile owner `owner` holds ground `p` may take: neutral land, or a foe's. Teammate
 * territory is never capturable, so it is neither a capture destination nor a frontier of p's. */
const capturable = (world, p, owner) => owner === 0 || (owner !== p.id && !allied(world, p.id, owner));

/** One think-pass for an AI player: recruit, invest (buildings and roads), then give fresh orders to
 * the idle divisions. */
export function aiThink(world, p) {
  const { rand, time } = world;
  const mine = world.divs.filter(d => d.owner === p.id);
  const myCities = world.cities.filter(c => c.owner === p.id);
  const chest = p.pool >= TYPES.arm.manpower ? TYPES.arm.gold : TYPES.inf.gold;
  // The deployed policy is resolved once per think-pass and handed to every sub-policy; it is a
  // frozen shared object, never re-normalized or copied per decision.
  const policy = policyOf(world, p);

  // Peaceful land policy runs first, before any spending or orders: it only ever moves ownership of
  // already-owned bare tiles between teammates, so it needs no budget, route or unit and cannot
  // disturb the construction, paving, recruitment or order passes below.
  aiCede(world, p);

  // Construction and roads are paid from their own slices of gold income (buildBudget/roadBudget), so
  // buildings, paving and armies are funded in parallel instead of fighting over one purse; the army
  // keeps the chest and recruits from whatever is left. Both go first so what their budgets already
  // cover is claimed before a division can be raised with it.
  let held = 0;
  if (myCities.length) held = aiBuild(world, p, myCities, buildBudget(world, p), policy);
  const reserve = Math.max(chest, held);
  const roadHold = aiRoads(world, p, myCities, roadBudget(world, p), reserve, policy);
  recruit(world, p, mine, myCities, reserve + roadHold, policy);

  const byId = new Map(mine.map(d => [d.id, d]));
  for (const o of planAI(world, p).orders) {
    const units = [];
    for (const id of o.ids) { const d = byId.get(id); if (d) units.push(d); }
    if (!units.length) continue;
    if (o.k === 'formation') issueFormation(world, units, o.points);
    else issueMove(world, units, o.x, o.y);
    // Only divisions that actually got a route go on cooldown; the rest retry on the next think.
    for (const d of units) if (d.path.length) { d.aiGoal = o.goal; d.nextThink = time + 2 + rand() * 3; }
  }
}

/** At most this many bare tiles one think may hand to a teammate: a bounded, deliberate gesture, not
 * a wholesale surrender. */
export const CEDE_MAX_TILES = 4;
/** Own divisions within this many tiles (Chebyshev) of a candidate keep it: land under or near the
 * AI's own troops is never given away, so a cession can never strand or unhinge a division. */
const CEDE_UNIT_CLEAR = 2;

/**
 * Peaceful land policy: give a teammate a bounded handful of the AI's own bare border tiles when
 * they fall inside one of that teammate's city zones (BUILD_RADIUS) and outside every one of the
 * AI's own - the fringe a teammate needs to raise its Factory or Fortress there, which the AI cannot
 * build on itself. Only bare tiles that genuinely touch the teammate's land move; cities, finished
 * and unfinished buildings, the AI's own city footprints and ground under or near its divisions are
 * never given, and no gold or manpower changes hands.
 *
 * One recipient per think (players in id order) and CEDE_MAX_TILES tiles per think (cities in idx
 * order, tiles ascending within each), so the policy is stable, deterministic and bounded. Each
 * tile is ceded through the shared cedeLand mutation path, which keeps ownership, building and city
 * tallies in sync. State-driven only - no policy knob, no randomness, no elapsed time.
 * @returns {number} tiles actually ceded this think (0 when there is no teammate or no such ground).
 */
export function aiCede(world, p) {
  // Disabled or dead players own nothing worth giving, and never act.
  if (!p.enabled || !p.alive) return 0;
  // world.players is id-ordered, so recipients are considered in a stable order and only one gets a
  // gift this think. In FFA `allied` is true only of a player with itself, so the list is empty.
  for (const q of world.players) {
    if (q.id === p.id || !q.enabled || !q.alive || !allied(world, p.id, q.id)) continue;
    const tiles = cedeTiles(world, p, q);
    if (!tiles.length) continue;
    let ceded = 0;
    for (const t of tiles) {
      const x = t % world.w, y = (t / world.w) | 0;
      const r = cedeLand(world, p.id, q.id, [x, y, x, y]);
      if (r && r.ok) ceded += r.ceded;
    }
    return ceded;                               // one recipient per think, even if it took none
  }
  return 0;
}

/**
 * The AI's own bare tiles worth handing to teammate `q`, in stable city/tile order: each lies inside
 * one of q's city build radii, touches q's land, and sits outside every one of the AI's own city
 * zones and clear of its own divisions. Cities, buildings (finished or under construction) and bare
 * tiles with no teammate frontier are excluded. Bounded by CEDE_MAX_TILES.
 */
function cedeTiles(world, p, q) {
  const { owner, terr, bld, cityAt, w, h } = world;
  const zones = world.cities.filter(c => c.owner === q.id).sort((a, b) => a.idx - b.idx);
  const seen = new Set();
  const out = [];
  for (const c of zones) {
    const x0 = Math.max(0, Math.floor(c.x - BUILD_RADIUS)), x1 = Math.min(w - 1, Math.ceil(c.x + BUILD_RADIUS));
    const y0 = Math.max(0, Math.floor(c.y - BUILD_RADIUS)), y1 = Math.min(h - 1, Math.ceil(c.y + BUILD_RADIUS));
    for (let y = y0; y <= y1 && out.length < CEDE_MAX_TILES; y++) {
      for (let x = x0; x <= x1 && out.length < CEDE_MAX_TILES; x++) {
        const i = y * w + x;
        if (owner[i] !== p.id || terr[i] === WATER) continue;
        if (bld[i] !== 0 || cityAt[i] >= 0) continue;                 // never a building or a city
        if (Math.hypot(c.x - x, c.y - y) > BUILD_RADIUS) continue;    // must be inside q's city zone
        if (seen.has(i)) continue;                                    // a zone overlap is offered once
        if (!touchesOwner(world, q.id, i)) continue;                  // must border q's land
        if (ownCityZone(world, p, x, y)) continue;                    // outside every one of the AI's zones
        if (nearOwnDivision(world, p, x, y)) continue;                // never under/near its own troops
        seen.add(i);
        out.push(i);
      }
    }
  }
  return out;
}

/** Does land tile `i` share an edge with land owned by `o`? */
function touchesOwner(world, o, i) {
  const { owner, terr, w, h } = world;
  const x = i % w, y = (i / w) | 0;
  return (x > 0 && owner[i - 1] === o && terr[i - 1] !== WATER) ||
    (x < w - 1 && owner[i + 1] === o && terr[i + 1] !== WATER) ||
    (y > 0 && owner[i - w] === o && terr[i - w] !== WATER) ||
    (y < h - 1 && owner[i + w] === o && terr[i + w] !== WATER);
}

/** Is (x, y) inside the build radius of any city `p` owns? Such ground is the AI's own to use. */
function ownCityZone(world, p, x, y) {
  for (const c of world.cities) if (c.owner === p.id && Math.hypot(c.x - x, c.y - y) <= BUILD_RADIUS) return true;
  return false;
}

/** Is a tile centre within CEDE_UNIT_CLEAR tiles of one of `p`'s divisions? */
function nearOwnDivision(world, p, x, y) {
  for (const d of world.divs) {
    if (d.owner !== p.id) continue;
    if (Math.abs(d.x - (x + 0.5)) <= CEDE_UNIT_CLEAR && Math.abs(d.y - (y + 0.5)) <= CEDE_UNIT_CLEAR) return true;
  }
  return false;
}

/** Raise a division while the soft cap allows it; heavy units need a Factory city. `reserve` is gold
 * the army must leave in the bank (the war chest, plus a building already paid for by the budget).
 * The cap and the type roll are the player's policy: recruitTiles tiles per extra division, then
 * infantry/armor/artillery split by infantryShare and armorShare. */
function recruit(world, p, mine, myCities, reserve, policy = policyOf(world, p)) {
  if (!myCities.length || mine.length >= 3 + Math.floor(p.tiles / policy.recruitTiles)) return;
  const r = world.rand();
  let type = r < policy.infantryShare ? 'inf' : r < policy.infantryShare + policy.armorShare ? 'arm' : 'art';
  let pool = myCities;
  if (TYPES[type].needs) {
    pool = myCities.filter(c => hasFactory(world, p.id, c));
    if (!pool.length) { type = 'inf'; pool = myCities; }
  }
  // Keep troops flowing: when the rolled type is too dear, raise infantry instead of nothing.
  if (type !== 'inf' && (p.pool < TYPES[type].manpower || p.gold < reserve + TYPES[type].gold) &&
      p.pool >= TYPES.inf.manpower && p.gold >= reserve + TYPES.inf.gold) { type = 'inf'; pool = myCities; }
  if (p.pool < TYPES[type].manpower || p.gold < reserve + TYPES[type].gold) return;
  raiseDivision(world, p, pool[(world.rand() * pool.length) | 0], type);
}

/**
 * Strategic snapshot of one AI player: how many divisions it has and how strong they are, how much
 * of the map it holds and how long its border is, who leads (the rival side with the most land),
 * how many rival players are left, and how much enemy manpower stands near its army. Pure world
 * state - it never reads `world.time`, so no AI decision can be a function of elapsed time.
 * @returns {{n:number,men:number,hurt:number,cities:number,landShare:number,frontierTiles:number[],
 *   frontierShare:number,threat:number,opponents:number,leaderShare:number}}
 */
export function aiState(world, p) {
  const { owner, terr, divs, players, landCount } = world;
  let n = 0, men = 0, hurt = 0;
  // "Hurt" is the same threshold the sim routes on: below ROUT_FRAC a division is combat-wounded.
  for (const d of divs) if (d.owner === p.id) { n++; men += d.men; if (d.men < d.cap * ROUT_FRAC) hurt++; }

  const frontierTiles = [];
  const w = world.w, h = world.h;
  const last = w * (h - 1);
  const land = i => terr[i] !== WATER;
  for (let i = 0; i < w * h; i++) {
    if (owner[i] !== p.id) continue;
    const x = i % w;
    if ((x > 0 && land(i - 1) && capturable(world, p, owner[i - 1])) ||
        (x < w - 1 && land(i + 1) && capturable(world, p, owner[i + 1])) ||
        (i >= w && land(i - w) && capturable(world, p, owner[i - w])) ||
        (i < last && land(i + w) && capturable(world, p, owner[i + w]))) frontierTiles.push(i);
  }

  let threat = 0;
  for (const e of divs) {
    if (!isFoe(world, p, e.owner)) continue;
    for (const d of divs) if (d.owner === p.id && Math.hypot(e.x - d.x, e.y - d.y) <= THREAT_RANGE) { threat += e.men; break; }
  }

  // The leading side is measured by the land its whole side holds: an enemy coalition is one strong
  // rival, not several small ones. `opponents` stays a player count - the endgame bonus is about
  // how many rivals are left, and in a fresh two-team game counting sides would fire it from turn
  // one (measured: the roster bot test then stops taking ground). In FFA every enabled seat carries
  // its own id as its team (createWorld), so each side is a single player and the classic per-player
  // numbers come out exactly; a hand-built seat without a team counts alone too.
  let opponents = 0, leaderShare = 0;
  const sideTiles = new Map();
  for (const q of players) {
    if (!isFoe(world, p, q.id) || !q.alive) continue;
    opponents++;
    const side = (q.team | 0) || q.id;
    sideTiles.set(side, (sideTiles.get(side) || 0) + q.tiles);
  }
  for (const tiles of sideTiles.values()) leaderShare = Math.max(leaderShare, landCount ? tiles / landCount : 0);
  return {
    n, men, hurt, cities: p.cities,
    landShare: landCount ? p.tiles / landCount : 0,
    frontierTiles,
    frontierShare: Math.min(1, frontierTiles.length / Math.max(1, p.tiles)),
    threat, opponents, leaderShare
  };
}

/**
 * How strongly this army should fight as a line rather than scatter for land. Troop mass, the share
 * of the map the AI already holds, the length of its border, nearby enemy manpower, a rival side
 * running away with the game and the endgame (few rival sides left) all push lines up; time pushes
 * nothing.
 */
export function lineDemand(st) {
  return st.men / 200
    + st.landShare * 3
    + Math.min(1, st.frontierShare) * 0.8
    + Math.min(1.5, st.threat / 200)
    + (st.leaderShare > 0.3 ? 1 : 0)
    + (st.opponents <= 2 ? 1 : 0);
}

/**
 * Work out one think-pass for an AI player without touching the world: which divisions are busy
 * (fighting, marching or cooling down) and stay untouched, which are fleeing, cornered or wounded
 * under the shared routing policy and are left strictly alone, and what orders the free ones get.
 * Orders are applied by aiThink:
 *   {k:'move',      ids:[id], x, y, goal:'capture'|'support'}
 *   {k:'formation', ids:[...ids], points:[[x,y],[x,y]], goal:'line', aim:[x,y]}
 * A group of two or more line troops fights as a line as soon as lineDemand() says the army is big,
 * entrenched or threatened enough; smaller or scattered groups keep capturing land around them.
 */
export function planAI(world, p) {
  const st = aiState(world, p);
  const policy = policyOf(world, p);
  const orders = [], free = [];

  for (const d of world.divs) {
    if (d.owner !== p.id) continue;
    // Fleeing and cornered are authoritative states shared with humans: the sim owns the flee path,
    // the locked fight-to-the-death decision and the saved intended order, so the AI never re-orders
    // a routing or routLocked division - it must keep fleeing or keep fighting until it is spent.
    if (d.routing || d.routLocked) continue;
    // A division below the routing threshold is left to hold its ground and be reinforced rather
    // than be pushed back into a line by the AI; either way it never joins a group.
    if (d.men < d.cap * ROUT_FRAC) continue;
    // Busy: fighting, walking a leg, still holding ordered checkpoints (the leg underfoot can be
    // empty between checkpoints) or walking back to ground it was displaced from. The sim owns all of
    // those routes, and a fresh order would wipe them, so the division stays untouched.
    if (d.eng || d.path.length || d.routePoints.length || d.anchor != null || world.time < d.nextThink) continue;
    free.push(d);
  }

  const claimed = [];                            // capture destinations already handed out
  for (const g of cluster(free)) {
    const units = g.units;
    const men = units.reduce((s, d) => s + d.men, 0);
    const front = units.filter(d => d.type !== 'art');   // artillery never captures and never charges
    const arts = units.filter(d => d.type === 'art');
    const threat = nearbyEnemy(world, p, g.cx, g.cy);
    const obj = objective(world, p, st, g, threat);
    const lines = front.length >= 2 && !!obj &&
      lineDemand({ ...st, n: units.length, men, threat: threat ? threat.men : 0 }) >= policy.lineDemand;
    const anchor = lines ? frontAnchor(g, obj, policy.advance) : null;
    const first = orders.length;
    if (front.length) {
      if (lines) lineRanks(front, anchor, threat && threat.men >= men ? RANK_MAX_THREAT : RANK_MAX, orders);
      else capture(world, p, front, claimed, orders, policy);
    }
    if (arts.length) {
      if (lines) artilleryLine(arts, anchor, orders);
      else captureArt(world, p, arts, orders);
    }
    if (lines) for (let i = first; i < orders.length; i++) orders[i].aim = [obj.x, obj.y];
  }
  return { state: st, demand: lineDemand(st), orders };
}

/** Deterministic greedy grouping: divisions join the first group whose running centre is within
 * GROUP_RADIUS of them (id order), otherwise they start a new group. */
function cluster(units) {
  const groups = [];
  for (const d of units.slice().sort((a, b) => a.id - b.id)) {
    let best = null, bd = GROUP_RADIUS;
    for (const g of groups) {
      const dd = Math.hypot(g.cx - d.x, g.cy - d.y);
      if (dd < bd) { bd = dd; best = g; }
    }
    if (!best) { best = { cx: d.x, cy: d.y, units: [] }; groups.push(best); }
    best.units.push(d);
    const k = best.units.length;
    best.cx += (d.x - best.cx) / k;
    best.cy += (d.y - best.cy) / k;
  }
  return groups;
}

/**
 * Enemy strength near a point: the men-weighted centre of enemy divisions within THREAT_RANGE (how
 * heavy the mass is, which decides how tight a line has to be), plus the closest of those divisions.
 * A line marches on the FRONT one, never on the centre: a big army's centre sits far behind its own
 * front rank, so aiming at it would halt the line in open ground short of melee range - a frozen war.
 */
function nearbyEnemy(world, p, x, y) {
  let sx = 0, sy = 0, men = 0, front = null, near = Infinity;
  for (const e of world.divs) {
    if (!isFoe(world, p, e.owner)) continue;
    const dd = Math.hypot(e.x - x, e.y - y);
    if (dd > THREAT_RANGE) continue;
    sx += e.x * e.men; sy += e.y * e.men; men += e.men;
    if (dd < near) { near = dd; front = { x: e.x, y: e.y }; }
  }
  return men > 0 ? { x: sx / men, y: sy / men, men, front } : null;
}

/**
 * The next thing to fight for: the front of the enemy mass this group can see (the line closes to
 * melee range instead of hovering), else the nearest enemy city within SEARCH_RANGE, else the
 * nearest stretch of the AI's own frontier. Null when the group has nothing worth doing.
 */
function objective(world, p, st, g, threat) {
  if (threat) return { x: threat.front.x, y: threat.front.y, standoff: RANGE * 0.8 };
  let bc = null, bd = SEARCH_RANGE;
  for (const c of world.cities) {
    if (!isFoe(world, p, c.owner)) continue;
    const q = world.players[c.owner - 1];
    if (!q || !q.alive) continue;
    const dd = Math.hypot(c.x + .5 - g.cx, c.y + .5 - g.cy);
    if (dd < bd) { bd = dd; bc = c; }
  }
  if (bc) return { x: bc.x + .5, y: bc.y + .5 };
  let ft = -1, fd = Infinity;
  for (const t of st.frontierTiles) {
    const dd = Math.hypot((t % world.w) + .5 - g.cx, ((t / world.w) | 0) + .5 - g.cy);
    if (dd < fd) { fd = dd; ft = t; }
  }
  return ft >= 0 ? { x: (ft % world.w) + .5, y: ((ft / world.w) | 0) + .5 } : null;
}

/**
 * Where a group's front line stands this think and which way it faces: `advance` tiles (the
 * player's policy.advance) from the group's centre towards the objective (the whole distance to a
 * nearby enemy, minus its standoff), so lines roll forward in steps and stop in melee range instead
 * of walking through the enemy.
 */
function frontAnchor(g, obj, advance = BASE_AI_POLICY.advance) {
  let dx = obj.x - g.cx, dy = obj.y - g.cy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: g.cx, y: g.cy, dx: 1, dy: 0 };
  dx /= d; dy /= d;
  const step = Math.min(Math.max(d - (obj.standoff || 0), 0), advance);
  return { x: g.cx + dx * step, y: g.cy + dy * step, dx, dy };
}

/**
 * One line per rank: the divisions closest to the objective hold the front line, the rest form lines
 * ECHELON tiles behind it. Lines are centred on the anchor, perpendicular to the advance direction
 * and no wider than MAX_LINE_WIDTH, so a big army fights as several compact lines.
 */
function lineRanks(units, anchor, perLine, orders) {
  const px = -anchor.dy, py = anchor.dx;
  const proj = d => (d.x - anchor.x) * anchor.dx + (d.y - anchor.y) * anchor.dy;
  const sorted = units.slice().sort((a, b) => proj(b) - proj(a) || a.id - b.id);
  for (let start = 0, rank = 0; start < sorted.length; start += perLine, rank++) {
    const rankUnits = sorted.slice(start, start + perLine);
    const cx = anchor.x - anchor.dx * rank * ECHELON, cy = anchor.y - anchor.dy * rank * ECHELON;
    const half = Math.min(MAX_LINE_WIDTH, (rankUnits.length - 1) * LINE_SPACING) / 2;
    orders.push({
      k: 'formation', ids: rankUnits.map(d => d.id), goal: 'line',
      points: [[cx - px * half, cy - py * half], [cx + px * half, cy + py * half]]
    });
  }
}

/** Artillery deploys as one line ART_BACK behind the front line, inside its fire support range. */
function artilleryLine(units, anchor, orders) {
  const px = -anchor.dy, py = anchor.dx;
  const cx = anchor.x - anchor.dx * ART_BACK, cy = anchor.y - anchor.dy * ART_BACK;
  const half = Math.min(MAX_LINE_WIDTH, (units.length - 1) * LINE_SPACING) / 2;
  orders.push({
    k: 'formation', ids: units.map(d => d.id), goal: 'line',
    points: [[cx - px * half, cy - py * half], [cx + px * half, cy + py * half]]
  });
}

/**
 * Scatter the group onto nearby enemy or unowned land, one unique destination per division. Prefers
 * ground that touches the AI's own border (so the army expands its territory) and land near cities;
 * never hands the same area to two divisions.
 */
function capture(world, p, units, claimed, orders, policy = policyOf(world, p)) {
  for (const d of units) {
    const t = captureTarget(world, p, d, claimed, policy);
    if (t < 0) continue;
    orders.push({ k: 'move', ids: [d.id], x: (t % world.w) + .5, y: ((t / world.w) | 0) + .5, goal: 'capture' });
  }
}

/** Best unclaimed tile around `d` to capture, or -1. Deterministic; routes are validated first.
 * The policy's captureRange scales the search radius, so a wider-looking player claims farther-out
 * ground while a tight one grabs only what it stands on. */
function captureTarget(world, p, d, claimed, policy = policyOf(world, p)) {
  const { terr, owner, cityAt, rand } = world;
  const rad = (7 + d.men / 18) * policy.captureRange, cand = [];
  for (let k = 0; k < CAPTURE_SAMPLES; k++) {
    const a = rand() * 6.283, rr = 3 + rand() * rad;
    const x = (d.x + Math.cos(a) * rr) | 0, y = (d.y + Math.sin(a) * rr) | 0;
    if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
    const i = y * world.w + x;
    if (terr[i] === WATER || !capturable(world, p, owner[i])) continue;
    if (claimed.some(c => Math.abs((c % world.w) - x) < 3 && Math.abs(((c / world.w) | 0) - y) < 3)) continue;
    let sc = (owner[i] === 0 ? 2 : 1) - rr * 0.12 + rand();
    if (owner[i] && world.players[owner[i] - 1].seat) sc += 0.6;   // mild grudge against human seats
    let border = false;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= world.w || yy >= world.h) continue;
      const j = yy * world.w + xx;
      if (cityAt[j] >= 0 && owner[j] !== p.id) sc += 0.15;
      if (owner[j] === p.id && terr[j] !== WATER) border = true;
    }
    if (border) sc += 0.9;
    cand.push([sc, i]);
  }
  cand.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < Math.min(3, cand.length); k++) {
    const t = cand[k][1];
    if (!findPath(world, tileOf(world, d), t)) continue;
    claimed.push(t);
    return t;
  }
  return -1;
}

/**
 * Without a line to stand behind, artillery trails the nearest friendly line division at a standoff
 * (never the same tile), or falls back on the nearest own city. It can never capture land.
 */
function captureArt(world, p, units, orders) {
  for (const a of units) {
    const buddy = nearest(world.divs, d => d.owner === p.id && d !== a && d.type !== 'art', a.x, a.y);
    if (buddy) {
      const foe = nearest(world.divs, d => isFoe(world, p, d.owner), buddy.x, buddy.y);
      let dx = foe ? buddy.x - foe.x : 0, dy = foe ? buddy.y - foe.y : 0;
      const dd = Math.hypot(dx, dy);
      if (dd > 1e-6) { dx /= dd; dy /= dd; } else { dx = 1; dy = 0; }
      orders.push({ k: 'move', ids: [a.id], x: buddy.x + dx * ART_BACK, y: buddy.y + dy * ART_BACK, goal: 'support' });
      continue;
    }
    const c = nearestCity(world, p, a.x, a.y);
    if (c) orders.push({ k: 'move', ids: [a.id], x: c.x + .5, y: c.y + .5, goal: 'support' });
  }
}

const nearest = (divs, pred, x, y) => {
  let best = null, bd = Infinity;
  for (const d of divs) {
    if (!pred(d)) continue;
    const dd = Math.hypot(d.x - x, d.y - y);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
};

const nearestCity = (world, p, x, y) => {
  let best = null, bd = Infinity;
  for (const c of world.cities) {
    if (c.owner !== p.id) continue;
    const dd = Math.hypot(c.x + .5 - x, c.y + .5 - y);
    if (dd < bd) { bd = dd; best = c; }
  }
  return best;
};

/** Construction budgets, sim-only: world -> player id -> { fund, t }. Never part of the wire state. */
const buildFunds = new WeakMap();

/**
 * The construction budget of one AI player: `fund` is the gold its economy has set aside for
 * building, `t` the last time income was banked. A single purse would force a choice between
 * starving the army while saving for a Factory and never reaching its price at all, so buildings are
 * paid from their own slice of gold income (the policy's buildShare) while the rest pays for troops.
 * The fund is
 * a pure function of income, holdings and gold rate - no elapsed-time gate, no randomness, no wire
 * state. Rows are created on first ask and live as long as their world.
 */
function buildBudget(world, p) {
  let byPlayer = buildFunds.get(world);
  if (!byPlayer) buildFunds.set(world, byPlayer = new Map());
  let e = byPlayer.get(p.id);
  if (!e) byPlayer.set(p.id, e = { fund: 0, t: world.time });
  return e;
}

/**
 * Building policy. Every want scales with owned land, cities and income - never with elapsed time:
 *  - Factories: one per owned city, plus a spare once gold income is high. They unlock Armor and
 *    Artillery in that city and pay the most taxes.
 *  - Fortresses: one per two owned cities, holding ground the AI already took.
 *  - Farms: three per hundred owned tiles plus one and a half per city. Only on owned plain land
 *    OUTSIDE the BUILD_RADIUS of every city - held or not - so a city the AI captures later still
 *    has its full zone free for its own Factory or Fortress; with no such land no Farm is placed at
 *    all (there is never an in-zone fallback). Prefers interior ground away from the cities.
 * Each think the AI invests in the wanted category it is furthest behind on (lowest built/want), so
 * cheap Farms can never crowd out Factories and vice versa, and buys that one building when its
 * budget covers the price. A category with no legal tile is skipped, so an impossible one never
 * starves the others; and income is banked only while something is still wanted, so an AI with a
 * finished economy spends all of its gold on troops instead of hoarding.
 * @returns {number} gold the army must leave in the bank for a building the budget already covers but
 *   the purse cannot pay for yet, so recruitment cannot spend the savings before they are used.
 */
function aiBuild(world, p, myCities, budget, policy = policyOf(world, p)) {
  const want = {
    factory: myCities.length + (p.goldRate >= 10 ? 1 : 0),
    fortress: Math.ceil(myCities.length / 2),
    farm: Math.ceil(p.tiles * 0.03 + myCities.length * 1.5),
  };
  // Furthest behind first; ties keep the order above (Factories, then Fortresses, then Farms).
  let type = null, tile = -1, cost = 0, behind = Infinity;
  for (const t of ['factory', 'fortress', 'farm']) {
    if (p.built[t] >= want[t]) continue;
    const ratio = p.built[t] / want[t];
    if (ratio >= behind) continue;
    const at = t === 'farm' ? farmTile(world, p) : zoneTile(world, p, myCities, t);
    if (at < 0) continue;                       // nowhere legal: another category gets the budget
    behind = ratio; type = t; tile = at; cost = buildCost(world, p.id, t);
  }
  const dt = Math.max(0, Math.min(world.time - budget.t, 10));
  budget.t = world.time;
  if (type) budget.fund = Math.min(cost, budget.fund + p.goldRate * dt * policy.buildShare);
  if (!type || budget.fund < cost) return 0;    // nothing wanted, or still saving for it
  if (p.gold < cost) return cost;               // funded but not yet paid for: hold the purse for it
  if (placeBuildings(world, p, type, [tile]).placed) budget.fund = Math.max(0, budget.fund - cost);
  return 0;
}

/**
 * Best owned plain tile for a Farm: outside the build radius of EVERY city, held or not, so a Farm
 * can never squat on ground that city's Factory or Fortress will need once the AI captures it.
 * Prefers interior ground (safe from capture) far from the nearest city of any owner. -1 when the
 * AI owns no such land.
 */
function farmTile(world, p) {
  const { owner, rand } = world;
  let best = -1, bs = -1;
  for (let i = 0; i < world.w * world.h; i++) {
    const x = i % world.w, y = (i / world.w) | 0;
    if (!canBuild(world, p.id, 'farm', i) || nearAnyCity(world, x, y)) continue;
    let sc = 0;
    if (x > 0 && owner[i - 1] === p.id) sc++;
    if (x < world.w - 1 && owner[i + 1] === p.id) sc++;
    if (y > 0 && owner[i - world.w] === p.id) sc++;
    if (y < world.h - 1 && owner[i + world.w] === p.id) sc++;
    sc = sc * 4 + Math.min(8, cityDist(world, x, y));
    if (sc > bs || (sc === bs && rand() < 0.5)) { bs = sc; best = i; }
  }
  return best;
}

/** Inside the build radius of ANY city, held or not? Such ground belongs to Factories/Fortresses. */
function nearAnyCity(world, x, y) {
  for (const c of world.cities) if (Math.hypot(c.x - x, c.y - y) <= BUILD_RADIUS) return true;
  return false;
}

/** Tile distance from (x, y) to the nearest city of any owner (Infinity when the map has none). */
function cityDist(world, x, y) {
  let d = Infinity;
  for (const c of world.cities) d = Math.min(d, Math.hypot(c.x - x, c.y - y));
  return d;
}

/**
 * Legal tile for a Factory/Fortress inside one of the AI's city zones. Prefers a city that still
 * lacks the building (a Factory unlocks Armor/Artillery there, a Fortress must not be redundant),
 * samples deterministic spots around it, and finally scans the map so a legal tile is never missed.
 * -1 when no owned city zone has room.
 */
function zoneTile(world, p, myCities, type) {
  const sorted = myCities.slice().sort((a, b) => a.idx - b.idx);
  const lacking = sorted.filter(c => type === 'factory'
    ? !hasFactory(world, p.id, c)
    : !world.forts.some(f => f.owner === p.id && Math.hypot(f.x - (c.x + .5), f.y - (c.y + .5)) <= FORT_RANGE * 2));
  const pool = lacking.length ? lacking : sorted;
  for (let k = 0; k < 16; k++) {
    const c = pool[(world.rand() * pool.length) | 0];
    const a = world.rand() * 6.283, r = 1.5 + world.rand() * (BUILD_RADIUS - 1.5);
    const x = Math.floor(c.x + .5 + Math.cos(a) * r), y = Math.floor(c.y + .5 + Math.sin(a) * r);
    if (x < 0 || y < 0 || x >= world.w || y >= world.h) continue;
    const t = y * world.w + x;
    if (canBuild(world, p.id, type, t)) return t;
  }
  for (let i = 0; i < world.w * world.h; i++) if (canBuild(world, p.id, type, i)) return i;
  return -1;
}

/** Road budgets, sim-only: world -> player id -> { fund, t }. Never part of the wire state. */
const roadFunds = new WeakMap();

/**
 * The road budget of one AI player: `fund` is the gold its economy has set aside for paving, `t` the
 * last time income was banked. Like the building budget it is a pure function of income and the gold
 * rate - no elapsed-time gate, no randomness, no wire state.
 */
function roadBudget(world, p) {
  let byPlayer = roadFunds.get(world);
  if (!byPlayer) roadFunds.set(world, byPlayer = new Map());
  let e = byPlayer.get(p.id);
  if (!e) byPlayer.set(p.id, e = { fund: 0, t: world.time });
  return e;
}

/**
 * Paving policy, bounded by state and income: a corridor from one of the AI's cities towards a front
 * its supply line cannot properly reach (finite logistics distance past ROAD_NEED_DIST), or between
 * two of its own cities whose direct line runs long. Each project is truncated to ROAD_MAX_NEW fresh
 * tiles so a think can never commit an unbounded spend, and a route with nothing left to pave is
 * skipped instead of re-ordered (placeRoads would only no-op on it).
 * @returns {number} gold the army must leave in the bank for a road the budget already covers but
 *   the purse cannot pay for yet, so recruitment cannot spend the savings before they are used.
 */
function aiRoads(world, p, myCities, budget, reserve, policy = policyOf(world, p)) {
  const dt = Math.max(0, Math.min(world.time - budget.t, 10));
  budget.t = world.time;
  if (!myCities.length) return 0;
  const proj = roadProject(world, p, myCities);
  if (!proj) return 0;

  // Truncate to a bounded amount of fresh paving, then price exactly what would be committed.
  const kept = [];
  let fresh = 0;
  for (const t of proj.tiles) {
    kept.push(t);
    if (!world.roads[t] && ++fresh >= ROAD_MAX_NEW) break;
  }
  const to = tilePoint(world, kept[kept.length - 1]);
  const tiles = roadTiles(world, p.id, [proj.from, to]);
  if (!tiles) return 0;
  let cost = 0;
  for (const t of tiles) if (!world.roads[t]) cost += ROAD_GOLD;
  if (!cost) return 0;
  budget.fund = Math.min(cost, budget.fund + p.goldRate * dt * policy.roadShare);
  if (budget.fund < cost) return 0;             // still saving for the corridor
  if (p.gold < reserve + cost) return cost;     // funded but not yet paid for: hold the purse for it
  const r = placeRoads(world, p.id, [proj.from, to]);
  if (r.ok) budget.fund = Math.max(0, budget.fund - r.cost);
  return 0;
}

/**
 * The corridor a think would pave: the starved front with the longest supply line (a division whose
 * finite logistics distance exceeds ROAD_NEED_DIST), else the farthest pair of the AI's own cities
 * that no road connects. Fronts are deduplicated and examined farthest-first, each candidate is
 * routed at most once, and a corridor that is already fully paved is skipped - paving never repeats
 * a no-op. Returns null when nothing is worth paving.
 */
function roadProject(world, p, myCities) {
  const fronts = [];
  for (const d of world.divs) {
    if (d.owner !== p.id || d.routing || d.routLocked) continue;
    const dist = logisticsDistance(world, d);
    if (Number.isFinite(dist) && dist > ROAD_NEED_DIST) fronts.push({ x: d.x, y: d.y, dist });
  }
  fronts.sort((a, b) => b.dist - a.dist);
  const seen = [];
  let tries = 0;
  for (const f of fronts) {
    if (tries >= ROAD_CANDIDATES) break;
    if (seen.some(s => Math.hypot(s.x - f.x, s.y - f.y) < ROAD_SNAP)) continue;
    seen.push(f);
    const end = ownedTileNear(world, p, f.x, f.y, ROAD_SNAP);
    const city = nearestCity(world, p, f.x, f.y);
    if (end < 0 || !city) continue;
    tries++;
    const proj = corridor(world, p, city, end);
    if (proj && freshOn(world, proj.tiles)) return proj;
  }

  const links = [];
  for (let i = 0; i < myCities.length; i++) {
    for (let j = i + 1; j < myCities.length; j++) {
      const a = myCities[i], b = myCities[j];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > ROAD_NEED_DIST) links.push({ a, b, dist });
    }
  }
  links.sort((a, b) => b.dist - a.dist);
  for (const l of links.slice(0, ROAD_CANDIDATES)) {
    const proj = corridor(world, p, l.a, l.b.idx);
    if (proj && freshOn(world, proj.tiles)) return proj;
  }
  return null;
}

const freshOn = (world, tiles) => tiles.some(t => !world.roads[t]);

/** Route a two-point corridor from a city centre to an owned tile; null when no owned route exists. */
function corridor(world, p, city, tile) {
  const from = [city.x + 0.5, city.y + 0.5];
  const to = tilePoint(world, tile);
  const tiles = roadTiles(world, p.id, [from, to]);
  return tiles ? { from, to, tiles } : null;
}

/** World-coordinate centre of a tile index. */
const tilePoint = (world, tile) => [tile % world.w + 0.5, ((tile / world.w) | 0) + 0.5];

/**
 * Owned, non-water tile closest to (x, y) within maxR tiles, or -1. Snaps a road end from a front
 * division's position onto ground the player actually owns (roads run on owned land only).
 */
function ownedTileNear(world, p, x, y, maxR) {
  const { owner, terr, w, h } = world;
  const x0 = Math.max(0, Math.floor(x - maxR)), x1 = Math.min(w - 1, Math.ceil(x + maxR));
  const y0 = Math.max(0, Math.floor(y - maxR)), y1 = Math.min(h - 1, Math.ceil(y + maxR));
  let best = -1, bd = Infinity;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const i = ty * w + tx;
      if (owner[i] !== p.id || terr[i] === WATER) continue;
      const dd = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
      if (dd < bd || (dd === bd && (best < 0 || i < best))) { bd = dd; best = i; }
    }
  }
  return best;
}
