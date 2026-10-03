import { describe, it, expect } from 'vitest';
import { STEP, COLORS, WATER } from '../src/config.js';
import { MAP_SIZES, maxCityCapacity, normalizeSettings } from '../src/setup.js';
import { generateCityLayout } from '../src/sim/city-layout.js';
import { createWorld } from '../src/sim/world.js';
import { getAIPolicy, normalizeAIPolicy } from '../src/sim/ai-policy.js';
import { tick, checkEnd } from '../src/sim/game.js';
import { economy } from '../src/sim/economy.js';
import { spawnDiv, issueMove } from '../src/sim/divisions.js';
import { findPath } from '../src/sim/pathfinding.js';
import { moveDivs } from '../src/sim/movement.js';
import { tileOf } from '../src/sim/geom.js';

const run = (w, seconds) => {
  for (let i = 0, n = Math.round(seconds / STEP); i < n && !w.over; i++) tick(w, STEP);
};

/** A land tile far from `from` that is actually reachable (long route), or -1. */
function farTile(w, from) {
  for (let t = w.terr.length - 1; t >= 0; t--) {
    if (w.terr[t] === WATER) continue;
    const p = findPath(w, from, t);
    if (p && p.length > 20) return t;
  }
  return -1;
}

describe('setup: map presets', () => {
  it('small and large maps generate and simulate at their own dimensions', () => {
    for (const size of ['small', 'large']) {
      const dims = MAP_SIZES[size];
      const w = createWorld(4242, { settings: normalizeSettings({ mapSize: size, factions: [1, 2] }), humans: ['Me'] });
      expect(w.w).toBe(dims.w);
      expect(w.h).toBe(dims.h);
      expect(w.settings.mapSize).toBe(size);
      expect(w.terr).toHaveLength(dims.w * dims.h);
      expect(w.owner).toHaveLength(dims.w * dims.h);
      expect(w.landCount).toBeGreaterThan(dims.w * dims.h * 0.3);
      for (const c of w.cities) {
        expect(c.idx).toBeGreaterThanOrEqual(0);
        expect(c.idx).toBeLessThan(dims.w * dims.h);
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.x).toBeLessThan(dims.w);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeLessThan(dims.h);
      }
      expect(w.cities.filter(c => c.capital && c.owner).map(c => c.owner).sort((a, b) => a - b)).toEqual([1, 2]);
      run(w, 20);
      expect(w.over).toBe(false);
      for (const d of w.divs) {
        expect(d.x).toBeGreaterThanOrEqual(0);
        expect(d.x).toBeLessThan(dims.w);
        expect(d.y).toBeGreaterThanOrEqual(0);
        expect(d.y).toBeLessThan(dims.h);
      }
    }
  });
});

describe('setup: city layout', () => {
  it('declares how many participant seats each map size can hold', () => {
    expect(maxCityCapacity('small')).toBe(14);
    expect(maxCityCapacity('standard')).toBe(24);
    expect(maxCityCapacity('large')).toBe(38);
    expect(() => maxCityCapacity('huge')).toThrow('Choose a supported map size');
    for (const size of ['small', 'standard', 'large']) {
      const dims = MAP_SIZES[size];
      for (const seed of [0, 4242]) {
        const layout = generateCityLayout(seed, dims.w, dims.h);
        expect(layout.cities).toHaveLength(maxCityCapacity(size));
        expect(layout.cities.filter(c => c.capital)).toHaveLength(6);
        expect(layout.cities.filter(c => c.capital).map(c => c.idx)).toHaveLength(6);
      }
    }
  });

  it('depends only on the seed and the map size, never on who plays', () => {
    const dims = MAP_SIZES.standard;
    const layout = generateCityLayout(4242, dims.w, dims.h);
    const two = createWorld(4242, { settings: normalizeSettings({ factions: [1, 2] }), humans: ['Me'] });
    const many = createWorld(4242, { settings: normalizeSettings({ factions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }), humans: [] });
    expect(two.cities.map(c => c.idx)).toEqual(layout.cities.map(c => c.idx));
    expect(many.cities.map(c => c.idx)).toEqual(layout.cities.map(c => c.idx));
    expect(Array.from(two.terr)).toEqual(Array.from(layout.terr));
    expect(Array.from(many.terr)).toEqual(Array.from(two.terr));
    expect(two.landCount).toBe(layout.landCount);
    expect(many.landCount).toBe(layout.landCount);
    // the same twelve cities serve a two-faction duel and a twelve-faction game, and the rest stay neutral
    expect(many.cities.filter(c => c.owner).map(c => c.idx).sort((a, b) => a - b))
      .toEqual(layout.cities.slice(0, 12).map(c => c.idx).sort((a, b) => a - b));
  });

  it('keeps the original six-faction placement for a given seed', () => {
    // captured from the pre-layout generator: the default game's terrain and city tiles are unchanged
    const w = createWorld(4242, { humans: [] });
    expect(w.settings.factions).toEqual([1, 2, 3, 4, 5, 6]);
    expect(w.cityCapacity).toBe(24);
    expect(w.cities.map(c => c.idx)).toEqual([
      8886, 8536, 2783, 11784, 1981, 5958, 2469, 2750, 4595, 6423, 9574, 10260,
      9079, 4235, 5301, 6370, 10072, 4734, 7996, 11359, 6023, 7762, 4221, 8607]);
    expect(w.cities.filter(c => c.capital).map(c => c.owner)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(w.players.slice(0, 6).map(p => p.name)).toEqual(['Azure', 'Crimson', 'Verdant', 'Gilded', 'Violet', 'Ember']);
    expect(w.players.slice(0, 6).map(p => p.color)).toEqual(['#3b82f6', '#e5484d', '#30b765', '#e8b923', '#a560e8', '#f07d2e']);

    const small = createWorld(0, { settings: normalizeSettings({ mapSize: 'small', factions: [1, 2] }), humans: ['Me'] });
    expect(small.cityCapacity).toBe(14);
    expect(small.cities.map(c => c.idx)).toEqual([3552, 2310, 2992, 5623, 836, 1469, 1854, 4467, 1526, 2780, 3367, 4613, 2439, 4445]);
  });

  it('creates a world at the city limit with a complete identity for every seat', () => {
    for (const size of ['small', 'standard', 'large']) {
      const cap = maxCityCapacity(size);
      const ids = Array.from({ length: cap }, (_, i) => i + 1);
      const w = createWorld(4242, { settings: normalizeSettings({ mapSize: size, factions: ids }), humans: [] });
      expect(w.cityCapacity).toBe(cap);
      expect(w.players).toHaveLength(cap);
      expect(w.players.map(p => p.id)).toEqual(ids);
      expect(w.players.every(p => p.enabled && p.alive && !p.seat)).toBe(true);

      // every participant owns exactly one city — its own capital — and the rest stay unowned
      const owned = w.cities.filter(c => c.owner);
      expect(owned).toHaveLength(cap);
      expect(new Set(owned.map(c => c.owner)).size).toBe(cap);
      expect(w.cities.filter(c => !c.owner)).toHaveLength(w.cities.length - cap);
      for (const p of w.players) {
        const mine = owned.filter(c => c.owner === p.id);
        expect(mine).toHaveLength(1);
        expect(mine[0].capital).toBe(true);
        expect(w.owner[mine[0].idx]).toBe(p.id);
        expect(w.cityAt[mine[0].idx]).toBeGreaterThanOrEqual(0);
        expect(w.terr[mine[0].idx]).not.toBe(WATER);
      }

      // seat identity is defined for every id: names, colours, own-team FFA, no reserved bots
      for (const p of w.players) {
        expect(typeof p.name).toBe('string');
        expect(p.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(p.team).toBe(p.id);
        expect(p.bot).toBe(false);
      }
      expect(new Set(w.players.map(p => p.color)).size).toBe(cap);
      expect(new Set(w.players.map(p => p.name)).size).toBe(cap);
    }
  });

  it('seats humans on high-numbered factions', () => {
    const cap = maxCityCapacity('small');
    const s = normalizeSettings({ mapSize: 'small', factions: Array.from({ length: cap }, (_, i) => i + 1) });
    const w = createWorld(7, { settings: s, humans: ['Ana', 'Bo'], humanIds: [9, 14] });
    expect(w.cityCapacity).toBe(cap);
    expect(w.players[8].seat).toBe(true);
    expect(w.players[8].name).toBe('Ana');
    expect(w.players[8].color).toBe(COLORS[8]);
    expect(w.players[13].seat).toBe(true);
    expect(w.players[13].name).toBe('Bo');
    expect(w.players[13].team).toBe(14);
    expect(w.players[13].cities).toBe(1);
    // an empty seat at the top of the roster is still playable
    expect(() => createWorld(7, { settings: s, humans: ['Ana'], humanIds: [15] })).toThrow('Human faction is not enabled');
  });

  it('rejects a roster the map cannot seat, including one a short seed cannot hold', () => {
    const over = Array.from({ length: maxCityCapacity('small') + 1 }, (_, i) => i + 1);
    expect(() => normalizeSettings({ mapSize: 'small', factions: over })).toThrow('Faction ids must be 1 to 14 on a small map');
    expect(() => normalizeSettings({ mapSize: 'large', factions: Array.from({ length: 39 }, (_, i) => i + 1) }))
      .toThrow('Faction ids must be 1 to 38 on a large map');

    // seed 104 lays out 13 cities on a small map, so its 14th faction has nowhere to start
    const dims = MAP_SIZES.small;
    expect(generateCityLayout(104, dims.w, dims.h).cities).toHaveLength(13);
    const ids = Array.from({ length: maxCityCapacity('small') }, (_, i) => i + 1);
    expect(() => createWorld(104, { settings: normalizeSettings({ mapSize: 'small', factions: ids }), humans: [] }))
      .toThrow('Map has only 13 player cities: faction 14 has no city');
    // the same roster fits the map on a seed whose layout is complete
    expect(createWorld(0, { settings: normalizeSettings({ mapSize: 'small', factions: ids }), humans: [] }).cityCapacity).toBe(14);
  });
});

describe('setup: factions', () => {
  it('only the selected factions take part in the game', () => {
    const w = createWorld(9, { settings: normalizeSettings({ factions: [3, 5] }), humans: [] });
    expect(w.cityCapacity).toBe(24);
    expect(w.players).toHaveLength(24);
    expect(w.players.filter(p => p.enabled).map(p => p.id)).toEqual([3, 5]);
    for (const p of w.players) {
      if (p.enabled) continue;
      expect(p.alive).toBe(false);
      expect(p.seat).toBe(false);
      expect(p.bot).toBe(false);
      expect(p.team).toBe(0);
      expect(p.tiles).toBe(0);
      expect(p.cities).toBe(0);
    }
    expect(w.cities.filter(c => c.capital && c.owner).map(c => c.owner).sort((a, b) => a - b)).toEqual([3, 5]);
    for (let t = 0; t < w.owner.length; t++) {
      expect([0, 3, 5]).toContain(w.owner[t]);
      if (w.bld[t]) expect([3, 5]).toContain(w.owner[t]);
    }
    // the selected AIs really play: armies appear, and only for the enabled factions
    run(w, 60);
    expect(w.over).toBe(false);
    for (const d of w.divs) expect([3, 5]).toContain(d.owner);
  });

  it('humans are mapped onto the chosen enabled factions, with faction identity fixed to the id', () => {
    const s = normalizeSettings({ factions: [3, 5] });
    const first = createWorld(9, { settings: s, humans: ['You'] });
    expect(first.players[2].seat).toBe(true);       // first enabled faction when humanIds is omitted
    expect(first.players[2].name).toBe('You');

    const w = createWorld(9, { settings: s, humans: ['You'], humanIds: [5] });
    expect(w.players[4].seat).toBe(true);
    expect(w.players[4].human).toBe(true);
    expect(w.players[4].name).toBe('You');
    expect(w.players[2].seat).toBe(false);
    expect(w.players[2].human).toBe(false);
    expect(w.players[2].color).toBe(COLORS[2]);
    expect(w.players[4].color).toBe(COLORS[4]);

    expect(() => createWorld(9, { settings: s, humans: ['You'], humanIds: [2] })).toThrow('Human faction is not enabled');
    expect(() => createWorld(9, { settings: s, humans: ['You'], humanIds: [3, 5] })).toThrow('humanIds must match humans one for one');
    expect(() => createWorld(9, { settings: normalizeSettings({ factions: [1, 2] }), humans: ['A', 'B'], humanIds: [1, 1] })).toThrow('Duplicate human faction');
    expect(() => createWorld(9, { settings: normalizeSettings({ factions: [1, 2] }), humans: ['A', 'B', 'C'] })).toThrow('too many human players');
  });

  it('an all-AI world keeps playing: with no seat there is no human-elimination end', () => {
    const w = createWorld(5, { settings: normalizeSettings({ factions: [1, 2] }), humans: [] });
    expect(w.players.every(p => !p.seat)).toBe(true);
    for (const p of w.players) if (p.alive) p.tiles = 0;
    checkEnd(w);                                    // every faction is landless, yet the game goes on
    expect(w.over).toBe(false);

    const h = createWorld(5, { settings: normalizeSettings({ factions: [1, 2, 3] }), humans: ['Me'] });
    h.players[0].tiles = 0;
    checkEnd(h);                                    // that seat fell while other empires are still up
    expect(h.over).toBe(true);
    expect(h.result).toMatchObject({ winnerId: null, reason: 'humans', pct: 0 });
  });
});

describe('setup: bots and teams', () => {
  it('reserves bot factions: they AI-play and no human may claim their seat', () => {
    const s = normalizeSettings({ factions: [1, 2, 3, 4, 5, 6, 7, 8], bots: [8, 2, 2] });
    expect(s.bots).toEqual([2, 8]);                      // canonical: sorted and deduplicated
    const w = createWorld(11, { settings: s, humans: ['Me', 'You'] });
    expect(w.players[1].bot).toBe(true);
    expect(w.players[1].alive).toBe(true);
    expect(w.players[1].seat).toBe(false);
    expect(w.players[7].bot).toBe(true);
    // humans take the first open seats, stepping over the reserved ones
    expect(w.players.filter(p => p.seat).map(p => p.id)).toEqual([1, 3]);
    expect(w.players[0].name).toBe('Me');
    expect(w.players[2].name).toBe('You');
    // an open seat nobody occupies is still AI, but it is not a reserved bot seat
    expect(w.players[4].bot).toBe(false);
    expect(w.players[4].alive).toBe(true);

    expect(() => createWorld(11, { settings: s, humans: ['Me'], humanIds: [2] })).toThrow('Faction 2 is reserved for a bot');
    expect(() => createWorld(11, { settings: s, humans: ['Me'], humanIds: [8] })).toThrow('Faction 8 is reserved for a bot');
    expect(() => createWorld(11, { settings: s, humans: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] })).toThrow('too many human players');

    // an all-bot game needs nobody at the keyboard, and a spectator host can watch one
    const all = createWorld(11, { settings: normalizeSettings({ factions: [1, 2, 3], bots: [1, 2, 3] }), humans: [] });
    expect(all.players.slice(0, 3).every(p => p.bot && !p.seat && p.alive)).toBe(true);
    run(all, 30);
    expect(all.over).toBe(false);
    expect(all.divs.every(d => [1, 2, 3].includes(d.owner))).toBe(true);
  });

  it('maps faction team ids into the world and keeps FFA as every faction for itself', () => {
    const ffa = normalizeSettings({ factions: [4, 2, 6, 1] });
    expect(ffa.factions).toEqual([1, 2, 4, 6]);
    expect(ffa.teams).toBeNull();
    const w = createWorld(9, { settings: ffa, humans: [] });
    for (const p of w.players) expect(p.team).toBe(p.enabled ? p.id : 0);

    // factions and their team ids travel as pairs, so canonical sorting keeps the host's pairing
    const s = normalizeSettings({ factions: [6, 2, 4, 1], teams: [2, 1, 2, 1], teamCount: 2 });
    expect(s.factions).toEqual([1, 2, 4, 6]);
    expect(s.teams).toEqual([1, 1, 2, 2]);
    const t = createWorld(9, { settings: s, humans: [] });
    expect(t.players[0].team).toBe(1);
    expect(t.players[1].team).toBe(1);
    expect(t.players[3].team).toBe(2);
    expect(t.players[5].team).toBe(2);
    expect(t.players[2].team).toBe(0);                   // faction 3 is not playing
  });

  it('rejects malformed bots, teams and team counts', () => {
    expect(() => normalizeSettings({ factions: [1, 2, 3], bots: [4] })).toThrow('Bots must be enabled factions');
    expect(() => normalizeSettings({ factions: [1, 2, 3], bots: [0, 1] })).toThrow('Bots must be enabled factions');
    expect(() => normalizeSettings({ factions: [1, 2, 3], teams: [1, 2] })).toThrow('Teams must pair with every enabled faction');
    expect(() => normalizeSettings({ factions: [1, 2, 3], teams: {} })).toThrow('Teams must pair with every enabled faction');
    expect(() => normalizeSettings({ factions: [1, 2, 3], teams: [1, 1, 1] })).toThrow('Teams must use at least two different team ids');
    expect(() => normalizeSettings({ factions: [1, 2, 3, 4], teams: [1, 1, 3, 4] })).toThrow('Team ids must be 1 to 2');
    expect(() => normalizeSettings({ factions: [1, 2, 3, 4], teams: [1, 2, 3, 4], teamCount: 5 })).toThrow('Invalid team count');
    expect(() => normalizeSettings({ factions: [1, 2], teams: [1, 2], teamCount: 1 })).toThrow('Invalid team count');
    expect(() => normalizeSettings({ factions: [1, 2], teamCount: 3 })).toThrow('Invalid team count');
    // the shipped FFA default keeps working untouched, and an explicit team layout round-trips
    expect(normalizeSettings().teams).toBeNull();
    expect(normalizeSettings({ factions: [1, 2, 3, 4], teams: [3, 1, 2, 3], teamCount: 3 }).teams).toEqual([3, 1, 2, 3]);
  });
});

describe('setup: economy and victory settings', () => {
  it('starting resources scale the opening pool and gold, the income multiplier scales earned income only', () => {
    const base = normalizeSettings({ factions: [1, 2], startingResources: 1, incomeMultiplier: 1 });
    const dbl = normalizeSettings({ factions: [1, 2], startingResources: 2, incomeMultiplier: 2 });
    const w1 = createWorld(31, { settings: base, humans: ['Me'] });
    const w2 = createWorld(31, { settings: dbl, humans: ['Me'] });
    expect(w2.players[0].pool).toBe(w1.players[0].pool * 2);
    expect(w2.players[0].gold).toBe(w1.players[0].gold * 2);
    expect(w2.players[1].pool).toBe(w1.players[1].pool * 2);
    expect(w2.players[1].gold).toBe(w1.players[1].gold * 2);

    // compare income from identical holdings: zero the reserves so the soft manpower cap behaves the same
    for (const w of [w1, w2]) for (const p of w.players) { p.pool = 0; p.army = 0; }
    economy(w1, 0);
    economy(w2, 0);
    expect(w1.players[0].rate).toBeGreaterThan(0);
    expect(w2.players[0].rate).toBe(w1.players[0].rate * 2);
    expect(w2.players[0].goldRate).toBe(w1.players[0].goldRate * 2);
    expect(w2.players[1].rate).toBe(w1.players[1].rate * 2);

    // reinforcement moves manpower from the pool into a division: a transfer, not income
    const hurt1 = hurtOn(w1, 1);
    const hurt2 = hurtOn(w2, 1);
    economy(w1, STEP);
    economy(w2, STEP);
    expect(hurt1.men - 50).toBeCloseTo(3 * STEP, 6);
    expect(hurt2.men - 50).toBeCloseTo(hurt1.men - 50, 10);
  });

  it('the victory target decides when the game ends', () => {
    const w = createWorld(5, { settings: normalizeSettings({ factions: [1, 2], victoryShare: 0.63 }), humans: ['Me'] });
    expect(w.settings.victoryShare).toBe(0.63);
    w.players[0].tiles = Math.floor(w.landCount * 0.62);
    checkEnd(w);
    expect(w.over).toBe(false);
    w.players[0].tiles = Math.ceil(w.landCount * 0.63);
    checkEnd(w);
    expect(w.over).toBe(true);
    expect(w.result).toMatchObject({ winnerId: 1, reason: 'land', pct: 63 });

    const strict = createWorld(5, { settings: normalizeSettings({ factions: [1, 2], victoryShare: 0.67 }), humans: ['Me'] });
    strict.players[0].tiles = Math.ceil(strict.landCount * 0.67);
    checkEnd(strict);
    expect(strict.over).toBe(true);
    expect(strict.result).toMatchObject({ winnerId: 1, reason: 'land', pct: 67 });

    const loose = createWorld(5, { settings: normalizeSettings({ factions: [1, 2], victoryShare: 0.5 }), humans: ['Me'] });
    loose.players[0].tiles = Math.ceil(loose.landCount * 0.5);
    checkEnd(loose);
    expect(loose.over).toBe(true);
    expect(loose.result.reason).toBe('land');
  });

  it('accepts any whole-percent victory target in [50%, 100%] and rejects the rest', () => {
    expect(normalizeSettings({ factions: [1, 2] }).victoryShare).toBe(0.6);   // existing default
    for (const pct of [50, 55, 63, 67, 99, 100]) {
      expect(normalizeSettings({ factions: [1, 2], victoryShare: pct / 100 }).victoryShare).toBe(pct / 100);
    }
    // a share that arrives with float noise is canonicalized once, not left for callers to clean up
    expect(normalizeSettings({ factions: [1, 2], victoryShare: 0.63 + 1e-12 }).victoryShare).toBe(0.63);
    for (const bad of [0.49, 1.01, 0, 2, -1, NaN, Infinity, -Infinity, '0.6', null, undefined, {}, []]) {
      expect(() => normalizeSettings({ factions: [1, 2], victoryShare: bad })).toThrow('Invalid victory target');
    }
  });
});

describe('setup: AI difficulty', () => {
  it('normalizes the difficulty, defaults to medium, and rejects unknown values', () => {
    expect(normalizeSettings().aiDifficulty).toBe('medium');
    expect(normalizeSettings({ aiDifficulty: 'easy' }).aiDifficulty).toBe('easy');
    expect(normalizeSettings({ aiDifficulty: 'hard' }).aiDifficulty).toBe('hard');
    for (const bad of ['beginner', 'EASY', 'MEDIUM', '', null, 0, {}, []]) {
      expect(() => normalizeSettings({ aiDifficulty: bad })).toThrow('Invalid AI difficulty');
    }
    // a network settings patch can only ever name a shipped difficulty — policies themselves are not settings
    const sneaky = normalizeSettings({ aiPolicies: { 1: { recruitTiles: 40 } } });
    expect(sneaky.aiPolicies).toBeUndefined();
    expect(sneaky.aiDifficulty).toBe('medium');
  });

  it('seeds every player from the chosen difficulty policy, or a trusted per-player override', () => {
    const easy = createWorld(11, { settings: normalizeSettings({ mapSize: 'small', factions: [1, 2], aiDifficulty: 'easy' }), humans: ['Me'], humanIds: [1] });
    const hard = createWorld(11, { settings: normalizeSettings({ mapSize: 'small', factions: [1, 2], aiDifficulty: 'hard' }), humans: ['Me'], humanIds: [1] });
    for (const p of easy.players) expect(p.aiPolicy).toEqual(getAIPolicy('easy'));
    for (const p of hard.players) expect(p.aiPolicy).toEqual(getAIPolicy('hard'));
    expect(easy.players[0].seat).toBe(true);                        // the human seat carries a policy too
    expect(easy.players[0].aiPolicy).toEqual(getAIPolicy('easy'));

    // headless training passes per-player policies off the wire, keyed by faction id
    const a = { recruitTiles: 30, infantryShare: 0.5, armorShare: 0.2, buildShare: 0.6, roadShare: 0.2, lineDemand: 2.2, advance: 11, captureRange: 1.1 };
    const b = { ...a, recruitTiles: 15 };
    const w = createWorld(11, { settings: normalizeSettings({ mapSize: 'small', factions: [1, 2] }), humans: [], aiPolicies: { 1: a, 2: b } });
    expect(w.players[0].aiPolicy).toEqual(normalizeAIPolicy(a));
    expect(w.players[1].aiPolicy).toEqual(normalizeAIPolicy(b));
    expect(w.players[0].aiPolicy).not.toEqual(w.players[1].aiPolicy);
    expect(w.players[2].aiPolicy).toEqual(getAIPolicy('medium'));    // no override: the settings difficulty
    a.recruitTiles = 999;                                           // the world keeps its own normalized copy
    expect(w.players[0].aiPolicy.recruitTiles).toBe(30);

    expect(() => createWorld(11, { settings: normalizeSettings({ factions: [1, 2] }), humans: [], aiPolicies: [a] }))
      .toThrow('aiPolicies must be a per-player record');
  });

  it('deploys distinct, frozen policies per difficulty', () => {
    for (const id of ['easy', 'medium', 'hard']) {
      const p = getAIPolicy(id);
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.keys(p).sort()).toEqual(['advance', 'armorShare', 'buildShare', 'captureRange', 'infantryShare', 'lineDemand', 'recruitTiles', 'roadShare']);
    }
    expect(getAIPolicy('easy')).not.toEqual(getAIPolicy('hard'));   // the dropdown really changes play
  });
});

describe('setup: worlds of different sizes side by side', () => {
  it('interleaved different-size worlds keep their own geometry and scratch state', () => {
    const a = createWorld(77, { settings: normalizeSettings({ mapSize: 'small', factions: [1, 2] }), humans: ['Me'] });
    const b = createWorld(77, { settings: normalizeSettings({ mapSize: 'large', factions: [1, 2] }), humans: ['Me'] });
    const capA = a.cities.find(c => c.owner === 1 && c.capital);
    const capB = b.cities.find(c => c.owner === 1 && c.capital);
    expect(capA).toBeTruthy();
    expect(capB).toBeTruthy();

    const da = spawnDiv(a, 1, capA.x + .5, capA.y + .5, 60, 60, 'inf');
    const db = spawnDiv(b, 1, capB.x + .5, capB.y + .5, 60, 60, 'inf');
    expect(tileOf(a, da)).toBe(capA.idx);
    expect(tileOf(b, db)).toBe(capB.idx);

    const goalA = farTile(a, capA.idx);
    const goalB = farTile(b, capB.idx);
    expect(goalA).toBeGreaterThanOrEqual(0);
    expect(goalB).toBeGreaterThanOrEqual(0);
    expect(findPath(a, capA.idx, goalA).every(t => t >= 0 && t < a.w * a.h)).toBe(true);
    expect(findPath(b, capB.idx, goalB).every(t => t >= 0 && t < b.w * b.h)).toBe(true);

    issueMove(a, [da], (goalA % a.w) + .5, ((goalA / a.w) | 0) + .5);
    issueMove(b, [db], (goalB % b.w) + .5, ((goalB / b.w) | 0) + .5);
    const ax0 = da.x, ay0 = da.y, bx0 = db.x, by0 = db.y;
    for (let i = 0; i < 300; i++) { moveDivs(a, STEP); moveDivs(b, STEP); }

    expect(da.x).toBeLessThan(a.w); expect(da.y).toBeLessThan(a.h);
    expect(db.x).toBeLessThan(b.w); expect(db.y).toBeLessThan(b.h);
    expect(da.x).toBeGreaterThanOrEqual(0); expect(da.y).toBeGreaterThanOrEqual(0);
    expect(db.x).toBeGreaterThanOrEqual(0); expect(db.y).toBeGreaterThanOrEqual(0);
    expect(Math.hypot(da.x - ax0, da.y - ay0)).toBeGreaterThan(3);  // small world: the body really moved
    expect(Math.hypot(db.x - bx0, db.y - by0)).toBeGreaterThan(3);  // large world: same, on its own buffers
    for (const [w, d] of [[a, da], [b, db]]) {
      expect(d.path.every(t => t >= 0 && t < w.w * w.h)).toBe(true);
    }
  });
});

/** A wounded division on its own capital, with plenty of manpower, to measure reinforcement. */
function hurtOn(w, pid) {
  const c = w.cities.find(c => c.owner === pid && c.capital);
  const d = spawnDiv(w, pid, c.x + .5, c.y + .5, 50, 100, 'inf');
  expect(d).not.toBeNull();
  for (const p of w.players) p.pool = 1000;         // the pool must never be the limit here
  return d;
}
