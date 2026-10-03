#!/usr/bin/env node
/**
 * scripts/train-ai.js - real, seeded natural selection for the AI policy profiles.
 *
 * This trainer plays the SHIPPED simulation: every candidate is a parametric policy handed into
 * createWorld({ aiPolicies }) and every match is a real small-map 1v1 between two AI players on
 * balanced faction assignments (each pair plays both seats on every seed, so a map/seat edge can
 * never masquerade as policy strength). No handicaps, no bonus resources, no wall-clock in the
 * fitness: a match runs tick() until the world really ends (victory) or the sim-minute cap is hit.
 *
 *   score(seat) = (winner === seat ? 2 : 0) + tiles / landTiles + 0.5 * cities / (cities + opponents)
 *
 * Evolution: truncation selection (top keepFrac of the ranked parents), elitism (the top `elite`
 * members are copied to the next generation unchanged), uniform crossover of two parents and
 * per-parameter Gaussian-free bounded mutation. Every candidate is normalized with the runtime
 * normalizeAIPolicy, so trained profiles can never leave the documented parameter bounds.
 *
 * Hard and Medium come from a held-out validation table (seeds disjoint from the training set,
 * mirrored seats vs the baseline reference): Hard is the best measured evolved candidate and Medium
 * stays the deployed baseline - so the default gameplay and its tests are untouched - and its
 * validation row is still measured. Easy is deliberately NOT the weakest survivor of a population
 * that beats the baseline (such a "loser" still wins): it is selected by a dedicated bounded
 * weakening search that breeds the weakest sampled archive members of all generations plus mutants,
 * plays every candidate both seats against the baseline on its own seeds, keeps the lowest measured
 * score, and keeps breeding (at least --weaken-gens generations, at most twice that) until the
 * candidate is measured decisively weaker than baseline self-play.
 * The artifact records every candidate, its real scores, the exact seed sets and the run
 * configuration; nothing is labelled trained that was not played, and an Easy profile is only
 * presented as easier when its own evaluation says so.
 *
 * Usage:
 *   node scripts/train-ai.js [options]
 *     --pop N            population per generation, 4..64            (default 12)
 *     --gens N           generations of selection, 1..100            (default 6)
 *     --minutes M        sim-minute cap per match, 2..60             (default 10)
 *     --seeds a,b,c      training seeds, 1..16 distinct integers     (default 101,202,303)
 *     --eval-seeds a,b   held-out validation seeds, disjoint         (default 9109,9203,9407,9601)
 *     --easy-seeds a,b   Easy weakening-search seeds, disjoint       (default 8302,8404,8506,8608)
 *     --assess-seeds a,b independent assessment seeds, disjoint      (default 5101,5203,5309,5407,5501,5603,5701,5807)
 *     --weaken-gens N    bounded weakening-search generations, 0..12 (default 2, one extension allowed)
 *     --weaken-pop N     weakening-search population, 4..64          (default 8)
 *     --master-seed N    master RNG seed for the whole run           (default 20250923)
 *     --out path         artifact to write (default src/sim/ai-models.json, atomic tmp+rename)
 *     --init path        extend a previous artifact's population instead of starting fresh
 *     --help             show this text
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STEP } from '../src/config.js';
import { createWorld } from '../src/sim/world.js';
import { tick } from '../src/sim/game.js';
import { rng as makeRng } from '../src/util.js';
import { AI_POLICY_KEYS, AI_POLICY_SPEC, BASE_AI_POLICY, normalizeAIPolicy } from '../src/sim/ai-policy.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = resolve(REPO_ROOT, 'src/sim/ai-models.json');

export const DEFAULTS = {
  pop: 12,
  gens: 6,
  minutes: 10,
  seeds: [101, 202, 303],
  evalSeeds: [9109, 9203, 9407, 9601],
  easySeeds: [8302, 8404, 8506, 8608],
  assessSeeds: [5101, 5203, 5309, 5407, 5501, 5603, 5701, 5807],
  masterSeed: 20250923,
  mutationProb: 0.3,
  mutationScale: 0.25,
  keepFrac: 0.5,
  elite: 2,
  weakenGens: 3,
  weakenPop: 10,
};

const HELP = `train-ai: real seeded natural selection for the AI policy profiles.

  node scripts/train-ai.js [options]
    --pop N            population per generation, 4..64            (default ${DEFAULTS.pop})
    --gens N           generations of selection, 1..100            (default ${DEFAULTS.gens})
    --minutes M        sim-minute cap per match, 2..60             (default ${DEFAULTS.minutes})
    --seeds a,b,c      training seeds, 1..16 distinct integers     (default ${DEFAULTS.seeds})
    --eval-seeds a,b   held-out validation seeds, disjoint         (default ${DEFAULTS.evalSeeds})
    --easy-seeds a,b   Easy weakening-search seeds, disjoint       (default ${DEFAULTS.easySeeds})
    --assess-seeds a,b independent assessment seeds, disjoint      (default ${DEFAULTS.assessSeeds})
    --weaken-gens N    bounded weakening-search generations, 0..12 (default ${DEFAULTS.weakenGens})
    --weaken-pop N     weakening-search population, 4..64          (default ${DEFAULTS.weakenPop})
    --master-seed N    master RNG seed for the whole run           (default ${DEFAULTS.masterSeed})
    --out path         artifact to write, atomically (default src/sim/ai-models.json)
    --init path        extend the population of a previous artifact
    --help             show this text

Every match runs the real simulation to real victory or the sim-minute cap. Training uses --seeds;
Hard and Medium come from the held-out table on --eval-seeds (disjoint). Easy is chosen by the
weakening search on --easy-seeds: real candidates are played against the baseline, both seats, and
only a candidate measured weaker than baseline self-play is labelled Easy. The final Easy/Medium/
Hard pairwise assessment uses --assess-seeds, disjoint from every other seed set.`;

const r4 = v => Math.round(v * 1e4) / 1e4;
const meanScore = m => (m.games ? m.score / m.games : 0);
const winRate = m => (m.games ? m.wins / m.games : 0);
const paramsKey = p => AI_POLICY_KEYS.map(k => p[k].toFixed(4)).join(',');

/** Lowest measured candidate first (weakness ordering); ties break on win rate then params. */
export const pickWeakest = rows => rows.slice()
  .sort((a, b) => meanScore(a) - meanScore(b) || winRate(a) - winRate(b) || a.key.localeCompare(b.key))[0] || null;

/** Parse CLI arguments into a raw config (syntax only; validateConfig() checks the semantics). */
export function parseArgs(argv = []) {
  const cfg = { ...DEFAULTS, out: DEFAULT_OUT, init: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--pop': cfg.pop = Number(value()); break;
      case '--gens': cfg.gens = Number(value()); break;
      case '--minutes': cfg.minutes = Number(value()); break;
      case '--seeds': cfg.seeds = parseSeedList(value(), a); break;
      case '--eval-seeds': cfg.evalSeeds = parseSeedList(value(), a); break;
      case '--easy-seeds': cfg.easySeeds = parseSeedList(value(), a); break;
      case '--assess-seeds': cfg.assessSeeds = parseSeedList(value(), a); break;
      case '--weaken-gens': cfg.weakenGens = Number(value()); break;
      case '--weaken-pop': cfg.weakenPop = Number(value()); break;
      case '--master-seed': cfg.masterSeed = Number(value()); break;
      case '--out': cfg.out = resolve(process.cwd(), value()); break;
      case '--init': cfg.init = resolve(process.cwd(), value()); break;
      case '--help': case '-h': cfg.help = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  return cfg;
}

function parseSeedList(text, flag) {
  const parts = text.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`${flag} needs a comma-separated list of seeds`);
  return parts.map(p => {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag}: '${p}' is not a positive integer seed`);
    return n;
  });
}

/** Bounded-configuration check: population/generations/seed sets/time are all validated up front. */
export function validateConfig(cfg) {
  const problems = [];
  const int = (v, lo, hi, name) => {
    if (!Number.isInteger(v) || v < lo || v > hi) problems.push(`${name} must be an integer in [${lo}, ${hi}] (got ${v})`);
  };
  int(cfg.pop, 4, 64, '--pop');
  int(cfg.gens, 1, 100, '--gens');
  if (!Number.isFinite(cfg.minutes) || cfg.minutes < 2 || cfg.minutes > 60) {
    problems.push(`--minutes must be a number in [2, 60] (got ${cfg.minutes})`);
  }
  int(cfg.masterSeed, 1, Number.MAX_SAFE_INTEGER, '--master-seed');
  int(cfg.weakenGens, 0, 12, '--weaken-gens');
  int(cfg.weakenPop, 4, 64, '--weaken-pop');
  for (const [name, list] of [
    ['--seeds', cfg.seeds], ['--eval-seeds', cfg.evalSeeds],
    ['--easy-seeds', cfg.easySeeds], ['--assess-seeds', cfg.assessSeeds],
  ]) {
    if (!Array.isArray(list) || !list.length || list.length > 16) {
      problems.push(`${name} needs 1..16 seeds`);
      continue;
    }
    if (new Set(list).size !== list.length) problems.push(`${name} contains duplicate seeds`);
  }
  if (Array.isArray(cfg.seeds) && Array.isArray(cfg.evalSeeds)) {
    const shared = cfg.evalSeeds.filter(s => cfg.seeds.includes(s));
    if (shared.length) problems.push(`--eval-seeds must be disjoint from --seeds (shared: ${shared.join(', ')})`);
  }
  if (Array.isArray(cfg.easySeeds)) {
    const shared = cfg.easySeeds.filter(s =>
      (cfg.seeds || []).includes(s) || (cfg.evalSeeds || []).includes(s));
    if (shared.length) problems.push(`--easy-seeds must be disjoint from --seeds and --eval-seeds (shared: ${shared.join(', ')})`);
  }
  if (Array.isArray(cfg.assessSeeds)) {
    const shared = cfg.assessSeeds.filter(s =>
      (cfg.seeds || []).includes(s) || (cfg.evalSeeds || []).includes(s) || (cfg.easySeeds || []).includes(s));
    if (shared.length) problems.push(`--assess-seeds must be disjoint from the other seed sets (shared: ${shared.join(', ')})`);
  }
  if (!cfg.out || typeof cfg.out !== 'string') problems.push('--out must be a file path');
  if (cfg.init && !existsSync(cfg.init)) problems.push(`--init file not found: ${cfg.init}`);
  if (problems.length) throw new Error(`Invalid training configuration:\n  - ${problems.join('\n  - ')}`);
  return cfg;
}

/** Fisher-Yates with the run's seeded RNG, so pairings are part of the reproducible run. */
function shuffle(list, rand) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function crossover(a, b, rand) {
  const out = {};
  for (const k of AI_POLICY_KEYS) out[k] = rand() < 0.5 ? a[k] : b[k];
  return normalizeAIPolicy(out);
}

/** Bounded mutation: each parameter is nudged by up to scale×(hi-lo) with probability prob. */
function mutate(params, rand, prob, scale) {
  const out = { ...params };
  for (const k of AI_POLICY_KEYS) {
    if (rand() >= prob) continue;
    const { lo, hi } = AI_POLICY_SPEC[k];
    out[k] = params[k] + (rand() * 2 - 1) * scale * (hi - lo);
  }
  return normalizeAIPolicy(out);
}

/** One real match: seat 1 thinks with a, seat 2 with b. Runs to real victory or the cap. */
function playDuel(cfg, seed, a, b) {
  const world = createWorld(seed, {
    settings: { mapSize: 'small', factions: [1, 2], aiDifficulty: 'medium' },
    humans: [],
    aiDelay: 1,
    aiPolicies: { 1: a, 2: b },
  });
  const cap = cfg.minutes * 60;
  while (!world.over && world.time < cap) tick(world, STEP);
  return world;
}

/** Fitness of one seat in a finished (or capped) duel: win dominates, then land, then cities. */
function matchScore(world, seat) {
  const p = world.players[seat - 1];
  const q = world.players[seat === 1 ? 1 : 0];
  const cityShare = p.cities / Math.max(1, p.cities + q.cities);
  const win = world.result && world.result.winnerId === seat;
  return (win ? 2 : 0) + (world.landCount ? p.tiles / world.landCount : 0) + 0.5 * cityShare;
}

function addScore(member, score) {
  member.score += score;
  member.games += 1;
}

/** Play a pair on every training seed with BOTH faction assignments. */
function duelPair(cfg, a, b, seeds) {
  for (const seed of seeds) {
    for (const first of [a, b]) {
      const second = first === a ? b : a;
      const world = playDuel(cfg, seed, first.params, second.params);
      addScore(first, matchScore(world, 1));
      addScore(second, matchScore(world, 2));
      const winner = world.result ? world.result.winnerId : null;
      if (winner === 1) first.wins += 1;
      else if (winner === 2) second.wins += 1;
    }
  }
}

/** Evaluate the whole population this generation; an odd member plays the baseline instead. */
function evaluatePool(cfg, rand, members, seeds) {
  const order = shuffle(members.slice(), rand);
  for (let i = 0; i + 1 < order.length; i += 2) duelPair(cfg, order[i], order[i + 1], seeds);
  if (order.length % 2 === 1) {
    const spare = { params: normalizeAIPolicy(BASE_AI_POLICY), score: 0, games: 0, wins: 0 };
    duelPair(cfg, order[order.length - 1], spare, seeds);
  }
}

/** One candidate against the fixed baseline reference on held-out seeds, both seats. */
function evaluateCandidate(cfg, row, baseline, seeds) {
  for (const seed of seeds) {
    const perSeed = { seed, score: 0, oppScore: 0, wins: 0, games: 0 };
    for (const seat of [1, 2]) {
      const world = playDuel(cfg, seed, seat === 1 ? row.params : baseline, seat === 1 ? baseline : row.params);
      const mine = matchScore(world, seat);
      const theirs = matchScore(world, seat === 1 ? 2 : 1);
      addScore(row, mine);
      row.oppScore += theirs;
      perSeed.score += mine;
      perSeed.oppScore += theirs;
      perSeed.games += 1;
      const winner = world.result ? world.result.winnerId : null;
      if (winner === seat) { row.wins += 1; perSeed.wins += 1; }
    }
    row.perSeed.push({ seed, mean: r4(perSeed.score / perSeed.games), opponent: r4(perSeed.oppScore / perSeed.games), wins: perSeed.wins, games: perSeed.games });
  }
  return row;
}

/**
 * Bounded weakening search ("backward selection") for the Easy profile. Starting from the weakest
 * sampled archive members - real candidates from all generations, including the poor early ones -
 * it breeds the weakest measured parents (uniform crossover + bounded mutation, keep the weakest
 * half) and plays every new candidate both seats against the baseline reference on the dedicated
 * easy seeds. It always runs at least --weaken-gens generations, then keeps going (up to maxGens =
 * 2 x --weaken-gens) until the weakest measured candidate is below baseline self-play by a decisive
 * margin (a quarter point on the fitness scale, where a match win is worth 2), so Easy is not a
 * statistically worthless hair-line pick. The returned rows are the complete measured candidate
 * table; the artifact keeps all of them.
 */
function weakenSearch(cfg, rand, seeds, starts, baselineMean, log) {
  const base = normalizeAIPolicy(BASE_AI_POLICY);
  const maxGens = cfg.weakenGens * 2;
  const DECISIVE = 0.25;
  const rows = [];
  const byKey = new Map();
  const evaluate = (params, source) => {
    const key = paramsKey(params);
    const seen = byKey.get(key);
    if (seen) return seen;
    const row = { id: `weak-${rows.length + 1}`, key, params, source, score: 0, oppScore: 0, games: 0, wins: 0, perSeed: [] };
    evaluateCandidate(cfg, row, base, seeds);
    byKey.set(key, row);
    rows.push(row);
    return row;
  };
  let pool = [];
  for (const start of starts) pool.push(evaluate(start.params, start.source));
  if (!pool.length) pool.push(evaluate(base, 'baseline start (no archive members)'));
  let gensRun = 0;
  const weakMargin = () => baselineMean - meanScore(pickWeakest(rows));
  while (gensRun < maxGens && (gensRun < cfg.weakenGens || weakMargin() < DECISIVE)) {
    gensRun += 1;
    const rankedPool = pool.slice()
      .sort((a, b) => meanScore(a) - meanScore(b) || winRate(a) - winRate(b) || a.key.localeCompare(b.key));
    const parents = rankedPool.slice(0, Math.max(2, Math.ceil(rankedPool.length / 2)));
    const next = parents.map(m => m.params);
    while (next.length < Math.max(cfg.weakenPop, parents.length)) {
      const a = parents[(rand() * parents.length) | 0].params;
      const b = parents[(rand() * parents.length) | 0].params;
      next.push(mutate(crossover(a, b, rand), rand, 0.7, 0.4));
    }
    pool = next.map(params => evaluate(params, `weakening search, gen ${gensRun}`));
    log(`  weaken gen ${gensRun}/${maxGens}: weakest ${r4(meanScore(pickWeakest(rows)))} vs baseline self-play ${r4(baselineMean)}` +
      ` (margin ${r4(weakMargin())}, ${rows.length} candidates measured)`);
  }
  return { rows, gensRun, maxGens };
}

/** Independent pairwise assessment of the three selected profiles, on fresh seeds, both seats. */
function assessPair(cfg, an, a, bn, b, seeds) {
  const row = { a: an, b: bn, seeds, aWins: 0, bWins: 0, games: 0, aScore: 0, bScore: 0, perSeed: [], verdict: 'inconclusive' };
  for (const seed of seeds) {
    const perSeed = { seed, aScore: 0, bScore: 0, aWins: 0, games: 0 };
    for (const seat of [1, 2]) {
      const world = playDuel(cfg, seed, seat === 1 ? a : b, seat === 1 ? b : a);
      const as = seat === 1 ? matchScore(world, 1) : matchScore(world, 2);
      const bs = seat === 1 ? matchScore(world, 2) : matchScore(world, 1);
      row.aScore += as; row.bScore += bs; perSeed.aScore += as; perSeed.bScore += bs;
      row.games += 1; perSeed.games += 1;
      const winner = world.result ? world.result.winnerId : null;
      if ((seat === 1 && winner === 1) || (seat === 2 && winner === 2)) { row.aWins += 1; perSeed.aWins += 1; }
      else if (winner === 1 || winner === 2) row.bWins += 1;
    }
    row.perSeed.push({ seed, a: r4(perSeed.aScore / perSeed.games), b: r4(perSeed.bScore / perSeed.games), aWins: perSeed.aWins, games: perSeed.games });
  }
  const margin = row.games ? (row.aScore - row.bScore) / row.games : 0;
  const winMargin = Math.abs(row.aWins - row.bWins);
  if (winMargin >= 2 && Math.sign(row.aWins - row.bWins) === Math.sign(margin) && margin !== 0) {
    row.verdict = row.aWins > row.bWins ? `${an} stronger` : `${bn} stronger`;
  }
  row.margin = r4(margin);
  return row;
}

/**
 * Run the whole training. Returns the artifact (ready to write) and its summary. Deterministic for
 * a fixed config and master seed: the simulation, the pairings and the mutations are all seeded.
 */
export function trainFromConfig(cfg, log = console.log) {
  const started = Date.now();
  const rand = makeRng(cfg.masterSeed);
  const baseline = normalizeAIPolicy(BASE_AI_POLICY);
  log(`train-ai: pop=${cfg.pop} gens=${cfg.gens} minutes=${cfg.minutes} seats=both` +
    ` seeds=[${cfg.seeds}] eval=[${cfg.evalSeeds}] easy=[${cfg.easySeeds}] assess=[${cfg.assessSeeds}]` +
    ` weaken=${cfg.weakenGens}x${cfg.weakenPop} masterSeed=${cfg.masterSeed}`);

  // --- Population: baseline seed + mutants, or the population of a previous artifact. ----------
  const population = [];
  let extendedFrom = null;
  if (cfg.init) {
    const init = JSON.parse(readFileSync(cfg.init, 'utf8'));
    extendedFrom = { file: cfg.init, generatedAt: init.generatedAt || null, trained: !!init.trained };
    for (const m of init.population || []) population.push(normalizeAIPolicy(m.params));
    population.length = Math.min(population.length, cfg.pop);
    log(`train-ai: seeded ${population.length} member(s) from ${cfg.init}`);
  }
  while (population.length < cfg.pop) {
    population.push(population.length === 0 ? baseline : mutate(baseline, rand, 0.6, 0.5));
  }

  const archive = new Map();   // paramsKey -> best fitness ever measured for those exact params
  const record = (member, gen) => {
    const key = paramsKey(member.params);
    const best = meanScore(member);
    const seen = archive.get(key);
    if (!seen || best > seen.fitness) archive.set(key, { params: member.params, fitness: r4(best), wins: member.wins, games: member.games, gen });
  };

  // --- Generations: evaluate, rank, truncate, breed (no breeding after the final evaluation). --
  const history = [];
  let ranked = [];
  for (let gen = 1; gen <= cfg.gens; gen++) {
    const genStart = Date.now();
    const members = population.map(params => ({ params, score: 0, games: 0, wins: 0 }));
    evaluatePool(cfg, rand, members, cfg.seeds);
    for (const m of members) record(m, gen);
    ranked = members.slice().sort((a, b) => meanScore(b) - meanScore(a) || winRate(b) - winRate(a) || paramsKey(a.params).localeCompare(paramsKey(b.params)));
    const mean = members.reduce((s, m) => s + meanScore(m), 0) / members.length;
    history.push({
      gen,
      best: r4(meanScore(ranked[0])),
      mean: r4(mean),
      worst: r4(meanScore(ranked[ranked.length - 1])),
      wins: members.reduce((s, m) => s + m.wins, 0),
      games: members.reduce((s, m) => s + m.games, 0),
      ms: Date.now() - genStart,
    });
    const h = history[history.length - 1];
    log(`  gen ${gen}/${cfg.gens}: best ${h.best} mean ${h.mean} worst ${h.worst}` +
      ` (${h.games} games, ${h.wins} wins, ${(h.ms / 1000).toFixed(1)}s)`);

    if (gen === cfg.gens) break;   // the last generation's evaluated population is the output
    const keep = Math.max(cfg.elite + 2, Math.ceil(cfg.pop * cfg.keepFrac));
    const parents = ranked.slice(0, Math.min(keep, ranked.length));
    const next = ranked.slice(0, Math.min(cfg.elite, ranked.length)).map(m => m.params);
    while (next.length < cfg.pop) {
      const a = parents[(rand() * parents.length) | 0];
      const b = parents[(rand() * parents.length) | 0];
      next.push(mutate(crossover(a.params, b.params, rand), rand, cfg.mutationProb, cfg.mutationScale));
    }
    population.length = 0;
    population.push(...next);
  }

  // --- Held-out validation: baseline + best final + worst archive, mirrored seats. --------------
  const candidates = [];
  const pushCandidate = (id, params, source) => {
    const key = paramsKey(params);
    if (candidates.some(c => c.key === key)) return;
    candidates.push({ id, params, key, source, score: 0, oppScore: 0, games: 0, wins: 0, perSeed: [] });
  };
  pushCandidate('baseline', baseline, 'deployed baseline reference');
  ranked.slice(0, 3).forEach((m, i) => pushCandidate(`final-top${i + 1}`, m.params, 'top of the final evaluated population'));
  [...archive.values()].sort((a, b) => a.fitness - b.fitness).slice(0, 2)
    .forEach((e, i) => pushCandidate(`archive-worst${i + 1}`, e.params, `weakest archived member (gen ${e.gen})`));
  log(`  validation: ${candidates.length} candidates x ${cfg.evalSeeds.length} held-out seeds x 2 seats`);
  for (const c of candidates) evaluateCandidate(cfg, c, baseline, cfg.evalSeeds);
  const ranking = candidates.slice().sort((a, b) => meanScore(b) - meanScore(a) || winRate(b) - winRate(a) || a.key.localeCompare(b.key));
  ranking.forEach((c, i) => log(`    #${i + 1} ${c.id}: mean ${r4(meanScore(c))} vs baseline ${r4(c.games ? c.oppScore / c.games : 0)}` +
    ` (win rate ${r4(winRate(c))}, source: ${c.source})`));

  const evolved = ranking.filter(c => c.id !== 'baseline');
  const baselineRow = ranking.find(c => c.id === 'baseline');
  const hardRow = evolved[0] || baselineRow;
  const rankOf = row => ranking.indexOf(row) + 1;
  const describe = row => `evolved candidate '${row.id}' (validation rank ${rankOf(row)}/${ranking.length}, ` +
    `mean score ${r4(meanScore(row))} vs baseline ${r4(row.games ? row.oppScore / row.games : 0)}, win rate ${r4(winRate(row))})`;

  // --- Easy: the weakest MEASURED candidate, not the weakest survivor of a strong population. ---
  // Baseline self-play on the easy seeds is the comparison point: a candidate whose own measured
  // score is below it really loses ground to the deployed Medium.
  const easyBaseline = {
    id: 'baseline-selfplay', key: paramsKey(baseline), params: baseline,
    source: 'baseline reference playing itself', score: 0, oppScore: 0, games: 0, wins: 0, perSeed: [],
  };
  evaluateCandidate(cfg, easyBaseline, baseline, cfg.easySeeds);
  const baselineMean = meanScore(easyBaseline);
  const weakStarts = [...archive.values()]
    .sort((a, b) => a.fitness - b.fitness || paramsKey(a.params).localeCompare(paramsKey(b.params)))
    .slice(0, 3)
    .map((e, i) => ({ params: e.params, source: `weakest sampled archive member #${i + 1} (gen ${e.gen}, training fitness ${e.fitness})` }));
  log(`  easy: weakening search vs baseline self-play ${r4(baselineMean)} on seeds [${cfg.easySeeds}]`);
  const search = weakenSearch(cfg, rand, cfg.easySeeds, weakStarts, baselineMean, log);
  const easyRows = search.rows.slice()
    .sort((a, b) => meanScore(a) - meanScore(b) || winRate(a) - winRate(b) || a.key.localeCompare(b.key));
  const easyRow = easyRows[0] || easyBaseline;
  const easyMargin = r4(baselineMean - meanScore(easyRow));
  const easyWeaker = meanScore(easyRow) < baselineMean;
  log(`  easy: '${easyRow.id}' mean ${r4(meanScore(easyRow))} vs baseline self-play ${r4(baselineMean)}` +
    ` (${easyRow.games} games, win rate ${r4(winRate(easyRow))}) ->` +
    ` ${easyWeaker ? `measured weaker by ${easyMargin}` : 'NOT measured weaker'}`);

  const profileOrigin = {
    easy: `weakest measured candidate on the easy seeds: '${easyRow.id}' from ${easyRow.source}; ` +
      `mean score ${r4(meanScore(easyRow))} vs baseline self-play ${r4(baselineMean)} over ${easyRow.games} games ` +
      `[seeds ${cfg.easySeeds}], win rate ${r4(winRate(easyRow))}` +
      (easyWeaker ? ` - measured weaker than the retained baseline Medium by ${easyMargin}`
        : ' - the bounded weakening search hit its generation cap without a candidate measured weaker than baseline self-play'),
    medium: `retained deployed baseline (compatibility: existing default gameplay) - ` +
      `evaluated on the same held-out seeds: rank ${rankOf(baselineRow)}/${ranking.length}, ` +
      `mean score ${r4(meanScore(baselineRow))}`,
    hard: evolved.length ? `best evolved candidate: ${describe(hardRow)}`
      : `retained deployed baseline: no evolved candidate survived validation, rank ${rankOf(baselineRow)}/${ranking.length}, ` +
        `mean score ${r4(meanScore(baselineRow))}`,
  };
  const profiles = {
    easy: { params: easyRow.params, origin: profileOrigin.easy },
    medium: { params: baseline, origin: profileOrigin.medium },
    hard: { params: hardRow.params, origin: profileOrigin.hard },
  };

  // --- Independent pairwise assessment of the three selected profiles on fresh seeds. -----------
  const assessment = [];
  log('  assessment (fresh seeds, both faction assignments):');
  for (const [an, bn] of [['hard', 'medium'], ['hard', 'easy'], ['medium', 'easy']]) {
    const row = assessPair(cfg, an, profiles[an].params, bn, profiles[bn].params, cfg.assessSeeds);
    assessment.push(row);
    log(`    ${an} vs ${bn}: wins ${row.aWins}-${row.bWins}, mean margin ${row.margin} -> ${row.verdict}`);
  }

  const verdicts = assessment.map(r => `${r.a} vs ${r.b}: ${r.verdict}`);
  const artifact = {
    version: 1,
    kind: 'ai-policy-profiles',
    trained: true,
    bootstrap: false,
    generatedBy: 'scripts/train-ai.js',
    generatedAt: new Date().toISOString(),
    note: 'Produced by real seeded natural selection inside the shipped simulation. Medium is the retained ' +
      'deployed baseline (its held-out measurements are recorded); Hard is the best evolved candidate. Easy is ' +
      'the weakest measured candidate from the sampled archive plus a bounded weakening search, played against ' +
      'the baseline on its own seeds, and is only labelled measured weaker when its own numbers say so.',
    config: {
      pop: cfg.pop, gens: cfg.gens, minutes: cfg.minutes,
      seeds: cfg.seeds, evalSeeds: cfg.evalSeeds, easySeeds: cfg.easySeeds, assessSeeds: cfg.assessSeeds,
      masterSeed: cfg.masterSeed,
      mutationProb: cfg.mutationProb, mutationScale: cfg.mutationScale, keepFrac: cfg.keepFrac, elite: cfg.elite,
      weakenGens: cfg.weakenGens, weakenPop: cfg.weakenPop,
      extendedFrom,
    },
    fitness: {
      formula: '(winner ? 2 : 0) + tiles / landTiles + 0.5 * cities / (own + opponent cities); averaged over matches',
      seats: 'every pair plays both faction assignments on every seed',
      cap: `${cfg.minutes} simulated minutes per match, real victory ends it earlier`,
    },
    profiles,
    validation: {
      seeds: cfg.evalSeeds,
      ranking: ranking.map((c, i) => ({
        rank: i + 1, id: c.id, source: c.source, params: c.params,
        meanScore: r4(meanScore(c)), opponentMean: r4(c.games ? c.oppScore / c.games : 0),
        wins: c.wins, games: c.games, winRate: r4(winRate(c)), perSeed: c.perSeed,
      })),
    },
    assessment: { seeds: cfg.assessSeeds, pairs: assessment, verdicts },
    easySelection: {
      seeds: cfg.easySeeds,
      baselineSelfPlay: { meanScore: r4(baselineMean), wins: easyBaseline.wins, games: easyBaseline.games },
      search: { gensRun: search.gensRun, maxGens: search.maxGens, pop: cfg.weakenPop, evaluated: easyRows.length },
      chosen: {
        id: easyRow.id, source: easyRow.source, params: easyRow.params,
        meanScore: r4(meanScore(easyRow)), winRate: r4(winRate(easyRow)), wins: easyRow.wins, games: easyRow.games,
        marginVsBaseline: easyMargin, weakerThanBaseline: easyWeaker, perSeed: easyRow.perSeed,
      },
      candidates: easyRows.map(row => ({
        id: row.id, source: row.source, params: row.params,
        meanScore: r4(meanScore(row)), opponentMean: r4(row.games ? row.oppScore / row.games : 0),
        wins: row.wins, games: row.games, winRate: r4(winRate(row)), perSeed: row.perSeed,
      })),
    },
    history,
    population: ranked.map(m => ({ params: m.params, fitness: r4(meanScore(m)), wins: m.wins, games: m.games })),
    archiveSize: archive.size,
    elapsedMs: Date.now() - started,
  };
  log(`train-ai: done in ${(artifact.elapsedMs / 1000).toFixed(1)}s (${verdicts.join('; ')})`);
  return { artifact, summary: { history, ranking, assessment, profiles, easy: { chosen: easyRow, baselineMean, rows: easyRows, gensRun: search.gensRun } } };
}

/** Atomic artifact write: temp file in the target directory, then rename (readers see either old or new). */
export function writeArtifact(path, artifact) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + '\n');
  renameSync(tmp, path);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const raw = parseArgs(process.argv.slice(2));
    if (raw.help) {
      console.log(HELP);
      process.exit(0);
    }
    const cfg = validateConfig(raw);
    const { artifact, summary } = trainFromConfig(cfg, console.log);
    writeArtifact(cfg.out, artifact);
    console.log(`\ntrain-ai: wrote ${cfg.out}`);
    console.log('  easy:', JSON.stringify(artifact.profiles.easy.params));
    console.log('  medium:', JSON.stringify(artifact.profiles.medium.params));
    console.log('  hard:', JSON.stringify(artifact.profiles.hard.params));
    console.log(`  validation seeds [${cfg.evalSeeds}] ranking: ${summary.ranking.map(r => `${r.id}=${r4(meanScore(r))}`).join(', ')}`);
    console.log(`  easy seeds [${cfg.easySeeds}]: ${summary.easy.rows.slice(0, 4).map(r => `${r.id}=${r4(meanScore(r))}`).join(', ')}` +
      ` (baseline self-play ${r4(summary.easy.baselineMean)}, search gens ${summary.easy.gensRun})`);
    console.log(`  assessment seeds [${cfg.assessSeeds}]: ${summary.assessment.map(r => `${r.a}vs${r.b} ${r.aWins}-${r.bWins} (${r.verdict})`).join(', ')}`);
  } catch (e) {
    console.error('train-ai:', e.message);
    process.exit(1);
  }
}
