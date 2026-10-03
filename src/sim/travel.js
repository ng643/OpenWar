import { TCOST, WATER, ROAD_SPEED } from '../config.js';

/**
 * Cheapest possible cost of entering one tile: the cheapest non-water terrain, on a road. A* scales
 * its octile heuristic by this so the estimate can never exceed the true remaining cost (admissible).
 */
export const MIN_MOVE_COST = Math.min(...TCOST.filter((_, t) => t !== WATER)) / ROAD_SPEED;

/**
 * Cost of entering `tile` for a normal move: its terrain cost, divided by ROAD_SPEED on a road.
 * Pathfinding uses this for every step; movement uses it for normal (non-combat) top speed.
 */
export function moveCost(world, tile) {
  return TCOST[world.terr[tile]] / (world.roads[tile] ? ROAD_SPEED : 1);
}
