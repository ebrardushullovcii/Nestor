import {
  CandidateProfileSchema,
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
} from "./types";

const at = "2026-10-27T05:00:00.000Z";
const url = "https://apply.example.test/application";
const recorded = "+383 44 000 111";
const scopeKey = "r0form0";
const call = (name: string, args: unknown) => ({
  toolCalls: [
    {
      id: "call",
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

function raw(index: number, label: string): RawApplyControl {
  return {
    index,
    tagName: "input",
    inputType: "text",
    role: "",
    id: `field${index}`,
    name: `field${index}`,
    scopeKey,
    label,
    groupLabel: "Phone",
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
  };
}

/** The observed Greenhouse shape: a country combobox beside a tel input. */
function setup() {
  const country = {
    ...raw(0, "Country*"),
    role: "combobox",
    value: "",
    selectedOptionLabel: "Kosovo +383",
    options: ["Albania +355", "Kosovo +383", "United Kingdom +44"],
  };
  const phone = {
    ...raw(1, "Phone"),
    inputType: "tel",
    autocomplete: "tel-national",
  };
  const page: RawApplyPage = {
    url,
    title: "Apply",
    bodyText: "Application",
    controls: [country, phone],
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
  const fillText = vi.fn<ApplyPageHands["fillText"]>((ref, value) => {
    page.controls.find((control) => `c${control.index}` === ref)!.value = value;
    return Promise.resolve({ ok: true, observedValue: value });
  });
  const clickAction = vi.fn<ApplyPageHands["clickAction"]>(() =>
    Promise.resolve({ ok: true, observedValue: "clicked" }),
  );
  const hands: ApplyPageHands = {
    observe: () => Promise.resolve(observation()),
    fillText,
    clickAction,
    navigate: () => Promise.resolve({ ok: true, url }),
    goBack: () => Promise.resolve({ ok: true, url }),
    followLink: () => Promise.resolve({ ok: true, url }),
    wait: () => Promise.resolve(),
    readText: () => Promise.resolve(page.bodyText),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "scrolled" }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    chooseOption: (_ref, value) =>
      Promise.resolve({ ok: true, observedValue: value }),
  };
  const config: ApplyAgentConfig = {
    hands,
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        fullName: "Robin Example",
        yearsExperience: 3,
        phone: recorded,
        baseResume: {
          id: "resume",
          fileName: "synthetic.txt",
          uploadedAt: at,
          extractionStatus: "ready",
        },
      }),
      resumeText: null,
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
      startingUrl: url,
    },
    siteLabel: "Synthetic application",
  };
  let sourceId: string | null = "profile.phone";
  const tags = (control: ApplyFormControl) => ({
    kind: "other" as const,
    country: null,
    sourceId: control.ref === "c1" ? sourceId : null,
  });
  const classification = () =>
    call("report_question_kinds", {
      plainIndexes: page.controls.map((_, index) => index),
      flagged: [],
      tags: observation().controls.map((control, index) => ({
        index,
        ...tags(control),
      })),
    });
  const checkWrittenAnswer = vi.fn(() =>
    Promise.resolve({
      supported: true,
      reason: "A model cannot authorize a different phone number.",
      evidence: [],
    }),
  );
  const execute = (answer: string) =>
    executeApplyProposal(
      { tool: "type", ref: "c1", text: answer },
      observation().signature,
      {
        config,
        now: () => new Date(at),
        guardState: createApplyGuardState(),
        checkWrittenAnswer,
        classifyQuestions: (controls) =>
          Promise.resolve(
            new Map(
              controls.map((control) => [
                questionPrompt(control),
                {
                  asksAboutPay: false,
                  declarationKind: null,
                  answerTags: tags(control),
                },
              ]),
            ),
          ),
      },
    );
  const client: LLMClient = {
    chatWithTools: () => Promise.resolve(classification()),
  };
  const check = (answer: string) =>
    checkClassifiedApplicationAnswers({
      client,
      sources: config.sources,
      payDisclosed: false,
      application: config.application,
      answers: [{ question: "Phone", answer }],
      formControls: observation().controls,
      formContext: { pageText: page.bodyText, fields: [] },
    });
  return {
    page,
    phone,
    country,
    config,
    observation,
    fillText,
    clickAction,
    execute,
    check,
    checkWrittenAnswer,
    classification,
    setSource: (id: string | null) => {
      sourceId = id;
    },
  };
}

test.each([false, true])(
  "a country picker also labelled Phone stays with its number at Fill and Send (saved: %s)",
  async (saved) => {
    const s = setup();
    s.country.label = "Phone";
    if (saved) {
      s.config.sources.profile.phone = "+383 45 000 222";
      s.config.sources.reusableAnswers = [
        {
          id: "person-phone",
          kind: "other",
          label: "Phone",
          question: "Phone",
          answer: recorded,
          roleFamilies: [],
          proofEntryIds: [],
        },
      ];
      s.setSource("answerLibrary.person-phone");
    }
    expect((await s.execute("44000111")).kind).toBe("filled");
    expect((await s.check("44000111"))[0]?.supported).toBe(true);
    expect((await s.check("44000112"))[0]?.supported).toBe(false);
    s.country.selectedOptionLabel = "Albania +355";
    expect((await s.check("44000111"))[0]?.supported).toBe(false);
    expect(s.clickAction).not.toHaveBeenCalled();
  },
);

test.each([
  recorded,
  "+383 (44) 000-111",
  "38344000111",
  "44 000 111",
  "44000111",
])("the same recorded number passes Fill and Send: %s", async (answer) => {
  const s = setup();
  expect(s.observation().controls[1]).toMatchObject({
    telInput: true,
    scopeKey,
  });
  expect((await s.execute(answer)).kind).toBe("filled");
  expect(s.fillText).toHaveBeenCalledExactlyOnceWith("c1", answer);
  // Only Phone is an answer under review. Its current country picker is still
  // required evidence at Send, even though it isn't another reviewed answer.
  expect((await s.check(answer))[0]?.supported).toBe(true);
  expect(s.config.sources.profile.phone).toBe(recorded);
  expect(s.checkWrittenAnswer).not.toHaveBeenCalled();
});

test.each([
  "+383 44 000 112",
  "44000112",
  "+44 000 111",
  "000111",
  "Call 38344000111 instead",
])(
  "a different or ambiguous number is refused at Fill and Send: %s",
  async (answer) => {
    const s = setup();
    expect((await s.execute(answer)).kind).not.toBe("filled");
    expect(s.fillText).not.toHaveBeenCalled();
    expect((await s.check(answer))[0]?.supported).toBe(false);
    expect(s.checkWrittenAnswer).not.toHaveBeenCalled();
  },
);

test.each([
  "wrong code",
  "unselected",
  "offered only",
  "invalid",
  "other form",
  "missing scope",
  "other group",
  "another phone",
  "two pickers",
  "another invalid picker",
  "two codes",
])(
  "national digits need this phone's unambiguous current picker: %s",
  async (shape) => {
    const s = setup();
    if (shape === "wrong code") s.country.selectedOptionLabel = "Albania +355";
    if (shape === "unselected") {
      s.country.selectedOptionLabel = "";
      s.country.value = "Kosovo +383";
    }
    if (shape === "offered only")
      s.country.selectedOptionLabel = "Choose a country";
    if (shape === "invalid") s.country.invalid = true;
    if (shape === "other form") s.country.scopeKey = "r0form1";
    if (shape === "missing scope") {
      delete s.country.scopeKey;
      delete s.phone.scopeKey;
    }
    if (shape === "other group")
      s.country.groupLabel = "Professional reference";
    if (shape === "another phone")
      s.page.controls.push({ ...raw(2, "Other contact"), inputType: "tel" });
    if (shape === "two pickers")
      s.page.controls.push({ ...s.country, index: 2, id: "second-country" });
    if (shape === "another invalid picker")
      s.page.controls.push({
        ...s.country,
        index: 2,
        id: "second-country",
        invalid: true,
      });
    if (shape === "two codes")
      s.country.selectedOptionLabel = "Kosovo +383 / Albania +355";
    expect((await s.execute("44000111")).kind).not.toBe("filled");
    expect(s.fillText).not.toHaveBeenCalled();
    expect((await s.check("44000111"))[0]?.supported).toBe(false);
  },
);

test("Send rechecks the current selection rather than the earlier fill's code", async () => {
  const s = setup();
  expect((await s.execute("44000111")).kind).toBe("filled");
  s.country.selectedOptionLabel = "United Kingdom +44";
  expect((await s.check("44000111"))[0]?.supported).toBe(false);
  // The full number still has all the Profile's digits and needs no prefix.
  expect((await s.check("+383 (44) 000-111"))[0]?.supported).toBe(true);
});

test.each([null, "profile.email", "answerLibrary.unrelated-answer"])(
  "a missing or unrelated phone source grants nothing: %s",
  async (sourceId) => {
    const s = setup();
    s.config.sources.reusableAnswers = [
      {
        id: "unrelated-answer",
        kind: "other",
        label: "Email",
        question: "Email",
        answer: recorded,
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    s.setSource(sourceId);
    expect((await s.execute("38344000111")).kind).not.toBe("filled");
    expect((await s.check("38344000111"))[0]?.supported).toBe(false);
    expect(s.fillText).not.toHaveBeenCalled();
  },
);

test("formatting cannot put the applicant's number into a reference field", async () => {
  const s = setup();
  s.phone.hint = "The telephone number of your professional reference.";
  expect((await s.execute("+383 (44) 000-111")).kind).not.toBe("filled");
  expect(s.fillText).not.toHaveBeenCalled();
  expect((await s.check("+383 (44) 000-111"))[0]?.supported).toBe(false);
});

test("the preferred application phone is the recorded number used by the gate", async () => {
  const s = setup();
  s.config.sources.profile.applicationIdentity.preferredPhone =
    "+383 45 000 222";
  expect((await s.execute("44000111")).kind).not.toBe("filled");
  expect((await s.execute("45000222")).kind).toBe("filled");
  expect((await s.check("45000222"))[0]?.supported).toBe(true);
});

test("the person's remembered Phone answer clears once with the national number", async () => {
  const s = setup();
  s.country.label = "Phone";
  s.config.sources.reusableAnswers = [
    {
      id: "phone-answer",
      kind: "other",
      label: "Phone",
      question: "Phone",
      answer: recorded,
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  s.setSource("answerLibrary.phone-answer");
  s.config.modelQuestionClassification = true;
  s.config.runControl = { maxSteps: 4, noProgressStepLimit: 2 };
  const client: LLMClient = {
    chatWithTools: vi.fn<LLMClient["chatWithTools"]>((_messages, tools) =>
      Promise.resolve(
        tools[0]?.function.name === "report_question_kinds"
          ? s.classification()
          : call("fill_fields", {
              fields: [{ tool: "type", ref: "c1", text: "44000111" }],
              finishWhenReady: true,
            }),
      ),
    ),
  };
  const result = await runApplyAgent(s.config, client);
  expect(result.pauses).toEqual([]);
  expect(result.outcome).toBe("prepared");
  expect(s.fillText).toHaveBeenCalledExactlyOnceWith("c1", "44000111");
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  expect(s.clickAction).not.toHaveBeenCalled();
  expect((await s.check("44000111"))[0]?.supported).toBe(true);
  expect((await s.check("44000112"))[0]?.supported).toBe(false);
  expect((await s.execute("44000112")).kind).not.toBe("filled");
  expect(s.fillText).toHaveBeenCalledTimes(1);
});
