import type { WipData } from 'pg-boss';

/** Idle workers must poll; allow the longest bounded coding job (900s) plus cleanup grace. */
export function workersReady(workers: WipData[], expected: ReadonlySet<string>, now = Date.now()) {
  if (!expected.size) return false;
  return [...expected].every((name) =>
    workers.some((worker) => {
      if (worker.name !== name || worker.state !== 'active') return false;
      if (worker.count > 0) {
        const deadline = 930000;
        return worker.lastJobStartedOn !== null && now - worker.lastJobStartedOn <= deadline;
      }
      const allowance = Math.max(60000, (worker.options.pollingIntervalSeconds ?? 2) * 3000);
      return now - (worker.lastFetchedOn ?? worker.createdOn) <= allowance;
    }),
  );
}

/** Coalesce public probes so a slow database cannot accumulate a query per health request. */
export function createReadinessProbe(
  database: () => Promise<unknown>,
  queue: () => Promise<unknown>,
  options: { timeoutMs?: number; cacheMs?: number } = {},
) {
  let inFlight: Promise<boolean> | undefined;
  let lastSuccess = 0;
  return async (): Promise<boolean> => {
    if (lastSuccess && Date.now() - lastSuccess < (options.cacheMs ?? 1000)) return true;
    if (!inFlight) {
      inFlight = Promise.allSettled([
        Promise.resolve().then(database),
        Promise.resolve().then(queue),
      ])
        .then((results) => {
          const ready = results.every((result) => result.status === 'fulfilled');
          if (ready) lastSuccess = Date.now();
          return ready;
        })
        .catch(() => false)
        .finally(() => {
          inFlight = undefined;
        });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        inFlight,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), options.timeoutMs ?? 2000);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
