/** Geometry helpers. Every helper takes the world so it works for any configured map size. */

/** Tile index under a division (or any {x,y} in tile coordinates). */
export const tileOf = (world, d) => (d.y | 0) * world.w + (d.x | 0);
export const tileX = (world, i) => i % world.w;
export const tileY = (world, i) => (i / world.w) | 0;
export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
