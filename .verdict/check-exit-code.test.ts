// scope: `bun src/cli.ts check` run as a real process in scratch directories (outside the repo), over two laws in every combination of seven states: pass, fail, inconclusive, not in the lock, lock entry for reworded text, enforcer file missing, lock entry with no enforcers; plus a missing VERDICT.md and an unreadable VERDICT.lock. Enforcers are executable test scripts that exit 0, 1 or 77, so no semgrep, TLC, decision model, LLM judge or network is needed. "Planned" here means a lock entry with at least one enforcer, which is what plan writes. Not covered: more than two laws, the enforcer kinds semgrep, tla, decision and llm, and this repo's own laws (their judges run agents and take minutes).

import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLaws } from "../src/laws.ts";

const REPO = resolve(import.meta.dir, "..");

const TEXT = ["Alpha stays planned.", "Beta stays planned."];

type State = "pass" | "fail" | "inconclusive" | "unplanned" | "reworded" | "missing" | "empty";
const STATES: State[] = ["pass", "fail", "inconclusive", "unplanned", "reworded", "missing", "empty"];
// Any of these must make check exit non-zero.
const BAD = new Set<State>(["fail", "unplanned", "reworded", "missing", "empty"]);

const hashOf = (text: string) => parseLaws(`- ${text}`)[0]!.hash;

function fixture(states: State[]): string {
  const dir = mkdtempSync(join(tmpdir(), "verdict-exit-"));
  mkdirSync(join(dir, ".verdict"));
  writeFileSync(join(dir, "VERDICT.md"), TEXT.map((t) => `- ${t}\n`).join(""));
  const entries: string[] = [];
  states.forEach((state, i) => {
    if (state === "unplanned") return;
    const text = state === "reworded" ? `Old wording of ${TEXT[i]}` : TEXT[i]!;
    const enforcers =
      state === "empty"
        ? "  enforcers: []"
        : state === "missing"
          ? `  enforcers:\n    - test: .verdict/gone${i}.sh`
          : `  enforcers:\n    - test: .verdict/law${i}.sh`;
    if (state !== "empty" && state !== "missing") {
      const body = { pass: "exit 0", reworded: "exit 0", fail: "echo 'broken on purpose'\nexit 1", inconclusive: "exit 77" }[state];
      const file = join(dir, `.verdict/law${i}.sh`);
      writeFileSync(file, `#!/bin/sh\n# scope: fixture script for check-exit-code.test.ts\n${body}\n`);
      chmodSync(file, 0o755);
    }
    entries.push(`${hashOf(text)}:\n  law: ${JSON.stringify(text)}\n${enforcers}\n`);
  });
  writeFileSync(join(dir, "VERDICT.lock"), entries.join(""));
  return dir;
}

async function verdictCheck(dir: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, join(REPO, "src/cli.ts"), "check"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code: code ?? -1, out: out + err };
}

test(
  "check exits 0 only when no law fails and every law is planned, for every pair of states",
  async () => {
    const cases: State[][] = [];
    for (const a of STATES) for (const b of STATES) cases.push([a, b]);
    const violations: string[] = [];
    for (let i = 0; i < cases.length; i += 8) {
      await Promise.all(
        cases.slice(i, i + 8).map(async (states) => {
          const dir = fixture(states);
          try {
            const { code, out } = await verdictCheck(dir);
            const bad = states.some((s) => BAD.has(s));
            const allPass = states.every((s) => s === "pass");
            if (bad && code === 0) violations.push(`states [${states.join(", ")}] but exit 0:\n${out}`);
            if (allPass && code !== 0) violations.push(`states [${states.join(", ")}] all pass but exit ${code}:\n${out}`);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }),
      );
    }
    expect(violations).toEqual([]);
  },
  900_000,
);

test(
  "a missing VERDICT.md is an error, not a pass",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "verdict-exit-"));
    try {
      const { code } = await verdictCheck(dir);
      expect(code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

test(
  "a VERDICT.lock that can't be read is an error, not a pass",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "verdict-exit-"));
    try {
      writeFileSync(join(dir, "VERDICT.md"), `- ${TEXT[0]}\n`);
      writeFileSync(join(dir, "VERDICT.lock"), "{{ not: [yaml\n");
      const { code } = await verdictCheck(dir);
      expect(code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
