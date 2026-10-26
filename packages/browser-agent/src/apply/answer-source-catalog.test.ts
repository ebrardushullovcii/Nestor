import {
  CandidateProfileSchema,
  type ApplyAnswerTags,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import { classifyAnswerPermission } from "./answer-source-catalog";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

function source(): ApplyAnswerSources {
  return {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      fullName: "Alex Vanguard",
      yearsExperience: 2,
      baseResume: {
        id: "resume",
        fileName: "resume.txt",
        uploadedAt: "2026-10-01T00:00:00.000Z",
        extractionStatus: "ready",
      },
      currentCountry: "Germany",
      workEligibility: {
        authorizedWorkCountries: ["Germany"],
        requiresVisaSponsorship: false,
      },
    }),
    resumeText: null,
    posting: {
      title: "Engineer",
      company: "Example",
      location: "United Kingdom",
      description: "Build services.",
    },
    reusableAnswers: [],
    documents: [],
  };
}
function control(
  label = "Are you legally authorized to work in this country?",
): ApplyFormControl {
  return {
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
  };
}
function decide(
  sources: ApplyAnswerSources,
  field: ApplyFormControl,
  tags: ApplyAnswerTags | null,
  answer = "Yes",
  controls = [field],
) {
  return classifyAnswerPermission({
    sources,
    control: field,
    controls,
    tags,
    answer,
    pageInstructions: "",
  });
}

test.each([
  ["no classification", null],
  ["no source", { kind: "work_auth", country: "GB", sourceId: null }],
  [
    "wrong country's profile",
    {
      kind: "work_auth",
      country: "GB",
      sourceId: "profile.workEligibility.authorizedWorkCountries.0",
    },
  ],
  [
    "model country disagrees with the posting",
    {
      kind: "work_auth",
      country: "DE",
      sourceId: "profile.workEligibility.authorizedWorkCountries.0",
    },
  ],
  [
    "residence is not work permission",
    { kind: "work_auth", country: "GB", sourceId: "profile.currentCountry" },
  ],
] as const)("decision table: %s goes to Needs you", (_name, tags) => {
  expect(decide(source(), control(), tags).kind).toBe("needs_you");
});

test("unknown and multiple job countries cannot reuse a this-country answer", () => {
  for (const location of ["", "Remote", "Germany and United Kingdom"]) {
    const sources = source();
    sources.posting.location = location;
    expect(
      decide(sources, control(), {
        kind: "work_auth",
        country: "DE",
        sourceId: "profile.workEligibility.authorizedWorkCountries.0",
      }).kind,
    ).toBe("needs_you");
  }
});
test("only the exact, unique question receives unchanged saved text", () => {
  const sources = source(),
    field = control("Your favourite tool?");
  sources.reusableAnswers = [
    {
      id: "saved",
      kind: "other",
      label: "Tool",
      question: field.label,
      answer: "Playwright",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const tags = {
    kind: "preference",
    country: null,
    sourceId: "answerLibrary.saved",
  } as const;
  expect(decide(sources, field, tags, "Playwright").kind).toBe("literal");
  expect(
    decide(sources, field, tags, "Playwright", [field, { ...field, ref: "c1" }])
      .kind,
  ).toBe("needs_you");
  expect(decide(sources, field, tags, "I prefer Playwright").kind).toBe(
    "needs_you",
  );
  sources.reusableAnswers = [
    ...sources.reusableAnswers,
    { ...sources.reusableAnswers[0], id: "conflict", answer: "Other" },
  ];
  expect(decide(sources, field, tags, "Playwright").kind).toBe("needs_you");
});
test("saved legal answers require their own country, not a generic Yes", () => {
  const sources = source(),
    field = control();
  sources.reusableAnswers = [
    {
      id: "saved",
      kind: "work_authorization",
      label: field.label,
      question: field.label,
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
      applicationScope: {
        resultId: null,
        applicationRecordId: null,
        location: "United Kingdom",
      },
    },
  ];
  const tags = {
    kind: "work_auth",
    country: "GB",
    sourceId: "answerLibrary.saved",
  } as const;
  expect(decide(sources, field, tags).kind).toBe("literal");
  sources.reusableAnswers = [
    {
      ...sources.reusableAnswers[0],
      applicationScope: {
        resultId: null,
        applicationRecordId: null,
        location: "Germany",
      },
    },
  ];
  expect(decide(sources, field, tags).kind).toBe("needs_you");
});
test("limited permission is not unconditional authorization or sponsorship", () => {
  const sources = source();
  sources.posting.location = "Germany";
  sources.profile.workEligibility.limitedWorkPermissions = [
    {
      country: "Germany",
      conditions: "20 hours during term",
      requiresFutureSponsorship: true,
    },
  ];
  expect(
    decide(sources, control(), {
      kind: "work_auth",
      country: "DE",
      sourceId: "profile.workEligibility.authorizedWorkCountries.0",
    }).kind,
  ).toBe("needs_you");
});

test("known contact links bind their profile field name, and listing answers bind the recorded source and actual options", () => {
  const sources = source();
  sources.profile.linkedinUrl = "https://profile.example.test/alex";
  expect(
    decide(
      sources,
      control("LinkedIn URL"),
      { kind: "other", country: null, sourceId: "profile.linkedinUrl" },
      sources.profile.linkedinUrl,
    ).kind,
  ).toBe("literal");
  sources.listingDiscovery = {
    label: "Local replica",
    url: "https://listings.example.test/job/1",
  };
  const field = {
    ...control("How did you hear about this job?"),
    kind: "select" as const,
    options: ["Referral", "Other"],
  };
  const tags = {
    kind: "other",
    country: null,
    sourceId: "listingDiscovery",
  } as const;
  expect(decide(sources, field, tags, "Other").kind).toBe("literal");
  expect(decide(sources, field, tags, "Referral").kind).toBe("needs_you");
  expect(decide(sources, { ...field, options: [] }, tags, "Other").kind).toBe(
    "needs_you",
  );
});
test("own-words text is used unchanged from the exact saved question", () => {
  const sources = source(),
    field = control("Responda com suas próprias palavras");
  sources.reusableAnswers = [
    {
      id: "own",
      kind: "other",
      label: field.label,
      question: field.label,
      answer: "My unchanged words.",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const tags = {
    kind: "own_words",
    country: null,
    sourceId: "answerLibrary.own",
  } as const;
  expect(decide(sources, field, tags, "My unchanged words.").kind).toBe(
    "literal",
  );
  expect(decide(sources, field, tags, "Improved generated words.").kind).toBe(
    "needs_you",
  );
  expect(decide(sources, field, tags, " My unchanged words. ").kind).toBe(
    "needs_you",
  );
});
