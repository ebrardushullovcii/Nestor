import { expect, test } from "vitest";
import { selectBatches } from "./run";
import type { BuiltAppBatch } from "./built-app";

const add: BuiltAppBatch = {
  id: "add",
  request: "Add a record",
  actions: [{ actionId: "record.add", observe: async () => [] }],
};
const remove: BuiltAppBatch = {
  id: "remove",
  request: "Remove it",
  requires: ["add"],
  actions: [{ actionId: "record.remove", observe: async () => [] }],
};
const undo: BuiltAppBatch = {
  id: "undo",
  request: "Undo removal",
  requires: ["remove"],
  actions: [{ actionId: "record.undo", observe: async () => [] }],
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
