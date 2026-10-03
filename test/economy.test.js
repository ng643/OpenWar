import { describe, it, expect } from 'vitest';
import { STEP, LAND, LOGISTICS_DISTANCE, REINFORCE_RATE, ISOLATED_COMBAT } from '../src/config.js';
import { createWorld, setOwner } from '../src/sim/world.js';
import { tick } from '../src/sim/game.js';
import { economy } from '../src/sim/economy.js';
import { spawnDiv } from '../src/sim/divisions.js';
import { tileOf } from '../src/sim/geom.js';
import { logisticsDistance, combatMult, reinforceRate } from '../src/sim/supply.js';

const mk = (seed = 12345) => createWorld(seed, { humans: ['Me'], aiDelay: 1e9 });
const capital = (w, pid) => w.cities.find(c => c.owner === pid && c.capital);

/**
 * Own a straight cardinal run of `len` plain tiles (no city or building on it) right next to `c`;
 * returns the tiles in walking order, none when no direction offers one. The city keeps its own
 * disc, but the straight run is the shortest path, so the run's k-th tile sits at exactly distance k.
 */
function corridor(w, c, len) {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const tiles = [];
    for (let k = 1; k <= len; k++) {
      const x = c.x + dx * k, y = c.y + dy * k;
      if (x < 0 || y < 0 || x >= w.w || y >= w.h) { tiles.length = 0; break; }
      const t = y * w.w + x;
      if (w.terr[t] !== LAND || w.cityAt[t] !== -1 || w.bld[t] !== 0) { tiles.length = 0; break; }
      tiles.push(t);
    }
    if (tiles.length === len) { for (const t of tiles) setOwner(w, t, 1); return tiles; }
  }
  return null;
}

/** A world with player 1's capital and a `len`-tile plain corridor leaving it. */
function staged(len = 4) {
  for (const seed of [12345, 2, 3, 5, 7, 11, 13]) {
    const w = mk(seed);
    const c = capital(w, 1);
    const tiles = corridor(w, c, len);
    if (tiles) return { w, c, tiles };
  }
  throw new Error(`no capital with a ${len}-tile plain corridor was found`);
}

/** A place far from anything player 1 owns: logistics there is Infinity by construction. */
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

/** Spawn a division centred on a tile; fails loudly if spawnDiv placed it elsewhere. */
function hurtOn(w, pid, t, men = 50) {
  const d = spawnDiv(w, pid, (t % w.w) + .5, ((t / w.w) | 0) + .5, men, 100, 'inf');
  expect(d).not.toBeNull();
  expect(tileOf(w, d)).toBe(t);
  return d;
}

describe('economy', () => {
  it('manpower income fades to zero once reserves plus army reach the holding ceiling', () => {
    const w = mk(); const p = w.players[0];
    p.pool = 1e7;                               // far above any ceiling this player can hold
    tick(w, STEP);
    expect(p.rate).toBe(0);
    const held = p.pool;
    for (let i = 0; i < 40; i++) tick(w, STEP);
    expect(p.pool).toBe(held);                  // over the ceiling nothing accrues
  });

  it('economy accrues income for elapsed time and leaves balances untouched at dt zero', () => {
    const w = mk(); const p = w.players[0];
    p.pool = 0; w.divs = [];
    const gold0 = p.gold;
    economy(w, 0);                              // dt 0: compute rates without accruing
    expect(p.pool).toBe(0);
    expect(p.gold).toBe(gold0);
    economy(w, STEP);
    expect(p.pool).toBeCloseTo(p.rate * STEP, 9);
    expect(p.gold).toBeCloseTo(gold0 + p.goldRate * STEP, 9);
  });
});

describe('logistics reinforcement', () => {
  it('a connected division at its city reinforces at the full rate, and the pool pays for every man', () => {
    const { w, c } = staged();
    const d = hurtOn(w, 1, c.idx, 40);
    expect(logisticsDistance(w, d)).toBe(0);
    expect(combatMult(w, d)).toBeCloseTo(1, 9);
    const p = w.players[0]; p.pool = 200;
    const pool0 = p.pool, men0 = d.men;
    economy(w, STEP);
    const gained = d.men - men0;
    expect(gained).toBeCloseTo(REINFORCE_RATE * STEP, 6);              // up to 3 men/s at a city
    expect(p.pool).toBeCloseTo(pool0 + p.rate * STEP - gained, 6);     // income in, men paid out
    expect(p.pool).toBeLessThan(pool0 + p.rate * STEP);
  });

  it('a remote but connected division reinforces at the distance rate, still paid from the pool', () => {
    const { w, tiles } = staged();
    const d = hurtOn(w, 1, tiles[3]);
    expect(logisticsDistance(w, d)).toBeCloseTo(4, 5);
    expect(reinforceRate(w, d)).toBeGreaterThan(0);
    const p = w.players[0]; p.pool = 200;
    const pool0 = p.pool, men0 = d.men;
    economy(w, STEP);
    const gained = d.men - men0;
    const want = REINFORCE_RATE / (1 + 4 / LOGISTICS_DISTANCE) * STEP;
    expect(gained).toBeGreaterThan(0);
    expect(gained).toBeCloseTo(want, 6);
    expect(p.pool).toBeCloseTo(pool0 + p.rate * STEP - gained, 6);
  });

  it('reinforcement is limited by the reserves pool', () => {
    const { w, c } = staged();
    const d = hurtOn(w, 1, c.idx, 40);
    const p = w.players[0]; p.pool = 0;
    economy(w, STEP);
    expect(d.men - 40).toBeCloseTo(p.rate * STEP, 9);                  // only this tick's income, nothing more
    expect(p.pool).toBeCloseTo(0, 9);
  });

  it("allies conduct supply but fund their own armies: each side pays for its own men", () => {
    const { w, tiles } = staged();
    for (const t of tiles) setOwner(w, t, 2);                          // the ally holds the corridor
    w.players[0].team = 1; w.players[1].team = 1;
    const mine = hurtOn(w, 1, tiles[3], 40);                           // my division, standing on ally ground
    const theirs = hurtOn(w, 2, tiles[0], 40);                         // the ally's, near my capital
    expect(logisticsDistance(w, mine)).toBeCloseTo(4, 5);              // my line still runs through their land
    const p = w.players[0], mate = w.players[1];
    p.pool = 200; mate.pool = 200;
    const pool0 = p.pool, mate0 = mate.pool, men0 = mine.men;
    economy(w, STEP);
    const gained = mine.men - men0, mateGained = theirs.men - 40;
    expect(gained).toBeCloseTo(REINFORCE_RATE / (1 + 4 / LOGISTICS_DISTANCE) * STEP, 6);
    expect(mateGained).toBeGreaterThan(0);
    expect(p.pool).toBeCloseTo(pool0 + p.rate * STEP - gained, 6);     // my men come out of my pool
    expect(mate.pool).toBeCloseTo(mate0 + mate.rate * STEP - mateGained, 6);   // never out of my ally's
  });

  it('an isolated division receives nothing and loses nothing', () => {
    const { w } = staged();
    const t = wilderness(w, 1);
    expect(t).toBeGreaterThanOrEqual(0);
    const d = hurtOn(w, 1, t, 50);
    expect(logisticsDistance(w, d)).toBe(Infinity);
    expect(reinforceRate(w, d)).toBe(0);
    expect(combatMult(w, d)).toBe(ISOLATED_COMBAT);
    const p = w.players[0]; p.pool = 200;
    const pool0 = p.pool;
    for (let i = 0; i < 10; i++) economy(w, STEP);
    expect(d.men).toBe(50);                                            // no healing, no attrition
    expect(p.pool).toBeGreaterThan(pool0);                             // normal income keeps flowing
  });

  it('an engaged division does not reinforce even beside its city', () => {
    const { w, c } = staged();
    const d = hurtOn(w, 1, c.idx, 40);
    d.eng = true;
    const p = w.players[0]; p.pool = 200;
    const pool0 = p.pool;
    economy(w, STEP);
    expect(d.men).toBe(40);
    expect(p.pool).toBeCloseTo(pool0 + p.rate * STEP, 6);              // income only
  });

  it('a division already at full strength does not drain the pool', () => {
    const { w, c } = staged();
    spawnDiv(w, 1, c.x + .5, c.y + .5, 100, 100, 'inf');
    const p = w.players[0]; p.pool = 200;
    const pool0 = p.pool;
    tick(w, STEP);
    expect(p.pool).toBeCloseTo(pool0 + p.rate * STEP, 6);              // only income, no reinforcement
  });
});
