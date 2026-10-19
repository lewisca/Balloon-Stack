// Sends a downloaded trace file (already OTLP/JSON) to a collector.
// Usage: npm run export -- <trace.json> [endpoint]   (default http://localhost:4318/v1/traces)
// Standard OpenTelemetry env vars are honored, so hosted backends (Arize AX, Phoenix, ...) work without code changes:
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_ENDPOINT   where to send
//   OTEL_EXPORTER_OTLP_TRACES_HEADERS / OTEL_EXPORTER_OTLP_HEADERS     auth, as "key=value,key2=value2"
//   OTEL_RESOURCE_ATTRIBUTES                                           extra resource attributes, same format
const fs = require('fs');
const env = process.env;
const pairs = s => (s || '').split(',').filter(p => p.includes('=')).map(p => {
  const i = p.indexOf('='); return [decodeURIComponent(p.slice(0, i).trim()), decodeURIComponent(p.slice(i + 1).trim())];
});
const [file, arg] = process.argv.slice(2);
const endpoint = arg || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  (env.OTEL_EXPORTER_OTLP_ENDPOINT ? env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '') + '/v1/traces' : 'http://localhost:4318/v1/traces');
if (!file) { console.error('usage: npm run export -- <trace.json> [endpoint]'); process.exit(2); }

const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
const extra = pairs(env.OTEL_RESOURCE_ATTRIBUTES);
for (const rs of trace.resourceSpans) {
  const attrs = rs.resource.attributes = rs.resource.attributes || [];
  for (const [key, v] of extra) {
    const kv = { key, value: { stringValue: v } }, at = attrs.findIndex(a => a.key === key);
    if (at >= 0) attrs[at] = kv; else attrs.push(kv);
  }
}
const n = trace.resourceSpans.reduce((s, r) => s + r.scopeSpans.reduce((t, ss) => t + ss.spans.length, 0), 0);
const headers = Object.assign({ 'Content-Type': 'application/json' },
  Object.fromEntries(pairs(env.OTEL_EXPORTER_OTLP_HEADERS)), Object.fromEntries(pairs(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS)));

fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(trace) })
  .then(async r => {
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0, 300)}`);
    // OTLP reports partially rejected spans in a 200 response.
    const rejected = (() => { try { return JSON.parse(text).partialSuccess; } catch (_) { return null; } })();
    if (rejected && rejected.rejectedSpans) throw new Error(`${rejected.rejectedSpans} spans rejected: ${rejected.errorMessage}`);
    console.log(`sent ${n} spans to ${endpoint}`);
  })
  .catch(e => { console.error(`export failed: ${e.message}`); process.exit(1); });
