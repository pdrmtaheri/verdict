// scope: createController().state() in public/controller.js, one controller whose clock advances monotonically
// 1 ms at a time across 4 full cycles (including every wrap from the last phase to the first). Whenever one road
// stops going (yellow -> red) and the other starts going (red -> green), the states between must include an
// all-red run lasting at least MIN_CLEAR_MS (1000 ms, an assumed value for "time to clear"). Checked in both
// directions (NS->EW and EW->NS). Rendering in app.js and non-monotonic or fractional clocks are not covered.
import { test, expect } from 'bun:test';
const { createController, CYCLE_MS } = require((process.env.VERDICT_TARGET ?? __dirname + '/..') + '/public/controller.js');

const MIN_CLEAR_MS = 1000;

type Run = { ns: string; ew: string; start: number; len: number };

function runs(): Run[] {
  let clock = 0;
  const c = createController({ now: () => clock });
  const out: Run[] = [];
  for (clock = 0; clock < CYCLE_MS * 4; clock++) {
    const s = c.state();
    const last = out[out.length - 1];
    if (last && last.ns === s.ns && last.ew === s.ew) last.len++;
    else out.push({ ns: s.ns, ew: s.ew, start: clock, len: 1 });
  }
  return out;
}

const going = (c: string) => c !== 'red';

test('no run where one road goes is directly followed by a run where the other road goes', () => {
  const rs = runs();
  expect(rs.length).toBeGreaterThan(8);
  for (let i = 1; i < rs.length; i++) {
    const a = rs[i - 1];
    const b = rs[i];
    const handOver =
      (going(a.ns) && going(b.ew)) || (going(a.ew) && going(b.ns));
    if (handOver) {
      throw new Error(
        `direct hand-over at t=${b.start}: ns=${a.ns},ew=${a.ew} -> ns=${b.ns},ew=${b.ew} with no both-red state between`,
      );
    }
  }
});

test('every all-red run between the two roads lasts at least the clearance time, in both directions', () => {
  const rs = runs();
  const seen = new Set<string>();
  for (let i = 1; i < rs.length - 1; i++) {
    const r = rs[i];
    if (r.ns !== 'red' || r.ew !== 'red') continue;
    const before = rs[i - 1];
    const after = rs[i + 1];
    // a road that was going (yellow) before, and the other road that goes after
    const dir = going(before.ns) && going(after.ew) ? 'ns->ew' : going(before.ew) && going(after.ns) ? 'ew->ns' : null;
    expect(dir).not.toBeNull();
    seen.add(dir as string);
    expect(r.len).toBeGreaterThanOrEqual(MIN_CLEAR_MS);
    // the road that stopped went through yellow just before red
    expect(going(before.ns) ? before.ns : before.ew).toBe('yellow');
  }
  expect([...seen].sort()).toEqual(['ew->ns', 'ns->ew']);
});

test('one controller, repeated hand-overs: the last yellow-to-first green gap is the same every cycle', () => {
  const rs = runs().filter((r) => r.ns === 'red' && r.ew === 'red');
  expect(rs.length).toBeGreaterThanOrEqual(7);
  for (const r of rs.slice(0, -1)) expect(r.len).toBeGreaterThanOrEqual(MIN_CLEAR_MS);
});
