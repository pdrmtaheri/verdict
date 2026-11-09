// Lint enforcers: a rule the project's own linter already has. verdict
// writes no lint rules of its own (Semgrep is for those); it points at one
// in the project's config, runs the linter under that config, and keeps only
// that rule's findings in the scope. The tool is inferred from the config's
// file name. Turning the rule off is reported directly when the linter can
// say so, and otherwise shows up when check replays the break.
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { ExecResult } from "./exec.ts";
import { z } from "zod";
import { fail, inconclusive, pass, type Result } from "./result.ts";

export interface LintContext {
  root: string;
  config: string; // the config file, relative to root
  rule: string;
  scope: string; // globs relative to root, separated by spaces or commas
  run: (argv: string[], env?: Record<string, string>) => Promise<ExecResult>;
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
  // The files in the scope the rule doesn't apply to under the config (turned
  // off for them, or the files are ignored), with why; null if it can't tell.
  off: (ctx: LintContext, exe: string, files: string[]) => Promise<string[] | null>;
  findings: (ctx: LintContext, exe: string, files: string[]) => Promise<{ found: Finding[]; suppressed: number } | Result>;
}

// A linter's JSON report, read as `schema`; null if it printed something else.
function parse<S extends z.ZodType>(r: ExecResult, schema: S): z.infer<S> | null {
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const EslintReport = z.array(
  z.object({
    filePath: z.string(),
    messages: z.array(z.object({ ruleId: z.string().nullable(), line: z.number(), message: z.string() })),
    suppressedMessages: z.array(z.object({ ruleId: z.string().nullable() })).optional(),
  }),
);
const RuffReport = z.array(z.object({ code: z.string().nullable(), filename: z.string(), location: z.object({ row: z.number() }), message: z.string() }));
const OxlintRules = z.record(z.string(), z.unknown());
const OxlintConfig = z.object({ rules: OxlintRules.optional(), overrides: z.array(z.object({ files: z.array(z.string()), rules: OxlintRules.optional() })).optional() });
const OxlintReport = z.object({
  diagnostics: z.array(z.object({ code: z.string(), filename: z.string(), message: z.string(), labels: z.array(z.object({ span: z.object({ line: z.number() }) })).optional() })),
});

const ESLINT_PROBE = `
const [config, rule, ...files] = process.argv.slice(1);
(async () => {
  const { ESLint } = require("eslint");
  const eslint = new ESLint({ cwd: process.cwd(), overrideConfigFile: config });
  const off = [];
  for (const f of files) {
    if (await eslint.isPathIgnored(f)) { off.push(f + " (ignored by the config)"); continue; }
    const c = await eslint.calculateConfigForFile(f);
    const s = c && c.rules ? c.rules[rule] : undefined;
    const level = Array.isArray(s) ? s[0] : s;
    if (level === undefined || level === 0 || level === "off") off.push(f);
  }
  console.log(JSON.stringify(off));
})().catch((e) => { console.error(e && e.message); process.exit(1); });
`;

const eslint: Linter = {
  name: "eslint",
  configs: /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.(c?js|json|ya?ml))?)$/,
  install: "add eslint to the project's dev dependencies",
  // One node process asks the project's own eslint, file by file, whether the
  // file is ignored and what the rule is set to: a config can turn a rule off
  // for some files only.
  async off(ctx, exe, files) {
    const node = ctx.bin("node");
    if (!node) return null;
    // The same eslint that lints: node_modules/eslint/bin/eslint.js. NODE_PATH
    // makes require("eslint") find it, after any node_modules from root up.
    const modules = dirname(dirname(dirname(realpathSync(exe))));
    const r = await ctx.run([node, "-e", ESLINT_PROBE, "--", ctx.config, ctx.rule, ...files], { NODE_PATH: modules });
    return r.code === 0 ? parse(r, z.array(z.string())) : null;
  },
  async findings(ctx, exe, files) {
    const r = await ctx.run([exe, "--config", ctx.config, "--format", "json", "--no-warn-ignored", ...files.map((f) => `./${f}`)]);
    const out = parse(r, EslintReport);
    if (!out) return inconclusive(`eslint exited ${r.code} without a report, so verdict can't read its findings. Fix the error below, then run verdict check again\n${r.output.split("\n").slice(-15).join("\n")}`);
    const found = out.flatMap((f) => f.messages.filter((m) => m.ruleId === ctx.rule).map((m) => ({ file: f.filePath, line: m.line, message: m.message })));
    const suppressed = out.reduce((n, f) => n + (f.suppressedMessages ?? []).filter((m) => m.ruleId === ctx.rule).length, 0);
    return { found, suppressed };
  },
};

const ruff: Linter = {
  name: "ruff",
  configs: /^(\.?ruff\.toml|pyproject\.toml)$/,
  install: "install ruff (https://docs.astral.sh/ruff/installation/)",
  // Whether the rule is selected, then which files per-file-ignores exempt.
  async off(ctx, exe, files) {
    const r = await ctx.run([exe, "check", "--config", ctx.config, "--show-settings", `./${files[0]}`]);
    const enabled = /^linter\.rules\.enabled = \[\n([\s\S]*?)^\]/m.exec(r.stdout);
    if (!enabled) return null;
    if (!enabled[1]!.includes(`(${ctx.rule})`)) return files;
    const off: string[] = [];
    const ignores = /^linter\.per_file_ignores = \{\n([\s\S]*?)^\}/m.exec(r.stdout)?.[1] ?? "";
    for (const m of ignores.matchAll(/absolute_matcher = "([^"]+)"\s*\n\s*basename_matcher = "[^"]*"\s*\n\s*negated = (true|false)\s*\n\s*data = \[([\s\S]*?)\]/g)) {
      if (!m[3]!.includes(`(${ctx.rule})`)) continue;
      const glob = new Bun.Glob(m[1]!);
      const root = realpathSync(ctx.root); // ruff prints resolved paths
      for (const f of files) if (glob.match(join(root, f)) !== (m[2] === "true")) off.push(`${f} (per-file-ignores)`);
    }
    return off;
  },
  async findings(ctx, exe, files) {
    const r = await ctx.run([exe, "check", "--config", ctx.config, "--output-format", "json", "--no-fix", "--exit-zero", ...files.map((f) => `./${f}`)]);
    const out = parse(r, RuffReport);
    if (!out) return inconclusive(`ruff exited ${r.code} without a report, so verdict can't read its findings. Fix the error below, then run verdict check again\n${r.output.split("\n").slice(-15).join("\n")}`);
    // ruff doesn't report what `# noqa` suppressed.
    return { found: out.filter((f) => f.code === ctx.rule).map((f) => ({ file: f.filename, line: f.location.row, message: f.message })), suppressed: 0 };
  },
};

// oxlint names a rule "plugin/name" in its config ("no-var" is eslint's) and
// "plugin(name)" in its report; both normalise to "plugin/name".
const OX_ALIASES: Record<string, string> = { "@typescript-eslint": "typescript", "typescript-eslint": "typescript", "eslint-plugin-unicorn": "unicorn" };
export function oxRule(id: string): string {
  const report = /^([\w@/-]+)\(([\w-]+)\)$/.exec(id);
  const [plugin, name] = report ? [report[1]!, report[2]!] : id.includes("/") ? [id.slice(0, id.lastIndexOf("/")), id.slice(id.lastIndexOf("/") + 1)] : ["eslint", id];
  return `${OX_ALIASES[plugin] ?? plugin}/${name}`;
}
const oxOff = (level: unknown) => {
  const l = Array.isArray(level) ? level[0] : level;
  return l === "off" || l === "allow" || l === 0;
};

// Disable comments that name the rule, or no rule (they silence all). oxlint
// honours both its own and eslint's, and doesn't report what they suppressed.
function disables(root: string, files: string[], rule: string): number {
  let n = 0;
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/(?:eslint|oxlint)-disable(?:-next-line|-line)?([^\n*]*)/g)) {
      const named = m[1]!.split(/[\s,]+/).filter((r) => r && !r.startsWith("--"));
      if (named.length === 0 || named.some((r) => oxRule(r) === oxRule(rule))) n++;
    }
  }
  return n;
}

const oxlint: Linter = {
  name: "oxlint",
  configs: /^(\.oxlintrc\.jsonc?|oxlint\.config\.[cm]?[jt]s)$/,
  install: "add oxlint to the project's dev dependencies",
  // --print-config gives the base rules (defaults included), the overrides and
  // the ignore patterns, not a file's own config: overrides are applied here,
  // and --debug files says which files oxlint would lint at all.
  async off(ctx, exe, files) {
    const printed = await ctx.run([exe, "-c", ctx.config, "--print-config"]);
    const cfg = printed.code === 0 ? parse(printed, OxlintConfig) : null;
    if (!cfg?.rules) return null;
    const want = oxRule(ctx.rule);
    const level = (rules: Record<string, unknown> = {}) => Object.entries(rules).find(([k]) => oxRule(k) === want)?.[1];
    const listed = await ctx.run([exe, "-c", ctx.config, "--debug", "files", ...files.map((f) => `./${f}`)]);
    if (listed.code !== 0) return null;
    const linted = new Set(listed.stdout.split("\n").map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean));
    const base = dirname(join(ctx.root, ctx.config)); // override globs are relative to the config
    const off: string[] = [];
    for (const f of files) {
      if (!linted.has(f)) {
        off.push(`${f} (ignored by the config)`);
        continue;
      }
      let l = level(cfg.rules);
      const rel = relative(base, join(ctx.root, f));
      for (const o of cfg.overrides ?? []) if (o.files.some((g) => new Bun.Glob(g).match(rel)) && level(o.rules) !== undefined) l = level(o.rules);
      if (l === undefined || oxOff(l)) off.push(f);
    }
    return off;
  },
  async findings(ctx, exe, files) {
    const r = await ctx.run([exe, "-c", ctx.config, "--format", "json", ...files.map((f) => `./${f}`)]);
    const out = parse(r, OxlintReport);
    if (!out) return inconclusive(`oxlint exited ${r.code} without a report, so verdict can't read its findings. Fix the error below, then run verdict check again\n${r.output.split("\n").slice(-15).join("\n")}`);
    const want = oxRule(ctx.rule);
    const found = out.diagnostics.filter((d) => oxRule(d.code) === want).map((d) => ({ file: d.filename, line: d.labels?.[0]?.span.line ?? 0, message: d.message }));
    return { found, suppressed: disables(ctx.root, files, ctx.rule) };
  },
};

export const LINTERS = [eslint, oxlint, ruff];

export const linterFor = (config: string): Linter | undefined => LINTERS.find((l) => l.configs.test(basename(config)));

// The files a scope names, relative to root (dependency and VCS directories skipped).
export function scopeFiles(root: string, scope: string): string[] {
  const files = new Set<string>();
  for (const glob of scope.split(/[\s,]+/).filter(Boolean)) {
    for (const f of new Bun.Glob(glob).scanSync({ cwd: root, onlyFiles: true })) {
      if (!/(^|\/)(node_modules|\.git|\.venv|venv)\//.test(f)) files.add(f);
    }
  }
  return [...files].toSorted();
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
  const off = await linter.off(ctx, exe, files);
  if (off === null) return inconclusive(`verdict couldn't ask ${linter.name} whether ${ctx.rule} is on for the scope, so a pass would prove nothing: check that ${linter.name} runs with ${ctx.config}`);
  if (off.length > 0) {
    const shown = off.slice(0, 10).join(", ") + (off.length > 10 ? `, and ${off.length - 10} more` : "");
    return fail(`${ctx.rule} is turned off in ${ctx.config} for ${off.length === files.length ? "the whole scope" : `${off.length} of ${files.length} files in the scope`}: ${shown}. Turn it back on, or edit the law in VERDICT.md if it no longer holds`);
  }
  const r = await linter.findings(ctx, exe, files);
  if ("status" in r) return r;
  if (r.suppressed > 0) warn(`${r.suppressed} finding${r.suppressed === 1 ? "" : "s"} of ${ctx.rule} suppressed by disable comments in the scope: remove the comments and fix the code, or leave them if each exception is deliberate`);
  if (r.found.length === 0) return pass();
  const shown = r.found.slice(0, 20).map((f) => `${f.file}:${f.line}: ${f.message}`);
  return fail([`${ctx.rule}: ${r.found.length} finding${r.found.length === 1 ? "" : "s"}`, ...shown, ...(r.found.length > 20 ? ["…"] : []), "Fix the code at the findings above, or edit the law in VERDICT.md if it no longer holds"].join("\n"));
}
