import { MAP_SIZES, AI_DIFFICULTIES, MIN_VICTORY_SHARE, MAX_VICTORY_SHARE, maxCityCapacity } from '../setup.js';
import { participantName, participantColor, WIN_SHARE } from '../config.js';
import { generateCityLayout } from '../sim/city-layout.js';

/**
 * Shared match setup: rules (map, modifiers, teams) plus the seat roster, used both by the
 * single-player setup panel and by the multiplayer lobby (the host edits, guests get a read-only
 * copy of the rules but still pick their own seat).
 *
 * The roster is the list of city seats for the *previewed* map: the map size and the seed alone
 * decide how many cities a layout has, and that number of cities is what bounds the participants —
 * so the row list, the counts and the "your seat" picker are all driven by the same computed
 * capacity. A seed left blank shows the exact random seed a start would use (the preview), and a
 * start reuses it, so what the form promises is what the match gets.
 *
 * `seats` is a Map(seatId -> {name, you}) of seats other players already hold in a lobby, or null
 * for a local game. Values read back out are raw; the caller runs them through normalizeSettings()
 * (src/setup.js) so one validation serves every path.
 */
const FACTORS = [[0.5, 'Low (×0.5)'], [1, 'Normal (×1)'], [2, 'High (×2)']];
// The victory target is a whole-percent slider between the shared bounds.
const WIN_MIN = Math.round(MIN_VICTORY_SHARE * 100);
const WIN_MAX = Math.round(MAX_VICTORY_SHARE * 100);
const DIFFICULTIES = AI_DIFFICULTIES.map(d => [d.id, d.name]);
const MAX_SEED = 2147483647;
const MIN_SEATS = 2;
const optionsHtml = list => list.map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('');

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rollSeed = () => (Math.random() * (MAX_SEED + 1)) | 0;
/** A usable seed, or null when the value is not a seed at all. */
const asSeed = v => (Number.isInteger(v) && v >= 0 && v <= MAX_SEED ? v : null);

/**
 * Cities in a layout — the seat limit. generateCityLayout() is a full map generation, so results
 * are remembered per (seed, map size) for the life of the page (the form recomputes on typing).
 */
const layouts = new Map();
function capacityFor(seed, sizeKey) {
  const key = Object.hasOwn(MAP_SIZES, sizeKey) ? sizeKey : Object.keys(MAP_SIZES)[0];
  const size = MAP_SIZES[key];
  const cache = seed + '|' + key;
  let cap = layouts.get(cache);
  if (cap === undefined) {
    // Never offer more seats than the map size can nominate: settings are bounded the same way.
    cap = Math.min(generateCityLayout(seed, size.w, size.h).cities.length, maxCityCapacity(key));
    if (layouts.size > 96) layouts.clear();
    layouts.set(cache, cap);
  }
  return cap;
}

function markup(p) {
  return '' +
    '<div class="setup-top">' +
      '<fieldset class="box"><legend>Map</legend>' +
        '<div class="opts">' +
          '<label for="' + p + 'MapSize">Map size</label>' +
          '<select id="' + p + 'MapSize">' + Object.entries(MAP_SIZES).map(([k, s]) =>
            '<option value="' + k + '">' + s.name + ' (' + s.w + '×' + s.h + ')</option>').join('') + '</select>' +
          '<label for="' + p + 'Seed">Seed</label>' +
          '<span class="seedwrap"><input id="' + p + 'Seed" inputmode="numeric" autocomplete="off" placeholder="random"' +
            ' title="Leave blank for a random seed: the preview below is the seed the match will use">' +
            '<button type="button" id="' + p + 'SeedRoll" class="mini" title="Roll another random seed">↻</button></span>' +
        '</div>' +
        '<div class="muted" id="' + p + 'Cap"></div>' +
      '</fieldset>' +
      '<fieldset class="box"><legend>Modifiers</legend>' +
        '<div class="opts">' +
          '<label for="' + p + 'Res">Starting resources</label><select id="' + p + 'Res">' + optionsHtml(FACTORS) + '</select>' +
          '<label for="' + p + 'Inc">Income rate</label><select id="' + p + 'Inc">' + optionsHtml(FACTORS) + '</select>' +
          '<label for="' + p + 'Win">Victory target</label>' +
          '<span class="winwrap"><input type="range" id="' + p + 'Win" min="' + WIN_MIN + '" max="' + WIN_MAX +
            '" step="1" value="' + Math.round(WIN_SHARE * 100) + '"> <output id="' + p + 'WinPct" for="' + p +
            'Win">' + Math.round(WIN_SHARE * 100) + '%</output></span>' +
          '<label for="' + p + 'Difficulty">AI difficulty</label><select id="' + p + 'Difficulty">' + optionsHtml(DIFFICULTIES) + '</select>' +
          '<label for="' + p + 'Fog">Fog of war</label>' +
          '<span class="chkwrap"><input type="checkbox" id="' + p + 'Fog"> <span class="muted">enemies show only near your own forces</span></span>' +
        '</div>' +
      '</fieldset>' +
    '</div>' +
    '<fieldset class="box"><legend>Teams</legend>' +
      '<div class="opts">' +
        '<label for="' + p + 'Mode">Mode</label>' +
        '<select id="' + p + 'Mode"><option value="ffa">Free-for-all — every seat for itself</option>' +
        '<option value="teams">Teams — allies win together</option></select>' +
        '<label for="' + p + 'Teams">Team count</label>' +
        '<span class="btnwrap"><select id="' + p + 'Teams"></select>' +
        '<button type="button" id="' + p + 'Balance" class="mini" title="Split the active seats evenly across the teams">Auto-balance</button></span>' +
      '</div>' +
      '<div class="muted" id="' + p + 'TeamNote"></div>' +
    '</fieldset>' +
    '<fieldset class="box roster"><legend>Roster</legend>' +
      '<div class="muted" id="' + p + 'Count"></div>' +
      '<div class="rctrl">' +
        '<label for="' + p + 'Act">Active seats</label>' +
        '<select id="' + p + 'Act" title="How many seats take part. Humans already seated keep their seat."></select>' +
        '<label for="' + p + 'BotN">Reserved bots</label>' +
        '<select id="' + p + 'BotN" title="Seats set aside for an AI before the match: no human may claim them."></select>' +
      '</div>' +
      '<div class="rows" id="' + p + 'Rows"></div>' +
      '<div class="muted" id="' + p + 'Note"></div>' +
    '</fieldset>' +
    '<div class="opts">' +
      '<label for="' + p + 'Side">Your seat</label><select id="' + p + 'Side"></select>' +
    '</div>';
}

const rowHtml = id =>
  '<div class="rrow" data-id="' + id + '">' +
    '<i class="sw" style="background:' + participantColor(id) + '"></i>' +
    '<span class="rname">' + esc(participantName(id)) + '</span>' +
    '<span class="rstates">' +
      '<button type="button" class="st" data-state="open" title="Open seat: any human may claim it — an AI plays it if nobody does">Open</button>' +
      '<button type="button" class="st" data-state="bot" title="Reserved for a bot: always played by an AI, no human may claim it">Bot</button>' +
      '<button type="button" class="st" data-state="off" title="Out of this match: the seat and its city stay neutral">Off</button>' +
    '</span>' +
    '<span class="rocc"></span>' +
    '<select class="rteam" title="Team this seat fights for"></select>' +
  '</div>';

const HEAD =
  '<div class="rhead"><span></span><span>Seat</span><span>Status</span><span>Claimed by</span>' +
  '<span class="thTeam">Team</span></div>';

export function createSettingsForm(container, prefix) {
  container.innerHTML = markup(prefix);
  const p = prefix;
  const c = {
    mapSize: $(p + 'MapSize'), seed: $(p + 'Seed'), seedRoll: $(p + 'SeedRoll'), cap: $(p + 'Cap'),
    res: $(p + 'Res'), inc: $(p + 'Inc'), win: $(p + 'Win'), winPct: $(p + 'WinPct'),
    difficulty: $(p + 'Difficulty'), fog: $(p + 'Fog'),
    mode: $(p + 'Mode'), teamCount: $(p + 'Teams'), balance: $(p + 'Balance'), teamNote: $(p + 'TeamNote'),
    rows: $(p + 'Rows'), count: $(p + 'Count'), note: $(p + 'Note'), side: $(p + 'Side'),
    act: $(p + 'Act'), botN: $(p + 'BotN')
  };

  let editable = true, seatEditable = true, seats = null, side = 0;
  let enabled = new Set([1, 2, 3, 4, 5, 6]);      // participant ids, replaced by render()
  let bots = new Set();                            // ids reserved for an AI, subset of enabled
  let teams = new Map();                           // id -> team id, teams mode only
  let mode = 'ffa', teamCount = 2, teamSig = '';
  let seedMode = 'random', previewSeed = rollSeed(), seedBad = false;
  let capacity = 0, capOverride = null;
  let onSettings = null, onSeat = null;

  const activeSeats = () => [...enabled].sort((a, b) => a - b);
  const teamOf = id => teams.get(id) || 1;
  const clampTeams = n => Math.min(Math.max(Math.round(n) || MIN_SEATS, MIN_SEATS), Math.max(MIN_SEATS, enabled.size));

  /* ---------------------------------------------------------------- roster rows */

  const rows = new Map();       // seat id -> { el, occ, team, st:{open,bot,off} }
  let rowCap = -1;

  function buildRows(cap) {
    if (cap === rowCap) return;
    rowCap = cap;
    const scroll = c.rows.scrollTop;
    c.rows.innerHTML = cap > 0
      ? HEAD + Array.from({ length: cap }, (_, i) => rowHtml(i + 1)).join('')
      : '<div class="muted">Loading this map…</div>';
    rows.clear();
    for (const el of c.rows.querySelectorAll('.rrow')) {
      const id = Number(el.dataset.id);
      const st = {};
      for (const b of el.querySelectorAll('button[data-state]')) {
        st[b.dataset.state] = b;
        b.addEventListener('click', () => setState(id, b.dataset.state));
      }
      const team = el.querySelector('.rteam');
      team.addEventListener('change', () => {
        teams.set(id, Number(team.value));
        paint();
        if (editable && onSettings) onSettings();
      });
      rows.set(id, { el, occ: el.querySelector('.rocc'), team, st });
    }
    teamSig = '';   // fresh elements: rebuild their team options on the next paint
    c.rows.scrollTop = scroll;
  }

  /* ------------------------------------------------------------------- roster state */

  /** Seats held by a human right now: lobby occupants plus your own seat, before or after the echo. */
  function occupySet() {
    const ids = new Set();
    if (seats) for (const id of seats.keys()) ids.add(Number(id));
    if (side > 0) ids.add(side);
    return ids;
  }

  /**
   * Bulk control for the number of active seats. Humans keep their seat wherever it is; the rest of
   * the roster is filled from the lowest free seats and trimmed from the highest, so the same
   * request always produces the same roster and hand-set rows are not disturbed unnecessarily.
   */
  function setActive(target) {
    const occ = occupySet();
    const want = Math.max(MIN_SEATS, Math.min(capacity, Math.round(target) || MIN_SEATS), occ.size);
    const ids = new Set(occ);
    for (const id of activeSeats()) { if (ids.size >= want) break; ids.add(id); }
    for (let id = 1; ids.size < want && id <= capacity; id++) if (!occ.has(id)) ids.add(id);
    enabled = ids;
    for (const id of [...bots]) if (!enabled.has(id) || occ.has(id)) bots.delete(id);
    paint();
    if (editable && onSettings) onSettings();
  }

  /**
   * Bulk control for reserved bot seats: existing picks are kept (lowest first) and the rest of the
   * count is filled from the lowest free seats, so an AI-only seat is never in doubt.
   */
  function setBotCount(target) {
    const occ = occupySet();
    const free = activeSeats().filter(id => !occ.has(id));
    const want = Math.max(0, Math.min(free.length, Math.round(target) || 0));
    const keep = activeSeats().filter(id => bots.has(id)).slice(0, want);
    bots = new Set(keep);
    for (const id of free) { if (bots.size >= want) break; bots.add(id); }
    paint();
    if (editable && onSettings) onSettings();
  }

  function setState(id, st) {
    if (!editable) return;
    const occ = seats && seats.get(id);
    if (occ && !occ.you) return;                     // somebody else is sitting there
    if (st === 'off') {
      if (enabled.has(id) && enabled.size <= MIN_SEATS) return;   // a match needs two participants
      enabled.delete(id);
      bots.delete(id);
      teams.delete(id);
    } else {
      enabled.add(id);
      // A reserved bot seat is a participant like any other: it keeps its team slot.
      if (st === 'bot') bots.add(id);
      else bots.delete(id);
    }
    // Turning your own seat off (or handing it to a bot) means giving it up: the picker drops to
    // Spectator and the lobby is told straight away, so the rules change cannot bounce off a seat
    // that is still yours (a websocket keeps that order).
    const gaveSeat = side === id && (!enabled.has(id) || bots.has(id));
    if (gaveSeat) side = 0;
    paint();
    if (gaveSeat && seatEditable && onSeat) onSeat(seat());
    if (onSettings) onSettings();
  }

  /** Even split, then hosts can adjust any seat from its own dropdown. */
  function autoBalance() {
    const ids = activeSeats();
    teams.clear();
    ids.forEach((id, i) => teams.set(id, (i % teamCount) + 1));
  }

  /** Give seats that were enabled after the last balance a home on the smallest team. */
  function fillTeams() {
    const counts = new Map();
    for (const [id, t] of teams) if (enabled.has(id)) counts.set(t, (counts.get(t) || 0) + 1);
    for (const id of activeSeats()) {
      if (teams.has(id)) continue;
      let best = 1, bestN = Infinity;
      for (let t = 1; t <= teamCount; t++) {
        const n = counts.get(t) || 0;
        if (n < bestN) { best = t; bestN = n; }
      }
      teams.set(id, best);
      counts.set(best, bestN + 1);
    }
  }

  function syncTeams() {
    for (const id of [...teams.keys()]) {
      if (!enabled.has(id) || teams.get(id) > teamCount) teams.delete(id);
    }
    if (mode === 'teams') fillTeams();
  }

  function paintTeams() {
    const show = mode === 'teams';
    const sig = show ? mode + ':' + teamCount : '';
    if (show && sig !== teamSig) {
      const html = Array.from({ length: teamCount }, (_, i) => '<option value="' + (i + 1) + '">Team ' + (i + 1) + '</option>').join('');
      for (const r of rows.values()) r.team.innerHTML = html;
    }
    teamSig = sig;
    if (!show) return;
    for (const [id, r] of rows) {
      r.team.value = String(teamOf(id));
      r.team.disabled = !editable || !enabled.has(id);
    }
  }

  function paintRoster() {
    const teamsMode = mode === 'teams';
    for (const [id, r] of rows) {
      const on = enabled.has(id), bot = bots.has(id);
      const occ = seats && seats.get(id);
      const mine = !!(occ && occ.you);
      r.el.classList.toggle('off', !on);
      r.st.open.classList.toggle('on', on && !bot);
      r.st.bot.classList.toggle('on', on && bot);
      r.st.off.classList.toggle('on', !on);
      const locked = !editable || (occ && !occ.you);
      r.st.open.disabled = locked;
      r.st.bot.disabled = locked;
      r.st.off.disabled = locked || (on && enabled.size <= MIN_SEATS);
      r.occ.textContent = mine ? 'you' : occ ? occ.name : '';
      r.el.title = 'Seat ' + id + ' · ' + participantName(id) + ' — ' +
        (on ? (bot ? 'reserved for a bot' : 'open for any human') : 'out of this match') +
        (occ ? (mine ? ' · your seat' : ' · taken by ' + occ.name) : '');
    }
    c.rows.classList.toggle('teams', teamsMode);
  }

  /** Seat picker: every open seat plus spectator; other people's seats are shown but not selectable. */
  function paintSide() {
    if (side !== 0 && (!enabled.has(side) || bots.has(side))) side = 0;
    const ids = activeSeats().filter(id => !bots.has(id));
    c.side.innerHTML = ids.map(id => {
      const occ = seats && seats.get(id);
      const tag = occ ? (occ.you ? ' (you)' : ' — ' + occ.name) : '';
      return '<option value="' + id + '"' + (occ && !occ.you ? ' disabled' : '') + '>' + participantName(id) + tag + '</option>';
    }).join('') + '<option value="0">Spectator — watch the whole map</option>';
    c.side.value = String(side);
    c.side.disabled = !seatEditable;
  }

  function paintSummary() {
    const size = MAP_SIZES[c.mapSize.value] || MAP_SIZES[Object.keys(MAP_SIZES)[0]];
    const humans = seats ? seats.size : (side > 0 ? 1 : 0);
    const active = activeSeats().length;
    const botSeats = activeSeats().filter(id => bots.has(id)).length;
    const open = Math.max(0, active - botSeats - humans);
    const ai = Math.max(0, active - humans);
    c.cap.textContent = seedBad
      ? 'Seed must be a whole number from 0 to ' + MAX_SEED + '.'
      : size.name + ' holds ' + capacity + ' cit' + (capacity === 1 ? 'y' : 'ies') + ' on ' +
        (seedMode === 'fixed' ? 'seed ' : 'random seed ') + previewSeed +
        ' — up to ' + capacity + ' participants.';
    c.cap.classList.toggle('warn', seedBad);
    // `p.bot` marks a seat RESERVED for an AI, not the AI that fills an unclaimed seat: the AI
    // count at start is every active seat minus the seated humans (reserved bots + still-open).
    c.count.textContent = active + ' of ' + capacity + ' seats active · ' +
      humans + ' human' + (humans === 1 ? '' : 's') + ' · ' +
      botSeats + ' reserved bot' + (botSeats === 1 ? '' : 's') + ' · ' + open + ' open · ' +
      ai + ' AI at start (' + botSeats + ' reserved + ' + open + ' unclaimed)';
    const notes = [];
    if (!humans) notes.push('Watch mode: no human is seated, so every active seat is played by an AI.');
    else notes.push('Open seats can be claimed by humans; any seat still open when the match starts is played by an AI.');
    if (botSeats) notes.push('Reserved bot seats are always played by an AI and humans cannot claim them.');
    if (!editable) notes.push('Only the host changes the rules, seats and teams — pick your own seat below.');
    c.note.textContent = notes.join(' ');
  }

  function paintTeamNote() {
    if (mode === 'teams') {
      const g = new Map();
      for (const id of activeSeats()) {
        const t = teamOf(id);
        if (!g.has(t)) g.set(t, []);
        g.get(t).push(participantName(id));
      }
      c.teamNote.textContent = 'Allies share vision, logistics, fortress cover and victory. ' +
        [...g.entries()].sort((a, b) => a[0] - b[0]).map(([t, names]) => 'Team ' + t + ': ' + names.join(', ')).join(' · ');
    } else {
      c.teamNote.textContent = 'Free-for-all: every active seat fights alone — no allies, no shared vision, logistics or victory.';
    }
  }

  function paintTeamCount() {
    const max = Math.max(MIN_SEATS, enabled.size);
    if (c.teamCount.dataset.max !== String(max)) {
      c.teamCount.dataset.max = String(max);
      c.teamCount.innerHTML = Array.from({ length: max - 1 }, (_, i) =>
        '<option value="' + (i + 2) + '">' + (i + 2) + ' teams</option>').join('');
    }
    teamCount = clampTeams(teamCount);
    c.teamCount.value = String(teamCount);
  }

  /** The two bulk controls above the roster, rebuilt only when their bounds change. */
  function paintCounts() {
    const occ = occupySet();
    const active = activeSeats();
    const humans = active.filter(id => occ.has(id)).length;
    const lo = Math.max(MIN_SEATS, humans);
    const hi = Math.max(lo, capacity);
    const sig = lo + ':' + hi;
    if (c.act.dataset.sig !== sig) {
      c.act.dataset.sig = sig;
      c.act.innerHTML = Array.from({ length: hi - lo + 1 }, (_, i) =>
        '<option value="' + (lo + i) + '">' + (lo + i) + '</option>').join('');
    }
    c.act.value = String(Math.min(Math.max(active.length, lo), hi));
    c.act.title = hi === lo
      ? 'Every seat on this map is taken by a human player'
      : 'How many seats take part (' + lo + '–' + hi + '). Humans already seated keep their seat.';

    const maxBots = Math.max(0, active.length - humans);
    const bsig = String(maxBots);
    if (c.botN.dataset.sig !== bsig) {
      c.botN.dataset.sig = bsig;
      c.botN.innerHTML = Array.from({ length: maxBots + 1 }, (_, i) =>
        '<option value="' + i + '">' + i + '</option>').join('');
    }
    const botSeats = active.filter(id => bots.has(id)).length;
    c.botN.value = String(Math.min(botSeats, maxBots));
    c.botN.title = maxBots === 0
      ? 'No seat is free to reserve for a bot'
      : 'Seats set aside for an AI before the match (0–' + maxBots + '). No human may claim them.';
  }

  function paintEditable() {
    for (const el of [c.mapSize, c.seed, c.seedRoll, c.res, c.inc, c.win, c.difficulty, c.fog, c.mode]) el.disabled = !editable;
    c.teamCount.disabled = !editable || mode !== 'teams';
    c.balance.disabled = !editable || mode !== 'teams';
    c.act.disabled = !editable;
    c.botN.disabled = !editable;
  }

  /** One pass over everything derived from the current state. */
  function paint() {
    capacity = capOverride !== null ? capOverride : capacityFor(previewSeed, c.mapSize.value);
    for (const id of [...enabled]) if (id > capacity) enabled.delete(id);   // smaller map: drop the seats it cannot hold
    syncTeams();
    buildRows(capacity);
    paintTeamCount();
    paintRoster();
    paintCounts();
    paintTeams();
    paintSide();
    paintSummary();
    paintTeamNote();
    paintEditable();
  }

  /* ------------------------------------------------------------------------ input */

  const winLabel = () => { c.winPct.textContent = c.win.value + '%'; };

  function editSeed(text) {
    const trimmed = text.trim();
    if (trimmed === '') {
      seedMode = 'random';
      seedBad = false;
      if (asSeed(previewSeed) === null) previewSeed = rollSeed();
    } else {
      const seed = asSeed(Number(trimmed));
      seedMode = 'fixed';
      seedBad = seed === null;
      if (seed !== null) previewSeed = seed;
    }
    capOverride = null;      // the local field now decides the map, not the lobby's copy
  }

  c.mapSize.addEventListener('change', () => {
    capOverride = null;
    paint();
    if (editable && onSettings) onSettings();
  });
  c.seed.addEventListener('input', () => {
    editSeed(c.seed.value);
    paint();
    if (editable && onSettings) onSettings();
  });
  c.seedRoll.addEventListener('click', () => {
    if (!editable) return;
    seedMode = 'random';
    seedBad = false;
    previewSeed = rollSeed();
    capOverride = null;
    c.seed.value = '';
    paint();
    if (onSettings) onSettings();
  });
  c.mode.addEventListener('change', () => {
    mode = c.mode.value === 'teams' ? 'teams' : 'ffa';
    if (mode === 'teams') autoBalance();
    paint();
    if (editable && onSettings) onSettings();
  });
  c.teamCount.addEventListener('change', () => {
    teamCount = clampTeams(Number(c.teamCount.value));
    if (mode === 'teams') autoBalance();
    paint();
    if (editable && onSettings) onSettings();
  });
  c.balance.addEventListener('click', () => {
    if (!editable || mode !== 'teams') return;
    autoBalance();
    paint();
    if (onSettings) onSettings();
  });
  // Bulk controls: the same state the per-row buttons edit, applied over the free seats only.
  c.act.addEventListener('change', () => { if (editable) setActive(Number(c.act.value)); });
  c.botN.addEventListener('change', () => { if (editable) setBotCount(Number(c.botN.value)); });
  // Live label while dragging; the debounced lobby push reuses the same onSettings callback.
  c.win.addEventListener('input', () => { winLabel(); if (editable && onSettings) onSettings(); });
  c.side.addEventListener('change', () => {
    side = Number(c.side.value) || 0;
    paintSummary();
    if (seatEditable && onSeat) onSeat(seat());
  });
  for (const el of [c.res, c.inc, c.difficulty, c.fog]) {
    el.addEventListener('change', () => { paint(); if (editable && onSettings) onSettings(); });
  }

  /* ------------------------------------------------------------------------ public */

  function render(s, o = {}) {
    editable = o.editable !== false;
    seatEditable = o.seatEditable !== false;
    seats = o.seats || null;
    if (o.seat !== undefined && o.seat !== null) side = o.seat | 0;

    // Seed preview: a blank field means "random", and the preview keeps the seed it already shows
    // across re-renders, so a start uses exactly the map the form described. `seedIntent` re-states
    // what the player last asked for (null = random, a number = fixed), a fresh local game rolls a
    // new random preview, and an explicit seed in the settings is fixed as-is.
    let intent;                                  // undefined = keep the preview this form already shows
    if (o.seedIntent !== undefined) intent = o.seedIntent;
    else if (s.seed !== undefined) intent = s.seed === null || s.seed === '' ? null : s.seed;
    // Somebody typing in the seed field is the authority on it: a lobby echo must not reset the
    // mode or the preview underneath their cursor.
    if (document.activeElement === c.seed) intent = undefined;
    if (intent === undefined) {
      if (asSeed(previewSeed) === null) previewSeed = rollSeed();
    } else if (intent === null || intent === '') {
      seedMode = 'random';
      seedBad = false;
      if (o.freshSeed) previewSeed = rollSeed();
    } else {
      const seed = asSeed(Number(intent));
      seedMode = 'fixed';
      seedBad = seed === null;
      if (seed !== null) previewSeed = seed;
    }

    // A lobby states its own resolved seed and capacity: the preview must show exactly those.
    capOverride = Number.isInteger(o.cityCapacity) && o.cityCapacity > 0 ? o.cityCapacity : null;
    if (seedMode === 'random' && Number.isInteger(Number(o.mapSeed)) && o.mapSeed !== undefined && o.mapSeed !== null) {
      previewSeed = Number(o.mapSeed) | 0;
    }

    const v = (el, val) => { if (document.activeElement !== el) el.value = String(val); };
    v(c.mapSize, s.mapSize || Object.keys(MAP_SIZES)[0]);
    if (!seedBad) v(c.seed, seedMode === 'fixed' ? previewSeed : '');
    v(c.res, s.startingResources === undefined ? 1 : s.startingResources);
    v(c.inc, s.incomeMultiplier === undefined ? 1 : s.incomeMultiplier);
    // The slider speaks whole percent; settings carry the 0.5–1 share.
    if (document.activeElement !== c.win) c.win.value = String(Math.round((s.victoryShare === undefined ? WIN_SHARE : s.victoryShare) * 100));
    winLabel();
    v(c.difficulty, s.aiDifficulty || 'medium');
    c.fog.checked = !!s.fog;

    const list = (s.factions || []).map(Number).filter(id => Number.isInteger(id) && id >= 1).sort((a, b) => a - b);
    enabled = new Set(list.length >= MIN_SEATS ? list : [1, 2, 3, 4, 5, 6]);
    bots = new Set((s.bots || []).map(Number).filter(id => enabled.has(id)));
    mode = s.teams ? 'teams' : 'ffa';
    teamCount = clampTeams(s.teamCount === undefined ? 2 : Number(s.teamCount));
    teams = new Map();
    if (Array.isArray(s.teams)) {
      const ids = [...enabled].sort((a, b) => a - b);
      s.teams.forEach((t, i) => { if (ids[i] !== undefined) teams.set(ids[i], Number(t)); });
    }
    c.mode.value = mode;
    paint();
  }

  /** Lobby updates: only the seats changed, the rules themselves stay as they are. */
  function updateSeats(nextSeats, mySeat) {
    seats = nextSeats || null;
    if (mySeat !== undefined && mySeat !== null) side = mySeat | 0;
    paint();
  }

  const read = () => {
    // A seed left blank stays null: the lobby resolves one and publishes it back (the preview).
    const factions = activeSeats();
    const teamsArr = mode === 'teams' ? factions.map(id => teamOf(id)) : null;
    return {
      mapSize: c.mapSize.value,
      seed: seedMode === 'fixed' ? (seedBad ? NaN : previewSeed) : null,
      factions,
      bots: factions.filter(id => bots.has(id)),
      teams: teamsArr,
      teamCount: mode === 'teams' ? teamCount : MIN_SEATS,
      startingResources: Number(c.res.value),
      incomeMultiplier: Number(c.inc.value),
      victoryShare: Number(c.win.value) / 100,
      fog: c.fog.checked,
      aiDifficulty: c.difficulty.value
    };
  };

  const seat = () => (side >= 1 ? { role: 'player', faction: side } : { role: 'spectator', faction: 0 });

  return {
    render,
    updateSeats,
    read,
    seat,
    /** The exact seed a start would use, which is the seed the preview line is showing. */
    mapSeed: () => (seedMode === 'fixed' ? (seedBad ? NaN : previewSeed) : previewSeed),
    /** What the player asked for: null = random, a number = fixed. */
    seedIntent: () => read().seed,
    /** Seats the rules can currently hold (the layout bound, not the lobby's own count). */
    /** Cities on the previewed map: the number of seats the rules can hold. */
    capacity: () => capacity,
    /** Move focus away before re-rendering, so lobby echoes never fight a local edit. */
    focusOut() {
      const el = document.activeElement;
      if (el && container.contains(el) && typeof el.blur === 'function') el.blur();
    },
    onChange(fn) { onSettings = fn; },
    onSeatChange(fn) { onSeat = fn; }
  };
}
