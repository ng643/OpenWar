import { STEP } from '../src/config.js';
import { createWorld, subscribe } from '../src/sim/world.js';
import { generateCityLayout } from '../src/sim/city-layout.js';
import { tick } from '../src/sim/game.js';
import { applyCommand } from '../src/sim/commands.js';
import { SNAP_EVERY, MAX_CLIENTS, cleanName } from '../src/net/protocol.js';
import { normalizeSettings } from '../src/setup.js';
import { buildInit, buildSnapshot } from './snapshot.js';

const RECONNECT_GRACE = 20;      // s before the AI takes over a disconnected seat
const EMPTY_TIMEOUT = 60;        // s a running game survives with nobody connected
const CMD_RATE = 10;             // sustained commands/s per client (pathfinding is the expensive part)
const CMD_BURST = 25;

/** A fresh lobby seed. settings.seed stays null; the resolved seed lives in `mapSeed` alone. */
function randomSeed() { return (Math.random() * 2147483648) | 0; }

/** The actual number of cities the given seed/map generates — the real bound on participants. */
function cityCapacityOf(seed, settings) { return generateCityLayout(seed, settings.w, settings.h).cities.length; }

/**
 * One room = one lobby that becomes one authoritative game. The server owns the only real world;
 * clients send commands and receive fogged snapshots.
 * States: 'lobby' -> 'running' -> 'ended' -> (rematch) 'lobby'
 *
 * Lobby clients are either players (one enabled seat each, `slot` = that id once running) or
 * spectators (`slot` 0). Seats are 1..cityCapacity of the actual resolved map; settings.factions
 * enables them, settings.bots reserves some of them for AI. The host alone edits settings, seats
 * never change hands implicitly, and the lobby's resolved mapSeed is exactly the seed the next
 * start uses. Spectators may host, start an all-AI game, join a running room and always see the
 * full map; they can never take a faction mid-game or issue commands.
 */
export class Room {
  constructor(code) {
    this.code = code;
    this.state = 'lobby';
    this.clients = new Map();      // token -> { token, name, ws, connected, role, faction, slot, bucket, bucketAt }
    this.hostToken = null;
    this.settings = normalizeSettings();   // canonical; kept across rematch, editable by the host in the lobby
    this.mapSeed = this.settings.seed !== null ? this.settings.seed : randomSeed();   // resolved for the next start
    this.cityCapacity = cityCapacityOf(this.mapSeed, this.settings);                  // actual cities, the real seat bound
    this.world = null;
    this.accum = 0;
    this.tickN = 0;
    this.emptyFor = 0;
  }

  // ---------- connections ----------
  /**
   * Join or reconnect. `role` is 'player' | 'spectator' (undefined = player); `faction` is the
   * chosen player id (0/undefined = first enabled free one). Returns an error string, or null.
   */
  join(ws, name, token, role, faction) {
    let c = this.clients.get(token);
    if (c) {                                   // reconnect (or a second tab with the same token): role/faction untouched
      if (c.ws && c.ws !== ws) { try { c.ws.close(4000, 'replaced'); } catch { /* already closed */ } }
      c.ws = ws; c.connected = true;
      if (this.state === 'running' && c.slot) this.world.players[c.slot - 1].human = true;
      this.emptyFor = 0;
      ws.client = c;
      ws.room = this;
      this.sendLobby();
      if (this.state !== 'lobby') this.sendInit(c);
      return null;
    }
    if (role !== undefined && role !== 'player' && role !== 'spectator') return 'Bad role';
    if (this.state !== 'lobby' && role !== 'spectator') return 'Game already in progress';
    if (this.clients.size >= MAX_CLIENTS) return 'Room is full';
    let fac = 0;
    if (this.state === 'lobby' && role !== 'spectator') {
      const pick = this.pickFaction(faction, null);
      if (pick.err) return pick.err;
      fac = pick.faction;
    }
    c = {
      token, name: cleanName(name), ws, connected: true,
      role: role === 'spectator' ? 'spectator' : 'player', faction: fac, slot: 0,
      bucket: CMD_BURST, bucketAt: Date.now()
    };
    this.clients.set(token, c);
    if (!this.hostToken) this.hostToken = token;
    this.emptyFor = 0;
    ws.client = c;
    ws.room = this;
    this.sendLobby();
    if (this.state !== 'lobby') this.sendInit(c);
    return null;
  }

  leave(ws) {
    const c = ws.client;
    if (!c || c.ws !== ws) return;            // stale socket, the client already reconnected elsewhere
    c.connected = false; c.ws = null;
    if (this.state === 'lobby') {
      this.clients.delete(c.token);
      if (this.hostToken === c.token) this.hostToken = this.clients.keys().next().value || null;
    } else if (this.state === 'running' && c.slot) {
      const p = this.world.players[c.slot - 1];
      p.human = false;                         // AI plays the seat...
      p.nextAI = Math.max(p.nextAI, this.world.time + RECONNECT_GRACE);   // ...after a grace period
    } else if (this.state === 'ended' && this.hostToken === c.token) {
      this.hostToken = [...this.clients.values()].find(x => x.connected)?.token || this.hostToken;
    }
    this.sendLobby();
  }

  connectedCount() {
    let n = 0;
    for (const c of this.clients.values()) if (c.connected) n++;
    return n;
  }

  /** True when the room can be discarded. */
  isDead() {
    if (this.state === 'lobby') return this.clients.size === 0;
    return this.emptyFor > EMPTY_TIMEOUT;
  }

  // ---------- lobby seats and settings ----------
  /**
   * Resolve a seat choice to an actual id. `self` is the client making the choice (excluded from
   * the occupancy check, so it can re-pick its own seat). Returns { faction } or { err }.
   * A seat must be enabled, inside the actual city capacity, not reserved for a bot and not taken.
   */
  pickFaction(requested, self) {
    const taken = id => [...this.clients.values()].some(x => x !== self && x.role === 'player' && x.faction === id);
    if (requested === undefined || requested === null || requested === 0) {
      const free = this.settings.factions.find(id => !taken(id) && !this.settings.bots.includes(id));
      return free ? { faction: free } : { err: 'No free seat - join as a spectator' };
    }
    if (!Number.isInteger(requested) || requested < 1) return { err: 'Bad faction' };
    if (requested > this.cityCapacity) return { err: 'Faction ' + requested + ' is beyond this map\'s ' + this.cityCapacity + ' cities' };
    if (!this.settings.factions.includes(requested)) return { err: 'Faction ' + requested + ' is not in this game' };
    if (this.settings.bots.includes(requested)) return { err: 'Faction ' + requested + ' is reserved for a bot' };
    if (taken(requested)) return { err: 'Faction ' + requested + ' is already taken' };
    return { faction: requested };
  }

  /** Host-only settings edit; rejected unless valid and compatible with the seats already taken. */
  configure(c, msg) {
    if (c.token !== this.hostToken) return this.softErr(c, 'Only the host can change settings');
    if (this.state !== 'lobby') return this.softErr(c, 'Settings can only change in the lobby');
    let next;
    try { next = normalizeSettings(merge(this.settings, msg.settings)); }
    catch (e) { return this.softErr(c, e.message); }
    // A map-size or seed edit resolves the next layout now: an explicit seed verbatim, a fresh
    // random one otherwise. Nothing is committed until every check below passes, so a rejected
    // edit leaves the previous settings, mapSeed and capacity untouched.
    const remap = next.mapSize !== this.settings.mapSize || next.seed !== this.settings.seed;
    const seed = next.seed !== null ? next.seed : (remap ? randomSeed() : this.mapSeed);
    const capacity = cityCapacityOf(seed, next);
    const beyond = next.factions.find(id => id > capacity);
    if (beyond !== undefined) return this.softErr(c, 'Faction ' + beyond + ' is beyond this map\'s ' + capacity + ' cities');
    for (const x of this.clients.values()) {
      if (x.role !== 'player') continue;
      // Occupied seats stay occupied: the edit must both keep every taken faction enabled and leave
      // it a human seat, so a host can never kick somebody by disabling or bot-reserving their seat.
      if (!next.factions.includes(x.faction) || next.bots.includes(x.faction)) {
        return this.softErr(c, 'Faction ' + x.faction + ' is in use');
      }
    }
    this.settings = next;
    this.mapSeed = seed;
    this.cityCapacity = capacity;
    this.sendLobby();
  }

  /** Choose or switch role/faction while in the lobby. Players can never take an occupied id. */
  setSeat(c, msg) {
    if (this.state !== 'lobby') return this.softErr(c, 'Seats can only change in the lobby');
    if (msg.role !== undefined && msg.role !== 'player' && msg.role !== 'spectator') return this.softErr(c, 'Bad role');
    if (msg.role !== 'spectator') {
      const pick = this.pickFaction(msg.faction, c);
      if (pick.err) return this.softErr(c, pick.err);
      c.role = 'player';
      c.faction = pick.faction;
    } else {
      c.role = 'spectator';
      c.faction = 0;
    }
    this.sendLobby();
  }

  // ---------- messages ----------
  onMessage(ws, msg) {
    const c = ws.client;
    if (!c) return;
    switch (msg.t) {
      case 'configure': return this.configure(c, msg);
      case 'seat': return this.setSeat(c, msg);
      case 'start': return this.start(c, msg);
      case 'rematch': return this.rematch(c);
      case 'cmd': return this.command(c, msg.c);
    }
  }

  command(c, cmd) {
    if (this.state !== 'running' || !c.slot) return;    // spectators and the lobby are commandless
    const now = Date.now();
    c.bucket = Math.min(CMD_BURST, c.bucket + (now - c.bucketAt) / 1000 * CMD_RATE);
    c.bucketAt = now;
    if (c.bucket < 1) return;                  // flooding: drop
    c.bucket -= 1;
    const r = applyCommand(this.world, c.slot, cmd);
    if ((r.ok && (r.k === 'split' || r.k === 'merge')) || r.k === 'cede') this.send(c, { t: 'res', r });
  }

  /** Host starts the game: every connected player takes the seat it picked, disabled seats stay
   *  neutral, bot-reserved seats are AI from the first tick. A spectator may host an all-AI game. */
  start(c, msg) {
    if (this.state !== 'lobby') return;
    if (c.token !== this.hostToken) return this.softErr(c, 'Only the host can start the game');
    let settings;
    try { settings = normalizeSettings(merge(this.settings, msg && msg.settings)); }
    catch (e) { return this.softErr(c, e.message); }
    // The seed that was resolved for this lobby is the seed that starts, unless this patch itself
    // moves the map or the seed. Explicit seeds (including 0) are used verbatim; a null seed on a
    // fresh map draws one new random seed per lobby, not per request.
    const remap = settings.mapSize !== this.settings.mapSize || settings.seed !== this.settings.seed;
    const seed = settings.seed !== null ? settings.seed : (remap ? randomSeed() : this.mapSeed);
    const capacity = cityCapacityOf(seed, settings);
    const beyond = settings.factions.find(id => id > capacity);
    if (beyond !== undefined) return this.softErr(c, 'Faction ' + beyond + ' is beyond this map\'s ' + capacity + ' cities');
    const seats = [...this.clients.values()].filter(x => x.connected && x.role === 'player');
    for (const x of seats) {
      if (!settings.factions.includes(x.faction)) return this.softErr(c, 'Faction ' + x.faction + ' is not in this game');
      if (settings.bots.includes(x.faction)) return this.softErr(c, 'Faction ' + x.faction + ' is reserved for a bot');
    }
    let world;
    try {
      world = createWorld(seed, { settings, humans: seats.map(x => x.name), humanIds: seats.map(x => x.faction) });
    } catch (e) { return this.softErr(c, e.message); }
    for (const [token, x] of this.clients) if (!x.connected) this.clients.delete(token);
    this.settings = settings;
    this.mapSeed = seed;
    this.cityCapacity = capacity;
    this.world = world;
    world.changes = [];
    world.bchanges = [];
    world.rchanges = [];
    seats.forEach(x => { x.slot = x.faction; });
    subscribe(world, (type, data) => this.route(type, data));
    this.state = 'running'; this.accum = 0; this.tickN = 0;
    for (const x of this.clients.values()) if (x.connected) this.sendInit(x);
    this.sendLobby();
  }

  /** Back to the lobby with every seat, faction, team, bot reservation and setting intact.
   *  A new random map is resolved here (explicit seeds stay), never on a field render. */
  rematch(c) {
    if (this.state !== 'ended' || c.token !== this.hostToken) return;
    this.state = 'lobby'; this.world = null;
    if (this.settings.seed === null) this.mapSeed = randomSeed();
    this.cityCapacity = cityCapacityOf(this.mapSeed, this.settings);
    for (const [token, x] of this.clients) { x.slot = 0; if (!x.connected) this.clients.delete(token); }
    this.sendLobby();
  }

  // ---------- simulation ----------
  advance(dt) {
    if (this.state === 'running' || this.state === 'ended') {
      this.emptyFor = this.connectedCount() ? 0 : this.emptyFor + dt;
    }
    if (this.state !== 'running') return;
    if (!this.connectedCount()) {              // nobody watching: freeze rather than burn CPU on an AI-only game
      return;
    }
    this.accum = Math.min(this.accum + dt, STEP * 6);
    while (this.accum >= STEP && !this.world.over) {
      this.accum -= STEP;
      tick(this.world, STEP);
      if (++this.tickN % SNAP_EVERY === 0) this.broadcastSnapshots();
    }
    if (this.world.over) {
      this.broadcastSnapshots();
      this.state = 'ended';
      this.sendLobby();
    }
  }

  broadcastSnapshots() {
    const changes = this.world.changes, bchanges = this.world.bchanges, rchanges = this.world.rchanges || [];
    this.world.changes = [];
    this.world.bchanges = [];
    this.world.rchanges = [];       // an empty array, not null: setRoad only logs deltas when rchanges exists
    for (const c of this.clients.values()) {
      if (c.connected) this.send(c, buildSnapshot(this.world, c.slot, changes, bchanges, rchanges));
    }
  }

  /** Forward sim events to the players who should hear about them. */
  route(type, data) {
    const w = this.world;
    const to = (pid, e, d) => {
      const c = this.bySlot(pid);
      if (c) this.send(c, { t: 'ev', e, d });
    };
    switch (type) {
      case 'cityCaptured': {
        const city = w.cities.indexOf(data.city);
        for (const pid of new Set([data.by, data.from])) if (pid) to(pid, type, { city, by: data.by, from: data.from });
        break;
      }
      case 'divisionDestroyed': to(data.div.owner, type, { owner: data.div.owner }); break;
      case 'raiseFailed': to(data.player.id, type, { reason: data.reason, need: data.need }); break;
      case 'buildFailed': to(data.player.id, type, { reason: data.reason, need: data.need }); break;
      case 'buildingLost': to(data.owner, type, { type: data.type }); break;
      case 'landCeded': to(data.from, type, data); to(data.to, type, data); break;
      case 'playerEliminated': this.broadcast({ t: 'ev', e: type, d: { player: data.player.id } }); break;
      case 'gameOver': this.broadcast({ t: 'ev', e: type, d: data }); break;
    }
  }

  // ---------- sending ----------
  bySlot(pid) {
    for (const c of this.clients.values()) if (c.slot === pid) return c;
    return null;
  }

  softErr(c, msg) {
    this.send(c, { t: 'err', msg, soft: true });
  }

  send(c, msg) {
    if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.ws && c.ws.readyState === 1) c.ws.send(s);
  }

  sendInit(c) {
    this.send(c, buildInit(this.world, c.slot));
  }

  sendLobby() {
    for (const c of this.clients.values()) {
      this.send(c, {
        t: 'lobby', room: this.code, state: this.state, max: MAX_CLIENTS, settings: this.settings,
        mapSeed: this.mapSeed, cityCapacity: this.cityCapacity,
        players: [...this.clients.values()].map(x => ({
          name: x.name, host: x.token === this.hostToken, connected: x.connected, you: x === c,
          role: x.role, faction: x.role === 'player' ? x.faction : 0, team: x.role === 'player' ? teamOf(this.settings, x.faction) : 0
        }))
      });
    }
  }
}

/** The team a seat plays for: its faction id under FFA, the parallel array's team id with teams. */
function teamOf(settings, faction) {
  if (!settings.teams) return faction;
  const i = settings.factions.indexOf(faction);
  return i < 0 ? 0 : settings.teams[i];
}

/** Merge a settings patch over the current canonical settings; validates the patch shape. */
function merge(current, patch) {
  if (patch === undefined) return { ...current };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid game settings');
  return { ...current, ...patch };
}
