import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overrides as agents } from "../src/agent.ts";
import { init, ruleFiles } from "../src/init.ts";
import { parseLaws } from "../src/laws.ts";
import { at } from "../src/where.ts";
import { repo, scriptedAgent } from "./helpers.ts";

afterEach(() => {
  delete agents.agent;
});

test("finds the prose rule files a project already has", () => {
  const root = repo({ "AGENTS.md": "x", "CONTRIBUTING.md": "x", ".cursor/rules/money.mdc": "x", ".cursor/rules/img.png": "x", "README.md": "x" });
  expect(ruleFiles(root).sort()).toEqual([".cursor/rules/money.mdc", "AGENTS.md", "CONTRIBUTING.md"]);
});

test("drafts VERDICT.md from them, one law per bullet, citing each source", async () => {
  const root = repo({ "AGENTS.md": "- Never store money as a float.\n- Be concise in PR descriptions.\n" });
  const model = scriptedAgent([
    { tool: "read_file", input: { path: "AGENTS.md" } },
    { tool: "submit", input: { laws: [{ text: "Money is never stored as a float.", from: "AGENTS.md" }, { text: "Errors tell the user\nwhat to do next.", from: "AGENTS.md" }], skipped: ["PR description style"] } },
  ]);
  agents.agent = model;
  const log: string[] = [];
  expect(await init(at(root), (l) => log.push(l))).toBe(0);
  expect(model.prompts[0]).toContain("AGENTS.md");
  const md = readFileSync(join(root, "VERDICT.md"), "utf8");
  expect(parseLaws(md).map((l) => l.text)).toEqual(["Money is never stored as a float.", "Errors tell the user what to do next."]);
  expect(md).toContain("<!-- from AGENTS.md -->");
  expect(log.join("\n")).toContain("left out: PR description style");
});

test("never overwrites a VERDICT.md, and says what to do without rule files", async () => {
  let started = 0;
  agents.agent = { name: "counting", run: async () => void started++ };
  const existing = repo({ "VERDICT.md": "- A law.\n", "AGENTS.md": "x" });
  const log: string[] = [];
  expect(await init(at(existing), (l) => log.push(l))).toBe(2);
  expect(readFileSync(join(existing, "VERDICT.md"), "utf8")).toBe("- A law.\n");
  expect(await init(at(repo({})), (l) => log.push(l))).toBe(2);
  expect(log.join("\n")).toContain("write VERDICT.md by hand");
  expect(started).toBe(0);
});

test("refuses to write through a VERDICT.md symlink, even a dangling one", async () => {
  const { symlinkSync, existsSync } = await import("node:fs");
  const root = repo({ "AGENTS.md": "- Never store money as a float.\n" });
  const elsewhere = join(repo({}), "owned.txt");
  symlinkSync(elsewhere, join(root, "VERDICT.md"));
  agents.agent = scriptedAgent([{ tool: "submit", input: { laws: [{ text: "A law.", from: "AGENTS.md" }], skipped: [] } }]);
  expect(await init(at(root), () => {})).toBe(2);
  expect(existsSync(elsewhere)).toBe(false);
});
