import { describe, it, expect } from 'vitest';
import { W, H, WATER, LAND, STEP, RANGE, TYPES, MERGE_RANGE, SPLIT_MIN_MEN } from '../src/config.js';
import { createWorld } from '../src/sim/world.js';
import { spawnDiv, splitDivs, mergeDivs } from '../src/sim/divisions.js';
import { combat } from '../src/sim/combat.js';

// A quiet world: no humans, no AI steps — these tests drive split/merge/combat directly.
const mkWorld = (seed = 12345) => createWorld(seed, { humans: [], aiDelay: 1e9 });

/** Top-left corner of the first nx x ny block of standable tiles (anything but water). */
function landBlock(world, nx, ny) {
  for (let y = 1; y + ny < H; y++) {
    for (let x = 1; x + nx < W; x++) {
      let ok = true;
      for (let dy = 0; dy < ny && ok; dy++)
        for (let dx = 0; dx < nx; dx++)
          if (world.terr[(y + dy) * W + x + dx] === WATER) { ok = false; break; }
      if (ok) return { x, y };
    }
  }
  throw new Error('no standable block found');
}

/**
 * Spawn a division and park it on exact coordinates: the tests own their geometry, spawnSpot only has
 * to find the body ground near the requested point.
 */
function at(world, owner, x, y, men, cap = men, type = 'inf') {
  const d = spawnDiv(world, owner, x, y, men, cap, type);
  expect(d).not.toBeNull();
  d.x = x; d.y = y; d.px = x; d.py = y;
  return d;
}

const sumMen = ds => ds.reduce((s, d) => s + d.men, 0);
const sumCap = ds => ds.reduce((s, d) => s + d.cap, 0);

describe('merge: whole detachments, never an oversized body', () => {
  it('joins a pair that exactly fits the type ceiling and refuses one man over', () => {
    const w = mkWorld(), B = landBlock(w, 4, 2), y = B.y + .5;
    const a = at(w, 1, B.x + .5, y, 60, 60);
    const b = at(w, 1, B.x + 1.5, y, 40, 40);
    const { absorbed } = mergeDivs([a, b]);
    expect(absorbed).toHaveLength(1);
    expect(absorbed[0]).toBe(b);
    expect([a.men, a.cap]).toEqual([TYPES.inf.men, TYPES.inf.men]);
    expect([b.men, b.merged]).toEqual([0, true]);

    const w2 = mkWorld(), B2 = landBlock(w2, 4, 2), y2 = B2.y + .5;
    const c = at(w2, 1, B2.x + .5, y2, 61, 61);
    const d = at(w2, 1, B2.x + 1.5, y2, 40, 40);
    expect(mergeDivs([c, d]).absorbed).toHaveLength(0);
    expect([c.men, c.cap, d.men, d.cap]).toEqual([61, 61, 40, 40]);
    expect(d.merged).toBeFalsy();

    // artillery has a smaller ceiling: 40 + 20 exactly fills it, 40 + 21 does not
    const w3 = mkWorld(), B3 = landBlock(w3, 4, 2), y3 = B3.y + .5;
    const p = at(w3, 1, B3.x + .5, y3, 40, 40, 'art');
    const q = at(w3, 1, B3.x + 1.5, y3, 20, 20, 'art');
    expect(mergeDivs([p, q]).absorbed).toHaveLength(1);
    expect([p.men, p.cap]).toEqual([TYPES.art.men, TYPES.art.men]);

    const w4 = mkWorld(), B4 = landBlock(w4, 4, 2), y4 = B4.y + .5;
    const r = at(w4, 1, B4.x + .5, y4, 40, 40, 'art');
    const s = at(w4, 1, B4.x + 1.5, y4, 21, 21, 'art');
    expect(mergeDivs([r, s]).absorbed).toHaveLength(0);
    expect([r.men, s.men]).toEqual([40, 21]);
  });

  it('refuses a merge that fits men but overflows nominal capacity', () => {
    const w = mkWorld(), B = landBlock(w, 4, 2), y = B.y + .5;
    const a = at(w, 1, B.x + .5, y, 50, 60);   // men 50+50 <= 100, but cap 60+41 = 101 > 100
    const b = at(w, 1, B.x + 1.5, y, 50, 41);
    expect(mergeDivs([a, b]).absorbed).toHaveLength(0);
    expect([a.men, a.cap, b.men, b.cap]).toEqual([50, 60, 50, 41]);
  });

  it('never stacks two standard-cap units, even wounded', () => {
    const w = mkWorld(), B = landBlock(w, 4, 2), y = B.y + .5;
    const a = at(w, 1, B.x + .5, y, 50, 100);
    const b = at(w, 1, B.x + 1.5, y, 50, 100);
    expect(mergeDivs([a, b]).absorbed).toHaveLength(0);
    expect([a.men, a.cap, b.men, b.cap]).toEqual([50, 100, 50, 100]);
  });

  it('fills every surviving target greedily and deterministically without losing men or capacity', () => {
    const layout = B => [
      [B.x + .5, B.y + .5, 60], [B.x + 1.5, B.y + .5, 60],
      [B.x + .5, B.y + 1.5, 40], [B.x + 1.5, B.y + 1.5, 40],
    ];
    const w1 = mkWorld(), B1 = landBlock(w1, 3, 3);
    const ds1 = layout(B1).map(([x, y, men]) => at(w1, 1, x, y, men, men));
    const men0 = sumMen(ds1), cap0 = sumCap(ds1);
    const r1 = mergeDivs(ds1);
    expect(r1.absorbed.map(d => d.id)).toEqual([ds1[2].id, ds1[3].id]);   // strongest first, 40s taken in id order
    expect(ds1.map(d => d.men)).toEqual([100, 100, 0, 0]);
    expect([sumMen(ds1), sumCap(ds1)]).toEqual([men0, cap0]);            // zeroed donors keep the books balanced

    const w2 = mkWorld(), B2 = landBlock(w2, 3, 3);
    const ds2 = layout(B2).map(([x, y, men]) => at(w2, 1, x, y, men, men));
    const r2 = mergeDivs([ds2[3], ds2[1], ds2[0], ds2[2]]);              // shuffled input resolves identically
    expect(r2.absorbed.map(d => d.id)).toEqual([ds2[2].id, ds2[3].id]);
    expect(ds2.map(d => d.men)).toEqual([100, 100, 0, 0]);
  });

  it('refuses other types and owners, and only joins inside MERGE_RANGE', () => {
    const w = mkWorld(), B = landBlock(w, 5, 2), y = B.y + .5;
    const inf = at(w, 1, B.x + .5, y, 40, 40, 'inf');
    const arm = at(w, 1, B.x + .5, y, 40, 40, 'arm');       // same tile and owner, other type
    expect(mergeDivs([inf, arm]).absorbed).toHaveLength(0);
    const foe = at(w, 2, B.x + .5, y, 40, 40, 'inf');       // same type, other owner
    expect(mergeDivs([inf, foe]).absorbed).toHaveLength(0);
    expect([inf.men, arm.men, foe.men]).toEqual([40, 40, 40]);

    const far = at(w, 1, B.x + 2.1, y, 40, 40, 'inf');      // same type and owner, out of range
    expect(MERGE_RANGE).toBe(1.5);
    expect(mergeDivs([inf, far]).absorbed).toHaveLength(0);
    expect(far.men).toBe(40);
    far.x = B.x + 1.9;                                      // walk into range: now they join
    const { absorbed } = mergeDivs([inf, far]);
    expect(absorbed[0]).toBe(far);
    expect(inf.men).toBe(80);
  });

  it('refuses dead, merged, engaged, routing and rout-locked units on both sides of the call', () => {
    const w = mkWorld(), B = landBlock(w, 8, 2), y = B.y + .5;
    const d = at(w, 1, B.x + .5, y, 100, 100);
    for (const flag of ['eng', 'routing', 'routLocked']) {
      d[flag] = true;
      expect(splitDivs(w, [d])).toHaveLength(0);
      expect([d.men, d.cap]).toEqual([100, 100]);
      d[flag] = false;
    }
    d.merged = true;
    expect(splitDivs(w, [d])).toHaveLength(0);
    d.merged = false;
    d.men = SPLIT_MIN_MEN - 1;
    expect(splitDivs(w, [d])).toHaveLength(0);
    d.men = 100;

    const t = at(w, 1, B.x + 4.5, y, 50, 50);
    const n = at(w, 1, B.x + 5.5, y, 50, 50);
    for (const flag of ['eng', 'routing', 'routLocked']) {
      n[flag] = true;                                       // a donor in any bad state stays out
      expect(mergeDivs([t, n]).absorbed).toHaveLength(0);
      n[flag] = false;
    }
    t.eng = true;                                           // the absorber is refused as well
    expect(mergeDivs([t, n]).absorbed).toHaveLength(0);
    t.eng = false;
    n.merged = true;                                        // already absorbed: inert
    expect(mergeDivs([t, n]).absorbed).toHaveLength(0);
    n.merged = false;
    n.men = 0;                                              // dead
    expect(mergeDivs([t, n]).absorbed).toHaveLength(0);
    n.men = 50;
    expect([t.men, n.men]).toEqual([50, 50]);

    // a healthy marching unit may still split and merge
    const halves = splitDivs(w, [d]);
    expect(halves).toHaveLength(1);
    t.path = [1, 2]; n.path = [3];                          // orders under way do not block a merge
    const { absorbed } = mergeDivs([t, n]);
    expect(absorbed).toHaveLength(1);
    expect([t.men, t.cap]).toEqual([100, 100]);
  });
});

describe('split: men, capacity and credit are partitioned, never minted', () => {
  it('splits odd men and capacity exactly, flooring the new half and sharing credit by men', () => {
    const w = mkWorld(), B = landBlock(w, 8, 2), y = B.y + .5;
    const d = at(w, 1, B.x + .5, y, 81, 81);
    expect(d.acc).toBe(0);                                  // a fresh body banks no capture credit
    d.acc = 1.2;
    const men0 = d.men, cap0 = d.cap;
    const [half] = splitDivs(w, [d]);
    expect([half.men, half.cap]).toEqual([40, 40]);
    expect([d.men, d.cap]).toEqual([41, 41]);
    expect(d.men + half.men).toBe(men0);
    expect(d.cap + half.cap).toBe(cap0);
    expect(d.men).toBeLessThanOrEqual(d.cap);
    expect(half.men).toBeLessThanOrEqual(half.cap);
    expect(half.acc).toBeCloseTo(1.2 * 40 / 81, 12);        // credit follows the men, none is minted
    expect(d.acc + half.acc).toBeCloseTo(1.2, 12);

    const e = at(w, 1, B.x + 4.5, y, 40, 41);               // even men, odd capacity
    const [m] = splitDivs(w, [e]);
    expect([m.men, m.cap]).toEqual([20, 20]);
    expect([e.men, e.cap]).toEqual([20, 21]);
    expect(m.acc).toBe(0);                                  // a creditless parent hands nothing down
  });

  it('a split with nowhere to stand conserves men, capacity and credit', () => {
    const w = mkWorld();
    for (let i = 0; i < W * H; i++) w.terr[i] = WATER;
    w.terr[25 * W + 25] = LAND;
    const d = at(w, 1, 25.5, 25.5, 100, 100);
    d.acc = 2;
    expect(splitDivs(w, [d])).toHaveLength(0);
    expect([d.men, d.cap, d.acc]).toEqual([100, 100, 2]);
    expect(w.divs).toHaveLength(1);
  });
});

describe('absorbed donors leave the fight', () => {
  it('sums merged credit up to the bank cap and keeps the absorbed body out of the fight', () => {
    const w = mkWorld(), B = landBlock(w, 8, 2), y = B.y + .5;
    const a = at(w, 1, B.x + .5, y, 50, 50);
    const b = at(w, 1, B.x + 1.7, y, 50, 50);
    const foe = at(w, 2, B.x + 3.4, y, 60, 60);             // in reach of the donor, not of the absorber
    a.acc = 2; b.acc = 2;
    expect(mergeDivs([a, b]).absorbed[0]).toBe(b);
    expect(a.acc).toBe(3);                                  // 2 + 2 is banked only up to the cap of 3
    expect(b.acc).toBe(0);
    expect([a.men, b.men]).toEqual([100, 0]);

    // the absorbed donor stands inside melee range of the enemy but is already inert
    expect(Math.hypot(foe.x - b.x, foe.y - b.y)).toBeLessThan(RANGE);
    expect(Math.hypot(foe.x - a.x, foe.y - a.y)).toBeGreaterThan(RANGE);
    combat(w, STEP);
    expect(w.fights).toHaveLength(0);
    expect([a.eng, b.eng, foe.eng]).toEqual([false, false, false]);
    expect([a.men, b.men, foe.men]).toEqual([100, 0, 60]);

    // a live enemy in reach still fights
    const live = at(w, 2, B.x + .5, y + 1.5, 60, 60);
    combat(w, STEP);
    expect(w.fights).toHaveLength(1);
    expect([a.eng, live.eng]).toEqual([true, true]);
    expect(live.men).toBeLessThan(60);

    // a smaller credit sum is banked in full
    const w2 = mkWorld(), B2 = landBlock(w2, 4, 2), y2 = B2.y + .5;
    const p = at(w2, 1, B2.x + .5, y2, 50, 50);
    const q = at(w2, 1, B2.x + 1.5, y2, 50, 50);
    p.acc = 1; q.acc = .5;
    mergeDivs([p, q]);
    expect(p.acc).toBe(1.5);
  });
});

describe('result contracts', () => {
  it('returns the new halves and the absorbed donor objects, keeping ids stable', () => {
    const w = mkWorld(), B = landBlock(w, 4, 2), y = B.y + .5;
    const d = at(w, 1, B.x + .5, y, 100, 100);
    const added = splitDivs(w, [d]);
    expect(Array.isArray(added)).toBe(true);
    expect(added).toHaveLength(1);
    const half = added[0];
    expect([half.owner, half.type]).toEqual([d.owner, d.type]);
    expect(typeof half.id).toBe('number');
    expect(w.divs).toContain(half);
    const res = mergeDivs([d, half]);
    expect(Array.isArray(res.absorbed)).toBe(true);
    expect(res.absorbed[0]).toBe(half);                     // the donor object itself, for id mapping
    expect([d.men, d.cap]).toEqual([100, 100]);
    expect([half.men, half.merged]).toEqual([0, true]);
  });
});
