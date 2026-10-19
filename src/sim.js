// ---- Simulation core (shared by live play and Monte Carlo rollouts) ----
// Stacking corner: floor, door-frame wall on the right, a low lip on the left, olive-branch pegs above it.
const ARENA = { W: 360, H: 600, floorY: 588, x0: 204, wallX: 330 };
const PEGS = [ { x: 200, y: 520, r: 7 }, { x: 196, y: 440, r: 7 }, { x: 202, y: 356, r: 7 }, { x: 198, y: 272, r: 7 } ];
const SLOTS = 7;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function gauss(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }

function bodyFor(M, b, x, y, grip, bounce) {
  return M.Bodies.circle(x, y, b.r, {
    restitution: 0.05 + bounce * 0.5, friction: 0.05 + grip * 0.9, frictionStatic: 0.4 + grip * 4,
    frictionAir: 0.04, density: 0.0012
  });
}

function makeEngine(M) {
  const engine = M.Engine.create({ enableSleeping: false });
  engine.gravity.y = 1; engine.positionIterations = 8; engine.velocityIterations = 6;
  const B = M.Bodies, so = { isStatic: true, friction: 0.5, frictionStatic: 1, restitution: 0.1 };
  const st = [
    B.rectangle(180, ARENA.floorY + 20, 420, 40, so),
    B.rectangle(ARENA.wallX + 8, 300, 16, 700, so),
    B.rectangle(ARENA.x0 - 4, ARENA.floorY - 14, 8, 28, so),
    B.rectangle(-10, 300, 20, 700, so)
  ];
  PEGS.forEach(p => st.push(B.circle(p.x, p.y, p.r, so)));
  M.Composite.add(engine.world, st);
  return engine;
}

function slotX(i, r) { const lo = ARENA.x0 + 2 + r, hi = ARENA.wallX - r; return lo + (hi - lo) * i / (SLOTS - 1); }

// Gentle placement: just above whatever is already in that column.
function dropY(stack, x, r) {
  let y = ARENA.floorY - r - 1;
  for (const b of stack) {
    const dx = Math.abs(b.x - x);
    if (dx < b.r + r) { const yy = b.y - Math.sqrt((b.r + r) ** 2 - dx * dx) - 3; if (yy < y) y = yy; }
  }
  return y;
}

const spilled = b => b.x < ARENA.x0;

function snapshot(list, bodies) { list.forEach(b => { const s = bodies.get(b.id); if (s) { b.x = s.position.x; b.y = s.position.y; b.a = s.angle; } }); }

function sampleBel(b, rng) {
  return { g: clamp(b.bel.gm + gauss(rng) * Math.sqrt(b.bel.gv), 0, 1), k: clamp(b.bel.km + gauss(rng) * Math.sqrt(b.bel.kv), 0, 1) };
}

// One rollout: does the stack keep every balloon after placing `cand` in slot `slot`?
// A freshly rebuilt stack has none of the friction its real counterpart has built up, so it would sag
// and spill on its own. We first ease gravity in with extra damping so the copy settles, then add the new balloon.
const SETTLE = 90;
function rollout(M, stack, cand, slot, rng, steps) {
  const engine = makeEngine(M), bodies = new Map();
  for (const b of stack) {
    const s = sampleBel(b, rng);
    const body = bodyFor(M, b, b.x, b.y, s.g, s.k);
    body.angle = b.a || 0; bodies.set(b.id, body);
  }
  const list = [...bodies.values()];
  M.Composite.add(engine.world, list);
  if (list.length) for (let i = 0; i < SETTLE; i++) {
    engine.gravity.y = (i + 1) / SETTLE;
    const air = 0.04 + 0.5 * (1 - i / SETTLE);
    for (const b of list) b.frictionAir = air;
    M.Engine.update(engine, 1000 / 60);
  }
  engine.gravity.y = 1;
  for (const b of list) b.frictionAir = 0.04;
  const s = sampleBel(cand, rng);
  const x = slotX(slot, cand.r) + gauss(rng) * 2;
  const placed = stack.map(b => { const body = bodies.get(b.id); return { x: body.position.x, y: body.position.y, r: b.r }; });
  const nb = bodyFor(M, cand, x, dropY(placed, x, cand.r), s.g, s.k);
  bodies.set(cand.id, nb); M.Composite.add(engine.world, nb);
  for (let i = 0; i < steps; i++) {
    M.Engine.update(engine, 1000 / 60);
    if (i % 10 === 9) {
      let moving = 0;
      for (const body of bodies.values()) { if (body.position.x < ARENA.x0) return false; moving += body.speed; }
      if (i > 50 && moving < 0.05 * bodies.size) return true;
    }
  }
  for (const body of bodies.values()) if (body.position.x < ARENA.x0) return false;
  return true;
}

function makeBalloons(rng, n) {
  const COLORS = ['orange', 'green', 'red', 'yellow', 'blue'];
  const out = [];
  for (let i = 0; i < n; i++) out.push({
    id: i + 1, r: 21 + rng() * 6, color: COLORS[i % COLORS.length],
    grip: 0.08 + rng() * 0.88, bounce: rng(),
    bel: { gm: 0.5, gv: 0.0625, km: 0.5, kv: 0.0625 }, squeezed: 0
  });
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  out.forEach((b, i) => b.id = i + 1);
  return out;
}

if (typeof module !== 'undefined') module.exports = { ARENA, SLOTS, makeEngine, bodyFor, slotX, dropY, spilled, snapshot, rollout, makeBalloons, gauss, clamp };
