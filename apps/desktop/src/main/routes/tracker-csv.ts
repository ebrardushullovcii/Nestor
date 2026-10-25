import { TRACKER_STATUS_LABEL, type TrackerRow } from "@nestor/contracts";

function csvCell(value: string | null): string {
  const text = value ?? "";
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The person's own calendar day, as the screen shows it. */
export function localDay(iso: string): string {
  const at = new Date(iso);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Local wall-clock time with its UTC offset, so a spreadsheet can't misread it. */
export function localDateTime(iso: string): string {
  const at = new Date(iso);
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  return `${localDay(iso)} ${pad(at.getHours())}:${pad(at.getMinutes())} ${sign}${hours}:${pad(Math.abs(offset) % 60)}`;
}

const CSV_COLUMNS: readonly [string, (row: TrackerRow) => string | null][] = [
  ["Company", (row) => row.company],
  ["Job", (row) => row.title],
  ["Location", (row) => row.location],
  ["Status", (row) => TRACKER_STATUS_LABEL[row.status]],
  ["Status since", (row) => localDay(row.statusAt)],
  ["Applied", (row) => (row.appliedAt ? localDay(row.appliedAt) : null)],
  ["Next", (row) => row.nextTitle],
  ["Next on", (row) => (row.nextAt ? localDateTime(row.nextAt) : null)],
  ["Tags", (row) => row.tags.join("; ")],
];

/** Applications as CSV, with dates and times as the person sees them. */
export function trackerCsv(rows: Iterable<TrackerRow>): string {
  const lines = [CSV_COLUMNS.map(([header]) => header).join(",")];
  for (const row of rows)
    lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
