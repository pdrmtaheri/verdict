// Is each enforcer of a planned law still able to fail on today's code?
// A check can keep passing after the code it describes has moved, e.g. a rule
// scoped to src/money/ once the money code lives in src/billing/. That pass
// looks like a proof. `verdict plan` replays every stored break to find out.
import { describe, prove, readBreaks } from "./breaks.ts";
import { checkLaw } from "./check.ts";
import { withScratch } from "./scratch.ts";
import { inCopy, type Where } from "./where.ts";
import type { Law } from "./laws.ts";
import type { Lock } from "./lock.ts";
import type { Result } from "./result.ts";

export type Outcome = "in sync" | "drift" | "fails today" | "blocked" | "not planned";

export interface Reproof {
  law: Law;
  outcome: Outcome;
  findings: { path: string; result: Result }[];
}

export async function reproveLaw(w: Where, law: Law, lock: Lock): Promise<Reproof> {
  const entry = lock.get(law.hash);
  if (!entry) return { law, outcome: "not planned", findings: [] };
  // plan runs everything in a sandboxed scratch copy, even enforcers already in the lock.
  const today = await withScratch(w.repo, (copy) => checkLaw(inCopy(w, copy), entry, { readable: [w.repo] }));
  const breaks = readBreaks(w.dir, law.hash);
  const findings: Reproof["findings"] = [];
  let drift = false;
  let blocked = false;
  for (const e of entry.enforcers) {
    const now = today.details.find((d) => d.path === e.path)?.result;
    if (!now) continue; // an LLM judge skipped because its decision model was sure
    if (now.status === "fail") {
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
    const proof = await prove(w, law.text, e, brk);
    if (proof.kind === "stale" || proof.kind === "missed") drift = true;
    if (proof.kind === "unknown") blocked = true;
    findings.push({ path: e.path, result: describe(proof) });
  }
  const outcome: Outcome =
    today.status === "fail" ? "fails today" : drift ? "drift" : blocked ? "blocked" : "in sync";
  return { law, outcome, findings };
}

