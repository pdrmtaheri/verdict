import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { overrides as agents } from "../src/agent.ts";
import { prove } from "../src/breaks.ts";
import { check, format } from "../src/check.ts";
import { parseLaws } from "../src/laws.ts";
import { readLock, writeLock, type Lock } from "../src/lock.ts";
import { changes, inputsOf } from "../src/pins.ts";
import { plan } from "../src/plan.ts";
import { at } from "../src/where.ts";
import { repo, scriptedAgent } from "./helpers.ts";

afterEach(() => {
  delete agents.agent;
});

const [law] = parseLaws("- Amounts are stored in cents.");
const SCRIPT = "#!/bin/sh\n# scope: src/money.ts only\ngrep -q cents src/money.ts\n";
const enforcer = { kind: "test", path: ".verdict/cents.sh" };
const brk = { enforcer: ".verdict/cents.sh", description: "store dollars", edits: [{ path: "src/money.ts", find: "cents", replace: "dollars" }] };

// A repo whose law was planned and proven, with inputs recorded.
async function planned(): Promise<string> {
  const root = repo({ "src/money.ts": "export const amount = 0; // cents\n" });
  agents.agent = scriptedAgent([
    { tool: "write_file", input: { path: ".verdict/cents.sh", content: SCRIPT, executable: true } },
    { tool: "submit", input: { enforcers: [enforcer], breaks: [brk], suggestions: [] } },
  ]);
  expect(await plan({ ...at(root), lockFile: join(root, "VERDICT.lock"), laws: [law!], lock: new Map() }, () => {})).toBe(true);
  delete agents.agent;
  return root;
}

const run = async (root: string) => (await check({ ...at(root), laws: [law!], lock: readLock(join(root, "VERDICT.lock")) }))[0]!;

test("plan records what each enforcer was proven against", async () => {
  const root = await planned();
  const e = readLock(join(root, "VERDICT.lock")).get(law!.hash)!.enforcers[0]!;
  expect(Object.keys(e.inputs ?? {})).toEqual([".verdict/cents.sh"]);
  const r = await run(root);
  expect(r.status).toBe("pass");
  expect(r.details[0]!.warnings).toEqual([]);
});

test("an enforcer weakened after it was proven fails check, though it still passes", async () => {
  const root = await planned();
  writeFileSync(join(root, ".verdict/cents.sh"), "#!/bin/sh\n# scope: src/money.ts only\ntrue\n");
  const r = await run(root);
  expect(r.status).toBe("fail");
  expect(r.details[0]!.result.message).toContain(".verdict/cents.sh changed");
  expect(r.details[0]!.result.message).toContain("can no longer see the violation");
});

test("a harmless edit to an enforcer is replayed, passes, and is reported", async () => {
  const root = await planned();
  writeFileSync(join(root, ".verdict/cents.sh"), `${SCRIPT  }# a comment\n`);
  const r = await run(root);
  expect(r.status).toBe("pass");
  const said = format([r]);
  expect(said).toContain("warning: changed since it was proven: .verdict/cents.sh changed");
  expect(said).toContain("still caught");
  expect(said).toContain("2 warnings");
});

test("check warns when a break no longer applies to the code", async () => {
  const root = await planned();
  writeFileSync(join(root, "src/money.ts"), "export const amount = 0; // cents, in cents\n");
  const r = await run(root);
  expect(r.status).toBe("pass");
  expect(r.details[0]!.warnings.join("\n")).toContain("its break no longer applies");
});

test("an in-sync plan records new inputs without starting an agent", async () => {
  const root = await planned();
  const file = join(root, "VERDICT.lock");
  writeFileSync(join(root, ".verdict/cents.sh"), `${SCRIPT  }# a comment\n`);
  const before = readLock(file).get(law!.hash)!.enforcers[0]!.inputs;
  let started = 0;
  agents.agent = { name: "counting", run: async () => void started++ };
  expect(await plan({ ...at(root), lockFile: file, laws: [law!], lock: readLock(file) }, () => {})).toBe(true);
  expect(started).toBe(0);
  const after = readLock(file).get(law!.hash)!.enforcers[0]!.inputs;
  expect(after).not.toEqual(before);
  expect((await run(root)).details[0]!.warnings).toEqual([]);
});

test("a break may not edit the enforcer or the config it runs under", async () => {
  const root = repo({ "src/money.ts": "cents\n", "bunfig.toml": "# none\n", ".verdict/cents.test.ts": "// scope: x\n" });
  for (const path of [".verdict/cents.test.ts", "bunfig.toml"]) {
    const p = await prove(at(root), law!.text, { kind: "test", path: ".verdict/cents.test.ts" }, { enforcer: ".verdict/cents.test.ts", description: "x", edits: [{ path, find: path === "bunfig.toml" ? "none" : "scope", replace: "y" }] });
    expect(p.kind).toBe("stale");
  }
});

test("test inputs include the runner's config and its version", () => {
  const root = repo({ "package.json": JSON.stringify({ devDependencies: { vitest: "^3.0.0", lodash: "4" } }), "vitest.config.ts": "export default {}\n", "pkg/.verdict/a.test.ts": "// scope: x\n" });
  const w = { dir: join(root, "pkg"), repo: root };
  const inputs = inputsOf(w, { kind: "test", path: ".verdict/a.test.ts" });
  expect(Object.keys(inputs).toSorted()).toEqual(["../package.json#vitest", "../vitest.config.ts", ".verdict/a.test.ts"]);
  expect(changes(inputs, { ...inputs, "../package.json#vitest": "^4.0.0" })).toEqual(["../package.json: vitest went from ^3.0.0 to ^4.0.0"]);
});

test("the lock keeps name, scope and inputs", () => {
  const root = repo({});
  const file = join(root, "VERDICT.lock");
  const lock: Lock = new Map([[law!.hash, { law: law!.text, enforcers: [{ kind: "test", path: "tests/money.test.ts", name: "stores cents", scope: "src/money.ts", inputs: { "tests/money.test.ts": "abc" } }] }]]);
  writeLock(file, lock, [law!]);
  expect(readLock(file)).toEqual(lock);
  expect(readFileSync(file, "utf8")).toContain("- test: tests/money.test.ts");
});

test("helpers an enforcer in .verdict/ names are among its inputs", () => {
  const root = repo({
    ".verdict/a.test.ts": '// scope: x\nimport { go } from "./runner";\nconst f = join(import.meta.dir, "fixture.json");\n',
    ".verdict/runner.ts": "export const go = 1;\n",
    ".verdict/fixture.json": "{}",
    ".verdict/unrelated.ts": "",
    ".verdict/breaks/abc.json": "[]",
  });
  expect(Object.keys(inputsOf(at(root), { kind: "test", path: ".verdict/a.test.ts" })).toSorted()).toEqual([".verdict/a.test.ts", ".verdict/fixture.json", ".verdict/runner.ts"]);
});

test("a dangling link in .verdict/ doesn't break pinning", async () => {
  const { symlinkSync } = await import("node:fs");
  const root = repo({ ".verdict/a.sh": "# scope: x\n" });
  symlinkSync(join(root, "nowhere"), join(root, ".verdict/dangling-link"));
  expect(Object.keys(inputsOf(at(root), { kind: "test", path: ".verdict/a.sh" }))).toEqual([".verdict/a.sh"]);
});
