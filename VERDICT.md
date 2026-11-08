# verdict's own laws

- Only src/models.ts imports a model provider package (`@ai-sdk/*`); everything
  else goes through the provider-agnostic `ai` package.
- An agent's file tools never read or write outside the repository, and the
  planner never writes outside .verdict/.
- `verdict check` exits 0 only when no law fails and every law is planned.
- Error messages tell the user what to do next.
