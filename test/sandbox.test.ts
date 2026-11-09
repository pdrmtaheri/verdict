import { expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInScratch } from "../src/breaks.ts";
import { bwrapArgs, macProfile } from "../src/sandbox.ts";
import { inside } from "../src/fsx.ts";
import { checkGitArgs, writeTools } from "../src/tools.ts";
import { at } from "../src/where.ts";
import { repo } from "./helpers.ts";
import { rejectsWith } from "./rejects.ts";

const live = process.env.VERDICT_SANDBOX !== "off";

test("the macOS profile denies writes, home reads and the network except what's given", () => {
  const p = macProfile({ readable: ["/r"], writable: ["/w"], network: false }, "/Users/me");
  expect(p).toContain("(deny file-write*)");
  expect(p).toContain('(allow file-write* (subpath "/w"))');
  expect(p).toContain('(deny file-read* (subpath "/Users/me"))');
  expect(p).toContain('(allow file-read* (subpath "/r"))');
  expect(p).toContain("(deny network*)");
  expect(macProfile({ readable: [], writable: [], network: true }, "/Users/me")).not.toContain("(deny network*)");
  // No way out through launchd, apps, scripts or the keychain; no unix sockets even with network on.
  for (const deny of ["(deny lsopen)", "/usr/bin/open", "/usr/bin/osascript", "com.apple.coreservices.launchservicesd", "com.apple.SecurityServer"]) expect(p).toContain(deny);
  expect(macProfile({ readable: [], writable: [], network: true }, "/Users/me")).toContain("(deny network-outbound (remote unix-socket))");
});

test("a box with listed reads only denies reads everywhere but the system, tools and the paths given", () => {
  const p = macProfile({ readable: ["/r"], writable: [], network: false, readsListedOnly: true }, "/Users/me");
  expect(p).toContain('(deny file-read* (subpath "/"))');
  expect(p).toContain('(allow file-read* (subpath "/System"))');
  expect(p).toContain('(allow file-read* (subpath "/r"))');
  expect(p.indexOf('(deny file-read* (subpath "/"))')).toBeLessThan(p.indexOf('(allow file-read* (subpath "/r"))'));
  expect(p).not.toContain('(allow file-read* (subpath "/Users"))');
  expect(macProfile({ readable: [], writable: [], network: false }, "/Users/me")).not.toContain('(deny file-read* (subpath "/"))');
  expect(p.lastIndexOf('(deny file-read* (subpath "/System/Volumes/Data"))')).toBeGreaterThan(p.indexOf('(allow file-read* (subpath "/System"))'));
});

test("on Linux, a box with listed reads only starts from an empty root", () => {
  const a = bwrapArgs({ readable: ["/srv/repo"], writable: ["/w"], network: false, readsListedOnly: true }, "/home/me", "/srv/repo");
  expect(a.join(" ")).not.toContain("--ro-bind / /");
  expect(a.join(" ")).toContain("--ro-bind-try /usr /usr");
  expect(a.join(" ")).toContain("--ro-bind /srv/repo /srv/repo");
  expect(a.join(" ")).toContain("--bind /w /w");
  expect(bwrapArgs({ readable: [], writable: [], network: false }, "/home/me", "/").join(" ")).toContain("--ro-bind / /");
});

test("the bubblewrap arguments hide home, bind only what's given, and cut the network", () => {
  const a = bwrapArgs({ readable: [], writable: ["/w"], network: false }, "/home/me", "/w");
  expect(a.join(" ")).toContain("--tmpfs /home/me");
  expect(a.join(" ")).toContain("--bind /w /w");
  expect(a).toContain("--unshare-net");
  for (const flag of ["--unshare-pid", "--unshare-ipc", "--new-session"]) expect(a).toContain(flag);
  expect(a.join(" ")).toContain("--tmpfs /run --tmpfs /tmp");
});

test.skipIf(!live)("live: planner-written code can't write to the repo or see verdict's environment", async () => {
  const root = repo({
    ".verdict/escape.sh": `#!/bin/sh\n# scope: probe\necho "$SECRET_FOR_TEST"\ntouch "$REPO/escaped" && exit 1\nexit 0\n`,
  }, [".verdict/escape.sh"]);
  process.env.SECRET_FOR_TEST = "hunter2";
  const r = await runInScratch(at(root), "law", { kind: "test", path: ".verdict/escape.sh" });
  delete process.env.SECRET_FOR_TEST;
  expect(r.message).not.toContain("hunter2");
  expect(existsSync(join(root, "escaped"))).toBe(false);
});

test.skipIf(!live)("live: the planner's run tool can't write outside its scratch copy", async () => {
  const root = repo({ ".verdict/w.sh": `#!/bin/sh\necho x > ${JSON.stringify(join(homedir(), ".verdict-sandbox-probe"))}\n` }, [".verdict/w.sh"]);
  const out = await writeTools(root, join(root, ".verdict")).run.execute({ argv: ["./.verdict/w.sh"] });
  expect(out).not.toContain("exit 0");
  expect(existsSync(join(homedir(), ".verdict-sandbox-probe"))).toBe(false);
});

test("git allows only listed flags per subcommand", () => {
  const root = repo({ "a.txt": "" });
  expect(() => checkGitArgs(root, ["log", "--oneline", "-n", "5", "--", "a.txt"])).not.toThrow();
  expect(() => checkGitArgs(root, ["blame", "-L", "1,3", "a.txt"])).not.toThrow();
  expect(() => checkGitArgs(root, ["blame", "-S/etc/hosts", "a.txt"])).toThrow("not allowed");
  expect(() => checkGitArgs(root, ["diff", "--output=/tmp/x"])).toThrow("not allowed");
  expect(() => checkGitArgs(root, ["diff", "--no-index", "/etc/hosts", "a.txt"])).toThrow("not allowed");
  expect(() => checkGitArgs(root, ["log", "--orderfile=/etc/hosts"])).toThrow("not allowed");
  expect(() => checkGitArgs(root, ["push"])).toThrow("not allowed");
  // -U's value is optional and attached; the next argument is still checked.
  expect(() => checkGitArgs(root, ["diff", "-U", "--output=/tmp/x"])).toThrow("not allowed");
  expect(() => checkGitArgs(root, ["diff", "-U3"])).not.toThrow();
  expect(() => checkGitArgs(root, ["log", "-n"])).toThrow("needs a value");
});

test("write_file refuses a dangling symlink in .verdict/", async () => {
  const root = repo({ "a.txt": "" });
  mkdirSync(join(root, ".verdict"));
  const target = join(process.env.TMPDIR!, `verdict-dangling-${Date.now()}.txt`);
  symlinkSync(target, join(root, ".verdict", "link.txt"));
  expect(() => inside(root, ".verdict/link.txt", join(root, ".verdict"))).toThrow("symlink to nowhere");
  await rejectsWith(writeTools(root, join(root, ".verdict")).write_file.execute({ path: ".verdict/link.txt", content: "x" }));
  expect(existsSync(target)).toBe(false);
  writeFileSync(join(root, "a.txt"), "still fine");
});
