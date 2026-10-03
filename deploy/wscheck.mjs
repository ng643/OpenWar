// OpenWar WebSocket probe (infrastructure-owned, no npm dependencies).
// Performs real RFC6455 upgrade handshakes against the public endpoint through nginx,
// verifying the TLS certificate (IP SAN) and the Sec-WebSocket-Accept value, and checks
// the production Origin contract:
//   1. same-host origin            -> must be accepted (101)
//   2. Pages origin (github.io)    -> must be accepted (101)   [ALLOWED_ORIGINS on the service]
//   3. foreign origin              -> must be rejected (no 101)
import https from 'node:https';
import crypto from 'node:crypto';

const HOST = process.env.OPENWAR_HOST || '130.162.162.132';
const PORT = Number(process.env.OPENWAR_PORT || 443);
const PAGES_ORIGIN = process.env.OPENWAR_PAGES_ORIGIN || 'https://ng643.github.io';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TIMEOUT_MS = 10_000;

function probe(origin) {
  return new Promise(resolve => {
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };

    const req = https.request({
      host: HOST, port: PORT, path: '/ws', method: 'GET', agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        Origin: origin
      }
    }, res => {
      res.resume();
      finish({ upgraded: false, detail: `HTTP ${res.statusCode}` });
    });

    req.on('upgrade', (res, socket) => {
      const ok = res.statusCode === 101 && res.headers['sec-websocket-accept'] === expected;
      socket.destroy();
      finish({ upgraded: true, ok, detail: ok ? '101' : 'bad Sec-WebSocket-Accept' });
    });

    req.on('error', err => finish({ upgraded: false, detail: err.message }));

    req.end();
    const t = setTimeout(() => { req.destroy(); finish({ upgraded: false, detail: 'timeout' }); }, TIMEOUT_MS);
    t.unref();
  });
}

const cases = [
  { name: 'same-host', origin: `https://${HOST}`, want: true },
  { name: 'pages-origin', origin: PAGES_ORIGIN, want: true },
  { name: 'foreign-origin', origin: 'https://evil.example.invalid', want: false }
];

let failed = 0;
for (const c of cases) {
  const r = await probe(c.origin);
  const pass = c.want ? (r.upgraded && r.ok) : !r.upgraded;
  if (!pass) failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ws ${c.name} (${c.origin}): ${c.want ? 'expect 101' : 'expect reject'} -> ${r.upgraded ? `upgraded ${r.detail}` : `not upgraded (${r.detail})`}`);
}

if (failed === 0) console.log(`ws probe: OK (wss://${HOST}:${PORT}/ws, TLS verified, origin contract holds)`);
process.exit(failed === 0 ? 0 : 1);
