import { describe, expect, test } from "vitest";
import {
  checkFormReadiness,
  unresolvedRequiredControls,
} from "./submit-preflight";
import { buildApplyFormObservation } from "./page-hands";
import type { RawApplyControl, RawApplyPage } from "@nestor/contracts";

const control: RawApplyControl = {
  index: 0,
  tagName: "input",
  inputType: "text",
  role: "",
  id: "answer",
  name: "answer",
  label: "Address",
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
const page: RawApplyPage = {
  url: "https://local.example/form",
  title: "Apply",
  bodyText: "Application",
  controls: [],
  actions: [
    { index: 0, label: "Send application", visible: true, disabled: false },
  ],
  links: [],
  headings: [],
  clickables: [],
  openedTabs: [],
  loading: false,
  validationErrors: [],
  stepLabel: null,
};
const observe = (overrides: Partial<RawApplyPage>) =>
  buildApplyFormObservation(
    { ...page, ...overrides },
    "2026-10-04T12:00:00.000Z",
  );

describe("form readiness", () => {
  test.each(["text", "number", "date", "month", "file"])(
    "an empty required %s cannot be ready",
    (inputType) => {
      const observation = observe({
        controls: [{ ...control, inputType, visible: inputType !== "file" }],
      });
      expect(checkFormReadiness(observation).ok).toBe(false);
      expect(unresolvedRequiredControls(observation)).toHaveLength(1);
    },
  );
  test("a rejected attached file is not ready", () => {
    expect(
      checkFormReadiness(
        observe({
          controls: [
            {
              ...control,
              inputType: "file",
              value: "resume.md",
              invalid: true,
              validationMessage: "Upload TXT or PDF",
            },
          ],
        }),
      ).ok,
    ).toBe(false);
  });
  test("an unknown-length wizard with Next cannot be ready", () => {
    expect(
      checkFormReadiness(
        observe({
          actions: [
            { index: 0, label: "Next", visible: true, disabled: false },
          ],
        }),
      ).ok,
    ).toBe(false);
  });
  test("a disabled send control cannot be ready even with zero required fields", () => {
    expect(
      checkFormReadiness(
        observe({ actions: [{ ...page.actions[0], disabled: true }] }),
      ).ok,
    ).toBe(false);
  });
  test("manual completion clears a missing field without trusting an old receipt", () => {
    const raw = { ...control };
    expect(checkFormReadiness(observe({ controls: [raw] })).ok).toBe(false);
    raw.value = "Synthetic address";
    expect(checkFormReadiness(observe({ controls: [raw] })).ok).toBe(true);
  });
  test("one checked skill satisfies its required group without ticking all options", () => {
    const observation = observe({
      controls: ["Analysis", "Coordination"].map((label, index) => ({
        ...control,
        index,
        name: "skills",
        label,
        groupLabel: "Skills",
        inputType: "checkbox",
        required: false,
        value: label,
        checked: index === 0,
      })),
    });
    observation.controls.forEach((entry) => {
      entry.required = true;
    });
    expect(unresolvedRequiredControls(observation)).toHaveLength(0);
    expect(checkFormReadiness(observation).ok).toBe(true);
  });
});

test("individually required declaration boxes cannot satisfy one another just because they share a name", () => {
  const observation = observe({
    controls: ["Privacy", "Background check"].map((label, index) => ({
      ...control,
      index,
      name: "declarations",
      label,
      groupLabel: "Declarations",
      inputType: "checkbox",
      value: label,
      checked: index === 0,
    })),
  });
  expect(unresolvedRequiredControls(observation)).toHaveLength(1);
  expect(checkFormReadiness(observation).ok).toBe(false);
});

test("an explicitly final review may offer Save beside Send, while earlier or unknown steps stay blocked", () => {
  const actions = [
    { index: 0, label: "Save and continue", visible: true, disabled: false },
    { index: 1, label: "Submit", visible: true, disabled: false },
  ];
  expect(
    checkFormReadiness(observe({ actions, stepLabel: "Step 4 of 4: Review" }))
      .ok,
  ).toBe(true);
  expect(
    checkFormReadiness(
      observe({ actions, stepLabel: "Step 3 of 4: Questions" }),
    ).ok,
  ).toBe(false);
  expect(checkFormReadiness(observe({ actions, stepLabel: null })).ok).toBe(
    false,
  );
  expect(
    checkFormReadiness(
      observe({
        actions: [
          { ...actions[0], disabled: false },
          { ...actions[1], disabled: true },
        ],
        stepLabel: "Step 4 of 4: Review",
      }),
    ).ok,
  ).toBe(false);
});
