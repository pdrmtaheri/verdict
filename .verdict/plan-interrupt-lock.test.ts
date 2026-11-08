// scope: the process `verdict plan` runs (findSets + plan() in src/plan.ts, writeLock()/readLock() in src/lock.ts, reproveLaw() and check()), run as real subprocesses via .verdict/plan-interrupt-runner.ts with a scripted agent in temp directories that are not git repos (verdict's no-git fallbacks). Sequences of 3-4 VERDICT.md edits (add, reword, remove, reorder, duplicate a law out of a pool of 5 laws) each followed by a `plan` that is SIGKILLed at a chosen point (before an agent starts, after a file is written, after a submit is accepted, a few ms into the run, or a parent-timed kill), then a plan run to completion. Checked after each kill: the lock parses, and once plan() has started it holds only current laws, each under its own hash with its current text; after the final run: exit 0, a lock entry for every law, `check` exits 0, every law "in sync". Not covered: a kill during the few microseconds of writeFileSync inside writeLock (a torn write), a real coding agent, git-tracked repos, nested VERDICT.md files, edits to VERDICT.md while plan runs.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLaws } from "../src/laws.ts";
import { readLock } from "../src/lock.ts";

const ROOT = resolve(import.meta.dir, "..");
const RUNNER = join(import.meta.dir, "plan-interrupt-runner.ts");

const POOL = ["Alpha is stored in cents.", "Beta is stored in cents.", "Gamma is stored in cents.", "Delta is stored in cents.", "Alpha is always stored in cents."];

type Kill = { at: string } | { after: number } | null; // "kind:n" inside the runner, or ms from outside
type Step = { laws: string[]; kill: Kill };

function fixture() {
  const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "verdict-interrupt-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/money.ts"), "export const amount = 0; // cents\n");
  return { base, repo, marker: join(base, "started") };
}

async function runPlan(f: ReturnType<typeof fixture>, kill: Kill) {
  rmSync(f.marker, { force: true });
  const env: Record<string, string> = { ...(process.env as Record<string, string>), VERDICT_SRC: join(ROOT, "src"), VERDICT_JOBS: "2", STARTED_MARKER: f.marker };
  delete env.KILL_AT;
  if (kill && "at" in kill) env.KILL_AT = kill.at;
  const proc = Bun.spawn(["bun", RUNNER], { cwd: f.repo, env, stdout: "pipe", stderr: "pipe" });
  if (kill && "after" in kill) setTimeout(() => proc.kill("SIGKILL"), kill.after);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code, started: existsSync(f.marker) };
}

// The runner's RESULT line, or a failure that shows why a run that was not killed printed none.
function resultOf(r: { out: string; err: string; code: number | null }, label: string) {
  const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`${label}: plan ran to the end without a result (exit ${r.code})\n${r.err.slice(0, 1500)}\n${r.out.slice(0, 500)}`);
  return JSON.parse(line.slice(7)) as { ok: boolean; checkExit: number; planned: boolean[]; synced: boolean[] };
}

const bullets = (laws: string[]) => "# laws\n\n" + laws.map((l) => `- ${l}`).join("\n") + "\n";

function lockAfterKill(f: ReturnType<typeof fixture>, laws: string[], started: boolean, label: string) {
  const file = join(f.repo, "VERDICT.lock");
  let lock;
  try {
    lock = readLock(file);
  } catch (e) {
    throw new Error(`${label}: VERDICT.lock does not parse after the interrupt: ${(e as Error).message}`);
  }
  const current = new Map(parseLaws(bullets(laws)).map((l) => [l.hash, l.text]));
  for (const [hash, entry] of lock) {
    if (!started) continue; // killed before plan() ran at all: it never got to touch the lock
    expect({ label, hash, held: current.has(hash) }).toEqual({ label, hash, held: true });
    expect({ label, hash, law: entry.law }).toEqual({ label, hash, law: current.get(hash) });
  }
}

async function play(steps: Step[], name: string) {
  const f = fixture();
  try {
    for (const [i, s] of steps.entries()) {
      writeFileSync(join(f.repo, "VERDICT.md"), bullets(s.laws));
      const label = `${name} step ${i} (laws ${JSON.stringify(s.laws)}, kill ${JSON.stringify(s.kill)})`;
      const r = await runPlan(f, s.kill);
      lockAfterKill(f, s.laws, r.started, label);
      if (!s.kill) {
        const result = resultOf(r, label);
        expect({ label, code: r.code, ok: result.ok }).toEqual({ label, code: 0, ok: true });
      }
    }
    // Finally: plan to completion on whatever the last interrupted run left behind.
    const final = steps.at(-1)!.laws;
    const labelled = `${name} final run (laws ${JSON.stringify(final)})`;
    const r = await runPlan(f, null);
    const result = resultOf(r, labelled);
    expect({ labelled, code: r.code, ok: result.ok }).toEqual({ labelled, code: 0, ok: true });
    const wanted = parseLaws(bullets(final));
    const lock = readLock(join(f.repo, "VERDICT.lock"));
    expect({ labelled, keys: [...lock.keys()].sort() }).toEqual({ labelled, keys: [...new Set(wanted.map((l) => l.hash))].sort() });
    expect({ labelled, checkExit: result.checkExit }).toEqual({ labelled, checkExit: 0 });
    expect({ labelled, planned: result.planned.every(Boolean) }).toEqual({ labelled, planned: true });
    expect({ labelled, synced: result.synced.every(Boolean) }).toEqual({ labelled, synced: true });
    expect(readFileSync(join(f.repo, "src/money.ts"), "utf8")).toContain("cents"); // the repo was never broken
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
}

const [A, B, C, D, A2] = POOL as [string, string, string, string, string];

test("a law removed, then plan killed as it starts an agent: the lock drops the removed law", async () => {
  await play(
    [
      { laws: [A, B, C], kill: null },
      { laws: [B], kill: { at: "start:1" } },
      { laws: [B, D], kill: { at: "write:1" } },
    ],
    "remove",
  );
}, 120_000);

test("a law reworded, plan killed after the new plan was accepted but before the lock is written", async () => {
  await play(
    [
      { laws: [A, B], kill: null },
      { laws: [A2, B], kill: { at: "submit:1" } },
      { laws: [A, A2], kill: { at: "submit:1" } },
      { laws: [A2], kill: null },
    ],
    "reword",
  );
}, 120_000);

test("everything removed, then laws re-added, with kills in between", async () => {
  await play(
    [
      { laws: [A, B, C, D], kill: { at: "submit:2" } },
      { laws: [], kill: { at: "start:1" } },
      { laws: [D, C, B, A], kill: { at: "mid:150" } },
      { laws: [C, C], kill: { after: 400 } },
    ],
    "empty",
  );
}, 120_000);

// A seeded random walk over edits and kill points, so a failure replays.
function walk(seed: number): Step[] {
  let s = seed;
  const rnd = (n: number) => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return Math.floor((s / 2 ** 32) * n);
  };
  return Array.from({ length: 3 + rnd(2) }, () => {
    const laws = Array.from({ length: rnd(4) }, () => POOL[rnd(POOL.length)]!);
    const k = rnd(7);
    const kill: Kill =
      k === 0 ? null : k === 1 ? { at: `start:${1 + rnd(3)}` } : k === 2 ? { at: `write:${1 + rnd(3)}` } : k === 3 ? { at: `submit:${1 + rnd(3)}` } : k === 4 ? { at: `mid:${rnd(200)}` } : { after: 50 + rnd(600) };
    return { laws, kill };
  });
}

for (const seed of [1, 2, 3, 4, 5, 6]) {
  test(`random edits and interrupts, seed ${seed}`, async () => {
    await play(walk(seed), `seed ${seed}`);
  }, 120_000);
}
