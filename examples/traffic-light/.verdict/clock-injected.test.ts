// scope: every method of createController() in public/controller.js (state, emergency, clear, fault, recover). Loads a
// fresh copy of the controller with Date, performance and process.hrtime booby-trapped (any use throws), then checks
// the controller follows only the supplied now() across a full cycle, repeatedly, out of order, and through
// emergency/fault/recover sequences. Timers and app.js are not covered.
import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const SRC = readFileSync((process.env.VERDICT_TARGET ?? __dirname + '/..') + '/public/controller.js', 'utf8');

function withTrappedClock<T>(fn: () => T): T {
  const g: any = globalThis;
  const saved = {
    Date: g.Date,
    perfNow: g.performance && g.performance.now,
    hrtime: process.hrtime,
  };
  const trap = () => { throw new Error('real clock read'); };
  const FakeDate: any = function () { trap(); };
  FakeDate.now = trap;
  try {
    g.Date = FakeDate;
    if (g.performance) g.performance.now = trap;
    (process as any).hrtime = trap;
    return fn();
  } finally {
    g.Date = saved.Date;
    if (g.performance) g.performance.now = saved.perfNow;
    (process as any).hrtime = saved.hrtime;
  }
}

function load() {
  const mod: any = { exports: {} };
  new Function('module', SRC)(mod);
  return mod.exports;
}

test('state() depends only on the supplied now(), never on the real clock', () => {
  withTrappedClock(() => {
    const { createController, CYCLE_MS } = load();
    let clock = 0;
    const c = createController({ now: () => clock });
    const expected: Array<[number, string, string]> = [
      [0, 'green', 'red'], [9999, 'green', 'red'], [10000, 'yellow', 'red'],
      [13000, 'red', 'red'], [15000, 'red', 'green'], [25000, 'red', 'yellow'],
      [28000, 'red', 'red'], [CYCLE_MS, 'green', 'red'], [CYCLE_MS * 1000 + 11000, 'yellow', 'red'],
      [0, 'green', 'red'],
    ];
    for (const [t, ns, ew] of expected) {
      clock = t;
      expect(c.state()).toEqual({ ns, ew });
    }
    clock = 16000;
    const a = c.state();
    expect(c.state()).toEqual(a);
  });
});

test('every state() call asks now() exactly once', () => {
  withTrappedClock(() => {
    const { createController } = load();
    let calls = 0;
    const c = createController({ now: () => { calls++; return 12000; } });
    c.state(); c.state(); c.state();
    expect(calls).toBe(3);
  });
});

test('emergency, clear, fault and recover take time only from now()', () => {
  withTrappedClock(() => {
    const { createController } = load();
    let clock = 0;
    const c = createController({ now: () => clock });

    // emergency for ew: hold ew green past its normal length, clear() restarts its clock from now()
    c.emergency('ew');
    clock = 15000;
    expect(c.state()).toEqual({ ns: 'red', ew: 'green' });
    clock = 60000;
    expect(c.state()).toEqual({ ns: 'red', ew: 'green' });
    c.clear();
    clock = 62999;
    expect(c.state()).toEqual({ ns: 'red', ew: 'green' });
    clock = 70000;
    expect(c.state()).toEqual({ ns: 'red', ew: 'yellow' });

    // fault while green-ish: waits for all red, then both red
    c.fault();
    clock = 80000;
    expect(c.state()).toEqual({ ns: 'red', ew: 'red' });
    clock = 500000;
    expect(c.state()).toEqual({ ns: 'red', ew: 'red' });

    // recover restarts from all red at now()
    clock = 600000;
    c.recover();
    expect(c.state()).toEqual({ ns: 'red', ew: 'red' });
    clock = 601999;
    expect(c.state()).toEqual({ ns: 'red', ew: 'red' });
    clock = 602000;
    expect(c.state()).toEqual({ ns: 'red', ew: 'green' });

    // fault while held green: the held green restarts its clock at now()
    c.emergency('ew');
    clock = 650000;
    c.fault();
    expect(c.state()).toEqual({ ns: 'red', ew: 'green' });
  });
});
