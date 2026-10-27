import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ModelUsageTotalsSchema,
  type ModelRequestUsage,
} from "@nestor/contracts";
import { createModelUsageRecorder } from "./model-usage-scope";
import { performModelRequest } from "./model-request-transport";
import { createOpenAiCompatibleJobFinderAiClient } from "./openai-compatible";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const reply = (inputTokens: number, cached: number) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "Synthetic result" } }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: cached },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
const request = {
  url: "https://model.example.test/v1/chat/completions",
  headers: {},
  body: { messages: [] },
  apiMode: "chat_completions" as const,
  totalTimeoutMs: 2000,
  maxAttempts: 2,
  retryBaseDelayMs: 0,
  retryMaxDelayMs: 0,
};
test("scope records transport retries, cached input and unknown token usage for a rejected attempt", async () => {
  const usage = createModelUsageRecorder();
  let calls = 0;
  await usage.run(() =>
    performModelRequest({
      ...request,
      fetchImpl: (_url, init) => {
        expect(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
        ).toMatchObject({
          stream_options: { include_usage: true },
        });
        return Promise.resolve(
          ++calls === 1
            ? new Response("busy", { status: 429 })
            : reply(100, 60),
        );
      },
    }),
  );
  expect(usage.snapshot()).toEqual({
    calls: 2,
    unreportedCalls: 1,
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 60,
    reasoningTokens: 0,
    estimated: {
      calls: 1,
      inputTokens: 4,
      outputTokens: 0,
      method: "utf8_bytes_div_4_visible_only",
    },
  });
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const sse = (...events: unknown[]) =>
  new Response(
    events
      .map(
        (event) =>
          `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const numbers = {
  input_tokens: 120,
  output_tokens: 40,
  total_tokens: 160,
  input_tokens_details: { cached_tokens: 80 },
  output_tokens_details: { reasoning_tokens: 25 },
};
const client = () =>
  createOpenAiCompatibleJobFinderAiClient({
    baseUrl: "https://model.example.test/v1",
    apiKey: "SECRET_KEY_SENTINEL",
    model: "synthetic-reasoner",
    apiMode: "responses",
    maxAttempts: 1,
  });
const tools = [
  {
    type: "function" as const,
    function: {
      name: "report_question_kinds",
      description: "Synthetic question reading",
      parameters: { type: "object" as const, properties: {} },
    },
  },
];

test.each([false, true])(
  "a rejected classification preserves the provider's usage through the real client (stream: %s)",
  async (stream) => {
    const scope = createModelUsageRecorder(),
      events: ModelRequestUsage[] = [];
    const payload = {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: numbers,
      output: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          stream
            ? sse({ type: "response.incomplete", response: payload })
            : json(payload),
        ),
      ),
    );
    await expect(
      scope.run(() =>
        client().chatWithTools(
          [{ role: "user", content: "PRIVATE_PROMPT_SENTINEL" }],
          tools,
          {
            reasoningTask: "apply",
            onRequestUsage: (usage) => events.push(usage),
          },
        ),
      ),
    ).rejects.toThrow("incomplete");
    expect(ModelUsageTotalsSchema.parse(scope.snapshot())).toEqual({
      calls: 1,
      unreportedCalls: 0,
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 80,
      reasoningTokens: 25,
    });
    expect(events).toMatchObject([
      {
        provider: "https://model.example.test",
        model: "synthetic-reasoner",
        purpose: "apply:report_question_kinds",
        outcome: "failed",
        httpStatus: 200,
        providerTotalTokens: 160,
      },
    ]);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toMatch(
      /PRIVATE_PROMPT_SENTINEL|SECRET_KEY_SENTINEL/,
    );
  },
);

test("a truncated Chat answer still collects the later usage chunk, then refuses the answer", async () => {
  const scope = createModelUsageRecorder();
  await expect(
    scope.run(() =>
      performModelRequest({
        ...request,
        maxAttempts: 1,
        fetchImpl: () =>
          Promise.resolve(
            sse(
              {
                choices: [
                  { delta: { content: "Partial" }, finish_reason: "length" },
                ],
              },
              {
                choices: [],
                usage: { prompt_tokens: 75, completion_tokens: 30 },
              },
              "[DONE]",
            ),
          ),
      }),
    ),
  ).rejects.toThrow("incomplete");
  expect(scope.snapshot()).toMatchObject({
    calls: 1,
    unreportedCalls: 0,
    inputTokens: 75,
    outputTokens: 30,
  });
  expect(scope.snapshot().estimated).toBeUndefined();
});

test.each(["responses", "chat_completions"] as const)(
  "successful %s output without usage has a separate, visible-only estimate",
  async (apiMode) => {
    const scope = createModelUsageRecorder(),
      events: ModelRequestUsage[] = [];
    const body = {
      model: "synthetic-model",
      messages: [
        { role: "user", content: "Private input that must not be logged" },
      ],
    };
    const payload =
      apiMode === "responses"
        ? { status: "completed", output_text: "Done" }
        : {
            choices: [{ message: { content: "Done" }, finish_reason: "stop" }],
          };
    const result = await scope.run(() =>
      performModelRequest({
        ...request,
        body,
        apiMode,
        purpose: "synthetic_read",
        onUsage: (usage) => events.push(usage),
        fetchImpl: () => Promise.resolve(json(payload)),
      }),
    );
    expect(result.choices?.[0]?.message?.content).toBe("Done");
    const total = scope.snapshot();
    expect(total).toMatchObject({
      calls: 1,
      unreportedCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      estimated: {
        calls: 1,
        outputTokens: 1,
        method: "utf8_bytes_div_4_visible_only",
      },
    });
    expect(total.estimated?.inputTokens).toBe(
      Math.ceil(
        Buffer.byteLength(JSON.stringify({ messages: body.messages })) / 4,
      ),
    );
    expect(events[0]?.outcome).toBe("completed");
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      body.messages[0]?.content,
    );
  },
);

test("a network failure and its successful retry are each counted once, without mixing estimated and reported tokens", async () => {
  const scope = createModelUsageRecorder(),
    events: ModelRequestUsage[] = [];
  let attempts = 0;
  await scope.run(() =>
    performModelRequest({
      ...request,
      onUsage: (usage) => events.push(usage),
      fetchImpl: () =>
        ++attempts === 1
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve(reply(100, 60)),
    }),
  );
  expect(scope.snapshot()).toMatchObject({
    calls: 2,
    unreportedCalls: 1,
    inputTokens: 100,
    outputTokens: 10,
    estimated: { calls: 1, inputTokens: 4, outputTokens: 0 },
  });
  expect(events).toMatchObject([
    { attempt: 0, outcome: "failed", failureKind: "network" },
    { attempt: 1, outcome: "completed", inputTokens: 100 },
  ]);
  expect(new Set(events.map((event) => event.requestId)).size).toBe(2);
});

test("an aborted stream keeps the request and partial-output estimate", async () => {
  const scope = createModelUsageRecorder(),
    events: ModelRequestUsage[] = [];
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(writer) {
      writer.enqueue(
        new TextEncoder().encode(
          'data: {"type":"response.output_text.delta","delta":"Work"}\n\n',
        ),
      );
    },
  });
  await expect(
    scope.run(() =>
      performModelRequest({
        ...request,
        apiMode: "responses",
        signal: controller.signal,
        onUsage: (usage) => events.push(usage),
        fetchImpl: () =>
          Promise.resolve(
            new Response(body, {
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        onStreamEvent: (event) => {
          if (event.type === "text_delta") controller.abort();
        },
      }),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(scope.snapshot()).toMatchObject({
    calls: 1,
    unreportedCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    estimated: { calls: 1, inputTokens: 4, outputTokens: 1 },
  });
  expect(events).toMatchObject([
    { outcome: "cancelled", failureKind: "cancelled", httpStatus: 200 },
  ]);
});

test("malformed output cannot discard a valid usage object", async () => {
  const scope = createModelUsageRecorder();
  await expect(
    scope.run(() =>
      performModelRequest({
        ...request,
        apiMode: "responses",
        maxAttempts: 1,
        fetchImpl: () =>
          Promise.resolve(
            json({ status: "completed", output: "malformed", usage: numbers }),
          ),
      }),
    ),
  ).rejects.toThrow();
  expect(scope.snapshot()).toMatchObject({
    calls: 1,
    unreportedCalls: 0,
    inputTokens: 120,
    outputTokens: 40,
    cachedInputTokens: 80,
  });
});

test("explicit cache hit and miss counters remain provider numbers", async () => {
  const scope = createModelUsageRecorder();
  await scope.run(() =>
    performModelRequest({
      ...request,
      fetchImpl: () =>
        Promise.resolve(
          json({
            choices: [{ message: { content: "Done" } }],
            usage: {
              prompt_cache_hit_tokens: 60,
              prompt_cache_miss_tokens: 40,
              completion_tokens: 10,
            },
          }),
        ),
    }),
  );
  expect(scope.snapshot()).toMatchObject({
    calls: 1,
    unreportedCalls: 0,
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 60,
  });
  expect(scope.snapshot().estimated).toBeUndefined();
});

test("partial usage preserves real numbers, zero usage is real, and observer errors never trigger another request", async () => {
  const scope = createModelUsageRecorder();
  const result = await scope.run(() =>
    performModelRequest({
      ...request,
      onUsage: () => {
        throw new Error("Observer failed");
      },
      fetchImpl: () =>
        Promise.resolve(
          json({
            choices: [{ message: { content: "Done" } }],
            usage: { prompt_tokens: 50 },
          }),
        ),
    }),
  );
  expect(result.choices?.[0]?.message?.content).toBe("Done");
  expect(scope.snapshot()).toMatchObject({
    calls: 1,
    inputTokens: 50,
    outputTokens: 0,
    estimated: { calls: 1, inputTokens: 0, outputTokens: 1 },
  });
  const zero = createModelUsageRecorder();
  await zero.run(() =>
    performModelRequest({
      ...request,
      fetchImpl: () => Promise.resolve(reply(0, 0)),
    }),
  );
  expect(zero.snapshot()).toMatchObject({
    calls: 1,
    inputTokens: 0,
    outputTokens: 10,
    unreportedCalls: 0,
  });
  expect(zero.snapshot().estimated).toBeUndefined();
});
test("concurrent application scopes never charge another application's requests", async () => {
  const a = createModelUsageRecorder(),
    b = createModelUsageRecorder();
  await Promise.all([
    a.run(() =>
      performModelRequest({
        ...request,
        fetchImpl: () => Promise.resolve(reply(100, 60)),
      }),
    ),
    b.run(() =>
      performModelRequest({
        ...request,
        fetchImpl: () => Promise.resolve(reply(500, 400)),
      }),
    ),
  ]);
  expect(a.snapshot()).toMatchObject({
    calls: 1,
    inputTokens: 100,
    cachedInputTokens: 60,
    unreportedCalls: 0,
  });
  expect(b.snapshot()).toMatchObject({
    calls: 1,
    inputTokens: 500,
    cachedInputTokens: 400,
    unreportedCalls: 0,
  });
});
