// Small deterministic helpers shared by the sim.

/** Mulberry32 seeded PRNG: returns a function producing floats in [0,1). */
export function rng(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** 2D value noise sampler built from a PRNG. */
export function makeNoise(r) {
  const N = 64, g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const sm = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = sm(x - xi), fy = sm(y - yi);
    const a = g[(yi & 63) * N + (xi & 63)], b = g[(yi & 63) * N + ((xi + 1) & 63)];
    const c = g[((yi + 1) & 63) * N + (xi & 63)], d = g[((yi + 1) & 63) * N + ((xi + 1) & 63)];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
