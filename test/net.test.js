import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createGameServer } from '../server/index.js';
import { createViewWorld, applySnapshot } from '../src/client/net-world.js';
import { generateCityLayout } from '../src/sim/city-layout.js';
import { TYPES, BUILD_IDS, WATER, LAND, ROAD_GOLD, MAX_ROUTE_POINTS } from '../src/config.js';
import { canBuild } from '../src/sim/buildings.js';
import { spawnDiv } from '../src/sim/divisions.js';
import { setOwner } from '../src/sim/world.js';
import { getAIPolicy } from '../src/sim/ai-policy.js';
import { formationSlots } from '../src/sim/formations.js';
import { MIN_SEP } from '../src/sim/collision.js';
import { F_ENG, F_OOS, F_MOVING, F_ROUTING, F_ROUT_LOCKED, F_COLUMN, MAX_CLIENTS } from '../src/net/protocol.js';

let server;
beforeAll(async () => { server = await createGameServer({ port: 0, host: '127.0.0.1' }); });
afterAll(async () => { await server.close(); });

/** Minimal test client: records every message and lets a test await a matching one. */
function connect(name, room, token, opts = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/ws');
  const msgs = [], waiters = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    msgs.push(m);
    for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const c = {
    ws, msgs,
    send: m => ws.send(JSON.stringify(m)),
    next: (pred, ms = 4000) => new Promise((resolve, reject) => {
      const hit = msgs.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('timeout waiting for message: ' + pred)), ms).unref?.();
    }),
    /** Like next(), but only looks at messages that arrive from now on. */
    after: (pred, ms = 4000) => {
      const from = msgs.length;
      return c.next(m => msgs.indexOf(m) >= from && pred(m), ms);
    },
    open: new Promise(r => ws.on('open', r)),
    close: () => ws.close()
  };
  c.open.then(() => c.send({ t: 'join', room, name, token, ...opts }));
  return c;
}

const tok = n => 'test-token-' + n + '-' + Math.random().toString(36).slice(2);
const settle = ms => new Promise(r => setTimeout(r, ms));
const lastLobby = c => c.msgs.filter(m => m.t === 'lobby').pop();

/** Place a division exactly; spawnDiv may shift a body off a busy tile, tests own their geometry. */
const put = (d, x, y) => { d.x = x; d.y = y; d.px = x; d.py = y; };

/** The centre of the first water-free `span` x `span` block, or null. */
function openSquare(world, span) {
  const W = world.w, H = world.h, r = (span - 1) / 2;
  for (let y = r; y < H - r; y++) {
    for (let x = r; x < W - r; x++) {
      let open = true;
      for (let j = y - r; j <= y + r && open; j++) {
        for (let i = x - r; i <= x + r; i++) if (world.terr[j * W + i] === WATER) { open = false; break; }
      }
      if (open) return { x, y };
    }
  }
  return null;
}

/** Like openSquare, but the block also sits `clearance` tiles clear of every body and city, so a
 *  staged encounter owns its ground and nothing else walks through it. */
function clearSquare(world, span, clearance = 8) {
  const W = world.w, H = world.h, r = (span - 1) / 2;
  for (let y = r; y < H - r; y++) {
    for (let x = r; x < W - r; x++) {
      let open = true;
      for (let j = y - r; j <= y + r && open; j++) {
        for (let i = x - r; i <= x + r; i++) if (world.terr[j * W + i] === WATER) { open = false; break; }
      }
      if (!open) continue;
      let clear = true;
      for (const d of world.divs) if (Math.hypot(d.x - x, d.y - y) < clearance) { clear = false; break; }
      if (clear) for (const c of world.cities) if (Math.hypot(c.x - x, c.y - y) < clearance) { clear = false; break; }
      if (clear) return { x, y };
    }
  }
  return null;
}

/** Every pair of adjacent (right/below) non-water tiles a player owns. */
function ownedPairs(world, pid) {
  const W = world.w, H = world.h, out = [];
  for (let t = 0; t < W * H; t++) {
    if (world.owner[t] !== pid || world.terr[t] === WATER) continue;
    const x = t % W, y = (t / W) | 0;
    if (x + 1 < W && world.owner[t + 1] === pid && world.terr[t + 1] !== WATER) out.push([t, t + 1]);
    if (y + 1 < H && world.owner[t + W] === pid && world.terr[t + W] !== WATER) out.push([t, t + W]);
  }
  return out;
}

describe('multiplayer server', () => {
  it('allows the configured Pages origin to join while rejecting unrelated web pages', async () => {
    const hosted = await createGameServer({
      port: 0, host: '127.0.0.1', allowedOrigins: ['https://ng643.github.io']
    });
    const sockets = [];
    const joinFrom = origin => new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + hosted.port + '/ws', { origin });
      sockets.push(ws);
      ws.once('open', () => ws.send(JSON.stringify({
        t: 'join', room: 'ORIG1', name: 'Hosted', token: tok('origin' + sockets.length), role: 'spectator'
      })));
      ws.once('message', raw => resolve(JSON.parse(raw.toString())));
      ws.once('unexpected-response', (_req, response) => {
        response.resume();
        resolve({ status: response.statusCode });
      });
      ws.once('error', reject);
    });
    try {
      expect(await joinFrom('http://127.0.0.1:' + hosted.port)).toMatchObject({ t: 'lobby', state: 'lobby' });
      expect(await joinFrom('https://ng643.github.io')).toMatchObject({ t: 'lobby', state: 'lobby' });
      for (const origin of [
        'https://evil.example.invalid', 'https://ng643.github.io.attacker.invalid',
        'http://ng643.github.io', 'https://ng643.github.io:444'
      ]) expect(await joinFrom(origin)).toEqual({ status: 401 });
    } finally {
      for (const ws of sockets) ws.terminate();
      await hosted.close();
    }
  });

  it('runs lobby -> game -> rematch for two players', async () => {
    const a = connect('Alice', 'TEST1', tok('a'));
    const lobbyA = await a.next(m => m.t === 'lobby');
    expect(lobbyA.state).toBe('lobby');
    expect(lobbyA.max).toBe(MAX_CLIENTS);
    expect(lobbyA.settings.mapSize).toBe('standard');
    expect(lobbyA.players[0]).toMatchObject({ name: 'Alice', you: true, host: true, role: 'player', faction: 1 });
    const b = connect('Bob', 'test1', tok('b'));            // room codes are case-insensitive
    await b.next(m => m.t === 'lobby' && m.players.length === 2);

    // only the host may start, and it hears about the rejection without losing its seat
    b.send({ t: 'start' });
    const denied = await b.next(m => m.t === 'err');
    expect(denied.msg).toMatch(/host/i);
    expect(denied.soft).toBe(true);
    expect(a.msgs.some(m => m.t === 'init')).toBe(false);

    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    const initB = await b.next(m => m.t === 'init');
    expect(initA.me).toBe(1);
    expect(initB.me).toBe(2);
    expect(initA.seed).toBe(initB.seed);
    expect(initA.w).toBe(initA.settings.w);
    expect(initA.h).toBe(initA.settings.h);
    expect(initA.owner.length).toBe(initA.w * initA.h);
    expect(initA.players.map(p => p.name).slice(0, 2)).toEqual(['Alice', 'Bob']);
    // The roster covers every seat the actual map can hold; the default six-seat FFA enables the
    // first six and leaves the extra cities neutral.
    expect(initA.players.length).toBe(initA.cityCapacity);
    expect(initA.players.length).toBeGreaterThan(6);
    expect(initA.players.map(p => p.id)).toEqual(initA.players.map((_, i) => i + 1));
    expect(initA.players.filter(p => p.enabled).map(p => p.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(initA.players.map(p => p.team)).toEqual([1, 2, 3, 4, 5, 6, ...initA.players.slice(6).map(() => 0)]);
    // Every seat of the actual map is painted, including the ones past the familiar six.
    expect(initA.players.every(p => typeof p.color === 'string' && p.color.length > 0)).toBe(true);

    // client-side mirror: terrain regenerated from the seed/dimensions, ownership matches the server's
    const view = createViewWorld(initA);
    expect(view.landCount).toBeGreaterThan(1000);
    expect(view.w).toBe(initA.w);
    expect(view.h).toBe(initA.h);
    expect(view.settings.mapSize).toBe('standard');
    const snap = await a.next(m => m.t === 'snap');
    applySnapshot(view, snap, 1);
    expect(view.players[0].pool).toBeGreaterThanOrEqual(0);
    expect(view.players[1].pool).toBe(-1);                  // rival economy is hidden by fog
    expect(view.players[1].army).toBe(-1);

    // commands: raising a division spends reserves and the new division shows up in snapshots
    const before = view.players[0].pool;
    a.send({ t: 'cmd', c: { k: 'raise', type: 'inf', city: -1 } });
    const snap2 = await a.next(m => m.t === 'snap' && m.divs.some(d => d[1] === 1));
    applySnapshot(view, snap2, 1);
    expect(view.divs.filter(d => d.owner === 1).length).toBeGreaterThan(0);
    expect(view.players[0].pool).toBeLessThan(before - TYPES.inf.manpower + 30);   // paid for it (minus a little income)

    // buildings: the capital's starting factory comes in the init; a farm placed later arrives as a delta
    const fid = BUILD_IDS.indexOf('factory') + 1;
    expect(view.bld.some(b => b === fid)).toBe(true);
    expect(view.players[0].gold).toBeGreaterThanOrEqual(0);
    expect(view.players[1].gold).toBe(-1);                 // rival gold is hidden by fog
    const srv = [...server.rooms.values()].find(r => r.code === 'TEST1').world;
    srv.players[0].gold = 500;
    let ft = -1;
    for (let t = 0; t < srv.owner.length && ft < 0; t++) if (canBuild(srv, 1, 'farm', t)) ft = t;
    a.send({ t: 'cmd', c: { k: 'build', type: 'farm', tiles: [ft] } });
    const bs = await a.next(m => m.t === 'snap' && m.bch && m.bch.length);
    applySnapshot(view, bs, 1);
    expect(view.bld[ft]).toBe(BUILD_IDS.indexOf('farm') + 1);
    const bsB = await b.next(m => m.t === 'snap' && m.bch && m.bch.length);
    expect(bsB.bch[0]).toBe(ft);                           // buildings are public information

    // anti-maphack: enemy divisions never appear in a snapshot unless within vision
    const world = [...server.rooms.values()].find(r => r.code === 'TEST1').world;
    const seen = new Set(snap2.divs.filter(d => d[1] !== 1).map(d => d[0]));
    for (const d of world.divs) if (d.owner === 2) expect(seen.has(d.id)).toBe(false);

    // commands for other players' divisions are ignored
    const bDiv = world.divs.find(d => d.owner === 2);
    if (bDiv) {
      a.send({ t: 'cmd', c: { k: 'move', ids: [bDiv.id], x: 5, y: 5 } });
      a.send({ t: 'cmd', c: { k: 'formation', ids: [bDiv.id], points: [[5, 5], [9, 5]] } });
      a.send({ t: 'cmd', c: { k: 'formation', ids: [bDiv.id], points: [[5, 5]] } });                  // fewer than two points
      a.send({ t: 'cmd', c: { k: 'formation', ids: [bDiv.id], points: [[5, 5], [9, 'x']] } });        // malformed pair
      a.send({ t: 'cmd', c: { k: 'formation', ids: [], points: 'nope' } });                          // not an array
      a.send({ t: 'cmd', c: { k: 'formation', ids: [bDiv.id], points: Array.from({ length: 200 }, (_, k) => [k, k]) } });   // oversize
      await new Promise(r => setTimeout(r, 200));
      expect(bDiv.path.length).toBe(0);
    }

    // garbage must not crash the server
    a.ws.send('not json');
    a.send({ t: 'cmd', c: { k: 'raise', type: '__proto__', city: 'x' } });
    a.send({ t: 'cmd', c: null });
    await new Promise(r => setTimeout(r, 150));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);

    // finish the game artificially, then host rematch returns the room to the lobby
    world.over = true;
    world.result = { winnerId: 1, reason: 'land', pct: 60 };
    await a.next(m => m.t === 'lobby' && m.state === 'ended');
    b.send({ t: 'rematch' });                               // non-host: ignored
    await new Promise(r => setTimeout(r, 100));
    expect(a.msgs.filter(m => m.t === 'lobby').pop().state).toBe('ended');
    a.send({ t: 'rematch' });
    await new Promise(r => setTimeout(r, 150));
    expect(a.msgs.filter(m => m.t === 'lobby').pop().state).toBe('lobby');
    expect(server.rooms.get('TEST1').world).toBe(null);

    a.close(); b.close();
  }, 15000);

  it('lets a disconnected player resume with the same token', async () => {
    const token = tok('r');
    const a = connect('Rejoiner', 'RESUME', token);
    await a.next(m => m.t === 'lobby');
    a.send({ t: 'start' });
    const init1 = await a.next(m => m.t === 'init');
    a.close();
    await new Promise(r => setTimeout(r, 200));

    const room = server.rooms.get('RESUME');
    expect(room.world.players[0].human).toBe(false);        // AI covers the seat while away

    const b = connect('Rejoiner', 'RESUME', token);
    const init2 = await b.next(m => m.t === 'init');
    expect(init2.me).toBe(init1.me);
    expect(init2.seed).toBe(init1.seed);
    expect(init2.settings).toEqual(init1.settings);
    expect(room.world.players[0].human).toBe(true);
    b.close();
  }, 10000);

  it('rejects strangers joining a running game and bad input', async () => {
    const a = connect('Host', 'BUSY', tok('h'));
    await a.next(m => m.t === 'lobby');
    a.send({ t: 'start' });
    await a.next(m => m.t === 'init');
    const c = connect('Late', 'BUSY', tok('l'));            // an unspecified role is a player
    const err = await c.next(m => m.t === 'err');
    expect(err.msg).toMatch(/progress/);
    expect(err.soft).toBeUndefined();

    const d = connect('Bad', 'bad room!', tok('d'));
    expect((await d.next(m => m.t === 'err')).msg).toMatch(/Room code/);
    a.close(); c.close(); d.close();
  }, 10000);

  it('tells a viewer that a hidden-route enemy is under way, so its preview picks the same slots', async () => {
    const a = connect('Viewer', 'MOVE1', tok('v'));
    await a.next(m => m.t === 'lobby');
    const b = connect('Runner', 'MOVE1', tok('r'));
    await b.next(m => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    await b.next(m => m.t === 'init');
    const view = createViewWorld(initA);
    const world = server.rooms.get('MOVE1').world;
    const W = world.w, H = world.h;

    // Open ground: the enemy starts on the middle tile, the viewer's body two tiles away (inside
    // VISION, and a whole block of land around the enemy so a blocked slot has legal fallbacks).
    let T = -1;
    for (let y = 4; y < H - 4 && T < 0; y++) {
      for (let x = 4; x < W - 4; x++) {
        let open = true;
        for (let j = y - 3; j <= y + 3 && open; j++) {
          for (let i = x - 3; i <= x + 3; i++) if (world.terr[j * W + i] === WATER) { open = false; break; }
        }
        if (open) { T = y * W + x; break; }
      }
    }
    expect(T).toBeGreaterThanOrEqual(0);
    const tx = T % W, ty = (T / W) | 0;

    const foe = spawnDiv(world, 2, tx + .5, ty + .5, 60, 60);       // under way towards the far corner
    foe.x = tx + .5; foe.y = ty + .5; foe.px = foe.x; foe.py = foe.y;
    foe.path = [(H - 1) * W + (W - 1)];
    const mine = spawnDiv(world, 1, tx + 2.5, ty + .5, 80, 80);     // holding its ground
    expect(mine).toBeTruthy();

    const snap = await a.next(m => m.t === 'snap' && m.divs.some(r => r[0] === foe.id));
    const row = snap.divs.find(r => r[0] === foe.id);
    expect(row.length).toBe(8);                                     // an enemy route is still never sent
    expect(row[7] & F_MOVING).toBe(F_MOVING);                       // ...but the viewer is told it is moving
    applySnapshot(view, snap, 1);
    const foeSeen = view.byId.get(foe.id);
    expect(foeSeen.path.length).toBe(0);
    expect(foeSeen.moving).toBe(true);

    // The viewer's own prediction, held against the authoritative world (route known) and against how
    // the viewer saw the same bodies before the flag existed (a hidden route looked like holding ground).
    // The lone unit is aimed at the enemy's observed position, so its nearest free tile is the very tile
    // the enemy stands on - a body inside a tile is always inside MIN_SEP of that tile's centre.
    const u = view.byId.get(mine.id);
    expect(u).toBeTruthy();
    const FT = (foeSeen.y | 0) * view.w + (foeSeen.x | 0);
    const points = [[foeSeen.x, foeSeen.y], [foeSeen.x, foeSeen.y]];
    const variant = (path, moving) => ({
      w: view.w, h: view.h, terr: view.terr,
      divs: view.divs.map(d => (d === foeSeen ? { ...d, path, moving } : d))
    });
    const live = formationSlots(variant([], true), [u], points);
    const truth = formationSlots(variant([...foe.path], undefined), [u], points);
    const before = formationSlots(variant([], false), [u], points);
    expect(live).toEqual(truth);                                    // the hidden route no longer changes it
    expect(live[0].tile).toBe(FT);                                  // a body under way holds no tile
    expect(before[0].tile).not.toBe(FT);                            // ...and the flag is what tells them apart

    // Control: once the enemy stops, the viewer is told it holds its ground.
    foe.path = [];
    const stopped = await a.next(m => m.t === 'snap' && m.divs.some(r => r[0] === foe.id && !(r[7] & F_MOVING)));
    applySnapshot(view, stopped, 1);
    expect(view.byId.get(foe.id).moving).toBe(false);

    a.close(); b.close();
  }, 15000);

  it('breaks a real division out of combat and corners it, and the mirror follows the flags', async () => {
    const a = connect('Wounded', 'RETR1', tok('w'));
    await a.next(m => m.t === 'lobby');
    const b = connect('Bystander', 'RETR1', tok('e'));
    await b.next(m => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    await b.next(m => m.t === 'init');
    const view = createViewWorld(initA);
    const world = server.rooms.get('RETR1').world;

    // A wide open block: a rout needs reachable land 6..12 tiles away, and the cornering enemy must
    // be able to land right beside a live, moving body.
    const ground = openSquare(world, 13) || openSquare(world, 11) || openSquare(world, 9);
    expect(ground).toBeTruthy();

    // Real combat is what starts a rout: a player-1 armor just under 40% of its cap with a player-2
    // infantry one tile away, so the next combat tick wounds it and the rout begins on
    // its own. Armor outruns infantry, so the melee breaks again by itself. No field is ever written.
    const pair = (dx, dy) => {
      const runner = spawnDiv(world, 1, ground.x + dx + .5, ground.y + dy + .5, 39.5, 100, 'arm');
      const spar = spawnDiv(world, 2, ground.x + dx + 1.5, ground.y + dy + .5, 100, 100);
      expect(runner).toBeTruthy();
      expect(spar).toBeTruthy();
      put(runner, ground.x + dx + .5, ground.y + dy + .5);
      put(spar, ground.x + dx + 1.5, ground.y + dy + .5);   // 1.0 tile away: contact, not a kill zone
      return runner;
    };
    const runner = pair(-4, -4);      // routed by combat, then cornered
    const healer = pair(4, 4);        // routed by combat, then recovers without further contact

    const flags = (snap, id) => { const r = snap.divs.find(x => x[0] === id); return r ? r[7] : 0; };
    const routed = await a.after(m => m.t === 'snap' && (flags(m, runner.id) & F_ROUTING), 8000);
    const row = routed.divs.find(r => r[0] === runner.id);
    expect(row[7] & F_MOVING).toBe(F_MOVING);                            // fleeing is a real path, not holding ground
    for (const r of routed.divs) if (r[1] !== 1) expect(r.length).toBe(8);   // a rival's route never travels
    applySnapshot(view, routed, 1);
    expect(view.byId.get(runner.id).routing).toBe(true);
    expect(view.byId.get(runner.id).routePoints).toEqual([]);            // a rout keeps its escape in the leg alone...
    expect(view.byId.get(runner.id).path.length).toBeGreaterThan(0);     // ...and that leg really travels
    expect(view.byId.get(runner.id).routLocked).toBe(false);

    // While it still runs, a fresh enemy catches it: cornered, the rout is closed for good. (If the
    // original melee catches up first the lock is just as real, so accept either path to the disengage.)
    await a.after(m => m.t === 'snap' && (!(flags(m, runner.id) & F_ENG) || (flags(m, runner.id) & F_ROUT_LOCKED)), 8000);
    if (!world.divs.find(d => d.id === runner.id).routLocked) {
      const cutter = spawnDiv(world, 2, runner.x + 1.5, runner.y, 100, 100);
      expect(cutter).toBeTruthy();
      put(cutter, runner.x + 1, runner.y);
    }
    const locked = await a.after(m => m.t === 'snap' && (flags(m, runner.id) & F_ROUT_LOCKED), 8000);
    applySnapshot(view, locked, 1);
    expect(view.byId.get(runner.id).routLocked).toBe(true);
    expect(world.divs.find(d => d.id === runner.id).routLocked).toBe(true);

    // Unintercepted, a router recovers above 70% and stops fleeing...
    await a.after(m => m.t === 'snap' && (flags(m, healer.id) & F_ROUTING), 8000);
    healer.men = healer.cap * 0.8;
    const recovered = await a.after(m => m.t === 'snap' && !(flags(m, healer.id) & F_ROUTING), 8000);
    applySnapshot(view, recovered, 1);
    expect(view.byId.get(healer.id).routing).toBe(false);

    // ...and mere depletion below 40% is not a rout: without combat it holds its ground.
    // Clear the test's own hostiles first: a live enemy would keep the fight going, so the premise
    // under test is a router with no combat left to re-open it. Own bodies are kept untouched.
    world.divs = world.divs.filter(d => d.owner === healer.owner);
    healer.men = healer.cap * 0.1;
    const calm = await a.after(m => m.t === 'snap' && m.time > recovered.time && m.divs.some(r => r[0] === healer.id), 4000);
    const calmRow = calm.divs.find(r => r[0] === healer.id);
    expect(calmRow).toBeTruthy();                                // still on the board: not a vanished-unit pass
    expect(calmRow[7] & F_ENG).toBe(0);                          // no combat is holding it
    expect(calmRow[7] & F_ROUTING).toBe(0);                      // and depletion alone does not start a rout

    a.close(); b.close();
  }, 30000);

  it('charges gold for a real road, mirrors it, and keeps it across capture and reconnect', async () => {
    const token = tok('r');
    const a = connect('Builder', 'ROAD1', token);
    await a.next(m => m.t === 'lobby');
    const b = connect('Rival', 'ROAD1', tok('r2'));
    await b.next(m => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    const world = server.rooms.get('ROAD1').world;
    const view = createViewWorld(initA);

    // The shortest legal road: two adjacent tiles of player 1's own land, exactly two fresh tiles.
    const pairs = ownedPairs(world, 1);
    expect(pairs.length).toBeGreaterThan(0);
    const [t0, t1] = pairs[0];
    const px = t => (t % world.w) + .5;
    const py = t => ((t / world.w) | 0) + .5;
    const points = [[px(t0), py(t0)], [px(t1), py(t1)]];

    world.players[0].gold = 100;
    const gold0 = world.players[0].gold, time0 = world.time;
    a.send({ t: 'cmd', c: { k: 'road', points } });
    const built = await a.after(m => m.t === 'snap' && m.rch && m.rch.length);
    const tiles = [];
    for (let k = 0; k < built.rch.length; k += 2) if (built.rch[k + 1]) tiles.push(built.rch[k]);
    expect(tiles.sort((x, y) => x - y)).toEqual([t0, t1].sort((x, y) => x - y));
    // Paid per fresh tile out of the builder's own gold; only the ticking income explains the slack.
    const earned = world.players[0].goldRate * (world.time - time0 + .05);
    const spent = gold0 + earned - world.players[0].gold;
    expect(spent).toBeGreaterThan(2 * ROAD_GOLD - 1);
    expect(spent).toBeLessThan(2 * ROAD_GOLD + 1);
    applySnapshot(view, built, 1);
    expect(view.roads[t0]).toBe(1);
    expect(view.roads[t1]).toBe(1);
    expect(view.roadVersion).toBeGreaterThan(initA.roadVersion);   // deltas bump the map's road revision

    // Repeating the order is free and silent: nothing changes, so no road delta travels.
    a.send({ t: 'cmd', c: { k: 'road', points } });
    const quiet = await a.after(m => m.t === 'snap' && m.time > built.time);
    expect(quiet.rch == null || quiet.rch.length === 0).toBe(true);

    // A road the player cannot pay for is refused with a real error event and builds nothing.
    const fresh = pairs.find(p => !p.includes(t0) && !p.includes(t1));
    expect(fresh).toBeTruthy();
    world.players[0].gold = 2;
    a.send({ t: 'cmd', c: { k: 'road', points: [[px(fresh[0]), py(fresh[0])], [px(fresh[1]), py(fresh[1])]] } });
    const ev = await a.after(m => m.t === 'ev' && m.e === 'buildFailed');
    expect(ev.d.reason).toBe('gold');
    expect(ev.d.need).toBe(2 * ROAD_GOLD);                      // the very tiles that would have been laid
    await settle(150);
    expect(world.roads[fresh[0]]).toBe(0);
    expect(world.players[0].gold).toBeGreaterThanOrEqual(2);    // nothing was charged for a refused road

    // Illegal sketches are ignored: too few points, too many, a non-finite point, water, a rival's land.
    const roadsBefore = Array.from(world.roads).join('');
    const water = world.terr.indexOf(WATER);
    const foreign = world.owner.indexOf(2);
    const illegal = [
      [[px(t0), py(t0)]],
      Array.from({ length: MAX_ROUTE_POINTS + 1 }, () => [px(fresh[0]), py(fresh[0])]),
      [[px(fresh[0]), NaN], [px(fresh[1]), py(fresh[1])]],
      [[px(t0), py(t0)], [(water % world.w) + .5, ((water / world.w) | 0) + .5]],
      [[px(t0), py(t0)], [(foreign % world.w) + .5, ((foreign / world.w) | 0) + .5]]
    ];
    for (const sketch of illegal) a.send({ t: 'cmd', c: { k: 'road', points: sketch } });
    await settle(150);
    expect(Array.from(world.roads).join('')).toBe(roadsBefore);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);

    // Reconnecting rebuilds the full road set from init, deltas keep applying, and a captured tile
    // keeps its road: ownership and roads are independent.
    a.close();
    await settle(200);
    const back = connect('Builder', 'ROAD1', token);
    const init2 = await back.next(m => m.t === 'init');
    expect(init2.roads).toContain(t0);
    expect(init2.roads).toContain(t1);
    const rejoin = createViewWorld(init2);
    expect(rejoin.roads[t0]).toBe(1);
    setOwner(world, t0, 2);
    const captured = await back.after(m => m.t === 'snap' && m.ch && m.ch.includes(t0));
    applySnapshot(rejoin, captured, 1);
    expect(rejoin.owner[t0]).toBe(2);
    expect(rejoin.roads[t0]).toBe(1);
    expect(rejoin.roads[t1]).toBe(1);
    expect(world.roads[t0]).toBe(1);

    a.close(); b.close();
  }, 20000);

  it('sends own multipoint checkpoints and column state on the wire, never an enemy\'s route', async () => {
    const a = connect('Ranger', 'ROUT1', tok('a'));
    await a.next(m => m.t === 'lobby');
    const b = connect('Chaser', 'ROUT1', tok('b'));
    await b.next(m => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'configure', settings: { fog: false, seed: 5150 } });   // b sees the body: privacy must still hold
    await a.next(m => m.t === 'lobby' && m.settings.seed === 5150);
    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    await b.next(m => m.t === 'init');
    const world = server.rooms.get('ROUT1').world;
    const view = createViewWorld(initA);
    const s = connect('Watcher', 'ROUT1', tok('s'), { role: 'spectator' });
    await s.next(m => m.t === 'init');

    // Open ground, so every checkpoint is land and every leg has a path.
    const ground = openSquare(world, 13) || openSquare(world, 11);
    expect(ground).toBeTruthy();
    const scout = spawnDiv(world, 1, ground.x + .5, ground.y + .5, 80, 80);
    expect(scout).toBeTruthy();
    put(scout, ground.x + .5, ground.y + .5);
    const pts = [[ground.x + 3.5, ground.y + .5], [ground.x + 4.5, ground.y + .5], [ground.x + 5.5, ground.y + .5]];

    a.send({ t: 'cmd', c: { k: 'route', ids: [scout.id], points: pts, append: false, column: true } });
    const own = await a.after(m => m.t === 'snap' && m.divs.some(r => r[0] === scout.id && r.length > 9));
    const row = own.divs.find(r => r[0] === scout.id);
    expect(row[7] & F_MOVING).toBe(F_MOVING);
    expect(row[7] & F_COLUMN).toBe(F_COLUMN);
    expect(row[9]).toEqual(pts);                                  // every explicit checkpoint is queued, in order
    const leg = row[8][row[8].length - 1];                        // ...and the current leg really aims at the first
    expect(leg % world.w).toBe(ground.x + 3);
    expect((leg / world.w) | 0).toBe(ground.y);
    applySnapshot(view, own, 1);
    const mine = view.byId.get(scout.id);
    expect(mine.routePoints).toEqual(pts);
    expect(mine.column).toBe(true);
    expect(mine.moving).toBe(true);

    // The rival (fog off, so the body itself is visible) and the spectator get the intention but
    // never the checkpoints.
    const rival = await b.after(m => m.t === 'snap' && m.divs.some(r => r[0] === scout.id));
    const rrow = rival.divs.find(r => r[0] === scout.id);
    expect(rrow.length).toBe(8);
    expect(rrow[7] & F_COLUMN).toBe(F_COLUMN);
    expect(rrow[7] & F_MOVING).toBe(F_MOVING);
    const spec = await s.after(m => m.t === 'snap' && m.divs.some(r => r[0] === scout.id));
    expect(spec.divs.find(r => r[0] === scout.id).length).toBe(8);

    // Append adds one more checkpoint; a plain move clears the queue and the column intention.
    a.send({ t: 'cmd', c: { k: 'route', ids: [scout.id], points: [[ground.x + 5.5, ground.y + 1.5]], append: true } });
    const appended = await a.after(m => m.t === 'snap' && m.divs.some(r => r[0] === scout.id && r.length > 9 && r[9].length === 4));
    expect(appended.divs.find(r => r[0] === scout.id)[9][3]).toEqual([ground.x + 5.5, ground.y + 1.5]);
    a.send({ t: 'cmd', c: { k: 'move', ids: [scout.id], x: ground.x + 2.5, y: ground.y + 2.5 } });
    const moved = await a.after(m => m.t === 'snap' && m.divs.some(r => r[0] === scout.id && r.length === 9));
    expect(moved.divs.find(r => r[0] === scout.id)[7] & F_COLUMN).toBe(0);
    expect(moved.divs.find(r => r[0] === scout.id)[7] & F_MOVING).toBe(F_MOVING);
    applySnapshot(view, moved, 1);
    expect(view.byId.get(scout.id).routePoints).toEqual([]);

    // Illegal payloads are ignored without disturbing the live order or the session.
    const before = (world.divs.find(d => d.id === scout.id).routePoints || []).length;
    a.send({ t: 'cmd', c: { k: 'route', ids: [scout.id], points: [], append: true } });
    a.send({ t: 'cmd', c: { k: 'route', ids: [scout.id], points: [[ground.x + .5, NaN]], append: true } });
    a.send({ t: 'cmd', c: { k: 'route', ids: [scout.id], points: Array.from({ length: MAX_ROUTE_POINTS + 1 }, () => [ground.x + .5, ground.y + .5]), append: true } });
    await settle(150);
    expect((world.divs.find(d => d.id === scout.id).routePoints || []).length).toBe(before);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);

    a.close(); b.close(); s.close();
  }, 20000);

  it('sends a displaced own body\'s saved home to its owner alone, and the mirror reserves that ground', async () => {
    const a = connect('Owner', 'ANCH1', tok('a'));
    await a.next(m => m.t === 'lobby');
    const b = connect('Rival', 'ANCH1', tok('b'));
    await b.next(m => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'configure', settings: { fog: false, seed: 8371 } });   // b sees our bodies: privacy must still hold
    await a.next(m => m.t === 'lobby' && m.settings.seed === 8371);
    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    await b.next(m => m.t === 'init');
    const world = server.rooms.get('ANCH1').world;
    const view = createViewWorld(initA);
    const s = connect('Watcher', 'ANCH1', tok('s'), { role: 'spectator' });
    await s.next(m => m.t === 'init');

    // A wide block with no other body or city anywhere near it, so the traffic, the shove and the
    // fallback slots around the home are the only things in play.
    const ground = clearSquare(world, 15, 9);
    expect(ground).toBeTruthy();
    const gx = ground.x, gy = ground.y;
    // The tile next door to the home. Its centre is inside MIN_SEP of the home spot, but the shove
    // carries the holder's body clear of it, so nothing but the home itself can keep a unit off it.
    const goal = { x: gx + 6.5, y: gy + 5.5 };
    const homeTile = (gy + 5) * world.w + (gx + 5), goalTile = (gy + 5) * world.w + (gx + 6);

    // The holder stands a hair off its own tile centre: the wire has to carry that exact spot, and the
    // tile next door then falls inside MIN_SEP of it. The mover is ordered straight through the holder,
    // so the authoritative tick shoves a friendly body aside and remembers the ground it left behind.
    const hx = gx + 5.9 + 0.0037, hy = gy + 5.5;
    const holder = spawnDiv(world, 1, hx, hy, 80, 80);
    expect(holder).toBeTruthy();
    put(holder, hx, hy);
    const mover = spawnDiv(world, 1, gx + 4.1, hy, 80, 80);
    put(mover, gx + 4.1, hy);
    const u = spawnDiv(world, 1, gx + 5.5, gy + 2.5, 80, 80);            // ordered onto the home spot later
    expect(u).toBeTruthy();
    put(u, gx + 5.5, gy + 2.5);
    const points = [[goal.x, goal.y], [goal.x, goal.y]];                // a zero-length line: the order aims at that tile

    // Registered before the order: these are snapshots sent while the holder is under way only because
    // of the home it is walking back to.
    const rivalSnap = b.after(m => m.t === 'snap' && m.divs.some(r => r[0] === holder.id && (r[7] & F_MOVING)), 10000);
    const specSnap = s.after(m => m.t === 'snap' && m.divs.some(r => r[0] === holder.id && (r[7] & F_MOVING)), 10000);

    a.send({ t: 'cmd', c: { k: 'move', ids: [mover.id], x: gx + 10.5, y: hy } });
    // Wait until the shove has carried the holder's body clear of the tile centre the order aims at:
    // from there its body alone no longer excludes that tile, so what the mirror does depends on the
    // home the wire carries.
    const far = m => {
      const r = m.t === 'snap' && m.divs && m.divs.find(r => r[0] === holder.id);
      return r && r.length === 11 && Math.hypot(r[3] - goal.x, r[4] - goal.y) >= 0.9 ? r : null;
    };
    const own = await a.next(m => far(m), 15000);
    const row = far(own);
    expect(row[8]).toEqual([]);                    // the route slots are padded so the home lands at [10]
    expect(row[9]).toEqual([]);
    expect(row[10][0]).toBe(hx);                   // the exact saved spot, never rounded
    expect(row[10][0]).not.toBe(Math.round(hx * 100) / 100);
    expect(row[10][1]).toBe(hy);
    expect(row[7] & F_MOVING).toBe(F_MOVING);      // under way by its saved home alone
    expect(row[7] & ~(F_ENG | F_OOS | F_MOVING | F_ROUTING | F_ROUT_LOCKED | F_COLUMN)).toBe(0);   // and no new flag
    expect(world.divs.find(d => d.id === holder.id).anchor).toEqual({ x: hx, y: hy });
    expect(own.divs.find(r => r[0] === mover.id).length).toBe(9);   // a walking own row keeps its old shape
    expect(own.divs.find(r => r[0] === u.id).length).toBe(8);

    applySnapshot(view, own, 1);
    const held = view.byId.get(holder.id);
    expect(held.anchor).toEqual({ x: hx, y: hy });  // the mirror holds the home too...
    expect(held.moving).toBe(true);                 // ...so it counts as under way
    const mu = view.byId.get(u.id);

    // The ordered tile's centre is inside MIN_SEP of the home while the holder's body has been shoved
    // clear of it, so only the home can keep a unit off it - and the mirror has to know that.
    const live = formationSlots(view, [mu], points);
    const truth = formationSlots(world, [u], points);
    expect(Math.hypot(goal.x - held.anchor.x, goal.y - held.anchor.y)).toBeLessThan(MIN_SEP);
    expect(Math.hypot((gx + 5.5) - held.anchor.x, (gy + 5.5) - held.anchor.y)).toBeLessThan(MIN_SEP);
    expect(Math.hypot(goal.x - row[3], goal.y - row[4])).toBeGreaterThan(MIN_SEP);   // the body is clear of it
    expect(live[0].tile).toBe(truth[0].tile);       // the mirror allocates what the server would...
    expect(live[0].tile).not.toBe(goalTile);        // ...and refuses the ordered tile, as the home says
    expect(live[0].tile).not.toBe(homeTile);
    // Without the home the very same preview takes the ordered tile: the home on the wire is what keeps
    // the unit off the ground a displaced body is walking back to.
    const blind = Object.create(view);
    blind.divs = view.divs.map(d => (d === held ? { ...d, anchor: null } : d));
    expect(formationSlots(blind, [mu], points)[0].tile).toBe(goalTile);

    // The real order lands exactly where the mirror previewed.
    a.send({ t: 'cmd', c: { k: 'formation', ids: [u.id], points } });
    await settle(150);
    expect(world.divs.find(d => d.id === u.id).path.at(-1)).toBe(live[0].tile);

    // The rival and the spectator see the body but never its home.
    const rrow = (await rivalSnap).divs.find(r => r[0] === holder.id);
    expect(rrow.length).toBe(8);
    expect(rrow[7] & F_MOVING).toBe(F_MOVING);
    expect((await specSnap).divs.find(r => r[0] === holder.id).length).toBe(8);

    // A fresh order gives up the walk home: the wire drops the home and the mirror clears it...
    a.send({ t: 'cmd', c: { k: 'move', ids: [holder.id], x: gx + 2.5, y: gy + 8.5 } });
    const released = await a.after(m => m.t === 'snap' && m.divs.some(r => r[0] === holder.id && r.length === 9), 10000);
    const rrow2 = released.divs.find(r => r[0] === holder.id);
    expect(rrow2[10]).toBeUndefined();
    expect(rrow2[7] & F_MOVING).toBe(F_MOVING);     // walking its new order instead
    applySnapshot(view, released, 1);
    expect(view.byId.get(holder.id).anchor).toBe(null);
    expect(world.divs.find(d => d.id === holder.id).anchor).toBe(null);

    // ...and once the body is off the ground it held, nobody reserves the old home: the preview takes
    // the ordered tile back, and so does the authoritative allocator.
    await a.after(m => m.t === 'snap' && m.divs.some(r => r[0] === holder.id && r.length === 8), 15000);
    const away = world.divs.find(d => d.id === holder.id);
    expect(Math.hypot(away.x - hx, away.y - hy)).toBeGreaterThan(MIN_SEP);
    expect(formationSlots(view, [mu], points)[0].tile).toBe(goalTile);
    expect(formationSlots(world, [u], points)[0].tile).toBe(goalTile);

    a.close(); b.close(); s.close();
  }, 30000);

  it('lets only the host configure settings and starts every client on the chosen map', async () => {
    const a = connect('Host', 'CFG1', tok('a'));
    await a.next(m => m.t === 'lobby' && m.players.length === 1);
    const b = connect('Guest', 'CFG1', tok('b'));
    const lb = await b.next(m => m.t === 'lobby' && m.players.length === 2);
    expect(lb.settings.mapSize).toBe('standard');
    expect(lb.players.map(p => p.faction)).toEqual([1, 2]);          // first free enabled factions

    // a non-host settings edit is refused and changes nothing
    b.send({ t: 'configure', settings: { mapSize: 'large' } });
    const denied = await b.next(m => m.t === 'err');
    expect(denied.soft).toBe(true);
    expect(denied.msg).toMatch(/host/i);
    await settle(100);
    expect(lastLobby(b).settings.mapSize).toBe('standard');

    // an occupied faction cannot be taken
    b.send({ t: 'seat', role: 'player', faction: 1 });
    const taken = await b.next(m => m.t === 'err' && /taken/.test(m.msg));
    expect(taken.soft).toBe(true);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);                    // ...and the session survives it

    // host trims the game to factions 2 and 5 with a small, fixed-seed map
    a.send({ t: 'seat', role: 'player', faction: 5 });
    await a.next(m => m.t === 'lobby' && m.players.some(p => p.you && p.faction === 5));
    b.send({ t: 'seat', role: 'player', faction: 2 });
    await b.next(m => m.t === 'lobby' && m.players.some(p => p.you && p.faction === 2));
    a.send({ t: 'configure', settings: { mapSize: 'small', factions: [2, 5], startingResources: 2, incomeMultiplier: 0.5, victoryShare: 0.63, fog: false, seed: 4242, aiDifficulty: 'hard' } });
    const configured = await b.next(m => m.t === 'lobby' && m.settings.mapSize === 'small');
    expect(configured.settings).toEqual({
      mapSize: 'small', w: 100, h: 64, factions: [2, 5], bots: [], teams: null, teamCount: 2,
      startingResources: 2, incomeMultiplier: 0.5, victoryShare: 0.63, fog: false, seed: 4242, aiDifficulty: 'hard'
    });
    expect(configured.players.map(p => p.faction)).toEqual([5, 2]);

    // disabling a faction that is already seated is refused, not silently reshuffled
    a.send({ t: 'configure', settings: { factions: [2, 3] } });
    const inUse = await a.next(m => m.t === 'err' && /in use/.test(m.msg));
    expect(inUse.soft).toBe(true);
    b.send({ t: 'seat', role: 'player', faction: 4 });               // disabled by the trim
    const disabled = await b.next(m => m.t === 'err' && /not in this game/.test(m.msg));
    expect(disabled.soft).toBe(true);

    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    const initB = await b.next(m => m.t === 'init');
    expect(initA.me).toBe(5);
    expect(initB.me).toBe(2);
    expect(initA.seed).toBe(4242);
    expect(initA.w).toBe(100);
    expect(initA.h).toBe(64);
    expect(initA.owner.length).toBe(100 * 64);
    expect(initA.settings).toEqual(configured.settings);
    // The trimmed game still generates the whole small map: factions 2 and 5 play, the other seats
    // stay disabled and the mirror keeps every one of them addressable.
    expect(initA.players.length).toBe(initA.cityCapacity);
    expect(initA.players.filter(p => p.enabled).map(p => p.id)).toEqual([2, 5]);
    expect(initA.players.filter(p => !p.enabled).every(p => p.team === 0 && !p.bot && !p.human && !p.seat)).toBe(true);
    expect(initA.players.find(p => p.id === 5)).toMatchObject({ human: true, seat: true, team: 5, bot: false });
    expect(initA.players.find(p => p.id === 2)).toMatchObject({ human: true, seat: true, team: 2, bot: false });

    const world = [...server.rooms.values()].find(r => r.code === 'CFG1').world;
    expect(world.w).toBe(100);
    expect(world.h).toBe(64);
    expect(world.owner.length).toBe(6400);
    expect(world.players[0].enabled).toBe(false);
    expect(world.players[0].alive).toBe(false);                      // disabled factions never live
    expect(world.cities.every(c => c.owner === 0 || c.owner === 2 || c.owner === 5)).toBe(true);
    // the chosen difficulty reached every seat's runtime policy, human and AI alike
    expect(initA.settings.aiDifficulty).toBe('hard');
    expect(world.players[1].aiPolicy).toEqual(getAIPolicy('hard'));
    expect(world.players[4].aiPolicy).toEqual(getAIPolicy('hard'));
    expect(world.players[0].aiPolicy).toEqual(getAIPolicy('hard'));  // disabled seat still canonical

    // both mirrors regenerate exactly the same small map, matching the server's arrays
    const va = createViewWorld(initA), vb = createViewWorld(initB);
    expect(va.w).toBe(100);
    expect(va.h).toBe(64);
    expect(va.terr.length).toBe(6400);
    expect(va.cityAt.length).toBe(6400);
    expect(va.settings).toEqual(initA.settings);
    expect(va.players.map(p => p.enabled)).toEqual(initA.players.map(p => p.enabled));
    expect(Buffer.compare(Buffer.from(va.terr), Buffer.from(vb.terr))).toBe(0);
    expect(Buffer.compare(Buffer.from(va.owner), Buffer.from(world.owner))).toBe(0);

    // fog:false is a game rule, not a client hint: every economy arrives visible with fog off
    const snapA = await a.next(m => m.t === 'snap');
    expect(snapA.fog).toBe(false);
    expect(snapA.pl[1][3]).toBeGreaterThanOrEqual(0);                // rival manpower is visible
    expect(snapA.pl[4][5]).toBeGreaterThanOrEqual(0);
    applySnapshot(va, snapA, 1);

    a.close(); b.close();
  }, 15000);

  it('lets a spectator watch the full map but never act', async () => {
    const a = connect('Blue', 'SPEC1', tok('a'));
    await a.next(m => m.t === 'lobby' && m.players.length === 1);
    const b = connect('Red', 'SPEC1', tok('b'));
    await b.next(m => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    await b.next(m => m.t === 'init');
    const world = server.rooms.get('SPEC1').world;

    // a spectator may still join a running game: me=0, full map, no faction
    const s = connect('Watcher', 'SPEC1', tok('s'), { role: 'spectator' });
    const initS = await s.next(m => m.t === 'init');
    expect(initS.me).toBe(0);
    expect(initS.seed).toBe(initA.seed);
    expect(initS.w).toBe(initA.w);
    expect(initS.players.find(p => p.id === 0)).toBeUndefined();
    expect(s.msgs.find(m => m.t === 'lobby').players.find(p => p.you)).toMatchObject({ role: 'spectator', faction: 0 });

    // a body far outside everyone's vision: the players never see it, the spectator always does
    const W = world.w, H = world.h;
    let T = -1;
    for (let t = 0; t < world.owner.length && T < 0; t++) {
      if (world.terr[t] !== LAND) continue;
      const x = t % W, y = (t / W) | 0;
      if (x < 4 || y < 4 || x > W - 5 || y > H - 5) continue;
      let far = true;
      for (const c of world.cities) if (c.owner === 2 && Math.hypot(c.x - x, c.y - y) < 30) { far = false; break; }
      for (const d of world.divs) if (d.owner === 2 && Math.hypot(d.x - x, d.y - y) < 30) { far = false; break; }
      if (far) T = t;
    }
    expect(T).toBeGreaterThanOrEqual(0);
    const foe = spawnDiv(world, 1, (T % W) + .5, ((T / W) | 0) + .5, 50, 50);
    foe.path = [(H - 1) * W + (W - 1)];           // under way, so its route must stay private
    const route = foe.path[0];

    // player 2's snapshots never contain that body...
    const snapB = await b.after(m => m.t === 'snap');
    expect(snapB.divs.some(r => r[0] === foe.id)).toBe(false);
    // ...while the spectator sees it (no fog) without its route
    const snapS = await s.after(m => m.t === 'snap' && m.divs.some(r => r[0] === foe.id));
    expect(snapS.fog).toBe(false);
    const row = snapS.divs.find(r => r[0] === foe.id);
    expect(row.length).toBe(8);
    expect(row[7] & F_MOVING).toBe(F_MOVING);
    expect(snapS.pl.every(r => r[3] >= 0 && r[5] >= 0)).toBe(true);  // every economy is visible
    const view = createViewWorld(initS);
    applySnapshot(view, snapS, 1);
    expect(view.byId.get(foe.id).path.length).toBe(0);

    // spectator commands are dropped: no division is raised, no reserves spent, no route changed
    const divsBefore = world.divs.length;
    const poolBefore = world.players[0].pool;
    const city = world.cities.findIndex(c => c.owner === 1);
    expect(city).toBeGreaterThanOrEqual(0);
    s.send({ t: 'cmd', c: { k: 'raise', type: 'inf', city } });
    s.send({ t: 'cmd', c: { k: 'move', ids: [foe.id], x: 3, y: 3 } });
    s.send({ t: 'cmd', c: { k: 'road', points: [[3.5, 3.5], [4.5, 3.5]] } });
    s.send({ t: 'cmd', c: { k: 'route', ids: [foe.id], points: [[5.5, 5.5]], append: true, column: true } });
    await settle(300);
    expect(world.divs.length).toBe(divsBefore);             // a real raise would have added a body
    expect(world.players[0].pool).toBeGreaterThanOrEqual(poolBefore);   // ...and spent manpower
    expect(world.divs.find(d => d.id === foe.id).path[0]).toBe(route);
    expect(world.roads.some(v => v)).toBe(false);           // a spectator cannot build roads...
    expect((world.divs.find(d => d.id === foe.id).routePoints || []).length).toBe(0);   // ...or order a route

    // and a spectator cannot grab a seat once the game is running
    s.send({ t: 'seat', role: 'player', faction: 3 });
    const noSeat = await s.next(m => m.t === 'err' && /lobby/.test(m.msg));
    expect(noSeat.soft).toBe(true);
    expect(s.ws.readyState).toBe(WebSocket.OPEN);

    a.close(); b.close(); s.close();
  }, 15000);

  it('lets a spectator host an all-AI game that does not end by human elimination', async () => {
    const h = connect('Referee', 'AIGAME', tok('h'), { role: 'spectator' });
    const lb = await h.next(m => m.t === 'lobby');
    expect(lb.players[0]).toMatchObject({ host: true, role: 'spectator', faction: 0 });
    h.send({ t: 'start' });
    const init = await h.next(m => m.t === 'init');
    expect(init.me).toBe(0);
    // the roster still covers every seat of the map; the six default factions are all AI-run with
    // no human seat anywhere and nothing bot-reserved
    expect(init.players.filter(p => p.enabled).map(p => p.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(init.players.every(p => !p.seat && !p.human)).toBe(true);
    expect(init.players.filter(p => p.enabled).every(p => p.bot === false)).toBe(true);

    const room = server.rooms.get('AIGAME');
    expect(room.world.players.every(p => !p.human && !p.seat)).toBe(true);
    await settle(400);
    expect(room.state).toBe('running');       // with no human seat the game must not auto-end
    expect(room.world.over).toBe(false);

    // the host keeps watching (full map) and still cannot command anyone
    const snap = await h.after(m => m.t === 'snap');
    expect(snap.fog).toBe(false);
    const ids = room.world.divs.slice(0, 2).map(d => d.id);
    const divsBefore = room.world.divs.length;
    h.send({ t: 'cmd', c: { k: 'split', ids } });
    await settle(200);
    expect(room.world.divs.length).toBe(divsBefore);
    h.close();
  }, 10000);

  it('keeps role, faction, settings and world across reconnect and rematch', async () => {
    const token = tok('r');
    const a = connect('Owner', 'RCON', token);
    await a.next(m => m.t === 'lobby');
    a.send({ t: 'seat', role: 'player', faction: 3 });
    await a.next(m => m.t === 'lobby' && m.players.some(p => p.you && p.faction === 3));
    const wToken = tok('w');
    const watcher = connect('Watcher', 'RCON', wToken, { role: 'spectator' });
    await watcher.next(m => m.t === 'lobby' && m.players.length === 2);
    a.send({ t: 'configure', settings: { mapSize: 'large', seed: 777, aiDifficulty: 'easy' } });
    await a.next(m => m.t === 'lobby' && m.settings.seed === 777);
    a.send({ t: 'start' });
    const init1 = await a.next(m => m.t === 'init');
    expect(init1.me).toBe(3);
    expect(init1.seed).toBe(777);
    expect(init1.w).toBe(200);
    expect(init1.h).toBe(128);
    expect(init1.settings.aiDifficulty).toBe('easy');
    const world1 = server.rooms.get('RCON').world;
    expect(world1.players[2].aiPolicy).toEqual(getAIPolicy('easy'));

    // reconnect keeps the token's role/faction, settings and the very same running world
    a.close();
    await settle(200);
    const back = connect('Owner', 'RCON', token);
    const init2 = await back.next(m => m.t === 'init');
    expect(init2.me).toBe(3);
    expect(init2.seed).toBe(init1.seed);
    expect(init2.settings).toEqual(init1.settings);
    expect(server.rooms.get('RCON').world).toBe(world1);
    expect(back.msgs.find(m => m.t === 'lobby').players.find(p => p.you)).toMatchObject({ role: 'player', faction: 3 });

    // the spectator's role survives its own reconnect too
    watcher.close();
    await settle(200);
    const watchBack = connect('Watcher', 'RCON', wToken);
    const wInit = await watchBack.next(m => m.t === 'init');
    expect(wInit.me).toBe(0);
    expect(watchBack.msgs.find(m => m.t === 'lobby').players.find(p => p.you)).toMatchObject({ role: 'spectator', faction: 0 });

    // rematch keeps settings and lobby seats; the next game reuses the fixed seed and faction
    world1.over = true;
    world1.result = { winnerId: 3, reason: 'land', pct: 70 };
    await back.next(m => m.t === 'lobby' && m.state === 'ended');
    back.send({ t: 'rematch' });
    const lb = await back.next(m => m.t === 'lobby' && m.state === 'lobby');
    expect(lb.settings).toEqual(init1.settings);
    expect(lb.players.find(p => p.you)).toMatchObject({ role: 'player', faction: 3 });
    back.send({ t: 'start' });
    const init3 = await back.after(m => m.t === 'init');
    expect(init3.me).toBe(3);
    expect(init3.seed).toBe(777);
    expect(init3.w).toBe(200);
    expect(init3.h).toBe(128);
    expect(server.rooms.get('RCON').world).not.toBe(world1);
    back.close(); watchBack.close();
  }, 15000);

  it('rejects malformed settings without touching the live lobby settings', async () => {
    const a = connect('Host', 'BADSET', tok('a'));
    const l0 = await a.next(m => m.t === 'lobby');
    const bad = [
      { mapSize: 'huge' }, { factions: [1] }, { factions: [1, 1] }, { factions: [0, 1] },
      { startingResources: 3 }, { incomeMultiplier: 5 },
      { victoryShare: 0.4 }, { victoryShare: 1.5 }, { victoryShare: '0.6' },
      { aiDifficulty: 'insane' }, { aiDifficulty: 1 }, { aiDifficulty: null },
      { fog: 'yes' }, { seed: -1 }, { seed: 1.5 }, 'nope', [1, 2], null
    ];
    for (const settings of bad) {
      a.send({ t: 'configure', settings });
      const e = await a.after(m => m.t === 'err');
      expect(e.soft).toBe(true);
      expect(typeof e.msg).toBe('string');
      expect(e.msg.length).toBeGreaterThan(0);
    }

    // nothing above stuck: a valid edit still starts from the original settings
    a.send({ t: 'configure', settings: { startingResources: 2 } });
    const l1 = await a.after(m => m.t === 'lobby' && m.settings.startingResources === 2);
    expect(l1.settings).toEqual({ ...l0.settings, startingResources: 2 });

    // and a malformed start patch cannot launch the game
    a.send({ t: 'start', settings: { incomeMultiplier: 7 } });
    const se = await a.after(m => m.t === 'err');
    expect(se.soft).toBe(true);
    await settle(100);
    expect(a.msgs.some(m => m.t === 'init')).toBe(false);
    expect(server.rooms.get('BADSET').state).toBe('lobby');

    // ...while a valid start patch does launch, with the patched settings
    a.send({ t: 'start', settings: { mapSize: 'small', seed: 99 } });
    const init = await a.after(m => m.t === 'init');
    expect(init.seed).toBe(99);
    expect(init.w).toBe(100);
    expect(init.settings).toEqual({ ...l1.settings, mapSize: 'small', w: 100, h: 64, seed: 99 });
    expect(server.rooms.get('BADSET').state).toBe('running');
    a.close();
  }, 10000);

  it('caps a room at MAX_CLIENTS connections', async () => {
    const clients = [];
    for (let i = 0; i < MAX_CLIENTS; i++) {
      const c = connect('Watcher' + i, 'CAP1', tok('c' + i), { role: 'spectator' });
      clients.push(c);
      await c.next(m => m.t === 'lobby');
    }
    const extra = connect('Extra', 'CAP1', tok('x'), { role: 'spectator' });
    const full = await extra.next(m => m.t === 'err');
    expect(full.msg).toMatch(/full/i);
    expect(full.soft).toBeUndefined();
    for (const c of clients) c.close();
    extra.close();
  }, 40000);

  it('starts a full house of humans across the map\'s real cities', async () => {
    const hostTok = tok('h');
    const host = connect('Host', 'ROSTER', hostTok);
    const l0 = await host.next(m => m.t === 'lobby');
    expect(l0.max).toBe(MAX_CLIENTS);                       // the connection cap...
    expect(l0.cityCapacity).toBeGreaterThan(6);             // ...is not the seat cap: the map decides that
    expect(l0.settings.seed).toBe(null);
    expect(Number.isInteger(l0.mapSeed)).toBe(true);

    host.send({ t: 'configure', settings: { mapSize: 'small', factions: [1, 2, 3, 4, 5, 6, 7, 8], seed: 31000 } });
    const lc = await host.next(m => m.t === 'lobby' && m.settings.factions.length === 8);
    expect(lc.mapSeed).toBe(31000);                         // an explicit seed is published verbatim
    expect(lc.cityCapacity).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(lc)).not.toContain(hostTok);      // join tokens never travel back out

    const guests = [];
    for (let i = 2; i <= 8; i++) {
      const g = connect('Guest' + i, 'ROSTER', tok('g' + i), { faction: i });
      guests.push(g);
      await g.next(m => m.t === 'lobby');
    }
    const seated = await host.next(m => m.t === 'lobby' && m.players.length === 8);
    expect(seated.players.map(p => p.faction)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    host.send({ t: 'start' });
    const init = await host.next(m => m.t === 'init');
    expect(init.seed).toBe(31000);
    expect(init.cityCapacity).toBe(lc.cityCapacity);
    expect(init.players.map(p => p.id)).toEqual(init.players.map((_, i) => i + 1));
    expect(init.players.filter(p => p.human).map(p => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(init.players.find(p => p.id === 7)).toMatchObject({ name: 'Guest7', seat: true, bot: false, enabled: true });
    expect(init.players.every(p => typeof p.color === 'string' && p.color.length > 0)).toBe(true);
    expect(init.players.filter(p => !p.enabled).every(p => p.team === 0 && !p.seat && !p.human && !p.bot)).toBe(true);
    expect(JSON.stringify(host.msgs)).not.toContain(hostTok);

    // every seat mirrors: the seventh human is an ordinary roster entry with its own colour, never a
    // lookup miss past a six-colour table
    const view = createViewWorld(init);
    expect(view.players.length).toBe(init.cityCapacity);
    expect(view.players[7]).toMatchObject({ id: 8, enabled: true });
    expect(typeof view.players[7].color).toBe('string');
    expect(view.players[7].color.length).toBeGreaterThan(0);

    for (const g of guests) expect((await g.next(m => m.t === 'init')).cityCapacity).toBe(init.cityCapacity);

    // and the eighth seat really plays: it can raise with its own reserves and gets its own body
    guests[5].send({ t: 'cmd', c: { k: 'raise', type: 'inf', city: -1 } });
    const snap = await guests[5].next(m => m.t === 'snap' && m.divs.some(d => d[1] === 7), 6000);
    const room = server.rooms.get('ROSTER');
    expect(room.world.time).toBeGreaterThan(0);
    expect(room.world.players[6].human).toBe(true);
    applySnapshot(view, snap, 1);
    expect(view.divs.some(d => d.owner === 7)).toBe(true);
    expect(snap.pl[6][3]).toBeGreaterThanOrEqual(0);   // seat 7 sees its own reserves
    host.close();
    for (const g of guests) g.close();
  }, 20000);

  it('reserves seats for bots and refuses to hand them to humans', async () => {
    const a = connect('Host', 'BOTSEAT', tok('a'));
    await a.next(m => m.t === 'lobby');
    a.send({ t: 'configure', settings: { mapSize: 'small', bots: [3, 4], factions: [1, 2, 3, 4, 5], seed: 5151 } });
    const lc = await a.next(m => m.t === 'lobby' && m.settings.bots.length === 2);
    expect(lc.settings.bots).toEqual([3, 4]);
    expect(lc.cityCapacity).toBeGreaterThanOrEqual(5);

    // a reserved seat is not a seat a human can claim, and a seat past the real city count is not a
    // seat at all - both are refused with the reason, not by a silent reshuffle
    const claimer = connect('Claimer', 'BOTSEAT', tok('b'), { faction: 3 });
    expect((await claimer.next(m => m.t === 'err')).msg).toBe('Faction 3 is reserved for a bot');
    const greedy = connect('Greedy', 'BOTSEAT', tok('g'), { faction: 40 });
    expect((await greedy.next(m => m.t === 'err')).msg).toBe('Faction 40 is beyond this map\'s ' + lc.cityCapacity + ' cities');

    // automatic seating walks past the reserved ids
    const auto = connect('Auto', 'BOTSEAT', tok('c'));
    const la = await auto.next(m => m.t === 'lobby' && m.players.length === 2);
    expect(la.players.find(p => p.you).faction).toBe(2);

    a.send({ t: 'start' });
    const init = await a.next(m => m.t === 'init');
    expect(init.players.find(p => p.id === 3)).toMatchObject({ bot: true, human: false, enabled: true });
    expect(init.players.find(p => p.id === 4)).toMatchObject({ bot: true, human: false });
    expect(init.players.find(p => p.id === 5)).toMatchObject({ bot: false, human: false, enabled: true });
    const world = server.rooms.get('BOTSEAT').world;
    expect(world.players[2].bot).toBe(true);
    expect(world.players[2].human).toBe(false);
    expect(world.players[4].enabled).toBe(true);
    a.close(); claimer.close(); greedy.close(); auto.close();
  }, 15000);

  it('keeps a rejected host roster edit inert instead of kicking a seated player', async () => {
    const a = connect('Host', 'ROSTER2', tok('a'));
    const l0 = await a.next(m => m.t === 'lobby');
    const b = connect('Guest', 'ROSTER2', tok('b'), { faction: 4 });
    const lb = await b.next(m => m.t === 'lobby' && m.players.length === 2);
    expect(lb.players.map(p => p.faction)).toEqual([1, 4]);

    // each of these would strip the guest's seat, or even the host's own: a dropped faction, a bot
    // reservation, or both
    for (const [settings, seat] of [
      [{ factions: [1, 2, 3] }, 4], [{ bots: [4] }, 4],
      [{ factions: [1, 4], bots: [4] }, 4], [{ factions: [2, 3, 4] }, 1]
    ]) {
      a.send({ t: 'configure', settings });
      const e = await a.after(m => m.t === 'err');
      expect(e.soft).toBe(true);
      expect(e.msg).toBe('Faction ' + seat + ' is in use');
      await settle(80);
      const now = lastLobby(b);
      expect(now.settings).toEqual(l0.settings);            // the rejected edit changed nothing...
      expect(now.players.map(p => p.faction)).toEqual([1, 4]);
      expect(now.mapSeed).toBe(lb.mapSeed);                 // ...not even the resolved map
    }
    expect(b.ws.readyState).toBe(WebSocket.OPEN);           // and nobody was kicked

    // the nominal map size and the real city count can differ: a map whose layout comes up short
    // cannot seat the nominal maximum, and the host is told so instead of starting a broken game
    let shortSeed = -1;
    for (let s = 0; s < 200 && shortSeed < 0; s++) if (generateCityLayout(s, 100, 64).cities.length < 14) shortSeed = s;
    expect(shortSeed).toBeGreaterThanOrEqual(0);
    expect(generateCityLayout(shortSeed, 100, 64).cities.length).toBeGreaterThanOrEqual(6);
    const capBefore = lastLobby(b).cityCapacity;
    a.send({ t: 'configure', settings: { mapSize: 'small', factions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], seed: shortSeed } });
    const beyond = await a.after(m => m.t === 'err');
    expect(beyond.soft).toBe(true);
    expect(beyond.msg).toMatch(/^Faction 14 is beyond this map's \d+ cities$/);
    await settle(80);
    expect(lastLobby(b).cityCapacity).toBe(capBefore);      // the rejected map/seed pair left no trace
    expect(lastLobby(b).mapSeed).toBe(lb.mapSeed);
    a.close(); b.close();
  }, 15000);

  it('mirrors host-chosen teams and keeps them host-controlled', async () => {
    const a = connect('Host', 'TEAM1', tok('a'));
    await a.next(m => m.t === 'lobby');
    const b = connect('Ally', 'TEAM1', tok('b'), { faction: 2 });
    await b.next(m => m.t === 'lobby' && m.players.length === 2);

    a.send({ t: 'configure', settings: { mapSize: 'small', factions: [1, 2, 3, 4], teams: [1, 1, 2, 2], teamCount: 2, seed: 6161 } });
    const teams = await a.next(m => m.t === 'lobby' && m.settings.teams);
    expect(teams.settings.teams).toEqual([1, 1, 2, 2]);
    expect(teams.settings.teamCount).toBe(2);
    expect(teams.players.map(p => p.team)).toEqual([1, 1]);   // the lobby names each seat's side

    // only the host decides teams, and a team shape that does not fit the seats is refused whole
    b.send({ t: 'configure', settings: { teams: [1, 2, 2, 2] } });
    expect((await b.after(m => m.t === 'err')).msg).toMatch(/host/i);
    for (const settings of [{ teams: [1, 1, 2] }, { teams: [1, 1, 5, 5] }, { teamCount: 1 }, { teams: [2, 2, 2, 2] }]) {
      a.send({ t: 'configure', settings });
      const e = await a.after(m => m.t === 'err');
      expect(e.soft).toBe(true);
      expect(typeof e.msg).toBe('string');
    }
    await settle(80);
    expect(lastLobby(b).settings.teams).toEqual([1, 1, 2, 2]);

    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    expect(initA.players.find(p => p.id === 1)).toMatchObject({ team: 1, human: true });
    expect(initA.players.find(p => p.id === 2)).toMatchObject({ team: 1, human: true });
    expect(initA.players.find(p => p.id === 3)).toMatchObject({ team: 2, human: false, bot: false });
    expect(initA.players.filter(p => !p.enabled).every(p => p.team === 0)).toBe(true);
    const world = server.rooms.get('TEAM1').world;
    expect(world.players.slice(0, 4).map(p => p.team)).toEqual([1, 1, 2, 2]);
    expect(world.players[5].team).toBe(0);

    // a spectator reads the same sides, while its own seat belongs to nobody
    const s = connect('Watcher', 'TEAM1', tok('s'), { role: 'spectator' });
    const initS = await s.next(m => m.t === 'init');
    expect(initS.players.filter(p => p.enabled).map(p => p.team)).toEqual([1, 1, 2, 2]);
    expect(s.msgs.find(m => m.t === 'lobby').players.find(p => p.you)).toMatchObject({ role: 'spectator', faction: 0, team: 0 });

    // a rematch carries the chosen teams back into the lobby
    world.over = true;
    world.result = { winnerId: 1, reason: 'land', pct: 70 };
    await a.next(m => m.t === 'lobby' && m.state === 'ended');
    a.send({ t: 'rematch' });
    const lr = await a.after(m => m.t === 'lobby' && m.state === 'lobby');
    expect(lr.settings.teams).toEqual([1, 1, 2, 2]);
    expect(lr.settings.teamCount).toBe(2);
    expect(lr.players.filter(p => p.role === 'player').map(p => p.team)).toEqual([1, 1]);
    expect(lr.players.filter(p => p.role === 'spectator').map(p => p.team)).toEqual([0]);
    a.close(); b.close(); s.close();
  }, 15000);

  it('shows an ally\'s body and saved home to its team while every route stays private', async () => {
    const a = connect('Host', 'ALLY1', tok('a'));
    await a.next(m => m.t === 'lobby');
    const b = connect('Ally', 'ALLY1', tok('b'), { faction: 2 });
    await b.next(m => m.t === 'lobby' && m.players.length === 2);
    const r = connect('Rival', 'ALLY1', tok('r'), { faction: 3 });
    await r.next(m => m.t === 'lobby' && m.players.length === 3);
    a.send({ t: 'configure', settings: { mapSize: 'small', factions: [1, 2, 3, 4], teams: [1, 1, 2, 2], teamCount: 2, seed: 9090 } });
    await r.next(m => m.t === 'lobby' && m.settings.seed === 9090);
    a.send({ t: 'start' });
    const initA = await a.next(m => m.t === 'init');
    await b.next(m => m.t === 'init');
    await r.next(m => m.t === 'init');
    const world = server.rooms.get('ALLY1').world;
    const view = createViewWorld(initA);
    const W = world.w, H = world.h;

    // Open ground clear of every RIVAL asset: only the team relation can reveal a body there, since
    // a rival's own eyes reach 10 tiles from its divisions and 7 from its cities. The host's and the
    // ally's units are irrelevant - they are not the ones who must stay blind.
    let T = -1;
    for (const clear of [30, 24, 20, 16]) {
      for (let t = 0; t < world.owner.length && T < 0; t++) {
        if (world.terr[t] !== LAND) continue;
        const x = t % W, y = (t / W) | 0;
        if (x < 4 || y < 4 || x > W - 5 || y > H - 5) continue;
        let far = true;
        for (let j = y - 1; j <= y + 1 && far; j++) for (let i = x - 1; i <= x + 1; i++) if (world.terr[j * W + i] === WATER) { far = false; break; }
        if (far) for (const c of world.cities) if (c.owner === 3 && Math.hypot(c.x - x, c.y - y) < clear) { far = false; break; }
        if (far) for (const d of world.divs) if (d.owner === 3 && Math.hypot(d.x - x, d.y - y) < clear) { far = false; break; }
        if (far) T = t;
      }
      if (T >= 0) break;
    }
    expect(T).toBeGreaterThanOrEqual(0);
    const tx = T % W, ty = (T / W) | 0;

    const scout = spawnDiv(world, 2, tx + .5, ty + .5, 80, 80);
    expect(scout).toBeTruthy();
    put(scout, tx + .5, ty + .5);
    const seen = await a.next(m => m.t === 'snap' && m.divs.some(x => x[0] === scout.id), 15000);
    const srow = seen.divs.find(x => x[0] === scout.id);
    expect(srow[7] & F_MOVING).toBe(0);
    expect(srow.length).toBe(8);                       // a still ally carries nothing past its flags
    expect((await r.after(m => m.t === 'snap')).divs.some(x => x[0] === scout.id)).toBe(false);

    // A second ally body shoved aside by its own traffic remembers the ground it left: that exact spot
    // has to reach the team mate, or the two previews would allocate different tiles for one order.
    const hx = tx + 2.9 + .0031, hy = ty + 2.5;
    const holder = spawnDiv(world, 2, hx, hy, 80, 80); put(holder, hx, hy);
    const mover = spawnDiv(world, 2, hx - 1.8, hy, 80, 80); put(mover, hx - 1.8, hy);
    b.send({ t: 'cmd', c: { k: 'move', ids: [mover.id], x: hx + 4.6, y: hy } });
    const anchored = m => {
      const row = m.t === 'snap' && m.divs && m.divs.find(x => x[0] === holder.id);
      return row && row.length === 11 ? row : null;
    };
    const own = await b.next(m => anchored(m) && m.divs.some(x => x[0] === mover.id && x.length === 9), 15000);
    const orow = anchored(own);
    expect(orow[10]).toEqual([hx, hy]);                // the owner still gets its own home

    const hostSnap = await a.next(m => anchored(m), 15000);
    const hrow = anchored(hostSnap);
    expect(hrow[8]).toEqual([]);                       // routes stay private even inside a team...
    expect(hrow[9]).toEqual([]);
    expect(hrow[10]).toEqual([hx, hy]);                // ...while the home is shared exactly
    // shared sight never shares the books: an ally's reserves stay hidden while the map is fogged
    expect(hostSnap.pl[0][3]).toBeGreaterThanOrEqual(0);
    expect(hostSnap.pl[1][3]).toBe(-1);
    applySnapshot(view, hostSnap, 1);
    expect(view.byId.get(holder.id).anchor).toEqual({ x: hx, y: hy });
    const hostMover = hostSnap.divs.find(x => x[0] === mover.id);
    if (hostMover) expect(hostMover.length).toBe(8);   // an ally's moving row never carries its leg

    // a rival standing by the same ground sees the bodies but never a home or a leg
    const foe = spawnDiv(world, 3, hx, hy - 8, 80, 80);
    expect(foe).toBeTruthy();
    put(foe, hx, hy - 8);
    const rSnap = await r.next(m => m.t === 'snap' && m.divs.some(x => x[0] === holder.id), 15000);
    expect(rSnap.divs.find(x => x[0] === holder.id).length).toBe(8);
    for (const m of r.msgs) if (m.t === 'snap') for (const row of m.divs) if (row[1] === 2) expect(row.length).toBe(8);
    a.close(); b.close(); r.close();
  }, 30000);

  it('publishes one resolved map seed per lobby and starts that exact map', async () => {
    const a = connect('Host', 'SEED1', tok('a'));
    const l0 = await a.next(m => m.t === 'lobby');
    expect(l0.settings.seed).toBe(null);
    expect(Number.isInteger(l0.mapSeed)).toBe(true);
    expect(l0.mapSeed).toBeGreaterThanOrEqual(0);
    expect(l0.cityCapacity).toBe(generateCityLayout(l0.mapSeed, l0.settings.w, l0.settings.h).cities.length);

    // an edit that does not move the map keeps the resolved seed and its capacity
    a.send({ t: 'configure', settings: { startingResources: 2 } });
    const l1 = await a.next(m => m.t === 'lobby' && m.settings.startingResources === 2);
    expect(l1.mapSeed).toBe(l0.mapSeed);
    expect(l1.cityCapacity).toBe(l0.cityCapacity);

    // an explicit seed - including 0 - is fixed and published verbatim
    a.send({ t: 'configure', settings: { seed: 0 } });
    const l2 = await a.next(m => m.t === 'lobby' && m.settings.seed === 0);
    expect(l2.mapSeed).toBe(0);
    expect(l2.cityCapacity).toBe(generateCityLayout(0, l2.settings.w, l2.settings.h).cities.length);

    a.send({ t: 'start' });
    const init = await a.next(m => m.t === 'init');
    expect(init.seed).toBe(0);                          // explicit zero survives into the world
    expect(init.cityCapacity).toBe(l2.cityCapacity);     // and the lobby published this map's real capacity
    const room = server.rooms.get('SEED1');
    expect(room.world.cityCapacity).toBe(init.cityCapacity);
    expect(room.world.players.length).toBe(init.cityCapacity);
    expect(room.world.cities.length).toBe(init.cityCapacity);

    // a fresh random map is drawn on rematch, and only when the map actually moves
    room.world.over = true;
    room.world.result = { winnerId: 1, reason: 'land', pct: 80 };
    await a.next(m => m.t === 'lobby' && m.state === 'ended');
    a.send({ t: 'rematch' });
    const l3 = await a.after(m => m.t === 'lobby' && m.state === 'lobby');
    expect(l3.mapSeed).toBe(0);                         // an explicit seed is never re-rolled
    a.send({ t: 'configure', settings: { seed: null } });   // hand the map back to chance...
    const l4 = await a.after(m => m.t === 'lobby' && m.settings.seed === null);
    expect(Number.isInteger(l4.mapSeed)).toBe(true);
    expect(l4.cityCapacity).toBe(generateCityLayout(l4.mapSeed, l4.settings.w, l4.settings.h).cities.length);
    a.send({ t: 'configure', settings: { victoryShare: 0.8 } });
    const l5 = await a.next(m => m.t === 'lobby' && m.settings.victoryShare === 0.8);
    expect(l5.mapSeed).toBe(l4.mapSeed);               // ...and the draw sticks until the map moves
    expect(l5.cityCapacity).toBe(l4.cityCapacity);
    a.close();
  }, 15000);

  it('hands the host role to the next connected client without losing any configuration', async () => {
    const a = connect('Host', 'XFER', tok('a'));
    await a.next(m => m.t === 'lobby');
    a.send({ t: 'configure', settings: { mapSize: 'small', factions: [1, 2, 3], bots: [3], teams: [1, 1, 2], teamCount: 2, seed: 8080 } });
    const cfg = await a.next(m => m.t === 'lobby' && m.settings.bots.length === 1);
    const b = connect('Heir', 'XFER', tok('b'), { faction: 2 });
    await b.next(m => m.t === 'lobby' && m.players.length === 2);

    a.close();                                          // the host walks out of the lobby
    const mine = await b.next(m => m.t === 'lobby' && m.players.find(p => p.you).host);
    expect(mine.settings).toEqual(cfg.settings);         // configuration belongs to the room, not the socket
    expect(mine.mapSeed).toBe(cfg.mapSeed);
    expect(mine.cityCapacity).toBe(cfg.cityCapacity);
    expect(mine.players.map(p => p.faction)).toEqual([2]);   // the departing host's seat is freed, not stolen
    expect(mine.players[0].team).toBe(1);

    b.send({ t: 'configure', settings: { startingResources: 0.5 } });   // the heir really holds authority now
    const edited = await b.next(m => m.t === 'lobby' && m.settings.startingResources === 0.5);
    expect(edited.mapSeed).toBe(cfg.mapSeed);            // and an unrelated edit still keeps the resolved map
    expect(edited.settings.teams).toEqual([1, 1, 2]);

    b.send({ t: 'start' });
    const init = await b.next(m => m.t === 'init');
    expect(init.seed).toBe(8080);
    expect(init.settings.startingResources).toBe(0.5);
    expect(init.players.find(p => p.id === 3)).toMatchObject({ bot: true, enabled: true });   // reservation survived
    b.close();
  }, 15000);

  it('cedes a swath to a real ally over the wire and ignores spectators, non-allies and foreign land', async () => {
    const a = connect('Host', 'CEDE1', tok('a'));
    await a.next(m => m.t === 'lobby');
    a.send({ t: 'configure', settings: { mapSize: 'small', factions: [1, 2, 3, 4], teams: [1, 1, 2, 2], teamCount: 2, seed: 9090 } });
    await a.next(m => m.t === 'lobby' && m.settings.seed === 9090);
    const ally = connect('Ally', 'CEDE1', tok('b'), { faction: 2 });
    await ally.next(m => m.t === 'lobby' && m.players.length === 2);
    const foe = connect('Rival', 'CEDE1', tok('r'), { faction: 3 });
    await foe.next(m => m.t === 'lobby' && m.players.length === 3);
    const spec = connect('Watcher', 'CEDE1', tok('s'), { role: 'spectator' });
    await spec.next(m => m.t === 'lobby');

    a.send({ t: 'start' });
    await a.next(m => m.t === 'init');
    const initB = await ally.next(m => m.t === 'init');
    await foe.next(m => m.t === 'init');
    await spec.next(m => m.t === 'init');
    const world = server.rooms.get('CEDE1').world;
    world.players.forEach(p => { p.nextAI = 1e9; });   // AI off: ownership only moves where a command says so
    const viewB = createViewWorld(initB);
    const W = world.w;

    // a swath of the host's own inland land with no city in it, so the only thing that moves is land
    let base = -1, rect = null;
    for (let i = 0; i < world.owner.length && base < 0; i++) {
      if (world.owner[i] !== 1 || world.cityAt[i] >= 0) continue;
      const x = i % W, y = (i / W) | 0;
      const r = [x, y, Math.min(x + 3, W - 1), Math.min(y + 3, world.h - 1)];
      let count = 0, city = false;
      for (let j = r[1]; j <= r[3]; j++) for (let k = r[0]; k <= r[2]; k++) {
        const t = j * W + k;
        if (world.cityAt[t] >= 0) city = true;
        else if (world.owner[t] === 1) count++;
      }
      if (!city && count >= 4) { base = i; rect = r; }
    }
    expect(base).toBeGreaterThan(-1);
    const before = Array.from(world.owner);
    const expected = [];
    for (let j = rect[1]; j <= rect[3]; j++) for (let k = rect[0]; k <= rect[2]; k++) {
      if (world.owner[j * W + k] === 1) expected.push(j * W + k);
    }
    expect(expected.length).toBeGreaterThanOrEqual(4);
    const t1 = world.players[0].tiles, t2 = world.players[1].tiles;

    const pending = ally.after(m => m.t === 'snap' && Array.isArray(m.ch) && expected.every(i => m.ch.includes(i)));
    a.send({ t: 'cmd', c: { k: 'cede', to: 2, rect: [rect[2], rect[3], rect[0], rect[1]] } });   // dragged backwards on purpose
    const snapB = await pending;

    // authority moved exactly the host's own cells of the rectangle; nothing else budged
    for (const i of expected) expect(world.owner[i]).toBe(2);
    for (let j = rect[1]; j <= rect[3]; j++) for (let k = rect[0]; k <= rect[2]; k++) {
      const t = j * W + k;
      if (before[t] !== 1) expect(world.owner[t]).toBe(before[t]);
    }
    expect(world.players[0].tiles).toBe(t1 - expected.length);
    expect(world.players[1].tiles).toBe(t2 + expected.length);

    // ...and the ally's own mirror, fed only by snapshots, agrees
    applySnapshot(viewB, snapB, 1);
    for (const i of expected) expect(viewB.owner[i]).toBe(2);
    expect(viewB.players[0].tiles).toBe(t1 - expected.length);
    expect(viewB.players[1].tiles).toBe(t2 + expected.length);

    // spectators, non-allied recipients, someone else's land and out-of-bounds rectangles are all inert
    let foeTile = -1;
    for (let i = 0; i < world.owner.length && foeTile < 0; i++) if (world.owner[i] === 3 && world.cityAt[i] < 0) foeTile = i;
    expect(foeTile).toBeGreaterThan(-1);
    const fx = foeTile % W, fy = (foeTile / W) | 0;
    const locked = Array.from(world.owner);
    spec.send({ t: 'cmd', c: { k: 'cede', to: 1, rect: [rect[0], rect[1], rect[2], rect[3]] } });
    a.send({ t: 'cmd', c: { k: 'cede', to: 3, rect: [rect[0], rect[1], rect[2], rect[3]] } });
    a.send({ t: 'cmd', c: { k: 'cede', to: 2, rect: [fx, fy, fx, fy] } });
    a.send({ t: 'cmd', c: { k: 'cede', to: 2, rect: [0, 0, W, world.h] } });
    await settle(200);
    expect(Array.from(world.owner)).toEqual(locked);
    expect(world.players[0].tiles).toBe(t1 - expected.length);
    expect(world.players[1].tiles).toBe(t2 + expected.length);

    a.close(); ally.close(); foe.close(); spec.close();
  }, 20000);
});
