// Is each enforcer of a planned law still able to fail on today's code?
// A check can keep passing after the code it describes has moved, e.g. a rule
// scoped to src/money/ once the money code lives in src/billing/. That pass
// looks like a proof. `verdict plan` replays every stored break to find out.
import { describe, prove, readBreaks } from "./breaks.ts";
import { checkLaw } from "./check.ts";
import { withScratch } from "./scratch.ts";
import type { Law } from "./laws.ts";
import type { Lock } from "./lock.ts";
import type { Result } from "./result.ts";
import { isStale, staleReason, stampModels, STALE } from "./specbind.ts";

export type Outcome = "in sync" | "drift" | "fails today" | "blocked" | "not planned";

export interface Reproof {
  law: Law;
  outcome: Outcome;
  findings: { path: string; result: Result }[];
}

export async function reproveLaw(root: string, law: Law, lock: Lock): Promise<Reproof> {
  const entry = lock.get(law.hash);
  if (!entry) return { law, outcome: "not planned", findings: [] };
  // plan runs everything in a sandboxed scratch copy, even enforcers already in the lock.
  const today = await withScratch(root, (dir) => checkLaw(dir, entry, { readable: [root] }));
  const breaks = readBreaks(root, law.hash);
  const findings: Reproof["findings"] = [];
  let drift = false;
  let blocked = false;
  let realFail = false;
  let staleSpec = false; // while a spec is stale a failing test cannot say whether the code or the spec is wrong: triage decides
  for (const e of entry.enforcers) {
    const now = today.details.find((d) => d.path === e.path)?.result;
    if (!now) continue; // an LLM judge skipped because its decision model was sure
    if (now.status === "fail" && isStale(now.message)) {
      drift = true; // the spec's code moved: plan re-stamps it or re-plans the law
      staleSpec = true;
      findings.push({ path: e.path, result: now });
      continue;
    }
    if (now.status === "fail") {
      realFail = true;
      findings.push({ path: e.path, result: now });
      continue;
    }
    if (now.status === "inconclusive") {
      blocked = true;
      findings.push({ path: e.path, result: now });
      continue;
    }
    const brk = breaks.find((b) => b.enforcer === e.path);
    if (!brk) {
      drift = true;
      findings.push({ path: e.path, result: { status: "inconclusive", message: "passes, but has never been seen to fail (no break)" } });
      continue;
    }
    const proof = await prove(root, law.text, e, brk);
    if (proof.kind === "stale" || proof.kind === "missed") drift = true;
    if (proof.kind === "unknown") blocked = true;
    findings.push({ path: e.path, result: describe(proof) });
  }
  const outcome: Outcome =
    realFail && !staleSpec ? "fails today" : drift ? "drift" : blocked ? "blocked" : "in sync";
  return { law, outcome, findings };
}


// A spec whose modeled code changed is stale. If the law's other enforcers (the
// tests that replay the spec against the code) still pass on the new code, the
// spec still describes it: re-stamp the hash, no model needed. If they fail,
// leave it stale so reproveLaw reports drift and the law is re-planned.
export async function refreshSpecs(root: string, law: Law, lock: Lock, log: (line: string) => void): Promise<void> {
  const entry = lock.get(law.hash);
  if (!entry) return;
  const stale = entry.enforcers.filter((e) => {
    if (e.kind !== "tla") return false;
    const why = staleReason(root, e.path);
    return why !== null && why.startsWith(STALE) && !why.includes("no longer exists");
  });
  const others = entry.enforcers.filter((e) => e.kind !== "tla");
  if (stale.length === 0 || others.length === 0) return;
  const today = await withScratch(root, (dir) => checkLaw(dir, { ...entry, enforcers: others }, { readable: [root] }));
  if (today.status !== "pass") return;
  for (const e of stale) {
    stampModels(root, e.path);
    log(`  ${e.path}: the code it models changed, its tests still pass: re-stamped`);
  }
}
