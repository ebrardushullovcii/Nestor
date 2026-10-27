import type { ModelTokenUsage } from "@nestor/contracts";
import type { ModelUsagePayload } from "./openai-compatible-transport";

/** Cached input is a subset of input tokens, never subtracted from the cost target. */
export function normalizeModelUsage(usage: ModelUsagePayload): ModelTokenUsage {
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.round(value))
      : 0;
  return {
    inputTokens: count(usage.prompt_tokens),
    outputTokens: count(usage.completion_tokens),
    cachedInputTokens: Math.max(
      count(usage.prompt_tokens_details?.cached_tokens),
      count(usage.prompt_cache_hit_tokens),
    ),
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
    ...(usage.nestor_estimated ? { estimated: usage.nestor_estimated } : {}),
  };
}
