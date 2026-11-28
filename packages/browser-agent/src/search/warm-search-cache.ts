import type { LLMClient } from "../agent/contracts";

type Chat = LLMClient["chatWithTools"];
type StreamListener = NonNullable<
  NonNullable<Parameters<Chat>[2]>["onStreamEvent"]
>;

const searches = new WeakMap<
  LLMClient,
  WeakMap<AbortSignal, Map<string, Promise<void>>>
>();

/**
 * The first request gives the provider time to write its prefix. Release
 * the rest on the first streamed answer event, or when the lead settles.
 * After that, callers use their existing parallel lanes.
 */
export async function withWarmSearchCache(
  client: LLMClient,
  signal: AbortSignal | undefined,
  key: string,
  send: (onStreamEvent?: StreamListener) => ReturnType<Chat>,
): ReturnType<Chat> {
  if (!signal) return send();
  let runs = searches.get(client);
  if (!runs) {
    runs = new WeakMap();
    searches.set(client, runs);
  }
  let prefixes = runs.get(signal);
  if (!prefixes) {
    prefixes = new Map();
    runs.set(signal, prefixes);
  }
  const first = prefixes.get(key);
  if (first) {
    await first;
    signal.throwIfAborted();
    return send();
  }
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  prefixes.set(key, promise);
  try {
    return await send((event) => {
      if (event.type !== "attempt_started" && event.type !== "provider_wait")
        release();
    });
  } finally {
    release();
  }
}
