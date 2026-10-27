/**
 * Fair, bounded concurrency per host. Waiting and server cooldowns occupy no
 * active slot. A limit given as a function is read each time work could
 * start, so a setting change applies to the next start.
 */
export function createHostQueue(options: {
  limit: number | (() => number);
  perHost: number;
}) {
  const limit = () =>
    Math.max(
      1,
      typeof options.limit === "function" ? options.limit() : options.limit,
    );
  type Entry = {
    start(): void;
    signal: AbortSignal;
    reject(reason: Error): void;
    detach(): void;
  };
  const hosts = new Map<
    string,
    { active: number; until: number; entries: Entry[] }
  >();
  let active = 0,
    turn = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const idleWaiters: (() => void)[] = [];
  const pump = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const keys = [...hosts.keys()];
    let earliest = Infinity;
    for (
      let checked = 0;
      active < limit() && checked < keys.length;
      checked++
    ) {
      const key = keys[(turn + checked) % keys.length]!;
      const host = hosts.get(key)!;
      while (
        host.entries.length &&
        host.active < options.perHost &&
        active < limit()
      ) {
        if (host.until > Date.now()) {
          earliest = Math.min(earliest, host.until);
          break;
        }
        const entry = host.entries.shift()!;
        if (entry.signal.aborted) {
          entry.detach();
          entry.reject(new Error("Cancelled"));
          continue;
        }
        host.active++;
        active++;
        entry.start();
      }
    }
    turn = keys.length ? (turn + 1) % keys.length : 0;
    const waiting = [...hosts.values()].some((host) => host.entries.length);
    if (waiting && Number.isFinite(earliest))
      timer = setTimeout(pump, Math.max(0, earliest - Date.now()));
    if (!waiting && active === 0)
      for (const resolve of idleWaiters.splice(0)) resolve();
  };
  return {
    run<T>(
      key: string,
      signal: AbortSignal,
      work: () => Promise<T>,
    ): Promise<T> {
      signal.throwIfAborted();
      let host = hosts.get(key);
      if (!host) {
        host = { active: 0, until: 0, entries: [] };
        hosts.set(key, host);
      }
      const group = host;
      return new Promise<T>((resolve, reject) => {
        let started = false,
          settled = false;
        const finish = () => {
          if (settled) return false;
          settled = true;
          signal.removeEventListener("abort", cancel);
          if (started) {
            active--;
            group.active--;
          } else {
            const index = group.entries.indexOf(entry);
            if (index >= 0) group.entries.splice(index, 1);
          }
          pump();
          return true;
        };
        const cancel = () => {
          if (finish())
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("Cancelled"),
            );
        };
        const entry: Entry = {
          signal,
          reject,
          detach: () => signal.removeEventListener("abort", cancel),
          start() {
            started = true;
            void Promise.resolve()
              .then(() => {
                signal.throwIfAborted();
                return work();
              })
              .then(
                (value) => {
                  if (finish()) resolve(value);
                },
                (error: unknown) => {
                  if (finish())
                    reject(
                      error instanceof Error ? error : new Error(String(error)),
                    );
                },
              );
          },
        };
        signal.addEventListener("abort", cancel, { once: true });
        group.entries.push(entry);
        pump();
      });
    },
    pause(key: string, until: number) {
      const host = hosts.get(key);
      if (host) host.until = Math.max(host.until, until);
      pump();
    },
    idle(): Promise<void> {
      return active === 0 &&
        [...hosts.values()].every((host) => !host.entries.length)
        ? Promise.resolve()
        : new Promise((resolve) => idleWaiters.push(resolve));
    },
    get queued() {
      return [...hosts.values()].reduce(
        (n, host) => n + host.entries.length,
        0,
      );
    },
    get active() {
      return active;
    },
  };
}
