# Error messages tell the user what to do next

scope: the error and failure text that verdict itself prints to a person running `verdict plan` or `verdict check`. Files: src/cli.ts, src/check.ts, src/plan.ts (plan, planLaw, logOutcome), src/enforcers.ts (each runner and runEnforcer), src/agent.ts (pickAgent), src/agents/claude-code.ts, src/agents/codex.ts, src/agents/pi.ts, src/models.ts. Covers every message a person can read on stdout or stderr, including the reason verdict prints for each enforcer result and each line for unplanned, failing or inconclusive laws. Does not cover: text sent back to the planner or judge agents (tool results, submit rejections), output from third-party tools (semgrep, test runners, TLC) that verdict only relays, and docs. Static reading of the source only; the judge does not run the CLI.

## What counts as a user-facing error

A message a person reads when something went wrong or a step was not done. Find them by searching the files above for `console.log`, `console.error`, `throw new Error`, `inconclusive(`, `fail(`, `log(`, and template strings that reach those calls. Follow messages through variables: a message built in one function and printed in another (for example, enforcer results printed by `format()` in src/check.ts) is in scope.

## What to check

A message passes when it gives the user a next step they can take: a command to run (for example `verdict plan`), a file to create or edit, an environment variable or flag to set, a tool to install (a link or the install step is enough), or a concrete fix. Saying that something is missing, or that a step failed, is not a next step by itself.

Check each entry point:
- `verdict` run where there is no VERDICT.md (src/cli.ts, main).
- `verdict plan` and `verdict check`, including every line that format() prints and every line plan() and logOutcome() print.
- Each enforcer runner in src/enforcers.ts: semgrep, test, tla, decision, llm. Also runEnforcer's missing-file branch, its catch branch, and the unknown-kind branch.
- Agent selection and agent failures: pickAgent in src/agent.ts, and the errors thrown in src/agents/claude-code.ts, src/agents/codex.ts and src/agents/pi.ts.
- Missing keys or models: src/models.ts and the paths that reach it.
- Laws that are not planned or whose enforcers are stale (src/check.ts).

Examples that already pass, so you can see the standard: the NOT PLANNED line in src/check.ts that says to run `verdict plan`; the semgrep-not-installed message that links to install docs; the TLC-not-installed message that says where to put tlc; the Pi missing-model message that says which command lists models.

## Pass criteria

- Every user-facing message in scope names a next step, as defined above.
- Every failure path in scope prints a message that the user can act on.

## Fail criteria

- A user-facing message in scope says what went wrong and stops, with no next step.
- A user-facing failure path in scope exits with no message, or with a message that gives no next step.

For a fail, name each violating message with its file:line and quote its text. Do not count a message as passing because a nearby message is good.
