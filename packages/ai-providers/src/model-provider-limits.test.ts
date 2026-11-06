import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { performModelRequest } from "./model-request-transport";
import { withModelProviderProgress } from "./model-request-events";
import { runAgentLoop, runModelTurn } from "@nestor/agent-runtime";
import { createOpenAiCompatibleJobFinderAiClient } from "./openai-compatible";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const complete = () =>
  json({
    choices: [{ message: { content: "Complete" }, finish_reason: "stop" }],
  });
const input = {
  url: "https://model.example/v1/chat/completions",
  headers: { Authorization: "Bearer synthetic" },
  body: { model: "synthetic", messages: [] },
  apiMode: "chat_completions" as const,
  retryBaseDelayMs: 1,
};

test("a gateway Input too long 400 is recovered with exact readable parts by the agent runtime", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string")
        throw Error("Expected a JSON request body");
      requests.push(init.body);
      return Promise.resolve(
        requests.length === 1
          ? json(
              {
                error: {
                  type: "invalid_request_error",
                  message:
                    "Upstream request failed: [invalid_request_error] Input too long: model limit 1048576 tokens, requested 1603421 tokens.",
                },
              },
              400,
            )
          : json({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: "finish-once",
                        type: "function",
                        function: { name: "finish", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
      );
    }),
  );
  const client = createOpenAiCompatibleJobFinderAiClient({
    baseUrl: "https://model.example/v1",
    model: "synthetic",
    apiKey: "synthetic",
  });
  const execute = vi.fn(() =>
    Promise.resolve({
      kind: "finish" as const,
      finish: {
        reason: "Complete",
        stuck: false,
        needsPerson: false,
        data: {},
      },
    }),
  );
  const text =
    "Visible synthetic page fact. ".repeat(3000) + "Last visible fact.";
  const result = await runAgentLoop({
    model: { chatWithTools: client.chatWithTools.bind(client) },
    messages: [{ role: "user", content: text }],
    subjectLabel: "synthetic page",
    compactionMaxChars: 1_000_000,
    tools: [
      {
        definition: {
          type: "function",
          function: {
            name: "finish",
            description: "Finish",
            parameters: { type: "object", properties: {} },
          },
        },
        execute,
      },
    ],
  });
  expect(result.ending).toBe("finished");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toContain("Last visible fact.");
  expect(requests[1]).toContain("Exact content in ordered parts");
  expect(requests[1]).toContain("read_context_part");
  expect(requests[1]!.length).toBeLessThan(requests[0]!.length);
  expect(execute).toHaveBeenCalledOnce();
});

test("ten consecutive 429s respect Retry-After and finish on the eleventh call", async () => {
  const moments: number[] = [];
  const fetchImpl = vi.fn(async () => {
    moments.push(Date.now());
    return Promise.resolve(
      moments.length <= 10
        ? json({ error: { message: "Slow down" } }, 429, {
            "Retry-After": "30",
          })
        : complete(),
    );
  });
  const progress = vi.fn();
  const pending = withModelProviderProgress(progress, () =>
    performModelRequest({ ...input, fetchImpl }),
  );
  await vi.advanceTimersByTimeAsync(299_999);
  expect(fetchImpl).toHaveBeenCalledTimes(10);
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).choices?.[0]?.message?.content).toBe("Complete");
  expect(moments.slice(1).map((at, i) => at - moments[i]!)).toEqual(
    Array(10).fill(30_000),
  );
  expect(progress.mock.calls.at(-1)).toEqual([false]);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([200, 429, 503])(
  "%i capacity error waits the body's full 30 seconds",
  async (status) => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() =>
        json(
          {
            error: {
              message:
                "Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)",
            },
          },
          status,
        ),
      )
      .mockImplementation(complete);
    const pending = performModelRequest({ ...input, fetchImpl });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).choices?.[0]?.message?.content).toBe("Complete");
  },
);

test("Retry-After takes precedence over a different body advice and the exponential cap", async () => {
  const fetchImpl = vi
    .fn()
    .mockImplementationOnce(() =>
      json(
        { error: { message: "at capacity; retry shortly (after 30 s)" } },
        429,
        { "Retry-After": "240" },
      ),
    )
    .mockImplementation(complete);
  // The enclosing turn must not mistake this intentional wait for 180s silence.
  const pending = runModelTurn(
    (options) => performModelRequest({ ...input, ...options, fetchImpl }),
    {},
  );
  await vi.advanceTimersByTimeAsync(239_999);
  expect(fetchImpl).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).choices?.[0]?.message?.content).toBe("Complete");
});

test("a request quota that resets shortly is a provider wait; insufficient account quota is permanent", async () => {
  const fetchImpl = vi
    .fn()
    .mockImplementationOnce(() =>
      json(
        {
          error: { message: "Quota exceeded: rate limit; retry in 30 seconds" },
        },
        429,
      ),
    )
    .mockImplementation(complete);
  const pending = performModelRequest({ ...input, fetchImpl });
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await pending).choices?.[0]?.message?.content).toBe("Complete");
  const rejected = vi.fn(() =>
    Promise.resolve(
      json(
        {
          error: {
            code: "insufficient_quota",
            message:
              "You exceeded your current quota, check your plan and billing details.",
          },
        },
        429,
      ),
    ),
  );
  await expect(
    performModelRequest({ ...input, fetchImpl: rejected }),
  ).rejects.toThrow("check your plan and billing details");
  expect(rejected).toHaveBeenCalledOnce();
});

test("a silent stream reconnects more than once and then completes", async () => {
  const cancelled = vi.fn();
  let calls = 0;
  const fetchImpl = vi.fn(() =>
    Promise.resolve(
      ++calls <= 3
        ? new Response(new ReadableStream({ cancel: cancelled }), {
            headers: { "content-type": "text/event-stream" },
          })
        : complete(),
    ),
  );
  const pending = performModelRequest({
    ...input,
    idleTimeoutMs: 50,
    retryBaseDelayMs: 0,
    fetchImpl,
  });
  await vi.advanceTimersByTimeAsync(150);
  expect((await pending).choices?.[0]?.message?.content).toBe("Complete");
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect(cancelled).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

test("Stop cancels a provider wait immediately and clears its progress", async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn(() =>
    Promise.resolve(
      json({ error: "slow down" }, 429, { "Retry-After": "3600" }),
    ),
  );
  const progress = vi.fn();
  const pending = withModelProviderProgress(progress, () =>
    performModelRequest({ ...input, fetchImpl, signal: controller.signal }),
  );
  const stopped = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  expect(progress).toHaveBeenLastCalledWith(true);
  controller.abort();
  await stopped;
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(progress).toHaveBeenLastCalledWith(false);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  [401, "API key rejected"],
  [400, "invalid parameter"],
  [429, "insufficient_quota: your plan is used up"],
  [200, "Your quota is exhausted; try again next month"],
] as const)(
  "%i permanent account/request error fails immediately: %s",
  async (status, message) => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json({ error: { message } }, status)),
    );
    await expect(performModelRequest({ ...input, fetchImpl })).rejects.toThrow(
      message,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("concurrent and newly arriving calls share an extended route cooldown; other routes proceed", async () => {
  let second!: (response: Response) => void;
  const times: number[] = [];
  const fetchImpl = vi.fn(async () => {
    times.push(Date.now());
    if (times.length === 1)
      return Promise.resolve(
        json({ error: "slow down" }, 429, { "Retry-After": "30" }),
      );
    if (times.length === 2)
      return new Promise<Response>((resolve) => {
        second = resolve;
      });
    return Promise.resolve(complete());
  });
  const start = Date.now();
  const a = performModelRequest({ ...input, fetchImpl });
  const b = performModelRequest({ ...input, fetchImpl });
  await vi.advanceTimersByTimeAsync(1000);
  const c = performModelRequest({ ...input, fetchImpl });
  const other = performModelRequest({
    ...input,
    body: { model: "other" },
    fetchImpl,
  });
  await other;
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  second(json({ error: "slow down" }, 429, { "Retry-After": "30" }));
  await vi.advanceTimersByTimeAsync(29_999);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all([a, b, c]);
  expect(times.slice(3)).toEqual([
    start + 31_000,
    start + 31_000,
    start + 31_000,
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test("an apply model turn stays running through ten 429s and finishes once, without replaying a tool", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        ++calls <= 10
          ? json({ error: "slow down" }, 429, { "Retry-After": "30" })
          : json({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: "finish-once",
                        type: "function",
                        function: { name: "finish", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
      ),
    ),
  );
  const client = createOpenAiCompatibleJobFinderAiClient({
    baseUrl: "https://model.example/v1",
    model: "synthetic",
    apiKey: "synthetic",
  });
  const execute = vi.fn(async () =>
    Promise.resolve({
      kind: "finish" as const,
      finish: {
        reason: "Complete",
        stuck: false,
        needsPerson: false,
        data: {},
      },
    }),
  );
  const notes: string[] = [];
  let finished = false;
  const pending = runAgentLoop({
    model: { chatWithTools: client.chatWithTools.bind(client) },
    messages: [],
    tools: [
      {
        definition: {
          type: "function",
          function: {
            name: "finish",
            description: "Finish",
            parameters: { type: "object", properties: {} },
          },
        },
        execute,
      },
    ],
    subjectLabel: "the application",
    onStep: ({ note }) => {
      notes.push(note);
    },
  }).then((value) => {
    finished = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(299_999);
  expect(finished).toBe(false);
  expect(notes).toContain("waiting for the AI provider");
  expect(execute).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).ending).toBe("finished");
  expect(execute).toHaveBeenCalledOnce();
});
