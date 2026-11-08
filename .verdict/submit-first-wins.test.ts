// scope: runAgent() in src/agent.ts driven by a scripted Agent (overrides.agent) that calls the `submit` tool it is handed through callTool(): sequential later submits (valid, invalid, different), and concurrent submits (same tick, and one fast submit overtaking a slow-validating one), with a counting validate(). Checks validate is never run for a later/concurrent submit and that runAgent returns the first accepted input. Not covered: the real adapters in src/agents/ (they only forward tool calls), and an agent that throws after acceptance.
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { callTool, overrides, runAgent, type Agent, type Tools } from "../src/agent.ts";

afterEach(() => {
  delete overrides.agent;
});

const schema = z.object({ n: z.number() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drive(script: (tools: Tools) => Promise<void>, validate: (input: { n: number }) => Promise<string | null>) {
  const agent: Agent = { name: "scripted", run: async (task) => script(task.tools) };
  overrides.agent = agent;
  return runAgent({
    system: "s",
    prompt: "p",
    tools: {},
    cwd: ".",
    submit: { description: "submit", schema, validate },
  });
}

test("a later submit after acceptance is not validated and does not change the result", async () => {
  const validated: number[] = [];
  const results: string[] = [];
  const out = await drive(
    async (tools) => {
      results.push((await callTool(tools.submit!, { n: 1 })).text);
      results.push((await callTool(tools.submit!, { n: 2 })).text);
      results.push((await callTool(tools.submit!, { n: "bad" })).text);
    },
    async (i) => {
      validated.push(i.n);
      return null;
    },
  );
  expect(out).toEqual({ n: 1 });
  expect(validated).toEqual([1]);
  expect(results[0]).toContain("accepted");
  expect(results[1]).toContain("already accepted");
});

test("a rejected submit does not block a later one, but the first accepted wins", async () => {
  const out = await drive(
    async (tools) => {
      await callTool(tools.submit!, { n: 1 });
      await callTool(tools.submit!, { n: 2 });
      await callTool(tools.submit!, { n: 3 });
    },
    async (i) => (i.n === 1 ? "no" : null),
  );
  expect(out).toEqual({ n: 2 });
});

test("concurrent submits: only one is validated, and it is the one returned", async () => {
  const validated: number[] = [];
  const out = await drive(
    async (tools) => {
      await Promise.all([callTool(tools.submit!, { n: 1 }), callTool(tools.submit!, { n: 2 })]);
    },
    async (i) => {
      validated.push(i.n);
      await sleep(30);
      return null;
    },
  );
  expect(validated.length).toBe(1);
  expect(out).toEqual({ n: validated[0]! });
});

test("a submit started while another is validating cannot replace it, even if it finishes first or last", async () => {
  const accepted: number[] = [];
  const out = await drive(
    async (tools) => {
      const slow = callTool(tools.submit!, { n: 1 }); // validates for 60ms
      await sleep(10);
      const fast = callTool(tools.submit!, { n: 2 }); // validates instantly, accepted first if validated at all
      await Promise.all([slow, fast]);
    },
    async (i) => {
      if (i.n === 1) await sleep(60);
      accepted.push(i.n);
      return null;
    },
  );
  // Whatever order they finish in, the result must be the first one accepted.
  expect(out).toEqual({ n: accepted[0]! });
  // And the later, concurrent submit must not have been validated at all.
  expect(accepted.length).toBe(1);
});
