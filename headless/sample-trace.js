// Plays one full game headlessly with the real game code and writes its trace to docs/sample-trace.json.
// The forecaster takes every turn (solo mode with the AI as the player). Usage: node headless/sample-trace.js [seed]
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, 'src', f), 'utf8');

const patch = (src, from, to) => { if (!src.includes(from)) throw new Error('patch target missing: ' + from); return src.replace(from, to); };
let game = read('game.js');
game = patch(game, "turn: vs ? starter : 'you'", "turn: 'ai'");
game = patch(game, 'newGame();\nrequestAnimationFrame(frame);', 'globalThis.__trace = () => G.over && Tr.export();\nnewGame();\nrequestAnimationFrame(frame);');

// Anything the page touches (DOM elements, canvas context, media queries) becomes a do-nothing stub.
const stub = () => new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k in t ? t[k] : (t[k] = stub()),
  set: (t, k, v) => { t[k] = v; return true; },
  apply: () => stub(), construct: () => stub()
});
const els = { mVs: { checked: false } }; // solo mode
let x = Number(process.argv[2] || 7) * 7919 + 13;
const math = Object.create(Math); math.random = () => (x = (x * 16807) % 2147483647) / 2147483647;
const ctx = {
  Matter: require('matter-js'), Math: math, performance, console,
  document: { getElementById: id => els[id] || (els[id] = stub()), documentElement: stub(), createElement: stub() },
  window: { devicePixelRatio: 1 }, navigator: stub(), localStorage: stub(),
  matchMedia: stub(), getComputedStyle: stub(), MutationObserver: stub(),
  setTimeout: f => setTimeout(f, 0),
  requestAnimationFrame: f => setImmediate(() => {
    const t = ctx.__trace && ctx.__trace();
    if (!t) return f(performance.now());
    const out = path.join(root, 'docs', 'sample-trace.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(t, null, 2) + '\n');
    const game = t.resourceSpans[0].scopeSpans[0].spans.find(s => s.name === 'game').attributes;
    console.log(`wrote docs/sample-trace.json: ${game['game.result']}, ${game['stack.final_size']} stacked, Brier ${game['brier.score']}`);
    process.exit(0);
  })
};
vm.createContext(ctx);
vm.runInContext(read('sim.js') + game, ctx);
