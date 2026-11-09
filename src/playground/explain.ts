// Turns an enforcer's raw failure output into something a person can read: a
// headline, a few plain points, and the raw output kept for the curious. The
// raw text is stack traces, source excerpts and diffs; none of it leads.
export interface Point {
  text: string;
  code?: string; // the line of code the point is about
}
export interface Explained {
  headline: string;
  points: Point[];
  raw: string; // shown only behind "technical details"; "" when the headline says it all
}

// oxlint-disable-next-line no-control-regex -- strips ANSI colour codes, which start with ESC
const clean = (s: string) => s.replaceAll(/\u001b\[[0-9;]*m/g, "").replaceAll(/[ \t]+$/gm, "");
const sentence = (s: string) => {
  const t = s.trim().replaceAll(/\s+/g, " ");
  return t ? t[0]!.toUpperCase() + t.slice(1) + (/[.!?…]$/.test(t) ? "" : ".") : t;
};
const capital = (s: string) => { const t = s.trim().replaceAll(/\s+/g, " "); return t ? t[0]!.toUpperCase() + t.slice(1) : t; };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "expect(received).toBeGreaterThanOrEqual(expected)" + Expected/Received lines.
const MATCHERS: [RegExp, (e: string) => string][] = [
  [/toBeGreaterThanOrEqual/, (e) => `expected at least ${e.replace(/^>=\s*/, "")}`],
  [/toBeGreaterThan\b/, (e) => `expected more than ${e.replace(/^>\s*/, "")}`],
  [/toBeLessThanOrEqual/, (e) => `expected at most ${e.replace(/^<=\s*/, "")}`],
  [/toBeLessThan\b/, (e) => `expected less than ${e.replace(/^<\s*/, "")}`],
  [/toContain/, (e) => `expected it to contain ${e}`],
  [/toMatch/, (e) => `expected it to match ${e}`],
];

interface Failure {
  name: string;
  problem: string;
}

function bunFailures(text: string): { failures: Failure[]; pass: number; fail: number } | null {
  const lines = text.split("\n");
  if (!lines.some((l) => l.startsWith("(fail) "))) return null;
  const failures: Failure[] = [];
  let block: string[] = [];
  for (const line of lines) {
    const m = /^\(fail\) (.*?)(?: \[[\d.]+ms\])?$/.exec(line);
    if (!m) {
      block.push(line);
      continue;
    }
    failures.push({ name: m[1]!, problem: problemOf(block) });
    block = [];
  }
  const num = (word: string) => Number(new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(text)?.[1] ?? 0);
  const failed = num("fail");
  return { failures, pass: num("pass"), fail: failed > 0 ? failed : failures.length };
}

function problemOf(block: string[]): string {
  const at = block.map((l) => l.trim());
  const err = at.toReversed().find((l) => /^(error:|[A-Z][A-Za-z]*Error:)/.test(l));
  const expected = at.findLast((l) => l.startsWith("Expected:"))?.slice(9).trim();
  const received = at.findLast((l) => l.startsWith("Received:"))?.slice(9).trim();
  if (err && expected !== undefined && received !== undefined) {
    const matcher = MATCHERS.find(([re]) => re.test(err));
    return `${matcher ? matcher[1](expected) : `expected ${expected}`}, got ${received}`;
  }
  if (err?.startsWith("error: expect(")) return "the values did not match what the test expected";
  if (err) {
    const msg = err.replace(/^error:\s*/, "");
    return /^[A-Z][A-Za-z]*Error:/.test(msg) ? `the code crashed with ${msg}` : msg;
  }
  // Long output is cut from the top, so the error line may be gone while its diff remains.
  if (at.some((l) => /^[-+]\s+(Expected|Received)\b/.test(l))) return "the result was not what the test expected";
  return "it failed";
}

function semgrepFindings(text: string): Point[] | null {
  if (!text.includes("Code Finding") && !text.includes("Blocking")) return null;
  const lines = text.split("\n");
  const points: Point[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes("Blocking")) continue;
    const msg = lines.slice(i + 1).find((l) => l.trim() !== "")?.trim() ?? "a rule matched";
    const file = lines.slice(0, i).findLast((l) => /^\s+\S+\.\w+\s*$/.test(l))?.trim();
    const code = /^\s*(\d+)┆\s?(.*)$/.exec(lines.slice(i + 1).find((l) => /^\s*\d+┆/.test(l)) ?? "");
    points.push({ text: `${file ? `${file}${code ? `:${code[1]}` : ""} — ` : ""}${msg}`, code: code?.[2]?.trim() });
  }
  return points.length > 0 ? points : null;
}

function tlcTrace(text: string): { headline: string; points: Point[] } | null {
  const m = /Error: (Invariant (\S+) is violated|Temporal properties were violated|Deadlock reached)/.exec(text);
  if (!m) return null;
  const headline = m[2]
    ? `The model checker found a sequence of steps that breaks “${m[2]}”.`
    : m[1]!.startsWith("Temporal") ? "The model checker found a sequence of steps that breaks a property over time." : "The model checker found a state it cannot leave.";
  const points: Point[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && points.length < 8; i++) {
    const s = /^State (\d+): (.*)$/.exec(lines[i]!);
    if (!s) continue;
    const vars: string[] = [];
    for (let j = i + 1; j < lines.length && !/^State \d+:/.test(lines[j]!) && /^[/\\ \w]*\w+ = /.test(lines[j]!); j++) vars.push(lines[j]!.replace(/^\/\\\s*/, "").trim());
    const what = /Initial/.test(s[2]!) ? "start" : "next step";
    points.push({ text: `Step ${s[1]} (${what}): ${vars.join(", ") || "no change"}` });
  }
  return { headline, points };
}

export function explain(kind: string, status: "pass" | "fail" | "inconclusive", message: string): Explained {
  const raw = clean(message).trim();
  if (!raw) return { headline: status === "fail" ? "It failed, and printed nothing." : "", points: [], raw: "" };

  if (kind === "llm" || kind === "decision") return { headline: raw.split("\n")[0]!, points: [], raw: raw.includes("\n") ? raw : "" };
  if (/^the code this spec models changed|is not stamped with the hash|has no "models:" line/.test(raw)) return { headline: sentence(raw.split("\n")[0]!), points: [], raw: "" };

  if (kind === "test") {
    const b = bunFailures(raw);
    if (b) {
      const counted = b.pass + b.fail;
      const total = counted > 0 ? counted : b.failures.length;
      return {
        headline: `${b.failures.length} of ${plural(total, "check")} failed.`,
        points: b.failures.map((f) => ({ text: `${capital(f.name)} — ${f.problem}` })),
        raw,
      };
    }
    const crash = /^(.*Error): (.*)$/m.exec(raw);
    if (crash) return { headline: `The test crashed: ${crash[1]}: ${crash[2]}`, points: [], raw };
  }
  if (kind === "semgrep") {
    const f = semgrepFindings(raw);
    if (f) return { headline: `A code rule found ${plural(f.length, "problem")}.`, points: f, raw };
  }
  if (kind === "tla") {
    const t = tlcTrace(raw);
    if (t) return { ...t, raw };
    const exit = /^TLC exited (\d+)/.exec(raw);
    if (exit) return { headline: "The model checker could not run the model.", points: [], raw };
  }

  const first = raw.split("\n").find((l) => l.trim() && !/^(bun test v|…)/.test(l.trim())) ?? raw;
  return { headline: sentence(first.length > 160 ? `${first.slice(0, 157)}…` : first), points: [], raw: raw.includes("\n") ? raw : "" };
}
