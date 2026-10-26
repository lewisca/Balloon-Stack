// Local relay: the game POSTs each finished game's trace here, and the relay forwards it to Arize AX
// using the same env vars as `npm run export`. Your API key stays on this machine.
// It also serves the game itself, so playing at http://localhost:4320 needs no cross-site permission.
// Usage: npm run relay        (play at http://localhost:4320)
const http = require('http'), fs = require('fs'), path = require('path');
const { send, checkConfig, defaultEndpoint, ENV_FILE } = require('./export-otlp.js');
const PORT = Number(process.env.RELAY_PORT || 4320), MAX_BYTES = 10 * 1024 * 1024;
// Only the game may use the relay: the local file (origin "null"), localhost, and the GitHub Pages site.
const allowed = o => o === 'null' || o === 'https://lewisca.github.io' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o || '');

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && !allowed(origin)) { res.writeHead(403).end('origin not allowed'); return; }
  const cors = origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', Vary: 'Origin' } : {};
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, '..', 'index.html'), (e, html) => {
      if (e) { res.writeHead(500).end('index.html not found; run npm run build'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
    });
    return;
  }
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
// Without credentials, create a .env template, open it in Notepad, and explain what to fill in.
function credentials() {
  try { checkConfig(); return Promise.resolve(); } catch (e) {
    if (!fs.existsSync(ENV_FILE)) fs.writeFileSync(ENV_FILE,
      '# Arize AX credentials for Balloon Stack, from Space Settings in Arize. This file is not committed to git.\n' +
      '# Replace YOUR_SPACE_ID and YOUR_API_KEY, keep the comma between them, then save.\n' +
      'OTEL_EXPORTER_OTLP_TRACES_HEADERS=space_id=YOUR_SPACE_ID,api_key=YOUR_API_KEY\n');
    console.error(`Arize needs your Space ID and API key.\n  1. In ${ENV_FILE}, replace YOUR_SPACE_ID and YOUR_API_KEY, then save.\n  2. Run npm run relay again.`);
    if (process.platform === 'win32') require('child_process').spawn('notepad.exe', [ENV_FILE], { detached: true, stdio: 'ignore' }).unref();
    process.exit(1);
  }
}

credentials().then(() => server.listen(PORT, '127.0.0.1', () => {
  console.log(`play at   http://localhost:${PORT}`);
  console.log(`relaying  http://localhost:${PORT}/v1/traces  →  ${defaultEndpoint()}`);
  // An empty export checks the endpoint and credentials without sending any spans.
  send({ resourceSpans: [] })
    .then(() => console.log('Arize accepted your Space ID and API key. Finished games will be forwarded.'))
    .catch(e => console.error(`WARNING: Arize rejected the credentials check: ${e.message}`));
}));
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is another relay still running? Close it and try again.` : e.message);
  process.exit(1);
});
