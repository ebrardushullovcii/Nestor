import type { ModelRequestUsage } from "@nestor/contracts";
import type {
  ModelApiMode,
  ModelUsagePayload,
} from "./openai-compatible-transport";
import { normalizeModelPayload } from "./openai-compatible-transport";
import { normalizeModelUsage } from "./model-token-usage";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
const bytes = (value: unknown): number =>
  typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;

/** Only counts survive an attempt; no prompt, response, credential or page text. */
export function createModelRequestUsage(
  input: {
    url: string;
    body: Record<string, unknown>;
    apiMode: ModelApiMode;
    purpose?: string | undefined;
  },
  attempt: number,
) {
  let provider = "unknown";
  try {
    provider = new URL(input.url).origin;
  } catch {
    /* No URL text in logs. */
  }
  const inputBytes = Buffer.byteLength(
    JSON.stringify({
      messages: input.body.messages ?? input.body.input,
      instructions: input.body.instructions,
      tools: input.body.tools,
      response_format: input.body.response_format ?? input.body.text,
    }),
    "utf8",
  );
  let usage: ModelUsagePayload = {};
  let deltaBytes = 0;
  let outputBytes = 0;
  const items = new Map<string | number, number>();
  const itemBytes = (item: Record<string, unknown>) =>
    bytes(item.arguments) +
    (Array.isArray(item.content)
      ? item.content.reduce<number>(
          (sum, part: unknown) => sum + (record(part) ? bytes(part.text) : 0),
          0,
        )
      : 0);
  const observe = (payload: unknown) => {
    if (!record(payload)) return;
    const response = record(payload.response) ? payload.response : payload;
    const normalized = normalizeModelPayload(response, input.apiMode);
    if (normalized.usage) {
      const next = normalized.usage;
      usage = {
        ...usage,
        ...next,
        prompt_tokens: count(next.prompt_tokens) ?? usage.prompt_tokens,
        completion_tokens:
          count(next.completion_tokens) ?? usage.completion_tokens,
        ...(next.prompt_tokens_details || usage.prompt_tokens_details
          ? {
              prompt_tokens_details: {
                cached_tokens:
                  count(next.prompt_tokens_details?.cached_tokens) ??
                  usage.prompt_tokens_details?.cached_tokens,
              },
            }
          : {}),
        prompt_cache_hit_tokens:
          count(next.prompt_cache_hit_tokens) ?? usage.prompt_cache_hit_tokens,
        ...(next.completion_tokens_details || usage.completion_tokens_details
          ? {
              completion_tokens_details: {
                reasoning_tokens:
                  count(next.completion_tokens_details?.reasoning_tokens) ??
                  usage.completion_tokens_details?.reasoning_tokens,
              },
            }
          : {}),
      };
    }
    // Deltas and final snapshots describe the same output. Never add both.
    if (
      typeof payload.type === "string" &&
      /^response\..*\.delta$/.test(payload.type)
    ) {
      deltaBytes += bytes(payload.delta);
    }
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      if (!record(choice) || !record(choice.delta)) continue;
      const delta = choice.delta;
      deltaBytes += bytes(delta.content) + bytes(delta.reasoning_content);
      if (Array.isArray(delta.tool_calls))
        for (const call of delta.tool_calls) {
          if (record(call) && record(call.function))
            deltaBytes += bytes(call.function.arguments);
        }
    }
    const message = normalized.choices?.[0]?.message;
    let snapshotBytes =
      bytes(message?.content) + bytes(message?.reasoning_content);
    for (const call of message?.tool_calls ?? [])
      snapshotBytes += bytes(call.function.arguments);
    if (Array.isArray(response.output))
      snapshotBytes = response.output.reduce<number>(
        (sum, item: unknown) => sum + (record(item) ? itemBytes(item) : 0),
        0,
      );
    if (payload.type === "response.output_item.done" && record(payload.item)) {
      const id =
        typeof payload.item.id === "string"
          ? payload.item.id
          : typeof payload.output_index === "number"
            ? payload.output_index
            : "unknown";
      items.set(id, itemBytes(payload.item));
    }
    outputBytes = Math.max(
      outputBytes,
      snapshotBytes,
      deltaBytes,
      [...items.values()].reduce((a, b) => a + b, 0),
    );
  };
  return {
    observe,
    finish(outcome: ModelRequestUsage["outcome"]): {
      payload: ModelUsagePayload;
      event: ModelRequestUsage;
    } {
      const inputMissing = usage.prompt_tokens === undefined;
      const outputMissing = usage.completion_tokens === undefined;
      const estimatedInput = inputMissing ? Math.ceil(inputBytes / 4) : 0;
      const estimatedOutput = outputMissing ? Math.ceil(outputBytes / 4) : 0;
      const payload: ModelUsagePayload = {
        ...usage,
        ...(inputMissing || outputMissing
          ? {
              nestor_estimated: {
                calls: 1,
                inputTokens: estimatedInput,
                outputTokens: estimatedOutput,
                method: "utf8_bytes_div_4_visible_only" as const,
              },
            }
          : {}),
      };
      return {
        payload,
        event: {
          ...normalizeModelUsage(payload),
          provider,
          model:
            typeof input.body.model === "string" ? input.body.model : "unknown",
          purpose: input.purpose ?? "unspecified",
          attempt,
          outcome,
        },
      };
    },
  };
}
