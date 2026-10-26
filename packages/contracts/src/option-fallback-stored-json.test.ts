import { expect, test } from "vitest";
import { CandidateReusableAnswerSchema } from "./profile";
import { SavedFormAnswerSummarySchema } from "./applications";
import { ApplicationAnswerDependenciesSchema } from "./application-answer-dependencies";

test("old saved-answer JSON reads without an optional picker rule", () => {
  expect(
    CandidateReusableAnswerSchema.parse({
      id: "saved",
      kind: "other",
      label: "Country",
      question: "Country",
      answer: "Primary territory",
    }).optionFallback,
  ).toBeNull();
  expect(
    SavedFormAnswerSummarySchema.parse({
      id: 1,
      key: "country",
      kind: "other",
      label: "Country",
      needsConfirmation: false,
      prompt: "Country",
      preview: "Primary territory",
      scope: { country: "", siteOrigin: "" },
      input: "text",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }).optionFallback,
  ).toBeNull();
});

test("old dependency JSON reads without picker rules in either answer source", () => {
  const parsed = ApplicationAnswerDependenciesSchema.parse({
    form: [
      {
        key: "country",
        prompt: "Country",
        reusePrompt: true,
        answer: "Primary territory",
      },
    ],
    context: [
      {
        id: 1,
        kind: "other",
        answer: "Primary territory",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ],
  });
  expect(parsed.form[0]?.optionFallback).toBeNull();
  expect(parsed.context[0]?.optionFallback).toBeNull();
});
