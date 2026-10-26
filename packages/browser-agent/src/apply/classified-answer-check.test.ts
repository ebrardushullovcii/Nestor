import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { concreteClaimsSupported } from "./concrete-answer-claims";
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
