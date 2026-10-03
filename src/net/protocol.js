// Wire protocol shared by server and client. All messages are JSON text frames: { t: <type>, ... }.
//
// client -> server
//   join      { room, name, token, role?, faction? }
//                                     join or create a room (token identifies you for reconnects).
//                                     role 'player'|'spectator' (default 'player'); faction is the
//                                     player's chosen id (0/absent = first enabled free faction).
//                                     A reserved bot seat, an id past the actual city capacity and an
//                                     already taken seat are refused with the reason (and no reshuffle).
//                                     Players can only join a lobby; spectators may also join a
//                                     running/ended game. Unspecified role is a player.
//   configure { settings }            host only, lobby only: replace the game settings (validated).
//                                     settings.factions are the enabled seats (at most the actual
//                                     city capacity of the resolved map), settings.bots the seats
//                                     reserved for AI, settings.teams a parallel team-id array
//                                     (null = FFA) with settings.teamCount configured team slots.
//                                     A seat that a connected player occupies, or that becomes a
//                                     reserved bot seat, rejects the whole edit: nobody is kicked.
//   seat      { role, faction }       lobby only: choose/switch role and faction ({role:'spectator'}
//                                     takes faction 0; occupied, disabled, reserved-bot seats and
//                                     ids beyond the actual city capacity are rejected)
//   start     { settings? }           host only: start the game from the lobby, optionally adjusting
//                                     settings first. The lobby's resolved mapSeed is reused (an
//                                     explicit settings.seed, including 0, is used verbatim; a null
//                                     seed draws one fresh random seed per lobby/rematch) and the
//                                     world is created for that exact layout.
//   cmd       { c: <command> }        a player command, see src/sim/commands.js (spectators: none)
//                                     commands include {k:'route', ids, points, append, column} (1..128
//                                     [x,y] pairs), {k:'road', points} (2..128 [x,y] pairs) and
//                                     {k:'cede', to, rect:[x0,y0,x1,y1]}: give the sender's own tiles in
//                                     that inclusive rectangle (reversed corners fine) to the allied seat
//                                     `to`; the command result carries the authoritative tile count
//   rematch   {}                      host only: return a finished room to the lobby (settings,
//                                     roles, factions, bot reservations and teams are kept; a null
//                                     seed draws one fresh map for the next game)
// server -> client
//   lobby     { room, state:'lobby'|'running'|'ended', max, mapSeed, cityCapacity, settings,
//               players:[{name, you, host, connected, role:'player'|'spectator', faction, team}] }
//               max = MAX_CLIENTS total room connections; the player cap is the actual city
//               capacity of the resolved mapSeed/mapSize layout (1..cityCapacity), never max.
//               mapSeed is the seed the next start will use (an explicit settings.seed verbatim).
//   init      { seed, me, w, h, cityCapacity, settings, time, result,
//               players:[{id,name,color,seat,human,enabled,team,bot}],
//               cities, owner, bld, roads, roadVersion }  full state at game start / reconnect;
//                                     me=0 for spectators; players cover every seat 1..cityCapacity
//                                     (disabled ones inert) with their colour, team id and AI flag.
//                                     roads is a flat list of the map tiles
//                                     (indices) that carry a road, roadVersion its revision counter
//   snap      { time, ch, bch, rch, divs, fights, pl, fog }  10 Hz view of the world, fogged per
//                                     player. ch/bch/rch are flat tile deltas (owner / building / road).
//                                     div rows: [id, owner, type, x, y, men, cap, flags, path?, route?,
//                                     anchor?]; path (thinned current leg), route (remaining multipoint
//                                     checkpoints) and anchor ([x, y], the exact spot a body displaced by
//                                     traffic is walking back to — never rounded) are appended for your
//                                     own divisions only. A visible ally's row carries no path or route,
//                                     but does carry its anchor at [10] (padded with [] so the index
//                                     holds), because allocating around their exact homes has to agree
//                                     with the server; an enemy row always ends at the flags. path and
//                                     route are padded with [] when anchor has to land at index 10, while a
//                                     row without a home keeps its old shape.
//                                     Fog is false for spectators and when settings.fog is off; allies see
//                                     each other's bodies and homes; neither route/path nor an enemy home
//                                     is ever sent to anyone else.
//   ev        { e, d }                game event for this player (city captured, ...)
//   res       { r }                   result of a split/merge (new / absorbed division ids)
//   err       { msg, soft? }          error; soft:true = lobby action rejected, session stays alive

export const TYPE_IDS = ['inf', 'arm', 'art'];

// Division flag bits in snapshots. F_MOVING reports "under way": enemy routes are never sent, so this
// bit is the only way the local prediction tells a body that is moving from one holding its ground.
// It covers an active path, remaining multipoint route checkpoints and a body actively returning to
// the ground it was displaced from. F_ENG/F_OOS are the combat and logistics states. F_ROUTING marks a
// wounded division fleeing from combat, F_ROUT_LOCKED the cornered state that fights instead of
// fleeing again, F_COLUMN the single-file column intention. None of them carry route information, so
// they are safe to send for enemies too.
export const F_ENG = 1, F_OOS = 2, F_MOVING = 4, F_ROUTING = 8, F_ROUT_LOCKED = 16, F_COLUMN = 32;

export const SNAP_EVERY = 2;        // send a snapshot every N sim ticks (2 x 50 ms = 10 Hz)
export const PATH_STRIDE = 4;       // own-division paths are sent as every Nth waypoint (+ the last)

export const MAX_CLIENTS = 64;      // room-wide connection cap: every map's cities plus spectators

export const MAX_NAME = 16;
export const ROOM_RE = /^[A-Za-z0-9]{1,12}$/;

/** Thin a path for the wire: every PATH_STRIDE-th tile, always keeping the final one. */
export function stridePath(path) {
  const out = [];
  for (let i = PATH_STRIDE - 1; i < path.length; i += PATH_STRIDE) out.push(path[i]);
  if (path.length && out[out.length - 1] !== path[path.length - 1]) out.push(path[path.length - 1]);
  return out;
}

export function cleanName(s) {
  s = String(s ?? '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, MAX_NAME);
  return s || 'Player';
}
