import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { callTool } from "../src/agent.ts";
import { parseLaws } from "../src/laws.ts";
import { loadManifest, validatePlayground } from "../src/playground/manifest.ts";
import { startPlayground, type Playground } from "../src/playground/server.ts";
import { newState, playgroundTools } from "../src/playground/tools.ts";
import { repo } from "./helpers.ts";

const manifest = JSON.stringify({ title: "T", idea: "an idea", brief: "build it", writable: ["src", "test"] });
const files = { "PLAYGROUND.json": manifest, "VERDICT.md": "- Things are fine.\n" };

let running: Playground | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

test("validate reports each problem with what to do", () => {
  const root = repo({ "PLAYGROUND.json": JSON.stringify({ title: "", writable: ["../x", "a/b"] }) });
  const problems = validatePlayground(root).join("\n");
  expect(problems).toContain("PLAYGROUND.json is invalid");
  expect(problems).toContain("no VERDICT.md: add at least one law");
  expect(validatePlayground(repo(files))).toEqual([]);
  const bad = repo({ "PLAYGROUND.json": JSON.stringify({ title: "T", idea: "i", brief: "b", writable: ["../x", "a/b"] }), "VERDICT.md": "- x\n" });
  expect(validatePlayground(bad).join("\n")).toContain('writable entry "../x"');
  expect(validatePlayground(bad).join("\n")).toContain('writable entry "a/b"');
});

test("manifest defaults all panels and the standard writable directories", () => {
  const m = loadManifest(repo({ "PLAYGROUND.json": JSON.stringify({ title: "T", idea: "i", brief: "b" }) }));
  expect(m.panels).toContain("preview");
  expect(m.writable).toContain("src");
});

test("write_file stays inside the writable directories", async () => {
  const root = repo(files);
  const tools = playgroundTools(root, newState());
  const write = (path: string) => callTool(tools.write_file!, { path, content: "x" });
  expect((await write("src/a.ts")).isError).toBe(false);
  expect(existsSync(join(root, "src/a.ts"))).toBe(true);
  for (const bad of ["../escape.ts", "src/../../escape.ts", "/tmp/escape.ts", "VERDICT.lock", "VERDICT.md", "PLAYGROUND.json", "other/a.ts"]) {
    const r = await write(bad);
    expect(r.isError).toBe(true);
  }
  expect(readFileSync(join(root, "PLAYGROUND.json"), "utf8")).toBe(manifest);
});

test("write_file refuses to write through a symlink out of the playground", async () => {
  const root = repo(files);
  const outside = repo({});
  symlinkSync(outside, join(root, "src"));
  const r = await callTool(playgroundTools(root, newState()).write_file!, { path: "src/a.ts", content: "x" });
  expect(r.isError).toBe(true);
  expect(existsSync(join(outside, "a.ts"))).toBe(false);
});

test("read_file cannot read outside the playground", async () => {
  const tools = playgroundTools(repo(files), newState());
  expect((await callTool(tools.read_file!, { path: "../../etc/hosts" })).isError).toBe(true);
});

test("write_laws rejects text with no laws and run_tests rejects missing files", async () => {
  const tools = playgroundTools(repo(files), newState());
  expect((await callTool(tools.write_laws!, { markdown: "just prose" })).isError).toBe(true);
  expect((await callTool(tools.run_tests!, { path: "test/none.test.ts" })).text).toContain("write it first");
});

test("check reports an unplanned law", async () => {
  const tools = playgroundTools(repo(files), newState());
  expect((await callTool(tools.check!, {})).text).toContain("NOT PLANNED");
});

test("run_tests runs a test file and reports failure", async () => {
  const root = repo({ ...files, "test/ok.test.ts": 'import {test,expect} from "bun:test"; test("a",()=>expect(1).toBe(1));', "test/bad.test.ts": 'import {test,expect} from "bun:test"; test("a",()=>expect(1).toBe(2));' });
  const tools = playgroundTools(root, newState());
  expect((await callTool(tools.run_tests!, { path: "test/ok.test.ts" })).text).toContain("exit 0");
  expect((await callTool(tools.run_tests!, { path: "test/bad.test.ts" })).text).not.toContain("exit 0");
});

test("the server refuses a missing token, a wrong Host and a foreign Origin", async () => {
  running = await startPlayground(repo(files));
  const base = new URL(running.url).origin;
  expect((await fetch(`${base}/api/state`)).status).toBe(401);
  expect((await fetch(`${base}/api/state?token=wrong`)).status).toBe(401);
  expect((await fetch(`${base}/api/state?token=${running.token}`)).status).toBe(200);
  expect((await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${running.token}`, origin: "https://evil.example" } })).status).toBe(403);
  expect((await fetch(`${base}/api/state`, { headers: { "x-playground-token": running.token, host: "evil.example" } })).status).toBe(403);
  expect((await fetch(`${base}/`)).status).toBe(401);
  expect((await fetch(running.url)).status).toBe(200);
  expect((await fetch(`${base}/app.js`)).status).toBe(200);
});

test("an MCP client lists the tools and a write shows up in the activity feed", async () => {
  running = await startPlayground(repo(files));
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(running.mcpUrl)));
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["get_brief", "write_laws", "plan", "check", "write_file", "run_tests"]));
  const brief = await client.callTool({ name: "get_brief", arguments: {} });
  expect(JSON.stringify(brief.content)).toContain("build it");
  await client.callTool({ name: "write_file", arguments: { path: "src/a.ts", content: "x" } });
  const escaped = await client.callTool({ name: "write_file", arguments: { path: "../a.ts", content: "x" } });
  expect(escaped.isError).toBe(true);
  const state = await (await fetch(`${new URL(running.url).origin}/api/state?token=${running.token}`)).json() as { activity: { tool: string; isError: boolean }[]; files: string[] };
  expect(state.activity.filter((a) => a.tool === "write_file").map((a) => a.isError)).toEqual([false, true]);
  expect(state.files).toContain("src/a.ts");
  await client.close();
});

test("the MCP endpoint needs the token too", async () => {
  running = await startPlayground(repo(files));
  const r = await fetch(`${new URL(running.url).origin}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  expect(r.status).toBe(401);
});

test("preview serves public/ with a locking CSP, needs the path token, and stays inside public/", async () => {
  const root = repo({ ...files, "public/index.html": "<h1>hi</h1>", "secret.txt": "nope" });
  symlinkSync(join(root, "secret.txt"), join(root, "public/link.txt"));
  running = await startPlayground(root);
  const base = new URL(running.url).origin;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}/preview/${running!.token}/${path}`, { headers });
  const ok = await get("index.html");
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("<h1>hi</h1>");
  expect(ok.headers.get("content-security-policy")).toContain("connect-src 'none'");
  expect(ok.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  expect((await get("index.html", { origin: "null" })).status).toBe(200); // a sandboxed iframe's own requests
  expect((await get("index.html", { origin: "https://evil.example" })).status).toBe(403);
  expect((await fetch(`${base}/preview/wrong/index.html`)).status).toBe(401);
  expect((await get("..%2Fsecret.txt")).status).toBe(400);
  expect((await get("link.txt")).status).toBe(400); // a symlink out of public/
  expect((await get("missing.js")).status).toBe(404);
  expect((await fetch(`${base}/preview/${running.token}/index.html`, { method: "POST" })).status).toBe(405);
});

test("lawViews joins laws, the lock and the latest report", async () => {
  const { lawViews } = await import("../src/playground/view.ts");
  const root = repo({ ...files, "VERDICT.md": "- Things are fine.\n- Other things hold.\n", "VERDICT.lock": `${parseLaws("- Things are fine.")[0]!.hash}:\n  law: Things are fine.\n  enforcers:\n    - test: .verdict/a.sh\n` });
  const views = lawViews(root, null);
  expect(views.map((v) => v.status)).toEqual(["unchecked", "unplanned"]);
  expect(views[0]!.enforcers[0]).toMatchObject({ kind: "test", path: ".verdict/a.sh", status: null });
  const report = [{ law: "Things are fine.", status: "fail" as const, details: [{ id: ".verdict/a.sh", kind: "test", path: ".verdict/a.sh", result: { status: "fail" as const, message: "boom" }, scope: null, warnings: [] }] }];
  const after = lawViews(root, report);
  expect(after[0]).toMatchObject({ status: "fail" });
  expect(after[0]!.enforcers[0]).toMatchObject({ status: "fail", message: "boom" });
  expect(after[1]!.status).toBe("unplanned");
});
