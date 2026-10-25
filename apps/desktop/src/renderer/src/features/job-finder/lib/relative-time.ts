const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const JUST_NOW_THRESHOLD_MS = 45 * SECOND_MS;

export interface RelativeTimestamp {
  /** Absolute locale timestamp for `title` attributes; null when unknown. */
  absolute: string | null;
  /** Compact relative label such as "just now", "3 min ago", or "Aug 12". */
  label: string;
}

function startOfLocalDay(value: Date): number {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
  ).getTime();
}

function formatShortDate(value: Date, now: Date): string {
  const sameYear = value.getFullYear() === now.getFullYear();

  return value.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Formats an ISO timestamp as a short relative phrase for dense headers.
 * Future or near-present values collapse to "just now"; anything older than
 * yesterday falls back to a short calendar date so the label never grows past
 * a few words. The absolute locale string is returned separately so callers
 * can expose it through a `title` attribute.
 */
export function formatRelativeTimestamp(
  value: string | null,
  now: Date = new Date(),
): RelativeTimestamp {
  if (!value) {
    return { absolute: null, label: "not set" };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { absolute: null, label: "unknown time" };
  }

  const absolute = date.toLocaleString();
  const elapsedMs = now.getTime() - date.getTime();

  if (elapsedMs < JUST_NOW_THRESHOLD_MS) {
    return { absolute, label: "just now" };
  }

  if (elapsedMs < HOUR_MS) {
    const minutes = Math.max(1, Math.round(elapsedMs / MINUTE_MS));
    return { absolute, label: `${minutes} min ago` };
  }

  if (elapsedMs < 24 * HOUR_MS) {
    const hours = Math.max(1, Math.floor(elapsedMs / HOUR_MS));
    return { absolute, label: `${hours} h ago` };
  }

  const dayDifference = Math.round(
    (startOfLocalDay(now) - startOfLocalDay(date)) / (24 * HOUR_MS),
  );
  if (dayDifference <= 1) {
    return { absolute, label: "yesterday" };
  }

  return { absolute, label: formatShortDate(date, now) };
}
