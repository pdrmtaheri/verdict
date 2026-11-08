# Planner: everything it runs writes only to a scratch copy

scope: the code paths through which the planner (or a judge's tools) starts a program or edits a file: `run` in writeTools() (src/tools.ts), run() and the runners in src/enforcers.ts, prove() and runInScratch() in src/breaks.ts, withScratch() in src/scratch.ts, sandboxed()/macProfile()/bwrapArgs() in src/sandbox.ts, and the callers in src/plan.ts and src/reprove.ts. Judges from the code's text whether each started program is confined by the OS sandbox with write access only to a scratch copy (plus the sandbox's own throwaway dir), and whether the real repo is only readable. Does not run anything; the behaviour of where things run is tested in planner-scratch-boundary.test.ts, which runs with VERDICT_SANDBOX=off. The VERDICT_SANDBOX=off opt-out is documented as for use only when something else already confines verdict: do not fail it by itself. Does not cover reads, the network, or the agents' built-in tools (agent-builtin-tools.judge.md).

## What to check

1. `run` in src/tools.ts: the `Box` passed to `sandboxed()` has `writable` containing only the scratch `copy`, never `repo` or `root`; the program runs with cwd inside the copy; scripts must be inside the law's `.verdict/` (the `inside(root, bin, outDir)` check).
2. src/enforcers.ts `run()`: when `ctx.sandbox` is set, `writable` is only the context's repo (which, while planning, is a scratch copy), and `readable` may include the real repo but not as writable. Check semgrep, test, tla and decision (`state_from`) all go through `run()` and none call `exec` directly with `ctx.sandbox` set. The tla runner's metadir must be inside root when sandboxed.
3. src/breaks.ts: `prove()` and `runInScratch()` call `runEnforcer` with `root`/`repo` taken from the scratch copy (`inCopy`) and `sandbox` set; break edits go through `inside(dir, e.path, c.repo)` against the copy and refuse `.verdict/`.
4. src/sandbox.ts: the macOS profile denies `file-write*` and re-allows it only for `box.writable` and a few /dev files; bwrap mounts `/` read-only and binds only `box.writable` read-write. Look for any extra allow that makes the real repo or home writable.
5. src/plan.ts and src/reprove.ts: every place that runs a planner-written enforcer or a break uses `runInScratch` or `prove`, never `runEnforcer` with the real repo as root, and the planner's own tools write only through `write_file` (confined to `.verdict/`), `run` and `try_break`/`run_enforcer`.

## Pass criteria

- Every path that starts a planner-influenced program or applies an edit is confined as above, in the code as written.

## Fail criteria

- A program started for the planner can write to the real repo or any path outside a scratch copy (quote the file and line of the `writable` list or the direct `exec`).
- A planner-reachable path writes to the real repo outside `.verdict/` other than `write_file`.
- A comment says a path is confined and the code does not match.

## Notes for the judge

- Cite the code, not what you assume. If the text does not settle it, say inconclusive and name what you could not check.
- src/check.ts runs enforcers on the real repo without a sandbox on purpose (it only runs `verdict check`, which reruns already-planned enforcers); that is covered by another law, do not fail this one for it.
