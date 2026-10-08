import { describe, it, expect } from 'vitest';
import { STEP, LAND, REINFORCE_RATE, LOGISTICS_DISTANCE, TYPES } from '../src/config.js';
import { createWorld, setOwner } from '../src/sim/world.js';
import { economy } from '../src/sim/economy.js';
import { spawnDiv } from '../src/sim/divisions.js';
import { tileOf } from '../src/sim/geom.js';
import { logisticsDistance, reinforceRate } from '../src/sim/supply.js';

const mk = seed => createWorld(seed, { humans: ['Me'], aiDelay: 1e9 });
const T = (w, x, y) => y * w.w + x;

/** The first row of `len` plain land tiles with no city or building, or null. Deterministic per seed. */
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

/** A map with a 33-tile plain row, fixed seeds tried in order so geometry (and every number) is stable. */
function site() {
  for (const seed of [12345, 2, 3, 5, 7, 11, 13]) {
    const w = mk(seed);
    const row = findRow(w, 33);
    if (row) return { w, ...row };
  }
  throw new Error('no plain-land site with a 33-tile row was found');
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

/** One owned city at the site's west end plus a straight owned run of `len` columns east of it. */
function stage({ len = 30 } = {}) {
  const { w, x0, y } = site();
  wipe(w, 1);
  const c = installCity(w, 1, x0, y);
  const run = [];
  for (let k = 1; k <= len; k++) { const t = T(w, x0 + k, y); setOwner(w, t, 1); run.push(t); }
  return { w, c, run, x0, y };
}

/**
 * Spawn a division and own its geometry: spawnSpot may shift a body off a busy tile, so the centre is
 * rewritten after spawn to pin the unit to exactly `t`, letting several units share one supply point.
 */
function place(w, pid, t, men, cap, type = 'inf') {
  const d = spawnDiv(w, pid, (t % w.w) + .5, ((t / w.w) | 0) + .5, men, cap, type);
  expect(d).not.toBeNull();
  d.x = (t % w.w) + .5; d.y = ((t / w.w) | 0) + .5;
  expect(tileOf(w, d)).toBe(t);
  return d;
}

describe('paid refill scales with nominal cap', () => {
  it('splitting a division partitions its reserve-to-field replenishment (sum conserved)', () => {
    // Whole body: one wounded standard infantry at 30 tiles (the standard cap is its own type's men).
    const a = stage();
    const orig = place(a.w, 1, a.run[29], 50, TYPES.inf.men, 'inf');
    const d0 = logisticsDistance(a.w, orig);
    const R = reinforceRate(a.w, orig);
    expect(R).toBeCloseTo(REINFORCE_RATE / (1 + d0 / LOGISTICS_DISTANCE), 12);

    // Its two halves: same tile, cap halved, men conserved. Fragmenting must not create extra supply.
    const b = stage();
    const t = b.run[29];
    const h1 = place(b.w, 1, t, 25, TYPES.inf.men / 2, 'inf');
    const h2 = place(b.w, 1, t, 25, TYPES.inf.men / 2, 'inf');
    expect(logisticsDistance(b.w, h1)).toBeCloseTo(d0, 9);
    expect(reinforceRate(b.w, h1) + reinforceRate(b.w, h2)).toBeCloseTo(R, 12);

    // Real economy at equal supply: the same men/s reaches the field, paid from the same pool.
    for (const w of [a.w, b.w]) { const p = w.players[0]; p.pool = 500; }
    const menA0 = orig.men, menB0 = h1.men + h2.men;
    economy(a.w, STEP);
    economy(b.w, STEP);
    const gainA = orig.men - menA0, gainB = (h1.men + h2.men) - menB0;
    expect(gainA).toBeCloseTo(R * STEP, 9);
    expect(gainB).toBeGreaterThan(0);
    expect(gainB).toBeCloseTo(gainA, 9);
  });

  it('normalizes every type by its own standard body and clamps oversized caps to full rate', () => {
    const { w, run } = stage();
    const t = run[20];
    const d = logisticsDistance(w, place(w, 1, t, 10, 10, 'inf'));
    const base = REINFORCE_RATE / (1 + d / LOGISTICS_DISTANCE);
    for (const [type, def] of Object.entries(TYPES)) {
      expect(reinforceRate(w, place(w, 1, t, def.men, def.men, type))).toBeCloseTo(base, 9);
      expect(reinforceRate(w, place(w, 1, t, def.men / 4, def.men / 2, type))).toBeCloseTo(base / 2, 9);
      // Over-sized trusted fixtures keep the falloff, never exceeding a standard body's paid rate.
      expect(reinforceRate(w, place(w, 1, t, 10, def.men + 20, type))).toBeCloseTo(base, 9);
    }
  });

  it('stays pool-paid, cap-limited and exactly zero when isolated', () => {
    const { w, run } = stage();
    const p = w.players[0];
    const conn = place(w, 1, run[29], 25, 50, 'inf');
    const Rc = reinforceRate(w, conn);
    expect(Rc).toBeGreaterThan(0);
    p.pool = 500;
    const m0 = conn.men, pool0 = p.pool;
    economy(w, STEP);
    expect(conn.men - m0).toBeCloseTo(Rc * STEP, 12);
    expect(p.pool).toBeLessThan(pool0);                        // men bought from reserves, not minted

    // Cap-limited: a nearly full fragment tops out at exactly its cap, never past it.
    const full = place(w, 1, run[28], 49.99, 50, 'inf');
    economy(w, STEP);
    expect(full.men).toBeCloseTo(50, 12);
    expect(full.men).toBeLessThanOrEqual(full.cap);

    // Isolated: no city the side still holds means no reinforcement at all.
    const iso = stage();
    wipe(iso.w, 1);
    iso.c.owner = 0;                                          // the city slot goes too: player 1 is cut off
    const lost = place(iso.w, 1, iso.run[29], 25, 50, 'inf');
    expect(reinforceRate(iso.w, lost)).toBe(0);
    iso.w.players[0].pool = 500;
    const im0 = lost.men;
    economy(iso.w, STEP);
    expect(lost.men).toBe(im0);
  });
});
