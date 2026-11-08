import { describe, prove, readBreaks, stale } from "./breaks.ts";
import { runEnforcer, scopeOf } from "./enforcers.ts";
import { changes, inputsOf } from "./pins.ts";
import type { Law } from "./laws.ts";
import type { Enforcer, Lock, LockEntry } from "./lock.ts";
import type { Where } from "./where.ts";
import { jobs, makeLimit, type Limit } from "./limit.ts";
import { combine, fail, inconclusive, type Result, type Status } from "./result.ts";
import type { Break } from "./breaks.ts";

export interface LawReport {
  law: string;
  status: Status | "unplanned";
  // warnings: what changed since the enforcer was proven, and what verdict
  // did about it. They don't change the status on their own.
  details: { kind: string; path: string; result: Result; scope: string | null; warnings: string[] }[];
}

export interface CheckOptions {
  sandbox?: { readable: string[] };
  // Replay the break of an enforcer that passes but whose inputs changed
  // since it was proven (default). `plan` replays every break itself.
  replay?: boolean;
  hash?: string; // the law's hash, to find its breaks
}

// Runs a law's enforcers. An LLM judge next to a decision model is its
// fallback: it runs only when the decision model is inconclusive.
export async function checkLaw(w: Where, entry: LockEntry, opts: CheckOptions = {}): Promise<LawReport> {
  const details: LawReport["details"] = [];
  const breaks = opts.hash ? readBreaks(w.dir, opts.hash) : [];
  const run = async (e: Enforcer) => {
    let result = await runEnforcer(e.kind, { root: w.dir, repo: w.repo, law: entry.law, path: e.path, name: e.name, rule: e.rule, scope: e.scope, sandbox: opts.sandbox });
    const warnings: string[] = [...(result.warnings ?? [])];
    if (opts.replay !== false && result.status === "pass") result = await guard(w, entry.law, e, breaks, result, warnings);
    details.push({ kind: e.kind, path: e.path, result, scope: e.scope ?? scopeOf(w.dir, e.path), warnings });
    return result;
  };

  const judges = entry.enforcers.filter((e) => e.kind === "llm");
  const others = entry.enforcers.filter((e) => e.kind !== "llm");
  for (const e of others) await run(e);

  const decisions = details.filter((d) => d.kind === "decision");
  const needJudge = decisions.length === 0 || decisions.some((d) => d.result.status === "inconclusive");
  if (judges.length > 0 && needJudge) {
    // The judge's answer replaces the inconclusive decisions.
    for (const d of decisions) if (d.result.status === "inconclusive") details.splice(details.indexOf(d), 1);
    for (const e of judges) await run(e);
  }
  return { law: entry.law, status: combine(details.map((d) => d.result)), details };
}

// A pass counts only while the enforcer is still the one that was seen to
// fail. Warns about what changed; when its inputs changed, replays its break
// on a scratch copy and fails the enforcer if the break now passes.
async function guard(w: Where, law: string, e: Enforcer, breaks: Break[], result: Result, warnings: string[]): Promise<Result> {
  const brk = breaks.find((b) => b.enforcer === e.path);
  if (!brk) {
    warnings.push("passes, but has never been seen to fail (it failed when it was planned, so it has no break): run `verdict plan` to prove it");
    return result;
  }
  const why = stale(w, brk);
  if (why) warnings.push(`its break no longer applies (${why}), so this pass is unproven: run \`verdict plan\``);
  if (!e.inputs) {
    warnings.push("the lock doesn't record what it was proven against: run `verdict plan` to record it");
    return result;
  }
  const changed = changes(e.inputs, inputsOf(w, e));
  if (changed.length === 0) return result;
  warnings.push(`changed since it was proven: ${changed.join("; ")}`);
  if (why) return inconclusive(`changed since it was proven, and its break no longer applies, so verdict can't replay it: run \`verdict plan\``);
  const proof = await prove(w, law, e, brk);
  if (proof.kind === "caught") {
    warnings.push(`replayed its break ("${brk.description}"): still caught. Run \`verdict plan\` to record the new inputs`);
    return result;
  }
  if (proof.kind === "missed") {
    return fail(
      `changed since it was proven (${changed.join("; ")}), and it now passes on code broken on purpose ("${brk.description}"): ` +
        "it can no longer see the violation. Undo the change, or run `verdict plan` to re-plan the law",
    );
  }
  return inconclusive(`changed since it was proven, and replaying its break was inconclusive: ${describe(proof).message}`);
}

// Laws run in parallel, up to the limit (VERDICT_JOBS); results keep VERDICT.md's order.
export async function check(w: Where, laws: Law[], lock: Lock, limit: Limit = makeLimit(jobs())): Promise<LawReport[]> {
  return Promise.all(
    laws.map((law) => {
      const entry = lock.get(law.hash);
      // An entry with no enforcers checks nothing, so the law isn't planned.
      if (!entry || entry.enforcers.length === 0) return { law: law.text, status: "unplanned" as const, details: [] };
      return limit(() => checkLaw(w, entry, { hash: law.hash }));
    }),
  );
}

const LABEL: Record<LawReport["status"], string> = {
  pass: "PASS        ",
  fail: "FAIL        ",
  inconclusive: "INCONCLUSIVE",
  unplanned: "NOT PLANNED ",
};

export function format(reports: LawReport[], summary = true): string {
  const out: string[] = [];
  for (const r of reports) {
    out.push(`${LABEL[r.status]}  ${r.law}`);
    if (r.status === "unplanned") out.push(`              run \`verdict plan\` (new law, or its wording changed)`);
    for (const d of r.details) {
      const scope = d.scope ? ` (scope: ${d.scope})` : "";
      out.push(`              ${d.kind} ${d.path}: ${d.result.status}${d.result.status === "pass" ? scope : ""}`);
      for (const line of d.result.message.split("\n")) if (line) out.push(`                ${line}`);
      for (const w of d.warnings) out.push(`                warning: ${w}`);
    }
  }
  if (summary) out.push("", summarize(reports));
  return out.join("\n");
}

export function summarize(reports: LawReport[]): string {
  const count = (s: LawReport["status"]) => reports.filter((r) => r.status === s).length;
  const warnings = reports.reduce((n, r) => n + r.details.reduce((m, d) => m + d.warnings.length, 0), 0);
  const warned = warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : "";
  return `${count("pass")} pass, ${count("fail")} fail, ${count("inconclusive")} inconclusive, ${count("unplanned")} not planned${warned}`;
}

export function exitCode(reports: LawReport[]): number {
  return reports.some((r) => r.status === "fail" || r.status === "unplanned") ? 1 : 0;
}
