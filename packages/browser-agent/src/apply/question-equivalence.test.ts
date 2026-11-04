import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { equivalentApplicationQuestions } from "./question-equivalence";
const pairs = [
  {
    id: "same",
    saved: {
      question: "Availability for the scheduled call",
      answer: "Tuesday",
      options: ["Tuesday", "Thursday"],
    },
    waiting: {
      question: "Available day for that call",
      options: ["Thursday", "Tuesday"],
    },
  },
  {
    id: "different",
    saved: {
      question: "Availability for the scheduled call",
      answer: "Tuesday",
      options: ["Tuesday", "Thursday"],
    },
    waiting: {
      question: "Days for regular work",
      options: ["Tuesday", "Thursday"],
    },
  },
];
const response = (comparisons: unknown) => ({
  toolCalls: [
    {
      id: "report",
      type: "function" as const,
      function: {
        name: "report_question_equivalence",
        arguments: JSON.stringify({ comparisons }),
      },
    },
  ],
});
test("complete same-question and different-activity reports keep their exact ids", async () => {
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue(
    response([
      { id: "same", equivalent: true, difference: null },
      { id: "different", equivalent: false, difference: "Different activity." },
    ]),
  );
  expect([
    ...(await equivalentApplicationQuestions({
      client: { chatWithTools },
      pairs,
    })),
  ]).toEqual(["same"]);
  expect(chatWithTools).toHaveBeenCalledOnce();
  expect(chatWithTools.mock.calls[0]?.[2]?.reasoningTask).toBe("claim_check");
});
test("an incomplete comparison gets one complete retry, never a partial reuse", async () => {
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValueOnce(
      response([{ id: "same", equivalent: true, difference: null }]),
    )
    .mockResolvedValueOnce(
      response([
        { id: "same", equivalent: true, difference: null },
        {
          id: "different",
          equivalent: false,
          difference: "Different activity.",
        },
      ]),
    );
  expect([
    ...(await equivalentApplicationQuestions({
      client: { chatWithTools },
      pairs,
    })),
  ]).toEqual(["same"]);
  expect(chatWithTools).toHaveBeenCalledTimes(2);
});
test.each([
  {
    label: "inconsistent",
    comparisons: [
      { id: "same", equivalent: true, difference: "A different condition." },
      { id: "different", equivalent: false, difference: "Different activity." },
    ],
  },
  {
    label: "duplicate",
    comparisons: [
      { id: "same", equivalent: true, difference: null },
      { id: "same", equivalent: true, difference: null },
    ],
  },
  {
    label: "missing",
    comparisons: [{ id: "same", equivalent: true, difference: null }],
  },
])(
  "a $label report stays unavailable after the bound",
  async ({ comparisons }) => {
    const chatWithTools = vi
      .fn<LLMClient["chatWithTools"]>()
      .mockResolvedValue(response(comparisons));
    await expect(
      equivalentApplicationQuestions({ client: { chatWithTools }, pairs }),
    ).rejects.toThrow("could not compare");
    expect(chatWithTools).toHaveBeenCalledTimes(2);
  },
);
