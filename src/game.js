// ---- Game layer ----
(function () {
const M = Matter;
const rng = Math.random;
const N = 11, QUICK = 12, FULL = 40, MIN_AT_DROP = 8;
const HUE = { orange: '#F28A2E', green: '#1F7A45', red: '#E2463E', yellow: '#F2C42A', blue: '#2F4FD1' };
const $ = id => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
let G, token = 0, theme = {}, starter = 'ai', inspect = false;

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  ['wall', 'wall-shade', 'frame', 'frame-edge', 'floor', 'planter', 'ink', 'muted', 'good', 'warn', 'bad', 'surface', 'accent'].forEach(k => theme[k] = cs.getPropertyValue('--' + k).trim());
}
readTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
(function fit() { const d = Math.min(window.devicePixelRatio || 1, 2); cv.width = 360 * d; cv.height = 600 * d; ctx.setTransform(d, 0, 0, d, 0, 0); })();

// ---------- Tracing (OpenTelemetry spans) ----------
// A game is a session (session.id on every span); each balloon placement is its own trace rooted at a `move` span.
// The game's start-to-end summary is one more trace in the same session.
const hex = n => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');
const nowNs = () => String(Math.round((performance.timeOrigin + performance.now()) * 1e6));
// OTLP/JSON value encoding
const anyValue = v => typeof v === 'boolean' ? { boolValue: v }
  : typeof v === 'number' ? { doubleValue: v } // one type per key, so p_hold = 1 and p_hold = 0.97 compare cleanly
  : Array.isArray(v) ? { arrayValue: { values: v.map(anyValue) } }
  : v && typeof v === 'object' ? { kvlistValue: { values: keyValues(v) } }
  : { stringValue: String(v) };
const keyValues = o => Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([key, v]) => ({ key, value: anyValue(v) }));
const STATUS = { UNSET: 0, OK: 1, ERROR: 2 };
// OpenInference conventions, so LLM-observability tools (Arize, Phoenix) fill in Kind, Input and Output.
const pct = v => Math.round(v * 100) + '%', pm = (m, v) => `${m.toFixed(2)} ± ${Math.sqrt(v).toFixed(2)}`;
const OI = {
  game: { kind: 'AGENT', in: a => `${a['game.mode']} game, ${a['game.balloons']} balloons, ${a['game.first_turn'] === 'ai' ? 'AI' : 'player'} first`,
          out: a => `${a['game.result']}: ${a['stack.final_size'] ?? 0} stacked` + (a['brier.score'] != null ? `, Brier ${a['brier.score'].toFixed(3)}` : '') },
  move: { kind: 'CHAIN', in: a => `Move ${a['move.number']} by ${a['move.actor'] === 'ai' ? 'AI' : 'player'}: ${a['stack.size']} stacked`,
          out: a => `#${a['balloon.id']} → spot ${a.spot}, P(hold) ${pct(a['prediction.p_hold'])} over ${a['prediction.rollouts']} rollouts, ${a['outcome.held'] ? 'held' : 'spilled'}` },
  squeeze: { kind: 'TOOL', in: a => `Squeeze #${a['balloon.id']}: prior grip ${pm(a['prior.grip_mean'], a['prior.grip_var'])}, bounce ${pm(a['prior.bounce_mean'], a['prior.bounce_var'])}`,
             out: a => `Read grip ${a['reading.grip']}, bounce ${a['reading.bounce']} → posterior grip ${pm(a['posterior.grip_mean'], a['posterior.grip_var'])}, bounce ${pm(a['posterior.bounce_mean'], a['posterior.bounce_var'])}` },
  forecast: { kind: 'EVALUATOR', in: a => `${a['candidates.count']} candidate spots, ${a['rollouts.total']} physics rollouts`,
              out: a => a.candidates && a.candidates.length ? `Best: #${a.candidates[0].balloon} → spot ${a.candidates[0].spot}, P(hold) ${pct(a.candidates[0].p_hold)}` : 'No candidates' },
  'physics.settle': { kind: 'TOOL', in: a => `Drop #${a['balloon.id']} in spot ${a.spot}, simulate ${a.steps} steps`,
                      out: a => a['outcome.held'] ? 'Held' : `Spilled #${a['outcome.spilled_ids'].join(', #')}` }
};
const Tr = {
  spans: [],
  start(name, parent, attrs) {
    const s = { traceId: parent ? parent.traceId : hex(32), spanId: hex(16), parentSpanId: parent ? parent.spanId : null, name,
                startTimeUnixNano: nowNs(), endTimeUnixNano: null, attributes: Object.assign({ 'session.id': G.sessionId }, attrs), events: [], status: 'UNSET' };
    const oi = OI[name];
    if (oi) Object.assign(s.attributes, { 'openinference.span.kind': oi.kind, 'input.value': oi.in(s.attributes) });
    this.spans.push(s); return s;
  },
  end(s, attrs, ok) {
    if (!s || s.endTimeUnixNano) return;
    Object.assign(s.attributes, attrs || {});
    if (OI[s.name] && s.attributes['game.result'] !== 'abandoned') s.attributes['output.value'] = OI[s.name].out(s.attributes);
    s.endTimeUnixNano = nowNs();
    s.status = ok === false ? 'ERROR' : 'OK';
  },
  event(s, name, attrs) { if (s) s.events.push({ name, timeUnixNano: nowNs(), attributes: attrs || {} }); },
  // Strict OTLP/JSON, ready to POST to any collector's /v1/traces. Spans still open are closed at export time.
  export() {
    const now = nowNs();
    const spans = this.spans.map(s => Object.assign({ traceId: s.traceId, spanId: s.spanId }, s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}, {
      name: s.name, kind: 1, startTimeUnixNano: s.startTimeUnixNano, endTimeUnixNano: s.endTimeUnixNano || now,
      attributes: keyValues(s.attributes),
      events: s.events.map(e => ({ name: e.name, timeUnixNano: e.timeUnixNano, attributes: keyValues(e.attributes) })),
      status: { code: STATUS[s.status] } }));
    return { resourceSpans: [{ resource: { attributes: keyValues({ 'service.name': 'balloon-stack', 'service.version': '1.1' }) },
      scopeSpans: [{ scope: { name: 'balloon-stack.forecaster' }, spans }] }] };
  }
};
const r3 = v => Math.round(v * 1000) / 1000;
const beliefsOf = list => list.map(b => ({ id: b.id, grip_mean: r3(b.bel.gm), grip_var: r3(b.bel.gv), bounce_mean: r3(b.bel.km), bounce_var: r3(b.bel.kv) }));

// Floor pile layout on the left side of the room.
const PILE = [[36, 0], [88, 0], [140, 0], [62, 1], [114, 1], [166, 1], [36, 2], [88, 2], [140, 2], [62, 3], [114, 3]];
function layoutGround() { G.ground.forEach((b, i) => { const [x, row] = PILE[i]; b.x = x; b.y = ARENA.floorY - 26 - row * 44; b.a = 0; }); }

function newGame() {
  token++;
  if (G && G.gameSpan) Tr.end(G.gameSpan, { 'game.result': 'abandoned' });
  if (G) sendTrace();
  const vs = $('mVs').checked;
  if (vs) starter = starter === 'you' ? 'ai' : 'you';
  G = { mode: vs ? 'vs' : 'solo', ground: makeBalloons(rng, N), stack: [], turn: vs ? starter : 'you',
        sel: null, slot: null, fc: new Map(), squeezed: false, busy: false, over: null,
        calib: [], placed: { you: 0, ai: 0 }, engine: makeEngine(M), bodies: new Map(),
        settle: 0, pending: null, wobble: null, reveal: false, parts: [], pops: [], popped: new Set(), sessionId: hex(32), move: 0, turnSpan: null, sent: false };
  Tr.spans = [];
  G.gameSpan = Tr.start('game', null, { 'game.mode': G.mode, 'game.balloons': N, 'game.first_turn': G.turn });
  layoutGround();
  $('banner').hidden = true; status('');
  renderPanel(); renderInspector();
  if (G.turn === 'ai') setTimeout(aiTurn, 600);
}

function turnSpan(actor) {
  if (!G.turnSpan) {
    G.move++;
    G.turnSpan = Tr.start('move', null, { 'move.number': G.move, 'move.actor': actor, 'stack.size': G.stack.length });
    Tr.event(G.turnSpan, 'beliefs.snapshot', { balloons: beliefsOf(G.ground) });
  }
  return G.turnSpan;
}

// ---------- Forecasting ----------
const key = (id, s) => id + ':' + s;
function runRollouts(c, s, n) {
  const k = key(c.id, s), prev = G.fc.get(k);
  let wins = prev ? Math.round(prev.p * prev.n) : 0, done = prev ? prev.n : 0;
  for (; done < n; done++) if (rollout(M, G.stack, c, s, rng, 150)) wins++;
  G.fc.set(k, { p: wins / done, n: done, partial: false });
}
async function forecast(pairs, n) {
  const my = token;
  for (const [id, s] of pairs) {
    const c = G.ground.find(b => b.id === id); if (!c) continue;
    const prev = G.fc.get(key(id, s));
    if (prev && prev.n >= n) continue;
    let wins = prev ? Math.round(prev.p * prev.n) : 0, done = prev ? prev.n : 0;
    while (done < n) {
      for (let k = 0; k < 3 && done < n; k++, done++) if (rollout(M, G.stack, c, s, rng, 150)) wins++;
      await new Promise(r => setTimeout(r, 0));
      if (my !== token) return false;
      G.fc.set(key(id, s), { p: wins / done, n: done, partial: done < n });
      if (inspect && G.sel === id) renderInspector();
    }
  }
  if (inspect) renderInspector();
  return true;
}
const allSlots = id => Array.from({ length: SLOTS }, (_, s) => [id, s]);

// ---------- Beliefs ----------
function squeeze(b, actor) {
  const span = Tr.start('squeeze', turnSpan(actor), { 'balloon.id': b.id, 'prior.grip_mean': r3(b.bel.gm), 'prior.grip_var': r3(b.bel.gv), 'prior.bounce_mean': r3(b.bel.km), 'prior.bounce_var': r3(b.bel.kv) });
  const zg = clamp(b.grip + gauss(rng) * 0.15, 0, 1), zk = clamp(b.bounce + gauss(rng) * 0.15, 0, 1);
  const kg = b.bel.gv / (b.bel.gv + 0.0225), kk = b.bel.kv / (b.bel.kv + 0.0225);
  b.bel.gm += kg * (zg - b.bel.gm); b.bel.gv *= (1 - kg);
  b.bel.km += kk * (zk - b.bel.km); b.bel.kv *= (1 - kk);
  b.squeezed++;
  G.wobble = { id: b.id, t: performance.now() };
  Tr.end(span, { 'reading.grip': r3(zg), 'reading.bounce': r3(zk), 'reading.noise_sd': 0.15, 'kalman_gain.grip': r3(kg), 'kalman_gain.bounce': r3(kk),
                 'posterior.grip_mean': r3(b.bel.gm), 'posterior.grip_var': r3(b.bel.gv), 'posterior.bounce_mean': r3(b.bel.km), 'posterior.bounce_var': r3(b.bel.kv) });
  return { zg, zk };
}
function feelWords(z) {
  const g = z.zg > 0.66 ? 'tacky and clingy' : z.zg > 0.38 ? 'a little grippy' : 'smooth and slippery';
  const k = z.zk > 0.66 ? 'tight and bouncy' : z.zk > 0.38 ? 'fairly firm' : 'soft and squishy';
  return `It feels ${g}, ${k}.`;
}

// ---------- Placing ----------
function place(id, slot, who) {
  const c = G.ground.find(b => b.id === id);
  const ts = turnSpan(who);
  // Make sure the forecast behind this move has enough samples to be worth grading.
  const before = G.fc.get(key(id, slot));
  if (!before || before.n < MIN_AT_DROP) runRollouts(c, slot, MIN_AT_DROP);
  const f = G.fc.get(key(id, slot));
  const cands = [];
  G.fc.forEach((v, k) => { const [bid, s] = k.split(':').map(Number); if (G.ground.some(b => b.id === bid)) cands.push({ balloon: bid, spot: s + 1, rollouts: v.n, p_hold: r3(v.p) }); });
  cands.sort((a, b) => b.p_hold - a.p_hold);
  const fs = Tr.start('forecast', ts, { 'candidates.count': cands.length, 'rollouts.total': cands.reduce((s, c) => s + c.rollouts, 0) });
  Tr.end(fs, { candidates: cands });
  G.busy = true; token++;
  G.ground = G.ground.filter(b => b !== c); layoutGround();
  c.x = slotX(slot, c.r); c.y = dropY(G.stack, c.x, c.r); c.a = 0;
  const body = bodyFor(M, c, c.x, c.y, c.grip, c.bounce);
  G.bodies.set(c.id, body); M.Composite.add(G.engine.world, body);
  G.stack.push(c); G.placed[who]++;
  const ps = Tr.start('physics.settle', ts, { 'balloon.id': id, 'spot': slot + 1, 'steps': 210 });
  G.pending = { who, id, slot, p: f.p, n: f.n, color: c.color, span: ps };
  G.sel = null; G.slot = null; G.settle = 210;
  renderPanel();
}
function finishPlace() {
  const { who, id, slot, p, n, span } = G.pending;
  G.pending = null; G.busy = false;
  const out = G.stack.filter(spilled);
  const ok = out.length === 0;
  G.calib.push({ p, o: ok ? 1 : 0 });
  Tr.end(span, { 'outcome.held': ok, 'outcome.spilled_ids': out.map(b => b.id) }, ok);
  Tr.end(G.turnSpan, { 'balloon.id': id, 'spot': slot + 1, 'prediction.p_hold': r3(p), 'prediction.rollouts': n,
                       'outcome.held': ok, 'brier.contribution': r3((p - (ok ? 1 : 0)) ** 2) }, ok);
  G.turnSpan = null;
  if (!ok) { popAll(out); return endGame(G.mode === 'solo' ? 'lost' : (who === 'you' ? 'ai' : 'you'), 'spill'); }
  if (G.ground.length === 0) return endGame(G.mode === 'solo' ? 'won' : who, 'done');
  G.squeezed = false; G.fc.clear();
  if (G.mode === 'vs') G.turn = who === 'you' ? 'ai' : 'you';
  status(who === 'ai' ? 'The forecaster placed a balloon. Your turn.' : G.stack.length > 6 ? 'It held. Getting taller.' : 'It held.');
  renderPanel(); renderInspector();
  if (G.turn === 'ai') setTimeout(aiTurn, 500);
}
// Auto-send: each game's trace goes once to the local relay (npm run relay), which forwards it to Arize.
// text/plain keeps it a simple request (no CORS preflight). If no relay is running, nothing happens.
// Served by the relay (http://localhost:4320): post to the same origin. From a file or another site: post to the default relay.
const servedLocally = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(location.origin);
const RELAY = servedLocally ? '/v1/traces' : 'http://localhost:4320/v1/traces';
function sendTrace(keepalive) {
  if (G.sent || !G.move || typeof fetch !== 'function') return;
  G.sent = true;
  const body = JSON.stringify(Tr.export()), say = t => { const el = $('tSend'); if (el) el.textContent = t; };
  fetch(RELAY, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: !!keepalive })
    .then(r => r.ok ? r.json().then(j => say(`Last game sent to the relay: ${j.spans} span${j.spans === 1 ? '' : 's'} forwarded.`))
                    : r.text().then(t => say(`Relay could not forward the last game: ${t.slice(0, 120)}`)))
    .catch(() => say(servedLocally
      ? 'Could not reach the relay. Is npm run relay still running?'
      : 'Trace not sent: could not reach the relay. Start npm run relay and play at http://localhost:4320.'));
}
addEventListener('pagehide', () => { if (G && !G.over) { Tr.end(G.gameSpan, { 'game.result': 'abandoned' }); sendTrace(true); } });

function endGame(result, why) {
  G.over = result; G.reveal = true;
  Tr.end(G.gameSpan, { 'game.result': result, 'game.end_reason': why, 'stack.final_size': G.stack.length - (why === 'spill' ? 1 : 0),
                       'brier.score': G.calib.length ? r3(G.calib.reduce((s, c) => s + (c.p - c.o) ** 2, 0) / G.calib.length) : null,
                       'true_values': G.stack.concat(G.ground).map(b => ({ id: b.id, grip: r3(b.grip), bounce: r3(b.bounce) })) });
  const head = { won: 'All 11 stacked', lost: 'The stack fell', you: 'You win', ai: 'The AI wins' }[result];
  const msg = why === 'spill' ? (G.mode === 'solo' ? `A balloon rolled out with ${G.stack.length - 1} up.` : 'A balloon rolled out of the corner.')
                              : (G.mode === 'solo' ? 'Every balloon is off the floor.' : 'The last balloon held.');
  const b = $('banner');
  b.innerHTML = `<b>${head}</b>${msg}`;
  b.hidden = false; status(''); renderPanel(); renderInspector();
  sendTrace();
}

// ---------- AI ----------
async function aiTurn() {
  if (G.over || G.turn !== 'ai') return;
  G.busy = true; renderPanel();
  status('The forecaster is thinking…');
  turnSpan('ai');
  const byGrip = [...G.ground].sort((a, b) => b.bel.gm - a.bel.gm);
  const unsure = [...G.ground].sort((a, b) => b.bel.gv - a.bel.gv)[0];
  if (unsure.bel.gv > 0.02) { squeeze(unsure, 'ai'); G.squeezed = true; byGrip.sort((a, b) => b.bel.gm - a.bel.gm); }
  const short = byGrip.slice(0, 3).map(b => b.id);
  for (const id of short) { G.sel = id; if (inspect) renderInspector(); if (!(await forecast(allSlots(id), 8))) return; }
  let ranked = [];
  short.forEach(id => { for (let s = 0; s < SLOTS; s++) ranked.push({ id, s, p: G.fc.get(key(id, s)).p }); });
  ranked.sort((a, b) => b.p - a.p);
  const top = ranked.slice(0, 3);
  if (!(await forecast(top.map(r => [r.id, r.s]), 32))) return;
  top.forEach(r => r.p = G.fc.get(key(r.id, r.s)).p);
  top.sort((a, b) => b.p - a.p);
  const pick = top[0];
  Tr.event(G.turnSpan, 'ai.decision', { policy: 'max p_hold over top-3 balloons by believed grip', shortlist: short, chosen_balloon: pick.id, chosen_spot: pick.s + 1, p_hold: r3(pick.p) });
  G.sel = pick.id; G.slot = pick.s; renderInspector();
  await new Promise(r => setTimeout(r, reduce ? 200 : 900));
  if (G.over) return;
  place(pick.id, pick.s, 'ai');
}

// ---------- Rendering ----------
function puff(b, big) {
  const n = big ? 18 : 10;
  for (let i = 0; i < n; i++) { const a = rng() * 6.28, v = big ? 1.5 + rng() * 1.5 : 1; G.parts.push({ x: b.x, y: b.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 30, c: HUE[b.color] }); }
  if (big) G.parts.push({ ring: true, x: b.x, y: b.y, r: b.r, life: 12, c: HUE[b.color] });
}
// A spill ends the game: pop every balloon, starting with the ones that rolled out, then the stack top-down, then the floor.
function popAll(out) {
  const rest = G.stack.filter(b => !out.includes(b)).sort((a, b) => a.y - b.y);
  const t = performance.now(), gap = reduce ? 0 : 90;
  out.concat(rest, G.ground).forEach((b, i) => G.pops.push({ b, at: t + 250 + i * gap }));
}
const oddsColor = p => p >= 0.8 ? theme.good : p >= 0.5 ? theme.warn : theme.bad;

function drawScene() {
  ctx.fillStyle = theme.wall; ctx.fillRect(0, 0, 360, 600);
  ctx.fillStyle = theme['wall-shade']; ctx.fillRect(0, 0, 150, 600);
  ctx.fillStyle = theme.frame; ctx.fillRect(ARENA.wallX, 0, 30, 600);
  ctx.strokeStyle = theme['frame-edge']; ctx.lineWidth = 1;
  ctx.strokeRect(ARENA.wallX + 0.5, -1, 12, 620); ctx.strokeRect(ARENA.wallX + 12.5, -1, 18, 620);
  ctx.fillStyle = theme.floor; ctx.fillRect(0, ARENA.floorY, 360, 12);
  drawTree();
}

// Potted olive tree. The pot's right wall is the lip and the branch tips are the pegs; the rest is decoration.
const BARK = '#7A6852', LEAF = ['#6F8460', '#5A6E4D', '#83977A'];
const POT = { l: 162, r: ARENA.x0, top: ARENA.floorY - 34 };
const trunkX = y => 180 + 5 * Math.sin(y / 45);
const TREE_TOP = 214;
// Canopy: overlapping leafy clumps, then leaves scattered on a golden-angle spiral (fixed positions, no randomness).
const CLUMPS = [[132, 236, 17], [152, 222, 25], [178, 204, 30], [206, 220, 25], [226, 238, 16], [164, 244, 22], [194, 246, 22]];
const CANOPY = Array.from({ length: 90 }, (_, i) => {
  const t = Math.sqrt((i + 0.5) / 90), a = i * 2.39996;
  return { x: 179 + Math.cos(a) * t * 50, y: TREE_TOP + 10 + Math.sin(a) * t * 30, rot: i * 1.3, c: LEAF[i % 3] };
});
const SIDE = [{ y: 492, dx: -38, dy: -34 }, { y: 404, dx: -44, dy: -30 }, { y: 318, dx: -40, dy: -36 }];
function leavesAlong(x0, y0, cx, cy, x1, y1, n) {
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1), u = 1 - t;
    const lx = u * u * x0 + 2 * u * t * cx + t * t * x1, ly = u * u * y0 + 2 * u * t * cy + t * t * y1;
    ctx.fillStyle = LEAF[k % 3]; ctx.beginPath(); ctx.ellipse(lx, ly + (k % 2 ? 5 : -5), 8, 3, k % 2 ? 0.6 : -0.6, 0, 6.283); ctx.fill();
  }
}
function drawTree() {
  ctx.lineCap = 'round'; ctx.strokeStyle = BARK;
  // trunk, tapering as it rises
  for (let y = POT.top; y > TREE_TOP; y -= 6) {
    ctx.lineWidth = 4 + 8 * (y - TREE_TOP) / (POT.top - TREE_TOP);
    ctx.beginPath(); ctx.moveTo(trunkX(y), y); ctx.lineTo(trunkX(y - 6), y - 6); ctx.stroke();
  }
  // decorative branches reaching up and left
  ctx.lineWidth = 3;
  SIDE.forEach(s => {
    const x0 = trunkX(s.y), x1 = x0 + s.dx, y1 = s.y + s.dy;
    ctx.strokeStyle = BARK; ctx.beginPath(); ctx.moveTo(x0, s.y); ctx.quadraticCurveTo(x0 + s.dx * 0.4, s.y - 4, x1, y1); ctx.stroke();
    leavesAlong(x0, s.y, x0 + s.dx * 0.4, s.y - 4, x1, y1, 4);
  });
  // canopy
  ctx.fillStyle = LEAF[1]; CLUMPS.forEach(([x, y, r]) => { ctx.beginPath(); ctx.arc(x, y + 3, r, 0, 6.283); ctx.fill(); });
  ctx.fillStyle = LEAF[0]; CLUMPS.forEach(([x, y, r]) => { ctx.beginPath(); ctx.arc(x - 2, y - 2, r * 0.85, 0, 6.283); ctx.fill(); });
  CANOPY.forEach(l => { ctx.fillStyle = l.c; ctx.beginPath(); ctx.ellipse(l.x, l.y, 9, 3.5, l.rot, 0, 6.283); ctx.fill(); });
  // branches out to the pegs
  PEGS.forEach(p => {
    const y0 = p.y + 30, x0 = trunkX(y0), cx = x0 + 4, cy = p.y + 8;
    ctx.strokeStyle = BARK; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, p.x, p.y); ctx.stroke();
    leavesAlong(x0, y0, cx, cy, p.x, p.y, 3);
    ctx.fillStyle = '#3E4733'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
  });
  // pot: tapered, with a rim; its right edge sits on the lip
  ctx.fillStyle = theme.planter;
  ctx.beginPath(); ctx.moveTo(POT.l + 3, POT.top + 6); ctx.lineTo(POT.r, POT.top + 6); ctx.lineTo(POT.r - 4, ARENA.floorY); ctx.lineTo(POT.l + 7, ARENA.floorY); ctx.closePath(); ctx.fill();
  ctx.fillRect(POT.l, POT.top, POT.r - POT.l, 7);
  ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(POT.l + 3, POT.top + 7, POT.r - POT.l - 6, 2);
  ctx.fillStyle = theme.planter; ctx.fillRect(ARENA.x0 - 8, ARENA.floorY - 28, 8, 28);
}
function balloonShape(b, x, y, a, alpha) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.rotate(a);
  const r = b.r, c = HUE[b.color];
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.1);
  g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(0.25, c); g.addColorStop(1, c);
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 0, r, r * 1.04, 0, 0, 6.283); ctx.fill();
  ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(-4, r + 4); ctx.lineTo(4, r + 4); ctx.lineTo(0, r - 3); ctx.closePath(); ctx.fill();
  ctx.restore();
}
function label(b, x, y, txt) {
  ctx.font = '600 11px "Chivo Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = b.color === 'yellow' || b.color === 'orange' ? 'rgba(0,0,0,.7)' : 'rgba(255,255,255,.92)';
  ctx.fillText(txt, x, y);
}
const tagOf = b => !inspect ? null : G.reveal ? Math.round(b.grip * 100) + '%' : '#' + b.id;

function frame(now) {
  if (G.settle > 0) {
    const n = reduce ? 5 : 1;
    for (let i = 0; i < n && G.settle > 0; i++, G.settle--) M.Engine.update(G.engine, 1000 / 60);
    snapshot(G.stack, G.bodies);
    if (G.settle <= 0) finishPlace();
  }
  drawScene();
  const sel = G.ground.find(b => b.id === G.sel);
  const dragging = drag && drag.moved;
  if (sel && !G.over) {
    for (let s = 0; s < SLOTS; s++) {
      const chosen = G.slot === s;
      if (!inspect && !chosen) continue;
      const x = slotX(s, sel.r), y = dropY(G.stack, x, sel.r), f = G.fc.get(key(sel.id, s));
      if (inspect) {
        balloonShape(sel, x, y, 0, chosen ? 0.5 : 0.14);
        ctx.lineWidth = chosen ? 3 : 2; ctx.strokeStyle = f ? oddsColor(f.p) : theme.muted;
        ctx.setLineDash(chosen ? [] : [4, 4]); ctx.beginPath(); ctx.arc(x, y, sel.r, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
        ctx.font = '600 11px "Chivo Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = theme.ink; ctx.fillText(f ? Math.round(f.p * 100) + '%' : '…', x, y);
      } else if (!dragging) {
        balloonShape(sel, x, y, 0, 0.35);
        ctx.lineWidth = 2; ctx.strokeStyle = theme.ink; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc(x, y, sel.r, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }
  G.pops = G.pops.filter(p => { if (p.at > now) return true; G.popped.add(p.b.id); puff(p.b, true); return false; });
  if (inspect && G.reveal) G.popped.forEach(id => { const b = G.stack.concat(G.ground).find(x => x.id === id);
    ctx.font = '600 11px "Chivo Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = theme.muted; ctx.fillText(tagOf(b), b.x, b.y); });
  G.stack.forEach(b => { if (G.popped.has(b.id)) return; balloonShape(b, b.x, b.y, b.a || 0, 1); const t = tagOf(b); if (t) label(b, b.x, b.y, t); });
  G.ground.forEach(b => {
    if (G.popped.has(b.id) || (dragging && drag.id === b.id)) return;
    let wob = 0;
    if (G.wobble && G.wobble.id === b.id) { const dt = now - G.wobble.t; if (dt < 700) wob = Math.sin(dt / 40) * 3 * (1 - dt / 700); else G.wobble = null; }
    balloonShape(b, b.x + wob, b.y, 0, 1);
    const t = tagOf(b); if (t) label(b, b.x + wob, b.y, t);
    if (G.sel === b.id) { ctx.strokeStyle = theme.ink; ctx.lineWidth = 2.5; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 4, 0, 6.283); ctx.stroke(); ctx.setLineDash([]); }
  });
  if (dragging) {
    const b = G.ground.find(x => x.id === drag.id);
    if (b) { const x = drag.x + drag.ox, y = drag.y + drag.oy;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 8; balloonShape(b, x, y, Math.sin(now / 160) * 0.06, 0.95); ctx.restore();
      const t = tagOf(b); if (t) label(b, x, y, t); }
  }
  G.parts = G.parts.filter(p => p.life-- > 0);
  G.parts.forEach(p => {
    if (p.ring) { p.r += 3; ctx.globalAlpha = p.life / 12; ctx.strokeStyle = p.c; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.stroke(); return; }
    p.x += p.vx; p.y += p.vy; ctx.globalAlpha = p.life / 30; ctx.fillStyle = p.c; ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
  });
  ctx.globalAlpha = 1;
  requestAnimationFrame(frame);
}

// ---------- Player panel ----------
function status(t) { $('status').textContent = t; }
function renderPanel() {
  const yours = G.turn === 'you' && !G.over;
  const vs = G.mode === 'vs';
  $('pYou').classList.toggle('on', yours && !G.busy); $('pAi').classList.toggle('on', vs && G.turn === 'ai' && !G.over);
  $('aiWho').textContent = vs ? 'Forecaster AI' : 'Floor';
  $('sYou').textContent = vs ? `${G.placed.you} placed` : `${G.stack.length} of ${N} up`;
  $('sAi').textContent = vs ? `${G.placed.ai} placed` : `${G.ground.length} left`;
  $('tYou').textContent = G.over ? ({ you: 'Winner', won: 'Cleared', lost: 'Fell' }[G.over] || '') : yours ? 'Your turn' : 'Waiting';
  $('tAi').textContent = vs ? (G.over ? (G.over === 'ai' ? 'Winner' : '') : G.turn === 'ai' ? 'Thinking' : 'Waiting') : 'Balloons to lift';
  const b = G.ground.find(x => x.id === G.sel);
  $('selTitle').textContent = G.over ? 'Game over' : (yours && b) ? (G.slot === null ? 'Drag it into the corner' : 'Drop it here?') : yours ? 'Drag a balloon into the corner' : 'The forecaster is taking its turn';
  const can = yours && !G.busy && b;
  $('bSqueeze').disabled = !(can && !G.squeezed);
  $('bPlace').hidden = !(can && G.slot !== null && !(drag && drag.moved));
  $('bPlace').disabled = !(can && G.slot !== null);
}

// ---------- Inspector ----------
function setMeter(el, m, v) {
  const sd = Math.sqrt(v), i = el.querySelector('i'), e = el.querySelector('em');
  const lo = clamp(m - 2 * sd, 0, 1), hi = clamp(m + 2 * sd, 0, 1);
  i.style.left = lo * 100 + '%'; i.style.width = (hi - lo) * 100 + '%'; e.style.left = clamp(m, 0, 1) * 100 + '%';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderInspector() {
  if (!inspect) return;
  const b = G.ground.find(x => x.id === G.sel);
  if (b) {
    $('iTitle').textContent = `Balloon #${b.id}${G.slot !== null ? ' → spot ' + (G.slot + 1) : ''}${b.squeezed ? ' · squeezed' : ''}`;
    const fs = Array.from({ length: SLOTS }, (_, s) => G.fc.get(key(b.id, s)));
    const f = G.slot !== null ? fs[G.slot] : null;
    if (f) {
      $('pBig').textContent = Math.round(f.p * 100) + '%'; $('pBig').style.color = oddsColor(f.p);
      const ci = 1.96 * Math.sqrt(Math.max(f.p * (1 - f.p), 0.01) / f.n);
      $('pCi').textContent = `chance it all holds · ±${Math.round(ci * 100)} pts · ${f.n} simulations${f.partial ? '…' : ''}`;
    } else if (fs.every(Boolean)) {
      const best = fs.reduce((m, x, s) => x.p > m.p ? { p: x.p, s } : m, { p: -1, s: 0 });
      $('pBig').textContent = Math.round(best.p * 100) + '%'; $('pBig').style.color = oddsColor(best.p);
      $('pCi').textContent = `best spot is ${best.s + 1}. Each ring on the board shows a spot's odds.`;
    } else { $('pBig').textContent = '…'; $('pBig').style.color = ''; $('pCi').textContent = 'Simulating each spot'; }
    setMeter($('mGrip'), b.bel.gm, b.bel.gv); $('vGrip').textContent = `${Math.round(b.bel.gm * 100)} ±${Math.round(Math.sqrt(b.bel.gv) * 100)}`;
    setMeter($('mBounce'), b.bel.km, b.bel.kv); $('vBounce').textContent = `${Math.round(b.bel.km * 100)} ±${Math.round(Math.sqrt(b.bel.kv) * 100)}`;
  } else {
    $('iTitle').textContent = 'Forecast';
    $('pBig').textContent = '—'; $('pBig').style.color = '';
    $('pCi').textContent = G.over ? 'Balloons now show their true grip.' : 'Pick up a balloon to see its odds for each spot.';
    ['mGrip', 'mBounce'].forEach(m => { const el = $(m); el.querySelector('i').style.width = '0'; el.querySelector('em').style.left = '-4px'; });
    $('vGrip').textContent = '—'; $('vBounce').textContent = '—';
  }
  // calibration
  if (G.calib.length) {
    const bs = G.calib.reduce((s, c) => s + (c.p - c.o) ** 2, 0) / G.calib.length;
    $('brier').textContent = `Brier ${bs.toFixed(3)} · ${G.calib.length} move${G.calib.length > 1 ? 's' : ''}`;
  } else $('brier').textContent = 'Brier —';
  const rows = [];
  for (let k = 0; k < 5; k++) {
    const inB = G.calib.filter(c => Math.min(4, Math.floor(c.p * 5)) === k);
    if (!inB.length) { rows.push(`<tr><td>${k * 20}–${k * 20 + 20}%</td><td>0</td><td>—</td><td>—</td></tr>`); continue; }
    const pp = inB.reduce((s, c) => s + c.p, 0) / inB.length, oo = inB.reduce((s, c) => s + c.o, 0) / inB.length;
    rows.push(`<tr><td>${k * 20}–${k * 20 + 20}%</td><td>${inB.length}</td><td>${Math.round(pp * 100)}%</td><td class="${Math.abs(pp - oo) > 0.25 && inB.length >= 3 ? 'off' : ''}">${Math.round(oo * 100)}%</td></tr>`);
  }
  $('calt').tBodies[0].innerHTML = rows.join('');
  // trace
  $('tCount').textContent = `${Tr.spans.length} span${Tr.spans.length === 1 ? '' : 's'}`;
  const moves = Tr.spans.filter(s => s.name === 'move').slice().reverse();
  $('trace').innerHTML = moves.length ? moves.map(m => {
    const a = m.attributes, kids = Tr.spans.filter(s => s.parentSpanId === m.spanId);
    const head = a['balloon.id'] !== undefined
      ? `Move ${a['move.number']} · ${a['move.actor'] === 'you' ? 'You' : 'AI'} · #${a['balloon.id']} → spot ${a.spot} · forecast ${Math.round(a['prediction.p_hold'] * 100)}% · <span class="${a['outcome.held'] ? '' : 'bad'}">${a['outcome.held'] ? 'held' : 'spilled'}</span>`
      : `Move ${a['move.number']} · ${a['move.actor'] === 'you' ? 'You' : 'AI'} · in progress`;
    const lines = kids.map(k => {
      const ka = k.attributes;
      if (k.name === 'squeeze') return `<div><b>squeeze</b> #${ka['balloon.id']} read grip ${ka['reading.grip']}, bounce ${ka['reading.bounce']} → grip belief ${ka['prior.grip_mean']}→${ka['posterior.grip_mean']} (var ${ka['prior.grip_var']}→${ka['posterior.grip_var']})</div>`;
      if (k.name === 'forecast') return `<div><b>forecast</b> ${ka['candidates.count']} candidates, ${ka['rollouts.total']} rollouts. Top: ${(ka.candidates || []).slice(0, 3).map(c => `#${c.balloon}@${c.spot} ${Math.round(c.p_hold * 100)}% (n${c.rollouts})`).join(', ')}</div>`;
      if (k.name === 'physics.settle') return `<div><b>physics.settle</b> ${ka.steps} steps · ${ka['outcome.held'] === undefined ? 'running' : ka['outcome.held'] ? 'held' : 'spilled #' + ka['outcome.spilled_ids'].join(', #')}</div>`;
      return `<div><b>${esc(k.name)}</b></div>`;
    });
    m.events.filter(e => e.name === 'ai.decision').forEach(e => lines.push(`<div><b>ai.decision</b> ${esc(e.attributes.policy)} → #${e.attributes.chosen_balloon}@${e.attributes.chosen_spot}</div>`));
    const brier = a['brier.contribution'] !== undefined ? `<span class="k">brier ${a['brier.contribution']}</span>` : '';
    return `<li><details><summary><span>${head}</span>${brier}</summary><div class="kids">${lines.join('')}<div class="k">trace ${m.traceId} · span ${m.spanId}</div></div></details></li>`;
  }).join('') : '<li class="muted">Each move becomes its own trace, with child spans for squeezes, the forecast and the physics outcome. The game is the session.</li>';
}

// ---------- Input ----------
let drag = null;
const canPlay = () => G && !G.busy && !G.over && G.turn === 'you';
function toCanvas(e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * 360 / r.width, y: (e.clientY - r.top) * 600 / r.height }; }
const hitGround = p => G.ground.find(b => Math.hypot(b.x - p.x, b.y - p.y) < b.r + 6);
function nearestSlot(b, x, y) {
  if (x < ARENA.x0 - 14) return null;
  let best = 0, bd = 1e9;
  for (let s = 0; s < SLOTS; s++) { const sx = slotX(s, b.r), sy = dropY(G.stack, sx, b.r), d = Math.hypot(sx - x, (sy - y) * 0.4); if (d < bd) { bd = d; best = s; } }
  return best;
}
function select(g) {
  if (G.sel === g.id) return;
  G.sel = g.id; G.slot = null; token++; status('');
  turnSpan('you');
  renderPanel(); renderInspector();
  forecast(allSlots(g.id), QUICK);
}
function chooseSlot(sel, s) {
  G.slot = s; token++; renderPanel(); renderInspector();
  forecast([[sel.id, s]], FULL).then(ok => { if (ok) forecast(allSlots(sel.id), QUICK); });
}
cv.addEventListener('touchstart', e => { if (!canPlay()) return; const t = e.touches[0]; if (t && hitGround(toCanvas(t))) e.preventDefault(); }, { passive: false });
cv.addEventListener('pointerdown', e => {
  if (!canPlay()) return;
  const p = toCanvas(e), g = hitGround(p);
  if (g) {
    select(g);
    drag = { id: g.id, x: p.x, y: p.y, ox: g.x - p.x, oy: g.y - p.y - (e.pointerType === 'touch' ? 34 : 0), sx: p.x, sy: p.y, moved: false };
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    cv.style.cursor = 'grabbing';
    return;
  }
  const sel = G.ground.find(b => b.id === G.sel);
  if (sel) { const s = nearestSlot(sel, p.x, p.y); if (s !== null) chooseSlot(sel, s); }
});
cv.addEventListener('pointermove', e => {
  const p = toCanvas(e);
  if (!drag) { cv.style.cursor = canPlay() && hitGround(p) ? 'grab' : 'default'; return; }
  drag.x = p.x; drag.y = p.y;
  if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 6) { if (!drag.moved) { drag.moved = true; renderPanel(); } }
  if (!drag.moved) return;
  const b = G.ground.find(x => x.id === drag.id);
  const s = nearestSlot(b, p.x + drag.ox, p.y + drag.oy);
  if (s !== G.slot) { G.slot = s; renderInspector(); if (s !== null) { token++; forecast([[b.id, s]], QUICK); } }
});
function endDrag(cancel) {
  if (!drag) return;
  const d = drag; drag = null; cv.style.cursor = '';
  if (!d.moved) { renderPanel(); return; }
  const b = G.ground.find(x => x.id === d.id);
  if (!cancel && b && G.slot !== null && canPlay()) { place(b.id, G.slot, 'you'); return; }
  G.slot = null; renderPanel(); renderInspector();
}
cv.addEventListener('pointerup', () => endDrag(false));
cv.addEventListener('pointercancel', () => endDrag(true));

$('bSqueeze').addEventListener('click', () => {
  const b = G.ground.find(x => x.id === G.sel); if (!b) return;
  const z = squeeze(b, 'you'); G.squeezed = true;
  status(feelWords(z));
  token++; G.fc.clear(); renderPanel(); renderInspector();
  const first = G.slot !== null ? [[b.id, G.slot]] : [];
  forecast(first.concat(allSlots(b.id)), QUICK).then(ok => { if (ok && G.slot !== null) forecast([[b.id, G.slot]], FULL); });
});
$('bPlace').addEventListener('click', () => { if (G.sel && G.slot !== null) place(G.sel, G.slot, 'you'); });
$('bNew').addEventListener('click', newGame);
$('cInspect').addEventListener('change', e => {
  inspect = e.target.checked; $('inspector').hidden = !inspect;
  try { localStorage.setItem('bs-inspect', inspect ? '1' : '0'); } catch (_) {}
  renderInspector();
});
$('bCopy').addEventListener('click', () => {
  const json = JSON.stringify(Tr.export(), null, 2), out = $('traceOut');
  const fallback = () => { out.value = json; out.hidden = false; out.focus(); out.select(); $('bCopy').textContent = 'Select all and copy'; };
  try {
    navigator.clipboard.writeText(json).then(() => { $('bCopy').textContent = 'Copied'; setTimeout(() => $('bCopy').textContent = 'Copy trace JSON', 1600); }, fallback);
  } catch (_) { fallback(); }
});
$('bDownload').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(Tr.export(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `balloon-stack-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
});

try { if (localStorage.getItem('bs-inspect') === '1') { $('cInspect').checked = true; inspect = true; $('inspector').hidden = false; } } catch (_) {}
newGame();
requestAnimationFrame(frame);
})();
