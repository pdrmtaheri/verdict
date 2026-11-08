# verdict — design

Status: v1 slice built (TypeScript on Bun). See "Implementation" below.

## The idea

Lint configs, AGENTS.md, TLA+ specs, QA and E2E suites are all the same thing:
assertions about a system. They differ only in how they are enforced, and the
enforcement mechanism is an implementation detail.

So: write the assertions once, in prose (VERDICT.md). An LLM plans how to enforce
each one, generating linters, tests, specs or judges, and records that plan in a
lockfile (VERDICT.lock). A human reviews all of it at merge time like any other
code.

## Principles

1. **A law is prose.** How it's enforced is generated detail.
2. **Enforcers observe from outside.** They never change the system under check.
3. **Language-agnostic.** The format knows no language; enforcers are generated
   per repo and may be language-specific.
4. **Everything generated is code.** It is reviewed and merged like any code.
   verdict has no approval mechanism of its own.
5. **No triggers.** verdict is a CLI. Anything can call it: a hook, CI, an agent,
   a person.
6. **Bare bones.** Linter conventions (baselines, suppressions, severity, output
   formats, autofix, per-path overrides) are known good ideas to borrow only when
   a need appears. None are in v1.

## Files

```
VERDICT.md      # human-written laws
VERDICT.lock    # generated: law -> enforcers
.verdict/       # generated enforcers, their tests/evals, and breaks/
```

Any directory can have these three. A VERDICT.md's laws apply to its
directory's subtree, and its VERDICT.lock and `.verdict/` sit beside it, so a
module carries its laws when it moves, and its owners review them (CODEOWNERS
works per directory). Paths in a lock are relative to its directory. There are
no overrides: a child can't switch off a parent's law; the parent rewords it
("except generated code").

Like a test runner, `verdict check` and `verdict plan` with no paths run every
VERDICT.md in the repo (found through git, so .gitignore applies); with paths,
they run the VERDICT.md files in those subtrees. The planner for a nested law
works from its directory: paths are relative to it, `../` reaches the rest of
the repo for context (never above the repo root), and it writes only in that
directory's `.verdict/`. Enforcers run in their law's directory; package and
tool lookups (package.json, node_modules/.bin) walk up to the repo root, as
monorepos expect.

### VERDICT.md

A Markdown list. One top-level bullet = one law. Indented continuation lines
belong to that law. No IDs.

```markdown
- Money is never a float; amounts are integer cents.
- No order is charged twice, even if the payment
  provider times out or the user retries.
  Retries reuse the original idempotency key.
- Error messages tell the user what to do next.
```

### VERDICT.lock

Keyed by a hash of the law's whitespace-normalised text (generated, never
typed). Re-wrapping a law doesn't change its hash; editing its words does, and
then the law counts as unplanned until `verdict plan` runs again.

```yaml
9f3c1a:
  law: Money is never a float; amounts are integer cents.
  enforcers:
    - semgrep: .verdict/money-not-float.semgrep.yml

c4e910:
  law: >
    No order is charged twice, even if the payment provider times out
    or the user retries. Retries reuse the original idempotency key.
  enforcers:
    - tla: .verdict/no-double-charge.tla
    - test: .verdict/no-double-charge.model.test.ts

51d0aa:
  law: Error messages tell the user what to do next.
  enforcers:
    - decision: .verdict/actionable-errors.decision.json
    - llm: .verdict/actionable-errors.judge.md

7b21e0:
  law: Promises are always awaited or handled.
  enforcers:
    - lint: eslint.config.js
      rule: "@typescript-eslint/no-floating-promises"
      scope: src/**/*.ts
      inputs:
        eslint.config.js: 07bd5e21c4aa
        package.json#typescript-eslint: ^8.40.0
```

An enforcer is its kind and path, and may also record the one test to run in
a file that has others (`name`), the rule for a lint enforcer (`rule`), the
scope when verdict doesn't own the file and can't add a scope line (`scope`),
and what it was proven against (`inputs`, see "Staying proven"). Nothing else
goes in the lock: no severity, no trigger, no "holds today" state, no approval.
Those are either inferred, run output, or the merge review's job.

## Commands

- `verdict plan`: sync the lock with VERDICT.md and the code, the way a
  package manager syncs its lockfile. One command does three things:
  - plans each law that is new, or whose hash changed: picks enforcer(s),
    generates them, and proves each one can fail (see "Every check must be seen
    to fail");
  - re-proves each planned law on today's code by replaying its breaks; this
    needs no model except for judges;
  - re-plans a law that drifted: a break no longer applies, or an enforcer
    passes on code broken on purpose. The planner then sorts the cause: the
    enforcer no longer describes the code (fix it from the code), the promise
    changed on purpose (cite the evidence, suggest editing the law), or the code
    breaks the law (a finding).
  `verdict plan --again <law>` plans a law afresh even when it's in sync (for
  example once TLC is installed); `<law>` is a hash prefix or part of its text.
  A law that passed when it was planned and fails now is re-planned the same
  way: it's a regression, or an enforcer that depended on something incidental
  (an exact message, a path). A law that already failed when it was planned
  is reported, not re-planned: that's a known finding. Laws, from every VERDICT.md, are planned in parallel, up to
  `VERDICT_JOBS` at once (default 4; each is one agent session). A planner
  may write only new files or files its own law owns, so parallel planners
  can't overwrite each other. Each law's results print as one block. Suggestions that would mean changing the system are printed, not
  written to the lock.
- `verdict init`: draft a VERDICT.md from the rules a project already wrote
  down for people and agents (AGENTS.md, CLAUDE.md, CONTRIBUTING.md,
  `.cursor/rules`, Copilot instructions…). It keeps the checkable ones, cites
  each one's source, and lists what it left out. It's a draft to edit and
  never overwrites a VERDICT.md: those files change freely and mix rules with
  advice, so verdict doesn't read them as laws. The planner gets them as
  context.
- `verdict check`: run every law's enforcers (all laws by default). Per law, the
  result is pass, fail or inconclusive, with a message quoting the law. A pass
  prints each enforcer's scope. Exit 0 when everything passes, 1 on any failure.
  Also reports laws that aren't planned or whose hash is stale. Laws run in
  parallel under the same `VERDICT_JOBS` limit; output keeps VERDICT.md's order.
  `--format sarif` prints the report as SARIF 2.1.0 instead, for GitHub code
  scanning and other tools that read linter output: one rule per law, an error
  per failing enforcer, a note per inconclusive one, a warning per warning.

## Every check must be seen to fail

A check you have never seen fail proves nothing. For each enforcer that passes
on today's code, the planner submits a break: a small edit to the system under
check that violates the law the way it would really be broken, such as removing
a check, reordering two steps, or using a float. verdict applies it to a scratch
copy of the working tree, never to the repo, and won't accept the plan until the
enforcer fails there. For Semgrep this goes beyond its should-flag examples:
those test the rule, while the break tests the rule's reach into the real code.
For judges, the break is the eval.

Breaks ship with the enforcers in `.verdict/breaks/<law hash>.json`, as
`{enforcer, description, edits: [{path, find, replace}]}`, where `enforcer` is
the enforcer's path, plus `#<rule>` or `#<test name>` when it has one (two
rules of one linter config are two enforcers, each with its own break). They
are not in the lock. The commit at which a law was last proven is inferred from git (the last
commit that touched its breaks file), not stored.

Findings stay findings. If a law is false today, the planner must not weaken the
enforcer, its scope or its bounds until it passes. It submits the enforcer
failing, with the counterexample as steps in the code's own words.

## Staying proven

A break proves an enforcer could fail when it was planned. It can stop being
able to: someone weakens a test, skips it, excludes it in the runner's config,
or turns a lint rule off, and the same pass now means less. This matters most
for enforcers verdict doesn't own (a project's own tests and linter config),
which people edit without thinking about verdict, but it applies to all.

So the lock records each enforcer's inputs: a fingerprint of its file, of the
other `.verdict/` files it names (a runner script, a fixture), and of the
config files it runs under (vitest/jest/playwright configs, bunfig.toml,
pyproject.toml, go.mod, a TLA+ spec's .cfg, the lint config), and the version
package.json asks for of its runner or linter packages. `plan` records them
whenever it plans or re-proves a law (no model needed for a law in sync).

`check` compares them on every run, and only replays what changed: when a
passing enforcer's inputs differ, it applies the enforcer's break to a scratch
copy and runs it there. Still caught is a warning (run `plan` to record the new
inputs); a pass on the broken code fails the law. Unrelated edits don't block
anyone, and `check` stays deterministic and writes nothing.

`check` also warns about what it can see without running anything: a break
that no longer applies to the code (its text is gone), an enforcer that passes
but was never seen to fail (it failed when planned), an entry with no inputs
recorded, and a lint rule's findings suppressed by disable comments. Some
changes it detects directly and fails on: a test run where no test ran
(skipped, filtered out or excluded: most runners exit 0), a lint rule turned
off or ignored for any file in its scope, and a scope that matches no files.

A break must change the system. It may not edit an enforcer's inputs, a
package.json its runner is picked from, or anything on the test side of the
repo: test files, snapshots, fixtures, mocks, testdata, conftest.py, any
`.verdict/`. Paths are compared with symlinks resolved and case folded where
the filesystem ignores case.

Every enforcer file states its scope: a `scope:` line near the top (a `scope`
field in JSON), saying what it covers, its bounds and assumptions, and what it
leaves out. A pass covers that scope, not the system.

## Enforcer kinds

All four observe from outside.

| Kind | Covers | Ships with | Picked when the law is… |
|---|---|---|---|
| Lint / pattern | Semgrep for rules verdict writes (type-aware rules: see below); a rule the project's own linter already has (eslint, oxlint, ruff) | Should-flag / should-pass tests in the tool's own format; for an existing rule, its break | About the shape of the code |
| Tests | Unit, property, fuzz, E2E, DST, spec-generated; or a test the project already has | Nothing extra: the test is the example | About behaviour |
| Proofs / models | TLA+, Bend | Nothing extra: a checker verifies it | An invariant worth proving |
| Judges | LLM, decision models (jev) | Evals | Readable but not mechanical (copy, docs, transcripts) |

If no other kind fits, an LLM judge always does, so no law goes without an
enforcer.

### Pattern rules and type-aware rules

When the project's own linter already checks the law, the planner points at
that rule instead of writing one: a `lint` enforcer names the linter's config
file, the rule id and a scope (globs). verdict runs the linter under that config
and keeps only that rule's findings in the scope; the tool is inferred from the
config's file name. It never writes linter rules or configs. For a linter
verdict can't read, an executable test runs it.

For rules verdict writes, Semgrep is the only pattern-rule engine: one rule
format and one test format (`semgrep --test`) across every language. Semgrep mostly matches syntax, so a
law that depends on types goes down this list, stopping at the first rung that
can express it:

1. Semgrep typed metavariables (`(float $X)`) where the language supports them.
2. One built-in rule of a type-aware tool the repo already uses: a `lint`
   enforcer for a typescript-eslint typed rule or a ruff rule, or an
   executable test that runs it (`cargo clippy -- -D clippy::float_arithmetic`).
3. A custom analyzer in the language's own framework (go/analysis, a
   typescript-eslint rule), kept in `.verdict/` and run by a test script.
4. A behavioural test, or an LLM judge.

verdict has no type-aware machinery of its own; those tools run as tests.

### Tests

The law is the oracle; the search strategy varies: a unit test (one case),
property tests (random inputs), fuzzing (coverage-guided inputs), DST
(interleavings of time, network and faults). verdict doesn't manage
environments. A test does its own setup, the way E2E frameworks already do, and
verdict will likely use those frameworks under the hood.

When the project already has a test that checks the law, the planner points at
it rather than copying it: its path outside `.verdict/`, the test's name if the
file has others, and its scope in the lock. verdict never edits that file. The
name is passed to the runner (`-t` for bun, vitest and jest, `-g` for
playwright, `-run` for go, a pytest node id).

### Judges

- **LLM judge.** An agent with read access. Its file holds the law and optional
  hints; it gathers whatever context it needs.
- **Decision model** (kind `decision`; TypeSafe's jev by default). One tool among
  several, not a replacement for LLMs; decision models are young and can be
  wrong. It can't look around, so:
  - Its input comes from a deterministic command written at plan time
    (`state_from`), which the reviewer can see.
  - "Inconclusive" is a real answer: the choice options are always `pass`,
    `fail` and `inconclusive` (so no mapping field is needed), and a selected
    option below `min_probability` counts as inconclusive. Either way, an LLM
    judge in the same lock entry runs instead. No `otherwise` field: the
    fallback is inferred from the entry.

```json
{
  "state_from": "git diff --cached -- '*.ts' '*.tsx'",
  "instructions": "Do the user-facing error messages added in this diff tell the user what to do next?",
  "criteria": {
    "pass": "Every new message names a next step",
    "fail": "At least one new message gives no next step",
    "inconclusive": "Can't tell from this diff alone"
  },
  "min_probability": 0.85
}
```

### TLA+ and drift from the code

A spec proves the design, not the code. To catch the code drifting away from
the spec, a law checked with TLA+ gets two enforcers:

1. The spec itself, which shows the design is correct.
2. Tests generated from the spec. A model checker (TLC or Apalache) walks the
   spec's possible behaviours; each one is replayed against the real app through
   an adapter that maps spec actions (`Charge`, `Timeout`, `Retry`) to the app's
   public calls. The planner generates the adapter and a person reviews it. If
   the code drifts, the adapter breaks or the tests fail. Large state spaces are
   handled by a depth limit or by sampling, which is a setting on the test.

## Suggestions, not enforcement

Some good ideas mean changing the system, so `verdict plan` prints them for a
person to act on, and they never go in the lock:

- Encode a law in types (e.g. a `Cents` type). Once the type exists, a lint rule
  can enforce that everyone uses it.
- Make the system deterministic so DST can run.
- Instrument the code for TLA+ trace validation.
- Rewrite a law that seems vague (e.g. the decision model is unsure on the planner's own
  examples).
- Flag a law that is false in today's code.

## Implementation (v1)

TypeScript on Bun. `bun src/cli.ts plan|check [path...]`.

verdict runs its agents (the planner and the LLM judge) on a coding agent the
user already has and is logged into, the way bb does: no model API keys and no
AI library in between. `VERDICT_AGENT` picks one, and `VERDICT_MODEL` is that
agent's own model name. Each adapter (`src/agents/`) runs one task: it gives the
agent verdict's tools and lets the agent run its own loop until `submit` is
accepted.

| Agent | Talks to | verdict's tools reach it as | Built-in tools |
|---|---|---|---|
| claude-code (default) | Claude Agent SDK | an in-process MCP server | off (`tools: []`); the user's MCP servers, settings and hooks are ignored |
| codex | `codex app-server`, JSON-RPC 2.0 on stdio | dynamic tools (experimental API) | its shell can't be switched off, so the whole app-server runs in verdict's sandbox with no network of its own (see below) |
| pi | Pi's SDK (`@earendil-works/pi-coding-agent`), in process | custom tools | off (`noTools: "all"` plus an allowlist); no extensions, skills, prompt templates or context files; in-memory session |

Tool input is validated against the tool's zod schema in verdict
(`callTool`), whichever agent calls it.

### Confinement while planning

The planner reads text from the repo, so a comment in the repo can steer it.
Everything it can cause to run is therefore confined:

- Code it runs (its tests and scripts, programs called through `run`, a
  decision file's `state_from`, enforcers already in the lock when `plan`
  re-proves them) runs on a scratch copy of the working tree, inside an OS
  sandbox (`src/sandbox.ts`): macOS `sandbox-exec`, Linux bubblewrap. Inside,
  it can write only to the scratch copy, can't read the user's home beyond the
  repo and the tools on PATH, gets a scrubbed environment with a fresh HOME,
  and has no network except localhost. With no sandbox available verdict
  refuses to run the code (the enforcer is inconclusive). `VERDICT_SANDBOX=off`
  turns it off, for when verdict itself already runs in a sandbox (macOS
  sandboxes don't nest).
- File tools resolve every path, refuse anything outside the repo, refuse
  dangling symlinks, and `write_file` writes only in `.verdict/`.
- The git tool allows a fixed list of flags per subcommand.
- Codex's shell can't be switched off, so its threads run with approval
  policy `untrusted`: only Codex's built-in safe read-only commands run
  without asking, and verdict declines every approval request. The app-server
  also runs in the same sandbox, with no network of its own: its only way out is verdict's
  egress proxy (`src/agents/egress.ts`), which tunnels HTTPS to OpenAI's hosts
  (`VERDICT_CODEX_HOSTS`) and refuses everything else. On macOS the sandbox
  allows only the proxy's localhost port; on Linux the sandbox has its own
  network namespace, and a forwarder inside it (`src/agents/netns-forward.ts`)
  reaches the proxy over a unix socket. Codex follows the proxy because its
  throwaway home turns on `respect_system_proxy`; if it connects directly, the
  sandbox refuses, so this fails closed. That throwaway home, under
  `~/.cache/verdict` where other sandboxes can't read, holds only a copy of
  `auth.json`, and nothing is copied back from it: a login written in the
  sandbox can't be trusted. If Codex refreshed it, verdict says the user may
  need to run `codex login`. Remaining risk: a safe-listed read can put the
  repo or the login copy into the model's context; from there it can leave
  only through Codex's own requests to OpenAI or through files in `.verdict/`,
  which a person reviews. On macOS, Codex's sandbox also denies reads outside
  the system, installed tools, the repo, and Codex's install and home: other
  users' files, other volumes and the rest of the user's disk are out of
  reach, not only the home directory, including through the data volume's
  other name (/System/Volumes/Data). On Linux, Codex's sandbox starts from an
  empty root and binds back only /usr, /bin, /lib, /etc and the like, tool
  installs on PATH, and the paths it needs (untested on Linux so far). With
  `VERDICT_SANDBOX=off` verdict refuses to start Codex, since nothing would
  confine its shell.

`verdict check` runs the reviewed enforcers in the real repo, unsandboxed:
they are code that passed the merge review.

Decision models (jev) go through TypeSafe's own AI SDK provider
(`TYPESAFE_AI_API_KEY`) and the SDK's `experimental_decide`, the only use of
the `ai` package. `VERDICT_DECISION_MODEL` defaults to `jev-1.14.0`, pinned
because `jev-latest` changes results on each release.

How each kind runs. These rules are inferred, not configured:

| Kind | Command | Pass / fail / inconclusive |
|---|---|---|
| semgrep | `semgrep scan --config <file> --error` over the whole repo | exit 0 / 1 / other, or semgrep missing |
| lint | The linter the config file belongs to (eslint, oxlint, ruff), under that config, over the scope's files; first asks it whether the rule applies to each file | no findings for the rule / findings, or the rule off for any file / linter missing or can't say |
| test | Inferred from the file name: `*.test.*`/`*.spec.*` → vitest, jest, playwright or bun test (from package.json); `*_test.go` → go test; `test_*.py` → pytest; an executable file → run it. A `name` selects one test | exit 0 / non-zero, or exit 0 with no test run / 77 (automake's "skipped": a precondition is missing) or runner missing |
| tla | TLC (`tlc` on PATH or `VERDICT_TLA2TOOLS` jar); `<spec>.cfg` next to it | exit 0 / 10–14 (violations) / other |
| decision | `sh -c state_from`, then one choice question | see Judges |
| llm | A tool loop with read_file, list_files, grep and read-only git; ends with a submit tool | the judge's answer |

Within a law: any fail → fail, else any inconclusive → inconclusive. `check`
exits 1 if a law fails or isn't planned. Inconclusive doesn't fail the run.

The planner is the same tool loop, plus `run_enforcer`, `try_break` (a break on
a scratch copy) and `write_file`, which is confined to
`.verdict/`, and `run`, which runs allowlisted programs (semgrep, test runners,
tlc, type-aware tools) or its own scripts in `.verdict/`, with no shell, so it
can validate what it wrote. Its `submit` is checked before it's accepted: each
enforcer is inside `.verdict/`, has a scope line, and either fails today (with a
finding) or fails on its break. Outside `.verdict/`, only a test or a linter
config the repo already has is allowed, with its scope given in the submission. A rejected submit goes back to the planner with
the reason.

Gaps in v1:
- A judge's eval is its break, run at plan time. There is no larger eval set
  yet, so `min_probability` isn't tuned per law.
- Files in `.verdict/` are not cleaned up when a law is removed. The lock entry
  is.
- Hashes are 8 hex characters.

## Not in v1

- Type-based enforcement suggestions (later iteration).
- Linter conventions: baselines, severity, autofix. (Suppressions are warned
  about, and SARIF is the one output format besides text.)
- Lint enforcers for linters other than eslint, oxlint and ruff (golangci-lint,
  clippy, biome…); until then, an executable test runs them.
- A `.verdict/` enforcer's helpers are found by name (other `.verdict/` files
  its text mentions), not by resolving imports.

## Prior art to keep in mind

- Bend 2's LAWS.bend + PROOF.bend: humans write the laws, an AI writes the proofs.
- Lockfiles (package-lock.json) for the generated plan.
- ESLint / Semgrep / ruff conventions, for when we need them.
- Gherkin/Cucumber as a cautionary tale: prose specs whose hand-maintained glue
  code rotted. Generated, reviewed glue is the bet here.
- Model-based testing from TLA+ (MongoDB, Informal Systems' Modelator); trace
  validation (Microsoft CCF).
- JEV-as-a-Judge (arXiv 2609.26550) and JEV vs. LLMs as Rubric Judges
  (arXiv 2609.29769).
