import { describe, it, expect } from 'vitest';
import { createWorld, setOwner, setBuilding, setRoad, subscribe } from '../src/sim/world.js';
import { recount } from '../src/sim/buildings.js';
import { applyCommand } from '../src/sim/commands.js';
import { cedeLand } from '../src/sim/cession.js';
import { tick } from '../src/sim/game.js';
import { GOLD, LAND, STEP } from '../src/config.js';

/**
 * Six factions in three fixed alliances (1+2, 3+4, 5+6) — the sim.test.js team world, with the AI
 * parked an era away so ownership only ever moves where a test says it does.
 */
function mkWorld(seed = 12345) {
  return createWorld(seed, { humans: [], aiDelay: 1e9, settings: { teams: [1, 1, 2, 2, 3, 3], teamCount: 3 } });
}

/**
 * Top-left of the first `sw` x `sh` rectangle holding at least `need` neutral plain-land tiles and,
 * when `avoidPid` is set, none of that player's. Returns [x0, y0, x1, y1] (inclusive) or null.
 */
function plainRect(w, sw, sh, need, avoidPid = 0) {
  for (let y = 0; y + sh <= w.h; y++) for (let x = 0; x + sw <= w.w; x++) {
    let count = 0, ok = true;
    for (let j = y; j < y + sh && ok; j++) for (let i = x; i < x + sw && ok; i++) {
      const t = j * w.w + i;
      if (avoidPid && w.owner[t] === avoidPid) ok = false;
      else if (w.terr[t] === LAND && w.owner[t] === 0 && w.cityAt[t] < 0 && w.bld[t] === 0) count++;
    }
    if (ok && count >= need) return [x, y, x + sw - 1, y + sh - 1];
  }
  return null;
}

/** Claim every neutral plain-land tile of the rect for `pid`; returns the tile indices claimed. */
function claimRect(w, pid, [x0, y0, x1, y1]) {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w.w + x;
    if (w.terr[i] === LAND && w.owner[i] === 0 && w.cityAt[i] < 0 && w.bld[i] === 0) { setOwner(w, i, pid); out.push(i); }
  }
  return out;
}

/** Tile indices owned by `pid` inside an already-normalised rectangle. */
function ownedIn(w, pid, [x0, y0, x1, y1]) {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w.w + x;
    if (w.owner[i] === pid) out.push(i);
  }
  return out;
}

/** Record every sim event as a [kind, data] pair. */
function eventLog(w) {
  const ev = [];
  subscribe(w, (k, d) => ev.push([k, d]));
  return ev;
}

/** The first neutral map city, as [city, its tile index]. */
function neutralCity(w) {
  for (let i = 0; i < w.cityAt.length; i++) if (w.cityAt[i] >= 0 && w.owner[i] === 0) return [w.cities[w.cityAt[i]], i];
  return [null, -1];
}

describe('land cession', () => {
  it('cedes an inclusive rectangle to a teammate and reports the authoritative count', () => {
    const w = mkWorld();
    const rect = plainRect(w, 14, 8, 60, 1);          // wholly free of player 1's land before the claim
    expect(rect).not.toBeNull();
    const claimed = claimRect(w, 1, rect);
    expect(claimed.length).toBeGreaterThanOrEqual(60);
    expect(ownedIn(w, 1, rect)).toHaveLength(claimed.length);

    const t1 = w.players[0].tiles, t2 = w.players[1].tiles;
    const ev = eventLog(w);
    const v0 = w.ownerVersion;
    w.changes = [];
    const r = applyCommand(w, 1, { k: 'cede', to: 2, rect });
    expect(r).toEqual({ ok: true, k: 'cede', ceded: claimed.length });
    for (const i of claimed) expect(w.owner[i]).toBe(2);
    expect(w.players[0].tiles).toBe(t1 - claimed.length);
    expect(w.players[1].tiles).toBe(t2 + claimed.length);
    expect(w.ownerVersion).toBeGreaterThan(v0);

    // the server sees one owner delta per tile, all addressed to the recipient
    expect(w.changes).toHaveLength(claimed.length * 2);
    const deltas = new Map();
    for (let i = 0; i < w.changes.length; i += 2) deltas.set(w.changes[i], w.changes[i + 1]);
    for (const i of claimed) expect(deltas.get(i)).toBe(2);

    expect(ev).toEqual([['landCeded', { from: 1, to: 2, tiles: claimed.length }]]);

    // ceding the same ground again (now the sender owns none of it) is a harmless no-op
    const settled = Array.from(w.owner);
    expect(cedeLand(w, 1, 2, rect)).toEqual({ ok: true, ceded: 0 });
    expect(Array.from(w.owner)).toEqual(settled);
    expect(ev).toHaveLength(1);
  });

  it('normalises reversed drag corners and one-tile rectangles', () => {
    const w = mkWorld();
    const rect = plainRect(w, 12, 6, 40, 1);
    expect(rect).not.toBeNull();
    const claimed = claimRect(w, 1, rect);

    // a drag from bottom-right to top-left must cede the same rectangle
    const r = cedeLand(w, 1, 2, [rect[2], rect[3], rect[0], rect[1]]);
    expect(r).toEqual({ ok: true, ceded: claimed.length });
    for (const i of claimed) expect(w.owner[i]).toBe(2);

    // a plain click (x0 == x1, y0 == y1) follows the same path
    let t = -1;
    for (let i = 0; i < w.owner.length && t < 0; i++) {
      if (w.terr[i] === LAND && w.owner[i] === 0 && w.cityAt[i] < 0 && w.bld[i] === 0) t = i;
    }
    expect(t).toBeGreaterThan(-1);
    setOwner(w, t, 1);
    const x = t % w.w, y = (t - x) / w.w;
    expect(cedeLand(w, 1, 2, [x, y, x, y])).toEqual({ ok: true, ceded: 1 });
    expect(w.owner[t]).toBe(2);
  });

  it('moves only the sender\'s own land and ignores allies, enemies and neutral cells', () => {
    const w = mkWorld();
    const rect = plainRect(w, 10, 6, 40, 1);
    expect(rect).not.toBeNull();
    const [x0, y0, x1, y1] = rect;
    const free = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * w.w + x;
      if (w.terr[i] === LAND && w.owner[i] === 0 && w.cityAt[i] < 0 && w.bld[i] === 0) free.push(i);
    }
    const mine = free.slice(0, 12), ally = free.slice(12, 15), foe = free.slice(15, 17);
    expect(mine).toHaveLength(12); expect(ally).toHaveLength(3); expect(foe).toHaveLength(2);
    for (const i of mine) setOwner(w, i, 1);
    for (const i of ally) setOwner(w, i, 2);          // the recipient's own land inside the drag
    for (const i of foe) setOwner(w, i, 3);           // a third party's land, not ours to give

    const r = cedeLand(w, 1, 2, rect);
    expect(r).toEqual({ ok: true, ceded: 12 });
    for (const i of mine) expect(w.owner[i]).toBe(2);
    for (const i of ally) expect(w.owner[i]).toBe(2);  // untouched: it was already the recipient's
    for (const i of foe) expect(w.owner[i]).toBe(3);   // untouched: never the sender's to move
    for (const i of free.slice(17)) expect(w.owner[i]).toBe(0);
  });

  it('offers a large swath as one tiny command', () => {
    const w = mkWorld();
    const rect = plainRect(w, 30, 20, 300, 1) || plainRect(w, 20, 15, 120, 1) || plainRect(w, 12, 10, 50, 1);
    expect(rect).not.toBeNull();
    const claimed = claimRect(w, 1, rect);
    expect(claimed.length).toBeGreaterThanOrEqual(50);
    const t1 = w.players[0].tiles;
    const r = applyCommand(w, 1, { k: 'cede', to: 2, rect });
    expect(r).toEqual({ ok: true, k: 'cede', ceded: claimed.length });
    expect(w.players[0].tiles).toBe(t1 - claimed.length);
    for (const i of claimed) expect(w.owner[i]).toBe(2);
  });

  it('treats an area with no sender-owned cell as a harmless no-op', () => {
    const w = mkWorld();
    const rect = plainRect(w, 8, 6, 30, 1);           // no player-1 land anywhere inside
    expect(rect).not.toBeNull();
    expect(ownedIn(w, 1, rect)).toHaveLength(0);
    const before = Array.from(w.owner);
    const t1 = w.players[0].tiles, t2 = w.players[1].tiles;
    const ev = eventLog(w);

    expect(cedeLand(w, 1, 2, rect)).toEqual({ ok: true, ceded: 0 });
    expect(Array.from(w.owner)).toEqual(before);
    expect(w.players[0].tiles).toBe(t1);
    expect(w.players[1].tiles).toBe(t2);
    expect(ev).toEqual([]);
  });

  it('keeps buildings, deadlines and roads intact and moves their counters, forts and income', () => {
    const w = mkWorld();
    const rect = plainRect(w, 10, 8, 40, 1);
    expect(rect).not.toBeNull();
    const claimed = claimRect(w, 1, rect);
    recount(w);                                       // baseline tallies before any structure exists
    const p1 = w.players[0], p2 = w.players[1];
    const base = { b1: { ...p1.built }, b2: { ...p2.built }, a1: { ...p1.active }, a2: { ...p2.active } };
    const [factory, farm, fort, roadA, roadB] = claimed;
    setBuilding(w, factory, 2, 0);                    // finished Factory
    const deadline = w.time + 30;
    setBuilding(w, farm, 1, deadline);                // Farm still under construction
    setBuilding(w, fort, 3, 0);                       // finished Fortress
    setRoad(w, roadA, 1); setRoad(w, roadB, 1);
    recount(w);

    const fx = (fort % w.w) + .5, fy = ((fort / w.w) | 0) + .5;
    expect(w.forts.find(f => f.x === fx && f.y === fy).owner).toBe(1);

    tick(w, STEP);                                    // publish the pre-cession income rates
    const rate0 = p1.goldRate, rate1 = p2.goldRate;
    const gold0 = p1.gold, pool0 = p1.pool, gold1 = p2.gold, pool1 = p2.pool;
    w.bchanges = []; w.rchanges = [];

    const r = cedeLand(w, 1, 2, rect);
    expect(r).toEqual({ ok: true, ceded: claimed.length });

    // structures and their deadlines cross over untouched; nothing is reported as lost
    expect(w.bld[factory]).toBe(2); expect(w.bdone[factory]).toBe(0);
    expect(w.bld[farm]).toBe(1); expect(w.bdone[farm]).toBe(deadline);
    expect(w.bld[fort]).toBe(3);
    expect(w.bchanges).toEqual([]);
    expect(w.roads[roadA]).toBe(1); expect(w.roads[roadB]).toBe(1);
    expect(w.rchanges).toEqual([]);

    // tallies follow the land immediately: built counts all, active only what has finished
    expect(p1.built).toEqual(base.b1);
    expect(p1.active).toEqual(base.a1);
    expect(p2.built).toEqual({ farm: base.b2.farm + 1, factory: base.b2.factory + 1, fortress: base.b2.fortress + 1 });
    expect(p2.active).toEqual({ farm: base.a2.farm, factory: base.a2.factory + 1, fortress: base.a2.fortress + 1 });
    expect(w.forts.find(f => f.x === fx && f.y === fy).owner).toBe(2);

    // no resources were minted or spent by the transfer itself
    expect(p1.gold).toBe(gold0); expect(p1.pool).toBe(pool0);
    expect(p2.gold).toBe(gold1); expect(p2.pool).toBe(pool1);

    // income follows the land and the finished Factory that came with it
    const n = r.ceded, per = GOLD.perTile * w.settings.incomeMultiplier;
    const fac = GOLD.perFactory * w.settings.incomeMultiplier;
    tick(w, STEP);
    expect(p1.goldRate).toBeCloseTo(rate0 - (n * per + fac), 9);
    expect(p2.goldRate).toBeCloseTo(rate1 + (n * per + fac), 9);
  });

  it('hands a ceded city over without a capture report and clears its rally', () => {
    const w = mkWorld();
    w.time = 5;
    const [c, idx] = neutralCity(w);
    expect(c).not.toBeNull();
    setOwner(w, idx, 1);
    c.rally = c.y * w.w + Math.min(c.x + 1, w.w - 1);
    const ev = eventLog(w);
    const n1 = w.players[0].cities, n2 = w.players[1].cities;

    expect(cedeLand(w, 1, 2, [c.x, c.y, c.x, c.y])).toEqual({ ok: true, ceded: 1 });
    expect(w.owner[idx]).toBe(2);
    expect(c.owner).toBe(2);
    expect(c.rally).toBeNull();
    expect(w.players[0].cities).toBe(n1 - 1);
    expect(w.players[1].cities).toBe(n2 + 1);
    expect(ev).toEqual([['landCeded', { from: 1, to: 2, tiles: 1 }]]);
  });

  it('still razes captured fortresses and reports captures on the three-argument path', () => {
    const w = mkWorld();
    const rect = plainRect(w, 8, 6, 20, 1);
    expect(rect).not.toBeNull();
    const claimed = claimRect(w, 1, rect);
    const [fort, , farm, road] = claimed;
    setBuilding(w, fort, 3, 0);
    recount(w);
    w.time = 3;
    const ev = eventLog(w);

    setOwner(w, fort, 3);                             // hostile capture keeps the old fate: razed
    expect(w.owner[fort]).toBe(3);
    expect(w.bld[fort]).toBe(0);
    expect(ev).toEqual([['buildingLost', { owner: 1, type: 'fortress' }]]);

    // under construction or not, losing a farm/factory to a capture still reports the loss
    setBuilding(w, farm, 1, w.time + 10);
    const til = w.bdone[farm];
    ev.length = 0;
    setOwner(w, farm, 3);
    expect(w.bld[farm]).toBe(1);
    expect(w.bdone[farm]).toBe(til);
    expect(ev).toEqual([['buildingLost', { owner: 1, type: 'farm' }]]);

    setRoad(w, road, 1);
    setOwner(w, road, 3);
    expect(w.roads[road]).toBe(1);                    // conquering the tile keeps the road

    const [c, idx] = neutralCity(w);
    expect(c).not.toBeNull();
    setOwner(w, idx, 1);
    ev.length = 0;
    setOwner(w, idx, 3);
    expect(ev).toEqual([['cityCaptured', { city: c, by: 3, from: 1 }]]);
  });

  it('refuses non-teammates, invalid seats and malformed rectangles without touching the world', () => {
    const w = mkWorld();
    const rect = plainRect(w, 8, 6, 20, 1);
    expect(rect).not.toBeNull();
    const claimed = claimRect(w, 1, rect);
    expect(claimed.length).toBeGreaterThanOrEqual(20);
    const before = Array.from(w.owner);
    const t1 = w.players[0].tiles, t2 = w.players[1].tiles;

    const attempts = [
      [1, 3, rect],                                   // 3 is not a teammate of 1
      [1, 5, rect],                                   // nor is 5
      [1, 1, rect],                                   // you cannot cede to yourself
      [1, 2.5, rect],                                 // seat ids are integers
      [1, 0, rect],                                   // ...and real seats
      [1, 99, rect],
      [0, 2, rect],                                   // spectators own nothing
      [1, 2, null], [1, 2, 'rect'], [1, 2, undefined],
      [1, 2, []], [1, 2, [rect[0], rect[1], rect[2]]], [1, 2, [...rect, 1]],
      [1, 2, [rect[0] + 0.5, rect[1], rect[2], rect[3]]],
      [1, 2, [rect[0], NaN, rect[2], rect[3]]],
      [1, 2, [rect[0], rect[1], Infinity, rect[3]]],
      [1, 2, ['0', rect[1], rect[2], rect[3]]],
      [1, 2, [-1, rect[1], rect[2], rect[3]]],
      [1, 2, [rect[0], rect[1], w.w, rect[3]]],
      [1, 2, [rect[0], rect[1], rect[2], w.h]],
    ];
    for (const [pid, to, r] of attempts) {
      const out = cedeLand(w, pid, to, r);
      expect({ pid, to, r, out }).toEqual({ pid, to, r, out: { ok: false, ceded: 0 } });
    }

    const p1 = w.players[0], p2 = w.players[1];
    p1.enabled = false; expect(cedeLand(w, 1, 2, rect)).toEqual({ ok: false, ceded: 0 }); p1.enabled = true;
    p1.alive = false; expect(cedeLand(w, 1, 2, rect)).toEqual({ ok: false, ceded: 0 }); p1.alive = true;
    p2.enabled = false; expect(cedeLand(w, 1, 2, rect)).toEqual({ ok: false, ceded: 0 }); p2.enabled = true;
    p2.alive = false; expect(cedeLand(w, 1, 2, rect)).toEqual({ ok: false, ceded: 0 }); p2.alive = true;

    // the command layer additionally turns away spectators, the dead and finished games
    expect(applyCommand(w, 0, { k: 'cede', to: 2, rect })).toEqual({ ok: false });
    expect(applyCommand(w, 1, { k: 'cede', to: 2, rect: [rect[0], rect[1], -2, rect[3]] })).toEqual({ ok: false });
    p1.alive = false; expect(applyCommand(w, 1, { k: 'cede', to: 2, rect })).toEqual({ ok: false }); p1.alive = true;
    w.over = true; expect(applyCommand(w, 1, { k: 'cede', to: 2, rect })).toEqual({ ok: false }); w.over = false;

    expect(Array.from(w.owner)).toEqual(before);
    expect(w.players[0].tiles).toBe(t1);
    expect(w.players[1].tiles).toBe(t2);
  });

  it('has no cede to give in free-for-all, where nobody is an ally', () => {
    const w = createWorld(12345, { humans: [], aiDelay: 1e9 });
    const rect = plainRect(w, 8, 6, 20, 1);
    expect(rect).not.toBeNull();
    expect(claimRect(w, 1, rect).length).toBeGreaterThan(0);
    const before = Array.from(w.owner);
    expect(cedeLand(w, 1, 2, rect)).toEqual({ ok: false, ceded: 0 });
    expect(applyCommand(w, 1, { k: 'cede', to: 2, rect })).toEqual({ ok: false });
    expect(Array.from(w.owner)).toEqual(before);
  });
});
