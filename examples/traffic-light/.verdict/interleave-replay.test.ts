// scope: createController() in public/controller.js, replaying every behaviour of the spec .verdict/interleave.tla
// (all reachable abstract states, and every action from each of them, including ignored/no-op calls) through the
// public API: state(), emergency('ns'|'ew'), clear(), fault(), recover(), and a clock that steps one phase or jumps
// backwards. Checks that lights match the spec and that crossing roads are never both green/yellow after any step.
// Phase durations are driven from the clock; rendering in app.js is not covered.
import { test, expect } from 'bun:test';
const { createController } = require((process.env.VERDICT_TARGET ?? __dirname + '/..') + '/public/controller.js');

const PHASE_MS = [10000, 3000, 2000, 10000, 3000, 2000];
const NS = ['green', 'yellow', 'red', 'red', 'red', 'red'];
const EW = ['red', 'red', 'red', 'green', 'yellow', 'red'];
const GREEN: Record<string, number> = { ns: 0, ew: 3 };
const allRed = (p: number) => p === 2 || p === 5;

type M = { mode: 'cycle' | 'fault'; i: number; hold: 'none' | 'ns' | 'ew'; faulting: boolean };
const ACTIONS = ['tick', 'back', 'emergency ns', 'emergency ew', 'clear', 'fault', 'recover'] as const;
type A = (typeof ACTIONS)[number];

// The spec's Next, made total: an action whose guard is false changes nothing.
function step(m: M, a: A): M {
  const n = { ...m };
  switch (a) {
    case 'tick':
      if (m.mode !== 'cycle') return n;
      if (m.hold !== 'none' && m.i === GREEN[m.hold]) return n;
      n.i = (m.i + 1) % 6;
      if (m.faulting && allRed(n.i)) { n.mode = 'fault'; n.faulting = false; }
      return n;
    case 'back':
      if (m.mode === 'cycle') n.i = 0;
      return n;
    case 'emergency ns':
    case 'emergency ew':
      if (m.mode === 'cycle' && !m.faulting && m.hold === 'none') n.hold = a.endsWith('ns') ? 'ns' : 'ew';
      return n;
    case 'clear':
      n.hold = 'none';
      return n;
    case 'fault':
      if (m.mode !== 'cycle') return n;
      n.hold = 'none';
      if (allRed(m.i)) n.mode = 'fault'; else n.faulting = true;
      return n;
    case 'recover':
      if (m.mode === 'fault') return { mode: 'cycle', i: 2, hold: 'none', faulting: false };
      return n;
  }
}

const key = (m: M) => `${m.mode}/${m.i}/${m.hold}/${m.faulting}`;
const lights = (m: M) => (m.mode === 'fault' ? { ns: 'red', ew: 'red' } : { ns: NS[m.i], ew: EW[m.i] });
const go = (l: string) => l === 'green' || l === 'yellow';

// Drive the real controller with a script; return the state() after every step.
function replay(script: A[]) {
  let clock = 0;
  const c = createController({ now: () => clock });
  const model: M = { mode: 'cycle', i: 0, hold: 'none', faulting: false };
  let m = model;
  const out: { m: M; s: { ns: string; ew: string }; path: string }[] = [];
  const first = c.state();
  out.push({ m, s: first, path: '(start)' });
  const done: A[] = [];
  for (const a of script) {
    done.push(a);
    const before = m;
    switch (a) {
      case 'tick': clock += PHASE_MS[before.i]; break;
      case 'back': clock = -1; c.state(); clock = 0; break;
      case 'emergency ns': c.emergency('ns'); break;
      case 'emergency ew': c.emergency('ew'); break;
      case 'clear': c.clear(); break;
      case 'fault': c.fault(); break;
      case 'recover': c.recover(); break;
    }
    m = step(before, a);
    out.push({ m, s: c.state(), path: done.join(' > ') });
  }
  return out;
}

test('real controller conforms to the spec on every reachable abstract state and action', () => {
  // Breadth-first walk of the spec's reachable states, keeping a shortest script to each.
  const init: M = { mode: 'cycle', i: 0, hold: 'none', faulting: false };
  const paths = new Map<string, A[]>([[key(init), []]]);
  const states = new Map<string, M>([[key(init), init]]);
  const queue: M[] = [init];
  while (queue.length) {
    const m = queue.shift()!;
    for (const a of ACTIONS) {
      const n = step(m, a);
      if (!paths.has(key(n))) {
        paths.set(key(n), [...paths.get(key(m))!, a]);
        states.set(key(n), n);
        queue.push(n);
      }
    }
  }
  expect(paths.size).toBeGreaterThan(20);

  let checked = 0;
  for (const [k, script] of paths) {
    for (const a of ACTIONS) {
      const steps = replay([...script, a]);
      for (const { m, s, path } of steps) {
        // the law: never both green/yellow
        if (go(s.ns) && go(s.ew)) throw new Error(`both axes go after ${path}: ns=${s.ns} ew=${s.ew}`);
        // the spec: the lights are what the model says
        expect({ path, ...s }).toEqual({ path, ...lights(m) });
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(500);
});

test('emergencies, faults and recoveries interleaved at every depth up to 6 keep crossing roads apart', () => {
  const walk = (script: A[]) => {
    for (const { s, path } of replay(script)) {
      if (go(s.ns) && go(s.ew)) throw new Error(`both axes go after ${path}: ns=${s.ns} ew=${s.ew}`);
    }
  };
  const rec = (script: A[], depth: number) => {
    if (depth === 0) { walk(script); return; }
    for (const a of ACTIONS) rec([...script, a], depth - 1);
  };
  rec([], 6);
});
