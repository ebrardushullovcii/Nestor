/** A child request can abort without the person stopping the owning run. */
export function isAgentRunAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Stop ends the wait even if a tool ignores its signal; late errors are consumed. */
export function runWithAgentRunCancellation<T>(
  work: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The run was stopped.", "AbortError"),
      );
    };
    if (isAgentRunAborted(signal)) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        return work();
      })
      .then(
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
