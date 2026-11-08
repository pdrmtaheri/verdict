import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ExecResult {
  code: number;
  output: string; // stdout + stderr
}

// Finds a tool in the repo's node_modules/.bin first, then on PATH.
export function which(root: string, bin: string): string | null {
  const local = join(root, "node_modules", ".bin", bin);
  if (existsSync(local)) return local;
  return Bun.which(bin);
}

export async function exec(
  argv: string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<ExecResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
    timeout: opts.timeoutMs ?? 10 * 60_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: (stdout + stderr).trim() };
}

export function tail(text: string, lines = 30): string {
  const all = text.split("\n");
  return all.length <= lines ? text : ["…", ...all.slice(-lines)].join("\n");
}
