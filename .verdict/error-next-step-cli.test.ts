// scope: `bun src/cli.ts` run as a real process in scratch directories (outside the repo), on the failure paths a person can reach without an agent, a model key or a network: no VERDICT.md, a path with no VERDICT.md, a corrupt or malformed VERDICT.lock (check and plan), an unknown VERDICT_AGENT on plan, bad flags, a lock entry with an unknown enforcer kind, a missing enforcer file, and an enforcer that fails, exits 77 or can't be run. Each must print a next step (a command in backticks, or an imperative such as run/create/fix/restore/delete/edit) and never a raw stack trace. Not covered: failures that need a real agent, semgrep, TLC or a decision model, and wording quality beyond "names a next step" (the llm judge reads that).

import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLaws } from "../src/laws.ts";

const REPO = resolve(import.meta.dir, "..");
const LAW = "Alpha stays planned.";
const hashOf = (text: string) => parseLaws(`- ${text}`)[0]!.hash;

// What counts as a next step: a command in backticks, or an imperative verb.
const NEXT_STEP = /`[^`\n]+`|\b(run|create|install|fix|restore|delete|remove|edit|set|unset|add|move|provide|check the|write|use)\b/i;
// A raw stack trace or a library error class leaking to the user.
const RAW_CRASH = /^\s+at .*(\.ts|\.js|<anonymous>)|\b\w*(Parse|Type|Reference|Syntax)Error:|\bBun v\d/m;

function scratch(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "verdict-nextstep-"));
  setup(dir);
  return dir;
}

async function cli(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, join(REPO, "src/cli.ts"), ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code: code ?? -1, out: out + err };
}

async function expectNextStep(setup: (dir: string) => void, args: string[], env: Record<string, string> = {}, opts: { nonZero?: boolean } = { nonZero: true }) {
  const dir = scratch(setup);
  try {
    const { code, out } = await cli(dir, args, env);
    if (opts.nonZero) expect(code).not.toBe(0);
    // Judge only the message, not the directory it names.
    const text = out.replaceAll(dir, "<dir>");
    expect(text.trim(), "a failure path printed nothing").not.toBe("");
    expect(text, `raw crash instead of a message:\n${text}`).not.toMatch(RAW_CRASH);
    expect(text, `no next step in:\n${text}`).toMatch(NEXT_STEP);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const withLaw = (dir: string) => writeFileSync(join(dir, "VERDICT.md"), `- ${LAW}\n`);

function withLock(entry: (hash: string) => string, files: Record<string, { body: string; exec: boolean }> = {}) {
  return (dir: string) => {
    withLaw(dir);
    mkdirSync(join(dir, ".verdict"));
    for (const [name, { body, exec }] of Object.entries(files)) {
      const f = join(dir, ".verdict", name);
      writeFileSync(f, body);
      if (exec) chmodSync(f, 0o755);
    }
    writeFileSync(join(dir, "VERDICT.lock"), entry(hashOf(LAW)));
  };
}

const entryWith = (kind: string, path: string) => (hash: string) => `${hash}:\n  law: ${JSON.stringify(LAW)}\n  enforcers:\n    - ${kind}: ${path}\n`;

for (const command of ["check", "plan"]) {
  test(`${command}: no VERDICT.md says what to create`, async () => {
    await expectNextStep(() => {}, [command]);
  }, 120_000);

  test(`${command}: a path with no VERDICT.md says what to do`, async () => {
    await expectNextStep(withLaw, [command, "nowhere"]);
  }, 120_000);

  test(`${command}: a corrupt VERDICT.lock says what to do, not a stack trace`, async () => {
    await expectNextStep(withLock(() => "{{ not: [yaml\n"), [command]);
  }, 120_000);
}

test("plan: an unknown VERDICT_AGENT says what to set", async () => {
  await expectNextStep(withLaw, ["plan"], { VERDICT_AGENT: "nonesuch" });
}, 120_000);

test("bad flags say what to do", async () => {
  await expectNextStep(withLaw, ["check", "--format", "xml"]);
  await expectNextStep(withLaw, ["check", "--again", "x"]);
  await expectNextStep(withLaw, ["plan", "--format", "sarif"]);
  await expectNextStep(withLaw, ["plan", "--again", "no such law"]);
}, 120_000);

test("check: an unknown enforcer kind says how to fix the lock", async () => {
  await expectNextStep(withLock(entryWith("magic", ".verdict/x.sh")), ["check"]);
}, 120_000);

test("check: a missing enforcer file says how to get it back", async () => {
  await expectNextStep(withLock(entryWith("test", ".verdict/gone.sh")), ["check"]);
}, 120_000);

test("check: a failing enforcer says what to fix", async () => {
  await expectNextStep(withLock(entryWith("test", ".verdict/f.sh"), { "f.sh": { body: "#!/bin/sh\n# scope: fixture\necho broken on purpose\nexit 1\n", exec: true } }), ["check"]);
}, 120_000);

test("check: an enforcer that exits 77 says what to provide", async () => {
  await expectNextStep(withLock(entryWith("test", ".verdict/s.sh"), { "s.sh": { body: "#!/bin/sh\n# scope: fixture\nexit 77\n", exec: true } }), ["check"], {}, { nonZero: false });
}, 120_000);

test("check: a test file verdict can't tell how to run says what to do", async () => {
  await expectNextStep(withLock(entryWith("test", ".verdict/plain.txt"), { "plain.txt": { body: "# scope: fixture\nnot a test\n", exec: false } }), ["check"], {}, { nonZero: false });
}, 120_000);
