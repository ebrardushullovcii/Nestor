import { describe, expect, test } from "vitest";
import {
  readRowChanges,
  rememberRowChanges,
  transferRowChanges,
} from "./row-changes";

describe("immutable row change hints", () => {
  test("carries only changed rows into thin versions and releases full-row hints", () => {
    const original = Object.freeze(
      Array.from({ length: 1000 }, (_, i) =>
        Object.freeze({ id: String(i), score: i, body: "Listing body" }),
      ),
    );
    const changed = Object.freeze({ ...original[20]!, score: 2000 });
    const next = Object.freeze(
      original.map((row) => (row.id === changed.id ? changed : row)),
    );
    const thin = (row: (typeof original)[number]) => ({
      id: row.id,
      score: row.score,
    });
    const beforeRows = Object.freeze(original.map(thin));
    const afterRows = Object.freeze(next.map(thin));
    const touched: string[] = [];
    const project = (row: (typeof original)[number]) => {
      touched.push(row.id);
      return thin(row);
    };
    transferRowChanges(original, beforeRows, project);
    rememberRowChanges(original, next, [
      { id: changed.id, before: original[20]!, after: changed },
    ]);
    transferRowChanges(next, afterRows, project);
    expect(touched).toEqual(["20", "20"]);
    expect(readRowChanges(beforeRows, afterRows)).toEqual([
      {
        id: "20",
        before: { id: "20", score: 20 },
        after: { id: "20", score: 2000 },
      },
    ]);
    expect(readRowChanges(original, next)).toBeNull();
  });
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
