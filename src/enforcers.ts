// How each enforcer kind runs. Every kind observes the repo from outside.
import { existsSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { experimental_decide } from "ai";
import { z } from "zod";
import { runAgent } from "./agent.ts";
import { exec, tail, which, type ExecResult } from "./exec.ts";
import { sandboxed, sandboxFailure, SandboxUnavailable } from "./sandbox.ts";
import { decisionModel } from "./models.ts";
import { fail, inconclusive, pass, type Result } from "./result.ts";
import { readTools } from "./tools.ts";

export interface Context {
  root: string; // the law's directory: enforcers run here
  repo?: string; // the repository root (defaults to root): what may be read
  law: string;
  path: string; // enforcer file, relative to root
  // Set while planning: root is a scratch copy, and every program runs in the
  // OS sandbox, writing only to root. `readable` is what else it may read.
  sandbox?: { readable: string[] };
}

// Runs a program for an enforcer, in the sandbox when the context asks for one.
async function run(ctx: Context, argv: string[], extraReadable: string[] = []): Promise<ExecResult> {
  if (!ctx.sandbox) return exec(argv, { cwd: ctx.root });
  // Write access covers the whole (scratch) repo: a nested law's tests may
  // build or cache at the repo root, as in a monorepo.
  const repo = ctx.repo ?? ctx.root;
  const box = sandboxed(argv, { readable: [repo, ...ctx.sandbox.readable, ...extraReadable], writable: [repo], network: false }, ctx.root);
  const r = await exec(box.argv, { cwd: ctx.root, env: box.env, cleanEnv: true });
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
  const r = await run(ctx, [exe, "scan", "--config", path, "--error", "--metrics", "off", "--quiet"]);
  if (r.code === 0) return pass();
  if (r.code === 1) return fail(tail(r.output));
  return inconclusive(`semgrep exited ${r.code}\n${tail(r.output)}`);
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

export function testCommand(root: string, file: string, repo = root): string[] | null {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) {
    const d = deps(root, repo);
    const which = (r: string, bin: string) => findBin(r, bin, repo);
    if (d["@playwright/test"] && /\.spec\./.test(file)) return [which(root, "playwright") ?? "playwright", "test", file];
    if (d.vitest) return [which(root, "vitest") ?? "vitest", "run", file];
    if (d.jest) return [which(root, "jest") ?? "jest", file];
    return ["bun", "test", `./${file}`];
  }
  if (/_test\.go$/.test(file)) return ["go", "test", `./${dirname(file)}`];
  if (/(^|\/)test_[^/]*\.py$|_test\.py$/.test(file)) return ["python3", "-m", "pytest", file];
  if (statSync(join(root, file)).mode & 0o111) return [`./${file}`];
  return null;
}

const test: Runner = async (ctx) => {
  const { root, path } = ctx;
  const argv = testCommand(root, path, ctx.repo ?? root);
  if (!argv) return inconclusive(`don't know how to run ${path}`);
  if (!argv[0]!.startsWith("./") && !findBin(root, argv[0]!, ctx.repo ?? root)) return inconclusive(`${argv[0]} is not installed`);
  const r = await run(ctx, argv);
  if (r.code === 0) return pass();
  // 77 is the automake "skipped" code: a precondition the test needs is missing.
  if (r.code === SKIPPED) return inconclusive(`a precondition is missing\n${tail(r.output, 10)}`);
  return fail(tail(r.output));
};

export const SKIPPED = 77;

// ---------------------------------------------------------------- TLA+
// TLC exit codes: 0 ok, 10-14 a property was violated, others are errors.

const tla: Runner = async (ctx) => {
  const { root, path } = ctx;
  const jar = process.env.VERDICT_TLA2TOOLS;
  const tlc = Bun.which("tlc") ? ["tlc"] : jar ? ["java", "-cp", jar, "tlc2.TLC"] : null;
  if (!tlc) return inconclusive("TLC is not installed (put tlc on PATH or set VERDICT_TLA2TOOLS to tla2tools.jar)");
  // TLC's state files go inside root when sandboxed, the only place it may write.
  const meta = mkdtempSync(ctx.sandbox ? join(root, ".tlc-") : join(tmpdir(), "verdict-tlc-"));
  const r = await run(ctx, [...tlc, "-workers", "auto", "-metadir", meta, path], jar ? [jar] : []);
  if (r.code === 0) return pass();
  if (r.code >= 10 && r.code <= 14) return fail(tail(r.output));
  return inconclusive(`TLC exited ${r.code}\n${tail(r.output)}`);
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
  const state = await run(ctx, ["sh", "-c", spec.state_from]);
  if (state.code !== 0) return inconclusive(`state_from exited ${state.code}\n${tail(state.output)}`);
  if (state.output === "") return pass("state_from produced nothing to judge");
  const result = await experimental_decide({
    model: decisionModel(),
    state: state.output,
    questions: { verdict: { type: "choice", instructions: spec.instructions, criteria: spec.criteria } },
  });
  const answer = result.answers.verdict;
  const p = answer.probabilities?.[answer.choice];
  if (answer.choice === "inconclusive") return inconclusive("the decision model can't tell");
  if (p == null || p < spec.min_probability) {
    return inconclusive(`the decision model leaned ${answer.choice} at p=${p?.toFixed(2) ?? "?"}, below ${spec.min_probability}`);
  }
  return answer.choice === "pass" ? pass() : fail(`the decision model judged it false (p=${p.toFixed(2)})`);
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
    tools: readTools(root, ctx.repo ?? root),
    cwd: root,
    submit: { description: "Report your verdict on the law.", schema: Verdict },
  });
  if (!verdict) return inconclusive("the judge did not reach a verdict");
  return { status: verdict.status, message: verdict.reason };
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
  test,
  tla,
  decision,
  llm,
};

export const KINDS = Object.keys(RUNNERS);

export async function runEnforcer(kind: string, ctx: Context): Promise<Result> {
  const runner = RUNNERS[kind];
  if (!runner) return inconclusive(`unknown enforcer kind "${kind}"`);
  if (!existsSync(join(ctx.root, ctx.path))) return fail(`${ctx.path} is missing`);
  try {
    return await runner(ctx);
  } catch (err) {
    return inconclusive(err instanceof Error ? err.message : String(err));
  }
}
