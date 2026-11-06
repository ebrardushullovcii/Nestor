import { CandidateProfileSchema } from "@nestor/contracts";
import type { RawApplyControl, RawApplyPage } from "@nestor/contracts";
import { expect, test, vi } from "vitest";

import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyAgentConfig, ApplyPageHands } from "./types";

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
  options: {
    emptyStep?: boolean;
    startStep?: number;
    advanceLabel?: string;
  } = {},
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
            label: options.advanceLabel ?? "Save and Continue",
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
        return Promise.resolve();
      },
      closeIntermediateWriteWindow: () => {
        state.windowOpen = false;
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
  ).toEqual([
    ["Full name", "Robin Ashford", "observed.summary_0"],
    ["Unknown private value", "not a supplied fact", "observed.summary_1"],
  ]);
});

test("a structured summary does not duplicate a control retained with its section context", async () => {
  const w = wizard("saves", { startStep: 3 });
  w.source.controls = [
    { ...field(), groupLabel: "Step 1 of 3: Contact details" },
  ];
  w.source.summaryRows = [{ label: "Full name", value: "Robin Ashford" }];
  const result = await runApplyAgent(w.config, finishing());
  expect(result.reviewFilled).toHaveLength(1);
});
