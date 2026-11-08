# Context for agents working on verdict

Read DESIGN.md first; it holds the decisions. This file holds what DESIGN.md
doesn't: how we got there, what was considered and rejected and why, and how
Pedram likes to work on this. It summarises a bb design thread
(thr_rm66x3dph4, "Unify project checks in LAWS.md", 2026-11-07). Use
`bb thread log thr_rm66x3dph4` if you need the full conversation.

## Where it came from

Pedram noticed that .lintrules.yml files, AGENTS.md files, Bend 2's LAWS.bend and
TLA+ specs are all checks: assertions about a system. QA and E2E flows are too.
His position: move one level up the abstraction tree. Write the assertion once;
how it's enforced (linter, TLA+, jev, LLM judge, tests) is an implementation
detail that an LLM proposes.

## How Pedram wants this designed

- **Bare bones.** Don't add a feature or copy a convention until there's a need
  for it. Keep good prior designs (ESLint, Semgrep, ruff, lockfiles) in mind,
  but don't import them early.
- **Remove what can be inferred.** Most of the design converged by deleting
  fields that the planner or the enforcer can work out.
- **Language-agnostic.** The framework must not depend on any language.
- **Humans review everything.** The verification stack is generated code
  reviewed at merge, not a fully agentic system. Don't build approval
  mechanisms; the merge review is the approval.
- **jev is one tool, not the centre.** Decision models are young and can be
  inaccurate. Don't let jev displace LLM judges.

## Rejected ideas and why (don't reintroduce without a reason)

| Idea | Why it was dropped |
|---|---|
| `when` field (edit / CI / runtime) | That's a trigger. verdict is a CLI anyone can call; when to check is the caller's concern. |
| `strength` (proven / tested / judged) | You'd want "proven" on every law, and that's impossible. The enforcer already implies the guarantee. |
| `subject` (code / product / transcript) | It follows from the enforcer: Semgrep reads code, Playwright drives the app. |
| Gradually moving laws from LLM judges to cheaper checks over time | The planner can propose the right enforcer upfront and validate it upfront. |
| Approval fields / tying approval to the law hash | The merge review already does this. |
| `samples` / `verify` in the lockfile | Examples matter only for pattern rules (as the rule's own tests) and judges (as evals). They ship with the enforcer, not in the lock. Proofs and tests need none. |
| `holds_today` | That's run output, not config. When a baseline is needed, borrow it from linters (ESLint bulk suppressions, RuboCop todo, PHPStan baseline). |
| Type enforcer as an enforcer kind | It changes the system instead of observing it, and it depends on the language. Kept as a future suggestion feature ("encode this as a Cents type"). |
| Law IDs (L-007) | Not needed: a list of strings. The lock is keyed by a generated hash of the normalised text. |
| `law_hash` as a typed field | Kept, but generated. Its job is detecting a changed law so the lock gets re-planned. |
| Fuzzing / DST / property tests as separate kinds | They're all tests: the law is the oracle, and they differ only in search strategy. DST also needs a deterministic system, so it's a suggestion. |
| TLA+ trace validation as the drift check | It needs code instrumentation, which breaks "observe from outside". Pedram picked model-based tests generated from the spec instead. |

## Settled answers to the last open questions

1. `verdict check` runs every law by default.
2. Environment setup for E2E and spec-generated tests: do whatever E2E testing
   frameworks do; verdict will likely use them under the hood.
3. Results: pass / fail / inconclusive per law, a message quoting the law, exit
   code 0/1. Nothing fancier for now.
4. If no enforcer fits, an LLM judge always does.

## Assumptions not yet confirmed

- The 0.85 threshold (`min_probability`) is illustrative; it should be tuned
  per law against evals.

## Decided while building v1 (2026-11-07)

- Names: CLI `verdict`; files VERDICT.md / VERDICT.lock / .verdict/ (Pedram
  picked renaming the files to match the CLI).
- TypeScript on Bun, latest versions of every dependency (TypeScript 7).
- Provider-agnostic: Vercel AI SDK (`ai` v7), not a vendor SDK. Pedram
  explicitly rejected using Anthropic's SDK. TanStack AI was the alternative;
  the AI SDK won on maturity and because it has `experimental_decide` with a
  TypeSafe (jev) provider.
- Model routing (2026-11-08): verdict runs on coding agents the user is
  already logged into (Claude Code, Codex, Pi), like bb (github.com/get-bb/bb):
  Claude Agent SDK for Claude Code, `codex app-server` JSON-RPC with dynamic
  tools for Codex, and Pi's SDK for Pi. How it got here: Vercel AI Gateway
  first (its free tier blocks every model worth using; the one free model is
  capped at 5 requests a minute), then OpenRouter (dropped), then the community
  AI SDK provider for Claude Code (worked), then Pedram asked to drop the
  gateway and the AI SDK route and copy bb. The AI SDK provider for Pi
  couldn't take custom tools; Pi's own SDK can.
- jev stays, through TypeSafe's own provider (TYPESAFE_AI_API_KEY). That is
  the one model dependency outside the three agents, and the only reason the
  `ai` package is still installed.
- jev became the generic `decision` kind. The file's `accept_if` / `otherwise`
  were removed: choices are always pass/fail/inconclusive, and the fallback is
  any `llm` enforcer in the same entry.
- All enforcer kinds are in the first slice.
- Semgrep is the only lint kind (2026-11-08). The first build also had oxlint,
  ESLint, ruff, golangci-lint and ast-grep runners; Pedram chose to simplify.
  Why: one rule and test format for every language, and ruff can't do custom
  rules anyway. What native analyzers add is type information, so type-aware
  rules run as executable `test` scripts that call those tools (built-in rule
  or a custom analyzer in .verdict/). See DESIGN.md "Pattern rules and
  type-aware rules". Don't reintroduce per-linter kinds without a law that
  needs one.

## Facts about external tools gathered during design (verify before relying on them)

- **jev** (TypeSafe AI): a decision model, not a text generator. Request
  = `state` (text/JSON, ~32k tokens) + typed `questions`
  (choice / score / yes-no). It returns probabilities and confidence. Reported
  ~0.2 s and ~$0.0004 per decision. Weak at derived reasoning (math, code,
  logic, counting, dates). Closed weights. Sources disagree on whether its
  answers are deterministic. Text only.
  - JEV-as-a-Judge (arXiv 2609.26550): accepting confident verdicts and
    escalating the rest matched or beat GPT-6 at ~41% of its cost. Weaker on
    math, code and logic.
  - JEV vs. LLMs as Rubric Judges (arXiv 2609.29769): LLM judges cost 16–357x
    as much. Over 85% of LLM verdicts on jev's most confident errors repeat
    them, so escalating doesn't fix correlated errors; deterministic enforcers
    do.
- **Bend 2** (github.com/bendlang/bend): LAWS.bend declares invariants, PROOF.bend
  holds proofs (AI-written), and `bend PROOF.bend` checks them. In one reported
  trial, 4 of ~20 agent-proposed laws turned out to be false, which is why
  `verdict plan` should flag laws that are false in today's code.

## Borrowed from pstack's verification skills (2026-11-08)

From create/maintain-(formal-)verification-skill, Pedram took:
- Every enforcer must be seen to fail on a break (plan rejects it otherwise).
- Findings stay findings: never weaken an enforcer to pass.
- Scope line in every enforcer file; check prints it.
- E2E proof standards in the planner prompt; exit 77 = inconclusive.
- Re-proving on today's code to catch vacuous passes. First built as a
  separate `verdict audit`; Pedram rejected that: "why can't it be the same as
  plan", like package managers where sync and update are one command over one
  lockfile. So `plan` is the sync: plan new laws, re-prove planned ones, re-plan
  drift. Don't reintroduce a separate audit/maintain command.
Skipped: the feature map (VERDICT.md is that), launch/doctor sections (tests
own their setup), a stored sync commit (inferred from git), one PR per pass (a
trigger).

## verdict's planner attacked verdict (2026-11-08)

The first real `plan` on verdict's own VERDICT.md (Claude Code, Haiku) found
law 2 (agent tools stay in the repo; the planner writes only in .verdict/)
false, with working exploits: `run` allowed `bun -e`/`python3 -c`; planner-
written tests and `state_from` ran unconfined; `git blame -S<file>` read
outside the repo; write_file followed a dangling symlink; Codex's shell could
read anywhere. Fixed with an OS sandbox around everything the planner causes
to run (src/sandbox.ts), a per-subcommand git flag allowlist, and refusing
dangling symlinks. Laws 3 (check's exit code) and 4 (error messages say what
to do next) were also found false and are not fixed yet. The planner also
noted that law 2's "never writes outside .verdict/" conflicts with scratch
copies in TMPDIR; the wording is Pedram's call.

## Codex egress (2026-11-08)

Codex's shell could read the copied login and use Codex's network. Fixed by
giving the app-server no network at all and an HTTPS-only CONNECT proxy to
OpenAI's hosts; Codex is told to use it through `respect_system_proxy` in its
throwaway config. Not verified live (this dev session can't run Codex or nest
sandboxes): if Codex ignores the proxy it fails to connect rather than
connecting directly. Check this on a real machine with VERDICT_AGENT=codex.
