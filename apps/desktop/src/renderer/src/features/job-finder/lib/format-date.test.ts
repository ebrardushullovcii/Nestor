import { describe, expect, test } from "vitest";

import { formatDate, formatDateTime, formatTime } from "./format-date";

describe("one date wording", () => {
  const now = new Date(2026, 10, 2, 12);
  const sameYear = new Date(2026, 10, 2, 13, 8);
  const lastYear = new Date(2025, 2, 14, 9, 5);
  const day = (date: Date, year: boolean) =>
    new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      ...(year ? { year: "numeric" } : {}),
    }).format(date);

  test("says the year only outside this year", () => {
    expect(formatDate(sameYear, now)).toBe(day(sameYear, false));
    expect(formatDate(lastYear, now)).toBe(day(lastYear, true));
  });

  test("adds the time after the day where the moment matters", () => {
    expect(formatDateTime(sameYear, now)).toBe(
      `${day(sameYear, false)}, ${formatTime(sameYear)}`,
    );
  });

  test("keeps a time and its AM/PM on one line", () => {
    expect(formatTime(sameYear)).not.toMatch(/[ \t\u202f]/u);
  });

  test("writes nothing for a missing or unreadable date", () => {
    expect(formatDate(null, now)).toBe("");
    expect(formatDate("not a date", now)).toBe("");
    expect(formatDateTime(undefined, now)).toBe("");
  });
});
