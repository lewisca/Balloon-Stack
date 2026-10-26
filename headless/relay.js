// Local relay: the game POSTs each finished game's trace here, and the relay forwards it to Arize
// (or any OTLP backend) using the same env vars as `npm run export`. Your API key stays on this machine.
// Usage: npm run relay        (listens on http://localhost:4320)
const http = require('http');
const { send, defaultEndpoint } = require('./export-otlp.js');
const PORT = Number(process.env.RELAY_PORT || 4320), MAX_BYTES = 10 * 1024 * 1024;
// Only the game may use the relay: the local file (origin "null"), localhost, and the GitHub Pages site.
const allowed = o => o === 'null' || o === 'https://lewisca.github.io' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o || '');

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && !allowed(origin)) { res.writeHead(403).end('origin not allowed'); return; }
  const cors = origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', Vary: 'Origin' } : {};
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
  if (req.method !== 'POST' || req.url !== '/v1/traces') { res.writeHead(404, cors).end(); return; }
  let body = '', size = 0;
  req.on('data', d => { size += d.length; if (size > MAX_BYTES) req.destroy(); else body += d; });
  req.on('end', async () => {
    let trace;
    try { trace = JSON.parse(body); if (!Array.isArray(trace.resourceSpans)) throw new Error('not an OTLP trace'); }
    catch (e) { res.writeHead(400, cors).end(e.message); return; }
    try {
      const n = await send(trace);
      console.log(`${new Date().toLocaleTimeString()}  forwarded ${n} spans`);
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors)).end(JSON.stringify({ spans: n }));
    } catch (e) {
      console.error(`${new Date().toLocaleTimeString()}  forward failed: ${e.message}`);
      res.writeHead(502, cors).end(e.message);
    }
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`relay on http://localhost:${PORT}/v1/traces  →  ${defaultEndpoint()}`));
