// Lint enforcers: a rule the project's own linter already has. verdict
// writes no lint rules of its own (Semgrep is for those); it points at one
// in the project's config, runs the linter under that config, and keeps only
// that rule's findings in the scope. The tool is inferred from the config's
// file name. Turning the rule off is reported directly when the linter can
// say so, and otherwise shows up when check replays the break.
import { basename } from "node:path";
import type { ExecResult } from "./exec.ts";
import { fail, inconclusive, pass, type Result } from "./result.ts";

export interface LintContext {
  root: string;
  config: string; // the config file, relative to root
  rule: string;
  scope: string; // globs relative to root, separated by spaces or commas
  run: (argv: string[]) => Promise<ExecResult>;
  bin: (name: string) => string | null;
}

interface Finding {
  file: string;
  line: number;
  message: string;
}

interface Linter {
  name: string;
  configs: RegExp;
  install: string;
  // Whether the rule is on for this file under the config; null if it can't tell.
  enabled: (ctx: LintContext, exe: string, file: string) => Promise<boolean | null>;
  findings: (ctx: LintContext, exe: string, files: string[]) => Promise<{ found: Finding[]; suppressed: number } | Result>;
}

const parse = (r: ExecResult): unknown => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

const eslint: Linter = {
  name: "eslint",
  configs: /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.(c?js|json|ya?ml))?)$/,
  install: "add eslint to the project's dev dependencies",
  async enabled(ctx, exe, file) {
    const r = await ctx.run([exe, "--config", ctx.config, "--print-config", file]);
    const cfg = r.code === 0 ? (parse(r) as { rules?: Record<string, unknown> } | null) : null;
    if (!cfg?.rules) return null;
    const setting = cfg.rules[ctx.rule];
    const level = Array.isArray(setting) ? setting[0] : setting;
    return level !== undefined && level !== 0 && level !== "off";
  },
  async findings(ctx, exe, files) {
    const r = await ctx.run([exe, "--config", ctx.config, "--format", "json", "--no-warn-ignored", ...files]);
    const out = parse(r) as { filePath: string; messages: { ruleId: string | null; line: number; message: string }[]; suppressedMessages?: { ruleId: string | null }[] }[] | null;
    if (!Array.isArray(out)) return inconclusive(`eslint exited ${r.code} without a report, so verdict can't read its findings. Fix the error below, then run verdict check again\n${r.output.split("\n").slice(-15).join("\n")}`);
    const found = out.flatMap((f) => f.messages.filter((m) => m.ruleId === ctx.rule).map((m) => ({ file: f.filePath, line: m.line, message: m.message })));
    const suppressed = out.reduce((n, f) => n + (f.suppressedMessages ?? []).filter((m) => m.ruleId === ctx.rule).length, 0);
    return { found, suppressed };
  },
};

const ruff: Linter = {
  name: "ruff",
  configs: /^(\.?ruff\.toml|pyproject\.toml)$/,
  install: "install ruff (https://docs.astral.sh/ruff/installation/)",
  async enabled(ctx, exe, file) {
    const r = await ctx.run([exe, "check", "--config", ctx.config, "--show-settings", file]);
    const m = /^linter\.rules\.enabled = \[\n([\s\S]*?)^\]/m.exec(r.stdout);
    if (!m) return null;
    return m[1]!.includes(`(${ctx.rule})`);
  },
  async findings(ctx, exe, files) {
    const r = await ctx.run([exe, "check", "--config", ctx.config, "--output-format", "json", "--no-fix", "--exit-zero", ...files]);
    const out = parse(r) as { code: string | null; filename: string; location: { row: number }; message: string }[] | null;
    if (!Array.isArray(out)) return inconclusive(`ruff exited ${r.code} without a report, so verdict can't read its findings. Fix the error below, then run verdict check again\n${r.output.split("\n").slice(-15).join("\n")}`);
    // ruff doesn't report what `# noqa` suppressed.
    return { found: out.filter((f) => f.code === ctx.rule).map((f) => ({ file: f.filename, line: f.location.row, message: f.message })), suppressed: 0 };
  },
};

export const LINTERS = [eslint, ruff];

export const linterFor = (config: string): Linter | undefined => LINTERS.find((l) => l.configs.test(basename(config)));

// The files a scope names, relative to root (dependency and VCS directories skipped).
export function scopeFiles(root: string, scope: string): string[] {
  const files = new Set<string>();
  for (const glob of scope.split(/[\s,]+/).filter(Boolean)) {
    for (const f of new Bun.Glob(glob).scanSync({ cwd: root, onlyFiles: true })) {
      if (!/(^|\/)(node_modules|\.git|\.venv|venv)\//.test(f)) files.add(f);
    }
  }
  return [...files].sort();
}

export async function runLint(ctx: LintContext, warn: (w: string) => void): Promise<Result> {
  const linter = linterFor(ctx.config);
  if (!linter) {
    return fail(`verdict can't tell which linter reads ${ctx.config}: point the lint enforcer at ${LINTERS.map((l) => l.name).join(" or ")}'s config file, or run \`verdict plan\``);
  }
  const exe = ctx.bin(linter.name);
  if (!exe) return inconclusive(`${linter.name} is not installed: ${linter.install}, then run verdict check again`);
  const files = scopeFiles(ctx.root, ctx.scope);
  if (files.length === 0) return fail(`the scope "${ctx.scope}" matches no files, so ${ctx.rule} checks nothing: the code moved. Run \`verdict plan\` to re-plan the law`);
  const on = await linter.enabled(ctx, exe, files[0]!);
  if (on === false) return fail(`${ctx.rule} is turned off in ${ctx.config} for ${files[0]}: turn it back on, or edit the law in VERDICT.md if it no longer holds`);
  const r = await linter.findings(ctx, exe, files);
  if ("status" in r) return r;
  if (r.suppressed > 0) warn(`${r.suppressed} finding${r.suppressed === 1 ? "" : "s"} of ${ctx.rule} suppressed by disable comments in the scope`);
  if (r.found.length === 0) return pass();
  const shown = r.found.slice(0, 20).map((f) => `${f.file}:${f.line}: ${f.message}`);
  return fail([`${ctx.rule}: ${r.found.length} finding${r.found.length === 1 ? "" : "s"}`, ...shown, ...(r.found.length > 20 ? ["…"] : [])].join("\n"));
}
