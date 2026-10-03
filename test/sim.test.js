import { describe, it, expect } from 'vitest';
import { W, H, STEP, TYPES, WATER, LAND, ISOLATED_COMBAT, PUSH_BASE, SPEED } from '../src/config.js';
import { createWorld, subscribe, setOwner } from '../src/sim/world.js';
import { findPath, nearestLand } from '../src/sim/pathfinding.js';
import { raiseDivision, spawnDiv, issueMove, issueFormation, splitDivs, mergeDivs } from '../src/sim/divisions.js';
import { formationSlots, MAX_FORMATION_POINTS } from '../src/sim/formations.js';
import { applyCommand } from '../src/sim/commands.js';
import { moveDivs } from '../src/sim/movement.js';
import { MIN_SEP, stepAround, indexBodies, freeTileNear } from '../src/sim/collision.js';
import { tick, checkEnd } from '../src/sim/game.js';
import { updateLogistics, logisticsDistance, combatMult } from '../src/sim/supply.js';
import { combat, hit } from '../src/sim/combat.js';
import { visibleDivs } from '../src/sim/vision.js';
import { tileOf } from '../src/sim/geom.js';

const mkWorld = (seed = 12345, opts = {}) => createWorld(seed, { humans: [], aiDelay: 1, ...opts });
const run = (w, seconds) => { for (let t = 0; t < seconds / STEP && !w.over; t++) tick(w, STEP); };
/** A land tile owned by nobody, far from all spawns, for staging isolated fights. */
function emptyLand(w, minDist = 12) {
  for (let i = 0; i < W * H; i++) {
    if (w.terr[i] === WATER || w.owner[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (w.cities.every(c => Math.hypot(c.x - x, c.y - y) > minDist)) return { x: x + .5, y: y + .5 };
  }
  throw new Error('no empty land');
}
/** A land tile owned by nobody whose eight neighbours are unowned too: nothing connects a division there. */
function cutOffLand(w) {
  for (let i = 0; i < W * H; i++) {
    if (w.terr[i] === WATER || w.owner[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++)
      if (w.owner[(y + dy) * W + x + dx]) { ok = false; break; }
    if (ok) return { x: x + .5, y: y + .5 };
  }
  throw new Error('no cut-off land');
}
/** Top-left tile of the first `len` consecutive land tiles along a row (or a column when vertical). */
function landRun(w, len, vertical = false) {
  const nx = vertical ? 1 : len, ny = vertical ? len : 1;
  for (let y = 0; y + ny <= H; y++) for (let x = 0; x + nx <= W; x++) {
    let ok = true;
    for (let k = 0; k < Math.max(nx, ny) && ok; k++) {
      const i = vertical ? (y + k) * W + x : y * W + x + k;
      if (w.terr[i] === WATER) ok = false;
    }
    if (ok) return { x, y };
  }
  throw new Error('no land run');
}

/** Top-left tile of the first L of neutral land: `hlen` tiles across the top row, then `vlen` down the right column. */
function landL(w, hlen, vlen) {
  for (let y = 0; y + vlen <= H; y++) for (let x = 0; x + hlen <= W; x++) {
    let ok = true;
    for (let k = 0; k < hlen && ok; k++) { const i = y * W + x + k; if (w.terr[i] === WATER || w.owner[i]) ok = false; }
    for (let k = 0; k < vlen && ok; k++) { const i = (y + k) * W + x + hlen - 1; if (w.terr[i] === WATER || w.owner[i]) ok = false; }
    if (ok) return { x, y };
  }
  throw new Error('no land L');
}

/** Top-left of the first run of `len` neutral, empty plain-land tiles along a row. */
function neutralRun(w, len) {
  for (let y = 0; y < H; y++) for (let x = 0; x + len <= W; x++) {
    let ok = true;
    for (let k = 0; k < len && ok; k++) {
      const i = y * W + x + k;
      if (w.terr[i] !== LAND || w.owner[i] || w.cityAt[i] >= 0 || w.bld[i]) ok = false;
    }
    if (ok) return { x, y };
  }
  throw new Error('no neutral land run');
}

/** A `len`-wide neutral, empty plain-land row at least `gap` tiles from every city and from `avoid`. */
function wildRun(w, len = 5, avoid = [], gap = 12) {
  for (let y = 0; y < H; y++) for (let x = 0; x + len <= W; x++) {
    let ok = true;
    for (let k = 0; k < len && ok; k++) {
      const i = y * W + x + k;
      if (w.terr[i] !== LAND || w.owner[i] || w.cityAt[i] >= 0 || w.bld[i]) ok = false;
    }
    if (!ok) continue;
    const cx = x + 2, cy = y;
    if (w.cities.some(c => Math.hypot(c.x - cx, c.y - cy) <= gap)) continue;
    if (avoid.some(p => Math.hypot(p.x - cx, p.y - cy) <= gap)) continue;
    return { x, y };
  }
  throw new Error('no wild land run');
}

/** Plant `pid`'s city on a wild tile (test-local: the income tallies do not matter here). */
function installCity(w, pid, x, y) {
  const i = y * W + x;
  w.cityAt[i] = w.cities.length;
  const c = { idx: i, x, y, owner: pid, capital: false, rally: null };
  w.cities.push(c);
  setOwner(w, i, pid);
  return c;
}

describe('world generation', () => {
  it('creates enough land, a capital per enabled player, and consistent tallies', () => {
    const w = mkWorld();
    expect(w.landCount).toBeGreaterThan(W * H * 0.3);
    expect(w.players).toHaveLength(w.cityCapacity);
    expect(w.cities).toHaveLength(w.cityCapacity);
    for (const p of w.players) {
      if (!p.enabled) {                                          // seats this seed never handed out stay inert
        expect(p.alive).toBe(false);
        expect(p.tiles).toBe(0);
        continue;
      }
      expect(p.team).toBe(p.id);                                 // teams off: every player is its own side
      const cap = w.cities.find(c => c.capital && c.owner === p.id);
      expect(cap, p.name + ' capital').toBeTruthy();
      expect(p.tiles).toBeGreaterThanOrEqual(5);
    }
    const owned = w.owner.reduce((n, o) => n + (o ? 1 : 0), 0);
    expect(owned).toBe(w.players.reduce((n, p) => n + p.tiles, 0));
  });

  it('is deterministic per seed', () => {
    const a = mkWorld(99), b = mkWorld(99), c = mkWorld(100);
    expect(Buffer.from(a.terr).equals(Buffer.from(b.terr))).toBe(true);
    expect(Buffer.from(a.terr).equals(Buffer.from(c.terr))).toBe(false);
  });
});

describe('pathfinding', () => {
  it('stays on land and ends at the target', () => {
    const w = mkWorld();
    const a = w.cities[0], b = w.cities.find(c => c !== a && findPath(w, a.idx, c.idx));
    const path = findPath(w, a.idx, b.idx);
    expect(path.length).toBeGreaterThan(0);
    expect(path.at(-1)).toBe(b.idx);
    for (const t of path) expect(w.terr[t]).not.toBe(WATER);
  });

  it('walks around blocked tiles instead of cutting the corner between two of them', () => {
    const w = {                                                    // a bare land world: costs need terrain and roads
      w: W, h: H, terr: new Uint8Array(W * H).fill(LAND), roads: new Uint8Array(W * H),
    };
    const blocked = new Set([10 * W + 11, 11 * W + 10]);           // the two corners of a diagonal step
    const path = findPath(w, 10 * W + 10, 11 * W + 11, blocked);
    expect(path).not.toBeNull();
    expect(path.at(-1)).toBe(11 * W + 11);
    expect(path.length).toBeGreaterThan(1);                        // the straight diagonal is gone
    for (const t of path) expect(blocked.has(t)).toBe(false);      // and nothing walks through a body
  });

  it('refuses water and finds nearest land for a water click', () => {
    const w = mkWorld();
    // a water tile touching land (the map corner is farther than nearestLand searches)
    const water = w.terr.findIndex((t, i) => t === WATER && [i - 1, i + 1, i - W, i + W].some(j => w.terr[j] !== undefined && w.terr[j] !== WATER));
    expect(findPath(w, w.cities[0].idx, water)).toBeNull();
    const near = nearestLand(w, water % W, (water / W) | 0);
    expect(near).toBeGreaterThanOrEqual(0);
    expect(w.terr[near]).not.toBe(WATER);
  });
});

describe('divisions', () => {
  it('raising deducts the type cost and spawns the right unit', () => {
    const w = mkWorld(); const p = w.players[0]; p.pool = 1000; p.gold = 1000;
    for (const type of Object.keys(TYPES)) {
      const before = [p.pool, p.gold], d = raiseDivision(w, p, w.cities[0], type);
      expect(d.type).toBe(type);
      expect(d.men).toBe(TYPES[type].men);
      expect(before[0] - p.pool).toBe(TYPES[type].manpower);
      expect(before[1] - p.gold).toBe(TYPES[type].gold);
    }
  });

  it('refuses when reserves are short and reports why', () => {
    const w = mkWorld(); const p = w.players[0]; p.pool = 10;
    const events = []; subscribe(w, (t, d) => events.push([t, d]));
    expect(raiseDivision(w, p, w.cities[0], 'arm')).toBeNull();
    expect(events[0][0]).toBe('raiseFailed');
    expect(events[0][1].reason).toBe('funds');
    expect(p.pool).toBe(10);
    p.pool = 1000; p.gold = 5;
    expect(raiseDivision(w, p, w.cities[0], 'inf')).toBeNull();
    expect(events[1][1].reason).toBe('gold');
    expect(p.gold).toBe(5);
  });

  it('split conserves men and merge only joins same-type neighbours', () => {
    const w = mkWorld(); const at = emptyLand(w);
    const a = spawnDiv(w, 1, at.x, at.y, 100, 100, 'inf');
    const halves = splitDivs(w, [a]);
    expect(a.men + halves[0].men).toBe(100);
    const art = spawnDiv(w, 1, at.x + .5, at.y, 60, 60, 'art');
    const { absorbed } = mergeDivs([a, halves[0], art]);
    expect(absorbed).toEqual([halves[0]]);
    expect(a.men).toBe(100);
    expect(art.men).toBe(60);
  });

  it('moves along a path, faster for armor than infantry', () => {
    const w = mkWorld(); const at = emptyLand(w);
    const inf = spawnDiv(w, 1, at.x, at.y, 100, 100, 'inf'), arm = spawnDiv(w, 1, at.x, at.y + .01, 90, 90, 'arm');
    const target = nearestLand(w, at.x + 25, at.y);
    issueMove(w, [inf], target % W + .5, ((target / W) | 0) + .5);
    issueMove(w, [arm], target % W + .5, ((target / W) | 0) + .5);
    const x0 = inf.x; run(w, 3);
    expect(arm.x - at.x).toBeGreaterThan(inf.x - x0);
  });
});

describe('solid bodies', () => {
  /** All-land stub world: movement and placement on their own, with no water, economy or AI in the way. */
  const sand = () => ({
    w: W, h: H, terr: new Uint8Array(W * H).fill(LAND), owner: new Uint8Array(W * H),
    roads: new Uint8Array(W * H), divs: [], nextId: 1, time: 0, rand: () => .5, listeners: [],
    // teams off: a seat is its own side, so two owners are allied exactly when they are equal
    players: [1, 2, 3, 4, 5, 6].map(id => ({ id, enabled: true, alive: true, team: id }))
  });
  const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const centre = t => ({ x: (t % W) + .5, y: ((t / W) | 0) + .5 });

  /**
   * March for `seconds` and return the closest two bodies ever came. A body that leaves the map or
   * stands on water fails the test, so both invariants hold on every step, not just at the end. The
   * world clock advances as `tick` advances it, so a body nudged aside walks home within the march.
   */
  function march(w, seconds) {
    let min = Infinity;
    for (let t = 0; t < Math.round(seconds / STEP); t++) {
      w.time += STEP;
      moveDivs(w, STEP);
      for (const d of w.divs) {
        if (!(d.x >= 0 && d.x < W && d.y >= 0 && d.y < H)) throw new Error(`body left the map at ${d.x},${d.y}`);
        if (w.terr[tileOf(w, d)] === WATER) throw new Error(`body stood on water at ${d.x},${d.y}`);
      }
      for (let i = 0; i < w.divs.length; i++) for (let j = i + 1; j < w.divs.length; j++) min = Math.min(min, gap(w.divs[i], w.divs[j]));
    }
    return min;
  }

  it('friendly traffic nudges a parked body aside and it walks back to the exact spot', () => {
    const w = sand();
    const mover = spawnDiv(w, 1, 10.5, 10.5, 100, 100, 'inf');
    issueMove(w, [mover], 16.5, 10.5);
    expect(mover.path.at(-1)).toBe(10 * W + 16);
    const holder = spawnDiv(w, 1, 13.5, 10.5, 100, 100, 'inf');    // parks on the mover's line, mid-route
    const home = { x: holder.x, y: holder.y };
    let min = Infinity, shoved = 0, stride = 0, prev = { ...home };
    for (let t = 0; t < 20 / STEP; t++) {
      w.time += STEP;
      moveDivs(w, STEP);
      stride = Math.max(stride, gap(holder, prev));                // no tick moves it further than its own feet
      min = Math.min(min, gap(mover, holder));
      shoved = Math.max(shoved, gap(holder, home));
      prev = { x: holder.x, y: holder.y };
    }
    expect(stride).toBeLessThanOrEqual(SPEED * STEP + 1e-9);       // one stride a tick, however hard the traffic pushes
    expect(min).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);            // never entered
    expect(shoved).toBeGreaterThan(0.5);                           // displaced off its ground for a moment
    expect(holder.x).toBe(home.x); expect(holder.y).toBe(home.y);  // and back on it, to the hair
    expect(holder.anchor).toBeNull();
    expect(holder.path).toHaveLength(0);                           // the holder kept its own (empty) orders
    expect(mover.path).toHaveLength(0);                            // the mover walked its whole route
    expect(gap(mover, { x: 16.5, y: 10.5 })).toBeLessThan(1e-9);
  });

  it("an ally's parked body yields the lane like a teammate's and walks back to its spot", () => {
    const w = sand();
    w.players[1].team = 1;                                        // players 1 and 2 are on one side now
    const mover = spawnDiv(w, 1, 10.5, 10.5, 100, 100, 'inf');
    issueMove(w, [mover], 16.5, 10.5);
    const holder = spawnDiv(w, 2, 13.5, 10.5, 100, 100, 'inf');    // the ally parks on the mover's line
    const home = { x: holder.x, y: holder.y };
    let shoved = 0;
    for (let t = 0; t < 20 / STEP; t++) {
      w.time += STEP;
      moveDivs(w, STEP);
      shoved = Math.max(shoved, gap(holder, home));
    }
    expect(shoved).toBeGreaterThan(0.5);                           // nudged out of the way, not treated as a wall
    expect(holder.x).toBe(home.x); expect(holder.y).toBe(home.y);  // and back on its spot, to the hair
    expect(holder.anchor).toBeNull();
    expect(mover.path).toHaveLength(0);
    expect(gap(mover, { x: 16.5, y: 10.5 })).toBeLessThan(1e-9);
  });

  it('an enemy parked in the way is never displaced: the mover waits or goes round it', () => {
    const w = sand();
    const mover = spawnDiv(w, 1, 10.5, 10.5, 100, 100, 'inf');
    issueMove(w, [mover], 16.5, 10.5);
    const foe = spawnDiv(w, 2, 13.5, 10.5, 100, 100, 'inf');       // parks on the mover's line
    expect(march(w, 25)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);
    expect(foe.x).toBe(13.5); expect(foe.y).toBe(10.5);            // never nudged, never pushed
    expect(foe.anchor).toBeNull();
    expect(mover.path).toHaveLength(0);                            // went round it and arrived
    expect(gap(mover, { x: 16.5, y: 10.5 })).toBeLessThan(1e-9);
  });

  it('two movers heading at each other pass and both arrive', () => {
    const w = sand();
    const east = spawnDiv(w, 1, 10.5, 20.5, 100, 100, 'inf');
    issueMove(w, [east], 18.5, 20.5);
    const west = spawnDiv(w, 1, 18.5, 20.5, 100, 100, 'inf');     // parks on the destination, then heads back
    issueMove(w, [west], 10.5, 20.5);
    const eDest = east.path.at(-1), wDest = west.path.at(-1);
    expect(eDest).toBe(20 * W + 18);
    expect(wDest).toBe(20 * W + 10);
    expect(march(w, 30)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);
    expect(east.path).toHaveLength(0);                             // neither gave up: both walked their whole path
    expect(west.path).toHaveLength(0);
    expect(gap(east, centre(eDest))).toBeLessThan(1e-9);
    expect(gap(west, centre(wDest))).toBeLessThan(1e-9);
  });

  it('a causeway crowd never slides into the sea, and the body pushed aside comes back', () => {
    const w = sand();
    for (let i = 0; i < W * H; i++) w.terr[i] = WATER;             // a one-tile causeway across an ocean
    for (let x = 0; x < 30; x++) w.terr[25 * W + x] = LAND;
    const mover = spawnDiv(w, 1, 10.5, 25.5, 100, 100, 'inf');
    const parked = spawnDiv(w, 1, 14.5, 25.5, 100, 100, 'inf');
    issueMove(w, [mover], 20.5, 25.5);                             // past the parked body, along the causeway
    const home = { x: parked.x, y: parked.y };
    expect(march(w, 20)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);  // the slide never crosses the water or a body
    expect(w.terr[tileOf(w, mover)]).toBe(LAND);                   // whatever the crowd did, both stand on the causeway
    expect(w.terr[tileOf(w, parked)]).toBe(LAND);
    expect(parked.x).toBe(home.x); expect(parked.y).toBe(home.y);  // and the body pushed aside came back to the hair
    expect(parked.anchor).toBeNull();
  });

  it('a step never comes closer than MIN_SEP to a body it walks around', () => {
    const w = sand();
    const a = spawnDiv(w, 1, 10.5, 10.5, 100, 100, 'inf');
    const b = spawnDiv(w, 1, 11.5, 10.5, 100, 100, 'inf');
    b.x = 11.35; b.y = 10.5; b.px = b.x; b.py = b.y;               // b stands exactly 0.85 from a: touching
    b.path = [];                                                   // and it is not going anywhere
    a.path = [10 * W + 16];
    indexBodies(w);
    const p = stepAround(w, a, 1, 0, 0.055, STEP);                 // a drives straight into b's flank
    expect(p).toBeTruthy();
    expect(gap(p, b)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);      // the firm disc holds to the last hair
    expect(b.x).toBe(11.35);                                       // b is only ever moved aside ...
    expect(Math.abs(b.y - 10.5)).toBeGreaterThan(0);               // ... by what a tick's stride allows:
    expect(Math.abs(b.y - 10.5)).toBeLessThanOrEqual(SPEED * STEP + 1e-9);   // the rest of the clearance comes over the ticks that follow
    expect(march(w, 15)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);   // walking on keeps the distance
    expect(gap(a, centre(10 * W + 16))).toBeLessThan(1e-9);        // a still gets where it was going
    expect(b.x).toBe(11.35); expect(b.y).toBe(10.5);               // and b ends on its exact spot again
    expect(b.anchor).toBeNull();

    const f = spawnDiv(w, 1, 10.5, 30.5, 100, 100, 'arm');         // armour takes longer strides than infantry
    const g = spawnDiv(w, 1, 11.5, 30.5, 100, 100, 'inf');
    g.x = 11.35; g.y = 30.5; g.px = g.x; g.py = g.y;
    g.path = [];
    f.path = [30 * W + 16];
    expect(march(w, 15)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);   // a long stride opens the way the same way
    expect(gap(f, centre(30 * W + 16))).toBeLessThan(1e-9);
    expect(g.x).toBe(11.35); expect(g.y).toBe(30.5);
  });

  it('a crowded lane never shoves a parked body faster than its own feet, and it still comes home', () => {
    const w = sand();
    const holder = spawnDiv(w, 1, 26.5, 20.5, 100, 100, 'inf');
    const a = spawnDiv(w, 1, 25.65, 20.5, 100, 100, 'inf');
    const b = spawnDiv(w, 1, 26.5, 19.65, 100, 100, 'inf');
    const c = spawnDiv(w, 1, 27.35, 20.5, 100, 100, 'inf');
    issueMove(w, [a], 30.5, 20.5);                                 // three walkers crowd the holder at once:
    issueMove(w, [b], 26.5, 15.5);                                 // past it, away from it, and through it
    issueMove(w, [c], 22.5, 20.5);
    const home = { x: holder.x, y: holder.y };
    let min = Infinity, stride = 0, shoved = 0, prev = { ...home };
    for (let t = 0; t < 60 / STEP; t++) {
      w.time += STEP;
      moveDivs(w, STEP);
      stride = Math.max(stride, gap(holder, prev));                // whatever the crowd does to it
      shoved = Math.max(shoved, gap(holder, home));
      for (const m of [a, b, c]) min = Math.min(min, gap(m, holder));
      prev = { x: holder.x, y: holder.y };
    }
    expect(stride).toBeLessThanOrEqual(SPEED * STEP + 1e-9);       // no tick moves it more than one stride
    expect(shoved).toBeGreaterThan(0.5);                           // it did have to give way
    expect(min).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);            // and nobody ever entered anybody
    expect([a, b, c].every(d => d.path.length === 0)).toBe(true);  // all three still got through
    expect(holder.x).toBe(home.x); expect(holder.y).toBe(home.y);  // and it ended on its exact spot
    expect(holder.anchor).toBeNull();
  });

  it('a move order never steals the ground a displaced body is walking home to', () => {
    const w = sand();
    const holder = spawnDiv(w, 1, 20.55, 20.5, 100, 100, 'inf');
    holder.path = [];
    holder.anchor = { x: 20.95, y: 20.5 };                         // nudged off its tile centre, on its way back
    const u = spawnDiv(w, 1, 20.5, 18.5, 100, 100, 'inf');
    expect(Math.hypot(21.5 - holder.anchor.x, 20.5 - holder.anchor.y)).toBeLessThan(MIN_SEP);  // the tile next door is too close to it
    issueMove(w, [u], 21.5, 20.5);
    const slot = u.path.at(-1);
    expect(Math.hypot((slot % W) + .5 - 20.95, ((slot / W) | 0) + .5 - 20.5)).toBeGreaterThanOrEqual(MIN_SEP);
    expect(march(w, 45)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);   // nobody ever entered the returning body
    expect(u.path).toHaveLength(0);                                // the order still ran
    expect(gap(u, centre(slot))).toBeLessThan(1e-9);
    expect(holder.x).toBe(20.95); expect(holder.y).toBe(20.5);     // and it came home to the hair
    expect(holder.anchor).toBeNull();
  });

  it('a formation slot never steals the ground a displaced body is walking home to', () => {
    const w = sand();
    const holder = spawnDiv(w, 1, 20.55, 20.5, 100, 100, 'inf');
    holder.path = [];
    holder.anchor = { x: 20.95, y: 20.5 };
    const u = spawnDiv(w, 1, 20.5, 18.5, 100, 100, 'inf');
    issueFormation(w, [u], [[21.5, 20.5], [21.5, 20.5]]);          // a zero-length line onto the tile next door
    const slot = u.path.at(-1);
    expect(Math.hypot((slot % W) + .5 - 20.95, ((slot / W) | 0) + .5 - 20.5)).toBeGreaterThanOrEqual(MIN_SEP);
    expect(march(w, 45)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);
    expect(u.path).toHaveLength(0);
    expect(gap(u, centre(slot))).toBeLessThan(1e-9);
    expect(holder.x).toBe(20.95); expect(holder.y).toBe(20.5);
    expect(holder.anchor).toBeNull();
  });

  it('a unit ordered again is not fenced out by the ground it is still walking home to', () => {
    const w = sand();
    const u = spawnDiv(w, 1, 20.5, 18.5, 100, 100, 'inf');
    u.path = [];
    u.anchor = { x: 20.95, y: 20.5 };                              // displaced, on its way back
    expect(Math.hypot(21.5 - u.anchor.x, 20.5 - u.anchor.y)).toBeLessThan(MIN_SEP);  // the ordered tile centre is too close to that ground
    issueMove(w, [u], 21.5, 20.5);                                 // but that ground is its own: the order stands
    expect(u.path.at(-1)).toBe(20 * W + 21);
    expect(march(w, 15)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);
    expect(gap(u, centre(20 * W + 21))).toBeLessThan(1e-9);        // it landed on the tile it was sent to
    expect(u.anchor).toBeNull();
  });

  it('two movers meeting right in front of their goals still get past each other', () => {
    const w = sand();
    const a = spawnDiv(w, 1, 10.5, 10.5, 100, 100, 'inf');
    const b = spawnDiv(w, 1, 11.5, 10.5, 100, 100, 'inf');
    a.path = [10 * W + 11];                                        // a is ordered onto b's tile ...
    b.path = [10 * W + 10];                                        // ... and b onto a's: one step from home
    expect(march(w, 20)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);
    expect(a.path).toHaveLength(0);                                // both arrived instead of stalling on each other
    expect(b.path).toHaveLength(0);
    expect(gap(a, centre(10 * W + 11))).toBeLessThan(1e-9);
    expect(gap(b, centre(10 * W + 10))).toBeLessThan(1e-9);
  });

  it('a body wedged in a pinch backs out and still reaches its slot', () => {
    const w = sand();
    // Four units ordered onto one zero-length line: three slots ring the fourth, whose way to the
    // middle is pinched shut by the two touching bodies beside it. Nothing may be pushed and the
    // order stands, so the wedged unit has to walk out of the pocket and round the ring.
    const units = [0, 1, 2, 3].map(k => spawnDiv(w, 1, 20.5, 19.5 + k, 100, 100, 'inf'));
    issueFormation(w, units, [[27.5, 22.5], [27.5, 22.5]]);
    const goals = units.map(d => d.path.at(-1));
    expect(new Set(goals).size).toBe(4);                           // one distinct slot each
    expect(march(w, 30)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);
    units.forEach((d, k) => {
      expect(d.path).toHaveLength(0);                              // the pinch did not eat the order
      expect(d.x).toBeCloseTo((goals[k] % W) + .5, 9);             // and it ended on its own slot's centre
      expect(d.y).toBeCloseTo(((goals[k] / W) | 0) + .5, 9);
    });
  });

  it('a step may not cut a water corner, not even to reach a diagonal waypoint', () => {
    const w = sand();
    w.terr[11 * W + 10] = WATER;                                   // (10,11): the corner between (10,10) and (11,11)
    const d = spawnDiv(w, 1, 10.5, 10.5, 100, 100, 'inf');
    d.x = 10.98; d.y = 10.99; d.px = d.x; d.py = d.y;              // just inside the corner
    d.path = [11 * W + 11];                                        // ordered diagonally across it
    indexBodies(w);
    expect(stepAround(w, d, 0.72, 0.71, 0.085, STEP)).toBeNull();  // refused: the line crosses the water
    moveDivs(w, STEP);
    expect(tileOf(w, d)).toBe(10 * W + 10);                           // held, without touching the sea
    expect(d.path).toHaveLength(1);                                // and with its orders kept
  });

  it('spawns and splits never stack bodies', () => {
    const w = sand();
    const five = Array.from({ length: 5 }, () => spawnDiv(w, 1, 40.5, 40.5, 100, 100, 'inf'));
    expect(five.every(d => d)).toBe(true);                         // all five found ground
    expect(new Set(five.map(d => tileOf(w, d))).size).toBe(5);     // each on its own tile
    for (let i = 0; i < five.length; i++) for (let j = i + 1; j < five.length; j++)
      expect(gap(five[i], five[j])).toBeGreaterThanOrEqual(MIN_SEP);
    const parent = spawnDiv(w, 1, 40.5, 44.5, 100, 100, 'inf');
    const [half] = splitDivs(w, [parent]);
    expect(half).toBeTruthy();
    expect(tileOf(w, half)).not.toBe(tileOf(w, parent));
    expect(gap(half, parent)).toBeGreaterThanOrEqual(MIN_SEP);
    expect(parent.men + half.men).toBe(100);
  });

  it('recruits answering one rally point are given ground of their own', () => {
    const w = sand();
    w.players = [{ id: 1, enabled: true, alive: true, team: 1, pool: 500, gold: 500 }];
    w.cities = [{ x: 20, y: 20, owner: 1, capital: true, rally: 20 * W + 26 }];
    const p = w.players[0], city = w.cities[0];
    const first = raiseDivision(w, p, city, 'inf');
    const second = raiseDivision(w, p, city, 'inf');
    expect(first).toBeTruthy(); expect(second).toBeTruthy();
    expect(first.path.at(-1)).toBe(20 * W + 26);                   // the first heads for the rally point itself
    expect(second.path.at(-1)).not.toBe(first.path.at(-1));        // the second is sent to ground beside it
    expect(p.pool).toBe(500 - 2 * TYPES.inf.manpower);
  });

  it('a split half marches to its own ground instead of queueing on its parent', () => {
    const w = sand();
    const parent = spawnDiv(w, 1, 10.5, 10.5, 100, 100, 'inf');
    issueMove(w, [parent], 20.5, 10.5);
    const [half] = splitDivs(w, [parent]);
    expect(half).toBeTruthy();
    expect(half.path.at(-1)).not.toBe(parent.path.at(-1));         // sent beside the parent, not onto its tile
    expect(march(w, 20)).toBeGreaterThanOrEqual(MIN_SEP - 1e-7);
    expect(parent.path).toHaveLength(0);                           // both finished their march
    expect(half.path).toHaveLength(0);
  });

  it('classifies a client mirror by its moving flag, as the server classifies a real mover', () => {
    const w = sand();
    const mirror = { id: 1, owner: 1, type: 'inf', x: 10.5, y: 10.5, men: 100, cap: 100, path: [], eng: false, moving: true };
    w.divs.push(mirror);
    expect(freeTileNear(w, 10.5, 10.5)).toBe(10 * W + 10);         // on the move: its tile is still free ground
    mirror.moving = false;
    expect(freeTileNear(w, 10.5, 10.5)).not.toBe(10 * W + 10);     // standing still: its ground is taken
  });

  it('repeating a move order does not shuffle the destination', () => {
    const w = sand();
    const d = spawnDiv(w, 1, 10.5, 10.5, 100, 100, 'inf');
    issueMove(w, [d], 20.5, 10.5);
    const first = d.path.at(-1);
    issueMove(w, [d], 20.5, 10.5);
    issueMove(w, [d], 20.5, 10.5);
    expect(d.path.at(-1)).toBe(first);                             // the unit keeps the ground it was promised
  });

  it('a split with no ground to stand on costs no men', () => {
    const w = sand();
    for (let i = 0; i < W * H; i++) w.terr[i] = WATER;             // one island tile, nothing else to stand on
    w.terr[25 * W + 25] = LAND;
    const d = spawnDiv(w, 1, 25.5, 25.5, 100, 100, 'inf');
    expect(splitDivs(w, [d])).toHaveLength(0);
    expect(d.men).toBe(100);                                       // no half was made, so no men were lost
    expect(w.divs).toHaveLength(1);
  });

  it('an engaged division holds its path and carries on when the enemy is gone', () => {
    const w = mkWorld(12345, { aiDelay: 1e9 });
    const s = landRun(w, 9);
    const a = spawnDiv(w, 1, s.x + .5, s.y + .5, 400, 400, 'inf');
    const b = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 120, 120, 'inf');   // 1.0 apart: inside melee range
    issueMove(w, [a], s.x + 8.5, s.y + .5);
    expect(a.path.at(-1)).toBe(s.y * W + s.x + 8);
    const x0 = a.x;
    run(w, 1);
    expect(a.eng).toBe(true);                                      // locked in melee
    expect(w.divs.includes(b)).toBe(true);                         // enemy still standing
    expect(a.x).toBeCloseTo(x0 + PUSH_BASE, 9);                    // presses in at the shove's own pace, not its walking stride
    expect(a.path.length).toBeGreaterThan(0);                      // kept the order
    b.men = 0;                                                     // enemy destroyed
    run(w, 20);
    expect(a.path).toHaveLength(0);                                // carried on and arrived
    expect(a.x).toBeCloseTo(s.x + 8.5);
    expect(a.y).toBeCloseTo(s.y + .5);
  });

  it('a raise with no free ground left costs nothing and reports space', () => {
    const w = mkWorld(12345, { aiDelay: 1e9 });
    const p = w.players[0], city = w.cities.find(c => c.owner === p.id);
    expect(city).toBeTruthy();
    for (let y = city.y - 14; y <= city.y + 14; y++) for (let x = city.x - 14; x <= city.x + 14; x++)
      if (x >= 0 && y >= 0 && x < W && y < H) w.terr[y * W + x] = WATER;   // drown every approach to the city
    p.pool = 1000; p.gold = 1000;
    const events = []; subscribe(w, (t, d) => events.push([t, d]));
    expect(raiseDivision(w, p, city, 'inf')).toBeNull();
    expect(events.at(-1)[0]).toBe('raiseFailed');
    expect(events.at(-1)[1].reason).toBe('space');
    expect(events.at(-1)[1].need).toBeUndefined();                 // nothing was wanted, nothing was spent
    expect(p.pool).toBe(1000);
    expect(p.gold).toBe(1000);
  });
});

describe('formations', () => {
  /** All-land world stub with no divisions: the nearest tile is always free land, so polyline geometry is testable on its own. */
  const flat = () => ({ w: W, h: H, terr: new Uint8Array(W * H).fill(LAND) });

  it('lays a horizontal line out in draw order, independent of input order', () => {
    const w = mkWorld(); const s = landRun(w, 9);
    const mk = dx => spawnDiv(w, 1, s.x + dx + .5, s.y + .5, 100, 100, 'inf');
    const a = mk(0), b = mk(4), c = mk(8);
    const slots = formationSlots(w, [c, a, b], [[s.x + .5, s.y + .5], [s.x + 8.5, s.y + .5]]);
    expect(slots).toEqual([
      { id: a.id, tile: tileOf(w, a), x: s.x + .5, y: s.y + .5 },
      { id: b.id, tile: tileOf(w, b), x: s.x + 4.5, y: s.y + .5 },
      { id: c.id, tile: tileOf(w, c), x: s.x + 8.5, y: s.y + .5 }
    ]);
  });

  it('lays a vertical line out from top to bottom', () => {
    const w = mkWorld(); const s = landRun(w, 9, true);
    const mk = dy => spawnDiv(w, 1, s.x + .5, s.y + dy + .5, 100, 100, 'inf');
    const a = mk(0), b = mk(8);
    const slots = formationSlots(w, [b, a], [[s.x + .5, s.y + .5], [s.x + .5, s.y + 8.5]]);
    expect(slots).toEqual([
      { id: a.id, tile: tileOf(w, a), x: s.x + .5, y: s.y + .5 },
      { id: b.id, tile: tileOf(w, b), x: s.x + .5, y: s.y + 8.5 }
    ]);
  });

  it('mirrors the assignment when the line is drawn in reverse', () => {
    const w = mkWorld(); const s = landRun(w, 9);
    const a = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    const b = spawnDiv(w, 1, s.x + 8.5, s.y + .5, 100, 100, 'inf');
    const slots = formationSlots(w, [a, b], [[s.x + 8.5, s.y + .5], [s.x + .5, s.y + .5]]);
    expect(slots).toEqual([
      { id: b.id, tile: s.y * W + s.x + 8, x: s.x + 8.5, y: s.y + .5 },
      { id: a.id, tile: s.y * W + s.x, x: s.x + .5, y: s.y + .5 }
    ]);
  });

  it('gives a lone unit the midpoint of a two-point line', () => {
    const w = mkWorld(); const s = landRun(w, 9);
    const d = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    expect(formationSlots(w, [d], [[s.x + .5, s.y + .5], [s.x + 8.5, s.y + .5]]))
      .toEqual([{ id: d.id, tile: s.y * W + s.x + 4, x: s.x + 4.5, y: s.y + .5 }]);
  });

  it('spreads a compressed line over distinct tiles without moving its draw positions', () => {
    const w = flat();
    const units = [1, 2, 3, 4].map(id => ({ id, x: id, y: 0 }));
    const slots = formationSlots(w, units, [[0, 0], [1, 0]]);      // a one-tile line for four units
    expect(slots.map(s => s.id)).toEqual([1, 2, 3, 4]);            // equal keys keep the input order
    expect(slots.map(s => s.tile)).toEqual([0, 1, W, 2]);          // nearest free tiles: nobody stacks
    expect(slots.map(s => +s.x.toFixed(6))).toEqual([0, 0.333333, 0.666667, 1]);   // the drawn line is kept
    expect(slots.every(s => s.y === 0)).toBe(true);
  });

  it('spaces a bent curve by total arc length, not per vertex', () => {
    const w = flat();
    const pts = [[0, 0], [6, 0], [6, 8]];                  // arc lengths 6 + 8 = 14
    const units = [{ id: 1, x: .5, y: .5 }, { id: 2, x: 6, y: 4 }, { id: 3, x: 6, y: 8.5 }];
    expect(formationSlots(w, units, pts)).toEqual([
      { id: 1, tile: 0, x: 0, y: 0 },
      { id: 2, tile: W + 6, x: 6, y: 1 },                  // arc distance 7: one tile past the corner, not on it
      { id: 3, tile: 8 * W + 6, x: 6, y: 8 }
    ]);
  });

  it('mirrors a bent curve when its polyline is reversed', () => {
    const w = flat();
    const pts = [[6, 8], [6, 0], [0, 0]];
    const units = [{ id: 1, x: .5, y: .5 }, { id: 2, x: 6, y: 4 }, { id: 3, x: 6, y: 8.5 }];
    expect(formationSlots(w, units, pts)).toEqual([
      { id: 3, tile: 8 * W + 6, x: 6, y: 8 },
      { id: 2, tile: W + 6, x: 6, y: 1 },
      { id: 1, tile: 0, x: 0, y: 0 }
    ]);
  });

  it('gives a lone unit the arc midpoint of a bent curve', () => {
    const w = flat();
    expect(formationSlots(w, [{ id: 9, x: 0, y: 0 }], [[0, 0], [6, 0], [6, 8]]))
      .toEqual([{ id: 9, tile: W + 6, x: 6, y: 1 }]);
  });

  it('handles duplicate, closed and fully degenerate polylines without NaN', () => {
    const w = flat();
    // duplicate vertices add no length and never place a slot off the curve
    expect(formationSlots(w, [{ id: 1, x: 0, y: 0 }, { id: 2, x: 6, y: 0 }], [[0, 0], [0, 0], [6, 0], [6, 0]]))
      .toEqual([{ id: 1, tile: 0, x: 0, y: 0 }, { id: 2, tile: 6, x: 6, y: 0 }]);
    // a closed loop starts and ends on the same point, in id order; the second unit takes the next free tile
    expect(formationSlots(w, [{ id: 1, x: .5, y: .5 }, { id: 2, x: 2, y: .5 }], [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]))
      .toEqual([{ id: 1, tile: 0, x: 0, y: 0 }, { id: 2, tile: 1, x: 0, y: 0 }]);
    // a zero-length polyline collapses every unit onto its single point, so they take the nearest free tiles
    const deg = formationSlots(w, [{ id: 3, x: 9, y: 2 }, { id: 1, x: 0, y: 0 }, { id: 2, x: 4, y: 4 }], [[5, 5], [5, 5], [5, 5]]);
    expect(deg).toEqual([
      { id: 1, tile: 5 * W + 5, x: 5, y: 5 },
      { id: 2, tile: 4 * W + 5, x: 5, y: 5 },
      { id: 3, tile: 5 * W + 4, x: 5, y: 5 }
    ]);
  });

  it('clamps polyline points to the map and snaps slots to land', () => {
    const w = mkWorld(); const s = landRun(w, 5);
    const d = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    // both endpoints clamp to the same corner, so the whole line degenerates there
    expect(formationSlots(w, [d], [[-1e6, -1e6], [-1e6, -1e6]]))
      .toEqual([{ id: d.id, tile: nearestLand(w, 0, 0), x: 0, y: 0 }]);
    const e = spawnDiv(w, 1, s.x + 1.5, s.y + .5, 100, 100, 'inf');
    expect(formationSlots(w, [d, e], [[-1e6, -1e6], [1e6, 1e6]])).toEqual([
      { id: d.id, tile: nearestLand(w, 0, 0), x: 0, y: 0 },
      { id: e.id, tile: nearestLand(w, W - 1, H - 1), x: W - 1, y: H - 1 }
    ]);
    // a slot over water snaps to the nearest shore, exactly as a point move does
    const water = w.terr.findIndex((t, i) => t === WATER && [i - 1, i + 1, i - W, i + W].some(j => w.terr[j] !== undefined && w.terr[j] !== WATER));
    expect(water).toBeGreaterThanOrEqual(0);
    const wx = water % W, wy = (water / W) | 0;
    const [slot] = formationSlots(w, [d], [[wx, wy], [wx, wy]]);
    expect(slot.tile).toBe(nearestLand(w, wx, wy));
    expect(w.terr[slot.tile]).not.toBe(WATER);
  });

  it('rejects malformed or oversize formation polylines without touching paths', () => {
    const w = mkWorld(); const at = emptyLand(w);
    const d = spawnDiv(w, 1, at.x, at.y, 100, 100, 'inf');
    d.path = [7];                                          // sentinel: must survive rejected commands
    const max = Array.from({ length: MAX_FORMATION_POINTS }, (_, k) => [k % 40, k % 20]);
    for (const c of [
      { k: 'formation', ids: [d.id] },                                     // no points at all
      { k: 'formation', ids: [d.id], points: 'x' },                        // not an array
      { k: 'formation', ids: [d.id], points: [[1, 2]] },                   // fewer than two
      { k: 'formation', ids: [d.id], points: max.concat([[0, 0]]) },       // more than the shared bound
      { k: 'formation', ids: [d.id], points: [[1, 2, 3], [4, 5]] },        // pair is not two numbers
      { k: 'formation', ids: [d.id], points: [[NaN, 1], [2, 3]] },
      { k: 'formation', ids: [d.id], points: [[1, Infinity], [2, 3]] },
      { k: 'formation', ids: [d.id], points: [[1, '2'], [2, 3]] },
      { k: 'formation', ids: [d.id], points: [[1, 2], null] }
    ]) expect(applyCommand(w, 1, c)).toEqual({ ok: false });
    expect(d.path).toEqual([7]);
    // the two-point minimum and the exported bound are both accepted
    expect(applyCommand(w, 1, { k: 'formation', ids: [], points: [[0, 0], [1, 1]] })).toEqual({ ok: true, k: 'formation' });
    expect(applyCommand(w, 1, { k: 'formation', ids: [], points: max })).toEqual({ ok: true, k: 'formation' });
  });

  it('never commands units owned by another player', () => {
    const w = mkWorld(); const s = landRun(w, 5);
    const mine = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    const foe = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 100, 100, 'inf');
    expect(applyCommand(w, 1, { k: 'formation', ids: [mine.id, foe.id], points: [[s.x + .5, s.y + .5], [s.x + 4.5, s.y + .5]] }))
      .toEqual({ ok: true, k: 'formation' });
    expect(mine.path.at(-1)).toBe(nearestLand(w, s.x + 2.5, s.y + .5));   // the sole own unit takes the arc midpoint
    expect(foe.path).toEqual([]);
  });

  it('marches a command into the curved slots of an L-shaped polyline', () => {
    const w = mkWorld(12345, { aiDelay: 1e9 });            // no AI, so nothing disturbs the arrivals
    const L = landL(w, 5, 3);                              // 4 tiles across the top row, then 2 tiles down
    const pts = [[L.x + .5, L.y + .5], [L.x + 4.5, L.y + .5], [L.x + 4.5, L.y + 2.5]];   // genuinely noncollinear
    const units = [0, 1, 2].map(k => spawnDiv(w, 1, L.x + .5 + k, L.y + .5, 100, 100, 'inf'));
    // arc lengths 4 + 2 = 6 split over three units: start, mid-edge 3 tiles across on the corner's row, then the end
    const tiles = [L.y * W + L.x, L.y * W + L.x + 3, (L.y + 2) * W + L.x + 4];
    expect(applyCommand(w, 1, { k: 'formation', ids: units.map(d => d.id), points: pts }))
      .toEqual({ ok: true, k: 'formation' });
    run(w, 30);
    units.forEach((d, k) => {   // staged one tile apart along the start of the line, so ascending keys keep id order
      const tile = tiles[k];
      expect(d.path.length).toBe(0);
      expect(d.x).toBeCloseTo((tile % W) + .5);
      expect(d.y).toBeCloseTo(((tile / W) | 0) + .5);
      expect(d.men).toBeGreaterThan(0);
    });
  });
});

describe('combat', () => {
  it('a larger division inflicts more losses while both sides are in melee', () => {
    const w = mkWorld(); const at = emptyLand(w);
    const big = spawnDiv(w, 1, at.x, at.y, 120, 120), small = spawnDiv(w, 2, at.x + 1, at.y, 60, 60);
    run(w, 1);
    expect(big.eng).toBe(true);
    expect(small.eng).toBe(true);
    expect(small.men).toBeLessThan(60);
    expect(120 - big.men).toBeLessThan(60 - small.men);
  });

  it('artillery hurts a distant enemy without being engaged', () => {
    const w = mkWorld(); const at = emptyLand(w);
    const art = spawnDiv(w, 1, at.x, at.y, 60, 60, 'art'), tgt = spawnDiv(w, 2, at.x + 4, at.y, 100, 100);
    run(w, 1);
    expect(tgt.men).toBeLessThan(100);
    expect(art.eng).toBe(false);
    expect(art.men).toBeGreaterThan(55); // not being hit back at range
  });

  it('artillery cannot capture land', () => {
    const w = mkWorld(); const at = emptyLand(w);
    const art = spawnDiv(w, 1, at.x, at.y, 60, 60, 'art');
    const before = w.players[0].tiles; art.eng = false;
    run(w, 5);
    expect(w.players[0].tiles).toBe(before);
  });

  it('an ordered attacker pushes a slower defender back at the speed difference', () => {
    const stage = (attType, defType) => {
      const w = mkWorld(12345, { aiDelay: 1e9 });
      const s = landRun(w, 9);
      const att = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, attType);
      const def = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 100, 100, defType);   // one tile away: in melee
      issueMove(w, [att], s.x + 8.5, s.y + .5);                              // ordered straight at it
      return { w, att, def };
    };
    // armour onto infantry: the fastest push, exactly SPEED*(1.8-1)+PUSH_BASE over one step
    let { w, att, def } = stage('arm', 'inf');
    let x0 = def.x;
    tick(w, STEP);
    expect(att.eng).toBe(true);
    expect(def.x - x0).toBeCloseTo((SPEED * (TYPES.arm.speed - TYPES.inf.speed) + PUSH_BASE) * STEP, 9);
    expect(def.y).toBe(att.y);                             // straight back along the attacker's heading
    // infantry onto infantry: the baseline shove
    ({ w, att, def } = stage('inf', 'inf'));
    x0 = def.x;
    tick(w, STEP);
    expect(def.x - x0).toBeCloseTo(PUSH_BASE * STEP, 9);
    // infantry onto armour: the speed difference dominates, so nothing is pushed
    ({ w, att, def } = stage('inf', 'arm'));
    x0 = def.x;
    tick(w, STEP);
    expect(def.x).toBe(x0);
  });

  it('a defender with no order of its own never shoves back', () => {
    const w = mkWorld(12345, { aiDelay: 1e9 });
    const s = landRun(w, 9);
    const att = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'arm');      // no order: not an attacker
    const def = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 100, 100, 'inf');
    issueMove(w, [def], s.x + 8.5, s.y + .5);              // ordered away: its heading never points at att
    const x0 = att.x, y0 = att.y;
    tick(w, STEP);
    expect(def.eng).toBe(true);
    expect(att.x).toBe(x0); expect(att.y).toBe(y0);        // "defender" is not silently treated as an attacker
    expect(def.path.length).toBeGreaterThan(0);            // and the ordered one keeps its own order
  });

  it('a sustained push walks the pair forward as one instead of driving them apart', () => {
    const w = mkWorld(12345, { aiDelay: 1e9 });
    const s = landRun(w, 9);
    const att = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    const def = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 100, 100, 'inf');   // unordered: only the attacker shoves
    issueMove(w, [att], s.x + 8.5, s.y + .5);
    const step = PUSH_BASE * STEP;                          // inf onto inf: the baseline shove
    let ax = att.x, dx = def.x;
    for (let i = 0; i < 60; i++) {
      tick(w, STEP);
      expect(att.eng).toBe(true);                           // never shoved out of its own melee
      expect(def.eng).toBe(true);
      expect(att.x - ax).toBeCloseTo(step, 9);              // both bodies advance the same steady step
      expect(def.x - dx).toBeCloseTo(step, 9);
      ax = att.x; dx = def.x;
    }
  });

  it('two ordered enemies pushing at each other hold a line instead of stuttering', () => {
    const w = mkWorld(12345, { aiDelay: 1e9 });
    const s = landRun(w, 14);
    const att = spawnDiv(w, 1, s.x + 4.5, s.y + .5, 100, 100, 'inf');
    const def = spawnDiv(w, 2, s.x + 6.5, s.y + .5, 100, 100, 'inf');
    issueMove(w, [att], s.x + 13.5, s.y + .5);              // marching straight at each other
    issueMove(w, [def], s.x - .5, s.y + .5);
    run(w, 2);
    expect(att.eng && def.eng).toBe(true);                  // locked
    const step = PUSH_BASE * STEP, a0 = att.x, d0 = def.x;
    for (let i = 0; i < 80; i++) {
      tick(w, STEP);
      expect(att.eng).toBe(true);                           // equal shoves: neither one breaks contact
      expect(def.eng).toBe(true);
      expect(Math.abs(att.x - a0)).toBeLessThanOrEqual(step + 1e-9);  // each holds its line: no stride-long lurch
      expect(Math.abs(def.x - d0)).toBeLessThanOrEqual(step + 1e-9);
    }
    expect(Math.abs(att.x - a0)).toBeLessThan(1e-6);        // and after four seconds the line has not crept
    expect(Math.abs(def.x - d0)).toBeLessThan(1e-6);
  });

  it('a slower ordered attacker neither shoves nor is carried', () => {
    const w = mkWorld(12345, { aiDelay: 1e9 });
    const s = landRun(w, 9);
    const att = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    const def = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 100, 100, 'arm');   // faster than the attacker: no shove at all
    issueMove(w, [att], s.x + 8.5, s.y + .5);
    const ax = att.x, dx = def.x;
    for (let i = 0; i < 60; i++) tick(w, STEP);
    expect(att.eng).toBe(true);
    expect(att.x).toBe(ax);                                 // a slower order just holds, it does not creep
    expect(def.x).toBe(dx);                                 // and nothing is pushed the other way
  });

  it("a push stops cleanly at the attacker's ordered destination", () => {
    const w = mkWorld(12345, { aiDelay: 1e9 });
    const s = landRun(w, 14);
    const att = spawnDiv(w, 1, s.x + 2.5, s.y + .5, 200, 200, 'arm');
    const def = spawnDiv(w, 2, s.x + 4.5, s.y + .5, 200, 200, 'inf');   // unordered: it just gets pushed
    issueMove(w, [att], s.x + 5.5, s.y + .5);
    const goal = s.x + 5.5, step = (SPEED * (TYPES.arm.speed - TYPES.inf.speed) + PUSH_BASE) * STEP;
    let guard = 0;
    while (att.x < goal && guard++ < 400) tick(w, STEP);
    expect(att.x).toBeGreaterThanOrEqual(goal);             // the pushing walk carries it to its order
    expect(att.x - goal).toBeLessThanOrEqual(step + 1e-9);  // and no further than the step that got it there
    const ax = att.x, dx = def.x, men = def.men;
    run(w, 1);
    expect(att.eng).toBe(true);                             // still in melee
    expect(att.x).toBeCloseTo(ax, 9);                       // order done: no creep past it, no recoil
    expect(def.x).toBeCloseTo(dx, 9);                       // a pair at rest is at rest, not oscillating
    expect(def.men).toBeLessThan(men);                      // while the fight itself goes on
  });
});

describe('teams', () => {
  /** Three two-player teams: 1+2, 3+4 and 5+6, with every seat enabled. */
  const teamWorld = () => mkWorld(12345, { aiDelay: 1e9, settings: { teams: [1, 1, 2, 2, 3, 3], teamCount: 3 } });

  it('allied units never fight; the same pair turns hostile the moment the pact breaks', () => {
    const w = teamWorld();
    expect([w.players[0].team, w.players[1].team]).toEqual([1, 1]);
    const at = emptyLand(w);
    const a = spawnDiv(w, 1, at.x, at.y, 100, 100, 'inf');
    const b = spawnDiv(w, 2, at.x + 1, at.y, 100, 100, 'inf');       // in melee range of a
    const art = spawnDiv(w, 1, at.x + 4, at.y, 60, 60, 'art');       // an ally inside artillery range
    for (let i = 0; i < 1 / STEP; i++) combat(w, STEP);
    expect(w.fights).toEqual([]);                                    // no melee, no shells, no pushes
    expect([a.men, b.men, art.men]).toEqual([100, 100, 60]);
    expect(a.eng || b.eng).toBe(false);
    w.players[1].team = 2;                                           // the pact breaks
    for (let i = 0; i < 1 / STEP; i++) combat(w, STEP);
    expect(w.fights.length).toBeGreaterThan(0);
    expect(b.men).toBeLessThan(100);
    expect(a.men).toBeLessThan(100);                                 // the fight is mutual, not one-sided
  });

  it("an ally's ground is never captured, but it feeds a capture like home soil", () => {
    const w = teamWorld();
    const s = neutralRun(w, 8);
    const beach = s.y * W + s.x;
    setOwner(w, beach, 2);                                           // the ally's beachhead
    const d = spawnDiv(w, 1, s.x + 1.5, s.y + .5, 100, 100, 'inf');
    expect(d).not.toBeNull();
    expect(w.terr[tileOf(w, d)]).not.toBe(WATER);
    const before = w.players[0].tiles;
    run(w, 20);
    expect(w.owner[beach]).toBe(2);                                  // ally ground survives inside the capture radius
    expect(w.players[0].tiles).toBeGreaterThan(before);              // while neutral ground beside it is taken
    setOwner(w, beach, 3);                                           // the same tile, now hostile
    run(w, 20);
    expect(w.owner[beach]).toBe(1);                                  // the skip was the alliance, not the geometry
  });

  it('allies share eyes: allied bodies are always visible and allied divisions and cities spot', () => {
    const w = teamWorld();
    const lone = wildRun(w, 8, [], 12);                              // a clear row far from every city
    const scout = spawnDiv(w, 2, lone.x + .5, lone.y + .5, 100, 100, 'inf');   // an ally alone in the wild
    const seen = spawnDiv(w, 3, lone.x + 3.5, lone.y + .5, 100, 100, 'inf');   // an enemy within VISION of that ally
    expect(visibleDivs(w, 1, true)).toContain(scout);                // an ally's body needs no spotter
    expect(visibleDivs(w, 1, true)).toContain(seen);                 // and the ally's eyes work for me
    expect(visibleDivs(w, 0, true)).toEqual([]);                     // a fogged spectator (id 0) is nobody's ally
    expect(visibleDivs(w, 5, true)).toEqual([]);                     // nothing leaks to a third party
    // an allied city is an eye too, and stops being one the moment it changes hands
    const runRow = wildRun(w, 5, [{ x: lone.x + .5, y: lone.y + .5 }, { x: lone.x + 3.5, y: lone.y + .5 }], 12);
    const city = installCity(w, 2, runRow.x + 1, runRow.y);
    const near = spawnDiv(w, 3, runRow.x + 3.5, runRow.y + .5, 100, 100, 'inf');
    expect(visibleDivs(w, 1, true)).toContain(near);                 // spotted by the allied city
    expect(visibleDivs(w, 6, true)).toEqual([]);                     // still nothing for a third party
    setOwner(w, city.idx, 3);                                        // the enemy overruns the city
    expect(visibleDivs(w, 1, true)).not.toContain(near);
  });

  it("victory aggregates a side's land and names the winning team with its roster", () => {
    const w = teamWorld();
    const need = Math.ceil(w.landCount * w.settings.victoryShare);
    expect(w.players[0].tiles).toBeLessThan(need);                   // no ally reaches the share alone
    w.players[0].tiles = need - 50;
    w.players[1].tiles = 60;
    checkEnd(w);
    expect(w.over).toBe(true);
    expect(w.result).toMatchObject({ winnerId: 1, reason: 'land', winnerTeam: 1, teamMembers: [1, 2] });
    expect(w.result.pct).toBeGreaterThanOrEqual(Math.floor(w.settings.victoryShare * 100));
  });

  it('the last side standing wins as a side, not as a survivor list', () => {
    const w = teamWorld();
    for (const p of w.players) if (p.enabled) p.tiles = p.id <= 2 ? 100 : 0;
    checkEnd(w);
    expect(w.over).toBe(true);
    expect(w.result).toMatchObject({ winnerId: 1, reason: 'last', winnerTeam: 1, teamMembers: [1, 2] });
  });

  it("a human's seat lives while any teammate stands; 'humans' fires only when the whole side is gone", () => {
    const w = mkWorld(12345, { humans: ['Me'], aiDelay: 1e9, settings: { teams: [1, 1, 2, 2, 3, 3], teamCount: 3 } });
    expect(w.players[0].seat).toBe(true);
    for (const p of w.players) if (p.enabled) p.tiles = p.id === 1 ? 0 : 5;
    checkEnd(w);
    expect(w.over).toBe(false);                                      // the teammate carries the seat
    expect(w.players[0].alive).toBe(false);
    w.players[1].tiles = 0;                                          // the last teammate falls
    checkEnd(w);
    expect(w.over).toBe(true);
    expect(w.result).toMatchObject({ winnerId: null, reason: 'humans', winnerTeam: null, teamMembers: [] });
  });

  it('FFA results keep their original shape: the winner is its own side', () => {
    const w = mkWorld();
    w.players[0].tiles = Math.ceil(w.landCount * w.settings.victoryShare);
    checkEnd(w);
    expect(w.result).toMatchObject({ winnerId: 1, reason: 'land', winnerTeam: 1, teamMembers: [1] });
    expect(w.result.winnerTeam).toBe(w.result.winnerId);
  });
});

describe('logistics', () => {
  it('a division cut off from its supply line fights worse without ever losing men to it', () => {
    const w = mkWorld(12345, { aiDelay: 1e9 });
    const cut = cutOffLand(w);
    const d = spawnDiv(w, 1, cut.x, cut.y, 100, 100, 'art');
    const home = w.cities.find(c => c.owner === 1);
    const h = spawnDiv(w, 1, home.x + .5, home.y + .5, 100, 100, 'art');
    updateLogistics(w);
    expect(logisticsDistance(w, d)).toBe(Infinity);        // nothing connects this tile to a held city
    expect(Number.isFinite(logisticsDistance(w, h))).toBe(true);
    run(w, 5);
    expect(d.oos).toBe(true);
    expect(h.oos).toBe(false);
    expect(d.men).toBe(100);                               // isolation is not attrition
    expect(h.men).toBe(100);
    // the same attacker hits softer when it is the one cut off, but never stops hitting
    w.rand = () => .5;                                     // the same dice for both swings
    const foeA = spawnDiv(w, 2, cut.x + 1, cut.y, 100, 100, 'inf');
    const foeB = spawnDiv(w, 2, home.x + 1.5, home.y + .5, 100, 100, 'inf');
    expect(combatMult(w, d)).toBe(ISOLATED_COMBAT);
    const cutHit = hit(w, d, foeA, 1), homeHit = hit(w, h, foeB, 1);
    expect(cutHit).toBeGreaterThan(0);
    expect(cutHit).toBeLessThan(homeHit);
  });
});

describe('full game', () => {
  // Long synchronous simulations must yield so the worker can acknowledge runner IPC.
  async function runCooperatively(world, seconds) {
    for (let remaining = seconds; remaining > 0 && !world.over; remaining -= 10) {
      run(world, Math.min(remaining, 10));
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  it('AI-only game runs without error, keeps tallies consistent and is deterministic', async () => {
    const summarize = w => w.players.map(p => p.tiles + ':' + w.divs.filter(d => d.owner === p.id).length).join(',');
    const a = mkWorld(777), b = mkWorld(777);
    await runCooperatively(a, 240);
    await runCooperatively(b, 240);
    expect(summarize(a)).toBe(summarize(b));
    const owned = a.owner.reduce((n, o) => n + (o ? 1 : 0), 0);
    expect(owned).toBe(a.players.reduce((n, p) => n + p.tiles, 0));
    for (const d of a.divs) expect(Number.isFinite(d.men)).toBe(true);
  }, 180000);

  // A whole AI-only game on the full map: several hundred simulated seconds of six players fighting,
  // pathfinding and raising divisions. It carries its own budget so a loaded machine cannot turn a
  // slow run into a failure — the assertion below is what the test is about, not the clock.
  it('eventually ends with a result', async () => {
    const w = mkWorld(4242);
    await runCooperatively(w, 1800);
    expect(w.over).toBe(true);
    expect(w.result.reason).toMatch(/land|last/);
  }, 180000);
});
