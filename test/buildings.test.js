import { describe, it, expect } from 'vitest';
import { W, H, STEP, WATER, BUILD_RADIUS, BUILDINGS, BUILD_IDS, MANPOWER, GOLD, FORT_RANGE } from '../src/config.js';
import { createWorld, subscribe, setOwner } from '../src/sim/world.js';
import { tick } from '../src/sim/game.js';
import { applyCommand } from '../src/sim/commands.js';
import { canBuild, buildCost, hasFactory, placeBuildings, recount } from '../src/sim/buildings.js';
import { economy } from '../src/sim/economy.js';
import { raiseDivision, spawnDiv } from '../src/sim/divisions.js';
import { hit } from '../src/sim/combat.js';
import { nearFriendly } from '../src/sim/proximity.js';

const mk = (seed = 12345) => createWorld(seed, { humans: ['Me'], aiDelay: 1e9 });
const FACTORY = BUILD_IDS.indexOf('factory') + 1;
const FORTRESS = BUILD_IDS.indexOf('fortress') + 1;
// Explicit proximity range for the generic nearFriendly/city tests: the config heal radius no longer
// exists (reinforcement now keys off connected logistics distance), so the tests carry their own.
const CITY_TEST_RANGE = 5;

/** An owned, empty, plain tile close to (but not on) player 1's capital, and one far outside the circle. */
function tilesFor(w) {
  const cap = w.cities.find(c => c.owner === 1 && c.capital);
  let near = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = y * W + x, d = Math.hypot(x - cap.x, y - cap.y);
    if (near < 0 && d > 2 && d < BUILD_RADIUS - 0.5 && w.owner[t] === 1 && canBuild(w, 1, 'farm', t)) near = t;
  }
  return { cap, near };
}

/** Up to `n` tiles `pid` may build `type` on, nearest their capital first. */
function buildTiles(w, pid, type, n) {
  const cap = w.cities.find(c => c.owner === pid && c.capital);
  const out = [];
  for (let t = 0; t < W * H; t++) if (canBuild(w, pid, type, t)) out.push(t);
  out.sort((a, b) => Math.hypot(a % W - cap.x, ((a / W) | 0) - cap.y) - Math.hypot(b % W - cap.x, ((b / W) | 0) - cap.y));
  return out.slice(0, n);
}

/** Run the sim forwards `seconds` worth of fixed-step ticks. */
function advance(w, seconds) { for (let i = 0; i < seconds / STEP; i++) tick(w, STEP); }

/** Recompute a player's rates at a controlled state (empty reserves, no divisions) so the soft-cap factor is exactly 1. */
function incomeAt(w, p) {
  const divs = w.divs, pool = p.pool;
  w.divs = []; p.pool = 0;
  economy(w, 0);
  const out = { rate: p.rate, goldRate: p.goldRate };
  w.divs = divs; p.pool = pool;
  return out;
}

describe('buildings', () => {
  it('every capital starts with a working factory', () => {
    const w = mk();
    for (const c of w.cities.filter(c => c.capital)) expect(hasFactory(w, c.owner, c)).toBe(true);
    expect(w.players[0].active.factory).toBe(1);
  });

  it('placement rules: owned plain land, factories only near own cities', () => {
    const w = mk(); const { near } = tilesFor(w);
    expect(near).toBeGreaterThan(0);
    expect(canBuild(w, 1, 'factory', near)).toBe(true);
    expect(canBuild(w, 2, 'farm', near)).toBe(false);                       // not theirs
    const cityTile = w.cities[0].idx;
    expect(canBuild(w, 1, 'farm', cityTile)).toBe(false);                   // cities are not buildable
    const water = w.terr.findIndex(t => t === WATER);
    expect(canBuild(w, 1, 'farm', water)).toBe(false);
    // owned land far from every city: farm yes, factory no
    let far = -1;
    for (let t = 0; t < W * H && far < 0; t++) {
      if (w.terr[t] === 1 && w.owner[t] === 0 && w.cityAt[t] < 0) {
        const x = t % W, y = (t / W) | 0;
        if (w.cities.every(c => Math.hypot(c.x - x, c.y - y) > BUILD_RADIUS + 1)) far = t;
      }
    }
    setOwner(w, far, 1);
    expect(canBuild(w, 1, 'farm', far)).toBe(true);
    expect(canBuild(w, 1, 'factory', far)).toBe(false);
    expect(canBuild(w, 1, 'fortress', far)).toBe(false);
  });

  it('build costs gold, takes time, and cannot be stacked on one tile', () => {
    const w = mk(); const p = w.players[0]; const { near } = tilesFor(w);
    p.gold = 500;
    const cost = buildCost(w, 1, 'factory');
    expect(placeBuildings(w, p, 'factory', [near]).placed).toBe(1);
    expect(p.gold).toBe(500 - cost);
    expect(placeBuildings(w, p, 'farm', [near]).placed).toBe(0);            // occupied
    expect(buildCost(w, 1, 'factory')).toBeGreaterThan(cost);                // gets dearer
    recount(w);
    expect(p.built.factory).toBe(2); expect(p.active.factory).toBe(1);       // new one still under construction
    for (let i = 0; i < (BUILDINGS.factory.time + 1) / STEP; i++) tick(w, STEP);
    expect(p.active.factory).toBe(2);
  });

  it('stops placing when gold runs out and reports it', () => {
    const w = mk(); const p = w.players[0]; p.gold = BUILDINGS.farm.gold * 2;
    const events = []; subscribe(w, (t, d) => events.push([t, d]));
    const tiles = [];
    for (let t = 0; t < W * H && tiles.length < 5; t++) if (canBuild(w, 1, 'farm', t)) tiles.push(t);
    expect(placeBuildings(w, p, 'farm', tiles).placed).toBe(2);
    expect(p.gold).toBe(0);
    expect(placeBuildings(w, p, 'farm', tiles.slice(2)).placed).toBe(0);
    expect(events.some(([t, d]) => t === 'buildFailed' && d.reason === 'gold')).toBe(true);
  });

  it('build command validates its input', () => {
    const w = mk(); w.players[0].gold = 1000;
    expect(applyCommand(w, 1, { k: 'build', type: 'nuke', tiles: [1] }).ok).toBe(false);
    expect(applyCommand(w, 1, { k: 'build', type: 'farm', tiles: 'x' }).ok).toBe(false);
    expect(applyCommand(w, 1, { k: 'build', type: 'farm', tiles: new Array(500).fill(1) }).ok).toBe(false);
    expect(applyCommand(w, 1, { k: 'build', type: 'farm', tiles: [1.5, -3, 1e9, null, 'a'] }).ok).toBe(false);
    const { near } = tilesFor(w);
    expect(applyCommand(w, 1, { k: 'build', type: 'farm', tiles: [near] })).toMatchObject({ ok: true, placed: 1 });
    expect(applyCommand(w, 2, { k: 'build', type: 'farm', tiles: [near + 1] }).placed).toBe(0);
  });

  it('a paid farm or factory produces no income until construction completes', () => {
    const w = mk(); const p = w.players[0]; p.gold = 1000;
    const [farmTile, factoryTile] = buildTiles(w, 1, 'factory', 2);
    const base = incomeAt(w, p);
    expect(placeBuildings(w, p, 'farm', [farmTile]).placed).toBe(1);
    expect(placeBuildings(w, p, 'factory', [factoryTile]).placed).toBe(1);
    expect(p.built.farm).toBe(1); expect(p.built.factory).toBe(2);      // paid for and under construction
    expect(p.active.farm).toBe(0); expect(p.active.factory).toBe(1);    // nothing new has finished
    const mid = incomeAt(w, p);
    expect(mid.rate).toBeCloseTo(base.rate, 6);                         // no farm income yet
    expect(mid.goldRate).toBeCloseTo(base.goldRate, 6);                 // no factory income yet
    advance(w, Math.max(BUILDINGS.farm.time, BUILDINGS.factory.time) + 2);
    expect(p.active.farm).toBe(1); expect(p.active.factory).toBe(2);
    const done = incomeAt(w, p);
    expect(done.rate - base.rate).toBeCloseTo(MANPOWER.perFarm, 6);     // exactly one farm's manpower
    expect(done.goldRate - base.goldRate).toBeCloseTo(GOLD.perFactory, 6); // exactly one factory's gold
  });

  it('a completed building outweighs a realistic slice of new territory', () => {
    const w = mk(); const p = w.players[0];
    const plain = incomeAt(w, p);
    const extra = [];                                                   // 40 more owned plain tiles
    for (let t = 0; t < W * H && extra.length < 40; t++)
      if (w.terr[t] === 1 && w.owner[t] === 0 && w.cityAt[t] < 0) extra.push(t);
    for (const t of extra) setOwner(w, t, 1);
    const widened = incomeAt(w, p);
    const tileManpower = widened.rate - plain.rate;
    const tileGold = widened.goldRate - plain.goldRate;
    expect(tileManpower).toBeGreaterThan(0);                            // territory does pay something
    p.gold = 1000;
    const [farmTile, factoryTile] = buildTiles(w, 1, 'factory', 2);
    placeBuildings(w, p, 'farm', [farmTile]);
    placeBuildings(w, p, 'factory', [factoryTile]);
    advance(w, Math.max(BUILDINGS.farm.time, BUILDINGS.factory.time) + 2);
    const built = incomeAt(w, p);
    expect(built.rate - widened.rate).toBeCloseTo(MANPOWER.perFarm, 6);
    expect(built.goldRate - widened.goldRate).toBeCloseTo(GOLD.perFactory, 6);
    // one building beats all 40 extra tiles: buildings, not sprawl, drive the economy
    expect(MANPOWER.perFarm).toBeGreaterThan(tileManpower);
    expect(GOLD.perFactory).toBeGreaterThan(tileGold);
  });

  it('a captured farm or factory changes hands intact and keeps paying its captor', () => {
    const w = mk(); const p1 = w.players[0]; p1.gold = 1000;
    const [farmTile, factoryTile] = buildTiles(w, 1, 'factory', 2);
    placeBuildings(w, p1, 'farm', [farmTile]);
    placeBuildings(w, p1, 'factory', [factoryTile]);
    advance(w, BUILDINGS.factory.time + 2);
    expect(p1.active.farm).toBe(1); expect(p1.active.factory).toBe(2);  // the capital's own factory plus this one
    const cap = w.cities.find(c => c.owner === 1 && c.capital);
    expect(hasFactory(w, 2, cap)).toBe(false);                          // the captor has no working factory here yet
    const withFarm = incomeAt(w, p1), before = incomeAt(w, w.players[1]);
    const farmDone = w.bdone[farmTile], factoryDone = w.bdone[factoryTile];
    const events = []; subscribe(w, (t, d) => events.push([t, d]));
    w.changes = []; w.bchanges = [];
    setOwner(w, farmTile, 2); setOwner(w, factoryTile, 2);              // captured, not destroyed
    expect(w.bld[farmTile]).toBe(BUILD_IDS.indexOf('farm') + 1);
    expect(w.bld[factoryTile]).toBe(FACTORY);
    expect(w.bdone[farmTile]).toBe(farmDone);                           // the deadline the old owner paid for survives
    expect(w.bdone[factoryTile]).toBe(factoryDone);
    expect(w.changes).toEqual([farmTile, 2, factoryTile, 2]);           // ownership deltas are all a client needs
    expect(w.bchanges).toEqual([]);                                     // the buildings never left their tiles
    expect(events.some(([t, d]) => t === 'buildingLost' && d.owner === 1 && d.type === 'farm')).toBe(true);
    expect(events.some(([t, d]) => t === 'buildingLost' && d.owner === 1 && d.type === 'factory')).toBe(true);
    expect(hasFactory(w, 2, cap)).toBe(true);                           // the captured factory unlocks for its new owner at once
    advance(w, 1.2);                                                    // the periodic recount hands the tallies over
    expect(p1.active.farm).toBe(0); expect(p1.active.factory).toBe(1);   // p1 keeps only its capital's factory
    expect(w.players[1].active.farm).toBe(1);
    expect(w.players[1].active.factory).toBe(2);                        // its own capital factory plus the captured one
    const lost = incomeAt(w, p1), gained = incomeAt(w, w.players[1]);
    expect(withFarm.rate - lost.rate).toBeCloseTo(MANPOWER.perFarm + 2 * MANPOWER.perTile, 6);
    expect(withFarm.goldRate - lost.goldRate).toBeCloseTo(GOLD.perFactory + 2 * GOLD.perTile, 6);
    expect(gained.rate - before.rate).toBeCloseTo(MANPOWER.perFarm + 2 * MANPOWER.perTile, 6);
    expect(gained.goldRate - before.goldRate).toBeCloseTo(GOLD.perFactory + 2 * GOLD.perTile, 6);

    // a farm still under construction is captured the same way: same deadline, it finishes for the captor
    p1.gold = 1000;
    const [lateTile] = buildTiles(w, 1, 'farm', 1);
    placeBuildings(w, p1, 'farm', [lateTile]);
    const deadline = w.bdone[lateTile];
    expect(deadline).toBeGreaterThan(w.time);
    setOwner(w, lateTile, 2);
    expect(w.bld[lateTile]).toBe(BUILD_IDS.indexOf('farm') + 1);
    expect(w.bdone[lateTile]).toBe(deadline);
    recount(w);
    expect(p1.built.farm).toBe(0); expect(w.players[1].built.farm).toBe(2);   // the captor owns both farms now
    expect(w.players[1].active.farm).toBe(1);                           // one finished, one still building
    // the periodic recount runs once a second, so allow it to land past the deadline
    advance(w, deadline - w.time + 1.5);
    expect(w.players[1].active.farm).toBe(2);                           // it finished for the captor, deadline unchanged
    expect(p1.active.farm).toBe(0);

    // a captured city plus its captured factory lets the new owner raise heavy units there
    setOwner(w, cap.idx, 2);
    const p2 = w.players[1];
    p2.pool = 1000; p2.gold = 1000;
    expect(raiseDivision(w, p2, cap, 'arm')).not.toBeNull();
  });

  it('placing buildings spends gold and never mints resources', () => {
    const w = mk(); const p = w.players[0];
    const [farmTile, factoryTile] = buildTiles(w, 1, 'factory', 2);
    p.gold = 100000; p.pool = 321;
    const farmCost = buildCost(w, 1, 'farm'), factoryCost = buildCost(w, 1, 'factory');
    const gold0 = p.gold, pool0 = p.pool;
    placeBuildings(w, p, 'farm', [farmTile]);
    placeBuildings(w, p, 'factory', [factoryTile]);
    expect(p.gold).toBe(gold0 - farmCost - factoryCost);                // paid exactly: no refund, no bonus
    expect(p.pool).toBe(pool0);                                         // placements never touch manpower
    const [brokeTile] = buildTiles(w, 1, 'farm', 1);
    p.gold = 0;
    expect(placeBuildings(w, p, 'farm', [brokeTile]).placed).toBe(0);
    expect(p.gold).toBe(0);                                             // still broke, nothing minted
    expect(p.pool).toBe(pool0);
  });

  it('heavy units need a factory near the city; infantry does not', () => {
    const w = mk(); const p = w.players[0]; p.pool = 1000; p.gold = 1000;
    const other = w.cities.find(c => c.owner === 0 && !c.capital);
    setOwner(w, other.idx, 1);                                              // a city without a factory
    const events = []; subscribe(w, (t, d) => events.push([t, d]));
    expect(raiseDivision(w, p, other, 'arm')).toBeNull();
    expect(events.at(-1)[1].reason).toBe('factory');
    expect(raiseDivision(w, p, other, 'inf')).not.toBeNull();
    expect(raiseDivision(w, p, null, 'arm')).not.toBeNull();                // falls back to the capital's factory
  });

  it('capturing a tile transfers the farm on it instead of destroying it', () => {
    const w = mk(); const p = w.players[0]; const { near } = tilesFor(w);
    p.gold = 500; placeBuildings(w, p, 'farm', [near]);
    const deadline = w.bdone[near];
    const events = []; subscribe(w, (t, d) => events.push([t, d]));
    w.time = 1;
    setOwner(w, near, 2);
    expect(w.bld[near]).toBe(BUILD_IDS.indexOf('farm') + 1);            // the farm stays on the captured tile
    expect(w.bdone[near]).toBe(deadline);                               // with its original completion time
    expect(events.some(([t, d]) => t === 'buildingLost' && d.owner === 1 && d.type === 'farm')).toBe(true);
  });

  it('nearFriendly: one owner-aware, inclusive proximity test for cities and forts', () => {
    const w = mk();
    const c = w.cities.find(c => c.owner === 1);
    const at = (dx, dy, owner = 1) => ({ x: c.x + .5 + dx, y: c.y + .5 + dy, owner });
    expect(nearFriendly(w, at(0, 0), 'city', CITY_TEST_RANGE)).toBe(true);                  // the centre itself
    expect(nearFriendly(w, at(CITY_TEST_RANGE, 0), 'city', CITY_TEST_RANGE)).toBe(true);    // inclusive edge
    expect(nearFriendly(w, at(4, 3), 'city', CITY_TEST_RANGE)).toBe(true);                  // exactly 5 tiles diagonally
    expect(nearFriendly(w, at(CITY_TEST_RANGE + 0.01, 0), 'city', CITY_TEST_RANGE)).toBe(false);
    expect(nearFriendly(w, at(0, 0, 2), 'city', CITY_TEST_RANGE)).toBe(false);              // only friendly cities count
    expect(nearFriendly(w, at(0, 0), 'fortress', FORT_RANGE)).toBe(false);                  // no fortress built yet
  });

  it('fortress cover: friendly, finished, in range — and gone the moment the fort falls', () => {
    const w = mk(); const { near } = tilesFor(w); const p = w.players[0];
    p.gold = 500;
    expect(placeBuildings(w, p, 'fortress', [near]).placed).toBe(1);
    const fx = (near % W) + .5, fy = ((near / W) | 0) + .5;
    const attacker = { type: 'inf', men: 100, oos: false };
    const def = owner => ({ x: fx, y: fy, owner, type: 'inf' });
    const avg = d => { let s = 0; for (let i = 0; i < 400; i++) s += hit(w, attacker, d, 1); return s / 400; };
    w.forts.push({ x: fx, y: fy, owner: 1 });                           // a stale cache entry naming the fort
    expect(nearFriendly(w, def(1), 'fortress', FORT_RANGE)).toBe(false); // under construction: no cover
    const bare = avg(def(1));
    advance(w, BUILDINGS.fortress.time + 2);
    expect(w.forts.some(f => f.owner === 1 && f.x === fx && f.y === fy)).toBe(true);
    expect(w.bld[near]).toBe(FORTRESS);                                 // the live tile still holds the finished fort
    expect(nearFriendly(w, def(1), 'fortress', FORT_RANGE)).toBe(true);
    const covered = avg(def(1));
    expect(covered).toBeLessThan(bare * 0.75);                          // FORT_DEF = 0.6
    expect(nearFriendly(w, def(2), 'fortress', FORT_RANGE)).toBe(false); // an enemy fort never covers the defender
    expect(avg(def(2))).toBeGreaterThan(covered * 1.25);
    expect(nearFriendly(w, { ...def(1), x: fx + FORT_RANGE }, 'fortress', FORT_RANGE)).toBe(true);      // inclusive edge
    expect(nearFriendly(w, { ...def(1), x: fx + FORT_RANGE + 0.01 }, 'fortress', FORT_RANGE)).toBe(false);

    // an enemy division overruns the fort tile: the fort is razed, not captured
    w.changes = []; w.bchanges = [];
    const events = []; subscribe(w, (t, d) => events.push([t, d]));
    expect(spawnDiv(w, 2, fx, fy, 40, 40, 'inf')).not.toBeNull();
    for (let i = 0; i < 400 && w.owner[near] !== 2; i++) tick(w, STEP);
    expect(w.owner[near]).toBe(2);
    expect(w.bld[near]).toBe(0);
    expect(w.bchanges).toEqual([near, 0, 0]);                           // mirrors are told to clear the fort
    expect(events.some(([t, d]) => t === 'buildingLost' && d.owner === 1 && d.type === 'fortress')).toBe(true);
    w.forts.push({ x: fx, y: fy, owner: 1 });                           // the up-to-1s-stale cache still lists it
    expect(nearFriendly(w, def(1), 'fortress', FORT_RANGE)).toBe(false);
    expect(nearFriendly(w, def(2), 'fortress', FORT_RANGE)).toBe(false);
    expect(avg(def(2))).toBeGreaterThan(covered * 1.3);                 // and no stale damage reduction survives
  });

  it("an ally's finished fort covers my division, and the cover follows the pact", () => {
    const w = mk();
    expect([w.players[0].team, w.players[1].team]).toEqual([1, 2]);      // FFA until a team is set
    const mate = w.players[1];
    const fort = buildTiles(w, 2, 'fortress', 1)[0];                     // legal fortress ground for player 2
    expect(fort).toBeGreaterThanOrEqual(0);
    mate.gold = 500;
    expect(placeBuildings(w, mate, 'fortress', [fort]).placed).toBe(1);
    advance(w, BUILDINGS.fortress.time + 2);
    expect(w.bld[fort]).toBe(FORTRESS);                                  // finished and live
    const fx = (fort % W) + .5, fy = ((fort / W) | 0) + .5;
    const attacker = { type: 'inf', men: 100, oos: false };
    const def = { x: fx, y: fy, owner: 1, type: 'inf' };
    const avg = () => { let s = 0; for (let i = 0; i < 400; i++) s += hit(w, attacker, def, 1); return s / 400; };
    const bare = avg();
    expect(nearFriendly(w, def, 'fortress', FORT_RANGE)).toBe(false);    // an ally's fort is not mine in FFA
    w.players[1].team = 1;                                               // same fort, now on my side
    expect(nearFriendly(w, def, 'fortress', FORT_RANGE)).toBe(true);
    expect(avg()).toBeLessThan(bare * 0.75);                             // FORT_DEF = 0.6
    w.players[1].team = 2;                                               // the pact breaks: cover is gone at once
    expect(nearFriendly(w, def, 'fortress', FORT_RANGE)).toBe(false);
    expect(avg()).toBeGreaterThan(bare * 0.9);
  });

  it('AI converts gold into finished farms whose output shows in its income', () => {
    const w = createWorld(777, { humans: [], aiDelay: 1 });
    const start = w.players.map(p => p.built.farm + p.built.factory);
    advance(w, 240);
    // real new construction, not the free factory every capital already starts with
    const builders = w.players.filter(p => p.alive && p.built.farm + p.built.factory > start[p.id - 1]);
    expect(builders.length).toBeGreaterThan(0);
    expect(builders.some(p => p.active.farm >= 1)).toBe(true);         // at least one farm actually finished
    const p = builders.find(p => p.active.farm >= 1);
    // the finished buildings are real income, not just territory: observed rates match land/cities/farms/factories
    const inc = incomeAt(w, p);
    expect(inc.rate).toBeCloseTo(
      MANPOWER.base + p.tiles * MANPOWER.perTile + p.cities * MANPOWER.perCity + MANPOWER.perFarm * p.active.farm, 6);
    expect(inc.goldRate).toBeCloseTo(
      GOLD.base + p.tiles * GOLD.perTile + p.cities * GOLD.perCity + GOLD.perFactory * p.active.factory, 6);
  }, 20000);
});
