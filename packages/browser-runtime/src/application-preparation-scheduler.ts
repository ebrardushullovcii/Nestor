import { isIP } from "node:net";

// The Speed setting's Maximum level; Standard is 4.
export const MAX_APPLICATION_PREPARATIONS = 8;

export function applicationPreparationConcurrency(
  value: string | undefined,
): number {
  const requested = Number(value ?? 4);
  return Number.isInteger(requested)
    ? Math.max(1, Math.min(MAX_APPLICATION_PREPARATIONS, requested))
    : 4;
}

/** A shared browser can prepare several forms, but only one on each site. */
export function applicationSiteKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    const hostname = parsed.hostname.toLowerCase();
    if (isIP(hostname.replace(/^\[|\]$/gu, "")) !== 0) return hostname;
    const parts = hostname.split(".");
    // Group subdomains and deliberately group more broadly for compound public
    // suffixes. Extra serialization is safer than sharing an account session.
    return parts.length > 1 ? parts.slice(-2).join(".") : hostname;
  } catch {
    return null;
  }
}

export interface ApplicationPreparationLease {
  moveTo: (url: string) => Promise<void>;
  /**
   * Gives up the site and the worker slot while `work` waits on something
   * else (a free browser tab), then takes the site back. A form waiting for
   * a tab must not stop other applications on the site from carrying on,
   * or the pages holding the tabs can never finish and free them.
   */
  suspend: <T>(work: () => Promise<T>) => Promise<T>;
  release: () => void;
}

export interface ApplicationPreparationScheduler {
  acquire: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<ApplicationPreparationLease>;
  /** Records a site's response; returns its earliest retry time when limited. */
  recordResponse: (
    url: string,
    status: number,
    retryAfter: string | null,
  ) => number | null;
}

export function createApplicationPreparationScheduler(
  maxActive: number | (() => number) = 2,
): ApplicationPreparationScheduler {
  // Read at each grant, so a Speed change applies to the next form.
  const capacity = () =>
    applicationPreparationConcurrency(
      String(typeof maxActive === "function" ? maxActive() : maxActive),
    );
  type Request = {
    key: string;
    signal?: AbortSignal;
    active: boolean;
    granted: boolean;
    resolve: () => void;
    onAbort: () => void;
  };
  const requests = new Set<Request>();
  const sites = new Map<string, { until: number; failures: number }>();
  let running = 0;
  let wake: ReturnType<typeof setTimeout> | undefined;
  const pausedUntil = (key: string) => sites.get(key)?.until ?? 0;

  const drain = (): void => {
    clearTimeout(wake);
    wake = undefined;
    let nextWake = Infinity;
    for (const request of requests) {
      if (request.granted || request.signal?.aborted) continue;
      const until = pausedUntil(request.key);
      if (until > Date.now()) {
        nextWake = Math.min(nextWake, until);
        continue;
      }
      if (!request.active && running >= capacity()) continue;
      if (
        [...requests].some(
          (other) =>
            other !== request && other.granted && other.key === request.key,
        )
      )
        continue;
      if (!request.active) {
        request.active = true;
        running += 1;
      }
      request.granted = true;
      request.resolve();
    }
    if (Number.isFinite(nextWake)) {
      // Node timers overflow after about 25 days. Long server waits keep their
      // full deadline and wake in chunks; they are never shortened to a cap.
      wake = setTimeout(
        drain,
        Math.min(2_147_483_647, Math.max(1, nextWake - Date.now())),
      );
      wake.unref();
    }
  };

  const waitFor = (request: Request, key: string): Promise<void> => {
    request.key = key;
    request.granted = false;
    return new Promise<void>((resolve, reject) => {
      request.resolve = resolve;
      request.onAbort = () => {
        requests.delete(request);
        if (request.active) {
          running -= 1;
          request.active = false;
        }
        reject(
          request.signal?.reason instanceof Error
            ? request.signal.reason
            : new DOMException("Aborted", "AbortError"),
        );
        drain();
      };
      if (request.signal?.aborted) {
        request.onAbort();
        return;
      }
      request.signal?.addEventListener("abort", request.onAbort, {
        once: true,
      });
      requests.add(request);
      drain();
    }).finally(() =>
      request.signal?.removeEventListener("abort", request.onAbort),
    );
  };

  return {
    recordResponse(url, status, retryAfter) {
      const key = applicationSiteKey(url);
      if (!key) return null;
      const previous = sites.get(key) ?? { until: 0, failures: 0 };
      if (status !== 429 && !(status === 503 && retryAfter !== null)) {
        if (status >= 200 && status < 400 && previous.failures > 0) {
          // Successful responses restore normal speed, but an in-flight success
          // cannot cancel a wait another response has already asked for.
          sites.set(key, { ...previous, failures: 0 });
        }
        return null;
      }
      const now = Date.now();
      const value = retryAfter?.trim() ?? "";
      const hint = /^\d+(?:\.\d+)?$/u.test(value)
        ? Number(value) * 1_000
        : Date.parse(value) - now;
      const delay =
        Number.isFinite(hint) && hint > 0
          ? hint
          : Math.min(60_000, 1_000 * 2 ** Math.min(previous.failures, 6));
      const until = Math.max(previous.until, now + delay);
      sites.set(key, { until, failures: previous.failures + 1 });
      drain();
      return until;
    },
    async acquire(url, signal) {
      const request: Request = {
        key: "",
        ...(signal ? { signal } : {}),
        active: false,
        granted: false,
        resolve: () => undefined,
        onAbort: () => undefined,
      };
      await waitFor(request, applicationSiteKey(url) ?? "unknown-site");
      let released = false;
      let tail = Promise.resolve();
      // Batched form hands can notice the same redirect together. They must
      // all wait for ownership, rather than one treating a queued site as held.
      const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
        const next = tail.then(() => {
          signal?.throwIfAborted();
          if (released)
            throw new Error("Application preparation was released.");
          return work();
        });
        tail = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      };
      return {
        moveTo(nextUrl) {
          return inOrder(async () => {
            const nextKey = applicationSiteKey(nextUrl) ?? "unknown-site";
            if (nextKey === request.key && pausedUntil(nextKey) <= Date.now())
              return;
            // Release both the previous site and the worker slot while waiting
            // for the destination. An unrelated site can use the idle capacity.
            if (request.active) {
              request.active = false;
              running -= 1;
            }
            await waitFor(request, nextKey);
          });
        },
        suspend(work) {
          return inOrder(async () => {
            const key = request.key;
            request.granted = false;
            request.key = "";
            if (request.active) {
              request.active = false;
              running -= 1;
            }
            // Out of the queue while suspended; waitFor puts it back.
            requests.delete(request);
            drain();
            try {
              return await work();
            } finally {
              if (!released) await waitFor(request, key);
            }
          });
        },
        release() {
          if (released) return;
          released = true;
          if (!request.granted && requests.has(request)) {
            request.onAbort();
            return;
          }
          requests.delete(request);
          if (request.active) {
            request.active = false;
            running -= 1;
          }
          drain();
        },
      };
    },
  };
}
