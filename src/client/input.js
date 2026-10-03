import { clampCamera, toWorld, zoomAt, centerOn } from './camera.js';
import { tileX, tileY } from '../sim/geom.js';
import { rectOf, cedeCount } from './ui-state.js';
import { canBuild, nearOwnCity } from '../sim/buildings.js';
import { formationSlots, MAX_FORMATION_POINTS } from '../sim/formations.js';
import { roadTiles } from '../sim/roads.js';
import { ROAD_GOLD, WATER, MAX_ROUTE_POINTS } from '../config.js';

/** Wire mouse + keyboard on the main canvas and minimap to player commands. */
export function attachInput(app, cmd, hud, canvas, mini) {
  const ui = app.ui, cam = app.camera;
  const mouse = { down: false, mid: false, paint: false, last: -1, sx: 0, sy: 0, cx: 0, cy: 0 };
  const keys = {};
  app.keys = keys;   // polled by the main loop for WASD/arrow panning

  function pickDiv(px, py) {
    if (app.me <= 0) return null;                    // spectators own nothing to select
    const [wx, wy] = toWorld(cam, px, py);
    let best = null, bd = Math.max(1.0, 14 / cam.z);
    for (const d of app.world.divs) {
      if (d.owner !== app.me) continue;
      const dd = Math.hypot(d.x - wx, d.y - wy);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }
  function pickCity(px, py) {
    if (app.me <= 0) return null;
    const [wx, wy] = toWorld(cam, px, py);
    for (const c of app.world.cities) {
      if (c.owner === app.me && Math.hypot(c.x + .5 - wx, c.y + .5 - wy) < Math.max(.9, 12 / cam.z)) return c;
    }
    return null;
  }

  // ---------- building placement ----------
  const tileAt = (px, py) => {
    const w = app.world, [wx, wy] = toWorld(cam, px, py), x = Math.floor(wx), y = Math.floor(wy);
    return x < 0 || y < 0 || x >= w.w || y >= w.h ? -1 : y * w.w + x;
  };
  /** Collect a tile (and, for farms, every tile on the straight line since the last one) into the current paint. */
  function paintTo(t) {
    if (t < 0 || !ui.build) return;
    const world = app.world, farm = ui.build === 'farm', tiles = [];
    if (farm && mouse.last >= 0) {
      let x0 = tileX(world, mouse.last), y0 = tileY(world, mouse.last);
      const x1 = tileX(world, t), y1 = tileY(world, t);
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy;
      for (;;) {
        tiles.push(y0 * world.w + x0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
      }
    } else tiles.push(t);
    mouse.last = t;
    for (const q of tiles) {
      if (ui.paint.length >= 80 || ui.paint.includes(q)) continue;
      if (canBuild(app.world, app.me, ui.build, q)) ui.paint.push(q);
    }
  }
  function finishPaint() {
    mouse.paint = false; mouse.last = -1;
    if (!ui.build) { ui.paint = []; return; }
    if (ui.paint.length) cmd.placeBuildings(ui.paint);
    else if (ui.hover >= 0) {
      const w = app.world;
      hud.toast(w.owner[ui.hover] !== app.me ? 'You can only build on your own land'
        : w.terr[ui.hover] !== 1 || w.cityAt[ui.hover] >= 0 || w.bld[ui.hover] ? 'That tile is not free'
        : !nearOwnCity(w, app.me, ui.hover) ? 'Must be within 5 tiles of one of your cities' : 'Cannot build there', 'bad');
    }
    ui.paint = [];
  }

  // ---------- road tool (B) ----------
  // The sketch itself lives on ui.road (ui-state) so renderer/HUD can show it and every click path can
  // drop it. Geometry is cached under a fingerprint of every input roadTiles reads - the world's
  // ownership and road revisions, the player and the effective polyline - so the open sketch can be
  // re-checked on the HUD cadence: pathfinding runs only when one of those changed, while affordability
  // follows the player's current gold on every call.
  const roadPoint = (px, py) => {
    const [wx, wy] = toWorld(cam, px, py);
    return [Math.max(0, Math.min(app.world.w - 1, Math.floor(wx))), Math.max(0, Math.min(app.world.h - 1, Math.floor(wy)))];
  };
  const roadCost = tiles => { let n = 0; for (const t of tiles) if (!app.world.roads[t]) n++; return n * ROAD_GOLD; };
  /** FNV-1a fingerprint of the sketch's routing inputs: the numbers roadTiles actually reads. */
  function roadStamp(w, pts, liveX, liveY) {
    let h = 2166136261;
    h = Math.imul(h ^ w.ownerVersion, 16777619);
    h = Math.imul(h ^ w.roadVersion, 16777619);
    h = Math.imul(h ^ app.me, 16777619);
    h = Math.imul(h ^ pts.length, 16777619);
    for (const p of pts) { h = Math.imul(h ^ p[0], 16777619); h = Math.imul(h ^ p[1], 16777619); }
    h = Math.imul(h ^ (liveX + 1), 16777619);
    h = Math.imul(h ^ (liveY + 1), 16777619);
    return h >>> 0;
  }
  /** Refresh the open road sketch: re-route only when its inputs changed, re-price against gold always. */
  function roadPreview() {
    const r = ui.road; if (!r || !app.world) return;
    const w = app.world;
    const liveX = r.hover >= 0 ? r.cx : -1, liveY = r.hover >= 0 ? r.cy : -1;
    const stamp = roadStamp(w, r.pts, liveX, liveY);
    if (stamp !== r.key) {                           // ownership, roads, player or polyline changed: re-route
      r.key = stamp;
      const last = r.pts[r.pts.length - 1];
      const pts = liveX >= 0 && (!last || last[0] !== liveX || last[1] !== liveY)
        ? r.pts.concat([[liveX, liveY]]) : r.pts;
      if (pts.length < 2) { r.tiles = null; r.cost = 0; r.valid = false; }
      else {
        const tiles = roadTiles(w, app.me, pts);
        r.tiles = tiles;
        r.valid = !!tiles;
        r.cost = tiles ? roadCost(tiles) : 0;
      }
    }
    const p = w.players[app.me - 1];                 // gold moves without any input event: re-price every call
    r.afford = !p || p.gold < 0 || r.cost <= p.gold;
  }
  app.roadPreview = roadPreview;                     // the HUD cadence keeps a stationary sketch fresh
  /** Commit the current committed sketch (Enter, or the endpoint click after it pushed its point). */
  function roadCommit() {
    const r = ui.road; if (!r) return false;
    if (r.pts.length < 2) {
      hud.toast('Road: click a start tile, Shift+click any bends, then click the end tile (or press Enter)', 'bad');
      return false;
    }
    const tiles = roadTiles(app.world, app.me, r.pts);
    if (!tiles) { hud.toast('No road route there - every tile of it must be your own land', 'bad'); return false; }
    const cost = roadCost(tiles), p = app.world.players[app.me - 1];
    if (p && p.gold >= 0 && cost > p.gold) {
      hud.toast('Not enough gold for that road: ' + cost + 'g needed', 'bad');
      return false;
    }
    cmd.road(r.pts);
    r.pts = []; r.tiles = null; r.cost = 0; r.valid = false; r.afford = true;
    return true;                                     // tool stays open so several roads can be chained
  }

  // ---------- right-drag formation ----------
  // While the right button is down over a selection we freeze the press point and build the preview
  // from the cursor, so a plain click still issues an ordinary move order. Holding Ctrl latches a
  // freehand mode: world samples are collected as the pointer moves and formed into a polyline.
  const form = {
    active: false, world: null, snap: null, curved: false, dragged: false,
    sx0: 0, sy0: 0,
    pts: [], lx: 0, ly: 0   // curved world samples + last sampled screen position (4px sampling threshold)
  };
  // Same clamp as src/sim/formations.js so the preview geometry matches the order the sim will use.
  const clampX = v => Math.max(0, Math.min(app.world.w - 1, v)), clampY = v => Math.max(0, Math.min(app.world.h - 1, v));
  const worldAt = (px, py) => { const [wx, wy] = toWorld(cam, px, py); return [clampX(wx), clampY(wy)]; };
  // Once the pointer travels 6px the gesture counts as a drag even if a later loop returns near the press point.
  const dragTest = (x, y) => { const dx = x - form.sx0, dy = y - form.sy0; return dx * dx + dy * dy >= 36; };
  const sameSelection = () => {
    if (!form.snap || ui.sel.size !== form.snap.length) return false;
    for (const d of form.snap) if (!ui.sel.has(d)) return false;
    return true;
  };
  /** The gesture is still valid only while the same world, selection and mode are in play. */
  const formAlive = () => form.active && app.world === form.world && !ui.build && !ui.road && !ui.cede && sameSelection();

  function cancelForm() { form.active = false; form.world = null; form.snap = null; form.pts = []; ui.formation = null; }

  /** Halve the retained interior samples at the shared point cap, keeping both ends and whole shape. */
  function compactPts() {
    const src = form.pts;
    if (src.length <= 3) return;                            // too short to shrink further
    const out = [src[0]];
    for (let i = 1; i < src.length - 1; i += 2) out.push(src[i]);
    out.push(src[src.length - 1]);
    if (out.length < src.length) form.pts = out;
  }

  /** Store a freehand sample after ~4 screen px of travel, deduplicating identical clamped positions. */
  function sampleCurved(px, py) {
    const p = worldAt(px, py), n = form.pts.length;
    if (n && form.pts[n - 1][0] === p[0] && form.pts[n - 1][1] === p[1]) return;
    if (n && Math.hypot(px - form.lx, py - form.ly) < 4) return;
    form.pts.push(p); form.lx = px; form.ly = py;
    while (form.pts.length > 3 && form.pts.length + 1 > MAX_FORMATION_POINTS) compactPts();
  }

  /** The polyline shown/sent: retained samples plus the always-live cursor endpoint, capped for transport. */
  function formPoints(live) {
    let pts = form.curved ? form.pts.slice() : [form.pts[0]];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== live[0] || last[1] !== live[1]) pts.push(live);
    while (pts.length > MAX_FORMATION_POINTS) {
      const out = [pts[0]];
      for (let i = 1; i < pts.length - 1; i += 2) out.push(pts[i]);
      out.push(pts[pts.length - 1]);
      if (out.length >= pts.length) break;                  // cannot shrink further: keep following the cursor
      pts = out;
    }
    if (pts.length < 2) pts.push([pts[0][0], pts[0][1]]);   // degenerate shape stays a valid 2-point command
    return pts;
  }

  /** Recompute the preview polyline from the gesture and the current cursor position. */
  function refreshForm(px, py) {
    if (!dragTest(px, py) && !form.dragged) { ui.formation = null; return; }
    form.dragged = true;
    const points = formPoints(worldAt(px, py));
    ui.formation = { points, slots: formationSlots(app.world, [...ui.sel], points) };
  }

  // ---------- main canvas ----------
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('mousedown', e => {
    if (!app.world) return;
    if (ui.build) {
      if (e.button === 0) {
        mouse.paint = true; mouse.last = -1; ui.paint = []; ui.hover = tileAt(e.clientX, e.clientY); paintTo(ui.hover);
        return;
      }
      if (e.button === 2) { cancelForm(); cmd.cancelBuild(); return; }
    }
    if (app.me <= 0 && (e.button === 0 || e.button === 2)) return;   // spectator: camera only (middle drag still pans)
    if (ui.cede && e.button !== 1) {                 // cede tool owns left/right clicks until it closes (middle still pans)
      if (e.button === 2) { cmd.cancelCede(); return; }
      if (e.button !== 0) return;
      const c = ui.cede, p = roadPoint(e.clientX, e.clientY);
      c.anchor = p;                                  // press marks a corner; a plain click marks exactly this tile
      c.rect = [p[0], p[1], p[0], p[1]];
      c.count = cedeCount(app.world, app.me, c.rect);
      return;
    }
    if (ui.road && e.button !== 1) {                 // road tool owns left/right clicks until it closes (middle still pans)
      if (e.button === 2) { cmd.cancelRoad(); return; }
      if (e.button !== 0) return;
      const r = ui.road, p = roadPoint(e.clientX, e.clientY), w = app.world;
      if (!r.pts.length) {
        if (w.owner[p[1] * w.w + p[0]] !== app.me || w.terr[p[1] * w.w + p[0]] === WATER) {
          hud.toast('Roads can only start on your own land', 'bad');
          return;
        }
        r.pts.push(p); roadPreview();
        return;
      }
      const last = r.pts[r.pts.length - 1];
      if (last[0] === p[0] && last[1] === p[1]) return;   // same tile as the last sketch point: ignore
      if (e.shiftKey) {                                  // Shift: add a bend, no commit
        if (r.pts.length >= MAX_ROUTE_POINTS) { hud.toast('Road sketch is full (' + MAX_ROUTE_POINTS + ' points)', 'bad'); return; }
        r.pts.push(p); roadPreview();
        return;
      }
      if (r.pts.length >= MAX_ROUTE_POINTS) { hud.toast('Road sketch is full (' + MAX_ROUTE_POINTS + ' points)', 'bad'); return; }
      r.pts.push(p);                                    // ordinary click: the endpoint
      if (!roadCommit()) { r.pts.pop(); roadPreview(); }
      return;
    }
    if (form.active) {
      if (e.buttons & 2) return;       // the right button is still held: this drag owns the mouse
      cancelForm();                    // its release was missed (pointer left the window): drop the stale drag
    }
    if (e.button === 0) { mouse.down = true; mouse.sx = e.clientX; mouse.sy = e.clientY; }
    else if (e.button === 1) { mouse.mid = true; mouse.cx = e.clientX; mouse.cy = e.clientY; e.preventDefault(); }
    else if (e.button === 2) {
      if (!ui.sel.size) {              // nothing selected, or a city (rally point): unchanged immediate order
        const [wx, wy] = toWorld(cam, e.clientX, e.clientY);
        cmd.order(wx, wy);
        return;
      }
      mouse.down = false; ui.dragBox = null; mouse.mid = false;   // no simultaneous box-select / pan
      const [wx, wy] = toWorld(cam, e.clientX, e.clientY);
      form.active = true; form.world = app.world; form.snap = [...ui.sel];
      form.curved = e.ctrlKey;         // latch freehand mode at press time
      form.dragged = false;
      form.sx0 = e.clientX; form.sy0 = e.clientY;
      form.pts = [[clampX(wx), clampY(wy)]];
      form.lx = e.clientX; form.ly = e.clientY;
    }
  });

  window.addEventListener('mousemove', e => {
    if (form.active) {
      if (!(e.buttons & 2)) cancelForm();   // right button gone without a mouseup (focus loss): no order
      else if (!formAlive()) cancelForm();
      else {
        if (form.curved) sampleCurved(e.clientX, e.clientY);
        refreshForm(e.clientX, e.clientY);  // geometry is recomputed only here, never per frame
      }
    }
    if (app.world && ui.build) {
      ui.hover = e.target === canvas ? tileAt(e.clientX, e.clientY) : -1;
      if (mouse.paint && ui.build === 'farm') paintTo(ui.hover);
    }
    if (app.world && ui.road) {                    // preview refresh on input events only
      const r = ui.road;
      if (e.target === canvas) {
        r.hover = tileAt(e.clientX, e.clientY);
        if (r.hover >= 0) { const [cx, cy] = roadPoint(e.clientX, e.clientY); r.cx = cx; r.cy = cy; }
      } else r.hover = -1;
      roadPreview();
    }
    if (app.world && ui.cede && ui.cede.anchor) {  // drag the rectangle corner to corner; edges clamp to the map
      const c = ui.cede, p = roadPoint(e.clientX, e.clientY);
      c.rect = rectOf(c.anchor[0], c.anchor[1], p[0], p[1]);
      c.count = cedeCount(app.world, app.me, c.rect);
    }
    if (mouse.mid) {
      cam.x -= (e.clientX - mouse.cx) / cam.z; cam.y -= (e.clientY - mouse.cy) / cam.z;
      mouse.cx = e.clientX; mouse.cy = e.clientY; clampCamera(cam);
    }
    if (mouse.down && (Math.abs(e.clientX - mouse.sx) > 5 || Math.abs(e.clientY - mouse.sy) > 5)) {
      ui.dragBox = { x0: mouse.sx, y0: mouse.sy, x1: e.clientX, y1: e.clientY };
    }
    if (miniDrag) miniGo(e);
  });

  window.addEventListener('mouseup', e => {
    if (e.button === 2 && form.active) {
      const live = formAlive(), dragged = form.dragged || dragTest(e.clientX, e.clientY);
      const start = form.pts[0];
      const points = dragged ? formPoints(worldAt(e.clientX, e.clientY)) : null;
      cancelForm();
      if (!live) return;                                   // session/world changed, selection lost, build mode entered
      if (dragged) cmd.formation(points);
      else if (e.shiftKey) cmd.route([[start[0], start[1]]], { append: true, column: ui.column });  // add a checkpoint
      else if (ui.column) cmd.route([[start[0], start[1]]], { column: true });                     // single-file move
      else cmd.order(start[0], start[1]);                    // plain click: original press point
      return;
    }
    if (e.button === 1) mouse.mid = false;
    if (e.button === 0) miniDrag = false;
    if (e.button === 0 && ui.cede) {               // release keeps the preview: only the drag anchor drops
      ui.cede.anchor = null;
      mouse.down = false; ui.dragBox = null;       // the cede rectangle owns the gesture, not the box-select
      return;
    }
    if (e.button === 0 && mouse.paint) { finishPaint(); return; }
    if (e.button !== 0 || !mouse.down) return;
    mouse.down = false;
    if (!app.world) { ui.dragBox = null; return; }
    if (ui.dragBox) {
      const b = ui.dragBox;
      const [ax, ay] = toWorld(cam, Math.min(b.x0, b.x1), Math.min(b.y0, b.y1));
      const [bx, by] = toWorld(cam, Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
      if (!e.shiftKey) ui.sel.clear();
      for (const d of app.world.divs) if (d.owner === app.me && d.x >= ax && d.x <= bx && d.y >= ay && d.y <= by) ui.sel.add(d);
      ui.selCity = null; ui.dragBox = null;
    } else {
      const d = pickDiv(e.clientX, e.clientY);
      if (d) {
        if (e.shiftKey) { ui.sel.has(d) ? ui.sel.delete(d) : ui.sel.add(d); } else { ui.sel.clear(); ui.sel.add(d); }
        ui.selCity = null;
      } else {
        const c = pickCity(e.clientX, e.clientY);
        if (c) { ui.sel.clear(); ui.selCity = c; }
        else if (!e.shiftKey) cmd.clearSelection();
      }
    }
  });

  canvas.addEventListener('dblclick', e => {
    if (app.world && !ui.build && !ui.road && !ui.cede && pickDiv(e.clientX, e.clientY)) cmd.selectOnScreen();
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(cam, e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    if (form.active) {                                     // zoom moves the live endpoint under the fixed cursor
      if (!formAlive()) cancelForm();
      else { refreshForm(e.clientX, e.clientY); }            // recompute only: no extra samples
    }
  }, { passive: false });

  // ---------- minimap ----------
  let miniDrag = false;
  const miniPoint = e => {
    const r = mini.getBoundingClientRect();
    return [(e.clientX - r.left) * app.world.w / r.width, (e.clientY - r.top) * app.world.h / r.height];
  };
  function miniGo(e) { const [wx, wy] = miniPoint(e); centerOn(cam, wx, wy); }
  mini.addEventListener('contextmenu', e => e.preventDefault());
  mini.addEventListener('mousedown', e => {
    if (!app.world) return;
    if (e.button === 0) { miniDrag = true; miniGo(e); }
    else if (e.button === 2) {
      if (ui.cede) { cmd.cancelCede(); return; }   // a stray right-click never fires an order through the preview
      const [wx, wy] = miniPoint(e); cmd.order(wx, wy);
    }
  });

  // ---------- keyboard ----------
  window.addEventListener('keydown', e => {
    if (!app.world || e.target.tagName === 'INPUT') return;     // menu is open / typing in a text field
    const k = e.key.toLowerCase();
    if (e.repeat && !/^arrow|^[wasd]$/.test(k)) return;
    keys[k] = true;
    if (k === 'escape') {
      if (form.active) cancelForm();
      else if (ui.cede) cmd.cancelCede();
      else if (ui.road) cmd.cancelRoad();
      else cmd.clearSelection();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k !== 'a' && !/^[1-9]$/.test(k)) return;      // leave browser shortcuts alone
    if (k === 'enter') {
      if (ui.road) { e.preventDefault(); roadCommit(); return; }
      if (ui.cede) { e.preventDefault(); cmd.cedeConfirm(); }
      return;
    }
    if (mod && k === 'a') { e.preventDefault(); cmd.selectAll(); return; }
    if (/^[1-9]$/.test(k)) {
      if (mod) { e.preventDefault(); cmd.setGroup(k); } else cmd.recallGroup(k);
      return;
    }
    switch (k) {
      case ' ': e.preventDefault(); cmd.togglePause(); break;
      case 'r': cmd.raise('inf'); break;
      case 't': cmd.raise('arm'); break;
      case 'y': cmd.raise('art'); break;
      case 'b': cmd.startRoad(); break;
      case 'g': cmd.startCede(); break;
      case 'c': cmd.toggleColumn(); break;
      case 'j': cmd.startBuild('farm'); break;
      case 'k': cmd.startBuild('factory'); break;
      case 'l': cmd.startBuild('fortress'); break;
      case 'h': cmd.halt(); break;
      case 'x': cmd.split(); break;
      case 'm': cmd.merge(); break;
      case 'f': cmd.focus(); break;
      case 'v': cmd.toggleFog(); break;
      case 'o': cmd.toggleLogistics(); break;
      case '/': case '?': hud.toggleHelp(); break;
    }
  });
  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
  });
  window.addEventListener('blur', () => {                 // tab/window switch drops the pending drag and road sketch
    if (form.active) cancelForm();
    if (ui.road) cmd.cancelRoad();
    if (ui.cede) cmd.cancelCede();
  });
}
