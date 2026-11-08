// scope: runAgent() in src/agent.ts driven by a scripted Agent (overrides.agent) that gets its submit accepted and then misbehaves the way a real adapter can (src/agents/claude-code.ts throws when the SDK reports a non-success result; codex.ts and pi.ts throw on protocol errors and the step limit): throws, or rejects after a further submit. The accepted submission must still be what runAgent returns. Not covered: the real adapters, only the gateway's behaviour when the agent's run() rejects.
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { callTool, overrides, runAgent, type Agent } from "../src/agent.ts";

afterEach(() => {
  delete overrides.agent;
});

const schema = z.object({ n: z.number() });

function go(script: Agent["run"]) {
  overrides.agent = { name: "scripted", run: script };
  return runAgent({ system: "s", prompt: "p", tools: {}, cwd: ".", submit: { description: "submit", schema, validate: async () => null } });
}

test("an agent that throws after its submit was accepted does not lose the accepted plan", async () => {
  const out = await go(async (task) => {
    await callTool(task.tools.submit!, { n: 1 });
    throw new Error("agent crashed after the plan was accepted");
  });
  expect(out).toEqual({ n: 1 });
});

test("an agent that submits again and then throws still gets the first accepted plan returned", async () => {
  const out = await go(async (task) => {
    await callTool(task.tools.submit!, { n: 1 });
    await callTool(task.tools.submit!, { n: 2 });
    throw new Error("step limit reached");
  });
  expect(out).toEqual({ n: 1 });
});
