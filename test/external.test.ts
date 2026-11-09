// Enforcers that are the project's own tests, outside .verdict/.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { overrides as agents } from "../src/agent.ts";
import { check } from "../src/check.ts";
import { passedCount } from "../src/enforcers.ts";
import { parseLaws } from "../src/laws.ts";
import { readLock } from "../src/lock.ts";
import { plan } from "../src/plan.ts";
import { at } from "../src/where.ts";
import { repo, scriptedAgent } from "./helpers.ts";

afterEach(() => {
  delete agents.agent;
});

const [law] = parseLaws("- Amounts are stored in cents.");
const TESTS = `import { expect, test } from "bun:test";
import { unit } from "../src/money.ts";
test("stores cents", () => expect(unit).toBe("cents"));
test("something else", () => expect(1).toBe(1));
`;
const enforcer = { kind: "test", path: "tests/money.test.ts", name: "stores cents", scope: "src/money.ts" };
const brk = { enforcer: "tests/money.test.ts", description: "store dollars", edits: [{ path: "src/money.ts", find: '"cents"', replace: '"dollars"' }] };

function project() {
  return repo({ "src/money.ts": 'export const unit = "cents";\n', "tests/money.test.ts": TESTS });
}

async function planWith(root: string, calls: { tool: string; input: unknown }[]) {
  const model = scriptedAgent(calls);
  agents.agent = model;
  const ok = await plan({ ...at(root), lockFile: join(root, "VERDICT.lock"), laws: [law!], lock: new Map() }, () => {});
  delete agents.agent;
  return { ok, said: model.results.join("\n") };
}

test("a law can be enforced by one test the repo already has, which stays where it is", async () => {
  const root = project();
  const { ok } = await planWith(root, [{ tool: "submit", input: { enforcers: [enforcer], breaks: [brk], suggestions: [] } }]);
  expect(ok).toBe(true);
  const e = readLock(join(root, "VERDICT.lock")).get(law!.hash)!.enforcers[0]!;
  expect(e).toMatchObject(enforcer);
  expect(Object.keys(e.inputs!)).toContain("tests/money.test.ts");
  expect(readFileSync(join(root, "tests/money.test.ts"), "utf8")).toBe(TESTS);
  expect((await check({ ...at(root), laws: [law!], lock: readLock(join(root, "VERDICT.lock")) }))[0]!.status).toBe("pass");
});

test("its break must change the code, not the test", async () => {
  const root = project();
  const cheat = { ...brk, edits: [{ path: "tests/money.test.ts", find: 'toBe("cents")', replace: 'toBe("x")' }] };
  const { ok, said } = await planWith(root, [{ tool: "submit", input: { enforcers: [enforcer], breaks: [cheat], suggestions: [] } }]);
  expect(ok).toBe(false);
  expect(said).toContain("must change the system, not the enforcer");
});

test("skipping the test fails the law, though the runner exits 0", async () => {
  const root = project();
  await planWith(root, [{ tool: "submit", input: { enforcers: [enforcer], breaks: [brk], suggestions: [] } }]);
  writeFileSync(join(root, "tests/money.test.ts"), TESTS.replace('test("stores cents"', 'test.skip("stores cents"'));
  const r = (await check({ ...at(root), laws: [law!], lock: readLock(join(root, "VERDICT.lock")) }))[0]!;
  expect(r.status).toBe("fail");
  expect(r.details[0]!.result.message).toContain("ran no tests");
});

test("passed counts from each runner's summary", () => {
  expect(passedCount("bun", " 0 pass\n 1 skip\n 0 fail\n")).toBe(0);
  expect(passedCount("bun", " 2 pass\n 0 fail\n")).toBe(2);
  expect(passedCount("vitest", " Test Files  1 passed (1)\n      Tests  3 skipped (3)\n")).toBe(0);
  expect(passedCount("vitest", "      Tests  1 failed | 2 passed (3)\n")).toBe(2);
  expect(passedCount("jest", "Tests:       1 skipped, 2 total\n")).toBe(0);
  expect(passedCount("jest", "Tests:       1 skipped, 2 passed, 3 total\n")).toBe(2);
  expect(passedCount("pytest", "===== 1 skipped in 0.01s =====")).toBe(0);
  expect(passedCount("pytest", "===== 3 passed in 0.01s =====")).toBe(3);
  expect(passedCount("go", "testing: warning: no tests to run\nPASS\n")).toBe(0);
  expect(passedCount("go", "=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\n")).toBe(1);
  expect(passedCount("script", "ok")).toBe(null);
});

test("a break can't reach the test or package.json by another spelling", async () => {
  const root = repo({ "src/money.ts": 'export const unit = "cents";\n', "tests/money.test.ts": TESTS, "package.json": '{"devDependencies":{"vitest":"1"}}\n' });
  const { prove } = await import("../src/breaks.ts");
  const edits = [
    { path: "package.json", find: '"vitest":"1"', replace: '"x":"1"' },
    ...(process.platform === "darwin" ? [{ path: "tests/MONEY.test.ts", find: 'toBe("cents")', replace: 'toBe("x")' }] : []),
    { path: "src/../tests/money.test.ts", find: 'toBe("cents")', replace: 'toBe("x")' },
  ];
  for (const edit of edits) {
    const p = await prove(at(root), law!.text, enforcer, { ...brk, edits: [edit] });
    expect(p.kind).toBe("stale");
  }
});
