#!/bin/sh
# scope: every file under src/ linted by oxlint's no-eval, no-new-func and no-implied-eval rules (direct eval, indirect/global eval, Function constructor with or without new, string-argument setTimeout/setInterval). Does not cover the node:vm module or aliasing beyond what oxlint resolves.
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.." || exit 1
if command -v oxlint >/dev/null 2>&1; then
  OX="oxlint"
elif [ -x node_modules/.bin/oxlint ]; then
  OX="node_modules/.bin/oxlint"
else
  echo "oxlint not available" >&2
  exit 77
fi
exec $OX -c "$here/no-eval.json" src
