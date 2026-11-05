import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import {
  AnswerMatchUnavailableError,
  matchApplicationAnswer,
} from "./answer-match";

const reply = (sourceId: string | null, answer: string | null) => ({
  toolCalls: [
    {
      id: "match",
      type: "function" as const,
      function: {
        name: "match_application_answer",
        arguments: JSON.stringify({ sourceId, answer }),
      },
    },
  ],
});
const input = (chatWithTools: LLMClient["chatWithTools"]) => ({
  client: { chatWithTools },
  question: "Weekly hours?",
  rejection: null,
  sources: [
    {
      id: "answerLibrary.hours",
      value: "24",
      purpose: "saved" as const,
      country: null,
    },
  ],
});

test.each([
  {},
  reply(null, null),
  {
    toolCalls: [
      {
        id: "partial",
        type: "function" as const,
        function: {
          name: "match_application_answer",
          arguments: '{"sourceId":',
        },
      },
    ],
  },
])(
  "a length-limited reply retries once with room for reasoning before deciding no source (%j)",
  async (truncated) => {
    const client = vi
      .fn<LLMClient["chatWithTools"]>()
      .mockResolvedValueOnce({ ...truncated, finishReason: "length" })
      .mockResolvedValueOnce(reply("answerLibrary.hours", "24"));
    await expect(matchApplicationAnswer(input(client))).resolves.toEqual({
      sourceId: "answerLibrary.hours",
      value: "24",
    });
    expect(client.mock.calls.map((call) => call[2]?.maxOutputTokens)).toEqual([
      4000, 8000,
    ]);
  },
);

test("two output limits are a technical error, never no saved answer", async () => {
  const client = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValue({ finishReason: "length" });
  await expect(matchApplicationAnswer(input(client))).rejects.toMatchObject({
    category: "output_limit",
  });
  expect(client).toHaveBeenCalledTimes(2);
});

test("only an explicit complete no-source decision returns null", async () => {
  await expect(
    matchApplicationAnswer(input(() => Promise.resolve(reply(null, null)))),
  ).resolves.toBeNull();
  await expect(
    matchApplicationAnswer(input(() => Promise.resolve({}))),
  ).rejects.toBeInstanceOf(AnswerMatchUnavailableError);
});
