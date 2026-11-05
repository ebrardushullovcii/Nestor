import { CandidateProfileSchema } from "@nestor/contracts";
import type { RawApplyControl, RawApplyPage } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { createHash } from "node:crypto";

import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyAgentConfig, ApplyPageHands } from "./types";

/**
 * Fill in for me on a numbered wizard whose Save and Continue saves the step
 * through the site's own request before the next step shows (B6). The site
 * only moves on when its save can go out, which needs the per-action
 * intermediate-write window; a read-only local press cannot save it.
 */

const RECEIPT_LABEL = "Step press not confirmed";

function field(): RawApplyControl {
  return {
    index: 0,
    tagName: "input",
    inputType: "text",
    role: "",
    id: "f0",
    name: "f0",
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
    value: "Robin Ashford",
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
  };
}

type Variant = "saves" | "unchanged" | "wrong_total" | "no_numbers";

function wizard(
  variant: Variant,
  options: { emptyStep?: boolean; startStep?: number } = {},
) {
  const state = {
    step: options.startStep ?? 1,
    total: 3,
    windowOpen: false,
    saves: [] as number[],
    events: [] as string[],
    finalPresses: 0,
  };
  const source: RawApplyPage = {
    url: "https://apply.example.test/wizard",
    title: "Apply",
    bodyText: "Apply for the role",
    controls: [],
    actions: [],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
  };
  const render = () => {
    const review = state.step >= state.total;
    source.stepLabel =
      variant === "no_numbers"
        ? "My Information"
        : `Step ${state.step} of ${state.total}`;
    source.bodyText =
      variant === "no_numbers"
        ? "Tell us about yourself"
        : `Step ${state.step} of ${state.total}`;
    source.headings = review
      ? [{ level: 1, text: "Review your application" }]
      : [{ level: 1, text: `Section ${state.step}` }];
    source.controls =
      options.emptyStep && state.step === 1
        ? []
        : [{ ...field(), id: `f${state.step}`, name: `f${state.step}` }];
    source.actions = review
      ? [
          {
            index: 0,
            label: "Submit application",
            visible: true,
            disabled: false,
            inForm: true,
            submitsForm: true,
          },
        ]
      : [
          {
            index: 0,
            label: "Save and Continue",
            visible: true,
            disabled: false,
            inForm: true,
            submitsForm: false,
          },
        ];
  };
  render();
  const advance = () => {
    if (variant === "unchanged") return;
    if (variant === "wrong_total") {
      state.step += 1;
      state.total = 4;
    } else state.step += 1;
    render();
  };
  const hands: ApplyPageHands & {
    clickBoundAction: NonNullable<ApplyPageHands["clickWithoutWrites"]>;
  } = {
    observe: () =>
      Promise.resolve(
        buildApplyFormObservation(source, "2026-11-03T10:00:00.000Z"),
      ),
    navigate: () => Promise.resolve({ ok: true, url: source.url! }),
    clickElement: vi.fn((ref: string) => {
      state.events.push(`click ${ref}`);
      if (source.actions[0]?.label === "Submit application")
        state.finalPresses += 1;
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    goBack: () => Promise.resolve({ ok: true, url: source.url! }),
    readText: () => Promise.resolve(source.bodyText),
    fillText: (_ref, value) =>
      Promise.resolve({ ok: true, observedValue: value }),
    chooseOption: (_ref, option) =>
      Promise.resolve({ ok: true, observedValue: option }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () => Promise.resolve({ ok: true, url: source.url! }),
    // The read-only local press: the site's save cannot go out, so a
    // server-backed step does not move.
    clickWithoutWrites: vi.fn((expected: { label: string }) => {
      state.events.push(`local ${expected.label}`);
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    }),
    // The bound press: the step saves only while the window is open.
    clickBoundAction: vi.fn((expected: { label: string }) => {
      state.events.push(
        `press ${expected.label} on ${state.step}/${state.total} window=${state.windowOpen}`,
      );
      if (state.windowOpen) {
        if (variant !== "unchanged") state.saves.push(state.step);
        advance();
      }
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    }),
  };
  const config: ApplyAgentConfig = {
    hands,
    safety: {
      readBlockedAttempt: () => Promise.resolve(null),
      registerPreparedValue: () => Promise.resolve(),
      openIntermediateWriteWindow: () => {
        state.windowOpen = true;
        state.events.push("open window");
        return Promise.resolve();
      },
      closeIntermediateWriteWindow: () => {
        state.windowOpen = false;
        state.events.push("close window");
        return Promise.resolve();
      },
      closeUploadWindow: () => Promise.resolve(),
      checkServiceWorker: () => Promise.resolve(null),
    },
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "candidate_test",
        firstName: "Robin",
        lastName: "Ashford",
        fullName: "Robin Ashford",
        headline: "Platform engineer",
        summary: "Builds dependable internal tools.",
        currentLocation: "Manchester",
        workEligibility: { authorizedWorkCountries: ["United Kingdom"] },
        yearsExperience: 8,
        baseResume: {
          id: "resume_test",
          fileName: "resume.txt",
          uploadedAt: "2026-09-01T09:00:00.000Z",
          textContent: "8 years of platform engineering.",
          textUpdatedAt: "2026-09-01T09:00:00.000Z",
          extractionStatus: "ready",
        },
      }),
      resumeText: null,
      posting: {
        title: "Platform Engineer",
        company: "Northwind Tools",
        location: "Manchester",
        description: "Own the internal platform.",
      },
      reusableAnswers: [],
      documents: [],
    },
    application: {
      jobId: "job_test",
      applicationId: "application_test",
      startingUrl: source.url!,
    },
    siteLabel: "the careers site",
    now: () => new Date("2026-11-03T10:00:00.000Z"),
    // Fill in for me: the site may save as it is filled, the person sends.
    intermediateWritesAuthorized: true,
    pressesFormButtons: false,
  };
  return { state, source, hands, config };
}

/** A model that only ever says the visible step is filled, or clicks one ref. */
function model(turn: () => { name: string; args: Record<string, unknown> }) {
  let calls = 0;
  const client: LLMClient = {
    chatWithTools: (messages, definitions) => {
      if (definitions[0]?.function.name === "report_answer_checks") {
        const asked = JSON.parse(String(messages[1]?.content ?? "{}")) as {
          answers?: unknown[];
        };
        return Promise.resolve({
          toolCalls: [
            {
              id: "check",
              type: "function" as const,
              function: {
                name: "report_answer_checks",
                arguments: JSON.stringify({
                  checks: (asked.answers ?? []).map((_answer, index) => ({
                    index,
                    supported: true,
                    reason: "Supported.",
                    evidence: [],
                  })),
                }),
              },
            },
          ],
        });
      }
      calls += 1;
      const next = turn();
      return Promise.resolve({
        toolCalls: [
          {
            id: `call_${calls}`,
            type: "function" as const,
            function: { name: next.name, arguments: JSON.stringify(next.args) },
          },
        ],
      });
    },
  };
  return client;
}
const finishing = () =>
  model(() => ({ name: "finish", args: { reason: "This step is filled." } }));

test.each(["saved", "other_form", "rejected"] as const)(
  "a native step carries only its verified file forward: %s",
  async (variant) => {
    const w = wizard("saves");
    const bytes = new TextEncoder().encode("Resume");
    w.config.sources.documents = [
      {
        id: "resume_document",
        fileName: "resume.txt",
        mimeType: "text/plain",
        label: "Your CV",
        kind: "resume",
        loadBytes: () => Promise.resolve(bytes),
      },
    ];
    let held = false;
    const observe = w.hands.observe;
    w.hands.observe = () => {
      if (w.state.step === 1) {
        w.source.actions[0] = {
          ...w.source.actions[0],
          submitsForm: true,
          formAction: w.source.url!,
          formMethod: "POST",
        };
        w.source.controls = [
          field(),
          {
            ...field(),
            index: 1,
            id: "resume",
            name: "resume",
            inputType: "file",
            label: "Resume",
            value: held ? "fakepath/resume.txt" : "",
            upload: {
              described: "",
              nearby: "",
              shown: true,
              formSubmits: true,
              formAction:
                w.source.url! + (variant === "other_form" ? "/other" : ""),
              ...(held
                ? {
                    fileName: "resume.txt",
                    fileSize: bytes.length,
                    selectedFileName: "resume.txt",
                    selectedFileSize: bytes.length,
                  }
                : {}),
            },
          },
        ];
      } else
        w.source.uploads = [
          {
            fileName: "resume.txt",
            network: variant === "rejected" ? "rejected" : "unconfirmed",
          },
        ];
      return observe();
    };
    w.hands.uploadFile = () => {
      held = true;
      return Promise.resolve({ ok: true, observedValue: "resume.txt" });
    };
    const result = await runApplyAgent(
      { ...w.config, uploadWaitMs: 0 },
      model(() =>
        !held
          ? {
              name: "upload",
              args: { ref: "c1", documentId: "resume_document" },
            }
          : { name: "finish", args: { reason: "Filled" } },
      ),
    );
    expect(
      result.pauses
        .flatMap((p) => p.questions ?? [])
        .some((q) => q.prompt.includes("upload")),
    ).toBe(variant !== "saved");
    if (variant === "saved")
      expect(
        result.reviewAttachments?.find((a) => a.fileName === "resume.txt")
          ?.savedSha256,
      ).toBe(createHash("sha256").update(bytes).digest("hex"));
    else
      expect(result.reviewAttachments?.some((a) => a.savedSha256)).toBe(false);
  },
);

test.each([true, false])(
  "a restored native file receipt requires the same source bytes (%s)",
  async (same) => {
    const w = wizard("saves", { startStep: 2 });
    const bytes = new TextEncoder().encode("Resume");
    w.config.sources.documents = [
      {
        id: "resume_document",
        fileName: "resume.txt",
        mimeType: "text/plain",
        label: "Your CV",
        kind: "resume",
        loadBytes: () =>
          Promise.resolve(same ? bytes : new TextEncoder().encode("Changed")),
      },
    ];
    w.config.replay = {
      answers: [],
      path: [],
      attachments: [
        {
          fieldKey: w.source.url + "|field:file:0|Resume",
          label: "Your CV",
          field: "Resume",
          fileName: "resume.txt",
          savedSha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    };
    const result = await runApplyAgent(w.config, finishing());
    expect(result.reviewAttachments?.some((a) => a.savedSha256)).toBe(same);
  },
);

test("a fresh structured review retains known earlier contact values without editable controls", async () => {
  const w = wizard("saves", { startStep: 3 });
  w.source.controls = [];
  w.source.summaryRows = [
    { label: "Full name", value: "Robin Ashford" },
    { label: "Unknown private value", value: "not a supplied fact" },
  ];
  const result = await runApplyAgent(w.config, finishing());
  expect(
    result.reviewFilled?.map((a) => [
      a.label,
      a.answer.value,
      a.answer.sourceId,
    ]),
  ).toEqual([["Full name", "Robin Ashford", "observed.summary_0"]]);
});

test("a structured summary does not duplicate a control retained with its section context", async () => {
  const w = wizard("saves", { startStep: 3 });
  w.source.controls = [
    { ...field(), groupLabel: "Step 1 of 3: Contact details" },
  ];
  w.source.summaryRows = [{ label: "Full name", value: "Robin Ashford" }];
  const result = await runApplyAgent(w.config, finishing());
  expect(result.reviewFilled).toHaveLength(1);
  expect(result.reviewFilled?.[0]?.label).toContain("Contact details");
  expect(result.reviewFilled?.[0]?.answer.value).toBe("Robin Ashford");
});

test("an empty optional advance restores the newly exposed recorded answer before the model", async () => {
  const w = wizard("saves", { emptyStep: true });
  let restored = false;
  const observe = w.hands.observe;
  w.hands.observe = () => {
    const control = w.source.controls[0];
    if (w.state.step === 2 && control && !restored) control.value = "";
    return observe();
  };
  w.hands.fillText = vi.fn((_ref: string, value: string) => {
    restored = true;
    const control = w.source.controls[0];
    if (control) control.value = value;
    return Promise.resolve({ ok: true as const, observedValue: value });
  });
  w.config.replay = {
    answers: [
      {
        question: "Full name",
        answer: "Robin Ashford",
        source: "your saved name",
        written: false,
        groundedIn: [],
        sourceId: "profile.fullName",
      },
    ],
    attachments: [],
    path: [],
  };
  const result = await runApplyAgent(w.config, finishing());
  expect(w.hands.fillText).toHaveBeenCalledTimes(1);
  expect(vi.mocked(w.hands.fillText).mock.calls[0]?.[1]).toBe("Robin Ashford");
  expect(result.outcome).toBe("prepared");
  expect(w.state.finalPresses).toBe(0);
});

test("Fill advances numbered server-backed steps 1 and 2 with their saves and stops at review with no final press", async () => {
  const { state, hands, config } = wizard("saves");
  const result = await runApplyAgent(config, finishing());
  expect(state.saves).toEqual([1, 2]);
  expect(state.step).toBe(3);
  expect(hands.clickBoundAction).toHaveBeenCalledTimes(2);
  expect(hands.clickWithoutWrites).not.toHaveBeenCalled();
  // Each press happened inside its own freshly opened window.
  expect(state.events.filter((event) => event.startsWith("press"))).toEqual([
    "press Save and Continue on 1/3 window=true",
    "press Save and Continue on 2/3 window=true",
  ]);
  expect(state.finalPresses).toBe(0);
  expect(hands.clickElement).not.toHaveBeenCalled();
  expect(result.pauses).toEqual([]);
  expect(result.outcome).toBe("prepared");
  expect(
    result.timeline.filter((entry) => entry.label === RECEIPT_LABEL),
  ).toEqual([]);
});

test("an empty numbered step is advanced through the same windowed press", async () => {
  const { state, hands, config } = wizard("saves", { emptyStep: true });
  const result = await runApplyAgent(config, finishing());
  expect(state.saves).toEqual([1, 2]);
  expect(hands.clickBoundAction).toHaveBeenCalledTimes(2);
  expect(hands.clickWithoutWrites).not.toHaveBeenCalled();
  expect(state.finalPresses).toBe(0);
  expect(result.outcome).toBe("prepared");
});

test("a step without numbers is handed to the person without any press", async () => {
  const { state, hands, config } = wizard("no_numbers");
  // The model presses the step when told the form has another one.
  const turns = [
    { name: "finish", args: { reason: "This step is filled." } },
    { name: "click", args: { ref: "a0" } },
    { name: "finish", args: { reason: "This step is filled." } },
  ];
  let turn = 0;
  const result = await runApplyAgent(
    config,
    model(() => turns[Math.min(turn++, turns.length - 1)]),
  );
  expect(hands.clickBoundAction).not.toHaveBeenCalled();
  expect(hands.clickWithoutWrites).not.toHaveBeenCalled();
  expect(hands.clickElement).not.toHaveBeenCalled();
  expect(state.saves).toEqual([]);
  expect(state.step).toBe(1);
  expect(result.outcome).toBe("paused");
  expect(result.pauses.at(-1)?.question?.prompt).toBe(
    'Press "Save and Continue" on the site, then continue',
  );
});

test.each(["unchanged", "wrong_total"] as const)(
  "a press whose counter does not show exactly the next step (%s) stops after one press and records it",
  async (variant) => {
    const { state, hands, config } = wizard(variant);
    const result = await runApplyAgent(config, finishing());
    expect(hands.clickBoundAction).toHaveBeenCalledTimes(1);
    expect(hands.clickWithoutWrites).not.toHaveBeenCalled();
    expect(state.finalPresses).toBe(0);
    expect(result.outcome).toBe("paused");
    const pause = result.pauses.at(-1)!;
    expect(pause.question?.prompt).toBe(
      'Press "Save and Continue" on the site, then continue',
    );
    expect(pause.question?.askReason).toMatchObject({
      kind: "page_refused",
      check: "step_not_confirmed",
    });
    expect(pause.summary).toContain(
      'Nestor pressed "Save and Continue" once on step 1 of 3',
    );
    // The window that press used is shut, not left for later writes.
    expect(state.events.at(-1)).toBe("close window");
    expect(
      result.timeline.filter((entry) => entry.label === RECEIPT_LABEL),
    ).toHaveLength(1);
  },
);

test.each(["finish", "click"] as const)(
  "a step an earlier run could not confirm is never pressed again by a %s",
  async (path) => {
    const first = wizard("unchanged");
    const earlier = await runApplyAgent(first.config, finishing());
    const receipt = earlier.timeline.find(
      (entry) => entry.label === RECEIPT_LABEL,
    )!;
    expect(receipt).toBeDefined();
    // The continued run on the same page, now with a site that would save.
    const again = wizard("saves");
    const result = await runApplyAgent(
      {
        ...again.config,
        earlierActivity: [
          {
            id: "checkpoint_earlier",
            at: receipt.at,
            label: receipt.label!,
            detail: receipt.text,
            state: "in_progress",
            visualEvidence: [],
          },
        ],
      },
      path === "finish"
        ? finishing()
        : model(() => ({ name: "click", args: { ref: "a0" } })),
    );
    expect(again.hands.clickBoundAction).not.toHaveBeenCalled();
    expect(again.hands.clickWithoutWrites).not.toHaveBeenCalled();
    expect(again.hands.clickElement).not.toHaveBeenCalled();
    expect(again.state.saves).toEqual([]);
    expect(result.outcome).toBe("paused");
    expect(result.pauses.at(-1)?.question?.askReason?.check).toBe(
      "step_not_confirmed",
    );
    // The receipt is carried on for the next run, once.
    expect(
      result.timeline.filter((entry) => entry.label === RECEIPT_LABEL),
    ).toHaveLength(1);
  },
);

test("without intermediate-write authority a numbered step keeps the read-only local press", async () => {
  const { hands, config } = wizard("saves");
  const result = await runApplyAgent(
    { ...config, intermediateWritesAuthorized: false },
    finishing(),
  );
  expect(hands.clickBoundAction).not.toHaveBeenCalled();
  expect(hands.clickWithoutWrites).toHaveBeenCalledTimes(1);
  expect(result.outcome).toBe("paused");
});

test("the review step's send control is never pressed from Fill in for me", async () => {
  const { state, hands, config } = wizard("saves", { startStep: 3 });
  await runApplyAgent(
    config,
    model(() => ({ name: "click", args: { ref: "a0" } })),
  );
  expect(hands.clickBoundAction).not.toHaveBeenCalled();
  expect(hands.clickWithoutWrites).not.toHaveBeenCalled();
  expect(hands.clickElement).not.toHaveBeenCalled();
  expect(state.finalPresses).toBe(0);
});

// Council D1: the run stores what it confirmed on each step it advanced.
test("confirmed advances store one receipt per step from the pre-press page, then the final page", async () => {
  const { config } = wizard("saves");
  const result = await runApplyAgent(config, finishing());
  const receipts = result.stepReceipts ?? [];
  expect(receipts.map((receipt) => [receipt.kind, receipt.stepIndex])).toEqual([
    ["advance", 1],
    ["advance", 2],
    ["final", 3],
  ]);
  for (const [step, receipt] of receipts.slice(0, 2).entries()) {
    expect(receipt.resultId).toBe("application_test");
    expect(receipt.origin).toBe("https://apply.example.test");
    expect(receipt.stepTotal).toBe(3);
    expect(receipt.fields).toHaveLength(1);
    // The site showed the name and Nestor never wrote it.
    // The label is the card's own prompt, with its repeat note on step 2.
    expect(receipt.fields[0]).toMatchObject({
      label: step ? "Full name (repeated question on step 2)" : "Full name",
      value: "Robin Ashford",
      provenance: "site_unchanged",
    });
  }
});

test.each(["unchanged", "wrong_total"] as const)(
  "an unconfirmed press (%s) stores an unconfirmed marker and no advance receipt",
  async (variant) => {
    const { config } = wizard(variant);
    const result = await runApplyAgent(config, finishing());
    const kinds = (result.stepReceipts ?? []).map((receipt) => receipt.kind);
    expect(kinds).not.toContain("advance");
    expect(kinds.filter((kind) => kind === "unconfirmed")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("final");
  },
);

test("a step without numbers stores no advance receipt", async () => {
  const { config } = wizard("no_numbers");
  const turns = [
    { name: "finish", args: { reason: "This step is filled." } },
    { name: "click", args: { ref: "a0" } },
    { name: "finish", args: { reason: "This step is filled." } },
  ];
  let turn = 0;
  const result = await runApplyAgent(
    config,
    model(() => turns[Math.min(turn++, turns.length - 1)]),
  );
  expect(
    (result.stepReceipts ?? []).filter((receipt) => receipt.kind === "advance"),
  ).toEqual([]);
});

// Council D5: the model restating the press already handed over is that one
// handover; anything more is still asked.
async function handoverRun(
  forPerson: string[],
  page: (source: RawApplyPage) => void = () => undefined,
) {
  const { hands, config, source } = wizard("no_numbers");
  page(source);
  const turns = [
    { name: "finish", args: { reason: "This step is filled." } },
    { name: "click", args: { ref: "a0" } },
    {
      name: "finish",
      args: {
        reason: "The site needs the person to continue.",
        needsPerson: true,
        forPerson,
      },
    },
  ];
  let turn = 0;
  const result = await runApplyAgent(
    config,
    model(() => turns[Math.min(turn++, turns.length - 1)]),
  );
  const asked = result.pauses.flatMap(
    (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
  );
  return { hands, result, asked };
}

test.each([
  // The wording the native no-number run produced (Batch 3).
  [
    "Please press Save and Continue on the Clientnest Replica application page to advance to the next step (First name and Referral code are already filled).",
  ],
  ['Press "Save and Continue" on the site, then continue'],
  ["Press Save and Continue to move to the next step"],
  ["Click the Save and Continue button."],
])("%s is the one step handover", async (item) => {
  const { hands, asked } = await handoverRun([item]);
  expect(hands.clickBoundAction).not.toHaveBeenCalled();
  expect(hands.clickWithoutWrites).not.toHaveBeenCalled();
  expect(hands.clickElement).not.toHaveBeenCalled();
  expect(new Set(asked.map((question) => question.id))).toEqual(
    new Set(["step_handover"]),
  );
  expect(
    asked.find((question) => question.id === "step_handover")?.askReason,
  ).toMatchObject({ kind: "page_refused", check: "step_handover" });
});

test.each([
  ["Press Save and Continue, then tell us your notice period"],
  ["Press Submit application"],
  ["What is your notice period?"],
])("%s is still asked beside the handover", async (item) => {
  const { asked } = await handoverRun([item]);
  expect(asked.some((question) => question.id === "step_handover")).toBe(true);
  expect(asked.some((question) => question.id !== "step_handover")).toBe(true);
});

test("a press instruction naming an open field is still asked", async () => {
  const { asked } = await handoverRun(
    ["Press Save and Continue after you enter your Notice period"],
    (source) => {
      source.controls.push({
        ...field(),
        index: 1,
        id: "notice",
        name: "notice",
        label: "Notice period",
        value: "",
        required: false,
      });
    },
  );
  // The handover stays one item; the instruction that names the open field
  // is not folded into it.
  expect(
    asked.filter((question) => question.id === "step_handover"),
  ).toHaveLength(1);
  expect(asked.map((question) => question.prompt)).toContain(
    "Press Save and Continue after you enter your Notice period",
  );
});

test("with two different advance buttons a press instruction is still asked", async () => {
  const { asked } = await handoverRun(["Press Continue"], (source) => {
    source.actions.push({
      index: 1,
      label: "Continue",
      visible: true,
      disabled: false,
      inForm: true,
      submitsForm: false,
    });
  });
  expect(
    asked.filter((question) => question.id === "step_handover"),
  ).toHaveLength(1);
  expect(asked.some((question) => question.id !== "step_handover")).toBe(true);
});

test("a real fact named with the press keeps its own question", async () => {
  const { asked } = await handoverRun([
    "Press Save and Continue",
    "Tell us your notice period",
  ]);
  expect(
    asked.filter((question) => question.id === "step_handover"),
  ).toHaveLength(1);
  expect(
    asked.some((question) => /notice period/iu.test(question.prompt)),
  ).toBe(true);
});
