import { expect, test, vi } from "vitest";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import { applicationFacts } from "./application-facts";
import { classifyAnswerPermission } from "./answer-source-catalog";
import { expectedPaySuggestion } from "./expected-pay";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
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
function report(evidence: unknown[]): LLMClient {
  return {
    chatWithTools: vi.fn().mockResolvedValue({
      toolCalls: [
        {
          id: "check",
          type: "function",
          function: {
            name: "report_answer_checks",
            arguments: JSON.stringify({
              checks: [
                {
                  index: 0,
                  supported: true,
                  reason: "The saved answer addresses the whole question.",
                  evidence,
                },
              ],
            }),
          },
        },
      ],
    }),
  };
}

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

test("task notes reach the independent checker with verifiable quote paths", async () => {
  const src = sources();
  src.taskInstructions = [
    "Analysis experience is 22 completed non-overlapping years.",
  ];
  const client = report([
    {
      claim: "22",
      kind: "applicant_fact",
      source: "applicant",
      path: "/taskGuidance/0",
      quote: src.taskInstructions[0],
    },
  ]);
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: src,
      payDisclosed: false,
      answers: [
        {
          question: "Years of analysis experience",
          answer: "22",
          evidencePolicy: "factual_inference",
        },
      ],
    }),
  ).toMatchObject([{ supported: true }]);
  src.taskInstructions = [];
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: src,
      payDisclosed: false,
      answers: [
        {
          question: "Years of analysis experience",
          answer: "22",
          evidencePolicy: "factual_inference",
        },
      ],
    }),
  ).toMatchObject([{ supported: false }]);
});

test("saved answer wording changes require an independent whole-question check", async () => {
  const src = sources();
  src.reusableAnswers = [
    {
      id: "consent",
      kind: "other",
      label: "Accuracy",
      question: "I certify the supplied information is accurate",
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const field = {
    ...control("I confirm the accuracy of the details supplied above"),
    kind: "checkbox" as const,
    answerControlType: "boolean" as const,
    attestationKind: "truthfulness_certification" as const,
  };
  const decision = classifyAnswerPermission({
    control: field,
    controls: [field],
    sources: src,
    tags: {
      kind: "other",
      country: null,
      sourceId: "answerLibrary.consent",
      declarationPurpose: "acknowledgement",
    },
    answer: "Yes",
    pageInstructions: "",
    approvedAttestations: [],
  });
  expect(decision).toMatchObject({
    kind: "writing",
    evidencePolicy: "saved_answer",
  });
  const good = {
    claim: "Yes",
    kind: "applicant_fact",
    source: "applicant",
    path: "/savedAnswers/0/answer",
    quote: "Yes",
  };
  for (const evidence of [
    [
      good,
      {
        ...good,
        path: "/savedAnswers/0/question",
        quote: src.reusableAnswers[0].question,
      },
    ],
    [{ ...good, path: "/yearsExperience", quote: "23" }],
  ]) {
    const result = await checkWrittenApplicationAnswers({
      client: report(evidence),
      sources: src,
      payDisclosed: false,
      answers: [
        {
          question: field.label,
          answer: "Yes",
          evidencePolicy: "saved_answer",
        },
      ],
    });
    expect(result[0]?.supported).toBe(evidence[0] === good);
  }
});

test("a current conditional answer can be rechecked, but another jurisdiction cannot borrow it", () => {
  const src = sources();
  src.reusableAnswers = [
    {
      id: "application_local",
      kind: "work_authorization",
      label: "UK authorization",
      question:
        "May you work in the UK for this role until your permit expires?",
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
      applicationScope: {
        applicationRecordId: "application_1",
        resultId: null,
        location: "United Kingdom",
      },
    },
  ];
  for (const place of ["United Kingdom", "United States"]) {
    const field = {
      ...control(
        `Are you allowed to take this role in the ${place} until your current permission expires?`,
      ),
      questionKind: "work_authorization" as const,
    };
    const result = classifyAnswerPermission({
      control: field,
      controls: [field],
      sources: src,
      tags: {
        kind: "work_auth",
        country: place === "United Kingdom" ? "GB" : "US",
        sourceId: "answerLibrary.application_local",
        hasAdditionalConditions: true,
      },
      answer: "Yes",
      pageInstructions: "",
      application: {
        jobId: "1",
        applicationId: "attempt2",
        applicationRecordId: "application_1",
        startingUrl: "https://replica.test/apply",
      },
    });
    expect(result.kind).toBe(
      place === "United Kingdom" ? "writing" : "needs_you",
    );
  }
});

test("approved acknowledgements do not depend on the reader choosing an empty source", () => {
  const src = sources();
  const field = {
    ...control("I confirm the supplied details are accurate"),
    kind: "checkbox" as const,
    attestationKind: "truthfulness_certification" as const,
  };
  expect(
    classifyAnswerPermission({
      control: field,
      controls: [field],
      sources: src,
      tags: {
        kind: "other",
        country: null,
        sourceId: "resume.text",
        declarationPurpose: "acknowledgement",
      },
      answer: "Yes",
      pageInstructions: "",
      approvedAttestations: ["truthfulness_certification"],
    }),
  ).toMatchObject({ kind: "literal", source: { purpose: "authority" } });
  expect(
    classifyAnswerPermission({
      control: field,
      controls: [field],
      sources: src,
      tags: {
        kind: "other",
        country: null,
        sourceId: "resume.text",
        declarationPurpose: "personal_fact",
      },
      answer: "Yes",
      pageInstructions: "",
      approvedAttestations: ["truthfulness_certification"],
    }),
  ).toMatchObject({ kind: "needs_you" });
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
