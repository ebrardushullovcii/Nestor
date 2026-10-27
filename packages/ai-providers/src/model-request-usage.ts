import type { ModelRequestUsage } from "@nestor/contracts";
import { randomUUID } from "node:crypto";
import type {
  ModelApiMode,
  ModelUsagePayload,
} from "./openai-compatible-transport";
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
  const metadata = {
    requestId: randomUUID(),
    startedAt: new Date().toISOString(),
    provider,
    model: typeof input.body.model === "string" ? input.body.model : "unknown",
    purpose: input.purpose ?? "unspecified",
    attempt,
  };
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
    // Read counters without parsing output: a malformed or truncated answer
    // can still carry valid, billable provider usage.
    if (record(response.usage)) {
      const next = response.usage;
      const promptDetails = record(next.prompt_tokens_details)
        ? next.prompt_tokens_details
        : record(next.input_tokens_details)
          ? next.input_tokens_details
          : {};
      const completionDetails = record(next.completion_tokens_details)
        ? next.completion_tokens_details
        : record(next.output_tokens_details)
          ? next.output_tokens_details
          : {};
      const hit = count(next.prompt_cache_hit_tokens),
        miss = count(next.prompt_cache_miss_tokens);
      usage = {
        ...usage,
        total_tokens: count(next.total_tokens) ?? usage.total_tokens,
        prompt_tokens:
          count(next.prompt_tokens ?? next.input_tokens) ??
          (hit !== undefined && miss !== undefined
            ? count(hit + miss)
            : undefined) ??
          usage.prompt_tokens,
        completion_tokens:
          count(next.completion_tokens ?? next.output_tokens) ??
          usage.completion_tokens,
        ...(next.prompt_tokens_details ||
        next.input_tokens_details ||
        usage.prompt_tokens_details
          ? {
              prompt_tokens_details: {
                cached_tokens:
                  count(promptDetails.cached_tokens) ??
                  usage.prompt_tokens_details?.cached_tokens,
              },
            }
          : {}),
        prompt_cache_hit_tokens:
          count(next.prompt_cache_hit_tokens) ?? usage.prompt_cache_hit_tokens,
        ...(next.completion_tokens_details ||
        next.output_tokens_details ||
        usage.completion_tokens_details
          ? {
              completion_tokens_details: {
                reasoning_tokens:
                  count(completionDetails.reasoning_tokens) ??
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
    const first = choices[0];
    const message =
      record(first) && record(first.message) ? first.message : null;
    let snapshotBytes =
      bytes(message?.content) + bytes(message?.reasoning_content);
    if (Array.isArray(message?.tool_calls))
      for (const call of message.tool_calls) {
        if (record(call) && record(call.function))
          snapshotBytes += bytes(call.function.arguments);
      }
    snapshotBytes = Math.max(snapshotBytes, bytes(response.output_text));
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
    metadata,
    observeText: (text: string) => {
      outputBytes = Math.max(outputBytes, bytes(text));
    },
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
          ...metadata,
          finishedAt: new Date().toISOString(),
          outcome,
        },
      };
    },
  };
}
