// A shared limit on how many slow jobs (agent sessions, enforcer runs) run at
// once. VERDICT_JOBS sets it; each law being planned is one agent session.
export type Limit = <T>(job: () => Promise<T>) => Promise<T>;

export function makeLimit(n: number): Limit {
  let active = 0;
  const queue: (() => void)[] = [];
  return async (job) => {
    if (active >= n) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active++;
    try {
      return await job();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function jobs(): number {
  const n = Number(process.env.VERDICT_JOBS ?? 4);
  return Number.isInteger(n) && n > 0 ? n : 4;
}
