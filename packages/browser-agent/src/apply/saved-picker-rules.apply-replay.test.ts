import { expect, test } from "vitest";
import { strictOptionMatch } from "./option-fallback";

test("technology spellings are distinct choices", () => {
  expect(strictOptionMatch(["C#", "Go"], "C++")).toEqual({ kind: "none" });
  expect(strictOptionMatch(["C++", "C#"], "C#")).toEqual({
    kind: "match",
    value: "C#",
  });
});
