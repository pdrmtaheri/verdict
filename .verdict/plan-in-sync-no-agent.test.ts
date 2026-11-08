// scope: `bun src/cli.ts plan` as a real process, and plan() in-process with a counting agent, over throwaway repos whose laws are all in sync (executable test-script enforcers, each with a stored break that applies and is caught): one law, and three laws across a root VERDICT.md and a nested one. In the CLI runs VERDICT_AGENT names no agent, so starting any coding agent (planner or judge) throws and plan exits 1. Controls: a drifted law and an unplanned law do start the agent. The child runs with VERDICT_SANDBOX=off (the sandbox is not under test, and sandboxes do not nest on macOS). Not covered: llm/decision/semgrep/tla enforcers (an llm judge starts an agent by design when its decision model is unsure), the real claude-code/codex/pi launchers.

import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { overrides as agents, type Agent } from "../src/agent.ts";
import { writeBreaks } from "../src/breaks.ts";
import { parseLaws } from "../src/laws.ts";
import { readLock } from "../src/lock.ts";
import { plan } from "../src/plan.ts";
import { at } from "../src/where.ts";

const REPO = resolve(import.meta.dir, "..");
// A real git first, not macOS's xcrun shim (it prints errors into stdout/stderr when it can't write its cache).
const CLT = "/Library/Developer/CommandLineTools/usr/bin";
const PATH = [existsSync(CLT) ? CLT : "", process.env.PATH, "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"].filter(Boolean).join(":");
const ENV = { ...process.env, PATH, VERDICT_SANDBOX: "off" };

afterEach(() => {
  delete agents.agent;
});

const hashOf = (text: string) => parseLaws(`- ${text}`)[0]!.hash;
const script = (word: string, file: string) => `#!/bin/sh\n# scope: ${file} only (fixture for plan-in-sync-no-agent.test.ts)\ngrep -q ${word} ${file}\n`;

interface Spec {
  dir: string; // relative to the repo root, "" for the root
  text: string;
  word: string;
  state?: "sync" | "drift" | "unplanned";
}

function fixture(specs: Spec[]): string {
  const root = mkdtempSync(join(tmpdir(), "verdict-insync-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: root, env: ENV });
  const byDir = new Map<string, Spec[]>();
  for (const s of specs) byDir.set(s.dir, [...(byDir.get(s.dir) ?? []), s]);
  for (const [dir, list] of byDir) {
    const base = join(root, dir);
    mkdirSync(join(base, ".verdict"), { recursive: true });
    mkdirSync(join(base, "src"), { recursive: true });
    writeFileSync(join(base, "VERDICT.md"), list.map((s) => `- ${s.text}\n`).join(""));
    const entries: string[] = [];
    list.forEach((s, i) => {
      const file = `src/f${i}.ts`;
      writeFileSync(join(base, file), `export const x = "${s.word}";\n`);
      const enforcer = `.verdict/e${i}.sh`;
      // A drifted law has an enforcer that passes on broken code.
      const body = s.state === "drift" ? `#!/bin/sh\n# scope: nothing, by mistake\nexit 0\n` : script(s.word, file);
      writeFileSync(join(base, enforcer), body);
      chmodSync(join(base, enforcer), 0o755);
      if (s.state === "unplanned") return;
      writeBreaks(base, hashOf(s.text), [{ enforcer, description: `drop ${s.word}`, edits: [{ path: file, find: s.word, replace: "other" }] }]);
      entries.push(`${hashOf(s.text)}:\n  law: ${JSON.stringify(s.text)}\n  enforcers:\n    - test: ${enforcer}\n`);
    });
    writeFileSync(join(base, "VERDICT.lock"), entries.join(""));
  }
  return root;
}

async function cli(root: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, join(REPO, "src/cli.ts"), "plan"], {
    cwd: root,
    env: { ...ENV, VERDICT_AGENT: "no-such-agent", VERDICT_JOBS: "4" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 240_000,
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code: code ?? -1, out: out + err };
}

function countingAgent(): Agent & { started: number } {
  const a = { name: "counting", started: 0, async run() { a.started++; } };
  return a;
}

const ONE: Spec[] = [{ dir: "", text: "Amounts are stored in cents.", word: "cents" }];
const THREE: Spec[] = [
  { dir: "", text: "Alpha holds.", word: "alpha" },
  { dir: "", text: "Beta holds.", word: "beta" },
  { dir: "sub", text: "Gamma holds.", word: "gamma" },
];

test("CLI: plan with every law in sync starts no agent and exits 0", async () => {
  for (const specs of [ONE, THREE]) {
    const root = fixture(specs);
    try {
      const { code, out } = await cli(root);
      expect(out).not.toContain("is not one of"); // that error means plan tried to start an agent
      expect(out).not.toContain("error:");
      expect(out).not.toContain("planning:");
      expect(out.match(/in sync:/g)?.length).toBe(specs.length);
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 600_000);

test("in-process: plan() with every law in sync never calls runAgent", async () => {
  const root = fixture(ONE);
  try {
    const agent = countingAgent();
    agents.agent = agent;
    const text = ONE[0]!.text;
    const log: string[] = [];
    const lock = readLock(join(root, "VERDICT.lock"));
    const ok = await plan(at(root), join(root, "VERDICT.lock"), parseLaws(`- ${text}`), lock, (l) => log.push(l));
    expect(log.join("\n")).toContain("in sync:");
    expect(agent.started).toBe(0);
    expect(ok).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);

test("controls: a drifted law and an unplanned law do start the agent", async () => {
  for (const state of ["drift", "unplanned"] as const) {
    const root = fixture([{ dir: "", text: "Amounts are stored in cents.", word: "cents", state }]);
    try {
      const { code, out } = await cli(root);
      expect(out).toContain("is not one of");
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 600_000);
