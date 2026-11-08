# verdict's own laws

- Only src/agents/ and src/models.ts talk to a coding agent or a model
  provider; everything else goes through runAgent() or decisionModel().
- An agent's file tools never read or write outside the repository, and the
  planner never writes outside .verdict/.
- `verdict check` exits 0 only when no law fails and every law is planned.
- Error messages tell the user what to do next.
- Once the planner's submission is accepted, nothing the agent does afterwards
  changes the plan: no later or concurrent submit is validated or accepted, and
  runAgent returns the first submission it accepted.
- However `verdict plan` is interrupted, and in whatever order laws are added,
  reworded or removed, VERDICT.lock only holds entries for laws currently in
  VERDICT.md, and running plan to completion afterwards leaves every law planned.
- The egress proxy never opens a connection to a host or port outside its
  allowlist, however the request is split across packets, cased or padded.
- `verdict check` never changes the repository: after it runs, git status and
  the contents of every file are what they were before.
- `verdict plan` on a repo whose laws are all in sync, with every break still
  caught, finishes without starting a coding agent.
- Re-wrapping or re-indenting a law in VERDICT.md never makes `verdict check`
  report it as not planned; changing any of its words does.
