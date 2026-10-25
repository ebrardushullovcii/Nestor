import { expect, test, vi } from "vitest";

import {
  memoizeBySameElements,
  memoizeSortedBySameElements,
} from "./same-elements-memo";

test("reuses the result for a new array of the same frozen elements", () => {
  const a = Object.freeze({ id: "a" });
  const b = Object.freeze({ id: "b" });
  const compute = vi.fn((items: readonly { id: string }[]) =>
    items.map((item) => item.id),
  );
  const memo = memoizeBySameElements(compute);
  const first = memo([a, b]);
  expect(memo([a, b])).toBe(first);
  expect(compute).toHaveBeenCalledTimes(1);
  expect(memo([b, a])).toEqual(["b", "a"]);
  expect(memo([b, a, Object.freeze({ id: "c" })])).toHaveLength(3);
  expect(compute).toHaveBeenCalledTimes(3);
});

test("recomputes every time while an element can still change", () => {
  const editable = { id: "a" };
  const compute = vi.fn((items: readonly { id: string }[]) =>
    items.map((item) => item.id),
  );
  const memo = memoizeBySameElements(compute);
  memo([editable]);
  editable.id = "changed";
  expect(memo([editable])).toEqual(["changed"]);
  expect(compute).toHaveBeenCalledTimes(2);
});

type Row = { readonly id: string; readonly score: number };
const byScoreThenId = (left: Row, right: Row) =>
  right.score - left.score ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

test("merges a few changed rows into the last order exactly as a full sort would", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const row = (id: string) =>
    Object.freeze({ id, score: Math.floor(random() * 50) });
  let rows = Array.from({ length: 2_000 }, (_, index) => row(`job-${index}`));
  const compare = vi.fn(byScoreThenId);
  const rank = memoizeSortedBySameElements(compare);
  expect(rank(rows)).toEqual([...rows].sort(byScoreThenId));

  for (let round = 0; round < 40; round += 1) {
    const next = [...rows];
    // Replace a few rows with changed copies, drop one, add one.
    for (let change = 0; change < 3; change += 1) {
      const at = Math.floor(random() * next.length);
      next[at] = row(next[at]!.id);
    }
    next.splice(Math.floor(random() * next.length), 1);
    next.push(row(`new-${round}`));
    rows = next;
    compare.mockClear();
    const ranked = rank(rows);
    expect(ranked).toEqual([...rows].sort(byScoreThenId));
    expect(Object.isFrozen(ranked)).toBe(true);
    // A handful of binary searches, not a sort of 2,000 rows.
    expect(compare.mock.calls.length).toBeLessThan(200);
  }
});

test("sorts in full when many rows changed or rows can still change", () => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    Object.freeze({ id: `job-${index}`, score: index % 7 }),
  );
  const rank = memoizeSortedBySameElements(byScoreThenId);
  rank(rows);
  const replaced = rows.map((item) =>
    Object.freeze({ ...item, score: 9 - item.score }),
  );
  expect(rank(replaced)).toEqual([...replaced].sort(byScoreThenId));
  const editable = rows.map((item) => ({ ...item }));
  expect(rank(editable)).toEqual([...editable].sort(byScoreThenId));
  editable[0]!.score = 100;
  expect(rank(editable)[0]).toBe(editable[0]);
});
