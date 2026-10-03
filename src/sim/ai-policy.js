// Parametric AI policies. A policy is a bounded vector of eight real decision knobs (src/sim/ai.js
// reads them); it is NOT a neural model and grants no resources, information or other cheats. The
// deployed difficulty profiles are produced by the offline natural-selection trainer
// (scripts/train-ai.js) and shipped in ai-models.json - the trainer overwrites that file with the
// measured population, so the numbers here are outcomes of measured play, not hand-picked presets.
import model from './ai-models.json' with { type: 'json' };

/**
 * Every policy parameter, with the bounds the trainer mutates within and the baseline value - the
 * behaviour the AI had before policies existed. `medium` is the baseline, so games that never pick a
 * difficulty keep exactly the balance they had.
 */
export const AI_POLICY_SPEC = Object.freeze({
  /** Owned tiles per division in the army soft cap (3 + floor(tiles / recruitTiles)). */
  recruitTiles: Object.freeze({ lo: 12, hi: 40, base: 22 }),
  /** Share of the troop roll that raises Infantry. */
  infantryShare: Object.freeze({ lo: 0.35, hi: 0.85, base: 0.62 }),
  /** Share of the troop roll that raises Armor; infantryShare + armorShare <= 0.95, the rest is Artillery. */
  armorShare: Object.freeze({ lo: 0.05, hi: 0.4, base: 0.23 }),
  /** Share of gold income set aside for buildings. */
  buildShare: Object.freeze({ lo: 0.15, hi: 0.7, base: 0.5 }),
  /** Share of gold income set aside for roads; buildShare + roadShare <= 0.85. */
  roadShare: Object.freeze({ lo: 0.05, hi: 0.35, base: 0.3 }),
  /** lineDemand() at/above which an army fights as a line instead of scattering to capture land. */
  lineDemand: Object.freeze({ lo: 0.8, hi: 4, base: 2 }),
  /** Tiles a line steps forward when it reaches its slots. */
  advance: Object.freeze({ lo: 4, hi: 14, base: 9 }),
  /** Capture search radius multiplier (1 at baseline). */
  captureRange: Object.freeze({ lo: 0.6, hi: 1.6, base: 1 })
});

/** Canonical parameter order, shared by the trainer's vectors and the artifact. */
export const AI_POLICY_KEYS = Object.freeze(Object.keys(AI_POLICY_SPEC));

/** The baseline policy: pre-policy AI behaviour, and the deployed `medium` profile. */
export const BASE_AI_POLICY = Object.freeze(
  Object.fromEntries(AI_POLICY_KEYS.map(k => [k, AI_POLICY_SPEC[k].base]))
);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Canonicalize one policy: every parameter is clamped into its bound, a missing or non-finite field
 * falls back to the baseline, and the two coupled sums are repaired (armor carries only the troop
 * budget infantry leaves it, roads only the income buildings leave). The input is never mutated and
 * the result is frozen; calling this twice on the same values yields the same policy.
 */
export function normalizeAIPolicy(value) {
  if (value == null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AI policy');
  const out = {};
  for (const k of AI_POLICY_KEYS) {
    const spec = AI_POLICY_SPEC[k];
    out[k] = typeof value[k] === 'number' && Number.isFinite(value[k])
      ? clamp(value[k], spec.lo, spec.hi)
      : spec.base;
  }
  out.armorShare = Math.min(out.armorShare, 0.95 - out.infantryShare);
  out.roadShare = Math.min(out.roadShare, 0.85 - out.buildShare);
  return Object.freeze(out);
}

/** Deployed difficulty profiles: one frozen policy per difficulty, canonicalized once on first use
 * and returned by reference afterwards - a think-pass never allocates or copies parameters. */
const deployed = new Map();

export function getAIPolicy(difficulty = 'medium') {
  const id = difficulty ?? 'medium';
  if (!['easy', 'medium', 'hard'].includes(id)) throw new Error('Unknown AI difficulty');
  let policy = deployed.get(id);
  if (!policy) {
    const profile = model.profiles && model.profiles[id];
    if (!profile || typeof profile.params !== 'object') throw new Error('AI model has no ' + id + ' profile');
    policy = normalizeAIPolicy(profile.params);
    deployed.set(id, policy);
  }
  return policy;
}
