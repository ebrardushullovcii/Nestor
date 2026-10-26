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
    ? Math.max(1, Math.min(32, Math.floor(value!)))
    : fallback;
}

export function errorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      /timed? out|timeout/iu.test(error.message))
  )
    return "The site took too long to respond. Open it to check it loads, then retry the search. Other sites continue normally.";
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
