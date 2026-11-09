---
name: create-playground
description: Create a verdict playground for an idea. Use when the user wants an interactive playground where a connected coding agent builds something (a library, a parser, or a service) while verdict checks laws about it. Writes PLAYGROUND.json, starter laws, and a README, validates them, and launches the playground.
---

# Create a verdict playground

A playground is a normal verdict repo plus a `PLAYGROUND.json`. One runtime,
`verdict playground`, serves every playground. It runs a local web UI and an
MCP endpoint that the user's coding agent connects to. You write only the
idea: the manifest and the laws. Do not write UI code or the program itself.
The connected agent builds the program.

## Steps

1. Ask the user at most three questions. Skip any question the user already
   answered.
   - What should it do, in one sentence?
   - What must never go wrong? The answers become laws.
   - Which language and test runner? The default is TypeScript with
     `bun test`.
2. Pick a directory. Use `playgrounds/<slug>/` under the current repo unless
   the user names one. If the directory already exists, ask before you write
   into it. Never overwrite it without asking.
3. Write the files from `template/` in this skill:
   - `PLAYGROUND.json`: a `title`, a one-line `idea`, and a `brief`. The brief
     tells the agent where code and tests go, tells it to work law by law,
     and says that a law failing today is a finding, never something to
     weaken. Keep `writable` to top-level directory names, such as `src`,
     `test`, and `.verdict`. Never list `VERDICT.md`, `VERDICT.lock`, or
     `PLAYGROUND.json`.
   - `VERDICT.md`: 3 to 6 laws, one top-level bullet each, in prose that a
     person could check. Laws are about behaviour or code shape, not about
     steps to implement. Write no IDs and no enforcer names. verdict plans
     the enforcers.
   - `README.md`: the two commands from steps 4 and 5.
4. Validate the playground with `verdict playground validate <dir>`. Fix every
   problem it prints, and rerun it until it exits 0.
5. If the user wants the playground now, launch it with
   `verdict playground <dir>`. Give the user the printed UI URL and the
   `claude mcp add ...` line exactly as printed. The URL carries a secret
   token. Do not paste it anywhere else.

## Rules

- Do not run `verdict plan` yourself, because it spends the user's
  coding-agent quota. Tell the user that the connected agent or the UI's
  **Plan** button runs it.
- Keep the brief under 15 lines. The agent can read the laws itself.
- Never put secrets, tokens, or absolute paths in the manifest.
