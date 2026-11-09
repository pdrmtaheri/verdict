import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { callTool, overrides as agents, type Agent } from "../src/agent.ts";
import { parseLaws } from "../src/laws.ts";
import { makeLimit } from "../src/limit.ts";
import { Claims, plan } from "../src/plan.ts";
import { at } from "../src/where.ts";
import { repo } from "./helpers.ts";

afterEach(() => {
  delete agents.agent;
});

test("the limit never runs more jobs at once than allowed", async () => {
  const limit = makeLimit(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limit(async () => {
        peak = Math.max(peak, ++active);
        await Bun.sleep(10);
        active--;
      }),
    ),
  );
  expect(peak).toBe(2);
});

// An agent that writes a passing-today-but-breakable script for its law, waits
// a little (so runs overlap), and submits. It records how many ran at once.
function overlappingAgent(name: (prompt: string) => string) {
  let active = 0;
  const stats = { peak: 0, results: [] as string[] };
  const agent: Agent = {
    name: "overlapping",
    async run(task) {
      stats.peak = Math.max(stats.peak, ++active);
      const file = `.verdict/${name(task.prompt)}.sh`;
      const w = await callTool(task.tools.write_file!, { path: file, content: "#!/bin/sh\n# scope: a.txt\ngrep -q ok a.txt\n", executable: true });
      stats.results.push(w.text);
      await Bun.sleep(50);
      active--;
      if (w.isError) return;
      await callTool(task.tools.submit!, {
        enforcers: [{ kind: "test", path: file }],
        breaks: [{ enforcer: file, description: "break a.txt", edits: [{ path: "a.txt", find: "ok", replace: "no" }] }],
        suggestions: [],
      });
    },
  };
  return { agent, stats };
}

test("laws are planned at the same time, up to the limit", async () => {
  const root = repo({ "a.txt": "ok\n" });
  const laws = parseLaws("- Law one.\n- Law two.\n- Law three.\n");
  const { agent, stats } = overlappingAgent((p) => (p.includes("one") ? "one" : p.includes("two") ? "two" : "three"));
  agents.agent = agent;
  const ok = await plan({ ...at(root), lockFile: join(root, "VERDICT.lock"), laws, lock: new Map() }, () => {}, { limit: makeLimit(3) });
  expect(ok).toBe(true);
  expect(stats.peak).toBe(3);
});

test("a planner can't overwrite a file another law is using", async () => {
  const root = repo({ "a.txt": "ok\n" });
  const laws = parseLaws("- Law one.\n- Law two.\n");
  const { agent, stats } = overlappingAgent(() => "same-name"); // both pick the same file
  agents.agent = agent;
  const log: string[] = [];
  await plan({ ...at(root), lockFile: join(root, "VERDICT.lock"), laws, lock: new Map() }, (l) => log.push(l), { limit: makeLimit(2), claims: new Claims() });
  expect(stats.results.filter((r) => r.includes("belongs to another law"))).toHaveLength(1);
});
