// OpenWar service wrapper (infrastructure-owned, lives outside release archives).
//
// Why: `node server/index.js` only honours PORT and always binds 0.0.0.0. The exported
// API of server/index.js is `createGameServer({ port = 8080, host = '0.0.0.0', staticDir = <app>/dist })`,
// so the service binds the loopback interface explicitly without touching the game code.
//
// systemd runs this with:
//   OPENWAR_APP_DIR=/opt/openwar/current  PORT=8080  HOST=127.0.0.1  STATIC_DIR=/opt/openwar/current/dist
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const appDir = process.env.OPENWAR_APP_DIR || '/opt/openwar/current';
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
const staticDir = process.env.STATIC_DIR || path.join(appDir, 'dist');

const entry = pathToFileURL(path.join(appDir, 'server', 'index.js')).href;
const { createGameServer } = await import(entry);
if (typeof createGameServer !== 'function') {
  console.error(`[openwar] ${entry} does not export createGameServer()`);
  process.exit(78);
}

const server = await createGameServer({ port, host, staticDir });
console.log(`[openwar] listening on http://${host}:${server.port} (ws /ws), app=${appDir}, static=${staticDir}`);

let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log(`[openwar] ${sig}: shutting down`);
    const kill = setTimeout(() => process.exit(1), 10_000);
    kill.unref();
    Promise.resolve(server.close()).then(() => process.exit(0), () => process.exit(1));
  });
}
