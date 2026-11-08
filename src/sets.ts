// Finding laws. Any directory can have a VERDICT.md; its VERDICT.lock and
// .verdict/ sit beside it. Like a test runner, verdict finds them all from the
// repository root, or the ones under the paths it's given.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { exec } from "./exec.ts";
import { parseLaws, type Law } from "./laws.ts";
import { readLock, type Lock } from "./lock.ts";
import type { Where } from "./where.ts";

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

async function lawFiles(repo: string): Promise<string[]> {
  const r = await exec(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo });
  const files = r.code === 0 ? r.output.split("\n") : await Array.fromAsync(new Bun.Glob("**/VERDICT.md").scan({ cwd: repo }));
  return files.filter((f) => f === "VERDICT.md" || f.endsWith("/VERDICT.md")).map((f) => join(repo, f));
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

// Every law set in the repo whose directory is inside one of `paths` (laws
// declared in that subtree), or all of them when no paths are given.
export async function findSets(cwd: string, paths: string[]): Promise<{ repo: string; sets: LawSet[]; unmatched: string[] }> {
  const repo = await repoRoot(cwd);
  const all = (await lawFiles(repo)).sort();
  const targets = paths.map((p) => real(resolve(cwd, p)));
  const chosen = targets.length === 0 ? all : all.filter((f) => targets.some((t) => under(dirname(f), t)));
  const unmatched = paths.filter((_, i) => !all.some((f) => under(dirname(f), targets[i]!)));
  const sets = chosen.map((lawsFile) => {
    const dir = dirname(lawsFile);
    const lockFile = join(dir, "VERDICT.lock");
    return { dir, repo, lawsFile, lockFile, laws: parseLaws(readFileSync(lawsFile, "utf8")), lock: readLock(lockFile) };
  });
  return { repo, sets, unmatched };
}

export const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
export const shown = (repo: string, file: string) => relative(repo, file) || file;
