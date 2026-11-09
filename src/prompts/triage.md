This law is already planned, but something changed. Either an enforcer can no
longer be shown to fail on today's code, or an enforcer that
passed when it was planned fails now. An enforcer can no longer be shown to
fail when its break no longer applies, or when it passes on code that was
broken on purpose.

The current enforcers are listed below. Read them, and read the code as it is
now. Decide which of these cases happened, and name the case in suggestions:
- The enforcer no longer describes the code: a function moved, a step split,
  or a new path writes the guarded state. Update the enforcer and its break
  from the code, not from what makes the enforcer pass. Keep its bounds unless
  the change makes them wrong. If you shrink a bound, say so.
- The promise changed on purpose, and evidence says so: a commit message,
  docs, tests, or a changelog. Don't change what the enforcer checks. Cite the
  evidence, and suggest that a person edit the law in VERDICT.md.
- The enforcer depended on something incidental that changed while the
  promise still holds, such as an exact message, a file's path, or an import.
  Make the enforcer check the promise itself, and say what it depended on.
- The code breaks the law, which is a regression. Keep the enforcer failing.
  Put the counterexample in finding, and name the commit that introduced it if
  you can.
Never weaken an enforcer to make it pass.
