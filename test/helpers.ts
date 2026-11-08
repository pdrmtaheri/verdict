import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTool, type Agent } from "../src/agent.ts";

export function repo(files: Record<string, string>, executable: string[] = []): string {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "verdict-test-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const path of executable) chmodSync(join(root, path), 0o755);
  return root;
}

// An agent that makes the given tool calls in order, and stops once a submit
// is accepted. It records the prompts it got and every tool result.
export function scriptedAgent(calls: { tool: string; input: unknown }[]): Agent & { prompts: string[]; results: string[] } {
  const prompts: string[] = [];
  const results: string[] = [];
  const agent: Agent = {
    name: "scripted",
    async run(task) {
      prompts.push(task.prompt);
      for (const c of calls) {
        const t = task.tools[c.tool];
        if (!t) {
          results.push(`no tool ${c.tool}`);
          continue;
        }
        const r = await callTool(t, c.input);
        results.push(r.text);
        if (c.tool === "submit" && r.text.startsWith("accepted")) break;
      }
    },
  };
  return Object.assign(agent, { prompts, results });
}
