import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reproveLaw } from "../src/reprove.ts";
import { readBreaks, writeBreaks, prove } from "../src/breaks.ts";
import { checkLaw, format } from "../src/check.ts";
import { parseLaws } from "../src/laws.ts";
import { readLock, type Lock } from "../src/lock.ts";
import { overrides } from "../src/models.ts";
import { overrides as agents } from "../src/agent.ts";
import { plan } from "../src/plan.ts";
import { at } from "../src/where.ts";
import { repo, scriptedAgent } from "./helpers.ts";

afterEach(() => {
  delete agents.agent;
});

const LAW = "Amounts are stored in cents.";
const [law] = parseLaws(`- ${LAW}`);
const script = "#!/bin/sh\n# scope: src/money.ts only\ngrep -q cents src/money.ts\n";
const enforcer = { kind: "test", path: ".verdict/cents.sh" };
const write = { tool: "write_file", input: { path: ".verdict/cents.sh", content: script, executable: true } };
const goodBreak = { enforcer: ".verdict/cents.sh", description: "store dollars", edits: [{ path: "src/money.ts", find: "cents", replace: "dollars" }] };
const uselessBreak = { enforcer: ".verdict/cents.sh", description: "rename a variable", edits: [{ path: "src/money.ts", find: "amount", replace: "value" }] };
const submit = (extra: object) => ({ tool: "submit", input: { enforcers: [enforcer], breaks: [], suggestions: [], ...extra } });

function money(text = "export const amount = 0; // cents\n") {
  return repo({ "src/money.ts": text });
}

async function runPlan(root: string, calls: { tool: string; input: unknown }[]) {
  const model = scriptedAgent(calls);
  agents.agent = model;
  const log: string[] = [];
  const ok = await plan(at(root), join(root, "VERDICT.lock"), [law!], new Map(), (l) => log.push(l));
  return { ok, log: log.join("\n"), model };
}

test("plan only accepts an enforcer once it has been seen to fail", async () => {
  const root = money();
  const { ok, log, model } = await runPlan(root, [write, submit({}), submit({ breaks: [uselessBreak] }), submit({ breaks: [goodBreak] })]);
  expect(ok).toBe(true);
  const said = model.results.join("\n");
  expect(said).toContain("passes today; submit a break");
  expect(said).toContain("still passes with the break");
  expect(log).toContain("caught its break: store dollars");
  expect(readLock(join(root, "VERDICT.lock")).get(law!.hash)?.enforcers).toEqual([enforcer]);
  expect(readBreaks(root, law!.hash)).toEqual([goodBreak]);
  expect(readFileSync(join(root, "src/money.ts"), "utf8")).toContain("cents"); // the repo was never broken
});

test("plan rejects an enforcer without a scope line", async () => {
  const root = money();
  const noScope = { tool: "write_file", input: { path: ".verdict/cents.sh", content: "#!/bin/sh\ngrep -q cents src/money.ts\n", executable: true } };
  const { ok, model } = await runPlan(root, [noScope, submit({ breaks: [goodBreak] })]);
  expect(ok).toBe(false);
  expect(model.results.join("\n")).toContain('has no "scope:" line');
});

test("a law that is false today needs a finding, not a weaker enforcer", async () => {
  const root = money("export const amount = 0.5; // dollars\n");
  const { ok, log, model } = await runPlan(root, [write, submit({}), submit({ finding: "src/money.ts:1 stores 0.5 dollars as a float. Harm: rounding errors." })]);
  expect(ok).toBe(true);
  expect(model.results.join("\n")).toContain("describe the counterexample in finding");
  expect(log).toContain("finding: the law looks false in today's code");
});

test("plan rejects enforcers outside .verdict/", async () => {
  const root = repo({ "src/x.test.ts": "" });
  const { ok, model } = await runPlan(root, [{ tool: "submit", input: { enforcers: [{ kind: "test", path: "src/x.test.ts" }], breaks: [], suggestions: [] } }]);
  expect(ok).toBe(false);
  expect(model.results.join("\n")).toContain("outside .verdict");
});

test("a break runs on a scratch copy of the working tree, never the repo", async () => {
  const root = repo({ "src/money.ts": "export const amount = 0; // cents\n", ".verdict/cents.sh": script }, [".verdict/cents.sh"]);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  Bun.spawnSync(["git", "add", "src/money.ts"], { cwd: root }); // .verdict/ stays untracked
  writeFileSync(join(root, "src/money.ts"), "export const amount = 0; // cents, uncommitted\n");
  const uncommitted = { ...goodBreak, edits: [{ path: "src/money.ts", find: "cents, uncommitted", replace: "dollars" }] };
  expect((await prove(at(root), LAW, enforcer, uncommitted)).kind).toBe("caught");
  expect(readFileSync(join(root, "src/money.ts"), "utf8")).toContain("cents, uncommitted");
});

function planned(text = "export const amount = 0; // cents\n", enforcerScript = script) {
  const root = repo({ "src/money.ts": text, ".verdict/cents.sh": enforcerScript }, [".verdict/cents.sh"]);
  writeBreaks(root, law!.hash, [goodBreak]);
  const lock: Lock = new Map([[law!.hash, { law: LAW, enforcers: [enforcer] }]]);
  return { root, lock };
}

test("re-proof: in sync when every enforcer still catches its break", async () => {
  const { root, lock } = planned();
  expect((await reproveLaw(at(root), law!, lock)).outcome).toBe("in sync");
});

test("re-proof: drift when the code moved and the break no longer applies", async () => {
  const { root, lock } = planned("export const amountInCents = 0;\n"); // "cents" is still there, once
  writeFileSync(join(root, "src/money.ts"), "export const total = 0; // stored as cents\nexport const fee = 0; // cents\n");
  const r = await reproveLaw(at(root), law!, lock);
  expect(r.outcome).toBe("drift");
  expect(r.findings[0]!.result.message).toContain("no longer applies");
});

test("re-proof: drift when an enforcer passes on code broken on purpose", async () => {
  const { root, lock } = planned(undefined, "#!/bin/sh\n# scope: nothing, by mistake\nexit 0\n");
  const r = await reproveLaw(at(root), law!, lock);
  expect(r.outcome).toBe("drift");
  expect(r.findings[0]!.result.message).toContain("can't see this break");
});

test("plan re-plans a drifted law with the triage rules, and leaves in-sync laws alone", async () => {
  const { root, lock } = planned(undefined, "#!/bin/sh\n# scope: nothing, by mistake\nexit 0\n");
  const model = scriptedAgent([write, submit({ breaks: [goodBreak] })]);
  agents.agent = model;
  const log: string[] = [];
  expect(await plan(at(root), join(root, "VERDICT.lock"), [law!], lock, (l) => log.push(l))).toBe(true);
  expect(log.join("\n")).toContain("drift: Amounts are stored in cents.");
  expect(model.prompts[0]).toContain("Never weaken an enforcer to make it pass");
  // Synced now: a second run re-proves it without calling the model.
  const again = scriptedAgent([]);
  agents.agent = again;
  const log2: string[] = [];
  expect(await plan(at(root), join(root, "VERDICT.lock"), [law!], readLock(join(root, "VERDICT.lock")), (l) => log2.push(l))).toBe(true);
  expect(log2.join("\n")).toContain("in sync: Amounts are stored in cents.");
  expect(again.prompts.length).toBe(0);
});

test("plan reports a law that already failed when planned, without re-planning it", async () => {
  const { root, lock } = planned("export const amount = 0.5;\n");
  writeBreaks(root, law!.hash, []); // it failed when planned, so it has no break
  const model = scriptedAgent([]);
  agents.agent = model;
  const log: string[] = [];
  await plan(at(root), join(root, "VERDICT.lock"), [law!], lock, (l) => log.push(l));
  expect(log.join("\n")).toContain("fails today: Amounts are stored in cents.");
  expect(model.prompts.length).toBe(0);
});

test("a test that exits 77 is inconclusive, and check prints scopes on a pass", async () => {
  const root = repo({ "src/money.ts": "cents", ".verdict/cents.sh": script, ".verdict/svc.sh": "#!/bin/sh\necho 'payments sandbox is down'\nexit 77\n" }, [".verdict/cents.sh", ".verdict/svc.sh"]);
  const skipped = await checkLaw(at(root), { law: LAW, enforcers: [{ kind: "test", path: ".verdict/svc.sh" }] });
  expect(skipped.status).toBe("inconclusive");
  expect(skipped.details[0]!.result.message).toContain("payments sandbox is down");
  const ok = await checkLaw(at(root), { law: LAW, enforcers: [enforcer] });
  expect(format([ok])).toContain("pass (scope: src/money.ts only)");
});

test("plan re-plans a law that passed when planned and fails now", async () => {
  const { root, lock } = planned("export const amount = 0.5;\n"); // its break exists: it passed once
  const model = scriptedAgent([submit({ finding: "src/money.ts:1 is a float again" })]);
  agents.agent = model;
  const log: string[] = [];
  await plan(at(root), join(root, "VERDICT.lock"), [law!], lock, (l) => log.push(l));
  expect(log.join("\n")).toContain("newly failing: Amounts are stored in cents.");
  expect(model.prompts[0]).toContain("passed when it was planned");
  expect(model.prompts[0]).toContain("something incidental");
});

test("the planner is told when TLC is available and when a proof beats a test", async () => {
  const root = money();
  const jar = join(root, "tla2tools.jar");
  writeFileSync(jar, "");
  process.env.VERDICT_TLA2TOOLS = jar;
  try {
    const { model } = await runPlan(root, []);
    expect(model.prompts[0]).toContain("tlc (tla2tools.jar via VERDICT_TLA2TOOLS)");
  } finally {
    delete process.env.VERDICT_TLA2TOOLS;
  }
  const { SYSTEM } = await import("../src/plan.ts");
  expect(SYSTEM).toContain("a test only covers the schedules you wrote down");
});
