// Filesystem and path primitives shared across verdict: one definition each
// of what a path resolves to, whether it's inside another, and where the
// nearest file or tool is on the way up to the repository root.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { exec } from "./exec.ts";

// The real path when it exists, the path itself otherwise. Paths are compared
// after resolving symlinks (git reports real paths, and macOS's /tmp is a
// link to /private/tmp).
export const realOrSelf = (p: string): string => (existsSync(p) ? realpathSync(p) : p);

// Whether `p` is `dir` or below it. Both paths must already be absolute.
export const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + sep);

// Whether anything is at `p`, a dangling symlink included.
export function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// A file or directory, following links: a dangling link is neither.
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Resolves symlinks on the deepest ancestor that exists (as a file, directory
// or link), so links can't escape. A dangling link can't be resolved, and
// writing through one would create its target wherever it points, so it's refused.
function resolveLinks(p: string): string {
  let existing = p;
  while (!lexists(existing)) existing = dirname(existing);
  let resolved: string;
  try {
    resolved = realpathSync(existing);
  } catch {
    throw new Error(`${existing} is a symlink to nowhere`);
  }
  return resolve(resolved, relative(existing, p));
}

// `p` resolved against `root`, after checking that it (with every symlink on
// the way resolved) stays inside `within`. Throws a message saying so.
export function inside(root: string, p: string, within = root): string {
  const abs = resolve(root, p);
  const target = resolveLinks(abs);
  const base = resolveLinks(resolve(within));
  if (!under(target, base)) throw new Error(`${p} is outside ${relative(root, within) || "the repo"}`);
  return abs;
}

export function isInside(root: string, p: string, within = root): boolean {
  try {
    inside(root, p, within);
    return true;
  } catch {
    return false;
  }
}

// The directories from `from` up to `repo` (inclusive), or up to the
// filesystem root when `from` isn't inside `repo`.
export function* upTo(from: string, repo: string): Generator<string> {
  for (let dir = from; ; dir = dirname(dir)) {
    yield dir;
    if (dir === repo || dir === dirname(dir)) return;
  }
}

// The nearest `name` from `from` up to the repo root; null if there is none.
export function nearest(from: string, name: string, repo: string): string | null {
  for (const dir of upTo(from, repo)) {
    if (existsSync(join(dir, name))) return join(dir, name);
    if (!dir.startsWith(repo)) return null;
  }
  return null;
}

// A tool in node_modules/.bin from `from` up to the repo root, then on PATH.
export function findBin(from: string, bin: string, repo = from): string | null {
  for (const dir of upTo(from, repo)) {
    const local = join(dir, "node_modules", ".bin", bin);
    if (existsSync(local)) return local;
  }
  return Bun.which(bin);
}

// The files git would track under `root` (uncommitted and untracked,
// non-ignored files included), relative to it. Outside a git repo, every file
// matching `glob`.
export async function listFiles(root: string, fallback: { glob: string; dot?: boolean } = { glob: "**/*" }): Promise<string[]> {
  const r = await exec(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (r.code === 0) return r.output.split("\n").filter(Boolean);
  return Array.fromAsync(new Bun.Glob(fallback.glob).scan({ cwd: root, onlyFiles: true, dot: fallback.dot ?? false }));
}

// The dependencies and devDependencies a package.json asks for.
export function packageDeps(file: string): Record<string, string> {
  const json = JSON.parse(readFileSync(file, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return { ...json.dependencies, ...json.devDependencies };
}
