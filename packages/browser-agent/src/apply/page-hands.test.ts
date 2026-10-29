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
  test("application contact email is reusable; only a sign-in context makes it an identifier", () => {
    const page = rawPage("");
    const email = {
      ...page.controls[0],
      inputType: "email",
      id: "email",
      name: "email",
      placeholder: "Email",
      label: "Email *",
      autocomplete: "email",
    };
    page.url = "https://fixture.example/apply/100";
    page.title = "Application";
    page.controls = [email];
    expect(
      buildApplyFormObservation(page, "2026-10-27T10:00:00Z").controls[0]
        ?.credentialRole,
    ).toBeNull();
    page.controls.push({ ...email, index: 1, inputType: "password" });
    expect(
      buildApplyFormObservation(page, "2026-10-27T10:00:00Z").controls[0]
        ?.credentialRole,
    ).toBe("identifier");
    page.controls = [email];
    page.title = "Sign in";
    expect(
      buildApplyFormObservation(page, "2026-10-27T10:00:00Z").controls[0]
        ?.credentialRole,
    ).toBe("identifier");
  });

  test("one-time codes stay out of answer lookup and observations", () => {
    const page = rawPage("");
    page.controls = [
      {
        ...page.controls[0],
        inputType: "text",
        label: "Code",
        autocomplete: "one-time-code",
        value: "123456",
      },
    ];
    const observation = buildApplyFormObservation(page, "2026-10-27T10:00:00Z");
    expect(observation.controls[0]).toMatchObject({
      credentialRole: "one_time_code",
      value: "",
      answered: true,
    });
    expect(JSON.stringify(observation)).not.toContain("123456");
  });
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

test("a website's Show password field remains redacted when its input type becomes text", () => {
  const page = rawPage("synthetic-replica-secret");
  page.controls[0].inputType = "text";
  const observed = buildApplyFormObservation(page, "2026-10-29T10:00:00.000Z");
  expect(observed.controls[0]).toMatchObject({
    credentialRole: "password",
    answered: true,
    value: "",
  });
  expect(JSON.stringify(observed)).not.toContain("synthetic-replica-secret");
});
