import {
  CandidateProfileSchema,
  createFreshStartCandidateProfile,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import { manualEntryPressFor } from "./fill-presses";
import type { ApplyAgentConfig, ApplyPageHands } from "./types";

function field(index: number, label: string): RawApplyControl {
  return {
    index,
    label,
    tagName: "input",
    inputType: "text",
    role: "",
    id: `f${index}`,
    name: `f${index}`,
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
  };
}
function setup(controls: RawApplyControl[]) {
  const raw: RawApplyPage = {
    url: "https://replica.example.test/apply",
    title: "Application",
    bodyText: "Personal information",
    controls,
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
  };
  const write = vi.fn((ref: string, value: string) => {
    const control = raw.controls.find((entry) => `c${entry.index}` === ref)!;
    control.value = value;
    control.invalid = false;
    return Promise.resolve({ ok: true as const, observedValue: value });
  });
  const hands: ApplyPageHands = {
    observe: () =>
      Promise.resolve(buildApplyFormObservation(raw, new Date().toISOString())),
    fillText: write,
    chooseOption: write,
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: () => Promise.resolve({ ok: false, error: "Upload refused" }),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    clickAction: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        observedValue: "clicked",
      }),
    ),
    navigate: () => Promise.resolve({ ok: true, url: raw.url! }),
    followLink: () => Promise.resolve({ ok: true, url: raw.url! }),
    goBack: () => Promise.resolve({ ok: true, url: raw.url! }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    readText: () => Promise.resolve(raw.bodyText),
  };
  const input: ApplyAgentConfig = {
    hands,
    modelQuestionClassification: true,
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    application: {
      jobId: "job",
      applicationId: "application",
      startingUrl: raw.url!,
    },
    siteLabel: "Synthetic replica",
    sources: {
      profile: CandidateProfileSchema.parse({
        ...createFreshStartCandidateProfile(),
        id: "synthetic",
        firstName: "Jamie",
        lastName: "Rivers",
        fullName: "Jamie Rivers",
        email: "jamie@example.test",
        currentCity: "Riverside",
        currentCountry: "Germany",
        currentLocation: "Riverside, Germany",
      }),
      posting: {
        title: "Engineer",
        company: "Synthetic employer",
        location: "Germany",
        description: "Build software",
      },
      resumeText: null,
      reusableAnswers: [],
      documents: [],
    },
  };
  return { raw, input, write };
}
function client(
  turns: { name: string; args: Record<string, unknown> }[],
): LLMClient {
  let turn = 0;
  const report = (name: string, args: Record<string, unknown>) =>
    Promise.resolve({
      toolCalls: [
        {
          id: `${name}-${turn}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
  return {
    chatWithTools: (messages, tools) => {
      const name = tools[0]?.function.name;
      if (name === "report_question_kinds") {
        const questions = JSON.parse(messages[1].content) as {
          index: number;
          question: string;
        }[];
        const sources: Record<string, string> = {
          City: "profile.currentCity",
          "City*": "profile.currentCity",
          "Country/Region": "profile.currentCountry",
        };
        return report(name, {
          plainIndexes: questions.map((q) => q.index),
          flagged: [],
          tags: questions.map((q) => ({
            index: q.index,
            kind:
              q.question === "Country/Region" ? "residence_country" : "other",
            country: null,
            sourceId: sources[q.question] ?? null,
          })),
        });
      }
      if (name === "match_application_answer")
        return report(name, { sourceId: null });
      const current = turns[Math.min(turn++, turns.length - 1)];
      return report(current.name, current.args);
    },
  };
}

test("a document handoff fills known name and email fields before asking only for the missing file", async () => {
  const { raw, input } = setup([
    { ...field(0, "Resume / CV"), inputType: "file", accept: ".docx" },
    field(1, "First Name"),
    field(2, "Last Name"),
    { ...field(3, "Email"), inputType: "email" },
  ]);
  input.sources.documents = [
    {
      id: "cv",
      kind: "resume",
      label: "Synthetic CV",
      fileName: "synthetic.pdf",
      mimeType: "application/pdf",
      loadBytes: () => Promise.resolve(new Uint8Array([1])),
    },
  ];
  const result = await runApplyAgent(
    input,
    client([{ name: "upload", args: { ref: "c0", documentId: "cv" } }]),
  );
  expect(raw.controls.slice(1).map((entry) => entry.value)).toEqual([
    "Jamie",
    "Rivers",
    "jamie@example.test",
  ]);
  expect(
    result.pauses
      .flatMap(
        (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
      )
      .map((q) => q.prompt),
  ).toEqual(["Resume / CV"]);
  expect(input.hands.clickAction).not.toHaveBeenCalled();
});

test.each([false, true])(
  "manual entry remains fillable after a refused city picker (earlier refusal: %s)",
  async (earlierRefusal) => {
    const { raw, input, write } = setup([
      { ...field(0, "City*"), role: "combobox" },
    ]);
    raw.clickables = [
      {
        index: 0,
        label: "Cannot find your city? Click here to fill in manually",
        visible: true,
        tagName: "button",
        role: "button",
        topOffset: 0,
        inForm: true,
      },
    ];
    if (earlierRefusal)
      input.initialPickerAttempts = [
        {
          question: "city",
          tried: ["riverside", "riverside germany"],
          notOffered: [],
          offeredOptions: [],
        },
      ];
    input.hands.chooseOption = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: "No matching city in this list.",
        reason: "option_not_offered" as const,
        offeredOptions: [],
      }),
    );
    input.hands.clickElement = vi.fn(() => {
      raw.controls[0] = { ...field(0, "City*"), role: "", value: "" };
      raw.controls.push(field(1, "Country/Region"));
      raw.clickables = [];
      return Promise.resolve({
        ok: true as const,
        observedValue: "Manual entry opened",
      });
    });
    const result = await runApplyAgent(
      input,
      client([
        {
          name: "select",
          args: {
            ref: "c0",
            option: "Riverside",
            storedFactId: "profile.currentCity",
          },
        },
        { name: "click", args: { ref: "e0" } },
        {
          name: "fill_fields",
          args: {
            fields: [
              {
                tool: "type",
                ref: "c0",
                text: "Riverside",
                storedFactId: "profile.currentCity",
              },
              {
                tool: "type",
                ref: "c1",
                text: "Germany",
                storedFactId: "profile.currentCountry",
              },
            ],
            finishWhenReady: true,
          },
        },
        {
          name: "finish",
          args: { reason: "The manual fields are filled.", needsPerson: false },
        },
      ]),
    );
    expect(
      input.hands.clickElement,
      JSON.stringify(result.timeline),
    ).toHaveBeenCalledWith("e0");
    expect(
      raw.controls.map((entry) => entry.value),
      JSON.stringify(result.timeline),
    ).toEqual(["Riverside", "Germany"]);
    expect(write).toHaveBeenCalledWith("c0", "Riverside");
    expect(
      result.pauses.flatMap(
        (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
      ),
    ).toEqual([]);
    expect(input.hands.clickElement).toHaveBeenCalledWith("e0");
    expect(input.hands.clickAction).not.toHaveBeenCalled();
  },
);

test("reopening an earlier handoff rechecks known identity instead of asking it again", async () => {
  const { raw, input } = setup([
    field(0, "First Name"),
    field(1, "Last Name"),
    { ...field(2, "Email"), inputType: "email" },
  ]);
  input.replay = { answers: [], attachments: [], path: [], formUrl: raw.url! };
  input.initialUnansweredPickerQuestions = raw.controls.map((control) => ({
    prompt: control.label,
    options: [],
  }));
  const result = await runApplyAgent(
    input,
    client([
      {
        name: "finish",
        args: { reason: "The form is complete.", needsPerson: false },
      },
    ]),
  );
  expect(raw.controls.map((control) => control.value)).toEqual([
    "Jamie",
    "Rivers",
    "jamie@example.test",
  ]);
  expect(result.pauses).toEqual([]);
  expect(input.hands.clickAction).not.toHaveBeenCalled();
});

test("manual-entry wording never authorizes a submit or a control outside the form", () => {
  const { raw } = setup([field(0, "City")]);
  const entry = {
    index: 0,
    label: "Enter manually",
    visible: true,
    tagName: "button",
    role: "button",
    topOffset: 0,
    inForm: true,
    submitsForm: false,
  };
  for (const change of [
    { submitsForm: true },
    { formAction: raw.url!, submitsForm: undefined },
    { inForm: false },
    { label: "Submit application manually" },
  ]) {
    raw.actions = [{ ...entry, disabled: false, ...change }];
    expect(
      manualEntryPressFor(
        buildApplyFormObservation(raw, new Date().toISOString()),
        "a0",
      ),
    ).toBeNull();
  }
});

test("a manual-entry button may inherit its form action when it explicitly does not submit", () => {
  const { raw } = setup([field(0, "City")]);
  raw.actions = [
    {
      index: 0,
      label: "Enter manually",
      visible: true,
      disabled: false,
      inForm: true,
      formAction: raw.url!,
      submitsForm: false,
    },
  ];
  expect(
    manualEntryPressFor(
      buildApplyFormObservation(raw, new Date().toISOString()),
      "a0",
    ),
  ).toEqual({ kind: "field_part", ref: "a0" });
});
