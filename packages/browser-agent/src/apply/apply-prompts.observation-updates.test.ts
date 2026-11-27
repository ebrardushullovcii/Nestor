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
  expect(update).toContain(
    "The page announces (its alert regions, word for word): (no longer shown).",
  );
  expect(update).toContain("The page is still loading. (no longer shown).");
  expect(update).toContain("Buttons: (no longer shown).");
});

test("visibility updates retain exact geometry, distinguish cleared geometry and reset for a tab switch", () => {
  const before = observation();
  const [first, second] = before.controls;
  const visibility = {
    x: 15.125,
    y: 901,
    width: 148,
    height: 24,
    viewportWidth: 1280,
    viewportHeight: 800,
    inViewport: false,
    offCanvas: false,
    zeroSize: false,
    ariaHidden: false,
    cssHidden: false,
  };
  first.visibility = visibility;
  second.visibility = visibility;
  before.tabs = [
    {
      id: "primary",
      url: before.url ?? "",
      title: before.title ?? "",
      active: true,
      primary: true,
    },
  ];
  const after = structuredClone(before);
  after.controls[0].visibility = {
    ...visibility,
    y: 117.375,
    inViewport: true,
  };
  delete after.controls[1].visibility;

  const full = describeObservation(before);
  expect(full).toContain(
    "x, y, width, height, viewportWidth, viewportHeight, inViewport, offCanvas, zeroSize, ariaHidden, cssHidden",
  );
  expect(full).toContain(
    `- ${first.ref}: [15.125,901,148,24,1280,800,false,false,false,false,false]`,
  );

  const update = describeObservationUpdate(after, before);
  expect(update).toContain(
    `Changed field visibility (columns after ref: y, inViewport):\n- ${first.ref}: [117.375,true]`,
  );
  expect(update).toContain(
    `Field visibility no longer reported for: ${second.ref}.`,
  );
  expect(update).not.toContain("Fields:\n");

  after.tabs![0].id = "auxiliary";
  expect(describeObservationUpdate(after, before)).toBe(
    describeObservation(after),
  );
});

test("page text updates keep the exact inserted lines and report removed text", () => {
  const before = observation();
  const first = "Persistent context at the beginning. ".repeat(12).trim();
  const last = "Persistent context at the end. ".repeat(12).trim();
  before.bodyTextExcerpt = `${first}\nOld status\n${last}`;
  const after = {
    ...before,
    bodyTextExcerpt: `${first}\nNew status\nNext step\n${last}`,
  };

  const update = describeObservationUpdate(after, before);
  expect(update).toContain(
    "keep the first 1 and last 1 lines of the previous page text. Replace the lines between them with these 2 lines:\nNew status\nNext step",
  );
  expect(update).not.toContain(first);
  expect(
    describeObservationUpdate({ ...before, bodyTextExcerpt: "" }, after),
  ).toContain("Page text: (no longer shown).");
});

test("redrawn handles reuse exact field descriptions when the old handles are gone", () => {
  const before = observation();
  const [first, second] = before.controls.filter(
    (control) => control.kind === "text",
  );
  const after = structuredClone(before);
  const newFirst = after.controls.find((control) => control.ref === first.ref)!;
  const newSecond = after.controls.find(
    (control) => control.ref === second.ref,
  )!;
  newFirst.ref = "c_redrawn";
  newSecond.ref = "c_changed";
  newSecond.label = "A different prompt";

  const update = describeObservationUpdate(after, before);
  expect(update).toContain(`- ${first.ref} → c_redrawn`);
  expect(update).toContain(
    "- c_changed [text] · Application — A different prompt",
  );
  expect(update).toContain(
    `Removed fields (do not use these handles): ${first.ref}, ${second.ref}`,
  );
  expect(update).not.toContain(`- c_redrawn [text]`);
});

test("page observations distinguish a site's old upload label from the browser's current file", () => {
  const current = observation();
  const file = current.controls.find((control) => control.kind === "file")!;
  file.upload = { described: "resume.pdf", nearby: "resume.pdf", shown: true };
  const before = structuredClone(current);
  before.controls.find((control) => control.ref === file.ref)!.upload = {
    ...file.upload,
    fileName: "resume.pdf",
    fileSize: 256,
  };

  expect(describeObservation(before)).toContain(
    'native file input: 1 file [{"name":"resume.pdf","size":256}]',
  );
  for (const text of [
    describeObservation(current),
    describeObservationUpdate(current, before),
  ]) {
    expect(text).toContain("native file input: 0 files");
    expect(text).toContain('"nearby":"resume.pdf"');
  }
});

test("an updated option replaces its whole group and removed option handles are explicit", () => {
  const before = observation();
  const after = structuredClone(before);
  const group = after.controls
    .filter((control) => control.kind === "radio")
    .slice(0, 2);
  const [yes, no] = group;
  no.checked = true;
  for (const control of group) control.answered = true;

  const update = describeObservationUpdate(after, before);
  expect(update.match(/\[radio group\]/gu)).toHaveLength(1);
  expect(update).toContain(`  - ${yes.ref} [radio]`);
  expect(update).toContain(`  - ${no.ref} [radio]`);
  expect(update).toContain('answered: "chosen"');

  const withoutNo = {
    ...after,
    controls: after.controls.filter((control) => control !== no),
  };
  expect(describeObservationUpdate(withoutNo, after)).toContain(
    `Removed fields (do not use these handles): ${no.ref}`,
  );
});
