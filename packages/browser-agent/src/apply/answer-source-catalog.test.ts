import {
  CandidateProfileSchema,
  type ApplyAnswerTags,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import {
  applicantLiteralSource,
  classifyAnswerPermission,
  duplicatedHistoryRows,
  answerSourceCatalog,
  legalQuestionCountry,
} from "./answer-source-catalog";
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

test("a resolved listing country supports generic legal questions but cannot override an explicit question country", () => {
  const sources = source();
  sources.posting = {
    ...sources.posting,
    location: "Austin, TX",
    resolvedCountry: "US",
  };
  const catalog = answerSourceCatalog(sources);
  expect(
    legalQuestionCountry("Are you authorized to work here?", catalog),
  ).toBe("US");
  expect(
    legalQuestionCountry("Are you authorized to work in Canada?", catalog),
  ).toBe("CA");
  sources.posting = {
    ...sources.posting,
    location: "Remote",
    resolvedCountry: null,
  };
  expect(
    legalQuestionCountry(
      "Are you authorized to work here?",
      answerSourceCatalog(sources),
    ),
  ).toBeNull();
  expect(
    legalQuestionCountry(
      "Are you authorized to work in Germany?",
      answerSourceCatalog(sources),
    ),
  ).toBe("DE");
});
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
  "Full name",
  "First name",
  "Legal first name",
  "Last name",
  "Legal last name",
  "Email",
])(
  "an unread or repeated applicant literal still binds exactly: %s",
  (label) => {
    const sources = source();
    sources.profile.firstName = "Alex";
    sources.profile.lastName = "Vanguard";
    sources.profile.email = "alex@example.test";
    const field = {
      ...control(label),
      groupLabel: "Contact details",
      repeatedQuestion: {
        prompt: `${label} (repeated question on step 2)`,
        step: "2",
      },
    };
    const value = /first/i.test(label)
      ? "Alex"
      : /last/i.test(label)
        ? "Vanguard"
        : label === "Email"
          ? "alex@example.test"
          : "Alex Vanguard";
    expect(decide(sources, field, null, value).kind).toBe("literal");
    field.groupLabel = "Employment history — Work history 2";
    expect(decide(sources, field, null, value).kind).toBe("needs_you");
  },
);

test.each([
  "Preferred name",
  "Supervisor name",
  "Reference full name",
  "Name as on passport",
])("unread %s does not borrow the applicant name", (label) => {
  expect(decide(source(), control(label), null, "Alex Vanguard").kind).toBe(
    "needs_you",
  );
});

// Batch-1 review P1: the unread-identity fallback must honour instructions
// that live only in the page text.
test.each([
  ["Enter your reference's full name.", "needs_you"],
  ["Enter your supervisor’s full name.", "needs_you"],
  ["Enter the full name of the person who referred you.", "needs_you"],
  ["Enter your referrer's full name.", "needs_you"],
  [
    "Your supervisor will review the application. Enter your full name.",
    "literal",
  ],
  ["Full name exactly as it appears on your passport.", "needs_you"],
  ["Please fill in your contact details.", "literal"],
] as const)(
  "an unread plain Full name follows the page's instruction: %s",
  (pageInstructions, expected) => {
    const sources = source();
    const field = { ...control("Full name"), groupLabel: "Contact details" };
    const decision = classifyAnswerPermission({
      sources,
      control: field,
      controls: [field],
      tags: null,
      answer: "Alex Vanguard",
      pageInstructions,
    });
    expect(decision.kind).toBe(expected);
    // The repeated-step guard is lifted only by the same binding.
    expect(
      applicantLiteralSource(
        { ...field, repeatedQuestion: { prompt: "Full name", step: "2" } },
        [field],
        sources,
        pageInstructions,
      ) !== null,
    ).toBe(expected === "literal");
  },
);

test("a nested scalar history fact remains literal when classified as a factual account", () => {
  const sources = source();
  sources.profile = CandidateProfileSchema.parse({
    ...sources.profile,
    experiences: [
      {
        id: "role",
        companyName: "Signal Systems",
        title: "Staff Frontend Engineer",
        startDate: "2014-01",
        isCurrent: true,
      },
    ],
  });
  const field = {
    ...control("Job title"),
    groupLabel: "Work history (optional) — Work history 1",
    sectionPath: ["Application", "Work history (optional)", "Work history 1"],
    rowScopeKey: "form0:row1",
  };
  const tags = {
    kind: "factual_summary",
    country: null,
    sourceId: "profile.experiences.role.title",
  } as const;
  expect(decide(sources, field, tags, "Staff Frontend Engineer").kind).toBe(
    "literal",
  );
  expect(
    decide(
      sources,
      { ...field, groupLabel: "Professional reference" },
      tags,
      "Staff Frontend Engineer",
    ).kind,
  ).toBe("needs_you");
});

test("an unknown age goes to the fact check instead of literal permission", () => {
  expect(
    decide(source(), control("Are you over 18?"), {
      kind: "other",
      country: null,
      sourceId: null,
    }),
  ).toMatchObject({ kind: "inference", evidencePolicy: "factual_inference" });
});

test("the classified meaning retains additional legal conditions in another language", () => {
  const sources = source();
  sources.posting.location = "Germany";
  expect(
    decide(
      sources,
      control(
        "Dürfen Sie dauerhaft und uneingeschränkt in Deutschland arbeiten?",
      ),
      {
        kind: "work_auth",
        country: "DE",
        sourceId: "profile.workEligibility.authorizedWorkCountries.0",
        hasAdditionalConditions: true,
      },
    ).kind,
  ).toBe("needs_you");
});

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

// Captured ledgerleaf receipt (candidate 2, 2026-11-03): work1 and work2 were
// both "Staff Frontend Engineer / Signal Systems / 2021-03", one Profile record
// in two rows. Rows bind by what they hold, never by order (council D2).
describe("history rows and Profile records", () => {
  const twoJobs = () => {
    const sources = source();
    sources.profile = CandidateProfileSchema.parse({
      ...sources.profile,
      experiences: [
        {
          id: "signal",
          companyName: "Signal Systems",
          title: "Staff Frontend Engineer",
          startDate: "2021-03",
          isCurrent: true,
        },
        {
          id: "copper",
          companyName: "Copper Finch Software",
          title: "Software Engineer",
          startDate: "2016-01",
          endDate: "2021-02",
        },
      ],
    });
    return sources;
  };
  const rowControls = (row: 1 | 2, values: [string, string, string]) =>
    (["Job title", "Company", "From"] as const).map((label, index) => ({
      ...control(label),
      ref: `w${row}${index}`,
      groupLabel: `Work history (optional) — Work history ${row}`,
      sectionPath: ["Work history (optional)", `Work history ${row}`],
      rowScopeKey: `row${row}`,
      scopeKey: "form0",
      ...(label === "From"
        ? { kind: "date" as const, dateInputType: "month" as const }
        : {}),
      value: values[index] ?? "",
    }));
  const fill = (
    sources: ReturnType<typeof source>,
    field: ApplyFormControl,
    controls: ApplyFormControl[],
    record: string,
    answer: string,
  ) =>
    classifyAnswerPermission({
      sources,
      control: field,
      controls,
      tags: {
        kind: "other",
        country: null,
        sourceId: `profile.experiences.${record}.companyName`,
      },
      answer,
      pageInstructions: "",
    }).kind;

  test("a record another row holds never fills a second row; the other record does", () => {
    const sources = twoJobs();
    const first = rowControls(1, [
      "Staff Frontend Engineer",
      "Signal Systems",
      "2021-03",
    ]);
    const second = rowControls(2, ["", "", ""]);
    const [, company] = second;
    if (!company) throw new Error("row 2 has a Company field");
    expect(
      classifyAnswerPermission({
        sources,
        control: company,
        controls: [...first, ...second],
        tags: {
          kind: "other",
          country: null,
          sourceId: "profile.experiences.signal.companyName",
        },
        answer: "Signal Systems",
        pageInstructions: "",
      }),
    ).toMatchObject({ kind: "needs_you", check: "history_record_in_use" });
    expect(
      fill(
        sources,
        company,
        [...first, ...second],
        "copper",
        "Copper Finch Software",
      ),
    ).toBe("literal");
    // With no other row holding it, the first record fills normally.
    expect(fill(sources, company, second, "signal", "Signal Systems")).toBe(
      "literal",
    );
  });

  test("the Send check names rows holding the same single record, and only those", () => {
    const sources = twoJobs();
    const duplicate = [
      ...rowControls(1, [
        "Staff Frontend Engineer",
        "Signal Systems",
        "2021-03",
      ]),
      ...rowControls(2, [
        "Staff Frontend Engineer",
        "Signal Systems",
        "2021-03",
      ]),
    ];
    expect(duplicatedHistoryRows(duplicate, sources)).toEqual([
      "Work history 1",
      "Work history 2",
    ]);
    const distinct = [
      ...rowControls(1, [
        "Staff Frontend Engineer",
        "Signal Systems",
        "2021-03",
      ]),
      ...rowControls(2, [
        "Software Engineer",
        "Copper Finch Software",
        "2016-01",
      ]),
    ];
    expect(duplicatedHistoryRows(distinct, sources)).toEqual([]);
    // An empty optional row, or one the person typed that no record is,
    // is not a duplicate.
    expect(
      duplicatedHistoryRows(
        [
          ...rowControls(1, [
            "Staff Frontend Engineer",
            "Signal Systems",
            "2021-03",
          ]),
          ...rowControls(2, ["", "", ""]),
        ],
        sources,
      ),
    ).toEqual([]);
    expect(
      duplicatedHistoryRows(
        [
          ...rowControls(1, [
            "Staff Frontend Engineer",
            "Signal Systems",
            "2021-03",
          ]),
          ...rowControls(2, ["Volunteer", "Local Library", "2014-05"]),
        ],
        sources,
      ),
    ).toEqual([]);
  });

  test("applicant identity never fills a field inside a history or reference row", () => {
    const sources = twoJobs();
    for (const section of ["Work history 1", "Professional reference"]) {
      const field = {
        ...control("Full name"),
        groupLabel: section,
        sectionPath: [section],
        rowScopeKey: "row1",
      };
      expect(
        classifyAnswerPermission({
          sources,
          control: field,
          controls: [field],
          tags: null,
          answer: "Alex Vanguard",
          pageInstructions: "",
        }).kind,
      ).toBe("needs_you");
    }
  });
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
    expect(decide(sources, field, tags, "Different value").kind).not.toBe(
      "literal",
    );
    // A classifier outage is not a question for a fact Profile holds.
    expect(decide(sources, field, null, value).kind).toBe("literal");
    expect(decide(sources, field, null, "Different value").kind).toBe(
      "needs_you",
    );
    expect(
      classifyAnswerPermission({
        sources,
        control: field,
        controls: [field],
        tags,
        answer: value,
        pageInstructions: "Professional reference",
      }).kind,
    ).not.toBe("literal");
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
    expect(decide(sources, field, tags, "Alex Vanguard").kind).not.toBe(
      "literal",
    );
  const field = control("Full name");
  expect(
    decide(sources, field, tags, "Alex Vanguard", [
      field,
      { ...field, ref: "c1" },
    ]).kind,
  ).toBe("needs_you");
  sources.profile.fullName = "";
  expect(decide(sources, field, tags, "Alex Vanguard").kind).not.toBe(
    "literal",
  );
});

test("relocation choice groups use the question leaf; unknown facts have no literal permission", () => {
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
  expect(decide(sources, field, tags, "No").kind).not.toBe("literal");
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
  ).not.toBe("literal");
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
    ).not.toBe("literal");
    expect(
      decide(
        sources,
        field,
        { kind: "other", country: null, sourceId },
        "https://github.com/synthetic-alex",
      ).kind,
    ).not.toBe("literal");
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
      ).not.toBe("literal");
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
      ).not.toBe("literal");
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
  expect(decide(sources, control(label), tags, "synthetic-alex").kind).not.toBe(
    "literal",
  );
  const url = control("GitHub URL");
  expect(decide(sources, url, tags, "synthetic-alex").kind).not.toBe("literal");
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
    ).toBe(expected === "needs_you" ? "inference" : expected);
  },
);

// Captured on the harbor-health replica (2026-11-03): "Availability —
// Preferred start date *" (a date input) was gated as an opinion and asked,
// although Profile records availableStartDate.
test.each(["other", "preference"] as const)(
  "a preferred start date is the recorded availability, not an opinion (read as %s)",
  (kind) => {
    const sources = source();
    sources.profile.workEligibility.availableStartDate = "2026-12-01";
    const field: ApplyFormControl = {
      ...control("Preferred start date *"),
      kind: "date",
      answerControlType: "date",
      groupLabel: "Availability",
    };
    const tags = {
      kind,
      country: null,
      sourceId: "profile.workEligibility.availableStartDate",
    };
    expect(decide(sources, field, tags, "2026-12-01").kind).toBe("literal");
    expect(decide(sources, field, tags, "2026-11-15").kind).toBe("needs_you");
  },
);

test.each([
  ["What is your preferred work location?", "text", "Berlin"],
  ["What is your preferred language?", "text", "English"],
  ["Preferred interview date", "date", "2026-12-01"],
] as const)(
  "other preferred questions stay the person's: %s",
  (label, kind, answer) => {
    const sources = source();
    sources.profile.workEligibility.availableStartDate = "2026-12-01";
    const field: ApplyFormControl = {
      ...control(label),
      kind,
      answerControlType: kind,
    };
    expect(
      decide(
        sources,
        field,
        {
          kind: "preference",
          country: null,
          sourceId: "profile.workEligibility.availableStartDate",
        },
        answer,
      ).kind,
    ).toBe("needs_you");
  },
);

// Captured on the workday replica (2026-11-03): "Which technical skills would
// you bring? *" was asked although every listed skill is in Profile.
test("a skills question is answered from the recorded skills list, verbatim only", () => {
  const sources = source();
  sources.profile = CandidateProfileSchema.parse({
    ...sources.profile,
    skills: ["React", "TypeScript", "Mentoring"],
  });
  const tags = { kind: "other", country: null, sourceId: null } as const;
  const bring = {
    ...control("Which technical skills would you bring? *"),
    groupLabel: "Application Questions",
  };
  expect(
    decide(sources, bring, tags, "React, TypeScript, Mentoring"),
  ).toMatchObject({
    kind: "literal",
    source: { id: "profile.skills" },
  });
  // An unrecorded skill is never vouched for.
  expect(decide(sources, bring, tags, "React, Kubernetes").kind).not.toBe(
    "literal",
  );
  // Opinion and own-words wording, and another person's skills, stay gated.
  for (const label of [
    "What is your top skill?",
    "Which skills do you enjoy using most?",
    "Describe, in your own words, the skills you would bring",
    "Which skills would your reference say you have?",
  ])
    expect(decide(sources, control(label), tags, "React").kind).not.toBe(
      "literal",
    );
  expect(
    decide(sources, bring, { ...tags, kind: "preference" }, "React").kind,
  ).toBe("needs_you");
});

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
    ).not.toBe("literal");
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
    expect(decide(sources, field, tags, "30").kind).not.toBe("literal");
    expect(decide(sources, field, tags, "30 days").kind).not.toBe("literal");
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

// Council D6: the job's country comes from the question or the listing,
// never from Remote, a bare city or the Profile's own permits; the
// countries where the person may work are a complete list (ADR 0029).
describe("D6 job country and eligibility answers", () => {
  const eligible = (
    location: string,
    workEligibility: Partial<
      ApplyAnswerSources["profile"]["workEligibility"]
    > = {},
  ) => {
    const sources = source();
    sources.posting.location = location;
    sources.profile.workEligibility = {
      ...sources.profile.workEligibility,
      authorizedWorkCountries: ["Germany"],
      requiresVisaSponsorship: false,
      limitedWorkPermissions: [],
      ...workEligibility,
    };
    return sources;
  };
  const auth = (
    sources: ApplyAnswerSources,
    question: string,
    answer: string,
    country: string | null,
    hasAdditionalConditions?: boolean,
  ) =>
    decide(
      sources,
      control(question),
      {
        kind: "work_auth",
        country,
        sourceId: "profile.workEligibility.authorizedWorkCountries.0",
        ...(hasAdditionalConditions === undefined
          ? {}
          : { hasAdditionalConditions }),
      },
      answer,
    ).kind;
  const jobCountry = "Are you authorized to work in the job's country?";

  test("one known country: every city in it is answered from Profile", () => {
    for (const location of ["Berlin, Germany", "Munich, Germany"])
      expect(auth(eligible(location), jobCountry, "Yes", "DE")).toBe("literal");
    // A question naming the country settles it even on a Remote listing.
    expect(
      auth(
        eligible("Remote"),
        "Are you authorized to work in Germany?",
        "Yes",
        "DE",
      ),
    ).toBe("literal");
  });

  test("Remote, a bare city or several permits never pick a country", () => {
    expect(auth(eligible("Remote"), jobCountry, "Yes", "DE")).toBe("needs_you");
    expect(
      auth(
        eligible("Remote", { authorizedWorkCountries: ["Germany", "Kosovo"] }),
        jobCountry,
        "Yes",
        "DE",
      ),
    ).toBe("needs_you");
    expect(auth(eligible("Berlin"), jobCountry, "Yes", "DE")).toBe("needs_you");
  });

  test("a resolved country the complete list does not cover is a No; doubt still asks", () => {
    expect(auth(eligible("Paris, France"), jobCountry, "No", "FR")).toBe(
      "literal",
    );
    // Never a Yes for it, and never a No when the list names a region, a
    // limited permit covers it, or the question adds conditions.
    expect(auth(eligible("Paris, France"), jobCountry, "Yes", "FR")).toBe(
      "needs_you",
    );
    expect(
      auth(
        eligible("Paris, France", {
          authorizedWorkCountries: ["European Union"],
        }),
        jobCountry,
        "No",
        "FR",
      ),
    ).not.toBe("literal");
    expect(
      auth(
        eligible("Paris, France", {
          limitedWorkPermissions: [
            {
              country: "France",
              conditions: "Student work only",
              requiresFutureSponsorship: null,
            },
          ],
        }),
        jobCountry,
        "No",
        "FR",
      ),
    ).not.toBe("literal");
    expect(
      auth(eligible("Paris, France"), jobCountry, "No", "FR", true),
    ).not.toBe("literal");
    // An unresolved country never becomes a No.
    expect(auth(eligible("Remote"), jobCountry, "No", null)).not.toBe(
      "literal",
    );
  });

  test("'without sponsorship' follows the recorded sponsorship fact; other conditions ask", () => {
    const question =
      "Are you authorized to work in Germany without sponsorship?";
    expect(auth(eligible("Berlin, Germany"), question, "Yes", "DE", true)).toBe(
      "literal",
    );
    expect(
      auth(
        eligible("Berlin, Germany", { requiresVisaSponsorship: true }),
        question,
        "Yes",
        "DE",
        true,
      ),
    ).toBe("needs_you");
    expect(
      auth(
        eligible("Berlin, Germany", { requiresVisaSponsorship: null }),
        question,
        "Yes",
        "DE",
        true,
      ),
    ).toBe("needs_you");
    expect(
      auth(
        eligible("Berlin, Germany", {
          limitedWorkPermissions: [
            {
              country: "Germany",
              conditions: "Up to 20 hours per week",
              requiresFutureSponsorship: false,
            },
          ],
        }),
        question,
        "Yes",
        "DE",
        true,
      ),
    ).toBe("needs_you");
    for (const wording of [
      "Are you authorized to work in Germany without restrictions?",
      "Are you permanently authorized to work in Germany without sponsorship?",
    ])
      expect(
        auth(eligible("Berlin, Germany"), wording, "Yes", "DE", true),
      ).toBe("needs_you");
    // On an unresolved Remote listing it still asks.
    expect(
      auth(
        eligible("Remote"),
        "Are you authorized to work in this country without sponsorship?",
        "Yes",
        "DE",
        true,
      ),
    ).toBe("needs_you");
  });

  test("a person's answer under a limited permit stays with that application", () => {
    const sources = eligible("Berlin, Germany", {
      authorizedWorkCountries: [],
      limitedWorkPermissions: [
        {
          country: "Germany",
          conditions: "Up to 20 hours per week",
          requiresFutureSponsorship: false,
        },
      ],
    });
    sources.posting.description = "This role requires 40 hours per week.";
    const field = control(jobCountry);
    const saved = (applicationRecordId: string | null) => ({
      id: applicationRecordId ? "application_7" : "remembered_7",
      kind: "work_authorization" as const,
      label: field.label,
      question: field.label,
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
      applicationScope: {
        resultId: null,
        applicationRecordId,
        location: "Berlin, Germany",
      },
    });
    const tags = { kind: "work_auth", country: "DE", sourceId: null } as const;
    sources.reusableAnswers = [saved(null)];
    expect(decide(sources, field, tags, "Yes").kind).toBe("needs_you");
    sources.reusableAnswers = [saved("application_1")];
    expect(
      classifyAnswerPermission({
        sources,
        control: field,
        controls: [field],
        tags,
        answer: "Yes",
        pageInstructions: "",
        application: {
          jobId: "1",
          applicationId: "application_1_attempt_2",
          resultId: "application_1_attempt_2",
          applicationRecordId: "application_1",
          startingUrl: "https://replica.test",
        },
      }).kind,
    ).toBe("literal");
  });
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

test("total experience brackets format the recorded total without lending it to a skill", () => {
  const sources = source();
  sources.profile.yearsExperience = 8;
  const field = {
    ...control("Years of Experience*"),
    kind: "select" as const,
    options: ["0-2", "3-5", "6-10", "11+", "7 or more years"],
  };
  const tags = {
    kind: "other",
    country: null,
    sourceId: "profile.yearsExperience",
  } as const;
  expect(decide(sources, field, tags, "6-10").kind).toBe("literal");
  expect(decide(sources, field, tags, "7 or more years").kind).toBe("literal");
  for (const answer of ["3-5", "11+", "7-9"])
    expect(decide(sources, field, tags, answer).kind).not.toBe("literal");
  expect(
    decide(
      sources,
      { ...field, label: "Years of Rust experience" },
      tags,
      "6-10",
    ).kind,
  ).not.toBe("literal");
});

test("country of residence selects the legal jurisdiction but never proves permission", () => {
  const sources = source();
  sources.posting.location = "EMEA Remote";
  const field = control("Are you authorized to work in country of residence?*");
  const tags = { kind: "work_auth", country: "DE", sourceId: null } as const;
  expect(decide(sources, field, tags).kind).toBe("literal");
  sources.profile.workEligibility.authorizedWorkCountries = [];
  expect(decide(sources, field, tags).kind).toBe("needs_you");
});

test("an explicit saved international phone supplies its code, not residence or another person's code", () => {
  const sources = source();
  sources.profile.phone = "+49 555 0000000";
  sources.profile.currentCountry = "Portugal";
  const field = {
    ...control("Phone country code"),
    kind: "select" as const,
    options: ["+1", "+44", "+49", "+351"],
  };
  const tags = {
    kind: "other",
    country: null,
    sourceId: "profile.phone#callingCode",
  } as const;
  expect(decide(sources, field, tags, "+49").kind).toBe("literal");
  expect(decide(sources, field, tags, "+351").kind).not.toBe("literal");
  expect(
    decide(
      sources,
      { ...field, groupLabel: "Professional reference" },
      tags,
      "+49",
    ).kind,
  ).toBe("needs_you");
  sources.profile.phone = "0555 0000000";
  expect(decide(sources, field, tags, "+49").kind).not.toBe("literal");
});

test("explicit residence country can be read from a saved full location, never from the city alone", () => {
  const sources = source();
  sources.profile.currentCountry = null;
  sources.profile.currentLocation = "Lisbon, Portugal";
  sources.profile.workEligibility.authorizedWorkCountries = ["Portugal"];
  sources.posting.location = "EMEA Remote";
  const field = control("Are you authorized to work in country of residence?");
  const tags = { kind: "work_auth", country: "PT", sourceId: null } as const;
  expect(decide(sources, field, tags).kind).toBe("literal");
  sources.profile.currentLocation = "Lisbon";
  expect(decide(sources, field, tags).kind).toBe("needs_you");
});

// Candidate 2: after "My answers are true" was turned off, the certify box was
// asked with "There is no matching verbatim source". It is the person's
// declaration to confirm, and the reason says why.
test("an unapproved declaration says it is the person's to confirm, and is never ticked", () => {
  const field: ApplyFormControl = {
    ...control("I certify that the information is true *"),
    kind: "checkbox",
    answerControlType: "boolean",
    groupLabel: "Review and send",
    attestationKind: "truthfulness_certification",
  };
  const decision = (approved: boolean) =>
    classifyAnswerPermission({
      sources: source(),
      control: field,
      controls: [field],
      tags: { kind: "other", country: null, sourceId: null },
      approvedAttestations: approved ? ["truthfulness_certification"] : [],
      answer: "Yes",
      pageInstructions: "",
    });
  const refused = decision(false);
  expect(refused.kind).toBe("needs_you");
  expect(refused.kind === "needs_you" && refused.check).toBe(
    "declaration_permission",
  );
  expect(refused.kind === "needs_you" && refused.reason).toContain(
    "not one of those you let Nestor tick",
  );
  expect(decision(true).kind).toBe("literal");
});

// Candidate 5 workday replica: "My Information — Address *" beside its own
// City and Postal code fields was sent "Berlin, Germany" (profile location).
// Earlier runs filled the street from the resume by checked inference.
describe("a street address line beside its own city field", () => {
  const sources = () => {
    const s = source();
    s.profile.currentCity = "Berlin";
    s.profile.currentLocation = "Berlin, Germany";
    s.profile.currentCountry = "Germany";
    s.resumeText = "Jamie Rivers\n12 Example Street, Berlin, Germany 10115";
    return s;
  };
  const form = () =>
    ["Address *", "City *", "Postal code *", "Country *"].map(
      (label, index) => ({
        ...control(label),
        ref: `c${index}`,
        groupLabel: "My Information",
        scopeKey: "form0",
      }),
    );
  const decide = (
    field: ApplyFormControl,
    controls: ApplyFormControl[],
    sourceId: string | null,
    answer: string,
  ) =>
    classifyAnswerPermission({
      sources: sources(),
      control: field,
      controls,
      tags: { kind: "other", country: null, sourceId },
      answer,
      pageInstructions: "",
    });

  test("never takes the city or location, from any source, and the street can still be worked out", () => {
    const controls = form();
    const [address, city] = controls;
    if (!address || !city) throw new Error("fixture");
    for (const [sourceId, answer] of [
      ["profile.currentLocation", "Berlin, Germany"],
      ["profile.currentCity", "Berlin"],
      ["resume.text", "Berlin, Germany"],
      [null, "Berlin"],
    ] as const)
      expect(decide(address, controls, sourceId, answer)).toMatchObject({
        kind: "needs_you",
        check: "street_address_line",
      });
    // The street itself goes through the checked inference path.
    expect(
      decide(address, controls, "resume.text", "12 Example Street").kind,
    ).toBe("inference");
    // City still binds its own Profile fact.
    expect(decide(city, controls, "profile.currentCity", "Berlin").kind).toBe(
      "literal",
    );
    // An unread Address street line never borrows the city either.
    expect(
      classifyAnswerPermission({
        sources: sources(),
        control: address,
        controls,
        tags: null,
        answer: "Berlin",
        pageInstructions: "",
      }).kind,
    ).toBe("needs_you");
  });

  test("a lone Address or a Location field is still the person's location", () => {
    const lone = { ...control("Address"), groupLabel: "Address" };
    expect(
      decide(lone, [lone], "profile.currentCity", "Berlin, Germany").kind,
    ).toBe("literal");
    const controls = form();
    const location = { ...control("Location"), ref: "loc", scopeKey: "form0" };
    expect(
      decide(
        location,
        [...controls, location],
        "profile.currentLocation",
        "Berlin, Germany",
      ).kind,
    ).toBe("literal");
  });
});
