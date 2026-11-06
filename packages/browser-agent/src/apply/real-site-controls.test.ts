import {
  CandidateProfileSchema,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { reportedSecurityChallenge } from "./blockers";
import { classifyAnswerPermission } from "./answer-source-catalog";
import { fillPressFor } from "./fill-presses";
import { buildApplyFormObservation } from "./page-hands";
import {
  buildPendingQuestion,
  createApplyGuardState,
  executeApplyProposal,
} from "./policy-executor";
import { questionPrompt } from "./question-text";
import type { ApplyAgentConfig } from "./types";

const now = () => new Date("2026-11-06T00:00:00Z");
function field(overrides: Partial<RawApplyControl> = {}): RawApplyControl {
  return {
    index: 0,
    tagName: "input",
    inputType: "text",
    role: "",
    id: "name",
    name: "name",
    scopeKey: "form0",
    label: "Full name",
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
function page(overrides: Partial<RawApplyPage> = {}): RawApplyPage {
  return {
    networkMutationCount: 0,
    url: "https://employer.example.test/jobs/1",
    title: "Engineer",
    bodyText: "Apply for Engineer",
    headings: [],
    controls: [],
    actions: [],
    clickables: [],
    links: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
    ...overrides,
  };
}
function config(raw: RawApplyPage): ApplyAgentConfig {
  const write = (ref: string, value: string) => {
    const c = raw.controls.find((c) => (c.ref ?? `c${c.index}`) === ref)!;
    c.value = value;
    return Promise.resolve({ ok: true as const, observedValue: value });
  };
  return {
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        fullName: "Jamie Example",
        currentCountry: "Germany",
        summary: "Twelve years building React and TypeScript.",
        yearsExperience: 12,
        workEligibility: {
          authorizedWorkCountries: ["Germany"],
          requiresVisaSponsorship: false,
        },
        baseResume: {
          id: "synthetic",
          fileName: "synthetic.txt",
          uploadedAt: now().toISOString(),
        },
      }),
      resumeText: null,
      documents: [],
      reusableAnswers: [],
      posting: {
        title: "Engineer",
        company: "Synthetic Workshop",
        location: "Germany",
        resolvedCountry: "DE",
        description: "Build software.",
      },
    },
    application: {
      jobId: "synthetic",
      applicationId: "synthetic",
      startingUrl: raw.url!,
    },
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    siteLabel: "Synthetic Workshop",
    now,
    hands: {
      observe: () =>
        Promise.resolve(buildApplyFormObservation(raw, now().toISOString())),
      fillText: write,
      chooseOption: write,
      setToggle: (ref, checked) => {
        raw.controls.find((c) => (c.ref ?? `c${c.index}`) === ref)!.checked =
          checked;
        return Promise.resolve({
          ok: true as const,
          observedValue: String(checked),
        });
      },
      navigate: (url) => Promise.resolve({ ok: true, url }),
      goBack: () => Promise.resolve({ ok: true, url: raw.url! }),
      followLink: () => Promise.resolve({ ok: true, url: raw.url! }),
      clickAction: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      clickElement: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      scroll: () => Promise.resolve({ ok: true, observedValue: "scrolled" }),
      wait: () => Promise.resolve(),
      readText: () => Promise.resolve(raw.bodyText),
      uploadFile: () =>
        Promise.resolve({ ok: false, error: "No file supplied" }),
    },
  };
}
function finishModel(
  forPerson: string[],
  reason = "The remaining questions need you.",
): LLMClient {
  return {
    chatWithTools: () =>
      Promise.resolve({
        toolCalls: [
          {
            id: "finish",
            type: "function",
            function: {
              name: "finish",
              arguments: JSON.stringify({
                reason,
                needsPerson: true,
                forPerson,
              }),
            },
          },
        ],
      }),
  };
}
function radios(question: string, options: string[]): RawApplyControl[] {
  return options.map((label, index) =>
    field({
      index,
      tagName: "contenteditable",
      inputType: "radio",
      role: "radio",
      name: "",
      id: `choice-${index}`,
      label: `${question} ${label}`,
      groupLabel: question,
      sectionPath: [question],
      value: "",
    }),
  );
}

test.each(["Apply Manually", "Apply for This Job"])(
  "the ordinary %s button opens the form inside a non-submitting form",
  (label) => {
    const raw = page({
      actions: [
        {
          index: 0,
          label,
          visible: true,
          disabled: false,
          inForm: true,
          formAction: "https://employer.example.test/jobs/1",
          formMethod: "POST",
          submitsForm: false,
        },
      ],
    });
    expect(
      fillPressFor({
        config: config(raw),
        observation: buildApplyFormObservation(raw, now().toISOString()),
        ref: "a0",
        state: createApplyGuardState(),
      }),
    ).toMatchObject({ kind: "open_form" });
    raw.actions[0].submitsForm = true;
    expect(
      fillPressFor({
        config: config(raw),
        observation: buildApplyFormObservation(raw, now().toISOString()),
        ref: "a0",
        state: createApplyGuardState(),
      }),
    ).toBeNull();
  },
);

test("a prefilled read-only sharing URL does not block the ordinary Apply opener", () => {
  const raw = page({
    controls: [
      field({
        label: "Link to This Job",
        readOnly: true,
        required: false,
        value: page().url!,
      }),
    ],
    actions: [
      { index: 0, label: "Apply for This Job", visible: true, disabled: false },
    ],
  });
  expect(
    fillPressFor({
      config: config(raw),
      observation: buildApplyFormObservation(raw, now().toISOString()),
      ref: "a0",
      state: createApplyGuardState(),
    }),
  ).toMatchObject({ kind: "open_form" });
  raw.controls[0].readOnly = false;
  expect(
    fillPressFor({
      config: config(raw),
      observation: buildApplyFormObservation(raw, now().toISOString()),
      ref: "a0",
      state: createApplyGuardState(),
    }),
  ).toBeNull();
});

test("a plain cookie dismissal outside the form stays an ordinary press", () => {
  const raw = page({
    bodyText:
      "Privacy Notice. This website uses cookies to improve your web experience.",
    actions: [{ index: 0, label: "dismiss", visible: true, disabled: false }],
  });
  const press = () =>
    fillPressFor({
      config: config(raw),
      observation: buildApplyFormObservation(raw, now().toISOString()),
      ref: "a0",
      state: createApplyGuardState(),
    });
  expect(press()).toMatchObject({ kind: "cookie_banner" });
  raw.actions[0].inForm = true;
  expect(press()).toBeNull();
  raw.actions[0].inForm = false;
  raw.bodyText = "Application details";
  expect(press()).toBeNull();
});

test("declining non-necessary cookies stays an ordinary privacy choice", () => {
  const raw = page({
    actions: [
      {
        index: 0,
        label: "Accept all cookies",
        section: "Cookies",
        visible: true,
        disabled: false,
      },
      {
        index: 1,
        label: "Decline all non-necessary cookies",
        section: "Cookies",
        visible: true,
        disabled: false,
      },
    ],
  });
  expect(
    fillPressFor({
      config: config(raw),
      observation: buildApplyFormObservation(raw, now().toISOString()),
      ref: "a1",
      state: createApplyGuardState(),
    }),
  ).toMatchObject({ kind: "cookie_banner", ref: "a1" });
});

test("a phone-country dialog is part of the visible phone control", () => {
  const raw = page({
    controls: [
      field({ inputType: "tel", label: "Phone", phoneCallingCode: "+380" }),
    ],
    actions: [
      {
        index: 0,
        label: "Change country, selected Ukraine (+380)",
        visible: true,
        disabled: false,
        inForm: true,
        submitsForm: false,
        formAction: page().url!,
      },
    ],
  });
  expect(
    fillPressFor({
      config: config(raw),
      observation: buildApplyFormObservation(raw, now().toISOString()),
      ref: "a0",
      state: createApplyGuardState(),
    }),
  ).toMatchObject({ kind: "field_part" });
  raw.controls = [];
  expect(
    fillPressFor({
      config: config(raw),
      observation: buildApplyFormObservation(raw, now().toISOString()),
      ref: "a0",
      state: createApplyGuardState(),
    }),
  ).toBeNull();
});

test("overview and application tabs remain ordinary navigation", () => {
  const raw = page({
    clickables: [
      {
        index: 0,
        role: "tab",
        tagName: "div",
        label: "Overview",
        visible: true,
        disabled: false,
        topOffset: 0,
      },
      {
        index: 1,
        role: "tab",
        tagName: "div",
        label: "Application",
        visible: true,
        disabled: false,
        topOffset: 0,
      },
    ],
  });
  const observation = buildApplyFormObservation(raw, now().toISOString());
  for (const entry of observation.clickables)
    expect(
      fillPressFor({
        config: config(raw),
        observation,
        ref: entry.ref,
        state: createApplyGuardState(),
      }),
    ).toMatchObject({ kind: "field_part" });
});

test("a five-option ARIA radio field produces one question with all five options", async () => {
  const question = "What is your level of proficiency in English?";
  const options = [
    "Native/Fluent",
    "Advanced",
    "Intermediate",
    "Basic",
    "Beginner",
  ];
  const raw = page({ controls: radios(question, options) });
  const observation = buildApplyFormObservation(raw, now().toISOString());
  const questions = observation.controls.map((control) =>
    buildPendingQuestion({
      control,
      jobId: "synthetic",
      detectedAt: now().toISOString(),
      suggestion: null,
      siblings: observation.controls,
    }),
  );
  expect(new Set(questions.map((q) => q.id)).size).toBe(1);
  expect(questions[0].answerOptions).toEqual(options);
  const result = await runApplyAgent(
    config(raw),
    finishModel(observation.controls.map((c) => c.ref)),
  );
  const pending = result.pauses.flatMap(
    (p) => p.questions ?? (p.question ? [p.question] : []),
  );
  expect(new Set(pending.map((q) => q.id)).size).toBe(1);
  expect(pending[0].prompt).toBe(question);
});

test("the React Yes/No group has one target and uses the independent fact check", async () => {
  const question =
    "Do you have at least 1 year of experience building responsive web applications using modern JavaScript frameworks (e.g., React, Vue, or Angular)?";
  const raw = page({ controls: radios(question, ["YES", "NO"]) });
  const input = config(raw),
    observation = await input.hands.observe(),
    control = observation.controls[0];
  const checkWrittenAnswer = vi.fn(() =>
    Promise.resolve({
      supported: true,
      reason: "The recorded summary says twelve years building React.",
    }),
  );
  const outcome = await executeApplyProposal(
    { tool: "set_checkbox", ref: control.ref, checked: true },
    observation.signature,
    {
      config: input,
      now,
      guardState: createApplyGuardState(),
      checkWrittenAnswer,
      classifyQuestions: () =>
        Promise.resolve(
          new Map([
            [
              questionPrompt(control),
              {
                asksAboutPay: false,
                declarationKind: null,
                answerTags: {
                  kind: "other",
                  sourceId: "profile.summary",
                  country: null,
                },
              },
            ],
          ]),
        ),
    },
  );
  expect(outcome.kind).toBe("filled");
  expect(checkWrittenAnswer).toHaveBeenCalledOnce();
  expect(raw.controls[0].checked).toBe(true);
  expect(raw.controls[1].checked).toBe(false);
});

test("a yes/no residence answer reaches the whole-question check instead of a country literal veto", () => {
  const raw = page({
    controls: [
      field({
        tagName: "select",
        label: "Is your current place of residence in Germany?* (required)",
        options: ["Yes", "No"],
      }),
    ],
  });
  const input = config(raw),
    observation = buildApplyFormObservation(raw, now().toISOString()),
    control = observation.controls[0];
  expect(
    classifyAnswerPermission({
      control,
      controls: observation.controls,
      sources: input.sources,
      tags: {
        kind: "residence_country",
        sourceId: "profile.currentCountry",
        country: null,
      },
      answer: "Yes",
      pageInstructions: "",
    }),
  ).toMatchObject({ kind: "inference", evidencePolicy: "factual_inference" });
});

test.each([
  ["Yes", true],
  ["No", false],
] as const)(
  "residence proposal %s still requires independent support before a write",
  async (answer, supported) => {
    const raw = page({
      controls: [
        field({
          tagName: "select",
          label: "Is your current place of residence in Germany?",
          options: ["Yes", "No"],
        }),
      ],
    });
    const input = config(raw),
      observation = await input.hands.observe(),
      control = observation.controls[0];
    const checkWrittenAnswer = vi.fn(() =>
      Promise.resolve({
        supported,
        reason: supported
          ? "The applicant lives in Germany."
          : "The applicant lives in Germany, so No contradicts the recorded country.",
      }),
    );
    const choose = vi.spyOn(input.hands, "chooseOption");
    const outcome = await executeApplyProposal(
      { tool: "select", ref: control.ref, option: answer },
      observation.signature,
      {
        config: input,
        now,
        guardState: createApplyGuardState(),
        checkWrittenAnswer,
        classifyQuestions: () =>
          Promise.resolve(
            new Map([
              [
                questionPrompt(control),
                {
                  asksAboutPay: false,
                  declarationKind: null,
                  answerTags: {
                    kind: "residence_country",
                    country: null,
                    sourceId: "profile.currentCountry",
                  },
                },
              ],
            ]),
          ),
      },
    );
    expect(checkWrittenAnswer).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe(supported ? "filled" : "suggestion");
    expect(choose).toHaveBeenCalledTimes(supported ? 1 : 0);
  },
);

test("work permission through citizenship OR a permit is checked as a whole legal question", () => {
  const raw = page({
    controls: [
      field({
        tagName: "select",
        label:
          "Are you currently eligible to work at the job's location either via EU citizenship or visa/work permit?*",
        options: ["Yes", "No"],
      }),
    ],
  });
  const input = config(raw),
    observation = buildApplyFormObservation(raw, now().toISOString()),
    control = observation.controls[0];
  expect(
    classifyAnswerPermission({
      control,
      controls: observation.controls,
      sources: input.sources,
      tags: {
        kind: "work_auth",
        sourceId: "profile.workEligibility.authorizedWorkCountries.0",
        country: "DE",
        hasAdditionalConditions: false,
      },
      answer: "Yes",
      pageInstructions: "",
    }),
  ).toMatchObject({ kind: "inference", evidencePolicy: "eligibility" });
});

test("a visible verification slider becomes an access handoff", () => {
  const raw = page({
    title: "Verification Required",
    bodyText:
      "Verification Required — Slide right to secure your access. Audio verification is available.",
  });
  expect(
    buildApplyFormObservation(raw, now().toISOString()).blocker,
  ).toMatchObject({ code: "security_challenge", requiresPerson: true });
});

test("a completed security check is not reported as a slider handoff", () => {
  expect(
    reportedSecurityChallenge(
      "No security check remains; the form is complete.",
    ),
  ).toBeNull();
});

test("hCaptcha named only in forPerson is an access handoff with no typed question", async () => {
  const result = await runApplyAgent(
    config(page()),
    finishModel(
      [
        "Complete the hCaptcha verification (shows 'Please try again') and press Next on the GDPR Login page",
      ],
      "The site requires a manual access step.",
    ),
  );
  expect(result.outcome).toBe("paused");
  expect(
    result.pauses.some((p) => p.blocker?.code === "security_challenge"),
  ).toBe(true);
  expect(
    result.pauses.flatMap(
      (p) => p.questions ?? (p.question ? [p.question] : []),
    ),
  ).toEqual([]);
});

async function uploadRun(
  dropOnly: boolean,
  counter: "known" | "changed" | "missing" = "known",
  changingLabel = false,
) {
  const raw = page({
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
    controls: [
      field({
        inputType: "file",
        label: "Resume",
        name: "resume",
        value: "",
        upload: {
          described: "",
          nearby: "Choose a file or drop it here",
          shown: false,
        },
      }),
    ],
  });
  if (counter === "missing") delete raw.networkMutationCount;
  const input = config(raw);
  input.uploadWaitMs = 0;
  input.sources.documents = [
    {
      id: "resume",
      kind: "resume",
      label: "Synthetic CV",
      fileName: "synthetic.pdf",
      mimeType: "application/pdf",
      loadBytes: () => Promise.resolve(new TextEncoder().encode("synthetic")),
    },
  ];
  const methods: string[] = [];
  let writes = 0;
  input.hands.uploadFile = (_ref, file) => {
    const method = file.method ?? "input";
    methods.push(method);
    if (changingLabel)
      raw.controls[0].label = `Resume/CV ${file.name} ATTACH RESUME/CV Couldn't auto-read resume`;
    const accepted = dropOnly && method === "drop";
    const noRequest = dropOnly && !accepted;
    if (counter === "changed" && method === "chooser") {
      writes++;
      raw.networkMutationCount = (raw.networkMutationCount ?? 0) + 1;
    }
    if (!noRequest) {
      writes++;
      raw.networkMutationCount = (raw.networkMutationCount ?? 0) + 1;
    }
    raw.controls[0].value = "";
    raw.controls[0].invalid = !accepted;
    raw.controls[0].upload = {
      described: accepted
        ? "File attached"
        : noRequest
          ? "Your file was not accepted. Use the attachment control."
          : "Your file upload failed: Document service unavailable",
      nearby: "Choose a file or drop it here",
      shown: false,
      fileName: file.name,
      ...(!noRequest
        ? {
            network: accepted ? ("accepted" as const) : ("rejected" as const),
            requests: Array.from({ length: writes }, () => ({
              endpoint: "https://employer.example.test/attachments",
              status: accepted ? 200 : 503,
              blocked: false,
            })),
          }
        : {}),
    };
    return Promise.resolve({ ok: true as const, observedValue: file.name });
  };
  let calls = 0;
  const model: LLMClient = {
    chatWithTools: () =>
      Promise.resolve({
        toolCalls: [
          {
            id: `call-${calls}`,
            type: "function",
            function:
              calls++ === 0
                ? {
                    name: "upload",
                    arguments: JSON.stringify({
                      ref: "c0",
                      documentId: "resume",
                    }),
                  }
                : {
                    name: "finish",
                    arguments: JSON.stringify({ reason: "Checked the file." }),
                  },
          },
        ],
      }),
  };
  return { result: await runApplyAgent(input, model), methods, writes };
}

test("an upload that replaces the form with an error is a technical stop, not a homepage chore", async () => {
  const raw = page({
    controls: [field({ inputType: "file", name: "resume", label: "Resume" })],
  });
  const input = config(raw);
  input.sources.documents = [
    {
      id: "resume",
      kind: "resume",
      label: "Synthetic CV",
      fileName: "synthetic.pdf",
      mimeType: "application/pdf",
      loadBytes: () => Promise.resolve(new TextEncoder().encode("synthetic")),
    },
  ];
  input.hands.uploadFile = (_ref, file) => {
    raw.controls = [];
    raw.bodyText = "Sorry, an unknown error occurred. Go to homepage";
    raw.links = [
      {
        index: 0,
        label: "Go to homepage",
        href: "https://employer.example.test/",
        target: "",
        visible: true,
        topOffset: 0,
      },
    ];
    raw.networkMutationCount = 1;
    return Promise.resolve({ ok: true, observedValue: file.name });
  };
  let calls = 0;
  const model: LLMClient = {
    chatWithTools: () =>
      Promise.resolve({
        toolCalls: [
          {
            id: `call-${calls}`,
            type: "function",
            function:
              calls++ === 0
                ? {
                    name: "upload",
                    arguments: JSON.stringify({
                      ref: "c0",
                      documentId: "resume",
                    }),
                  }
                : {
                    name: "follow_link",
                    arguments: JSON.stringify({ ref: "l0" }),
                  },
          },
        ],
      }),
  };
  const result = await runApplyAgent(input, model);
  expect(result.outcome).toBe("stuck");
  expect(result.reason).toContain("attachment field disappeared");
  expect(result.pauses).toEqual([]);
});

test("a rejected recovery upload fails with its cause and creates no candidate question", async () => {
  const { result, methods, writes } = await uploadRun(false);
  expect(methods).toEqual(["input", "chooser"]);
  expect(writes).toBe(2);
  expect(result.outcome).toBe("stuck");
  expect(result.reason).toContain("Document service unavailable");
  expect(
    result.pauses.flatMap(
      (p) => p.questions ?? (p.question ? [p.question] : []),
    ),
  ).toEqual([]);
  expect(result.readyToSend).toBeNull();
});

test("a filename added to the file label does not reset retries or create another upload question", async () => {
  const { result, methods } = await uploadRun(false, "known", true);
  expect(methods).toEqual(["input", "chooser"]);
  expect(result.outcome).toBe("stuck");
  expect(result.pauses).toEqual([]);
  expect(result.reviewAttachments).toEqual([]);
});

test("the recovery pass drops only after a chooser with no request and no attachment", async () => {
  const { result, methods, writes } = await uploadRun(true);
  expect(methods).toEqual(["input", "chooser", "drop"]);
  expect(writes).toBe(1);
  expect(result.outcome, result.notes.join("\n")).toBe("prepared");
  expect(result.pauses).toEqual([]);
});

test.each(["changed", "missing"] as const)(
  "a %s mutation count prevents drop even when the file ledger reports no request",
  async (counter) => {
    const { result, methods } = await uploadRun(true, counter);
    expect(methods).toEqual(["input", "chooser"]);
    expect(result.outcome).toBe("stuck");
    expect(result.pauses).toEqual([]);
    expect(result.readyToSend).toBeNull();
  },
);

test.each([true, false])(
  "a deferred file shown beside Add file is accepted without an upload request (input retained: %s)",
  async (retained) => {
    const raw = page({
      bodyText:
        "Your application\nError submitting application\nThere was an error submitting your application. Please try again.\nDocuments\nPlease upload your application documents here (in total max. 20 MB).\nCV*\nAdd file",
      actions: [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ],
      controls: [
        field({
          inputType: "file",
          name: "documents.cv",
          label: "Upload CV",
          visible: false,
        }),
      ],
    });
    const input = config(raw);
    input.sources.documents = [
      {
        id: "resume",
        kind: "resume",
        label: "Synthetic CV",
        fileName: "synthetic.pdf",
        mimeType: "application/pdf",
        loadBytes: () =>
          Promise.resolve(new TextEncoder().encode("Synthetic CV")),
      },
    ];
    const upload = vi.fn((_ref: string, file: { name: string }) => {
      raw.controls[0].value = retained ? file.name : "";
      raw.controls[0].upload = {
        described: "",
        nearby: `Documents\nPlease upload your application documents here (in total max. 20 MB).\nCV*\n${file.name}\n×\nAdd file`,
        shown: false,
        selectedFileName: file.name,
        ...(retained ? { fileName: file.name } : {}),
      };
      return Promise.resolve({ ok: true as const, observedValue: file.name });
    });
    input.hands.uploadFile = upload;
    let calls = 0;
    const model: LLMClient = {
      chatWithTools: () =>
        Promise.resolve({
          toolCalls: [
            {
              id: `call-${calls}`,
              type: "function",
              function:
                calls++ === 0
                  ? {
                      name: "upload",
                      arguments: JSON.stringify({
                        ref: "c0",
                        documentId: "resume",
                      }),
                    }
                  : {
                      name: "finish",
                      arguments: JSON.stringify({
                        reason: "The selected CV is kept for final Send.",
                      }),
                    },
            },
          ],
        }),
    };
    const result = await runApplyAgent(input, model);
    expect(upload).toHaveBeenCalledOnce();
    expect(raw.networkMutationCount).toBe(0);
    expect(result.outcome, result.notes.join("\n")).toBe("prepared");
    expect(result.pauses).toEqual([]);
    expect(result.reviewAttachments?.map((file) => file.fileName)).toContain(
      "synthetic.pdf",
    );
  },
);

test("a native tab opens a panel without becoming a write or a final Send", async () => {
  const raw = page({
    actions: [
      {
        index: 0,
        label: "Submit application",
        role: "tab",
        visible: true,
        disabled: false,
        inForm: true,
        formAction: page().url!,
        formMethod: "POST",
        submitsForm: false,
      },
    ],
  });
  const input = config(raw),
    observation = await input.hands.observe(),
    guardState = createApplyGuardState();
  const click = vi.spyOn(input.hands, "clickElement");
  expect(observation.actions[0]).toMatchObject({
    role: "tab",
    kind: "other",
    submitsForm: false,
  });
  const outcome = await executeApplyProposal(
    { tool: "click", ref: "a0" },
    observation.signature,
    { config: input, now, guardState },
  );
  expect(outcome.kind).toBe("moved");
  expect(click).toHaveBeenCalledOnce();
  expect(guardState.hasWritten).toBe(false);
  expect(guardState.fieldWrites).toBe(0);
  const submit = await executeApplyProposal(
    { tool: "submit_application", ref: "a0" },
    observation.signature,
    { config: input, now, guardState },
  );
  expect(submit.kind).toBe("refused");
  expect(click).toHaveBeenCalledOnce();
});

test("a long-text LinkedIn URL request can check the recorded URL without treating it as prose", () => {
  const raw = page({
    controls: [
      field({
        tagName: "textarea",
        label:
          "If you have a LinkedIn profile, please provide the URL below (if you don't have a LinkedIn profile, put N/A)",
      }),
    ],
  });
  const input = config(raw);
  input.sources.profile.linkedinUrl =
    "https://www.linkedin.com/in/jamie-example-test";
  const observation = buildApplyFormObservation(raw, now().toISOString()),
    control = observation.controls[0];
  expect(
    classifyAnswerPermission({
      control,
      controls: observation.controls,
      sources: input.sources,
      tags: { kind: "other", sourceId: "profile.linkedinUrl", country: null },
      answer: input.sources.profile.linkedinUrl,
      pageInstructions: "",
    }),
  ).toMatchObject({ kind: "inference", evidencePolicy: "factual_inference" });
});
