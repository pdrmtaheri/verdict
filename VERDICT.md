# verdict's own laws

- Only src/agents/ and src/models.ts talk to a coding agent or a model
  provider; everything else goes through runAgent() or decisionModel().
- An agent's file tools never read or write outside the repository, and the
  planner never writes outside .verdict/.
- `verdict check` exits 0 only when no law fails and every law is planned.
- Error messages tell the user what to do next.
