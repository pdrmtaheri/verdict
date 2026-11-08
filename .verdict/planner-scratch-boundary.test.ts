// scope: the planner's write paths, called the way the planner calls them, in throwaway git repos with a directory outside each repo that every escape targets. write_file and run's script check from writeTools() in src/tools.ts (absolute, ../ and symlink paths, files outside .verdict/); runInScratch() in src/breaks.ts (what run_enforcer and validate use) and prove() (what try_break uses): a planner-written test file and decision file that write into the real repo by absolute path and by relative path, and edits whose paths escape the repo or point into .verdict/ -- the real repo outside .verdict/ and the directory beside it must stay byte-identical, while a relative write must land in the scratch copy. Run with VERDICT_SANDBOX=off because the OS sandbox cannot nest (macOS) inside verdict's own: so this checks WHERE verdict runs things (always a scratch copy, never the repo) and which files its edit/write tools accept, not the OS sandbox's write denial; absolute-path writes by run programs and the Box passed to sandboxed() are covered by the judge in planner-sandbox.judge.md. Not covered: reads by run, tla and semgrep (argv fixed by verdict), the network, the agents' built-in tools (agent-builtin-tools.judge.md).

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Nested OS sandboxes fail; what is checked here does not depend on one.
process.env.VERDICT_SANDBOX = "off";

const { callTool } = await import("../src/agent.ts");
const { prove, runInScratch } = await import("../src/breaks.ts");
const { exec } = await import("../src/exec.ts");
const { writeTools } = await import("../src/tools.ts");

const SECRET = "VERDICT-SECRET-41d9";
const LAW = "An agent's file tools never read or write outside the repository; the planner never writes to the repository outside .verdict/, and anything it runs can write only to a scratch copy.";

async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "verdict-planner-"));
  const outside = join(base, "outside");
  const root = join(base, "repo");
  const verdict = join(root, ".verdict");
  mkdirSync(outside);
  mkdirSync(verdict, { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(outside, "secret.txt"), `${SECRET}\n`);
  writeFileSync(join(root, "a.txt"), "inside\n");
  writeFileSync(join(root, "src", "code.ts"), "export const x = 1;\n");
  symlinkSync(outside, join(verdict, "dir-link"));
  symlinkSync(join(outside, "dangling.txt"), join(verdict, "dangling-link"));
  await exec(["git", "init", "-q"], { cwd: root });
  await exec(["git", "add", "-A"], { cwd: root });
  await exec(["git", "-c", "user.name=verdict", "-c", "user.email=verdict@example.invalid", "commit", "-qm", "init"], { cwd: root });
  return { base, outside, root, verdict, w: { dir: root, repo: root }, secret: join(outside, "secret.txt") };
}

// Every file in the repo outside .verdict/ and .git/, and in the directory beside it, with contents.
function snapshot(root: string, outside: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, skip: (rel: string) => boolean, base: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (skip(relative(base, p))) continue;
      if (e.isDirectory()) walk(p, skip, base);
      else if (e.isFile()) out[p] = readFileSync(p, "utf8");
      else out[p] = "<link>";
    }
  };
  walk(root, (rel) => rel === ".git" || rel === ".verdict", root);
  walk(outside, () => false, outside);
  return out;
}

test("write_file writes only inside .verdict/", async () => {
  const f = await fixture();
  try {
    const tools = writeTools(f.root, f.verdict, f.root);
    const ok = await callTool(tools.write_file, { path: ".verdict/ok.txt", content: "x" });
    expect(ok.isError).toBe(false); // control
    const before = snapshot(f.root, f.outside);
    for (const path of ["../outside/pwned.txt", join(f.outside, "pwned.txt"), ".verdict/../../outside/pwned.txt", ".verdict/dir-link/pwned.txt", ".verdict/dangling-link", "src/code.ts", join(f.root, "evil.txt"), "a.txt"]) {
      await callTool(tools.write_file, { path, content: "pwned" });
    }
    expect(snapshot(f.root, f.outside)).toEqual(before);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("run refuses a script outside .verdict/ and writes to a scratch copy, not the repo", async () => {
  const f = await fixture();
  try {
    const tools = writeTools(f.root, f.verdict, f.root);
    await callTool(tools.write_file, { path: ".verdict/ok.sh", content: "#!/bin/sh\necho inside-ran\n", executable: true });
    const control = await callTool(tools.run, { argv: ["./.verdict/ok.sh"] });
    expect(control.text).toContain("inside-ran"); // control: run works

    // a relative write from a program run by `run` lands in the scratch copy
    const rel = await callTool(tools.run, { argv: ["python3", "-c", `open("scratch-note.txt", "w").write("x")\nopen("src/code.ts", "w").write("y")\nprint("wrote-in-scratch")`] });
    expect(rel.text).toContain("wrote-in-scratch");

    // scripts outside .verdict/ never run
    writeFileSync(join(f.root, "evil.sh"), `#!/bin/sh\necho x > ${join(f.outside, "ran.txt")}\n`, { mode: 0o755 });
    writeFileSync(join(f.outside, "evil.sh"), `#!/bin/sh\necho x > ${join(f.outside, "ran.txt")}\n`, { mode: 0o755 });
    const before = snapshot(f.root, f.outside);
    for (const bin of ["./evil.sh", "./src/../evil.sh", "../outside/evil.sh", ".verdict/dir-link/evil.sh"]) {
      const r = await callTool(tools.run, { argv: [bin] });
      expect(r.isError).toBe(true);
    }
    expect(snapshot(f.root, f.outside)).toEqual(before);
    expect(existsSync(join(f.root, "scratch-note.txt"))).toBe(false);
    expect(readFileSync(join(f.root, "src", "code.ts"), "utf8")).toBe("export const x = 1;\n");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a planner-written test or decision file, run through runInScratch, runs in a copy of the repo", async () => {
  const f = await fixture();
  try {
    const tools = writeTools(f.root, f.verdict, f.root);
    const before = snapshot(f.root, f.outside);

    // Relative writes from the test's cwd must land in the copy; the test also reports its cwd.
    await callTool(tools.write_file, {
      path: ".verdict/probe.test.ts",
      content:
        `// scope: probe\nimport { test, expect } from "bun:test";\nimport { writeFileSync, existsSync } from "node:fs";\n` +
        `test("probe", () => {\n  writeFileSync("src/code.ts", "changed");\n  writeFileSync("probe-in-repo.txt", "x");\n` +
        `  expect(process.cwd().startsWith(${JSON.stringify(f.base)})).toBe(false);\n});\n`,
    });
    const t = await runInScratch(f.w, LAW, { kind: "test", path: ".verdict/probe.test.ts" });
    expect(t.status).toBe("pass"); // control: it ran, in a directory that is not the real repo

    await callTool(tools.write_file, {
      path: ".verdict/probe.json",
      content: JSON.stringify({ scope: "probe", state_from: "echo x > probe-from-decision.txt; echo x > src/code.ts", instructions: "x", criteria: { pass: "a", fail: "b", inconclusive: "c" } }),
    });
    await runInScratch(f.w, LAW, { kind: "decision", path: ".verdict/probe.json" });

    expect(snapshot(f.root, f.outside)).toEqual(before);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("try_break edits change only the scratch copy: escaping paths are refused", async () => {
  const f = await fixture();
  try {
    const tools = writeTools(f.root, f.verdict, f.root);
    await callTool(tools.write_file, { path: ".verdict/ok.test.ts", content: `// scope: probe\nimport { test } from "bun:test";\ntest("p", () => {});\n` });
    const enforcer = { kind: "test", path: ".verdict/ok.test.ts" };

    // control: an edit inside the repo is applied to the copy only
    const okEdit = await prove(f.w, LAW, enforcer, { enforcer: enforcer.path, description: "control", edits: [{ path: "src/code.ts", find: "x = 1", replace: "x = 2" }] });
    expect(okEdit.kind).toBe("missed"); // applied (not stale); the probe test ignores it
    expect(readFileSync(join(f.root, "src", "code.ts"), "utf8")).toBe("export const x = 1;\n");

    const before = snapshot(f.root, f.outside);
    const edits = [
      { path: "../outside/secret.txt", find: SECRET, replace: "changed" },
      { path: f.secret, find: SECRET, replace: "changed" },
      { path: ".verdict/ok.test.ts", find: "test(", replace: "test.skip(" },
      { path: ".verdict/dir-link/secret.txt", find: SECRET, replace: "changed" },
    ];
    for (const edit of edits) {
      await prove(f.w, LAW, enforcer, { enforcer: enforcer.path, description: "escape", edits: [edit] });
    }
    expect(snapshot(f.root, f.outside)).toEqual(before);
    expect(readFileSync(join(f.root, ".verdict", "ok.test.ts"), "utf8")).toContain('test("p"');
    expect(readFileSync(f.secret, "utf8")).toBe(`${SECRET}\n`);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
