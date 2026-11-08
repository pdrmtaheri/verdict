// scope: createController().state() in public/controller.js, one controller driven by a fake clock at 1 ms steps
// over 3 full cycles from t=0 (including the wrap), for both the ns and ew light. Checks: in every aligned
// full cycle both roads show green for a real stretch (>= 1s), the longest stretch either road spends
// without green is shorter than one cycle (including across the wrap), and each road is still getting
// green at the end of the run. Rendering in app.js and non-monotonic clocks are not covered.
import { test, expect } from 'bun:test';
const { createController, CYCLE_MS } = require((process.env.VERDICT_TARGET ?? __dirname + '/..') + '/public/controller.js');

const AXES = ['ns', 'ew'] as const;

test('each road gets a real green in every aligned full cycle', () => {
  let clock = 0;
  const c = createController({ now: () => clock });
  for (let k = 0; k < 3; k++) {
    for (const axis of AXES) {
      let greenMs = 0;
      for (clock = k * CYCLE_MS; clock < (k + 1) * CYCLE_MS; clock += 1) {
        if (c.state()[axis] === 'green') greenMs += 1;
      }
      expect(greenMs).toBeGreaterThanOrEqual(1000);
    }
  }
});

test('neither road waits a full cycle without green', () => {
  let clock = 0;
  const c = createController({ now: () => clock });
  for (const axis of AXES) {
    let lastGreen = -1;
    let longestWait = 0;
    let sawGreen = false;
    for (clock = 0; clock < CYCLE_MS * 3; clock += 1) {
      if (c.state()[axis] === 'green') {
        if (sawGreen) longestWait = Math.max(longestWait, clock - lastGreen - 1);
        sawGreen = true;
        lastGreen = clock;
      }
    }
    expect(sawGreen).toBe(true);
    expect(longestWait).toBeLessThan(CYCLE_MS);
    expect(lastGreen).toBeGreaterThan(CYCLE_MS * 2);
  }
});
