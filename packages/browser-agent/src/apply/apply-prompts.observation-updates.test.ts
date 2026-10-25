import type { RawApplyPage } from "@nestor/contracts";
import { expect, test } from "vitest";
import {
  applyStepShape,
  describeObservation,
  describeObservationUpdate,
} from "./apply-prompts";
import { buildApplyFormObservation } from "./page-hands";
import recordedPage from "./synthetic-page.snapshot.json";

const observation = () =>
  buildApplyFormObservation(
    recordedPage as RawApplyPage,
    "2026-10-05T07:40:00.000Z",
  );

test("a recorded local synthetic form sends only changed fields with its earlier facts retained", () => {
  const before = observation();
  const after = structuredClone(before);
  const field = after.controls.find((control) => control.kind === "text")!;
  field.value = "Robin Ashford";
  field.answered = true;
  const full = describeObservation(after);
  const update = describeObservationUpdate(after, before);
  expect(update.length).toBeLessThan(full.length * 0.3);
  expect(update).toContain(field.ref);
  expect(update).toContain("Robin Ashford");
  expect(update).toContain(
    "Unchanged fields and page text remain as last shown",
  );
  expect(applyStepShape(after)).toBe(applyStepShape(before));
});

test("page updates keep new and removed fields, constraints and validation; navigation gets a full page", () => {
  const before = observation();
  const after = structuredClone(before);
  const removed = after.controls.shift()!;
  const newField = {
    ...after.controls[0],
    ref: "c_new",
    label: "Synthetic extra question",
    required: true,
    invalid: true,
    validationMessage: "Enter a valid answer.",
    options: ["One", "Two"],
  };
  after.controls.push(newField);
  after.validationErrors = ["Check the new question."];
  const update = describeObservationUpdate(after, before);
  expect(update).toContain("Synthetic extra question");
  expect(update).toContain("One | Two");
  expect(update).toContain("Enter a valid answer.");
  expect(update).toContain("Check the new question.");
  expect(update).toContain(
    `Removed fields (do not use these handles): ${removed.ref}`,
  );
  expect(applyStepShape(after)).not.toBe(applyStepShape(before));
  after.url = "http://127.0.0.1:47950/clientnest/apply/5";
  expect(describeObservationUpdate(after, before)).toBe(
    describeObservation(after),
  );
});

test("cleared page errors, loading and removed buttons do not linger as current facts", () => {
  const before = observation();
  before.validationErrors = ["Synthetic error."];
  before.loading = true;
  const after = structuredClone(before);
  after.validationErrors = [];
  after.loading = false;
  after.actions = [];
  const update = describeObservationUpdate(after, before);
  expect(update).toContain("The page is showing problems: (no longer shown).");
  expect(update).toContain("The page is still loading. (no longer shown).");
  expect(update).toContain("Buttons: (no longer shown).");
});
