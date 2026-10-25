import { describe, expect, test } from "vitest";

import {
  canContinueApplicationAfterAccess,
  detectApplyBlocker,
} from "./blockers";
import { buildApplyFormObservation } from "./page-hands";
import type { RawApplyPage } from "@nestor/contracts";
import type { ApplyFormControl } from "./types";

function checkbox(checked: boolean): ApplyFormControl {
  return {
    ref: "f0",
    kind: "checkbox",
    label: "I am not a robot",
    groupLabel: "Local fake CAPTCHA",
    placeholder: "",
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    value: checked ? "yes" : "",
    checked,
    options: [],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: "other",
    answerControlType: "boolean",
    attestationKind: null,
    answered: checked,
  };
}

describe("detectApplyBlocker", () => {
  test("a site checking the browser by itself is a wait, not a stop", () => {
    const blocker = detectApplyBlocker({
      bodyText:
        "Just a moment... weworkremotely.com Performing security verification. Verification successful. Waiting for weworkremotely.com to respond...",
      controls: [],
      actions: [],
    });
    expect(blocker?.code).toBe("security_challenge");
    expect(blocker?.detail).toMatch(/finishes on its own/i);
    expect(blocker?.detail).toMatch(/wait/i);
    expect(blocker?.nextActionLabel).toMatch(/let the check finish/i);
    expect(blocker?.requiresPerson).toBe(false);
  });

  test("a captcha the person has to solve is theirs", () => {
    const blocker = detectApplyBlocker({
      bodyText:
        "Just a moment. Please complete the challenge: verify you are human.",
      controls: [],
      actions: [],
    });
    expect(blocker?.code).toBe("security_challenge");
    expect(blocker?.detail).toMatch(/never answers those/i);
    expect(blocker?.requiresPerson).toBe(true);
  });

  test("the same CAPTCHA copy stops blocking after its control is checked", () => {
    const bodyText = "I am not a robot. Local fake CAPTCHA.";
    expect(
      detectApplyBlocker({ bodyText, controls: [checkbox(false)], actions: [] })
        ?.requiresPerson,
    ).toBe(true);
    expect(
      detectApplyBlocker({ bodyText, controls: [checkbox(true)], actions: [] }),
    ).toBeNull();
  });

  test("footer and informational account copy are not account gates", () => {
    expect(
      detectApplyBlocker({
        bodyText: "Already applied? Sign in. New here? Create an account.",
        controls: [],
        actions: [],
      }),
    ).toBeNull();
    expect(
      detectApplyBlocker({
        bodyText: "You can create an account later to track this application.",
        controls: [{ ...checkbox(false), label: "Full name", kind: "text" }],
        actions: [
          {
            ref: "a0",
            label: "Submit application",
            kind: "final",
            visible: true,
            disabled: false,
          },
        ],
      }),
    ).toBeNull();
  });

  test("an account form is a person-owned gate even when scoped text omits its heading", () => {
    const blocker = detectApplyBlocker({
      bodyText: "Use a made-up email and password.",
      controls: [
        { ...checkbox(false), label: "Password", kind: "text" },
        {
          ...checkbox(false),
          ref: "f1",
          label: "Verify password",
          kind: "text",
        },
      ],
      actions: [
        {
          ref: "a0",
          label: "Create account",
          kind: "advance",
          visible: true,
          disabled: false,
        },
      ],
    });

    expect(blocker?.code).toBe("account_creation_required");
    expect(blocker?.requiresPerson).toBe(true);
  });

  test("an existing-account choice wall is a sign-in handoff, not a prose-only pause", () => {
    const blocker = detectApplyBlocker({
      bodyText: "Sign in / Create account",
      controls: [],
      actions: [],
      links: [
        {
          ref: "l0",
          label: "Sign in",
          href: "https://apply.example.test/signin",
          origin: "https://apply.example.test",
          destination: "page",
          opensNewWindow: false,
          visible: true,
          topOffset: 10,
        },
        {
          ref: "l1",
          label: "Create account",
          href: "https://apply.example.test/register",
          origin: "https://apply.example.test",
          destination: "page",
          opensNewWindow: false,
          visible: true,
          topOffset: 20,
        },
      ],
    });

    expect(blocker?.code).toBe("site_login_required");
    expect(blocker?.requiresPerson).toBe(true);
  });

  test("a supplied credential form is not an unconditional terminal handoff", () => {
    const blocker = detectApplyBlocker({
      bodyText: "Sign in to continue",
      controls: [
        {
          ...checkbox(true),
          label: "Password",
          kind: "text",
          value: "task-local",
          checked: false,
        },
      ],
      actions: [
        {
          ref: "a0",
          label: "Sign in",
          kind: "advance",
          visible: true,
          disabled: false,
        },
      ],
    });
    expect(blocker?.code).toBe("site_login_required");
    expect(blocker?.requiresPerson).not.toBe(true);
  });
});

test("access continuation needs an actual form or application entry, never just an absent wall", () => {
  const raw: RawApplyPage = {
    url: "https://site.example.test/apply",
    title: "Apply",
    bodyText: "",
    controls: [],
    actions: [],
    links: [],
    clickables: [],
    headings: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
  };
  const canContinue = (page: RawApplyPage) =>
    canContinueApplicationAfterAccess(
      buildApplyFormObservation(page, new Date().toISOString()),
    );
  expect(canContinue(raw)).toBe(false);
  expect(canContinue({ ...raw, bodyText: "Page not found" })).toBe(false);
  const entry = {
    ...raw,
    links: [
      {
        index: 0,
        label: "Continue application",
        href: "https://site.example.test/apply?form=1",
        visible: true,
        target: "",
        topOffset: 0,
      },
    ],
  };
  expect(canContinue(entry)).toBe(true);
  expect(
    canContinue({
      ...entry,
      links: [{ ...entry.links[0], label: "Apply Manually" }],
    }),
  ).toBe(false);
  expect(canContinue({ ...entry, loading: true })).toBe(false);
  expect(
    canContinue({ ...entry, bodyText: "Enter the verification code" }),
  ).toBe(false);
});

test("a signup option for two-step verification is still sign-in, until an actual code step appears", () => {
  const password = {
    ...checkbox(false),
    kind: "text" as const,
    label: "Password",
    credentialRole: "password" as const,
  };
  const control = {
    ...checkbox(false),
    label: "Enable two-step verification for this local test",
  };
  expect(
    detectApplyBlocker({
      bodyText:
        "Create an account. Enable two-step verification for this local test",
      controls: [password, control],
      actions: [],
    })?.code,
  ).toBe("account_creation_required");
  expect(
    detectApplyBlocker({
      bodyText: "Enter the verification code",
      controls: [],
      actions: [],
    })?.code,
  ).toBe("multi_factor_required");
});
