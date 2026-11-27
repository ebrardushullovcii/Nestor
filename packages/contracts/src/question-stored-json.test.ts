import { expect, test } from "vitest";
import { ApplicationQuestionAskReasonSchema } from "./application-question-reason";
import { SubmissionBrowserActionDiagnosticsSchema } from "./application-authority";
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

test("the site's text in pickers, form steps, ask reasons and send diagnostics is stored whole", () => {
  const long = (word: string) => `${word} `.repeat(800).trim();
  const options = Array.from({ length: 900 }, (_, i) => `University ${i}`);
  const result = ApplyExecutionResultSchema.parse({
    state: "submitted",
    summary: "Sent",
    detail: "Sent on the employer's site",
    submittedAt: "2026-11-27T03:34:00.000Z",
    outcome: null,
    nextActionLabel: "Track it",
    pickerAttempts: [
      {
        question: long("Which school?"),
        tried: Array.from({ length: 30 }, (_, i) => `Try ${i}`),
        notOffered: [long("Option")],
        offeredOptions: options,
      },
    ],
    formPath: [
      {
        from: `https://jobs.example.test/${"a".repeat(3000)}`,
        tool: "click",
        label: long("Apply"),
        href: `https://jobs.example.test/?q=${"b".repeat(5000)}`,
      },
    ],
  });
  expect(result.pickerAttempts?.[0]?.offeredOptions).toHaveLength(900);
  expect(
    ApplicationQuestionAskReasonSchema.parse({
      kind: "no_source",
      detail: long("The form asks"),
      selectedDocument: {
        kind: "resume",
        label: long("Upload"),
        fileName: "resume.pdf",
      },
    }).detail.length,
  ).toBeGreaterThan(4000);
  expect(
    SubmissionBrowserActionDiagnosticsSchema.parse({
      reason: "model_observed_outcome",
      detail: long("Please correct the errors"),
    }).detail!.length,
  ).toBeGreaterThan(500);
});
