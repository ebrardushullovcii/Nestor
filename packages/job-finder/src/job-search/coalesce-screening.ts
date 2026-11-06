import { createHash } from "node:crypto";
import type { JobFinderAiClient } from "@nestor/ai-providers";

type Chat = NonNullable<JobFinderAiClient["chatWithTools"]>;

/** Identical concurrent questions in one search share a turn, not a remembered answer. */
export function coalesceScreening(chat: Chat): Chat {
  const searches = new WeakMap<AbortSignal, Map<string, ReturnType<Chat>>>();
  return (messages, tools, options) => {
    if (options?.reasoningTask !== "listing_screen" || !options.signal)
      return chat(messages, tools, options);
    options.signal.throwIfAborted();
    let pending = searches.get(options.signal);
    if (!pending) {
      pending = new Map();
      searches.set(options.signal, pending);
    }
    const key = createHash("sha256")
      .update(JSON.stringify([messages, tools, options]))
      .digest("hex");
    const existing = pending.get(key);
    if (existing)
      return existing.then((reply) => {
        // Provider usage belongs to the original turn, rather than each waiter.
        const shared = { ...reply };
        delete shared.usage;
        return shared;
      });
    const requests = pending;
    const request = chat(messages, tools, options).finally(() =>
      requests.delete(key),
    );
    requests.set(key, request);
    return request;
  };
}
