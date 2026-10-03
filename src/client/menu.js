import { createSettingsForm } from './settings-form.js';
import { defaultSettings } from '../setup.js';
import { participantName } from '../config.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const OPT_PANELS = [['main', 'mMain'], ['setup', 'mSetup'], ['lobby', 'mLobby']];

/**
 * Main menu, single-player setup panel and multiplayer lobby.
 * handlers: { onSingle(settings, seat, name), onOnline(name, room, spectate),
 *            onConfigure(settings), onSeat(role, faction), onStart(settings), onLeave() }
 * `seat` is {role:'player', faction: seatId} | {role:'spectator', faction: 0}.
 */
export function createMenu(handlers) {
  const nameEl = $('mName'), roomEl = $('mRoom');
  nameEl.value = localStorage.getItem('frontline.name') || '';
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) roomEl.value = urlRoom.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase();

  const name = () => {
    const n = nameEl.value.trim().slice(0, 16);
    localStorage.setItem('frontline.name', n);
    return n || 'Commander';
  };
  const panel = which => {
    for (const [key, id] of OPT_PANELS) $(id).style.display = which === key ? '' : 'none';
    $('mNameRow').style.display = which === 'main' ? '' : 'none';
    $('menu').querySelector('.card').classList.toggle('wide', which !== 'main');   // the roster needs the room
  };
  const setErr = msg => { $('mErr').textContent = msg || ''; };

  // Two instances of the same form: single-player setup, and the shared lobby setup.
  const sp = createSettingsForm($('sOpts'), 's');
  const lp = createSettingsForm($('lOpts'), 'l');
  let last = null;                  // {settings, seat} of the last single-player game, for "New game"
  let lobbyMsg = null, lobbyIsHost = false, lobbySeat = 0, cfgTimer = 0, lobbyKey = '';

  /** Seats held by players: seatId -> {name, you}. */
  function lobbySeats(msg) {
    const seats = new Map();
    for (const p of msg.players) if (p.role !== 'spectator' && p.faction >= 1) seats.set(p.faction, { name: p.name, you: !!p.you });
    return seats;
  }
  const seatLabel = (msg, p) => {
    if (p.role === 'spectator' || !p.faction) return 'Spectator';
    const onTeam = p.team >= 1 && msg.settings && msg.settings.teams;
    return esc(participantName(p.faction)) + (onTeam ? ' · team ' + p.team : '');
  };
  /** Roster list plus the running count of claimed, open and AI-played seats. */
  function lobbyList(msg) {
    const me = msg.players.find(p => p.you);
    $('lList').innerHTML = msg.players.map(p =>
      '<li class="' + (p.connected ? '' : 'off') + (p.you ? ' me' : '') + '">' + esc(p.name) +
      (p.you ? ' <small>(you)</small>' : '') + (p.host ? ' <small class="host">host</small>' : '') +
      '<span class="seat">' + seatLabel(msg, p) + '</span></li>').join('');
    const s = msg.settings || {};
    const active = (s.factions || []).length;
    const humans = msg.players.filter(p => p.role !== 'spectator' && p.faction >= 1).length;
    const bots = (s.bots || []).filter(id => (s.factions || []).includes(id)).length;
    const open = Math.max(0, active - humans - bots);
    const ai = Math.max(0, active - humans);
    $('lHint').textContent = (lobbyIsHost ? 'Press Start when everyone is in. ' : 'Waiting for the host to start. ') +
      humans + ' of ' + active + ' seats claimed · ' + open + ' open · ' + bots + ' reserved bot' + (bots === 1 ? '' : 's') +
      ' · ' + ai + ' AI at start (' + bots + ' reserved + ' + open + ' unclaimed), on a map with ' +
      (msg.cityCapacity || active) + ' cities. ' +
      'Unclaimed open seats are played by an AI. ' +
      (me && me.role === 'spectator' ? 'You are spectating this match.' : '');
  }
  /** Comparable fingerprint of a settings object, so a lobby echo can be told from a real edit. */
  const cfgKey = s => JSON.stringify([
    s.mapSize, Number(s.startingResources), Number(s.incomeMultiplier), Number(s.victoryShare), !!s.fog,
    s.aiDifficulty,
    s.seed === null || s.seed === undefined || s.seed === '' ? null : Number(s.seed),
    (s.factions || []).map(Number).sort((a, b) => a - b),
    (s.bots || []).map(Number).sort((a, b) => a - b),
    Array.isArray(s.teams) ? s.teams.map(Number) : null,
    s.teams ? Number(s.teamCount) : 2
  ]);
  /** Fingerprint of a whole lobby message: the resolved seed and capacity belong to the rules too. */
  const lobbyFp = msg => cfgKey(msg.settings || {}) + '|' + (msg.mapSeed === undefined ? '' : msg.mapSeed) +
    '|' + (msg.cityCapacity === undefined ? '' : msg.cityCapacity);
  const pushConfigure = () => {
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => {
      cfgTimer = 0;
      if (!lobbyIsHost || !lobbyMsg) return;
      const s = lp.read();
      if (Number.isNaN(s.seed)) return;      // a half-typed seed: the form itself warns, nothing is sent
      handlers.onConfigure(s);
    }, 250);
  };
  const pushSeat = () => {
    const s = lp.seat();
    lobbySeat = s.faction;
    handlers.onSeat(s.role, s.faction);
  };

  sp.onChange(() => setErr(''));
  lp.onChange(() => { setErr(''); pushConfigure(); });
  lp.onSeatChange(() => { setErr(''); pushSeat(); });

  $('mSingle').onclick = () => { setErr(''); showSetup(); };
  const go = spectate => {
    setErr('');
    $('mOnline').disabled = true; $('mWatch').disabled = true;
    handlers.onOnline(name(), roomEl.value.trim(), !!spectate);
  };
  $('mOnline').onclick = () => go(false);
  $('mWatch').onclick = () => go(true);
  roomEl.addEventListener('keydown', e => { if (e.key === 'Enter') go(false); });
  roomEl.addEventListener('input', () => { roomEl.value = roomEl.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); });
  $('mPlay').onclick = () => {
    // The previewed seed is the seed of the game that starts: what the form shows is what runs.
    const settings = { ...sp.read(), seed: sp.mapSeed() }, seat = sp.seat();
    setErr('');
    try { handlers.onSingle(settings, seat, name()); }
    catch (err) { showSetupError(err && err.message ? err.message : String(err), settings, seat.faction); }
  };
  $('mBack').onclick = () => { setErr(''); showMain(); };
  $('lStart').onclick = () => handlers.onStart(lp.read());
  $('lLeave').onclick = () => handlers.onLeave();
  $('lCopy').onclick = () => {
    const url = location.origin + location.pathname + '?room=' + encodeURIComponent($('lCode').textContent);
    const done = () => { $('lCopy').textContent = 'Copied!'; setTimeout(() => { $('lCopy').textContent = 'Copy invite link'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('Invite link', url));
    else prompt('Invite link', url);
  };

  function showMain(err) {
    $('menu').style.display = 'flex';
    $('mOnline').disabled = false;
    $('mWatch').disabled = false;
    panel('main'); setErr(err);
  }
  /** Single-player setup, pre-filled with the last local choices (or the given ones after a rejection). */
  function showSetup(settings, seat) {
    $('menu').style.display = 'flex';
    panel('setup'); setErr('');
    const base = settings || (last && last.settings) || defaultSettings();
    // `seedIntent` keeps a fixed seed and rolls a new random map for a seed the player left to chance.
    const intent = sp.seedIntent();
    sp.render(base, {
      editable: true, seats: null, freshSeed: true, seedIntent: intent,
      seat: seat !== undefined ? seat : (last ? last.seat : 1)
    });
  }
  function showSetupError(msg, settings, seat) {
    $('menu').style.display = 'flex';
    panel('setup');
    sp.render(settings || sp.read(), { editable: true, seats: null, seat, seedIntent: sp.seedIntent() });
    setErr(msg);
  }
  function showLobby(msg) {
    lobbyMsg = msg;
    lobbyKey = lobbyFp(msg);
    const me = msg.players.find(p => p.you);
    lobbyIsHost = !!(me && me.host);
    lobbySeat = me && me.role !== 'spectator' && me.faction >= 1 ? me.faction : 0;
    $('menu').style.display = 'flex';
    panel('lobby'); setErr('');
    $('lCode').textContent = msg.room;
    lp.render(msg.settings || defaultSettings(), {
      editable: lobbyIsHost, seatEditable: true, seats: lobbySeats(msg), seat: lobbySeat,
      mapSeed: msg.mapSeed, cityCapacity: msg.cityCapacity
    });
    $('lStart').style.display = lobbyIsHost ? '' : 'none';
    lobbyList(msg);
  }
  /**
   * Non-fatal lobby rejection (occupied seat, reserved bot seat, another host, running game): show it
   * and put the form back on the server's copy so a rejected edit cannot linger.
   */
  function showLobbyError(msg) {
    if (!lobbyMsg || $('mLobby').style.display === 'none') { setErr(msg); return; }
    lp.focusOut();
    lp.render(lobbyMsg.settings || defaultSettings(), {
      editable: lobbyIsHost, seatEditable: true, seats: lobbySeats(lobbyMsg), seat: lobbySeat,
      mapSeed: lobbyMsg.mapSeed, cityCapacity: lobbyMsg.cityCapacity
    });
    setErr(msg);
  }

  return {
    showMain, showSetup, showSetupError, showLobby, showLobbyError,
    /** Remember the local choices of a game that just started, so "New game" offers them again. */
    remember(settings, seat) { last = { settings, seat }; },
    /** Lobby messages that only carry seats: refresh the list without touching the edited form. */
    updateLobby(msg) {
      lobbyMsg = msg;
      const me = msg.players.find(p => p.you);
      const hostChanged = lobbyIsHost !== !!(me && me.host);
      lobbyIsHost = !!(me && me.host);
      if (hostChanged && cfgTimer) { clearTimeout(cfgTimer); cfgTimer = 0; }
      lobbySeat = me && me.role !== 'spectator' && me.faction >= 1 ? me.faction : 0;
      $('lStart').style.display = lobbyIsHost ? '' : 'none';
      const seats = lobbySeats(msg);
      const fp = lobbyFp(msg);
      const pending = cfgTimer !== 0;      // our own edit has not reached the server yet
      // The host may have edited the shared setup (rules, seed or the map's capacity): mirror it,
      // unless our own edit is still in flight — then the form is newer than the server and a
      // re-render would silently undo what is being typed right now.
      if (hostChanged || (fp !== lobbyKey && !pending)) {
        lp.render(msg.settings || defaultSettings(), {
          editable: lobbyIsHost, seatEditable: true, seats, seat: lobbySeat,
          mapSeed: msg.mapSeed, cityCapacity: msg.cityCapacity
        });
      } else {
        lp.updateSeats(seats, lobbySeat);
      }
      lobbyKey = fp;
      lobbyList(msg);
    },
    hide() { $('menu').style.display = 'none'; },
    get visible() { return $('menu').style.display !== 'none'; }
  };
}
