// scope: `bun src/cli.ts check` run as a real process in scratch directories (outside the repo). A lock is planned for single-line laws; VERDICT.md is then rewritten with seeded random re-wrapping and re-indenting of continuation lines (line breaks at any word gap, 1-8 space or tab indents, runs of spaces and tabs between words, trailing blanks, CRLF, words such as "-", "*", "+" starting a wrapped line), which must never produce "NOT PLANNED"; and with one word of one law deleted, inserted, replaced, case-changed, extended or swapped, which must always report exactly that law as NOT PLANNED. Enforcers are shell scripts exiting 0, so no agent, model or network is needed. Not covered: re-indenting the "- " bullet itself, nested VERDICT.md files, non-ASCII whitespace, and the plan command.

import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLaws } from "../src/laws.ts";

const REPO = resolve(import.meta.dir, "..");

// Small deterministic PRNG (mulberry32).
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick<T>(xs: T[]): T {
      return xs[Math.floor(next() * xs.length)]!;
    },
  };
}

const BASE: string[][] = [
  "Money is never a float; amounts are integer cents.".split(" "),
  "No order is charged twice - even if the payment provider times out or the user retries.".split(" "),
  "Error messages tell the user what to do next, + a hint * always.".split(" "),
  "Every export is signed - never plain - and logged once per request.".split(" "),
  "Sessions expire after 30 minutes; refresh tokens rotate on use.".split(" "),
];

const FILLER = ["banana", "never", "always", "-", "not", "zebra"];

const textOf = (words: string[]) => words.join(" ");
const hashOf = (text: string) => parseLaws(`- ${text}`)[0]!.hash;

function layout(words: string[], r: ReturnType<typeof rng>): string {
  const nl = r.pick(["\n", "\r\n"]);
  const gap = () => r.pick([" ", "  ", "\t", " \t ", "     "]);
  const indent = () => r.pick([" ", "  ", "   ", "    ", "\t", "        ", " \t"]);
  let out = `- ${words[0]!}`;
  for (let i = 1; i < words.length; i++) {
    if (r.int(3) === 0) out += r.pick(["", " ", "\t"]) + nl + indent();
    else out += gap();
    out += words[i]!;
  }
  return out + r.pick(["", " ", "  "]) + nl;
}

function fixture(lockLaws: string[], markdown: string): string {
  const dir = mkdtempSync(join(tmpdir(), "verdict-wrap-"));
  mkdirSync(join(dir, ".verdict"));
  const script = join(dir, ".verdict/ok.sh");
  writeFileSync(script, "#!/bin/sh\n# scope: fixture script for rewrap-hash.test.ts\nexit 0\n");
  chmodSync(script, 0o755);
  writeFileSync(join(dir, "VERDICT.md"), markdown);
  const lock = lockLaws
    .map((t) => `${JSON.stringify(hashOf(t))}:\n  law: ${JSON.stringify(t)}\n  enforcers:\n    - test: .verdict/ok.sh\n`)
    .join("");
  writeFileSync(join(dir, "VERDICT.lock"), lock);
  return dir;
}

async function check(dir: string): Promise<{ code: number; out: string; unplanned: number; unplannedLines: string[] }> {
  const proc = Bun.spawn([process.execPath, join(REPO, "src/cli.ts"), "check"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const [o, e, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const out = o + e;
  const m = /(\d+) not planned/.exec(out);
  const unplannedLines = out.split("\n").filter((l) => l.startsWith("NOT PLANNED"));
  return { code: code ?? -1, out, unplanned: m ? Number(m[1]) : -1, unplannedLines };
}

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

test(
  "re-wrapping and re-indenting laws never makes check report them as not planned",
  async () => {
    const seeds = Array.from({ length: 24 }, (_, i) => i + 1);
    const violations: string[] = [];
    await inBatches(seeds, 8, async (seed) => {
      const r = rng(seed * 7919);
      const md = "# Laws\n\nProse.\n\n" + BASE.map((w) => layout(w, r)).join(r.pick(["", "\n"]));
      const dir = fixture(BASE.map(textOf), md);
      try {
        const res = await check(dir);
        if (res.unplanned !== 0 || res.code !== 0) {
          violations.push(`seed ${seed}: exit ${res.code}, ${res.unplanned} not planned\n${JSON.stringify(md)}\n${res.out}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    expect(violations).toEqual([]);
  },
  600_000,
);

test(
  "changing any word of a law makes check report exactly that law as not planned",
  async () => {
    type Case = { name: string; law: number; words: string[]; seed: number };
    const cases: Case[] = [];
    let seed = 100;
    BASE.forEach((words, law) => {
      const r = rng(law + 5);
      const i = r.int(words.length);
      const j = (i + 1 + r.int(words.length - 1)) % words.length;
      const add = (name: string, w: string[]) => cases.push({ name, law, words: w, seed: seed++ });
      add(`delete word ${i}`, words.filter((_, k) => k !== i));
      add(`insert before ${i}`, [...words.slice(0, i), r.pick(FILLER), ...words.slice(i)]);
      add(`append word`, [...words, "extra"]);
      add(`replace word ${i}`, words.map((w, k) => (k === i ? w + "x" : w)));
      add(`replace word ${i} with other`, words.map((w, k) => (k === i ? "zzz" : w)));
      add(`upper-case word ${i}`, words.map((w, k) => (k === i ? w.toUpperCase() + "Q" : w)));
      add(`change last word`, words.map((w, k) => (k === words.length - 1 ? "changed" : w)));
      add(`change first word`, words.map((w, k) => (k === 0 ? "Changed" : w)));
      const sw = words.slice();
      [sw[i], sw[j]] = [sw[j]!, sw[i]!];
      if (textOf(sw) !== textOf(words)) add(`swap words ${i},${j}`, sw);
    });
    const violations: string[] = [];
    await inBatches(cases, 8, async (c) => {
      const r = rng(c.seed);
      const laws = BASE.map((w, k) => (k === c.law ? c.words : w));
      const md = laws.map((w) => layout(w, r)).join("");
      const dir = fixture(BASE.map(textOf), md);
      try {
        const res = await check(dir);
        const changed = textOf(c.words);
        const ok = res.code !== 0 && res.unplanned === 1 && res.unplannedLines.length === 1 && res.unplannedLines[0]!.includes(changed);
        if (!ok) violations.push(`${c.name} (law ${c.law}): exit ${res.code}, ${res.unplanned} not planned\n${JSON.stringify(md)}\n${res.out}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    expect(violations).toEqual([]);
  },
  600_000,
);
