import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { defineTool, runAgent } from "./agent.ts";
import { Break, breakFor, breaksFile, Edit, prove, runInScratch, writeBreaks } from "./breaks.ts";
import { KINDS, vet } from "./enforcers.ts";
import { exec } from "./exec.ts";
import { errorMessage, findBin } from "./fsx.ts";
import { ruleFiles } from "./init.ts";
import type { Law } from "./laws.ts";
import { jobs, makeLimit, type Limit } from "./limit.ts";
import { enforcerId, writeLock, type Enforcer, type Lock, type LockEntry } from "./lock.ts";
import { decisionModelsAvailable } from "./models.ts";
import { inputsOf } from "./pins.ts";
import AGAIN from "./prompts/again.md" with { type: "text" };
import PLANNER from "./prompts/plan.md" with { type: "text" };
import TRIAGE from "./prompts/triage.md" with { type: "text" };
import { refreshSpecs, reproveLaw, type Reproof } from "./reprove.ts";
import type { Result } from "./result.ts";
import type { Laws } from "./sets.ts";
import { stampModels } from "./specbind.ts";
import { readTools, writeTools } from "./tools.ts";
import { label, OUT_DIR, type Where } from "./where.ts";

// The planner's system prompt (src/prompts/plan.md).
export const SYSTEM = PLANNER;

const PROBE = ["semgrep", "eslint", "oxlint", "ruff", "golangci-lint", "clippy-driver", "mypy", "pyright", "tlc", "java", "go", "python3", "pytest", "cargo", "bun", "node"];

const EnforcerRef = z.object({
  kind: z.enum(KINDS),
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
  const reject = (problem: string) => ({ problem, notes });
  let failsToday = false;
  for (const e of sub.enforcers) {
    const problem = vet(w, e, sub.enforcers);
    if (problem) return reject(problem);
    if (e.kind === "tla") stampModels(w.dir, e.path);
    const id = enforcerId(e);
    const today = await runInScratch(w, law.text, e);
    if (today.status === "fail") {
      failsToday = true;
      notes.push(`${id} fails on today's code: see the finding below`);
      continue;
    }
    if (today.status === "inconclusive") {
      notes.push(`${id} is inconclusive today, so it is unproven (${firstLine(today.message)}): fix that, then run \`verdict plan --again ${law.hash}\` to prove it`);
      continue;
    }
    if (sub.enforcers.filter((o) => enforcerId(o) === id).length > 1) return reject(`${id} is listed twice: give each enforcer a different path, rule or test name`);
    const brk = breakFor(sub.breaks, e, sub.enforcers);
    if (!brk) return reject(`${id} passes today; submit a break with enforcer "${id}" that makes it fail`);
    const proof = await prove(w, law.text, e, brk);
    if (proof.kind === "missed") return reject(`${id} still passes with the break "${brk.description}". Make the enforcer see it, or pick a break that really violates the law.`);
    if (proof.kind === "stale") return reject(`the break for ${id} doesn't apply: ${proof.reason}`);
    if (proof.kind === "unknown") notes.push(`${id} was inconclusive on its break, so it is unproven (${firstLine(proof.result.message)}): fix that, then run \`verdict plan --again ${law.hash}\``);
    else notes.push(`${id} caught its break: ${brk.description}`);
  }
  if (failsToday && !sub.finding) return reject("the law fails on today's code; describe the counterexample in finding");
  return { problem: null, notes };
}

const firstLine = (text: string): string => text.split("\n")[0] ?? "";

const TRIAL = { caught: "caught", missed: "missed: the enforcer passed", unknown: "inconclusive" } as const;

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
        const p = await prove(w, law.text, enforcer, { enforcer: enforcerId(enforcer), description: "trial", edits });
        if (p.kind === "stale") return `the edits don't apply: ${p.reason}`;
        return `${TRIAL[p.kind]} (${show(p.result)})`;
      },
    }),
  };
}

export async function planLaw(w: Where, law: Law, context = "", claim?: (abs: string) => string | null): Promise<PlanOutcome> {
  const installed = PROBE.filter((t) => findBin(w.dir, t));
  const jar = process.env.VERDICT_TLA2TOOLS;
  if (jar && existsSync(jar) && !installed.includes("tlc")) installed.push("tlc (tla2tools.jar via VERDICT_TLA2TOOLS)");
  // A decision enforcer runs only with a key; without one it's always inconclusive.
  installed.push(decisionModelsAvailable() ? "decision models (TYPESAFE_AI_API_KEY is set)" : "no decision models (TYPESAFE_AI_API_KEY isn't set: use an llm judge instead)");
  const where =
    w.dir === w.repo
      ? "The law is declared in VERDICT.md at the repo root and applies to the whole repo."
      : `The law is declared in ${label(w)}/VERDICT.md and applies to that directory's subtree only. ` +
        `Paths are relative to ${label(w)}/; ../ reaches the rest of the repo for context. ` +
        `Write enforcers in ${label(w)}/${OUT_DIR}/ and scope them to that subtree.`;
  const rules = [...new Set([...ruleFiles(w.repo).map((f) => relative(w.dir, join(w.repo, f))), ...ruleFiles(w.dir)])];
  const guides = rules.length > 0
    ? `\n\nThe project's own rules for people and agents, worth reading for context (they are not laws): ${rules.join(", ")}`
    : "";
  let notes: string[] = [];
  const submission = await runAgent({
    system: PLANNER,
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
    breaks: submission.breaks.filter((b) => submission.enforcers.some((e) => breakFor([b], e, submission.enforcers))),
    finding: submission.finding,
    notes,
    suggestions: submission.suggestions,
  };
}

export function logOutcome(o: PlanOutcome, log: (line: string) => void): void {
  if (!o.entry) return log(`  error: ${o.error}`);
  for (const e of o.entry.enforcers) log(`  ${e.kind}: ${e.path}`);
  for (const n of o.notes) log(`  ${n}`);
  if (o.finding) {
    log(`  finding: the law looks false in today's code:\n${o.finding.replaceAll(/^/gm, "    ")}`);
    log("  verdict check fails this law until the code is fixed; if the law changed on purpose, edit it in VERDICT.md and run `verdict plan`");
  }
  for (const s of o.suggestions) log(`  suggestion: ${s}`);
}

// The commit at which a law's enforcers were last proven, read from git
// rather than stored: the last commit that touched its breaks file.
async function lastProven(w: Where, hash: string): Promise<string | null> {
  const r = await exec(["git", "log", "-1", "--format=%h", "--", breaksFile(w.dir, hash)], { cwd: w.dir });
  return r.code === 0 && r.output ? r.output : null;
}

const listEnforcers = (enforcers: Enforcer[]): string => enforcers.map((e) => `- ${e.kind}: ${e.path}`).join("\n");

async function triageContext(w: Where, law: Law, lock: Lock, r: Reproof): Promise<string> {
  const since = await lastProven(w, law.hash);
  return [
    TRIAGE,
    `Current enforcers:\n${listEnforcers(lock.get(law.hash)?.enforcers ?? [])}`,
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
export async function plan(set: Laws & { lockFile: string }, log: (line: string) => void, opts: PlanOptions = {}): Promise<boolean> {
  const { lockFile, laws, lock } = set;
  const w: Where = set;
  const limit = opts.limit ?? makeLimit(jobs());
  const claims = opts.claims ?? new Claims([set]);
  let ok = true;
  let stopped = false;
  writeLock(lockFile, lock, laws);

  const one = async (law: Law) => {
    if (stopped) return;
    const lines: string[] = [];
    const say = (line: string) => lines.push(line);
    try {
      let context = "";
      const entry = lock.get(law.hash);
      if (entry && opts.again?.(law)) {
        context = `${AGAIN}\n\nCurrent enforcers:\n${listEnforcers(entry.enforcers)}`;
        log(`planning again: ${law.text}`);
        say(`planned again: ${law.text}`);
      } else if (entry) {
        await refreshSpecs(w, law, lock, say);
        const r = await reproveLaw(w, law, lock);
        logReproof(r, say);
        if (r.outcome !== "drift" && r.outcome !== "newly failing") {
          // Nothing to re-plan; record what each enforcer was just proven against.
          if (JSON.stringify(r.pinned) !== JSON.stringify(entry)) {
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
        say(`  error: ${errorMessage(err)}`);
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
      if (lines.length > 0) log(lines.join("\n"));
    }
  };

  await Promise.all(laws.map((law) => limit(() => one(law))));
  return ok;
}
