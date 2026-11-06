import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgentLoop, type AgentLoopOptions } from "./agent-loop";

afterEach(() => vi.unstubAllEnvs());
const fixture = (): AgentLoopOptions => ({
  subjectLabel: "replica",
  now: () => new Date(0),
  messages: [
    { role: "system", content: "Exact system prompt" },
    { role: "user", content: "Do this" },
  ],
  model: {
    chatWithTools: (messages) => {
      expect(messages[0]?.content).toBe("Exact system prompt");
      return Promise.resolve({
        content: "",
        toolCalls: [
          {
            id: "finish-1",
            type: "function",
            function: { name: "finish", arguments: "{}" },
          },
        ],
      });
    },
  },
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
      execute: () =>
        Promise.resolve({
          kind: "finish",
          finish: {
            reason: "done",
            stuck: false,
            needsPerson: false,
            data: {},
          },
        }),
    },
  ],
});

test("optional observers cannot change requests, results, failures or the untraced transcript", async () => {
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", "");
  const baseline = await runAgentLoop(fixture());
  let calls = 0;
  const observed = await runAgentLoop({
    ...fixture(),
    onModelTurn: (event) => {
      calls++;
      const request = event.request as { messages: { content: string }[] };
      request.messages[0]!.content = "observer mutation";
      throw Error("Observer failed");
    },
    onToolCall: (event) => {
      expect(event.result).toBe("Finished.");
      throw Error("Observer failed");
    },
  });
  expect(calls).toBe(1);
  expect(JSON.stringify(observed)).toBe(JSON.stringify(baseline));
});

test("env tracing records exact runtime requests and tool results without private continuation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nestor-trace-test-"));
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
  try {
    const options = fixture();
    options.messages.push({
      role: "assistant",
      content: "visible",
      continuation: {
        kind: "reasoning_content",
        route: "test",
        text: "PRIVATE_REASONING",
      },
    });
    await runAgentLoop(options);
    const raw = readdirSync(dir)
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("");
    type Recorded = {
      event: string;
      request?: { messages: { role: string; content: string }[] };
      result?: string;
    };
    const events = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Recorded);
    expect(
      events.find((e) => e.event === "model_turn")?.request?.messages[0]
        ?.content,
    ).toBe("Exact system prompt");
    expect(events.find((e) => e.event === "tool_call")?.result).toBe(
      "Finished.",
    );
    expect(raw).not.toContain("PRIVATE_REASONING");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
