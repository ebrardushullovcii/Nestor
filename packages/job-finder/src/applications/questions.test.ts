import { expect, test } from "vitest";
import {
  cleanFormQuestionPrompt,
  normalizeFormQuestionPrompt,
} from "@nestor/contracts";
import {
  describeFormQuestion,
  describeSavedFormAnswer,
  type FormQuestion,
} from "./questions";

test("a boolean handover keeps the form's observed choice order", () => {
  const question: FormQuestion = {
    prompt: "Employment restrictions?",
    kind: "other",
    answerControlType: "boolean",
    answerOptions: ["No", "Yes"],
  };
  const job = { id: 1, location: "Remote" };
  expect(describeFormQuestion(question, job)).toMatchObject({
    input: "boolean",
    options: ["No", "Yes"],
  });
  expect(
    describeFormQuestion({ ...question, answerOptions: [] }, job).options,
  ).toEqual([]);
});

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

test("Workday legal prompt seeds are not country-scoped answers: the typed profile gate must resolve the explicit country", () => {
  for (const [prompt, kind, answer] of [
    [
      "Application Questions — Are you legally authorized to work in this country? *",
      "work_authorization",
      "Yes",
    ],
    [
      "Application Questions — Will you require sponsorship? *",
      "visa_sponsorship",
      "No",
    ],
  ] as const) {
    const saved = describeSavedFormAnswer(prompt, answer);
    const question = describeFormQuestion(
      {
        prompt,
        kind,
        answerControlType: "boolean",
        answerOptions: ["Yes", "No"],
      },
      { id: 1, location: "United Kingdom" },
    );
    expect(question.reusePrompt).toBe(false);
    expect(question.key).not.toBe(saved.key);
  }
});

test("an exact authorization question naming one country reuses its own saved answer across posting locations", () => {
  const prompt = "Are you authorized to work in the UK?";
  const question = {
    prompt,
    kind: "work_authorization" as const,
    answerControlType: "boolean" as const,
    answerOptions: ["Yes", "No"],
  };
  const saved = describeSavedFormAnswer(prompt, "No");
  const target = describeFormQuestion(question, { id: 1, location: "Germany" });
  expect(target.reusePrompt).toBe(true);
  expect(target.key).toBe(saved.key);
  for (const prompt of [
    "Are you authorized to work in this country?",
    "Are you authorized to work in the UK and Germany?",
  ])
    expect(
      describeFormQuestion(
        { ...question, prompt },
        { id: 1, location: "Germany" },
      ).reusePrompt,
    ).toBe(false);
});
