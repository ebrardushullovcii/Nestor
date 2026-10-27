import { expect, test } from "vitest";
import { selectBatches, allBatches, everydayBatches } from "./run";
import type { BuiltAppBatch } from "./built-app";

const add: BuiltAppBatch = {
  id: "add",
  request: "Add a record",
  actions: [{ actionId: "record.add", observe: () => Promise.resolve([]) }],
};
const remove: BuiltAppBatch = {
  id: "remove",
  request: "Remove it",
  requires: ["add"],
  actions: [{ actionId: "record.remove", observe: () => Promise.resolve([]) }],
};
const undo: BuiltAppBatch = {
  id: "undo",
  request: "Undo removal",
  requires: ["remove"],
  actions: [{ actionId: "record.undo", observe: () => Promise.resolve([]) }],
};

test("a selected Undo run also exercises creation and removal, rather than inheriting fabricated state", () => {
  expect(
    selectBatches([add, remove, undo], ["record.undo"]).map(
      (batch) => batch.id,
    ),
  ).toEqual(["add", "remove", "undo"]);
  expect(() => selectBatches([undo], ["record.undo"])).toThrow(
    "Missing prerequisite",
  );
});

test("unknown case prefixes and prerequisite cycles fail before an app mutation", () => {
  expect(() => selectBatches([add], ["typo"])).toThrow("No implemented case");
  expect(() =>
    selectBatches([{ ...add, requires: ["add"] }], ["record"]),
  ).toThrow("Cyclic prerequisites");
});

test("everyday hunt selection retains search, moves, both Apply modes, answers, Speed and tracking", () => {
  const selected = everydayBatches(allBatches());
  const ids = selected.map((batch) => batch.id);
  for (const id of [
    "open-home",
    "open-profile",
    "open-discovery",
    "open-shortlisted",
    "open-applications",
    "open-needs_you",
    "open-settings",
    "hunt-search",
    "hunt-speed",
    "hunt-triage-0",
    "hunt-triage-1",
    "hunt-triage-2",
    "hunt-triage-3",
    "hunt-approve-fill",
    "hunt-approve-send",
    "hunt-apply-fill",
    "hunt-apply-send",
    "hunt-answer-once",
    "hunt-remember-answer",
    "hunt-skip-waiting-application",
    "tracker-status",
  ])
    expect(ids).toContain(id);
  expect(selectBatches(selected, []).length).toBe(selected.length);
});
