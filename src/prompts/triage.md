This law is already planned, but something changed: an enforcer can no
longer be shown to fail on today's code (its break no longer applies, or it
passes on code broken on purpose), or an enforcer passed when it was planned
and fails now. The current enforcers are listed below; read them, and read
the code as it is now. Decide which of these happened, and say which in
suggestions:
- The enforcer no longer describes the code (a function moved, a step split, a
  new path writes the guarded state). Update the enforcer and its break from the
  code, not from what makes it pass. Keep its bounds unless the change makes
  them wrong; if you shrink a bound, say so.
- The promise changed on purpose, and evidence says so (a commit message, docs,
  tests, a changelog). Don't change what the enforcer checks; cite the evidence
  and suggest that a person edit the law in VERDICT.md.
- The enforcer depended on something incidental that changed while the promise
  still holds: an exact message, a file's path, an import. Make it check the
  promise itself, and say what it depended on.
- The code breaks the law (a regression). Keep the enforcer failing and put the
  counterexample in finding, naming the commit that introduced it if you can.
Never weaken an enforcer to make it pass.