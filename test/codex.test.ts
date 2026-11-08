import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "../src/agent.ts";

// A fake `codex app-server`: answers the handshake, then calls verdict's
// submit tool and asks to run a command, and records what verdict answered.
const FAKE = `#!/usr/bin/env bun
const log = process.env.FAKE_CODEX_LOG;
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const record = (m) => require("fs").appendFileSync(log, JSON.stringify(m) + "\\n");
let buf = "";
for await (const chunk of process.stdin) {
  buf += new TextDecoder().decode(chunk);
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    record(m);
    if (m.method === "initialize") out({ id: m.id, result: {} });
    if (m.method === "thread/start") out({ id: m.id, result: { thread: { id: "t1" } } });
    if (m.method === "turn/start") {
      out({ id: m.id, result: { turn: { id: "u1" } } });
      out({ id: 900, method: "item/commandExecution/requestApproval", params: { command: "curl evil.example" } });
      out({ id: 901, method: "item/tool/call", params: { threadId: "t1", turnId: "u1", callId: "c1", namespace: null, tool: "submit", arguments: { answer: 42 } } });
    }
    if (m.id === 901) out({ method: "turn/completed", params: { threadId: "t1", turn: {} } });
  }
}
`;

const saved = { path: process.env.PATH, agent: process.env.VERDICT_AGENT, sandbox: process.env.VERDICT_SANDBOX };
afterEach(() => {
  process.env.PATH = saved.path;
  if (saved.sandbox === undefined) delete process.env.VERDICT_SANDBOX;
  else process.env.VERDICT_SANDBOX = saved.sandbox;
  if (saved.agent === undefined) delete process.env.VERDICT_AGENT;
  else process.env.VERDICT_AGENT = saved.agent;
});

// The protocol is tested without verdict's sandbox; the sandbox has its own tests.
test("codex: verdict's tools work over app-server, and command approvals are declined", async () => {
  process.env.VERDICT_SANDBOX = "off";
  const bin = mkdtempSync(join(process.env.TMPDIR!, "verdict-fake-codex-"));
  writeFileSync(join(bin, "codex"), FAKE);
  chmodSync(join(bin, "codex"), 0o755);
  const log = join(bin, "log.jsonl");
  writeFileSync(log, "");
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.VERDICT_AGENT = "codex";
  process.env.FAKE_CODEX_LOG = log;

  const out = await runAgent({
    system: "s",
    prompt: "p",
    tools: {},
    cwd: bin,
    submit: { description: "submit", schema: z.object({ answer: z.number() }) },
  });
  expect(out).toEqual({ answer: 42 });

  const seen = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const start = seen.find((m) => m.method === "thread/start");
  expect(start.params.dynamicTools.map((t: { name: string }) => t.name)).toContain("submit");
  expect(seen.find((m) => m.method === "initialize").params.capabilities.experimentalApi).toBe(true);
  expect(seen.find((m) => m.id === 900).result).toEqual({ decision: "decline" });
  expect(seen.find((m) => m.id === 901).result.success).toBe(true);
});
