import { expect, test } from "vitest";
import { ApplyExecutionResultSchema } from "./discovery";

test("old stored execution JSON reads without the new question occurrence fields", () => {
  const question = {
    id: "q",
    prompt: "Start date",
    kind: "other",
    answerControlType: "text",
    detectedAt: "2026-01-01T00:00:00.000Z",
  };
  const result = ApplyExecutionResultSchema.parse({
    state: "ready",
    summary: "Prepared",
    detail: "Original stored detail",
    submittedAt: null,
    outcome: null,
    nextActionLabel: "Review the form",
    questions: [question],
  });
  expect(result.questionContexts).toEqual([]);
  expect(result.questions).toMatchObject([
    { ...question, repeatedAtDifferentStep: false },
  ]);
});
