import type { RawApplyPage } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { buildApplyFormObservation } from "./page-hands";

function rawPage(password: string): RawApplyPage {
  return {
    url: "https://fixture.example/sign-in",
    title: "Sign in",
    bodyText: "Sign in to continue",
    headings: [],
    controls: [
      {
        index: 0,
        tagName: "input",
        inputType: "password",
        role: "textbox",
        id: "password",
        name: "password",
        label: "Password",
        groupLabel: "",
        placeholder: "Password",
        autocomplete: "current-password",
        required: true,
        invalid: false,
        validationMessage: "",
        disabled: false,
        readOnly: false,
        visible: true,
        value: password,
        checked: false,
        multiple: false,
        options: [],
        selectedOptionLabel: "",
      },
    ],
    actions: [
      {
        index: 0,
        label: "Sign in",
        visible: true,
        disabled: false,
      },
    ],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
  };
}

describe("buildApplyFormObservation credential redaction", () => {
  test("reports password presence without exposing its value", () => {
    const password = "test-secret-value";
    const observation = buildApplyFormObservation(
      rawPage(password),
      "2026-09-22T10:00:00.000Z",
    );

    expect(observation.controls[0]).toMatchObject({
      credentialRole: "password",
      value: "",
      answered: true,
    });
    expect(JSON.stringify(observation)).not.toContain(password);
  });
});

describe("buildApplyFormObservation radio groups", () => {
  test("uses form scope and DOM name instead of merging equal wording", () => {
    const source = rawPage("");
    const template = source.controls[0];
    if (!template) throw new Error("Expected the fixture control.");
    source.controls = [
      ...["Yes", "No"].map((label, index) => ({
        ...template,
        index,
        inputType: "radio",
        name: "authorized",
        scopeKey: "form0",
        label,
        groupLabel: "Are you authorized?",
        value: label,
        checked: index === 0,
      })),
      ...["Yes", "No"].map((label, index) => ({
        ...template,
        index: index + 2,
        inputType: "radio",
        name: "authorized",
        scopeKey: "form1",
        label,
        groupLabel: "Are you authorized?",
        value: label,
        checked: false,
      })),
    ];

    const observation = buildApplyFormObservation(
      source,
      "2026-09-22T10:00:00.000Z",
    );

    expect(observation.controls.map((control) => control.answered)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(observation.controls[0]?.choiceGroupKey).not.toBe(
      observation.controls[2]?.choiceGroupKey,
    );
    expect(observation.controls.map((control) => control.options)).toEqual([
      ["Yes", "No"],
      ["Yes", "No"],
      ["Yes", "No"],
      ["Yes", "No"],
    ]);
  });

  test("does not merge unnamed radios only because their wording matches", () => {
    const source = rawPage("");
    const template = source.controls[0];
    if (!template) throw new Error("Expected the fixture control.");
    source.controls = [0, 1].map((index) => ({
      ...template,
      index,
      inputType: "radio",
      name: "",
      label: "Yes",
      groupLabel: "Are you authorized?",
      value: "Yes",
      checked: index === 0,
    }));

    const observation = buildApplyFormObservation(
      source,
      "2026-09-22T10:00:00.000Z",
    );
    expect(observation.controls.map((control) => control.answered)).toEqual([
      true,
      false,
    ]);
    expect(observation.controls.map((control) => control.options)).toEqual([
      ["Yes"],
      ["Yes"],
    ]);
  });
});
