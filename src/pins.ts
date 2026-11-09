// What an enforcer was proven against. A break proves an enforcer can fail,
// but only as the enforcer was then: edit the test, turn a lint rule off,
// exclude the file in the runner's config, and the same pass means less.
// The lock records a fingerprint of each enforcer's inputs (its file, the
// config it runs under, the version of the tool it needs), and `check`
// replays the break of any enforcer whose inputs changed since.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isFile, nearest, packageDeps, upTo } from "./fsx.ts";
import type { Enforcer } from "./lock.ts";
import { OUT_DIR, posixRelative, type Where } from "./where.ts";

// label -> fingerprint. A label is a path relative to the law's directory, or
// "package.json#<dependency>" for the version a package.json asks for.
export type Inputs = Record<string, string>;

// Config files each kind of enforcer runs under, found from the enforcer's
// directory up to the repo root (the nearest one of each name).
const CONFIG: Record<string, string[]> = {
  test: [
    ...["vitest", "vite", "jest", "playwright"].flatMap((t) => ["ts", "mts", "cts", "js", "mjs", "cjs"].map((x) => `${t}.config.${x}`)),
    "bunfig.toml", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini", "conftest.py", "go.mod",
  ],
  semgrep: [".semgrepignore"],
};

// Dependencies whose version changes what an enforcer does.
const DEPS: Record<string, (name: string) => boolean> = {
  test: (n) => ["vitest", "jest", "@playwright/test", "ts-jest"].includes(n),
  lint: (n) => n === "eslint" || n.includes("eslint-plugin") || n.includes("eslint-config") || n === "typescript-eslint" || n === "@biomejs/biome" || n === "oxlint",
};

const fingerprint = (text: string | Buffer) => createHash("sha256").update(text).digest("hex").slice(0, 12);

// The files and versions this enforcer depends on, as they are now.
export function inputsOf(w: Where, e: Enforcer): Inputs {
  const inputs: Inputs = {};
  const add = (abs: string) => {
    if (existsSync(abs)) inputs[posixRelative(w.dir, abs) || "."] = fingerprint(readFileSync(abs));
  };
  const file = resolve(w.dir, e.path);
  add(file);
  for (const helper of helpersOf(w, file)) add(helper);
  if (e.kind === "tla") add(file.replace(/\.tla$/, ".cfg"));
  for (const name of CONFIG[e.kind] ?? []) {
    const found = nearest(dirname(file), name, w.repo);
    if (found) add(found);
  }
  const wanted = DEPS[e.kind];
  const pkg = wanted && nearest(dirname(file), "package.json", w.repo);
  if (pkg) {
    const at = posixRelative(w.dir, pkg);
    const deps = Object.entries(packageDeps(pkg)).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name, version] of deps) if (wanted(name)) inputs[`${at}#${name}`] = version;
  }
  return inputs;
}

// Files a break may not edit, relative to the law's directory: the enforcer's
// inputs, and every package.json its runner is picked from or its versions
// are read from (only some fields of those are inputs, but a break that drops
// vitest from package.json changes the runner, not the system).
export function pinnedFiles(w: Where, e: Enforcer): string[] {
  const files = new Set(Object.keys(inputsOf(w, e)).filter((k) => !k.includes("#")));
  if (e.kind === "test" || DEPS[e.kind]) {
    // The runner is picked from the law's directory up; versions from the file's.
    for (const from of [w.dir, dirname(resolve(w.dir, e.path))]) {
      for (const dir of upTo(from, w.repo)) {
        if (!dir.startsWith(w.repo)) break;
        if (existsSync(join(dir, "package.json"))) files.add(posixRelative(w.dir, join(dir, "package.json")));
      }
    }
  }
  return [...files];
}

// Other files in the law's .verdict/ that the enforcer names (a runner script,
// a fixture, a shared module): what it runs depends on them too. Matched by
// file name, which over-pins rather than misses.
function helpersOf(w: Where, file: string): string[] {
  const dir = join(w.dir, OUT_DIR);
  if (!file.startsWith(`${dir  }/`) || !existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const abs = join(dir, f);
    if (abs === file || f.startsWith("breaks/") || !isFile(abs)) continue; // a dangling link isn't a helper
    const name = basename(f);
    const stem = name.replace(/\.[cm]?[jt]sx?$/, "");
    if (text.includes(name) || (stem !== name && new RegExp(`["'/]${stem.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(text))) out.push(abs);
  }
  return out;
}

// What changed between the inputs an enforcer was proven against and now,
// in words: ["tests/billing.test.ts changed", "vitest.config.ts was added"].
export function changes(was: Inputs, now: Inputs): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(was)) {
    if (!(k in now)) out.push(k.includes("#") ? k.replace("#", " no longer lists ") : `${k} was removed`);
    else if (now[k] !== v) out.push(k.includes("#") ? `${k.replace("#", ": ")} went from ${v} to ${now[k]}` : `${k} changed`);
  }
  for (const k of Object.keys(now)) {
    if (!(k in was)) out.push(k.includes("#") ? `${k.replace("#", " now lists ")} ${now[k]}` : `${k} was added`);
  }
  return out;
}
