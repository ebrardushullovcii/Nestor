import { expect, test, vi } from "vitest";
import {
  CandidateProfileSchema,
  CandidateReusableAnswerSchema,
} from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import {
  answerSourceCatalog,
  classifyAnswerPermission,
} from "./answer-source-catalog";
import {
  currentApplicationAnswer,
  meaningHash,
  meaningTargetHash,
  meaningSourcesHash,
} from "./answer-meaning";
import { buildPendingQuestion } from "./policy-executor";
import { buildApplyFormObservation } from "./page-hands";

const sources = (): ApplyAnswerSources => ({
  profile: CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Morgan Vale",
    yearsExperience: 6,
    workEligibility: {
      willingToTravel: true,
      limitedWorkPermissions: [
        {
          country: "Germany",
          conditions:
            "Employee work up to 18 hours weekly, from 2026-11-01 through 2027-04-30. No self-employment.",
          requiresFutureSponsorship: true,
        },
      ],
    },
    baseResume: {
      id: "resume",
      fileName: "synthetic.txt",
      uploadedAt: "2026-11-05T00:00:00Z",
      textContent: "Used SQL professionally for four years.",
    },
  }),
  resumeText: "Used SQL professionally for four years.",
  documents: [],
  reusableAnswers: [
    CandidateReusableAnswerSchema.parse({
      id: "saved-hours",
      label: "Availability",
      question: "Personal availability in Germany",
      answer:
        "I can work 16 hours weekly Monday and Tuesday from 2026-12-01. I have not agreed to Saturdays.",
    }),
  ],
  posting: {
    title: "Analyst",
    company: "Synthetic employer",
    location: "Germany",
    description: "Employee work, 16 hours weekly.",
  },
});
const cite = (
  path: string,
  quote: string,
  source = "applicant",
  kind = "applicant_fact",
  claim = "The saved answer establishes availability.",
) => ({ claim, source, kind, path, quote });
function clientFor(evidence: unknown[], extra = {}) {
  const report = {
    checks: [
      {
        index: 0,
        supported: true,
        reason: "The whole saved meaning matches.",
        meaningPreserved: true,
        evidence,
        ...extra,
      },
    ],
  };
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue({
    toolCalls: [
      {
        id: "check",
        type: "function",
        function: {
          name: "report_answer_checks",
          arguments: JSON.stringify(report),
        },
      },
    ],
  });
  return { chatWithTools };
}
const field = (): ApplyFormControl => ({
  ref: "c0",
  kind: "text",
  label: "Hours personally available on Saturday",
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

test("a deciding saved passage remains usable with redundant profile, resume and invalid context references", async () => {
  const src = sources();
  const client = clientFor([
    cite(
      "/savedAnswers/0/answer",
      "I can work 16 hours weekly Monday and Tuesday from 2026-12-01.",
    ),
    cite("/workEligibility/Willing to travel", "Yes"),
    cite("", "Used SQL professionally for four years.", "resume"),
    cite("/applicationFormContext/pageText", "Monday and Tuesday"),
  ]);
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: src,
      payDisclosed: false,
      formContext: {
        pageText:
          "Are you available 16 hours Monday and Tuesday from 2026-12-01?",
        fields: [],
      },
      answers: [
        {
          question:
            "Are you available 16 hours Monday and Tuesday from 2026-12-01?",
          answer: "Yes",
          evidencePolicy: "saved_answer",
        },
      ],
    }),
  ).toMatchObject([{ supported: true }]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  const data = JSON.parse(
    String(client.chatWithTools.mock.calls[0][0][1].content),
  ) as {
    applicant: { savedAnswers: { answer: string }[] };
    applicationFormContext: { pageText: string };
  };
  expect(data.applicant.savedAnswers[0].answer).toContain(
    "I have not agreed to Saturdays.",
  );
  expect(data.applicationFormContext.pageText).toContain("Monday and Tuesday");
});

test.each([
  [
    "wrong sole quote",
    cite("/savedAnswers/0/answer", "I can work on Saturdays."),
  ],
  ["wrong sole row", cite("/savedAnswers/7/answer", "8")],
  ["wrong sole value", cite("/savedAnswers/0/answer", "8")],
  [
    "only form support",
    cite("/pageText", "I can work on Saturdays.", "form", "role_motivation"),
  ],
  [
    "only posting support",
    cite(
      "/description",
      "Employee work, 16 hours weekly.",
      "posting",
      "role_motivation",
    ),
  ],
])("%s cannot supply a saved applicant answer", async (_name, evidence) => {
  const client = clientFor([evidence]);
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: sources(),
      payDisclosed: false,
      formContext: { pageText: "I can work on Saturdays.", fields: [] },
      answers: [
        {
          question: "Saturday hours",
          answer: "8",
          evidencePolicy: "saved_answer",
        },
      ],
    }),
  ).toMatchObject([
    { supported: false, unavailable: { category: "unverified_evidence" } },
  ]);
});

test("a truncated permit cannot lose its exclusions and correction identifies the required full row", async () => {
  const src = sources();
  const client = clientFor([
    cite("/workEligibility/Limited work permissions/0/Country", "Germany"),
    cite(
      "/workEligibility/Limited work permissions/0/Conditions",
      "Employee work up to 18 hours weekly, from 2026-11-01 through 2027-04-30.",
    ),
  ]);
  const result = await checkWrittenApplicationAnswers({
    client,
    sources: src,
    payDisclosed: false,
    answers: [
      {
        question: "Legally work in Germany for this employee role?",
        answer: "Yes",
        evidencePolicy: "eligibility",
      },
    ],
  });
  expect(result).toMatchObject([
    { supported: false, unavailable: { stage: "source_support" } },
  ]);
  const correction = String(
    client.chatWithTools.mock.calls[1][0].at(-1)?.content,
  );
  expect(correction).toContain("requiredPermitRows");
  expect(correction).toContain("full Conditions and Country");
  expect(correction).toContain("priorReports");
  expect(correction).not.toContain("JSON-encoded");
});

test("a form context quote can establish target conditions alongside complete applicant permission", async () => {
  const src = sources();
  const permit = src.profile.workEligibility.limitedWorkPermissions![0];
  const client = clientFor([
    cite("/workEligibility/Limited work permissions/0/Country", permit.country),
    cite(
      "/workEligibility/Limited work permissions/0/Conditions",
      permit.conditions,
    ),
    cite(
      "/pageText",
      "German employee role, 16 hours weekly.",
      "form",
      "role_motivation",
    ),
  ]);
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: src,
      payDisclosed: false,
      formContext: {
        pageText: "German employee role, 16 hours weekly.",
        fields: [],
      },
      answers: [
        {
          question: "Legally do this German employee role?",
          answer: "Yes",
          evidencePolicy: "eligibility",
        },
      ],
    }),
  ).toMatchObject([{ supported: true }]);
});

test("conflicting same-scope saved quantities cannot be voted into agreement", async () => {
  const src = sources();
  src.reusableAnswers = [4, 7].map((n) =>
    CandidateReusableAnswerSchema.parse({
      id: `years-${n}`,
      label: "SQL",
      question: "Years using SQL",
      answer: String(n),
    }),
  );
  const client = clientFor([cite("/savedAnswers/0/answer", "4")]);
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: src,
      payDisclosed: false,
      answers: [
        {
          question: "Years using SQL",
          answer: "4",
          evidencePolicy: "saved_answer",
        },
      ],
    }),
  ).toMatchObject([{ supported: false }]);
});

test("an unapproved declaration has no authority even with form instructions", async () => {
  const client = clientFor([
    cite("/approvedDeclarations/0", "marketing_contact", "authority"),
    cite(
      "/pageText",
      "I consent to marketing contact.",
      "form",
      "role_motivation",
    ),
  ]);
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: sources(),
      payDisclosed: false,
      approvedAttestations: ["truthfulness_certification"],
      formContext: { pageText: "I consent to marketing contact.", fields: [] },
      answers: [
        {
          question: "Marketing consent",
          answer: "Yes",
          evidencePolicy: "declaration",
        },
      ],
    }),
  ).toMatchObject([{ supported: false }]);
});

test("a lost prose claim is not rescued by a supported sibling claim or target context", async () => {
  const client = clientFor([
    cite("/summary", "Used SQL professionally for four years."),
    cite(
      "/not-real",
      "I led a team of twenty.",
      "applicant",
      "applicant_fact",
      "Led a team of twenty",
    ),
  ]);
  const src = sources();
  src.profile.summary = "Used SQL professionally for four years.";
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: src,
      payDisclosed: false,
      answers: [
        {
          question: "Describe your experience",
          answer:
            "Used SQL professionally for four years. I led a team of twenty.",
          evidencePolicy: "factual_summary",
        },
      ],
    }),
  ).toMatchObject([{ supported: false }]);
});

test("the person's exact bound current-field answer needs no semantic authorization; changed bindings do", () => {
  const control = field(),
    src = sources(),
    pageUrl = "http://127.0.0.1:47950/apply/42",
    pageInstructions = "Saturday 09:00–17:00 from 2026-12-12";
  src.reusableAnswers = [
    CandidateReusableAnswerSchema.parse({
      id: "application_current",
      label: control.label,
      question: control.label,
      answer: "8",
      applicationScope: {
        resultId: null,
        applicationRecordId: "application_42",
        location: null,
        currentFieldBinding: {
          pageUrl,
          targetHash: meaningTargetHash(control, [control]),
          instructionsHash: meaningHash(pageInstructions),
        },
      },
    }),
  ];
  const input = {
    control,
    controls: [control],
    sources: src,
    application: {
      jobId: "42",
      applicationId: "current",
      applicationRecordId: "application_42",
      startingUrl: pageUrl,
    },
    pageUrl,
    pageInstructions,
  };
  expect(currentApplicationAnswer(input)?.answer).toBe("8");
  expect(
    classifyAnswerPermission({ ...input, tags: null, answer: "8" }),
  ).toMatchObject({ kind: "literal", source: { value: "8" } });
  for (const change of [
    { pageUrl: pageUrl + "?different=1" },
    { pageInstructions: pageInstructions + " and Sunday" },
    {
      application: {
        ...input.application,
        applicationRecordId: "application_43",
      },
    },
    { control: { ...control, options: ["0", "4", "8"] } },
    { control: { ...control, label: control.label + " and Sunday" } },
    {
      control: {
        ...control,
        inputConstraints: { type: "number" as const, max: "4" },
      },
    },
  ])
    expect(currentApplicationAnswer({ ...input, ...change })).toBeNull();
  expect(
    classifyAnswerPermission({
      ...input,
      tags: {
        kind: "other",
        country: null,
        sourceId: "answerLibrary.application_current",
      },
      answer: "8",
      pageInstructions: pageInstructions + " and Sunday",
    }).kind,
  ).not.toBe("literal");
  expect(
    classifyAnswerPermission({ ...input, tags: null, answer: "7" }),
  ).toMatchObject({ kind: "needs_you" });
});

test("pending current-field binding survives the question contract", () => {
  const control = field();
  const page = buildApplyFormObservation(
    {
      url: "http://127.0.0.1:47950/apply/42",
      title: "Apply",
      bodyText: "Saturday work only",
      controls: [],
      actions: [],
      clickables: [],
      headings: [],
      links: [],
      openedTabs: [],
      loading: false,
      validationErrors: [],
      stepLabel: null,
    },
    "2026-11-05T00:00:00Z",
  );
  const question = buildPendingQuestion({
    control,
    observation: { ...page, controls: [control] },
    siblings: [control],
    jobId: "42",
    detectedAt: "2026-11-05T00:00:00Z",
    suggestion: null,
  });
  expect(question.currentFieldBinding).toMatchObject({
    targetHash: meaningTargetHash(control, [control]),
    instructionsHash: meaningHash("Saturday work only"),
  });
});

test("a real sole scalar cannot authorize a different numeric answer", async () => {
  const src = sources();
  src.reusableAnswers[0].answer = "4";
  const client = clientFor([cite("/savedAnswers/0/answer", "4")]);
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: src,
      payDisclosed: false,
      answers: [
        {
          question: "Personal availability in Germany",
          answer: "8",
          evidencePolicy: "saved_answer",
        },
      ],
    }),
  ).toMatchObject([{ supported: false }]);
});

test("a complete permit for a different country cannot establish the requested permission", async () => {
  const src = sources();
  const permit = src.profile.workEligibility.limitedWorkPermissions![0];
  const client = clientFor([
    cite("/workEligibility/Limited work permissions/0/Country", permit.country),
    cite(
      "/workEligibility/Limited work permissions/0/Conditions",
      permit.conditions,
    ),
  ]);
  expect(
    await checkWrittenApplicationAnswers({
      client,
      sources: src,
      payDisclosed: false,
      answers: [
        {
          question: "May you legally work in Switzerland?",
          answer: "Yes",
          evidencePolicy: "eligibility",
        },
      ],
    }),
  ).toMatchObject([{ supported: false }]);
});

test("the sent source catalog retains recorded personal work preferences including travel", () => {
  expect(answerSourceCatalog(sources())).toContainEqual(
    expect.objectContaining({
      id: "profile.workEligibility.willingToTravel",
      value: "Yes",
      purpose: "profile",
    }),
  );
});

test("native decision markers do not change the applicant facts hash between Fill and Send", () => {
  const src = sources();
  src.reusableAnswers[0].applicationScope = {
    resultId: null,
    applicationRecordId: "application_42",
    location: null,
  };
  const original = meaningSourcesHash(src, false);
  src.reusableAnswers[0].applicationScope.currentFieldBinding = {
    pageUrl: "http://127.0.0.1:47950/apply/42",
    targetHash: "a".repeat(64),
    instructionsHash: "b".repeat(64),
  };
  expect(meaningSourcesHash(src, false)).toBe(original);
  src.reusableAnswers[0].answer = "Different real answer";
  expect(meaningSourcesHash(src, false)).not.toBe(original);
});
