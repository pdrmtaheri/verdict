// Tests run in verdict's OS sandbox when it can start. It can't when the tests
// themselves already run in a macOS sandbox (sandboxes don't nest); then the
// sandbox is turned off for the suite and the live sandbox tests are skipped.
const canSandbox =
  process.platform === "darwin"
    ? Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"]).exitCode === 0
    : process.platform === "linux" && !!Bun.which("bwrap") && Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "true"]).exitCode === 0;
if (!canSandbox) process.env.VERDICT_SANDBOX = "off";
