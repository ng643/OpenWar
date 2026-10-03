// Deterministic map + city layout, independent of how many factions actually play.
//
// The original generator placed one capital per enabled faction and then scattered area-scaled
// neutral cities. Layout and roster are now decoupled: every map always gets CAPITAL_COUNT capitals
// plus the same area-scaled neutral cities, and createWorld() hands one existing city to each
// participant (unused cities stay neutral). For the default six-faction game the seed stream,
// terrain and city placement are byte-identical to the original generator.
import { W, H, LAND } from '../config.js';
import { rng } from '../util.js';
import { generateMap } from './mapgen.js';

export const CAPITAL_COUNT = 6;

/** Nominal player city count for a w×h map: the beam of capitals plus the area-scaled neutrals. */
export function cityCapacity(w, h) {
  return CAPITAL_COUNT + Math.max(2, Math.round(18 * (w * h) / (W * H)));
}

/**
 * Generate the terrain and the full city layout for a seed.
 * @param {number} seed
 * @param {number} [w] @param {number} [h] map dimensions (default: standard map)
 * @returns {{terr: Uint8Array, elev: Float32Array, landCount: number,
 *            cities: Array<{idx: number, x: number, y: number, capital: boolean}>}}
 *   The first `CAPITAL_COUNT` cities are capitals; the rest are neutral. `cities.length` is the
 *   actual seat capacity for this seed, which can fall a little short of `cityCapacity(w, h)` when
 *   the terrain cannot fit every neutral city (createWorld guards against that).
 */
export function generateCityLayout(seed, w = W, h = H) {
  const { terr, elev, landCount } = generateMap(seed, w, h);

  const landTiles = [];
  for (let i = 0; i < w * h; i++) if (terr[i] === LAND) landTiles.push(i);
  const R = rng(seed ^ 0xBEEF), pick = () => landTiles[(R() * landTiles.length) | 0];
  const dist = (a, b) => Math.hypot((a % w) - (b % w), ((a / w) | 0) - ((b / w) | 0));

  // capitals: a random first pick, then farthest-point sampling for the rest
  const picked = [pick()];
  while (picked.length < CAPITAL_COUNT) {
    let bestT = -1, bestD = -1;
    for (let k = 0; k < 500; k++) {
      const t = pick(); let md = 1e9;
      for (const s of picked) md = Math.min(md, dist(t, s));
      if (md > bestD) { bestD = md; bestT = t; }
    }
    picked.push(bestT);
  }

  // neutral cities scale with the map area (standard keeps the original 18 / 4000 attempts exactly)
  const areaRatio = (w * h) / (W * H);
  const neutralTarget = Math.max(2, Math.round(18 * areaRatio));
  const neutralTries = Math.round(4000 * areaRatio);
  for (let k = 0, placed = 0; k < neutralTries && placed < neutralTarget; k++) {
    const t = pick(); let ok = true;
    for (const c of picked) if (dist(t, c) < 11) { ok = false; break; }
    if (ok) { picked.push(t); placed++; }
  }

  return {
    terr, elev, landCount,
    cities: picked.map((t, i) => ({ idx: t, x: t % w, y: (t / w) | 0, capital: i < CAPITAL_COUNT }))
  };
}
