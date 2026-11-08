import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { check } from "../src/check.ts";
import { parseLaws } from "../src/laws.ts";
import { writeLock, type Lock } from "../src/lock.ts";
import { sarif } from "../src/sarif.ts";
import { at } from "../src/where.ts";
import { repo } from "./helpers.ts";

const laws = parseLaws("- Money is never a float.\n- Another law.\n");
const lock: Lock = new Map([[laws[0]!.hash, { law: laws[0]!.text, enforcers: [{ kind: "test", path: ".verdict/money.sh" }] }]]);
const fixture = () => repo({ "VERDICT.md": "- Money is never a float.\n- Another law.\n", ".verdict/money.sh": "#!/bin/sh\necho 'src/price.ts: 9.99'\nexit 1\n" }, [".verdict/money.sh"]);

test("SARIF has one rule per law and a result per failure", async () => {
  const root = fixture();
  const reports = await check(at(root), laws, lock);
  const out = sarif(root, [{ where: at(root), lawsFile: join(root, "VERDICT.md"), reports }]) as any;
  expect(out.version).toBe("2.1.0");
  const run = out.runs[0];
  expect(run.tool.driver.rules.map((r: any) => r.shortDescription.text)).toEqual(laws.map((l) => l.text));
  expect(run.results).toHaveLength(2);
  expect(run.results[0]).toMatchObject({ level: "error", locations: [{ physicalLocation: { artifactLocation: { uri: ".verdict/money.sh" } } }] });
  expect(run.results[0].message.text).toContain("src/price.ts: 9.99");
  expect(run.results[1].message.text).toContain("Not planned");
  expect(run.results[1].locations[0].physicalLocation.artifactLocation.uri).toBe("VERDICT.md");
});

test("verdict check --format sarif prints only SARIF and keeps the exit code", async () => {
  const root = fixture();
  writeLock(join(root, "VERDICT.lock"), lock, laws);
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  const p = Bun.spawnSync(["bun", resolve(import.meta.dir, "../src/cli.ts"), "check", "--format", "sarif"], { cwd: root, env: { ...process.env, VERDICT_SANDBOX: "off" } });
  expect(p.exitCode).toBe(1);
  expect(JSON.parse(p.stdout.toString()).runs[0].results.length).toBe(2);
});
