import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyFormControl } from "./types";
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
    disabled: true,
    readOnly: false,
    visible: false,
    value: "Alex Vanguard",
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
        answer: "Alex Vanguard",
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
        answers: [
          {
            question: "Professional reference — Full name",
            answer: "Alex Vanguard",
          },
        ],
        formControls: [{ ...field, groupLabel: "", sectionPath: [] }],
      })
    )[0]?.supported,
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

test("send binds a retained multi-select as one exact JSON set, including comma labels", async () => {
  const controls = buildApplyFormObservation(
    {
      url: "https://replica.test/apply",
      title: "Review",
      bodyText: "Review",
      controls: ["Writing, editing", "Mentoring", "Planning"].map(
        (label, index) => ({
          index,
          tagName: "input",
          inputType: "checkbox",
          role: "",
          id: `skill${index}`,
          name: "skills",
          scopeKey: "form0",
          label,
          groupLabel: "Select your skills",
          placeholder: "",
          autocomplete: "",
          required: false,
          invalid: false,
          validationMessage: "",
          disabled: false,
          readOnly: false,
          visible: false,
          value: label,
          checked: index < 2,
          multiple: false,
          options: [],
          selectedOptionLabel: "",
        }),
      ),
      actions: [],
      links: [],
      clickables: [],
      headings: [],
      openedTabs: [],
      validationErrors: [],
      loading: false,
      stepLabel: "Step 2 of 2: Review",
    },
    "2026-11-03T00:00:00Z",
  ).controls;
  const answer = '["Writing, editing","Mentoring"]';
  const input = {
    client: reader([
      {
        index: 0,
        kind: "other",
        country: null,
        sourceId: "answerLibrary.skills",
      },
    ]),
    sources: {
      ...sources,
      reusableAnswers: [
        {
          id: "skills",
          kind: "other" as const,
          label: "Select your skills",
          question: "Select your skills",
          answer,
          roleFamilies: [],
          proofEntryIds: [],
        },
      ],
    },
    payDisclosed: false,
    answers: [{ question: "Select your skills", answer }],
    formControls: controls,
    formContext: { pageText: "Review", fields: [] },
  };
  expect((await checkClassifiedApplicationAnswers(input))[0]?.supported).toBe(
    true,
  );
  // The review card shows the same set comma-joined.
  const shown = {
    ...input,
    answers: [
      { question: "Select your skills", answer: "Writing, editing, Mentoring" },
    ],
  };
  expect((await checkClassifiedApplicationAnswers(shown))[0]?.supported).toBe(
    true,
  );
  controls[2].checked = true;
  expect((await checkClassifiedApplicationAnswers(input))[0]?.supported).toBe(
    false,
  );
  expect((await checkClassifiedApplicationAnswers(shown))[0]?.supported).toBe(
    false,
  );
});

test("exact approved routine certification does not become an unknown personal fact at send", async () => {
  const field: ApplyFormControl = {
    ref: "c0",
    kind: "checkbox",
    label: "I certify that the information is true *",
    groupLabel: "Review and send",
    placeholder: "",
    required: true,
    disabled: false,
    readOnly: false,
    visible: true,
    value: "yes",
    checked: true,
    options: [],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: "other",
    answerControlType: "boolean",
    attestationKind: "truthfulness_certification",
    answered: true,
  };
  const input = {
    client: reader([
      {
        index: 0,
        kind: "other",
        country: null,
        sourceId: null,
        declarationPurpose: "personal_fact",
        hasAdditionalConditions: false,
      },
    ]),
    sources,
    payDisclosed: false,
    approvedAttestations: ["truthfulness_certification" as const],
    answers: [
      {
        question: "Review and send — I certify that the information is true *",
        answer: "Yes",
      },
    ],
    formControls: [field],
    formContext: { pageText: "Review", fields: [] },
  };
  expect((await checkClassifiedApplicationAnswers(input))[0]?.supported).toBe(
    true,
  );
  expect(
    (
      await checkClassifiedApplicationAnswers({
        ...input,
        approvedAttestations: [],
      })
    )[0]?.supported,
  ).toBe(false);
  field.label = "I certify that I have a medical licence";
  input.answers[0].question =
    "Review and send — I certify that I have a medical licence";
  expect((await checkClassifiedApplicationAnswers(input))[0]?.supported).toBe(
    false,
  );
});
test.each([
  {
    kind: "work_auth",
    question: "Are you authorized to work in the job's country?",
    answer: "Yes",
  },
  {
    kind: "sponsorship",
    question: "Will you need visa sponsorship?",
    answer: "No",
  },
])(
  "send-time eligibility uses only this application's unchanged answer: $kind",
  async ({ kind, question, answer }) => {
    const controls = buildApplyFormObservation(
      {
        url: "https://example.test/apply",
        title: "Apply",
        bodyText: "Review",
        controls: ["Yes", "No"].map((label, index) => ({
          index,
          tagName: "input",
          inputType: "radio",
          role: "",
          id: `f${index}`,
          name: "eligibility",
          label,
          groupLabel: question,
          placeholder: "",
          autocomplete: "",
          required: true,
          invalid: false,
          validationMessage: "",
          disabled: false,
          readOnly: false,
          visible: true,
          value: label,
          checked: label === answer,
          multiple: false,
          options: [],
          selectedOptionLabel: "",
        })),
        actions: [],
        links: [],
        headings: [],
        clickables: [],
        openedTabs: [],
        loading: false,
        validationErrors: [],
        stepLabel: null,
      },
      "2026-10-28T00:00:00.000Z",
    ).controls;
    for (const variant of [
      "local",
      "result",
      "other_application",
      "remembered",
      "changed_value",
      "changed_question",
      "unconfirmed",
    ] as const) {
      const checks = await checkClassifiedApplicationAnswers({
        client: reader(
          controls.map((_, index) => ({
            index,
            kind,
            country: null,
            sourceId: null,
          })),
        ),
        sources: {
          ...sources,
          posting: { ...sources.posting, location: "Worldwide" },
          reusableAnswers: [
            {
              id: variant === "remembered" ? "remembered_31" : "application_31",
              kind: "other",
              label: question,
              question:
                variant === "changed_question"
                  ? "Different question"
                  : question,
              answer:
                variant === "changed_value"
                  ? answer === "Yes"
                    ? "No"
                    : "Yes"
                  : answer,
              needsConfirmation: variant === "unconfirmed",
              roleFamilies: [],
              proofEntryIds: [],
              applicationScope: {
                applicationRecordId:
                  variant === "result"
                    ? null
                    : variant === "other_application"
                      ? "application_2"
                      : "application_1",
                resultId:
                  variant === "result" ? "application_1_attempt_2" : null,
                // A location hint cannot override the person's decision for this application.
                location: "Germany",
              },
            },
          ],
        },
        application: {
          jobId: "job_1",
          applicationId: "run_1",
          applicationRecordId: "application_1",
          resultId: "application_1_attempt_2",
          startingUrl: "https://example.test/apply",
        },
        payDisclosed: false,
        answers: [{ question, answer }],
        formControls: controls,
        formContext: { pageText: "Review", fields: [] },
      });
      expect(checks[0]?.supported, variant).toBe(
        variant === "local" || variant === "result",
      );
    }
  },
);
test.each([
  {
    label: "GitHub",
    hint: "Please provide your GitHub username, if you have one.",
    answer: "synthetic-alex",
    sourceId: "profile.githubUrl",
    supported: true,
    calls: 1,
  },
  {
    label: "GitHub URL",
    hint: "",
    answer: "https://github.com/synthetic-alex",
    sourceId: "profile.githubUrl",
    supported: true,
    calls: 1,
  },
  {
    label: "GitHub",
    hint: "Please provide your professional reference's GitHub username.",
    answer: "synthetic-alex",
    sourceId: "profile.githubUrl",
    supported: false,
    calls: 1,
  },
  {
    label: "Your GitHub handle will be shown publicly",
    hint: "",
    answer: "synthetic-alex",
    sourceId: "profile.githubUrl#username",
    supported: false,
    calls: 3,
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
  expect(client.chatWithTools).toHaveBeenCalledTimes(row.calls);
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
  expect(client.chatWithTools).toHaveBeenCalledTimes(
    [
      "an uncertain Profile timezone",
      "a saved answer to a different question",
    ].includes(entry.name)
      ? 6
      : 2,
  );
});

// Candidate 4 workday replica: the card kept "… (repeated question on step 4)"
// and Send, reading the page afresh, found "The question is no longer present".
test("Send binds a card answer recorded with a repeated-question note to its question", async () => {
  const field: ApplyFormControl = {
    ref: "c0",
    kind: "checkbox",
    label: "I have read and agree to the terms",
    groupLabel: "Review",
    placeholder: "",
    required: true,
    disabled: false,
    readOnly: false,
    visible: true,
    value: "yes",
    checked: true,
    options: [],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: "other",
    answerControlType: "boolean",
    attestationKind: "terms_acceptance",
    answered: true,
  };
  const check = (question: string) =>
    checkClassifiedApplicationAnswers({
      client: reader([
        {
          index: 0,
          kind: "other",
          country: null,
          sourceId: null,
          declarationPurpose: "acknowledgement",
          hasAdditionalConditions: false,
        },
      ]),
      sources,
      payDisclosed: false,
      approvedAttestations: ["terms_acceptance"],
      answers: [{ question, answer: "Yes" }],
      formControls: [field],
      formContext: { pageText: "Review", fields: [] },
    });
  const noted = await check(
    "Review — I have read and agree to the terms (repeated question on step 4)",
  );
  expect(noted[0]).toMatchObject({ supported: true });
  // A question that is really gone still is not bound.
  expect(
    (await check("Review — I confirm my references may be contacted"))[0]
      ?.supported,
  ).toBe(false);
});
