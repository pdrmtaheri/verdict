// Tools that agents (the LLM judge and the planner) use to look at the repo.
// Every path is confined to the repo root.
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { defineTool } from "./agent.ts";
import { exec, tail } from "./exec.ts";
import { sandboxed, sandboxFailure } from "./sandbox.ts";
import { withScratch } from "./scratch.ts";

const MAX_READ = 100_000;

// Resolves symlinks on the deepest ancestor that exists (as a file, directory
// or link), so links can't escape. A dangling link can't be resolved, and
// writing through one would create its target wherever it points, so it's refused.
function real(p: string): string {
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

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
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

// Read-only git, with an allowlist of flags per subcommand: git has many flags
// that read or write files (--output, --no-index, -S<file>, --contents,
// --ignore-revs-file, --orderfile…), so only known-safe ones pass. Flags that
// take a value are written --flag=value, or listed in TAKES_VALUE. Every other
// argument is a revision or a path, and paths must stay in the repo.
const COMMON = ["--no-color", "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "-p", "--patch", "--no-patch", "-w", "--ignore-all-space", "--word-diff", "--summary", "-M", "--find-renames", "--diff-filter=", "--unified=", "-U"];
const GIT_FLAGS: Record<string, string[]> = {
  diff: [...COMMON, "--cached", "--staged", "--merge-base"],
  log: [...COMMON, "--oneline", "-n", "--max-count=", "--since=", "--until=", "--author=", "--grep=", "--format=", "--pretty=", "--follow", "--reverse", "--no-merges", "--first-parent", "--all", "--date="],
  show: [...COMMON, "--oneline", "--format=", "--pretty=", "--date="],
  status: ["--short", "-s", "--porcelain", "--branch", "-b", "--untracked-files="],
  "ls-files": ["--cached", "-c", "--others", "-o", "--exclude-standard", "--deleted", "-d", "--modified", "-m"],
  blame: ["-L", "-w", "-e", "--porcelain", "-s", "-l", "--date="],
};
// Only flags whose value git always takes from the next argument. -U's value
// is optional and must be attached (-U3): git doesn't consume the next
// argument, so skipping it would let an unchecked flag through.
const TAKES_VALUE = new Set(["-n", "-L"]);

export function checkGitArgs(root: string, args: string[]): void {
  const [sub, ...rest] = args;
  const flags = GIT_FLAGS[sub ?? ""];
  if (!flags) throw new Error(`git ${sub} is not allowed; use one of ${Object.keys(GIT_FLAGS).join(", ")}`);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") continue;
    if (a.startsWith("-")) {
      const ok = flags.some((f) => (f.endsWith("=") ? a.startsWith(f) : a === f || ((f === "-n" || f === "-U") && new RegExp(`^${f}\\d+$`).test(a))));
      if (!ok) throw new Error(`git ${sub} ${a} is not allowed`);
      if (TAKES_VALUE.has(a)) {
        if (i + 1 >= rest.length) throw new Error(`git ${sub} ${a} needs a value`);
        i++; // git always takes the next argument as its value
      }
    } else if (lexists(resolve(root, a))) {
      inside(root, a); // a path: must stay in the repo
    }
  }
}

export function readTools(root: string) {
  return {
    read_file: defineTool({
      description: "Read a text file in the repository.",
      schema: z.object({ path: z.string().describe("Path relative to the repo root") }),
      execute: async ({ path }) => {
        const text = readFileSync(inside(root, path), "utf8");
        return text.length > MAX_READ ? text.slice(0, MAX_READ) + "\n…(truncated)" : text;
      },
    }),
    list_files: defineTool({
      description: "List files tracked in the repository (respects .gitignore). Optional glob filter.",
      schema: z.object({ glob: z.string().optional().describe('e.g. "src/**/*.ts"') }),
      execute: async ({ glob }) => {
        let files = await gitFiles(root);
        if (glob) {
          const g = new Bun.Glob(glob);
          files = files.filter((f) => g.match(f));
        }
        return files.slice(0, 2000).join("\n") || "(no files)";
      },
    }),
    grep: defineTool({
      description: "Search file contents with a regular expression. Returns path:line: text.",
      schema: z.object({
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
            const abs = inside(root, f); // a tracked symlink may point outside the repo
            if (statSync(abs).size > 1_000_000) continue;
            text = readFileSync(abs, "utf8");
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
    git: defineTool({
      description: `Run a read-only git command: ${Object.keys(GIT_FLAGS).join(", ")}, with common flags.`,
      schema: z.object({ args: z.array(z.string()).describe('e.g. ["diff", "--cached"]') }),
      execute: async ({ args }) => {
        checkGitArgs(root, args);
        const [sub, ...rest] = args;
        const safe = sub === "diff" || sub === "log" || sub === "show" ? ["--no-ext-diff", "--no-textconv"] : [];
        const r = await exec(["git", "--no-pager", sub!, ...safe, ...rest], {
          cwd: root,
          env: { GIT_CONFIG_NOSYSTEM: "1", GIT_EXTERNAL_DIFF: "" },
        });
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
    write_file: defineTool({
      description: `Create or overwrite a file. Only paths inside ${relative(root, outDir)}/ are allowed.`,
      schema: z.object({
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
    run: defineTool({
      description:
        `Run a program to validate an enforcer (e.g. semgrep --test, a test runner, tlc). ` +
        `Allowed: ${[...RUNNABLE].join(", ")}, or a script you wrote in ${relative(root, outDir)}/. ` +
        `No shell. Runs in a sandboxed scratch copy of the repo: it can't change the repo, ` +
        `read your home directory, or reach the network.`,
      schema: z.object({ argv: z.array(z.string()).min(1) }),
      execute: async ({ argv }) => {
        const bin = argv[0]!;
        const script = bin.includes("/") && !isAbsolute(bin);
        if (script) inside(root, bin, outDir); // throws outside .verdict/
        else if (!RUNNABLE.has(bin)) throw new Error(`${bin} is not allowed`);
        else if (!Bun.which(bin)) return `${bin} is not installed`;
        const r = await withScratch(root, async (dir) => {
          const box = sandboxed(argv, { readable: [dir, root], writable: [dir], network: false }, dir);
          return exec(box.argv, { cwd: dir, env: box.env, cleanEnv: true, timeoutMs: 5 * 60_000 });
        });
        const broken = r.code !== 0 ? sandboxFailure(r.output) : null;
        if (broken) throw new Error(`couldn't start verdict's sandbox (${broken})`);
        return tail(`exit ${r.code}\n${r.output}`, 200);
      },
    }),
  };
}
