// scope: createController().state() in public/controller.js, one controller whose clock advances
// monotonically in 0.5 ms steps across 3 full cycles (including the wrap). Whenever either road turns green,
// or stops going (yellow -> red) while the other is going, the previous sample must have been both-red, and each
// both-red gap must last at least 1 ms. Rendering in app.js and non-monotonic clocks are not covered.
import { test, expect } from 'bun:test';
const { createController, CYCLE_MS } = require((process.env.VERDICT_TARGET ?? __dirname + '/..') + '/public/controller.js');

type S = { ns: string; ew: string };
const allRed = (s: S) => s.ns === 'red' && s.ew === 'red';
const go = (c: string) => c === 'green' || c === 'yellow';

test('the other road only turns green after a both-red moment, and the gap lasts at least 1 ms', () => {
  let clock = 0;
  const c = createController({ now: () => clock });
  let prev: S = c.state();
  let gapStart: number | null = allRed(prev) ? 0 : null;
  let gaps = 0;
  for (clock = 0.5; clock < CYCLE_MS * 3; clock += 0.5) {
    const cur: S = c.state();
    for (const [a, b] of [['ns', 'ew'], ['ew', 'ns']] as const) {
      if (cur[b] === 'green' && prev[b] !== 'green' && !allRed(prev)) {
        throw new Error(`${b} went green at t=${clock} without both-red first (prev ns=${prev.ns} ew=${prev.ew})`);
      }
      if (go(prev[a]) && !go(cur[a]) && go(cur[b])) {
        throw new Error(`${a} went red while ${b} is ${cur[b]} at t=${clock}`);
      }
    }
    if (allRed(cur) && gapStart === null) gapStart = clock;
    if (!allRed(cur) && gapStart !== null) {
      expect(clock - gapStart).toBeGreaterThanOrEqual(1);
      gaps++;
      gapStart = null;
    }
    prev = cur;
  }
  // two both-red gaps per cycle; the last one is still open when the loop ends
  expect(gaps).toBeGreaterThanOrEqual(5);
});
