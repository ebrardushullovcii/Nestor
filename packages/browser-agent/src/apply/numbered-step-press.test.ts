import { CandidateProfileSchema } from "@nestor/contracts";
import type { RawApplyControl, RawApplyPage } from "@nestor/contracts";
import { expect, test, vi } from "vitest";

import {
  numberedStepAdvanced,
  numberedStepPreflight,
  unconfirmedStepText,
} from "./local-step-preflight";
import { buildApplyFormObservation } from "./page-hands";
import {
  createApplyGuardState,
  executeApplyProposal,
  fillStepPress,
} from "./policy-executor";
import type { ApplyAgentConfig, ApplyPageHands } from "./types";

function control(overrides: Partial<RawApplyControl> = {}): RawApplyControl {
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
    ...overrides,
  };
}

function step(overrides: Partial<RawApplyPage> = {}): RawApplyPage {
  return {
    url: "https://apply.example.test/wizard",
    title: "Apply",
    bodyText: "Step 1 of 3",
    controls: [control()],
    actions: [
      {
        index: 0,
        label: "Save and Continue",
        visible: true,
        disabled: false,
        inForm: true,
        submitsForm: false,
      },
    ],
    links: [],
    headings: [{ level: 1, text: "My Information" }],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: "Step 1 of 3",
    ...overrides,
  };
}

const read = (page: RawApplyPage) =>
  buildApplyFormObservation(page, "2026-11-03T10:00:00.000Z");

test("a fresh numbered non-final step with every field answered may be pressed", () => {
  expect(numberedStepPreflight(read(step()), "a0")).toMatchObject({
    label: "Save and Continue",
    index: 1,
    total: 3,
    frame: null,
  });
  // A control without a native form is still bound by the page counter.
  expect(
    numberedStepPreflight(
      read(
        step({
          actions: [
            { index: 0, label: "Next", visible: true, disabled: false },
          ],
        }),
      ),
      "a0",
    ),
  ).not.toBeNull();
});

test.each([
  [
    "no step numbers",
    step({ stepLabel: "My Information", bodyText: "Tell us" }),
  ],
  [
    "the last step",
    step({ stepLabel: "Step 3 of 3", bodyText: "Step 3 of 3" }),
  ],
  ["a review step label", step({ stepLabel: "Step 2 of 3: Review" })],
  [
    "a review heading",
    step({ headings: [{ level: 2, text: "Review your details" }] }),
  ],
  [
    "a visible send control",
    step({
      actions: [
        {
          index: 0,
          label: "Save and Continue",
          visible: true,
          disabled: false,
        },
        {
          index: 1,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ],
    }),
  ],
  [
    "send wording on the advance",
    step({
      actions: [
        {
          index: 0,
          label: "Continue and submit",
          visible: true,
          disabled: false,
        },
      ],
    }),
  ],
  [
    "a native submit",
    step({
      actions: [
        {
          index: 0,
          label: "Save and Continue",
          visible: true,
          disabled: false,
          inForm: true,
          submitsForm: true,
        },
      ],
    }),
  ],
  [
    "a disabled advance",
    step({
      actions: [
        { index: 0, label: "Save and Continue", visible: true, disabled: true },
      ],
    }),
  ],
  [
    "an unanswered required field",
    step({ controls: [control({ value: "" })] }),
  ],
  ["an invalid field", step({ controls: [control({ invalid: true })] })],
  [
    "a password field",
    step({
      controls: [
        control({ inputType: "password", label: "Password", value: "" }),
      ],
    }),
  ],
  ["a validation error", step({ validationErrors: ["Fix the date"] })],
  ["a loading page", step({ loading: true })],
] as const)("%s is never pressed as a server-backed step", (_name, page) => {
  expect(numberedStepPreflight(read(page), "a0")).toBeNull();
});

test("a blocker on the page stops a server-backed press", () => {
  const page = read(step());
  page.blocker = {
    code: "site_login_required",
    requiresPerson: false,
    summary: "Sign in",
    detail: "Sign in",
    nextActionLabel: "Sign in",
  };
  expect(numberedStepPreflight(page, "a0")).toBeNull();
});

test("only exactly the next step of the same wizard on the same site confirms a press", () => {
  const before = read(step());
  const next = read(
    step({ stepLabel: "Step 2 of 3", bodyText: "Step 2 of 3" }),
  );
  expect(numberedStepAdvanced(before, next)).toBe(true);
  for (const after of [
    before,
    read(step({ stepLabel: "Step 3 of 3", bodyText: "Step 3 of 3" })),
    read(step({ stepLabel: "Step 2 of 4", bodyText: "Step 2 of 4" })),
    read(
      step({
        url: "https://other.example.test/wizard",
        stepLabel: "Step 2 of 3",
      }),
    ),
  ])
    expect(numberedStepAdvanced(before, after)).toBe(false);
  // A same-site address change between steps is fine.
  expect(
    numberedStepAdvanced(
      before,
      read(
        step({
          url: "https://apply.example.test/wizard/2",
          stepLabel: "Step 2 of 3",
        }),
      ),
    ),
  ).toBe(true);
});

test("the receipt names the step by host and path, never by its query", () => {
  expect(
    unconfirmedStepText(
      read(step({ url: "https://apply.example.test/wizard?token=secret" })),
      "Save and Continue",
    ),
  ).toBe(
    "Pressed “Save and Continue” once on step 1 of 3 at apply.example.test/wizard. The form did not show step 2 of 3 afterwards, so Nestor will not press it again.",
  );
});

function executorConfig(page: RawApplyPage, extra: Partial<ApplyPageHands>) {
  const events: string[] = [];
  const hands: ApplyPageHands = {
    observe: () => Promise.resolve(read(page)),
    navigate: () => Promise.resolve({ ok: true, url: page.url! }),
    clickElement: vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "clicked" }),
    ),
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    goBack: () => Promise.resolve({ ok: true, url: page.url! }),
    readText: () => Promise.resolve(page.bodyText),
    fillText: (_ref, value) =>
      Promise.resolve({ ok: true, observedValue: value }),
    chooseOption: (_ref, option) =>
      Promise.resolve({ ok: true, observedValue: option }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () => Promise.resolve({ ok: true, url: page.url! }),
    ...extra,
  };
  const config: ApplyAgentConfig = {
    hands,
    safety: {
      readBlockedAttempt: () => Promise.resolve(null),
      registerPreparedValue: () => Promise.resolve(),
      openIntermediateWriteWindow: () => {
        events.push("open");
        return Promise.resolve();
      },
      closeIntermediateWriteWindow: () => {
        events.push("close");
        return Promise.resolve();
      },
      closeUploadWindow: () => {
        events.push("close upload");
        return Promise.resolve();
      },
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
        title: "Engineer",
        company: "Northwind",
        location: "",
        description: "",
      },
      reusableAnswers: [],
      documents: [],
    },
    application: {
      jobId: "job_test",
      applicationId: "application_test",
      startingUrl: page.url!,
    },
    siteLabel: "the careers site",
    intermediateWritesAuthorized: true,
    pressesFormButtons: false,
  };
  return { config, events, hands };
}

const now = () => new Date("2026-11-03T10:00:00.000Z");

test("a changed binding is refused before any press and leaves no receipt", async () => {
  const page = step();
  const bound = vi.fn(() =>
    Promise.resolve({
      ok: false as const,
      error: "The exact step control changed. Check the page again.",
      reason: "binding_changed" as const,
    }),
  );
  const { config, events } = executorConfig(page, { clickBoundAction: bound });
  const guardState = createApplyGuardState();
  const outcome = await executeApplyProposal(
    { tool: "click", ref: "a0" },
    read(page).signature,
    { config, now, guardState },
  );
  expect(outcome.kind).toBe("refused");
  expect(bound).toHaveBeenCalledTimes(1);
  expect(events).toEqual(["close upload", "open", "close"]);
  expect(guardState.uncertainAdvances.size).toBe(0);
});

test("a recorded step is refused by the executor itself, so replay and every caller share it", async () => {
  const page = step();
  const bound = vi.fn(() =>
    Promise.resolve({ ok: true as const, observedValue: "clicked" }),
  );
  const { config, hands } = executorConfig(page, { clickBoundAction: bound });
  const guardState = createApplyGuardState();
  guardState.uncertainAdvances.set(
    unconfirmedStepText(read(page), "Save and Continue")!,
    "2026-11-03T09:00:00.000Z",
  );
  const outcome = await executeApplyProposal(
    { tool: "click", ref: "a0" },
    read(page).signature,
    { config, now, guardState },
  );
  expect(outcome).toMatchObject({
    kind: "paused",
    pause: { unconfirmedStep: true },
  });
  expect(bound).not.toHaveBeenCalled();
  expect(hands.clickElement).not.toHaveBeenCalled();
});

test("Send for me keeps its own presses; the Fill step press is not used there", () => {
  const page = read(step());
  const { config } = executorConfig(step(), {
    clickBoundAction: vi.fn(),
  });
  expect(
    fillStepPress({ ...config, pressesFormButtons: true }, page, "a0"),
  ).toBeNull();
  expect(fillStepPress(config, page, "a0")).toMatchObject({ kind: "numbered" });
  expect(
    fillStepPress({ ...config, safety: undefined }, page, "a0"),
  ).toBeNull();
});
