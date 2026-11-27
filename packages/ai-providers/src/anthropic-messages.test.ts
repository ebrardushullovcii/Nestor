import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelRequestUsage } from "@nestor/contracts";
import type { ModelStreamEvent } from "./model-request-transport";
import { ModelOutputLimitError } from "@nestor/agent-runtime";
import {
  ModelRefusalError,
  messagesSdkBaseUrl,
  messagesToolInputSchema,
  normalizeMessagesResponse,
} from "./anthropic-messages";
import { getAiProviderAccessFailure } from "./ai-provider-access-failure";
import {
  performModelRequest,
  resetModelCredentialRejections,
} from "./model-request-transport";
import {
  buildModelRequestBody,
  buildModelUrl,
  parseModelApiMode,
} from "./openai-compatible-transport";
import { createOpenAiCompatibleJobFinderAiClient } from "./openai-compatible";
import { createOpenAiCompatibleInterviewScreenshotVisionProvider } from "./live-assistant";
import type { AgentLoopToolDefinition } from "@nestor/agent-runtime";
import type { AgentMessage } from "./shared";

/** A scripted Messages response, streamed as Anthropic's SSE events. */
type ScriptedBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "fallback"; from: { model: string }; to: { model: string } };

interface ScriptedMessage {
  content: ScriptedBlock[];
  stop_reason: string;
  stop_details?: unknown;
  usage?:
    | {
        input_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
        output_tokens: number;
      }
    | undefined;
}

function sse(message: ScriptedMessage): Response {
  const usage = message.usage ?? {
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 5,
  };
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage, output_tokens: 1 },
        },
      },
    ],
    ["ping", { type: "ping" }],
  ];
  message.content.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push(
        [
          "content_block_start",
          {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: block.thinking },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: block.signature },
          },
        ],
      );
    } else if (block.type === "text") {
      events.push(
        [
          "content_block_start",
          {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          },
        ],
      );
    } else if (block.type === "tool_use") {
      events.push(
        [
          "content_block_start",
          {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          },
        ],
      );
    } else {
      events.push([
        "content_block_start",
        { type: "content_block_start", index, content_block: block },
      ]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason: message.stop_reason,
          stop_sequence: null,
          stop_details: message.stop_details ?? null,
        },
        usage: { output_tokens: usage.output_tokens },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  const text = events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function apiError(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Stubs the global fetch the SDK is handed; records every request. */
function scriptFetch(replies: Array<Response | (() => Response)>) {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  const queue = [...replies];
  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: url instanceof Request ? url.url : url.toString(),
      headers: new Headers(init?.headers),
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    const next = queue.shift();
    if (!next) throw new Error("no scripted reply left");
    return Promise.resolve(typeof next === "function" ? next() : next);
  });
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  return {
    captured,
    fetchImpl,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

let restoreFetch: (() => void) | null = null;
beforeEach(() => {
  resetModelCredentialRejections();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  vi.restoreAllMocks();
});

function client(overrides: Record<string, unknown> = {}) {
  return createOpenAiCompatibleJobFinderAiClient({
    apiKey: "sk-ant-test",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-opus-5-5",
    apiMode: "messages",
    reasoningEffort: "medium",
    agentReasoningEffort: "medium",
    label: "AI resume agent",
    retryBaseDelayMs: 0,
    ...overrides,
  });
}

const tools: AgentLoopToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "open_page",
      description: "Open a page",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
];

describe("Messages route selection", () => {
  test("NESTOR_AI_API_MODE=messages selects it and names /v1/messages", () => {
    expect(parseModelApiMode("messages")).toBe("messages");
    expect(buildModelUrl("https://api.anthropic.com/v1", "messages")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(buildModelUrl("https://api.anthropic.com/", "messages")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(messagesSdkBaseUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com",
    );
  });
});

describe("Messages request mapping", () => {
  test("a JSON task: system cached, effort and schema in output_config, no tail write", () => {
    const body = buildModelRequestBody({
      apiMode: "messages",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
      temperature: 0,
      jsonOutput: true,
      jsonSchema: {
        name: "fit",
        schema: {
          type: "object",
          properties: {
            score: { type: "integer", minimum: 0, maximum: 100 },
            reasons: { type: "array", items: { type: "string" }, maxItems: 3 },
          },
          required: ["score", "reasons"],
          additionalProperties: false,
        },
      },
      messages: [
        { role: "system", content: "Judge fit. Return JSON only." },
        { role: "user", content: '{"job":1}' },
      ],
    });
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 128_000,
      fallbacks: "default",
      betas: [
        "server-side-fallback-2026-07-01",
        "thinking-binding-controls-2026-08-01",
      ],
      thinking: {
        type: "adaptive",
        display: "summarized",
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
      system: [
        {
          type: "text",
          text: "Judge fit. Return JSON only.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: '{"job":1}' }] },
      ],
      output_config: { effort: "high", format: { type: "json_schema" } },
    });
    // Sampling is rejected on this model; JSON mode does not exist.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("cache_control");
    const schema = (
      body.output_config as { format: { schema: Record<string, unknown> } }
    ).format.schema;
    // The SDK's transform moves unsupported constraints into descriptions.
    expect(JSON.stringify(schema)).not.toContain('"maximum"');
    expect(schema).toMatchObject({ additionalProperties: false });
  });

  test("tools, tool results with screenshots, images and parallel calls", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const body = buildModelRequestBody({
      apiMode: "messages",
      model: "claude-opus-5-5",
      reasoningEffort: "none",
      messages: [
        { role: "system", content: "Apply for the job." },
        {
          role: "user",
          content: [
            { type: "text", text: "Here is the page." },
            { type: "image_url", image_url: { url: png } },
          ],
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: { name: "open_page", arguments: '{"url":"a"}' },
            },
            {
              id: "toolu_2",
              type: "function",
              function: { name: "open_page", arguments: '{"url":"b"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "toolu_1", content: "Opened a." },
        {
          role: "tool",
          tool_call_id: "toolu_2",
          content: "Opened b.",
          images: [{ label: "Screenshot of b", dataUrl: png }],
        },
      ],
      tools,
      parallelToolCalls: false,
    });
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    };
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Here is the page." }, image],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "open_page",
            input: { url: "a" },
          },
          {
            type: "tool_use",
            id: "toolu_2",
            name: "open_page",
            input: { url: "b" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "Opened a." }],
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [
              { type: "text", text: "Opened b." },
              { type: "text", text: "Screenshot of b" },
              image,
            ],
          },
        ],
      },
    ]);
    expect(body).toMatchObject({
      tools: [
        {
          name: "open_page",
          description: "Open a page",
          input_schema: tools[0]!.function.parameters,
        },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      // A conversation's growing end is cached automatically.
      cache_control: { type: "ephemeral" },
      // Messages has no `none`; its lowest effort is `low`.
      output_config: { effort: "low" },
    });
    expect(body).not.toHaveProperty("tool_choice.type", "any");
  });

  test("a later system message stays a system message only where the API allows it", () => {
    const body = buildModelRequestBody({
      apiMode: "messages",
      model: "claude-opus-5-5",
      messages: [
        { role: "system", content: "Base." },
        { role: "user", content: "Hi" },
        { role: "system", content: "Now be brief." },
        { role: "assistant", content: "Ok." },
        { role: "system", content: "Context trimmed." },
        { role: "user", content: "Next" },
      ],
    });
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "system", content: "Now be brief." },
      { role: "assistant", content: [{ type: "text", text: "Ok." }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Context trimmed." },
          { type: "text", text: "Next" },
        ],
      },
    ]);
  });
});

describe("Messages agent turns through the client", () => {
  test("turn N+1 starts with turn N's request byte for byte, thinking replayed unchanged", async () => {
    const turn = (n: number, usage: ScriptedMessage["usage"]) =>
      sse({
        content: [
          {
            type: "thinking",
            thinking: `Plan ${n}`,
            signature: `sig-${n}-${"x".repeat(40)}`,
          },
          { type: "text", text: n === 3 ? "Done." : `Opening page ${n}.` },
          ...(n < 3
            ? [
                {
                  type: "tool_use" as const,
                  id: `toolu_${n}`,
                  name: "open_page",
                  input: { url: `https://jobs.example/${n}` },
                },
              ]
            : []),
        ],
        stop_reason: n < 3 ? "tool_use" : "end_turn",
        usage,
      });
    const script = scriptFetch([
      turn(1, {
        input_tokens: 40,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 2_000,
        output_tokens: 30,
      }),
      turn(2, {
        input_tokens: 30,
        cache_read_input_tokens: 2_000,
        cache_creation_input_tokens: 120,
        output_tokens: 30,
      }),
      turn(3, {
        input_tokens: 30,
        cache_read_input_tokens: 2_120,
        cache_creation_input_tokens: 110,
        output_tokens: 10,
      }),
    ]);
    restoreFetch = script.restore;
    const usages: ModelRequestUsage[] = [];
    const ai = client();
    const messages: AgentMessage[] = [
      { role: "system", content: "You are the search agent. ".repeat(50) },
      { role: "user", content: "Find jobs." },
    ];
    for (let n = 1; n <= 3; n += 1) {
      const result = await ai.chatWithTools(messages, tools, {
        reasoningTask: "search",
        onRequestUsage: (usage) => usages.push(usage),
      });
      messages.push({
        role: "assistant",
        content: result.content ?? "",
        ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
        ...(result.continuation ? { continuation: result.continuation } : {}),
      });
      for (const call of result.toolCalls ?? [])
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Opened ${(JSON.parse(call.function.arguments) as { url: string }).url}`,
        });
    }
    expect(script.captured).toHaveLength(3);
    const [first, second, third] = script.captured.map(
      (request) => request.body,
    );
    // The SDK is the client: its auth and version headers, our User-Agent, streaming.
    expect(script.captured[0]!.url).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(script.captured[0]!.headers.get("authorization")).toBe(
      "Bearer sk-ant-test",
    );
    expect(script.captured[0]!.headers.get("anthropic-version")).toBeTruthy();
    expect(script.captured[0]!.headers.get("user-agent")).toMatch(
      /^Nestor-JobFinder/,
    );
    expect(script.captured[0]!.headers.get("anthropic-beta")).toContain(
      "server-side-fallback-2026-07-01",
    );
    expect(first!.stream).toBe(true);
    for (const body of [first, second, third]) {
      expect(body!.cache_control).toEqual({ type: "ephemeral" });
      expect(body!.output_config).toEqual({ effort: "medium" });
    }
    // Tools and system never change, so their cache entry is read every turn.
    expect(JSON.stringify(second!.tools)).toBe(JSON.stringify(first!.tools));
    expect(JSON.stringify(second!.system)).toBe(JSON.stringify(first!.system));
    expect(JSON.stringify(third!.system)).toBe(JSON.stringify(first!.system));
    // Append-only: each request begins with the previous one's messages.
    const firstMessages = first!.messages as unknown[];
    const secondMessages = second!.messages as unknown[];
    const thirdMessages = third!.messages as unknown[];
    expect(JSON.stringify(secondMessages.slice(0, firstMessages.length))).toBe(
      JSON.stringify(firstMessages),
    );
    expect(JSON.stringify(thirdMessages.slice(0, secondMessages.length))).toBe(
      JSON.stringify(secondMessages),
    );
    // The assistant turn goes back exactly as Anthropic produced it.
    expect(secondMessages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Plan 1",
          signature: `sig-1-${"x".repeat(40)}`,
        },
        { type: "text", text: "Opening page 1." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "open_page",
          input: { url: "https://jobs.example/1" },
        },
      ],
    });
    // inputTokens includes cache reads and writes, as on the other routes.
    expect(
      usages.map((usage) => [
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.cacheWriteInputTokens,
        usage.outputTokens,
      ]),
    ).toEqual([
      [2_040, 0, 2_000, 30],
      [2_150, 2_000, 120, 30],
      [2_260, 2_120, 110, 10],
    ]);
    expect(usages.every((usage) => usage.outcome === "completed")).toBe(true);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Done.",
    });
  });

  test("an edited assistant turn is rebuilt without its thinking", async () => {
    const script = scriptFetch([
      sse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
    ]);
    restoreFetch = script.restore;
    const ai = client();
    await ai.chatWithTools(
      [
        { role: "system", content: "S" },
        { role: "user", content: "U" },
        {
          role: "assistant",
          content: "A rewritten receipt",
          continuation: {
            kind: "message_content",
            // The same route, so only the edit decides.
            route: createHash("sha256")
              .update(
                JSON.stringify([
                  "https://api.anthropic.com/v1/messages",
                  "claude-opus-5-5",
                  "messages",
                ]),
              )
              .digest("hex"),
            text: JSON.stringify([
              { type: "thinking", thinking: "", signature: "s" },
              { type: "text", text: "The original page view" },
            ]),
          },
        },
        { role: "user", content: "Next" },
      ],
      [],
    );
    expect((script.captured[0]!.body.messages as unknown[])[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "A rewritten receipt" }],
    });
  });

  test("streamed deltas reach the host as text, reasoning and tool-call events", async () => {
    const script = scriptFetch([
      sse({
        content: [
          { type: "thinking", thinking: "Considering", signature: "sig" },
          { type: "text", text: "Looking." },
          {
            type: "tool_use",
            id: "toolu_9",
            name: "open_page",
            input: { url: "u" },
          },
        ],
        stop_reason: "tool_use",
      }),
    ]);
    restoreFetch = script.restore;
    const events: ModelStreamEvent[] = [];
    const result = await client().chatWithTools(
      [{ role: "user", content: "go" }],
      tools,
      { onStreamEvent: (event) => events.push(event) },
    );
    expect(events).toEqual([
      { type: "attempt_started", attempt: 0 },
      { type: "reasoning_delta", text: "Considering" },
      { type: "text_delta", text: "Looking." },
      { type: "tool_call_started", index: 2, name: "open_page" },
      { type: "tool_call_delta", index: 2 },
    ]);
    expect(result).toMatchObject({
      content: "Looking.",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "toolu_9",
          type: "function",
          function: { name: "open_page", arguments: '{"url":"u"}' },
        },
      ],
    });
  });

  test("a JSON task with a schema sends it as structured output", async () => {
    const script = scriptFetch([
      sse({
        content: [{ type: "text", text: '{"keep":[1]}' }],
        stop_reason: "end_turn",
      }),
    ]);
    restoreFetch = script.restore;
    const result = await client().chatWithTools(
      [
        { role: "system", content: "Screen listings. Return JSON." },
        { role: "user", content: "[]" },
      ],
      [],
      {
        jsonOutput: true,
        jsonSchema: {
          name: "screen",
          schema: {
            type: "object",
            properties: { keep: { type: "array", items: { type: "integer" } } },
            required: ["keep"],
            additionalProperties: false,
          },
        },
        reasoningTask: "listing_screen",
      },
    );
    expect(result.content).toBe('{"keep":[1]}');
    expect(script.captured[0]!.body.output_config).toMatchObject({
      effort: "medium",
      format: { type: "json_schema" },
    });
  });
});

describe("Messages outcomes and failures", () => {
  const input = () => ({
    url: "https://api.anthropic.com/v1/messages",
    headers: { Authorization: "Bearer sk-ant-test" },
    body: buildModelRequestBody({
      apiMode: "messages",
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "hi" }],
    }),
    apiMode: "messages" as const,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
  });

  test("a refusal is reported with its category and is not retried", async () => {
    const script = scriptFetch([
      sse({
        content: [],
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: "Declined.",
        },
      }),
    ]);
    restoreFetch = script.restore;
    const error = await performModelRequest(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(error).toMatchObject({
      category: "cyber",
      message: "The AI declined this request (cyber): Declined.",
    });
    expect(script.fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("401 and 402 from Anthropic are the transport's access failures", async () => {
    for (const status of [401, 402, 403]) {
      resetModelCredentialRejections();
      const script = scriptFetch([
        apiError(status, "authentication_error", "invalid x-api-key"),
      ]);
      const error = await performModelRequest(input()).catch((e: unknown) => e);
      script.restore();
      expect(error).toMatchObject({ status });
      expect(getAiProviderAccessFailure(error)).not.toBeNull();
      expect(script.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  test("an overloaded API is retried, then answers", async () => {
    const script = scriptFetch([
      apiError(529, "overloaded_error", "Overloaded"),
      sse({
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
      }),
    ]);
    restoreFetch = script.restore;
    const payload = await performModelRequest(input());
    expect(payload.choices?.[0]?.message?.content).toBe("hello");
    expect(script.fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("a 400 is not retried and keeps Anthropic's message", async () => {
    const script = scriptFetch([
      apiError(
        400,
        "invalid_request_error",
        "prompt is too long: 2000000 tokens > 1000000 maximum",
      ),
    ]);
    restoreFetch = script.restore;
    await expect(performModelRequest(input())).rejects.toMatchObject({
      status: 400,
      message:
        "invalid_request_error: prompt is too long: 2000000 tokens > 1000000 maximum",
    });
    expect(script.fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("Stop aborts a streaming answer", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const script = scriptFetch([
      () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(
                encoder.encode(
                  `event: message_start\ndata: ${JSON.stringify({
                    type: "message_start",
                    message: {
                      id: "m",
                      type: "message",
                      role: "assistant",
                      model: "claude-opus-5-5",
                      content: [],
                      stop_reason: null,
                      usage: { input_tokens: 1, output_tokens: 1 },
                    },
                  })}\n\n`,
                ),
              );
              setTimeout(() => controller.abort(), 10);
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ]);
    restoreFetch = script.restore;
    await expect(
      performModelRequest({ ...input(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("an answer cut off at max_tokens is the output-limit error", () => {
    expect(() =>
      normalizeMessagesResponse({
        content: [{ type: "text", text: "partial", citations: null }],
        stop_reason: "max_tokens",
        stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as never),
    ).toThrow(ModelOutputLimitError);
  });

  test("after a mid-output fallback only the accepted blocks go back", () => {
    const payload = normalizeMessagesResponse({
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: "", signature: "a" },
        { type: "text", text: "Part one. ", citations: null },
        { type: "tool_use", id: "toolu_x", name: "open_page", input: {} },
        {
          type: "fallback",
          from: { model: "claude-opus-5-5" },
          to: { model: "claude-opus-5" },
        },
        { type: "thinking", thinking: "", signature: "b" },
        {
          type: "tool_use",
          id: "toolu_y",
          name: "open_page",
          input: { url: "y" },
        },
      ],
      stop_reason: "tool_use",
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never);
    const message = payload.choices?.[0]?.message;
    expect(message?.tool_calls?.map((call) => call.id)).toEqual(["toolu_y"]);
    expect(
      (message?.anthropic_content as Array<{ type: string }>).map(
        (block) => block.type,
      ),
    ).toEqual(["text", "fallback", "thinking", "tool_use"]);
  });
});

describe("Messages vision", () => {
  test("screenshots go as base64 image blocks and the JSON answer comes back", async () => {
    const script = scriptFetch([
      sse({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              {
                summary: "A system-design prompt is visible.",
                confidence: 0.98,
              },
            ]),
          },
        ],
        stop_reason: "end_turn",
      }),
    ]);
    restoreFetch = script.restore;
    const provider = createOpenAiCompatibleInterviewScreenshotVisionProvider({
      apiKey: "sk-ant-test",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-opus-5-5",
      apiMode: "messages",
      reasoningEffort: "low",
    });
    const observations = await provider.describeScreenshotBatch({
      batchId: "batch_1",
      screenshotCount: 1,
      overlayContaminated: false,
      images: [{ mimeType: "image/png", base64: "aW1hZ2U=" }],
      createdAt: "2026-05-13T10:00:05.000Z",
    });
    expect(observations).toMatchObject([
      { summary: "A system-design prompt is visible.", confidence: "high" },
    ]);
    const body = script.captured[0]!.body;
    expect(body.output_config).toEqual({ effort: "low" });
    expect(
      (body.messages as Array<{ content: unknown[] }>)[0]!.content,
    ).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
    });
  });
});

describe("Messages one-shot caching", () => {
  const system = { role: "system" as const, content: "Judge fit. ".repeat(80) };
  const lead = { person: { name: "Synthetic" }, goals: { remote: true } };
  const batch = (n: number) =>
    JSON.stringify({ ...lead, listings: [{ id: n, text: `Listing ${n}` }] });

  test("a one-shot request with a tool caches tools + system and the stable lead, never its end", () => {
    const leadText = JSON.stringify(lead).slice(0, -1);
    const bodies = [1, 2].map((n) =>
      buildModelRequestBody({
        apiMode: "messages",
        model: "claude-opus-5-5",
        messages: [system, { role: "user", content: batch(n) }],
        tools,
        oneShot: true,
        stableLead: leadText,
      }),
    );
    for (const body of bodies) {
      // No automatic breakpoint on the per-call end.
      expect(body).not.toHaveProperty("cache_control");
      expect(body.system).toMatchObject([
        { cache_control: { type: "ephemeral" } },
      ]);
    }
    const [first, second] = bodies.map(
      (body) =>
        (
          body.messages as Array<{ content: Array<Record<string, unknown>> }>
        )[0]!.content,
    );
    expect(first).toEqual([
      { type: "text", text: leadText, cache_control: { type: "ephemeral" } },
      { type: "text", text: batch(1).slice(leadText.length) },
    ]);
    // Everything up to the last breakpoint is byte-identical across calls;
    // only the uncached end differs, so the next call reads the lead.
    const cachedPrefix = (body: Record<string, unknown>, blocks: unknown[]) =>
      JSON.stringify([body.tools, body.system, blocks[0]]);
    expect(cachedPrefix(bodies[1]!, second!)).toBe(
      cachedPrefix(bodies[0]!, first!),
    );
    expect(second![1]).not.toEqual(first![1]);
  });

  test("a lead that is not where the message starts is not split", () => {
    const body = buildModelRequestBody({
      apiMode: "messages",
      model: "claude-opus-5-5",
      messages: [system, { role: "user", content: batch(1) }],
      oneShot: true,
      stableLead: '{"other":',
    });
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: batch(1) }] },
    ]);
  });

  test("earlier messages of a one-shot request are its lead", () => {
    const body = buildModelRequestBody({
      apiMode: "messages",
      model: "claude-opus-5-5",
      messages: [
        system,
        { role: "user", content: "The person's facts." },
        { role: "user", content: "This batch." },
      ],
    });
    expect(body).not.toHaveProperty("cache_control");
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The person's facts.",
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "This batch." },
        ],
      },
    ]);
  });

  test("once a one-shot request takes a tool turn, it caches as a conversation", () => {
    const body = buildModelRequestBody({
      apiMode: "messages",
      model: "claude-opus-5-5",
      messages: [
        system,
        { role: "user", content: batch(1) },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: { name: "open_page", arguments: '{"url":"a"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "toolu_1", content: "part 2" },
      ],
      tools,
      oneShot: true,
      stableLead: JSON.stringify(lead).slice(0, -1),
    });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(body.messages)).not.toContain('"cache_control"');
  });

  test("the client passes oneShot and stableLead to the route", async () => {
    const script = scriptFetch([
      sse({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }),
    ]);
    restoreFetch = script.restore;
    const leadText = JSON.stringify(lead).slice(0, -1);
    await client().chatWithTools(
      [system, { role: "user", content: batch(3) }],
      tools,
      { oneShot: true, stableLead: leadText, reasoningTask: "fit_batch" },
    );
    const body = script.captured[0]!.body;
    expect(body).not.toHaveProperty("cache_control");
    expect(
      (body.messages as Array<{ content: Array<{ text?: string }> }>)[0]!
        .content[0]!.text,
    ).toBe(leadText);
  });
});

describe("Messages tool input schemas", () => {
  const COMBINATORS = ["allOf", "anyOf", "oneOf"];
  /** Anthropic: an object at the top level, no combinator there. */
  const acceptable = (schema: Record<string, unknown>) =>
    schema.type === "object" && COMBINATORS.every((key) => !(key in schema));

  test("pointer's conditional requirements become a described object", () => {
    const pointer = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "drag", "hold"] },
        x: { type: "number" },
        y: { type: "number" },
        endX: { type: "number" },
        endY: { type: "number" },
        durationMs: { type: "number", minimum: 0 },
      },
      required: ["action", "x", "y"],
      additionalProperties: false,
      allOf: [
        {
          if: {
            properties: { action: { const: "drag" } },
            required: ["action"],
          },
          then: { required: ["endX", "endY"] },
        },
      ],
    };
    const schema = messagesToolInputSchema(pointer) as Record<string, unknown>;
    expect(acceptable(schema)).toBe(true);
    expect(schema).toMatchObject({
      properties: pointer.properties,
      required: ["action", "x", "y"],
      additionalProperties: false,
    });
    expect(schema.description).toContain('"then":{"required":["endX","endY"]}');
    // The app's own schema is left as it was.
    expect(pointer).toHaveProperty("allOf");
  });

  test("alternative argument shapes become one object of every property", () => {
    const schema = messagesToolInputSchema({
      type: "object",
      description: "Edit one thing.",
      anyOf: [
        {
          properties: { field: { type: "string" }, value: { type: "string" } },
          required: ["field", "value"],
        },
        {
          properties: { field: { type: "string" }, values: { type: "array" } },
          required: ["field", "values"],
        },
      ],
    }) as Record<string, unknown>;
    expect(acceptable(schema)).toBe(true);
    expect(schema).toMatchObject({
      properties: {
        field: { type: "string" },
        value: { type: "string" },
        values: { type: "array" },
      },
      required: ["field"],
    });
    expect(schema.description).toMatch(
      /^Edit one thing\.\nThe input must also satisfy/u,
    );
  });

  test("a schema the API already accepts goes out unchanged", () => {
    const plain = tools[0]!.function.parameters;
    expect(messagesToolInputSchema(plain)).toBe(plain);
  });

  test("every tool in a request is sent in the accepted form", () => {
    const body = buildModelRequestBody({
      apiMode: "messages",
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "go" }],
      tools: [
        ...tools,
        {
          type: "function",
          function: {
            name: "pointer",
            parameters: {
              type: "object",
              properties: { action: { type: "string" } },
              allOf: [{ if: {}, then: {} }],
            },
          },
        },
      ],
    });
    for (const tool of body.tools as Array<{
      input_schema: Record<string, unknown>;
    }>)
      expect(acceptable(tool.input_schema)).toBe(true);
  });
});

describe("Messages history", () => {
  test("a Messages reply asks the loop to keep its history append-only", async () => {
    const script = scriptFetch([
      sse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
    ]);
    restoreFetch = script.restore;
    const result = await client().chatWithTools(
      [{ role: "user", content: "go" }],
      tools,
    );
    expect(result.appendOnlyHistory).toBe(true);
  });

  test("other routes keep folding", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    const result = await client({
      baseUrl: "https://gateway.example/v1",
      model: "deepseek-v4.1-flash",
      apiMode: "chat_completions",
    }).chatWithTools([{ role: "user", content: "go" }], tools);
    expect(result.appendOnlyHistory).toBeUndefined();
  });
});
