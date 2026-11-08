# Agent built-in tools: judge

scope: the three coding-agent adapters in src/agents/ (claude-code.ts, codex.ts, pi.ts), the runAgent() gateway in src/agent.ts, and the OS sandbox Codex runs in (src/sandbox.ts: macProfile() and bwrapArgs()). Judges whether an agent's own built-in tools (shell, read, write, edit) can read or write outside the repository, on each platform verdict supports (macOS and Linux), from the configuration the code sets. Does not run any agent, does not cover verdict's own tools (agent-read-boundary.test.ts and planner-scratch-boundary.test.ts do), the network, or OS permissions beyond what the code's text shows.

## What to check

1. src/agents/claude-code.ts: the options passed to query() must turn off Claude Code's built-in tools (`tools: []`), leave only verdict's MCP tools allowed, and ignore the user's and repo's settings (`settingSources: []`).
2. src/agents/pi.ts: the session must have built-in tools off (`noTools: "all"`) and only verdict's custom tools enabled (`tools: Object.keys(task.tools)`). Extensions, skills and context files must stay off.
3. src/agents/codex.ts: Codex has no switch for its built-in shell (`sandbox: "danger-full-access"`, `approvalPolicy: "untrusted"` lets its safe-listed read commands such as cat, ls and rg run without asking). So the question is whether verdict's OS sandbox, which the app-server runs in (`box` in launch(), `readsListedOnly: true`), limits what that shell can read to the repo. Read src/sandbox.ts for BOTH platforms:
   - macOS, macProfile(): which paths are allowed for `file-read*` with `readsListedOnly`.
   - Linux, bwrapArgs(): what is mounted and readable. `--ro-bind / /` leaves the whole filesystem readable except what is then hidden by `--tmpfs`.
   Also check that with `VERDICT_SANDBOX=off` Codex is refused rather than started unconfined.
4. src/agent.ts: runAgent() must give every adapter only the tools built from its `tools` argument, and no adapter may add its own.

## Pass criteria

- Each adapter has its built-in tools off, or its OS sandbox confines their reads and writes to the repo (plus the minimum the program needs to start: its own install and throwaway home, the system and tool directories), on every supported platform, in the code as written.
- Any text a comment or DESIGN.md says about the built-in tools matches the code.

## Fail criteria

- An adapter leaves a built-in tool on that can read or write outside the repo on any supported platform. Quote the file and line of the setting that leaves it on, and name the platform.
- Codex's built-in shell can read files outside the repo and the minimum it needs to run: for example on Linux, where bwrapArgs() binds `/` read-only and hides only home, /tmp and /run, so /etc, /var, /opt and other users' files stay readable, or any platform where `readsListedOnly` is not applied to Codex's box.
- Any adapter adds tools or settings that let the agent reach files outside the repo.

## Notes for the judge

- Cite the setting in the code, not what you assume the SDK does. If the code's text does not settle the question, say inconclusive and name the exact SDK default you could not check.
- Do not judge the verdict tools in src/tools.ts; other enforcers cover them.
- A comment or doc that admits a platform is not confined is evidence of a fail, not an excuse.
