import { describe, expect, test } from "vitest";
import { readRowChanges, rememberRowChanges } from "./row-changes";

describe("immutable row change hints", () => {
  test("composes exact held baselines, including additions, removal and restoration", () => {
    const a = { id: "a", value: 1 };
    const b = { id: "b", value: 1 };
    const changed = { id: "a", value: 2 };
    const first = Object.freeze([a]);
    const second = Object.freeze([changed, b]);
    const third = Object.freeze([a]);
    rememberRowChanges(first, second, [
      { id: "a", before: a, after: changed },
      { id: "b", before: undefined, after: b },
    ]);
    rememberRowChanges(second, third, [
      { id: "a", before: changed, after: a },
      { id: "b", before: b, after: undefined },
    ]);
    expect(readRowChanges(first, third)).toEqual([
      { id: "a", before: a, after: a },
      { id: "b", before: undefined, after: undefined },
    ]);
    expect(readRowChanges(second, third)).toEqual([
      { id: "a", before: changed, after: a },
      { id: "b", before: b, after: undefined },
    ]);
    expect(readRowChanges(Object.freeze([a]), third)).toBeNull();
  });
  test("does not trust mutable inputs", () => {
    const first = [{ id: "a" }];
    const second = Object.freeze([{ id: "b" }]);
    rememberRowChanges(first, second, []);
    expect(readRowChanges(first, second)).toBeNull();
  });
});
