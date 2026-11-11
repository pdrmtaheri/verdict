// scope: every method of createController() in public/controller.js (state, emergency, clear, fault, recover), and
// createController() given no clock at all. Loads a fresh copy of the controller with Date, performance and
// process.hrtime booby-trapped (any use throws), then checks the answers depend only on the supplied now(): the same
// times and events give the same lights, whatever the real clock says. It does not check the schedule itself (which
// light shows when); other laws do. Timers and app.js are not covered.
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

// The lights a controller shows at each step of a script of times and events.
function replay(createController: any, script: Array<number | string>): string[] {
  let clock = 0;
  const c = createController({ now: () => clock });
  const seen: string[] = [];
  for (const step of script) {
    if (typeof step === 'number') clock = step;
    else c[step](step === 'emergency' ? 'ew' : undefined);
    const s = c.state();
    seen.push(`${clock}:${s.ns}/${s.ew}`);
  }
  return seen;
}

test('state() depends only on the supplied now(), never on the real clock', () => {
  withTrappedClock(() => {
    const { createController, CYCLE_MS } = load();
    const times = [0, 9999, 10000, 13000, 15000, 25000, 28000, CYCLE_MS, CYCLE_MS * 1000 + 11000, 0, 16000, 16000];
    // Two controllers fed the same times agree, and asking twice at one time gives one answer.
    expect(replay(createController, times)).toEqual(replay(createController, times));
    let clock = 16000;
    const c = createController({ now: () => clock });
    expect(c.state()).toEqual(c.state());
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
    const script = ['emergency', 15000, 60000, 'clear', 62999, 70000, 'fault', 80000, 500000, 600000, 'recover', 601999, 602000, 'emergency', 650000, 'fault', 700000];
    expect(replay(createController, script)).toEqual(replay(createController, script));
  });
});

test('a controller given no clock never falls back to the real one', () => {
  withTrappedClock(() => {
    const { createController } = load();
    // Refusing to run without a clock is fine; reading the real clock instead is not.
    let error = '';
    try {
      createController({}).state();
    } catch (e) {
      error = String(e);
    }
    expect(error).not.toContain('real clock read');
  });
});
