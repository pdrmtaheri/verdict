import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Experimental_DecisionModel } from "ai";
import { check, checkLaw, exitCode } from "../src/check.ts";
import { parseLaws } from "../src/laws.ts";
import { readLock, writeLock, type Lock } from "../src/lock.ts";
import { overrides } from "../src/models.ts";
import { overrides as agents } from "../src/agent.ts";
import { stampModels } from "../src/specbind.ts";
import { inside } from "../src/tools.ts";
import { at } from "../src/where.ts";
import { repo, scriptedAgent } from "./helpers.ts";

afterEach(() => {
  delete agents.agent;
  delete overrides.decision;
});

const law = "Money is never a float.";

function decisionModel(choice: string, p: number): Experimental_DecisionModel & { calls: number } {
  const m = {
    specificationVersion: "v4" as const,
    provider: "mock",
    modelId: "mock",
    supportedQuestionTypes: ["choice"] as const,
    calls: 0,
    async doDecide() {
      m.calls++;
      const others = ["pass", "fail", "inconclusive"].filter((c) => c !== choice);
      const probabilities = { [choice]: p, [others[0]!]: (1 - p) / 2, [others[1]!]: (1 - p) / 2 };
      return { answers: { verdict: { type: "choice" as const, choice, probabilities } }, warnings: [] };
    },
  };
  return m;
}

test("an executable test passes or fails the law by exit code", async () => {
  const root = repo({ ".verdict/ok.sh": "#!/bin/sh\nexit 0\n", ".verdict/bad.sh": "#!/bin/sh\necho 'found 0.1 + 0.2'\nexit 1\n" }, [".verdict/ok.sh", ".verdict/bad.sh"]);
  expect((await checkLaw(at(root), { law, enforcers: [{ kind: "test", path: ".verdict/ok.sh" }] })).status).toBe("pass");
  const bad = await checkLaw(at(root), { law, enforcers: [{ kind: "test", path: ".verdict/bad.sh" }] });
  expect(bad.status).toBe("fail");
  expect(bad.details[0]!.result.message).toContain("found 0.1 + 0.2");
});

test("unplanned laws fail the check; inconclusive ones don't", async () => {
  const laws = parseLaws(`- ${law}\n- Another law.`);
  const lock: Lock = new Map([[laws[0]!.hash, { law, enforcers: [{ kind: "semgrep", path: ".verdict/r.yml" }] }]]);
  const root = repo({ ".verdict/r.yml": "rules: []\n" });
  const reports = await check(at(root), laws, lock);
  expect(reports.map((r) => r.status)).toEqual([Bun.which("semgrep") ? reports[0]!.status : "inconclusive", "unplanned"]);
  expect(exitCode(reports)).toBe(1);
  expect(exitCode(reports.slice(0, 1).map((r) => ({ ...r, status: "inconclusive" as const })))).toBe(0);
});

test("a missing enforcer file fails the law", async () => {
  const root = repo({});
  const r = await checkLaw(at(root), { law, enforcers: [{ kind: "test", path: ".verdict/gone.sh" }] });
  expect(r.status).toBe("fail");
});

test("the LLM judge reads the repo and reports its verdict", async () => {
  const root = repo({ "src/price.ts": "export const price = 9.99;\n", ".verdict/money.judge.md": "Look in src/." });
  const model = scriptedAgent([
    { tool: "read_file", input: { path: "src/price.ts" } },
    { tool: "submit", input: { status: "fail", reason: "src/price.ts:1 stores 9.99 as a float" } },
  ]);
  agents.agent = model;
  const r = await checkLaw(at(root), { law, enforcers: [{ kind: "llm", path: ".verdict/money.judge.md" }] });
  expect(r.status).toBe("fail");
  expect(r.details[0]!.result.message).toContain("src/price.ts:1");
  expect(model.results.join("\n")).toContain("export const price = 9.99");
});

const decisionFile = JSON.stringify({
  state_from: "cat msgs.txt",
  instructions: "Does every message name a next step?",
  criteria: { pass: "Every message names one", fail: "One doesn't", inconclusive: "Can't tell" },
});

test("a confident decision model skips the LLM judge", async () => {
  const root = repo({ "msgs.txt": "Try again later.", ".verdict/e.decision.json": decisionFile, ".verdict/e.judge.md": "" });
  overrides.decision = decisionModel("pass", 0.95);
  const judge = scriptedAgent([]);
  agents.agent = judge;
  const r = await checkLaw(at(root), { law, enforcers: [{ kind: "decision", path: ".verdict/e.decision.json" }, { kind: "llm", path: ".verdict/e.judge.md" }] });
  expect(r.status).toBe("pass");
  expect(judge.prompts.length).toBe(0);
});

test("an unsure decision model falls back to the LLM judge", async () => {
  const root = repo({ "msgs.txt": "Oops.", ".verdict/e.decision.json": decisionFile, ".verdict/e.judge.md": "" });
  overrides.decision = decisionModel("fail", 0.6);
  agents.agent = scriptedAgent([{ tool: "submit", input: { status: "fail", reason: "msgs.txt:1 gives no next step" } }]);
  const r = await checkLaw(at(root), { law, enforcers: [{ kind: "decision", path: ".verdict/e.decision.json" }, { kind: "llm", path: ".verdict/e.judge.md" }] });
  expect(r.status).toBe("fail");
  expect(r.details.map((d) => d.kind)).toEqual(["llm"]);
});

test("a decision model without a judge stays inconclusive when unsure", async () => {
  const root = repo({ "msgs.txt": "Oops.", ".verdict/e.decision.json": decisionFile });
  overrides.decision = decisionModel("fail", 0.6);
  const r = await checkLaw(at(root), { law, enforcers: [{ kind: "decision", path: ".verdict/e.decision.json" }] });
  expect(r.status).toBe("inconclusive");
});

test("tool paths can't leave the repo or, for writes, .verdict/", () => {
  const root = repo({ "a.txt": "" });
  expect(() => inside(root, "../x")).toThrow();
  expect(() => inside(root, "src/../../x")).toThrow();
  expect(() => inside(root, "src/new.ts", join(root, ".verdict"))).toThrow();
  expect(inside(root, ".verdict/x.yml", root)).toBe(join(root, ".verdict/x.yml"));
});

test("the lock round-trips and drops removed laws", () => {
  const root = repo({});
  const laws = parseLaws(`- ${law}\n- Gone soon.`);
  const lock: Lock = new Map(laws.map((l) => [l.hash, { law: l.text, enforcers: [{ kind: "llm", path: ".verdict/j.md" }] }]));
  const file = join(root, "VERDICT.lock");
  writeLock(file, lock, laws.slice(0, 1));
  const back = readLock(file);
  expect([...back.keys()]).toEqual([laws[0]!.hash]);
  expect(readFileSync(file, "utf8")).toContain("- llm: .verdict/j.md");
});

test("the planner may run its own scripts in .verdict/, but nothing else outside the allowlist", async () => {
  const { writeTools } = await import("../src/tools.ts");
  const root = repo({ ".verdict/t.sh": "#!/bin/sh\necho hi\n", "evil.sh": "#!/bin/sh\necho no\n" }, [".verdict/t.sh", "evil.sh"]);
  const run = writeTools(root, join(root, ".verdict")).run;
  const call = (argv: string[]) => run.execute({ argv } as never);
  expect(await call(["./.verdict/t.sh"])).toContain("hi");
  await expect(call(["./evil.sh"])).rejects.toThrow("outside .verdict");
  await expect(call(["curl", "example.com"])).rejects.toThrow("not allowed");
});

test("grep skips tracked symlinks that point outside the repo; git rejects writing flags", async () => {
  const { readTools } = await import("../src/tools.ts");
  const { symlinkSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const outside = mkdtempSync(join(process.env.TMPDIR!, "verdict-outside-"));
  writeFileSync(join(outside, "secret.txt"), "TOKEN=hunter2\n");
  const root = repo({ "a.txt": "hello\n" });
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  const tools = readTools(root);
  expect(await tools.list_files.execute({} as never)).toContain("link.txt");
  expect(await tools.grep.execute({ pattern: "TOKEN" } as never)).toBe("(no matches)");
  await expect(tools.git.execute({ args: ["diff", "--output=/tmp/x"] } as never)).rejects.toThrow("not allowed");
  await expect(tools.git.execute({ args: ["diff", "--no-index", "/etc/hosts", "a.txt"] } as never)).rejects.toThrow("not allowed");
  await expect(tools.git.execute({ args: ["blame", "--ignore-revs-file=/etc/hosts", "a.txt"] } as never)).rejects.toThrow("not allowed");
  await expect(tools.git.execute({ args: ["diff", outside] } as never)).rejects.toThrow("outside");
  expect(await tools.git.execute({ args: ["ls-files", "a.txt"] } as never)).toContain("a.txt");
});

test("tool input is validated before a tool runs, whichever agent calls it", async () => {
  const { callTool, defineTool } = await import("../src/agent.ts");
  const { z } = await import("zod");
  let ran = false;
  const t = defineTool({ description: "", schema: z.object({ path: z.string() }), execute: async () => ((ran = true), "ok") });
  const bad = await callTool(t, { path: 42 });
  expect(bad.isError).toBe(true);
  expect(ran).toBe(false);
  expect(await callTool(t, { path: "a" })).toEqual({ text: "ok", isError: false });
  const boom = defineTool({ description: "", schema: z.object({}), execute: async () => { throw new Error("nope"); } });
  expect(await callTool(boom, {})).toEqual({ text: "nope", isError: true });
});

// Runs only where TLC is available (tlc on PATH or VERDICT_TLA2TOOLS / the TLA+ Toolbox's jar).
const toolboxJar = "/Applications/TLA+ Toolbox.app/Contents/Eclipse/tla2tools.jar";
const tlcAvailable = !!Bun.which("tlc") || !!process.env.VERDICT_TLA2TOOLS || (await Bun.file(toolboxJar).exists());
test.skipIf(!tlcAvailable)("a TLA+ enforcer passes when its invariant holds and fails when it's violated", async () => {
  const saved = process.env.VERDICT_TLA2TOOLS;
  if (!Bun.which("tlc") && !saved) process.env.VERDICT_TLA2TOOLS = toolboxJar;
  // A spec must name the code it models, stamped with its hash, or it is stale.
  const spec = (inv: string) => `---- MODULE Counter ----\n\\* models: counter.js\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = (x + 1) % 4\nSpec == Init /\\ [][Next]_x\nInv == ${inv}\n====\n`;
  try {
    const ok = repo({ "counter.js": "let x = 0;\n", ".verdict/Counter.tla": spec("x <= 3"), ".verdict/Counter.cfg": "SPECIFICATION Spec\nINVARIANT Inv\n" });
    stampModels(ok, ".verdict/Counter.tla");
    const okR = await checkLaw(at(ok), { law, enforcers: [{ kind: "tla", path: ".verdict/Counter.tla" }] });
    expect(okR.details[0]!.result.message).not.toContain("Cannot find source file");
    expect(okR.status).toBe("pass");
    const bad = repo({ "counter.js": "let x = 0;\n", ".verdict/Counter.tla": spec("x <= 2"), ".verdict/Counter.cfg": "SPECIFICATION Spec\nINVARIANT Inv\n" });
    stampModels(bad, ".verdict/Counter.tla");
    expect((await checkLaw(at(bad), { law, enforcers: [{ kind: "tla", path: ".verdict/Counter.tla" }] })).status).toBe("fail");
  } finally {
    if (saved === undefined) delete process.env.VERDICT_TLA2TOOLS;
    else process.env.VERDICT_TLA2TOOLS = saved;
  }
}, 60_000);

test("a decision enforcer without TYPESAFE_AI_API_KEY says to set it", async () => {
  const saved = process.env.TYPESAFE_AI_API_KEY;
  delete process.env.TYPESAFE_AI_API_KEY;
  try {
    const root = repo({ "msgs.txt": "error: failed\n", ".verdict/msgs.decision.json": decisionFile });
    const r = await checkLaw(at(root), { law, enforcers: [{ kind: "decision", path: ".verdict/msgs.decision.json" }] });
    expect(r.status).toBe("inconclusive");
    expect(r.details[0]!.result.message).toContain("set it to your TypeSafe AI key");
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_AI_API_KEY = saved;
  }
});
