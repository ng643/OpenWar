import { describe, it, expect } from 'vitest';
import { W, H, LAND, TYPES } from '../src/config.js';
import { createWorld, setOwner } from '../src/sim/world.js';
import { captureStep } from '../src/sim/movement.js';

const mkWorld = (seed = 12345, opts = {}) => createWorld(seed, { humans: [], aiDelay: 1e9, ...opts });

/**
 * A 5x5 block of plain neutral land at least two tiles from any city or building, forced to LAND and
 * nobody's ground so a division standing at its centre has a clean neighbourhood to capture in.
 * @returns {{x:number,y:number}} the centre tile in tile coordinates
 */
function clearArea(w) {
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    let ok = true;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) {
      const i = (y + dy) * W + x + dx;
      if (w.cityAt[i] >= 0 || w.bld[i]) { ok = false; break; }
    }
    if (!ok) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const i = (y + dy) * W + x + dx;
      w.terr[i] = LAND;
      if (w.owner[i]) setOwner(w, i, 0);
    }
    return { x, y };
  }
  throw new Error('no clear 5x5 land area');
}

/** A bare division for captureStep: the only fields land capture reads. */
function placeDiv(w, owner, tx, ty, men, type = 'inf', acc = 0) {
  const d = { id: w.nextId++, owner, type, x: tx + .5, y: ty + .5, men, cap: men, acc };
  w.divs.push(d);
  return d;
}

/** The tile index `dx, dy` from the centre of an area. */
const at = (c, dx, dy) => (c.y + dy) * W + c.x + dx;
const CARDINALS = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]];

describe('capture neighbourhood', () => {
  it('takes the ground underfoot and the four cardinals, never a diagonal or one tile beyond', () => {
    const w = mkWorld(); const c = clearArea(w);
    const d = placeDiv(w, 1, c.x, c.y, 100);

    // the tile underfoot: directly underfoot needs no own land to fall to
    d.acc = 1; captureStep(w, d, 0);
    expect(w.owner[at(c, 0, 0)]).toBe(1);
    expect(CARDINALS.slice(1).map(([dx, dy]) => w.owner[at(c, dx, dy)])).toEqual([0, 0, 0, 0]);

    // the four cardinal neighbours: each now touches the tile underfoot
    for (let k = 0; k < 4; k++) { d.acc = 1; captureStep(w, d, 0); }

    // exactly a plus of five tiles inside the 5x5 block: diagonals and distance two stay untouched
    const owned = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      if (w.owner[at(c, dx, dy)]) owned.push(dx + ',' + dy);
    expect(owned.sort()).toEqual(['-1,0', '0,-1', '0,0', '0,1', '1,0']);

    // nothing left to take: the accumulator is emptied, not left charged for a later frontier
    d.acc = 1; captureStep(w, d, 0);
    expect(d.acc).toBe(0);
    const after = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      if (w.owner[at(c, dx, dy)]) after.push(dx + ',' + dy);
    expect(after.sort()).toEqual(owned);                 // no further land was painted
  });

  it('an oversized merged body holds the same single-unit footprint', () => {
    const w = mkWorld(); const c = clearArea(w);
    const d = placeDiv(w, 1, c.x, c.y, 1000);            // ten times a normal infantry body
    for (let k = 0; k < 5; k++) { d.acc = 1; captureStep(w, d, 0); }
    const owned = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      if (w.owner[at(c, dx, dy)]) owned.push(dx + ',' + dy);
    expect(owned.sort()).toEqual(['-1,0', '0,-1', '0,0', '0,1', '1,0']);
    d.acc = 1; captureStep(w, d, 0);
    expect(d.acc).toBe(0);                               // no extra footprint to spend credit on
  });

  it('banks no capture credit when there is nothing to take', () => {
    const w = mkWorld(); const c = clearArea(w);
    setOwner(w, at(c, 0, 0), 1);
    for (const [dx, dy] of CARDINALS.slice(1)) setOwner(w, at(c, dx, dy), 1);
    const d = placeDiv(w, 1, c.x, c.y, 100);
    d.acc = 1; captureStep(w, d, 0);
    expect(d.acc).toBe(0);                               // an idle division stores no free capture
  });
});

describe('capture fronts', () => {
  /** Force one capture against the east cardinal only, and report the men paid and the new owner. */
  function front(w, targetOwner) {
    const c = clearArea(w);
    setOwner(w, at(c, 0, 0), 1);                         // ground underfoot
    for (const [dx, dy] of [[0, -1], [-1, 0], [0, 1]]) setOwner(w, at(c, dx, dy), 1);  // three cardinals ours
    if (targetOwner) setOwner(w, at(c, 1, 0), targetOwner);
    const d = placeDiv(w, 1, c.x, c.y, 100, 'inf', 1);
    const men0 = d.men;
    captureStep(w, d, 0);
    return { paid: men0 - d.men, owner: w.owner[at(c, 1, 0)] };
  }

  it('a neutral front costs a sliver of men, an enemy front the full price', () => {
    const neutral = front(mkWorld(), 0);
    const enemy = front(mkWorld(), 2);
    expect(neutral.owner).toBe(1);
    expect(enemy.owner).toBe(1);
    expect(neutral.paid).toBeCloseTo(0.04, 9);
    expect(enemy.paid).toBeCloseTo(0.25, 9);
    expect(enemy.paid).toBeGreaterThan(neutral.paid);
  });

  it('allied ground is never taken but lets a division capture from it', () => {
    const w = mkWorld(12345, { settings: { teams: [1, 1, 2, 2, 3, 3], teamCount: 3 } });
    const c = clearArea(w);
    setOwner(w, at(c, 0, 0), 2);                         // a teammate holds the ground underfoot
    const d = placeDiv(w, 1, c.x, c.y, 100, 'inf', 1);
    captureStep(w, d, 0);
    expect(w.owner[at(c, 0, 0)]).toBe(2);                // the ally's tile survives
    const taken = CARDINALS.slice(1).filter(([dx, dy]) => w.owner[at(c, dx, dy)] === 1);
    expect(taken).toHaveLength(1);                       // yet the ally's ground fed a capture beside it
  });

  it('artillery captures no land', () => {
    const w = mkWorld(); const c = clearArea(w);
    const d = placeDiv(w, 1, c.x, c.y, TYPES.art.men, 'art', 1);
    captureStep(w, d, 0);
    expect(d.men).toBe(TYPES.art.men);
    expect(w.owner[at(c, 0, 0)]).toBe(0);
  });
});

describe('capture rate', () => {
  const fullRate = dt => (0.7 + TYPES.inf.men / 120) * TYPES.inf.capt * dt;

  it('a split division keeps the original total capture rate', () => {
    const w = mkWorld(); const c = clearArea(w);
    const whole = placeDiv(w, 1, c.x, c.y, 100);
    const a = placeDiv(w, 1, c.x, c.y, 50);
    const b = placeDiv(w, 1, c.x, c.y + 1, 50);
    captureStep(w, whole, 0.5);
    captureStep(w, a, 0.5);
    captureStep(w, b, 0.5);
    expect(whole.acc).toBeCloseTo(fullRate(0.5), 12);    // a full body keeps its old steady rate
    expect(a.acc + b.acc).toBeCloseTo(whole.acc, 12);    // the two halves sum to exactly that rate
  });

  it('an oversized body is clamped to one normal unit of strength', () => {
    const w = mkWorld(); const c = clearArea(w);
    const normal = placeDiv(w, 1, c.x, c.y, 100);
    const huge = placeDiv(w, 1, c.x, c.y + 1, 1000);
    captureStep(w, normal, 0.5);
    captureStep(w, huge, 0.5);
    expect(huge.acc).toBe(normal.acc);
    expect(huge.acc).toBeCloseTo(fullRate(0.5), 12);
  });
});
