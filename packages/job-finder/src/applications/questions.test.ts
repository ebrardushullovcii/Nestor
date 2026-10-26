import { expect, test } from "vitest";
import {
  cleanFormQuestionPrompt,
  normalizeFormQuestionPrompt,
} from "@nestor/contracts";
import { describeFormQuestion, type FormQuestion } from "./questions";

test("the same question keeps its key across progress counters without discarding scope or group context", () => {
  const field: FormQuestion = {
    prompt: "Are you willing to relocate?",
    kind: "relocation",
    answerControlType: "boolean",
    answerOptions: ["Yes", "No"],
  };
  const place = { id: 1, location: "Fully remote, Worldwide" };
  const plain = describeFormQuestion(field, place).key;
  for (const prefix of [
    "Application",
    "Step 4 of 6",
    "Application — Step 2 of 3",
  ])
    expect(
      describeFormQuestion(
        { ...field, prompt: `${prefix} — ${field.prompt} *` },
        { ...place, id: 2 },
      ).key,
    ).toBe(plain);
  expect(
    describeFormQuestion(field, { ...place, location: "Germany" }).key,
  ).not.toBe(plain);
  expect(normalizeFormQuestionPrompt("Employment — From")).not.toBe(
    normalizeFormQuestionPrompt("Education — From"),
  );
  expect(cleanFormQuestionPrompt("Step 4 of 6: Employment — From")).toBe(
    "Employment — From",
  );
  expect(
    normalizeFormQuestionPrompt(
      cleanFormQuestionPrompt("Step 3 of 6: Marketing consent — I agree"),
    ),
  ).not.toBe(
    normalizeFormQuestionPrompt(
      cleanFormQuestionPrompt("Step 4 of 6: Terms — I agree"),
    ),
  );
  expect(cleanFormQuestionPrompt("Step 4 of 6: Compensation — I agree")).toBe(
    "Compensation — I agree",
  );
});

test.each([
  [
    "Step 2 of 6: Employment — Start date",
    "Step 3 of 6: Education — Start date",
  ],
  [
    "Step 4 of 7: Reference 1 — Email address",
    "Step 5 of 7: Reference 2 — Email address",
  ],
  ["Step 2 of 6: Terms — I agree", "Step 4 of 6: Marketing — I agree"],
])("%s and %s have separate answer keys", (first, second) => {
  const job = { id: 1, location: "Remote" };
  const question = {
    kind: "other",
    answerControlType: "text",
    answerOptions: [],
  } as const;
  expect(
    describeFormQuestion({ ...question, answerOptions: [], prompt: first }, job)
      .key,
  ).not.toBe(
    describeFormQuestion(
      { ...question, answerOptions: [], prompt: second },
      job,
    ).key,
  );
});

test("a repeated-step question is application-specific and cannot reuse the first entry's answer", () => {
  const question = {
    prompt: "Employment history � Start date (repeated question on step 2)",
    repeatedAtDifferentStep: true,
    kind: "other",
    answerControlType: "text",
    answerOptions: [],
  } as const;
  const one = describeFormQuestion(
    { ...question, answerOptions: [] },
    { id: 1, location: "Remote" },
  );
  const two = describeFormQuestion(
    { ...question, answerOptions: [] },
    { id: 2, location: "Remote" },
  );
  expect(one.reusePrompt).toBe(false);
  expect(one.key).not.toBe(two.key);
});
