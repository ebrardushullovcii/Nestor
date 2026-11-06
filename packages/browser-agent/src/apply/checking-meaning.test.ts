import { expect, test, vi } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import {
  meaningHash,
  meaningSourcesHash,
  meaningTargetHash,
} from "./answer-meaning";
import { createStepReceiptTracker } from "./step-receipts";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyAnswerSources } from "./types";

const sources: ApplyAnswerSources = {
  profile: CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Morgan River",
    yearsExperience: 8,
    summary: "I prepare monthly quality reports.",
    baseResume: {
      id: "synthetic",
      fileName: "synthetic.txt",
      uploadedAt: "2026-11-01T00:00:00Z",
      extractionStatus: "ready",
    },
  }),
  resumeText: "Reporting routine: I prepare monthly quality reports.",
  posting: {
    title: "Analyst",
    company: "Cedar Example",
    location: "Berlin, Germany",
    description: "Reporting.",
  },
  documents: [],
  reusableAnswers: [],
};
const reply = (checks: unknown[]) => ({
  toolCalls: [
    {
      id: "checks",
      type: "function" as const,
      function: {
        name: "report_answer_checks",
        arguments: JSON.stringify({ checks }),
      },
    },
  ],
});

test("one unusable citation preserves a supported answer and a genuine question", async () => {
  const checks = [
    {
      index: 0,
      supported: true,
      reason: "Recorded reporting.",
      evidence: [
        {
          claim: "Prepare monthly quality reports",
          kind: "applicant_fact",
          source: "applicant",
          path: "/summary",
          quote: "I prepare monthly quality reports.",
        },
      ],
    },
    {
      index: 1,
      supported: false,
      reason: "Your preferred contact time is unknown.",
      evidence: [],
    },
    {
      index: 2,
      supported: true,
      reason: "Malformed citation",
      evidence: [
        {
          claim: "A missing fact",
          kind: "applicant_fact",
          source: "applicant",
          path: "/missing",
          quote: "Yes",
        },
      ],
    },
  ];
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValue(reply(checks));
  const result = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources,
    payDisclosed: true,
    answers: [
      {
        question: "Describe recurring reports",
        answer: "I prepare monthly quality reports.",
        evidencePolicy: "factual_summary",
      },
      { question: "Preferred contact time", answer: "Morning" },
      { question: "An unknown personal fact", answer: "Yes" },
    ],
  });
  expect(result[0]?.supported).toBe(true);
  expect(result[1]).toEqual({
    supported: false,
    reason: "Your preferred contact time is unknown.",
  });
  expect(result[2]).toMatchObject({
    supported: false,
    unavailable: {
      index: 2,
      category: "unverified_evidence",
      stage: "citation_binding",
    },
  });
  expect(chatWithTools).toHaveBeenCalledTimes(3);
});

function observation() {
  return buildApplyFormObservation(
    {
      url: "http://127.0.0.1:47950/synthetic/apply",
      title: "Apply",
      bodyText: "Application\nDescribe recurring reports",
      controls: [
        {
          index: 0,
          tagName: "textarea",
          inputType: "",
          role: "",
          id: "reports",
          name: "reports",
          label: "Describe recurring reports",
          groupLabel: "",
          placeholder: "",
          autocomplete: "",
          required: true,
          invalid: false,
          validationMessage: "",
          disabled: false,
          readOnly: false,
          visible: true,
          value: "I prepare monthly quality reports.",
          checked: false,
          multiple: false,
          options: [],
          selectedOptionLabel: "",
        },
      ],
      actions: [],
      headings: [],
      links: [],
      clickables: [],
      openedTabs: [],
      validationErrors: [],
      stepLabel: null,
      loading: false,
    },
    "2026-11-05T05:00:00Z",
  );
}

test("Send reuses accepted meaning with complete live bindings and refreshes changed inputs", async () => {
  const page = observation();
  const control = page.controls[0];
  const value = control.value;
  const tracker = createStepReceiptTracker("attempt1", () => ({
    sourcesHash: meaningSourcesHash(sources, true, []),
    targetHash: meaningTargetHash(control, page.controls),
    instructionsHash: meaningHash(page.bodyTextExcerpt),
    valueHash: meaningHash(value),
    reason: "Checked against current facts.",
  }));
  const receipts = tracker.finish(page, page.observedAt);
  const field = receipts[0].fields[0];
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValue({ toolCalls: [] });
  const check = (
    overrides: Partial<
      Parameters<typeof checkClassifiedApplicationAnswers>[0]
    > = {},
  ) =>
    checkClassifiedApplicationAnswers({
      client: { chatWithTools },
      sources,
      payDisclosed: true,
      application: {
        applicationId: "attempt1",
        resultId: "attempt1",
        jobId: "1",
        startingUrl: page.url!,
      },
      answers: [
        { question: field.label, answer: value, fieldKey: field.fieldKey },
      ],
      formControls: page.controls,
      stepReceipts: receipts,
      formContext: { pageText: page.bodyTextExcerpt, fields: [] },
      ...overrides,
    });
  expect((await check())[0]?.supported).toBe(true);
  expect(chatWithTools).not.toHaveBeenCalled();
  for (const change of [
    { sources: { ...sources, resumeText: "Reporting changed." } },
    { payDisclosed: false },
    { formContext: { pageText: "Write this yourself", fields: [] } },
    { formControls: [{ ...control, hint: "Only during 2021", value }] },
    { formControls: [{ ...control, options: ["A different choice"], value }] },
    { formControls: [{ ...control, value: "A changed answer" }] },
    {
      application: {
        applicationId: "other-attempt",
        resultId: "other-attempt",
        jobId: "1",
        startingUrl: page.url!,
      },
    },
  ])
    expect((await check(change))[0]?.supported).toBe(false);
});

test("a bound whole-meaning verdict accepts a factual paraphrase without a second literal veto", async () => {
  const answer =
    "I keep recurring quality information current by preparing monthly quality reports.";
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue(
    reply([
      {
        index: 0,
        supported: true,
        reason: "Same monthly reporting fact.",
        evidence: [
          {
            claim: "Monthly quality reporting",
            kind: "applicant_fact",
            source: "applicant",
            path: "/summary",
            quote: "I prepare monthly quality reports.",
          },
        ],
      },
    ]),
  );
  const result = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources,
    payDisclosed: true,
    answers: [
      {
        question: "How do you keep recurring quality information current?",
        answer,
        evidencePolicy: "factual_summary",
      },
    ],
  });
  expect(result[0]?.supported).toBe(true);
  expect(chatWithTools).toHaveBeenCalledTimes(1);
});

test.each([
  ["6", true],
  ["7", false],
])(
  "equivalent numeric formatting reuses meaning while a conflicting %s stays blocked",
  async (other, supported) => {
    const saved = (id: string, answer: string) => ({
      id,
      kind: "other" as const,
      label: "Analysis",
      question: "Years of analysis experience",
      answer,
      roleFamilies: [],
      proofEntryIds: [],
    });
    const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue(
      reply([
        {
          index: 0,
          supported,
          reason: supported
            ? "Same meaning."
            : "Conflicting recorded quantities.",
          evidence: [
            {
              claim: "Six years",
              kind: "applicant_fact",
              source: "applicant",
              path: "/savedAnswers/0/answer",
              quote: "I have six years of analysis experience.",
            },
          ],
        },
      ]),
    );
    const result = await checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources: {
        ...sources,
        reusableAnswers: [
          saved("original", "I have six years of analysis experience."),
          saved("formatted", other),
        ],
      },
      payDisclosed: true,
      answers: [
        {
          question: "Years of analysis experience",
          answer: "6",
          evidencePolicy: "saved_answer",
        },
      ],
    });
    expect(result[0]?.supported).toBe(supported);
  },
);

test("two agreeing cited human answer rows are one supported numeric meaning", async () => {
  const saved = (id: string, answer: string) => ({
    id,
    kind: "other" as const,
    label: "Analysis",
    question: "Years of analysis experience",
    answer,
    roleFamilies: [],
    proofEntryIds: [],
  });
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue(
    reply([
      {
        index: 0,
        supported: true,
        reason: "Both recorded answers mean six years.",
        evidence: [
          {
            claim: "Six years",
            kind: "applicant_fact",
            source: "applicant",
            path: "/savedAnswers/0/answer",
            quote: "6 years",
          },
          {
            claim: "Six years",
            kind: "applicant_fact",
            source: "applicant",
            path: "/savedAnswers/1/answer",
            quote: "I have six years of analysis experience.",
          },
        ],
      },
    ]),
  );
  const result = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources: {
      ...sources,
      reusableAnswers: [
        saved("application_application:2", "6 years"),
        saved("form_answer_1", "I have six years of analysis experience."),
      ],
    },
    payDisclosed: true,
    answers: [
      {
        question: "Years of analysis experience",
        answer: "6",
        evidencePolicy: "saved_answer",
      },
    ],
  });
  expect(result[0]?.supported).toBe(true);
  expect(chatWithTools).toHaveBeenCalledTimes(1);
});

test("an earlier approved checkbox binds its exact native review value without a second sample", async () => {
  const page = observation();
  page.step = { index: 1, total: 2, label: "Step 1 of 2" };
  page.controls[0] = {
    ...page.controls[0],
    kind: "checkbox",
    label: "I certify the information is true",
    answerControlType: "boolean",
    attestationKind: "truthfulness_certification",
    value: "Certified as true",
    checked: true,
    options: [],
  };
  const control = page.controls[0];
  const approved = ["truthfulness_certification"] as const;
  const tracker = createStepReceiptTracker("attempt1", () => ({
    sourcesHash: meaningSourcesHash(sources, true, approved),
    targetHash: meaningTargetHash(control, page.controls),
    instructionsHash: meaningHash(page.bodyTextExcerpt),
    valueHash: meaningHash("Yes"),
    reason: "Exact approved declaration.",
  }));
  tracker.wrote(page, control.ref);
  tracker.advance(page, page.observedAt);
  const receipts = tracker.finish(null, page.observedAt);
  const field = receipts[0].fields[0];
  expect(field.nativeValue).toBe("Certified as true");
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValue({ toolCalls: [] });
  const input: Parameters<typeof checkClassifiedApplicationAnswers>[0] = {
    client: { chatWithTools },
    sources,
    payDisclosed: true,
    approvedAttestations: [...approved],
    application: {
      applicationId: "attempt1",
      resultId: "attempt1",
      jobId: "1",
      startingUrl: page.url!,
    },
    answers: [
      { question: field.label, answer: "Yes", fieldKey: field.fieldKey },
    ],
    stepReceipts: receipts,
    formControls: [],
    formContext: { pageText: "Review", fields: [] },
    sendPage: { origin: new URL(page.url!).origin, stepIndex: 2, stepTotal: 2 },
    summaryRows: [{ label: field.label, value: "Certified as true" }],
  };
  expect((await checkClassifiedApplicationAnswers(input))[0]?.supported).toBe(
    true,
  );
  expect(chatWithTools).not.toHaveBeenCalled();
  expect(
    (
      await checkClassifiedApplicationAnswers({
        ...input,
        approvedAttestations: [],
      })
    )[0]?.supported,
  ).toBe(false);
  expect(
    (
      await checkClassifiedApplicationAnswers({
        ...input,
        summaryRows: [{ label: field.label, value: "Different certification" }],
      })
    )[0]?.supported,
  ).toBe(false);
});
