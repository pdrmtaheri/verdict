// How each enforcer kind runs. Every kind observes the repo from outside.
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { experimental_decide } from "ai";
import { z } from "zod";
import { runAgent } from "./agent.ts";
import { exec, tail, which, type ExecResult } from "./exec.ts";
import { sandboxed, sandboxFailure, SandboxUnavailable } from "./sandbox.ts";
import { decisionModel } from "./models.ts";
import { fail, inconclusive, pass, type Result } from "./result.ts";
import { staleReason } from "./specbind.ts";
import { readTools } from "./tools.ts";
import { runLint } from "./linters.ts";

export interface Context {
  root: string; // the law's directory: enforcers run here
  repo?: string; // the repository root (defaults to root): what may be read
  law: string;
  path: string; // enforcer file, relative to root
  name?: string; // the one test to run, in a file that has others
  rule?: string; // lint: the rule in the project's config (path is the config)
  scope?: string; // lint: the files the rule must hold for
  // Where the code under check is: the law's directory when unset. Enforcers are
  // told through VERDICT_TARGET (and semgrep is pointed at it), so the same
  // enforcer can judge another folder of code, such as a version, without
  // copying it.
  target?: string;
  // Paths inside the target that are not part of the code under check, such as
  // the other versions' folders. semgrep skips them; scripts get them in
  // VERDICT_EXCLUDE, separated by ":".
  exclude?: string[];
  // Set while planning: root is a scratch copy, and every program runs in the
  // OS sandbox, writing only to the repo (or to `writable`). `readable` is what
  // else it may read. A check that must not change anything passes writable: [].
  sandbox?: { readable: string[]; writable?: string[] };
}

const targetOf = (ctx: Context) => ctx.target ?? ctx.root;

// Runs a program for an enforcer, in the sandbox when the context asks for one.
// Every program gets VERDICT_TARGET: the folder of code the enforcer should look at.
async function run(ctx: Context, argv: string[], extraReadable: string[] = [], env: Record<string, string> = {}, o: { cwd?: string; writable?: string[] } = {}): Promise<ExecResult> {
  const target = targetOf(ctx);
  const full: Record<string, string> = { VERDICT_TARGET: target, ...env };
  if (ctx.exclude?.length) full.VERDICT_EXCLUDE = ctx.exclude.join(":");
  const cwd = o.cwd ?? ctx.root;
  if (!ctx.sandbox) return exec(argv, { cwd, env: full });
  // Write access covers the whole (scratch) repo: a nested law's tests may
  // build or cache at the repo root, as in a monorepo.
  const repo = ctx.repo ?? ctx.root;
  const box = sandboxed(
    argv,
    { readable: [repo, target, ...ctx.sandbox.readable, ...extraReadable], writable: [...(ctx.sandbox.writable ?? [repo]), ...(o.writable ?? [])], network: false, env: full },
    cwd,
  );
  const r = await exec(box.argv, { cwd, env: box.env, cleanEnv: true });
  const broken = r.code !== 0 ? sandboxFailure(r.output) : null;
  if (broken) {
    throw new SandboxUnavailable(`couldn't start verdict's sandbox (${broken}). If verdict itself already runs in a sandbox, set VERDICT_SANDBOX=off`);
  }
  return r;
}

type Runner = (ctx: Context) => Promise<Result>;

// ---------------------------------------------------------------- semgrep
// The only pattern-rule engine. Type-aware rules run as tests (see plan.ts).
// Exit 0 = pass, 1 = findings, anything else = semgrep itself failed.

const semgrep: Runner = async (ctx) => {
  const { root, path } = ctx;
  const exe = findBin(root, "semgrep", ctx.repo ?? root);
  if (!exe) return inconclusive("semgrep is not installed (https://semgrep.dev/docs/getting-started)");
  // Skipping a path means scanning its siblings: semgrep's --exclude hangs inside the sandbox.
  const target = targetOf(ctx);
  const skip = new Set(ctx.exclude ?? []);
  const targets = skip.size ? readdirSync(target).filter((n) => !skip.has(n)).map((n) => join(target, n)) : [target === root ? "." : target];
  if (targets.length === 0) return pass("nothing to scan");
  const r = await run(ctx, [exe, "scan", "--config", path, "--error", "--metrics", "off", "--disable-version-check", "--quiet", ...targets]);
  if (r.code === 0) return pass();
  if (r.code === 1) return fail(`${tail(r.output)}\nFix the code at the findings above, or edit the law in VERDICT.md if it no longer holds`);
  return inconclusive(`semgrep exited ${r.code}: run \`semgrep --validate --config ${path}\` to see what's wrong with the rule, fix it or run \`verdict plan --again\`\n${tail(r.output)}`);
};

// A tool in node_modules/.bin from the law's directory up to the repo root,
// then on PATH.
function findBin(root: string, bin: string, repo = root): string | null {
  for (let dir = root; ; dir = dirname(dir)) {
    const local = join(dir, "node_modules", ".bin", bin);
    if (existsSync(local)) return local;
    if (dir === repo || dir === dirname(dir)) return which(root, bin);
  }
}

// ---------------------------------------------------------------- tests
// The runner is inferred from the file name and the repo's own tooling.

// The nearest package.json from the law's directory up to the repo root.
function deps(root: string, repo = root): Record<string, string> {
  for (let dir = root; ; dir = dirname(dir)) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, "utf8"));
      return { ...json.dependencies, ...json.devDependencies };
    }
    if (dir === repo || dir === dirname(dir)) return {};
  }
}

type TestRunner = "playwright" | "vitest" | "jest" | "bun" | "go" | "pytest" | "script";

// Test names are matched as regular expressions by most runners: match this one exactly.
const exactly = (name: string) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

export function testCommand(root: string, file: string, repo = root, name?: string): { runner: TestRunner; argv: string[] } | null {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) {
    const d = deps(root, repo);
    const which = (r: string, bin: string) => findBin(r, bin, repo);
    // JS runners match the full name ("describe block test name"), so the
    // name is matched as a suffix rather than anchored at both ends.
    const pattern = name ? exactly(name).slice(1) : "";
    if (d["@playwright/test"] && /\.spec\./.test(file)) return { runner: "playwright", argv: [which(root, "playwright") ?? "playwright", "test", file, ...(name ? ["-g", pattern] : [])] };
    if (d.vitest) return { runner: "vitest", argv: [which(root, "vitest") ?? "vitest", "run", file, ...(name ? ["-t", pattern] : [])] };
    if (d.jest) return { runner: "jest", argv: [which(root, "jest") ?? "jest", file, ...(name ? ["-t", pattern] : [])] };
    return { runner: "bun", argv: ["bun", "test", `./${file}`, ...(name ? ["-t", pattern] : [])] };
  }
  if (file.endsWith("_test.go")) return { runner: "go", argv: ["go", "test", "-v", `./${dirname(file)}`, ...(name ? ["-run", exactly(name)] : [])] };
  if (/(^|\/)test_[^/]*\.py$|_test\.py$/.test(file)) return { runner: "pytest", argv: ["python3", "-m", "pytest", name ? `${file}::${name}` : file] };
  if (name) return null; // a script is one test
  if (statSync(join(root, file)).mode & 0o111) return { runner: "script", argv: [`./${file}`] };
  return null;
}

// How many tests passed, from the runner's summary; null if it can't tell.
// A run where every test was skipped, filtered out or excluded exits 0 on
// most runners, and a pass that ran nothing proves nothing.
export function passedCount(runner: TestRunner, output: string): number | null {
  const n = (re: RegExp) => {
    const m = re.exec(output);
    return m ? Number(m[1]) : null;
  };
  switch (runner) {
    case "bun":
      return n(/^\s*(\d+) pass\b/m);
    case "vitest":
      return /^\s*Tests\s/m.test(output) ? (n(/^\s*Tests\s.*?(\d+) passed/m) ?? 0) : null;
    case "jest":
      return /^Tests:/m.test(output) ? (n(/^Tests:.*?(\d+) passed/m) ?? 0) : null;
    case "playwright":
    case "pytest":
      return n(/(\d+) passed/) ?? (/(\d+) skipped/.test(output) ? 0 : null);
    case "go":
      return /no tests to run/.test(output) ? 0 : (output.match(/^\s*--- PASS/gm)?.length ?? null);
    case "script":
      return null;
  }
}

const test: Runner = async (ctx) => {
  const { root, path, name } = ctx;
  const cmd = testCommand(root, path, ctx.repo ?? root, name);
  if (!cmd) {
    return name
      ? fail(`${path} is run as one script, so it can't select the test "${name}": remove the name from VERDICT.lock, or run \`verdict plan\``)
      : inconclusive(`verdict can't tell how to run ${path}: name it *.test.ts, *_test.go, test_*.py or similar, or make it executable`);
  }
  const { runner, argv } = cmd;
  if (!argv[0]!.startsWith("./") && !findBin(root, argv[0]!, ctx.repo ?? root)) {
    return inconclusive(`${argv[0]} is not installed: install it (or add it to the project's dev dependencies), then run verdict check again`);
  }
  const r = await run(ctx, argv);
  if (r.code === 0) {
    if (passedCount(runner, r.output) === 0) {
      const what = name ? `the test "${name}" in ${path}` : path;
      return fail(`${what} ran no tests: it is skipped, filtered out or excluded by the runner's config. Un-skip it, or run \`verdict plan\` if it moved\n${tail(r.output, 10)}`);
    }
    return pass();
  }
  // 77 is the automake "skipped" code: a precondition the test needs is missing.
  if (r.code === SKIPPED) return inconclusive(`${path} needs something that isn't here (a service, a credential, seed data; its output below says what): provide it, then run verdict check again\n${tail(r.output, 10)}`);
  return fail(`${tail(r.output)}\nRun ${argv.join(" ")} to see the failure; fix the code, or edit the law in VERDICT.md if it no longer holds`);
};

export const SKIPPED = 77;

// ---------------------------------------------------------------- lint
// A rule the project's own linter has (see linters.ts).

const lint: Runner = async (ctx) => {
  const { root, path, rule, scope } = ctx;
  if (!rule || !scope) return fail(`the lint enforcer ${path} needs a rule and a scope in VERDICT.lock: run \`verdict plan\` to re-plan the law`);
  const warnings: string[] = [];
  const r = await runLint(
    { root, config: path, rule, scope, run: (argv, env) => run(ctx, argv, [], env), bin: (name) => findBin(root, name, ctx.repo ?? root) },
    (w) => warnings.push(w),
  );
  return warnings.length ? { ...r, warnings } : r;
};

// ---------------------------------------------------------------- TLA+
// TLC exit codes: 0 ok, 10-14 a property was violated, others are errors.

const tla: Runner = async (ctx) => {
  const { root, path } = ctx;
  const target = targetOf(ctx);
  const stale = staleReason(root, path, target); // cheap, and the reason a code change makes this enforcer fail
  if (stale && target !== root) return inconclusive(`this spec describes the main code, and "${relative(root, target) || "."}" differs from it, so only the replay test says whether that code conforms`);
  if (stale) return fail(stale);
  const jar = process.env.VERDICT_TLA2TOOLS;
  const tlc = Bun.which("tlc") ? ["tlc"] : jar ? ["java", "-cp", jar, "tlc2.TLC"] : null;
  if (!tlc) return inconclusive("TLC is not installed (put tlc on PATH or set VERDICT_TLA2TOOLS to tla2tools.jar)");
  // TLC's state files go in a temp directory the sandbox is told it may write to.
  const meta = mkdtempSync(join(tmpdir(), "verdict-tlc-"));
  // TLC unpacks its standard modules (Naturals, Sequences…) into Java's temp
  // directory, which comes from java.io.tmpdir, not TMPDIR. Point it at a
  // directory it may write, or every spec fails with "Cannot find … Naturals".
  const env = { JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ""} -Djava.io.tmpdir=${meta}`.trim() };
  let r;
  try {
    r = await run(ctx, [...tlc, "-workers", "auto", "-metadir", meta, path], jar ? [jar] : [], env, { writable: [meta] });
  } finally {
    rmSync(meta, { recursive: true, force: true });
  }
  if (r.code === 0) return pass();
  if (r.code >= 10 && r.code <= 14) return fail(`${tail(r.output)}\nTLC found a behaviour that breaks the spec (trace above): fix the design in the code, or edit the law in VERDICT.md if it no longer holds`);
  return inconclusive(`TLC exited ${r.code} without checking the spec (error below): fix ${path}, or run \`verdict plan --again\` to re-plan the law\n${tail(r.output)}`);
};

// ---------------------------------------------------------------- decision models (jev)
// The file says where the state comes from and what to ask. Choices are
// always pass / fail / inconclusive, so no mapping is needed.

const DecisionFile = z.object({
  scope: z.string().optional(),
  state_from: z.string(),
  instructions: z.string(),
  criteria: z.object({ pass: z.string(), fail: z.string(), inconclusive: z.string() }),
  min_probability: z.number().min(0).max(1).default(0.85),
});

const decision: Runner = async (ctx) => {
  const { root, path } = ctx;
  const spec = DecisionFile.parse(JSON.parse(readFileSync(join(root, path), "utf8")));
  const state = await run(ctx, ["sh", "-c", spec.state_from], [], {}, { cwd: targetOf(ctx) });
  if (state.code !== 0) return inconclusive(`state_from in ${path} exited ${state.code} (output below): fix the command, or run \`verdict plan --again\` to re-plan the law\n${tail(state.output)}`);
  if (state.output === "") return pass("state_from produced nothing to judge");
  const result = await experimental_decide({
    model: decisionModel(),
    state: state.output,
    questions: { verdict: { type: "choice", instructions: spec.instructions, criteria: spec.criteria } },
  });
  const answer = result.answers.verdict;
  const p = answer.probabilities?.[answer.choice];
  if (answer.choice === "inconclusive") return inconclusive(`the decision model can't tell from what state_from in ${path} prints: add an llm judge to this law (run \`verdict plan --again\`), or make state_from print what decides it`);
  if (p == null || p < spec.min_probability) {
    return inconclusive(`the decision model leaned ${answer.choice} at p=${p?.toFixed(2) ?? "?"}, below ${spec.min_probability}: add an llm judge to this law (run \`verdict plan --again\`) to settle it, or sharpen the criteria in ${path}`);
  }
  return answer.choice === "pass" ? pass() : fail(`the decision model judged it false (p=${p.toFixed(2)}): run \`${spec.state_from}\` to see what it judged, then fix that, or edit the law in VERDICT.md if it no longer holds`);
};

// ---------------------------------------------------------------- LLM judge

const JUDGE_SYSTEM = `You check whether one law holds for a software repository.
You can read files, search, and run read-only git commands. Look for evidence
before deciding. When done, call submit exactly once.
- pass: you found evidence the law holds and none that it is broken.
- fail: you found a concrete violation. Quote the file and line.
- inconclusive: you can't tell from what the repository shows.`;

const Verdict = z.object({
  status: z.enum(["pass", "fail", "inconclusive"]),
  reason: z.string().describe("One or two sentences. For fail, name file:line."),
});

const llm: Runner = async (ctx) => {
  const { root, law, path } = ctx;
  const hints = readFileSync(join(root, path), "utf8");
  const verdict = await runAgent({
    system: JUDGE_SYSTEM,
    prompt: `Law: ${law}\n\nNotes from the plan:\n${hints}`,
    tools: readTools(ctx.target ?? root, ctx.target ?? ctx.repo ?? root), // the judge reads the code under check
    cwd: ctx.target ?? root,
    submit: { description: "Report your verdict on the law.", schema: Verdict },
  });
  if (!verdict) return inconclusive("the judge stopped without a verdict: run verdict check again, or set a stronger VERDICT_MODEL or VERDICT_REASONING=high");
  // The judge's reason says where; verdict adds what to do about it.
  const next =
    verdict.status === "fail"
      ? "Fix the code it names, or edit the law in VERDICT.md if it no longer holds"
      : verdict.status === "inconclusive"
        ? `Add hints to ${path} on where to look, or run \`verdict plan --again\` to re-plan the law`
        : "";
  return { status: verdict.status, message: next ? `${verdict.reason}\n${next}` : verdict.reason };
};

// ---------------------------------------------------------------- scope
// Every enforcer file says what it covers: a "scope:" line near the top in
// any comment style, or a "scope" field in JSON. `check` prints it on a pass,
// because a pass covers the model, the bound or the files named, not the system.

export function scopeOf(root: string, path: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
  if (path.endsWith(".json")) {
    try {
      const scope = JSON.parse(text).scope;
      return typeof scope === "string" ? scope : null;
    } catch {
      return null;
    }
  }
  for (const line of text.split("\n").slice(0, 20)) {
    const m = /\bscope:\s*(.+?)\s*(-->|\*\/)?\s*$/i.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

// ---------------------------------------------------------------- registry

export const RUNNERS: Record<string, Runner> = {
  semgrep,
  lint,
  test,
  tla,
  decision,
  llm,
};

export const KINDS = Object.keys(RUNNERS);

export async function runEnforcer(kind: string, ctx: Context): Promise<Result> {
  const runner = RUNNERS[kind];
  // The planner only writes known kinds, so this is a hand edit or a typo:
  // a law that can't be checked is not a pass.
  if (!runner) return fail(`unknown enforcer kind "${kind}" in VERDICT.lock: fix it to one of ${KINDS.join(", ")}, or delete the entry and run \`verdict plan\``);
  if (ctx.name && kind !== "test") return fail(`only test enforcers can name a test, but the ${kind} enforcer ${ctx.path} names "${ctx.name}": remove the name from VERDICT.lock, or run \`verdict plan\``);
  if (!existsSync(join(ctx.root, ctx.path))) return fail(`${ctx.path} is missing: restore it from git, or run \`verdict plan\` to plan the law again`);
  try {
    return await runner(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return inconclusive(/: (run|set|install|add|fix|restore|edit|remove|check)\b/i.test(message) ? message : `${message}\n(${kind} enforcer ${ctx.path} crashed: fix the error above, or run \`verdict plan --again\` to re-plan the law)`);
  }
}
