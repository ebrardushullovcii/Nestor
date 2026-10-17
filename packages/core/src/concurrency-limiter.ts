/** FIFO admission for expensive asynchronous work. Permits always release on failure. */
export function createConcurrencyLimiter(capacity: number) {
  if (!Number.isInteger(capacity) || capacity < 1)
    throw new Error("Concurrency capacity must be a positive integer.");
  let active = 0;
  const waiting: Array<() => void> = [];
  async function acquire(): Promise<() => void> {
    if (active < capacity) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    };
  }
  return {
    acquire,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const release = await acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}

/**
 * A limiter whose capacity backs off while the service it guards is refusing
 * for too many requests, and grows back one slot per success. Many callers
 * hitting one limit together halve the capacity once per cool-down, not once
 * each. Holders above a lowered capacity finish; only new starts wait.
 */
export function createAdaptiveConcurrencyLimiter(options: {
  max: number;
  min?: number;
  coolDownMs?: number;
  now?: () => number;
}) {
  const max = options.max;
  const min = Math.min(options.min ?? 1, max);
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(min) || min < 1)
    throw new Error("Concurrency capacity must be a positive integer.");
  const coolDownMs = options.coolDownMs ?? 10_000;
  const now = options.now ?? Date.now;
  let capacity = max;
  let active = 0;
  let lastDecreaseAt = Number.NEGATIVE_INFINITY;
  const waiting: Array<() => void> = [];
  const wake = () => {
    while (active < capacity && waiting.length > 0) {
      active += 1;
      waiting.shift()?.();
    }
  };
  async function acquire(): Promise<() => void> {
    if (active < capacity && waiting.length === 0) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      wake();
    };
  }
  return {
    acquire,
    capacity: () => capacity,
    /** The guarded call went through: allow one more at a time again. */
    recordSuccess() {
      if (capacity >= max) return;
      capacity += 1;
      wake();
    },
    /** The service refused for load: halve, at most once per cool-down. */
    recordOverload() {
      const at = now();
      if (at - lastDecreaseAt < coolDownMs) return;
      lastDecreaseAt = at;
      capacity = Math.max(min, Math.floor(capacity / 2));
    },
  };
}
