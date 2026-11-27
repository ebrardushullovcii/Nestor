import { traceEvent } from "@nestor/core/run-trace";
import { createHostQueue } from "./host-queue";
import { createConnectionIdleTimeout } from "@nestor/core";
import {
  DiscoveryPageReadError,
  type ReadDiscoveryPostingPage,
} from "@nestor/contracts";

/** A Retry-After value as an epoch time, or NaN when absent or unreadable. */
function retryAfterAt(value: string | null): number {
  if (!value) return NaN;
  return /^\d+(?:\.\d+)?$/u.test(value)
    ? Date.now() + Number(value) * 1000
    : Date.parse(value);
}

function waitUntil(until: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const ms = until - Date.now();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Cancelled"),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Read-only HTTP mechanics. A site's request to slow down is honoured per
 * host across concurrent HTTP and browser reads: its Retry-After when given,
 * otherwise a wait that doubles each time the site refuses again after
 * waiting, and resets once it answers. The refused read waits and is
 * requested again; it is never handed to a browser at once.
 */
export function createHttpPageReader(
  options: {
    fetch?: typeof globalThis.fetch;
    readRendered?: ReadDiscoveryPostingPage;
    idleTimeoutMs?: number;
  } = {},
): ReadDiscoveryPostingPage {
  const request = options.fetch ?? globalThis.fetch;
  const queue = createHostQueue({ limit: 16, perHost: 2 });
  const pacing = new Map<string, { until: number; wait: number }>();
  const refused = (host: string, status: number, retryAfter: string | null) => {
    const now = Date.now();
    const state = pacing.get(host) ?? { until: 0, wait: 0 };
    const requested = retryAfterAt(retryAfter);
    if (Number.isFinite(requested))
      state.until = Math.max(state.until, requested);
    else if (state.until <= now) {
      // Concurrent refusals during one wait are the same request to slow down.
      state.wait = state.wait ? state.wait * 2 : 1000;
      state.until = now + state.wait;
    }
    pacing.set(host, state);
    queue.pause(host, state.until);
    traceEvent("search_host_paced", {
      host,
      status,
      retryAfter,
      waitMs: Math.max(0, state.until - now),
    });
  };
  const answered = (host: string) => {
    const state = pacing.get(host);
    if (state) state.wait = 0;
  };
  return async (url, readOptions) => {
    const address = new URL(url);
    if (
      !["http:", "https:"].includes(address.protocol) ||
      address.username ||
      address.password
    )
      throw new Error("Only website pages can be read.");
    if (readOptions.rendered) {
      if (readOptions.jsonQuery)
        throw new Error("A JSON search query cannot navigate a browser page.");
      if (!options.readRendered)
        throw new Error("This listing needs a browser read.");
      const signal = readOptions.signal ?? new AbortController().signal;
      for (;;) {
        await waitUntil(pacing.get(address.hostname)?.until ?? 0, signal);
        try {
          const page = await options.readRendered(url, readOptions);
          answered(address.hostname);
          return page;
        } catch (error) {
          signal.throwIfAborted();
          if (
            !(error instanceof DiscoveryPageReadError && error.status === 429)
          )
            throw error;
          refused(address.hostname, 429, null);
        }
      }
    }
    const queueSignal = readOptions.signal ?? new AbortController().signal;
    for (;;) {
      const page = await queue.run(address.hostname, queueSignal, async () => {
        const idle = createConnectionIdleTimeout(
          options.idleTimeoutMs ?? 15_000,
        );
        const signal = AbortSignal.any([idle.signal, queueSignal]);
        try {
          traceEvent("search_page_started", {
            url,
            rendered: false,
          });
          const response = await request(url, {
            method: readOptions.jsonQuery ? "POST" : "GET",
            signal,
            ...(readOptions.jsonQuery
              ? {
                  body: JSON.stringify(readOptions.jsonQuery),
                  redirect: "manual" as const,
                }
              : {}),
            headers: {
              Accept:
                "text/html, application/json, application/xml;q=0.9, */*;q=0.5",
              ...(readOptions.jsonQuery
                ? { "Content-Type": "application/json" }
                : {}),
            },
          });
          idle.progress();
          traceEvent("search_page_fetched", {
            url,
            finalUrl: response.url || url,
            status: response.status,
          });
          const retry = response.headers.get("retry-after");
          if (
            response.status === 429 ||
            ((response.status === 408 || response.status >= 500) &&
              Number.isFinite(retryAfterAt(retry)))
          ) {
            refused(address.hostname, response.status, retry);
            await response.body?.cancel();
            // The site asked us to wait. Release this active slot; the queued
            // read resumes after the host cooldown.
            return null;
          }
          answered(address.hostname);
          if (readOptions.landingOnly) {
            await response.body?.cancel();
            if (response.status === 404 || response.status === 410)
              throw new DiscoveryPageReadError(response.status);
            return { html: "", finalUrl: response.url || url };
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new DiscoveryPageReadError(response.status);
          }
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          let html = "";
          if (reader) {
            const cancel = () => {
              void reader.cancel().catch(() => undefined);
            };
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                idle.progress();
                html += decoder.decode(value, { stream: true });
              }
              html += decoder.decode();
            } finally {
              signal.removeEventListener("abort", cancel);
              reader.releaseLock();
            }
          }
          signal.throwIfAborted();
          return { html, finalUrl: response.url || url };
        } finally {
          idle.cleanup();
        }
      });
      if (page) return page;
    }
  };
}
