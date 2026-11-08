import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Experimental_DecisionModel } from "ai";
import { check, checkLaw, exitCode } from "../src/check.ts";
import { parseLaws } from "../src/laws.ts";
import { readLock, writeLock, type Lock } from "../src/lock.ts";
import { overrides } from "../src/models.ts";
import { plan } from "../src/plan.ts";
import { inside } from "../src/tools.ts";
import { repo, scriptedModel } from "./helpers.ts";

afterEach(() => {
  delete overrides.language;
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
  expect((await checkLaw(root, { law, enforcers: [{ kind: "test", path: ".verdict/ok.sh" }] })).status).toBe("pass");
  const bad = await checkLaw(root, { law, enforcers: [{ kind: "test", path: ".verdict/bad.sh" }] });
  expect(bad.status).toBe("fail");
  expect(bad.details[0]!.result.message).toContain("found 0.1 + 0.2");
});

test("unplanned laws fail the check; inconclusive ones don't", async () => {
  const laws = parseLaws(`- ${law}\n- Another law.`);
  const lock: Lock = new Map([[laws[0]!.hash, { law, enforcers: [{ kind: "semgrep", path: ".verdict/r.yml" }] }]]);
  const root = repo({ ".verdict/r.yml": "rules: []\n" });
  const reports = await check(root, laws, lock);
  expect(reports.map((r) => r.status)).toEqual([Bun.which("semgrep") ? reports[0]!.status : "inconclusive", "unplanned"]);
  expect(exitCode(reports)).toBe(1);
  expect(exitCode(reports.slice(0, 1).map((r) => ({ ...r, status: "inconclusive" as const })))).toBe(0);
});

test("a missing enforcer file fails the law", async () => {
  const root = repo({});
  const r = await checkLaw(root, { law, enforcers: [{ kind: "test", path: ".verdict/gone.sh" }] });
  expect(r.status).toBe("fail");
});

test("the LLM judge reads the repo and reports its verdict", async () => {
  const root = repo({ "src/price.ts": "export const price = 9.99;\n", ".verdict/money.judge.md": "Look in src/." });
  const model = scriptedModel([
    { tool: "read_file", input: { path: "src/price.ts" } },
    { tool: "submit", input: { status: "fail", reason: "src/price.ts:1 stores 9.99 as a float" } },
  ]);
  overrides.language = model;
  const r = await checkLaw(root, { law, enforcers: [{ kind: "llm", path: ".verdict/money.judge.md" }] });
  expect(r.status).toBe("fail");
  expect(r.details[0]!.result.message).toContain("src/price.ts:1");
  expect(JSON.stringify(model.prompts.at(-1))).toContain("export const price = 9.99");
});

const decisionFile = JSON.stringify({
  state_from: "cat msgs.txt",
  instructions: "Does every message name a next step?",
  criteria: { pass: "Every message names one", fail: "One doesn't", inconclusive: "Can't tell" },
});

test("a confident decision model skips the LLM judge", async () => {
  const root = repo({ "msgs.txt": "Try again later.", ".verdict/e.decision.json": decisionFile, ".verdict/e.judge.md": "" });
  overrides.decision = decisionModel("pass", 0.95);
  const judge = scriptedModel([]);
  overrides.language = judge;
  const r = await checkLaw(root, { law, enforcers: [{ kind: "decision", path: ".verdict/e.decision.json" }, { kind: "llm", path: ".verdict/e.judge.md" }] });
  expect(r.status).toBe("pass");
  expect(judge.prompts.length).toBe(0);
});

test("an unsure decision model falls back to the LLM judge", async () => {
  const root = repo({ "msgs.txt": "Oops.", ".verdict/e.decision.json": decisionFile, ".verdict/e.judge.md": "" });
  overrides.decision = decisionModel("fail", 0.6);
  overrides.language = scriptedModel([{ tool: "submit", input: { status: "fail", reason: "msgs.txt:1 gives no next step" } }]);
  const r = await checkLaw(root, { law, enforcers: [{ kind: "decision", path: ".verdict/e.decision.json" }, { kind: "llm", path: ".verdict/e.judge.md" }] });
  expect(r.status).toBe("fail");
  expect(r.details.map((d) => d.kind)).toEqual(["llm"]);
});

test("a decision model without a judge stays inconclusive when unsure", async () => {
  const root = repo({ "msgs.txt": "Oops.", ".verdict/e.decision.json": decisionFile });
  overrides.decision = decisionModel("fail", 0.6);
  const r = await checkLaw(root, { law, enforcers: [{ kind: "decision", path: ".verdict/e.decision.json" }] });
  expect(r.status).toBe("inconclusive");
});

test("tool paths can't leave the repo or, for writes, .verdict/", () => {
  const root = repo({ "a.txt": "" });
  expect(() => inside(root, "../x")).toThrow();
  expect(() => inside(root, "src/../../x")).toThrow();
  expect(() => inside(root, "src/new.ts", join(root, ".verdict"))).toThrow();
  expect(inside(root, ".verdict/x.yml", root)).toBe(join(root, ".verdict/x.yml"));
});

test("plan writes enforcers and the lock; check then runs them", async () => {
  const root = repo({ "VERDICT.md": `- ${law}\n` });
  const laws = parseLaws(readFileSync(join(root, "VERDICT.md"), "utf8"));
  overrides.language = scriptedModel([
    { tool: "write_file", input: { path: ".verdict/money.sh", content: "#!/bin/sh\nexit 0\n", executable: true } },
    { tool: "submit", input: { enforcers: [{ kind: "test", path: ".verdict/money.sh" }], suggestions: ["Add a Cents type"] } },
  ]);
  const lockFile = join(root, "VERDICT.lock");
  const log: string[] = [];
  expect(await plan(root, lockFile, laws, new Map(), (l) => log.push(l))).toBe(true);
  expect(log.join("\n")).toContain("suggestion: Add a Cents type");
  expect(log.join("\n")).not.toContain("false in today's code");
  expect(log.join("\n")).not.toContain("inconclusive");
  const lock = readLock(lockFile);
  expect(lock.get(laws[0]!.hash)).toEqual({ law, enforcers: [{ kind: "test", path: ".verdict/money.sh" }] });
});

test("plan rejects enforcers outside .verdict/", async () => {
  const root = repo({ "src/x.test.ts": "" });
  const laws = parseLaws(`- ${law}`);
  overrides.language = scriptedModel([{ tool: "submit", input: { enforcers: [{ kind: "test", path: "src/x.test.ts" }], suggestions: [] } }]);
  const log: string[] = [];
  expect(await plan(root, join(root, "VERDICT.lock"), laws, new Map(), (l) => log.push(l))).toBe(false);
  expect(log.join("\n")).toContain("outside .verdict");
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
  const call = (argv: string[]) => run.execute!({ argv }, { toolCallId: "t", messages: [] } as never);
  expect(await call(["./.verdict/t.sh"])).toContain("hi");
  await expect(call(["./evil.sh"])).rejects.toThrow("outside .verdict");
  await expect(call(["curl", "example.com"])).rejects.toThrow("not allowed");
});
