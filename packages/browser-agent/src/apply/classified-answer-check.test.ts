import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { concreteClaimsSupported } from "./concrete-answer-claims";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyFormControl } from "./types";

test("motivation cannot turn a posting requirement into an applicant fact", () => {
  const quote = "Already holding a valid driving licence";
  const answer = "I am excited about already holding a valid driving licence";
  expect(
    concreteClaimsSupported(answer, [
      { source: "posting", path: "/description", quote },
    ]),
  ).toBe(false);
  expect(
    concreteClaimsSupported(answer, [
      { source: "applicant", path: "/summary", quote: answer },
    ]),
  ).toBe(true);
  expect(
    concreteClaimsSupported("The role requires a valid driving licence", [
      {
        source: "posting",
        path: "/description",
        quote: "The role requires a valid driving licence",
      },
    ]),
  ).toBe(true);
});
import replay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/typed-answer-permissions.json";

const sources = {
  profile: CandidateProfileSchema.parse({
    id: "synthetic",
    yearsExperience: 3,
    fullName: "Alex Vanguard",
    currentCountry: "Germany",
    workEligibility: {
      authorizedWorkCountries: ["United Kingdom"],
      requiresVisaSponsorship: false,
    },
    baseResume: {
      id: "resume",
      fileName: "resume.txt",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      extractionStatus: "ready",
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

test("send-time grounding binds a retained earlier wizard control without trusting a missing card field", async () => {
  const field: ApplyFormControl = {
    ref: "c0",
    kind: "text",
    label: "Full name",
    groupLabel: "Contact details",
    sectionPath: ["Application", "Contact details"],
    placeholder: "",
    required: true,
    disabled: false,
    readOnly: false,
    visible: false,
    value: sources.profile.fullName,
    checked: false,
    options: [],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: "other",
    answerControlType: "text",
    attestationKind: null,
    answered: true,
  };
  const input = {
    client: reader([
      { index: 0, kind: "other", country: null, sourceId: "profile.fullName" },
    ]),
    sources,
    payDisclosed: false,
    answers: [
      {
        question: "Step 1 of 4: Contact details — Full name",
        answer: sources.profile.fullName,
      },
    ],
    formContext: { pageText: "Review", fields: [] },
    formControls: [field],
  };
  expect((await checkClassifiedApplicationAnswers(input))[0]?.supported).toBe(
    true,
  );
  expect(
    (await checkClassifiedApplicationAnswers({ ...input, formControls: [] }))[0]
      ?.supported,
  ).toBe(false);
  expect(
    (
      await checkClassifiedApplicationAnswers({
        ...input,
        formControls: [
          {
            ...field,
            groupLabel: "Professional reference",
            sectionPath: ["Professional reference"],
          },
        ],
      })
    )[0]?.supported,
  ).toBe(false);
});
function reader(tags: unknown[]): LLMClient {
  return {
    chatWithTools: vi.fn(() =>
      Promise.resolve({
        toolCalls: [
          {
            id: "read",
            type: "function" as const,
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify({
                plainIndexes: tags.map((_tag, index) => index),
                flagged: [],
                tags,
              }),
            },
          },
        ],
      }),
    ),
  };
}
test.each([
  {
    label: "GitHub",
    hint: "Please provide your GitHub username, if you have one.",
    answer: "synthetic-alex",
    sourceId: "profile.githubUrl",
    supported: true,
  },
  {
    label: "GitHub URL",
    hint: "",
    answer: "https://github.com/synthetic-alex",
    sourceId: "profile.githubUrl",
    supported: true,
  },
  {
    label: "Your GitHub handle will be shown publicly",
    hint: "",
    answer: "synthetic-alex",
    sourceId: "profile.githubUrl#username",
    supported: false,
  },
])("preflight preserves the requested GitHub format: $label", async (row) => {
  const client = reader([
    { index: 0, kind: "other", country: null, sourceId: row.sourceId },
  ]);
  const field: ApplyFormControl = {
    ref: "github",
    kind: "text",
    label: row.label,
    hint: row.hint,
    groupLabel: "",
    placeholder: "",
    required: true,
    disabled: false,
    readOnly: false,
    visible: true,
    value: row.answer,
    checked: false,
    options: [],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: "other",
    answerControlType: "text",
    attestationKind: null,
    answered: true,
  };
  const checks = await checkClassifiedApplicationAnswers({
    client,
    sources: {
      ...sources,
      profile: {
        ...sources.profile,
        githubUrl: "https://github.com/synthetic-alex",
      },
    },
    payDisclosed: false,
    answers: [{ question: row.label, answer: row.answer }],
    formContext: { pageText: "", fields: [] },
    formControls: [field],
  });
  expect(checks[0]?.supported).toBe(row.supported);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});
test("preflight reuses the Workday country-bound facts without a prose check", async () => {
  const answers = replay.workday.questions.map((row) => ({
    question: `${replay.workday.group} — ${row.label}`,
    answer: row.answer,
  }));
  const client = reader(
    replay.workday.questions.map((row, index) => ({
      index,
      kind: row.kind,
      country: "GB",
      sourceId:
        row.kind === "work_auth"
          ? "profile.workEligibility.authorizedWorkCountries.0"
          : "profile.workEligibility.requiresVisaSponsorship.GB",
    })),
  );
  const result = await checkClassifiedApplicationAnswers({
    client,
    sources,
    payDisclosed: false,
    answers,
    formContext: { pageText: "Application Questions", fields: [] },
  });
  expect(result.map((row) => row.supported)).toEqual([true, true]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});
test("preflight refuses every multilingual gated kind without its matching human source", async () => {
  const client = reader(
    replay.gated.map((row, index) => ({
      index,
      kind: row.kind,
      country: null,
      sourceId: "profile.currentCountry",
    })),
  );
  const checks = await checkClassifiedApplicationAnswers({
    client,
    sources,
    payDisclosed: false,
    answers: replay.gated.map((row) => ({
      question: row.question,
      answer: "Germany",
    })),
    formContext: { pageText: "", fields: [] },
  });
  expect(checks).toHaveLength(replay.gated.length);
  expect(checks.every((row) => !row.supported)).toBe(true);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});
test.each([
  "kubernetes platform",
  "aws certification",
  "fluent in german and french",
  "a decade of TypeScript",
  "several years of TypeScript",
  "I joined Example Workshop in 2023",
  "I led a team of 12 at GitLab",
])("concrete claims need a single supporting passage: %s", (answer) => {
  expect(
    concreteClaimsSupported(answer, [
      {
        source: "resume",
        path: "/text",
        quote: "Platform engineer with overall experience.",
      },
    ]),
  ).toBe(false);
});
test("numbers and entities from different quotes cannot be recombined", () => {
  expect(
    concreteClaimsSupported("I led a team of 12 at Example Workshop in 2023", [
      {
        source: "resume",
        path: "/text",
        quote: "I led a team of 3 at Example Workshop in 2020.",
      },
      {
        source: "resume",
        path: "/text",
        quote: "I joined Other Company in 2023 with 12 colleagues.",
      },
    ]),
  ).toBe(false);
  expect(
    concreteClaimsSupported("I led a team of 12 at Example Workshop in 2023", [
      {
        source: "resume",
        path: "/text",
        quote: "I led a team of 12 at Example Workshop in 2023.",
      },
    ]),
  ).toBe(true);
});
test("empty inputs do not call AI; retry reads current sources, not an earlier permission", async () => {
  const client = reader([
    {
      index: 0,
      kind: "work_auth",
      country: "GB",
      sourceId: "profile.workEligibility.authorizedWorkCountries.0",
    },
  ]);
  const input = {
    client,
    sources,
    payDisclosed: false,
    answers: [] as { question: string; answer: string }[],
    formContext: { pageText: "", fields: [] },
  };
  expect(await checkClassifiedApplicationAnswers(input)).toEqual([]);
  expect(client.chatWithTools).not.toHaveBeenCalled();
  input.answers = [
    { question: replay.workday.questions[0].label, answer: "Yes" },
  ];
  expect((await checkClassifiedApplicationAnswers(input))[0]?.supported).toBe(
    true,
  );
  const changed = {
    ...input,
    sources: {
      ...sources,
      posting: { ...sources.posting, location: "Germany" },
    },
  };
  expect((await checkClassifiedApplicationAnswers(changed))[0]?.supported).toBe(
    false,
  );
  expect((await checkClassifiedApplicationAnswers(changed))[0]?.supported).toBe(
    false,
  );
});

test.each([
  "kubernetes platform",
  "aws certification",
  "fluent in german and french",
  "a decade of TypeScript",
  "several years of TypeScript",
  "I joined Example Workshop in 2023",
])(
  "a lying checker still cannot approve %s inside motivation",
  async (answer) => {
    const quote = "Platform engineer with overall experience.";
    const client: LLMClient = {
      chatWithTools: vi.fn<LLMClient["chatWithTools"]>((_messages, tools) =>
        Promise.resolve({
          toolCalls: [
            {
              id: "lying",
              type: "function",
              function: {
                name: tools[0].function.name,
                arguments: JSON.stringify(
                  tools[0].function.name === "report_question_kinds"
                    ? {
                        plainIndexes: [0],
                        flagged: [],
                        tags: [
                          {
                            index: 0,
                            kind: "motivation",
                            country: null,
                            sourceId: "resume.text",
                          },
                        ],
                      }
                    : {
                        checks: [
                          {
                            index: 0,
                            supported: true,
                            reason: "Supported",
                            evidence: [
                              {
                                kind: "applicant_fact",
                                claim: answer,
                                source: "resume",
                                path: "",
                                quote,
                              },
                            ],
                          },
                        ],
                      },
                ),
              },
            },
          ],
        }),
      ),
    };
    const checks = await checkClassifiedApplicationAnswers({
      client,
      sources: { ...sources, resumeText: quote },
      payDisclosed: false,
      answers: [{ question: "Why this role?", answer }],
      formContext: { pageText: "", fields: [] },
    });
    expect(checks[0]?.supported).toBe(false);
    expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  },
);

test("a preapproved routine declaration remains a sourced answer, while a gated question cannot borrow that approval", async () => {
  const client: LLMClient = {
    chatWithTools: vi.fn().mockResolvedValue({
      toolCalls: [
        {
          id: "read",
          type: "function",
          function: {
            name: "report_question_kinds",
            arguments: JSON.stringify({
              plainIndexes: [],
              flagged: [
                {
                  index: 0,
                  asksAboutPay: false,
                  declarationKind: "truthfulness_certification",
                },
              ],
              tags: [
                { index: 0, kind: "other", country: null, sourceId: null },
              ],
            }),
          },
        },
      ],
    }),
  };
  const input = {
    client,
    sources,
    payDisclosed: false,
    approvedAttestations: ["truthfulness_certification" as const],
    answers: [
      { question: "I certify that the information is true", answer: "Yes" },
    ],
    formContext: { pageText: "", fields: [] },
  };
  expect((await checkClassifiedApplicationAnswers(input))[0]?.supported).toBe(
    true,
  );
  expect(
    (
      await checkClassifiedApplicationAnswers({
        ...input,
        answers: [
          { question: "Do you hold British citizenship?", answer: "Yes" },
        ],
      })
    )[0]?.supported,
  ).toBe(false);
});

test.each([
  {
    name: "the person's Yes",
    answer: "Yes",
    selected: "Yes",
    saved: true,
    source: "saved",
    country: "Kosovo",
    supported: true,
  },
  {
    name: "the person's Yes without an inferred source",
    answer: "Yes",
    selected: "Yes",
    saved: true,
    source: null,
    country: "United States",
    supported: true,
  },
  {
    name: "the person's No overrides a location derivation",
    answer: "No",
    selected: "No",
    saved: true,
    source: null,
    country: "Kosovo",
    supported: true,
  },
  {
    name: "the same Profile timezone source as Fill",
    answer: "Yes",
    selected: "Yes",
    saved: false,
    source: "profile.currentCountry#timezone",
    country: "Kosovo",
    supported: true,
  },
  {
    name: "an uncertain Profile timezone",
    answer: "Yes",
    selected: "Yes",
    saved: false,
    source: "profile.currentCountry#timezone",
    country: "United States",
    supported: false,
  },
  {
    name: "a card value different from the selected choice",
    answer: "Yes",
    selected: "No",
    saved: true,
    source: "saved",
    country: "Kosovo",
    supported: false,
  },
  {
    name: "a saved answer to a different question",
    answer: "Yes",
    selected: "Yes",
    saved: true,
    source: "saved",
    country: "Kosovo",
    savedQuestion: "Do you require visa sponsorship?",
    supported: false,
  },
])("pre-send Yes/No rechecks preserve $name", async (entry) => {
  const question = "Are you in an European time zone?";
  // Ashby's Yes/No: two option buttons and its hidden box.
  const formControls = buildApplyFormObservation(
    {
      url: "https://jobs.example.test/acme/1/application",
      title: "Apply",
      bodyText: question,
      controls: [
        {
          index: 0,
          tagName: "input",
          inputType: "checkbox",
          role: "",
          id: "",
          name: "tz",
          label: question,
          groupLabel: "",
          placeholder: "",
          autocomplete: "",
          required: true,
          invalid: false,
          validationMessage: "",
          disabled: false,
          readOnly: false,
          visible: false,
          value: "on",
          checked: true,
          multiple: false,
          options: [],
          selectedOptionLabel: "",
        },
      ],
      actions: [
        {
          index: 0,
          label: "Yes",
          visible: true,
          disabled: false,
          section: question,
          pressed: entry.selected === "Yes",
          sectionRequired: true,
        },
        {
          index: 1,
          label: "No",
          visible: true,
          disabled: false,
          section: question,
          pressed: entry.selected === "No",
          sectionRequired: true,
        },
      ],
      links: [],
      headings: [],
      clickables: [],
      openedTabs: [],
      loading: false,
      validationErrors: [],
      stepLabel: null,
    },
    "2026-10-27T07:30:00.000Z",
  ).controls;
  const saved = {
    id: "application_application:146",
    kind: "other" as const,
    label: question,
    question: entry.savedQuestion ?? question,
    answer: entry.answer,
    roleFamilies: [],
    proofEntryIds: [],
  };
  const sourceId = `answerLibrary.${saved.id}`;
  const client = reader(
    formControls.map((_control, index) => ({
      index,
      kind: "other",
      country: null,
      sourceId: entry.source === "saved" ? sourceId : entry.source,
    })),
  );
  // Both pre-send checks must see the same choice and unchanged human answer.
  for (let recheck = 0; recheck < 2; recheck += 1) {
    const checks = await checkClassifiedApplicationAnswers({
      client,
      sources: {
        ...sources,
        profile: {
          ...sources.profile,
          currentCountry: entry.country,
          currentLocation: entry.country,
        },
        reusableAnswers: entry.saved ? [saved] : [],
      },
      answers: [{ question, answer: entry.answer }],
      formContext: { pageText: question, fields: [] },
      formControls,
      payDisclosed: false,
    });
    expect(checks).toEqual([
      expect.objectContaining({ supported: entry.supported }),
    ]);
  }
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});
