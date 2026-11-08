import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { ruleFiles } from "./init.ts";
import { z } from "zod";
import { defineTool, runAgent } from "./agent.ts";
import { Break, breaksFile, Edit, prove, runInScratch, writeBreaks } from "./breaks.ts";
import { KINDS, scopeOf, SKIPPED } from "./enforcers.ts";
import { exec, which } from "./exec.ts";
import type { Law } from "./laws.ts";
import { writeLock, type Enforcer, type Lock, type LockEntry } from "./lock.ts";
import type { Result } from "./result.ts";
import { inputsOf } from "./pins.ts";
import { LINTERS, linterFor, scopeFiles } from "./linters.ts";
import { reproveLaw, type Reproof } from "./reprove.ts";
import { inside, readTools, writeTools } from "./tools.ts";
import { label, type Where } from "./where.ts";
import { jobs, makeLimit, type Limit } from "./limit.ts";

export const OUT_DIR = ".verdict";

const PROBE = ["semgrep", "eslint", "ruff", "golangci-lint", "clippy-driver", "mypy", "pyright", "tlc", "java", "go", "python3", "pytest", "cargo", "bun", "node"];

export const SYSTEM = `You plan how to enforce one law about a software repository. A law is
an assertion in prose. You pick the enforcer(s) that check it, write them into
${OUT_DIR}/, prove each one can fail, and call submit.

Rules
- Enforcers observe the system from outside. Never change the system under
  check; you can only write inside ${OUT_DIR}/. If a good idea needs a change to
  the system (a new type, determinism for simulation testing, instrumentation),
  put it in suggestions instead.
- Prefer the most deterministic enforcer that can really check the law:
  pattern rules for the shape of code, tests for behaviour, proofs for
  invariants worth proving, judges only for things that are readable but not
  mechanical. An LLM judge always works, so use it when nothing else fits.
- Use the repo's own tooling when it is robust. Look at its config and
  dependencies first. Prefer installed tools; if the best tool is missing,
  still pick it and say so in suggestions.
- Before writing a test, look for one the repo already has that checks the
  law. If one does, point at it instead of copying it: its path (outside
  ${OUT_DIR}/), the test's name if the file has others, and its scope in the
  submission. Prove it like any enforcer: its break changes the code, never
  the test or the runner's config. If it can't see a real violation, write
  your own in ${OUT_DIR}/ and say what the existing one misses in suggestions.
- When a law is about interleavings, concurrency, retries, crashes or "in any
  order", a test only covers the schedules you wrote down. If TLC is installed,
  model the design in TLA+ and check it, paired with a test generated from the
  spec (see tla below): that covers every schedule up to the bound. If TLC
  isn't installed, write the test, and add a suggestion that installing TLC
  would let this law be model-checked.
- Cover every way the law can be broken, not the convenient one: every entry
  point a user has (UI, CLI, API), every code path that writes the guarded state.
- Keep each enforcer cheap to rerun: seconds, a few minutes at most. Choose
  bounds (model depth, input sizes) to fit.
- Name files ${OUT_DIR}/<short-slug>.<ext>. Other laws are planned at the same
  time; if a name is taken, write_file says so: pick another.

Every enforcer file states its scope
- Near the top, a comment line "scope: <what this covers, its bounds and
  assumptions, and what it leaves out>" (a "scope" field in JSON files). A pass
  only covers that scope. Example: "scope: charge() and retry() in
  src/payments/, up to 3 retries and 2 timeouts; refunds not covered".

Every enforcer must be seen to fail
- A check you have never seen fail proves nothing. For each enforcer that
  passes on today's code, submit a break: a small edit to the system under
  check (not to ${OUT_DIR}/) that violates the law the way it would really be
  broken, such as removing a check, reordering two steps, or using a float.
  verdict applies the break to a scratch copy, never to the repo, and the
  enforcer must fail there. Try breaks with try_break before submitting.
- Findings stay findings. If the law is false in today's code, do not weaken
  the enforcer, its scope or its bounds until it passes. Submit it failing, and
  put the counterexample in "finding" as a short sequence of steps in the
  code's own words (files, functions), plus the harm in one sentence.

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
- lint: a rule the project's own linter already has (${"eslint, ruff"}). path is
  the linter's config file (eslint.config.js, .eslintrc.*, ruff.toml,
  pyproject.toml), rule is the rule's id, and scope is globs relative to the
  law's directory (e.g. "src/**/*.ts"). verdict runs the linter under that
  config and keeps that rule's findings in the scope. Use it instead of a
  semgrep rule when the project's linter already checks the law; never write
  linter rules or configs of your own. Its break is code that violates the
  rule.
- test: one test file, run with the repo's test framework. The runner is
  inferred from the file name: *.test.ts / *.spec.ts (vitest, jest, playwright
  for .spec with @playwright/test, else bun test), *_test.go (go test on its
  directory), test_*.py / *_test.py (pytest), or any executable file (write it
  with executable: true). Exit 0 is pass. Exit ${SKIPPED} means a precondition the
  test needs is missing (a service, a credential, seed data): verdict reports
  that as inconclusive. Never weaken a test to make it pass or to dodge a
  missing precondition.
  Proof standards for tests that drive the app (E2E, CLI, API):
  - Exercise the real user path, not internal setters or test-only endpoints.
  - Check the action and the resulting state, and side effects too (files
    written, rows inserted, messages sent), not just what is shown.
  - Mock only where a production boundary already isolates the external system.
  - If the safe path is a dry-run or test mode, check what it really skips.
  - Start from an empty, disposable data dir and free ports, so two runs can
    happen at once. Stop only what the test started; never kill by name.
  - Wait for a ready signal that means usable, not just "process is up".
  The law is the oracle; pick the search strategy: example, property-based,
  fuzzing.
- tla: a TLA+ spec (<slug>.tla plus <slug>.cfg), checked with TLC. Every part
  of the spec points to code a reviewer can open (cite file:function in
  comments), names come from the repo, and one indivisible step in the code is
  one action in the spec. A spec only proves the design, so pair it with a test
  generated from the spec: walk the spec's behaviours (bounded depth) and replay
  each one against the real system through an adapter that maps spec actions to
  public calls. The break for the spec itself is an edit to the code that the
  generated test catches; a spec-only change is not a break.
- decision: a decision model (jev by default) answering one choice question.
  JSON: {"scope": "...", "state_from": "<shell command that prints the text to
  judge>", "instructions": "<question>", "criteria": {"pass": "...", "fail":
  "...", "inconclusive": "..."}, "min_probability": 0.85}. Good for judgement on
  text that a command can produce (a diff, docs, strings). It can't look around
  and is weak at maths, code and logic. Always add an llm judge to the same
  law: it runs when the decision model is unsure.
- llm: an LLM judge that can read the repo. The file is Markdown with hints:
  where to look and what counts as a violation. Its break is its eval: an edit
  the judge must fail.

If the law is too vague to check, suggest a rewrite.`;

const EnforcerRef = z.object({
  kind: z.enum(KINDS as [string, ...string[]]),
  path: z.string().describe(`A file you wrote in ${OUT_DIR}/, or a test file the repo already has`),
  name: z.string().optional().describe("For a test file the repo already has: the one test that enforces the law, by its name"),
  rule: z.string().optional().describe("For lint: the rule's id in the project's linter config (path is that config file)"),
  scope: z.string().optional().describe(`What it covers. Required for a file outside ${OUT_DIR}/ (you can't add a scope line there)`),
});

const Submission = z.object({
  enforcers: z.array(EnforcerRef).min(1),
  breaks: z.array(Break).describe("One per enforcer that passes on today's code"),
  finding: z
    .string()
    .optional()
    .describe("Only if the law is false in today's code: the counterexample as steps in the code's words, and the harm"),
  suggestions: z.array(z.string()).describe("Changes for a person to consider. Empty if none."),
});
type Submission = z.infer<typeof Submission>;

export interface PlanOutcome {
  law: Law;
  entry?: LockEntry;
  breaks: Break[];
  finding?: string;
  notes: string[]; // what verdict observed while validating
  suggestions: string[];
  error?: string;
}

function show(r: Result): string {
  return r.message ? `${r.status}: ${r.message}` : r.status;
}

// Checks a submission the way verdict will use it. Returns a reason to
// reject it, or notes for the person reviewing the plan.
export async function validate(w: Where, law: Law, sub: Submission): Promise<{ problem: string | null; notes: string[] }> {
  const notes: string[] = [];
  let failsToday = false;
  for (const e of sub.enforcers) {
    let ours = true;
    try {
      inside(w.dir, e.path, join(w.dir, OUT_DIR));
    } catch {
      ours = false;
    }
    if (!ours) {
      // A test the project already has: verdict points at it and never edits it.
      try {
        inside(w.dir, e.path, w.repo);
      } catch (err) {
        return { problem: (err as Error).message, notes };
      }
      if (e.kind !== "test" && e.kind !== "lint") return { problem: `${e.path} is outside ${OUT_DIR}/: only a test or a linter config the repo already has can be used where it is; write a ${e.kind} enforcer in ${OUT_DIR}/`, notes };
      if (!existsSync(join(w.dir, e.path))) return { problem: `${e.path} doesn't exist`, notes };
      if (!e.scope) return { problem: `${e.path} is the repo's own file: give its scope in the submission`, notes };
      if (e.kind === "lint" && !linterFor(e.path)) return { problem: `${e.path} isn't a config file verdict can read for lint (${LINTERS.map((l) => l.name).join(", ")}); for another linter, write an executable test in ${OUT_DIR}/ that runs it`, notes };
      if (e.kind === "lint" && !e.rule) return { problem: `the lint enforcer ${e.path} needs the rule's id`, notes };
      if (e.kind === "lint" && scopeFiles(w.dir, e.scope).length === 0) return { problem: `the scope "${e.scope}" matches no files: for lint it is globs relative to the law's directory`, notes };
    } else if (e.kind === "lint") {
      return { problem: `a lint enforcer points at the project's own linter config, not a file in ${OUT_DIR}/; to write a rule of your own, use semgrep`, notes };
    } else {
      if (!existsSync(join(w.dir, e.path))) return { problem: `${e.path} was not written`, notes };
      if (!e.scope && !scopeOf(w.dir, e.path)) return { problem: `${e.path} has no "scope:" line`, notes };
    }
    const today = await runInScratch(w, law.text, e);
    if (today.status === "fail") {
      failsToday = true;
      notes.push(`${e.path} fails on today's code`);
      continue;
    }
    if (today.status === "inconclusive") {
      notes.push(`${e.path} is inconclusive today and is unproven (${today.message.split("\n")[0]})`);
      continue;
    }
    const brk = sub.breaks.find((b) => b.enforcer === e.path);
    if (!brk) return { problem: `${e.path} passes today; submit a break that makes it fail`, notes };
    const proof = await prove(w, law.text, e, brk);
    if (proof.kind === "missed") return { problem: `${e.path} still passes with the break "${brk.description}". Make the enforcer see it, or pick a break that really violates the law.`, notes };
    if (proof.kind === "stale") return { problem: `the break for ${e.path} doesn't apply: ${proof.reason}`, notes };
    if (proof.kind === "unknown") notes.push(`${e.path} was inconclusive on its break (${proof.result.message.split("\n")[0]})`);
    else notes.push(`${e.path} caught its break: ${brk.description}`);
  }
  if (failsToday && !sub.finding) return { problem: "the law fails on today's code; describe the counterexample in finding", notes };
  return { problem: null, notes };
}

function planTools(w: Where, law: Law) {
  return {
    run_enforcer: defineTool({
      description: "Run one enforcer on a sandboxed scratch copy of the repo, the way verdict validates your plan.",
      schema: EnforcerRef,
      execute: async (e) => show(await runInScratch(w, law.text, e)),
    }),
    try_break: defineTool({
      description: "Apply edits to a scratch copy of the repo and run one enforcer there. The repo is never changed.",
      schema: z.object({ enforcer: EnforcerRef, edits: z.array(Edit).min(1) }),
      execute: async ({ enforcer, edits }) => {
        const p = await prove(w, law.text, enforcer, { enforcer: enforcer.path, description: "trial", edits });
        if (p.kind === "stale") return `the edits don't apply: ${p.reason}`;
        return `${p.kind === "caught" ? "caught" : p.kind === "missed" ? "missed: the enforcer passed" : "inconclusive"} (${show(p.result)})`;
      },
    }),
  };
}

export async function planLaw(w: Where, law: Law, context = "", claim?: (abs: string) => string | null): Promise<PlanOutcome> {
  const installed = PROBE.filter((t) => which(w.dir, t));
  const jar = process.env.VERDICT_TLA2TOOLS;
  if (jar && existsSync(jar) && !installed.includes("tlc")) installed.push("tlc (tla2tools.jar via VERDICT_TLA2TOOLS)");
  const where =
    w.dir === w.repo
      ? "The law is declared in VERDICT.md at the repo root and applies to the whole repo."
      : `The law is declared in ${label(w)}/VERDICT.md and applies to that directory's subtree only. ` +
        `Paths are relative to ${label(w)}/; ../ reaches the rest of the repo for context. ` +
        `Write enforcers in ${label(w)}/${OUT_DIR}/ and scope them to that subtree.`;
  const rules = [...new Set([...ruleFiles(w.repo).map((f) => relative(w.dir, join(w.repo, f))), ...ruleFiles(w.dir)])];
  const guides = rules.length
    ? `\n\nThe project's own rules for people and agents, worth reading for context (they are not laws): ${rules.join(", ")}`
    : "";
  let notes: string[] = [];
  const submission = await runAgent({
    system: SYSTEM,
    prompt: `Law: ${law.text}\n\n${where}\n\nInstalled tools: ${installed.join(", ") || "none"}${guides}${context ? `\n\n${context}` : ""}`,
    tools: { ...readTools(w.dir, w.repo), ...writeTools(w.dir, join(w.dir, OUT_DIR), w.repo, claim), ...planTools(w, law) },
    cwd: w.dir,
    submit: {
      description: "Submit the enforcers for this law, with a break for each one that passes today.",
      schema: Submission,
      validate: async (sub) => {
        const v = await validate(w, law, sub);
        notes = v.notes;
        return v.problem;
      },
    },
    maxSteps: 100,
    reasoning: "high",
  });
  if (!submission) return { law, breaks: [], notes, suggestions: [], error: "the planner stopped without a plan verdict could accept: read the rejections above, then run `verdict plan` again (a stronger VERDICT_MODEL or higher VERDICT_REASONING may help)" };
  return {
    law,
    entry: { law: law.text, enforcers: submission.enforcers },
    breaks: submission.breaks.filter((b) => submission.enforcers.some((e) => e.path === b.enforcer)),
    finding: submission.finding,
    notes,
    suggestions: submission.suggestions,
  };
}

export function logOutcome(o: PlanOutcome, log: (line: string) => void): void {
  if (!o.entry) return log(`  error: ${o.error}`);
  for (const e of o.entry.enforcers) log(`  ${e.kind}: ${e.path}`);
  for (const n of o.notes) log(`  ${n}`);
  if (o.finding) log(`  finding: the law looks false in today's code:\n${o.finding.replace(/^/gm, "    ")}`);
  for (const s of o.suggestions) log(`  suggestion: ${s}`);
}

// The commit at which a law's enforcers were last proven, read from git
// rather than stored: the last commit that touched its breaks file.
async function lastProven(w: Where, hash: string): Promise<string | null> {
  const r = await exec(["git", "log", "-1", "--format=%h", "--", breaksFile(w.dir, hash)], { cwd: w.dir });
  return r.code === 0 && r.output ? r.output : null;
}

const TRIAGE = `This law is already planned, but something changed: an enforcer can no
longer be shown to fail on today's code (its break no longer applies, or it
passes on code broken on purpose), or an enforcer passed when it was planned
and fails now. The current enforcers are listed below; read them, and read
the code as it is now. Decide which of these happened, and say which in
suggestions:
- The enforcer no longer describes the code (a function moved, a step split, a
  new path writes the guarded state). Update the enforcer and its break from the
  code, not from what makes it pass. Keep its bounds unless the change makes
  them wrong; if you shrink a bound, say so.
- The promise changed on purpose, and evidence says so (a commit message, docs,
  tests, a changelog). Don't change what the enforcer checks; cite the evidence
  and suggest that a person edit the law in VERDICT.md.
- The enforcer depended on something incidental that changed while the promise
  still holds: an exact message, a file's path, an import. Make it check the
  promise itself, and say what it depended on.
- The code breaks the law (a regression). Keep the enforcer failing and put the
  counterexample in finding, naming the commit that introduced it if you can.
Never weaken an enforcer to make it pass.`;

async function triageContext(w: Where, law: Law, lock: Lock, r: Reproof): Promise<string> {
  const since = await lastProven(w, law.hash);
  return [
    TRIAGE,
    `Current enforcers:\n${lock.get(law.hash)!.enforcers.map((e) => `- ${e.kind}: ${e.path}`).join("\n")}`,
    `What verdict found:\n${r.findings.map((f) => `- ${f.path}: ${f.result.status}: ${f.result.message}`).join("\n")}`,
    since ? `Last proven at commit ${since}; read what changed since: git log ${since}..HEAD, git diff ${since}.` : "",
  ].join("\n\n");
}

function logReproof(r: Reproof, log: (line: string) => void): void {
  log(`${r.outcome}: ${r.law.text}`);
  for (const f of r.findings) {
    if (f.result.status === "pass") continue;
    log(`  ${f.path}: ${f.result.status}`);
    for (const line of f.result.message.split("\n")) if (line) log(`    ${line}`);
  }
}

// Who owns which file in .verdict/ while laws are planned at the same time.
// A file belongs to the law whose lock entry names it, or to the planner that
// wrote it first in this run; a planner may write new files and its own.
export class Claims {
  private owner = new Map<string, string>();

  constructor(entries: { dir: string; lock: Lock }[] = []) {
    for (const { dir, lock } of entries) {
      for (const [hash, entry] of lock) for (const e of entry.enforcers) this.owner.set(join(dir, e.path), hash);
    }
  }

  for(hash: string): (abs: string) => string | null {
    return (abs) => {
      const owner = this.owner.get(abs);
      if (owner && owner !== hash) return `${abs} belongs to another law; pick another file name`;
      this.owner.set(abs, hash);
      return null;
    };
  }
}

export interface PlanOptions {
  limit?: Limit; // shared across VERDICT.md files; defaults to VERDICT_JOBS
  claims?: Claims;
  again?: (law: Law) => boolean; // re-plan these even if they're in sync
}

const AGAIN = `A person asked for this law to be planned again, though it is already
planned. Its current enforcers are listed below. Plan it afresh with what is
available now (for example, TLC may be installed where it wasn't before):
keep what is good, replace what a stronger enforcer would do better, and say
what you changed and why in suggestions. Never weaken an enforcer.`;

// Brings the lock in line with VERDICT.md and the code, like a package
// manager's sync: laws that are new or reworded get planned; planned laws get
// their breaks replayed on today's code, and the ones that drifted (a break no
// longer applies, or an enforcer can't see it) get re-planned, as do laws that
// passed when planned and fail now. A law that already failed when it was
// planned is reported, not re-planned: that is a known finding.
// Entries for removed laws are dropped.
//
// Laws run in parallel, up to the limit. Each law's results are logged as one
// block when it finishes; the lock is written after each law.
export async function plan(
  w: Where,
  lockFile: string,
  laws: Law[],
  lock: Lock,
  log: (line: string) => void,
  opts: PlanOptions = {},
): Promise<boolean> {
  const limit = opts.limit ?? makeLimit(jobs());
  const claims = opts.claims ?? new Claims([{ dir: w.dir, lock }]);
  let ok = true;
  let stopped = false;
  writeLock(lockFile, lock, laws);

  const one = async (law: Law) => {
    if (stopped) return;
    const lines: string[] = [];
    const say = (line: string) => lines.push(line);
    try {
      let context = "";
      if (lock.has(law.hash) && opts.again?.(law)) {
        const entry = lock.get(law.hash)!;
        context = `${AGAIN}\n\nCurrent enforcers:\n${entry.enforcers.map((e) => `- ${e.kind}: ${e.path}`).join("\n")}`;
        log(`planning again: ${law.text}`);
        say(`planned again: ${law.text}`);
      } else if (lock.has(law.hash)) {
        const r = await reproveLaw(w, law, lock);
        logReproof(r, say);
        if (r.outcome !== "drift" && r.outcome !== "newly failing") {
          // Nothing to re-plan; record what each enforcer was just proven against.
          if (JSON.stringify(r.pinned) !== JSON.stringify(lock.get(law.hash))) {
            lock.set(law.hash, r.pinned);
            writeLock(lockFile, lock, laws);
          }
          return;
        }
        context = await triageContext(w, law, lock, r);
        say(`  re-planning`);
      } else {
        log(`planning: ${law.text}`);
        say(`planned: ${law.text}`);
      }
      let outcome: PlanOutcome;
      try {
        outcome = await planLaw(w, law, context, claims.for(law.hash));
      } catch (err) {
        // e.g. not logged in: the same error would repeat for every law.
        say(`  error: ${err instanceof Error ? err.message : String(err)}`);
        stopped = true;
        ok = false;
        return;
      }
      logOutcome(outcome, say);
      if (!outcome.entry) {
        ok = false;
        return;
      }
      lock.set(law.hash, { ...outcome.entry, enforcers: outcome.entry.enforcers.map((e) => ({ ...e, inputs: inputsOf(w, e) })) });
      writeBreaks(w.dir, law.hash, outcome.breaks);
      writeLock(lockFile, lock, laws);
    } finally {
      if (lines.length) log(lines.join("\n"));
    }
  };

  await Promise.all(laws.map((law) => limit(() => one(law))));
  return ok;
}
