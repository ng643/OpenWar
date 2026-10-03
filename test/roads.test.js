import { describe, it, expect } from 'vitest';
import { LAND, MOUNTAIN, ROAD_GOLD, ROAD_SPEED, TCOST, WATER, MAX_ROUTE_POINTS } from '../src/config.js';
import { createWorld, setOwner, setRoad, subscribe } from '../src/sim/world.js';
import { roadTiles, placeRoads } from '../src/sim/roads.js';
import { findPath } from '../src/sim/pathfinding.js';
import { moveCost, MIN_MOVE_COST } from '../src/sim/travel.js';
import { normalizeSettings } from '../src/setup.js';
import { allied } from '../src/sim/teams.js';

/** A tiny all-land world owned by player 1, with just the state roads/pathfinding touch. */
function mk({ w = 10, h = 10 } = {}) {
  return {
    w, h,
    terr: new Uint8Array(w * h).fill(LAND),
    owner: new Uint8Array(w * h).fill(1),
    roads: new Uint8Array(w * h), roadVersion: 0, rchanges: null,
    bld: new Uint8Array(w * h), cityAt: new Int16Array(w * h).fill(-1),
    ownerVersion: 0, changes: null, time: 0, cities: [], listeners: [],
    players: [
      { id: 1, gold: 1000, enabled: true, alive: true, team: 1, tiles: w * h },
      { id: 2, gold: 1000, enabled: true, alive: true, team: 2, tiles: 0 }
    ]
  };
}

const t = (world, x, y) => y * world.w + x;

/** Cost of walking `path` (tiles after `s`) at the current roads/terrain. */
function pathCost(world, s, path) {
  let cost = 0, prev = s;
  for (const tile of path) {
    const dx = Math.abs((tile % world.w) - (prev % world.w));
    const dy = Math.abs(((tile / world.w) | 0) - ((prev / world.w) | 0));
    cost += (dx && dy ? 1.414 : 1) * moveCost(world, tile);
    prev = tile;
  }
  return cost;
}

describe('road tiles and payment', () => {
  it('builds deduplicated tiles along a bent polyline for exactly ROAD_GOLD per fresh tile', () => {
    const world = mk({ w: 12, h: 12 });
    world.rchanges = [];
    const gold0 = world.players[0].gold;
    const res = placeRoads(world, 1, [[1.5, 1.5], [9.5, 1.5], [9.5, 9.5]]);
    expect(res.ok).toBe(true);
    // (1,1) start + 8 tiles east + 8 tiles south; the bend tile (9,1) is shared, not double charged.
    expect(res.placed).toBe(17);
    expect(res.cost).toBe(17 * ROAD_GOLD);
    expect(world.players[0].gold).toBe(gold0 - 17 * ROAD_GOLD);
    expect(world.roadVersion).toBe(17);
    expect(world.rchanges.length).toBe(17 * 2);
    let roads = 0;
    for (let i = 0; i < world.w * world.h; i++) roads += world.roads[i];
    expect(roads).toBe(17);
    expect(world.roads[t(world, 1, 1)]).toBe(1);
    expect(world.roads[t(world, 9, 9)]).toBe(1);
    expect(world.roads[t(world, 9, 1)]).toBe(1);
  });

  it('charges only tiles that are not already roads, and repeats are free', () => {
    const world = mk({ w: 12, h: 12 });
    placeRoads(world, 1, [[1.5, 1.5], [9.5, 1.5]]);
    const gold = world.players[0].gold, version = world.roadVersion;
    const again = placeRoads(world, 1, [[1.5, 1.5], [9.5, 1.5]]);
    expect(again).toEqual({ ok: true, placed: 0, cost: 0 });
    expect(world.players[0].gold).toBe(gold);
    expect(world.roadVersion).toBe(version);
    // A retraced polyline is deduplicated too: same tiles, still nothing new.
    expect(placeRoads(world, 1, [[1.5, 1.5], [9.5, 1.5], [1.5, 1.5]])).toEqual({ ok: true, placed: 0, cost: 0 });
    // An extension pays only for the genuinely new tiles (the start tile is already a road).
    const ext = placeRoads(world, 1, [[5.5, 1.5], [5.5, 5.5]]);
    expect(ext.placed).toBe(4);
    expect(ext.cost).toBe(4 * ROAD_GOLD);
  });

  it('refuses to build anything without enough gold, reporting the full need', () => {
    const world = mk({ w: 12, h: 12 });
    world.rchanges = [];
    const events = [];
    subscribe(world, (type, data) => events.push({ type, data }));
    world.players[0].gold = 9 * ROAD_GOLD - 1;   // one gold short of the 9-tile route
    const res = placeRoads(world, 1, [[1.5, 1.5], [9.5, 1.5]]);
    expect(res).toEqual({ ok: false, placed: 0, cost: 0 });
    expect(world.players[0].gold).toBe(9 * ROAD_GOLD - 1);
    expect(world.roads.every(v => v === 0)).toBe(true);   // no partial road
    expect(world.roadVersion).toBe(0);
    expect(world.rchanges).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('buildFailed');
    expect(events[0].data.player).toBe(world.players[0]);
    expect(events[0].data.reason).toBe('gold');
    expect(events[0].data.need).toBe(9 * ROAD_GOLD);
    // Exactly enough gold builds; a repeat at zero gold stays free (no false failure).
    world.players[0].gold = 9 * ROAD_GOLD;
    expect(placeRoads(world, 1, [[1.5, 1.5], [9.5, 1.5]])).toEqual({ ok: true, placed: 9, cost: 9 * ROAD_GOLD });
    expect(world.players[0].gold).toBe(0);
    expect(placeRoads(world, 1, [[1.5, 1.5], [9.5, 1.5]])).toEqual({ ok: true, placed: 0, cost: 0 });
  });

  it('rejects water and foreign waypoints, and invalid point lists, without mutating', () => {
    const world = mk({ w: 12, h: 6 });
    world.terr[t(world, 1, 1)] = WATER;
    expect(roadTiles(world, 1, [[1.5, 1.5], [5.5, 1.5]])).toBeNull();
    expect(placeRoads(world, 1, [[1.5, 1.5], [5.5, 1.5]])).toEqual({ ok: false, placed: 0, cost: 0 });

    const world2 = mk({ w: 12, h: 6 });
    world2.owner[t(world2, 5, 1)] = 2;   // enemy tile mid-route: detoured, never crossed
    const detour = roadTiles(world2, 1, [[1.5, 1.5], [9.5, 1.5]]);
    expect(detour).not.toBeNull();
    expect(detour).not.toContain(t(world2, 5, 1));
    for (const tile of detour) expect(world2.owner[tile]).toBe(1);
    // A waypoint landing on foreign land is invalid outright, and nothing gets paved.
    expect(roadTiles(world2, 1, [[1.5, 1.5], [5.5, 1.5]])).toBeNull();
    expect(placeRoads(world2, 1, [[1.5, 1.5], [5.5, 1.5]])).toEqual({ ok: false, placed: 0, cost: 0 });
    expect(world2.roads.every(v => v === 0)).toBe(true);

    const world3 = mk({ w: 12, h: 6 });
    expect(roadTiles(world3, 1, [[1.5, 1.5]])).toBeNull();
    expect(roadTiles(world3, 1, [[1.5, 1.5], [Infinity, 1.5]])).toBeNull();
    expect(roadTiles(world3, 1, [[1.5, 1.5], ['2', 1.5]])).toBeNull();
    expect(roadTiles(world3, 1, [[-1.5, 1.5], [3.5, 1.5]])).toBeNull();
    expect(roadTiles(world3, 1, [[1.5, 1.5], [3.5, 1.5], [-5, 1.5]])).toBeNull();
    expect(roadTiles(world3, 1, [[1, 1, 3], [2, 2]])).toBeNull();
    expect(placeRoads(world3, 1, [[1, 1, 3], [2, 2]])).toEqual({ ok: false, placed: 0, cost: 0 });
    expect(roadTiles(world3, 1, Array.from({ length: MAX_ROUTE_POINTS + 1 }, (_, i) => [i % 4 + 0.5, 1.5]))).toBeNull();
    expect(world3.roads.every(v => v === 0)).toBe(true);
    expect(world3.roadVersion).toBe(0);
  });

  it('never routes through or around the corner of enemy/neutral/water land', () => {
    for (const wall of [2, 0, WATER]) {
      const world = mk({ w: 20, h: 8 });
      for (let y = 0; y < 8; y++) if (y !== 6) { world.owner[t(world, 10, y)] = 2; world.terr[t(world, 10, y)] = wall === WATER ? WATER : LAND; }
      if (wall === WATER) { for (let y = 0; y < 8; y++) if (y !== 6) world.terr[t(world, 10, y)] = WATER; }
      else for (let y = 0; y < 8; y++) if (y !== 6) world.owner[t(world, 10, y)] = wall;
      const route = roadTiles(world, 1, [[2.5, 1.5], [17.5, 1.5]]);
      expect(route).not.toBeNull();                       // the gate at (10,6) keeps it reachable
      expect(route).toContain(t(world, 10, 6));
      for (const tile of route) expect(world.terr[tile]).not.toBe(WATER);
      if (wall !== WATER) for (const tile of route) expect(world.owner[tile]).toBe(1);
      expect(route.length).toBeGreaterThanOrEqual(16);    // it detours down to the gate, not through the wall
      // Sealing the gate makes the two halves disconnected: no route at all.
      world.owner[t(world, 10, 6)] = wall === WATER ? 1 : wall;
      if (wall === WATER) world.terr[t(world, 10, 6)] = WATER;
      expect(roadTiles(world, 1, [[2.5, 1.5], [17.5, 1.5]])).toBeNull();
    }
  });

  it('refuses to cut the corner of a blocked (foreign) tile', () => {
    const world = mk({ w: 6, h: 6 });
    world.owner[t(world, 1, 1)] = 2;
    const path = roadTiles(world, 1, [[0.5, 0.5], [2.5, 2.5]]);
    expect(path).not.toBeNull();
    expect(path).not.toContain(t(world, 1, 1));
    for (let i = 1; i < path.length; i++) {
      const ax = path[i - 1] % world.w, ay = Math.floor(path[i - 1] / world.w);
      const bx = path[i] % world.w, by = Math.floor(path[i] / world.w);
      if (ax !== bx && ay !== by) {
        expect(world.owner[t(world, ax, by)]).toBe(1);
        expect(world.terr[t(world, ax, by)]).not.toBe(WATER);
        expect(world.owner[t(world, bx, ay)]).toBe(1);
        expect(world.terr[t(world, bx, ay)]).not.toBe(WATER);
      }
    }
  });

  it('keeps captured roads: ownership changes leave tiles, version and charges untouched', () => {
    const world = mk({ w: 8, h: 3 });
    placeRoads(world, 1, [[1.5, 1.5], [4.5, 1.5]]);
    const version = world.roadVersion;
    setOwner(world, t(world, 2, 1), 2);
    expect(world.owner[t(world, 2, 1)]).toBe(2);
    expect(world.roads[t(world, 2, 1)]).toBe(1);
    expect(world.roadVersion).toBe(version);
    // The captor can reuse the captured tile for free, but cannot pave from it through foreign land.
    setOwner(world, t(world, 1, 1), 2);
    expect(placeRoads(world, 2, [[1.5, 1.5], [2.5, 1.5]])).toEqual({ ok: true, placed: 0, cost: 0 });
    expect(roadTiles(world, 2, [[1.5, 1.5], [4.5, 1.5]])).toBeNull();
  });

  it("an ally's ground is not roadbed any more than an enemy's", () => {
    const world = mk({ w: 12, h: 12 });
    for (let y = 0; y < world.h; y++) setOwner(world, t(world, 5, y), 2);   // the ally walls off the middle
    world.players[0].team = 1; world.players[1].team = 1;                   // ...and the two are one side
    expect(allied(world, 1, 2)).toBe(true);
    expect(roadTiles(world, 1, [[1.5, 5.5], [10.5, 5.5]])).toBeNull();      // the wall is still foreign ground
    const gold = world.players[0].gold;
    expect(placeRoads(world, 1, [[1.5, 5.5], [10.5, 5.5]])).toEqual({ ok: false, placed: 0, cost: 0 });
    expect(world.players[0].gold).toBe(gold);                              // and the refusal costs nothing
    expect(world.roadVersion).toBe(0);
  });
});

describe('travel cost and pathfinding', () => {
  it('makes road tiles ROAD_SPEED cheaper to enter and keeps the heuristic scale minimal', () => {
    const world = mk({ w: 4, h: 4 });
    const plain = t(world, 1, 1);
    expect(moveCost(world, plain)).toBe(TCOST[LAND]);
    setRoad(world, plain, 1);
    expect(moveCost(world, plain)).toBe(TCOST[LAND] / ROAD_SPEED);
    world.terr[plain] = MOUNTAIN;
    expect(moveCost(world, plain)).toBe(TCOST[MOUNTAIN] / ROAD_SPEED);
    for (const tile of [plain, t(world, 2, 2)]) expect(moveCost(world, tile)).toBeGreaterThanOrEqual(MIN_MOVE_COST);
  });

  it('picks the cheaper road detour and cuts the normal travel cost', () => {
    const world = mk({ w: 20, h: 3 });
    const start = t(world, 0, 1), end = t(world, 19, 1);
    const before = pathCost(world, start, findPath(world, start, end));
    expect(before).toBeCloseTo(19, 5);                    // straight line over plain land
    for (let x = 0; x < 20; x++) setRoad(world, t(world, x, 0), 1);
    const path = findPath(world, start, end);
    const after = pathCost(world, start, path);
    expect(after).toBeLessThan(before);
    // Optimal: discounted diagonal onto the road, 17 discounted entries, plain diagonal off (entering road discounted/leaving plain not).
    expect(after).toBeCloseTo(1.414 / ROAD_SPEED + 17 / ROAD_SPEED + 1.414, 2);
    for (const tile of path.slice(0, -1)) expect(world.roads[tile]).toBe(1);
  });

  it('finds optimal routes with the road-scaled admissible heuristic', () => {
    const open = mk({ w: 12, h: 12 });
    const s = t(open, 0, 0), d = t(open, 6, 6);
    expect(pathCost(open, s, findPath(open, s, d))).toBeCloseTo(6 * 1.414, 4);   // diagonals are cheapest

    const ridge = mk({ w: 9, h: 3 });
    for (let y = 0; y < 3; y++) ridge.terr[t(ridge, 4, y)] = MOUNTAIN;
    const s2 = t(ridge, 0, 1), d2 = t(ridge, 8, 1);
    expect(pathCost(ridge, s2, findPath(ridge, s2, d2))).toBeCloseTo(7 * TCOST[LAND] + TCOST[MOUNTAIN], 4);
  });

  it('previews identically on a mirror world carrying only dims, terrain, ownership and roads', () => {
    const world = mk({ w: 10, h: 10 });
    placeRoads(world, 1, [[1.5, 1.5], [5.5, 1.5]]);
    const mirror = { w: world.w, h: world.h, terr: world.terr, owner: world.owner, roads: world.roads };
    const points = [[1.5, 1.5], [5.5, 5.5]];
    expect(roadTiles(mirror, 1, points)).toEqual(roadTiles(world, 1, points));
    expect(moveCost(mirror, t(world, 2, 1))).toBe(TCOST[LAND] / ROAD_SPEED);
  });
});

describe('world integration', () => {
  it('initializes road state with the canonical dimensions and no obsolete supply fields', () => {
    const settings = normalizeSettings({ mapSize: 'small' });
    const world = createWorld(7, { humans: [], settings });
    expect(world.w).toBe(settings.w);
    expect(world.h).toBe(settings.h);
    expect(world.roads).toBeInstanceOf(Uint8Array);
    expect(world.roads.length).toBe(settings.w * settings.h);
    expect(world.roads.every(v => v === 0)).toBe(true);
    expect(world.roadVersion).toBe(0);
    expect(world.rchanges).toBe(null);
    expect(world.recountT).toBe(0);
    expect('supply' in world).toBe(false);
    expect('supplyT' in world).toBe(false);
  });

  it('paves owned land on a generated world, coexisting with the capital and surviving capture', () => {
    const world = createWorld(4242, { humans: ['Me'], aiDelay: 1e9 });
    const cap = world.cities.find(c => c.owner === 1 && c.capital);
    const capTile = t(world, cap.x, cap.y);
    let nb = -1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const j = t(world, cap.x + dx, cap.y + dy);
      if (world.terr[j] === LAND && world.owner[j] === 1) { nb = j; break; }
    }
    expect(nb).toBeGreaterThanOrEqual(0);
    const res = placeRoads(world, 1, [[cap.x + 0.5, cap.y + 0.5], [nb % world.w + 0.5, ((nb / world.w) | 0) + 0.5]]);
    expect(res.ok).toBe(true);
    expect(res.placed).toBe(2);                            // the capital tile itself and the neighbour
    expect(world.roads[capTile]).toBe(1);
    expect(world.roads[nb]).toBe(1);
    const version = world.roadVersion;
    setOwner(world, nb, 2);
    expect(world.roads[nb]).toBe(1);                       // captured roads stay roads
    expect(world.roadVersion).toBe(version);
  });

  it('bumps the version and logs deltas only when a road actually changes', () => {
    const world = mk({ w: 4, h: 4 });
    world.rchanges = [];
    setRoad(world, 5, 1);
    setRoad(world, 5, 1);
    setRoad(world, 5, 0);
    setRoad(world, 5, 0);
    expect(world.roadVersion).toBe(2);
    expect(world.rchanges).toEqual([5, 1, 5, 0]);
  });
});
