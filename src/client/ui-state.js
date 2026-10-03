/** Everything the player's UI remembers that is not part of the simulation. */
export function createUIState() {
  return {
    sel: new Set(),      // selected divisions
    selCity: null,       // selected city (mutually exclusive with sel)
    groups: {},          // control groups: key -> division[]
    dragBox: null,       // {x0,y0,x1,y1} in screen px while box-selecting
    pings: [],           // order feedback rings {x,y,t,c}
    pendingSelect: null, // {ids, until}: new divisions (from a split) to select once they exist locally
    build: null,         // building type being placed ('farm' | 'factory' | 'fortress'), or null
    road: null,          // pending road sketch while the Road tool is open: {pts,tiles,cost,valid,afford,hover,cx,cy,key}
    cede: null,          // Cede tool (G): {to, rect:[x0,y0,x1,y1], count, anchor:[x,y]|null} - anchor is set only while dragging
    column: false,       // Column mode (C): a right-click routes the selection single file
    formation: null,     // {points,slots} while right-dragging a formation polyline (Ctrl: freehand)
    hover: -1,           // tile under the cursor (build mode preview)
    paint: [],           // tiles gathered by the current click / drag in build mode
    logistics: false,    // logistics overlay (O): supply paths + per-division damage output
    fog: true,
    paused: false,
    speed: 1
  };
}

export function resetUIState(ui) {
  ui.sel.clear(); ui.selCity = null; ui.groups = {}; ui.dragBox = null; ui.pings.length = 0; ui.pendingSelect = null;
  ui.build = null; ui.road = null; ui.cede = null; ui.column = false; ui.hover = -1; ui.paint = []; ui.formation = null;
  ui.logistics = false;
  ui.paused = false; ui.speed = 1;
}

/** Drop destroyed / merged divisions from the selection and control groups. */
export function pruneSelection(ui, world) {
  const alive = new Set(world.divs);
  for (const d of ui.sel) if (!alive.has(d)) ui.sel.delete(d);
  for (const k of Object.keys(ui.groups)) ui.groups[k] = ui.groups[k].filter(d => alive.has(d));
}

/** Select divisions created by a split as soon as the (possibly remote) world contains them. */
export function resolvePending(ui, world) {
  const p = ui.pendingSelect;
  if (!p) return;
  const want = new Set(p.ids);
  let found = 0;
  for (const d of world.divs) if (want.has(d.id)) { ui.sel.add(d); found++; }
  if (found === want.size || performance.now() > p.until) ui.pendingSelect = null;
}

/** Inclusive [x0,y0,x1,y1] from two dragged corner tiles, so a reversed drag means the same rectangle. */
export function rectOf(ax, ay, bx, by) {
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/**
 * The factions a cession may target: a different player who shares the viewer's configured team and is
 * enabled and alive. Free-for-all settings, spectators and solo players have no such ally.
 */
export function cedeAllies(world, me) {
  const s = world && world.settings;
  if (!world || !s || !s.teams || !(me > 0)) return [];
  const p = world.players[me - 1];
  if (!p || !(p.team >= 1)) return [];
  const out = [];
  for (const q of world.players) {
    if (q.id !== me && q.enabled !== false && q.alive && q.team === p.team) out.push(q);
  }
  return out;
}

/**
 * How many tiles the rectangle would actually move: only the sender's own tiles count, so neutral,
 * enemy and other-ally land is neither previewed as eligible nor ever transferred.
 */
export function cedeCount(world, playerId, rect) {
  if (!world || !rect) return 0;
  const x0 = Math.max(0, rect[0]), y0 = Math.max(0, rect[1]);
  const x1 = Math.min(world.w - 1, rect[2]), y1 = Math.min(world.h - 1, rect[3]);
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * world.w;
    for (let x = x0; x <= x1; x++) if (world.owner[row + x] === playerId) n++;
  }
  return n;
}
