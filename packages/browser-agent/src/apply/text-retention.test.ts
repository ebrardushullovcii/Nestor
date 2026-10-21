import { describe, expect, it } from "vitest";
import { CLEARED_TEXT_ERROR, textRetentionError } from "./text-retention";
import type { ApplyFormControl, ApplyFormObservation } from "./types";

function control(overrides: Partial<ApplyFormControl> = {}): ApplyFormControl {
  return {
    ref: "c0",
    kind: "text",
    label: "Field",
    groupLabel: "",
    placeholder: "",
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    value: "",
    checked: false,
    options: [],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: "other",
    answerControlType: "text",
    attestationKind: null,
    answered: false,
    ...overrides,
  };
}

function page(controls: ApplyFormControl[]): ApplyFormObservation {
  return {
    observedAt: "2026-10-21T10:00:00.000Z",
    signature: "s",
    url: "http://127.0.0.1/apply",
    origin: "http://127.0.0.1",
    title: "Apply",
    step: { label: null, index: null, total: null },
    bodyTextExcerpt: "",
    headings: [],
    controls,
    actions: [],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    loading: false,
    blocker: null,
  };
}

describe("typed answer retention", () => {
  it("reports a text field that cleared what was typed", () => {
    const field = control({ label: "City" });
    expect(
      textRetentionError(page([field]), page([field]), field, "Prishtina"),
    ).toBe(CLEARED_TEXT_ERROR);
  });

  it("does not report a password field, whose value page reads leave blank", () => {
    const field = control({ label: "Password", credentialRole: "password" });
    expect(
      textRetentionError(page([field]), page([field]), field, "secret"),
    ).toBeNull();
  });
});
