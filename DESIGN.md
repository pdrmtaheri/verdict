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
.verdict/       # generated enforcers and their tests/evals
```

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
```

Nothing else goes in the lock: no severity, no trigger, no "holds today" state,
no approval. Those are either inferred, run output, or the merge review's job.

## Commands

- `verdict plan`: for each law not in the lock, or whose hash changed: pick
  enforcer(s), generate them with their tests or evals, and write the lock entry.
  Suggestions that would mean changing the system (see below) are printed, not
  written to the lock.
- `verdict check`: run every law's enforcers (all laws by default). Per law, the
  result is pass, fail or inconclusive, with a message quoting the law. Exit 0
  when everything passes, 1 on any failure. Also reports laws that aren't
  planned or whose hash is stale.

## Enforcer kinds

All four observe from outside.

| Kind | Covers | Ships with | Picked when the law is… |
|---|---|---|---|
| Lint / pattern | Semgrep only (type-aware rules: see below) | Should-flag / should-pass tests in the tool's own format | About the shape of the code |
| Tests | Unit, property, fuzz, E2E, DST, spec-generated | Nothing extra: the test is the example | About behaviour |
| Proofs / models | TLA+, Bend | Nothing extra: a checker verifies it | An invariant worth proving |
| Judges | LLM, decision models (jev) | Evals | Readable but not mechanical (copy, docs, transcripts) |

If no other kind fits, an LLM judge always does, so no law goes without an
enforcer.

### Pattern rules and type-aware rules

Semgrep is the only pattern-rule engine: one rule format and one test format
(`semgrep --test`) across every language. Semgrep mostly matches syntax, so a
law that depends on types goes down this list, stopping at the first rung that
can express it:

1. Semgrep typed metavariables (`(float $X)`) where the language supports them.
2. An executable test script that runs one built-in rule of a type-aware tool
   the repo already uses (`cargo clippy -- -D clippy::float_arithmetic`, a
   typescript-eslint typed rule, `ruff --select`).
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

TypeScript on Bun. `bun src/cli.ts plan|check`. Models go through the Vercel
AI SDK, so no provider is built in. IDs are `provider:model` and are set by
`VERDICT_MODEL` (default `anthropic:claude-opus-5-5`) and `VERDICT_DECISION_MODEL`
(default `typesafe:jev-latest`). Registered providers: anthropic, openai, google,
typesafe, and gateway for everything else. Decision models use the SDK's
`experimental_decide`.

How each kind runs. These rules are inferred, not configured:

| Kind | Command | Pass / fail / inconclusive |
|---|---|---|
| semgrep | `semgrep scan --config <file> --error` over the whole repo | exit 0 / 1 / other, or semgrep missing |
| test | Inferred from the file name: `*.test.*`/`*.spec.*` → vitest, jest, playwright or bun test (from package.json); `*_test.go` → go test; `test_*.py` → pytest; an executable file → run it | exit 0 / non-zero / runner missing |
| tla | TLC (`tlc` on PATH or `VERDICT_TLA2TOOLS` jar); `<spec>.cfg` next to it | exit 0 / 10–14 (violations) / other |
| decision | `sh -c state_from`, then one choice question | see Judges |
| llm | A tool loop with read_file, list_files, grep and read-only git; ends with a submit tool | the judge's answer |

Within a law: any fail → fail, else any inconclusive → inconclusive. `check`
exits 1 if a law fails or isn't planned. Inconclusive doesn't fail the run.

The planner is the same tool loop, plus `write_file`, which is confined to
`.verdict/`, and `run`, which runs allowlisted programs (semgrep, test runners,
tlc, type-aware tools) or its own scripts in `.verdict/`, with no shell, so it
can validate what it wrote. After writing a lock
entry, `plan` runs the law once and flags it if it's false today.

Gaps in v1:
- Judge evals are not generated or run yet. There is no consumer for them.
- Files in `.verdict/` are not cleaned up when a law is removed. The lock entry
  is.
- Hashes are 8 hex characters.

## Not in v1

- Type-based enforcement suggestions (later iteration).
- Linter conventions: baselines, inline suppressions, severity, output formats,
  autofix, per-path overrides.

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
