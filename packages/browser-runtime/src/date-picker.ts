import type { ApplyWriteResult } from "@nestor/contracts";
import type { Locator, Page } from "playwright";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

interface CalendarDate {
  year: number;
  /** 0 for January. */
  month: number;
  day: number;
}

/** A date the answer names: 2026-10-27, or one a person writes out. */
export function parseWantedDate(value: string): CalendarDate | null {
  const iso = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/u.exec(value);
  if (iso) {
    const [year, month, day] = [
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
    ];
    const check = new Date(Date.UTC(year, month, day));
    return check.getUTCMonth() === month && check.getUTCDate() === day
      ? { year, month, day }
      : null;
  }
  // Only a written-out date ("October 27, 2026"), never "Immediately".
  if (!/\d{4}/u.test(value) || !/\d/u.test(value.replace(/\d{4}/u, "")))
    return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? null
    : {
        year: parsed.getFullYear(),
        month: parsed.getMonth(),
        day: parsed.getDate(),
      };
}

/** The date a calendar day's accessible name says ("Choose Tuesday, October 27th, 2026"). */
function labelDate(label: string): number | null {
  for (const [month, name] of MONTHS.entries()) {
    const found =
      new RegExp(
        `\\b${name}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
        "iu",
      ).exec(label) ??
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${name},?\\s+(\\d{4})\\b`,
        "iu",
      ).exec(label);
    if (found) return Date.UTC(Number(found[2]), month, Number(found[1]));
  }
  return null;
}

/** The date typed the way the box asks for it, when its placeholder says. */
function typedDate(date: CalendarDate, placeholder: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const separator = /(?:dd|mm)\s*([/.-])/iu.exec(placeholder)?.[1] ?? "/";
  if (/dd\s*[/.-]\s*mm/iu.test(placeholder))
    return [pad(date.day), pad(date.month + 1), date.year].join(separator);
  if (/mm\s*[/.-]\s*dd/iu.test(placeholder))
    return [pad(date.month + 1), pad(date.day), date.year].join(separator);
  return `${date.year}-${pad(date.month + 1)}-${pad(date.day)}`;
}

/**
 * Writes a date into a calendar's text box (a date picker) the way a person
 * does: opens it, moves to the month and picks the day by its name. Without
 * a calendar to pick from, types the date the way the box asks. Returns null
 * for a box that is not a date picker; refuses words that are not a date.
 */
export async function pickCalendarDate(
  page: Page,
  locator: Locator,
  value: string,
): Promise<ApplyWriteResult | null> {
  const placeholder = await locator
    .evaluate((element) => {
      // Mirrors the reader's date-picker test in apply-page-mechanics.
      if (!(element instanceof HTMLInputElement) || element.type !== "text")
        return null;
      const picker =
        /(?:^|[\s_-])date(?:picker)?(?:$|[\s_-])|datepicker/iu.test(
          element.className,
        ) ||
        Boolean(
          element.closest("[class*='datepicker' i], [class*='date-picker' i]"),
        ) ||
        /pick (?:a )?date|select (?:a )?date|\b(?:dd|mm)\s*[/.-]\s*(?:dd|mm)\s*[/.-]\s*(?:yy)?yy\b/iu.test(
          element.placeholder,
        );
      return picker ? element.placeholder : null;
    })
    .catch(() => null);
  if (placeholder === null) return null;
  const wanted = parseWantedDate(value);
  if (!wanted)
    return {
      ok: false,
      error:
        "This field takes a date from its calendar, not words. Give the date itself, such as 2026-10-27.",
    };
  const target = Date.UTC(wanted.year, wanted.month, wanted.day);
  await locator.click({ timeout: 5_000 });
  const days = page.locator(
    "[role='option'][aria-label], [role='gridcell'][aria-label], [role='button'][aria-label][class*='day' i]",
  );
  for (let move = 0; move < 36; move += 1) {
    const named = await days
      .evaluateAll((elements) =>
        elements.map((element) => ({
          label: element.getAttribute("aria-label") ?? "",
          usable:
            element.getClientRects().length > 0 &&
            element.getAttribute("aria-disabled") !== "true",
        })),
      )
      .catch(() => [] as Array<{ label: string; usable: boolean }>);
    const dated = named.map((entry) => ({
      ...entry,
      at: labelDate(entry.label),
    }));
    const shown = dated.filter((entry) => entry.usable && entry.at !== null);
    if (!shown.length) break;
    const index = dated.findIndex(
      (entry) => entry.usable && entry.at === target,
    );
    if (index >= 0) {
      await days.nth(index).click({ timeout: 5_000 });
      const observedValue = await locator.inputValue({ timeout: 2_000 });
      return observedValue.trim()
        ? { ok: true, observedValue }
        : {
            ok: false,
            error: "The calendar did not keep the date it was given.",
          };
    }
    const latest = Math.max(...shown.map((entry) => entry.at!));
    const earliest = Math.min(...shown.map((entry) => entry.at!));
    if (target >= earliest && target <= latest)
      return {
        ok: false,
        error: "That date cannot be chosen in this calendar.",
      };
    const step = page
      .getByRole("button", {
        name: target > latest ? /next month/iu : /previous month/iu,
      })
      .first();
    if (!(await step.isVisible().catch(() => false))) break;
    await step.click({ timeout: 2_000 });
  }
  // No calendar to pick from: type it the way the box asks for it.
  await locator.fill(typedDate(wanted, placeholder), { timeout: 5_000 });
  await locator.press("Enter").catch(() => undefined);
  const observedValue = await locator.inputValue({ timeout: 2_000 });
  return observedValue.trim()
    ? { ok: true, observedValue }
    : { ok: false, error: "The date box did not keep the date." };
}
