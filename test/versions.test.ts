import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callTool } from "../src/agent.ts";
import { runEnforcer } from "../src/enforcers.ts";
import { parseLaws } from "../src/laws.ts";
import { loadManifest, validatePlayground } from "../src/playground/manifest.ts";
import { discoverPlaygrounds, startPlayground, type Playground } from "../src/playground/server.ts";
import { checkVersion, newState, playgroundTools } from "../src/playground/tools.ts";
import { MAIN, versionList, versionTarget } from "../src/playground/versions.ts";
import { repo } from "./helpers.ts";

const law = "The answer is always 42.";
const hash = parseLaws(`- ${law}`)[0]!.hash;
const manifest = JSON.stringify({
  title: "Answer",
  idea: "an idea",
  brief: "build it",
  writable: ["public", ".verdict"],
  main: { label: "Right", note: "the right answer" },
  versions: [{ id: "wrong", label: "Wrong", note: "says 41" }],
});
// One shared enforcer: it reads whatever public/answer.txt the version has.
const files = (): Record<string, string> => ({
  "PLAYGROUND.json": manifest,
  "VERDICT.md": `- ${law}\n`,
  "VERDICT.lock": `${hash}:\n  law: ${law}\n  enforcers:\n    - test: .verdict/is-42.sh\n`,
  ".verdict/is-42.sh": "#!/bin/sh\n# scope: public/answer.txt in the target\ngrep -qx 42 \"${VERDICT_TARGET:-.}/public/answer.txt\" || { echo 'the answer file does not say 42'; exit 1; }\n",
  "public/answer.txt": "42\n",
  "public/index.html": "<h1>right</h1>",
  "versions/wrong/public/answer.txt": "41\n",
  "versions/wrong/public/index.html": "<h1>wrong</h1>",
});
const make = () => repo(files(), [".verdict/is-42.sh"]);

let running: Playground | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

test("versions come from the manifest and the versions folder, main first", () => {
  const root = make();
  expect(versionList(root, loadManifest(root))).toEqual([
    { id: "main", label: "Right", note: "the right answer" },
    { id: "wrong", label: "Wrong", note: "says 41" },
  ]);
  const bare = repo({ ...files(), "PLAYGROUND.json": JSON.stringify({ title: "T", idea: "i", brief: "b" }), "versions/third/public/x": "1" });
  expect(versionList(bare, loadManifest(bare)).map((v) => v.id)).toEqual(["main", "third", "wrong"]);
});

test("the same law passes on one version and fails on another, with the same enforcer", async () => {
  const root = make();
  const m = loadManifest(root);
  const right = await checkVersion(root, m, MAIN);
  const wrong = await checkVersion(root, m, "wrong");
  expect(right[0]!.status).toBe("pass");
  expect(wrong[0]!.status).toBe("fail");
  expect(wrong[0]!.details[0]!.result.message).toContain("does not say 42");
  expect(readFileSync(join(root, "public/answer.txt"), "utf8")).toBe("42\n"); // the real folder is untouched
  await expect(checkVersion(root, m, "nope")).rejects.toThrow('no version "nope"');
});

test("a check on a version points the enforcer at that folder and changes nothing on disk", async () => {
  const root = make();
  const m = loadManifest(root);
  expect(versionTarget(root, m, MAIN)).toBe(root);
  expect(versionTarget(root, m, "wrong")).toBe(join(root, "versions/wrong"));
  expect(() => versionTarget(root, m, "ghost")).toThrow('no version "ghost"');
  const listing = () => new Bun.Glob("**/*").scanSync({ cwd: root, dot: true, onlyFiles: true });
  const before = [...listing()].sort();
  const stamp = (f: string) => readFileSync(join(root, f), "utf8");
  const files0 = Object.fromEntries(before.map((f) => [f, stamp(f)]));
  await checkVersion(root, m, "wrong");
  await checkVersion(root, m, MAIN);
  expect([...listing()].sort()).toEqual(before); // nothing created, deleted or swapped
  for (const f of before) expect(stamp(f)).toBe(files0[f]!);
});

test("an enforcer that ignores VERDICT_TARGET looks at main, which is why enforcers must honor it", async () => {
  const root = repo({ ...files(), ".verdict/is-42.sh": "#!/bin/sh\n# scope: x\ngrep -qx 42 public/answer.txt\n" }, [".verdict/is-42.sh"]);
  const wrong = await checkVersion(root, loadManifest(root), "wrong");
  expect(wrong[0]!.status).toBe("pass"); // read main's file, not the version's
});

test("write_file can write a version's code and nothing outside its code folders", async () => {
  const root = make();
  const tools = playgroundTools(root, newState());
  const write = (path: string) => callTool(tools.write_file!, { path, content: "40\n" });
  expect((await write("versions/wrong/public/answer.txt")).isError).toBe(false);
  expect(readFileSync(join(root, "versions/wrong/public/answer.txt"), "utf8")).toBe("40\n");
  for (const bad of ["versions/ghost/public/a.txt", "versions/wrong/.verdict/x.sh", "versions/wrong/other/a.txt", "versions/wrong/../../escape.txt", "versions/wrong/public/../../../escape.txt"]) {
    expect((await write(bad)).isError).toBe(true);
  }
  expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
});

test("the check tool takes a version and run_tests runs against it", async () => {
  const root = make();
  const tools = playgroundTools(root, newState());
  expect((await callTool(tools.check!, {})).text).toContain("PASS");
  expect((await callTool(tools.check!, { version: "wrong" })).text).toContain("FAIL");
  expect((await callTool(tools.check!, { version: "nope" })).isError).toBe(true);
  expect((await callTool(tools.get_brief!, {})).text).toContain("versions/wrong/");
});

test("a spec stamped for main reads as inconclusive, not stale, on another version", async () => {
  const spec = "---- MODULE m ----\n\\* scope: x\n\\* models: public/answer.txt\n====\n";
  const root = repo({ ...files(), ".verdict/m.tla": spec, ".verdict/m.cfg": "SPECIFICATION Spec\n" }, [".verdict/is-42.sh"]);
  const { stampModels } = await import("../src/specbind.ts");
  stampModels(root, ".verdict/m.tla");
  const { runEnforcer } = await import("../src/enforcers.ts");
  const mainRun = await runEnforcer("tla", { root, law, path: ".verdict/m.tla" });
  expect(mainRun.status).not.toBe("fail");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "public/answer.txt"), "41\n");
  const other = await runEnforcer("tla", { root, law, path: ".verdict/m.tla", target: join(root, "versions/wrong") });
  expect(other.status).toBe("inconclusive");
  expect(other.message).toContain("only the replay test");
  expect(other.message).toContain("versions/wrong");
  expect(other.message).not.toContain(root);
});

test("a folder of playgrounds is a hub; each has its own state, MCP endpoint and versions", async () => {
  const a = make();
  const hub = repo({});
  const { cpSync } = await import("node:fs");
  cpSync(a, join(hub, "alpha"), { recursive: true });
  cpSync(a, join(hub, "beta"), { recursive: true });
  expect(discoverPlaygrounds(hub).map((d) => d.split("/").pop())).toEqual(["alpha", "beta"]);
  expect(validatePlayground(join(hub, "alpha"))).toEqual([]);
  running = await startPlayground(hub);
  expect(running.ids).toEqual(["alpha", "beta"]);
  const base = new URL(running.url).origin;
  const h = { "x-playground-token": running.token };
  const state = (q: string) => fetch(`${base}/api/state${q}`, { headers: h }).then((r) => r.json()) as Promise<any>;
  const s = await state("?p=beta&v=wrong");
  expect(s.id).toBe("beta");
  expect(s.version).toBe("wrong");
  expect(s.playgrounds.map((p: any) => p.id)).toEqual(["alpha", "beta"]);
  expect(s.versions.map((v: any) => v.id)).toEqual(["main", "wrong"]);
  expect((await fetch(`${base}/api/state?p=ghost`, { headers: h })).status).toBe(404);
  expect((await fetch(`${base}/api/state?v=ghost`, { headers: h })).status).toBe(404);

  // checking one version of one playground leaves the others untouched
  const c = await fetch(`${base}/api/check?p=alpha&v=wrong`, { method: "POST", headers: h });
  expect(c.status).toBe(200);
  expect((await state("?p=alpha&v=wrong")).laws[0].status).toBe("fail");
  expect((await state("?p=alpha&v=main")).laws[0].status).toBe("unchecked");
  expect((await state("?p=beta&v=wrong")).laws[0].status).toBe("unchecked");
  const wrongTally = (await state("?p=alpha")).versions.find((v: any) => v.id === "wrong").tally;
  expect(wrongTally).toMatchObject({ fail: 1, total: 1 });

  // check all runs every version
  expect((await fetch(`${base}/api/check?p=alpha&v=all`, { method: "POST", headers: h })).status).toBe(200);
  const all = (await state("?p=alpha")).versions;
  expect(all.map((v: any) => v.tally.pass + v.tally.fail)).toEqual([1, 1]);

  // each version's page is served from its own code, under the token
  const pv = (id: string, v: string) => fetch(`${base}/pv/${running!.token}/${id}/${v}/index.html`).then((r) => r.text());
  expect(await pv("alpha", "main")).toBe("<h1>right</h1>");
  expect(await pv("alpha", "wrong")).toBe("<h1>wrong</h1>");
  expect((await fetch(`${base}/pv/nope/alpha/main/index.html`)).status).toBe(401);
  expect((await fetch(`${base}/pv/${running.token}/alpha/ghost/index.html`)).status).toBe(404);
  expect((await fetch(`${base}/pv/${running.token}/alpha/wrong/..%2F..%2Fanswer.txt`)).status).toBe(400);

  // MCP endpoints are per playground
  expect(running.mcpUrls.beta).toContain("/mcp/beta?token=");
  expect((await fetch(`${base}/mcp/ghost?token=${running.token}`, { method: "POST" })).status).toBe(404);
});

test.skipIf(!Bun.which("semgrep"))("semgrep scans the target folder, and main's scan leaves the other versions out", async () => {
  const rule = "# scope: public/x.js\nrules:\n  - id: no-date\n    languages: [javascript]\n    severity: ERROR\n    message: do not read the real clock\n    pattern: Date.now()\n";
  const root = repo({ ...files(), ".verdict/no-date.yaml": rule, "public/x.js": "const a = 1;\n", "versions/wrong/public/x.js": "const t = Date.now();\n" }, [".verdict/is-42.sh"]);
  const run = async (target: string, exclude?: string[]) => (await runEnforcer("semgrep", { root, law, path: ".verdict/no-date.yaml", target, exclude, sandbox: { readable: [root], writable: [] } })).status;
  expect(await run(join(root, "versions/wrong"))).toBe("fail"); // the version's own code is flagged
  expect(await run(root, ["versions"])).toBe("pass"); // main's scan ignores versions/
  expect(await run(root)).toBe("fail"); // without the exclusion it would see them
}, 60000);
