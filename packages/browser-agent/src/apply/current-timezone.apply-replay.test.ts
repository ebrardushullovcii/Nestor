import {
  CandidateProfileSchema,
  type ApplyAnswerTags,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { buildApplyFormObservation } from "./page-hands";
import {
  createApplyGuardState,
  executeApplyProposal,
  questionPrompt,
} from "./policy-executor";
import type {
  ApplyAgentConfig,
  ApplyFormControl,
  ApplyPageHands,
  ApplyProposal,
} from "./types";

const at = "2026-10-27T03:00:00.000Z";
const question = "Are you based in a EU or equivalent timezone?";
const timezoneSource = "profile.currentCountry#timezone";
const pageUrl = "https://apply.example.test/application";
const call = (name: string, args: unknown) => ({
  toolCalls: [
    {
      id: "x",
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

function setup(
  label = question,
  country = "Kosovo",
  location = "Pristina, Kosovo",
  overrides: Partial<RawApplyControl> = {},
) {
  const field: RawApplyControl = {
    index: 0,
    tagName: "input",
    inputType: "text",
    role: "",
    id: "timezone",
    name: "timezone",
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
  const page: RawApplyPage = {
    url: pageUrl,
    title: "Apply",
    bodyText: "Apply for this role",
    controls: [field],
    actions: [
      { index: 0, label: "Submit Application", visible: true, disabled: false },
    ],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
  };
  const observation = () => buildApplyFormObservation(page, at);
  const fillText = vi.fn<ApplyPageHands["fillText"]>((_ref, value) => {
    field.value = value;
    return Promise.resolve({ ok: true, observedValue: value });
  });
  const chooseOption = vi.fn<ApplyPageHands["chooseOption"]>((_ref, value) => {
    field.value = value;
    field.selectedOptionLabel = value;
    return Promise.resolve({ ok: true, observedValue: value });
  });
  const setToggle = vi.fn<ApplyPageHands["setToggle"]>((ref, checked) => {
    for (const control of page.controls)
      control.checked = ref === `c${control.index}` ? checked : false;
    return Promise.resolve({
      ok: true,
      observedValue: checked ? "checked" : "unchecked",
    });
  });
  const clickAction = vi.fn<ApplyPageHands["clickAction"]>(() =>
    Promise.resolve({ ok: true, observedValue: "clicked" }),
  );
  const hands: ApplyPageHands = {
    observe: () => Promise.resolve(observation()),
    navigate: () => Promise.resolve({ ok: true, url: pageUrl }),
    goBack: () => Promise.resolve({ ok: true, url: pageUrl }),
    followLink: () => Promise.resolve({ ok: true, url: pageUrl }),
    readText: () => Promise.resolve(page.bodyText),
    wait: () => Promise.resolve(),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "scrolled" }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    fillText,
    chooseOption,
    setToggle,
    clickAction,
  };
  const config: ApplyAgentConfig = {
    hands,
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        fullName: "Robin Example",
        currentCountry: country || null,
        currentLocation: location || null,
        yearsExperience: 3,
        baseResume: {
          id: "resume",
          fileName: "synthetic.txt",
          uploadedAt: at,
          extractionStatus: "ready",
          textContent: "Engineer at Example Workshop.",
        },
      }),
      resumeText: "Engineer at Example Workshop.",
      posting: {
        title: "Engineer",
        company: "Example Workshop",
        location: "Remote",
        description: "Build tools.",
      },
      reusableAnswers: [],
      documents: [],
    },
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
      preApprovedAttestationKinds: [],
    },
    application: {
      jobId: "job",
      applicationId: "application",
      startingUrl: pageUrl,
    },
    siteLabel: "Synthetic application",
  };
  const tags: ApplyAnswerTags = {
    kind: "other",
    country: null,
    sourceId: timezoneSource,
  };
  const classification = (count: number) =>
    call("report_question_kinds", {
      plainIndexes: Array.from({ length: count }, (_, i) => i),
      flagged: [],
      tags: Array.from({ length: count }, (_, index) => ({ index, ...tags })),
    });
  const client: LLMClient = {
    chatWithTools: vi.fn(() =>
      Promise.resolve(classification(page.controls.length)),
    ),
  };
  const execute = (proposal: ApplyProposal) =>
    executeApplyProposal(proposal, observation().signature, {
      config,
      now: () => new Date(at),
      guardState: createApplyGuardState(),
      classifyQuestions: (controls: readonly ApplyFormControl[]) =>
        Promise.resolve(
          new Map(
            controls.map((control) => [
              questionPrompt(control),
              { asksAboutPay: false, declarationKind: null, answerTags: tags },
            ]),
          ),
        ),
      checkWrittenAnswer: () =>
        Promise.resolve({
          supported: true,
          reason: "A lying checker grants no location permission.",
          evidence: [],
        }),
    });
  const check = (answer: string) =>
    checkClassifiedApplicationAnswers({
      client,
      sources: config.sources,
      payDisclosed: false,
      application: config.application,
      answers: [
        { question: questionPrompt(observation().controls[0]), answer },
      ],
      formControls: observation().controls,
      formContext: { pageText: page.bodyText, fields: [] },
    });
  return {
    config,
    page,
    field,
    observation,
    fillText,
    chooseOption,
    setToggle,
    clickAction,
    execute,
    check,
    tags,
    classification,
  };
}

test.each([
  {
    country: "Kosovo",
    location: "Pristina, Kosovo",
    label: question,
    answer: "Yes",
  },
  {
    country: "Kosovo",
    location: "Pristina, Kosovo",
    label: "Are you in an European time zone?",
    answer: "Yes",
  },
  {
    country: "Albania",
    location: "Tirana, Albania",
    label: question,
    answer: "Yes",
  },
  {
    country: "United Kingdom",
    location: "London, United Kingdom",
    label: question,
    answer: "Yes",
  },
  {
    country: "",
    location: "Tirana, Albania",
    label: question,
    answer: "Yes",
    source: "profile.currentLocation#timezone",
  },
  {
    country: "Kosovo",
    location: "Pristina, Kosovo",
    label: "What is your current time zone?",
    answer: "Europe/Belgrade",
  },
  {
    country: "Japan",
    location: "Tokyo, Japan",
    label: "Are you based in a European timezone?",
    answer: "No",
  },
])(
  "a current-location answer is the same at Fill and Send: $country / $label",
  async (entry) => {
    const s = setup(entry.label, entry.country, entry.location);
    s.tags.sourceId = entry.source ?? timezoneSource;
    const before = JSON.stringify(s.config.sources.profile);
    const result = await s.execute({
      tool: "type",
      ref: "c0",
      text: "The model proposed an unrelated answer.",
    });
    expect(result.kind).toBe("filled");
    expect(s.fillText).toHaveBeenCalledWith("c0", entry.answer);
    expect((await s.check(entry.answer))[0]?.supported).toBe(true);
    expect(
      (await s.check(entry.answer === "Yes" ? "No" : "Yes"))[0]?.supported,
    ).toBe(false);
    expect(JSON.stringify(s.config.sources.profile)).toBe(before);
  },
);

test.each([
  { country: "United States", location: "United States", label: question },
  { country: "Germany", location: "Germany", label: question },
  { country: "", location: "", label: question },
  { country: "Kosovo", location: "Paris, France", label: question },
  { country: "Japan", location: "Tokyo, Japan", label: question },
  {
    country: "Kosovo",
    location: "Pristina, Kosovo",
    label: "Are you willing to work in a European timezone?",
  },
  {
    country: "Kosovo",
    location: "Pristina, Kosovo",
    label:
      "Are you based in a European timezone and authorized to work in the EU?",
  },
  {
    country: "Kosovo",
    location: "Pristina, Kosovo",
    label: "Are you not based in a European timezone?",
  },
  {
    country: "Kosovo",
    location: "Pristina, Kosovo",
    label: "Your professional reference's current timezone",
  },
])(
  "uncertain or different questions stay with the person: $country / $label",
  async (entry) => {
    const s = setup(entry.label, entry.country, entry.location);
    expect(
      (await s.execute({ tool: "type", ref: "c0", text: "Yes" })).kind,
    ).not.toBe("filled");
    expect(s.fillText).not.toHaveBeenCalled();
    expect((await s.check("Yes"))[0]?.supported).toBe(false);
  },
);

test.each([null, "profile.workEligibility.requiresVisaSponsorship"])(
  "a missing or unrelated classifier source grants nothing: %s",
  async (sourceId) => {
    const s = setup();
    s.tags.sourceId = sourceId;
    expect(
      (await s.execute({ tool: "type", ref: "c0", text: "Yes" })).kind,
    ).not.toBe("filled");
    expect(s.fillText).not.toHaveBeenCalled();
    expect((await s.check("Yes"))[0]?.supported).toBe(false);
  },
);

test.each(["preference", "own_words"] as const)(
  "current country cannot answer a gated %s question",
  async (kind) => {
    const s = setup();
    s.tags.kind = kind;
    expect(
      (await s.execute({ tool: "type", ref: "c0", text: "Yes" })).kind,
    ).not.toBe("filled");
    expect(s.fillText).not.toHaveBeenCalled();
    expect((await s.check("Yes"))[0]?.supported).toBe(false);
  },
);

test("a plain label cannot authorize extra conditions in its help", async () => {
  const s = setup(question, "Kosovo", "Pristina, Kosovo", {
    hint: "You must also have unrestricted permission to work in the EU.",
  });
  expect(
    (await s.execute({ tool: "type", ref: "c0", text: "Yes" })).kind,
  ).not.toBe("filled");
  expect(s.fillText).not.toHaveBeenCalled();
  expect((await s.check("Yes"))[0]?.supported).toBe(false);
});

test("the approved value is the Yes/No control actually pressed", async () => {
  const s = setup("No", "Kosovo", "Pristina, Kosovo", {
    inputType: "radio",
    groupLabel: question,
    value: "No",
  });
  s.page.controls.push({
    ...s.field,
    index: 1,
    id: "yes",
    label: "Yes",
    value: "Yes",
  });
  expect(
    (await s.execute({ tool: "set_checkbox", ref: "c0", checked: true })).kind,
  ).not.toBe("filled");
  expect(s.setToggle).not.toHaveBeenCalled();
  expect(
    (await s.execute({ tool: "set_checkbox", ref: "c1", checked: true })).kind,
  ).toBe("filled");
  expect(s.setToggle).toHaveBeenCalledExactlyOnceWith("c1", true);
  expect(s.page.controls.map((control) => control.checked)).toEqual([
    false,
    true,
  ]);
});

test("a select receives the proven value and Send rechecks changed country facts", async () => {
  const s = setup(question, "Kosovo", "Pristina, Kosovo", {
    tagName: "select",
    inputType: "",
    options: ["Yes", "No"],
  });
  expect(
    (await s.execute({ tool: "select", ref: "c0", option: "No" })).kind,
  ).toBe("filled");
  expect(s.chooseOption).toHaveBeenCalledExactlyOnceWith("c0", "Yes");
  expect((await s.check("Yes"))[0]?.supported).toBe(true);
  s.config.sources.profile = CandidateProfileSchema.parse({
    ...s.config.sources.profile,
    currentCountry: "United States",
    currentLocation: "United States",
  });
  expect((await s.check("Yes"))[0]?.supported).toBe(false);
});

test("a person's matching saved answer still answers an ambiguous-country question unchanged", async () => {
  const s = setup(question, "United States", "United States");
  s.config.sources.reusableAnswers = [
    {
      id: "timezone-answer",
      kind: "other",
      label: question,
      question,
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  s.tags.sourceId = "answerLibrary.timezone-answer";
  expect((await s.execute({ tool: "type", ref: "c0", text: "Yes" })).kind).toBe(
    "filled",
  );
  expect(s.fillText).toHaveBeenCalledExactlyOnceWith("c0", "Yes");
  expect((await s.check("Yes"))[0]?.supported).toBe(true);
});

test.each([
  { country: "Kosovo", location: "Pristina, Kosovo", outcome: "prepared" },
  { country: "United States", location: "United States", outcome: "paused" },
])(
  "a current-location fill or one handover takes two calls: $country",
  async ({ country, location, outcome }) => {
    const s = setup(question, country, location);
    s.config.modelQuestionClassification = true;
    s.config.runControl = { maxSteps: 4, noProgressStepLimit: 2 };
    const client: LLMClient = {
      chatWithTools: vi.fn<LLMClient["chatWithTools"]>((_messages, tools) =>
        Promise.resolve(
          tools[0]?.function.name === "report_question_kinds"
            ? s.classification(1)
            : call("fill_fields", {
                fields: [{ tool: "type", ref: "c0", text: "Yes" }],
                finishWhenReady: true,
              }),
        ),
      ),
    };
    const result = await runApplyAgent(s.config, client);
    expect(result.outcome).toBe(outcome);
    expect(s.field.value).toBe(outcome === "prepared" ? "Yes" : "");
    expect(result.pauses).toHaveLength(outcome === "prepared" ? 0 : 1);
    expect(client.chatWithTools).toHaveBeenCalledTimes(2);
    expect(s.clickAction).not.toHaveBeenCalled();
  },
);
