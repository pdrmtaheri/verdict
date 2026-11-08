// scope: createController().state() in public/controller.js, one controller whose clock advances
// monotonically in 0.5 ms steps across 3 full cycles (including the wrap from the last phase back to the first),
// for both the ns and ew light. Every change of colour must be green->yellow, yellow->red or red->green,
// and each light must actually go through all three colours every cycle. Rendering in app.js and
// non-monotonic clocks are not covered.
import { test, expect } from 'bun:test';
const { createController, CYCLE_MS } = require((process.env.VERDICT_TARGET ?? __dirname + '/..') + '/public/controller.js');

const NEXT: Record<string, string> = { green: 'yellow', yellow: 'red', red: 'green' };

test('each light only changes green->yellow->red->green, never skipping yellow or red->yellow', () => {
  let clock = 0;
  const c = createController({ now: () => clock });
  for (const axis of ['ns', 'ew'] as const) {
    clock = 0;
    let prev = c.state()[axis];
    expect(NEXT[prev]).toBeDefined();
    const changes: string[] = [];
    for (clock = 0.5; clock < CYCLE_MS * 3; clock += 0.5) {
      const cur = c.state()[axis];
      if (cur !== prev) {
        if (NEXT[prev] !== cur) throw new Error(`${axis} went ${prev} -> ${cur} at t=${clock}`);
        changes.push(`${prev}>${cur}`);
        prev = cur;
      }
    }
    // each light completes all three kinds of change at least once per cycle
    for (const ch of ['green>yellow', 'yellow>red', 'red>green']) {
      expect(changes.filter((x) => x === ch).length).toBeGreaterThanOrEqual(2);
    }
  }
});
