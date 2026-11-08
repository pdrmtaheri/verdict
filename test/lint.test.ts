// lint enforcers against the real linters. Skipped where a linter isn't installed.
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { overrides as agents } from "../src/agent.ts";
import { check, checkLaw } from "../src/check.ts";
import { parseLaws } from "../src/laws.ts";
import { readLock } from "../src/lock.ts";
import { plan } from "../src/plan.ts";
import { at } from "../src/where.ts";
import { repo, scriptedAgent } from "./helpers.ts";

afterEach(() => {
  delete agents.agent;
});

const [law] = parseLaws("- Variables are never declared with var.");
const ESLINT = 'export default [{ files: ["**/*.js"], rules: { "no-var": "error" } }];\n';
const enforcer = { kind: "lint", path: "eslint.config.mjs", rule: "no-var", scope: "src/**/*.js" };
const hasEslint = !!Bun.which("eslint");
const hasRuff = !!Bun.which("ruff");

const js = (code = "let a = 1;\n") => repo({ "eslint.config.mjs": ESLINT, "src/a.js": code });
const lint = (root: string, e: object = enforcer) => checkLaw(at(root), { law: law!.text, enforcers: [e as typeof enforcer] });

test.skipIf(!hasEslint)("eslint: the rule's findings in the scope decide the law", async () => {
  expect((await lint(js())).status).toBe("pass");
  const bad = await lint(js("var a = 1;\nif (a == 2) {}\n"));
  expect(bad.status).toBe("fail");
  expect(bad.details[0]!.result.message).toContain("no-var: 1 finding");
  expect(bad.details[0]!.result.message).not.toContain("eqeqeq");
});

test.skipIf(!hasEslint)("eslint: a rule turned off in the config fails the law", async () => {
  const root = js();
  writeFileSync(join(root, "eslint.config.mjs"), ESLINT.replace('"error"', '"off"'));
  const r = await lint(root);
  expect(r.status).toBe("fail");
  expect(r.details[0]!.result.message).toContain("no-var is turned off in eslint.config.mjs for the whole scope");
});

test.skipIf(!hasEslint)("eslint: disable comments are reported, and a scope that matches nothing fails", async () => {
  const r = await lint(js("// eslint-disable-next-line no-var\nvar a = 1;\n"));
  expect(r.status).toBe("pass");
  expect(r.details[0]!.warnings.join("\n")).toContain("1 finding of no-var suppressed");
  const moved = await lint(js(), { ...enforcer, scope: "lib/**/*.js" });
  expect(moved.status).toBe("fail");
  expect(moved.details[0]!.result.message).toContain("matches no files");
});

test.skipIf(!hasEslint)("plan accepts a rule the project has; check catches it being turned off", async () => {
  const root = js();
  const brk = { enforcer: "eslint.config.mjs", description: "declare with var", edits: [{ path: "src/a.js", find: "let a", replace: "var a" }] };
  agents.agent = scriptedAgent([{ tool: "submit", input: { enforcers: [enforcer], breaks: [brk], suggestions: [] } }]);
  expect(await plan(at(root), join(root, "VERDICT.lock"), [law!], new Map(), () => {})).toBe(true);
  const lock = readLock(join(root, "VERDICT.lock"));
  expect(lock.get(law!.hash)!.enforcers[0]).toMatchObject(enforcer);
  expect((await check(at(root), [law!], lock))[0]!.status).toBe("pass");
  writeFileSync(join(root, "eslint.config.mjs"), ESLINT.replace('"no-var": "error"', '"no-var": "error", "eqeqeq": "warn"'));
  const changed = (await check(at(root), [law!], lock))[0]!;
  expect(changed.status).toBe("pass");
  expect(changed.details[0]!.warnings.join("\n")).toContain("eslint.config.mjs changed");
  expect(changed.details[0]!.warnings.join("\n")).toContain("still caught");
});

test("plan refuses a lint enforcer in .verdict/ or on a config it can't read", async () => {
  const root = repo({ ".verdict/eslint.config.mjs": ESLINT, "src/a.js": "let a;\n", "tsconfig.json": "{}" });
  for (const [e, said] of [
    [{ ...enforcer, path: ".verdict/eslint.config.mjs" }, "use semgrep"],
    [{ ...enforcer, path: "tsconfig.json" }, "isn't a config file verdict can read"],
  ] as const) {
    const model = scriptedAgent([{ tool: "submit", input: { enforcers: [e], breaks: [], suggestions: [] } }]);
    agents.agent = model;
    expect(await plan(at(root), join(root, "VERDICT.lock"), [law!], new Map(), () => {})).toBe(false);
    expect(model.results.join("\n")).toContain(said);
  }
});

const PYPROJECT = '[tool.ruff.lint]\nselect = ["E711"]\n';
const py = (code: string) => repo({ "pyproject.toml": PYPROJECT, "app/a.py": code });
const ruffE = { kind: "lint", path: "pyproject.toml", rule: "E711", scope: "app/**/*.py" };

test.skipIf(!hasRuff)("ruff: the rule's findings decide the law; a rule no longer selected fails it", async () => {
  expect((await lint(py("x = None\nif x is None:\n    pass\n"), ruffE)).status).toBe("pass");
  const bad = await lint(py("import os\nx = None\nif x == None:\n    pass\n"), ruffE);
  expect(bad.status).toBe("fail");
  expect(bad.details[0]!.result.message).toContain("E711: 1 finding");
  const root = py("x = 1\n");
  writeFileSync(join(root, "pyproject.toml"), PYPROJECT.replace("E711", "F401"));
  const off = await lint(root, ruffE);
  expect(off.status).toBe("fail");
  expect(off.details[0]!.result.message).toContain("E711 is turned off in pyproject.toml for the whole scope");
});

test.skipIf(!hasEslint)("eslint: a rule turned off for part of the scope fails the law", async () => {
  const root = repo({ "eslint.config.mjs": ESLINT.replace("];", ', { files: ["src/legacy/**"], rules: { "no-var": "off" } }];'), "src/a.js": "let a;\n", "src/legacy/b.js": "var b;\n" });
  const r = await lint(root);
  expect(r.status).toBe("fail");
  expect(r.details[0]!.result.message).toContain("for 1 of 2 files in the scope: src/legacy/b.js");
});

test.skipIf(!hasRuff)("ruff: per-file-ignores for the rule fail the law", async () => {
  const root = repo({ "pyproject.toml": PYPROJECT + '[tool.ruff.lint.per-file-ignores]\n"app/legacy/*.py" = ["E711"]\n', "app/a.py": "x = 1\n", "app/legacy/b.py": "x = None\nif x == None:\n    pass\n" });
  const r = await lint(root, ruffE);
  expect(r.status).toBe("fail");
  expect(r.details[0]!.result.message).toContain("app/legacy/b.py (per-file-ignores)");
});
