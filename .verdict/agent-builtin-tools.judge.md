# Agent built-in tools: judge

scope: the three coding-agent adapters in src/agents/ (claude-code.ts, codex.ts, pi.ts) and the runAgent() gateway in src/agent.ts. Judges whether an agent's own built-in tools (shell, read, write, edit) can read or write outside the repository, from the configuration the code sets. Does not run any agent, does not cover verdict's own tools (agent-read-boundary.test.ts and planner-write-boundary.test.ts do), the network, or OS permissions.

## What to check

1. src/agents/claude-code.ts: the options passed to query() must turn off Claude Code's built-in tools (`tools: []`), leave only verdict's MCP tools allowed, and ignore the user's and repo's settings (`settingSources: []`).
2. src/agents/pi.ts: the session must have built-in tools off (`noTools: "all"`) and only verdict's custom tools enabled (`tools: Object.keys(task.tools)`). Extensions, skills and context files must stay off.
3. src/agents/codex.ts: the thread must not give the agent a shell or file tools that can reach outside the repo. Read the comments and the `thread/start` options (`sandbox`, `approvalPolicy`). A read-only sandbox that still lets the shell read the whole disk is a read outside the repo.
4. src/agent.ts: runAgent() must give every adapter only the tools built from its `tools` argument, and no adapter may add its own.

## Pass criteria

- Each adapter has its built-in tools off, or confines them to the repo, in the code as written.
- Any text a comment says about the built-in tools matches the code.

## Fail criteria

- An adapter leaves a built-in tool on that can read or write outside the repo. Quote the file and line of the setting that leaves it on.
- Codex's built-in shell can read files outside the repo: the code sets `sandbox: "read-only"` and says the shell "can read but not write". Judge this as a fail, quoting src/agents/codex.ts, unless the code, in the repo, shows the sandbox limits reads to the repo.
- Any adapter adds tools or settings that let the agent reach files outside the repo.

## Notes for the judge

- Cite the setting in the code, not what you assume the SDK does. If the code's text does not settle the question, say inconclusive and name the exact SDK default you could not check.
- Do not judge the verdict tools in src/tools.ts; other enforcers cover them.
