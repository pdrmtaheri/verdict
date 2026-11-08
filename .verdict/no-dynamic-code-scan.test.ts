// scope: every .ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts file under src/ (symlinks skipped), scanned as text after Bun's transpiler strips comments and types. Flags any reference to eval (called, aliased, passed, or reached through globalThis/global/window/self), any reference to the Function constructor (called, new, aliased, Reflect.construct, Function.prototype.constructor), any .constructor( call (the (()=>{}).constructor("...") route), imports of node:vm / vm / node:repl, new Worker(..., {eval}), string-argument setTimeout/setInterval, and import()/require() of data: or http(s): URLs or non-literal names. Complements oxlint no-eval/no-new-func/no-implied-eval in no-eval.sh. Static text only: a constructor reached through a computed property name or a string built at runtime is caught only where it shows as a computed member of a global; files outside src/ are not covered.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const LOADER: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx",
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
};

const RULES: { name: string; re: RegExp }[] = [
  { name: "eval referenced", re: /(?<![.\w$])eval\b(?!\s*:)|\b(?:globalThis|global|window|self)\s*(?:\.\s*eval\b|\[\s*["'`]eval["'`]\s*\])/g },
  { name: "Function constructor referenced", re: /(?<![.\w$])Function\b(?!\s*:)|\b(?:globalThis|global|window|self)\s*(?:\.\s*Function\b|\[\s*["'`]Function["'`]\s*\])/g },
  { name: "Function-family constructor (AsyncFunction etc.)", re: /\b(?:Async|Generator|AsyncGenerator)Function\b/g },
  { name: ".constructor( call", re: /\.\s*constructor\s*(?:\(|\[)|\[\s*["'`]constructor["'`]\s*\]/g },
  { name: "vm or repl module", re: /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`](?:node:)?(?:vm|repl)["'`]/g },
  { name: "Worker with eval", re: /\beval\s*:\s*true\b/g },
  { name: "string-argument timer", re: /\b(?:setTimeout|setInterval|setImmediate)\s*\(\s*["'`]/g },
  { name: "import/require of data: or remote URL", re: /\b(?:import|require)\s*\(\s*["'`](?:data|https?|blob):/g },
  { name: "import from data: or remote URL", re: /\bfrom\s*["'`](?:data|https?|blob):/g },
  { name: "computed import/require", re: /\b(?:import|require)\s*\(\s*(?!["'`])/g },
  { name: "Bun.Transpiler / Bun.plugin / Bun.build used to run generated code", re: /\bBun\s*\.\s*(?:plugin|build)\b/g },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.isFile() && LOADER[extname(entry.name)]) out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

function strip(path: string, text: string): string {
  const src = text.startsWith("#!") ? "//" + text.slice(2) : text;
  return new Bun.Transpiler({ loader: LOADER[extname(path)]! }).transformSync(src);
}

function check(path: string, code: string): string[] {
  const out: string[] = [];
  for (const rule of RULES) {
    for (const m of code.matchAll(rule.re)) out.push(`${path}: ${rule.name}: ${m[0].trim()}`);
  }
  return out;
}

const files = existsSync(SRC) ? sourceFiles(SRC).sort() : [];
const found = files.flatMap((p) => check(p, strip(p, readFileSync(join(ROOT, p), "utf8"))));

describe("src/ never runs a string as JavaScript", () => {
  test("no eval, Function constructor, vm, or data: import in src/", () => {
    if (found.length > 0) throw new Error(`${found.length} dynamic-code route(s):\n${found.join("\n")}`);
  });

  test("the scan reads the files it should", () => {
    expect(files).toContain("src/cli.ts");
    expect(files).toContain("src/plan.ts");
    expect(files.length).toBeGreaterThan(20);
  });

  test("the rules flag known-bad snippets", () => {
    const bad: Record<string, string> = {
      "eval referenced": `const e = eval; e("1");`,
      "Function constructor referenced": `const F = Function; new F("return 1");`,
      ".constructor( call": `(() => {}).constructor("return 1")();`,
      "vm or repl module": `import { runInNewContext } from "node:vm";`,
      "Worker with eval": `new Worker("1", { eval: true });`,
      "string-argument timer": `setTimeout("go()", 1);`,
      "import/require of data: or remote URL": `await import("data:text/javascript,1");`,
    };
    for (const [name, snippet] of Object.entries(bad)) {
      const hits = check("x.ts", strip("x.ts", snippet)).filter((h) => h.includes(`: ${name}:`));
      expect(hits.length, name).toBeGreaterThan(0);
    }
    expect(check("x.ts", strip("x.ts", `const retrieval = 1; const x = { evaluate() {} }; setTimeout(() => 1, 1);`))).toEqual([]);
  });
});
