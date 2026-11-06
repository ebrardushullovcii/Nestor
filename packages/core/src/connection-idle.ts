/** A connection is dead only after silence; each received chunk restarts the wait.
 * Yield once before declaring silence so queued network progress can run. */
export function createConnectionIdleTimeout(quietMs: number) {
  const controller = new AbortController();
  let lastProgressAt = Date.now();
  let finished = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const end = () => {
    if (!finished) controller.abort();
  };
  const arm = (delay: number) => {
    quietTimer = setTimeout(check, delay);
  };
  const check = () => {
    quietTimer = null;
    if (finished) return;
    const quietFor = Date.now() - lastProgressAt;
    if (quietFor < quietMs) {
      arm(quietMs - quietFor);
      return;
    }
    const progressBefore = lastProgressAt;
    setImmediate(() => {
      if (finished) return;
      if (lastProgressAt !== progressBefore) arm(quietMs);
      else end();
    });
  };
  arm(quietMs);
  return {
    signal: controller.signal,
    progress: () => {
      lastProgressAt = Date.now();
    },
    cleanup: () => {
      finished = true;
      if (quietTimer) clearTimeout(quietTimer);
    },
  };
}
