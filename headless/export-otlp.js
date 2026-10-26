// Sends a downloaded trace file (already OTLP/JSON) to Arize AX. Also used by relay.js.
// Usage: npm run export -- <trace.json>
// Configured with the standard OpenTelemetry env vars:
//   OTEL_EXPORTER_OTLP_TRACES_HEADERS   required: "space_id=<space-id>,api_key=<api-key>" from Arize Space Settings
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  optional: default https://otlp.arize.com/v1/traces (EU: https://otlp.eu-west-1a.arize.com/v1/traces)
//   OTEL_RESOURCE_ATTRIBUTES            optional: default openinference.project.name=balloon-stack
const fs = require('fs');
const env = process.env;
const pairs = s => (s || '').split(',').filter(p => p.includes('=')).map(p => {
  const i = p.indexOf('='); return [decodeURIComponent(p.slice(0, i).trim()), decodeURIComponent(p.slice(i + 1).trim())];
});
const defaultEndpoint = () => env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  (env.OTEL_EXPORTER_OTLP_ENDPOINT ? env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '') + '/v1/traces' : 'https://otlp.arize.com/v1/traces');
const headers = () => Object.assign({ 'Content-Type': 'application/json' },
  Object.fromEntries(pairs(env.OTEL_EXPORTER_OTLP_HEADERS)), Object.fromEntries(pairs(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS)));
// Arize rejects traces without these, so fail early with a clear message.
function checkConfig(endpoint = defaultEndpoint()) {
  const h = headers();
  if (/\/\/otlp\.[\w.-]*arize\.com\//.test(endpoint) &&!(h.space_id && h.api_key))
    throw new Error('Arize needs your Space ID and API key. Set OTEL_EXPORTER_OTLP_TRACES_HEADERS="space_id=<space-id>,api_key=<api-key>" (from Space Settings in Arize AX).');
}
const spanCount = t => t.resourceSpans.reduce((s, r) => s + r.scopeSpans.reduce((n, ss) => n + ss.spans.length, 0), 0);

// Adds OTEL_RESOURCE_ATTRIBUTES, POSTs, and throws on an HTTP error or partially rejected spans.
async function send(trace, endpoint = defaultEndpoint()) {
  checkConfig(endpoint);
  const extra = [['openinference.project.name', 'balloon-stack']].concat(pairs(env.OTEL_RESOURCE_ATTRIBUTES));
  for (const rs of trace.resourceSpans) {
    const attrs = rs.resource.attributes = rs.resource.attributes || [];
    for (const [key, v] of extra) {
      const kv = { key, value: { stringValue: v } }, at = attrs.findIndex(a => a.key === key);
      if (at >= 0) attrs[at] = kv; else attrs.push(kv);
    }
  }
  const r = await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify(trace) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${text.slice(0, 300)}`);
  // OTLP reports partially rejected spans in a 200 response.
  const rejected = (() => { try { return JSON.parse(text).partialSuccess; } catch (_) { return null; } })();
  if (rejected && rejected.rejectedSpans) throw new Error(`${rejected.rejectedSpans} spans rejected: ${rejected.errorMessage}`);
  return spanCount(trace);
}

module.exports = { send, checkConfig, defaultEndpoint, spanCount };

if (require.main === module) {
  const [file, endpoint = defaultEndpoint()] = process.argv.slice(2);
  if (!file) { console.error('usage: npm run export -- <trace.json>'); process.exit(2); }
  send(JSON.parse(fs.readFileSync(file, 'utf8')), endpoint)
    .then(n => console.log(`sent ${n} spans to ${endpoint}`))
    .catch(e => { console.error(`export failed: ${e.message}`); process.exit(1); });
}
