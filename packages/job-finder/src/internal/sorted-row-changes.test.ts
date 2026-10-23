import { expect, test } from "vitest";
import { mergeSortedRowChanges } from "./sorted-row-changes";

test("changed rows, insertions and removals match a complete stable sort", () => {
  const compare = (a: { score: number }, b: { score: number }) =>
    b.score - a.score;
  const before = Object.freeze(
    Array.from({ length: 100 }, (_, i) =>
      Object.freeze({ id: `job_${i}`, score: i % 11 }),
    ).sort(compare),
  );
  const ids = new Set(["job_0", "job_29", "job_72", "new"]);
  const next = [
    { id: "job_29", score: 99 },
    { id: "job_72", score: 0 },
    { id: "new", score: 8 },
  ];
  const expected = [...before.filter((row) => !ids.has(row.id)), ...next].sort(
    compare,
  );
  const actual = mergeSortedRowChanges(before, ids, next, compare);
  expect(actual).toEqual(expected);
  expect(actual.find((row) => row.id === "job_3")).toBe(
    before.find((row) => row.id === "job_3"),
  );
  expect(Object.isFrozen(actual)).toBe(true);
  expect(mergeSortedRowChanges(actual, new Set(), [], compare)).toBe(actual);
});
