// Is each enforcer of a planned law still able to fail on today's code?
// A check can keep passing after the code it describes has moved, e.g. a rule
// scoped to src/money/ once the money code lives in src/billing/. That pass
// looks like a proof. `verdict plan` replays every stored break to find out.
import { breakFor, describe, prove, readBreaks } from "./breaks.ts";
import { checkLaw } from "./check.ts";
import { withScratch } from "./scratch.ts";
import { inCopy, type Where } from "./where.ts";
import type { Law } from "./laws.ts";
import { enforcerId, type Lock, type LockEntry } from "./lock.ts";
import { inputsOf } from "./pins.ts";
import type { Result } from "./result.ts";

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

export async function reproveLaw(w: Where, law: Law, lock: Lock): Promise<Reproof> {
  const entry = lock.get(law.hash);
  if (!entry) return { law, outcome: "not planned", findings: [], pinned: { law: law.text, enforcers: [] } };
  // plan runs everything in a sandboxed scratch copy, even enforcers already in the lock.
  const today = await withScratch(w.repo, (copy) => checkLaw(inCopy(w, copy), entry, { sandbox: { readable: [w.repo] }, replay: false }));
  const breaks = readBreaks(w.dir, law.hash);
  const findings: Reproof["findings"] = [];
  let drift = false;
  let newlyFailing = false;
  let blocked = false;
  for (const e of entry.enforcers) {
    const id = enforcerId(e);
    const now = today.details.find((d) => d.id === id)?.result;
    if (!now) continue; // an LLM judge skipped because its decision model was sure
    if (now.status === "fail") {
      if (breakFor(breaks, e, entry.enforcers)) newlyFailing = true;
      findings.push({ path: id, result: now });
      continue;
    }
    if (now.status === "inconclusive") {
      blocked = true;
      findings.push({ path: id, result: now });
      continue;
    }
    const brk = breakFor(breaks, e, entry.enforcers);
    if (!brk) {
      drift = true;
      findings.push({ path: id, result: { status: "inconclusive", message: "passes, but has never been seen to fail (no break)" } });
      continue;
    }
    const proof = await prove(w, law.text, e, brk);
    if (proof.kind === "stale" || proof.kind === "missed") drift = true;
    if (proof.kind === "unknown") blocked = true;
    findings.push({ path: id, result: describe(proof) });
  }
  const outcome: Outcome =
    today.status === "fail" ? (newlyFailing ? "newly failing" : "fails today") : drift ? "drift" : blocked ? "blocked" : "in sync";
  const settled = (path: string) => findings.find((f) => f.path === path)?.result.status !== "inconclusive";
  const pinned = { ...entry, enforcers: entry.enforcers.map((e) => (settled(enforcerId(e)) ? { ...e, inputs: inputsOf(w, e) } : e)) };
  return { law, outcome, findings, pinned };
}

