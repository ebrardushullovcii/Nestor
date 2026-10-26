import type { LLMClient } from "../agent/contracts";
import { expect, test, vi } from "vitest";
import {
  CandidateProfileSchema,
  type ApplyAnswerTags,
} from "@nestor/contracts";
import { classifyAnswerPermission } from "./answer-source-catalog";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import {
  createApplyGuardState,
  executeApplyProposal,
  questionPrompt,
} from "./policy-executor";
import { buildApplyFormObservation } from "./page-hands";
import { createQuestionClassifier } from "./question-classification";
import type {
  ApplyFormControl,
  ApplyAnswerSources,
  ApplyAgentConfig,
  ApplyPageHands,
} from "./types";
import type { RawApplyControl, RawApplyPage } from "@nestor/contracts";
const at = "2026-10-26T12:00:00.000Z";
function sources(): ApplyAnswerSources {
  return {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      yearsExperience: 3,
      fullName: "Alex Vanguard",
      skills: ["Rust"],
      workEligibility: {
        authorizedWorkCountries: ["United Kingdom"],
        requiresVisaSponsorship: false,
      },
      baseResume: {
        id: "r",
        fileName: "r.txt",
        uploadedAt: at,
        extractionStatus: "ready",
        textContent: "I use C#.",
      },
    }),
    resumeText: "I use C#.",
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
function field(
  label: string,
  overrides: Partial<RawApplyControl> = {},
): RawApplyControl {
  return {
    index: 0,
    tagName: "input",
    inputType: "text",
    role: "",
    id: "field",
    name: "field",
    label,
    groupLabel: "",
    placeholder: "",
    autocomplete: "",
    required: true,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value: "",
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
    ...overrides,
  };
}
function setup(
  raw: RawApplyControl,
  src = sources(),
  pageText = "Apply for this role",
) {
  const page: RawApplyPage = {
    url: "https://apply.example.test/form",
    title: "Apply",
    bodyText: pageText,
    controls: [raw],
    actions: [],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
  };
  const observation = () => buildApplyFormObservation(page, at);
  const pageUrl = "https://apply.example.test/form";
  const fillText = vi.fn<ApplyPageHands["fillText"]>((_ref, value) => {
    raw.value = value;
    return Promise.resolve({ ok: true, observedValue: value });
  });
  const setToggle = vi.fn<ApplyPageHands["setToggle"]>((_ref, checked) => {
    raw.checked = checked;
    return Promise.resolve({
      ok: true,
      observedValue: checked ? "checked" : "unchecked",
    });
  });
  const hands: ApplyPageHands = {
    observe: () => Promise.resolve(observation()),
    navigate: () => Promise.resolve({ ok: true, url: pageUrl }),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "scrolled" }),
    wait: () => Promise.resolve(),
    goBack: () => Promise.resolve({ ok: true, url: pageUrl }),
    readText: () => Promise.resolve(page.bodyText),
    fillText,
    setToggle,
    chooseOption: (_ref, value) =>
      Promise.resolve({ ok: true, observedValue: value }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () => Promise.resolve({ ok: true, url: pageUrl }),
  };
  const config: ApplyAgentConfig = {
    hands,
    sources: src,
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    application: { jobId: "j", applicationId: "a", startingUrl: pageUrl },
    siteLabel: "synthetic",
  };
  return { raw, page, observation, config, fillText, setToggle };
}
function readTags(tags: ApplyAnswerTags, extra = {}) {
  return (controls: readonly ApplyFormControl[]) =>
    Promise.resolve(
      new Map(
        controls.map((c) => [
          questionPrompt(c),
          {
            asksAboutPay: false,
            declarationKind: null,
            answerTags: tags,
            ...extra,
          },
        ]),
      ),
    );
}
const call = (name: string, args: unknown) => ({
  toolCalls: [
    {
      id: "x",
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
function lying(
  src: ApplyAnswerSources,
  kind = "motivation",
  quote = src.resumeText ?? "",
  source = "resume",
  path = "",
) {
  return {
    chatWithTools: vi.fn(
      (_m: unknown, tools: readonly { function: { name: string } }[]) =>
        Promise.resolve(
          tools[0]?.function.name === "report_question_kinds"
            ? call("report_question_kinds", {
                plainIndexes: [0],
                flagged: [],
                tags: [
                  { index: 0, kind, country: null, sourceId: "resume.text" },
                ],
              })
            : call("report_answer_checks", {
                checks: [
                  {
                    index: 0,
                    supported: true,
                    reason: "Supported",
                    evidence: [
                      {
                        claim: "All claims",
                        kind: "applicant_fact",
                        source,
                        path,
                        quote,
                      },
                    ],
                  },
                ],
              }),
        ),
    ),
  };
}
test("batch W: an unsaved preference checkbox stays untouched", async () => {
  const s = setup(
    field("Is Rust your favourite language?", { inputType: "checkbox" }),
  );
  const result = await executeApplyProposal(
    { tool: "set_checkbox", ref: "c0", checked: true },
    s.observation().signature,
    {
      config: s.config,
      now: () => new Date(at),
      guardState: createApplyGuardState(),
      classifyQuestions: readTags({
        kind: "preference",
        country: null,
        sourceId: null,
      }),
    },
  );
  expect(result.kind).toBe("suggestion");
  expect(s.setToggle).not.toHaveBeenCalled();
});
test("batch W: classification failure leaves a citizenship checkbox untouched", async () => {
  const s = setup(
    field("Do you hold British citizenship?", { inputType: "checkbox" }),
  );
  const result = await executeApplyProposal(
    { tool: "set_checkbox", ref: "c0", checked: true },
    s.observation().signature,
    {
      config: s.config,
      now: () => new Date(at),
      guardState: createApplyGuardState(),
      classifyQuestions: () => Promise.reject(new Error("unavailable")),
    },
  );
  expect(result.kind).toBe("suggestion");
  expect(s.setToggle).not.toHaveBeenCalled();
});
test("batch W: C# evidence cannot support C++ at preflight", async () => {
  const src = sources(),
    answer = "I use C++.";
  const client = lying(src);
  const checks = await checkClassifiedApplicationAnswers({
    client,
    sources: src,
    payDisclosed: false,
    answers: [
      { question: "Why would you be a good fit for this role?", answer },
    ],
    formContext: { pageText: "", fields: [] },
  });
  expect(checks[0].supported).toBe(false);
});
test("batch W: compound legal conditions require their own evidence", () => {
  const src = sources(),
    s = setup(
      field(
        "Are you authorized to work in the United Kingdom without any restrictions and without ever requiring sponsorship?",
      ),
      src,
    );
  src.profile.workEligibility.requiresVisaSponsorship = true;
  const c = s.observation().controls[0];
  const decision = classifyAnswerPermission({
    control: c,
    controls: [c],
    tags: { kind: "work_auth", country: "GB", sourceId: null },
    sources: src,
    answer: "Yes",
    pageInstructions: "",
  });
  expect(decision.kind).toBe("needs_you");
  return Promise.resolve();
});
test("batch W: an explicitly named country uses its own profile fact", () => {
  const src = sources();
  src.posting.location = "Germany";
  const s = setup(
      field("Are you authorized to work in the United Kingdom?"),
      src,
    ),
    c = s.observation().controls[0];
  const decision = classifyAnswerPermission({
    control: c,
    controls: [c],
    tags: { kind: "work_auth", country: "GB", sourceId: null },
    sources: src,
    answer: "Yes",
    pageInstructions: "",
  });
  expect(decision.kind).toBe("literal");
});
test("batch W: an other-tagged preference cannot enter through a writing shortcut", async () => {
  const src = sources(),
    s = setup(field("Why is Rust your language of choice?"), src);
  const checker = vi.fn(() =>
    Promise.resolve({
      supported: false,
      reason: "unsupported preference",
    }),
  );
  const result = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "Rust" },
    s.observation().signature,
    {
      config: s.config,
      now: () => new Date(at),
      guardState: createApplyGuardState(),
      classifyQuestions: readTags({
        kind: "other",
        country: null,
        sourceId: "resume.text",
      }),
      checkWrittenAnswer: checker,
    },
  );
  const client = lying(src, "other", "Rust", "applicant", "/skills/0");
  const checks = await checkClassifiedApplicationAnswers({
    client,
    sources: src,
    payDisclosed: false,
    answers: [
      { question: questionPrompt(s.observation().controls[0]), answer: "Rust" },
    ],
    formContext: { pageText: "", fields: [] },
  });
  expect(result.kind).toBe("suggestion");
  expect(s.fillText).not.toHaveBeenCalled();
  expect(checker).not.toHaveBeenCalled();
  expect(checks[0].supported).toBe(false);
});
test("batch W: source-permission grammar can invert meaning with punctuation", async () => {
  const src = sources();
  src.resumeText = "I cannot work in the UK.";
  const answer = "I can not work in the UK.";
  const checks = await checkWrittenApplicationAnswers({
    client: lying(src),
    sources: src,
    payDisclosed: false,
    answers: [{ question: "Why are you a good fit?", answer }],
  });
  expect(checks[0].supported).toBe(false);
});

test("batch W: C# years cannot answer a C++ question", async () => {
  const src = sources();
  src.reusableAnswers = [
    {
      id: "saved",
      kind: "other",
      label: "C# years",
      question: "How many years of C# experience?",
      answer: "8",
      roleFamilies: [],
      proofEntryIds: [],
      needsConfirmation: false,
    },
  ];
  const s = setup(
    field("How many years of C++ experience?", { inputType: "number" }),
    src,
  );
  const result = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "8" },
    s.observation().signature,
    {
      config: s.config,
      now: () => new Date(at),
      guardState: createApplyGuardState(),
      classifyQuestions: readTags({
        kind: "other",
        country: null,
        sourceId: "answerLibrary.saved",
      }),
    },
  );
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve(
        call("report_question_kinds", {
          plainIndexes: [0],
          flagged: [],
          tags: [
            {
              index: 0,
              kind: "other",
              country: null,
              sourceId: "answerLibrary.saved",
            },
          ],
        }),
      ),
    ),
  };
  const checks = await checkClassifiedApplicationAnswers({
    client,
    sources: src,
    payDisclosed: false,
    answers: [{ question: "How many years of C++ experience?", answer: "8" }],
    formContext: { pageText: "", fields: [] },
  });
  expect(result.kind).toBe("suggestion");
  expect(s.fillText).not.toHaveBeenCalled();
  expect(checks[0].supported).toBe(false);
});
test("batch W: listing discovery respects own-words tags", async () => {
  const src = sources();
  src.listingDiscovery = {
    label: "Synthetic board",
    url: "https://board.example.test",
  };
  const s = setup(field("In your own words, how did you hear about us?"), src);
  const result = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "Synthetic board" },
    s.observation().signature,
    {
      config: s.config,
      now: () => new Date(at),
      guardState: createApplyGuardState(),
      classifyQuestions: readTags({
        kind: "own_words",
        country: null,
        sourceId: null,
      }),
    },
  );
  expect(result.kind).toBe("suggestion");
  expect(s.fillText).not.toHaveBeenCalled();
});
test("batch W: UK shorthand resolves without another question", () => {
  const src = sources(),
    s = setup(field("Are you authorized to work in the UK?"), src),
    c = s.observation().controls[0];
  const decision = classifyAnswerPermission({
    control: c,
    controls: [c],
    tags: { kind: "work_auth", country: "GB", sourceId: null },
    sources: src,
    answer: "Yes",
    pageInstructions: "",
  });
  expect(decision.kind).toBe("literal");
});
test("batch W: employment title stays with the employer profile record", () => {
  const src = sources();
  src.profile = CandidateProfileSchema.parse({
    ...src.profile,
    experiences: [
      {
        id: "old",
        companyName: "Old Company",
        title: "Director",
        startDate: "2020-01",
        endDate: "2021-01",
      },
      {
        id: "new",
        companyName: "New Company",
        title: "Engineer",
        startDate: "2024-01",
        endDate: null,
      },
    ],
  });
  const s = setup(field("Job title", { groupLabel: "Work experience" }), src);
  s.page.controls.push(
    field("Company", {
      index: 1,
      value: "New Company",
      groupLabel: "Work experience",
    }),
  );
  const c = s.observation().controls[0];
  const decision = classifyAnswerPermission({
    control: c,
    controls: s.observation().controls,
    tags: {
      kind: "other",
      country: null,
      sourceId: "profile.experiences.old.title",
    },
    sources: src,
    answer: "Director",
    pageInstructions: "",
  });
  expect(decision.kind).toBe("needs_you");
  return Promise.resolve();
});
test("batch W: preflight distinguishes compound conditions from an explicit country", async () => {
  const src = sources();
  src.profile.workEligibility.requiresVisaSponsorship = true;
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve(
        call("report_question_kinds", {
          plainIndexes: [0],
          flagged: [],
          tags: [
            { index: 0, kind: "work_auth", country: "GB", sourceId: null },
          ],
        }),
      ),
    ),
  };
  for (const [location, question] of [
    [
      "United Kingdom",
      "Are you authorized to work in the United Kingdom without any restrictions and without ever requiring sponsorship?",
    ],
    ["Germany", "Are you authorized to work in the United Kingdom?"],
  ]) {
    src.posting.location = location;
    const checks = await checkClassifiedApplicationAnswers({
      client,
      sources: src,
      payDisclosed: false,
      answers: [{ question, answer: "Yes" }],
      formContext: { pageText: "", fields: [] },
    });
    expect(checks[0].supported).toBe(location === "Germany");
  }
});
test("batch W: four-step saved-answer fill call count", async () => {
  const { runApplyAgent } = await import("./apply-agent");
  let step = 1;
  const s = setup(field("Question 1"), sources(), "Step 1 of 4");
  const applyStep = () => {
    s.page.bodyText = `Step ${step} of 4`;
    s.page.stepLabel = `Step ${step} of 4`;
    s.page.controls = [field(`Question ${step}`)];
    s.page.actions = [
      {
        index: 0,
        label: step === 4 ? "Submit application" : "Continue",
        visible: true,
        disabled: false,
      },
    ];
  };
  applyStep();
  s.config.hands.fillText = (_r, v) => {
    s.page.controls[0].value = v;
    return Promise.resolve({ ok: true, observedValue: v });
  };
  s.config.hands.clickElement = () => {
    if (step < 4) {
      step++;
      applyStep();
    }
    return Promise.resolve({ ok: true, observedValue: "clicked" });
  };
  s.config.modelQuestionClassification = true;
  s.config.readReusableAnswers = () =>
    Promise.resolve([
      {
        id: `remembered_${step}`,
        kind: "other",
        label: `Question ${step}`,
        question: `Question ${step}`,
        answer: `Answer ${step}`,
        roleFamilies: [],
        proofEntryIds: [],
        needsConfirmation: false,
      },
    ]);
  s.config.runControl = { maxSteps: 20, noProgressStepLimit: 5 };
  const kinds: string[] = [];
  let chars = 0;
  const client = {
    chatWithTools: vi.fn<LLMClient["chatWithTools"]>(
      (messages: unknown[], tools: { function: { name: string } }[]) => {
        chars += JSON.stringify(messages).length;
        const name = tools[0]?.function.name;
        if (name === "report_question_kinds") {
          kinds.push("classify");
          const questions = JSON.parse(
            (messages[1] as { content: string }).content,
          ) as Array<{ question: string }>;
          const catalog = (
            JSON.parse((messages[2] as { content: string }).content) as {
              sources: Array<{ id: string; question?: string }>;
            }
          ).sources;
          return Promise.resolve(
            call("report_question_kinds", {
              plainIndexes: questions.map((_q: unknown, i: number) => i),
              flagged: [],
              tags: questions.map((q: { question: string }, index: number) => ({
                index,
                kind: "other",
                country: null,
                sourceId:
                  catalog.find((c) => c.question === q.question)?.id ?? null,
              })),
            }),
          );
        }
        if (name === "report_answer_checks")
          throw new Error("no writing expected");
        kinds.push("form");
        if (step === 4 && s.page.controls[0].value)
          return Promise.resolve(
            call("finish", {
              reason: "All four steps completed.",
              needsPerson: false,
            }),
          );
        return Promise.resolve(
          call("fill_fields", {
            fields: [
              { tool: "type", ref: "c0", text: `Answer ${step}` },
              ...(step < 4
                ? [
                    {
                      tool: "click",
                      ref: "a0",
                      reason: "Continue to next step",
                    },
                  ]
                : []),
            ],
          }),
        );
      },
    ),
  };
  const result = await runApplyAgent(s.config, client);
  expect(result.outcome).toBe("prepared");
  expect(kinds.filter((kind) => kind === "classify")).toHaveLength(4);
  expect(chars).toBeGreaterThan(0);
  expect(kinds.length).toBeLessThanOrEqual(8);
});
test("batch W: a posting requirement is not applicant experience", async () => {
  const src = sources();
  src.posting.description =
    "Minimum qualifications: 10 years of Rust experience.";
  const answer = "10 years of Rust experience.";
  const client = {
    chatWithTools: vi.fn(
      (_messages: unknown[], tools: { function: { name: string } }[]) =>
        Promise.resolve(
          tools[0]?.function.name === "report_question_kinds"
            ? call("report_question_kinds", {
                plainIndexes: [0],
                flagged: [],
                tags: [
                  {
                    index: 0,
                    kind: "motivation",
                    country: null,
                    sourceId: "posting.description",
                  },
                ],
              })
            : call("report_answer_checks", {
                checks: [
                  {
                    index: 0,
                    supported: true,
                    reason: "Supported",
                    evidence: [
                      {
                        claim: answer,
                        kind: "role_motivation",
                        source: "posting",
                        path: "/description",
                        quote: "10 years of Rust experience.",
                      },
                    ],
                  },
                ],
              }),
        ),
    ),
  };
  const checks = await checkClassifiedApplicationAnswers({
    client,
    sources: src,
    payDisclosed: false,
    answers: [{ question: "Why are you a good fit for this role?", answer }],
    formContext: { pageText: "", fields: [] },
  });
  expect(checks[0].supported).toBe(false);
});
test("batch W: a scoped cover-letter instruction permits an unchanged contact fact", () => {
  const src = sources(),
    s = setup(field("Full name"), src),
    c = s.observation().controls[0];
  const decision = classifyAnswerPermission({
    control: c,
    controls: [c],
    tags: { kind: "other", country: null, sourceId: "profile.fullName" },
    sources: src,
    answer: "Alex Vanguard",
    pageInstructions: "Please write your cover letter in your own words.",
  });
  expect(decision.kind).toBe("literal");
});
test("batch W: the classifier receives the posting country", async () => {
  const { answerSourceCatalog } = await import("./answer-source-catalog");
  const src = sources();
  src.posting.location = "Germany";
  src.posting.description = "Build services.";
  const s = setup(field("Are you authorized to work in this country?"), src);
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve(
        call("report_question_kinds", {
          plainIndexes: [0],
          flagged: [],
          tags: [
            { index: 0, kind: "work_auth", country: null, sourceId: null },
          ],
        }),
      ),
    ),
  };
  const classify = createQuestionClassifier({
    client,
    sources: () => answerSourceCatalog(src),
  });
  await classify(
    s.observation().controls,
    JSON.stringify({ instructions: "Application questions" }),
  );
  const messageText = JSON.stringify(client.chatWithTools.mock.calls);
  expect(messageText.includes("Germany")).toBe(true);
});
test("batch W: preflight refuses mixed employment records", async () => {
  const src = sources();
  src.profile = CandidateProfileSchema.parse({
    ...src.profile,
    experiences: [
      {
        id: "old",
        companyName: "Old Company",
        title: "Director",
        startDate: "2020-01",
        endDate: "2021-01",
      },
      {
        id: "new",
        companyName: "New Company",
        title: "Engineer",
        startDate: "2024-01",
        isCurrent: true,
      },
    ],
  });
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve(
        call("report_question_kinds", {
          plainIndexes: [0, 1],
          flagged: [],
          tags: [
            {
              index: 0,
              kind: "other",
              country: null,
              sourceId: "profile.experiences.new.companyName",
            },
            {
              index: 1,
              kind: "other",
              country: null,
              sourceId: "profile.experiences.old.title",
            },
          ],
        }),
      ),
    ),
  };
  const checks = await checkClassifiedApplicationAnswers({
    client,
    sources: src,
    payDisclosed: false,
    answers: [
      { question: "Work experience — Company", answer: "New Company" },
      { question: "Work experience — Job title", answer: "Director" },
    ],
    formContext: { pageText: "", fields: [] },
  });
  expect(checks.every((c) => !c.supported)).toBe(true);
});

test.each([
  {
    label:
      "Are you authorized to work in the UK without ever requiring sponsorship?",
    group: "",
  },
  {
    label:
      "Without requiring sponsorship — Are you authorized to work in the UK?",
    group: "",
  },
  {
    label: "Are you authorized to work in the UK?",
    group: "Without restrictions or sponsorship",
  },
])(
  "compound instructions do not become a country-only answer: $label",
  ({ label, group }) => {
    const src = sources(),
      s = setup(field(label, { groupLabel: group }), src),
      control = s.observation().controls[0];
    expect(
      classifyAnswerPermission({
        control,
        controls: [control],
        tags: {
          kind: "work_auth",
          country: "GB",
          sourceId: "profile.workEligibility.authorizedWorkCountries.0",
        },
        sources: src,
        answer: "Yes",
        pageInstructions: "",
      }).kind,
    ).toBe("needs_you");
  },
);

test("an explicitly named country also binds a saved answer despite the posting's country", () => {
  const src = sources();
  src.posting.location = "Germany";
  const prompt = "Are you authorized to work in the United Kingdom?";
  src.reusableAnswers = [
    {
      id: "own-country",
      kind: "work_authorization",
      label: prompt,
      question: prompt,
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
      applicationScope: {
        resultId: null,
        applicationRecordId: null,
        location: "Germany",
      },
    },
  ];
  const s = setup(field(prompt), src),
    control = s.observation().controls[0];
  expect(
    classifyAnswerPermission({
      control,
      controls: [control],
      tags: {
        kind: "work_auth",
        country: "GB",
        sourceId: "answerLibrary.own-country",
      },
      sources: src,
      answer: "Yes",
      pageInstructions: "",
    }).kind,
  ).toBe("literal");
});
test("a motivation misreading cannot waive a language-of-choice preference", async () => {
  const src = sources(),
    s = setup(field("Why is Rust your language of choice?"), src);
  const check = vi
    .fn()
    .mockResolvedValue({ supported: true, reason: "lying checker" });
  const result = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "Rust" },
    s.observation().signature,
    {
      config: s.config,
      now: () => new Date(at),
      guardState: createApplyGuardState(),
      classifyQuestions: readTags({
        kind: "motivation",
        country: null,
        sourceId: "resume.text",
      }),
      checkWrittenAnswer: check,
    },
  );
  expect(result.kind).toBe("suggestion");
  expect(s.fillText).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
});

test.each(["truncated", "unparseable"])(
  "a %s question reading retries once then creates a visible handover",
  async (failure) => {
    const { runApplyAgent } = await import("./apply-agent");
    const s = setup(field("Full name"));
    s.config.modelQuestionClassification = true;
    const client: LLMClient = {
      chatWithTools: vi.fn<LLMClient["chatWithTools"]>((_messages, tools) => {
        expect(tools[0]?.function.name).toBe("report_question_kinds");
        return failure === "truncated"
          ? Promise.reject(new Error("incomplete response: max_output_tokens"))
          : Promise.resolve({
              toolCalls: [
                {
                  id: "broken",
                  type: "function",
                  function: {
                    name: "report_question_kinds",
                    arguments: '{"tags":[',
                  },
                },
              ],
            });
      }),
    };
    const result = await runApplyAgent(s.config, client);
    expect(client.chatWithTools).toHaveBeenCalledTimes(2);
    expect(s.fillText).not.toHaveBeenCalled();
    expect(result.outcome).toBe("paused");
    const question = result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .find((question) => question.prompt === "Full name");
    expect(question?.note).toContain("two attempts");
  },
);
