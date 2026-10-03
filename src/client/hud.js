import {
  TYPES, BUILDINGS, BUILD_IDS, BUILD_RADIUS, MANPOWER, GOLD,
  LOGISTICS_DISTANCE, REINFORCE_RATE, ROAD_GOLD, ROAD_SPEED, ROAD_LOGISTICS_COST,
  ROUT_FRAC, ROUT_RECOVER_FRAC, ROUT_MIN_DISTANCE, ROUT_MAX_DISTANCE,
  PUSH_BASE, COLUMN_SPACING, FORT_RANGE, FORT_DEF, ISOLATED_COMBAT
} from '../config.js';
import { buildCost, hasFactory, countBuilt } from '../sim/buildings.js';
import { logisticsDistance, combatMult, reinforceRate } from '../sim/supply.js';
import { moving } from '../sim/collision.js';
import { cedeAllies, cedeCount } from './ui-state.js';

const $ = id => document.getElementById(id);

/**
 * Tooltip / build-mode blurb for a building. The income figures are read from the balance config
 * (MANPOWER.perFarm, GOLD.perFactory) so a rebalance can never leave stale numbers in the UI copy.
 */
function buildInfo(type, mult = 1) {
  const rate = v => (Math.round(v * mult * 100) / 100).toString();
  const note = mult === 1 ? '' : ' (income ×' + mult + ')';
  if (type === 'farm') return '+' + rate(MANPOWER.perFarm) + ' manpower/s on any of your plain land' + note;
  if (type === 'factory') return '+' + rate(GOLD.perFactory) + ' gold/s; unlocks Armor and Artillery nearby' + note;
  return BUILDINGS[type].info;
}

/** A player's team key: the configured team id, or the faction itself in a free-for-all. */
const teamKey = p => (p && p.team >= 1 ? p.team : p ? p.id : 0);
/** True when two factions fight on the same configured team (always false in a free-for-all). */
function sameTeam(world, a, b) {
  const s = world && world.settings;
  if (!s || !s.teams || !a || !b || a === b) return false;
  const pa = world.players[a - 1], pb = world.players[b - 1];
  return !!(pa && pb && pa.team >= 1 && pa.team === pb.team);
}
/** Player names can come from other people, so never paste them into markup raw. */
const escHtml = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** DOM HUD: stat bar, scoreboard, selection panel, toasts and the end screen. */
export function createHud(app) {
  function toast(msg, kind = '') {
    const box = $('toasts'), d = document.createElement('div');
    d.className = 'toast ' + kind; d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => d.remove(), 4000);
    while (box.children.length > 5) box.firstChild.remove();
  }

  // A cession is reported twice in single player: the landCeded event (emitted inside the sim command)
  // and the command result that follows it. Whichever arrives first toasts, and the repeat right after
  // is swallowed; in multiplayer the server forwards both signals the same way.
  let lastCede = { at: -1e9, from: 0, to: 0, tiles: 0 };
  let cedeSig = '';                // fingerprint of the rendered recipient buttons, so they rebuild only on change
  function cedeToast(from, to, tiles) {
    const now = performance.now();
    if (now - lastCede.at < 500 && lastCede.from === from && lastCede.to === to && lastCede.tiles === tiles) return;
    lastCede = { at: now, from, to, tiles };
    if (!app.me || (from !== app.me && to !== app.me)) return;
    const name = id => { const p = app.world && app.world.players[id - 1]; return p ? p.name : 'a teammate'; };
    if (from === app.me) {
      toast(tiles > 0 ? 'Ceded ' + tiles + ' tile' + (tiles === 1 ? '' : 's') + ' of land to ' + name(to)
        : 'No land was ceded - that area held none of your tiles', tiles > 0 ? 'good' : 'bad');
    } else {
      toast(name(from) + ' ceded you ' + tiles + ' tile' + (tiles === 1 ? '' : 's') + ' of land', 'good');
    }
  }

  /** Headline + subtitle for the end screen, from this viewer's point of view (teams included). */
  function endText(result) {
    const world = app.world, me = app.me > 0 ? world.players[app.me - 1] : null;
    const winner = result.winnerId ? world.players[result.winnerId - 1] : null;
    const how = result.reason === 'land' ? 'controls ' + result.pct + '% of the land' : 'is the last empire standing';
    // The sim reports the winner's team, so an ally's win is the viewer's win.
    if (me && winner && teamKey(winner) === teamKey(me)) {
      if (winner.id === app.me) {
        return ['Victory!', result.reason === 'land' ? 'You control ' + result.pct + '% of the land.' : 'Your empire is the last one standing.'];
      }
      return ['Team victory!', (me.alive ? 'Your ally ' : 'You were eliminated, but your team won - ') + winner.name + ' ' + how + '.'];
    }
    if (!winner) return ['Game over', 'Every human player has been eliminated.'];
    const lost = me && !me.alive ? 'You were eliminated. ' : '';
    return [app.me > 0 ? 'Defeat' : 'The war is over', lost + winner.name + ' ' + how + '.'];
  }

  /** Translate sim events into player-facing feedback. Events carry player ids; app.me is the viewer. */
  function onEvent(type, data) {
    switch (type) {
      case 'cityCaptured':
        if (data.by === app.me) toast('City captured!', 'good');
        else if (data.from === app.me) toast(data.city.capital ? 'Your capital has fallen!' : 'City lost!', 'bad');
        break;
      case 'divisionDestroyed':
        if (data.div.owner === app.me) toast('A division was destroyed', 'bad');
        break;
      case 'playerEliminated': {
        if (data.player.id === app.me) toast('You have been eliminated' + (app.world.over ? '' : ' - spectating'), 'bad');
        else if (sameTeam(app.world, app.me, data.player.id)) toast('Your ally ' + data.player.name + ' has been eliminated', 'bad');
        else toast(data.player.name + ' has been eliminated', 'good');
        break;
      }
      case 'raiseFailed':
        if (data.player.id !== app.me) break;
        toast(data.reason === 'funds' ? 'Not enough manpower (need ' + data.need + ')'
          : data.reason === 'gold' ? 'Not enough gold (need ' + data.need + ')'
          : data.reason === 'factory' ? 'Armor and Artillery need a Factory within ' + BUILD_RADIUS + ' tiles of the city'
          : data.reason === 'space' ? 'No room to deploy a new division near the city'
          : 'You have no city to raise troops in', 'bad');
        break;
      case 'buildFailed':
        if (data.player.id === app.me) toast('Not enough gold (need ' + data.need + ')', 'bad');
        break;
      case 'buildingLost':
        if (data.owner === app.me) toast('A ' + BUILDINGS[data.type].name + (data.type === 'fortress' ? ' was destroyed' : ' was captured'), 'bad');
        break;
      case 'landCeded':
        cedeToast(data.from, data.to, data.tiles);
        break;
      case 'gameOver': {
        const [title, sub] = endText(data);
        $('endTitle').textContent = title;
        $('endSub').textContent = sub;
        $('end').style.display = 'flex';
        break;
      }
    }
  }

  /** The end-screen button is 'New game' alone, or 'Rematch' (host only) in multiplayer. */
  function refreshEnd() {
    if ($('end').style.display !== 'flex') return;
    const b = $('bAgain');
    if (app.session && app.session.kind === 'net') {
      const host = !!(app.lobby && app.lobby.players.some(p => p.you && p.host));
      b.textContent = host ? 'Rematch' : 'Waiting for host to rematch...';
      b.disabled = !host;
    } else { b.textContent = 'New game'; b.disabled = false; }
  }

  function hideEnd() { $('end').style.display = 'none'; }

  /** Live supply readout for one of our divisions: effective distance, damage output and reinforcement rate. */
  function supplyText(world, d) {
    const D = logisticsDistance(world, d);
    if (!Number.isFinite(D)) {
      return '<span class="warn">Cut off from your cities</span> - half fighting output, no reinforcements';
    }
    const out = Math.round(combatMult(world, d) * 100), rate = reinforceRate(world, d);
    return 'Logistics ' + D.toFixed(1) + ' tiles from a connected city - damage output ' + out + '%, reinforcements ' + rate.toFixed(2) + ' men/s';
  }

  function selectionHtml(world, ui) {
    const sel = [...ui.sel];
    if (sel.length === 1) {
      const d = sel[0], T = TYPES[d.type];
      // Mandatory states outrank order state: cornered > routing > fighting > on the move > holding.
      // An engaged body still shows its combat marker so its damage is never hidden.
      const engaged = d.eng ? ' <span class="fight">· In combat</span>' : '';
      let status;
      if (d.routLocked) status = '<span class="fight">Cornered — cannot flee again, fights to the death</span>' + engaged;
      else if (d.routing) status = '<span class="warn">Routing</span> (fleeing)' + engaged;
      else if (d.eng) status = '<span class="fight">In combat</span>';
      else if (d.column && ((d.routePoints && d.routePoints.length) || moving(d))) status = 'Column march' + (d.routePoints && d.routePoints.length ? ' (' + d.routePoints.length + ' checkpoint' + (d.routePoints.length > 1 ? 's' : '') + ')' : '');
      else if (d.routePoints && d.routePoints.length > 1) status = 'On route (' + d.routePoints.length + ' checkpoints)';
      else if (moving(d)) status = 'Moving';
      else status = T.capt ? 'Holding &amp; capturing' : 'Holding, shelling enemies in range';
      return '<b>' + T.name + '</b> — ' + Math.round(d.men) + ' / ' + Math.round(d.cap) + ' men<br>' + status + '<br>' + supplyText(world, d);
    }
    if (sel.length > 1) {
      const counts = {}; let m = 0, iso = 0, rate = 0, out = 0, cols = 0;
      for (const d of sel) {
        counts[d.type] = (counts[d.type] || 0) + 1; m += d.men;
        const D = logisticsDistance(world, d);
        if (!Number.isFinite(D)) iso++;
        rate += reinforceRate(world, d); out += combatMult(world, d) * 100;
        if (d.column) cols++;
      }
      const mix = Object.entries(counts).map(([t, n]) => n + ' ' + TYPES[t].tag).join(', ');
      return '<b>' + sel.length + ' divisions</b> (' + mix + ') — ' + Math.round(m) + ' men total<br>' +
        'Damage output ' + Math.round(out / sel.length) + '% · reinforcements ' + rate.toFixed(1) + ' men/s' +
        (iso ? ' · <span class="warn">' + iso + ' cut off (half output, no reinforcements)</span>' : '') +
        (cols ? ' · ' + cols + ' in column' : '');
    }
    if (ui.selCity) {
      return '<b>' + (ui.selCity.capital ? 'Capital' : 'City') + '</b><br>' + (ui.selCity.rally !== null ? 'Rally point set. ' : '') +
        'R infantry, T armor, Y artillery (need a Factory nearby). Right-click sets rally point. Nearby divisions reinforce in place — none of them needs to walk home.';
    }
    return 'Nothing selected. Click a city to recruit, drag to select divisions. Shift+right-click adds a route checkpoint; C toggles column mode.';
  }

  const kb = (label, cost, key) => label + ' <small>' + cost + '</small> <kbd>' + key + '</kbd>';

  /** Live summary of the setup this game runs with, so the help copy always matches the match settings. */
  function updateMods(world) {
    const s = world.settings;
    if (!s) return;
    const pct = v => Math.round(v * 100) + '%';
    const x = v => '×' + v;
    const el = $('hWinPct');
    if (el) el.textContent = pct(s.victoryShare);
    const m = $('hMods');
    if (m) m.textContent = 'This game: ' + world.players.filter(p => p.enabled !== false).length + ' participants · ' +
      (s.teams ? 'teams (' + s.teamCount + ')' : 'free-for-all') + ' · map ' + world.w + '×' + world.h +
      ' · starting resources ' + x(s.startingResources) + ' · income ' + x(s.incomeMultiplier) +
      ' · victory at ' + pct(s.victoryShare) + ' of the land · fog of war ' + (s.fog ? 'on' : 'off');
  }

  function refresh() {
    const world = app.world, ui = app.ui;
    if (!world) return;
    if (app.roadPreview) app.roadPreview();   // keep an open road sketch fresh against captures and gold changes
    const me = app.me > 0 ? world.players[app.me - 1] || null : null;
    const mult = world.settings ? world.settings.incomeMultiplier : 1;   // build tooltips quote the rate this match actually pays
    $('bPause').textContent = ui.paused ? '▶' : '⏸';
    refreshEnd();
    updateMods(world);

    // Factions that are not taking part in this match are left out of the scoreboard entirely.
    const fogged = ui.fog && !world.over;
    const board = world.players.filter(q => q.enabled !== false).slice().sort((a, b) => b.tiles - a.tiles);
    const row = q => {
      const seen = q.id === app.me || !fogged || sameTeam(world, app.me, q.id);   // allies share vision
      return '<div class="' + (q.alive ? '' : 'dead') + '"><i style="background:' + q.color + '"></i><span class="n">' +
        escHtml(q.name) + (q.id === app.me ? ' (you)' : '') + '</span><span>' + (q.tiles / world.landCount * 100).toFixed(1) +
        '%</span><span class="army">' + (q.army < 0 || !seen ? '?' : Math.round(q.army)) + '</span></div>';
    };
    // A team game groups the list per team, so allies read as one block with a shared land share.
    const groups = new Map();
    if (world.settings && world.settings.teams) for (const q of board) {
      const t = teamKey(q);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(q);
    }
    const grouped = groups.size > 0 && [...groups.values()].some(g => g.length > 1);
    $('board').innerHTML = grouped
      ? [...groups].map(([t, mem]) => '<div class="trow' + (t === teamKey(me) ? ' mine' : '') + '"><span class="tn">Team ' + t +
        (t === teamKey(me) ? ' (yours)' : '') + '</span><span>' + (mem.reduce((s, q) => s + q.tiles, 0) / world.landCount * 100).toFixed(1) +
        '%</span></div>' + mem.map(row).join('')).join('')
      : board.map(row).join('');

    // Logistics view: a pure read-only overlay, so unlike faction controls it is offered to spectators too.
    $('bLogi').classList.toggle('on', ui.logistics);
    $('logiLegend').style.display = ui.logistics ? '' : 'none';

    if (!me) return;                 // spectator: no faction of its own to report or command
    $('hPool').textContent = Math.floor(me.pool);
    $('hInc').textContent = '+' + me.rate.toFixed(1) + '/s';
    $('hGold').textContent = Math.floor(me.gold);
    $('hGoldInc').textContent = '+' + me.goldRate.toFixed(1) + '/s';
    $('hArmy').textContent = Math.round(me.army);
    $('hDivs').textContent = world.divs.filter(d => d.owner === me.id).length;
    $('hLand').textContent = (me.tiles / world.landCount * 100).toFixed(1) + '%';

    // recruitment: manpower + gold, and armor / artillery need a Factory near the city
    const city = ui.selCity && ui.selCity.owner === me.id ? ui.selCity : null;
    const mine = world.cities.filter(c => c.owner === me.id);
    const heavyOk = city ? hasFactory(world, me.id, city) : mine.some(c => hasFactory(world, me.id, c));
    const afford = T => me.pool >= T.manpower && me.gold >= T.gold;
    const cost = T => T.manpower + ' men · ' + T.gold + 'g';
    $('bRaise').innerHTML = kb('Infantry', cost(TYPES.inf), 'R');
    $('bRaiseA').innerHTML = kb('Armor', cost(TYPES.arm), 'T');
    $('bRaiseR').innerHTML = kb('Artillery', cost(TYPES.art), 'Y');
    $('bRaise').disabled = !afford(TYPES.inf);
    $('bRaiseA').disabled = !afford(TYPES.arm) || !heavyOk;
    $('bRaiseR').disabled = !afford(TYPES.art) || !heavyOk;
    $('bRaiseA').title = $('bRaiseR').title = heavyOk ? '' : 'Needs a Factory within ' + BUILD_RADIUS + ' tiles of the city';

    // construction buttons
    const bb = { farm: ['bFarm', 'J'], factory: ['bFactory', 'K'], fortress: ['bFort', 'L'] };
    for (const type of BUILD_IDS) {
      const b = $(bb[type][0]), c = buildCost(world, me.id, type);
      b.innerHTML = kb(BUILDINGS[type].name, c + 'g', bb[type][1]);
      b.classList.toggle('on', ui.build === type);
      b.disabled = me.gold < c && ui.build !== type;
      b.title = buildInfo(type, mult);
    }

    $('bRoad').innerHTML = kb('Road', ROAD_GOLD + 'g/tile', 'B');
    $('bRoad').classList.toggle('on', !!ui.road);
    $('bRoad').disabled = me.gold < ROAD_GOLD && !ui.road;
    $('bRoad').title = 'Draw a road across your own land: click a start tile, Shift+click bends, click the end tile or press Enter. New tiles cost '
      + ROAD_GOLD + 'g; roads speed movement ×' + ROAD_SPEED + ' and cut logistics cost to ' + Math.round(ROAD_LOGISTICS_COST * 100) + '%. Right-click / Esc cancels.';
    $('bColumn').classList.toggle('on', ui.column);
    $('bColumn').title = 'Column mode (C): right-click orders the selection to travel single file, at least ' + COLUMN_SPACING
      + ' tiles apart, in a fixed order. Shift+right-click adds route checkpoints.';

    // cede (G): a peaceful, free area handover to a teammate - offered whenever a living one exists
    const allies = cedeAllies(world, me.id);
    const cede = ui.cede;
    $('bCede').innerHTML = kb('Cede land', 'free', 'G');
    $('bCede').classList.toggle('on', !!cede);
    $('bCede').disabled = !allies.length && !cede;
    $('bCede').title = allies.length
      ? 'Hand a dragged rectangle of your own land to a teammate. Free and peaceful: nothing is destroyed - cities, farms, factories, fortresses (even unfinished ones) and roads on it change hands intact, while your divisions stay under their owner\'s command.'
      : 'Ceding needs a living teammate: set up teams, or join a team game.';
    $('cede').style.display = cede ? '' : 'none';
    if (cede) {
      if (!allies.some(p => p.id === cede.to)) cede.to = allies.length ? allies[0].id : 0;
      if (cede.rect) cede.count = cedeCount(world, me.id, cede.rect);   // captures can change a parked preview
      const sig = allies.map(p => p.id + ':' + p.name).join('|') + '#' + cede.to;
      if (sig !== cedeSig) {                                            // rebuild only when the roster or pick changed
        cedeSig = sig;
        $('cedeTargets').innerHTML = allies.map(p => '<button data-id="' + p.id + '"' + (p.id === cede.to ? ' class="on"' : '') + '>'
          + escHtml(p.name) + '</button>').join('');
      }
      $('bCedeGo').innerHTML = cede.rect && cede.count
        ? 'Cede ' + cede.count + ' tile' + (cede.count === 1 ? '' : 's') + ' <kbd>Enter</kbd>'
        : 'Cede area <kbd>Enter</kbd>';
      $('bCedeGo').disabled = !(cede.rect && cede.count > 0);
    }

    $('selInfo').innerHTML = cede
      ? '<b>Cede land to ' + escHtml((world.players[cede.to - 1] || {}).name || 'a teammate') + '</b> — ' +
        (cede.rect
          ? (cede.count ? cede.count + ' tile' + (cede.count === 1 ? '' : 's') + ' of yours will change hands. ' : 'No land of yours inside this area. ')
          : 'Drag a rectangle across your own land; a plain click marks a single tile. ') +
        'Confirm with Enter or the button. Free and peaceful: nothing is destroyed - cities, farms, factories, fortresses (even unfinished ones) and roads on the land change hands intact, and the divisions stay under your command. Right-click / Esc cancels.'
      : ui.road
      ? '<b>Road tool</b> — click a start tile, Shift+click bends, click the end tile or press Enter to build. ' +
        (ui.road.pts.length ? ui.road.pts.length + ' point' + (ui.road.pts.length > 1 ? 's' : '') +
          (ui.road.tiles ? ' · ' + ui.road.cost + 'g (' + (ui.road.afford ? 'affordable' : 'not enough gold') + ')' : ' · no valid route yet') + '. '
          : '') +
        'Right-click / Esc cancels. New tiles cost ' + ROAD_GOLD + 'g, must be your own land, speed movement ×' + ROAD_SPEED + ' and cut logistics cost to ' + Math.round(ROAD_LOGISTICS_COST * 100) + '%.'
      : ui.build
      ? '<b>Build ' + BUILDINGS[ui.build].name + '</b> (' + buildCost(world, me.id, ui.build) + 'g) — ' + buildInfo(ui.build, mult) + '<br>' +
        (ui.build === 'farm' ? 'Click or drag across your land to lay out farms.' : 'Click a spot within ' + BUILD_RADIUS + ' tiles of one of your cities.') + ' Right-click / Esc to stop.'
      : selectionHtml(world, ui) +
        (ui.column ? '<br><span class="col">Column mode: right-click orders a single-file route; Shift+right-click adds checkpoints (C toggles)</span>' : '');
    $('bStop').disabled = !ui.sel.size;
    $('bSplit').disabled = !ui.sel.size;
    $('bMerge').disabled = ui.sel.size < 2;
  }

  /** Hook up the DOM buttons to commands. */
  function bindButtons(cmd) {
    $('bPause').onclick = cmd.togglePause;
    document.querySelectorAll('[data-sp]').forEach(b => { b.onclick = () => cmd.setSpeed(+b.dataset.sp); });
    $('bRaise').onclick = () => cmd.raise('inf');
    $('bRaiseA').onclick = () => cmd.raise('arm');
    $('bFarm').onclick = () => cmd.startBuild('farm');
    $('bFactory').onclick = () => cmd.startBuild('factory');
    $('bFort').onclick = () => cmd.startBuild('fortress');
    $('bRoad').onclick = () => cmd.startRoad();
    $('bCede').onclick = () => cmd.startCede();
    $('bCedeGo').onclick = () => cmd.cedeConfirm();
    $('bCedeX').onclick = () => cmd.cancelCede();
    $('cedeTargets').onclick = e => { const b = e.target.closest('button[data-id]'); if (b) cmd.cedeTarget(+b.dataset.id); };
    $('bColumn').onclick = () => cmd.toggleColumn();
    $('bLogi').onclick = () => cmd.toggleLogistics();
    $('bRaiseR').onclick = () => cmd.raise('art');
    $('bStop').onclick = cmd.halt;
    $('bSplit').onclick = cmd.split;
    $('bMerge').onclick = cmd.merge;
    $('bAgain').onclick = cmd.again;
    $('bMenu').onclick = cmd.leave;
  }

  /** Fill the static help copy with the live balance constants so a rebalance never leaves stale numbers. */
  function initHelp() {
    const pct = v => Math.round(v * 100) + '%';
    const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    set('hLogDist', LOGISTICS_DISTANCE);
    set('hReinforce', REINFORCE_RATE);
    set('hRoadGold', ROAD_GOLD);
    set('hRoadSpeed', ROAD_SPEED);
    set('hRoadLogi', pct(ROAD_LOGISTICS_COST));
    set('hRoutPct', pct(ROUT_FRAC));
    set('hRecoverPct', pct(ROUT_RECOVER_FRAC));
    set('hRoutRange', ROUT_MIN_DISTANCE + '-' + ROUT_MAX_DISTANCE);
    set('hPush', PUSH_BASE);
    set('hCol', COLUMN_SPACING);
    set('hFortRange', FORT_RANGE);
    set('hFortRed', pct(1 - FORT_DEF));
    set('hIsoOut', pct(ISOLATED_COMBAT));
  }
  initHelp();

  function toggleHelp() {
    const h = $('help');
    h.style.display = h.style.display === 'none' ? '' : 'none';
  }

  return { toast, onEvent, refresh, hideEnd, bindButtons, toggleHelp, onCede: cedeToast };
}
