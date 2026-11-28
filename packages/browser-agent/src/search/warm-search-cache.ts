import type { LLMClient } from "../agent/contracts";

type Chat = LLMClient["chatWithTools"];
type StreamListener = NonNullable<
  NonNullable<Parameters<Chat>[2]>["onStreamEvent"]
>;

type Wave = { ready: Promise<void>; active: number };
const searches = new WeakMap<
  LLMClient,
  WeakMap<AbortSignal, Map<string, Wave>>
>();

/**
 * The first request gives the provider time to write its prefix. Fit waits
 * for the lead to start returning its answer, or to settle when no answer
 * streams. Other search turns also release on streamed reasoning.
 */
export async function withWarmSearchCache(
  client: LLMClient,
  signal: AbortSignal | undefined,
  key: string,
  send: (onStreamEvent?: StreamListener) => ReturnType<Chat>,
  releaseOnReasoning: boolean,
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
  let release: (() => void) | undefined;
  const wave = first ?? {
    ready: new Promise<void>((resolve) => {
      release = resolve;
    }),
    active: 0,
  };
  if (!first) prefixes.set(key, wave);
  wave.active++;
  try {
    if (first) {
      await wave.ready;
      signal.throwIfAborted();
      return await send();
    }
    return await send((event) => {
      if (
        event.type !== "attempt_started" &&
        event.type !== "provider_wait" &&
        (releaseOnReasoning || event.type !== "reasoning_delta")
      )
        release?.();
    });
  } finally {
    release?.();
    // A later wave may run after the cache expired or the provider refused
    // the first wave. Coordinate it again when no request is left in flight.
    if (--wave.active === 0) prefixes.delete(key);
  }
}
