// scope: `bun src/cli.ts check` run as a real process in disposable git repos (outside this repo). Before and after, it compares git HEAD, the index (git ls-files -s), `git status --porcelain --ignored -uall`, and the path, type, mode, symlink target and sha256 of every file outside .git (ignored files included). Fixtures: dirty tree (modified, untracked, ignored files); a root VERDICT.md plus a nested one; laws that pass, fail, are inconclusive, have a missing enforcer file, are unplanned, or are reworded; enforcer kinds test (executable script, bun .test.ts), decision (empty state, so no model is called), semgrep and tla (inconclusive when the tool is absent, real runs otherwise); no VERDICT.lock at all; a path argument; a repo that isn't a git repo; early failures (broken lock, unknown path, no VERDICT.md). Enforcers here are well-behaved, so a change is made by check itself. Not covered: llm judges and decision models that call a model, enforcers that write by themselves (check runs them unsandboxed), concurrent edits by other processes.

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseLaws } from "../src/laws.ts";

const REPO = resolve(import.meta.dir, "..");
const hashOf = (text: string) => parseLaws(`- ${text}`)[0]!.hash;

function put(dir: string, path: string, content: string, exec = false) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
  if (exec) chmodSync(join(dir, path), 0o755);
}

// On macOS the /usr/bin/git shim can print "couldn't create cache file" noise
// on stderr in restricted environments. verdict merges stderr into the output
// it parses, so run it through a wrapper that drops git's stderr.
const SHIM = (() => {
  const d = mkdtempSync(join(tmpdir(), "verdict-gitshim-"));
  const real = Bun.which("git") ?? "git";
  writeFileSync(join(d, "git"), `#!/bin/sh\nexec "${real}" "$@" 2>/dev/null\n`);
  chmodSync(join(d, "git"), 0o755);
  return d;
})();

// stdout only: git's stderr can carry per-run noise (temp file names).
function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: { ...process.env, PATH: `${SHIM}:${process.env.PATH}` } });
  return r.stdout.toString();
}

const sh = (body: string) => `#!/bin/sh\n# scope: fixture\n${body}\n`;

interface Law {
  text: string;
  lockText?: string; // text recorded in the lock (differs when reworded)
  enforcers: string[]; // lock lines like "test: .verdict/a.sh"
  unplanned?: boolean;
}

function lockOf(laws: Law[]): string {
  return laws
    .filter((l) => !l.unplanned)
    .map((l) => {
      const t = l.lockText ?? l.text;
      const enf = l.enforcers.length === 0 ? "  enforcers: []\n" : `  enforcers:\n${l.enforcers.map((e) => `    - ${e}\n`).join("")}`;
      return `${hashOf(t)}:\n  law: ${JSON.stringify(t)}\n${enf}`;
    })
    .join("");
}

function build(opts: { git: boolean; lock: boolean; dirty: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "verdict-ro-"));
  const root: Law[] = [
    { text: "Passing script law.", enforcers: ["test: .verdict/ok.sh"] },
    { text: "Failing script law.", enforcers: ["test: .verdict/bad.sh"] },
    { text: "Skipped script law.", enforcers: ["test: .verdict/skip.sh"] },
    { text: "Bun test law.", enforcers: ["test: .verdict/a.test.ts"] },
    { text: "Missing enforcer law.", enforcers: ["test: .verdict/gone.sh"] },
    { text: "Decision law.", enforcers: ["decision: .verdict/d.decision.json"] },
    { text: "Semgrep law.", enforcers: ["semgrep: .verdict/r.yml"] },
    { text: "Tla law.", enforcers: ["tla: .verdict/s.tla"] },
    { text: "Reworded law.", lockText: "Old reworded law.", enforcers: ["test: .verdict/ok.sh"] },
    { text: "Unplanned law.", enforcers: [], unplanned: true },
    { text: "Planned without enforcers.", enforcers: [] },
  ];
  const nested: Law[] = [
    { text: "Nested passing law.", enforcers: ["test: .verdict/n.sh"] },
    { text: "Nested unplanned law.", enforcers: [], unplanned: true },
  ];
  put(dir, "VERDICT.md", root.map((l) => `- ${l.text}\n`).join(""));
  put(dir, "sub/VERDICT.md", nested.map((l) => `- ${l.text}\n`).join(""));
  if (opts.lock) {
    put(dir, "VERDICT.lock", lockOf(root));
    put(dir, "sub/VERDICT.lock", lockOf(nested));
  }
  put(dir, ".verdict/ok.sh", sh("exit 0"), true);
  put(dir, ".verdict/bad.sh", sh("echo broken; exit 1"), true);
  put(dir, ".verdict/skip.sh", sh("exit 77"), true);
  put(dir, "sub/.verdict/n.sh", sh("exit 0"), true);
  put(dir, ".verdict/a.test.ts", `// scope: fixture\nimport { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n`);
  put(dir, ".verdict/d.decision.json", JSON.stringify({ scope: "fixture", state_from: "true", instructions: "q", criteria: { pass: "p", fail: "f", inconclusive: "i" } }));
  put(dir, ".verdict/r.yml", "# scope: fixture\nrules:\n  - id: nothing\n    pattern: THIS_NEVER_APPEARS_ANYWHERE()\n    message: m\n    languages: [python]\n    severity: ERROR\n");
  put(dir, ".verdict/s.tla", "---- MODULE s ----\nVARIABLE x\nInit == x = 0\nNext == x' = x\nSpec == Init /\\ [][Next]_x\n====\n");
  put(dir, ".verdict/s.cfg", "SPECIFICATION Spec\n");
  put(dir, "src/app.py", "print('hi')\n");
  put(dir, ".gitignore", "ignored/\n");
  if (opts.git) {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  if (opts.dirty) {
    put(dir, "src/app.py", "print('changed')\n");
    put(dir, "untracked.txt", "u\n");
    put(dir, "ignored/cache.bin", "cache\n");
    put(dir, "sub/untracked/new.py", "x = 1\n");
    symlinkSync("src/app.py", join(dir, "link.py"));
    if (opts.git) git(dir, "add", "sub/untracked/new.py");
  }
  return dir;
}

function snapshot(dir: string): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === ".git") continue;
      const st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) lines.push(`L ${r} -> ${readlinkSync(join(dir, r))}`);
      else if (st.isDirectory()) {
        lines.push(`D ${r}`);
        walk(r);
      } else lines.push(`F ${r} ${(st.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(join(dir, r))).digest("hex")}`);
    }
  };
  walk("");
  if (exists(join(dir, ".git"))) {
    lines.push("HEAD " + git(dir, "rev-parse", "HEAD").trim());
    lines.push("INDEX\n" + git(dir, "ls-files", "-s"));
    lines.push("STATUS\n" + git(dir, "status", "--porcelain", "--ignored", "-uall"));
    lines.push("BRANCHES\n" + git(dir, "branch", "-a"));
    lines.push("STASH\n" + git(dir, "stash", "list"));
  }
  return lines.join("\n");
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function check(dir: string, args: string[] = []): Promise<{ code: number; out: string }> {
  const env = { ...process.env, VERDICT_JOBS: "4", PATH: `${SHIM}:${process.env.PATH}` } as Record<string, string>;
  delete env.TYPESAFE_AI_API_KEY;
  const proc = Bun.spawn([process.execPath, join(REPO, "src/cli.ts"), "check", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env, timeout: 240_000 });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code: code ?? -1, out: out + err };
}

const CASES: { name: string; opts: { git: boolean; lock: boolean; dirty: boolean }; args?: string[]; expectOut: string }[] = [
  { name: "clean git repo", opts: { git: true, lock: true, dirty: false }, expectOut: "PASS" },
  { name: "dirty git repo (modified, untracked, ignored, symlink, staged)", opts: { git: true, lock: true, dirty: true }, expectOut: "PASS" },
  { name: "no VERDICT.lock anywhere", opts: { git: true, lock: false, dirty: true }, expectOut: "NOT PLANNED" },
  { name: "path argument", opts: { git: true, lock: true, dirty: true }, args: ["sub"], expectOut: "PASS" },
  { name: "not a git repo", opts: { git: false, lock: true, dirty: true }, expectOut: "PASS" },
];

for (const c of CASES) {
  test(
    `check leaves the repository untouched: ${c.name}`,
    async () => {
      const dir = build(c.opts);
      try {
        const before = snapshot(dir);
        const r = await check(dir, c.args);
        // The run must have really happened (laws were reported), not died early.
        expect(r.out).toContain(c.expectOut);
        const after = snapshot(dir);
        expect(after).toEqual(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
}

test(
  "check leaves the repository untouched when it fails early (no VERDICT.md, bad lock, unknown path)",
  async () => {
    const dir = build({ git: true, lock: true, dirty: true });
    try {
      writeFileSync(join(dir, "sub/VERDICT.lock"), "{{ not: [yaml\n");
      const before = snapshot(dir);
      await check(dir);
      await check(dir, ["nonexistent"]);
      expect(snapshot(dir)).toEqual(before);
      rmSync(join(dir, "VERDICT.md"));
      rmSync(join(dir, "sub/VERDICT.md"));
      const before2 = snapshot(dir);
      await check(dir);
      expect(snapshot(dir)).toEqual(before2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  300_000,
);
