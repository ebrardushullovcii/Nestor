import { expect, it, vi } from "vitest";
import {
  createAssistantRepository,
  type AssistantTranscriptItem,
} from "@nestor/db";
import {
  createTokenCalibrator,
  runConversationTurn,
  type AgentLoopMessage,
} from "@nestor/agent-runtime";
import { assembleModelInput, completedTurnContext } from "./context-assembly";

it("recovers an empty long-chat reply without losing authorization or replaying a completed write", async () => {
  const repository = createAssistantRepository({ filePath: ":memory:" });
  const old: AgentLoopMessage[] = [
    {
      role: "user",
      content: "Fill both; do not send.\n<context>stale screen</context>",
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "old",
          type: "function",
          function: { name: "send_application", arguments: '{"id":1}' },
        },
      ],
      continuation: {
        kind: "reasoning_content",
        route: "test",
        text: "private speculation ".repeat(2000),
      },
    },
    {
      role: "tool",
      toolCallId: "old",
      content: `Sending was not confirmed.\n${"old page data ".repeat(5000)}`,
    },
    { role: "assistant", content: "The form remains ready; no receipt." },
  ];
  await repository.appendTranscript("chat", "old", old);
  await repository.appendTranscript("chat", "current", [
    {
      role: "user",
      content: "Send the ready Lead application now. I authorize this send.",
    },
  ]);
  const seen: AgentLoopMessage[][] = [];
  let recover = false;
  const writes = vi.fn(() =>
    Promise.resolve({ kind: "ok" as const, content: "Saved answer 7." }),
  );
  const result = await runConversationTurn({
    model: {
      chatWithTools: (messages) => {
        seen.push(messages);
        if (seen.length === 1)
          return Promise.resolve({
            toolCalls: [
              {
                id: "save",
                type: "function",
                function: { name: "save", arguments: "{}" },
              },
            ],
          });
        if (seen.length === 2) return Promise.resolve({});
        return Promise.resolve({
          content:
            "Current request recovered; checking the application before sending.",
        });
      },
    },
    tools: [
      {
        definition: {
          type: "function",
          function: {
            name: "save",
            description: "save",
            parameters: { type: "object", properties: {} },
          },
        },
        label: () => "Save",
        execute: writes,
      },
    ],
    onEmptyReply: () => {
      recover = true;
    },
    assembleMessages: (turnMessages) =>
      assembleModelInput({
        repository,
        conversationId: "chat",
        activeTurnId: "current",
        recoverEmptyReply: recover,
        systemPrompt: "system",
        turnMessages,
        contextWindowTokens: 64000,
        maxOutputTokens: 1000,
        toolSchemaTokens: 0,
        calibrator: createTokenCalibrator(),
        summarize: null,
        onCompacted: () => Promise.resolve(),
        now: () => new Date().toISOString(),
        createId: () => "checkpoint",
      }),
  });
  expect(result.ending).toBe("replied");
  expect(writes).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(seen[2])).toContain("I authorize this send");
  expect(JSON.stringify(seen[2])).toContain("Saved answer 7");
  expect(JSON.stringify(seen[2])).not.toContain("old page data");
  expect(JSON.stringify(seen[2])).not.toContain("private speculation");
  expect(JSON.stringify(seen[2])).not.toContain("Earlier action receipts");
  expect(
    (await repository.listTranscript("chat", {})).map((row) => row.message),
  ).toContainEqual(old[2]);
});

it("keeps exact prior requests and short receipts while stripping completed private reasoning", () => {
  const items: AssistantTranscriptItem[] = [
    {
      seq: 1,
      turnId: "old",
      createdAt: "now",
      message: { role: "user", content: "Open job 12<context>stale</context>" },
    },
    {
      seq: 2,
      turnId: "old",
      createdAt: "now",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "a",
            type: "function",
            function: { name: "open_application", arguments: '{"id":12}' },
          },
        ],
        continuation: {
          kind: "reasoning_content",
          route: "test",
          text: "private",
        },
      },
    },
    {
      seq: 3,
      turnId: "old",
      createdAt: "now",
      message: {
        role: "tool",
        toolCallId: "a",
        content: "Opened application 12.\nfull old page",
      },
    },
  ];
  const context = JSON.stringify(completedTurnContext(items, "current", false));
  expect(context).toContain("Open job 12");
  expect(context).toContain("Opened application 12");
  expect(context).not.toMatch(/private|stale|full old page/);
});
