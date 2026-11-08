import { expect, test } from "bun:test";
import { explain } from "../src/playground/explain.ts";

const BUN_ASSERT = `bun test v1.4.3 (c6da4a4d3)

.verdict/green-each-cycle.test.ts:
18 |         if (c.state()[axis] === 'green') greenMs += 1;
19 |       }
20 |       expect(greenMs).toBeGreaterThanOrEqual(1000);
                                           ^
error: expect(received).toBeGreaterThanOrEqual(expected)
Expected: >= 1000
Received: 0
      at <anonymous> (/tmp/x/.verdict/green-each-cycle.test.ts:20:23)
(fail) each road gets a real green in every aligned full cycle [3.81ms]
39 |     expect(sawGreen).toBe(true);
                                          ^
error: expect(received).toBe(expected)
Expected: true
Received: false
      at <anonymous> (/tmp/x/.verdict/green-each-cycle.test.ts:39:22)
(fail) neither road waits a full cycle without green [6.49ms]
 0 pass
 2 fail
 2 expect() calls
Ran 2 tests across 1 file. [14.00ms]`;

test("a failing bun test becomes plain sentences, with the raw output kept", () => {
  const e = explain("test", "fail", BUN_ASSERT);
  expect(e.headline).toBe("2 of 2 checks failed.");
  expect(e.points.map((p) => p.text)).toEqual([
    "Each road gets a real green in every aligned full cycle — expected at least 1000, got 0",
    "Neither road waits a full cycle without green — expected true, got false",
  ]);
  expect(e.raw).toContain("at <anonymous>");
  for (const p of e.points) expect(p.text).not.toMatch(/\.test\.ts|\bat </);
});

test("a crash in the code under test says it crashed, not just a stack frame", () => {
  const e = explain("test", "fail", `bun test v1.4.3\n\n.verdict/s.test.ts:\nTypeError: undefined is not an object (evaluating 'statusEl.className = 'status'')\n      at syncButtons (app.js:110:15)\n(fail) readout names every lit lamp [1.2ms]\n 0 pass\n 1 fail`);
  expect(e.headline).toBe("1 of 1 check failed.");
  expect(e.points[0]!.text).toContain("the code crashed with TypeError: undefined is not an object");
});

const SEMGREP = `┌────────────────┐
│ 1 Code Finding │
└────────────────┘

    public/controller.js
   ❯❯❱ verdict.controller-reads-real-clock
          ❰❰ Blocking ❱❱
          The controller must not read the real clock; take time only from the \`now\` function in opts.

           24┆ var now = function () { return Date.now(); };`;

test("a Semgrep finding names the file, line, rule message and the offending code", () => {
  const e = explain("semgrep", "fail", SEMGREP);
  expect(e.headline).toBe("A code rule found 1 problem.");
  expect(e.points[0]!.text).toBe("public/controller.js:24 — The controller must not read the real clock; take time only from the `now` function in opts.");
  expect(e.points[0]!.code).toBe("var now = function () { return Date.now(); };");
});

test("a TLC violation reads as a sequence of steps", () => {
  const e = explain("tla", "fail", `Error: Invariant Inv is violated.\nError: The behavior up to this point is:\nState 1: <Initial predicate>\nx = 0\nState 2: <Next line 5, col 9 to line 5, col 18 of module m>\nx = 1\n2 states generated`);
  expect(e.headline).toBe("The model checker found a sequence of steps that breaks “Inv”.");
  expect(e.points.map((p) => p.text)).toEqual(["Step 1 (start): x = 0", "Step 2 (next step): x = 1"]);
});

test("a stale spec, a judge's reasoning and unknown output are passed through readably", () => {
  expect(explain("tla", "fail", "the code this spec models changed: public/controller.js (was a, now b). Run `verdict plan`: it re-stamps").raw).toBe("");
  expect(explain("llm", "fail", "app.js:134 writes the text, but it is the same color as the page.").headline).toContain("same color");
  const odd = explain("test", "inconclusive", "bun is not installed");
  expect(odd.headline).toBe("Bun is not installed.");
  expect(explain("test", "fail", "").headline).toContain("printed nothing");
});

test("output cut from the top still says what went wrong when a diff is left", () => {
  const e = explain("test", "fail", `…\n- [\n-   "ew->ns",\n- ]\n+ []\n\n- Expected  - 4\n+ Received  + 1\n\n      at <anonymous> (/tmp/x.test.ts:60:28)\n(fail) every all-red run lasts at least the clearance time [2.3ms]\n 0 pass\n 1 fail`);
  expect(e.points[0]!.text).toBe("Every all-red run lasts at least the clearance time — the result was not what the test expected");
});
