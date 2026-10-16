import { describe, expect, it } from "vitest";
import { applySelectionRange } from "./list-selection";

describe("applySelectionRange", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("ticks everything between the anchor and the target in either direction", () => {
    expect([...applySelectionRange(new Set(), ids, "b", "d", true)]).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect([...applySelectionRange(new Set(), ids, "d", "b", true)]).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("clears a range and keeps ticks outside it", () => {
    expect([
      ...applySelectionRange(new Set(ids), ids, "b", "c", false),
    ]).toEqual(["a", "d", "e"]);
  });

  it("toggles only the target without an anchor on this page", () => {
    expect([
      ...applySelectionRange(new Set(["z"]), ids, "gone", "c", true),
    ]).toEqual(["z", "c"]);
    expect([...applySelectionRange(new Set(), ids, null, "e", true)]).toEqual([
      "e",
    ]);
  });
});
