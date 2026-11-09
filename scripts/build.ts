// Builds verdict as single-file executables with `bun build --compile`.
//
//   bun scripts/build.ts                  this machine's platform
//   bun scripts/build.ts --all            every platform in TARGETS
//   bun scripts/build.ts linux-x64 ...    the platforms named
//
// Writes dist/verdict-<platform>[.exe] and dist/SHA256SUMS. Each executable
// carries the Bun runtime, so it needs no Bun or node_modules to run. Bun
// downloads the runtime for each platform other than this one the first time.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "windows-x64"] as const;
type Target = (typeof TARGETS)[number];

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");

function host(): Target {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const t = `${os}-${process.arch}` as Target;
  if (!TARGETS.includes(t)) throw new Error(`no build target for ${process.platform}-${process.arch}: pass one of ${TARGETS.join(", ")}`);
  return t;
}

function parse(args: string[]): Target[] {
  if (args.length === 0) return [host()];
  if (args.includes("--all")) return [...TARGETS];
  for (const a of args) {
    if (!TARGETS.includes(a as Target)) throw new Error(`unknown target "${a}": use one of ${TARGETS.join(", ")}, or --all`);
  }
  return args as Target[];
}

async function build(target: Target): Promise<string> {
  const outfile = join(DIST, `verdict-${target}${target.startsWith("windows") ? ".exe" : ""}`);
  const proc = Bun.spawn(
    [process.execPath, "build", "--compile", "--minify", `--target=bun-${target}`, join(ROOT, "src", "cli.ts"), "--outfile", outfile],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) throw new Error(`building ${target} failed (see the output above)`);
  return outfile;
}

const targets = parse(process.argv.slice(2));
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
const sums: string[] = [];
for (const t of targets) {
  console.log(`building ${t}`);
  const file = await build(t);
  sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${basename(file)}`);
}
writeFileSync(join(DIST, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`\n${sums.join("\n")}`);
