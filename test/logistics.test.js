import { describe, it, expect } from 'vitest';
import {
  STEP, LAND, WATER, LOGISTICS_DISTANCE, ISOLATED_COMBAT, REINFORCE_RATE, ROAD_LOGISTICS_COST, TCOST
} from '../src/config.js';
import { createWorld, setOwner, setRoad } from '../src/sim/world.js';
import { tick } from '../src/sim/game.js';
import { economy } from '../src/sim/economy.js';
import { spawnDiv } from '../src/sim/divisions.js';
import { tileOf } from '../src/sim/geom.js';
import { logisticsDistance, logisticsPath, combatMult, reinforceRate, updateLogistics } from '../src/sim/supply.js';
import { allied } from '../src/sim/teams.js';
import { normalizeSettings } from '../src/setup.js';

const mk = (seed = 12345, settings) => createWorld(seed, { humans: ['Me'], aiDelay: 1e9, settings });
const T = (w, x, y) => y * w.w + x;
/** Damage multiplier and reinforcement rate the contract prescribes at effective distance D. */
const mult = D => ISOLATED_COMBAT + (1 - ISOLATED_COMBAT) / (1 + D / LOGISTICS_DISTANCE);
const rate = D => REINFORCE_RATE / (1 + D / LOGISTICS_DISTANCE);

/** The first row of `len` plain land tiles with no city or building on it that this world offers, or null. */
function findRow(w, len) {
  for (let y = 0; y < w.h; y++)
    for (let x0 = 0; x0 + len <= w.w; x0++) {
      let ok = true;
      for (let k = 0; k < len && ok; k++) {
        const t = T(w, x0 + k, y);
        if (w.terr[t] !== LAND || w.cityAt[t] !== -1 || w.bld[t] !== 0) ok = false;
      }
      if (ok) return { x0, y };
    }
  return null;
}

/**
 * A plain-land site wide enough for every distance case below: 33 land tiles with no city or
 * building on them in one row (x0..x0+32) plus dry, clear land at (x0+30, y+1) and (x0+31, y+1) for
 * the frontier-step cases. Fixed seeds are tried in order and the first hit is used, so the map —
 * and every expected number — is deterministic; a mapgen change throws here instead of silently
 * skipping the geometry tests.
 */
function site(settings) {
  for (const seed of [12345, 2, 3, 5, 7, 11, 13]) {
    const w = mk(seed, settings);
    const row = findRow(w, 33);
    if (!row) continue;
    if (w.terr[T(w, row.x0 + 30, row.y + 1)] !== LAND || w.bld[T(w, row.x0 + 30, row.y + 1)] !== 0) continue;
    if (w.terr[T(w, row.x0 + 31, row.y + 1)] !== LAND || w.bld[T(w, row.x0 + 31, row.y + 1)] !== 0) continue;
    return { w, ...row };
  }
  throw new Error('no plain-land site with a 33-tile row and dry frontier tiles was found');
}

/** Plant `pid`'s city on a tile (test-local: income tallies do not matter for supply). */
function installCity(w, pid, x, y) {
  const t = T(w, x, y);
  w.cityAt[t] = w.cities.length;
  const c = { idx: t, x, y, owner: pid, capital: true, rally: null };
  w.cities.push(c);
  setOwner(w, t, pid);
  return c;
}

/** Strip every tile `pid` holds, so the world has exactly the supply sources a test builds. */
function wipe(w, pid) {
  for (let t = 0; t < w.owner.length; t++) if (w.owner[t] === pid) setOwner(w, t, 0);
}

/**
 * The standard layout: player 1 wiped bare, one owned city at the site's west end and a straight
 * owned run of `len` columns east of it (roads on every run tile when `road` is set). The run ends
 * at x0+len, leaving neutral tiles at x0+len+1 and x0+len+2 for the frontier tests.
 */
function stage({ len = 30, road = false } = {}) {
  const { w, x0, y } = site();
  wipe(w, 1);
  const c = installCity(w, 1, x0, y);
  const run = [];
  for (let k = 1; k <= len; k++) { const t = T(w, x0 + k, y); setOwner(w, t, 1); run.push(t); }
  if (road) for (const t of run) setRoad(w, t, 1);
  return { w, c, run, x0, y };
}

/** Spawn a division exactly on a tile; fails loudly if spawnDiv placed it elsewhere. */
function unitAt(w, pid, t, men = 50, cap = 100) {
  const d = spawnDiv(w, pid, (t % w.w) + .5, ((t / w.w) | 0) + .5, men, cap, 'inf');
  expect(d).not.toBeNull();
  expect(tileOf(w, d)).toBe(t);
  return d;
}

/** A neutral land tile (no city or building) at least `gap` tiles away from anything `pid` owns. */
function wilderness(w, pid, gap = 2) {
  for (let t = 0; t < w.owner.length; t++) {
    if (w.terr[t] !== LAND || w.cityAt[t] !== -1 || w.bld[t] !== 0 || w.owner[t] === pid) continue;
    const x = t % w.w, y = (t / w.w) | 0;
    let clear = true;
    for (let dy = -gap; dy <= gap && clear; dy++) for (let dx = -gap; dx <= gap; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w.w || ny >= w.h) continue;
      if (w.owner[ny * w.w + nx] === pid) { clear = false; break; }
    }
    if (clear) return t;
  }
  return -1;
}

/** A client-style read-only mirror: fresh arrays, same shape as net-world's view world. */
function mirror(w) {
  return {
    w: w.w, h: w.h,
    terr: w.terr.slice(), owner: w.owner.slice(), bld: w.bld.slice(), bdone: w.bdone.slice(),
    roads: w.roads.slice(), roadVersion: w.roadVersion, ownerVersion: w.ownerVersion,
    cityAt: w.cityAt.slice(), cities: w.cities.map(c => ({ ...c })),
    players: w.players.map(p => ({ ...p })), divs: []
  };
}

describe('logistics distance', () => {
  it('measures the exact distance along connected land, and remote troops reinforce from the pool', () => {
    const { w, run } = stage();
    const d = unitAt(w, 1, run[29]);
    expect(logisticsDistance(w, d)).toBeCloseTo(30, 5);       // straight octile run, all plain
    expect(combatMult(w, d)).toBeCloseTo(0.7, 9);             // .5 + .5/(1 + 30/20)
    expect(reinforceRate(w, d)).toBeCloseTo(1.2, 9);          // 3 men/s / (1 + 30/20)
    updateLogistics(w);                                       // an explicit rebuild changes nothing
    expect(logisticsDistance(w, d)).toBeCloseTo(30, 5);

    const p = w.players[0]; p.pool = 100;
    const pool0 = p.pool, men0 = d.men;
    economy(w, STEP);
    const gained = d.men - men0;
    expect(gained).toBeGreaterThan(0);                        // remote but connected: strictly positive
    expect(gained).toBeCloseTo(1.2 * STEP, 6);
    expect(p.pool).toBeCloseTo(pool0 + p.rate * STEP - gained, 6); // income in, men paid out
  });

  it('supplies from the nearest owned city, not just any city', () => {
    const { w, run, x0, y } = stage();
    const d = unitAt(w, 1, run[29]);
    expect(logisticsDistance(w, d)).toBeCloseTo(30, 5);
    installCity(w, 1, x0 + 31, y);                            // a second owned city right beside the unit
    expect(logisticsDistance(w, d)).toBeCloseTo(1, 5);        // the nearer city wins, not the capital
  });

  it('roads shrink the effective distance, and every road change is live on the next read', () => {
    const { w, run } = stage();
    const d = unitAt(w, 1, run[29]);
    for (let k = 0; k < 5; k++) setRoad(w, run[k], 1);        // five roaded tiles on the way
    expect(logisticsDistance(w, d)).toBeCloseTo(5 * ROAD_LOGISTICS_COST + 25, 5); // 26.25
    for (let k = 5; k < run.length; k++) setRoad(w, run[k], 1);                   // the run fully roaded
    expect(logisticsDistance(w, d)).toBeCloseTo(30 * ROAD_LOGISTICS_COST, 5);     // 7.5
    setRoad(w, run[10], 0);                                   // one road removed again
    expect(logisticsDistance(w, d)).toBeCloseTo(29 * ROAD_LOGISTICS_COST + 1, 5); // 8.25
    expect(combatMult(w, d)).toBeCloseTo(mult(8.25), 9);
    expect(reinforceRate(w, d)).toBeCloseTo(rate(8.25), 9);
  });

  it('capturing one tile of the run severs supply instantly; retaking it reconnects', () => {
    const { w, run } = stage({ road: true });
    const d = unitAt(w, 1, run[29]);
    expect(logisticsDistance(w, d)).toBeCloseTo(7.5, 5);

    setOwner(w, run[14], 2);                                  // the corridor is cut mid-way
    expect(logisticsDistance(w, d)).toBe(Infinity);
    expect(combatMult(w, d)).toBe(ISOLATED_COMBAT);           // exactly half damage output
    expect(reinforceRate(w, d)).toBe(0);
    expect(w.roads[run[20]]).toBe(1);                         // a capture never removes roads

    const p = w.players[0]; p.pool = 100;
    const pool0 = p.pool, men0 = d.men;
    economy(w, STEP);
    expect(d.men).toBe(men0);                                 // nothing to draw on: no men move
    expect(p.pool).toBeCloseTo(pool0 + p.rate * STEP, 6);     // and none are taken from the pool

    setOwner(w, run[14], 1);                                  // retaken: the same roads still carry it
    expect(logisticsDistance(w, d)).toBeCloseTo(7.5, 5);
    expect(combatMult(w, d)).toBeCloseTo(mult(7.5), 9);
  });

  it('losing the source city cuts the run; recapturing it reconnects', () => {
    const { w, run, c } = stage();
    const d = unitAt(w, 1, run[29]);
    expect(logisticsDistance(w, d)).toBeCloseTo(30, 5);
    setOwner(w, c.idx, 2);
    expect(c.owner).toBe(2);
    expect(logisticsDistance(w, d)).toBe(Infinity);
    expect(reinforceRate(w, d)).toBe(0);
    setOwner(w, c.idx, 1);
    expect(logisticsDistance(w, d)).toBeCloseTo(30, 5);
  });

  it('inside owned land a diagonal shortcut needs both shoulder tiles, otherwise there is no path', () => {
    const { w, x0, y } = site();
    wipe(w, 1);
    const e = T(w, x0 + 31, y), s = T(w, x0 + 30, y + 1), se = T(w, x0 + 31, y + 1);
    const c = installCity(w, 1, x0 + 30, y);
    const u = unitAt(w, 1, se);
    expect(logisticsDistance(w, u)).toBe(Infinity);           // diagonal across two foreign shoulders
    setOwner(w, e, 1);
    expect(logisticsDistance(w, u)).toBeCloseTo(2, 5);        // reached the long way, orthogonally
    setOwner(w, s, 1);
    expect(logisticsDistance(w, u)).toBeCloseTo(1.414, 4);    // both shoulders owned: the diagonal is legal
    setRoad(w, se, 1);                                        // a road under the unit's own tile is no shortcut
    expect(logisticsDistance(w, u)).toBeCloseTo(1.414, 4);
    setRoad(w, se, 0);
    setRoad(w, c.idx, 1);                                     // roading the entered tile cheapens the step
    expect(logisticsDistance(w, u)).toBeCloseTo(1.414 * ROAD_LOGISTICS_COST, 4);
    setRoad(w, c.idx, 0);
  });

  it('an isolated division keeps every man through a full tick and is flagged out of supply', () => {
    const { w } = stage();
    const t = wilderness(w, 1);
    expect(t).toBeGreaterThanOrEqual(0);
    const d = unitAt(w, 1, t, 60);
    expect(logisticsDistance(w, d)).toBe(Infinity);
    expect(combatMult(w, d)).toBe(ISOLATED_COMBAT);
    w.players[0].pool = 500;
    d.acc = 0;              // an empty capture accumulator: one short tick cannot seize the ground underfoot,
    tick(w, STEP);          // so any change in men would be supply-driven — attrition or healing, not land-taking
    expect(d.oos).toBe(true);
    expect(d.men).toBe(60);                                   // no attrition, no healing
    expect(logisticsDistance(w, d)).toBe(Infinity);
  });
});

describe('frontier step', () => {
  it('a neutral tile one step from connected land is supplied; two steps away is not', () => {
    const { w, x0, y } = stage();
    const near = unitAt(w, 1, T(w, x0 + 31, y));
    expect(logisticsDistance(w, near)).toBeCloseTo(31, 5);    // 30 to the run end plus the frontier step
    expect(reinforceRate(w, near)).toBeCloseTo(rate(31), 9);
    expect(reinforceRate(w, near)).toBeGreaterThan(0);
    const far = unitAt(w, 1, T(w, x0 + 32, y));
    expect(logisticsDistance(w, far)).toBe(Infinity);         // a foreign gap tile never bridges
  });

  it('the frontier step obeys the corner rule: a diagonal needs both shoulders owned', () => {
    const { w, x0, y } = stage();
    const shoulderA = T(w, x0 + 31, y), shoulderB = T(w, x0 + 30, y + 1);
    const u = unitAt(w, 1, T(w, x0 + 31, y + 1));
    expect(logisticsDistance(w, u)).toBe(Infinity);           // foreign ground all around it
    setOwner(w, shoulderA, 1); setOwner(w, shoulderB, 1);
    expect(logisticsDistance(w, u)).toBeCloseTo(30 + 1.414, 4); // the diagonal beats both orthogonal ways (32)
    setOwner(w, shoulderA, 2);                                // one shoulder turns enemy
    expect(logisticsDistance(w, u)).toBeCloseTo(32, 5);       // falls back to the surviving approach
    setOwner(w, shoulderB, 2);                                // every neighbour is foreign again
    expect(logisticsDistance(w, u)).toBe(Infinity);
    setOwner(w, shoulderA, 1); setOwner(w, shoulderB, 1);     // retaken: the diagonal carries supply again
    expect(logisticsDistance(w, u)).toBeCloseTo(30 + 1.414, 4);
  });

  it('a dry-shoulder diagonal is refused when a shoulder is water', () => {
    const { w, x0, y } = stage();
    const shoulderA = T(w, x0 + 31, y), shoulderB = T(w, x0 + 30, y + 1);
    const u = unitAt(w, 1, T(w, x0 + 31, y + 1));
    setOwner(w, shoulderA, 1); setOwner(w, shoulderB, 1);
    expect(logisticsDistance(w, u)).toBeCloseTo(30 + 1.414, 4);
    const saved = w.terr[shoulderB];
    w.terr[shoulderB] = WATER;                                // a wet shoulder
    expect(logisticsDistance(w, u)).toBeCloseTo(32, 5);       // diagonal refused, the other shoulder still works
    w.terr[shoulderB] = saved;
    expect(logisticsDistance(w, u)).toBeCloseTo(30 + 1.414, 4);
  });

  it('a division on enemy ground beside the frontier is supplied orthogonally', () => {
    const { w, x0, y } = stage();
    const t = T(w, x0 + 31, y);
    setOwner(w, t, 2);                                        // enemy tile right beside the run end
    const d = unitAt(w, 1, t);
    expect(logisticsDistance(w, d)).toBeCloseTo(31, 5);       // one orthogonal frontier step, no corner
    expect(combatMult(w, d)).toBeCloseTo(mult(31), 9);
  });
});

describe('allied supply', () => {
  const allies = { teams: [1, 1, 2, 2, 3, 3], teamCount: 3 };

  it("conducts across an ally's city and land, and cuts when that ground changes hands", () => {
    const { w, x0, y } = site(allies);
    wipe(w, 1); wipe(w, 2); wipe(w, 3);
    installCity(w, 2, x0, y);                                      // the ally's city: none of mine anywhere
    for (let k = 1; k <= 10; k++) setOwner(w, T(w, x0 + k, y), 2);
    expect(allied(w, 1, 2)).toBe(true);
    const d = unitAt(w, 1, T(w, x0 + 10, y));
    expect(logisticsDistance(w, d)).toBeCloseTo(10, 5);            // my division draws on my ally's city
    expect(combatMult(w, d)).toBeCloseTo(mult(10), 6);
    expect(reinforceRate(w, d)).toBeCloseTo(rate(10), 6);
    const path = logisticsPath(w, d);
    expect(path[0]).toBe(T(w, x0 + 10, y));
    expect(path.at(-1)).toBe(T(w, x0, y));
    expect(path).toHaveLength(11);                                 // ally land conducts like home soil

    for (let k = 0; k <= 10; k++) setOwner(w, T(w, x0 + k, y), 3); // the corridor falls to a rival
    expect(logisticsDistance(w, d)).toBe(Infinity);
    expect(logisticsPath(w, d)).toBeNull();

    for (let k = 0; k <= 10; k++) setOwner(w, T(w, x0 + k, y), 2); // retaken: the same chain comes back
    expect(logisticsDistance(w, d)).toBeCloseTo(10, 5);
    expect(logisticsPath(w, d)).toEqual(path);
  });
});

describe('per-world caches', () => {
  it('keeps different-sized worlds and sparse faction ids independent', () => {
    // A small world where only factions 2 and 5 exist: id 5 gets a city and a run; disabled and
    // city-less ids stay cut off. Ids are never dense, and player 1 has no tiles at all.
    const settings = normalizeSettings({ mapSize: 'small', factions: [2, 5] });
    const sw = createWorld(12345, { humans: ['Me'], aiDelay: 1e9, settings });
    expect(sw.players[0].enabled).toBe(false);
    const row = findRow(sw, 6);
    expect(row).not.toBeNull();
    wipe(sw, 5);
    installCity(sw, 5, row.x0, row.y);
    for (let k = 1; k <= 4; k++) setOwner(sw, T(sw, row.x0 + k, row.y), 5);
    const sd = unitAt(sw, 5, T(sw, row.x0 + 4, row.y));
    expect(logisticsDistance(sw, sd)).toBeCloseTo(4, 5);
    expect(logisticsDistance(sw, { x: sd.x, y: sd.y, owner: 1 })).toBe(Infinity); // disabled faction
    expect(logisticsDistance(sw, { x: sd.x, y: sd.y, owner: 2 })).toBe(Infinity); // enabled, owns nothing

    // A standard world on the same seed is an independent, differently sized cache: values never bleed.
    const { w, run } = stage();
    const d = unitAt(w, 1, run[29]);
    expect(logisticsDistance(w, d)).toBeCloseTo(30, 5);
    expect(logisticsDistance(sw, sd)).toBeCloseTo(4, 5);
    setOwner(w, run[14], 2);
    expect(logisticsDistance(w, d)).toBe(Infinity);
    expect(logisticsDistance(sw, sd)).toBeCloseTo(4, 5);       // the other world is unaffected
  });

  it('reads a client mirror with its own arrays without touching the sim world cache', () => {
    const { w, run } = stage();
    const d = unitAt(w, 1, run[29]);
    const view = mirror(w);
    expect(logisticsDistance(view, { x: d.x, y: d.y, owner: 1 })).toBeCloseTo(30, 5);
    setOwner(view, run[14], 2);                               // an independent copy: only the mirror is cut
    expect(logisticsDistance(view, { x: d.x, y: d.y, owner: 1 })).toBe(Infinity);
    expect(logisticsDistance(w, d)).toBeCloseTo(30, 5);
  });

  it('two worlds from the same seed produce identical distances', () => {
    const a = stage(), b = stage();
    const da = unitAt(a.w, 1, a.run[29]), db = unitAt(b.w, 1, b.run[29]);
    expect(logisticsDistance(a.w, da)).toBe(logisticsDistance(b.w, db));
    expect(combatMult(a.w, da)).toBe(combatMult(b.w, db));
    expect(reinforceRate(a.w, da)).toBe(reinforceRate(b.w, db));
  });
});

/**
 * The cost logisticsDistance charges for one chain move from `a` (farther from the city) to `b`
 * (nearer): the terrain/road cost of the tile the outward Dijkstra entered — `a` when it is
 * connected friendly ground, otherwise the friendly frontier entry `b` — times the move's diagonal
 * scale. Summing these over a returned chain reproduces the reported distance.
 */
function stepCharge(w, pid, a, b) {
  const entered = w.owner[a] === pid ? a : b;
  let step = TCOST[w.terr[entered]];
  if (w.roads[entered]) step *= ROAD_LOGISTICS_COST;
  const ax = a % w.w, ay = (a / w.w) | 0, bx = b % w.w, by = (b / w.w) | 0;
  if (ax !== bx && ay !== by) step *= 1.414;
  return step;
}
/** Total charged cost of a returned chain: must equal logisticsDistance for the same world/owner. */
const chainCost = (w, pid, path) => path.slice(1).reduce((s, b, i) => s + stepCharge(w, pid, path[i], b), 0);
const adjacent = (w, a, b) =>
  Math.max(Math.abs((a % w.w) - (b % w.w)), Math.abs(((a / w.w) | 0) - ((b / w.w) | 0))) === 1;

describe('logistics path', () => {
  it('traces the true chain from a division to the nearest owned city', () => {
    const { w, run, c } = stage();
    const d = unitAt(w, 1, run[29]);
    const path = logisticsPath(w, d);
    expect(path).not.toBeNull();
    expect(path[0]).toBe(run[29]);                            // starts on the division's own tile
    expect(path[path.length - 1]).toBe(c.idx);                // ends on the city that supplies it
    expect(new Set(path).size).toBe(path.length);             // a shortest chain never revisits a tile
    for (let i = 1; i < path.length; i++) {
      expect(adjacent(w, path[i - 1], path[i])).toBe(true);   // every step is a single legal move
      expect(w.owner[path[i]]).toBe(1);                       // and lands on ground supply may cross
    }
    expect(chainCost(w, 1, path)).toBeCloseTo(logisticsDistance(w, d), 3); // chain cost === reported distance
  });

  it('ends at the nearest owned city, not the capital', () => {
    const { w, run, x0, y } = stage();
    const d = unitAt(w, 1, run[29]);
    const near = installCity(w, 1, x0 + 31, y);               // a second owned city right beside the unit
    expect(logisticsDistance(w, d)).toBeCloseTo(1, 5);
    const path = logisticsPath(w, d);
    expect(path).toEqual([run[29], near.idx]);                // the nearer city wins, not the capital
  });

  it('roads shape the chain and it still ends at the city', () => {
    const { w, run, c } = stage({ road: true });
    const d = unitAt(w, 1, run[29]);
    const path = logisticsPath(w, d);
    expect(path.length).toBe(31);                             // run[29]..run[0] plus the city tile
    expect(path[path.length - 1]).toBe(c.idx);
    expect(chainCost(w, 1, path)).toBeCloseTo(7.5, 3);            // 30 roaded steps at ROAD_LOGISTICS_COST
    for (const t of path) if (w.cityAt[t] === -1) expect(w.roads[t]).toBe(1);
  });

  it('returns null when cut off and a fresh chain after reconnecting (no stale trace)', () => {
    const { w, run, c } = stage({ road: true });
    const d = unitAt(w, 1, run[29]);
    const before = logisticsPath(w, d);
    expect(before[before.length - 1]).toBe(c.idx);

    setOwner(w, run[14], 2);                                  // the corridor is severed mid-way
    expect(logisticsPath(w, d)).toBeNull();                   // isolated: no fabricated line to a city
    expect(logisticsDistance(w, d)).toBe(Infinity);

    setOwner(w, run[14], 1);                                  // retaken: the same roads carry it again
    const after = logisticsPath(w, d);
    expect(after).toEqual(before);                            // the restored chain is byte-for-byte the old one
    expect(chainCost(w, 1, after)).toBeCloseTo(7.5, 3);
  });

  it('losing and recapturing the source city appears in the chain', () => {
    const { w, run, c } = stage();
    const d = unitAt(w, 1, run[29]);
    expect(logisticsPath(w, d)).not.toBeNull();
    setOwner(w, c.idx, 2);
    expect(logisticsPath(w, d)).toBeNull();                   // no owned city left to terminate in
    setOwner(w, c.idx, 1);
    expect(logisticsPath(w, d)[30]).toBe(c.idx);
  });

  it('includes the division tile and the frontier entry when supplied outside ownership', () => {
    const { w, x0, y, run, c } = stage();
    const t = T(w, x0 + 31, y);                               // neutral tile one step east of the run end
    const d = unitAt(w, 1, t);
    expect(logisticsDistance(w, d)).toBeCloseTo(31, 5);
    const path = logisticsPath(w, d);
    expect(path[0]).toBe(t);                                  // the division's own (foreign) tile leads
    expect(path[1]).toBe(run[29]);                            // then the single frontier step
    expect(path[path.length - 1]).toBe(c.idx);
    expect(chainCost(w, 1, path)).toBeCloseTo(31, 3);
  });

  it('a diagonal frontier step appears in the chain only when both shoulders carry it', () => {
    const { w, x0, y, run, c } = stage();
    const shoulderA = T(w, x0 + 31, y), shoulderB = T(w, x0 + 30, y + 1);
    const unit = T(w, x0 + 31, y + 1);
    const d = unitAt(w, 1, unit);
    expect(logisticsPath(w, d)).toBeNull();                   // no friendly ground around it at all

    setOwner(w, shoulderA, 1);                                // one shoulder: only the long way round
    let path = logisticsPath(w, d);
    expect(path[1]).toBe(shoulderA);
    expect(chainCost(w, 1, path)).toBeCloseTo(32, 3);

    setOwner(w, shoulderB, 1);                                // both shoulders: the diagonal entry is legal
    path = logisticsPath(w, d);
    expect(path[1]).toBe(run[29]);
    expect(chainCost(w, 1, path)).toBeCloseTo(30 + 1.414, 3);

    setOwner(w, shoulderA, 2);                                // one shoulder lost: back to the orthogonal way
    path = logisticsPath(w, d);
    expect(path[1]).toBe(shoulderB);
    expect(chainCost(w, 1, path)).toBeCloseTo(32, 3);

    setOwner(w, shoulderB, 2);
    expect(logisticsPath(w, d)).toBeNull();                   // every approach foreign again
    expect(path[path.length - 1]).toBe(c.idx);
  });

  it('returns null for an isolated division and for an owner with no slot', () => {
    const { w } = stage();
    const t = wilderness(w, 1);
    expect(t).toBeGreaterThanOrEqual(0);
    const d = unitAt(w, 1, t, 60);
    expect(logisticsDistance(w, d)).toBe(Infinity);
    expect(logisticsPath(w, d)).toBeNull();
    expect(logisticsPath(w, { x: d.x, y: d.y, owner: 0 })).toBeNull();  // no faction at all
    expect(logisticsPath(w, { x: d.x, y: d.y, owner: 99 })).toBeNull(); // beyond the slot table
  });

  it('traces per world and per client mirror independently, and deterministically', () => {
    const a = stage(), b = stage();
    const da = unitAt(a.w, 1, a.run[29]), db = unitAt(b.w, 1, b.run[29]);
    const chainA = logisticsPath(a.w, da);
    expect(chainA).toEqual(logisticsPath(b.w, db));           // same seed, same deterministic ties

    const view = mirror(a.w);
    expect(logisticsPath(view, { x: da.x, y: da.y, owner: 1 })).toEqual(chainA);

    setOwner(a.w, a.run[14], 2);                              // cut only world A
    expect(logisticsPath(a.w, da)).toBeNull();
    expect(logisticsPath(b.w, db)).not.toBeNull();            // world B is untouched
    expect(logisticsPath(view, { x: da.x, y: da.y, owner: 1 })).not.toBeNull(); // and so is its mirror
  });

  it('tracing is a pure read: distance, damage multiplier and reinforcement are unchanged', () => {
    const { w, run } = stage();
    const d = unitAt(w, 1, run[29]);
    for (let k = 0; k < 5; k++) setRoad(w, run[k], 1);
    const D = logisticsDistance(w, d), M = combatMult(w, d), R = reinforceRate(w, d);
    expect(logisticsPath(w, d)).not.toBeNull();
    expect(logisticsPath(w, d)).not.toBeNull();
    expect(logisticsDistance(w, d)).toBe(D);
    expect(combatMult(w, d)).toBe(M);
    expect(reinforceRate(w, d)).toBe(R);
  });
});
