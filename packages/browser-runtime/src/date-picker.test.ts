import { expect, test } from "vitest";
import { parseWantedDate } from "./date-picker";

test("a date picker is given a date, never words", () => {
  expect(parseWantedDate("2026-10-27")).toEqual({
    year: 2026,
    month: 9,
    day: 27,
  });
  expect(parseWantedDate("October 27, 2026")).toEqual({
    year: 2026,
    month: 9,
    day: 27,
  });
  for (const words of [
    "Immediately",
    "In two weeks",
    "2026",
    "2026-02-30",
    "ASAP 2026",
  ])
    expect(parseWantedDate(words)).toBeNull();
});
