import { WATER } from '../config.js';
import { moveCost, MIN_MOVE_COST } from './travel.js';

// Scratch buffers are reused between searches (stamp trick avoids clearing them). They live per
// world so several worlds of different sizes can be simulated interleaved without reallocating or
// corrupting each other's state.
const scratch = new WeakMap();
function scratchFor(world) {
  let s = scratch.get(world);
  if (!s) {
    const n = world.w * world.h;
    s = {
      gScore: new Float32Array(n), cameFrom: new Int32Array(n),
      stamp: new Int32Array(n), closed: new Int32Array(n), stampN: 0
    };
    scratch.set(world, s);
  }
  return s;
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(v, k) {
    const K = this.k, V = this.v;
    let i = K.length; K.push(k); V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= K[i]) break;
      [K[p], K[i]] = [K[i], K[p]]; [V[p], V[i]] = [V[i], V[p]]; i = p;
    }
  }
  pop() {
    const K = this.k, V = this.v, top = V[0], lk = K.pop(), lv = V.pop();
    if (K.length) {
      K[0] = lk; V[0] = lv;
      let i = 0; const n = K.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < n && K[l] < K[m]) m = l;
        if (r < n && K[r] < K[m]) m = r;
        if (m === i) break;
        [K[m], K[i]] = [K[i], K[m]]; [V[m], V[i]] = [V[i], V[m]]; i = m;
      }
    }
    return top;
  }
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * A* over the tile grid (8-way, no corner cutting through water). Step cost is travel.js moveCost of
 * the entered tile, so roads (1.5x cheaper) are preferred where they help; the heuristic is the octile
 * distance scaled by the cheapest possible move cost, keeping it admissible on and off roads.
 * @param {Set<number>|null} [blocked] tile indices to treat as impassable (bodies standing in the way);
 *   a diagonal step is refused when either of the two tiles it cuts the corner of is blocked, the same
 *   way water corners are, since two bodies on neighbouring tiles leave no room to squeeze between.
 * @returns {number[]|null} tile indices from the tile after `s` to `t`, [] if s===t, null if unreachable.
 */
export function findPath(world, s, t, blocked = null) {
  const terr = world.terr, w = world.w, h = world.h;
  if (terr[t] === WATER) return null;
  if (s === t) return [];
  const sc = scratchFor(world);
  const { gScore, cameFrom, stamp, closed } = sc;
  const stampN = ++sc.stampN;
  const hp = new MinHeap(), tx = t % w, ty = (t / w) | 0;
  const hCost = i => {
    const dx = Math.abs((i % w) - tx), dy = Math.abs(((i / w) | 0) - ty);
    return (dx + dy - 0.586 * Math.min(dx, dy)) * MIN_MOVE_COST;
  };
  gScore[s] = 0; stamp[s] = stampN; cameFrom[s] = -1; hp.push(s, hCost(s));
  while (hp.size) {
    const cur = hp.pop();
    if (cur === t) break;
    if (closed[cur] === stampN) continue;
    closed[cur] = stampN;
    const cx = cur % w, cy = (cur / w) | 0;
    for (let k = 0; k < 8; k++) {
      const dx = DIRS[k][0], dy = DIRS[k][1], nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (terr[ni] === WATER || (blocked && blocked.has(ni))) continue;
      if (dx && dy && (terr[cy * w + nx] === WATER || terr[ny * w + cx] === WATER
        || (blocked && (blocked.has(cy * w + nx) || blocked.has(ny * w + cx))))) continue;
      const ng = gScore[cur] + (dx && dy ? 1.414 : 1) * moveCost(world, ni);
      if (stamp[ni] !== stampN || ng < gScore[ni]) {
        stamp[ni] = stampN; gScore[ni] = ng; cameFrom[ni] = cur;
        hp.push(ni, ng + hCost(ni));
      }
    }
  }
  if (stamp[t] !== stampN) return null;
  const path = [];
  for (let c = t; c !== s; c = cameFrom[c]) path.push(c);
  return path.reverse();
}

/** Nearest land tile index to a world position (searches outward), or -1. */
export function nearestLand(world, x, y) {
  const terr = world.terr, w = world.w, h = world.h;
  x = Math.max(0, Math.min(w - 1, x | 0)); y = Math.max(0, Math.min(h - 1, y | 0));
  if (terr[y * w + x]) return y * w + x;
  for (let r = 1; r < 14; r++) {
    let best = -1, bd = 1e9;
    for (let j = y - r; j <= y + r; j++) for (let i = x - r; i <= x + r; i++) {
      if (i < 0 || j < 0 || i >= w || j >= h || terr[j * w + i] === WATER) continue;
      const d = Math.hypot(i - x, j - y);
      if (d < bd) { bd = d; best = j * w + i; }
    }
    if (best >= 0) return best;
  }
  return -1;
}
