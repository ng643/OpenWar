import { nearestLand } from '../sim/pathfinding.js';
import { centerOn } from './camera.js';
import { resolvePending, cedeAllies, cedeCount } from './ui-state.js';
import { BUILDINGS, MAX_ROUTE_POINTS, ROAD_GOLD, MERGE_RANGE, MERGE_STACK, SPLIT_MIN_MEN, TYPES } from '../config.js';

/**
 * A division the sim will actually act on: still alive, not already absorbed by a merge, and free of
 * the combat states that block both split and merge — engaged, routing, and cornered (routLocked).
 */
const freeUnit = d => !!d && !d.merged && d.men > 0 && !d.eng && !d.routing && !d.routLocked;
const MERGE_R2 = MERGE_RANGE * MERGE_RANGE;
const NEEDS_TWO = 'Merging needs two or more free divisions of the same type - engaged, routing or cornered ones cannot merge';

/**
 * Why this selection cannot merge, or null when at least one merge would land. The UI must never
 * promise more than the sim delivers: merging only joins two free detachments of the same owner and
 * type, within MERGE_RANGE tiles, whose men AND capacity together still fit MERGE_STACK atomics of
 * that type (infantry 1000, armor 900, artillery 600). Anything that does not fit stays separate,
 * so this only needs to find one such pair; the selection is bucketed per owner+type so the pair
 * scan never compares unrelated divisions.
 */
export function mergeBlock(sel) {
  const groups = new Map();
  let free = 0;
  for (const d of sel) {
    if (!freeUnit(d)) continue;
    free++;
    const key = d.owner + '|' + d.type, g = groups.get(key);
    if (g) g.push(d); else groups.set(key, [d]);
  }
  if (free < 2) return NEEDS_TWO;
  let sameType = false;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    sameType = true;
    const lim = TYPES[g[0].type].men * MERGE_STACK;
    for (let i = 0; i < g.length; i++) {
      const a = g[i];
      for (let j = i + 1; j < g.length; j++) {
        const b = g[j];
        if (a.men + b.men > lim || a.cap + b.cap > lim) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx * dx + dy * dy > MERGE_R2) continue;
        return null;
      }
    }
  }
  if (!sameType) return NEEDS_TWO;
  return 'Merging only joins same-type divisions within ' + MERGE_RANGE +
    ' tiles while their men and capacity still fit ' + MERGE_STACK + ' atomic units - the rest stay separate';
}

/** Why the selection cannot split, or null when at least one division would peel an atomic off. */
export function splitBlock(sel) {
  let free = false, single = false;
  for (const d of sel) {
    if (!freeUnit(d)) continue;
    if (d.men > TYPES[d.type].men && d.cap > TYPES[d.type].men) return null;
    if (d.men >= SPLIT_MIN_MEN) single = true;
    free = true;
  }
  if (single) return 'Splitting peels one atomic unit off a stack: a single atomic cannot split further';
  return free
    ? 'A division needs more than one atomic unit to split'
    : 'Splitting needs a free division - engaged, routing or cornered ones cannot split';
}

/**
 * Player-facing actions shared by keyboard, mouse and HUD buttons.
 * Each one reads the current selection from app.ui and sends a command object through
 * app.session, which applies it locally (single player) or ships it to the server (multiplayer).
 * Command format: see src/sim/commands.js.
 */
export function createCommands(app, hud) {
  const ui = app.ui;
  const selected = () => [...ui.sel];
  const ids = () => selected().map(d => d.id);
  const send = c => app.session && app.session.send(c);
  const net = () => app.session && app.session.kind === 'net';
  let cedeSentTo = 0;         // recipient of the newest cede command: the result carries no `to` back

  // A spectator (playerId 0) owns no faction: orders, building and recruitment are all refused.
  let lastBlock = 0;
  function canAct() {
    if (app.world && app.me > 0) return true;
    const now = performance.now();
    if (now - lastBlock > 3000) { lastBlock = now; hud.toast('Spectating - only the camera is yours to move', 'bad'); }
    return false;
  }

  function ping(x, y) {
    ui.pings.push({ x, y, t: performance.now(), c: '#ffffff' });
  }

  /** Exactly the wire shape: min..MAX_ROUTE_POINTS [x,y] finite pairs. Returns null when malformed. */
  function cleanPoints(points, min = 1) {
    if (!Array.isArray(points) || points.length < min || points.length > MAX_ROUTE_POINTS) return null;
    const out = [];
    for (const p of points) {
      if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      out.push([p[0], p[1]]);
    }
    return out;
  }

  const cmd = {
    ping,

    raise(type) {
      if (!canAct()) return;
      send({ k: 'raise', type, city: ui.selCity ? app.world.cities.indexOf(ui.selCity) : -1 });
    },
    halt() { if (ui.sel.size && canAct()) send({ k: 'halt', ids: ids() }); },
    split() {
      if (!canAct() || !ui.sel.size) return;
      const why = splitBlock(ui.sel);
      if (why) { hud.toast(why); return; }
      send({ k: 'split', ids: ids() });
    },
    merge() {
      if (!canAct() || !ui.sel.size) return;
      const why = mergeBlock(ui.sel);
      if (why) { hud.toast(why); return; }
      send({ k: 'merge', ids: ids() });
    },

    /** Result of a split/merge: from the local sim immediately, or from the server a moment later. */
    onResult(r) {
      if (!r || !r.ok) return;
      if (r.k === 'cede') { hud.onCede(app.me, cedeSentTo, r.ceded | 0); return; }
      if (r.k === 'split') {
        if (r.added && !r.added.length) hud.toast('Nothing split: a stack needs more than one atomic unit and a free spot beside it');
        ui.pendingSelect = { ids: r.added, until: performance.now() + 3000 };
        resolvePending(ui, app.world);
      } else if (r.k === 'merge' && !(r.absorbed && r.absorbed.length)) {
        hud.toast('Nothing merged: divisions must be the same type, within ' + MERGE_RANGE +
          ' tiles, and their men and capacity must still fit ' + MERGE_STACK + ' atomic units');
      }
    },

    /** Move order for the current selection (or rally point if a city is selected). */
    order(wx, wy) {
      if (!app.world || !canAct()) return;
      if (ui.sel.size) {
        send({ k: 'move', ids: ids(), x: wx, y: wy });
        ping(wx, wy);
      } else if (ui.selCity && ui.selCity.owner === app.me) {
        const t = nearestLand(app.world, wx, wy);
        if (t >= 0) {
          send({ k: 'rally', city: app.world.cities.indexOf(ui.selCity), x: wx, y: wy });
          ui.selCity.rally = t;       // optimistic: snapshots do not carry rally points
          hud.toast('Rally point set'); ping(wx, wy);
        }
      }
    },

    /** Formation order: spread the selection evenly along the polyline (2 points = straight). */
    formation(points) {
      if (!ui.sel.size || !canAct()) return;
      send({ k: 'formation', ids: ids(), points });
    },

    // --- multipoint routes & columns ---
    /**
     * Route order: one or more checkpoints the selection visits in order.
     * `append` adds bends to the route already queued; without it the route replaces any old one.
     * `column` orders the selection to travel single file along it (Column mode, C).
     */
    route(points, { append = false, column = false } = {}) {
      if (!ui.sel.size || !canAct()) return;
      const pts = cleanPoints(points);
      if (!pts) return;
      send({ k: 'route', ids: ids(), points: pts, append, column });
      const last = pts[pts.length - 1];
      ping(last[0], last[1]);
    },
    /** Column mode (C) makes the next right-click a single-file route instead of a plain move. */
    toggleColumn() {
      if (!canAct()) return;
      ui.column = !ui.column;
      hud.toast(ui.column
        ? 'Column mode: right-click routes the selection single file; Shift+right-click bends that route'
        : 'Column mode off: right-click moves the selection normally', ui.column ? 'good' : '');
    },

    // --- road tool (B) ---
    /** Open (or close) the road tool: click start, Shift+click bends, click end or Enter to build. */
    startRoad() {
      if (!canAct()) return;
      if (ui.road) { cmd.cancelRoad(); return; }
      cmd.cancelBuild();
      cmd.cancelCede();                     // road/cede are mutually exclusive drawing tools
      ui.road = { pts: [], tiles: null, cost: 0, valid: false, afford: true, hover: -1, cx: 0, cy: 0, key: '' };
      hud.toast('Road: click a start tile, Shift+click bends, click the end tile or Enter to build ('
        + ROAD_GOLD + 'g per new tile, your own land only) - right-click or Esc cancels');
    },
    cancelRoad() { ui.road = null; },
    /** Commit a checked road sketch (points are [x,y] tile pairs; input validated it with roadTiles). */
    road(points) {
      if (!canAct()) return;
      const pts = cleanPoints(points, 2);
      if (!pts) return;
      send({ k: 'road', points: pts });
      const last = pts[pts.length - 1];
      ping(last[0] + .5, last[1] + .5);
    },

    // --- building ---
    /** Toggle placement mode for a building type (Esc / right-click leaves it). */
    startBuild(type) {
      if (!BUILDINGS[type] || !canAct()) return;
      ui.road = null;                       // build mode and the road tool are mutually exclusive
      cmd.cancelCede();
      ui.build = ui.build === type ? null : type;
      ui.paint = [];
      if (ui.build) hud.toast(BUILDINGS[type].name + ': ' + (type === 'farm' ? 'click or drag over your land' : 'click a spot near one of your cities') + ' - right-click to stop');
    },
    cancelBuild() { ui.build = null; ui.paint = []; },
    placeBuildings(tiles) {
      if (ui.build && tiles.length && canAct()) send({ k: 'build', type: ui.build, tiles });
    },

    // --- cede (G) ---
    /**
     * Toggle the Cede tool: drag a rectangle over your own land (a plain click marks one tile) to
     * preview it, choose the teammate and confirm with Enter or the button. One command per area -
     * the rectangle stays preview-only until then, and the actual transfer is decided by the sim.
     * Peaceful: only ownership moves; cities, farms/factories/fortresses (even unfinished ones),
     * roads and divisions all stay as they are, and the divisions stay under your command.
     */
    startCede() {
      if (!canAct()) return;
      if (ui.cede) { cmd.cancelCede(); return; }
      const allies = cedeAllies(app.world, app.me);
      if (!allies.length) {
        hud.toast('Nobody to cede land to - ceding needs a living teammate (set up teams, or join a team game)', 'bad');
        return;
      }
      cmd.cancelBuild();
      cmd.cancelRoad();
      ui.cede = { to: allies[0].id, rect: null, count: 0, anchor: null };
      hud.toast('Cede: drag a rectangle over your own land (a click marks one tile), then press Enter to hand it to ' +
        allies[0].name + '. Free and peaceful: nothing is destroyed - cities, farms, factories, fortresses (even unfinished ones) and roads on that land change hands intact, while your divisions stay yours - right-click or Esc cancels');
    },
    cancelCede() { ui.cede = null; },
    /** Pick the teammate that receives the land; ids that are no longer a living ally are ignored. */
    cedeTarget(id) {
      const c = ui.cede;
      if (!c || !canAct()) return;
      if (!cedeAllies(app.world, app.me).some(p => p.id === id)) return;
      c.to = id;
    },
    /** Send the previewed rectangle as ONE command; only tiles you own move, and the sim re-checks. */
    cedeConfirm() {
      const c = ui.cede;
      if (!c || !canAct()) return;
      const allies = cedeAllies(app.world, app.me);
      if (!allies.length) { hud.toast('Nobody to cede land to anymore', 'bad'); return; }
      if (!allies.some(p => p.id === c.to)) c.to = allies[0].id;
      if (!c.rect) { hud.toast('Cede: mark an area on your own land first - drag a rectangle or click a tile', 'bad'); return; }
      if (!cedeCount(app.world, app.me, c.rect)) { hud.toast('No land of yours inside that area - nothing to cede', 'bad'); return; }
      cedeSentTo = c.to;
      send({ k: 'cede', to: c.to, rect: c.rect.slice() });
      c.rect = null; c.count = 0; c.anchor = null;
    },

    // --- selection ---
    clearSelection() {
      if (ui.cede) { cmd.cancelCede(); return; }
      if (ui.build) { cmd.cancelBuild(); return; }
      if (ui.road) { cmd.cancelRoad(); return; }
      ui.sel.clear(); ui.selCity = null;
    },
    selectAll() {
      if (!canAct()) return;
      cmd.cancelRoad();                     // a fresh selection drops any pending road sketch
      ui.sel.clear(); for (const d of app.world.divs) if (d.owner === app.me) ui.sel.add(d); ui.selCity = null;
    },
    selectOnScreen() {
      if (!canAct()) return;
      const cam = app.camera; ui.sel.clear(); ui.selCity = null;
      for (const d of app.world.divs) {
        if (d.owner !== app.me) continue;
        const x = (d.x - cam.x) * cam.z, y = (d.y - cam.y) * cam.z;
        if (x >= 0 && y >= 0 && x <= cam.vw && y <= cam.vh) ui.sel.add(d);
      }
    },
    setGroup(k) { if (!canAct()) return; ui.groups[k] = selected(); hud.toast('Group ' + k + ' set (' + ui.sel.size + ')'); },
    recallGroup(k) {
      const g = ui.groups[k];
      if (!g || !g.length || !canAct()) return;
      cmd.cancelRoad();
      const same = ui.sel.size === g.length && g.every(d => ui.sel.has(d));
      ui.sel = new Set(g); ui.selCity = null;
      if (same) cmd.focus();
    },

    // --- view / game flow ---
    focus() {
      if (!app.world) return;
      const list = ui.sel.size ? selected() : [app.world.cities.find(c => c.owner === app.me && c.capital) || app.world.cities[0]];
      let x = 0, y = 0;
      for (const d of list) { x += d.x; y += d.y; }
      centerOn(app.camera, x / list.length + .5, y / list.length + .5);
    },
    toggleFog() {
      if (app.me <= 0) { hud.toast('Spectators always see the whole map'); return; }
      if (net()) { hud.toast('Fog of war is always on in multiplayer'); return; }
      ui.fog = !ui.fog; hud.toast('Fog of war ' + (ui.fog ? 'on' : 'off'));
    },
    /** Logistics overlay (O): real supply paths and per-division damage output. A pure view toggle, open to spectators too. */
    toggleLogistics() {
      if (!app.world) return;
      ui.logistics = !ui.logistics;
      hud.toast(ui.logistics
        ? 'Logistics overlay on: each division\'s supply path and its current fighting effectiveness (O)'
        : 'Logistics overlay off', ui.logistics ? 'good' : '');
    },
    togglePause() { if (!net()) ui.paused = !ui.paused; },
    setSpeed(n) { if (!net()) { ui.speed = n; ui.paused = false; } },
    /** End-screen primary button: new local game, or (host only) rematch in the same room. */
    again() { if (app.session) app.session.again(); },
    /** Back to the main menu. */
    leave() { app.leave(); }
  };
  return cmd;
}
