import { questionPrompt } from "./question-text";
import { expect, test, vi } from "vitest";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import { applicationFacts, savedAnswerForQuestion } from "./application-facts";
import { classifyAnswerPermission } from "./answer-source-catalog";
import { expectedPayHandoff, expectedPaySuggestion } from "./expected-pay";
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
  await expect(
    checkWrittenApplicationAnswers({
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
  ).rejects.toMatchObject({ category: "unverified_evidence" });
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
    const pending = checkWrittenApplicationAnswers({
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
    if (evidence[0] === good) expect((await pending)[0]?.supported).toBe(true);
    else
      await expect(pending).rejects.toMatchObject({
        category: "unverified_evidence",
      });
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

test("approved acknowledgements retain semantic category and reject an added personal claim", () => {
  const src = sources();
  const field = {
    ...control("These entries faithfully represent the supplied background"),
    kind: "checkbox" as const,
    answerControlType: "boolean" as const,
    attestationKind: "truthfulness_certification" as const,
  };
  const input = {
    control: field,
    controls: [field],
    sources: src,
    answer: "Yes",
    pageInstructions: "",
    tags: {
      kind: "other" as const,
      country: null,
      sourceId: null,
      declarationPurpose: "acknowledgement" as const,
    },
  };
  expect(
    classifyAnswerPermission({
      ...input,
      approvedAttestations: ["truthfulness_certification"],
    }).kind,
  ).toBe("literal");
  expect(
    classifyAnswerPermission({ ...input, approvedAttestations: [] }).kind,
  ).toBe("needs_you");
  expect(
    classifyAnswerPermission({
      ...input,
      approvedAttestations: ["truthfulness_certification"],
      tags: { ...input.tags, declarationPurpose: "personal_fact" },
    }).kind,
  ).toBe("needs_you");
});

test("conditional Profile permission reaches a checked comparison, never a literal Yes", async () => {
  const src = sources();
  src.profile.workEligibility.limitedWorkPermissions = [
    {
      country: "Germany",
      conditions: "No more than 20 hours weekly until August 2027",
      requiresFutureSponsorship: true,
    },
  ];
  const field = {
    ...control(
      "Does your current German permission cover 16 hours weekly through April 2027?",
    ),
    questionKind: "work_authorization" as const,
  };
  expect(
    classifyAnswerPermission({
      control: field,
      controls: [field],
      sources: src,
      answer: "Yes",
      pageInstructions: "",
      tags: {
        kind: "work_auth",
        country: "DE",
        sourceId: "profile.workEligibility.limitedWorkPermissions.0",
        hasAdditionalConditions: true,
      },
    }),
  ).toEqual({ kind: "inference", source: null, evidencePolicy: "eligibility" });
  const pending = checkWrittenApplicationAnswers({
    client: report([
      {
        claim: "Yes",
        kind: "applicant_fact",
        source: "applicant",
        path: "/workEligibility/Limited work permissions/0/Country",
        quote: "Germany",
      },
    ]),
    sources: src,
    payDisclosed: false,
    answers: [
      { question: field.label, answer: "Yes", evidencePolicy: "eligibility" },
    ],
  });
  await expect(pending).rejects.toMatchObject({
    category: "unverified_evidence",
  }); // A country alone cannot prove hours/expiry.
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

test("a resume quote binds the one plaintext document while an invented quote still fails", async () => {
  const src = sources();
  src.resumeText = "Paid work with TypeScript. No paid Rust experience.";
  const evidence = [
    {
      claim: "TypeScript",
      source: "resume",
      path: "/experiences/0/summary",
      quote: "Paid work with TypeScript.",
      kind: "applicant_fact",
    },
  ];
  const check = () =>
    checkWrittenApplicationAnswers({
      client: report(evidence),
      sources: src,
      payDisclosed: false,
      answers: [
        {
          question: "Which technology have you used professionally?",
          answer: "TypeScript",
          evidencePolicy: "factual_inference",
        },
      ],
    });
  expect((await check())[0]?.supported).toBe(true);
  evidence[0].quote = "Paid work with Ruby.";
  await expect(check()).rejects.toMatchObject({
    category: "unverified_evidence",
  });
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
