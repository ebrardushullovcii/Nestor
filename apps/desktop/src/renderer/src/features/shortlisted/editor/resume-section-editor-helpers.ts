import type {
  ResumeDraftBullet,
  ResumeDraftEntry,
  ResumeDraftOrigin,
  ResumeDraftPatch,
  ResumeDraftSection,
} from "@nestor/contracts";

let resumeDraftPatchCounter = 0;

export function resetResumeDraftPatchCounter() {
  resumeDraftPatchCounter = 0;
}

export function normalizeNullableText(
  value: string | null | undefined,
): string | null {
  if (value == null || value.trim() === "") {
    return null;
  }

  return value;
}

export function createResumeDraftPatch(input: {
  anchorBulletId?: string | null;
  anchorEntryId?: string | null;
  bulletId?: string | null;
  entryId?: string | null;
  idPrefix: string;
  newBullets?: ResumeDraftBullet[] | null;
  newIncluded?: boolean | null;
  newLocked?: boolean | null;
  newText?: string | null;
  operation: ResumeDraftPatch["operation"];
  position?: ResumeDraftPatch["position"];
  sectionId: string;
}) {
  const {
    anchorBulletId = null,
    anchorEntryId = null,
    bulletId = null,
    entryId = null,
    idPrefix,
    newBullets = null,
    newIncluded = null,
    newLocked = null,
    newText = null,
    operation,
    position = null,
    sectionId,
  } = input;

  resumeDraftPatchCounter += 1;
  const id = `${idPrefix}_${Date.now()}_${resumeDraftPatchCounter}`;

  return {
    id,
    draftId: "",
    operation,
    targetSectionId: sectionId,
    targetEntryId: entryId,
    anchorEntryId,
    targetBulletId: bulletId,
    anchorBulletId,
    position,
    newText,
    newIncluded,
    newLocked,
    newBullets,
    appliedAt: new Date().toISOString(),
    origin: "user" as const,
    conflictReason: null,
  } satisfies ResumeDraftPatch;
}

export function updateSectionEntry(
  section: ResumeDraftSection,
  entryId: string,
  updater: (entry: ResumeDraftEntry) => ResumeDraftEntry,
) {
  return {
    ...section,
    entries: section.entries.map((entry) =>
      entry.id === entryId ? updater(entry) : entry,
    ),
  };
}

type ResumeEntryTextField =
  | "dateRange"
  | "endDate"
  | "location"
  | "startDate"
  | "subtitle"
  | "summary"
  | "title";

type ResumeEntryFieldValue = {
  [K in ResumeEntryTextField]: string | null;
} & {
  isCurrent: boolean;
};

export function updateEntryField<TField extends keyof ResumeEntryFieldValue>(
  section: ResumeDraftSection,
  entryId: string,
  field: TField,
  value: ResumeEntryFieldValue[TField],
) {
  return updateSectionEntry(section, entryId, (entry) => ({
    ...entry,
    [field]: value,
  }));
}

function parseStructuredEntryDate(entry: ResumeDraftEntry) {
  if (
    entry.startDate?.trim() ||
    entry.endDate?.trim() ||
    entry.isCurrent === true
  ) {
    return parseEntryDateRange(
      [entry.startDate, entry.isCurrent === true ? "Present" : entry.endDate]
        .filter((value): value is string => Boolean(value?.trim()))
        .join(" – "),
    );
  }

  return parseEntryDateRange(entry.dateRange);
}

/**
 * Deterministic provenance transition shared by the primary inline text
 * surfaces (bullet text, entry summary, section text): identical content
 * preserves the current origin, while any deliberate rewrite of generated
 * (`ai_generated`, `assistant_edited`, `deterministic_fallback`) or imported
 * wording becomes `user_edited` so provenance always reflects the visible
 * text. Already-`user_edited` content stays `user_edited`.
 */
function resolveUserEditedOrigin(
  origin: ResumeDraftOrigin,
  materiallyChanged: boolean,
): ResumeDraftOrigin {
  if (!materiallyChanged) {
    return origin;
  }

  return "user_edited";
}

/**
 * Applies the shared provenance transition to a single bullet's text edit.
 * Unchanged text keeps the current object (and origin); IDs, locks, evidence
 * refs, and timestamps are never touched here.
 */
function applyUserBulletText(
  bullet: ResumeDraftBullet,
  text: string,
): ResumeDraftBullet {
  if (bullet.text === text) {
    return bullet;
  }

  return {
    ...bullet,
    text,
    origin: resolveUserEditedOrigin(bullet.origin, true),
  };
}

export function updateEntryBulletText(
  section: ResumeDraftSection,
  entryId: string,
  bulletId: string,
  text: string,
) {
  return updateSectionEntry(section, entryId, (entry) => ({
    ...entry,
    bullets: entry.bullets.map((bullet) =>
      bullet.id === bulletId ? applyUserBulletText(bullet, text) : bullet,
    ),
  }));
}

export function updateSectionBulletText(
  section: ResumeDraftSection,
  bulletId: string,
  text: string,
) {
  return {
    ...section,
    bullets: section.bullets.map((bullet) =>
      bullet.id === bulletId ? applyUserBulletText(bullet, text) : bullet,
    ),
  };
}

export function updateEntrySummary(
  section: ResumeDraftSection,
  entryId: string,
  summary: string | null,
) {
  return updateSectionEntry(section, entryId, (entry) => {
    if (entry.summary === summary) {
      return entry;
    }

    return {
      ...entry,
      summary,
      origin: resolveUserEditedOrigin(entry.origin, true),
    };
  });
}

export function updateSectionText(
  section: ResumeDraftSection,
  text: string | null,
) {
  if (section.text === text) {
    return section;
  }

  return {
    ...section,
    text,
    origin: resolveUserEditedOrigin(section.origin, true),
  };
}

const currentDateRangeEndTokens = new Set([
  "current",
  "now",
  "ongoing",
  "present",
]);
const dateRangeMonthNumbers = new Map<string, number>([
  ["jan", 0],
  ["january", 0],
  ["feb", 1],
  ["february", 1],
  ["mar", 2],
  ["march", 2],
  ["apr", 3],
  ["april", 3],
  ["may", 4],
  ["jun", 5],
  ["june", 5],
  ["jul", 6],
  ["july", 6],
  ["aug", 7],
  ["august", 7],
  ["sep", 8],
  ["sept", 8],
  ["september", 8],
  ["oct", 9],
  ["october", 9],
  ["nov", 10],
  ["november", 10],
  ["dec", 11],
  ["december", 11],
]);

function normalizeDateRangeSegment(value: string) {
  return value
    .replace(/[()]/g, " ")
    .replace(/\b(?:from|since|through|until|issued|expires|expected)\b/gi, " ")
    .replace(/[,]/g, " ")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDateRangeToken(value: string) {
  return normalizeDateRangeSegment(value).toLowerCase();
}

function splitDateRange(value: string): { end: string | null; start: string } {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const spacedSeparatorParts = trimmed
    .split(/\s+(?:-|–|—|to|through|until)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (spacedSeparatorParts.length >= 2) {
    return {
      end: spacedSeparatorParts.at(-1) ?? null,
      start: spacedSeparatorParts[0] ?? trimmed,
    };
  }

  const dashSeparatorParts = trimmed
    .split(/\s*(?:–|—)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (dashSeparatorParts.length >= 2) {
    return {
      end: dashSeparatorParts.at(-1) ?? null,
      start: dashSeparatorParts[0] ?? trimmed,
    };
  }

  const compactPresentMatch =
    /^(?<start>.+?)\s*-\s*(?<end>present|current|now|ongoing)$/i.exec(trimmed);
  if (compactPresentMatch?.groups?.start && compactPresentMatch.groups.end) {
    return {
      end: compactPresentMatch.groups.end,
      start: compactPresentMatch.groups.start,
    };
  }

  const compactMonthRangeMatch =
    /^(?<start>(?:\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4}))\s*-\s*(?<end>(?:\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]{3,9}\.?\s+\d{4}|\d{1,2}\/\d{4}|\d{4}))$/i.exec(
      trimmed,
    );
  if (
    compactMonthRangeMatch?.groups?.start &&
    compactMonthRangeMatch.groups.end
  ) {
    return {
      end: compactMonthRangeMatch.groups.end,
      start: compactMonthRangeMatch.groups.start,
    };
  }

  return { end: null, start: trimmed };
}

function toDateRangeMonthIndex(year: number, month: number) {
  return year * 12 + month;
}

function parseDateRangeSegment(
  value: string | null,
  position: "end" | "single" | "start",
): { isCurrent: boolean; month: number | null; unparseable: boolean } {
  const normalized = normalizeDateRangeSegment(value ?? "");
  if (!normalized) {
    return { isCurrent: false, month: null, unparseable: false };
  }

  if (currentDateRangeEndTokens.has(normalizeDateRangeToken(normalized))) {
    return { isCurrent: true, month: null, unparseable: false };
  }

  const isoMonth = /^(?<year>\d{4})-(?<month>\d{1,2})$/.exec(normalized);
  if (isoMonth?.groups?.year && isoMonth.groups.month) {
    const year = Number(isoMonth.groups.year);
    const month = Number(isoMonth.groups.month) - 1;
    return month >= 0 && month <= 11
      ? {
          isCurrent: false,
          month: toDateRangeMonthIndex(year, month),
          unparseable: false,
        }
      : { isCurrent: false, month: null, unparseable: true };
  }

  const slashMonth = /^(?<month>\d{1,2})\/(?<year>\d{4})$/.exec(normalized);
  if (slashMonth?.groups?.year && slashMonth.groups.month) {
    const year = Number(slashMonth.groups.year);
    const month = Number(slashMonth.groups.month) - 1;
    return month >= 0 && month <= 11
      ? {
          isCurrent: false,
          month: toDateRangeMonthIndex(year, month),
          unparseable: false,
        }
      : { isCurrent: false, month: null, unparseable: true };
  }

  const slashDayMonthYear =
    /^(?<day>\d{1,2})\/(?<month>\d{1,2})\/(?<year>\d{4})$/.exec(normalized);
  if (slashDayMonthYear?.groups?.year && slashDayMonthYear.groups.month) {
    const year = Number(slashDayMonthYear.groups.year);
    const month = Number(slashDayMonthYear.groups.month) - 1;
    return month >= 0 && month <= 11
      ? {
          isCurrent: false,
          month: toDateRangeMonthIndex(year, month),
          unparseable: false,
        }
      : { isCurrent: false, month: null, unparseable: true };
  }

  const monthYear = /^(?<month>[A-Za-z]{3,9})\s+(?<year>\d{4})$/.exec(
    normalized,
  );
  if (monthYear?.groups?.month && monthYear.groups.year) {
    const month =
      dateRangeMonthNumbers.get(monthYear.groups.month.toLowerCase()) ?? null;
    return month !== null
      ? {
          isCurrent: false,
          month: toDateRangeMonthIndex(Number(monthYear.groups.year), month),
          unparseable: false,
        }
      : { isCurrent: false, month: null, unparseable: true };
  }

  const yearOnly = /^(?<year>\d{4})$/.exec(normalized);
  if (yearOnly?.groups?.year) {
    const month = position === "end" || position === "single" ? 11 : 0;
    return {
      isCurrent: false,
      month: toDateRangeMonthIndex(Number(yearOnly.groups.year), month),
      unparseable: false,
    };
  }

  return { isCurrent: false, month: null, unparseable: true };
}

function parseEntryDateRange(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return {
      endMonth: null,
      hasParseableDate: false,
      hasUnparseableDateRange: false,
      isCurrent: false,
      startMonth: null,
    };
  }

  const range = splitDateRange(trimmed);
  const startSegment = parseDateRangeSegment(
    range.start,
    range.end ? "start" : "single",
  );
  const endSegment = range.end
    ? parseDateRangeSegment(range.end, "end")
    : startSegment;
  const isCurrent = endSegment.isCurrent;
  const startMonth = startSegment.month;
  const endMonth = isCurrent ? null : endSegment.month;

  return {
    endMonth,
    hasParseableDate: Boolean(
      isCurrent || startMonth !== null || endMonth !== null,
    ),
    hasUnparseableDateRange: Boolean(
      startSegment.unparseable || endSegment.unparseable,
    ),
    isCurrent,
    startMonth,
  };
}

function getEntryTieBreaker(entry: ResumeDraftEntry) {
  return [entry.title, entry.subtitle, entry.location, entry.id]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compareEntriesNewestFirst(
  left: { entry: ResumeDraftEntry; index: number },
  right: { entry: ResumeDraftEntry; index: number },
) {
  const leftDate = parseStructuredEntryDate(left.entry);
  const rightDate = parseStructuredEntryDate(right.entry);
  const leftConfident =
    leftDate.hasParseableDate && !leftDate.hasUnparseableDateRange;
  const rightConfident =
    rightDate.hasParseableDate && !rightDate.hasUnparseableDateRange;

  if (leftConfident !== rightConfident) {
    return leftConfident ? -1 : 1;
  }

  if (leftDate.isCurrent !== rightDate.isCurrent) {
    return leftDate.isCurrent ? -1 : 1;
  }

  const leftEnd = leftDate.isCurrent
    ? Number.MAX_SAFE_INTEGER
    : (leftDate.endMonth ?? leftDate.startMonth ?? Number.MIN_SAFE_INTEGER);
  const rightEnd = rightDate.isCurrent
    ? Number.MAX_SAFE_INTEGER
    : (rightDate.endMonth ?? rightDate.startMonth ?? Number.MIN_SAFE_INTEGER);

  if (leftEnd !== rightEnd) {
    return rightEnd - leftEnd;
  }

  const leftStart = leftDate.startMonth ?? Number.MIN_SAFE_INTEGER;
  const rightStart = rightDate.startMonth ?? Number.MIN_SAFE_INTEGER;
  if (leftStart !== rightStart) {
    return rightStart - leftStart;
  }

  if (left.entry.sortOrder !== right.entry.sortOrder) {
    return left.entry.sortOrder - right.entry.sortOrder;
  }

  const tieBreaker = getEntryTieBreaker(left.entry).localeCompare(
    getEntryTieBreaker(right.entry),
  );
  return tieBreaker !== 0 ? tieBreaker : left.index - right.index;
}

export function orderResumeEntriesNewestFirst(
  entries: readonly ResumeDraftEntry[],
): ResumeDraftEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(compareEntriesNewestFirst)
    .map(({ entry }, index) => ({
      ...entry,
      sortOrder: index,
    }));
}
