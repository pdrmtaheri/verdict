#!/usr/bin/env bun
import { check, exitCode, format, summarize } from "./check.ts";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { validatePlayground } from "./playground/manifest.ts";
import { describe, discoverPlaygrounds, startPlayground } from "./playground/server.ts";
import { init } from "./init.ts";
import { sarif } from "./sarif.ts";
import { BadLock } from "./lock.ts";
import { BadLaws, findSets, isDir, repoRoot, shown } from "./sets.ts";
import type { Law } from "./laws.ts";
import { jobs, makeLimit } from "./limit.ts";
import { Claims, plan } from "./plan.ts";

const USAGE = `usage: verdict <command> [path...]

  init    draft VERDICT.md from the rules the project already wrote down
          (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, .cursor/rules…), for you to
          edit; in the given directory, or the repo root
  plan    sync the lock: plan new or reworded laws, re-prove planned ones on
          today's code (each enforcer must still fail on its break), and
          re-plan the ones that drifted
          --again <law>  plan this law afresh even if it's in sync; <law> is
                         a hash prefix or part of its text (repeatable)
  check   run every law's enforcers; exit 1 if any law fails or isn't planned
          --format sarif  print the report as SARIF (GitHub code scanning)
  playground [dir] [--port N]
          serve a playground (a verdict repo with a PLAYGROUND.json), or every
          playground in a folder: a local web UI plus an MCP endpoint per
          playground that your coding agent connects to
  playground validate [dir]
          check a playground's manifest and laws; exit 1 with what to fix

Laws live in VERDICT.md files: any directory can have one, and its laws apply
to that directory's subtree. Each keeps its plan in VERDICT.lock and its
enforcers in .verdict/, beside it. With no paths, verdict runs every VERDICT.md
in the repo; with paths, the ones in those subtrees.
Agents: verdict runs its planner and judges on a coding agent you're logged into.
  VERDICT_AGENT      claude-code (default) | codex | pi
  VERDICT_MODEL      that agent's model name (e.g. haiku, gpt-6.1-terra,
                     anthropic/claude-haiku-5-5 for Pi); its default if unset
  VERDICT_REASONING  low | medium | high (default high to plan, medium to judge)
  VERDICT_JOBS       how many laws to plan or check at once (default 4)
Decision models (jev): TYPESAFE_AI_API_KEY; VERDICT_DECISION_MODEL
                     (default jev-1.14.0)`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "playground") return playgroundCommand(rest);
  const paths: string[] = [];
  const again: string[] = [];
  let fmt = "text";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--format" || a.startsWith("--format=")) {
      const value = a === "--format" ? rest[++i] : a.slice("--format=".length);
      if (value !== "text" && value !== "sarif") return usageError("--format is text or sarif");
      fmt = value;
    } else if (a === "--again") {
      const value = rest[++i];
      if (!value) return usageError("--again needs a law: a hash prefix or part of the law's text");
      again.push(value);
    } else if (a.startsWith("--again=")) again.push(a.slice("--again=".length));
    else paths.push(a);
  }
  if (again.length > 0 && command !== "plan") return usageError("--again only works with `verdict plan`");
  if (fmt !== "text" && command !== "check") return usageError("--format only works with `verdict check`");
  if (command === "init") {
    if (paths.length > 1) return usageError("init takes at most one directory");
    const repo = await repoRoot(process.cwd());
    const dir = paths[0] ? realpathSync(resolve(process.cwd(), paths[0])) : repo;
    if (!isDir(dir)) return usageError(`${paths[0]} is not a directory`);
    return init({ dir, repo }, (line) => console.log(line));
  }
  if (command !== "plan" && command !== "check") {
    console.log(USAGE);
    return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
  const { repo, sets, unmatched } = await findSets(process.cwd(), paths);
  for (const p of unmatched) {
    console.error(`no VERDICT.md in ${p} or below: check the path, or create ${p}/VERDICT.md with one law per bullet`);
  }
  if (unmatched.length > 0) return 2;
  if (sets.length === 0) {
    console.error(`no VERDICT.md in ${repo}: create one (at the repo root, or in any directory) with one law per bullet`);
    return 2;
  }
  for (const set of sets) {
    if (set.laws.length === 0) console.error(`no laws in ${shown(repo, set.lawsFile)}: write one law per top-level bullet ("- Money is never a float."), then run \`verdict plan\``);
  }
  const many = sets.length > 1;
  // One limit for everything, so VERDICT_JOBS bounds the whole run.
  const limit = makeLimit(jobs());
  if (command === "plan") {
    const claims = new Claims(sets);
    const matches = (sel: string, law: Law) =>
      (/^[0-9a-f]{4,8}$/.test(sel) && law.hash.startsWith(sel)) || law.text.toLowerCase().includes(sel.toLowerCase());
    for (const sel of again) {
      if (!sets.some((set) => set.laws.some((law) => matches(sel, law)))) {
        return usageError(`--again ${JSON.stringify(sel)} matches no law: use a hash prefix from VERDICT.lock or a phrase from the law`);
      }
    }
    const replan = (law: Law) => again.some((sel) => matches(sel, law));
    // Laws from every VERDICT.md run together; each line says which file it's from.
    const results = await Promise.all(
      sets.map((set) => {
        const prefix = many ? `[${shown(repo, set.lawsFile)}] ` : "";
        return plan(set, set.lockFile, set.laws, set.lock, (line) => console.log(prefix + line.replaceAll("\n", `\n${prefix}`)), { limit, claims, again: replan });
      }),
    );
    return results.every(Boolean) ? 0 : 1;
  }
  const reports = await Promise.all(sets.map((set) => check(set, set.laws, set.lock, limit)));
  if (fmt === "sarif") {
    console.log(JSON.stringify(sarif(repo, sets.map((set, i) => ({ where: set, lawsFile: set.lawsFile, reports: reports[i]! }))), null, 2));
    return exitCode(reports.flat());
  }
  sets.forEach((set, i) => {
    if (many) console.log(`\n${shown(repo, set.lawsFile)}`);
    console.log(format(reports[i]!, !many));
  });
  const all = reports.flat();
  if (many) console.log(`\n${summarize(all)}`);
  return exitCode(all);
}

function usageError(message: string): number {
  console.error(`${message}\n(run \`verdict help\` for usage)`);
  return 2;
}

// Anything that escapes main reaches a person: say what happened and what to
// do, never a raw stack trace (VERDICT_DEBUG=1 shows it).
async function run(): Promise<number> {
  try {
    return await main(process.argv.slice(2));
  } catch (err) {
    if (process.env.VERDICT_DEBUG) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BadLock || err instanceof BadLaws) {
      console.error(message);
      return 2;
    }
    console.error(`verdict stopped: ${message}\nIf the message doesn't say how to fix it, run again with VERDICT_DEBUG=1 and report the output at https://github.com/pdrmtaheri/verdict/issues`);
    return 1;
  }
}

async function playgroundCommand(args: string[]): Promise<number> {
  const validateOnly = args[0] === "validate";
  const rest = validateOnly ? args.slice(1) : args;
  const portAt = rest.indexOf("--port");
  const port = portAt >= 0 ? Number(rest[portAt + 1]) : undefined;
  if (portAt >= 0 && (!Number.isInteger(port) || port! < 0 || port! > 65535)) {
    console.error("--port needs a number from 0 to 65535");
    return 2;
  }
  const dirs = rest.filter((_, i) => portAt < 0 || (i !== portAt && i !== portAt + 1));
  const root = resolve(dirs[0] ?? process.cwd());
  // A folder holding one playground, or a folder of playgrounds.
  const found = discoverPlaygrounds(root);
  const problems = (found.length > 0 ? found : [root]).flatMap((d) => validatePlayground(d).map((p) => (found.length > 1 ? `${d}: ${p}` : p)));
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    return 1;
  }
  if (validateOnly) {
    console.log(found.length > 1 ? `${found.length} playgrounds in ${root} are valid` : `${root} is a valid playground`);
    return 0;
  }
  const pg = await startPlayground(root, { port });
  console.log(describe(pg));
  await new Promise(() => {}); // serve until interrupted
  return 0;
}

process.exit(await run());
