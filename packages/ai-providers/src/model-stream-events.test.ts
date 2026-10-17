import { describe, expect, test, vi } from "vitest";

import {
  performModelRequest,
  type ModelStreamEvent,
} from "./model-request-transport";
import { normalizeModelUsage } from "./openai-compatible";
import {
  ALTERNATIVE_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_MODEL,
  resolveAssistantModelCapabilities,
  resolveAssistantModelRouteFromEnvironment,
} from "./assistant-model";
import { buildModelRequestBody } from "./openai-compatible-transport";

function sseResponse(events: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const baseInput = {
  url: "https://gateway.example/v1/chat/completions",
  headers: { Authorization: "Bearer test" },
  body: { model: "test-model", messages: [] },
  apiMode: "chat_completions" as const,
  totalTimeoutMs: 5_000,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 5,
};

describe("normalized stream events", () => {
  test("chat completions: text deltas, reasoning continuation, usage and finish reason", async () => {
    const events: ModelStreamEvent[] = [];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        sseResponse([
          JSON.stringify({
            choices: [{ delta: { reasoning_content: "think " } }],
          }),
          JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "read_profile", arguments: "{" },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: "}" } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 40,
              prompt_tokens_details: { cached_tokens: 1000 },
            },
          }),
          "[DONE]",
        ]),
      ),
    );
    const payload = await performModelRequest({
      ...baseInput,
      fetchImpl,
      onStreamEvent: (event) => events.push(event),
    });
    expect(events).toEqual([
      { type: "attempt_started", attempt: 0 },
      { type: "reasoning_delta", text: "think " },
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "tool_call_started", index: 0, name: "read_profile" },
    ]);
    const choice = payload.choices?.[0];
    expect(choice?.message?.content).toBe("Hello");
    expect(choice?.message?.reasoning_content).toBe("think ");
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message?.tool_calls?.[0]?.function.arguments).toBe("{}");
    expect(normalizeModelUsage(payload.usage ?? {})).toEqual({
      inputTokens: 1200,
      outputTokens: 40,
      cachedInputTokens: 1000,
      reasoningTokens: 0,
    });
  });

  test("responses: text deltas and usage from the completed response", async () => {
    const events: ModelStreamEvent[] = [];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        sseResponse([
          JSON.stringify({ type: "response.output_text.delta", delta: "Hi" }),
          JSON.stringify({
            type: "response.completed",
            response: {
              status: "completed",
              output_text: "Hi",
              usage: {
                input_tokens: 500,
                output_tokens: 10,
                input_tokens_details: { cached_tokens: 200 },
                output_tokens_details: { reasoning_tokens: 4 },
              },
            },
          }),
        ]),
      ),
    );
    const payload = await performModelRequest({
      ...baseInput,
      apiMode: "responses",
      fetchImpl,
      onStreamEvent: (event) => events.push(event),
    });
    expect(events).toContainEqual({ type: "text_delta", text: "Hi" });
    expect(normalizeModelUsage(payload.usage ?? {})).toEqual({
      inputTokens: 500,
      outputTokens: 10,
      cachedInputTokens: 200,
      reasoningTokens: 4,
    });
  });

  test("a retried attempt announces itself so partial text is replaced", async () => {
    const events: ModelStreamEvent[] = [];
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      if (call === 1) {
        // Partial text, then the stream ends without a completion marker.
        return Promise.resolve(
          sseResponse([
            JSON.stringify({ choices: [{ delta: { content: "par" } }] }),
          ]),
        );
      }
      return Promise.resolve(
        sseResponse([
          JSON.stringify({
            choices: [{ delta: { content: "whole" }, finish_reason: "stop" }],
          }),
          "[DONE]",
        ]),
      );
    });
    const payload = await performModelRequest({
      ...baseInput,
      fetchImpl,
      onStreamEvent: (event) => events.push(event),
    });
    expect(payload.choices?.[0]?.message?.content).toBe("whole");
    expect(events.map((event) => event.type)).toEqual([
      "attempt_started",
      "text_delta",
      "attempt_started",
      "text_delta",
    ]);
  });

  test("chat body asks for stream usage only when told to", () => {
    const body = buildModelRequestBody({
      apiMode: "chat_completions",
      model: "m",
      messages: [],
      includeStreamUsage: true,
    });
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(
      buildModelRequestBody({
        apiMode: "chat_completions",
        model: "m",
        messages: [],
      }).stream_options,
    ).toBeUndefined();
  });
});

describe("assistant route", () => {
  test("defaults to DeepSeek Flash on Chat Completions at low effort", () => {
    const resolution = resolveAssistantModelRouteFromEnvironment({
      NESTOR_AI_API_KEY: "test-key",
    });
    expect(resolution.available).toBe(true);
    if (!resolution.available) return;
    expect(resolution.route.model).toBe(DEFAULT_ASSISTANT_MODEL);
    expect(resolution.route.apiMode).toBe("chat_completions");
    expect(resolution.route.reasoningEffort).toBe("low");
    expect(resolution.route.capabilities.continuation).toBe(
      "reasoning_content",
    );
    expect(resolution.fallback).toBeNull();
  });

  test("the alternative route uses Responses and has vision", () => {
    const resolution = resolveAssistantModelRouteFromEnvironment({
      NESTOR_AI_API_KEY: "test-key",
      NESTOR_AI_ASSISTANT_MODEL: ALTERNATIVE_ASSISTANT_MODEL,
    });
    expect(resolution.available).toBe(true);
    if (!resolution.available) return;
    expect(resolution.route.apiMode).toBe("responses");
    expect(resolution.route.capabilities.images).toBe(true);
  });

  test("an unknown model gets the conservative row and a missing key reads as an outage", () => {
    const unknown = resolveAssistantModelCapabilities({ model: "other" });
    expect(unknown.known).toBe(false);
    expect(unknown.contextWindowTokens).toBeLessThanOrEqual(64_000);
    const missing = resolveAssistantModelRouteFromEnvironment({});
    expect(missing.available).toBe(false);
    if (missing.available) return;
    expect(missing.detail).not.toMatch(/key|configure|setting/i);
  });
});
