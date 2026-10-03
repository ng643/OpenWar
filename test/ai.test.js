import { describe, it, expect } from 'vitest';
import { W, H, STEP, TYPES, WATER, LAND, BUILD_RADIUS, BUILD_IDS, ART_RANGE, RANGE, ROUT_FRAC, LOGISTICS_DISTANCE, ROAD_GOLD } from '../src/config.js';
import { createWorld, setOwner, setBuilding } from '../src/sim/world.js';
import { spawnDiv } from '../src/sim/divisions.js';
import { nearOwnCity, canBuild, placeBuildings } from '../src/sim/buildings.js';
import { formationSlots } from '../src/sim/formations.js';
import { findPath } from '../src/sim/pathfinding.js';
import { tick } from '../src/sim/game.js';
import { economy } from '../src/sim/economy.js';
import { logisticsDistance } from '../src/sim/supply.js';
import { aiThink, planAI, aiState, lineDemand, LINE_DEMAND, MAX_LINE_WIDTH, RANK_MAX, ROAD_MAX_NEW, aiCede, CEDE_MAX_TILES } from '../src/sim/ai.js';
import { getAIPolicy, normalizeAIPolicy, BASE_AI_POLICY } from '../src/sim/ai-policy.js';
import { allied } from '../src/sim/teams.js';
import { parseArgs, validateConfig, pickWeakest } from '../scripts/train-ai.js';
import { readFileSync } from 'node:fs';
import { tileOf } from '../src/sim/geom.js';

const mkWorld = (seed = 20250) => createWorld(seed, { humans: [], aiDelay: 1 });
const run = (w, seconds) => { for (let t = 0; t < seconds / STEP && !w.over; t++) tick(w, STEP); };

/** Let one AI's economy run for `seconds` of world time: income accrues and the AI thinks on its
 * normal 1.2 s cadence, but nothing fights or moves. Construction is paid out of this income. */
function grow(w, p, seconds) {
  const end = w.time + seconds;
  while (w.time < end) {
    economy(w, STEP);
    w.time += STEP;
    if (w.time >= p.nextAI) { p.nextAI = w.time + 1.2; aiThink(w, p); }
  }
}

/** Spawn a division that is ready for orders this instant (the per-unit think cooldown is 0). */
function stage(w, owner, x, y, men, type = 'inf', cap = men) {
  const d = spawnDiv(w, owner, x, y, men, cap, type);
  d.nextThink = 0;
  return d;
}

/** Put enabled factions on one team: the fixture seam for team play (roster worlds read teams from
 * settings; this covers the plain default worlds, and keeps team ids positive like a real setup). */
function teamUp(w, ...ids) {
  for (const id of ids) w.players[id - 1].team = ids[0];
}

/** Leave `pid` a single owned land tile whose every land neighbour belongs to `mate`, and return its
 * index: a border that only a team-blind frontier check would call a frontier. */
function boxIn(w, pid, mate) {
  for (let i = 0; i < W * H; i++) if (w.owner[i] === pid) setOwner(w, i, 0);
  for (let i = 0; i < W * H; i++) {
    if (w.terr[i] !== LAND || w.owner[i] !== 0 || w.cityAt[i] >= 0) continue;
    const x = i % W, y = (i / W) | 0;
    const land = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = x + dx, b = y + dy;
      if (a < 0 || b < 0 || a >= W || b >= H) continue;
      if (w.terr[b * W + a] === LAND) land.push(b * W + a);
    }
    if (!land.length) continue;
    for (const j of land) setOwner(w, j, mate);
    setOwner(w, i, pid);
    return i;
  }
  throw new Error('no isolatable tile');
}

/** Neutral land just outside `pid`'s border: a group staged here has a frontier objective in reach. */
function frontGround(w, pid) {
  for (let i = 0; i < W * H; i++) {
    if (w.terr[i] === WATER || w.owner[i] !== 0 || w.cityAt[i] >= 0) continue;
    const x = i % W, y = (i / W) | 0;
    if (x > 0 && w.owner[i - 1] === pid) return { x: x + .5, y: y + .5 };
    if (x < W - 1 && w.owner[i + 1] === pid) return { x: x - .5, y: y + .5 };
    if (y > 0 && w.owner[i - W] === pid) return { x: x + .5, y: y - .5 };
    if (y < H - 1 && w.owner[i + W] === pid) return { x: x + .5, y: y + .5 };
  }
  throw new Error('no frontier land');
}

/** A neutral frontier tile with open ground ahead: `span` clear unowned tiles in one cardinal
 * direction and something of `pid`'s right behind it - where a staged group can be met by an enemy
 * that genuinely stands `span` tiles away (bodies are solid, so spawns snap to free land).
 * Directions are tried in a fixed order, so the same world always yields the same spot. */
function openFront(w, pid, span = 10) {
  for (let i = 0; i < W * H; i++) {
    if (w.terr[i] === WATER || w.owner[i] !== 0 || w.cityAt[i] >= 0) continue;
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const bx = x - dx, by = y - dy;
      if (bx < 0 || by < 0 || bx >= W || by >= H || w.owner[by * W + bx] !== pid) continue;
      let ok = true;
      for (let k = 1; k <= span && ok; k++) {
        const nx = x + dx * k, ny = y + dy * k;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) { ok = false; break; }
        const j = ny * W + nx;
        if (w.terr[j] === WATER || w.owner[j] === pid || w.cityAt[j] >= 0) { ok = false; break; }
        // the tiles the staged group and the enemy stand on must be land too
        if (k <= 2) for (const [px, py] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
          if (nx + px < 0 || ny + py < 0 || nx + px >= W || ny + py >= H ||
              w.terr[(ny + py) * W + (nx + px)] === WATER) ok = false;
      }
      if (ok) return { x: x + .5, y: y + .5, dx, dy };
    }
  }
  throw new Error('no open frontier');
}

/** The nearest non-water tile to (x, y), for staging a second, far-away group. */
function landNear(w, x, y) {
  const cx = Math.round(x), cy = Math.round(y);
  for (let r = 0; r < 60; r++) {
    for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== r) continue;
      if (w.terr[yy * W + xx] !== WATER) return { x: xx + .5, y: yy + .5 };
    }
  }
  throw new Error('no land');
}

/** A point on the map with land outside every city's build radius, for exterior-farm scenarios. */
function exteriorPoint(w) {
  for (let i = 0; i < W * H; i++) {
    if (w.terr[i] === WATER || w.cityAt[i] >= 0) continue;
    const x = i % W, y = (i / W) | 0;
    if (w.cities.every(c => Math.hypot(c.x - x, c.y - y) > BUILD_RADIUS + 3)) return { x, y };
  }
  throw new Error('no exterior land');
}

/** Give `pid` up to `want` unowned, city-free land tiles, growing ring by ring from (cx, cy). */
function claimBlock(w, pid, cx, cy, want) {
  let n = 0;
  for (let r = 0; r <= 45 && n < want; r++) {
    for (let yy = cy - r; yy <= cy + r && n < want; yy++) for (let xx = cx - r; xx <= cx + r && n < want; xx++) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== r) continue;
      const i = yy * W + xx;
      if (w.terr[i] === WATER || w.owner[i] !== 0 || w.cityAt[i] >= 0) continue;
      setOwner(w, i, pid);
      n++;
    }
  }
  return n;
}

/** Every tile owned by `pid` carrying a building of `type` (finished or under construction). */
function builtTiles(w, pid, type) {
  const id = BUILD_IDS.indexOf(type) + 1, out = [];
  for (let i = 0; i < W * H; i++) if (w.bld[i] === id && w.owner[i] === pid) out.push(i);
  return out;
}

/** How many tiles of the map carry a road. */
function roadCount(w) {
  let n = 0;
  for (let i = 0; i < W * H; i++) if (w.roads[i]) n++;
  return n;
}

/** Own a clear-land walk `len` tiles out from a city and return its far end: a real owned supply
 * line, long enough that a division standing at the end of it is genuinely starved. The end is
 * picked so it touches no pre-existing territory of `pid` (no accidental shortcut home). */
function claimSupplyLine(w, pid, cx, cy, len) {
  const start = cy * W + cx;
  const dist = new Int32Array(W * H).fill(-1);
  const prev = new Int32Array(W * H).fill(-1);
  dist[start] = 0;
  const q = [start];
  for (let head = 0; head < q.length; head++) {
    const i = q[head], x = i % W, y = (i / W) | 0;
    if (dist[i] >= len) {
      let touched = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && w.owner[ny * W + nx] === pid) touched = true;
      }
      if (!touched) {
        for (let k = i; k !== start; k = prev[k]) setOwner(w, k, pid);
        return { x: x + .5, y: y + .5 };
      }
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (dist[j] >= 0 || w.terr[j] === WATER || w.cityAt[j] >= 0) continue;
      dist[j] = dist[i] + 1;
      prev[j] = i;
      q.push(j);
    }
  }
  throw new Error('no clear supply line of that length');
}

const mid = pts => ({ x: (pts[0][0] + pts[1][0]) / 2, y: (pts[0][1] + pts[1][1]) / 2 });
const mean = us => ({ x: us.reduce((s, d) => s + d.x, 0) / us.length, y: us.reduce((s, d) => s + d.y, 0) / us.length });

describe('AI strategic state', () => {
  it('is a pure function of troops, land and rivals - never of elapsed time', () => {
    const base = { n: 2, men: 200, landShare: 0.01, frontierShare: 0.5, threat: 0, opponents: 5, leaderShare: 0.1 };
    const demand = st => lineDemand({ ...base, ...st });
    expect(demand({})).toBeLessThan(LINE_DEMAND);                       // small army early: capture
    expect(demand({ n: 8, men: 800 })).toBeGreaterThan(LINE_DEMAND);    // more divisions
    expect(demand({ men: 1000 })).toBeGreaterThan(LINE_DEMAND);         // same count, more men
    expect(demand({ landShare: 0.4 })).toBeGreaterThan(demand({}));     // more land held
    expect(demand({ leaderShare: 0.5 })).toBeGreaterThanOrEqual(LINE_DEMAND);
    expect(demand({ opponents: 2 })).toBeGreaterThanOrEqual(LINE_DEMAND);
    expect(demand({ threat: 400 })).toBeGreaterThanOrEqual(LINE_DEMAND);
    expect(demand({ threat: 4000 })).toBe(demand({ threat: 400 }));     // threat term saturates
    expect(demand({})).toBe(demand({}));                                // no hidden input beyond state
  });

  it('measures the same world identically at any clock reading', () => {
    const w = mkWorld(4711);
    const at = frontGround(w, 1);
    for (let k = 0; k < 5; k++) stage(w, 1, at.x + k * 1.2, at.y, 100, 'inf');
    w.time = 3;
    const early = { state: aiState(w, w.players[0]), plan: planAI(w, w.players[0]) };
    w.time = 600;
    const late = { state: aiState(w, w.players[0]), plan: planAI(w, w.players[0]) };
    expect(late.state).toEqual(early.state);
    expect(late.plan.orders).toEqual(early.plan.orders);
    expect(late.plan.demand).toBe(early.plan.demand);
  });
});

describe('AI battle lines', () => {
  it('scatters a small force to capture land but forms lines with a consolidated army, at the same moment', () => {
    const small = mkWorld(), big = mkWorld();
    const at = frontGround(small, 1);
    for (let k = 0; k < 2; k++) stage(small, 1, at.x + k * 1.2, at.y, 100, 'inf');
    for (let k = 0; k < 8; k++) stage(big, 1, at.x + (k % 4) * 1.2, at.y + ((k / 4) | 0) * 1.2, 100, 'inf');

    const sp = planAI(small, small.players[0]);
    expect(sp.orders).toHaveLength(2);
    expect(sp.orders.every(o => o.k === 'move' && o.ids.length === 1)).toBe(true);
    // capture destinations are real, distinct places near the divisions - not a same-spot parade
    const dests = sp.orders.map(o => [Math.round(o.x - .5), Math.round(o.y - .5)]);
    expect(new Set(dests.map(d => d.join(','))).size).toBe(2);
    for (let k = 0; k < 2; k++) {
      const d = small.divs.find(x => x.id === sp.orders[k].ids[0]);
      expect(Math.hypot(sp.orders[k].x - d.x, sp.orders[k].y - d.y)).toBeGreaterThan(2);
      expect(Math.hypot(sp.orders[k].x - d.x, sp.orders[k].y - d.y)).toBeLessThan(25);
    }

    const bp = planAI(big, big.players[0]);
    expect(bp.demand).toBeGreaterThan(sp.demand);
    const lines = bp.orders.filter(o => o.k === 'formation');
    expect(lines).toHaveLength(1);
    expect(lines[0].ids).toHaveLength(8);
    expect(lines[0].points[0][0]).not.toBe(lines[0].points[1][0]);   // a real line, not a point
  });

  it('groups only nearby divisions and splits a big army into several compact lines', () => {
    const far = mkWorld();
    const a = frontGround(far, 1), b = landNear(far, a.x + 40, a.y);
    for (let k = 0; k < 4; k++) stage(far, 1, a.x + (k % 2) * 1.2, a.y + ((k / 2) | 0) * 1.2, 100, 'inf');
    for (let k = 0; k < 4; k++) stage(far, 1, b.x + (k % 2) * 1.2, b.y + ((k / 2) | 0) * 1.2, 100, 'inf');
    const lines = planAI(far, far.players[0]).orders.filter(o => o.k === 'formation');
    expect(lines).toHaveLength(2);                                    // one front per cluster
    const c0 = mid(lines[0].points), c1 = mid(lines[1].points);
    expect(Math.hypot(c0.x - c1.x, c0.y - c1.y)).toBeGreaterThan(20); // fronts are not one continent-wide line
    expect(Math.min(Math.hypot(c0.x - a.x, c0.y - a.y), Math.hypot(c1.x - a.x, c1.y - a.y))).toBeLessThan(15);
    expect(Math.min(Math.hypot(c0.x - b.x, c0.y - b.y), Math.hypot(c1.x - b.x, c1.y - b.y))).toBeLessThan(15);

    const horde = mkWorld();
    const g0 = frontGround(horde, 1);
    for (let k = 0; k < 20; k++) stage(horde, 1, g0.x + (k % 5) * 1.4, g0.y + ((k / 5) | 0) * 1.4, 100, 'inf');
    const ranks = planAI(horde, horde.players[0]).orders.filter(o => o.k === 'formation');
    expect(ranks.length).toBeGreaterThanOrEqual(3);
    for (const o of ranks) {
      expect(o.ids.length).toBeLessThanOrEqual(RANK_MAX);
      expect(Math.hypot(o.points[1][0] - o.points[0][0], o.points[1][1] - o.points[0][1])).toBeLessThanOrEqual(MAX_LINE_WIDTH + 1e-9);
    }
  });

  it('faces the threat, keeps artillery behind the front inside fire range, and tightens lines under pressure', () => {
    const w = mkWorld(31);
    const o = openFront(w, 1);
    const a = { x: o.x, y: o.y };
    const inf = [];
    for (let k = 0; k < 4; k++) inf.push(stage(w, 1, a.x + (k % 2) * 1.2, a.y + ((k / 2) | 0) * 1.2, 100, 'inf'));
    const arts = [stage(w, 1, a.x + .4, a.y + 1.6, 60, 'art'), stage(w, 1, a.x + 1.6, a.y + 1.6, 60, 'art')];
    const foe = stage(w, 2, a.x + o.dx * 10, a.y + o.dy * 10, 150, 'inf');
    expect(Math.hypot(foe.x - a.x, foe.y - a.y)).toBeGreaterThan(9);      // the enemy really is out there
    const cen = mean([...inf, ...arts]);

    const plan = planAI(w, w.players[0]);
    const front = plan.orders.find(o => o.k === 'formation' && o.ids.length === 4);
    const art = plan.orders.find(o => o.k === 'formation' && o.ids.length === 2);
    expect(front).toBeTruthy();
    expect(art).toBeTruthy();
    expect(art.ids.slice().sort()).toEqual(arts.map(d => d.id).sort());

    const dd = Math.hypot(foe.x - cen.x, foe.y - cen.y);
    const ux = (foe.x - cen.x) / dd, uy = (foe.y - cen.y) / dd;
    const fc = mid(front.points), ac = mid(art.points);
    // the front closes on the threat instead of hovering distant or standing on the group
    expect(Math.hypot(fc.x - foe.x, fc.y - foe.y)).toBeLessThanOrEqual(RANGE + 0.8);
    expect((fc.x - cen.x) * ux + (fc.y - cen.y) * uy).toBeGreaterThan(3);
    // the line is perpendicular to the threat axis
    const lx = front.points[1][0] - front.points[0][0], ly = front.points[1][1] - front.points[0][1];
    const ll = Math.hypot(lx, ly);
    expect(Math.abs((lx * ux + ly * uy) / ll)).toBeLessThan(0.05);
    // artillery is behind the front, within its fire support range of the front and of the enemy
    expect((ac.x - fc.x) * ux + (ac.y - fc.y) * uy).toBeLessThanOrEqual(-1);
    expect(Math.hypot(ac.x - fc.x, ac.y - fc.y)).toBeLessThanOrEqual(ART_RANGE);
    expect(Math.hypot(ac.x - foe.x, ac.y - foe.y)).toBeLessThanOrEqual(ART_RANGE);

    // enemy mass at least our own tightens the lines: fewer divisions per rank, more ranks
    const tight = mkWorld(31);
    const to = openFront(tight, 1);
    const t = { x: to.x, y: to.y };
    for (let k = 0; k < 8; k++) stage(tight, 1, t.x + (k % 4) * 1.2, t.y + ((k / 4) | 0) * 1.2, 100, 'inf');
    const calm = planAI(tight, tight.players[0]).orders.filter(o => o.k === 'formation');
    expect(calm.map(o => o.ids.length)).toEqual([8]);
    stage(tight, 2, t.x + to.dx * 10, t.y + to.dy * 10, 900, 'inf');
    const pressured = planAI(tight, tight.players[0]).orders.filter(o => o.k === 'formation');
    expect(pressured.length).toBeGreaterThan(calm.length);
    expect(Math.max(...pressured.map(o => o.ids.length))).toBeLessThanOrEqual(6);
  });

  it('rolls the line forward as its slots are reached, then holds at melee range', () => {
    const w = mkWorld(88);
    const p = w.players[0];
    const g = frontGround(w, 1);
    const units = [];
    for (let k = 0; k < 6; k++) units.push(stage(w, 1, g.x + (k % 3) * 1.2, g.y + ((k / 3) | 0) * 1.2, 100, 'inf'));
    const foe = stage(w, 2, g.x + 15.9, g.y, 100, 'inf');
    const byId = new Map(units.map(d => [d.id, d]));

    // plan once, then stand the divisions on the slots they were given, as if they had marched there
    const round = () => {
      const line = planAI(w, p).orders.find(o => o.k === 'formation');
      expect(line).toBeTruthy();
      expect(line.ids).toHaveLength(units.length);
      const c = mid(line.points);
      for (const { id, tile, x, y } of formationSlots(w, line.ids.map(id => byId.get(id)), line.points)) {
        if (tile < 0) continue;
        byId.get(id).x = x; byId.get(id).y = y; byId.get(id).path = [];
      }
      return { c, aim: { x: line.aim[0], y: line.aim[1] } };
    };

    const a = round();
    expect(a.aim.x).toBeCloseTo(foe.x, 6);                       // the objective is the enemy mass itself
    expect(a.aim.y).toBeCloseTo(foe.y, 6);
    const dd = Math.hypot(a.aim.x - a.c.x, a.aim.y - a.c.y);
    const ux = (a.aim.x - a.c.x) / dd, uy = (a.aim.y - a.c.y) / dd;
    const b = round();
    expect((b.c.x - a.c.x) * ux + (b.c.y - a.c.y) * uy).toBeGreaterThan(3);   // the front rolls forward
    expect(Math.hypot(b.c.x - a.aim.x, b.c.y - a.aim.y)).toBeLessThan(dd);    // towards its objective
    const c = round();
    expect(Math.hypot(c.c.x - foe.x, c.c.y - foe.y)).toBeLessThanOrEqual(RANGE + 0.8);  // closed to melee
    const d = round();
    expect(Math.hypot(d.c.x - c.c.x, d.c.y - c.c.y)).toBeLessThan(1);         // and holds: it does not walk through
  });

  it('marches on the enemy front rank, not the centre of a deep enemy mass', () => {
    const w = mkWorld(88);
    const p = w.players[0];
    const o = openFront(w, 1, 17);
    const units = [stage(w, 1, o.x, o.y, 100, 'inf'), stage(w, 1, o.x + 1.2, o.y, 100, 'inf')];
    // A screen in front of a heavier mass well behind it: the men-weighted centre of the five enemy
    // divisions sits ~7 tiles behind its own front rank. Aiming there parks the line in open ground
    // out of melee range, which freezes a war - so the front rank itself is the objective.
    const at = (k, owner) => stage(w, owner, o.x + o.dx * k, o.y + o.dy * k, 100, 'inf');
    const screen = at(6, 2);
    for (let k = 0; k < 4; k++) at(14 + k * 0.5, 2);
    const byId = new Map(units.map(d => [d.id, d]));

    const round = () => {
      const line = planAI(w, p).orders.find(ord => ord.k === 'formation');
      expect(line).toBeTruthy();
      expect(line.ids).toHaveLength(2);
      for (const { id, tile, x, y } of formationSlots(w, line.ids.map(id => byId.get(id)), line.points)) {
        if (tile < 0) continue;
        byId.get(id).x = x; byId.get(id).y = y; byId.get(id).path = [];
      }
      return { c: mid(line.points), aim: { x: line.aim[0], y: line.aim[1] } };
    };

    const a = round();
    expect(a.aim.x).toBeCloseTo(screen.x, 6);         // the nearest enemy body is what it marches on
    expect(a.aim.y).toBeCloseTo(screen.y, 6);
    expect(Math.hypot(a.c.x - screen.x, a.c.y - screen.y)).toBeLessThanOrEqual(RANGE);
    const b = round();
    expect(Math.hypot(b.c.x - screen.x, b.c.y - screen.y)).toBeLessThanOrEqual(RANGE);
    expect(Math.hypot(b.c.x - a.c.x, b.c.y - a.c.y)).toBeLessThan(1);   // closes and holds, no walk-through
  });
});

describe('AI orders and discipline', () => {
  it('leaves routing and cornered divisions to the sim and keeps wounded units out of the groups', () => {
    const w = mkWorld(97);
    const p = w.players[0];
    const g = frontGround(w, 1);
    const healthy = [stage(w, 1, g.x, g.y, 100, 'inf'), stage(w, 1, g.x + 1.2, g.y, 100, 'inf')];
    const far = landNear(w, g.x + 14, g.y);
    // A routing division: the sim owns its flee state, its path and the intended order it will resume,
    // so the AI must not re-order it or touch the saved route (issueMove would queue into it).
    const flee = stage(w, 1, far.x, far.y, 100, 'inf');
    flee.routing = true;
    flee.path = [];
    const resume = { routePoints: [[far.x + 5, far.y + 5]], column: false, aiGoal: 7 };
    flee.routeResume = resume;
    // A cornered division (routLocked) fights until death: it is committed and never pulled out.
    const cornered = stage(w, 1, far.x + 1.2, far.y, 100, 'inf');
    cornered.routLocked = true;
    cornered.path = [tileOf(w, cornered) + 1, tileOf(w, cornered) + 2];
    const corneredPath = cornered.path.slice();
    // Wounded below the routing threshold but not routing (no combat damage this tick): it holds its
    // ground to be reinforced and never joins a group.
    const marooned = stage(w, 1, far.x + 2.4, far.y, 20, 'inf', 100);
    const busy = stage(w, 1, g.x + 2.4, g.y, 100, 'inf');
    busy.eng = true;
    busy.path = [tileOf(w, busy) + 1, tileOf(w, busy) + 2];
    const busyKeep = busy.path.slice();

    const plan = planAI(w, p);
    const ids = plan.orders.flatMap(o => o.ids);
    expect(ids).not.toContain(flee.id);                          // never re-ordered mid-rout
    expect(ids).not.toContain(cornered.id);                      // cornered: committed to the fight
    expect(ids).not.toContain(marooned.id);                      // wounded troops never join a group
    expect(ids).not.toContain(busy.id);                          // fighting divisions stay untouched
    expect(ids).toContain(healthy[0].id);                        // free healthy troops still get orders

    aiThink(w, p);
    expect(flee.path).toEqual([]);                               // the flee route was not overwritten
    expect(flee.routeResume).toEqual(resume);                    // nor the intended order it will resume
    expect(cornered.path).toEqual(corneredPath);                 // the cornered unit keeps its path
    expect(busy.path).toEqual(busyKeep);                          // combat still pins a normal division
    expect(busy.aiGoal).toBe(null);
  });

  it('counts wounded divisions by the shared routing threshold', () => {
    const w = mkWorld(3);
    const p = w.players[0];
    const a = landNear(w, 30, 30), b = landNear(w, 36, 36);
    stage(w, 1, a.x, a.y, ROUT_FRAC * 100, 'inf', 100);              // exactly at the line: still sound
    stage(w, 1, b.x, b.y, ROUT_FRAC * 100 - 1, 'inf', 100);          // a touch below: wounded
    expect(aiState(w, p).hurt).toBe(1);
  });

  it('lets a division between route legs walk out its checkpoints instead of re-ordering it', () => {
    const w = mkWorld(31);
    const p = w.players[0];
    const g = frontGround(w, 1);
    const d = stage(w, 1, g.x, g.y, 100, 'inf');
    // Two checkpoints the sim can actually walk to, with the leg underfoot already walked out: the AI
    // must read this as a busy division, not an idle one - a fresh capture order would wipe the route
    // before it resumes.
    const points = [];
    for (const off of [4, 6, 8, 10, 12]) {
      const q = landNear(w, g.x + off, g.y + off);
      const t = (q.y | 0) * W + (q.x | 0);
      if (t !== tileOf(w, d) && findPath(w, tileOf(w, d), t)) points.push([q.x, q.y]);
      if (points.length === 2) break;
    }
    expect(points).toHaveLength(2);
    d.path = [];
    d.routePoints = points;
    expect(planAI(w, p).orders.flatMap(o => o.ids)).not.toContain(d.id);

    // The sim starts the next leg on the following movement tick and walks it to the last checkpoint.
    const b = points[points.length - 1];
    for (let t = 0; t < 900 && d.routePoints.length; t++) tick(w, STEP);
    expect(d.routePoints).toHaveLength(0);               // the route was resumed and walked out
    expect(Math.hypot(d.x - b[0], d.y - b[1])).toBeLessThan(1);
  });

  it('walks a displaced holder back to its spot instead of handing it a new order', () => {
    const w = mkWorld(41);
    const p = w.players[0];
    const g = frontGround(w, 1);
    const d = stage(w, 1, g.x, g.y, 100, 'inf');
    // A spot a straight slide away - the way home is walked without pathfinding - with no water
    // between: the sim holds the exact ground the division was displaced from and walks it back.
    const cx = d.x | 0, cy = d.y | 0;
    let home = null;
    for (const len of [2, 3]) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = cx + dx * len, y = cy + dy * len;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        let clear = true;
        for (let k = 1; k <= len && clear; k++) {
          const tx = cx + dx * k, ty = cy + dy * k;
          if (w.terr[ty * W + tx] === WATER) clear = false;
          if (w.divs.some(o => o !== d && (o.x | 0) === tx && (o.y | 0) === ty)) clear = false;
        }
        if (clear) { home = { x: x + .5, y: y + .5 }; break; }
      }
      if (home) break;
    }
    expect(home).not.toBe(null);
    d.path = [];
    d.routePoints = [];
    d.anchor = { x: home.x, y: home.y };
    expect(planAI(w, p).orders.flatMap(o => o.ids)).not.toContain(d.id);

    for (let t = 0; t < 200 && d.anchor; t++) tick(w, STEP);
    expect(d.anchor).toBe(null);                         // the return ran to completion
    expect(d.x).toBeCloseTo(home.x, 6);                  // and ended on the exact spot it came from
    expect(d.y).toBeCloseTo(home.y, 6);
  });

  it('does not re-plan divisions that are already marching, and resumes them after combat', () => {
    const w = mkWorld(1234);
    const p = w.players[0];
    const g = frontGround(w, 1);
    const units = [];
    for (let k = 0; k < 4; k++) units.push(stage(w, 1, g.x + (k % 2) * 1.2, g.y + ((k / 2) | 0) * 1.2, 100, 'inf'));
    aiThink(w, p);
    const paths = units.map(d => d.path.slice());
    expect(paths.every(path => path.length > 0)).toBe(true);
    for (let k = 0; k < 3; k++) aiThink(w, p);                          // more think passes, same instant
    units.forEach((d, i) => expect(d.path).toEqual(paths[i]));

    // an engaged division is left idle; once the enemy is gone the AI orders it again
    const stuck = units[0];
    // the enemy must land inside melee range on free ground (solid bodies snap a spawn to clear land)
    let foe = null;
    for (const [ox, oy] of [[1.2, 0], [0, 1.2], [-1.2, 0], [0, -1.2], [1.2, 1.2], [-1.2, 1.2], [1.2, -1.2], [-1.2, -1.2]]) {
      const at = landNear(w, stuck.x + ox, stuck.y + oy);
      const f = spawnDiv(w, 2, at.x, at.y, 100, 100, 'inf');
      if (!f) continue;
      if (Math.hypot(f.x - stuck.x, f.y - stuck.y) <= RANGE) { foe = f; break; }
      w.divs = w.divs.filter(d => d !== f);
    }
    expect(foe).toBeTruthy();                                            // a real enemy stands in melee range
    stuck.path = [];
    stuck.nextThink = 0;
    run(w, 1.05);
    expect(stuck.eng).toBe(true);                                        // combat has it pinned
    expect(stuck.path).toHaveLength(0);                                  // and its order was not replaced
    const held = { x: stuck.x, y: stuck.y };
    run(w, 0.5);
    expect(stuck.x).toBeCloseTo(held.x, 6);
    expect(stuck.y).toBeCloseTo(held.y, 6);
    w.divs = w.divs.filter(d => d !== foe);                              // the enemy dies
    run(w, 2);
    expect(stuck.path.length + (Math.hypot(stuck.x - held.x, stuck.y - held.y) > 0.5 ? 1 : 0)).toBeGreaterThan(0);
    expect(stuck.aiGoal).not.toBe(null);
  });

  it('keeps an AI-only game deterministic and keeps building an army and an economy', () => {
    const a = mkWorld(9091), b = mkWorld(9091);
    run(a, 150); run(b, 150);
    const snap = w => w.players.map(p => `${p.tiles}:${p.cities}:${p.built.farm}:${p.built.factory}:${p.built.fortress}:${p.gold | 0}:${w.divs.filter(d => d.owner === p.id).length}`).join(',') + `|roads:${roadCount(w)}`;
    expect(snap(a)).toBe(snap(b));
    expect(a.divs.length).toBeGreaterThan(0);
    expect(a.players.some(p => p.built.farm > 0)).toBe(true);            // exterior farms appeared
    expect(a.players.some(p => p.tiles > 40)).toBe(true);                // and land was taken
  });
});

describe('AI teams', () => {
  it('counts a teammate neither as a threat nor as a rival, while a true enemy stays both', () => {
    const w = mkWorld(6101);
    const p = w.players[0];
    const at = frontGround(w, 1);
    const mine = stage(w, 1, at.x, at.y, 100, 'inf');
    const ally = stage(w, 2, at.x + 4, at.y, 300, 'inf');
    const foe = stage(w, 3, at.x, at.y + 4, 300, 'inf');
    const far = d => Math.hypot(d.x - mine.x, d.y - mine.y);
    expect(Math.max(far(ally), far(foe))).toBeLessThanOrEqual(16);   // both armies stand in the threat radius
    expect(allied(w, 1, 2)).toBe(false);                             // FFA: no teammates anywhere
    expect(aiState(w, p).threat).toBe(600);                          // in FFA both armies count
    expect(aiState(w, p).opponents).toBe(5);

    teamUp(w, 1, 2);
    expect(allied(w, 1, 2)).toBe(true);
    expect(aiState(w, p).threat).toBe(300);                          // the teammate's 300 men are not a threat
    expect(aiState(w, p).opponents).toBe(4);                         // and its player is not a rival
  });

  it('measures the leading side by the land its whole side holds, not by single players', () => {
    const w = mkWorld(6201);
    const p = w.players[0];
    const at = frontGround(w, 1);
    const spots = [[at.x + 20, at.y], [at.x, at.y + 18], [Math.max(6, at.x - 20), at.y]];
    for (let k = 0; k < 3; k++) claimBlock(w, k + 2, Math.round(spots[k][0]), Math.round(spots[k][1]), 40);
    const land = w.landCount;
    const solo = Math.max(...w.players.slice(1, 6).map(q => q.tiles / land));
    expect(aiState(w, p).leaderShare).toBeCloseTo(solo, 12);         // FFA: the strongest single rival
    expect(aiState(w, p).opponents).toBe(5);                         // and five separate rivals

    teamUp(w, 2, 3, 4);                                              // three rivals now fight as one side
    const side = (w.players[1].tiles + w.players[2].tiles + w.players[3].tiles) / land;
    expect(side).toBeGreaterThan(solo);
    const st = aiState(w, p);
    expect(st.leaderShare).toBeCloseTo(side, 12);                    // their land counts as one side's
    expect(st.opponents).toBe(5);                                    // rivals are still counted per player
  });

  it('marches on the true enemy even when the teammate stands closer', () => {
    const w = mkWorld(6102);
    const p = w.players[0];
    teamUp(w, 1, 2);
    const at = frontGround(w, 1);
    for (let k = 0; k < 4; k++) stage(w, 1, at.x + (k % 2) * 1.2, at.y + ((k / 2) | 0) * 1.2, 100, 'inf');
    const allyAt = landNear(w, at.x, at.y - 4), foeAt = landNear(w, at.x + 6, at.y);
    const ally = stage(w, 2, allyAt.x, allyAt.y, 300, 'inf');
    const foe = stage(w, 3, foeAt.x, foeAt.y, 150, 'inf');
    const cen = mean(w.divs.filter(d => d.owner === 1));
    const allyD = Math.hypot(ally.x - cen.x, ally.y - cen.y);
    const foeD = Math.hypot(foe.x - cen.x, foe.y - cen.y);
    expect(allyD).toBeLessThan(foeD);                                // the teammate really is the nearer army
    expect(foeD).toBeLessThan(16);                                   // and the enemy is still in sight

    const plan = planAI(w, p);
    const line = plan.orders.find(o => o.k === 'formation');
    expect(line).toBeTruthy();
    expect(Math.hypot(line.aim[0] - foe.x, line.aim[1] - foe.y)).toBeLessThan(1);      // aimed at the enemy front
    expect(Math.hypot(line.aim[0] - ally.x, line.aim[1] - ally.y)).toBeGreaterThan(4);  // never at the teammate
  });

  it('never marches on the teammate capital next door: the enemy city beyond it is the objective', () => {
    const w = createWorld(7321, { settings: { mapSize: 'standard', factions: [1, 2, 3] }, humans: [], aiDelay: 1 });
    const p = w.players[0];
    teamUp(w, 1, 2);
    const cap2 = w.cities.find(c => c.owner === 2 && c.capital);
    const cap3 = w.cities.find(c => c.owner === 3 && c.capital);
    setOwner(w, cap3.idx, 0);          // strip the second enemy capital so the enemy has one city left
    const spot = landNear(w, cap2.x - 4, cap2.y);
    let near = null, nd = Infinity;    // the nearest neutral city becomes the one city worth marching on
    for (const c of w.cities) {
      if (c.owner !== 0 || c.idx === cap3.idx) continue;
      const dd = Math.hypot(c.x + .5 - spot.x, c.y + .5 - spot.y);
      if (dd < nd && dd < 60) { nd = dd; near = c; }
    }
    expect(near).toBeTruthy();
    setOwner(w, near.idx, 3);
    const own = [stage(w, 1, spot.x - 1, spot.y - .5, 100, 'inf'), stage(w, 1, spot.x + 1, spot.y + .5, 100, 'inf')];
    const cen = mean(own);
    expect(Math.hypot(cen.x - (cap2.x + .5), cen.y - (cap2.y + .5))).toBeLessThan(8);   // the ally capital is right there

    const plan = planAI(w, p);
    const line = plan.orders.find(o => o.k === 'formation');
    expect(line).toBeTruthy();
    const tile = Math.floor(line.aim[1]) * W + Math.floor(line.aim[0]);
    expect(tile).toBe(near.idx);                                     // the objective is the enemy city
    expect(w.owner[tile]).toBe(3);
    expect(w.cityAt[tile]).toBeGreaterThanOrEqual(0);
    expect(allied(w, p.id, 2)).toBe(true);
  });

  it('crosses a teammate block to capture real ground instead of taking the land underfoot', () => {
    const w = mkWorld(8181);
    const p = w.players[0];
    teamUp(w, 1, 2);
    const at = frontGround(w, 1);
    expect(claimBlock(w, 2, Math.round(at.x), Math.round(at.y), 60)).toBeGreaterThan(25);
    const d = stage(w, 1, at.x, at.y, 100, 'inf');
    expect(allied(w, 1, w.owner[((d.y | 0) * W) + (d.x | 0)])).toBe(true);   // standing on a teammate's land
    p.aiPolicy = normalizeAIPolicy({ lineDemand: 4 });                       // scatter to capture, not line up

    const plan = planAI(w, p);
    const moves = plan.orders.filter(o => o.k === 'move' && o.goal === 'capture');
    expect(moves.length).toBeGreaterThan(0);                                 // it still finds ground to take
    for (const o of moves) {
      const owner = w.owner[Math.floor(o.y) * W + Math.floor(o.x)];
      expect(allied(w, 1, owner)).toBe(false);                               // never ordered onto an ally's tile
    }
  });

  it('drives high-numbered roster bots with the same frozen profile and a normal game plan', () => {
    const w = createWorld(4242, {
      settings: {
        mapSize: 'standard', teams: [1, 1, 2, 2, 3, 3, 4, 4], teamCount: 4,
        factions: [1, 2, 3, 4, 5, 6, 7, 8], bots: [7, 8]
      },
      humans: [], aiDelay: 1
    });
    const on = w.players.filter(q => q.enabled);
    expect(on.map(q => q.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const q of on) {                                     // every seat, high ids included, shares the frozen profile
      expect(Object.isFrozen(q.aiPolicy)).toBe(true);
      expect(q.aiPolicy).toBe(getAIPolicy(w.settings.aiDifficulty));
    }
    const p7 = w.players[6], p8 = w.players[7];
    expect(p7.bot).toBe(true);
    expect(p8.bot).toBe(true);
    expect(allied(w, 7, 8)).toBe(true);                       // canonical teams, straight out of the settings
    expect(allied(w, 7, 1)).toBe(false);

    const cap7 = w.cities.find(c => c.owner === 7 && c.capital);
    expect(cap7).toBeTruthy();
    expect(claimBlock(w, 7, cap7.x + 5, cap7.y + 5, 80)).toBeGreaterThan(20);
    const at = frontGround(w, 7);
    for (let k = 0; k < 3; k++) stage(w, 7, at.x + k * 1.2, at.y, 100, 'inf');
    p7.gold = 1e5; p7.pool = 1e5;
    for (let i = 0; i < 40; i++) aiThink(w, p7);
    const mine = w.divs.filter(x => x.owner === 7);
    expect(mine.length).toBeGreaterThan(3);                   // it raised troops out of its own purse
    expect(mine.some(x => x.path.length || x.routePoints.length || x.anchor)).toBe(true);  // and gave them ground
    expect(p7.aiPolicy).toBe(getAIPolicy(w.settings.aiDifficulty));          // never swapped per think

    p7.gold = 0; p7.pool = 1e5;                               // economy only: no free forts, only its income
    grow(w, p7, 240);
    expect(builtTiles(w, 7, 'fortress').length).toBeGreaterThan(0);
  });

  it('keeps a twelve-bot, two-team roster off its teammates while every bot still plays', () => {
    const w = createWorld(2026, {
      settings: {
        mapSize: 'standard', teamCount: 2, teams: [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2],
        factions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
      },
      humans: [], aiDelay: 1
    });
    const on = w.players.filter(q => q.enabled);
    expect(on.length).toBe(12);
    expect(allied(w, 1, 6)).toBe(true);
    expect(allied(w, 7, 12)).toBe(true);
    expect(allied(w, 1, 12)).toBe(false);

    let captures = 0;
    for (const q of on) {
      const cap = w.cities.find(c => c.owner === q.id && c.capital);
      expect(cap).toBeTruthy();
      const sx = Math.min(W - 3, cap.x + 3), sy = Math.min(H - 3, cap.y + 3);
      for (let k = 0; k < 2; k++) stage(w, q.id, sx + k, sy, 100, 'inf');
      const orders = planAI(w, q).orders;
      expect(orders.length).toBeGreaterThan(0);               // every bot on the roster still commands troops
      for (const o of orders) {
        if (o.k !== 'move') continue;
        if (o.goal === 'capture') captures++;
        const owner = w.owner[Math.floor(o.y) * W + Math.floor(o.x)];
        expect(allied(w, q.id, owner)).toBe(false);           // no order ever lands on a teammate's tile
      }
    }
    expect(captures).toBeGreaterThan(0);                      // and the teams still take ground
  });

  it('treats a teammate border as no frontier at all', () => {
    const w = mkWorld(909);
    const p = w.players[0];
    teamUp(w, 1, 2);
    const t = boxIn(w, 1, 2);                                 // p1's only land borders p2 on every side
    expect(t).toBeGreaterThanOrEqual(0);
    expect(w.owner[t]).toBe(1);
    expect(aiState(w, p).frontierTiles).toEqual([]);          // teammate land is not ground to expand into
    expect(aiState(w, p).frontierShare).toBe(0);
  });

  it('gives a division boxed in by its teammate no capture order onto its land', () => {
    const w = mkWorld(910);
    const p = w.players[0];
    teamUp(w, 1, 2);
    for (let i = 0; i < W * H; i++) if (w.owner[i] === 1) setOwner(w, i, 0);
    let t = -1;
    for (let i = 0; i < W * H; i++) {                         // p1 holds exactly one tile ...
      if (w.terr[i] !== LAND || w.owner[i] !== 0 || w.cityAt[i] >= 0) continue;
      t = i; break;
    }
    expect(t).toBeGreaterThanOrEqual(0);
    const tx = t % W, ty = (t / W) | 0;
    for (let y = Math.max(0, ty - 20); y <= Math.min(H - 1, ty + 20); y++) {
      for (let x = Math.max(0, tx - 20); x <= Math.min(W - 1, tx + 20); x++) {
        const j = y * W + x;
        if (j === t || w.terr[j] !== LAND || w.owner[j] === 1) continue;
        setOwner(w, j, 2);                                    // ... wrapped in a teammate block deeper than capture range
      }
    }
    setOwner(w, t, 1);
    stage(w, 1, tx + .5, ty + .5, 100, 'inf');
    p.aiPolicy = normalizeAIPolicy({ lineDemand: 4 });        // scatter: capture would outrank a line

    const plan = planAI(w, p);
    const moves = plan.orders.filter(o => o.k === 'move' && o.goal === 'capture');
    expect(moves).toEqual([]);                                // in reach there is nothing but the teammate's land
  });
});

describe('AI construction policy', () => {
  it('puts farms only on owned land outside every city zone, and builds the city-zone buildings too', () => {
    const w = mkWorld(31337);
    const p = w.players[0];
    setOwner(w, w.cities.find(c => c.capital && c.owner === 2).idx, 1);   // a second reserved city zone
    const ext = exteriorPoint(w);
    expect(claimBlock(w, 1, ext.x, ext.y, 400)).toBeGreaterThan(200);     // exterior land to farm
    p.gold = 900; p.pool = 0;
    grow(w, p, 240);                                                     // construction is paid from income

    const farms = builtTiles(w, 1, 'farm');
    expect(farms.length).toBeGreaterThanOrEqual(5);
    for (const t of farms) {
      const x = t % W, y = (t / W) | 0;
      expect(w.terr[t]).toBe(LAND);
      expect(w.owner[t]).toBe(1);
      expect(w.cityAt[t]).toBeLessThan(0);
      for (const c of w.cities)                                          // every city zone stays clear
        expect(Math.hypot(c.x - x, c.y - y)).toBeGreaterThan(BUILD_RADIUS);
    }
    expect(p.built.factory).toBe(2);                                     // starter plus one more city
    expect(p.built.fortress).toBe(1);
    for (const type of ['factory', 'fortress'])
      for (const t of builtTiles(w, 1, type))
        expect(w.cities.some(c => c.owner === 1 && Math.hypot(c.x - (t % W), c.y - ((t / W) | 0)) <= BUILD_RADIUS)).toBe(true);

    // farm quota saturated: the budget still buys what the cities need
    for (const c of w.cities) if (!c.capital && c.owner === 0 && p.cities < 6) setOwner(w, c.idx, 1);
    p.built.farm = 9999; p.gold = 900;
    const factories = p.built.factory, forts = p.built.fortress;
    grow(w, p, 180);
    expect(p.built.factory).toBeGreaterThan(factories);
    expect(p.built.fortress).toBeGreaterThan(forts);
    expect(p.built.farm).toBe(9999);                                     // a saturated quota is never crossed
  });

  it('never farms inside another city zone, even when that tile is legal to build on', () => {
    const w = mkWorld(6060);
    const p = w.players[0];
    // Hand back every tile the AI holds outside its own city zones, so the only Farm sites left are
    // the two this test plants: a legal plain tile inside a neutral city's zone, ringed with owned
    // ground (the best-scoring site on the map), and one legal plain tile far from every city.
    for (let i = 0; i < W * H; i++) if (w.owner[i] === 1 && !nearOwnCity(w, 1, i)) setOwner(w, i, 0);

    let reserved = -1, around = null;
    for (let i = 0; i < W * H && reserved < 0; i++) {
      if (w.terr[i] !== LAND || w.owner[i] !== 0 || w.cityAt[i] >= 0 || w.bld[i] !== 0) continue;
      if (nearOwnCity(w, 1, i)) continue;                                // outside the AI's own zones
      const x = i % W, y = (i / W) | 0;
      if (!w.cities.some(c => c.owner === 0 && Math.hypot(c.x - x, c.y - y) <= BUILD_RADIUS)) continue;
      const sides = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
        .filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H &&
                            w.terr[b * W + a] === LAND && w.cityAt[b * W + a] < 0);
      if (sides.length >= 3) { reserved = i; around = sides; }
    }
    expect(reserved).toBeGreaterThan(-1);
    let exterior = -1;
    for (let i = 0; i < W * H && exterior < 0; i++) {
      if (w.terr[i] !== LAND || w.owner[i] !== 0 || w.cityAt[i] >= 0 || w.bld[i] !== 0) continue;
      const x = i % W, y = (i / W) | 0;
      if (w.cities.every(c => Math.hypot(c.x - x, c.y - y) > BUILD_RADIUS + 3)) exterior = i;
    }
    expect(exterior).toBeGreaterThan(-1);

    setOwner(w, reserved, 1);
    for (const [a, b] of around) setOwner(w, b * W + a, 1);
    setOwner(w, exterior, 1);
    expect(canBuild(w, 1, 'farm', reserved)).toBe(true);                 // the game would allow a Farm here
    p.gold = 900; p.pool = 0;
    grow(w, p, 480);

    expect(builtTiles(w, 1, 'farm')).toEqual([exterior]);                // the one legal site was used
    expect(w.bld[reserved]).toBe(0);                                     // the reserved tile stayed empty
  });

  it('never falls back to a farm inside a city zone: an impossible farm does not block factories or forts', () => {
    const w = mkWorld(4242);
    const p = w.players[0];
    setOwner(w, w.cities.find(c => c.capital && c.owner === 2).idx, 1);
    for (let i = 0; i < W * H; i++) if (w.owner[i] === 1 && !nearOwnCity(w, 1, i)) setOwner(w, i, 0);
    p.gold = 1000; p.pool = 0;

    grow(w, p, 200);
    expect(p.built.farm).toBe(0);                                        // no in-zone fallback, no farm at all
    expect(builtTiles(w, 1, 'farm')).toHaveLength(0);
    expect(p.built.factory).toBe(2);                                     // factory and fortress still went up
    expect(p.built.fortress).toBe(1);
    for (const type of ['factory', 'fortress'])
      for (const t of builtTiles(w, 1, type))
        expect(w.cities.some(c => c.owner === 1 && Math.hypot(c.x - (t % W), c.y - ((t / W) | 0)) <= BUILD_RADIUS)).toBe(true);
  });

  it('never spends the gold the army needs', () => {
    const w = mkWorld(515);
    const p = w.players[0];
    const ext = exteriorPoint(w);
    claimBlock(w, 1, ext.x, ext.y, 200);
    p.gold = 600; p.pool = 250;
    grow(w, p, 120);
    expect(w.divs.some(d => d.owner === 1)).toBe(true);                  // construction did not stop recruitment
    expect(builtTiles(w, 1, 'farm').length).toBeGreaterThan(0);          // and farms got funded all the same

    // army at its division cap: building is the only sink left and it must stop at the war chest
    const cap = 3 + Math.floor(p.tiles / 22);
    const mine = w.divs.filter(d => d.owner === 1);
    for (let k = mine.length; k < cap; k++) stage(w, 1, ext.x, ext.y, 100, 'inf');
    p.pool = TYPES.arm.manpower; p.gold = 350; p.built.farm = 0;
    const before = builtTiles(w, 1, 'farm').length;
    grow(w, p, 60);
    expect(p.gold).toBeGreaterThanOrEqual(TYPES.arm.gold);               // a heavy unit stays affordable
    expect(builtTiles(w, 1, 'farm').length).toBeGreaterThan(before);     // money was still invested
  });
});

describe('AI roads', () => {
  it('pays for a bounded road towards a starved front, and the cost comes out of its own purse', () => {
    const w = mkWorld(7777);
    const p = w.players[0];
    const city = w.cities.find(c => c.owner === 1 && c.capital);
    const end = claimSupplyLine(w, 1, city.x, city.y, 30);   // a long but real supply line home
    const front = stage(w, 1, end.x, end.y, 100, 'inf');
    expect(logisticsDistance(w, front)).toBeGreaterThan(LOGISTICS_DISTANCE);   // the front really is starved

    p.active.factory = 5;                        // road-worthy income without waiting on construction
    p.pool = 0;                                  // no recruits, no reinforcement: only paving can move gold
    p.built.farm = 9999; p.built.factory = 9999; p.built.fortress = 9999;   // and no building may spend either

    let placed = 0, spent = 0;
    const until = w.time + 90;
    while (w.time < until && !placed) {
      economy(w, STEP);
      w.time += STEP;
      if (w.time < p.nextAI) continue;
      p.nextAI = w.time + 1.2;
      const gold = p.gold, roads = roadCount(w);
      aiThink(w, p);
      const fresh = roadCount(w) - roads;
      if (fresh) { placed = fresh; spent = gold - p.gold; }
    }

    expect(placed).toBeGreaterThan(0);                   // the AI actually paved, on its own initiative
    expect(spent).toBe(placed * ROAD_GOLD);              // and paid for it: gold left the purse, none was minted
    expect(placed).toBeLessThanOrEqual(ROAD_MAX_NEW);    // bounded spend per project
    for (let i = 0; i < W * H; i++) {
      if (!w.roads[i]) continue;
      expect(w.terr[i]).toBe(LAND);
      expect(w.owner[i]).toBe(1);                        // roads run on the owner's own ground only
    }
    // the paving reached towards the starved front instead of some arbitrary corner of the realm
    let closest = Infinity;
    for (let i = 0; i < W * H; i++) if (w.roads[i])
      closest = Math.min(closest, Math.hypot((i % W) + .5 - end.x, ((i / W) | 0) + .5 - end.y));
    expect(closest).toBeLessThanOrEqual(2);

    // and the road purse never starves recruitment: reserves restored, troops still get raised
    const before = w.divs.filter(d => d.owner === 1).length;
    p.pool = 400; p.gold = 300;
    grow(w, p, 20);
    expect(w.divs.filter(d => d.owner === 1).length).toBeGreaterThan(before);
  });

  it('never paves when no front is starved and there is only one city to link', () => {
    const w = mkWorld(2468);
    const p = w.players[0];
    p.gold = 900;                                        // able to pay: the policy, not the purse, is on trial
    grow(w, p, 120);
    expect(roadCount(w)).toBe(0);                        // nothing worth a road: no pointless, no-op paving
    expect(w.divs.some(d => d.owner === 1)).toBe(true);   // while the army and the economy still ran
  });
});

describe('AI difficulty policies', () => {
  it('normalizes the eight knobs into their bounds and repairs the coupled sums', () => {
    const p = normalizeAIPolicy({
      recruitTiles: 100, infantryShare: 0.99, armorShare: 0.9, buildShare: 0.9, roadShare: 0.9,
      lineDemand: 99, advance: -5, captureRange: 9, sneaky: 1
    });
    expect(p.recruitTiles).toBe(40);
    expect(p.infantryShare).toBe(0.85);
    expect(p.armorShare).toBeCloseTo(0.1, 9);            // armour takes only what infantry leaves it
    expect(p.infantryShare + p.armorShare).toBeLessThanOrEqual(0.95 + 1e-9);
    expect(p.buildShare).toBe(0.7);
    expect(p.roadShare).toBeCloseTo(0.15, 9);            // and roads only what buildings leave them
    expect(p.buildShare + p.roadShare).toBeLessThanOrEqual(0.85 + 1e-9);
    expect(p.lineDemand).toBe(4);
    expect(p.advance).toBe(4);
    expect(p.captureRange).toBe(1.6);
    expect('sneaky' in p).toBe(false);                   // unknown fields are dropped, never carried through
    expect(Object.isFrozen(p)).toBe(true);

    expect(normalizeAIPolicy({})).toEqual(BASE_AI_POLICY);              // missing fields fall back
    expect(normalizeAIPolicy(null)).toEqual(BASE_AI_POLICY);
    expect(normalizeAIPolicy({ recruitTiles: NaN, advance: Infinity })).toEqual(BASE_AI_POLICY);
    expect(() => normalizeAIPolicy([1])).toThrow('Invalid AI policy');
  });

  it('deploys one frozen policy per difficulty, medium being the untouched baseline', () => {
    const easy = getAIPolicy('easy'), medium = getAIPolicy('medium'), hard = getAIPolicy('hard');
    for (const p of [easy, medium, hard]) expect(Object.isFrozen(p)).toBe(true);
    expect(getAIPolicy('easy')).toBe(easy);              // same object every call: a think never re-allocates
    expect(getAIPolicy()).toBe(medium);                  // the default difficulty
    expect(medium).toEqual(BASE_AI_POLICY);              // default gameplay keeps its pre-policy behaviour
    expect(() => getAIPolicy('brutal')).toThrow('Unknown AI difficulty');
  });

  it('seeds every player, honours per-player overrides and never swaps a policy per think', () => {
    const w = createWorld(5150, { humans: [], aiDelay: 1 });
    for (const p of w.players) expect(Object.isFrozen(p.aiPolicy)).toBe(true);
    expect(w.players[0].aiPolicy).toBe(getAIPolicy('medium'));

    const w2 = createWorld(5150, { humans: [], aiDelay: 1, aiPolicies: { 2: { advance: 4, lineDemand: 3 } } });
    expect(w2.players[0].aiPolicy).toBe(getAIPolicy('medium'));
    expect(w2.players[1].aiPolicy.advance).toBe(4);
    expect(w2.players[1].aiPolicy.lineDemand).toBe(3);
    expect(w2.players[2].aiPolicy).toBe(getAIPolicy('medium'));

    const before = w2.players[1].aiPolicy;
    aiThink(w2, w2.players[1]);
    aiThink(w2, w2.players[1]);
    expect(w2.players[1].aiPolicy).toBe(before);         // the same frozen object after thinking, never a copy
  });
});

describe('AI policy decisions', () => {
  const withPolicy = (w, params) => { w.players[0].aiPolicy = normalizeAIPolicy(params); return w.players[0]; };

  it('scatters to capture or forms a line from the same army, purely by lineDemand', () => {
    const plan = lineDemand => {
      const w = mkWorld(77);
      const g = frontGround(w, 1);
      for (let k = 0; k < 2; k++) stage(w, 1, g.x + k * 1.2, g.y, 100, 'inf');
      return planAI(w, withPolicy(w, { lineDemand }));
    };
    const line = plan(0.8), scatter = plan(4);
    expect(line.demand).toBeGreaterThan(0.8);            // the same moment sits between the two thresholds
    expect(line.demand).toBeLessThan(4);
    expect(scatter.demand).toBe(line.demand);            // demand is world state, not a policy readout
    expect(line.orders).toHaveLength(1);
    expect(line.orders[0].k).toBe('formation');
    expect(line.orders[0].ids).toHaveLength(2);
    expect(scatter.orders).toHaveLength(2);
    expect(scatter.orders.every(o => o.k === 'move' && o.ids.length === 1)).toBe(true);
  });

  it('steps a line forward by policy.advance and stops at the enemy standoff', () => {
    const w = mkWorld(31);
    const o = openFront(w, 1, 20);
    const units = [];
    for (let k = 0; k < 4; k++) units.push(stage(w, 1, o.x + (k % 2) * 1.2, o.y + ((k / 2) | 0) * 1.2, 100, 'inf'));
    const foe = stage(w, 2, o.x + o.dx * 15, o.y + o.dy * 15, 100, 'inf');
    const step = advance => {
      const plan = planAI(w, withPolicy(w, { lineDemand: 0.8, advance }));
      const line = plan.orders.find(x => x.k === 'formation');
      expect(line).toBeTruthy();
      const cen = mean(units), c = mid(line.points);
      return { step: Math.hypot(c.x - cen.x, c.y - cen.y), gap: Math.hypot(foe.x - cen.x, foe.y - cen.y) };
    };
    const near = step(4), far = step(14);
    expect(near.step).toBeCloseTo(4, 0);                 // a short advance: exactly its own step length
    expect(far.step).toBeGreaterThan(near.step + 4);     // a long advance: a step, not a teleport
    expect(far.step).toBeLessThanOrEqual(far.gap - RANGE * 0.8 + 0.6);
    expect(far.gap).toBeGreaterThan(9);                  // the enemy really is out there
  });

  it('searches a wider capture area when captureRange is raised', () => {
    const survey = captureRange => {
      const w = mkWorld(909);
      const owned = [];
      for (let i = 0; i < W * H; i++) if (w.owner[i] !== 0) owned.push(i);
      const openGround = (x, y) => owned.every(j => Math.hypot(x - (j % W), y - ((j / W) | 0)) > 18);
      const spots = [];
      for (let i = 0; i < W * H && spots.length < 10; i++) {
        if (w.terr[i] === WATER || w.owner[i] !== 0 || w.cityAt[i] >= 0) continue;
        const x = i % W + .5, y = ((i / W) | 0) + .5;
        if (!openGround(x, y)) continue;
        if (spots.some(s => Math.hypot(s.x - x, s.y - y) < 10)) continue;
        spots.push({ x, y });
      }
      expect(spots.length).toBe(10);
      for (const s of spots) stage(w, 1, s.x, s.y, 100, 'inf');
      const plan = planAI(w, withPolicy(w, { captureRange }));
      const out = [];
      for (const o of plan.orders) {
        if (o.k !== 'move' || o.goal !== 'capture') continue;
        const d = w.divs.find(x => x.id === o.ids[0]);
        out.push(Math.hypot(o.x - d.x, o.y - d.y));
      }
      return out;
    };
    const tight = survey(0.6), wide = survey(1.6);
    expect(tight.length).toBe(10);                       // single units really captured, not lined up
    expect(wide).toHaveLength(tight.length);
    const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
    // the wide policy reaches targets the tight one cannot sample at all, not just a longer mean
    expect(avg(wide)).toBeGreaterThan(avg(tight) + 1.5);
    expect(Math.max(...wide)).toBeGreaterThan(Math.max(...tight) + 4);
  });

  it('raises divisions to its own tile-driven cap with its own troop split', () => {
    const raise = params => {
      const w = mkWorld(2024);
      const p = w.players[0];
      p.aiPolicy = normalizeAIPolicy(params);
      p.gold = 1e6; p.pool = 1e6;
      const city = w.cities.find(c => c.owner === 1 && c.capital);
      claimBlock(w, 1, city.x + 3, city.y + 3, 80);
      for (const c of w.cities.filter(c => c.owner === 1)) {   // factories, or armour/artillery never raise
        for (let i = 0; i < W * H; i++) {
          if (canBuild(w, 1, 'factory', i) && Math.hypot((i % W) - c.x, ((i / W) | 0) - c.y) <= BUILD_RADIUS) {
            placeBuildings(w, p, 'factory', [i]);
            break;
          }
        }
      }
      for (let k = 0; k < 80; k++) aiThink(w, p);
      const mine = w.divs.filter(d => d.owner === 1);
      return {
        n: mine.length, inf: mine.filter(d => d.type === 'inf').length,
        other: mine.filter(d => d.type !== 'inf').length,
        cap: 3 + Math.floor(p.tiles / p.aiPolicy.recruitTiles)
      };
    };
    const mass = raise({ recruitTiles: 12, infantryShare: 0.35, armorShare: 0.4 });
    const elite = raise({ recruitTiles: 40, infantryShare: 0.85, armorShare: 0.1 });
    expect(mass.n).toBe(mass.cap);                       // the wide cap was reached and held
    expect(elite.n).toBe(elite.cap);
    expect(elite.n).toBeLessThan(mass.n);                // a bigger tile budget per division means a smaller army
    expect(mass.other).toBeGreaterThan(mass.inf);        // its roll raises mostly armour/artillery
    expect(elite.inf).toBeGreaterThan(elite.other);
  });

  it('funds construction and paving out of its own income shares', () => {
    const economyRun = (params, seconds) => {
      const w = mkWorld(31337);
      const p = w.players[0];
      setOwner(w, w.cities.find(c => c.capital && c.owner === 2).idx, 1);
      const ext = exteriorPoint(w);
      claimBlock(w, 1, ext.x, ext.y, 400);
      p.gold = 900; p.pool = 0;
      p.aiPolicy = normalizeAIPolicy(params);
      grow(w, p, seconds);
      const count = type => builtTiles(w, 1, type).length;
      return count('farm') + count('factory') + count('fortress');
    };
    expect(economyRun({ buildShare: 0.7 }, 240)).toBeGreaterThan(economyRun({ buildShare: 0.15 }, 240));

    const pave = (params, seconds) => {
      const w = mkWorld(7777);
      const p = w.players[0];
      const city = w.cities.find(c => c.owner === 1 && c.capital);
      const end = claimSupplyLine(w, 1, city.x, city.y, 30);
      stage(w, 1, end.x, end.y, 100, 'inf');
      p.active.factory = 5;                              // road-worthy income without waiting on construction
      p.pool = 0;
      p.built.farm = 9999; p.built.factory = 9999; p.built.fortress = 9999;
      p.aiPolicy = normalizeAIPolicy(params);
      let placed = 0;
      const until = w.time + seconds;
      while (w.time < until) {
        economy(w, STEP);
        w.time += STEP;
        if (w.time < p.nextAI) continue;
        p.nextAI = w.time + 1.2;
        const before = roadCount(w);
        aiThink(w, p);
        placed += roadCount(w) - before;
      }
      return placed;
    };
    // A road project is funded from income before it is paved, so a thin share visibly delays it:
    // within 45 s the greedy share has paid for the starved front's corridor, the lean one has not.
    const greedy = pave({ roadShare: 0.35 }, 45);
    const lean = pave({ roadShare: 0.05 }, 45);
    expect(greedy).toBeGreaterThan(0);
    expect(greedy).toBeGreaterThan(lean);
    expect(lean).toBe(0);
  });
});

describe('AI policy outcomes', () => {
  it('changes the game under different policies and repeats itself exactly under the same ones', () => {
    const A = { advance: 4, lineDemand: 0.8, captureRange: 0.6, recruitTiles: 40, infantryShare: 0.85, armorShare: 0.1, buildShare: 0.7, roadShare: 0.05 };
    const B = { advance: 14, lineDemand: 4, captureRange: 1.6, recruitTiles: 12, infantryShare: 0.35, armorShare: 0.4, buildShare: 0.15, roadShare: 0.35 };
    const play = (policies, seconds = 180) => {
      const w = createWorld(4242, {
        settings: { mapSize: 'small', factions: [1, 2], aiDifficulty: 'medium' },
        humans: [], aiDelay: 1, aiPolicies: policies
      });
      run(w, seconds);
      const types = { inf: 0, arm: 0, art: 0 };
      for (const d of w.divs) types[d.type]++;
      return [w.players[0].tiles, w.players[1].tiles, w.players[0].cities, w.players[1].cities,
              types.inf, types.arm, types.art, w.divs.filter(d => d.owner === 1).length,
              w.divs.filter(d => d.owner === 2).length, w.over ? w.result.winnerId : -1].join(':');
    };
    const ab = play({ 1: A, 2: B });
    expect(play({ 1: A, 2: B })).toBe(ab);               // same policies, same seed: exactly the same game
    expect(ab).not.toBe(play(undefined));                // policies demonstrably change what happens
    expect(play({ 1: B, 2: A })).not.toBe(ab);           // and which seat holds which policy matters
  });
});

describe('AI training CLI', () => {
  it('validates population, generations, time and disjoint seed sets before running', () => {
    const ok = validateConfig(parseArgs([
      '--pop', '8', '--gens', '2', '--minutes', '3', '--seeds', '1,2',
      '--eval-seeds', '3,4', '--easy-seeds', '5,6', '--assess-seeds', '7,8', '--master-seed', '9',
      '--weaken-gens', '4', '--weaken-pop', '16'
    ]));
    expect(ok.pop).toBe(8);
    expect(ok.gens).toBe(2);
    expect(ok.easySeeds).toEqual([5, 6]);
    expect(ok.weakenGens).toBe(4);
    expect(ok.weakenPop).toBe(16);

    const defaults = parseArgs([]);
    expect(defaults.easySeeds).toEqual([8302, 8404, 8506, 8608]);
    expect(defaults.weakenGens).toBe(3);
    expect(defaults.weakenPop).toBe(10);

    const bad = args => () => validateConfig(parseArgs(args));
    expect(bad(['--pop', '3'])).toThrow(/--pop must be an integer in \[4, 64\]/);
    expect(bad(['--gens', '0'])).toThrow(/--gens must be an integer in \[1, 100\]/);
    expect(bad(['--minutes', '1'])).toThrow(/--minutes must be a number in \[2, 60\]/);
    expect(bad(['--weaken-gens', '13'])).toThrow(/--weaken-gens must be an integer in \[0, 12\]/);
    expect(bad(['--weaken-pop', '3'])).toThrow(/--weaken-pop must be an integer in \[4, 64\]/);
    expect(bad(['--seeds', '1,1'])).toThrow(/duplicate/);
    expect(bad(['--seeds', '1', '--eval-seeds', '1'])).toThrow(/disjoint/);
    expect(bad(['--seeds', '1', '--eval-seeds', '2', '--easy-seeds', '2'])).toThrow(/--easy-seeds must be disjoint/);
    expect(bad(['--seeds', '1', '--easy-seeds', '1', '--eval-seeds', '2'])).toThrow(/--easy-seeds must be disjoint/);
    expect(bad(['--assess-seeds', '8302'])).toThrow(/--assess-seeds must be disjoint/);   // default easy seed
    expect(bad(['--seeds', '1', '--eval-seeds', '2', '--assess-seeds', '1'])).toThrow(/disjoint/);
    expect(bad(['--init', 'no-such-artifact.json'])).toThrow(/not found/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--pop'])).toThrow(/Missing value/);
    expect(() => parseArgs(['--seeds', 'zero'])).toThrow(/positive integer/);
  });
});

describe('AI training selection', () => {
  it('orders candidates by measured weakness, not by survival in a strong population', () => {
    const row = (id, score, wins, games) => ({ id, key: id, score, oppScore: 0, games, wins, perSeed: [] });
    const rows = [row('a', 12, 6, 8), row('b', 2, 0, 8), row('c', 7, 2, 8)];
    expect(pickWeakest(rows).id).toBe('b');
    expect(pickWeakest([row('x', 4, 2, 4), row('y', 4, 1, 4)]).id).toBe('y');   // equal mean: fewer wins is weaker
    expect(pickWeakest([row('p', 3, 0, 2), row('q', 6, 0, 3)]).id).toBe('p');   // mean 1.5 vs 2
    expect(pickWeakest([])).toBe(null);
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c']);                        // input order untouched
  });
});

describe('AI model artifact', () => {
  it('ships canonical trained profiles and an Easy claim that matches its own measured numbers', () => {
    const artifact = JSON.parse(readFileSync(new URL('../src/sim/ai-models.json', import.meta.url), 'utf8'));
    expect(artifact.trained).toBe(true);
    expect(artifact.bootstrap).toBe(false);
    for (const id of ['easy', 'medium', 'hard']) {
      const params = artifact.profiles[id].params;
      expect(normalizeAIPolicy(params)).toEqual(params);   // canonical: inside bounds, shares repaired
      expect(getAIPolicy(id)).toEqual(params);             // what the runtime actually deploys
    }
    expect(artifact.profiles.medium.params).toEqual(BASE_AI_POLICY);   // compatibility baseline retained

    const { chosen, baselineSelfPlay, candidates, seeds } = artifact.easySelection;
    expect(seeds.length).toBeGreaterThan(0);
    expect(artifact.profiles.easy.params).toEqual(chosen.params);
    expect(chosen.weakerThanBaseline).toBe(chosen.meanScore < baselineSelfPlay.meanScore);
    expect(artifact.profiles.easy.origin)
      .toContain(chosen.weakerThanBaseline ? 'measured weaker' : 'hit its generation cap');
    expect(candidates.some(c => c.id === chosen.id)).toBe(true);
    expect(candidates.every(c => c.meanScore >= chosen.meanScore)).toBe(true);   // chosen is the weakest measured
  });
});

describe('AI land cession', () => {
  /** Land tile `i` shares an edge with land owned by `o` (the same frontier cedeLand moves across). */
  function touches(w, o, i) {
    const x = i % W, y = (i / W) | 0;
    return (x > 0 && w.owner[i - 1] === o && w.terr[i - 1] !== WATER) ||
      (x < W - 1 && w.owner[i + 1] === o && w.terr[i + 1] !== WATER) ||
      (y > 0 && w.owner[i - W] === o && w.terr[i - W] !== WATER) ||
      (y < H - 1 && w.owner[i + W] === o && w.terr[i + W] !== WATER);
  }

  const countOwner = (w, pid) => {
    let n = 0;
    for (let i = 0; i < W * H; i++) if (w.owner[i] === pid) n++;
    return n;
  };

  /** Bare land tiles inside `city`'s build radius bordering land owned by `o` (a recipient's zone
   * fringe, the only ground a cession is meant to hand over). */
  function zoneFringe(w, city, o) {
    const out = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (w.terr[i] === WATER || w.owner[i] !== 0 || w.cityAt[i] >= 0 || w.bld[i] !== 0) continue;
      if (Math.hypot(city.x - x, city.y - y) > BUILD_RADIUS) continue;
      if (!touches(w, o, i)) continue;
      out.push(i);
    }
    return out;
  }

  /** Player 1 owns a deliberate set of bare land tiles inside teammate 2's capital city zone, each
   * bordering teammate 2's land: the city-zone fringe a cession should hand back. */
  function cedeWorld(seed = 20250, teamed = true) {
    const w = mkWorld(seed);
    const p = w.players[0], mate = w.players[1];
    if (teamed) teamUp(w, 1, 2);
    const c2 = w.cities.find(c => c.owner === 2 && c.capital);
    const fringe = zoneFringe(w, c2, 2);
    for (const i of fringe) setOwner(w, i, 1);
    return { w, p, mate, c2, fringe };
  }

  it('cedes only its own bare city-zone fringe to a teammate and never gives up protected ground', () => {
    const { w, p, mate, c2, fringe } = cedeWorld();
    expect(fringe.length).toBeGreaterThanOrEqual(CEDE_MAX_TILES + 2);

    // Protected ground inside the same zone: an unfinished building and a fringe tile its own
    // division stands on (both among the earliest candidates), plus an in-zone tile that borders no
    // teammate land. None may be given away.
    const bldTile = fringe[0];
    setBuilding(w, bldTile, BUILD_IDS.indexOf('factory') + 1, w.time + 30);   // deadline in the future
    const divTile = fringe[1];
    stage(w, 1, (divTile % W) + .5, ((divTile / W) | 0) + .5, 100, 'inf');
    let iso = -1;
    for (let y = 0; y < H && iso < 0; y++) for (let x = 0; x < W && iso < 0; x++) {
      const i = y * W + x;
      if (w.terr[i] === WATER || w.owner[i] !== 0 || w.cityAt[i] >= 0 || w.bld[i] !== 0) continue;
      if (Math.hypot(c2.x - x, c2.y - y) > BUILD_RADIUS || touches(w, 2, i)) continue;
      iso = i;
    }
    expect(iso).toBeGreaterThan(-1);
    setOwner(w, iso, 1);

    const capTile = w.cities.find(c => c.owner === 1 && c.capital).idx;      // valuable interior ground
    const beforeP = p.tiles, beforeM = mate.tiles;
    const snap = w.owner.slice();

    const ceded = aiCede(w, p);
    expect(ceded).toBeGreaterThan(0);                                         // it does hand ground over
    expect(ceded).toBeLessThanOrEqual(CEDE_MAX_TILES);                        // but only a bounded handful

    const changed = [];
    for (let i = 0; i < W * H; i++) if (snap[i] === 1 && w.owner[i] === 2) changed.push(i);
    expect(changed.length).toBe(ceded);
    const fringeSet = new Set(fringe);
    for (const t of changed) {                                                // every gift is a real fringe tile
      expect(fringeSet.has(t)).toBe(true);
      expect(w.bld[t]).toBe(0);
      expect(w.cityAt[t]).toBeLessThan(0);
    }
    expect(w.owner[bldTile]).toBe(1);                                         // the unfinished building stayed
    expect(w.bld[bldTile]).not.toBe(0);                                       // and stayed unfinished, not razed
    expect(w.owner[divTile]).toBe(1);                                         // land under a division stayed
    expect(w.owner[iso]).toBe(1);                                             // off-border ground stayed
    expect(w.owner[capTile]).toBe(1);                                         // its own capital stayed
    expect(p.tiles).toBe(countOwner(w, 1));                                   // tallies stayed exact
    expect(mate.tiles).toBe(countOwner(w, 2));
    expect(p.tiles).toBe(beforeP - ceded);
    expect(mate.tiles).toBe(beforeM + ceded);

    // Contrast: the same world with nothing protected hands both those tiles over, so the building
    // and the division - not the cession order - are what spared them above.
    const plain = cedeWorld();
    aiCede(plain.w, plain.p);
    expect(plain.w.owner[plain.fringe[0]]).toBe(2);
    expect(plain.w.owner[plain.fringe[1]]).toBe(2);
  });

  it('cedes during a normal think-pass to its teammate', () => {
    const { w, p, mate, fringe } = cedeWorld();
    const beforeP = p.tiles, beforeM = mate.tiles;
    p.nextAI = 0;
    aiThink(w, p);                                                            // the full pass, not just the policy
    const ceded = mate.tiles - beforeM;
    expect(ceded).toBeGreaterThan(0);
    expect(ceded).toBeLessThanOrEqual(CEDE_MAX_TILES);
    expect(p.tiles).toBe(beforeP - ceded);
    const fringeSet = new Set(fringe);
    let moved = 0;
    for (const t of fringeSet) if (w.owner[t] === 2) moved++;
    expect(moved).toBe(ceded);                                                // only fringe ground moved
  });

  it('is deterministic and bounded: the same world always cedes the same tiles', () => {
    const once = () => {
      const { w, p } = cedeWorld();
      const snap = w.owner.slice();
      aiCede(w, p);
      const out = [];
      for (let i = 0; i < W * H; i++) if (snap[i] === 1 && w.owner[i] === 2) out.push(i);
      return out;
    };
    const a = once(), b = once();
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(CEDE_MAX_TILES);
    expect(a).toEqual(b);
  });

  it('never cedes in FFA: a teammate is the only possible recipient', () => {
    const { w, p, fringe } = cedeWorld(20250, false);                          // teams default to own id
    expect(allied(w, 1, 2)).toBe(false);
    const before = countOwner(w, 1);
    expect(aiCede(w, p)).toBe(0);
    expect(countOwner(w, 1)).toBe(before);                                    // nothing left the sender
    for (const t of fringe) expect(w.owner[t]).toBe(1);
  });

  it('never hands over ground inside one of its own city zones', () => {
    const w = mkWorld(20250);
    const p = w.players[0];
    teamUp(w, 1, 2);
    const c2 = w.cities.find(c => c.owner === 2 && c.capital);
    // Give p a city close enough that its own zone overlaps the teammate's: the synthetic layout the
    // guard exists for (generated cities are normally spaced too far for zones to meet).
    const home = w.cities.find(c => c.owner === 0 && !c.capital);
    setOwner(w, home.idx, 1);
    home.x = c2.x + 3; home.y = c2.y;
    let t = -1;
    for (let y = 0; y < H && t < 0; y++) for (let x = 0; x < W && t < 0; x++) {
      const i = y * W + x;
      if (w.terr[i] === WATER || w.cityAt[i] >= 0 || w.bld[i] !== 0) continue;
      if (Math.hypot(c2.x - x, c2.y - y) > BUILD_RADIUS) continue;
      if (Math.hypot(home.x - x, home.y - y) > BUILD_RADIUS) continue;
      if (touches(w, 2, i)) t = i;
    }
    expect(t).toBeGreaterThan(-1);
    setOwner(w, t, 1);
    expect(aiCede(w, p)).toBe(0);                                             // its own city zone is off limits
    expect(w.owner[t]).toBe(1);
  });
});
