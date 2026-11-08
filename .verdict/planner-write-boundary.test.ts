// scope: the planner's tools, as the planner calls them, in throwaway repos with a directory outside each repo that every escape targets. write_file and run from writeTools() in src/tools.ts (absolute, ../ and symlink paths; a script in .verdict/; allowlisted bun and python3 given code); run_enforcer from runEnforcer() in src/enforcers.ts for a planner-written test file and decision file; try_break's edits from prove() in src/breaks.ts with escaping paths. Not covered: verdict's scratch copies in TMPDIR, which try_break always writes by design; tla and semgrep (their argv is fixed by verdict); network; the agents' built-in tools (agent-builtin-tools.judge.md); the read-only judge (agent-read-boundary.test.ts).

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../src/agent.ts";
import { prove } from "../src/breaks.ts";
import { runEnforcer } from "../src/enforcers.ts";
import { exec } from "../src/exec.ts";
import { writeTools } from "../src/tools.ts";

// The interpreter cases need python3; without it this precondition is missing (exit 77: inconclusive).
if (!Bun.which("python3")) {
  console.error("python3 is not installed");
  process.exit(77);
}

const SECRET = "VERDICT-SECRET-41d9";
const LAW = "An agent's file tools never read or write outside the repository, and the planner never writes outside .verdict/.";

// A repo with .verdict/, plus a directory outside it holding a secret. Links already in .verdict/ point outside.
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "verdict-planner-"));
  const outside = join(base, "outside");
  const root = join(base, "repo");
  const verdict = join(root, ".verdict");
  mkdirSync(outside);
  mkdirSync(verdict, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), `${SECRET}\n`);
  writeFileSync(join(root, "a.txt"), "inside\n");
  symlinkSync(outside, join(verdict, "dir-link"));
  symlinkSync(join(outside, "dangling.txt"), join(verdict, "dangling-link"));
  await exec(["git", "init", "-q"], { cwd: root });
  await exec(["git", "add", "-A"], { cwd: root });
  await exec(["git", "-c", "user.name=verdict", "-c", "user.email=verdict@example.invalid", "commit", "-qm", "init"], { cwd: root });
  return { base, outside, root, verdict, secret: join(outside, "secret.txt") };
}

// Anything the planner made outside the repo shows up as a new name in `outside`.
const newOutside = (dir: string) => readdirSync(dir).filter((n) => n !== "secret.txt");

test("write_file writes only inside .verdict/", async () => {
  const f = await fixture();
  try {
    const tools = writeTools(f.root, f.verdict);
    const ok = await callTool(tools.write_file, { path: ".verdict/ok.txt", content: "x" });
    expect(ok.isError).toBe(false); // control
    for (const path of ["../outside/pwned.txt", join(f.outside, "pwned.txt"), ".verdict/../../outside/pwned.txt", ".verdict/dir-link/pwned.txt", ".verdict/dangling-link"]) {
      await callTool(tools.write_file, { path, content: "pwned" });
    }
    const leaks = newOutside(f.outside).map((n) => `write_file created ${n} outside the repo`);
    expect(leaks).toEqual([]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("run executes nothing that writes or reads outside the repo", async () => {
  const f = await fixture();
  try {
    const tools = writeTools(f.root, f.verdict);
    const target = join(f.outside, "run.txt");
    const leaks: string[] = [];

    const ok = await callTool(tools.write_file, { path: ".verdict/ok.sh", content: "#!/bin/sh\necho inside-ran\n", executable: true });
    const control = await callTool(tools.run, { argv: ["./.verdict/ok.sh"] });
    expect(ok.isError).toBe(false);
    expect(control.text).toContain("inside-ran"); // control

    // A .verdict/ script that writes outside, then run on it.
    await callTool(tools.write_file, { path: ".verdict/evil.sh", content: `#!/bin/sh\necho x > ${target}\n`, executable: true });
    await callTool(tools.run, { argv: ["./.verdict/evil.sh"] });
    if (existsOutside(target)) leaks.push("a .verdict/ script wrote outside the repo");
    rmIfExists(target);

    // An allowlisted interpreter given code: writes outside.
    await callTool(tools.run, { argv: ["bun", "-e", `require("node:fs").writeFileSync(${JSON.stringify(target)}, "x")`] });
    if (existsOutside(target)) leaks.push("run bun -e wrote outside the repo");
    rmIfExists(target);
    await callTool(tools.run, { argv: ["python3", "-c", `open(${JSON.stringify(target)}, "w").write("x")`] });
    if (existsOutside(target)) leaks.push("run python3 -c wrote outside the repo");
    rmIfExists(target);

    // Reads: the output goes back to the agent.
    const read = await callTool(tools.run, { argv: ["bun", "-e", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(f.secret)}, "utf8"))`] });
    if (read.text.includes(SECRET)) leaks.push("run bun -e read the secret outside the repo");
    const read2 = await callTool(tools.run, { argv: ["python3", "-c", `print(open(${JSON.stringify(f.secret)}).read())`] });
    if (read2.text.includes(SECRET)) leaks.push("run python3 -c read the secret outside the repo");

    expect(leaks).toEqual([]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("run_enforcer does not run a planner-written test or decision file that writes outside", async () => {
  const f = await fixture();
  try {
    const tools = writeTools(f.root, f.verdict);
    const target = join(f.outside, "probe.txt");
    await callTool(tools.write_file, {
      path: ".verdict/probe.test.ts",
      content: `// scope: probe\nimport { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("probe", () => { writeFileSync(${JSON.stringify(target)}, "x"); });\n`,
    });
    await runEnforcer("test", { root: f.root, law: LAW, path: ".verdict/probe.test.ts" });
    const testLeaks = newOutside(f.outside).map((n) => `a planner-written test file, run by run_enforcer, created ${n} outside the repo`);
    rmIfExists(target);

    await callTool(tools.write_file, {
      path: ".verdict/probe.json",
      content: JSON.stringify({ scope: "probe", state_from: `touch ${target}`, instructions: "x", criteria: { pass: "a", fail: "b", inconclusive: "c" } }),
    });
    await runEnforcer("decision", { root: f.root, law: LAW, path: ".verdict/probe.json" });
    const decisionLeaks = newOutside(f.outside).map((n) => `a planner-written decision file, run by run_enforcer, created ${n} outside the repo`);

    expect([...testLeaks, ...decisionLeaks]).toEqual([]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("try_break edits cannot change files outside the scratch copy", async () => {
  const f = await fixture();
  try {
    const tools = writeTools(f.root, f.verdict);
    await callTool(tools.write_file, { path: ".verdict/ok.test.ts", content: `// scope: probe\nimport { test } from "bun:test";\ntest("p", () => {});\n` });
    const enforcer = { kind: "test", path: ".verdict/ok.test.ts" };
    const edits = [
      { path: "../outside/secret.txt", find: SECRET, replace: "changed" },
      { path: join(f.outside, "secret.txt"), find: SECRET, replace: "changed" },
    ];
    for (const edit of edits) {
      await prove(f.root, LAW, enforcer, { enforcer: enforcer.path, description: "escape", edits: [edit] });
    }
    const leaks: string[] = [];
    if (readFileSync(f.secret, "utf8") !== `${SECRET}\n`) leaks.push("a break edit changed secret.txt outside the repo");
    leaks.push(...newOutside(f.outside).map((n) => `a break edit created ${n} outside the repo`));
    expect(leaks).toEqual([]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

function existsOutside(p: string): boolean {
  return readdirSync(join(p, "..")).includes(p.split("/").pop()!);
}
function rmIfExists(p: string): void {
  rmSync(p, { force: true });
}
