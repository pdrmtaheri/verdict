// scope: helper for plan-interrupt-lock.test.ts, not an enforcer. Runs what `verdict plan` runs in src/cli.ts (findSets, then plan() per set with shared Claims and limit) in the current directory, with a scripted agent standing in for the coding agent, and kills itself with SIGKILL at the point named by KILL_AT. After a run that was not killed it also runs check() and reproveLaw().
import "../test/preload.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const src = process.env.VERDICT_SRC!;
const { overrides, callTool } = await import(join(src, "agent.ts"));
const { findSets } = await import(join(src, "sets.ts"));
const { Claims, plan } = await import(join(src, "plan.ts"));
const { makeLimit, jobs } = await import(join(src, "limit.ts"));
const { check, exitCode } = await import(join(src, "check.ts"));
const { reproveLaw } = await import(join(src, "reprove.ts"));

const [killKind, killN] = (process.env.KILL_AT ?? "").split(":");
const n = Number(killN);
const die = () => process.kill(process.pid, "SIGKILL");
const SCRIPT = "#!/bin/sh\n# scope: src/money.ts only\ngrep -q cents src/money.ts\n";
const BREAK = { description: "store dollars", edits: [{ path: "src/money.ts", find: "cents", replace: "dollars" }] };
let starts = 0;
let writes = 0;
let submits = 0;

// Plans every law the same way: a script that greps for "cents", and a break that removes it.
overrides.agent = {
  name: "scripted",
  async run(task: { prompt: string; tools: Record<string, any> }) {
    starts++;
    if (killKind === "start" && starts === n) die();
    if (killKind === "mid" && starts === 1) setTimeout(die, n);
    const text = task.prompt.split("\n\n")[0]!.replace(/^Law: /, "");
    const path = `.verdict/${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.sh`;
    await callTool(task.tools.write_file, { path, content: SCRIPT, executable: true });
    writes++;
    if (killKind === "write" && writes === n) die();
    const enforcer = { kind: "test", path };
    const r = await callTool(task.tools.submit, { enforcers: [enforcer], breaks: [{ enforcer: path, ...BREAK }], suggestions: [] });
    if (!r.text.startsWith("accepted")) {
      console.error(`rejected: ${r.text}`);
      return;
    }
    submits++;
    if (killKind === "submit" && submits === n) die();
  },
};

const { repo, sets } = await findSets(process.cwd(), []);
const limit = makeLimit(jobs());
const claims = new Claims(sets);
const running = Promise.all(sets.map((set: any) => plan(set, set.lockFile, set.laws, set.lock, () => {}, { limit, claims })));
// plan() has already pruned the lock by now: its first steps run before its first await.
if (process.env.STARTED_MARKER) writeFileSync(process.env.STARTED_MARKER, "started");
const oks: boolean[] = await running;

const fresh = (await findSets(process.cwd(), [])).sets;
const planned: boolean[] = [];
const synced: boolean[] = [];
let code = 0;
for (const set of fresh) {
  const reports = await check(set, set.laws, set.lock, limit);
  code = Math.max(code, exitCode(reports));
  for (const law of set.laws) {
    planned.push(set.lock.has(law.hash));
    synced.push((await reproveLaw(set, law, set.lock)).outcome === "in sync");
  }
}
console.log("RESULT " + JSON.stringify({ ok: oks.every(Boolean), checkExit: code, planned, synced }));
void repo;
