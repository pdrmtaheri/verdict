// An OS sandbox for code verdict runs on the planner's behalf: tests and
// scripts it wrote, the programs it calls through `run`, a decision file's
// state_from, and the Codex app-server. The planner reads text from the repo,
// so a comment in the repo can steer what it runs. Inside the sandbox that
// code can write only to the paths given, can't read the user's home except
// the paths given, gets a scrubbed environment, and has no network beyond
// localhost unless asked for.
//
// macOS: sandbox-exec. Linux: bubblewrap (bwrap). Elsewhere, or if neither is
// available, verdict refuses to run the code. VERDICT_SANDBOX=off turns the
// sandbox off; use it only when something else already confines verdict.
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { exec, type ExecResult } from "./exec.ts";
import { realOrSelf as real, under } from "./fsx.ts";

export interface Box {
  readable: string[]; // extra paths readable inside the user's home
  writable: string[];
  network: boolean;
  // With the network off: the localhost ports it may connect to. Unset means
  // any localhost port (tests that start a local server need that).
  localhostPorts?: number[];
  home?: string; // HOME inside the sandbox; a fresh empty directory by default
  env?: Record<string, string>;
  // Deny reads everywhere except the system, installed tools and the paths
  // given, not only under the user's home. For a program that reads files on
  // its own, like Codex's shell.
  readsListedOnly?: boolean;
}

// What any program needs to read to start: the OS, its libraries, settings
// and certificates. Not users' files, other volumes or other programs' data.
const SYSTEM_READS = ["/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/Library/Preferences", "/Library/Keychains", "/private/etc", "/private/var/db", "/dev"];

// Where tools on PATH outside the user's home are installed (/opt/homebrew,
// /usr/local…): each PATH entry, its real directory and that directory's prefix.
export function installRoots(home = real(homedir())): string[] {
  const roots = new Set<string>();
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry || !existsSync(entry)) continue;
    for (const dir of [entry, real(entry)]) {
      if (under(dir, home)) continue;
      roots.add(basename(dir) === "bin" ? dirname(dir) : dir);
    }
  }
  return [...roots].filter((r) => r !== "/" && r !== "/private");
}

export class SandboxUnavailable extends Error {}


// Where the user's tools live inside their home (~/.bun, a node version
// manager's install, …): each PATH entry under home, plus its parent when the
// entry is a bin/ directory, unless that parent is home itself or ~/.local.
export function toolRoots(home = real(homedir())): string[] {
  const roots = new Set<string>();
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry || !existsSync(entry)) continue;
    const dir = real(entry);
    if (!under(dir, home)) continue;
    roots.add(dir);
    const parent = dirname(dir);
    if (basename(dir) === "bin" && parent !== home && parent !== join(home, ".local")) roots.add(parent);
  }
  return [...roots];
}

const q = (p: string) => JSON.stringify(p); // SBPL string literal

export function macProfile(box: Box, home: string): string {
  const rules = ["(version 1)", "(allow default)"];
  if (!box.network) {
    rules.push("(deny network*)");
    if (box.localhostPorts) {
      for (const port of box.localhostPorts) rules.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
    } else {
      rules.push(
        '(allow network-bind (local ip "localhost:*"))',
        '(allow network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*"))',
      );
    }
  }
  // (allow default) leaves ways out of the sandbox that don't touch files or
  // the network: asking launchd to open an app or script (open, osascript,
  // Launch Services), and the keychain. Unix sockets (an ssh agent, Docker)
  // are already denied by (deny network*) when the network is off.
  rules.push(
    "(deny lsopen)",
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/osacompile"))',
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name-prefix "com.apple.lsd.") (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))',
  );
  if (box.network) rules.push("(deny network-outbound (remote unix-socket))");
  rules.push(
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))',
    ...box.writable.map((w) => `(allow file-write* (subpath ${q(real(w))}))`),
    box.readsListedOnly ? '(deny file-read* (subpath "/"))' : `(deny file-read* (subpath ${q(home)}))`,
    ...(box.readsListedOnly ? ['(allow file-read* (literal "/"))', ...[...SYSTEM_READS, ...installRoots(home)].map((r) => `(allow file-read* (subpath ${q(r)}))`)] : []),
    ...[...box.readable, ...box.writable, ...toolRoots(home)].map((r) => `(allow file-read* (subpath ${q(real(r))}))`),
    // /System/Volumes/Data is the data volume (/Users, /opt, /private…) by
    // another name: what /System allows above must not reach it that way.
    ...(box.readsListedOnly ? ['(deny file-read* (subpath "/System/Volumes/Data"))'] : []),
    "(allow file-read-metadata)",
  );
  return rules.join("\n");
}

// The Linux equivalent of SYSTEM_READS: libraries, binaries and settings.
const LINUX_SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/nix/store"];

export function bwrapArgs(box: Box, home: string, cwd: string): string[] {
  // /run, /var/run and /tmp hold other programs' sockets (Docker, D-Bus, ssh
  // agents, X11); they're hidden, then only the given paths are bound back.
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc"];
  if (box.readsListedOnly) {
    // Start from an empty root and bind back only the system, installed tools
    // and the paths given.
    for (const d of LINUX_SYSTEM) args.push("--ro-bind-try", d, d);
    for (const r of installRoots(home)) if (!LINUX_SYSTEM.some((d) => under(r, d))) args.push("--ro-bind-try", r, r);
    args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/run", "--tmpfs", "/tmp", "--tmpfs", home);
    for (const r of [...box.readable, ...toolRoots(home)]) args.push("--ro-bind", real(r), real(r));
  } else {
    args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/run", "--tmpfs", "/tmp", "--tmpfs", home);
    // /var/run is usually a link to /run; where it's a real directory, hide it too.
    if (existsSync("/var/run") && real("/var/run") !== "/run") args.push("--tmpfs", "/var/run");
    const hidden = [home, "/tmp", "/run", "/var/run"];
    for (const r of [...box.readable, ...toolRoots(home)]) if (hidden.some((h) => under(real(r), h))) args.push("--ro-bind", real(r), real(r));
  }
  for (const w of box.writable) args.push("--bind", real(w), real(w));
  if (!box.network) args.push("--unshare-net");
  args.push("--chdir", cwd);
  return args;
}

// Tools like Semgrep read the system certificate store when they start, even for
// a local scan. On macOS that means the keychain, which the sandbox denies on
// purpose. Pointing them at the system's PEM bundle avoids the keychain.
export function certEnv(): Record<string, string> {
  if (process.env.SSL_CERT_FILE) return { SSL_CERT_FILE: process.env.SSL_CERT_FILE };
  const bundle = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"].find((f) => existsSync(f));
  return bundle ? { SSL_CERT_FILE: bundle } : {};
}

// The parent's environment without unset entries.
const definedEnv = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));

// Wraps argv so it runs inside the box. Returns the argv and environment to run.
export function sandboxed(argv: string[], box: Box, cwd: string): { argv: string[]; env: Record<string, string> } {
  const home = real(homedir());
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "verdict-box-"));
  const boxHome = box.home ?? scratch;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: boxHome,
    TMPDIR: scratch,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...certEnv(),
    ...box.env,
  };
  const full: Box = { ...box, writable: [...box.writable, scratch] };
  if (process.env.VERDICT_SANDBOX === "off") return { argv, env: { ...definedEnv(), ...env } };
  if (process.platform === "darwin") {
    return { argv: ["/usr/bin/sandbox-exec", "-p", macProfile(full, home), ...argv], env };
  }
  if (process.platform === "linux") {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) throw new SandboxUnavailable("bubblewrap (bwrap) is not installed: install it, or set VERDICT_SANDBOX=off if verdict already runs in a sandbox");
    return { argv: [bwrap, ...bwrapArgs(full, home, cwd), "--", ...argv], env };
  }
  throw new SandboxUnavailable(`no sandbox for ${process.platform}: set VERDICT_SANDBOX=off only if verdict already runs in a sandbox`);
}

// sandbox-exec and bwrap report their own failures on stderr.
export function sandboxFailure(output: string): string | null {
  const m = /sandbox-exec: [^\n]*|bwrap: [^\n]*/.exec(output);
  return m ? m[0] : null;
}

// Runs argv inside the box, with exactly the box's environment. Throws
// SandboxUnavailable when the sandbox itself couldn't start, so a broken
// sandbox never reads as the program failing.
export async function execBoxed(argv: string[], box: Box, cwd: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  const boxed = sandboxed(argv, box, cwd);
  const r = await exec(boxed.argv, { cwd, env: boxed.env, cleanEnv: true, timeoutMs: opts.timeoutMs });
  const broken = r.code === 0 ? null : sandboxFailure(r.output);
  if (broken) throw new SandboxUnavailable(`couldn't start verdict's sandbox (${broken}). If verdict itself already runs in a sandbox, set VERDICT_SANDBOX=off`);
  return r;
}
