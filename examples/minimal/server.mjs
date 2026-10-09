import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {RingWhepClient, LiveSessionPool, RingError, assertSameOrigin} from '../../src/node.mjs';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 4325);
const origin = `http://${host}:${port}`;
const deviceId = process.env.RING_DEVICE_ID;
if (!deviceId) throw new Error('Set RING_DEVICE_ID to a device from Ring Playground or your linked Ring account.');
const client = new RingWhepClient({getAccessToken: async () => process.env.RING_TOKEN_FILE
  ? (await readFile(process.env.RING_TOKEN_FILE, 'utf8')).trim() : process.env.RING_ACCESS_TOKEN});
const pool = new LiveSessionPool({client, onEvent: event => console.log(JSON.stringify(event))});
const files = new Map([
  ['/', [new URL('./index.html', import.meta.url), 'text/html; charset=utf-8']],
  ['/app.mjs', [new URL('./app.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
  ['/styles.css', [new URL('./styles.css', import.meta.url), 'text/css; charset=utf-8']],
  ['/ring-view-bridge.mjs', [new URL('../../src/browser.mjs', import.meta.url), 'text/javascript; charset=utf-8']],
]);
const json = (res, status, data) => {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
};
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'");
  try {
    const path = new URL(req.url, origin).pathname;
    if (req.method === 'POST' && path === '/api/live-sessions') {
      assertSameOrigin(req, origin);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024) throw new RingError('too_large', 'Request exceeds 128 KiB.', 413);
        chunks.push(chunk);
      }
      const {offer} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // The server selects the authorized device; request bodies carry the SDP.
      const session = await pool.open({deviceId, offer});
      if (res.destroyed) { await pool.close(session.sessionId, 'request_closed'); return; }
      return json(res, 201, session);
    }
    if (req.method === 'DELETE' && /^\/api\/live-sessions\/[a-f0-9-]+$/.test(path)) {
      assertSameOrigin(req, origin);
      return json(res, 200, await pool.close(path.split('/').at(-1)));
    }
    if (req.method === 'GET' && files.has(path)) {
      const [file, mime] = files.get(path);
      res.writeHead(200, {'Content-Type': mime, 'Cache-Control': 'no-cache'});
      res.end(await readFile(fileURLToPath(file)));
      return;
    }
    json(res, 404, {error: {message: 'Choose an available example route.'}});
  } catch (error) {
    json(res, error.status || (error instanceof SyntaxError ? 400 : 500), {
      error: error instanceof RingError ? error.toJSON() : {message: 'Example request failed. Check setup and JSON input.'},
    });
  }
});
server.listen(port, host, () => console.log(`Ring View Bridge → ${origin}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  server.close();
  const result = await pool.closeAll();
  console.log(JSON.stringify({shutdown: result}));
  process.exitCode = result.closed ? 0 : 1;
});
