import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "./agent.ts";
import { checkLaw } from "./check.ts";
import { KINDS } from "./enforcers.ts";
import { which } from "./exec.ts";
import type { Law } from "./laws.ts";
import { writeLock, type Lock, type LockEntry } from "./lock.ts";
import { languageModel } from "./models.ts";
import { readTools, writeTools, inside } from "./tools.ts";

export const OUT_DIR = ".verdict";

const PROBE = ["semgrep", "eslint", "ruff", "golangci-lint", "clippy-driver", "mypy", "pyright", "tlc", "java", "go", "python3", "pytest", "cargo", "bun", "node"];

const SYSTEM = `You plan how to enforce one law about a software repository. A law is
an assertion in prose. You pick the enforcer(s) that check it, write them into
${OUT_DIR}/, validate them, and call submit.

Rules
- Enforcers observe the system from outside. Never change the system under
  check; you can only write inside ${OUT_DIR}/. If a good idea needs a change to
  the system (a new type, determinism for simulation testing, instrumentation),
  put it in suggestions instead.
- Prefer the most deterministic enforcer that can really check the law:
  lint/pattern for the shape of code, tests for behaviour, proofs for invariants
  worth proving, judges only for things that are readable but not mechanical.
  An LLM judge always works, so use it when nothing else fits.
- Use the repo's own tooling when it is robust. Look at its config and
  dependencies first. Prefer tools that are installed or already in its
  dependencies; if the best tool is missing, still pick it and say so in
  suggestions.
- Name files ${OUT_DIR}/<short-slug>.<ext>.

Enforcer kinds (the "kind" in submit) and their file formats
- semgrep: a Semgrep rule file, run as semgrep scan --config <file> --error over
  the whole repo. Exit 1 means the law is broken. Semgrep is the only engine
  for pattern rules. Ship should-flag and should-pass examples in its own test
  format (ruleid:/ok: annotations, run with semgrep --test), and exclude
  ${OUT_DIR}/ from the real scan (paths: exclude) so the examples don't trip it.
- Type-aware rules. Semgrep matches syntax and has limited type information.
  When a law depends on types, go down this list and stop at the first that
  can express it:
  1. Semgrep typed metavariables, e.g. (float $X), where the language supports them.
  2. An executable test script (kind test) that runs one built-in rule of a
     type-aware tool the repo already uses, e.g. cargo clippy -- -D
     clippy::float_arithmetic, a typescript-eslint typed rule, ruff --select.
  3. A custom analyzer in the language's own framework (go/analysis, a
     typescript-eslint rule, ...), written inside ${OUT_DIR}/ and run by a test
     script.
  4. A behavioural test or an LLM judge.
- test: one test file, run with the repo's test framework. The runner is
  inferred from the file name: *.test.ts / *.spec.ts (vitest, jest, playwright
  for .spec with @playwright/test, else bun test), *_test.go (go test on its
  directory), test_*.py / *_test.py (pytest), or any executable file (write it
  with executable: true). Exit 0 is pass. Drive the system through its public interface. The law is the oracle;
  pick the search strategy: example, property-based, fuzzing.
- tla: a TLA+ spec (<slug>.tla plus <slug>.cfg), checked with TLC. A spec only
  proves the design, so pair it with a test generated from the spec: walk the
  spec's behaviours (bounded depth) and replay each one against the real system
  through an adapter that maps spec actions to public calls.
- decision: a decision model (jev by default) answering one choice question.
  JSON: {"state_from": "<shell command that prints the text to judge>",
  "instructions": "<question>", "criteria": {"pass": "...", "fail": "...",
  "inconclusive": "..."}, "min_probability": 0.85}. Good for judgement on text
  that a command can produce (a diff, docs, strings). It can't look around and
  is weak at maths, code and logic. Always add an llm judge to the same law: it
  runs when the decision model is unsure.
- llm: an LLM judge that can read the repo. The file is Markdown with hints:
  where to look and what counts as a violation.

Before submitting, run each enforcer you wrote once (when its tool is
installed). If the law looks false in today's code, still submit and add a
suggestion saying so, with the evidence. If the law is too vague to check,
suggest a rewrite.`;

const Submission = z.object({
  enforcers: z
    .array(z.object({ kind: z.enum(KINDS as [string, ...string[]]), path: z.string() }))
    .min(1),
  suggestions: z.array(z.string()).describe("Changes for a person to consider. Empty if none."),
});

export interface PlanOutcome {
  law: Law;
  entry?: LockEntry;
  suggestions: string[];
  error?: string;
}

export async function planLaw(root: string, law: Law): Promise<PlanOutcome> {
  const installed = PROBE.filter((t) => which(root, t));
  const submission = await runAgent({
    model: languageModel(),
    system: SYSTEM,
    prompt: `Law: ${law.text}\n\nInstalled tools: ${installed.join(", ") || "none"}`,
    tools: { ...readTools(root), ...writeTools(root, join(root, OUT_DIR)) },
    submit: { description: "Submit the enforcers for this law.", schema: Submission },
    maxSteps: 80,
    reasoning: "high",
  });
  if (!submission) return { law, suggestions: [], error: "the planner did not submit a plan" };
  for (const e of submission.enforcers) {
    try {
      inside(root, e.path, join(root, OUT_DIR));
    } catch (err) {
      return { law, suggestions: submission.suggestions, error: (err as Error).message };
    }
    if (!existsSync(join(root, e.path))) {
      return { law, suggestions: submission.suggestions, error: `${e.path} was not written` };
    }
  }
  return { law, entry: { law: law.text, enforcers: submission.enforcers }, suggestions: submission.suggestions };
}

// Plans every law that isn't in the lock (new, or its wording changed),
// writing the lock after each one. Entries for removed laws are dropped.
export async function plan(
  root: string,
  lockFile: string,
  laws: Law[],
  lock: Lock,
  log: (line: string) => void,
): Promise<boolean> {
  let ok = true;
  writeLock(lockFile, lock, laws);
  for (const law of laws.filter((l) => !lock.has(l.hash))) {
    log(`planning: ${law.text}`);
    let outcome: PlanOutcome;
    try {
      outcome = await planLaw(root, law);
    } catch (err) {
      // e.g. a missing API key: the same error would repeat for every law.
      log(`  error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    for (const s of outcome.suggestions) log(`  suggestion: ${s}`);
    if (!outcome.entry) {
      ok = false;
      log(`  error: ${outcome.error}`);
      continue;
    }
    lock.set(law.hash, outcome.entry);
    writeLock(lockFile, lock, laws);
    for (const e of outcome.entry.enforcers) log(`  ${e.kind}: ${e.path}`);
    const report = await checkLaw(root, outcome.entry);
    if (report.status === "fail") log(`  suggestion: this law looks false in today's code (verdict check fails it)`);
    if (report.status === "inconclusive") log(`  note: the enforcers are inconclusive today`);
  }
  return ok;
}
