// Where a law lives. Laws can be declared in any directory's VERDICT.md; they
// apply to that directory's subtree, and their VERDICT.lock and .verdict/ sit
// beside them. `dir` is that directory; `repo` is the repository root, which
// bounds everything verdict reads. Paths in a lock are relative to `dir`.
import { join, relative, sep } from "node:path";

export interface Where {
  dir: string;
  repo: string;
}

// Where a law's generated enforcers and breaks live, beside its VERDICT.md.
export const OUT_DIR = ".verdict";

// A relative path with "/" separators on every OS: what goes in a lock, a
// report or anything else that's committed or compared across machines.
export const posixRelative = (from: string, to: string): string => relative(from, to).split(sep).join("/");

export const at = (root: string): Where => ({ dir: root, repo: root });

// The same place inside a scratch copy of the repo.
export const inCopy = (w: Where, copy: string): Where => ({ dir: join(copy, relative(w.repo, w.dir)), repo: copy });

// How the law's directory reads to a person: "." for the repo root.
export const label = (w: Where): string => relative(w.repo, w.dir) || ".";
