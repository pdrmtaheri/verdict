import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, runAgent } from "./agent.ts";
import { Break, breaksFile, Edit, prove, runInScratch, writeBreaks } from "./breaks.ts";
import { KINDS, scopeOf, SKIPPED } from "./enforcers.ts";
import { exec, which } from "./exec.ts";
import type { Law } from "./laws.ts";
import { writeLock, type Enforcer, type Lock, type LockEntry } from "./lock.ts";
import type { Result } from "./result.ts";
import { refreshSpecs, reproveLaw, type Reproof } from "./reprove.ts";
import { modelsOf, stampModels } from "./specbind.ts";
import { inside, readTools, writeTools } from "./tools.ts";

export const OUT_DIR = ".verdict";

const PROBE = ["semgrep", "eslint", "ruff", "golangci-lint", "clippy-driver", "mypy", "pyright", "tlc", "java", "go", "python3", "pytest", "cargo", "bun", "node"];

const SYSTEM = `You plan how to enforce one law about a software repository. A law is
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
- Match the kind to what the law is about. A test is not the default.
  - A banned call, import or pattern, or a naming or layering rule: semgrep,
    never a test that greps the source.
  - An invariant over states or orderings (never both, always eventually, no
    lost update) that is worth proving: tla, with a test generated from it.
  - Behaviour you can observe by running the code: test.
  - Something readable rather than mechanical (copy, docs, error messages,
    accessibility): llm, and decision when a command can print the text.
  When a law has a readable side as well as a mechanical one (a page that must
  say something in words, an error message that must tell the user what to do),
  ship an llm judge next to the test: the test checks the mechanism, the judge
  checks that a person would find it readable.
  Before you settle on a test alone, say in suggestions which other kinds you
  considered and why they don't fit.
- Use the repo's own tooling when it is robust. Look at its config and
  dependencies first. If the right tool for the law is not installed, still
  write that enforcer and submit it: verdict records it as unproven and reports
  it inconclusive until the tool is installed. Do not swap it for a test. Pair
  it with a test that checks the same law in the repo's own framework, so the
  law is covered meanwhile, and name the tool to install in suggestions.
- Cover every way the law can be broken, not the convenient one: every entry
  point a user has (UI, CLI, API), every code path that writes the guarded state.
- Keep each enforcer cheap to rerun: seconds, a few minutes at most. Choose
  bounds (model depth, input sizes) to fit.
- Name files ${OUT_DIR}/<short-slug>.<ext>.

Where the code is
- The code under check is not always the repo root: verdict can run the same
  enforcer against another folder of code (a version of the system). It tells
  the enforcer where through the environment variable VERDICT_TARGET, an
  absolute path. In a test or script, read the code from there, and fall back to
  the repo root only when it is unset, for example in a .verdict/ test:
  const target = process.env.VERDICT_TARGET ?? path.join(__dirname, "..");
  then require(path.join(target, "src/x.js")) or read files under target.
  Never find the code relative to the enforcer's own file only. Semgrep rules
  need nothing: verdict scans the target folder, so paths in a rule are relative
  to it. Your enforcers must not write into the target; write temp files to the
  OS temp directory. When VERDICT_EXCLUDE is set it lists paths inside the target
  (separated by ":") that are not part of the code under check; skip them if you
  walk the tree.

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
  one action in the spec. A spec only proves the design, so submit it together
  with a test generated from it: walk the spec's behaviours (bounded depth) and
  replay each one against the real system through an adapter that maps spec
  actions to public calls.
  Bind the spec to the code it models: add a comment line per file, written
  "models: <path>" (for example "\\* models: public/controller.js"). verdict
  stamps each file's hash into that line. A spec whose files changed fails with
  "the code this spec models changed" until \`verdict plan\` re-stamps it, so the
  break for the spec is the same code edit the replay test catches: any edit to
  a modeled file fails the spec, and the replay test says whether the code
  still conforms. Name only the files the spec really describes; every edit to
  them makes the spec stale.
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

const EnforcerRef = z.object({ kind: z.enum(KINDS as [string, ...string[]]), path: z.string() });

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
export async function validate(root: string, law: Law, sub: Submission): Promise<{ problem: string | null; notes: string[] }> {
  const notes: string[] = [];
  let failsToday = false;
  for (const e of sub.enforcers) {
    try {
      inside(root, e.path, join(root, OUT_DIR));
    } catch (err) {
      return { problem: (err as Error).message, notes };
    }
    if (!existsSync(join(root, e.path))) return { problem: `${e.path} was not written`, notes };
    if (!scopeOf(root, e.path)) return { problem: `${e.path} has no "scope:" line`, notes };
    if (e.kind === "tla") {
      const models = modelsOf(readFileSync(join(root, e.path), "utf8"));
      if (models.length === 0) return { problem: `${e.path} must name the code it models: add a comment line "models: <file>" for each file the spec describes. verdict stamps their hash, so a spec whose code changed fails, and a break to that code makes it fail`, notes };
      const bad = models.find((m) => m.file.startsWith(OUT_DIR) || !existsSync(join(root, m.file)));
      if (bad) return { problem: `${e.path} says it models ${bad.file}, which is not a file of the system under check`, notes };
      if (!sub.enforcers.some((x) => x.kind !== "tla")) return { problem: `a spec only proves the design: submit a test that replays ${e.path} against the real code alongside it`, notes };
      stampModels(root, e.path);
    }
    const today = await runInScratch(root, law.text, e);
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
    const proof = await prove(root, law.text, e, brk);
    if (proof.kind === "missed") return { problem: `${e.path} still passes with the break "${brk.description}". Make the enforcer see it, or pick a break that really violates the law.`, notes };
    if (proof.kind === "stale") return { problem: `the break for ${e.path} doesn't apply: ${proof.reason}`, notes };
    if (proof.kind === "unknown") notes.push(`${e.path} was inconclusive on its break (${proof.result.message.split("\n")[0]})`);
    else notes.push(`${e.path} caught its break: ${brk.description}`);
  }
  if (failsToday && !sub.finding) return { problem: "the law fails on today's code; describe the counterexample in finding", notes };
  return { problem: null, notes };
}

function planTools(root: string, law: Law) {
  return {
    run_enforcer: defineTool({
      description: "Run one enforcer on a sandboxed scratch copy of the repo, the way verdict validates your plan.",
      schema: EnforcerRef,
      execute: async (e) => show(await runInScratch(root, law.text, e)),
    }),
    try_break: defineTool({
      description: "Apply edits to a scratch copy of the repo and run one enforcer there. The repo is never changed.",
      schema: z.object({ enforcer: EnforcerRef, edits: z.array(Edit).min(1) }),
      execute: async ({ enforcer, edits }) => {
        const p = await prove(root, law.text, enforcer, { enforcer: enforcer.path, description: "trial", edits });
        if (p.kind === "stale") return `the edits don't apply: ${p.reason}`;
        return `${p.kind === "caught" ? "caught" : p.kind === "missed" ? "missed: the enforcer passed" : "inconclusive"} (${show(p.result)})`;
      },
    }),
  };
}

export async function planLaw(root: string, law: Law, context = ""): Promise<PlanOutcome> {
  // TLC counts as installed when VERDICT_TLA2TOOLS names tla2tools.jar and Java is there.
  const jar = process.env.VERDICT_TLA2TOOLS;
  const installed = PROBE.filter((t) => which(root, t) || (t === "tlc" && jar && which(root, "java")));
  let notes: string[] = [];
  const submission = await runAgent({
    system: SYSTEM,
    prompt: `Law: ${law.text}\n\nInstalled tools: ${installed.join(", ") || "none"}${jar && installed.includes("tlc") && !which(root, "tlc") ? `\n(tlc is not a command here: run TLC as java -Djava.io.tmpdir=. -cp ${jar} tlc2.TLC, from the repo root; the tmpdir flag lets it unpack its standard modules inside the sandbox)` : ""}${context ? `\n\n${context}` : ""}`,
    tools: { ...readTools(root), ...writeTools(root, join(root, OUT_DIR)), ...planTools(root, law) },
    cwd: root,
    submit: {
      description: "Submit the enforcers for this law, with a break for each one that passes today.",
      schema: Submission,
      validate: async (sub) => {
        const v = await validate(root, law, sub);
        notes = v.notes;
        return v.problem;
      },
    },
    maxSteps: 100,
    reasoning: "high",
  });
  if (!submission) return { law, breaks: [], notes, suggestions: [], error: "the planner did not submit a plan that verdict could accept" };
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
async function lastProven(root: string, hash: string): Promise<string | null> {
  const r = await exec(["git", "log", "-1", "--format=%h", "--", breaksFile(root, hash)], { cwd: root });
  return r.code === 0 && r.output ? r.output : null;
}

const TRIAGE = `This law is already planned, but an enforcer can no longer be shown to
fail on today's code: its break no longer applies, or the enforcer passes on
code broken on purpose. The current enforcers are listed below; read them, and
read the code as it is now. Decide which of these happened, and say which in
suggestions:
- The enforcer no longer describes the code (a function moved, a step split, a
  new path writes the guarded state). Update the enforcer and its break from the
  code, not from what makes it pass. Keep its bounds unless the change makes
  them wrong; if you shrink a bound, say so.
- The promise changed on purpose, and evidence says so (a commit message, docs,
  tests, a changelog). Don't change what the enforcer checks; cite the evidence
  and suggest that a person edit the law in VERDICT.md.
- The code breaks the law. Keep the enforcer failing and put the counterexample
  in finding, naming the commit that introduced it if you can find it.
Never weaken an enforcer to make it pass.`;

async function triageContext(root: string, law: Law, lock: Lock, r: Reproof): Promise<string> {
  const since = await lastProven(root, law.hash);
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

// Brings the lock in line with VERDICT.md and the code, like a package
// manager's sync: laws that are new or reworded get planned; planned laws get
// their breaks replayed on today's code, and the ones that drifted (a break no
// longer applies, or an enforcer can't see it) get re-planned. Laws that fail
// today are reported, not re-planned: that is a finding, not drift.
// Entries for removed laws are dropped.
export async function plan(
  root: string,
  lockFile: string,
  laws: Law[],
  lock: Lock,
  log: (line: string) => void,
): Promise<boolean> {
  let ok = true;
  writeLock(lockFile, lock, laws);
  for (const law of laws) {
    let context = "";
    if (lock.has(law.hash)) {
      await refreshSpecs(root, law, lock, log);
      const r = await reproveLaw(root, law, lock);
      logReproof(r, log);
      if (r.outcome !== "drift") continue;
      context = await triageContext(root, law, lock, r);
      log(`  re-planning`);
    } else {
      log(`planning: ${law.text}`);
    }
    let outcome: PlanOutcome;
    try {
      outcome = await planLaw(root, law, context);
    } catch (err) {
      // e.g. a missing API key: the same error would repeat for every law.
      log(`  error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    logOutcome(outcome, log);
    if (!outcome.entry) {
      ok = false;
      continue;
    }
    lock.set(law.hash, outcome.entry);
    writeBreaks(root, law.hash, outcome.breaks);
    writeLock(lockFile, lock, laws);
  }
  return ok;
}
