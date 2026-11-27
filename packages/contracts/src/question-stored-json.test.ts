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

test("a form's long question and step text are stored whole", () => {
  const prompt = `Tell us about a project you led. ${"Details. ".repeat(400)}`;
  const step = `Application questions. ${"Context. ".repeat(900)}`;
  const result = ApplyExecutionResultSchema.parse({
    state: "submitted",
    summary: "Sent",
    detail: "Sent on the employer's site",
    submittedAt: "2026-11-27T03:34:00.000Z",
    outcome: null,
    nextActionLabel: "Track it",
    questionContexts: [{ prompt, step }],
  });
  expect(prompt.length).toBeGreaterThan(2000);
  expect(result.questionContexts).toEqual([{ prompt, step }]);
});
