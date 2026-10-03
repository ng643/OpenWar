import { STEP } from '../config.js';
import { SNAP_EVERY } from '../net/protocol.js';
import { createWorld, subscribe } from '../sim/world.js';
import { tick } from '../sim/game.js';
import { applyCommand } from '../sim/commands.js';
import { updateVisibility } from '../sim/vision.js';
import { pruneSelection, resolvePending } from './ui-state.js';
import { createViewWorld, applySnapshot } from './net-world.js';

const SNAP_MS = SNAP_EVERY * STEP * 1000;

/**
 * A session owns the world for the current game and is what the UI talks to:
 *   kind                 'local' | 'net'
 *   send(cmd)            issue a player command (src/sim/commands.js)
 *   update(dt, now)      called every frame: advance the sim / interpolate
 *   again()              end-screen primary button (back to setup / host rematch)
 *   destroy()
 * `host` is main.js, which reacts to session events (see the on* callbacks used below).
 */

// ---------------------------------------------------------------- single player
export function createLocalSession(app, host, { settings, side = 1, name = 'You' } = {}) {
  const ui = app.ui;
  let accum = 0;

  const spectator = !(side > 0);
  // Seed null means a fresh random map on every start; an explicit seed (0 included) is reused as-is.
  const seed = settings.seed === null || settings.seed === undefined ? (Math.random() * 0x7fffffff) | 0 : settings.seed;
  const world = createWorld(seed, {
    settings,
    humans: spectator ? [] : [name],
    humanIds: spectator ? undefined : [side]
  });
  app.me = spectator ? 0 : side;
  subscribe(world, host.onEvent);
  host.onGameStart(world, { resume: false, kind: 'local' });

  return {
    kind: 'local',
    send(cmd) { if (app.me > 0) host.onResult(applyCommand(world, app.me, cmd)); },
    update(dt) {
      if (!ui.paused && !world.over) {
        accum += dt * ui.speed;
        let n = 0;
        while (accum >= STEP && n++ < 40) { tick(world, STEP); accum -= STEP; }
        if (n >= 40) accum = 0;                 // can't keep up: drop the backlog
        pruneSelection(ui, world);
      }
      app.alpha = ui.paused || world.over ? 1 : Math.min(1, accum / STEP);
      updateVisibility(world, app.me, ui.fog && !world.over);
    },
    again() { host.toSetup(); },               // end screen: back to the setup panel, choices kept
    destroy() { /* nothing to release */ }
  };
}

// ---------------------------------------------------------------- multiplayer
function getToken() {
  // sessionStorage: one identity per browser tab, so two tabs can play against each other
  let t = sessionStorage.getItem('frontline.token');
  if (!t) {
    t = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now().toString(36));
    sessionStorage.setItem('frontline.token', t);
  }
  return t;
}

export function serverUrl() {
  const o = new URLSearchParams(location.search).get('server');
  if (o) return o;
  const configured = import.meta.env && import.meta.env.VITE_SERVER_URL;
  if (configured) return configured;
  const secure = location.protocol === 'https:';
  if (import.meta.env && import.meta.env.DEV) return (secure ? 'wss://' : 'ws://') + location.hostname + ':8080/ws';
  return (secure ? 'wss://' : 'ws://') + location.host + '/ws';
}

export function createNetSession(app, host, { name, room, role = 'player', faction = 0 } = {}) {
  const ui = app.ui;
  const token = getToken();
  const wanted = (r, f) => ({ role: r === 'spectator' ? 'spectator' : 'player', faction: r === 'spectator' ? 0 : Math.max(0, f | 0) });
  let seat = wanted(role, faction);           // what we ask for on join; the server's answer is authoritative
  let ws = null, closed = false, everJoined = false, attempts = 0, retryTimer = 0;
  let roomCode = room || '';
  let lastSnap = performance.now();
  let inGame = false;

  const raw = msg => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function connect() {
    ws = new WebSocket(serverUrl());
    ws.onopen = () => { raw({ t: 'join', room: roomCode, name, token, role: seat.role, faction: seat.faction }); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
    ws.onclose = ev => {
      if (closed) return;
      if (ev.code === 4000) return fail('This game was opened in another tab');
      if (!everJoined || attempts >= 10) return fail(everJoined ? 'Lost connection to the server' : 'Could not reach the game server');
      attempts++;
      host.onConnection('Connection lost - reconnecting (' + attempts + ')...');
      retryTimer = setTimeout(connect, Math.min(4000, 500 * attempts));
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  function fail(msg) {
    if (closed) return;
    closed = true;
    host.onConnection(null);
    host.onNetError(msg);
  }

  function handle(m) {
    switch (m.t) {
      case 'lobby': {
        everJoined = true; attempts = 0; roomCode = m.room;
        const mine = m.players.find(p => p.you);
        if (mine) seat = wanted(mine.role, mine.faction);
        // Lets a page reload rejoin with the same seat (the server drops lobby clients on disconnect).
        sessionStorage.setItem('frontline.resume', JSON.stringify({ room: m.room, name, role: seat.role, faction: seat.faction }));
        host.onConnection(null);
        app.lobby = m;
        if (m.state === 'lobby' && inGame) { inGame = false; host.onGameEnd(); }   // rematch, or the server restarted
        host.onLobby(m);
        break;
      }
      case 'init': {
        const world = createViewWorld(m);
        app.me = m.me;
        const resume = inGame;
        inGame = true;
        host.onGameStart(world, { resume, kind: 'net' });
        break;
      }
      case 'snap':
        if (!app.world || !inGame) break;
        applySnapshot(app.world, m, app.alpha);
        lastSnap = performance.now();
        ui.fog = m.fog;
        pruneSelection(ui, app.world);
        resolvePending(ui, app.world);
        break;
      case 'ev': {
        const w = app.world;
        if (!w) break;
        const d = m.d;
        if (m.e === 'cityCaptured') host.onEvent('cityCaptured', { city: w.cities[d.city], by: d.by, from: d.from });
        else if (m.e === 'divisionDestroyed') host.onEvent('divisionDestroyed', { div: { owner: d.owner } });
        else if (m.e === 'raiseFailed') host.onEvent('raiseFailed', { player: w.players[app.me - 1], reason: d.reason, need: d.need });
        else if (m.e === 'buildFailed') host.onEvent('buildFailed', { player: w.players[app.me - 1], reason: d.reason, need: d.need });
        else if (m.e === 'buildingLost') host.onEvent('buildingLost', { owner: app.me, type: d.type });
        else if (m.e === 'landCeded') host.onEvent('landCeded', d);
        else if (m.e === 'playerEliminated') { const p = w.players[d.player - 1]; p.alive = false; host.onEvent('playerEliminated', { player: p }); }
        else if (m.e === 'gameOver') { w.over = true; w.result = d; host.onEvent('gameOver', d); }
        break;
      }
      case 'res': host.onResult(m.r); break;
      // soft errors (lobby actions) stay non-fatal: keep the connection, show the message in the lobby
      case 'err':
        if (m.soft) { host.onSoftError(m.msg); break; }
        fail(m.msg); try { ws.close(); } catch { /* ignore */ } break;
    }
  }

  connect();

  return {
    kind: 'net',
    send(cmd) { raw({ t: 'cmd', c: cmd }); },
    update(dt, now) { app.alpha = Math.min(1, (now - lastSnap) / SNAP_MS); },
    /** Host only: change the shared game setup (server validates and broadcasts a new lobby). */
    configure(settings) { raw({ t: 'configure', settings }); },
    /** Pick this client's own seat: a free enabled faction, or spectator. */
    setSeat(role, faction) { seat = wanted(role, faction); raw({ t: 'seat', role: seat.role, faction: seat.faction }); },
    start(settings) { raw(settings ? { t: 'start', settings } : { t: 'start' }); },
    again() { raw({ t: 'rematch' }); },
    destroy() {
      closed = true; clearTimeout(retryTimer);
      host.onConnection(null);
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
    }
  };
}
