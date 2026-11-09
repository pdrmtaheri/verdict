import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { overrides as agents } from "../src/agent.ts";
import { parseLaws } from "../src/laws.ts";
import { readLock, writeLock } from "../src/lock.ts";
import { plan } from "../src/plan.ts";
import { findSets } from "../src/sets.ts";
import { repo, scriptedAgent } from "./helpers.ts";

afterEach(() => {
  delete agents.agent;
});

const CLI = resolve(import.meta.dir, "../src/cli.ts");

// A repo with laws at the root and in two packages. Package a's law has a
// test enforcer that only passes when it runs in packages/a.
function monorepo() {
  const root = repo(
    {
      "VERDICT.md": "- The root law.\n",
      "shared.txt": "shared\n",
      "packages/a/VERDICT.md": "- Package a has a local marker.\n",
      "packages/a/marker.txt": "here\n",
      "packages/a/.verdict/marker.sh": "#!/bin/sh\n# scope: packages/a\ntest -f marker.txt\n",
      "packages/b/VERDICT.md": "- Package b's law.\n",
    },
    ["packages/a/.verdict/marker.sh"],
  );
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  const a = join(root, "packages/a");
  const laws = parseLaws(readFileSync(join(a, "VERDICT.md"), "utf8"));
  writeLock(join(a, "VERDICT.lock"), new Map([[laws[0]!.hash, { law: laws[0]!.text, enforcers: [{ kind: "test", path: ".verdict/marker.sh" }] }]]), laws);
  return root;
}

const cli = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, env: { ...process.env } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

test("verdict finds every VERDICT.md, or the ones under the given paths", async () => {
  const root = realpathSync(monorepo());
  const all = await findSets(root, []);
  expect(all.sets.map((s) => s.dir)).toEqual([root, join(root, "packages/a"), join(root, "packages/b")].toSorted());
  expect((await findSets(root, ["packages/a"])).sets.map((s) => s.dir)).toEqual([join(root, "packages/a")]);
  expect((await findSets(join(root, "packages"), ["."])).sets).toHaveLength(2); // a path is resolved from cwd
  expect((await findSets(root, ["nowhere"])).unmatched).toEqual(["nowhere"]);
});

test("check <path> runs the laws declared in that subtree, each in its own directory", () => {
  const root = monorepo();
  const a = cli(root, "check", "packages/a");
  expect(a.out).toContain("PASS");
  expect(a.out).toContain("Package a has a local marker.");
  expect(a.out).not.toContain("The root law.");
  expect(a.code).toBe(0);

  const everything = cli(root, "check");
  expect(everything.out).toContain("packages/a/VERDICT.md");
  expect(everything.out).toContain("1 pass, 0 fail, 0 inconclusive, 2 not planned");
  expect(everything.code).toBe(1);

  const missing = cli(root, "check", "nowhere");
  expect(missing.code).toBe(2);
  expect(missing.out).toContain("create nowhere/VERDICT.md");
});

test("a nested law is planned into its own directory, reading up to the repo root and no further", async () => {
  const root = monorepo();
  const b = join(root, "packages/b");
  const laws = parseLaws(readFileSync(join(b, "VERDICT.md"), "utf8"));
  const script = "#!/bin/sh\n# scope: packages/b and the shared file\ngrep -q shared ../../shared.txt\n";
  const agent = scriptedAgent([
    { tool: "read_file", input: { path: "../../shared.txt" } },
    { tool: "read_file", input: { path: "../../../outside.txt" } },
    { tool: "list_files", input: { from: "../.." } },
    { tool: "write_file", input: { path: ".verdict/shared.sh", content: script, executable: true } },
    {
      tool: "submit",
      input: {
        enforcers: [{ kind: "test", path: ".verdict/shared.sh" }],
        breaks: [{ enforcer: ".verdict/shared.sh", description: "drop the shared marker", edits: [{ path: "../../shared.txt", find: "shared", replace: "gone" }] }],
        suggestions: [],
      },
    },
  ]);
  agents.agent = agent;
  const log: string[] = [];
  expect(await plan({ dir: b, repo: root, lockFile: join(b, "VERDICT.lock"), laws, lock: new Map() }, (l) => log.push(l))).toBe(true);
  expect(agent.prompts[0]).toContain("packages/b/VERDICT.md and applies to that directory's subtree");
  expect(agent.results[0]).toBe("shared\n");
  expect(agent.results[1]).toContain("outside");
  expect(agent.results[2]).toContain("packages/a/marker.txt".replace("packages/a/", "../a/"));
  expect(existsSync(join(b, ".verdict/shared.sh"))).toBe(true);
  expect(readLock(join(b, "VERDICT.lock")).get(laws[0]!.hash)?.enforcers).toMatchObject([{ kind: "test", path: ".verdict/shared.sh" }]);
  expect(log.join("\n")).toContain("caught its break");
  expect(readFileSync(join(root, "shared.txt"), "utf8")).toBe("shared\n"); // the break ran on a copy
});
