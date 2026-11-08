# verdict

Write the rules of your project once, in prose. verdict has a coding agent plan
how to enforce each one (linters, tests, models, LLM judges), proves every
enforcer can actually fail, and records the plan in a lockfile you review like
any other code.

See [DESIGN.md](DESIGN.md) for the full design.

## Requirements

- [Bun](https://bun.sh)
- A coding agent you are already logged into: Claude Code (default), Codex, or
  Pi. verdict uses no model API keys of its own.
- An OS sandbox for running generated code: macOS (`sandbox-exec`, built in) or
  Linux ([bubblewrap](https://github.com/containers/bubblewrap)). Without one,
  verdict refuses to run the code and the enforcer is reported inconclusive.
- Optional, depending on what the planner picks: [Semgrep](https://semgrep.dev)
  for pattern enforcers, and `TYPESAFE_AI_API_KEY` for decision-model (jev)
  judges.

## Install

```sh
bun install
```

Run it from the repository you want to check, pointing at this checkout:

```sh
bun /path/to/verdict/src/cli.ts <command>
```

Or link it once so `verdict` is on your PATH:

```sh
bun link            # in this checkout
bun link verdict    # in the repo you want to check
```

## Usage

1. **Write your laws** in `VERDICT.md` at the root of your repo. One top-level
   bullet is one law; indented lines continue it.

   ```markdown
   - Money is never a float; amounts are integer cents.
   - No order is charged twice, even if the payment provider times out.
     Retries reuse the original idempotency key.
   - Error messages tell the user what to do next.
   ```

2. **Plan** the enforcement:

   ```sh
   verdict plan
   ```

   This plans every new or reworded law, re-proves existing ones against
   today's code (each enforcer must still fail on its recorded break), and
   re-plans any that drifted. It writes `VERDICT.lock` and the enforcers and
   breaks under `.verdict/`.

3. **Review and commit** `VERDICT.md`, `VERDICT.lock` and `.verdict/` like any
   other code. The merge review is the approval; verdict has no approval step
   of its own.

4. **Check**:

   ```sh
   verdict check
   ```

   Runs every law's enforcers. Each law is reported as pass, fail or
   inconclusive. Exits `0` only when no law fails and every law is planned, so
   it works as a CI step, git hook or agent tool.

Run `verdict plan` again whenever you edit a law or the code changes enough that
an enforcer drifts. Editing a law's words marks it unplanned until you do.

## Enforcers

The planner picks one or more of these for each law. Every enforcer states its
`scope`, and every one that passes today must be shown to fail on a recorded
break before the plan is accepted.

| Kind | What it is | Runs with | Needs |
|---|---|---|---|
| `semgrep` | A Semgrep rule file, for laws about the shape of the code | `semgrep` | [Semgrep](https://semgrep.dev) installed |
| `test` | A test file, for laws about behaviour (unit, property, fuzz, E2E) | Inferred from the file name and the repo's tooling (below) | That runner installed |
| `tla` | A TLA+ spec, for invariants worth proving | TLC | `tlc` on PATH, or `VERDICT_TLA2TOOLS` set to `tla2tools.jar` (also needs Java) |
| `decision` | A JSON file that gathers state with a shell command and asks a jev decision model to rule pass, fail or inconclusive | `experimental_decide` | `TYPESAFE_AI_API_KEY` |
| `llm` | A Markdown judge prompt read by a coding agent, for laws that are readable but not mechanical (copy, docs, messages) | Your configured agent | A logged-in agent |

Test files run with:

| File name | Command |
|---|---|
| `*.spec.ts` (with `@playwright/test`) | `playwright test` |
| `*.test.*` / `*.spec.*` (with `vitest`) | `vitest run` |
| `*.test.*` / `*.spec.*` (with `jest`) | `jest` |
| `*.test.*` / `*.spec.*` (otherwise) | `bun test` |
| `*_test.go` | `go test` |
| `test_*.py`, `*_test.py` | `python3 -m pytest` |
| Any executable file | Run directly; exit 77 means a precondition is missing (inconclusive) |

A missing tool makes that enforcer inconclusive rather than failing the law.

## Playground

An interactive way to try verdict on any idea. A playground is a verdict repo
with a `PLAYGROUND.json` (title, idea, a brief for the agent). Serve one, or a
folder of them:

```sh
verdict playground examples/traffic-light  # one playground; add --port N to pick a port
verdict playground examples                # every playground in a folder, with links between them
verdict playground validate <dir>          # check the manifest and laws
```

It prints a local URL for the web UI and, per playground, a command that
connects your agent over MCP:

```sh
claude mcp add --transport http playground "http://127.0.0.1:PORT/mcp/<playground>?token=…"
```

The page shows the laws and their results, a live preview of what the agent
builds in `public/`, and a drawer with the agent's activity, the files, and
these connection instructions. A failing check is explained in plain sentences,
with the raw output folded away.

The agent gets tools to read and write laws, write files under the manifest's
`writable` directories, run tests in the sandbox, and call `plan` and `check`.
The server listens on 127.0.0.1 only, requires the session token on every
request, and refuses foreign `Host` and `Origin` headers.

### Versions

A playground can hold several versions of its code, all judged by the same laws:
the code in the playground's own folders is the `main` version, and every
folder in `versions/<id>/` (same layout) is another. Pick one in the page and
press **Check**, or **Check all versions**. Nothing is copied or swapped:
verdict tells each enforcer where the code is through the `VERDICT_TARGET`
environment variable (Semgrep is pointed at that folder), so enforcers must read
the code from there and not relative to their own file. The planner is told to
write them that way. Describe versions in `PLAYGROUND.json`:

```json
{ "main": { "label": "Correct" },
  "versions": [{ "id": "skips-yellow", "label": "Skips yellow", "note": "Green drops straight to red." }] }
```

### Making a playground

Use the `create-playground` skill in
[skills/create-playground](skills/create-playground/SKILL.md): give it an idea
and it writes the manifest and starter laws, validates them, and launches it.
[examples/traffic-light](examples/traffic-light) is a worked one, with five
versions.

## Configuration

Environment variables:

| Variable | Meaning |
|---|---|
| `VERDICT_AGENT` | `claude-code` (default), `codex` or `pi` |
| `VERDICT_MODEL` | That agent's own model name, e.g. `haiku`, or `anthropic/claude-haiku-5-5` for Pi. The agent's default if unset |
| `VERDICT_REASONING` | `low`, `medium` or `high` (default `high` to plan, `medium` to judge) |
| `TYPESAFE_AI_API_KEY` | Key for decision-model (jev) enforcers |
| `VERDICT_DECISION_MODEL` | Decision model to use (default `jev-1.14.0`) |
| `VERDICT_SANDBOX` | Set to `off` only when verdict already runs inside a sandbox (macOS sandboxes don't nest) |

## Files

```
VERDICT.md     your laws, written by hand
VERDICT.lock   generated: each law and its enforcers
.verdict/      generated enforcers, their tests, and the breaks that prove them
```

## Safety

The planner reads your repo, so text in it could try to steer it. Everything the
planner can cause to run happens on a scratch copy of the working tree inside an
OS sandbox with no network (beyond localhost), no read access to your home
directory beyond the repo and your tools, and a scrubbed environment. Its file
tools cannot reach outside the repo, and it writes only under `.verdict/`. Details
are in [DESIGN.md](DESIGN.md#confinement-while-planning).

## Development

```sh
bun test
bun run typecheck
```

verdict checks itself: its own laws are in [VERDICT.md](VERDICT.md).
