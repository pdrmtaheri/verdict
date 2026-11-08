#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, exitCode, format } from "./check.ts";
import { parseLaws } from "./laws.ts";
import { readLock } from "./lock.ts";
import { plan } from "./plan.ts";

const USAGE = `usage: verdict <command>

  plan    sync the lock: plan new or reworded laws, re-prove planned ones on
          today's code (each enforcer must still fail on its break), and
          re-plan the ones that drifted
  check   run every law's enforcers; exit 1 if any law fails or isn't planned

Laws live in VERDICT.md, the plan in VERDICT.lock, enforcers in .verdict/.
Agents: verdict runs its planner and judges on a coding agent you're logged into.
  VERDICT_AGENT      claude-code (default) | codex | pi
  VERDICT_MODEL      that agent's model name (e.g. haiku, gpt-6.1-terra,
                     anthropic/claude-haiku-5-5 for Pi); its default if unset
  VERDICT_REASONING  low | medium | high (default high to plan, medium to judge)
Decision models (jev): TYPESAFE_AI_API_KEY; VERDICT_DECISION_MODEL
                     (default jev-1.14.0)`;

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  const root = process.cwd();
  const lawsFile = join(root, "VERDICT.md");
  const lockFile = join(root, "VERDICT.lock");
  if (command !== "plan" && command !== "check") {
    console.log(USAGE);
    return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
  if (!existsSync(lawsFile)) {
    console.error("no VERDICT.md in this directory");
    return 2;
  }
  const laws = parseLaws(readFileSync(lawsFile, "utf8"));
  const lock = readLock(lockFile);
  if (command === "plan") return (await plan(root, lockFile, laws, lock, console.log)) ? 0 : 1;
  const reports = await check(root, laws, lock);
  console.log(format(reports));
  return exitCode(reports);
}

process.exit(await main(process.argv.slice(2)));
