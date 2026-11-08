// Finding laws. Any directory can have a VERDICT.md; its VERDICT.lock and
// .verdict/ sit beside it. Like a test runner, verdict finds them all from the
// repository root, or the ones under the paths it's given.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { exec } from "./exec.ts";
import { parseLaws, type Law } from "./laws.ts";
import { readLock, type Lock } from "./lock.ts";
import type { Where } from "./where.ts";

export class BadLaws extends Error {}

export interface LawSet extends Where {
  lawsFile: string;
  lockFile: string;
  laws: Law[];
  lock: Lock;
}

// Paths are compared after resolving symlinks (git reports real paths, and
// e.g. macOS's /tmp is a link to /private/tmp).
const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);

export async function repoRoot(cwd: string): Promise<string> {
  const r = await exec(["git", "rev-parse", "--show-toplevel"], { cwd });
  return real(r.code === 0 && r.output ? r.output.trim() : cwd);
}

// The VERDICT.md files in the repo, and the directories that are playgrounds
// (they hold a PLAYGROUND.json). A playground is a world of its own, with its own
// laws and versions of code: verdict playground runs it, and an outer check or
// plan leaves it alone unless it's pointed at it.
async function lawFiles(repo: string): Promise<{ laws: string[]; playgrounds: string[] }> {
  const r = await exec(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo });
  const files = r.code === 0 ? r.output.split("\n") : await Array.fromAsync(new Bun.Glob("**/{VERDICT.md,PLAYGROUND.json}").scan({ cwd: repo }));
  const named = (name: string) => files.filter((f) => f === name || f.endsWith(`/${name}`)).map((f) => join(repo, f));
  return { laws: named("VERDICT.md"), playgrounds: named("PLAYGROUND.json").map((f) => dirname(f)) };
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

// Every law set in the repo whose directory is inside one of `paths` (laws
// declared in that subtree), or all of them when no paths are given.
export async function findSets(cwd: string, paths: string[]): Promise<{ repo: string; sets: LawSet[]; unmatched: string[] }> {
  const repo = await repoRoot(cwd);
  const found = await lawFiles(repo);
  const all = found.laws.sort();
  const targets = paths.map((p) => real(resolve(cwd, p)));
  // A playground's laws count only when a path points at the playground or inside it.
  const apart = (f: string) => found.playgrounds.some((pg) => under(dirname(f), pg) && !targets.some((t) => under(t, pg)));
  const chosen = (targets.length === 0 ? all : all.filter((f) => targets.some((t) => under(dirname(f), t)))).filter((f) => !apart(f));
  const unmatched = paths.filter((_, i) => !all.some((f) => under(dirname(f), targets[i]!)));
  const sets = chosen.map((lawsFile) => {
    const dir = dirname(lawsFile);
    const lockFile = join(dir, "VERDICT.lock");
    let text: string;
    try {
      text = readFileSync(lawsFile, "utf8");
    } catch (err) {
      throw new BadLaws(`can't read ${lawsFile} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}): check that it's a readable file, or remove it from the repo`);
    }
    return { dir, repo, lawsFile, lockFile, laws: parseLaws(text), lock: readLock(lockFile) };
  });
  return { repo, sets, unmatched };
}

export const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
export const shown = (repo: string, file: string) => relative(repo, file) || file;
