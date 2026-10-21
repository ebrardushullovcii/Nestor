import { describe, expect, it, vi } from "vitest";
import { createIdentityMemo, createPerObjectCache } from "./identity-memo";

describe("createIdentityMemo", () => {
  it("returns the kept result for the same input and arguments", () => {
    const compute = vi.fn((items: readonly number[], factor: number) =>
      items.map((item) => item * factor),
    );
    const memo = createIdentityMemo(compute);
    const items = [1, 2, 3];

    const first = memo(items, 2);
    expect(memo(items, 2)).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);

    expect(memo(items, 3)).toEqual([3, 6, 9]);
    expect(memo([1, 2, 3], 3)).toEqual([3, 6, 9]);
    expect(compute).toHaveBeenCalledTimes(3);
  });
});

describe("createPerObjectCache", () => {
  it("computes once per object, including null results", () => {
    const compute = vi.fn((row: { value: number | null }) => row.value);
    const cached = createPerObjectCache(compute);
    const row = { value: null };

    expect(cached(row)).toBeNull();
    expect(cached(row)).toBeNull();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cached({ value: 4 })).toBe(4);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
