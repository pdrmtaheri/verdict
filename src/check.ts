import { runEnforcer, scopeOf } from "./enforcers.ts";
import type { Law } from "./laws.ts";
import type { Lock, LockEntry } from "./lock.ts";
import type { Where } from "./where.ts";
import { combine, type Result, type Status } from "./result.ts";

export interface LawReport {
  law: string;
  status: Status | "unplanned";
  details: { kind: string; path: string; result: Result; scope: string | null }[];
}

// Runs a law's enforcers. An LLM judge next to a decision model is its
// fallback: it runs only when the decision model is inconclusive.
export async function checkLaw(w: Where, entry: LockEntry, sandbox?: { readable: string[] }): Promise<LawReport> {
  const details: LawReport["details"] = [];
  const run = async (kind: string, path: string) => {
    const result = await runEnforcer(kind, { root: w.dir, repo: w.repo, law: entry.law, path, sandbox });
    details.push({ kind, path, result, scope: scopeOf(w.dir, path) });
    return result;
  };

  const judges = entry.enforcers.filter((e) => e.kind === "llm");
  const others = entry.enforcers.filter((e) => e.kind !== "llm");
  for (const e of others) await run(e.kind, e.path);

  const decisions = details.filter((d) => d.kind === "decision");
  const needJudge = decisions.length === 0 || decisions.some((d) => d.result.status === "inconclusive");
  if (judges.length > 0 && needJudge) {
    // The judge's answer replaces the inconclusive decisions.
    for (const d of decisions) if (d.result.status === "inconclusive") details.splice(details.indexOf(d), 1);
    for (const e of judges) await run(e.kind, e.path);
  }
  return { law: entry.law, status: combine(details.map((d) => d.result)), details };
}

export async function check(w: Where, laws: Law[], lock: Lock): Promise<LawReport[]> {
  return Promise.all(
    laws.map((law) => {
      const entry = lock.get(law.hash);
      if (!entry) return { law: law.text, status: "unplanned" as const, details: [] };
      return checkLaw(w, entry);
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
    }
  }
  if (summary) out.push("", summarize(reports));
  return out.join("\n");
}

export function summarize(reports: LawReport[]): string {
  const count = (s: LawReport["status"]) => reports.filter((r) => r.status === s).length;
  return `${count("pass")} pass, ${count("fail")} fail, ${count("inconclusive")} inconclusive, ${count("unplanned")} not planned`;
}

export function exitCode(reports: LawReport[]): number {
  return reports.some((r) => r.status === "fail" || r.status === "unplanned") ? 1 : 0;
}
