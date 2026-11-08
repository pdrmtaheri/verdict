#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, exitCode, format } from "./check.ts";
import { parseLaws } from "./laws.ts";
import { readLock } from "./lock.ts";
import { plan } from "./plan.ts";
import { validatePlayground } from "./playground/manifest.ts";
import { describe, discoverPlaygrounds, startPlayground } from "./playground/server.ts";

const USAGE = `usage: verdict <command>

  plan    sync the lock: plan new or reworded laws, re-prove planned ones on
          today's code (each enforcer must still fail on its break), and
          re-plan the ones that drifted
  check   run every law's enforcers; exit 1 if any law fails or isn't planned
  playground [dir] [--port N]
          serve a playground (a verdict repo with a PLAYGROUND.json), or every
          playground in a folder: a local web UI plus an MCP endpoint per
          playground that your coding agent connects to
  playground validate [dir]
          check a playground's manifest and laws; exit 1 with what to fix

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
  if (command === "playground") return playgroundCommand(argv.slice(1));
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

process.exit(await main(process.argv.slice(2)));
