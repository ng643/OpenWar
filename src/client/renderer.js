import { TS, COLORS, TYPES, ART_RANGE, VISION, CITY_VIS, WATER, MOUNTAIN, BUILDINGS, BUILD_IDS, BUILD_RADIUS, FORT_RANGE, DIV_RADIUS } from '../config.js';
import { canBuild } from '../sim/buildings.js';
import { tileX, tileY, tileOf } from '../sim/geom.js';
import { combatMult, logisticsPath } from '../sim/supply.js';

const TAU = Math.PI * 2;

function packColor(hex, a, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) * k | 0, g = ((n >> 8) & 255) * k | 0, b = (n & 255) * k | 0;
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;   // ABGR for little-endian Uint32 views
}
const FILL = [], EDGE = [];
/** Colour of a participant, taken from the world's own roster (classic palette as the fallback). */
function playerColor(world, id) {
  const p = id > 0 && world && world.players ? world.players[id - 1] : null;
  return (p && p.color) || COLORS[(id - 1 + COLORS.length) % COLORS.length] || '#ccc';
}

// Logistics overlay colours: damage output runs from ISOLATED_COMBAT (0.5) up to 1, i.e. 50%..100%.
// The hue and the label text are precomputed once so drawing the overlay allocates nothing per frame
// (an index lookup, never a string concat).
const SUPPLY_STEPS = 51;
const SUPPLY_COLOR = new Array(SUPPLY_STEPS);
const SUPPLY_PCT = new Array(SUPPLY_STEPS);
for (let i = 0; i < SUPPLY_STEPS; i++) {
  const hue = Math.round(i / (SUPPLY_STEPS - 1) * 120);   // 0 = red (cut off) .. 120 = green (full output)
  SUPPLY_COLOR[i] = 'hsl(' + hue + ',72%,52%)';
  SUPPLY_PCT[i] = (50 + i) + '%';
}
const CUT_COLOR = '#ff4a3d';
const CUT_LABEL = '✕ 50%';
const CUT_DASH = [3, 3], NO_DASH = [];   // reused so the per-frame overlay allocates nothing
/** Bucket a combat multiplier (0.5..1) into the precomputed 50..100% colour/label tables. */
function supplyStep(mult) {
  const i = Math.round((mult - 0.5) * 100);
  return i < 0 ? 0 : i > SUPPLY_STEPS - 1 ? SUPPLY_STEPS - 1 : i;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * Draws the world onto `canvas` (main view) and `miniCanvas` (minimap).
 * Reads app.world / app.ui / app.camera / app.alpha; never mutates the sim.
 */
export function createRenderer(app, canvas, miniCanvas) {
  const ctx = canvas.getContext('2d'), mctx = miniCanvas.getContext('2d');
  const cam = app.camera;

  // Layers sized to the world being played: terrain 1px/tile, territory TS px/tile, fog screen-sized.
  let tcv, tctx, ocv, octx, fcv, fcx, oimg, ov;
  const MINI_W = 210;

  function buildLayers(world) {
    tcv = makeCanvas(world.w, world.h); tctx = tcv.getContext('2d');
    ocv = makeCanvas(world.w * TS, world.h * TS); octx = ocv.getContext('2d');
    oimg = octx.createImageData(world.w * TS, world.h * TS); ov = new Uint32Array(oimg.data.buffer);
    fcv = makeCanvas(1, 1); fcx = fcv.getContext('2d');
    const mh = Math.max(1, Math.round(MINI_W * world.h / world.w));   // minimap keeps the map's aspect
    miniCanvas.width = MINI_W; miniCanvas.height = mh;
    miniCanvas.style.height = mh + 'px';
    resize();
  }

  let dpr = 1, VW = 1, VH = 1, seenVersion = -1, lastOverlay = 0;

  const sx = wx => (wx - cam.x) * cam.z;
  const sy = wy => (wy - cam.y) * cam.z;
  const lerpX = d => d.px + (d.x - d.px) * app.alpha;
  const lerpY = d => d.py + (d.y - d.py) * app.alpha;

  function resize() {
    dpr = window.devicePixelRatio || 1; VW = window.innerWidth; VH = window.innerHeight;
    canvas.width = VW * dpr; canvas.height = VH * dpr;
    canvas.style.width = VW + 'px'; canvas.style.height = VH + 'px';
    if (fcv) { fcv.width = canvas.width; fcv.height = canvas.height; }   // layers exist only once a world is set
    cam.vw = VW; cam.vh = VH;
  }

  // ---------- static layers ----------
  function buildTerrainImage(world) {
    const w = world.w, h = world.h;
    const img = tctx.createImageData(w, h), px = img.data;
    for (let i = 0; i < w * h; i++) {
      const e = world.elev[i], jitter = ((Math.imul(i, 2654435761) >>> 24) / 255 - .5) * 8;
      let r, g, b;
      if (world.terr[i] === WATER) {
        const t = Math.max(0, Math.min(1, e / 0.4)); r = 12 + t * 22; g = 36 + t * 50; b = 64 + t * 56;
      } else if (world.terr[i] === MOUNTAIN) {
        const t = Math.min(1, (e - .66) * 5); r = 112 + t * 70; g = 104 + t * 70; b = 96 + t * 70;
      } else {
        const t = Math.min(1, (e - .4) / .26); r = 86 + t * 50; g = 142 - t * 10; b = 76 - t * 12;
      }
      px[i * 4] = r + jitter; px[i * 4 + 1] = g + jitter; px[i * 4 + 2] = b + jitter; px[i * 4 + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
  }

  function setWorld(world) {
    buildLayers(world);
    buildTerrainImage(world);
    // Bake this world's ownership colours from its own roster, so seats beyond the classic six
    // colours still get their own tint and border tone.
    FILL.length = EDGE.length = 0;
    for (let id = 1; id <= world.players.length; id++) {
      const c = playerColor(world, id);
      FILL[id] = packColor(c, 120, 1); EDGE[id] = packColor(c, 255, 0.75);
    }
    seenVersion = -1;
  }

  function renderOverlay(world) {
    const w = world.w, h = world.h, owner = world.owner, OW = w * TS;
    ov.fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, o = owner[i];
      if (!o) continue;
      const f = FILL[o], e = EDGE[o], bx = x * TS, by = y * TS;
      for (let yy = 0; yy < TS; yy++) { const row = (by + yy) * OW + bx; for (let xx = 0; xx < TS; xx++) ov[row + xx] = f; }
      if (x === 0 || owner[i - 1] !== o) for (let yy = 0; yy < TS; yy++) ov[(by + yy) * OW + bx] = e;
      if (x === w - 1 || owner[i + 1] !== o) for (let yy = 0; yy < TS; yy++) ov[(by + yy) * OW + bx + TS - 1] = e;
      if (y === 0 || owner[i - w] !== o) for (let xx = 0; xx < TS; xx++) ov[by * OW + bx + xx] = e;
      if (y === h - 1 || owner[i + w] !== o) for (let xx = 0; xx < TS; xx++) ov[(by + TS - 1) * OW + bx + xx] = e;
    }
    octx.putImageData(oimg, 0, 0);
  }

  // ---------- layers drawn each frame ----------
  function drawFog(world) {
    fcx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fcx.globalCompositeOperation = 'source-over';
    fcx.clearRect(0, 0, VW, VH);
    fcx.fillStyle = 'rgba(4,10,20,.42)';
    fcx.fillRect(0, 0, VW, VH);
    fcx.globalCompositeOperation = 'destination-out';
    const hole = (wx, wy, r) => {
      const x = sx(wx), y = sy(wy), R = r * cam.z;
      if (x + R < 0 || y + R < 0 || x - R > VW || y - R > VH) return;
      const g = fcx.createRadialGradient(x, y, R * .7, x, y, R);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      fcx.fillStyle = g; fcx.beginPath(); fcx.arc(x, y, R, 0, TAU); fcx.fill();
    };
    for (const d of world.divs) if (d.owner === app.me) hole(lerpX(d), lerpY(d), VISION);
    for (const c of world.cities) if (c.owner === app.me) hole(c.x + .5, c.y + .5, CITY_VIS);
    fcx.globalCompositeOperation = 'source-over';
    ctx.drawImage(fcv, 0, 0, VW, VH);
  }

  // ---------- buildings ----------
  function drawGlyph(kind, x, y, s, col) {
    if (kind === 'farm') {
      ctx.fillStyle = '#c9a93c'; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      ctx.strokeStyle = '#8f7a26'; ctx.lineWidth = Math.max(1, s / 12);
      ctx.beginPath();
      for (let k = 1; k < 4; k++) { ctx.moveTo(x + 1, y + s * k / 4); ctx.lineTo(x + s - 1, y + s * k / 4); }
      ctx.stroke();
    } else if (kind === 'factory') {
      ctx.fillStyle = '#39424f'; ctx.fillRect(x + s * .1, y + s * .42, s * .8, s * .48);
      ctx.beginPath();                                              // sawtooth roof
      ctx.moveTo(x + s * .1, y + s * .42); ctx.lineTo(x + s * .1, y + s * .22); ctx.lineTo(x + s * .37, y + s * .42);
      ctx.lineTo(x + s * .37, y + s * .22); ctx.lineTo(x + s * .63, y + s * .42);
      ctx.lineTo(x + s * .63, y + s * .22); ctx.lineTo(x + s * .9, y + s * .42); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#39424f'; ctx.fillRect(x + s * .74, y + s * .08, s * .12, s * .3);   // chimney
      ctx.fillStyle = col; ctx.fillRect(x + s * .1, y + s * .8, s * .8, s * .1);
    } else {
      ctx.fillStyle = '#8a8f98'; ctx.fillRect(x + s * .1, y + s * .3, s * .8, s * .6);
      for (let k = 0; k < 3; k++) ctx.fillRect(x + s * (.1 + k * .31), y + s * .14, s * .18, s * .16);   // battlements
      ctx.fillStyle = '#3b4048'; ctx.fillRect(x + s * .4, y + s * .58, s * .2, s * .32);              // gate
      ctx.fillStyle = col; ctx.fillRect(x + s * .1, y + s * .3, s * .8, s * .08);
    }
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, s / 14);
    ctx.strokeRect(x + .5, y + .5, s - 1, s - 1);
  }

  function drawBuildings(world) {
    if (!world.bld) return;
    const w = world.w, h = world.h;
    const x0 = Math.max(0, Math.floor(cam.x)), y0 = Math.max(0, Math.floor(cam.y));
    const x1 = Math.min(w - 1, Math.ceil(cam.x + VW / cam.z)), y1 = Math.min(h - 1, Math.ceil(cam.y + VH / cam.z));
    const s = cam.z;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const i = ty * w + tx, b = world.bld[i];
      if (!b) continue;
      const done = world.bdone[i] <= world.time, o = world.owner[i];
      const x = sx(tx), y = sy(ty), col = o ? playerColor(world, o) : '#ccc';
      ctx.globalAlpha = done ? 1 : .5;
      drawGlyph(BUILD_IDS[b - 1], x, y, s, col);
      ctx.globalAlpha = 1;
      if (!done) {
        const total = BUILDINGS[BUILD_IDS[b - 1]].time, p = Math.max(0, Math.min(1, 1 - (world.bdone[i] - world.time) / total));
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x + 1, y + s - 4, s - 2, 3);
        ctx.fillStyle = '#ffe14d'; ctx.fillRect(x + 1, y + s - 4, (s - 2) * p, 3);
      }
    }
  }

  /** Build-radius rings, valid-tile tint, and the placement preview under the cursor. */
  function drawBuildMode(world, ui) {
    const sel = ui.selCity && ui.selCity.owner === app.me ? ui.selCity : null;
    const heavy = ui.build === 'factory' || ui.build === 'fortress';
    const cities = heavy ? world.cities.filter(c => c.owner === app.me) : sel ? [sel] : [];
    for (const c of cities) {
      const x = sx(c.x + .5), y = sy(c.y + .5), R = BUILD_RADIUS * cam.z;
      if (x + R < 0 || y + R < 0 || x - R > VW || y - R > VH) continue;
      ctx.beginPath(); ctx.arc(x, y, R, 0, TAU);
      ctx.fillStyle = heavy ? 'rgba(255,225,77,.07)' : 'rgba(255,225,77,.04)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,225,77,.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (!ui.build) return;
    const s = cam.z;
    if (s >= 6) {                                                    // faint tint on every tile that accepts this building
      const w = world.w, h = world.h;
      const x0 = Math.max(0, Math.floor(cam.x)), y0 = Math.max(0, Math.floor(cam.y));
      const x1 = Math.min(w - 1, Math.ceil(cam.x + VW / s)), y1 = Math.min(h - 1, Math.ceil(cam.y + VH / s));
      ctx.fillStyle = 'rgba(120,255,160,.13)';
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
        if (world.owner[ty * w + tx] === app.me && canBuild(world, app.me, ui.build, ty * w + tx)) ctx.fillRect(sx(tx), sy(ty), s, s);
      }
    }
    for (const t of ui.paint) { ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(sx(tileX(world, t)), sy(tileY(world, t)), s, s); }
    const h = ui.hover;
    if (h >= 0) {
      const ok = canBuild(world, app.me, ui.build, h), x = sx(tileX(world, h)), y = sy(tileY(world, h));
      ctx.globalAlpha = .75; drawGlyph(ui.build, x, y, s, app.me > 0 ? playerColor(world, app.me) : '#fff'); ctx.globalAlpha = 1;
      ctx.strokeStyle = ok ? '#7dff9f' : '#ff6b64'; ctx.lineWidth = 2; ctx.strokeRect(x, y, s, s);
      if (ui.build === 'fortress') {                                  // show the shield radius
        ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, FORT_RANGE * s, 0, TAU);
        ctx.strokeStyle = 'rgba(160,200,255,.5)'; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }

  // ---------- roads ----------
  /** Committed roads are terrain: drawn under buildings, own roads brighter than foreign ones. */
  function drawRoads(world) {
    const s = cam.z, w = world.w, h = world.h, roads = world.roads;
    if (!roads) return;
    const x0 = Math.max(0, Math.floor(cam.x)), y0 = Math.max(0, Math.floor(cam.y));
    const x1 = Math.min(w - 1, Math.ceil(cam.x + VW / s)), y1 = Math.min(h - 1, Math.ceil(cam.y + VH / s));
    const size = Math.max(1.5, s * .55);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const t = ty * w + tx;
      if (!roads[t]) continue;
      ctx.fillStyle = world.owner[t] === app.me ? 'rgba(233,190,122,.95)' : 'rgba(160,142,112,.8)';
      ctx.fillRect(sx(tx) + (s - size) / 2, sy(ty) + (s - size) / 2, size, size);
    }
  }

  /** Road tool sketch: committed points, the checked route tiles, the live cursor tile and the cost chip. */
  function drawRoadMode(world, ui) {
    const r = ui.road;
    if (!r) return;
    const s = Math.max(3, cam.z);
    ctx.lineWidth = 2;
    for (const p of r.pts) {                              // committed sketch points
      ctx.fillStyle = '#ffe14d';
      ctx.beginPath(); ctx.arc(sx(p[0] + .5), sy(p[1] + .5), Math.max(3, cam.z * .22), 0, TAU); ctx.fill();
    }
    if (r.tiles && r.tiles.length) {                      // validated route tiles + polyline
      const ok = r.afford;
      ctx.fillStyle = ok ? 'rgba(255,225,77,.30)' : 'rgba(255,107,100,.32)';
      for (const t of r.tiles) ctx.fillRect(sx(tileX(world, t)), sy(tileY(world, t)), s, s);
      ctx.strokeStyle = ok ? '#ffe14d' : '#ff6b64'; ctx.setLineDash([6, 5]);
      ctx.beginPath();
      r.tiles.forEach((t, i) => {
        const x = sx(tileX(world, t) + .5), y = sy(tileY(world, t) + .5);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke(); ctx.setLineDash([]);
    } else if (r.pts.length && (r.hover >= 0 || r.pts.length > 1)) {   // no route yet: straight red sketch
      const pts = r.hover >= 0 ? r.pts.concat([[r.cx, r.cy]]) : r.pts;
      ctx.strokeStyle = '#ff6b64'; ctx.setLineDash([6, 5]);
      ctx.beginPath();
      pts.forEach((p, i) => { const x = sx(p[0] + .5), y = sy(p[1] + .5); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (r.hover >= 0) {                                   // live tile ghost
      ctx.strokeStyle = !r.pts.length ? 'rgba(255,255,255,.7)' : (r.valid ? '#7dff9f' : '#ff6b64');
      ctx.strokeRect(sx(r.cx), sy(r.cy), s, s);
    }
    const ax = r.hover >= 0 ? r.cx : (r.pts.length ? r.pts[r.pts.length - 1][0] : -1);
    if (ax >= 0) {                                        // cost chip follows the live cursor / last point
      const ay = r.hover >= 0 ? r.cy : r.pts[r.pts.length - 1][1];
      const label = r.tiles
        ? (r.cost > 0 ? r.cost + 'g' : 'free')
        : (r.pts.length >= 2 ? 'no route' : (r.pts.length ? 'Shift: bends, click: end' : 'click start'));
      const good = r.tiles ? r.afford : false;
      ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width, cx = sx(ax + .5) + 14, cy = sy(ay + .5) - 14;
      ctx.fillStyle = 'rgba(8,14,22,.78)'; ctx.fillRect(cx - 4, cy - 9, tw + 8, 18);
      ctx.fillStyle = good ? '#7dff9f' : '#ff8f87'; ctx.fillText(label, cx, cy + 1);
      ctx.textAlign = 'center';
    }
  }

  /**
   * Cede tool preview: the rectangle's own tiles tinted, its outline, and a chip with the live count
   * and recipient. Only the sender's tiles are marked - neutral, enemy and other-ally land inside the
   * rectangle is shown as untouched because it can never move in a cession.
   */
  function drawCedeMode(world, ui) {
    const c = ui.cede;
    if (!c || !c.rect) return;
    const s = Math.max(3, cam.z);
    const x0 = Math.max(0, c.rect[0]), y0 = Math.max(0, c.rect[1]);
    const x1 = Math.min(world.w - 1, c.rect[2]), y1 = Math.min(world.h - 1, c.rect[3]);
    ctx.fillStyle = 'rgba(125,255,159,.32)';
    for (let y = y0; y <= y1; y++) {
      const row = y * world.w;
      for (let x = x0; x <= x1; x++) if (world.owner[row + x] === app.me) ctx.fillRect(sx(x), sy(y), s, s);
    }
    const good = c.count > 0;
    ctx.strokeStyle = good ? '#7dff9f' : '#ff6b64'; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
    ctx.strokeRect(sx(x0), sy(y0), (x1 - x0 + 1) * cam.z, (y1 - y0 + 1) * cam.z);
    ctx.setLineDash([]);
    const to = world.players[c.to - 1];
    const label = c.count
      ? c.count + (c.count === 1 ? ' tile' : ' tiles') + ' to ' + (to ? to.name : '?')
      : 'no land of yours in this area';
    ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const cx = Math.max(12, Math.min(VW - tw - 12, sx((x0 + x1 + 1) / 2)));
    const cy = Math.max(12, Math.min(VH - 12, sy(y0 + 1) - 14));
    ctx.fillStyle = 'rgba(8,14,22,.78)'; ctx.fillRect(cx - 4, cy - 9, tw + 8, 18);
    ctx.fillStyle = good ? '#7dff9f' : '#ff8f87'; ctx.fillText(label, cx, cy + 1);
    ctx.textAlign = 'center';
  }

  function drawCities(world, ui) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of world.cities) {
      const x = sx(c.x + .5), y = sy(c.y + .5);
      if (x < -20 || y < -20 || x > VW + 20 || y > VH + 20) continue;
      const s = Math.max(6, cam.z * (c.capital ? 1.3 : 1)), col = c.owner ? playerColor(world, c.owner) : '#cfd6dd';
      ctx.fillStyle = '#10161d'; ctx.fillRect(x - s / 2 - 1.5, y - s / 2 - 1.5, s + 3, s + 3);
      ctx.fillStyle = col; ctx.fillRect(x - s / 2, y - s / 2, s, s);
      if (c.capital) {
        ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.round(s * .8) + 'px system-ui'; ctx.fillText('★', x, y + 1);
      } else {
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x - s / 4, y - s / 4, s / 2, s / 2);
      }
      if (ui.selCity === c) {
        ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2; ctx.strokeRect(x - s / 2 - 4, y - s / 2 - 4, s + 8, s + 8);
        if (c.rally !== null && c.owner === app.me) {
          const rx = sx(tileX(world, c.rally) + .5), ry = sy(tileY(world, c.rally) + .5);
          ctx.strokeStyle = '#ffe14d'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(rx, ry); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#ffe14d'; ctx.beginPath(); ctx.arc(rx, ry, 4, 0, TAU); ctx.fill();
        }
      }
    }
  }

  function drawSelectionOverlays(world, ui) {
    for (const d of ui.sel) {
      const x = lerpX(d), y = lerpY(d);
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
      if (TYPES[d.type].capt) { ctx.beginPath(); ctx.arc(sx(x), sy(y), (1.5 + Math.sqrt(d.men) / 8) * cam.z, 0, TAU); ctx.stroke(); }
      if (d.type === 'art') { ctx.strokeStyle = 'rgba(255,150,80,.45)'; ctx.beginPath(); ctx.arc(sx(x), sy(y), ART_RANGE * cam.z, 0, TAU); ctx.stroke(); }
      // Current leg (d.path tiles) + the remaining multipoint checkpoints (world coords, own divisions only).
      // Drawn straight from the arrays: no per-frame intermediate list.
      const path = d.path || [], route = d.routePoints || [];
      if (!path.length && !route.length) continue;
      const col = d.column ? '#38bdf8' : (d.routing ? '#fca5a5' : (route.length ? '#fbbf24' : 'rgba(255,255,255,.75)'));
      const skip = path.length && route.length ? 1 : 0;    // route[0] mirrors the active leg's destination
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash(d.column ? [3, 4] : [5, 4]);
      ctx.beginPath(); ctx.moveTo(sx(x), sy(y));
      let ex = sx(x), ey = sy(y);
      for (const t of path) { ex = sx(tileX(world, t) + .5); ey = sy(tileY(world, t) + .5); ctx.lineTo(ex, ey); }
      for (let i = skip; i < route.length; i++) { ex = sx(route[i][0]); ey = sy(route[i][1]); ctx.lineTo(ex, ey); }
      ctx.stroke(); ctx.setLineDash([]);
      if (route.length <= (path.length ? 1 : 0)) {          // plain move: mark the single leg's end
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, TAU); ctx.fill();
      } else {
        for (let i = skip; i < route.length; i++) {
          const px = sx(route[i][0]), py = sy(route[i][1]), last = i === route.length - 1;
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(px, py, last ? 4.5 : 3, 0, TAU); ctx.fill();
          if (last) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, 7, 0, TAU); ctx.stroke(); }
        }
      }
    }
  }

  function drawPings(ui, now) {
    for (let k = ui.pings.length - 1; k >= 0; k--) {
      const p = ui.pings[k], a = (now - p.t) / 700;
      if (a >= 1) { ui.pings.splice(k, 1); continue; }
      ctx.strokeStyle = p.c; ctx.globalAlpha = 1 - a; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), (0.4 + a * 1.2) * cam.z, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawFights(world) {
    ctx.lineWidth = 2;
    for (const [a, b, ranged] of world.fights) {
      if (!a.vis || !b.vis) continue;
      ctx.strokeStyle = ranged ? 'rgba(255,170,60,.8)' : 'rgba(255,70,60,.9)';
      ctx.setLineDash(ranged ? [3, 5] : []);
      ctx.beginPath(); ctx.moveTo(sx(lerpX(a)), sy(lerpY(a))); ctx.lineTo(sx(lerpX(b)), sy(lerpY(b))); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawDivisions(world, ui) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const d of world.divs) {
      if (!d.vis) continue;
      const x = sx(lerpX(d)), y = sy(lerpY(d));
      if (x < -40 || y < -40 || x > VW + 40 || y > VH + 40) continue;
      // The drawn body is the physical collision body (DIV_RADIUS tiles): two divisions the sim keeps
      // at least 2 * DIV_RADIUS tiles apart never overlap on screen. The small floor keeps them visible
      // when zoomed all the way out; the men count is drawn on top and may overhang the body.
      const w = Math.max(8, cam.z * 2 * DIV_RADIUS), h = w * .62, col = playerColor(world, d.owner), s = ui.sel.has(d);
      ctx.fillStyle = col; ctx.fillRect(x - w / 2, y - h / 2, w, h);
      ctx.lineWidth = s ? 2.5 : 1.5;
      ctx.strokeStyle = s ? '#ffe14d' : d.routLocked ? '#c0392b' : d.routing ? '#fb923c' : (d.eng ? '#ff4a3d' : '#fff');
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);

      ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
      ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.round(Math.max(7, Math.min(14, h * .62))) + 'px system-ui';
      ctx.fillText(Math.round(d.men), x, y + 1);
      ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'left';
      ctx.fillStyle = d.oos ? '#fca5a5' : '#fff';
      ctx.fillText(TYPES[d.type].tag + (d.oos ? ' !' : ''), x - w / 2, y - h / 2 - 6);
      ctx.textAlign = 'center'; ctx.shadowBlur = 0;

      const f = Math.max(0, Math.min(1, d.men / d.cap));
      ctx.fillStyle = '#000a'; ctx.fillRect(x - w / 2, y + h / 2 + 2, w, 3);
      ctx.fillStyle = f > .6 ? '#4ade80' : f > .3 ? '#facc15' : '#f87171'; ctx.fillRect(x - w / 2, y + h / 2 + 2, w * f, 3);
    }
  }

  /** Right-drag formation preview: the drawn polyline plus one snapped tile ghost per unit (cross = no land). */
  function drawFormation(world, ui) {
    const f = ui.formation;
    if (!f) return;
    const col = '#7dd3fc';
    const pts = f.points;
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.globalAlpha = .9; ctx.setLineDash([7, 6]);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = sx(pts[i][0]), y = sy(pts[i][1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);
    const s = Math.max(9, cam.z * .85);
    ctx.lineWidth = 2;
    for (const sl of f.slots) {
      if (sl.tile >= 0) continue;
      const bx = sx(sl.x), by = sy(sl.y);      // raw intended slot, not the snapped tile
      ctx.beginPath(); ctx.moveTo(bx - 4, by - 4); ctx.lineTo(bx + 4, by + 4);
      ctx.moveTo(bx + 4, by - 4); ctx.lineTo(bx - 4, by + 4); ctx.stroke();
    }
    ctx.fillStyle = col; ctx.globalAlpha = .25;
    for (const sl of f.slots) if (sl.tile >= 0) ctx.fillRect(sx(tileX(world, sl.tile) + .5) - s / 2, sy(tileY(world, sl.tile) + .5) - s / 2, s, s);
    ctx.globalAlpha = .95; ctx.lineWidth = 1.5;
    for (const sl of f.slots) if (sl.tile >= 0) ctx.strokeRect(sx(tileX(world, sl.tile) + .5) - s / 2, sy(tileY(world, sl.tile) + .5) - s / 2, s, s);
    ctx.globalAlpha = 1;
  }

  function drawDragBox(ui) {
    const b = ui.dragBox;
    if (!b) return;
    ctx.strokeStyle = '#ffe14d'; ctx.fillStyle = 'rgba(255,225,77,.12)'; ctx.lineWidth = 1;
    const bx = Math.min(b.x0, b.x1), by = Math.min(b.y0, b.y1), bw = Math.abs(b.x1 - b.x0), bh = Math.abs(b.y1 - b.y0);
    ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh);
  }

  function drawMinimap(world) {
    const mw = miniCanvas.width, mh = miniCanvas.height;
    const kx = mw / world.w, ky = mh / world.h;
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(tcv, 0, 0, mw, mh);
    mctx.drawImage(ocv, 0, 0, mw, mh);
    for (const c of world.cities) {
      mctx.fillStyle = c.owner ? playerColor(world, c.owner) : '#ddd';
      mctx.fillRect(c.x * kx - 1.5, c.y * ky - 1.5, 3, 3);
    }
    for (const d of world.divs) {
      if (!d.vis) continue;
      mctx.fillStyle = playerColor(world, d.owner);
      mctx.fillRect(d.x * kx - 1, d.y * ky - 1, 2.5, 2.5);
    }
    mctx.strokeStyle = '#fff'; mctx.lineWidth = 1;
    mctx.strokeRect(cam.x * kx, cam.y * ky, VW / cam.z * kx, VH / cam.z * ky);
  }

  // ---------- logistics overlay ----------
  // Paths are cached per world + ownerVersion + roadVersion + unit tile and owner, exactly the inputs
  // logisticsPath reads, so a capture, a new road or a unit crossing a tile boundary is picked up on
  // the next frame while an unchanged world does no pathfinding at all. Off by default (ui.logistics).
  let logiWorld = null;
  const logiCache = new Map();          // division id -> { ov, rv, tile, owner, path }

  function supplyPath(world, d) {
    if (world !== logiWorld) { logiCache.clear(); logiWorld = world; }
    const ov = world.ownerVersion | 0, rv = world.roadVersion | 0, tile = tileOf(world, d);
    let e = logiCache.get(d.id);
    if (!e) { e = { ov: -1, rv: -1, tile: -1, owner: -1, path: null }; logiCache.set(d.id, e); }
    else if (e.ov === ov && e.rv === rv && e.tile === tile && e.owner === d.owner) return e.path;
    e.ov = ov; e.rv = rv; e.tile = tile; e.owner = d.owner;
    e.path = logisticsPath(world, d);
    return e.path;
  }

  /** Overlay scope: a player sees only their own divisions; a spectator sees every visible division. */
  const logiTarget = (d) => d.vis && (app.me <= 0 || d.owner === app.me);

  /** The real supply chain of each covered division, plus a red cut-off ring when there is none. */
  function drawLogisticsPaths(world) {
    if (logiCache.size > world.divs.length * 2 + 64) logiCache.clear();   // drop ids of long-dead divisions
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const d of world.divs) {
      if (!logiTarget(d)) continue;
      const x = sx(lerpX(d)), y = sy(lerpY(d));
      if (x < -64 || y < -64 || x > VW + 64 || y > VH + 64) continue;
      const path = supplyPath(world, d);
      if (path && path.length) {
        const col = SUPPLY_COLOR[supplyStep(combatMult(world, d))];
        ctx.strokeStyle = col; ctx.globalAlpha = .8; ctx.lineWidth = 2; ctx.setLineDash(NO_DASH);
        if (path.length > 1) {
          ctx.beginPath(); ctx.moveTo(x, y);
          for (let i = 1; i < path.length; i++) {
            const t = path[i];
            ctx.lineTo(sx(tileX(world, t) + .5), sy(tileY(world, t) + .5));
          }
          ctx.stroke();
        }
        const src = path[path.length - 1];                    // the supplying city tile
        ctx.globalAlpha = 1; ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(sx(tileX(world, src) + .5), sy(tileY(world, src) + .5), 3, 0, TAU); ctx.fill();
      } else {
        // Isolated: a red cut-off marker, never a fabricated line to a city.
        ctx.globalAlpha = 1; ctx.strokeStyle = CUT_COLOR; ctx.lineWidth = 2; ctx.setLineDash(CUT_DASH);
        ctx.beginPath(); ctx.arc(x, y, Math.max(11, cam.z * 1.7), 0, TAU); ctx.stroke();
        ctx.setLineDash(NO_DASH);
      }
    }
    ctx.restore();
  }

  /** Per-division damage-output percent (50..100%), red-green, drawn just under the men count bar. */
  function drawLogisticsBadges(world) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 10px system-ui';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
    for (const d of world.divs) {
      if (!logiTarget(d)) continue;
      const x = sx(lerpX(d)), y = sy(lerpY(d));
      if (x < -20 || y < -20 || x > VW + 20 || y > VH + 20) continue;
      const p = supplyPath(world, d), cut = !p || !p.length;
      const step = supplyStep(combatMult(world, d));
      const h = Math.max(8, cam.z * 2 * DIV_RADIUS) * .62;
      ctx.fillStyle = cut ? CUT_COLOR : SUPPLY_COLOR[step];
      ctx.fillText(cut ? CUT_LABEL : SUPPLY_PCT[step], x, y + h / 2 + 11);
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function render(now) {
    const world = app.world, ui = app.ui;
    if (!world) return;
    if (seenVersion !== world.ownerVersion && now - lastOverlay > 90) {
      renderOverlay(world); seenVersion = world.ownerVersion; lastOverlay = now;
    }
    drawMinimap(world);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a2038'; ctx.fillRect(0, 0, VW, VH);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tcv, sx(0), sy(0), world.w * cam.z, world.h * cam.z);
    ctx.drawImage(ocv, sx(0), sy(0), world.w * cam.z, world.h * cam.z);
    drawRoads(world);
    drawBuildings(world);
    if (ui.fog && !world.over) drawFog(world);
    if (ui.logistics) drawLogisticsPaths(world);

    drawCities(world, ui);
    drawBuildMode(world, ui);
    drawRoadMode(world, ui);
    drawCedeMode(world, ui);
    drawSelectionOverlays(world, ui);
    drawFormation(world, ui);
    drawPings(ui, now);
    drawFights(world);
    drawDivisions(world, ui);
    if (ui.logistics) drawLogisticsBadges(world);
    drawDragBox(ui);
  }

  window.addEventListener('resize', resize);
  resize();

  return { render, setWorld, resize };
}
