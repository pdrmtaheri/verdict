// scope: runAgent() in src/agent.ts driven by a scripted Agent (overrides.agent) that fires 2-4 submit calls through callTool() on randomised schedules (seeded PRNG, 300 runs): random start offsets 0-6ms, random validate() latency 0-6ms, random accept/reject per call, plus calls fired from inside an earlier call's response. Oracle: validate() never overlaps another validate(), is never started after a validate() has accepted, and runAgent returns the input of the first validate() that accepted (null if none), with only that call's response saying "accepted". Not covered: real adapters in src/agents/, an agent that throws or returns while a submit is still in flight, plan.ts's own validate.
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { callTool, overrides, runAgent, type Agent } from "../src/agent.ts";

afterEach(() => {
  delete overrides.agent;
});

const schema = z.object({ n: z.number() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Call {
  n: number;
  start: number;
  latency: number;
  accept: boolean;
  chained: boolean; // fired right after the previous call's response, not on a timer
}

async function run(calls: Call[]) {
  let active = 0;
  let overlap = false;
  let acceptedYet = false;
  let startedAfterAccept = false;
  const order: { n: number; ok: boolean }[] = [];
  const texts = new Map<number, string>();

  const agent: Agent = {
    name: "scripted",
    run: async (task) => {
      const submit = task.tools.submit!;
      const fire = async (c: Call) => {
        texts.set(c.n, (await callTool(submit, { n: c.n })).text);
      };
      let prev: Promise<void> = Promise.resolve();
      const all: Promise<void>[] = [];
      for (const c of calls) {
        if (c.chained) {
          prev = prev.then(() => fire(c));
          all.push(prev);
        } else {
          prev = (async () => {
            await sleep(c.start);
            await fire(c);
          })();
          all.push(prev);
        }
      }
      await Promise.all(all);
    },
  };
  overrides.agent = agent;
  const byN = new Map(calls.map((c) => [c.n, c]));
  const out = await runAgent({
    system: "s",
    prompt: "p",
    tools: {},
    cwd: ".",
    submit: {
      description: "submit",
      schema,
      validate: async (i) => {
        const c = byN.get(i.n)!;
        if (acceptedYet) startedAfterAccept = true;
        if (++active > 1) overlap = true;
        await sleep(c.latency);
        active--;
        order.push({ n: c.n, ok: c.accept });
        if (c.accept) acceptedYet = true;
        return c.accept ? null : "no";
      },
    },
  });
  return { out, overlap, startedAfterAccept, order, texts };
}

test("random schedules of 2-4 submits: first validated-and-accepted wins, nothing later is validated", async () => {
  const rnd = prng(20260101);
  for (let round = 0; round < 300; round++) {
    const count = 2 + Math.floor(rnd() * 3);
    const calls: Call[] = Array.from({ length: count }, (_, k) => ({
      n: k + 1,
      start: Math.floor(rnd() * 7),
      latency: Math.floor(rnd() * 7),
      accept: rnd() < 0.6,
      chained: k > 0 && rnd() < 0.3,
    }));
    const r = await run(calls);
    const label = `round ${round}: ${JSON.stringify(calls)}`;
    expect(r.overlap, `validates overlapped, ${label}`).toBe(false);
    expect(r.startedAfterAccept, `validate started after an acceptance, ${label}`).toBe(false);
    const firstOk = r.order.find((o) => o.ok);
    expect(r.out, label).toEqual(firstOk ? { n: firstOk.n } : null);
    // Everything validated after the accepted one: nothing. So the accepted one is last in order.
    if (firstOk) expect(r.order[r.order.length - 1]!.n, label).toBe(firstOk.n);
    const acceptedTexts = [...r.texts.entries()].filter(([, t]) => t.startsWith("accepted"));
    expect(acceptedTexts.length, label).toBe(firstOk ? 1 : 0);
    if (firstOk) expect(acceptedTexts[0]![0], label).toBe(firstOk.n);
    for (const c of calls) {
      if (firstOk && c.n !== firstOk.n && !r.order.some((o) => o.n === c.n)) {
        expect(r.texts.get(c.n), label).toContain("already accepted");
      }
    }
  }
});
