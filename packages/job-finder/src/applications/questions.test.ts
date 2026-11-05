import { expect, test } from "vitest";
import {
  CandidateWorkEligibilitySchema,
  cleanFormQuestionPrompt,
  normalizeFormQuestionPrompt,
} from "@nestor/contracts";
import {
  describeFormQuestion,
  describeSavedFormAnswer,
  describeLegacyFormQuestion,
  resolveListingCountry,
  toKnownFormAnswer,
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

test("an explicit authorization country has a fingerprinted key across posting locations", () => {
  const prompt = "Are you authorized to work in the UK?";
  const question = {
    prompt,
    kind: "work_authorization" as const,
    answerControlType: "boolean" as const,
    answerOptions: ["Yes", "No"],
  };
  const saved = describeSavedFormAnswer(prompt, "No");
  const profile = { workEligibility: CandidateWorkEligibilitySchema.parse({}) };
  const target = describeFormQuestion(
    question,
    { id: 1, location: "Germany" },
    profile,
  );
  expect(target.reusePrompt).toBe(false);
  expect(target.key).not.toBe(saved.key);
  expect(
    describeLegacyFormQuestion(question, { id: 1, location: "Germany" }).key,
  ).toBe(saved.key);
  expect(
    describeFormQuestion(question, { id: 2, location: "Remote" }, profile).key,
  ).toBe(target.key);
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

test("eligibility memory shares a resolved country only while recorded facts match", () => {
  const question: FormQuestion = {
    prompt: "Are you authorized to work here?",
    kind: "work_authorization",
    answerControlType: "boolean",
    answerOptions: ["Yes", "No"],
  };
  const profile = {
    workEligibility: {
      authorizedWorkCountries: ["Germany"],
      requiresVisaSponsorship: false,
    },
  };
  const facts = {
    workEligibility: CandidateWorkEligibilitySchema.parse(
      profile.workEligibility,
    ),
  };
  const one = describeFormQuestion(
    question,
    { id: 1, location: "Berlin, Germany" },
    facts,
  );
  expect(
    describeFormQuestion(
      question,
      { id: 2, location: "Munich, Germany" },
      facts,
    ).key,
  ).toBe(one.key);
  expect(
    describeFormQuestion(
      question,
      { id: 2, location: "Munich, Germany" },
      {
        workEligibility: {
          ...facts.workEligibility,
          requiresVisaSponsorship: true,
        },
      },
    ).key,
  ).not.toBe(one.key);
  expect(
    describeFormQuestion(question, { id: 1, location: "Remote, Europe" }, facts)
      .key,
  ).not.toBe(
    describeFormQuestion(question, { id: 2, location: "Remote, Europe" }, facts)
      .key,
  );
  const limited = {
    workEligibility: CandidateWorkEligibilitySchema.parse({
      ...facts.workEligibility,
      limitedWorkPermissions: [
        {
          country: "Germany",
          permissionType: "Student",
          conditions: "20 hours",
          requiresFutureSponsorship: false,
        },
      ],
    }),
  };
  expect(
    describeFormQuestion(question, { id: 1, location: "Germany" }, limited).key,
  ).not.toBe(
    describeFormQuestion(question, { id: 2, location: "Germany" }, limited).key,
  );
});

test.each([
  ["Austin, TX", "US"],
  ["Toronto, ON", "CA"],
  ["Vancouver, British Columbia", "CA"],
  ["Berlin, Germany", "DE"],
  ["Paris", null],
  ["Remote", null],
  ["Remote, Europe", null],
  ["Canada / Germany", null],
])("listing country %s resolves conservatively", (location, expected) => {
  expect(resolveListingCountry(location)).toBe(expected);
});

test("only an application-local answer carries the original exact field binding", () => {
  const question: FormQuestion = {
    prompt: "Saturday hours",
    kind: "availability",
    answerControlType: "text",
    answerOptions: [],
    currentFieldBinding: {
      pageUrl: "http://127.0.0.1:47950/apply/42",
      targetHash: "a".repeat(64),
      instructionsHash: "b".repeat(64),
    },
  };
  const answer = {
    id: "42",
    prompt: question.prompt,
    answer: "8",
    local: true,
  };
  expect(
    toKnownFormAnswer(answer, question, "Germany", 42).applicationScope
      ?.currentFieldBinding,
  ).toEqual(question.currentFieldBinding);
  expect(
    toKnownFormAnswer({ ...answer, local: false }, question, "Germany", 42)
      .applicationScope?.currentFieldBinding,
  ).toBeUndefined();
});
