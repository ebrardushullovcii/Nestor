import { expect, test } from "vitest";
import { createModelUsageRecorder } from "./model-usage-scope";
import { performModelRequest } from "./model-request-transport";

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
        expect(JSON.parse(String(init?.body))).toMatchObject({
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
  });
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
