import {
  CandidateProfileSchema,
  type ApplyAnswerTags,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import { classifyAnswerPermission } from "./answer-source-catalog";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";
import { ownWordsAppliesToQuestion } from "./own-words";

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

test("a host semantic match preserves reference, own-words, country and history guards", () => {
  const sources = source();
  const field = {
    ...control("Contact identity"),
    groupLabel: "Professional reference",
  };
  const run = (
    target: ApplyFormControl,
    kind: ApplyAnswerTags["kind"],
    sourceId: string,
    answer: string,
  ) =>
    classifyAnswerPermission({
      sources,
      control: target,
      controls: [target],
      tags: { kind, sourceId: null, country: "GB" },
      matchedSourceId: sourceId,
      answer,
      pageInstructions: "",
    });
  expect(run(field, "other", "profile.fullName", "Alex Vanguard").kind).toBe(
    "needs_you",
  );
  expect(
    run(
      control("Use your own words"),
      "own_words",
      "profile.fullName",
      "Alex Vanguard",
    ).kind,
  ).toBe("needs_you");
  expect(
    run(
      control(),
      "work_auth",
      "profile.workEligibility.authorizedWorkCountries.0",
      "Yes",
    ).kind,
  ).toBe("needs_you");
  sources.profile = CandidateProfileSchema.parse({
    ...sources.profile,
    experiences: [
      { id: "one", companyName: "First", title: "Engineer" },
      { id: "two", companyName: "Second", title: "Designer" },
    ],
  });
  const title = { ...control("Position"), groupLabel: "Work history 1" };
  const company = {
    ...control("Company"),
    ref: "company",
    groupLabel: "Work history 1",
    value: "First",
  };
  expect(
    classifyAnswerPermission({
      sources,
      control: title,
      controls: [title, company],
      tags: { kind: "other", country: null, sourceId: null },
      matchedSourceId: "profile.experiences.two.title",
      answer: "Designer",
      pageInstructions: "",
    }).kind,
  ).toBe("needs_you");
});

test("plain applicant identity binds to its own exact Profile value when the model omits a source", () => {
  const sources = source();
  sources.profile.firstName = "Alex";
  sources.profile.lastName = "Vanguard";
  sources.profile.email = "alex@example.test";
  const tags = { kind: "other", country: null, sourceId: null } as const;
  for (const [label, value, id] of [
    ["First Name *", "Alex", "profile.firstName"],
    ["Last Name *", "Vanguard", "profile.lastName"],
    ["Full name", "Alex Vanguard", "profile.fullName"],
    ["Email *", "alex@example.test", "profile.email"],
  ]) {
    const field = control(label);
    expect(decide(sources, field, tags, value)).toMatchObject({
      kind: "literal",
      source: { id },
    });
    expect(decide(sources, field, tags, "Different value").kind).toBe(
      "needs_you",
    );
    expect(decide(sources, field, null, value).kind).toBe("needs_you");
    expect(
      classifyAnswerPermission({
        sources,
        control: field,
        controls: [field],
        tags,
        answer: value,
        pageInstructions: "Professional reference",
      }).kind,
    ).toBe("needs_you");
    expect(
      decide(sources, field, { ...tags, kind: "own_words" }, value).kind,
    ).toBe("needs_you");
  }
});

test("Atlas Application ancestors do not reject contact leaves or turn a reference into the applicant", () => {
  const sources = source();
  sources.profile.email = "alex@example.test";
  for (const [label, value] of [
    ["Full name *", "Alex Vanguard"],
    ["Email *", "alex@example.test"],
  ]) {
    const field = {
      ...control(label),
      groupLabel: "Application",
      sectionPath: ["Application"],
    };
    expect(
      decide(
        sources,
        field,
        { kind: "other", sourceId: null, country: null },
        value,
      ).kind,
    ).toBe("literal");
    expect(
      decide(
        sources,
        { ...field, sectionPath: ["Application", "Professional reference"] },
        { kind: "other", sourceId: null, country: null },
        value,
      ).kind,
    ).toBe("needs_you");
  }
});

test("Brindle nested numbered work-history rows retain employer/title/date binding", () => {
  const sources = source();
  sources.profile = CandidateProfileSchema.parse({
    ...sources.profile,
    experiences: [
      {
        id: "one",
        companyName: "First Company",
        title: "Engineer",
        startDate: "2020-01",
      },
      {
        id: "two",
        companyName: "Second Company",
        title: "Designer",
        startDate: "2024-02",
      },
    ],
  });
  const row = (label: string, ref: string, value = "") => ({
    ...control(label),
    ref,
    value,
    groupLabel: "Step 3 of 4: Work history (optional) — Work history 1",
    sectionPath: ["Step 3 of 4: Work history (optional)", "Work history 1"],
  });
  const employer = row("Company", "company", "First Company");
  const title = row("Job title", "title");
  const date = {
    ...row("From", "from"),
    kind: "date" as const,
    dateInputType: "month" as const,
  };
  expect(
    decide(
      sources,
      title,
      {
        kind: "other",
        country: null,
        sourceId: "profile.experiences.one.title",
      },
      "Engineer",
      [employer, title, date],
    ).kind,
  ).toBe("literal");
  expect(
    decide(
      sources,
      date,
      {
        kind: "other",
        country: null,
        sourceId: "profile.experiences.one.startDate",
      },
      "2020-01",
      [employer, title, date],
    ).kind,
  ).toBe("literal");
  expect(
    decide(
      sources,
      title,
      {
        kind: "other",
        country: null,
        sourceId: "profile.experiences.two.title",
      },
      "Designer",
      [employer, title, date],
    ).kind,
  ).toBe("needs_you");
});

test.each([
  ["Are you authorized to work in the job's country?", "work_auth", "Yes"],
  ["Will you need visa sponsorship?", "sponsorship", "No"],
] as const)(
  "replica eligibility meaning binds to the job country: %s",
  (question, kind, answer) => {
    const sources = source();
    sources.posting.location = "Berlin, Germany";
    const yes = {
      ...control("Yes"),
      groupLabel: `Application — ${question}`,
      sectionPath: ["Application", question],
      choiceGroupKey: "eligible",
      kind: "radio" as const,
      answerControlType: "single_choice" as const,
      options: ["Yes", "No"],
    };
    const no = { ...yes, ref: "c1", label: "No" };
    expect(
      decide(
        sources,
        answer === "Yes" ? yes : no,
        { kind, country: "DE", sourceId: null },
        answer,
        [yes, no],
      ).kind,
    ).toBe("literal");
    expect(
      decide(sources, yes, { kind, country: "GB", sourceId: null }, answer, [
        yes,
        no,
      ]).kind,
    ).toBe("needs_you");
    sources.profile.workEligibility.limitedWorkPermissions = [
      {
        country: "Germany",
        conditions: "20 hours during term",
        requiresFutureSponsorship: true,
      },
    ];
    expect(
      decide(sources, yes, { kind, country: "DE", sourceId: null }, answer, [
        yes,
        no,
      ]).kind,
    ).toBe("needs_you");
  },
);

test("a missing identity source does not fill a reference, qualified question or ambiguous target", () => {
  const sources = source();
  const tags = { kind: "other", country: null, sourceId: null } as const;
  for (const field of [
    { ...control("Full name"), groupLabel: "Professional reference" },
    {
      ...control("Full name"),
      hint: "The name of your professional reference",
    },
    { ...control("Full name"), placeholder: "Emergency contact" },
    { ...control("Full name"), groupLabel: "Former legal names" },
    {
      ...control("Full name"),
      hint: "Your name before your most recent change",
    },
  ])
    expect(decide(sources, field, tags, "Alex Vanguard").kind).toBe(
      "needs_you",
    );
  const field = control("Full name");
  expect(
    decide(sources, field, tags, "Alex Vanguard", [
      field,
      { ...field, ref: "c1" },
    ]).kind,
  ).toBe("needs_you");
  sources.profile.fullName = "";
  expect(decide(sources, field, tags, "Alex Vanguard").kind).toBe("needs_you");
});

test("relocation choice groups use the question leaf, and unknown relocation or age stays unknown", () => {
  const sources = source();
  const field = {
    ...control("No"),
    kind: "radio" as const,
    choiceGroupKey: "relocation",
    groupLabel: "Application — Are you willing to relocate?",
    sectionPath: ["Application", "Are you willing to relocate?"],
    options: ["Yes", "No"],
  };
  const tags = {
    kind: "other",
    country: null,
    sourceId: "profile.workEligibility.willingToRelocate",
  } as const;
  expect(decide(sources, field, tags, "No").kind).toBe("needs_you");
  sources.profile.workEligibility.willingToRelocate = false;
  expect(decide(sources, field, tags, "No").kind).toBe("literal");
  expect(
    decide(
      sources,
      {
        ...field,
        groupLabel: "Application — Are you over 18?",
        sectionPath: ["Application", "Are you over 18?"],
      },
      tags,
      "No",
    ).kind,
  ).toBe("needs_you");
});

test.each(["profile.githubUrl", "profile.links.code"])(
  "a requested GitHub username uses the selected account's canonical source: %s",
  (sourceId) => {
    const sources = source();
    sources.profile.githubUrl = "https://github.com/synthetic-alex";
    sources.profile.links = [
      {
        id: "code",
        label: "Code",
        kind: "github",
        url: "https://github.com/synthetic-alex",
        isDraft: false,
      },
    ];
    const field = {
      ...control("GitHub"),
      hint: "Please provide your GitHub username, if you have one.",
      groupLabel: "Personal information",
    };
    for (const id of [sourceId, `${sourceId}#username`]) {
      const decision = decide(
        sources,
        field,
        { kind: "other", country: null, sourceId: id },
        "synthetic-alex",
      );
      expect(decision.kind).toBe("literal");
      if (decision.kind === "literal")
        expect(decision.source.id).toBe(`${sourceId}#username`);
    }
    expect(
      decide(
        sources,
        field,
        { kind: "other", country: null, sourceId: null },
        "synthetic-alex",
      ).kind,
    ).toBe("needs_you");
    expect(
      decide(
        sources,
        field,
        { kind: "other", country: null, sourceId },
        "https://github.com/synthetic-alex",
      ).kind,
    ).toBe("needs_you");
    expect(
      decide(
        sources,
        { ...field, groupLabel: "Professional reference" },
        { kind: "other", country: null, sourceId },
        "synthetic-alex",
      ).kind,
    ).toBe("needs_you");
  },
);

test.each([
  {
    label: "GitHub username",
    hint: "Please provide the full URL of your GitHub profile",
    placeholder: "",
  },
  { label: "GitHub username", hint: "", placeholder: "Full URL" },
  {
    label: "GitHub username",
    hint: "Please do not submit without a URL",
    placeholder: "",
  },
  {
    label: "GitHub username",
    hint: "Do not enter your username instead of a URL",
    placeholder: "",
  },
  { label: "GitHub username URL", hint: "Enter your handle", placeholder: "" },
  {
    label: "Please enter the GitHub username of your professional reference",
    hint: "",
    placeholder: "",
  },
  {
    label: "GitHub username",
    hint: "Please enter the GitHub username of your professional reference",
    placeholder: "",
  },
  {
    label: "GitHub",
    hint: "Please enter your emergency contact's GitHub username",
    placeholder: "",
  },
])(
  "URL and other-person instructions refuse an applicant handle: $label $hint $placeholder",
  (shape) => {
    const sources = source();
    sources.profile.githubUrl = "https://github.com/synthetic-alex";
    const field = { ...control(shape.label), ...shape };
    for (const sourceId of ["profile.githubUrl", "profile.githubUrl#username"])
      expect(
        decide(
          sources,
          field,
          { kind: "other", country: null, sourceId },
          "synthetic-alex",
        ).kind,
      ).toBe("needs_you");
    if (shape.hint.includes("emergency contact"))
      expect(
        decide(
          sources,
          field,
          { kind: "other", country: null, sourceId: "profile.githubUrl" },
          sources.profile.githubUrl,
        ).kind,
      ).toBe("needs_you");
  },
);

test.each(["other", null] as const)(
  "a community account is not a personal GitHub source: %s",
  (kind) => {
    const sources = source();
    sources.profile.githubUrl = "https://github.com/synthetic-alex";
    sources.profile.links = [
      {
        id: "community",
        label: "Open source community organization",
        kind,
        url: "https://github.com/synthetic-community",
        isDraft: false,
      },
    ];
    const field = control("GitHub username");
    for (const sourceId of [
      "profile.links.community",
      "profile.links.community#username",
      "profile.githubUrl",
    ])
      expect(
        decide(
          sources,
          field,
          { kind: "other", country: null, sourceId },
          "synthetic-community",
        ).kind,
      ).toBe("needs_you");
    expect(
      decide(
        sources,
        field,
        { kind: "other", country: null, sourceId: "profile.githubUrl" },
        "synthetic-alex",
      ).kind,
    ).toBe("literal");
  },
);

test.each([
  "Your GitHub username will be shown publicly",
  "Your GitHub handle will be shown publicly",
])("a public-display notice grants no username conversion: %s", (label) => {
  const sources = source();
  sources.profile.githubUrl = "https://github.com/synthetic-alex";
  const tags = {
    kind: "other",
    country: null,
    sourceId: "profile.githubUrl#username",
  } as const;
  expect(decide(sources, control(label), tags, "synthetic-alex").kind).toBe(
    "needs_you",
  );
  const url = control("GitHub URL");
  expect(decide(sources, url, tags, "synthetic-alex").kind).toBe("needs_you");
  expect(
    decide(
      sources,
      url,
      { ...tags, sourceId: "profile.githubUrl" },
      sources.profile.githubUrl,
    ).kind,
  ).toBe("literal");
});

test("a saved negative authorization answer asserts no compatibility with the permit", () => {
  const sources = source();
  sources.profile.workEligibility.limitedWorkPermissions = [
    {
      country: "United Kingdom",
      conditions: "Maximum 20 hours per week",
      requiresFutureSponsorship: false,
    },
  ];
  sources.posting.description = "This role requires 40 hours per week.";
  const field = control("Are you authorized to work in the UK?");
  sources.reusableAnswers = [
    {
      id: "legal",
      question: field.label,
      label: field.label,
      kind: "other",
      answer: "No",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const tags = {
    kind: "work_auth",
    country: "GB",
    sourceId: "answerLibrary.legal",
  } as const;
  expect(decide(sources, field, tags, "No").kind).toBe("literal");
  sources.reusableAnswers[0].answer = "Yes";
  expect(decide(sources, field, tags).kind).toBe("needs_you");
});

test.each([
  ["Are you authorized to work in the UK?", "literal"],
  ["Are you legally eligible to work in the UK?", "literal"],
  ["Are you eligible to work in the UK?", "literal"],
  ["Do you have the right to work in the UK?", "literal"],
  [
    "Do you have any restrictions on your right to work in the UK?",
    "needs_you",
  ],
  ["Do you have any limitations on your right to work in the UK?", "needs_you"],
  ["Are you authorized to work in the UK without restrictions?", "needs_you"],
  ["Are you authorized to work in the UK without sponsorship?", "needs_you"],
  ["Do you require sponsorship to work in the UK?", "needs_you"],
])(
  "a saved No skips permit compatibility only when denying authorization: %s",
  (label, expected) => {
    const sources = source();
    sources.profile.workEligibility.limitedWorkPermissions = [
      {
        country: "United Kingdom",
        conditions: "Maximum 20 hours per week",
        requiresFutureSponsorship: false,
      },
    ];
    sources.posting.description = "This role requires 40 hours per week.";
    const field = control(label);
    sources.reusableAnswers = [
      {
        id: "legal",
        question: label,
        label,
        kind: "other",
        answer: "No",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    expect(
      decide(
        sources,
        field,
        {
          kind: "work_auth",
          country: "GB",
          sourceId: "answerLibrary.legal",
        },
        "No",
      ).kind,
    ).toBe(expected);
  },
);

test.each([
  ["Start date (MM/YYYY)", "January 2024", "01/2024", "literal"],
  ["Start date (DD/MM/YYYY)", "2024-01-15", "15/01/2024", "literal"],
  ["Start date (DD/MM/YYYY)", "January 2024", "01/01/2024", "needs_you"],
  ["Start date (MM/YYYY)", "2024-01-15", "2024-01-15", "needs_you"],
  ["Start date (DD/MM/YYYY)", "2024-01-15", "01/15/2024", "needs_you"],
])(
  "recorded dates keep precision and the requested format: %s",
  (label, recorded, answer, expected) => {
    const sources = source();
    sources.profile = CandidateProfileSchema.parse({
      ...sources.profile,
      experiences: [
        {
          id: "job",
          companyName: "Example",
          title: "Engineer",
          startDate: recorded,
        },
      ],
    });
    const field = { ...control(label), groupLabel: "Employment history" };
    expect(
      decide(
        sources,
        field,
        {
          kind: "other",
          country: null,
          sourceId: "profile.experiences.job.startDate",
        },
        answer,
      ).kind,
    ).toBe(expected);
  },
);

test("only a classified, fact-free motivation can proceed without a source", () => {
  const sources = source(),
    field = control("Why do you want to join us?");
  const tags = { kind: "motivation", country: null, sourceId: null } as const;
  expect(
    decide(sources, field, tags, "I am excited about this opportunity.").kind,
  ).toBe("writing");
  expect(
    decide(
      sources,
      field,
      tags,
      "I am excited about already holding a valid driving licence.",
    ).kind,
  ).toBe("needs_you");
  expect(
    decide(
      sources,
      field,
      { ...tags, kind: "preference" },
      "I am excited about this opportunity.",
    ).kind,
  ).toBe("needs_you");
  expect(
    classifyAnswerPermission({
      control: field,
      controls: [field],
      tags,
      sources,
      answer: "I am excited about this opportunity.",
      pageInstructions: "Write this yourself",
    }).kind,
  ).toBe("needs_you");
});

test.each([
  ["City", "profile.currentCity", "London"],
  ["Country of residence", "profile.currentCountry", "Germany"],
  ["Total years of experience", "profile.yearsExperience", "2"],
  [
    "Notice period in days",
    "profile.workEligibility.noticePeriodDays",
    "30 days",
  ],
  [
    "Are you willing to relocate?",
    "profile.workEligibility.willingToRelocate",
    "Yes",
  ],
  ["School", "profile.education.school.schoolName", "Example University"],
])(
  "an explicit profile source answers the literal field %s",
  (label, sourceId, answer) => {
    const sources = source();
    sources.profile.currentCity = "London";
    sources.profile.workEligibility.noticePeriodDays = 30;
    sources.profile.workEligibility.willingToRelocate = true;
    sources.profile = CandidateProfileSchema.parse({
      ...sources.profile,
      education: [{ id: "school", schoolName: "Example University" }],
    });
    const field = {
      ...control(label),
      groupLabel: label === "School" ? "Education" : "",
    };
    expect(
      decide(sources, field, { kind: "other", country: null, sourceId }, answer)
        .kind,
    ).toBe("literal");
    expect(
      decide(
        sources,
        field,
        { kind: "other", country: null, sourceId: null },
        answer,
      ).kind,
    ).toBe("needs_you");
  },
);

test.each(["Months", "Weeks", "", "Days or months"])(
  "a stored day count cannot fill a notice field with unit %s",
  (placeholder) => {
    const sources = source();
    sources.profile.workEligibility.noticePeriodDays = 30;
    const field = { ...control("Notice period"), placeholder };
    const tags = {
      kind: "other",
      country: null,
      sourceId: "profile.workEligibility.noticePeriodDays",
    } as const;
    expect(decide(sources, field, tags, "30").kind).toBe("needs_you");
    expect(decide(sources, field, tags, "30 days").kind).toBe("needs_you");
  },
);

test("a shared job title follows the employer on this entry, and its recorded date can be formatted", () => {
  const sources = source();
  sources.profile = CandidateProfileSchema.parse({
    ...sources.profile,
    experiences: [
      {
        id: "old",
        companyName: "Old Company",
        title: "Engineer",
        startDate: "January 2020",
      },
      {
        id: "new",
        companyName: "New Company",
        title: "Engineer",
        startDate: "January 2024",
      },
    ],
  });
  const employer = {
    ...control("Company"),
    groupLabel: "Work experience",
    value: "New Company",
    ref: "company",
  };
  const title = { ...control("Job title"), groupLabel: "Work experience" };
  const decision = decide(
    sources,
    title,
    { kind: "other", country: null, sourceId: "profile.experiences.old.title" },
    "Engineer",
    [employer, title],
  );
  expect(decision.kind).toBe("literal");
  if (decision.kind === "literal")
    expect(decision.source.id).toBe("profile.experiences.new.title");
  const date = {
    ...control("Start date"),
    groupLabel: "Work experience",
    kind: "date" as const,
  };
  const tags = {
    kind: "other",
    country: null,
    sourceId: "profile.experiences.new.startDate",
  } as const;
  expect(decide(sources, date, tags, "2024-01", [employer, date]).kind).toBe(
    "literal",
  );
  expect(decide(sources, date, tags, "2024-01-01", [employer, date]).kind).toBe(
    "needs_you",
  );
});

test.each([
  [
    "Are you legally eligible to work in the United Kingdom?",
    "work_auth",
    "profile.workEligibility.authorizedWorkCountries.0",
    "Yes",
  ],
  [
    "Will you now or in the future require sponsorship for employment visa status?",
    "sponsorship",
    "profile.workEligibility.requiresVisaSponsorship.GB",
    "No",
  ],
] as const)(
  "standard legal wording reuses its country-bound fact: %s",
  (label, kind, sourceId, answer) => {
    const sources = source();
    sources.profile.workEligibility.authorizedWorkCountries = [
      "United Kingdom",
    ];
    expect(
      decide(sources, control(label), { kind, country: "GB", sourceId }, answer)
        .kind,
    ).toBe("literal");
  },
);

test.each(["consent", "acknowledgement", "personal_fact"] as const)(
  "routine declaration meaning: %s",
  (purpose) => {
    const field = {
      ...control(
        "I hereby certify that all information provided in this application is true and complete to the best of my knowledge",
      ),
      kind: "checkbox" as const,
      attestationKind: "truthfulness_certification" as const,
    };
    const result = classifyAnswerPermission({
      control: field,
      controls: [field],
      tags: {
        kind: "other",
        country: null,
        sourceId: null,
        declarationPurpose: purpose,
      },
      sources: source(),
      answer: "Yes",
      pageInstructions: "",
      approvedAttestations: ["truthfulness_certification"],
    });
    expect(result.kind).toBe(
      purpose === "personal_fact" ? "needs_you" : "literal",
    );
  },
);

test("a cover-letter own-words rule keeps its scope", () => {
  const sources = source(),
    field = control("Why do you want to join this company?");
  const input = {
    control: field,
    controls: [field],
    tags: {
      kind: "motivation",
      country: null,
      sourceId: "posting.description",
    } as const,
    sources,
    answer: "I am excited to build services.",
    pageInstructions: "Write your cover letter in your own words.",
  };
  expect(classifyAnswerPermission(input).kind).toBe("writing");
  expect(
    classifyAnswerPermission({
      ...input,
      pageInstructions: "Write all answers in your own words.",
    }).kind,
  ).toBe("needs_you");
  expect(
    ownWordsAppliesToQuestion(input.pageInstructions, "Cover letter"),
  ).toBe(true);
});

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

test("a limited permit must fit the job hours and future sponsorship remains affirmative", () => {
  const sources = source();
  sources.posting.location = "Germany";
  sources.posting.description = "This role requires 20 hours per week.";
  sources.profile.workEligibility.limitedWorkPermissions = [
    {
      country: "Germany",
      conditions: "Maximum 20 hours per week",
      requiresFutureSponsorship: true,
    },
  ];
  expect(
    decide(
      sources,
      control("Are you authorized to work in the job's country?"),
      { kind: "work_auth", country: "DE", sourceId: null },
      "Yes",
    ).kind,
  ).toBe("literal");
  const sponsorship = control("Will you need visa sponsorship?");
  expect(
    decide(
      sources,
      sponsorship,
      { kind: "sponsorship", country: "DE", sourceId: null },
      "No",
    ).kind,
  ).toBe("needs_you");
  expect(
    decide(
      sources,
      sponsorship,
      { kind: "sponsorship", country: "DE", sourceId: null },
      "Yes",
    ).kind,
  ).toBe("literal");
  sources.posting.description = "This role requires 40 hours per week.";
  expect(
    decide(
      sources,
      control(),
      { kind: "work_auth", country: "DE", sourceId: null },
      "Yes",
    ).kind,
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
test.each([
  ["Local job board", "https://listings.example.test/jobs/1", "Job board"],
  ["Company careers page", "https://example.test/jobs/1", "Company website"],
  ["Example", "https://example.test/careers/", "Other"],
  ["Example", "https://example.test/board/", "Other"],
])(
  "maps recorded listing provenance onto the form options: %s",
  (label, url, answer) => {
    const sources = source();
    sources.listingDiscovery = { label, url };
    const field = {
      ...control("How did you hear about this job?"),
      kind: "select" as const,
      options: ["Job board", "Company website", "Referral", "Other"],
    };
    const tags = {
      kind: "other",
      country: null,
      sourceId: "listingDiscovery",
    } as const;
    expect(decide(sources, field, tags, answer).kind).toBe("literal");
    expect(decide(sources, field, tags, "Referral").kind).toBe("needs_you");
  },
);

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
