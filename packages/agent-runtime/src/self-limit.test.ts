import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { runAgentTask, type AgentTaskRunOptions } from "./runtime";
import { elideOldToolOutputs, trimOldestExchanges } from "./context-budget";
import { AgentTaskResultStore } from "./result-store";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const base = (): AgentTaskRunOptions<object, object> => ({
  taskId: "synthetic",
  capability: "test",
  systemPrompt: "test",
  state: {},
  initialDraft: {},
  model: { chat: () => Promise.resolve({ content: "thinking" }) },
  tools: [],
  validate: () => [],
  buildContext: () => ({}),
});
function events(log: ReturnType<typeof vi.spyOn>) {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === "string" && line.startsWith("[self_limit_hit] ")
      ? [JSON.parse(line.slice(17)) as { limit: string; where: string }]
      : [],
  );
}
test.each([
  ["provider_calls", { providerCallBudget: 1 }],
  ["no_progress", { noProgressLimit: 1 }],
  ["emergency_ceiling", { emergencyCeiling: 4, noProgressLimit: 100 }],
] as const)("reports the reached %s boundary", async (limit, options) => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await runAgentTask({ ...base(), ...options });
  expect(events(log).some((hit) => hit.limit === limit)).toBe(true);
});
test("reports elapsed work and a model turn deadline, but not person cancellation", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await runAgentTask({
    ...base(),
    timeBudgetMs: 1000,
    model: {
      chat: () => {
        vi.setSystemTime(Date.now() + 1100);
        return Promise.resolve({});
      },
    },
  });
  expect(events(log).some((hit) => hit.limit === "task_time")).toBe(true);
  log.mockClear();
  const pending = runAgentTask({
    ...base(),
    modelTurnTimeoutMs: 10,
    model: { chat: () => new Promise(() => {}) },
  });
  await vi.advanceTimersByTimeAsync(11);
  expect((await pending).receipt.stopReason).toBe("time_budget");
  expect(events(log).some((hit) => hit.limit === "model_turn_time")).toBe(true);
  log.mockClear();
  await runAgentTask({ ...base(), signal: AbortSignal.abort() });
  expect(events(log)).toEqual([]);
});
test("reports exhausted transient provider retries", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const pending = runAgentTask({
    ...base(),
    model: {
      chat: () => {
        return Promise.reject(Error("network disconnected"));
      },
    },
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await pending).toBeInstanceOf(Error);
  expect(events(log).some((hit) => hit.limit === "provider_retries")).toBe(
    true,
  );
});
test.each([false, true])(
  "only reports a validator bound the model was not given (advertised=%s)",
  async (advertised) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAgentTask({
      ...base(),
      noProgressLimit: 1,
      model: {
        chat: () =>
          Promise.resolve({
            toolCalls: [
              {
                id: "x",
                type: "function",
                function: { name: "write", arguments: '{"text":"too long"}' },
              },
            ],
          }),
      },
      tools: [
        {
          name: "write",
          description: "write",
          permission: "draft_write",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", ...(advertised ? { maxLength: 2 } : {}) },
            },
          },
          inputSchema: z.object({ text: z.string().max(2) }),
          execute: () => ({ summary: "unused" }),
        },
      ],
    });
    expect(
      events(log).some((hit) => hit.limit === "unadvertised_validator_bound"),
    ).toBe(!advertised);
  },
);
test("reports history/evidence omitted by context maintenance", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const messages = [
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [
        {
          id: "a",
          type: "function" as const,
          function: { name: "read", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool" as const,
      toolCallId: "a",
      content: "evidence".repeat(1000),
    },
    { role: "user" as const, content: "next" },
    { role: "tool" as const, toolCallId: "b", content: "current" },
  ];
  expect(elideOldToolOutputs(messages, { keepRecent: 1 }).elided).toBe(1);
  expect(
    trimOldestExchanges(messages, { budgetTokens: 100, keepRecentMessages: 2 })
      .dropped.length,
  ).toBeGreaterThan(0);
  expect(events(log).map((hit) => hit.limit)).toEqual([
    "old_tool_outputs",
    "old_exchanges",
  ]);
});

test.each([
  [
    "minimum",
    z.object({ text: z.string().min(10) }),
    { type: "object", properties: { text: { type: "string" } } },
    { text: "ok" },
    true,
  ],
  [
    "enum",
    z.object({ text: z.enum(["one"]) }),
    {
      type: "object",
      properties: { text: { type: "string", enum: ["one", "two"] } },
    },
    { text: "two" },
    true,
  ],
  [
    "pattern",
    z.object({ text: z.string().regex(/^one$/u) }),
    {
      type: "object",
      properties: { text: { type: "string", pattern: "^[a-z]+$" } },
    },
    { text: "two" },
    true,
  ],
  [
    "keys",
    z.object({ text: z.string() }).strict(),
    { type: "object", properties: { text: { type: "string" } } },
    { text: "ok", extra: true },
    true,
  ],
  [
    "keys",
    z.object({ text: z.string() }).strict(),
    {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false,
    },
    { text: "ok", extra: true },
    false,
  ],
] as const)(
  "detects hidden validator %s while preserving advertised restrictions",
  async (kind, inputSchema, parameters, args, expected) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAgentTask({
      ...base(),
      noProgressLimit: 1,
      model: {
        chat: () =>
          Promise.resolve({
            toolCalls: [
              {
                id: "x",
                type: "function",
                function: { name: "write", arguments: JSON.stringify(args) },
              },
            ],
          }),
      },
      tools: [
        {
          name: "write",
          description: "Write",
          permission: "draft_write",
          parameters,
          inputSchema,
          execute: () => ({ summary: "unused" }),
        },
      ],
    });
    expect(
      events(log).some((hit) =>
        hit.limit.startsWith("unadvertised_validator_"),
      ),
    ).toBe(expected);
  },
);

test("task history and result-read clamps report at their real boundaries", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = new AgentTaskResultStore();
  const result = store.put({
    summary: "Synthetic rows",
    value: Array.from({ length: 100 }, (_, i) => i),
  });
  expect(
    store.read({ handle: result.reference.handle, limit: 100 })?.items,
  ).toHaveLength(50);
  let turn = 0;
  const resultOfTask = await runAgentTask({
    ...base(),
    model: {
      chat: () =>
        Promise.resolve({
          toolCalls: [
            {
              id: `turn${++turn}`,
              type: "function",
              function: {
                name: turn >= 12 ? "finish_task" : "read",
                arguments: "{}",
              },
            },
          ],
        }),
    },
    tools: [
      {
        name: "read",
        description: "Read",
        permission: "read",
        parameters: { type: "object" },
        inputSchema: z.object({}),
        execute: () => ({ summary: "Read", progressMade: true }),
      },
      {
        name: "finish_task",
        description: "Finish",
        permission: "read",
        parameters: { type: "object" },
        inputSchema: z.object({}),
        execute: () => ({ summary: "Done", finish: true }),
      },
    ],
  });
  expect(resultOfTask.receipt.stopReason).toBe("completed");
  expect(events(log).some((hit) => hit.limit === "result_read_items")).toBe(
    true,
  );
  expect(
    events(log).some((hit) => hit.where === "agent-runtime/recent_messages"),
  ).toBe(true);
});
