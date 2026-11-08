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

export interface Context {
  root: string; // the repo the enforcer lives in (.verdict/, the lock)
  law: string;
  path: string; // enforcer file, relative to root
  // Where the code under check is: the repo root when unset. Enforcers are told
  // through VERDICT_TARGET (and semgrep is pointed at it), so the same enforcer
  // can judge another folder of code, such as a version, without copying it.
  target?: string;
  // Paths inside the target that are not part of the code under check, such as
  // the other versions' folders. semgrep skips them; scripts get them in
  // VERDICT_EXCLUDE, separated by ":".
  exclude?: string[];
  // Set while planning: root is a scratch copy, and every program runs in the
  // OS sandbox, writing only to `writable` (default: root). `readable` is what
  // else it may read. A check that must not change anything passes writable: [].
  sandbox?: { readable: string[]; writable?: string[] };
}

const targetOf = (ctx: Context) => ctx.target ?? ctx.root;

// Runs a program for an enforcer, in the sandbox when the context asks for one.
// Every program gets VERDICT_TARGET: the folder of code the enforcer should look at.
async function run(ctx: Context, argv: string[], o: { cwd?: string; readable?: string[]; writable?: string[] } = {}): Promise<ExecResult> {
  const target = targetOf(ctx);
  const env: Record<string, string> = { VERDICT_TARGET: target };
  if (ctx.exclude?.length) env.VERDICT_EXCLUDE = ctx.exclude.join(":");
  const cwd = o.cwd ?? ctx.root;
  if (!ctx.sandbox) return exec(argv, { cwd, env });
  const box = sandboxed(
    argv,
    { readable: [ctx.root, target, ...ctx.sandbox.readable, ...(o.readable ?? [])], writable: [...(ctx.sandbox.writable ?? [ctx.root]), ...(o.writable ?? [])], network: false, env },
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
  const exe = which(root, "semgrep");
  if (!exe) return inconclusive("semgrep is not installed (https://semgrep.dev/docs/getting-started)");
  const target = targetOf(ctx);
  // Skipping a path means scanning its siblings: semgrep's --exclude hangs inside the sandbox.
  const skip = new Set(ctx.exclude ?? []);
  const targets = skip.size ? readdirSync(target).filter((n) => !skip.has(n)).map((n) => join(target, n)) : [target];
  if (targets.length === 0) return pass("nothing to scan");
  const r = await run(ctx, [exe, "scan", "--config", path, "--error", "--metrics", "off", "--disable-version-check", "--quiet", ...targets]);
  if (r.code === 0) return pass();
  if (r.code === 1) return fail(tail(r.output));
  return inconclusive(`semgrep exited ${r.code}\n${tail(r.output)}`);
};

// ---------------------------------------------------------------- tests
// The runner is inferred from the file name and the repo's own tooling.

function deps(root: string): Record<string, string> {
  const pkg = join(root, "package.json");
  if (!existsSync(pkg)) return {};
  const json = JSON.parse(readFileSync(pkg, "utf8"));
  return { ...json.dependencies, ...json.devDependencies };
}

export function testCommand(root: string, file: string): string[] | null {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) {
    const d = deps(root);
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
  const argv = testCommand(root, path);
  if (!argv) return inconclusive(`don't know how to run ${path}`);
  if (!argv[0]!.startsWith("./") && !which(root, argv[0]!)) return inconclusive(`${argv[0]} is not installed`);
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
  const target = targetOf(ctx);
  const stale = staleReason(root, path, target); // cheap, and the reason a code change makes this enforcer fail
  if (stale && target !== root) return inconclusive(`this spec describes the main code, and "${relative(root, target) || "."}" differs from it, so only the replay test says whether that code conforms`);
  if (stale) return fail(stale);
  const jar = process.env.VERDICT_TLA2TOOLS;
  const onPath = Bun.which("tlc");
  if (!onPath && !jar) return inconclusive("TLC is not installed (put tlc on PATH or set VERDICT_TLA2TOOLS to tla2tools.jar)");
  // TLC's state files go in a temp directory the sandbox is told it may write to.
  const meta = mkdtempSync(join(tmpdir(), "verdict-tlc-"));
  try {
    // TLC unpacks its standard modules (Naturals, Sequences...) into Java's temp
    // directory, which the sandbox doesn't allow; point it at the writable one.
    const tmpOpt = `-Djava.io.tmpdir=${meta}`;
    const tlc = onPath ? ["env", `JAVA_TOOL_OPTIONS=${tmpOpt}`, "tlc"] : ["java", tmpOpt, "-cp", jar!, "tlc2.TLC"];
    const r = await run(ctx, [...tlc, "-workers", "auto", "-metadir", meta, path], { readable: jar ? [jar] : [], writable: [meta] });
    if (r.code === 0) return pass();
    if (r.code >= 10 && r.code <= 14) return fail(tail(r.output));
    return inconclusive(`TLC exited ${r.code}\n${tail(r.output)}`);
  } finally {
    rmSync(meta, { recursive: true, force: true });
  }
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
  const state = await run(ctx, ["sh", "-c", spec.state_from], { cwd: targetOf(ctx) });
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
  const target = targetOf(ctx); // the judge reads the code under check; the notes come from the enforcer
  const hints = readFileSync(join(root, path), "utf8");
  const verdict = await runAgent({
    system: JUDGE_SYSTEM,
    prompt: `Law: ${law}\n\nNotes from the plan:\n${hints}`,
    tools: readTools(target),
    cwd: target,
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
