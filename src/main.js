import './styles.css';
import { normalizeSettings, defaultSettings } from './setup.js';
import { createCamera, clampCamera, resetCamera, setBounds, minZoom, centerOn } from './client/camera.js';
import { createUIState, resetUIState } from './client/ui-state.js';
import { createRenderer } from './client/renderer.js';
import { createHud } from './client/hud.js';
import { createCommands } from './client/commands.js';
import { attachInput } from './client/input.js';
import { createMenu } from './client/menu.js';
import { createLocalSession, createNetSession } from './client/session.js';

const app = {
  world: null,
  me: 1,             // player id of the viewer: 0 while spectating, otherwise an enabled faction id
  session: null,     // createLocalSession / createNetSession
  lobby: null,       // latest lobby message in multiplayer
  ui: createUIState(),
  camera: createCamera(),
  alpha: 1,          // render interpolation between sim steps / snapshots
  keys: {},
  leave: null
};

const canvas = document.getElementById('c');
const renderer = createRenderer(app, canvas, document.getElementById('mini'));
const hud = createHud(app);
const cmd = createCommands(app, hud);
attachInput(app, cmd, hud, canvas, document.getElementById('mini'));
hud.bindButtons(cmd);

let lobbyRoom = null;   // room the lobby panel is currently showing, so refreshes do not reset the form

// ---------- what sessions call back into ----------
const host = {
  onEvent: (type, data) => hud.onEvent(type, data),
  onResult: r => cmd.onResult(r),

  onGameStart(world, { resume, kind }) {
    resetUIState(app.ui);
    app.world = world;
    app.me = app.me | 0;
    app.ui.fog = app.me > 0 && !!world.settings.fog;   // spectators always see the whole map
    renderer.setWorld(world);                          // rebuilds the layers for this map's size
    setBounds(app.camera, world.w, world.h);
    if (!resume) {
      const cap = app.me > 0 ? world.cities.find(c => c.owner === app.me && c.capital) : null;
      if (cap) { resetCamera(app.camera, cap.x + .5, cap.y + .5); app.ui.selCity = cap; }
      else { centerOn(app.camera, world.w / 2, world.h / 2); app.camera.z = minZoom(app.camera); clampCamera(app.camera); }
    }
    hud.hideEnd();
    menu.hide();
    document.body.classList.remove('menu');
    document.body.classList.toggle('net', kind === 'net');
    document.body.classList.toggle('spectator', app.me <= 0);
    if (world.over && world.result) host.onEvent('gameOver', world.result);   // reconnected after the game ended
    hud.refresh();
  },
  onGameEnd() { app.world = null; hud.hideEnd(); },     // back to the lobby (rematch)

  onLobby(m) {
    if (m.state !== 'lobby') return;
    app.world = null; app.lobby = m; hud.hideEnd();
    document.body.classList.add('menu');
    if (lobbyRoom === m.room) menu.updateLobby(m);
    else { lobbyRoom = m.room; menu.showLobby(m); }
  },
  onConnection(text) {
    const el = document.getElementById('conn');
    el.textContent = text || ''; el.style.display = text ? 'block' : 'none';
  },
  /** A rejected lobby action (seat taken, not the host, ...) is not fatal: report it and stay in the lobby. */
  onSoftError(msg) { menu.showLobbyError(msg); },
  onNetError(msg) { toMenu(msg); },
  /** End screen "New game" in single player: back to the setup panel with the choices just used. */
  toSetup() {
    endSession();
    document.body.classList.add('menu');
    document.body.classList.remove('net', 'spectator');
    menu.showSetup();
  }
};

function endSession() {
  if (app.session) app.session.destroy();
  app.session = null; app.world = null; app.lobby = null; lobbyRoom = null;
  host.onConnection(null);
  hud.hideEnd();
}

function toMenu(err) {
  sessionStorage.removeItem('frontline.resume');
  endSession();
  document.body.classList.add('menu');
  document.body.classList.remove('net', 'spectator');
  menu.showMain(err);
}
app.leave = () => toMenu();

/** Start (or restart) a single-player game. Throws a readable message when the raw settings are not valid. */
function startLocal(rawSettings, seat, name) {
  const settings = normalizeSettings(rawSettings);
  const side = seat && seat.role === 'spectator' ? 0 : (seat && seat.faction) | 0;
  if (side > 0 && !settings.factions.includes(side)) throw new Error('Choose one of the enabled factions');
  // A reserved bot seat is never playable: it exists so a human cannot claim it by accident.
  if (side > 0 && settings.bots.includes(side)) throw new Error('Seat ' + side + ' is reserved for a bot — pick another seat');
  endSession();
  menu.remember(settings, side);
  app.session = createLocalSession(app, host, { settings, side, name: name || 'You' });
}

function startNet(name, room, seat = {}) {
  endSession();
  app.session = createNetSession(app, host, { name, room, role: seat.role, faction: seat.faction });
}

const menu = createMenu({
  onSingle: (rawSettings, seat, name) => startLocal(rawSettings, seat, name),
  onOnline: (name, room, spectate) => startNet(name, room, spectate ? { role: 'spectator', faction: 0 } : {}),
  onConfigure: rawSettings => {
    try { app.session.configure(normalizeSettings(rawSettings)); }
    catch (err) { menu.showLobbyError(err.message); }
  },
  onSeat: (role, faction) => { if (app.session) app.session.setSeat(role, faction); },
  onStart: rawSettings => {
    try { app.session.start(normalizeSettings(rawSettings)); }
    catch (err) { menu.showLobbyError(err.message); }
  },
  onLeave: () => toMenu()
});

// `?seed=123` jumps straight into a reproducible single-player game; otherwise show the menu.
const rawSeed = new URLSearchParams(location.search).get('seed');
let resume = null;
try { resume = JSON.parse(sessionStorage.getItem('frontline.resume')); } catch { /* ignore */ }
if (rawSeed !== null && rawSeed.trim() !== '') {
  // An explicit seed from the URL is kept exactly, 0 included; anything else falls back to the menu.
  try { startLocal({ ...defaultSettings(), seed: Number(rawSeed) }, { role: 'player', faction: 1 }); }
  catch (err) { menu.showMain('URL seed is not usable: ' + err.message); }
} else if (resume && resume.room) {
  // Page reload during an online game: rejoin with the same identity and seat.
  startNet(resume.name, resume.room, { role: resume.role, faction: resume.faction });
} else menu.showMain();

// ---------- main loop ----------
let last = performance.now(), hudT = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (app.world && app.session) {
    const { camera, keys } = app;
    const pan = 700 * dt / camera.z;
    if (keys['a'] || keys['arrowleft']) camera.x -= pan;
    if (keys['d'] || keys['arrowright']) camera.x += pan;
    if (keys['w'] || keys['arrowup']) camera.y -= pan;
    if (keys['s'] || keys['arrowdown']) camera.y += pan;
    clampCamera(camera);

    app.session.update(dt, now);
    renderer.render(now);
    if (now - hudT > 200) { hudT = now; hud.refresh(); }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for debugging in the console: window.__game.world
window.__game = app;
