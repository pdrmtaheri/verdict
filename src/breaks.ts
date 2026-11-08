// A break is a small edit to the system under check that should make an
// enforcer fail: removing a check, reordering a step, changing a value.
// "A check you've never seen fail proves nothing." Breaks ship with the
// enforcers, in .verdict/breaks/<law hash>.json, and `verdict plan` replays them.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { runEnforcer } from "./enforcers.ts";
import type { Enforcer } from "./lock.ts";
import { fail, inconclusive, pass, type Result } from "./result.ts";
import { withScratch } from "./scratch.ts";
import { pinnedFiles } from "./pins.ts";
import { inside } from "./tools.ts";
import { inCopy, type Where } from "./where.ts";

export const Edit = z.object({
  path: z.string().describe("A file of the system under check, relative to the law's directory (../ reaches the rest of the repo)"),
  find: z.string().describe("Exact text that occurs once in the file"),
  replace: z.string(),
});

export const Break = z.object({
  enforcer: z.string().describe("Path of the enforcer this break must make fail"),
  description: z.string().describe("What the break does, in the code's own words"),
  edits: z.array(Edit).min(1),
});
export type Break = z.infer<typeof Break>;

export const breaksFile = (root: string, hash: string) => join(root, ".verdict", "breaks", `${hash}.json`);

export function readBreaks(root: string, hash: string): Break[] {
  const file = breaksFile(root, hash);
  return existsSync(file) ? z.array(Break).parse(JSON.parse(readFileSync(file, "utf8"))) : [];
}

export function writeBreaks(root: string, hash: string, breaks: Break[]): void {
  mkdirSync(join(root, ".verdict", "breaks"), { recursive: true });
  writeFileSync(breaksFile(root, hash), JSON.stringify(breaks, null, 2) + "\n");
}

export type Proof =
  | { kind: "caught"; result: Result } // the enforcer failed on the broken code
  | { kind: "missed"; result: Result } // it passed: the enforcer can't see this break
  | { kind: "stale"; reason: string } // the break no longer applies: the code moved
  | { kind: "unknown"; result: Result }; // the enforcer was inconclusive

// Applies the break to a scratch copy and runs the enforcer there.
export async function prove(w: Where, law: string, enforcer: Enforcer, brk: Break): Promise<Proof> {
  return withScratch(w.repo, async (copy) => {
    const c = inCopy(w, copy);
    const dir = c.dir;
    const pinned = new Set(pinnedFiles(c, enforcer).map((f) => same(resolve(dir, f))));
    for (const e of brk.edits) {
      let file: string;
      try {
        file = inside(dir, e.path, c.repo);
      } catch (err) {
        return { kind: "stale", reason: (err as Error).message };
      }
      if (relative(dir, file).split(sep)[0] === ".verdict" || pinned.has(same(file))) {
        return { kind: "stale", reason: `${e.path}: a break must change the system, not the enforcer or the config it runs under` };
      }
      if (!existsSync(file)) return { kind: "stale", reason: `${e.path} no longer exists` };
      const text = readFileSync(file, "utf8");
      const count = text.split(e.find).length - 1;
      if (count !== 1) return { kind: "stale", reason: `${e.path}: the text to replace occurs ${count} times, not once` };
      writeFileSync(file, text.replace(e.find, () => e.replace));
    }
    const result = await runEnforcer(enforcer.kind, { root: c.dir, repo: c.repo, law, path: enforcer.path, name: enforcer.name, sandbox: { readable: [w.repo] } });
    if (result.status === "fail") return { kind: "caught", result };
    if (result.status === "pass") return { kind: "missed", result };
    return { kind: "unknown", result };
  });
}

// One spelling per file, to compare paths: symlinks resolved, and case folded
// where the filesystem ignores case (macOS and Windows by default).
function same(p: string): string {
  const real = existsSync(p) ? realpathSync(p) : p;
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
      return (err as Error).message;
    }
    if (!existsSync(file)) return `${e.path} no longer exists`;
    const count = readFileSync(file, "utf8").split(e.find).length - 1;
    if (count !== 1) return `${e.path}: the text it replaces occurs ${count} times, not once`;
  }
  return null;
}

// Runs an enforcer the way planning does: on a scratch copy, in the sandbox.
// The planner wrote it, so it never runs against the real repo unconfined.
export async function runInScratch(w: Where, law: string, enforcer: Enforcer): Promise<Result> {
  return withScratch(w.repo, (copy) => {
    const c = inCopy(w, copy);
    return runEnforcer(enforcer.kind, { root: c.dir, repo: c.repo, law, path: enforcer.path, name: enforcer.name, sandbox: { readable: [w.repo] } });
  });
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
