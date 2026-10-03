// Headless balance harness: `npm run sim [seeds...]`
// Runs AI-only games and prints land share / division counts every 5 sim-minutes.
import { STEP } from '../src/config.js';
import { createWorld } from '../src/sim/world.js';
import { tick } from '../src/sim/game.js';

const seeds = process.argv.slice(2).map(Number).filter(Boolean);
if (!seeds.length) seeds.push(12345, 777, 4242, 31337);

for (const seed of seeds) {
  const w = createWorld(seed, { humans: [], aiDelay: 20 });
  const t0 = Date.now();
  console.log('seed ' + seed);
  for (let m = 5; m <= 30 && !w.over; m += 5) {
    while (w.time < m * 60 && !w.over) tick(w, STEP);
    const row = w.players.map(p => (p.tiles / w.landCount * 100).toFixed(0).padStart(2) + '%/' + String(w.divs.filter(d => d.owner === p.id).length).padStart(2) + 'd').join('  ');
    console.log('  t=' + String(m).padStart(2) + 'min  ' + row);
  }
  console.log('  ' + (w.over ? w.result.reason + ' win by ' + w.players[w.result.winnerId - 1].name + ' (' + w.result.pct + '%) at ' + (w.time / 60).toFixed(1) + ' min' : 'no result after 30 min') + '  [' + (Date.now() - t0) + ' ms]');
}
