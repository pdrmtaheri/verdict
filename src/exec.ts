export interface ExecResult {
  code: number;
  output: string; // stdout + stderr
  stdout: string;
}

export async function exec(
  argv: string[],
  // cleanEnv: run with exactly `env`, not the parent's environment plus `env`.
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string>; cleanEnv?: boolean },
): Promise<ExecResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts.cleanEnv ? opts.env : { ...process.env, ...opts.env },
    timeout: opts.timeoutMs ?? 10 * 60_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: (stdout + stderr).trim(), stdout };
}

export function tail(text: string, lines = 30): string {
  const all = text.split("\n");
  return all.length <= lines ? text : ["…", ...all.slice(-lines)].join("\n");
}
