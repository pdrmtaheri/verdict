// Tools that agents (the LLM judge and the planner) use to look at the repo.
// Every path is confined to the repo root.
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { exec, tail } from "./exec.ts";

const MAX_READ = 100_000;

// Resolves symlinks on the deepest existing ancestor, so links can't escape.
function real(p: string): string {
  let existing = p;
  while (!existsSync(existing)) existing = dirname(existing);
  return resolve(realpathSync(existing), relative(existing, p));
}

export function inside(root: string, p: string, within = root): string {
  const abs = resolve(root, p);
  const target = real(abs);
  const base = real(resolve(within));
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`${p} is outside ${relative(root, within) || "the repo"}`);
  }
  return abs;
}

async function gitFiles(root: string): Promise<string[]> {
  const r = await exec(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (r.code === 0) return r.output.split("\n").filter(Boolean);
  return Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true }));
}

const GIT_READ_ONLY = new Set(["diff", "log", "show", "status", "ls-files", "blame"]);

export function readTools(root: string) {
  return {
    read_file: tool({
      description: "Read a text file in the repository.",
      inputSchema: z.object({ path: z.string().describe("Path relative to the repo root") }),
      execute: async ({ path }) => {
        const text = readFileSync(inside(root, path), "utf8");
        return text.length > MAX_READ ? text.slice(0, MAX_READ) + "\n…(truncated)" : text;
      },
    }),
    list_files: tool({
      description: "List files tracked in the repository (respects .gitignore). Optional glob filter.",
      inputSchema: z.object({ glob: z.string().optional().describe('e.g. "src/**/*.ts"') }),
      execute: async ({ glob }) => {
        let files = await gitFiles(root);
        if (glob) {
          const g = new Bun.Glob(glob);
          files = files.filter((f) => g.match(f));
        }
        return files.slice(0, 2000).join("\n") || "(no files)";
      },
    }),
    grep: tool({
      description: "Search file contents with a regular expression. Returns path:line: text.",
      inputSchema: z.object({
        pattern: z.string(),
        glob: z.string().optional().describe("Only search files matching this glob"),
      }),
      execute: async ({ pattern, glob }) => {
        const re = new RegExp(pattern);
        const g = glob ? new Bun.Glob(glob) : null;
        const hits: string[] = [];
        for (const f of await gitFiles(root)) {
          if (g && !g.match(f)) continue;
          let text: string;
          try {
            if (statSync(resolve(root, f)).size > 1_000_000) continue;
            text = readFileSync(resolve(root, f), "utf8");
          } catch {
            continue;
          }
          text.split("\n").forEach((line, i) => {
            if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.slice(0, 300)}`);
          });
          if (hits.length >= 500) break;
        }
        return hits.slice(0, 500).join("\n") || "(no matches)";
      },
    }),
    git: tool({
      description: `Run a read-only git command: ${[...GIT_READ_ONLY].join(", ")}.`,
      inputSchema: z.object({ args: z.array(z.string()).describe('e.g. ["diff", "--cached"]') }),
      execute: async ({ args }) => {
        if (!GIT_READ_ONLY.has(args[0] ?? "")) throw new Error(`git ${args[0]} is not allowed`);
        const r = await exec(["git", "--no-pager", ...args], { cwd: root });
        return tail(`exit ${r.code}\n${r.output}`, 400);
      },
    }),
  };
}

// Programs the planner may run to validate what it generated. No shell.
const RUNNABLE = new Set([
  "semgrep", "eslint", "ruff", "golangci-lint", "mypy", "pyright",
  "tlc", "java", "bun", "npx", "go", "python", "python3", "pytest", "cargo",
]);

export function writeTools(root: string, outDir: string) {
  return {
    write_file: tool({
      description: `Create or overwrite a file. Only paths inside ${relative(root, outDir)}/ are allowed.`,
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
        executable: z.boolean().optional().describe("Set the executable bit (for script tests)"),
      }),
      execute: async ({ path, content, executable }) => {
        mkdirSync(outDir, { recursive: true });
        const abs = inside(root, path, outDir);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, { mode: executable ? 0o755 : 0o644 });
        return `wrote ${relative(root, abs)}`;
      },
    }),
    run: tool({
      description:
        `Run a program to validate an enforcer (e.g. semgrep --test, a test runner, tlc). ` +
        `Allowed: ${[...RUNNABLE].join(", ")}, or a script you wrote in ${relative(root, outDir)}/. ` +
        `No shell. Runs in the repo root.`,
      inputSchema: z.object({ argv: z.array(z.string()).min(1) }),
      execute: async ({ argv }) => {
        const bin = argv[0]!;
        const script = bin.includes("/") && !isAbsolute(bin);
        if (script) inside(root, bin, outDir); // throws outside .verdict/
        else if (!RUNNABLE.has(bin)) throw new Error(`${bin} is not allowed`);
        else if (!Bun.which(bin)) return `${bin} is not installed`;
        const r = await exec(argv, { cwd: root, timeoutMs: 5 * 60_000 });
        return tail(`exit ${r.code}\n${r.output}`, 200);
      },
    }),
  };
}
