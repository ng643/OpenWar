// The routing slice under test: a division mauled in combat breaks away along a real escape route
// (never a teleport), is locked for good when it is intercepted, and otherwise resumes the order it
// was executing once it has recovered. Explicit route orders walk every checkpoint of their polyline,
// a jammed checkpoint is never dropped, and a column marches its shared bends single file at its
// slowest member's pace with a spaced final slot of its own.
import { describe, it, expect } from 'vitest';
import {
  W, H, STEP, LAND, WATER, TYPES, SPEED,
  ROUT_FRAC, ROUT_RECOVER_FRAC, ROUT_MIN_DISTANCE, ROUT_MAX_DISTANCE, COLUMN_SPACING, MAX_ROUTE_POINTS
} from '../src/config.js';
import { createWorld } from '../src/sim/world.js';
import { spawnDiv, issueMove, haltDivs } from '../src/sim/divisions.js';
import { applyCommand } from '../src/sim/commands.js';
import { issueRoute } from '../src/sim/routing.js';
import { moveDivs } from '../src/sim/movement.js';
import { tileOf } from '../src/sim/geom.js';
import { tick } from '../src/sim/game.js';

/** A world whose AI never thinks, so only the fixture moves. */
const mkWorld = (seed = 12345) => createWorld(seed, { humans: [], aiDelay: 1e9 });
const run = (w, seconds) => { for (let t = 0; t < seconds / STEP && !w.over; t++) tick(w, STEP); };

/** A land tile with `half` land tiles on either side along its row: room to break off both ways. */
function landMiddle(w, half = 12) {
  for (let y = 0; y < H; y++) for (let x = half; x + half < W; x++) {
    let ok = true;
    for (let k = -half; k <= half && ok; k++) if (w.terr[y * W + x + k] === WATER) ok = false;
    if (ok) return { x, y };
  }
  throw new Error('no land middle');
}

/** Top-left tile of the first L of neutral land: `hlen` across the top row, then `vlen` down the right column. */
function landL(w, hlen, vlen) {
  for (let y = 0; y + vlen <= H; y++) for (let x = 0; x + hlen <= W; x++) {
    let ok = true;
    for (let k = 0; k < hlen && ok; k++) { const i = y * W + x + k; if (w.terr[i] === WATER || w.owner[i]) ok = false; }
    for (let k = 0; k < vlen && ok; k++) { const i = (y + k) * W + x + hlen - 1; if (w.terr[i] === WATER || w.owner[i]) ok = false; }
    if (ok) return { x, y };
  }
  throw new Error('no land L');
}

/** A neutral land tile clear of the map edge and every city, for carving an island out of. */
function islandSpot(w) {
  for (let i = 0; i < W * H; i++) {
    if (w.terr[i] === WATER || w.owner[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < 4 || y < 4 || x > W - 5 || y > H - 5) continue;
    if (w.cities.every(c => Math.hypot(c.x - x, c.y - y) > 5)) return { x, y };
  }
  throw new Error('no island spot');
}

describe('teammates on the field', () => {
  it('a teammate in contact never fires, never breaks a rout and is never listed as a foe', () => {
    const w = createWorld(12345, { humans: [], aiDelay: 1e9, settings: { teams: [1, 1, 2, 2, 3, 3], teamCount: 3 } });
    const s = landMiddle(w);
    const mate = spawnDiv(w, 2, s.x + .5, s.y + .5, 100, 100, 'inf');       // same side as owner 1
    const runner = spawnDiv(w, 1, s.x + 1.5, s.y + .5, 100 * ROUT_FRAC - 5, 100, 'arm');
    tick(w, STEP);                                                          // a moment in contact, no more
    expect(mate.tookFire).toBe(false);
    expect(runner.tookFire).toBe(false);                                    // the ally never shoots
    expect(runner.routing).toBe(false);                                     // and never breaks it off
    expect(runner.routLocked).toBe(false);
    const foe = spawnDiv(w, 3, runner.x + 1, runner.y, 60, 100, 'inf');     // a real enemy joins
    tick(w, STEP);
    expect(runner.tookFire).toBe(true);
    expect(runner.routing).toBe(true);
    expect(runner.routFoes.has(foe.id)).toBe(true);                         // the enemy is the reason
    expect(runner.routFoes.has(mate.id)).toBe(false);                       // the ally never was
  });
});

describe('breaking off', () => {
  it('a division mauled in combat breaks away, and an interception locks it for good', () => {
    const w = mkWorld();
    const s = landMiddle(w);
    const runner = spawnDiv(w, 1, s.x + .5, s.y + .5, 100 * ROUT_FRAC - .5, 100, 'arm');
    spawnDiv(w, 2, s.x + 1.5, s.y + .5, 40, 100, 'inf');
    expect(runner.routing).toBe(false);
    const startX = runner.x, startY = runner.y;
    tick(w, STEP);
    expect(runner.tookFire).toBe(true);
    expect(runner.routing).toBe(true);
    expect(runner.path.length).toBeGreaterThan(0);
    // the escape is a walk on real land, a genuine distance away, and never a jump
    const fleeTile = runner.path.at(-1);
    expect(w.terr[fleeTile]).not.toBe(WATER);
    const fx = (fleeTile % W) + .5, fy = ((fleeTile / W) | 0) + .5;
    const stx = (startX | 0) + .5, sty = (startY | 0) + .5;
    const gap = Math.hypot(fx - stx, fy - sty);
    expect(gap).toBeGreaterThanOrEqual(ROUT_MIN_DISTANCE - 1e-9);
    expect(gap).toBeLessThanOrEqual(ROUT_MAX_DISTANCE + 1e-9);
    expect(Math.hypot(runner.x - startX, runner.y - startY)).toBeLessThan(.2);
    // the enemy it broke away from dies; a fresh enemy catches it: locked, never running again
    for (const u of w.divs) if (u.owner === 2) u.men = 0;
    tick(w, STEP);
    spawnDiv(w, 2, runner.x + 1, runner.y, 100, 100, 'inf');
    tick(w, STEP);
    expect(runner.eng).toBe(true);
    expect(runner.routLocked).toBe(true);
    expect(runner.routing).toBe(false);
    // field cleared and strength back: it still never breaks off again
    for (const u of w.divs) if (u.owner === 2) u.men = 0;
    runner.men = runner.cap * (ROUT_RECOVER_FRAC + .1);
    run(w, 5);
    expect(runner.routLocked).toBe(true);
    expect(runner.routing).toBe(false);
    expect(runner.path.length).toBe(0);
  });

  it('engaging again after breaking contact locks it, even against the same enemy', () => {
    const w = mkWorld();
    const s = landMiddle(w);
    const runner = spawnDiv(w, 1, s.x + .5, s.y + .5, 100 * ROUT_FRAC - .5, 100, 'arm');
    const foe = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 40, 100, 'inf');
    tick(w, STEP);
    expect(runner.routing).toBe(true);
    run(w, 1);                                    // the armor outruns the infantry: contact broken
    expect(runner.routClear).toBe(true);
    expect(runner.routing).toBe(true);
    const mx = runner.x - runner.px, my = runner.y - runner.py;
    const L = Math.hypot(mx, my);
    expect(L).toBeGreaterThan(0);
    foe.x = runner.x - (mx / L);                  // the same enemy re-engages from behind
    foe.y = runner.y - (my / L);
    tick(w, STEP);
    expect(runner.routLocked).toBe(true);
    expect(runner.routing).toBe(false);
  });

  it('a division with nowhere to run keeps holding its ground', () => {
    const w = mkWorld();
    const s = islandSpot(w);
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) continue;       // a 3x3 island, moat around it
      w.terr[(s.y + dy) * W + s.x + dx] = WATER;
    }
    const runner = spawnDiv(w, 1, s.x + .5, s.y + .5, 100 * ROUT_FRAC - .5, 100, 'arm');
    const foe = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 60, 100, 'inf');
    for (let t = 0; t < 100; t++) {
      runner.men = 100 * ROUT_FRAC - .5;          // mauled throughout: every tick wants to break off
      foe.men = 60;
      tick(w, STEP);
      expect(runner.routing).toBe(false);
      expect(runner.path.length).toBe(0);
    }
    expect(runner.eng).toBe(true);
    expect(w.terr[tileOf(w, runner)]).toBe(LAND);
  });

  it('an escape against a coast or the map edge still keeps the break-off distance', () => {
    // one tick of combat: where the escape landed, or that it held instead
    const measure = (prep, x, y, fx, fy) => {
      const w = mkWorld();
      prep(w);
      const d = spawnDiv(w, 1, x, y, 100 * ROUT_FRAC - .5, 100, 'inf');
      spawnDiv(w, 2, fx, fy, 100, 100, 'inf');
      const x0 = d.x, y0 = d.y;
      tick(w, STEP);
      if (!d.routing) return { routing: false, held: d.path.length === 0 && d.routRetryT > w.time };
      const t = d.path.at(-1);
      return { routing: true, gap: Math.hypot((t % W) + .5 - x0, ((t / W) | 0) + .5 - y0) };
    };
    const inBand = (r) => {
      expect(r.routing).toBe(true);
      expect(r.gap).toBeGreaterThanOrEqual(ROUT_MIN_DISTANCE - 1e-9);
      expect(r.gap).toBeLessThanOrEqual(ROUT_MAX_DISTANCE + 1e-9);
    };
    // a six-tile land bridge between two seas: straight away from the enemy is water, so the escape
    // has to run along the bridge instead of accepting a shore under the minimum
    inBand(measure((w) => {
      w.terr.fill(WATER);
      for (let y = 0; y < H; y++) for (let x = 20; x <= 25; x++) w.terr[y * W + x] = LAND;
    }, 22.5, 20.5, 21.5, 20.5));
    // a lake just south: the straight escape snaps to the near shore under the minimum
    inBand(measure((w) => {
      w.terr.fill(LAND);
      for (let y = 15; y <= 45; y++) for (let x = 5; x <= 50; x++) w.terr[y * W + x] = WATER;
    }, 25.5, 13.5, 25.5, 12.5));
    // the map edge: the straight escape runs off the map and snaps back under the minimum
    inBand(measure((w) => w.terr.fill(LAND), W - 2.5, 20.5, W - 3.5, 20.5));
    // an island with room: a qualified escape is found, inside the maximum
    inBand(measure((w) => {
      w.terr.fill(WATER);
      for (let y = 13; y <= 27; y++) for (let x = 23; x <= 37; x++) w.terr[y * W + x] = LAND;
    }, 30.5, 20.5, 31.5, 20.5));
  });

  it('an island too small for a break-off holds and retries instead of hopping short', () => {
    const w = mkWorld();
    w.terr.fill(WATER);
    for (let y = 18; y <= 22; y++) for (let x = 28; x <= 32; x++) w.terr[y * W + x] = LAND;
    const runner = spawnDiv(w, 1, 30.5, 20.5, 100 * ROUT_FRAC - .5, 100, 'inf');
    const foe = spawnDiv(w, 2, 31.5, 20.5, 100, 100, 'inf');
    for (let t = 0; t < 30; t++) {
      runner.men = 100 * ROUT_FRAC - .5;         // mauled throughout: every retry wants to break off
      foe.men = 100;
      tick(w, STEP);
      expect(runner.routing).toBe(false);
      expect(runner.path.length).toBe(0);
      expect(runner.routRetryT).toBeGreaterThan(w.time);   // the next attempt is scheduled, never relaxed
    }
    expect(runner.eng).toBe(true);
    expect(w.terr[tileOf(w, runner)]).toBe(LAND);
  });
});

describe('recovering', () => {
  it('resumes the order it was executing when it broke off', () => {
    const w = mkWorld();
    const s = landMiddle(w);
    const runner = spawnDiv(w, 1, s.x + .5, s.y + .5, 100 * ROUT_FRAC - .5, 100, 'arm');
    const dest = [s.x + 10.5, s.y + .5];
    issueMove(w, [runner], dest[0], dest[1]);
    const foe = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 40, 100, 'inf');
    tick(w, STEP);
    expect(runner.routing).toBe(true);
    expect(runner.routeResume.routePoints).toEqual([dest]);
    foe.men = 0;
    runner.men = runner.cap * (ROUT_RECOVER_FRAC + .1);
    tick(w, STEP);
    expect(runner.routing).toBe(false);
    expect(runner.routLocked).toBe(false);
    expect(runner.path.length).toBeGreaterThan(0);
    run(w, 30);
    expect(runner.x).toBeCloseTo(dest[0], 6);
    expect(runner.y).toBeCloseTo(dest[1], 6);
    expect(runner.path.length).toBe(0);
    expect(runner.routePoints.length).toBe(0);
  });

  it('queues an order issued during the rout instead of executing it', () => {
    const w = mkWorld();
    const s = landMiddle(w);
    const runner = spawnDiv(w, 1, s.x + .5, s.y + .5, 100 * ROUT_FRAC - .5, 100, 'arm');
    issueMove(w, [runner], s.x + 10.5, s.y + .5);
    const foe = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 40, 100, 'inf');
    tick(w, STEP);
    expect(runner.routing).toBe(true);
    const fleeTile = runner.path.at(-1);
    const dest = [s.x + 12.5, s.y + .5];
    issueMove(w, [runner], dest[0], dest[1]);
    expect(runner.path.at(-1)).toBe(fleeTile);          // the escape is not disturbed
    expect(runner.routeResume.routePoints).toEqual([dest]);
    foe.men = 0;
    runner.men = runner.cap * (ROUT_RECOVER_FRAC + .1);
    tick(w, STEP);
    expect(runner.routing).toBe(false);
    run(w, 30);
    expect(runner.x).toBeCloseTo(dest[0], 6);
    expect(runner.y).toBeCloseTo(dest[1], 6);
  });

  it('a halt during the rout leaves nothing to resume', () => {
    const w = mkWorld();
    const s = landMiddle(w);
    const runner = spawnDiv(w, 1, s.x + .5, s.y + .5, 100 * ROUT_FRAC - .5, 100, 'arm');
    issueMove(w, [runner], s.x + 10.5, s.y + .5);
    const foe = spawnDiv(w, 2, s.x + 1.5, s.y + .5, 40, 100, 'inf');
    tick(w, STEP);
    expect(runner.routing).toBe(true);
    haltDivs([runner]);
    expect(runner.routeResume).toBe(null);
    expect(runner.routing).toBe(true);                  // the escape itself carries on
    foe.men = 0;
    runner.men = runner.cap * (ROUT_RECOVER_FRAC + .1);
    tick(w, STEP);
    expect(runner.routing).toBe(false);
    run(w, 5);
    expect(runner.path.length).toBe(0);
    expect(runner.routePoints.length).toBe(0);
  });

  it('rebuilds a queued column order as its members recover from the rout', () => {
    const w = mkWorld();
    w.terr.fill(LAND);
    for (const p of w.players) p.pool = 0;
    const s = landMiddle(w);
    const sy = Math.min(s.y, H - 18);
    const u1 = spawnDiv(w, 1, s.x - 3.5, sy + .5, 100 * ROUT_FRAC - .5, 100, 'inf');
    const u2 = spawnDiv(w, 1, s.x - .5, sy + .5, 100 * ROUT_FRAC - .5, 100, 'arm');
    const u3 = spawnDiv(w, 1, s.x + 2.5, sy + .5, 100 * ROUT_FRAC - .5, 100, 'art');
    for (const d of [u1, u2, u3]) spawnDiv(w, 2, d.x + 1, d.y, 100, 100, 'inf');
    tick(w, STEP);
    expect([u1, u2, u3].every(d => d.routing)).toBe(true);
    for (const d of w.divs) if (d.owner === 2) d.men = 0;
    for (let t = 0; t < 60 && ![u1, u2, u3].every(d => d.routClear); t++) tick(w, STEP);
    expect([u1, u2, u3].every(d => d.routClear)).toBe(true);
    const P = [s.x + 2.5, sy + 6.5];
    const Q = [s.x + 2.5, sy + 16.5];
    const dist2 = (d) => (d.x - P[0]) ** 2 + (d.y - P[1]) ** 2;
    const units = [u1, u2, u3];
    const ids = units.slice().sort((a, b) => dist2(a) - dist2(b) || a.id - b.id).map(d => d.id);
    const byId = new Map(units.map(d => [d.id, d]));
    const flee = units.map(d => d.path.at(-1));
    issueRoute(w, units, [P, Q], { column: true });
    for (const d of units) {
      expect(d.routeResume.column).toBe(true);
      expect(d.routeResume.routePoints).toEqual([P, Q]);
      expect(d.routeResume.grp.ids).toEqual(ids);
    }
    expect(units.map(d => d.path.at(-1))).toEqual(flee);  // the escapes are not disturbed
    for (const id of ids) {                               // the stragglers recover one at a time
      const d = byId.get(id);
      d.men = d.cap * (ROUT_RECOVER_FRAC + .05);
      tick(w, STEP);
    }
    expect(ids.map(id => byId.get(id).routing)).toEqual([false, false, false]);
    expect(ids.map(id => byId.get(id).column)).toEqual([true, true, true]);
    expect(ids.map(id => byId.get(id).colIdx)).toEqual([0, 1, 2]);
    expect(ids.map(id => byId.get(id).colSpeed)).toEqual([TYPES.art.speed, TYPES.art.speed, TYPES.art.speed]);
    expect(ids.map(id => { const p = byId.get(id).colPrev; return p ? p.id : null; }))
      .toEqual([null, ids[0], ids[1]]);
    const cap = SPEED * TYPES.art.speed * STEP;
    let maxStep = 0, done = false;
    const prev = new Map(units.map(d => [d.id, { x: d.x, y: d.y }]));
    for (let t = 0; t < 3000 && !w.over; t++) {
      tick(w, STEP);
      for (const d of units) {
        const p = prev.get(d.id);
        maxStep = Math.max(maxStep, Math.hypot(d.x - p.x, d.y - p.y));
        p.x = d.x; p.y = d.y;
      }
      if (units.every(d => !d.path.length && !d.routePoints.length)) { done = true; break; }
    }
    expect(done).toBe(true);
    expect(maxStep).toBeLessThanOrEqual(cap + 1e-6);      // the whole rebuilt group holds the slowest pace
    ids.forEach((id, k) => {
      const d = byId.get(id);
      expect(d.x).toBeCloseTo(Q[0], 6);
      expect(d.y).toBeCloseTo(Q[1] - 2 * k, 6);           // unique slots, a rank apart
    });
    for (let k = 1; k < 3; k++) {
      const a = byId.get(ids[k - 1]), b = byId.get(ids[k]);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(COLUMN_SPACING - 1e-9);
    }
  });
});

describe('explicit routes', () => {
  it('walks every checkpoint of a multi-bend route in order', () => {
    const w = mkWorld();
    const s = landL(w, 12, 6);
    const d = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    const p1 = [s.x + 3.5, s.y + .5];
    const p2 = [s.x + 11.5, s.y + .5];                  // the corner of the L
    const p3 = [s.x + 11.5, s.y + 4.5];
    expect(applyCommand(w, 1, { k: 'route', ids: [d.id], points: [p1, p2, p3] })).toEqual({ ok: true, k: 'route' });
    expect(d.routePoints).toEqual([p1, p2, p3]);
    const corner = (p2[1] | 0) * W + (p2[0] | 0);
    const legs = [];
    let prev = null, visitedCorner = false;
    for (let t = 0; t < 2000 && (d.path.length || d.routePoints.length) && !w.over; t++) {
      tick(w, STEP);
      const dest = d.path.length ? d.path[d.path.length - 1] : null;
      if (dest !== null && dest !== prev) { legs.push(dest); prev = dest; }
      if (tileOf(w, d) === corner) visitedCorner = true;
    }
    expect(legs).toEqual([(p1[1] | 0) * W + (p1[0] | 0), corner, (p3[1] | 0) * W + (p3[0] | 0)]);
    expect(visitedCorner).toBe(true);
    expect(d.x).toBeCloseTo(p3[0], 6);
    expect(d.y).toBeCloseTo(p3[1], 6);
    expect(d.path.length).toBe(0);
    expect(d.routePoints.length).toBe(0);
  });

  it('never skips or replaces a checkpoint a body is sitting on', () => {
    const terr = new Uint8Array(8 * 3).fill(WATER);
    for (let x = 0; x < 8; x++) terr[8 + x] = LAND;     // row 1 is the only land
    const stub = {
      w: 8, h: 3, terr, owner: new Uint8Array(8 * 3), roads: new Uint8Array(8 * 3),
      divs: [], nextId: 1, time: 0, fights: [], listeners: {}, cities: [], rand: () => .5,
      players: [{ id: 1, enabled: true, team: 1 }],
    };
    const mover = spawnDiv(stub, 1, 1.5, 1.5, 100, 100, 'inf');
    const blocker = spawnDiv(stub, 1, 4.5, 1.5, 100, 100, 'inf');
    blocker.eng = true;                                 // engaged: it holds ground and is never nudged aside
    issueRoute(stub, [mover], [[4.5, 1.5], [6.5, 1.5]]);
    const first = 1 * 8 + 4;
    expect(mover.routePoints.length).toBe(2);
    for (let t = 0; t < 400; t++) {
      moveDivs(stub, STEP);
      expect(mover.routePoints.length).toBe(2);         // the jammed checkpoint is never dropped
      expect(mover.path.at(-1)).toBe(first);
    }
    expect(mover.x).toBeLessThan(4);                    // held up short of the checkpoint
    expect(stub.terr[tileOf(stub, mover)]).not.toBe(WATER);
    stub.divs.splice(stub.divs.indexOf(blocker), 1);    // the way clears
    for (let t = 0; t < 400; t++) moveDivs(stub, STEP);
    expect(mover.x).toBeCloseTo(6.5, 6);
    expect(mover.y).toBeCloseTo(1.5, 6);
    expect(mover.path.length).toBe(0);
    expect(mover.routePoints.length).toBe(0);
  });

  it('validates route orders, appends to them, and a plain move clears them', () => {
    const w = mkWorld();
    const s = landMiddle(w);
    const d = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    const p1 = [s.x + 5.5, s.y + .5], p2 = [s.x + 9.5, s.y + .5];
    expect(applyCommand(w, 1, { k: 'route', ids: [d.id], points: [] })).toEqual({ ok: false });
    expect(applyCommand(w, 1, { k: 'route', ids: [d.id], points: [[NaN, 1]] })).toEqual({ ok: false });
    expect(applyCommand(w, 1, { k: 'route', ids: [d.id], points: [[-1, 1]] })).toEqual({ ok: false });
    const tooMany = Array.from({ length: MAX_ROUTE_POINTS + 1 }, (_, i) => [s.x + (i % 10) + .5, s.y + ((i / 10) | 0) + .5]);
    expect(applyCommand(w, 1, { k: 'route', ids: [d.id], points: tooMany })).toEqual({ ok: false });
    expect(d.routePoints.length).toBe(0);
    expect(d.path.length).toBe(0);
    expect(applyCommand(w, 1, { k: 'route', ids: [d.id], points: [p1] })).toEqual({ ok: true, k: 'route' });
    expect(d.routePoints).toEqual([p1]);
    expect(applyCommand(w, 1, { k: 'route', ids: [d.id], points: [p2], append: true })).toEqual({ ok: true, k: 'route' });
    expect(d.routePoints).toEqual([p1, p2]);
    expect(applyCommand(w, 1, { k: 'move', ids: [d.id], x: s.x + 12.5, y: s.y + .5 })).toEqual({ ok: true, k: 'move' });
    expect(d.routePoints.length).toBe(0);
    expect(d.column).toBe(false);
    expect(d.path.at(-1)).toBe((s.y | 0) * W + (s.x + 12));
  });
});

describe('columns', () => {
  it('marches one path single file, spaced, and finishes', () => {
    const w = mkWorld();
    const s = landL(w, 14, 5);
    const lead = spawnDiv(w, 1, s.x + 4.5, s.y + .5, 100, 100, 'inf');
    const mid = spawnDiv(w, 1, s.x + 2.5, s.y + .5, 100, 100, 'arm');
    const tail = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'art');
    const A = [s.x + 8.5, s.y + .5];
    const B = [s.x + 13.5, s.y + .5];                   // the corner of the L
    const C = [s.x + 13.5, s.y + 4.5];
    expect(applyCommand(w, 1, { k: 'route', ids: [lead.id, mid.id, tail.id], points: [A, B, C], column: true }))
      .toEqual({ ok: true, k: 'route' });
    expect([lead.colIdx, mid.colIdx, tail.colIdx]).toEqual([0, 1, 2]);
    expect(lead.colSpeed).toBeCloseTo(TYPES.art.speed, 9);
    // the ordered endpoint for the leader, and a free slot of its own a rank behind it for each follower
    expect(lead.routePoints).toEqual([A, B, C]);
    expect(mid.routePoints).toEqual([A, B, [C[0], C[1] - 2]]);
    expect(tail.routePoints).toEqual([A, B]);
    const corner = (B[1] | 0) * W + (B[0] | 0);
    const startX = lead.x, startY = lead.y;
    let minGap = Infinity, visitedCorner = false, lead2s = 0, done = false;
    for (let t = 0; t < 2400 && !w.over; t++) {
      tick(w, STEP);
      minGap = Math.min(minGap, Math.hypot(lead.x - mid.x, lead.y - mid.y), Math.hypot(mid.x - tail.x, mid.y - tail.y));
      if (tileOf(w, lead) === corner || tileOf(w, mid) === corner || tileOf(w, tail) === corner) visitedCorner = true;
      if (t === Math.round(2 / STEP) - 1) lead2s = Math.hypot(lead.x - startX, lead.y - startY);
      if (!lead.path.length && !mid.path.length && !tail.path.length &&
          !lead.routePoints.length && !mid.routePoints.length && !tail.routePoints.length) { done = true; break; }
    }
    expect(done).toBe(true);
    expect(minGap).toBeGreaterThanOrEqual(COLUMN_SPACING - 1e-7);
    expect(visitedCorner).toBe(true);
    // a body lands exactly on every tile centre, so each arrival discards the rest of that tick's
    // step: two waypoints are crossed in the first two seconds, so the march finishes at the art pace
    // (never faster) and up to two partial steps short of it
    const pace = SPEED * TYPES.art.speed;
    expect(lead2s).toBeLessThanOrEqual(pace * 2 + 1e-9);
    expect(lead2s).toBeGreaterThan(pace * 2 - 2 * pace * STEP);
    expect(lead.x).toBeCloseTo(C[0], 6);
    expect(lead.y).toBeCloseTo(C[1], 6);
    expect(mid.x).toBeCloseTo(C[0], 6);
    expect(mid.y).toBeCloseTo(C[1] - 2, 6);
    expect(tail.x).toBeCloseTo(B[0], 6);
    expect(tail.y).toBeCloseTo(B[1], 6);
  });

  it('promotes the shared endpoint to a bend when the order is appended', () => {
    const w = mkWorld();
    const s = landMiddle(w);
    for (let y = Math.max(0, s.y - 2); y <= Math.min(H - 1, s.y + 12); y++) {
      for (let x = Math.max(0, s.x - 3); x <= Math.min(W - 1, s.x + 10); x++) w.terr[y * W + x] = LAND;
    }
    const a = spawnDiv(w, 1, s.x + 2.5, s.y + .5, 100, 100, 'inf');
    const b = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    const P = [s.x + 8.5, s.y + .5];
    const Q = [s.x + 8.5, s.y + 10.5];
    issueRoute(w, [a, b], [P], { column: true });
    expect(b.colSlot).toEqual([s.x + 6.5, s.y + .5]);     // the follower stands two tiles short of the bend
    expect(b.colTail).toEqual([P]);                       // and the shared bend is kept apart from its slot
    for (let t = 0; t < 10; t++) tick(w, STEP);
    issueRoute(w, [a, b], [Q], { append: true, column: true });
    expect(a.routePoints).toEqual([P, Q]);
    expect(b.routePoints).toEqual([P, [Q[0], Q[1] - 2]]); // it walks the bend first, then its own slot behind it
    expect(b.colTail).toEqual([Q]);
    let minA = Infinity, minB = Infinity, done = false;
    for (let t = 0; t < 4000 && !w.over; t++) {
      tick(w, STEP);
      minA = Math.min(minA, Math.hypot(a.x - P[0], a.y - P[1]));
      minB = Math.min(minB, Math.hypot(b.x - P[0], b.y - P[1]));
      if (!a.path.length && !b.path.length && !a.routePoints.length && !b.routePoints.length) { done = true; break; }
    }
    expect(done).toBe(true);
    expect(minA).toBeLessThan(.05);
    expect(minB).toBeLessThan(.05);                       // the follower walks the bend instead of cutting it
    expect(a.x).toBeCloseTo(Q[0], 6);
    expect(a.y).toBeCloseTo(Q[1], 6);
    expect(b.x).toBeCloseTo(Q[0], 6);
    expect(b.y).toBeCloseTo(Q[1] - 2, 6);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(COLUMN_SPACING - 1e-9);
  });

  it('a short final leg still carries the column up to the promoted bend', () => {
    const w = mkWorld();
    const s = landMiddle(w);
    for (let y = Math.max(0, s.y - 2); y <= Math.min(H - 1, s.y + 4); y++) {
      for (let x = Math.max(0, s.x - 3); x <= Math.min(W - 1, s.x + 10); x++) w.terr[y * W + x] = LAND;
    }
    const a = spawnDiv(w, 1, s.x + 2.5, s.y + .5, 100, 100, 'inf');
    const b = spawnDiv(w, 1, s.x + .5, s.y + .5, 100, 100, 'inf');
    const P = [s.x + 8.5, s.y + .5];
    const Q = [s.x + 8.5, s.y + 1.5];                     // one tile past the bend, shorter than the stagger
    issueRoute(w, [a, b], [P], { column: true });
    for (let t = 0; t < 10; t++) tick(w, STEP);
    issueRoute(w, [a, b], [Q], { append: true, column: true });
    expect(a.routePoints).toEqual([P, Q]);
    expect(b.routePoints).toEqual([[Q[0], Q[1] - 2]]);    // its slot is the one free tile past the bend
    expect(b.colTail).toEqual([P, Q]);                    // the whole shared route stays on the books
    let minA = Infinity, minB = Infinity, done = false;
    for (let t = 0; t < 4000 && !w.over; t++) {
      tick(w, STEP);
      minA = Math.min(minA, Math.hypot(a.x - P[0], a.y - P[1]));
      minB = Math.min(minB, Math.hypot(b.x - P[0], b.y - P[1]));
      if (!a.path.length && !b.path.length && !a.routePoints.length && !b.routePoints.length) { done = true; break; }
    }
    expect(done).toBe(true);
    expect(minA).toBeLessThan(.05);
    expect(minB).toBeLessThan(1.001);                     // it ends beside the bend, not two tiles short of it
    expect(a.x).toBeCloseTo(Q[0], 6);
    expect(a.y).toBeCloseTo(Q[1], 6);
    expect(b.x).toBeCloseTo(Q[0], 6);
    expect(b.y).toBeCloseTo(Q[1] - 2, 6);
  });
});
