import { traceEvent } from "@nestor/core/run-trace";
import { createHostQueue } from "./host-queue";
import { createConnectionIdleTimeout, reportSelfLimitHit } from "@nestor/core";
import {
  DiscoveryPageReadError,
  type ReadDiscoveryPostingPage,
} from "@nestor/contracts";

/** Read-only HTTP mechanics, with server-requested backoff shared across concurrent reads. */
export function createHttpPageReader(
  options: {
    fetch?: typeof globalThis.fetch;
    readRendered?: ReadDiscoveryPostingPage;
    idleTimeoutMs?: number;
  } = {},
): ReadDiscoveryPostingPage {
  const request = options.fetch ?? globalThis.fetch;
  const queue = createHostQueue({ limit: 16, perHost: 2 });
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
      return options.readRendered(url, readOptions);
    }
    for (let attempt = 0; ; attempt++) {
      const queueSignal = readOptions.signal ?? new AbortController().signal;
      const result = await queue.run(
        address.hostname,
        queueSignal,
        async () => {
          const idle = createConnectionIdleTimeout(
            options.idleTimeoutMs ?? 15_000,
          );
          const signal = AbortSignal.any([idle.signal, queueSignal]);
          try {
            traceEvent("search_page_started", {
              url,
              rendered: false,
              attempt,
            });
            const response = await request(url, {
              method: readOptions.jsonQuery ? "POST" : "GET",
              signal,
              ...(readOptions.jsonQuery
                ? {
                    body: JSON.stringify(readOptions.jsonQuery),
                    redirect: "error" as const,
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
              attempt,
            });
            if (
              (response.status === 429 || response.status === 503) &&
              attempt < 3
            ) {
              const retry = response.headers.get("retry-after");
              const until =
                retry && /^\d+(?:\.\d+)?$/u.test(retry)
                  ? Date.now() + Number(retry) * 1000
                  : retry
                    ? Date.parse(retry)
                    : NaN;
              queue.pause(
                address.hostname,
                Number.isFinite(until)
                  ? until
                  : Date.now() + 1000 * 2 ** attempt,
              );
              await response.body?.cancel();
              return null;
            }
            if (!response.ok) {
              if (
                (response.status === 429 || response.status === 503) &&
                attempt >= 3
              )
                reportSelfLimitHit({
                  limit: "http_retries",
                  kind: "retry",
                  value: 3,
                  where: "browser-runtime/createHttpPageReader",
                });
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
        },
      );
      if (result) return result;
    }
  };
}
