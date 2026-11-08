// scope: public/controller.js loaded in an isolated vm context where every real-clock global
// (Date, performance, setTimeout, setInterval, requestAnimationFrame, process.hrtime, Intl) throws when touched.
// Runs createController/state() at several injected times and checks the answer depends only on `now`.
// Not covered: app.js (the page driver), which may read the real clock to feed `now`.
import { test, expect } from 'bun:test';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.env.VERDICT_TARGET ?? path.join(__dirname, '..'), 'public', 'controller.js'), 'utf8');

function load() {
  const ctx: any = vm.createContext({});
  vm.runInContext(
    `['Date','performance','setTimeout','setInterval','requestAnimationFrame','Intl','process','queueMicrotask','setImmediate'].forEach(function (n) {
       Object.defineProperty(globalThis, n, { configurable: true, get: function () { throw new Error('controller touched real clock: ' + n); } });
     });`,
    ctx,
  );
  vm.runInContext(src, ctx, { filename: 'controller.js' });
  return ctx.TrafficController;
}

test('controller never touches a real-clock global; time comes only from now', () => {
  const { createController } = load();
  const times = [0, 9999, 10000, 12999, 13000, 14999, 15000, 25000, 28000, 29999, 30000, 123456789, -1];
  for (const t of times) {
    let clock = t;
    let calls = 0;
    const c = createController({ now: () => { calls++; return clock; } });
    const a = c.state();
    expect(calls).toBeGreaterThan(0);
    // same injected time -> same answer, regardless of how much real time passes
    const b = c.state();
    expect(b).toEqual(a);
  }
  // injected time moves the state; the controller follows it
  let clock = 0;
  const c = createController({ now: () => clock });
  expect(c.state()).toEqual({ ns: 'green', ew: 'red' });
  clock = 11000;
  expect(c.state()).toEqual({ ns: 'yellow', ew: 'red' });
  clock = 16000;
  expect(c.state()).toEqual({ ns: 'red', ew: 'green' });
});
