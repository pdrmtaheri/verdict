// scope: createController().state() in public/controller.js, every integer millisecond across 3 full cycles,
// plus negative, fractional, and very large clock values. Rendering in app.js is not covered
// (it paints one state() result per frame to both axes).
import { test, expect } from 'bun:test';
const { createController, CYCLE_MS } = require((process.env.VERDICT_TARGET ?? __dirname + '/..') + '/public/controller.js');

const VALID = ['red', 'yellow', 'green'];

function at(t: number) {
  return createController({ now: () => t }).state();
}

function check(t: number) {
  const s = at(t);
  expect(VALID).toContain(s.ns);
  expect(VALID).toContain(s.ew);
  const nsGo = s.ns === 'green' || s.ns === 'yellow';
  const ewGo = s.ew === 'green' || s.ew === 'yellow';
  if (nsGo && ewGo) throw new Error(`both axes go at t=${t}: ns=${s.ns} ew=${s.ew}`);
}

test('ns and ew are never both green/yellow at any millisecond over 3 cycles', () => {
  for (let t = 0; t < CYCLE_MS * 3; t++) check(t);
});

test('never both going at fractional, negative or huge clock values', () => {
  for (let t = -CYCLE_MS * 2; t < CYCLE_MS * 2; t += 7.3) check(t);
  for (const t of [1e9, 1e12 + 0.5, -1e9, -1, -0.5, 0.5, CYCLE_MS - 0.001, CYCLE_MS, CYCLE_MS + 0.001]) check(t);
});

test('one controller stays safe as its clock advances between calls', () => {
  let clock = 0;
  const c = createController({ now: () => clock });
  for (; clock < CYCLE_MS * 2; clock += 13) {
    const s = c.state();
    expect(s.ns !== 'red' && s.ew !== 'red').toBe(false);
  }
});
