import { expect, test, vi } from "vitest";

import { memoizeBySameElements } from "./same-elements-memo";

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
