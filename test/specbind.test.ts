import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync,existsSync } from "node:fs";
import { join } from "node:path";
import { runEnforcer } from "../src/enforcers.ts";
import { parseLaws } from "../src/laws.ts";
import { validate } from "../src/plan.ts";
import { refreshSpecs, reproveLaw } from "../src/reprove.ts";
import { hashFile, isStale, modelsOf, staleReason, stampModels } from "../src/specbind.ts";
import type { Lock } from "../src/lock.ts";
import { at } from "../src/where.ts";
import { repo } from "./helpers.ts";
import { homedir } from "node:os";
import { certEnv } from "../src/sandbox.ts";

const SPEC = "---- MODULE m ----\n\\* scope: the phase table\n\\* models: src/code.js\n====\n";
const files = (extra: Record<string, string> = {}) => ({ "src/code.js": "const x = 1;\n", ".verdict/m.tla": SPEC, ".verdict/m.cfg": "SPECIFICATION Spec\n", ...extra });
let jar: string | undefined;
beforeEach(() => { jar = process.env.VERDICT_TLA2TOOLS; delete process.env.VERDICT_TLA2TOOLS; });
afterEach(() => { if (jar) process.env.VERDICT_TLA2TOOLS = jar; });

test("models lines are read, stamped, and notice a change to the file", () => {
  const root = repo(files());
  expect(modelsOf(SPEC)).toEqual([{ file: "src/code.js", hash: null }]);
  expect(staleReason(root, ".verdict/m.tla")).toContain("not stamped");
  stampModels(root, ".verdict/m.tla");
  const stamped = readFileSync(join(root, ".verdict/m.tla"), "utf8");
  expect(stamped).toContain(`\\* models: src/code.js ${hashFile(root, "src/code.js")}`);
  expect(staleReason(root, ".verdict/m.tla")).toBeNull();
  stampModels(root, ".verdict/m.tla"); // stamping again doesn't pile up hashes
  expect(readFileSync(join(root, ".verdict/m.tla"), "utf8")).toBe(stamped);
  writeFileSync(join(root, "src/code.js"), "const x = 2;\n");
  const why = staleReason(root, ".verdict/m.tla")!;
  expect(isStale(why)).toBe(true);
  expect(why).toContain("verdict plan");
});

test("a spec with no models line, or whose file is gone, is not trusted", () => {
  const root = repo(files({ ".verdict/none.tla": "\\* scope: x\n" }));
  expect(staleReason(root, ".verdict/none.tla")).toContain('no "models:" line');
  stampModels(root, ".verdict/m.tla");
  writeFileSync(join(root, "src/code.js"), "");
  expect(hashFile(root, "src/nope.js")).toBeNull();
});

test("the tla enforcer fails as stale when the code it models changed, before TLC even runs", async () => {
  const root = repo(files());
  stampModels(root, ".verdict/m.tla");
  const run = () => runEnforcer({ kind: "tla", path: ".verdict/m.tla" }, { where: at(root), law: "L" });
  const before = await run();
  expect(before.status === "fail" && isStale(before.message)).toBe(false); // matches: goes on to TLC (inconclusive without it)
  writeFileSync(join(root, "src/code.js"), "const x = 3;\n");
  const after = await run();
  expect(after.status).toBe("fail");
  expect(isStale(after.message)).toBe(true);
});

const law = parseLaws("- Things hold.")[0]!;
const lock = (enforcers: { kind: string; path: string }[]): Lock => new Map([[law.hash, { law: law.text, enforcers }]]);

test("plan re-stamps a stale spec when its replay test still passes, and leaves it stale when not", async () => {
  const root = repo(files({ ".verdict/replay.sh": "#!/bin/sh\ngrep -q 'const x' src/code.js\n" }), [".verdict/replay.sh"]);
  stampModels(root, ".verdict/m.tla");
  const l = lock([{ kind: "tla", path: ".verdict/m.tla" }, { kind: "test", path: ".verdict/replay.sh" }]);
  const log: string[] = [];
  writeFileSync(join(root, "src/code.js"), "const x = 99;\n"); // harmless edit: the test still passes
  await refreshSpecs(at(root), law, l, (s) => log.push(s));
  expect(staleReason(root, ".verdict/m.tla")).toBeNull();
  expect(log.join("\n")).toContain("re-stamped");

  writeFileSync(join(root, "src/code.js"), "const y = 1;\n"); // the replay test now fails
  await refreshSpecs(at(root), law, l, () => {});
  expect(isStale(staleReason(root, ".verdict/m.tla")!)).toBe(true);
  const r = await reproveLaw(at(root), law, l);
  expect(r.outcome).toBe("drift"); // reported as drift to re-plan, not as a failing law
});

test("planning rejects a spec with no models line, or with no test beside it", async () => {
  const root = repo(files({ ".verdict/bare.tla": "\\* scope: x\n", ".verdict/t.sh": "#!/bin/sh\nexit 0\n" }), [".verdict/t.sh"]);
  const noModels = await validate(at(root), law, { enforcers: [{ kind: "tla", path: ".verdict/bare.tla" }, { kind: "test", path: ".verdict/t.sh" }], breaks: [], suggestions: [] });
  expect(noModels.problem).toContain("must name the code it models");
  const alone = await validate(at(root), law, { enforcers: [{ kind: "tla", path: ".verdict/m.tla" }], breaks: [], suggestions: [] });
  expect(alone.problem).toContain("replays");
  const missing = repo(files({ ".verdict/m.tla": SPEC.replace("src/code.js", "src/gone.js"), ".verdict/t.sh": "#!/bin/sh\nexit 0\n" }), [".verdict/t.sh"]);
  const gone = await validate(at(missing), law, { enforcers: [{ kind: "tla", path: ".verdict/m.tla" }, { kind: "test", path: ".verdict/t.sh" }], breaks: [], suggestions: [] });
  expect(gone.problem).toContain("not a file of the system under check");
});


test("sandboxed tools are pointed at a PEM bundle so they don't ask the keychain", () => {
  const env = certEnv();
  if (process.env.SSL_CERT_FILE) return expect(env.SSL_CERT_FILE).toBe(process.env.SSL_CERT_FILE);
  if (Object.keys(env).length > 0) expect(existsSync(env.SSL_CERT_FILE!)).toBe(true);
});

const TLA_JAR = join(homedir(), ".local/share/tla/tla2tools.jar");
test.skipIf(!existsSync(TLA_JAR) || !Bun.which("java"))("TLC runs a spec that EXTENDS Naturals inside the sandbox", async () => {
  process.env.VERDICT_TLA2TOOLS = TLA_JAR;
  try {
    const spec = "---- MODULE m ----\n\\* scope: a counter\n\\* models: src/code.js\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = (x + 1) % 3\nSpec == Init /\\ [][Next]_x\nInv == x \\in 0..2\n====\n";
    const root = repo({ "src/code.js": "1\n", ".verdict/m.tla": spec, ".verdict/m.cfg": "SPECIFICATION Spec\nINVARIANT Inv\n" });
    stampModels(root, ".verdict/m.tla");
    const r = await runEnforcer({ kind: "tla", path: ".verdict/m.tla" }, { where: at(root), law: "L", sandbox: { readable: [root] } });
    expect(r.status).toBe("pass");
  } finally {
    delete process.env.VERDICT_TLA2TOOLS;
  }
});
