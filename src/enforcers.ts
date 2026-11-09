// How each enforcer kind runs. Every kind observes the repo from outside.
// This is the one module that knows the kinds: how each runs, and what the
// planner may submit for each (vet).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { experimental_decide } from "ai";
import { z } from "zod";
import { runAgent } from "./agent.ts";
import { exec, tail, type ExecResult } from "./exec.ts";
import { errorMessage, findBin, inside, isInside, nearest, packageDeps } from "./fsx.ts";
import { LINTERS, linterFor, runLint, scopeFiles } from "./linters.ts";
import type { Enforcer } from "./lock.ts";
import { decisionModel } from "./models.ts";
import JUDGE from "./prompts/judge.md" with { type: "text" };
import { fail, inconclusive, pass, type Result } from "./result.ts";
import { bunCommand } from "./runtime.ts";
import { execBoxed } from "./sandbox.ts";
import { modelsOf, staleReason } from "./specbind.ts";
import { readTools } from "./tools.ts";
import { OUT_DIR, type Where } from "./where.ts";

export const KINDS = ["semgrep", "lint", "test", "tla", "decision", "llm"] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (kind: string): kind is Kind => (KINDS as readonly string[]).includes(kind);

// Where and how an enforcer runs. `where.dir` is the law's directory, where
// enforcers run; `where.repo` bounds what they may read.
export interface RunSite {
  where: Where;
  law: string;
  // Where the code under check is: the law's directory when unset. Enforcers are
  // told through VERDICT_TARGET (and semgrep is pointed at it), so the same
  // enforcer can judge another folder of code, such as a version, without
  // copying it.
  target?: string;
  // Paths inside the target that are not part of the code under check, such as
  // the other versions' folders. semgrep skips them; scripts get them in
  // VERDICT_EXCLUDE, separated by ":".
  exclude?: string[];
  // Set while planning: the law's directory is in a scratch copy, and every
  // program runs in the OS sandbox, writing only to the repo (or to
  // `writable`). `readable` is what else it may read. A check that must not
  // change anything passes writable: [].
  sandbox?: { readable: string[]; writable?: string[] };
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  readable?: string[]; // besides the repo and the target
  writable?: string[]; // besides the sandbox's own
}

const targetOf = (site: RunSite): string => site.target ?? site.where.dir;
const bin = (site: RunSite, name: string): string | null => findBin(site.where.dir, name, site.where.repo);

// Runs a program for an enforcer, in the sandbox when the site asks for one.
// Every program gets VERDICT_TARGET: the folder of code the enforcer should look at.
function run(site: RunSite, argv: string[], o: RunOptions = {}): Promise<ExecResult> {
  const { where, sandbox } = site;
  const target = targetOf(site);
  const env: Record<string, string> = { VERDICT_TARGET: target, ...o.env };
  if (site.exclude?.length) env.VERDICT_EXCLUDE = site.exclude.join(":");
  const cwd = o.cwd ?? where.dir;
  if (!sandbox) return exec(argv, { cwd, env });
  // Write access covers the whole (scratch) repo: a nested law's tests may
  // build or cache at the repo root, as in a monorepo.
  return execBoxed(
    argv,
    {
      readable: [where.repo, target, ...sandbox.readable, ...(o.readable ?? [])],
      writable: [...(sandbox.writable ?? [where.repo]), ...(o.writable ?? [])],
      network: false,
      env,
    },
    cwd,
  );
}

type Runner = (e: Enforcer, site: RunSite) => Promise<Result>;

// ---------------------------------------------------------------- semgrep
// The only pattern-rule engine. Type-aware rules run as tests (see plan.ts).
// Exit 0 = pass, 1 = findings, anything else = semgrep itself failed.

const semgrep: Runner = async ({ path }, site) => {
  const exe = bin(site, "semgrep");
  if (!exe) return inconclusive("semgrep is not installed (https://semgrep.dev/docs/getting-started)");
  // Skipping a path means scanning its siblings: semgrep's --exclude hangs inside the sandbox.
  const target = targetOf(site);
  const skip = new Set(site.exclude);
  const targets = skip.size > 0 ? readdirSync(target).filter((n) => !skip.has(n)).map((n) => join(target, n)) : [target === site.where.dir ? "." : target];
  if (targets.length === 0) return pass("nothing to scan");
  const r = await run(site, [exe, "scan", "--config", path, "--error", "--metrics", "off", "--disable-version-check", "--quiet", ...targets]);
  if (r.code === 0) return pass();
  if (r.code === 1) return fail(`${tail(r.output)}\nFix the code at the findings above, or edit the law in VERDICT.md if it no longer holds`);
  return inconclusive(`semgrep exited ${r.code}: run \`semgrep --validate --config ${path}\` to see what's wrong with the rule, fix it or run \`verdict plan --again\`\n${tail(r.output)}`);
};

// ---------------------------------------------------------------- tests
// The runner is inferred from the file name and the repo's own tooling.

// What the nearest package.json from the law's directory up to the repo root asks for.
function deps(root: string, repo: string): Record<string, string> {
  const pkg = nearest(root, "package.json", repo);
  return pkg ? packageDeps(pkg) : {};
}

type TestRunner = "playwright" | "vitest" | "jest" | "bun" | "go" | "pytest" | "script";

// Test names are matched as regular expressions by most runners: match this one exactly.
const exactly = (name: string) => `^${name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

export function testCommand(root: string, file: string, repo = root, name?: string): { runner: TestRunner; argv: string[] } | null {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) {
    const d = deps(root, repo);
    const local = (tool: string) => findBin(root, tool, repo);
    // JS runners match the full name ("describe block test name"), so the
    // name is matched as a suffix rather than anchored at both ends.
    const pattern = name ? exactly(name).slice(1) : "";
    if (d["@playwright/test"] && /\.spec\./.test(file)) return { runner: "playwright", argv: [local("playwright") ?? "playwright", "test", file, ...(name ? ["-g", pattern] : [])] };
    if (d.vitest) return { runner: "vitest", argv: [local("vitest") ?? "vitest", "run", file, ...(name ? ["-t", pattern] : [])] };
    if (d.jest) return { runner: "jest", argv: [local("jest") ?? "jest", file, ...(name ? ["-t", pattern] : [])] };
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

// 77 is the automake "skipped" code: a precondition the test needs is missing.
export const SKIPPED = 77;

const test: Runner = async ({ path, name }, site) => {
  const cmd = testCommand(site.where.dir, path, site.where.repo, name);
  if (!cmd) {
    return name
      ? fail(`${path} is run as one script, so it can't select the test "${name}": remove the name from VERDICT.lock, or run \`verdict plan\``)
      : inconclusive(`verdict can't tell how to run ${path}: name it *.test.ts, *_test.go, test_*.py or similar, or make it executable`);
  }
  const { runner } = cmd;
  let { argv } = cmd;
  let env: Record<string, string> = {};
  let readable: string[] = [];
  const [program = ""] = argv;
  if (runner === "bun") {
    // A compiled verdict carries its own Bun for bun tests when none is installed.
    const bun = bunCommand(bin(site, "bun"));
    argv = [bun.bin, ...argv.slice(1)];
    ({ env, readable } = bun);
  } else if (!program.startsWith("./") && !bin(site, program)) {
    return inconclusive(`${program} is not installed: install it (or add it to the project's dev dependencies), then run verdict check again`);
  }
  const r = await run(site, argv, { readable, env });
  if (r.code === 0) {
    if (passedCount(runner, r.output) === 0) {
      const what = name ? `the test "${name}" in ${path}` : path;
      return fail(`${what} ran no tests: it is skipped, filtered out or excluded by the runner's config. Un-skip it, or run \`verdict plan\` if it moved\n${tail(r.output, 10)}`);
    }
    return pass();
  }
  if (r.code === SKIPPED) return inconclusive(`${path} needs something that isn't here (a service, a credential, seed data; its output below says what): provide it, then run verdict check again\n${tail(r.output, 10)}`);
  return fail(`${tail(r.output)}\nRun ${[...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv].join(" ")} to see the failure; fix the code, or edit the law in VERDICT.md if it no longer holds`);
};

// ---------------------------------------------------------------- lint
// A rule the project's own linter has (see linters.ts).

const lint: Runner = async ({ path, rule, scope }, site) => {
  if (!rule || !scope) return fail(`the lint enforcer ${path} needs a rule and a scope in VERDICT.lock: run \`verdict plan\` to re-plan the law`);
  const warnings: string[] = [];
  const r = await runLint(
    { root: site.where.dir, config: path, rule, scope, run: (argv, env) => run(site, argv, { env }), bin: (name) => bin(site, name) },
    (w) => warnings.push(w),
  );
  return warnings.length > 0 ? { ...r, warnings } : r;
};

// ---------------------------------------------------------------- TLA+
// TLC exit codes: 0 ok, 10-14 a property was violated, others are errors.

const tla: Runner = async ({ path }, site) => {
  const root = site.where.dir;
  const target = targetOf(site);
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
  let r: ExecResult;
  try {
    r = await run(site, [...tlc, "-workers", "auto", "-metadir", meta, path], { readable: jar ? [jar] : [], env, writable: [meta] });
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

// How to run a shell command line: sh, or on Windows without one (Git for
// Windows ships sh), cmd.
function shell(): string[] {
  if (process.platform !== "win32" || Bun.which("sh")) return ["sh", "-c"];
  return ["cmd.exe", "/d", "/s", "/c"];
}

const decision: Runner = async ({ path }, site) => {
  const spec = DecisionFile.parse(JSON.parse(readFileSync(join(site.where.dir, path), "utf8")));
  const state = await run(site, [...shell(), spec.state_from], { cwd: targetOf(site) });
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
  if (p === undefined || p < spec.min_probability) {
    return inconclusive(`the decision model leaned ${answer.choice} at p=${p?.toFixed(2) ?? "?"}, below ${spec.min_probability}: add an llm judge to this law (run \`verdict plan --again\`) to settle it, or sharpen the criteria in ${path}`);
  }
  return answer.choice === "pass" ? pass() : fail(`the decision model judged it false (p=${p.toFixed(2)}): run \`${spec.state_from}\` to see what it judged, then fix that, or edit the law in VERDICT.md if it no longer holds`);
};

// ---------------------------------------------------------------- LLM judge

const Verdict = z.object({
  status: z.enum(["pass", "fail", "inconclusive"]),
  reason: z.string().describe("One or two sentences. For fail, name file:line."),
});

// What to do about a judge's verdict; its reason already says where.
const NEXT_STEP: Record<z.infer<typeof Verdict>["status"], (path: string) => string> = {
  pass: () => "",
  fail: () => "Fix the code it names, or edit the law in VERDICT.md if it no longer holds",
  inconclusive: (path) => `Add hints to ${path} on where to look, or run \`verdict plan --again\` to re-plan the law`,
};

const llm: Runner = async ({ path }, site) => {
  const hints = readFileSync(join(site.where.dir, path), "utf8");
  // The judge reads the code under check.
  const root = site.target ?? site.where.dir;
  const verdict = await runAgent({
    system: JUDGE,
    prompt: `Law: ${site.law}\n\nNotes from the plan:\n${hints}`,
    tools: readTools(root, site.target ?? site.where.repo),
    cwd: root,
    submit: { description: "Report your verdict on the law.", schema: Verdict },
  });
  if (!verdict) return inconclusive("the judge stopped without a verdict: run verdict check again, or set a stronger VERDICT_MODEL or VERDICT_REASONING=high");
  const next = NEXT_STEP[verdict.status](path);
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
      const parsed = z.object({ scope: z.string() }).safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.scope : null;
    } catch {
      return null;
    }
  }
  for (const line of text.split("\n").slice(0, 20)) {
    const m = /\bscope:\s*(.+?)\s*(-->|\*\/)?\s*$/i.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------- vet
// Whether the planner may submit this enforcer, as verdict will use it.
// Returns the reason to reject it, or null.

export function vet(w: Where, e: Enforcer, all: Enforcer[]): string | null {
  if (!isInside(w.dir, e.path, join(w.dir, OUT_DIR))) return vetExisting(w, e);
  if (e.kind === "lint") return `a lint enforcer points at the project's own linter config, not a file in ${OUT_DIR}/; to write a rule of your own, use semgrep`;
  if (!existsSync(join(w.dir, e.path))) return `${e.path} was not written`;
  if (!e.scope && !scopeOf(w.dir, e.path)) return `${e.path} has no "scope:" line`;
  if (e.kind !== "tla") return null;
  const models = modelsOf(readFileSync(join(w.dir, e.path), "utf8"));
  if (models.length === 0) return `${e.path} must name the code it models: add a comment line "models: <file>" for each file the spec describes. verdict stamps their hash, so a spec whose code changed fails, and a break to that code makes it fail`;
  const bad = models.find((m) => m.file.startsWith(OUT_DIR) || !existsSync(join(w.dir, m.file)));
  if (bad) return `${e.path} says it models ${bad.file}, which is not a file of the system under check`;
  if (!all.some((x) => x.kind !== "tla")) return `a spec only proves the design: submit a test that replays ${e.path} against the real code alongside it`;
  return null;
}

// A test or linter config the project already has: verdict points at it and
// never edits it.
function vetExisting(w: Where, e: Enforcer): string | null {
  try {
    inside(w.dir, e.path, w.repo);
  } catch (err) {
    return errorMessage(err);
  }
  if (e.kind !== "test" && e.kind !== "lint") return `${e.path} is outside ${OUT_DIR}/: only a test or a linter config the repo already has can be used where it is; write a ${e.kind} enforcer in ${OUT_DIR}/`;
  if (!existsSync(join(w.dir, e.path))) return `${e.path} doesn't exist`;
  if (!e.scope) return `${e.path} is the repo's own file: give its scope in the submission`;
  if (e.kind === "test") return null;
  if (!linterFor(e.path)) return `${e.path} isn't a config file verdict can read for lint (${LINTERS.map((l) => l.name).join(", ")}); for another linter, write an executable test in ${OUT_DIR}/ that runs it`;
  if (!e.rule) return `the lint enforcer ${e.path} needs the rule's id`;
  if (scopeFiles(w.dir, e.scope).length === 0) return `the scope "${e.scope}" matches no files: for lint it is globs relative to the law's directory`;
  return null;
}

// ---------------------------------------------------------------- registry

const RUNNERS: Record<Kind, Runner> = { semgrep, lint, test, tla, decision, llm };

export async function runEnforcer(e: Enforcer, site: RunSite): Promise<Result> {
  // The planner only writes known kinds, so this is a hand edit or a typo:
  // a law that can't be checked is not a pass.
  if (!isKind(e.kind)) return fail(`unknown enforcer kind "${e.kind}" in VERDICT.lock: fix it to one of ${KINDS.join(", ")}, or delete the entry and run \`verdict plan\``);
  if (e.name && e.kind !== "test") return fail(`only test enforcers can name a test, but the ${e.kind} enforcer ${e.path} names "${e.name}": remove the name from VERDICT.lock, or run \`verdict plan\``);
  if (!existsSync(join(site.where.dir, e.path))) return fail(`${e.path} is missing: restore it from git, or run \`verdict plan\` to plan the law again`);
  try {
    return await RUNNERS[e.kind](e, site);
  } catch (err) {
    const message = errorMessage(err);
    return inconclusive(/: (run|set|install|add|fix|restore|edit|remove|check)\b/i.test(message) ? message : `${message}\n(${e.kind} enforcer ${e.path} crashed: fix the error above, or run \`verdict plan --again\` to re-plan the law)`);
  }
}
