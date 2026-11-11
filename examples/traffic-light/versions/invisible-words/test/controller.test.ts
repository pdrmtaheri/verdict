import { test, expect } from 'bun:test';
const { createController, CYCLE_MS } = require('../public/controller.js');

function at(t: number) {
  let clock = t;
  return createController({ now: () => clock }).state();
}
const STEP = 50;

test('crossing roads are never both green or yellow', () => {
  for (let t = 0; t < CYCLE_MS * 3; t += STEP) {
    const s = at(t);
    const nsGo = s.ns !== 'red';
    const ewGo = s.ew !== 'red';
    expect(nsGo && ewGo).toBe(false);
  }
});

test('each light follows green, yellow, red, green and never red to yellow', () => {
  const allowed: Record<string, string> = { green: 'yellow', yellow: 'red', red: 'green' };
  for (const axis of ['ns', 'ew'] as const) {
    let prev = at(0)[axis];
    for (let t = STEP; t < CYCLE_MS * 3; t += STEP) {
      const cur = at(t)[axis];
      if (cur !== prev) expect(cur).toBe(allowed[prev]);
      prev = cur;
    }
  }
});

test('both roads are red between one road going red and the other going green', () => {
  let sawBothRed = 0;
  let prev = at(0);
  for (let t = STEP; t < CYCLE_MS * 3; t += STEP) {
    const cur = at(t);
    // direct hand-over is forbidden
    expect(prev.ns === 'yellow' && cur.ew === 'green').toBe(false);
    expect(prev.ew === 'yellow' && cur.ns === 'green').toBe(false);
    if (cur.ns === 'red' && cur.ew === 'red') sawBothRed++;
    prev = cur;
  }
  expect(sawBothRed).toBeGreaterThan(0);
  // all-red follows each yellow
  expect(at(13000)).toEqual({ ns: 'red', ew: 'red' });
  expect(at(28000)).toEqual({ ns: 'red', ew: 'red' });
});

test('both roads get a green in every full cycle', () => {
  for (let c = 0; c < 3; c++) {
    const seen = { ns: false, ew: false };
    for (let t = c * CYCLE_MS; t < (c + 1) * CYCLE_MS; t += STEP) {
      const s = at(t);
      if (s.ns === 'green') seen.ns = true;
      if (s.ew === 'green') seen.ew = true;
    }
    expect(seen).toEqual({ ns: true, ew: true });
  }
});

test('time comes only from the supplied now function', () => {
  let clock = 0;
  let calls = 0;
  const c = createController({ now: () => { calls++; return clock; } });
  expect(c.state().ns).toBe('green');
  expect(calls).toBeGreaterThan(0);
  clock = 11000;
  expect(c.state()).toEqual({ ns: 'yellow', ew: 'red' });
  clock = 0;
  expect(c.state().ns).toBe('green');
  const src = require('fs').readFileSync(__dirname + '/../public/controller.js', 'utf8');
  expect(src).not.toMatch(/Date|performance|setTimeout|setInterval/);
});

// Events: emergency(axis), clear(), fault(), recover(). Fine-grained clock so no step is skipped.
function run(script: (c: any, tick: (ms: number) => void) => void) {
  let t = 0;
  const c = createController({ now: () => t });
  const seen: { ns: string; ew: string }[] = [c.state()];
  const tick = (ms: number) => { for (let i = 0; i < ms; i += 50) { t += 50; seen.push(c.state()); } };
  script(c, tick);
  return seen;
}

test('an emergency holds its axis green until cleared, and never lets crossing roads go', () => {
  const seen = run((c, tick) => { tick(1000); c.emergency('ew'); tick(40000); c.clear(); tick(30000); });
  expect(seen.some((s) => s.ew === 'green' && seen.indexOf(s) > 600)).toBe(true);
  for (const s of seen) expect(s.ns !== 'red' && s.ew !== 'red').toBe(false);
});

test('a fault stops at all red, stays there, and recovery restarts through all red', () => {
  const seen = run((c, tick) => { tick(2000); c.fault(); tick(30000); c.recover(); tick(30000); });
  const firstBothRed = seen.findIndex((s, i) => i > 40 && s.ns === 'red' && s.ew === 'red');
  expect(firstBothRed).toBeGreaterThan(0);
  for (const s of seen) expect(s.ns !== 'red' && s.ew !== 'red').toBe(false);
  const allowed: Record<string, string> = { green: 'yellow', yellow: 'red', red: 'green' };
  for (const axis of ['ns', 'ew'] as const) for (let i = 1; i < seen.length; i++) { const a = seen[i - 1]![axis], b = seen[i]![axis]; if (a !== b) expect(b).toBe(allowed[a]!); }
});
