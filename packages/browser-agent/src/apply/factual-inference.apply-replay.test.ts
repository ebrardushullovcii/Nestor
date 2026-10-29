import {
  CandidateProfileSchema,
  type ApplyAnswerTags,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { classifyAnswerPermission } from "./answer-source-catalog";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { buildApplyFormObservation } from "./page-hands";
import { createApplyGuardState, executeApplyProposal } from "./policy-executor";
import type { ApplyAgentConfig, ApplyAnswerSources } from "./types";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";

const now = () => new Date("2026-10-29T00:00:00Z");
const sources: ApplyAnswerSources = {
  profile: CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Robin Example",
    currentCountry: "Kosovo",
    yearsExperience: 7,
    experiences: [
      {
        id: "synthetic-work",
        companyName: "Example Workshop",
        title: "Software Developer",
        startDate: "2019-01",
        endDate: "2026-01",
        isDraft: false,
      },
    ],
    education: [
      {
        id: "synthetic-degree",
        institution: "Example University",
        degree: "BSc Computer Science",
        startDate: "2015-09",
        endDate: "2018-06",
        isDraft: false,
      },
    ],
    baseResume: {
      id: "synthetic-resume",
      fileName: "synthetic.txt",
      uploadedAt: now().toISOString(),
      textContent:
        "Seven years of professional work as a Software Developer. BSc Computer Science, Example University, 2015–2018.",
    },
  }),
  resumeText: null,
  reusableAnswers: [],
  documents: [],
  posting: {
    title: "Software Developer",
    company: "Example Workshop",
    location: "Remote",
    description: "Build software.",
  },
};
const facts = [
  {
    question: "Do you have 2+ years of experience as a Software Developer?*",
    answer: "Yes",
    sourceId: "profile.yearsExperience",
    path: "/yearsExperience",
    quote: "7",
  },
  {
    question: "State*",
    answer: "Not in the U.S.",
    sourceId: null,
    path: "/location/country",
    quote: "Kosovo",
  },
  {
    question: "Are you at least 18 years of age?*",
    answer: "Yes",
    sourceId: null,
    path: "/experiences/0/title",
    quote: "Software Developer",
  },
];
function field(question: string, index = 0): RawApplyControl {
  return {
    index,
    tagName: "select",
    inputType: "",
    role: "",
    id: `field-${index}`,
    name: `field-${index}`,
    label: question,
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
    options:
      question === "State*"
        ? ["California", "New York", "Not in the U.S."]
        : ["Yes", "No"],
    selectedOptionLabel: "",
  };
}
function page(controls: RawApplyControl[]): RawApplyPage {
  return {
    url: "http://127.0.0.1:47950/synthetic/apply",
    title: "Apply",
    bodyText: "Application questions",
    controls,
    actions: [],
    headings: [],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
  };
}
function config(raw: RawApplyPage): ApplyAgentConfig {
  const write = (ref: string, value: string) => {
    raw.controls.find((control) => `c${control.index}` === ref)!.value = value;
    return Promise.resolve({ ok: true as const, observedValue: value });
  };
  return {
    sources,
    application: {
      jobId: "synthetic",
      applicationId: "synthetic",
      startingUrl: raw.url!,
    },
    authority: {
      mode: "autonomous_submit",
      submitAuthorized: true,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: ["http://127.0.0.1:47950"],
    },
    siteLabel: "Synthetic employer",
    modelQuestionClassification: true,
    now,
    hands: {
      observe: () =>
        Promise.resolve(buildApplyFormObservation(raw, now().toISOString())),
      fillText: write,
      chooseOption: write,
      setToggle: (ref, checked) => {
        raw.controls.find((control) => `c${control.index}` === ref)!.checked =
          checked;
        return write(ref, checked ? "Yes" : "No");
      },
      wait: () => Promise.resolve(),
      navigate: (url) => Promise.resolve({ ok: true, url }),
      goBack: () => Promise.resolve({ ok: true, url: raw.url! }),
      followLink: () => Promise.resolve({ ok: true, url: raw.url! }),
      clickElement: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      clickAction: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      scroll: () => Promise.resolve({ ok: true, observedValue: "scrolled" }),
      uploadFile: (_ref, file) =>
        Promise.resolve({
          ok: true,
          observedValue: file.name,
        }),
      readText: () => Promise.resolve(raw.bodyText),
    },
  };
}
function call(name: string, args: unknown) {
  return {
    toolCalls: [
      {
        id: name,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}
function model() {
  const batches: Array<
    Array<{ question: string; proposedAnswer: string; evidencePolicy?: string }>
  > = [];
  let filled = false;
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>(
    (messages, tools, options) => {
      if (
        tools.some((tool) => tool.function.name === "report_question_kinds")
      ) {
        const questions = JSON.parse(String(messages[1]?.content)) as {
          question: string;
        }[];
        return Promise.resolve(
          call("report_question_kinds", {
            plainIndexes: questions.map((_, index) => index),
            flagged: [],
            tags: questions.map((entry, index) => ({
              index,
              kind:
                entry.question === "Why do you want this role?"
                  ? "motivation"
                  : "other",
              country: null,
              sourceId:
                facts.find((fact) => fact.question === entry.question)
                  ?.sourceId ??
                (entry.question === "Why do you want this role?"
                  ? "posting.description"
                  : null),
            })),
          }),
        );
      }
      if (tools.some((tool) => tool.function.name === "report_answer_checks")) {
        expect(options?.reasoningTask).toBe("claim_check");
        const input = JSON.parse(String(messages[1]?.content)) as {
          answers: (typeof batches)[number];
        };
        batches.push(input.answers);
        return Promise.resolve(
          call("report_answer_checks", {
            checks: input.answers.map((entry, index) => {
              const fact = facts.find(
                (fact) => fact.question === entry.question,
              );
              const evidence = fact
                ? [
                    {
                      kind: "applicant_fact",
                      source: "applicant",
                      path: fact.path,
                      quote: fact.quote,
                      claim: entry.proposedAnswer,
                    },
                  ]
                : [
                    {
                      kind: "role_motivation",
                      source: "posting",
                      path: "/description",
                      quote: sources.posting.description,
                      claim: entry.proposedAnswer,
                    },
                  ];
              // Adult threshold is supported by the history and degree together,
              // rather than a fabricated date of birth or exact age.
              if (fact === facts[2])
                evidence.push({
                  kind: "applicant_fact",
                  source: "resume",
                  path: "",
                  quote: sources.profile.baseResume.textContent!,
                  claim: entry.proposedAnswer,
                });
              return {
                index,
                supported: true,
                reason: "Supported by the recorded facts and history.",
                evidence,
              };
            }),
          }),
        );
      }
      if (filled) return Promise.resolve(call("finish", {}));
      filled = true;
      return Promise.resolve(
        call("fill_fields", {
          fields: [
            ...facts.map((fact, index) => ({
              tool: "select",
              ref: `c${index}`,
              option: fact.answer,
            })),
            {
              tool: "type",
              ref: "c3",
              text: "I would like to join your team.",
            },
          ],
        }),
      );
    },
  );
  return { client: { chatWithTools }, batches };
}

test("a page batches three factual inferences with its writing, preserves provenance, and rechecks at Send", async () => {
  const raw = page(facts.map((fact, index) => field(fact.question, index)));
  raw.controls.push({
    ...field("Why do you want this role?", 3),
    tagName: "textarea",
    options: [],
  });
  const m = model();
  const client: LLMClient = m.client;
  const c = config(raw);
  const result = await runApplyAgent(c, client);
  expect(result.filled).toHaveLength(4);
  expect(raw.controls.slice(0, 3).map((control) => control.value)).toEqual(
    facts.map((fact) => fact.answer),
  );
  facts.forEach((fact, index) => {
    expect(result.filled[index]?.answer).toMatchObject({
      value: fact.answer,
      sourceKind: "generated",
      sourceId: `inferred.c${index}`,
      provenanceLabel: "worked out from your profile",
    });
  });
  expect(m.batches).toHaveLength(1);
  expect(m.batches[0]?.map((entry) => entry.evidencePolicy)).toEqual([
    "factual_inference",
    "factual_inference",
    "factual_inference",
    undefined,
  ]);
  expect(
    result.timing?.requests.reduce(
      (count, turn) => count + (turn.storedFactFills ?? 0),
      0,
    ),
  ).toBe(0);
  expect(
    result.timing?.requests.reduce(
      (count, turn) => count + (turn.answersWaited ?? 0),
      0,
    ),
  ).toBe(4);
  const checked = await checkClassifiedApplicationAnswers({
    client,
    sources,
    payDisclosed: false,
    answers: facts.map(({ question, answer }) => ({ question, answer })),
    formControls: buildApplyFormObservation(raw, now().toISOString()).controls,
    formContext: { pageText: raw.bodyText, fields: [] },
  });
  expect(checked.map((check) => check.supported)).toEqual([true, true, true]);
  expect(m.batches).toHaveLength(2);
  const changedSources = {
    ...sources,
    profile: { ...sources.profile, currentCountry: "Canada" },
  };
  const refused = await checkClassifiedApplicationAnswers({
    client,
    sources: changedSources,
    payDisclosed: false,
    answers: [{ question: facts[1].question, answer: facts[1].answer }],
    formControls: buildApplyFormObservation(raw, now().toISOString()).controls,
    formContext: { pageText: raw.bodyText, fields: [] },
  });
  // The earlier model's Kosovo citation no longer exists in current facts.
  expect(refused[0]?.supported).toBe(false);
});

test.each([
  {
    label: facts[0].question,
    tagName: "input",
    inputType: "checkbox",
    answer: "Yes",
    toggle: true,
  },
  {
    label: "Years of professional experience beyond the first two",
    tagName: "input",
    inputType: "number",
    answer: "5",
    toggle: false,
  },
  {
    label: "Continent of residence",
    tagName: "input",
    inputType: "text",
    answer: "Europe",
    toggle: false,
  },
])(
  "a supported factual $inputType answer uses the checker and keeps its provenance",
  async (entry) => {
    const raw = page([
      {
        ...field(entry.label),
        tagName: entry.tagName,
        inputType: entry.inputType,
        options: [],
      },
    ]);
    const c = config(raw),
      observation = await c.hands.observe();
    const check = vi.fn(() =>
      Promise.resolve({
        supported: true,
        reason: "Follows from profile facts.",
        groundedIn: ["applicant:/yearsExperience"],
      }),
    );
    const proposal = entry.toggle
      ? { tool: "set_checkbox" as const, ref: "c0", checked: true }
      : { tool: "type" as const, ref: "c0", text: entry.answer };
    const deps = {
      config: c,
      now,
      guardState: createApplyGuardState(),
      classifyQuestions: () =>
        Promise.resolve(
          new Map([
            [
              entry.label,
              {
                asksAboutPay: false,
                declarationKind: null,
                answerTags: {
                  kind: "other" as const,
                  country: null,
                  sourceId: null,
                },
              },
            ],
          ]),
        ),
    };
    const offline = await executeApplyProposal(
      proposal,
      observation.signature,
      deps,
    );
    expect(offline.kind).toBe("suggestion");
    expect(raw.controls[0]?.value).toBe("");
    const result = await executeApplyProposal(proposal, observation.signature, {
      ...deps,
      checkWrittenAnswer: check,
    });
    expect(check).toHaveBeenCalledExactlyOnceWith(
      entry.label,
      entry.answer,
      "factual_inference",
    );
    expect(result).toMatchObject({
      kind: "filled",
      filled: {
        answer: {
          sourceId: "inferred.c0",
          provenanceLabel: "worked out from your profile",
          groundedIn: ["applicant:/yearsExperience"],
        },
      },
    });
  },
);

test.each([
  ["Gender", "other", "equal_opportunity_self_identification"],
  ["Disability status", "other", "equal_opportunity_self_identification"],
  ["Veteran status", "other", "equal_opportunity_self_identification"],
  ["Have you ever been convicted?", "other", "background_check_consent"],
  ["Criminal history", "other", null],
  ["I certify this information is true", "other", "truthfulness_certification"],
  ["Signature", "other", null],
  ["Expected salary", "salary", null],
  ["Current salary", "other", null],
  ["Write this yourself", "other", null],
  ["Explain in your own words", "own_words", null],
  ["Authorized to work in the UK?", "work_auth", null],
  ["Do you need visa sponsorship in the UK?", "sponsorship", null],
  ["Citizenship", "citizenship", null],
  ["Nationality", "nationality", null],
] as const)(
  "%s stays with the person before the checker",
  async (question, kind, declaration) => {
    const raw = page([field(question)]),
      c = config(raw);
    const observation = buildApplyFormObservation(raw, now().toISOString());
    const control = observation.controls[0];
    control.attestationKind = declaration;
    const tags: ApplyAnswerTags = {
      kind,
      country: kind === "work_auth" || kind === "sponsorship" ? "GB" : null,
      sourceId: null,
    };
    expect(
      classifyAnswerPermission({
        control,
        controls: [control],
        tags,
        sources,
        answer: "Yes",
        pageInstructions: "",
      }).kind,
    ).toBe("needs_you");
    const checker = vi.fn(() =>
      Promise.resolve({
        supported: true,
        reason: "Must never authorize this.",
      }),
    );
    const write = vi.spyOn(c.hands, "chooseOption");
    const result = await executeApplyProposal(
      { tool: "select", ref: control.ref, option: "Yes" },
      observation.signature,
      {
        config: c,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer: checker,
        classifyQuestions: () =>
          Promise.resolve(
            new Map([
              [
                question,
                {
                  asksAboutPay:
                    kind === "salary" || question === "Current salary",
                  declarationKind: declaration,
                  answerTags: tags,
                },
              ],
            ]),
          ),
      },
    );
    expect(result.kind).toBe("suggestion");
    expect(checker).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);

test.each([false, null] as const)(
  "a refusal or unavailable fact check leaves the proposal unentered (%s)",
  async (supported) => {
    const raw = page([field(facts[0].question)]),
      c = config(raw);
    const observation = await c.hands.observe();
    const checker = vi.fn(() =>
      supported === null
        ? Promise.reject(new Error("Unavailable"))
        : Promise.resolve({
            supported,
            reason: "The facts do not establish this answer.",
          }),
    );
    const result = await executeApplyProposal(
      { tool: "select", ref: "c0", option: "Yes" },
      observation.signature,
      {
        config: c,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer: checker,
        classifyQuestions: () =>
          Promise.resolve(
            new Map([
              [
                facts[0].question,
                {
                  asksAboutPay: false,
                  declarationKind: null,
                  answerTags: { kind: "other", country: null, sourceId: null },
                },
              ],
            ]),
          ),
      },
    );
    expect(checker).toHaveBeenCalledWith(
      facts[0].question,
      "Yes",
      "factual_inference",
    );
    expect(result.kind).toBe("suggestion");
    expect(raw.controls[0]?.value).toBe("");
  },
);

test.each([
  "missing phone",
  "posting as personal evidence",
  "fabricated quote",
])("factual inference refuses %s", async (scenario) => {
  const evidence =
    scenario === "missing phone"
      ? []
      : [
          {
            kind: "applicant_fact",
            source:
              scenario === "posting as personal evidence"
                ? "posting"
                : "applicant",
            path:
              scenario === "posting as personal evidence"
                ? "/description"
                : "/phone",
            quote:
              scenario === "posting as personal evidence"
                ? sources.posting.description
                : "+1 555 0100",
            claim: "Phone",
          },
        ];
  const client: LLMClient = {
    chatWithTools: () =>
      Promise.resolve(
        call("report_answer_checks", {
          checks: [
            { index: 0, supported: true, reason: "Lying checker", evidence },
          ],
        }),
      ),
  };
  expect(
    (
      await checkWrittenApplicationAnswers({
        client,
        sources,
        payDisclosed: false,
        answers: [
          {
            question: "Phone",
            answer: "+1 555 0100",
            evidencePolicy: "factual_inference",
          },
        ],
      })
    )[0]?.supported,
  ).toBe(false);
});
