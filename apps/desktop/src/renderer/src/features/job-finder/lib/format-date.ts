/**
 * The one way Job Finder writes a date: "Nov 2" in rows and details, the
 * year only when it is not this year ("Nov 2, 2025"), and a time only where
 * the moment matters ("Nov 2, 1:08 PM"). In the person's own locale. Ages
 * ("6 days ago", "Posted 6d ago") say how long ago, not when, and stay
 * their own wording.
 *
 * Formatters are built once and rebuilt only when the device's time zone
 * changes, which a formatter fixes when it is built.
 */
type DateInput = string | number | Date;

function readTimeZoneKey(): string {
  return `${new Date(0).getTimezoneOffset()}|${new Date(962409600000).getTimezoneOffset()}`;
}

function cached(options: Intl.DateTimeFormatOptions) {
  let built: { formatter: Intl.DateTimeFormat; key: string } | null = null;
  return (): Intl.DateTimeFormat => {
    const key = readTimeZoneKey();
    if (built?.key !== key)
      built = { formatter: new Intl.DateTimeFormat(undefined, options), key };
    return built.formatter;
  };
}

const dayFormat = cached({ month: "short", day: "numeric" });
const dayYearFormat = cached({
  month: "short",
  day: "numeric",
  year: "numeric",
});
const timeFormat = cached({ hour: "numeric", minute: "2-digit" });

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Nov 2", or "Nov 2, 2025" outside this year. "" for no date. */
export function formatDate(
  value: DateInput | null | undefined,
  now: Date = new Date(),
): string {
  if (value === null || value === undefined || value === "") return "";
  const date = toDate(value);
  if (!date) return "";
  return (
    date.getFullYear() === now.getFullYear() ? dayFormat() : dayYearFormat()
  ).format(date);
}

/**
 * "1:08 PM", held together: the time never wraps away from its AM/PM
 * ("filled Nov 2, 3:28" over a lone "PM").
 */
export function formatTime(value: DateInput | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = toDate(value);
  return date ? timeFormat().format(date).replace(/\s/gu, "\u00a0") : "";
}

/** "Nov 2, 1:08 PM", or "Nov 2, 2025, 1:08 PM" outside this year. */
export function formatDateTime(
  value: DateInput | null | undefined,
  now: Date = new Date(),
): string {
  const day = formatDate(value, now);
  return day ? `${day}, ${formatTime(value)}` : "";
}
