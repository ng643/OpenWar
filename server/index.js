import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { ROOM_RE, cleanName } from '../src/net/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json'
};
const MAX_ROOMS = 50, MAX_SOCKETS = 300, JOIN_TIMEOUT = 10000;

function randomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[(Math.random() * A.length) | 0];
  return s;
}

/**
 * Start the game server: serves the built client from `staticDir` and handles WebSocket play at /ws.
 * @returns {Promise<{port:number, rooms:Map, close:()=>Promise<void>}>}
 */
export function createGameServer({
  port = 8080, host = '0.0.0.0', staticDir = path.join(here, '..', 'dist'),
  allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
} = {}) {
  const rooms = new Map();
  const trustedOrigins = new Set(allowedOrigins);

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(staticDir, path.normalize(rel));
    if (!file.startsWith(path.resolve(staticDir))) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) {
        fs.readFile(path.join(staticDir, 'index.html'), (e2, idx) => {   // SPA fallback / helpful message
          if (e2) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Client not built. Run: npm run build'); return; }
          res.writeHead(200, { 'content-type': MIME['.html'] }).end(idx);
        });
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
    });
  });

  const wss = new WebSocketServer({
    server: httpServer, path: '/ws', maxPayload: 16 * 1024,
    verifyClient: ({ origin, req }) => {
      // Keep same-host pages working; explicitly trust full origins for split frontend hosting.
      if (!origin) return true;
      try {
        const page = new URL(origin);
        return trustedOrigins.has(page.origin) ||
          page.hostname === (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      }
      catch { return false; }
    }
  });

  wss.on('connection', ws => {
    if (wss.clients.size > MAX_SOCKETS) { ws.close(1013, 'server busy'); return; }
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const joinTimer = setTimeout(() => { if (!ws.room) ws.close(4001, 'join timeout'); }, JOIN_TIMEOUT);

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'join') {
        if (ws.room) return;
        const token = typeof msg.token === 'string' && /^[\w-]{8,64}$/.test(msg.token) ? msg.token : null;
        if (!token) { ws.send(JSON.stringify({ t: 'err', msg: 'Bad token' })); return; }
        let code = typeof msg.room === 'string' ? msg.room.trim() : '';
        if (!code) { do { code = randomCode(); } while (rooms.has(code)); }
        if (!ROOM_RE.test(code)) { ws.send(JSON.stringify({ t: 'err', msg: 'Room code must be 1-12 letters or digits' })); return; }
        code = code.toUpperCase();
        let room = rooms.get(code);
        if (!room) {
          if (rooms.size >= MAX_ROOMS) { ws.send(JSON.stringify({ t: 'err', msg: 'Server is full, try again later' })); return; }
          room = new Room(code);
          rooms.set(code, room);
        }
        const err = room.join(ws, cleanName(msg.name), token, msg.role, msg.faction);
        if (err) ws.send(JSON.stringify({ t: 'err', msg: err }));
        return;
      }
      if (ws.room) ws.room.onMessage(ws, msg);
    });

    ws.on('close', () => { clearTimeout(joinTimer); if (ws.room) ws.room.leave(ws); });
    ws.on('error', () => { /* handled by close */ });
  });

  // one loop drives every room in real time
  let last = performance.now();
  const loop = setInterval(() => {
    const now = performance.now(), dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    for (const [code, room] of rooms) {
      room.advance(dt);
      if (room.isDead()) rooms.delete(code);
    }
  }, 25);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 15000);

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      resolve({
        port: httpServer.address().port,
        rooms,
        close: () => new Promise(r => {
          clearInterval(loop); clearInterval(heartbeat);
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => httpServer.close(() => r()));
        })
      });
    });
  });
}

// run directly: `node server/index.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  createGameServer({ port }).then(s => {
    console.log('Frontline server listening on http://localhost:' + s.port + '  (WebSocket at /ws)');
    console.log('Serving client from dist/ - run `npm run build` first if you have not.');
  });
}
