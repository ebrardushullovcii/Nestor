import { expect, test } from "vitest";
import {
  ApplyExecutionResultSchema,
  ApplyStepReceiptSchema,
} from "./discovery";

const stored = {
  state: "ready",
  summary: "Prepared",
  detail: "Stored detail",
  submittedAt: null,
  outcome: null,
  nextActionLabel: "Review the form",
};

const receipt = {
  kind: "advance",
  resultId: "application_7_attempt_1",
  url: "http://127.0.0.1:47950/case2/apply",
  origin: "http://127.0.0.1:47950",
  stepIndex: 1,
  stepTotal: 3,
  stepLabel: "Step 1 of 3",
  frame: null,
  instructions: "Step 1 of 3",
  fields: [
    {
      fieldKey:
        "http://127.0.0.1:47950/case2/apply|Step 1 of 3|first name|First name",
      label: "First name",
      groupLabel: "",
      sectionPath: [],
      hint: "",
      placeholder: "",
      kind: "text",
      answerControlType: "text",
      choiceGroupKey: null,
      options: [],
      required: true,
      readOnly: false,
      questionKind: "other",
      attestationKind: null,
      repeatedQuestion: null,
      telInput: false,
      urlInput: false,
      value: "Jamie",
      provenance: "executor_write",
    },
  ],
  at: "2026-11-04T01:00:00.000Z",
} as const;

test("an execution stored before step receipts reads with none, not invented ones", () => {
  expect(ApplyExecutionResultSchema.parse(stored).stepReceipts).toEqual([]);
});

test("a stored step receipt reads back unchanged", () => {
  const parsed = ApplyExecutionResultSchema.parse({
    ...stored,
    stepReceipts: [receipt],
  });
  expect(parsed.stepReceipts).toEqual([receipt]);
  expect(
    ApplyExecutionResultSchema.parse(JSON.parse(JSON.stringify(parsed)))
      .stepReceipts,
  ).toEqual([receipt]);
});

test("a receipt field never holds a file and never an unknown provenance", () => {
  expect(
    ApplyStepReceiptSchema.safeParse({
      ...receipt,
      fields: [{ ...receipt.fields[0], kind: "file" }],
    }).success,
  ).toBe(false);
  expect(
    ApplyStepReceiptSchema.safeParse({
      ...receipt,
      fields: [{ ...receipt.fields[0], provenance: "person_write" }],
    }).success,
  ).toBe(false);
});
