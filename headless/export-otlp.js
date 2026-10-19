// Sends a downloaded trace file (already OTLP/JSON) to a collector.
// Usage: npm run export -- <trace.json> [endpoint]   (default http://localhost:4318/v1/traces)
const fs = require('fs');
const [file, endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4318/v1/traces'] = process.argv.slice(2);
if (!file) { console.error('usage: npm run export -- <trace.json> [endpoint]'); process.exit(2); }
const body = fs.readFileSync(file, 'utf8');
const n = JSON.parse(body).resourceSpans.reduce((s, r) => s + r.scopeSpans.reduce((t, ss) => t + ss.spans.length, 0), 0);
fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  .then(async r => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
    console.log(`sent ${n} spans to ${endpoint}`);
  })
  .catch(e => { console.error(`export failed: ${e.message}`); process.exit(1); });
