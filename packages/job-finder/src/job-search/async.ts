/** Detach promptly even if an adapter ignores cancellation; consume late errors. */
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      const reason: unknown = signal.reason;
      cleanup();
      reject(reason instanceof Error ? reason : new Error("Search stopped"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function concurrency(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(8, Math.floor(value!)))
    : fallback;
}

/** A fixed number of workers; never creates one promise per configured site. */
export async function inWorkers<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!signal.aborted) {
        const item = items[next++];
        if (item === undefined) return;
        await work(item);
      }
    }),
  );
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

export function createSlots(limit: number, signal: AbortSignal) {
  let used = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    if (used >= limit)
      await abortable(
        new Promise<void>((resolve) => waiting.push(resolve)),
        signal,
      );
    else used++;
    try {
      signal.throwIfAborted();
      return await abortable(work(), signal);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else used--;
    }
  };
}
