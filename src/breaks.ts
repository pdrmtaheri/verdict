// A break is a small edit to the system under check that should make an
// enforcer fail: removing a check, reordering a step, changing a value.
// "A check you've never seen fail proves nothing." Breaks ship with the
// enforcers, in .verdict/breaks/<law hash>.json, and `verdict plan` replays them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { runEnforcer, type RunSite } from "./enforcers.ts";
import { errorMessage, inside, realOrSelf } from "./fsx.ts";
import { enforcerId, type Enforcer } from "./lock.ts";
import { pinnedFiles } from "./pins.ts";
import { fail, inconclusive, pass, type Result } from "./result.ts";
import { withScratch } from "./scratch.ts";
import { inCopy, OUT_DIR, type Where } from "./where.ts";

export const Edit = z.object({
  path: z.string().describe("A file of the system under check, relative to the law's directory (../ reaches the rest of the repo)"),
  find: z.string().describe("Exact text that occurs once in the file"),
  replace: z.string(),
});

export const Break = z.object({
  enforcer: z.string().describe('The enforcer this break must make fail: its path, plus "#<rule>" for a lint enforcer or "#<name>" for a named test'),
  description: z.string().describe("What the break does, in the code's own words"),
  edits: z.array(Edit).min(1),
});
export type Break = z.infer<typeof Break>;

export const breaksFile = (root: string, hash: string): string => join(root, OUT_DIR, "breaks", `${hash}.json`);

export function readBreaks(root: string, hash: string): Break[] {
  const file = breaksFile(root, hash);
  return existsSync(file) ? z.array(Break).parse(JSON.parse(readFileSync(file, "utf8"))) : [];
}

export function writeBreaks(root: string, hash: string, breaks: Break[]): void {
  mkdirSync(join(root, OUT_DIR, "breaks"), { recursive: true });
  writeFileSync(breaksFile(root, hash), `${JSON.stringify(breaks, null, 2)  }\n`);
}

export type Proof =
  | { kind: "caught"; result: Result } // the enforcer failed on the broken code
  | { kind: "missed"; result: Result } // it passed: the enforcer can't see this break
  | { kind: "stale"; reason: string } // the break no longer applies: the code moved
  | { kind: "unknown"; result: Result }; // the enforcer was inconclusive

// The break for this enforcer: by its id, or, for a break recorded before ids
// had a rule or name, by its path when no other enforcer shares the path.
export function breakFor(breaks: Break[], e: Enforcer, all: Enforcer[] = [e]): Break | undefined {
  const byId = breaks.find((b) => b.enforcer === enforcerId(e));
  if (byId) return byId;
  const sharesPath = all.filter((o) => o.path === e.path).length > 1;
  return sharesPath ? undefined : breaks.find((b) => b.enforcer === e.path);
}

// Where planning runs an enforcer: in a scratch copy, in the sandbox. The
// planner wrote it, so it never runs against the real repo unconfined.
const scratchSite = (w: Where, copy: string, law: string): RunSite => ({ where: inCopy(w, copy), law, sandbox: { readable: [w.repo] } });

// Applies the break to a scratch copy and runs the enforcer there.
export async function prove(w: Where, law: string, enforcer: Enforcer, brk: Break): Promise<Proof> {
  return withScratch(w.repo, async (copy) => {
    const site = scratchSite(w, copy, law);
    const c = site.where;
    const pinned = new Set(pinnedFiles(c, enforcer).map((f) => same(resolve(c.dir, f))));
    for (const e of brk.edits) {
      let file: string;
      try {
        file = inside(c.dir, e.path, c.repo);
      } catch (err) {
        return { kind: "stale", reason: errorMessage(err) };
      }
      if (testSide(relative(c.repo, file)) || pinned.has(same(file))) {
        return { kind: "stale", reason: `${e.path}: a break must change the system, not the enforcer or the config it runs under` };
      }
      if (!existsSync(file)) return { kind: "stale", reason: `${e.path} no longer exists` };
      const text = readFileSync(file, "utf8");
      const count = occurrences(text, e.find);
      if (count !== 1) return { kind: "stale", reason: `${e.path}: the text to replace occurs ${count} times, not once` };
      writeFileSync(file, text.replace(e.find, () => e.replace));
    }
    const result = await runEnforcer(enforcer, site);
    if (result.status === "fail") return { kind: "caught", result };
    if (result.status === "pass") return { kind: "missed", result };
    return { kind: "unknown", result };
  });
}

const occurrences = (text: string, find: string): number => text.split(find).length - 1;

// Files on the test side of the repo, which a break may not edit: making a
// test fail by changing its fixtures, snapshots, helpers or another law's
// enforcers proves nothing about the system. Path relative to the repo root.
export function testSide(path: string): boolean {
  const parts = path.toLowerCase().split(sep); // stricter than any runner, on any filesystem
  const name = parts.at(-1) ?? "";
  if (parts.some((p) => [".verdict", "__snapshots__", "__fixtures__", "__mocks__", "fixtures", "testdata", "__tests__"].includes(p))) return true;
  return /\.(test|spec)\.[^/]+$|_test\.go$|^test_.*\.py$|_test\.py$|^conftest\.py$/.test(name);
}

// One spelling per file, to compare paths: symlinks resolved, and case folded
// where the filesystem ignores case (macOS and Windows by default).
function same(p: string): string {
  const real = realOrSelf(p);
  return process.platform === "darwin" || process.platform === "win32" ? real.toLowerCase() : real;
}

// Whether a break still applies to the code, without running anything: each
// edit's text must still occur exactly once. Returns why not, or null.
export function stale(w: Where, brk: Break): string | null {
  for (const e of brk.edits) {
    let file: string;
    try {
      file = inside(w.dir, e.path, w.repo);
    } catch (err) {
      return errorMessage(err);
    }
    if (!existsSync(file)) return `${e.path} no longer exists`;
    const count = occurrences(readFileSync(file, "utf8"), e.find);
    if (count !== 1) return `${e.path}: the text it replaces occurs ${count} times, not once`;
  }
  return null;
}

// Runs an enforcer the way planning does: on a scratch copy, in the sandbox.
export async function runInScratch(w: Where, law: string, enforcer: Enforcer): Promise<Result> {
  return withScratch(w.repo, (copy) => runEnforcer(enforcer, scratchSite(w, copy, law)));
}

export function describe(p: Proof): Result {
  switch (p.kind) {
    case "caught":
      return pass("caught its break");
    case "missed":
      return fail("passed on code broken on purpose: it can't see this break");
    case "stale":
      return inconclusive(`the break no longer applies (${p.reason})`);
    case "unknown":
      return inconclusive(`inconclusive on the break: ${p.result.message}`);
  }
}
