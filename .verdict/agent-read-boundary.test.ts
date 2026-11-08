// scope: readTools() in src/tools.ts (read_file, list_files, grep, git), called through callTool() the way agents call them, in throwaway git repos with a secret file outside each repo. Covers ../ and absolute paths, file and directory symlinks pointing outside, a dangling symlink, git positional paths, and git flags that name a file (separate and attached form, -S included). Not covered: the agents' own built-in tools (agent-builtin-tools.judge.md), the write and run tools (planner-write-boundary.test.ts), network, OS permissions.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../src/agent.ts";
import { exec } from "../src/exec.ts";
import { readTools } from "../src/tools.ts";

const SECRET = "VERDICT-SECRET-41d9";

// A committed repo with links that point outside it, and a secret outside it.
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "verdict-read-"));
  const outside = join(base, "outside");
  const root = join(base, "repo");
  mkdirSync(outside);
  mkdirSync(root);
  writeFileSync(join(outside, "secret.txt"), `${SECRET}\n`);
  writeFileSync(join(root, "a.txt"), "inside\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "file-link"));
  symlinkSync(outside, join(root, "dir-link"));
  symlinkSync(join(outside, "missing.txt"), join(root, "dangling-link"));
  await exec(["git", "init", "-q"], { cwd: root });
  await exec(["git", "add", "-A"], { cwd: root });
  await exec(["git", "-c", "user.name=verdict", "-c", "user.email=verdict@example.invalid", "commit", "-qm", "init"], { cwd: root });
  return { base, outside, root, secret: join(outside, "secret.txt") };
}

test("read_file answers inside paths and refuses every path that reaches outside", async () => {
  const f = await fixture();
  try {
    const tools = readTools(f.root);
    const ok = await callTool(tools.read_file, { path: "a.txt" });
    expect(ok.text).toContain("inside"); // control: the tool works

    const leaks: string[] = [];
    for (const path of ["../outside/secret.txt", f.secret, "file-link", "dir-link/secret.txt", "a.txt/../../outside/secret.txt"]) {
      const r = await callTool(tools.read_file, { path });
      if (!r.isError || r.text.includes(SECRET)) leaks.push(path);
    }
    expect(leaks).toEqual([]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("list_files names only files in the repo", async () => {
  const f = await fixture();
  try {
    const tools = readTools(f.root);
    const r = await callTool(tools.list_files, {});
    expect(r.text).toContain("a.txt"); // control
    expect(r.text).not.toContain("secret.txt");
    expect(r.text).not.toContain("missing.txt");
    const g = await callTool(tools.list_files, { glob: "dir-link/**" });
    expect(g.text).not.toContain("secret.txt");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("grep never returns text from outside the repo", async () => {
  const f = await fixture();
  try {
    const tools = readTools(f.root);
    const control = await callTool(tools.grep, { pattern: "inside" });
    expect(control.text).toContain("a.txt:1:"); // control
    for (const pattern of [SECRET, "."]) {
      const r = await callTool(tools.grep, { pattern });
      expect(r.text).not.toContain(SECRET);
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("git refuses or confines every argument that names a file", async () => {
  const f = await fixture();
  try {
    const tools = readTools(f.root);
    const control = await callTool(tools.git, { args: ["diff", "HEAD"] });
    expect(control.text).toContain("exit 0"); // control

    const cases = [
      ["diff", "--no-index", f.secret, "a.txt"],
      ["show", f.secret],
      ["diff", "--", "../outside/secret.txt"],
      ["blame", `-S${f.secret}`, "a.txt"], // -S reads a file of revisions
      ["blame", "-S../outside/secret.txt", "a.txt"],
      ["blame", `--contents=${f.secret}`, "a.txt"],
      ["ls-files", `--exclude-from=${f.secret}`],
      ["log", `-O${f.secret}`],
    ];
    const leaks: string[] = [];
    for (const args of cases) {
      const r = await callTool(tools.git, { args });
      if (r.text.includes(SECRET)) leaks.push(`${args.join(" ")} printed the secret`);
    }
    const written = join(f.base, "written.txt");
    await callTool(tools.git, { args: ["diff", `--output=${written}`] });
    if (existsSync(written)) leaks.push("diff --output wrote a file outside the repo");
    expect(leaks).toEqual([]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
