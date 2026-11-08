// What the page shows per law: its text, status, and enforcers, joining
// VERDICT.md, the lock, the latest check report and the recorded breaks.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readBreaks } from "../breaks.ts";
import type { LawReport } from "../check.ts";
import { scopeOf } from "../enforcers.ts";
import { parseLaws } from "../laws.ts";
import { readLock } from "../lock.ts";
import { explain, type Explained } from "./explain.ts";

export interface EnforcerView {
  kind: string;
  path: string;
  status: "pass" | "fail" | "inconclusive" | null; // null: not run yet
  message: string;
  why: Explained | null; // the message in plain words, for a failure or an inconclusive result
  scope: string | null;
}

export interface LawView {
  text: string;
  hash: string;
  // unplanned: not in the lock. unchecked: planned, no check run since the page opened.
  status: "pass" | "fail" | "inconclusive" | "unplanned" | "unchecked";
  enforcers: EnforcerView[];
  proof: string | null; // the break that proved the first enforcer can fail
}

export function lawViews(root: string, last: LawReport[] | null): LawView[] {
  const lawsFile = join(root, "VERDICT.md");
  const laws = parseLaws(existsSync(lawsFile) ? readFileSync(lawsFile, "utf8") : "");
  const lock = readLock(join(root, "VERDICT.lock"));
  return laws.map((law) => {
    const entry = lock.get(law.hash);
    const report = last?.find((r) => r.law === law.text);
    let proof: string | null = null;
    try {
      proof = readBreaks(root, law.hash)[0]?.description ?? null;
    } catch {
      // a malformed breaks file is plan's problem, not the page's
    }
    if (report && report.status !== "unplanned") {
      return {
        ...law,
        status: report.status,
        proof,
        enforcers: report.details.map((d) => ({
          kind: d.kind,
          path: d.path,
          status: d.result.status,
          message: d.result.message,
          why: d.result.status === "pass" ? null : explain(d.kind, d.result.status, d.result.message),
          scope: d.scope,
        })),
      };
    }
    if (!entry) return { ...law, status: "unplanned" as const, proof: null, enforcers: [] };
    return {
      ...law,
      status: "unchecked" as const,
      proof,
      enforcers: entry.enforcers.map((e) => ({ kind: e.kind, path: e.path, status: null, message: "", why: null, scope: scopeOf(root, e.path) })),
    };
  });
}

// One line per version for the switcher: how many laws pass, fail or are inconclusive.
export function tally(report: LawReport[] | null): { pass: number; fail: number; inconclusive: number; total: number } | null {
  if (!report) return null;
  const n = (s: string) => report.filter((r) => r.status === s).length;
  return { pass: n("pass"), fail: n("fail"), inconclusive: n("inconclusive"), total: report.length };
}
