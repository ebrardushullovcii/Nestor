import {
  CandidateProfileSchema,
  CandidateReusableAnswerSchema,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import { meaningHash, meaningTargetHash } from "./answer-meaning";
import { answerSourceCatalog } from "./answer-source-catalog";
import { buildApplyFormObservation } from "./page-hands";
import { buildPendingQuestion } from "./policy-executor";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

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

test("the sent source catalog retains recorded personal work preferences including travel", () => {
  expect(answerSourceCatalog(sources())).toContainEqual(
    expect.objectContaining({
      id: "profile.workEligibility.willingToTravel",
      value: "Yes",
      purpose: "profile",
    }),
  );
});
