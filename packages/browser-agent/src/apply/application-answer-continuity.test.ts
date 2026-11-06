import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import { applicationFacts, savedAnswerForQuestion } from "./application-facts";
import { expectedPayHandoff, expectedPaySuggestion } from "./expected-pay";
import { questionPrompt } from "./question-text";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";
const sources = (): ApplyAnswerSources => ({
  profile: CandidateProfileSchema.parse({
    id: "synthetic-a1",
    fullName: "Synthetic Applicant",
    yearsExperience: 23,
    baseResume: {
      id: "synthetic",
      fileName: "synthetic.txt",
      uploadedAt: "2026-11-04T00:00:00Z",
      textContent: "Dated analysis history.",
    },
  }),
  resumeText: null,
  reusableAnswers: [],
  documents: [],
  posting: {
    title: "Analyst",
    company: "Synthetic",
    location: "United Kingdom",
    description: "Analysis",
  },
});
const control = (label: string): ApplyFormControl => ({
  ref: "c0",
  kind: "text",
  label,
  groupLabel: "",
  placeholder: "",
  required: true,
  disabled: false,
  readOnly: false,
  visible: true,
  value: "",
  checked: false,
  options: [],
  selectedOptionLabel: "",
  invalid: false,
  validationMessage: "",
  questionKind: "other",
  answerControlType: "text",
  attestationKind: null,
  answered: false,
});

test("unconfirmed currency defaults are not applicant facts", () => {
  const src = sources();
  src.preferences = JobSearchPreferencesSchema.parse({
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    compensation: {
      maximum: 85000,
      currency: null,
      currencyStatus: "needs_clarification",
    },
    salaryCurrency: "USD",
  });
  expect(
    applicationFacts(src, { payDisclosed: true }).preferences,
  ).toMatchObject({
    salaryCurrency: null,
    compensation: { currency: null, currencyStatus: "needs_clarification" },
  });
});

test("pay suggestions retain the recorded amount, currency and period", () => {
  const src = sources();
  src.preferences = JobSearchPreferencesSchema.parse({
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    compensation: {
      maximum: 85000,
      currency: "EUR",
      currencyStatus: "explicit",
      interval: "year",
    },
  });
  const field = {
    ...control("Expected annual salary range (EUR)"),
    kind: "select" as const,
    options: [
      "70 000 EUR – 80 000 EUR",
      "80 000 EUR – 90 000 EUR",
      "90 000 EUR – 100 000 EUR",
    ],
  };
  expect(expectedPaySuggestion(field, src)?.value).toBe(
    "80 000 EUR – 90 000 EUR",
  );
  expect(
    expectedPaySuggestion({ ...field, asksCurrentPay: true }, src),
  ).toBeNull();
  expect(
    expectedPaySuggestion(
      { ...field, label: "Expected hourly salary range" },
      src,
    ),
  ).toBeNull();
  src.preferences.compensation.currencyStatus = "needs_clarification";
  expect(expectedPaySuggestion(field, src)).toBeNull();
});

test("an explicit compensation currency replaces an unconfirmed legacy currency default", () => {
  const src = sources();
  src.preferences = JobSearchPreferencesSchema.parse({
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    salaryCurrency: "USD",
    compensation: {
      maximum: 85000,
      currency: "EUR",
      currencyStatus: "explicit",
      interval: "year",
    },
  });
  expect(
    applicationFacts(src, { payDisclosed: true }).preferences?.salaryCurrency,
  ).toBe("EUR");
});

test("gross expected pay offers the exact compatible band while a missing band and current pay remain distinct", () => {
  const src = sources();
  src.preferences = JobSearchPreferencesSchema.parse({
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    compensation: {
      maximum: 68400,
      currency: "EUR",
      currencyStatus: "explicit",
      interval: "year",
      basis: "base",
    },
  });
  const field = {
    ...control("Desired gross base pay per year in EUR"),
    kind: "select" as const,
    questionKind: "salary_expectation" as const,
    options: ["EUR 65,000–69,999", "EUR 70,000–74,999"],
  };
  expect(expectedPaySuggestion(field, src)?.value).toBe(field.options[0]);
  expect(
    expectedPayHandoff({ ...field, options: [field.options[1]] }, src),
  ).toMatchObject({ suggestion: null, check: "pay_option_missing" });
  expect(
    expectedPayHandoff({ ...field, asksCurrentPay: true }, src),
  ).toMatchObject({ suggestion: null, check: "current_pay_missing" });
  expect(
    expectedPaySuggestion(
      { ...field, label: "Desired net pay after tax in EUR per year" },
      src,
    ),
  ).toBeNull();
  expect(
    expectedPaySuggestion(
      { ...field, label: "Desired base pay in CAD per month" },
      src,
    ),
  ).toBeNull();
});

test("question identity preserves an outer subject and a condition supplied only as a hint", () => {
  const field = {
    ...control("Monday"),
    kind: "checkbox" as const,
    answerControlType: "multi_choice" as const,
    groupLabel: "Weekdays",
    sectionPath: ["Remote interviews", "Weekdays"],
    hint: "From 17:00 to 19:00 Europe/Berlin",
  };
  const first = questionPrompt(field);
  expect(first).toContain("Remote interviews");
  expect(first).toContain("17:00 to 19:00 Europe/Berlin");
  expect(
    questionPrompt({ ...field, hint: "From 09:00 to 11:00 Europe/Berlin" }),
  ).not.toBe(first);
  expect(
    questionPrompt({
      ...field,
      sectionPath: ["Regular office work", "Weekdays"],
    }),
  ).not.toBe(first);
  const short = {
    id: "known",
    kind: "other" as const,
    label: "Availability",
    question: "Availability",
    answer: "Tuesday",
    roleFamilies: [],
    proofEntryIds: [],
  };
  const availability = {
    ...control("Availability"),
    hint: "For regular office work, 09:00–17:00 Europe/Berlin",
  };
  expect(
    savedAnswerForQuestion(availability, [short], [availability]),
  ).toBeNull();
  expect(
    savedAnswerForQuestion(
      availability,
      [{ ...short, question: questionPrompt(availability) }],
      [availability],
    )?.answer,
  ).toBe("Tuesday");
});

test("a longer outer subject is retained when it contains the leaf question", () => {
  const field = {
    ...control("Monday"),
    kind: "checkbox" as const,
    answerControlType: "multi_choice" as const,
    groupLabel: "Availability",
    sectionPath: ["Remote interview availability", "Availability"],
  };
  const interview = questionPrompt(field);
  expect(interview).toBe("Remote interview availability — Availability");
  const work = questionPrompt({
    ...field,
    sectionPath: ["Regular work availability", "Availability"],
  });
  expect(work).toBe("Regular work availability — Availability");
  expect(
    savedAnswerForQuestion(
      { ...field, sectionPath: ["Regular work availability", "Availability"] },
      [
        {
          id: "interview",
          kind: "other",
          label: interview,
          question: interview,
          answer: "Monday",
          roleFamilies: [],
          proofEntryIds: [],
        },
      ],
      [field],
    ),
  ).toBeNull();
});
