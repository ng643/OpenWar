import { W, H, WATER, LAND, MOUNTAIN } from '../config.js';
import { rng, makeNoise } from '../util.js';

/** Generate one candidate map of w×h tiles (w/h default to the documented standard size). */
export function genTerrain(seed, w = W, h = H) {
  const r = rng(seed), n1 = makeNoise(r), n2 = makeNoise(r), n3 = makeNoise(r);
  const elev = new Float32Array(w * h), terr = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = x / w * 2 - 1, ny = y / h * 2 - 1;
    const d = Math.hypot(nx * 0.95, ny * 1.05);
    let e = 0.55 * n1(x / 24 + 3, y / 24 + 3) + 0.3 * n2(x / 10, y / 10) + 0.15 * n3(x / 4.5, y / 4.5);
    e = e + 0.12 - Math.pow(d, 2.3) * 0.5;
    elev[y * w + x] = e;
    terr[y * w + x] = e < 0.4 ? WATER : (e > 0.66 ? MOUNTAIN : LAND);
  }

  // keep only the largest landmass
  const lab = new Int32Array(w * h).fill(-1);
  let best = -1, bestN = 0, id = 0;
  for (let s = 0; s < w * h; s++) {
    if (terr[s] === WATER || lab[s] >= 0) continue;
    let cnt = 0; const st = [s]; lab[s] = id;
    while (st.length) {
      const c = st.pop(); cnt++;
      const cx = c % w, cy = (c / w) | 0;
      if (cx > 0 && terr[c - 1] && lab[c - 1] < 0) { lab[c - 1] = id; st.push(c - 1); }
      if (cx < w - 1 && terr[c + 1] && lab[c + 1] < 0) { lab[c + 1] = id; st.push(c + 1); }
      if (cy > 0 && terr[c - w] && lab[c - w] < 0) { lab[c - w] = id; st.push(c - w); }
      if (cy < h - 1 && terr[c + w] && lab[c + w] < 0) { lab[c + w] = id; st.push(c + w); }
    }
    if (cnt > bestN) { bestN = cnt; best = id; }
    id++;
  }
  let landCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (lab[i] !== best) terr[i] = WATER; else landCount++;
  }
  return { terr, elev, landCount };
}

/** Generate a map, retrying with derived seeds until there is enough land. */
export function generateMap(seed, w = W, h = H) {
  let tries = 0, m;
  do { m = genTerrain(seed + tries * 7919, w, h); tries++; } while (m.landCount < w * h * 0.3 && tries < 40);
  return m;
}
