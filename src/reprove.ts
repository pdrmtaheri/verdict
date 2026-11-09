// Is each enforcer of a planned law still able to fail on today's code?
// A check can keep passing after the code it describes has moved, e.g. a rule
// scoped to src/money/ once the money code lives in src/billing/. That pass
// looks like a proof. `verdict plan` replays every stored break to find out.
import { breakFor, describe, prove, readBreaks, type Proof } from "./breaks.ts";
import { checkLaw } from "./check.ts";
import type { Law } from "./laws.ts";
import { enforcerId, type Lock, type LockEntry } from "./lock.ts";
import { inputsOf } from "./pins.ts";
import { inconclusive, type Result } from "./result.ts";
import { withScratch } from "./scratch.ts";
import { isStale, STALE, staleReason, stampModels } from "./specbind.ts";
import { inCopy, type Where } from "./where.ts";

// "fails today": it failed when it was planned too (no break), a known finding.
// "newly failing": it passed when planned (it has a break) and fails now: a
// regression, or an enforcer that depended on something incidental.
export type Outcome = "in sync" | "drift" | "newly failing" | "fails today" | "blocked" | "not planned";

export interface Reproof {
  law: Law;
  outcome: Outcome;
  findings: { path: string; result: Result }[];
  // The lock entry with each enforcer's inputs recorded as they are now,
  // for the enforcers this re-proof settled (caught its break, or fails).
  pinned: LockEntry;
}

// What re-proving found for one enforcer, in the order outcomeOf weighs them.
type Tag = "stale spec" | "regression" | "known fail" | "drift" | "blocked" | "proven";

// The law's outcome from its enforcers' tags. A failing enforcer decides it,
// unless a spec is stale: then a failing test can't say whether the code or
// the spec is wrong, so it's drift and triage decides.
export function outcomeOf(tags: Tag[]): Outcome {
  const has = (t: Tag) => tags.includes(t);
  if ((has("regression") || has("known fail")) && !has("stale spec")) return has("regression") ? "newly failing" : "fails today";
  if (has("stale spec") || has("drift")) return "drift";
  if (has("blocked")) return "blocked";
  return "in sync";
}

// Runs a law's enforcers the way plan runs everything, even enforcers already
// in the lock: in a sandboxed scratch copy, without replaying breaks.
const checkInScratch = (w: Where, entry: LockEntry) =>
  withScratch(w.repo, (copy) => checkLaw(inCopy(w, copy), entry, { sandbox: { readable: [w.repo] }, replay: false }));

export async function reproveLaw(w: Where, law: Law, lock: Lock): Promise<Reproof> {
  const entry = lock.get(law.hash);
  if (!entry) return { law, outcome: "not planned", findings: [], pinned: { law: law.text, enforcers: [] } };
  const today = await checkInScratch(w, entry);
  const breaks = readBreaks(w.dir, law.hash);
  const findings: Reproof["findings"] = [];
  const tags: Tag[] = [];
  const found = (tag: Tag, path: string, result: Result) => {
    tags.push(tag);
    findings.push({ path, result });
  };
  for (const e of entry.enforcers) {
    const id = enforcerId(e);
    const now = today.details.find((d) => d.id === id)?.result;
    if (!now) continue; // an LLM judge skipped because its decision model was sure
    const brk = breakFor(breaks, e, entry.enforcers);
    if (now.status === "fail") {
      // A stale spec's code moved: plan re-stamps it or re-plans the law.
      found(isStale(now.message) ? "stale spec" : brk ? "regression" : "known fail", id, now);
      continue;
    }
    if (now.status === "inconclusive") {
      found("blocked", id, now);
      continue;
    }
    if (!brk) {
      found("drift", id, inconclusive("passes, but has never been seen to fail (no break)"));
      continue;
    }
    const proof = await prove(w, law.text, e, brk);
    found(PROOF_TAG[proof.kind], id, describe(proof));
  }
  const settled = (id: string) => findings.find((f) => f.path === id)?.result.status !== "inconclusive";
  const pinned = { ...entry, enforcers: entry.enforcers.map((e) => (settled(enforcerId(e)) ? { ...e, inputs: inputsOf(w, e) } : e)) };
  return { law, outcome: outcomeOf(tags), findings, pinned };
}

const PROOF_TAG: Record<Proof["kind"], Tag> = { caught: "proven", missed: "drift", stale: "drift", unknown: "blocked" };

// A spec whose modeled code changed is stale. If the law's other enforcers (the
// tests that replay the spec against the code) still pass on the new code, the
// spec still describes it: re-stamp the hash, no model needed. If they fail,
// leave it stale so reproveLaw reports drift and the law is re-planned.
export async function refreshSpecs(w: Where, law: Law, lock: Lock, log: (line: string) => void): Promise<void> {
  const entry = lock.get(law.hash);
  if (!entry) return;
  const stale = entry.enforcers.filter((e) => {
    if (e.kind !== "tla") return false;
    const why = staleReason(w.dir, e.path);
    return why !== null && why.startsWith(STALE) && !why.includes("no longer exists");
  });
  const others = entry.enforcers.filter((e) => e.kind !== "tla");
  if (stale.length === 0 || others.length === 0) return;
  const today = await checkInScratch(w, { ...entry, enforcers: others });
  if (today.status !== "pass") return;
  for (const e of stale) {
    stampModels(w.dir, e.path);
    log(`  ${e.path}: the code it models changed, its tests still pass: re-stamped`);
  }
}
