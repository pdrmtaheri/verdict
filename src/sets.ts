// Finding laws. Any directory can have a VERDICT.md; its VERDICT.lock and
// .verdict/ sit beside it. Like a test runner, verdict finds them all from the
// repository root, or the ones under the paths it's given.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { exec } from "./exec.ts";
import { errorMessage, listFiles, realOrSelf as real, under } from "./fsx.ts";
import { parseLaws, type Law } from "./laws.ts";
import { readLock, type Lock } from "./lock.ts";
import type { Where } from "./where.ts";

export class BadLaws extends Error {}

// A directory's laws and their lock: what `check` runs.
export interface Laws extends Where {
  laws: Law[];
  lock: Lock;
}

// ...and the files they're kept in: what `plan` syncs.
export interface LawSet extends Laws {
  lawsFile: string;
  lockFile: string;
}

export async function repoRoot(cwd: string): Promise<string> {
  const r = await exec(["git", "rev-parse", "--show-toplevel"], { cwd });
  return real(r.code === 0 && r.output ? r.output.trim() : cwd);
}

// The VERDICT.md files in the repo, and the directories that are playgrounds
// (they hold a PLAYGROUND.json). A playground is a world of its own, with its own
// laws and versions of code: verdict playground runs it, and an outer check or
// plan leaves it alone unless it's pointed at it.
async function lawFiles(repo: string): Promise<{ laws: string[]; playgrounds: string[] }> {
  const files = await listFiles(repo, { glob: "**/{VERDICT.md,PLAYGROUND.json}" });
  const named = (name: string) => files.filter((f) => f === name || f.endsWith(`/${name}`)).map((f) => join(repo, f));
  return { laws: named("VERDICT.md"), playgrounds: named("PLAYGROUND.json").map((f) => dirname(f)) };
}

// Every law set in the repo whose directory is inside one of `paths` (laws
// declared in that subtree), or all of them when no paths are given.
export async function findSets(cwd: string, paths: string[]): Promise<{ repo: string; sets: LawSet[]; unmatched: string[] }> {
  const repo = await repoRoot(cwd);
  const found = await lawFiles(repo);
  const all = found.laws.toSorted();
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
      const why = (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" && err.code) || errorMessage(err);
      throw new BadLaws(`can't read ${lawsFile} (${why}): check that it's a readable file, or remove it from the repo`);
    }
    return { dir, repo, lawsFile, lockFile, laws: parseLaws(text), lock: readLock(lockFile) };
  });
  return { repo, sets, unmatched };
}

export const shown = (repo: string, file: string) => relative(repo, file) || file;
