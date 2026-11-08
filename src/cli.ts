#!/usr/bin/env bun
import { check, exitCode, format, summarize } from "./check.ts";
import { findSets, shown } from "./sets.ts";
import { jobs, makeLimit } from "./limit.ts";
import { Claims, plan } from "./plan.ts";

const USAGE = `usage: verdict <command> [path...]

  plan    sync the lock: plan new or reworded laws, re-prove planned ones on
          today's code (each enforcer must still fail on its break), and
          re-plan the ones that drifted
  check   run every law's enforcers; exit 1 if any law fails or isn't planned

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
  const [command, ...paths] = argv;
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
  const many = sets.length > 1;
  // One limit for everything, so VERDICT_JOBS bounds the whole run.
  const limit = makeLimit(jobs());
  if (command === "plan") {
    const claims = new Claims(sets);
    // Laws from every VERDICT.md run together; each line says which file it's from.
    const results = await Promise.all(
      sets.map((set) => {
        const prefix = many ? `[${shown(repo, set.lawsFile)}] ` : "";
        return plan(set, set.lockFile, set.laws, set.lock, (line) => console.log(prefix + line.replaceAll("\n", `\n${prefix}`)), { limit, claims });
      }),
    );
    return results.every(Boolean) ? 0 : 1;
  }
  const reports = await Promise.all(sets.map((set) => check(set, set.laws, set.lock, limit)));
  sets.forEach((set, i) => {
    if (many) console.log(`\n${shown(repo, set.lawsFile)}`);
    console.log(format(reports[i]!, !many));
  });
  const all = reports.flat();
  if (many) console.log(`\n${summarize(all)}`);
  return exitCode(all);
}

process.exit(await main(process.argv.slice(2)));
