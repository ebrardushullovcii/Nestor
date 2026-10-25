import { DiscoveryPageReadError, type ReadDiscoveryPostingPage } from "@nestor/contracts";

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Read-only HTTP mechanics, with server-requested backoff shared across concurrent reads. */
export function createHttpPageReader(
  options: {
    fetch?: typeof globalThis.fetch;
    readRendered?: ReadDiscoveryPostingPage;
    timeoutMs?: number;
  } = {},
): ReadDiscoveryPostingPage {
  const request = options.fetch ?? globalThis.fetch;
  const cooldown = new Map<string, number>();
  return async (url, readOptions) => {
    const address = new URL(url);
    if (
      !["http:", "https:"].includes(address.protocol) ||
      address.username ||
      address.password
    )
      throw new Error("Only website pages can be read.");
    if (readOptions.rendered) {
      if (!options.readRendered)
        throw new Error("This listing needs a browser read.");
      return options.readRendered(url, readOptions);
    }
    for (let attempt = 0; ; attempt++) {
      await wait(
        (cooldown.get(address.origin) ?? 0) - Date.now(),
        readOptions.signal,
      );
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
      const signal = readOptions.signal
        ? AbortSignal.any([timeout, readOptions.signal])
        : timeout;
      const response = await request(url, {
        method: "GET",
        signal,
        headers: {
          Accept:
            "text/html, application/json, application/xml;q=0.9, */*;q=0.5",
        },
      });
      if ((response.status === 429 || response.status === 503) && attempt < 3) {
        const retry = response.headers.get("retry-after");
        const until =
          retry && /^\d+(?:\.\d+)?$/u.test(retry)
            ? Date.now() + Number(retry) * 1000
            : retry
              ? Date.parse(retry)
              : NaN;
        cooldown.set(
          address.origin,
          Math.max(
            cooldown.get(address.origin) ?? 0,
            Number.isFinite(until) ? until : Date.now() + 1000 * 2 ** attempt,
          ),
        );
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DiscoveryPageReadError(response.status);
      }
      return { html: await response.text(), finalUrl: response.url || url };
    }
  };
}
