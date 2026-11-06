import { expect, test } from "vitest";
import { createContextHistory, contextMessageChars } from "./context-history";
import type { AgentLoopMessage } from "./agent-loop";
import { runAgentLoop } from "./agent-loop";

test("long conversations append past the old threshold, recover once at the model window and keep the new prefix stable", async () => {
  const window = Math.floor(1_000_000 * 3.6 * 0.8);
  const context = createContextHistory(window);
  const opening: AgentLoopMessage[] = [
    { role: "system", content: "Stable instructions" },
    { role: "user", content: "Stable profile facts" },
  ];
  let messages = [...opening];
  let cuts = 0;
  let removed: AgentLoopMessage[] = [];
  let recoveredPrefix: AgentLoopMessage[] = [];
  for (let turn = 0; turn < 38; turn++) {
    messages = [
      ...messages,
      {
        role: "assistant",
        content: `Turn ${turn}`,
        toolCalls: [
          {
            id: `call${turn}`,
            type: "function",
            function: { name: "look", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: `call${turn}`,
        content: `${turn} ` + "page facts ".repeat(10_000),
      },
    ];
    const before = messages;
    const next = context.compact(messages, opening.length, []);
    if (next !== before) {
      cuts++;
      removed = before.slice(
        opening.length,
        before.indexOf(next[opening.length + 1]!),
      );
      recoveredPrefix = next;
      expect(
        before.reduce(
          (size, message) => size + contextMessageChars(message),
          0,
        ),
      ).toBeGreaterThan(window);
      expect(
        next.reduce((size, message) => size + contextMessageChars(message), 0),
      ).toBeLessThan(window / 2);
    } else if (recoveredPrefix.length)
      expect(next.slice(0, recoveredPrefix.length)).toEqual(recoveredPrefix);
    messages = next;
  }
  expect(cuts).toBe(1);
  expect(messages.slice(0, opening.length)).toEqual(opening);
  const archive = await context.tool.execute('{"archive":1}', { step: 1 });
  expect(archive.kind).toBe("ok");
  if (archive.kind === "ok")
    expect(
      (JSON.parse(archive.content) as { messages: AgentLoopMessage[] })
        .messages,
    ).toEqual(removed);
  const toolIds = messages
    .filter((message) => message.role === "tool")
    .map((message) => message.role === "tool" && message.toolCallId);
  const callIds = messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls?.map((call) => call.id) ?? [])
      : [],
  );
  expect(toolIds).toEqual(callIds);
});

test("the shared loop offers exact archived history through an unchanged tool schema", async () => {
  let turn = 0;
  let read = false;
  let definitions = "";
  const requests: AgentLoopMessage[][] = [];
  const result = await runAgentLoop({
    messages: [{ role: "system", content: "Stable synthetic instructions" }],
    subjectLabel: "synthetic search",
    retainCompactedHistory: true,
    compactionMaxChars: 8_000,
    staleToolResultChars: null,
    model: {
      chatWithTools: (messages, tools) => {
        requests.push(structuredClone(messages));
        if (!definitions) definitions = JSON.stringify(tools);
        expect(JSON.stringify(tools)).toBe(definitions);
        expect(tools.map((tool) => tool.function.name)).toContain(
          "read_context_history",
        );
        const archiveReady = messages.some((message) =>
          message.content.includes("Earlier turns were moved"),
        );
        const name =
          archiveReady && !read
            ? "read_context_history"
            : turn < 14
              ? "look"
              : "finish";
        if (name === "read_context_history") read = true;
        return Promise.resolve({
          toolCalls: [
            {
              id: `call${turn++}`,
              type: "function",
              function: {
                name,
                arguments:
                  name === "read_context_history"
                    ? '{"archive":1,"start":0,"end":2}'
                    : "{}",
              },
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
            name: "look",
            description: "Read synthetic page",
            parameters: { type: "object", properties: {} },
          },
        },
        execute: () =>
          Promise.resolve({
            kind: "ok",
            content: "exact page facts " + "x".repeat(1000),
          }),
      },
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
              reason: "Done",
              stuck: false,
              needsPerson: false,
              data: {},
            },
          }),
      },
    ],
  });
  expect(result.ending).toBe("finished");
  expect(read).toBe(true);
  expect(
    requests.every(
      (messages) => messages[0]?.content === "Stable synthetic instructions",
    ),
  ).toBe(true);
  expect(
    requests.some((messages) =>
      messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.includes('"totalMessages"') &&
          message.content.includes("exact page facts"),
      ),
    ),
  ).toBe(true);
});
