---
name: create-playground
description: Create a verdict playground for an idea. Use when the user wants an interactive playground where a connected coding agent builds something (a library, a parser, a service) while verdict checks laws about it. Scaffolds PLAYGROUND.json, starter laws and a README, validates it, and launches it.
---

# Create a verdict playground

A playground is a normal verdict repo plus a `PLAYGROUND.json`. Every playground
is served by the same runtime (`verdict playground`): a local web UI and an MCP
endpoint the user's coding agent connects to. You are writing only the idea:
the manifest and the laws. Do not write UI code or the program itself; the
connected agent builds the program.

## Steps

1. **Ask the user at most three things**, skipping any they already said:
   - What should it do, in a sentence?
   - What must never go wrong? (these become laws)
   - Language and test runner (default: TypeScript, `bun test`).
2. **Pick a directory**: `playgrounds/<slug>/` under the current repo unless the
   user names one. Do not overwrite an existing directory; ask first.
3. **Write the files** from `template/` in this skill:
   - `PLAYGROUND.json`: `title`, a one-line `idea`, and a `brief` that tells the
     agent where code and tests go, to work law by law, and that a law failing
     today is a finding, never something to weaken. Keep `writable` to top-level
     directory names (`src`, `test`, `.verdict`). Never list `VERDICT.md`,
     `VERDICT.lock` or `PLAYGROUND.json`.
   - `VERDICT.md`: 3 to 6 laws, one top-level bullet each, in prose a person
     could check. Laws are about behaviour or code shape, not implementation
     steps. No IDs, no enforcer names; verdict plans those.
   - `README.md`: the two commands below.
4. **Validate**: `verdict playground validate <dir>`. Fix every problem it prints
   and rerun until it exits 0.
5. **Launch** (when the user wants it now): `verdict playground <dir>`, then give
   the user the printed UI URL and the `claude mcp add ...` line verbatim. The
   URL carries a secret token; do not paste it anywhere else.

## Rules

- Do not run `verdict plan` yourself: it spends the user's coding-agent quota.
  Tell them the connected agent or the UI's Plan button will do it.
- Keep the brief under 15 lines. The agent can read the laws itself.
- Never put secrets, tokens or absolute paths in the manifest.
