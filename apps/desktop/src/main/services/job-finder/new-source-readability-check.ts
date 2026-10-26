export const NEW_SOURCE_READABILITY_TIMEOUT_MS = 15_000;

/** Runs the add-time probe with a hard deadline; the workflow persists cancellation. */
export async function runBoundedNewSourceReadabilityCheck<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = NEW_SOURCE_READABILITY_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new DOMException(
        "Source readability check timed out",
        "AbortError",
      );
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
