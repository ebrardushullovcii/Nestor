import type {
  ResumeDraft,
  ResumeDraftEntry,
  ResumeDraftSection,
  ResumeValidationIssue,
} from "@nestor/contracts";
import { normalizeText } from "./shared";

const orderedSectionKinds = new Set<ResumeDraftSection["kind"]>([
  "experience",
  "projects",
  "education",
  "certifications",
]);

const missingDateQualitySectionKinds = new Set<ResumeDraftSection["kind"]>([
  "experience",
  "education",
  "certifications",
]);

const currentEndTokens = new Set(["present", "current", "now", "ongoing"]);
const monthNumbers: Map<string, number> = new Map([
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
] as const);

export interface ParsedResumeEntryDateRange {
  endBeforeStart: boolean;
  endMonth: number | null;
  hasFutureDate: boolean;
  hasMissingDateRange: boolean;
  hasParseableDate: boolean;
  hasUnparseableDateRange: boolean;
  isCurrent: boolean;
  startMonth: number | null;
  /** The boundary names only a year, so it covers the whole year. */
  startYearOnly: boolean;
  endYearOnly: boolean;
}

interface ParsedDateSegment {
  isCurrent: boolean;
  month: number | null;
  unparseable: boolean;
  yearOnly?: boolean;
}

function toMonthIndex(year: number, month: number): number {
  return year * 12 + month;
}

function getCurrentMonthIndex(now = new Date()): number {
  return toMonthIndex(now.getUTCFullYear(), now.getUTCMonth());
}

function normalizeDateSegment(value: string): string {
  return value
    .replace(/[()]/g, " ")
    .replace(/\b(?:from|since|through|until|issued|expires|expected)\b/gi, " ")
    .replace(/[,]/g, " ")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitDateRange(value: string): { end: string | null; start: string } {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const spacedSeparatorParts = trimmed
    .split(/\s+(?:-|–|—|to|through|until)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (spacedSeparatorParts.length >= 2) {
    return {
      start: spacedSeparatorParts[0] ?? trimmed,
      end: spacedSeparatorParts.at(-1) ?? null,
    };
  }

  const dashSeparatorParts = trimmed
    .split(/\s*(?:–|—)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (dashSeparatorParts.length >= 2) {
    return {
      start: dashSeparatorParts[0] ?? trimmed,
      end: dashSeparatorParts.at(-1) ?? null,
    };
  }

  const compactPresentMatch =
    /^(?<start>.+?)\s*-\s*(?<end>present|current|now|ongoing)$/i.exec(trimmed);
  if (compactPresentMatch?.groups?.start && compactPresentMatch.groups.end) {
    return {
      start: compactPresentMatch.groups.start,
      end: compactPresentMatch.groups.end,
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
      start: compactMonthRangeMatch.groups.start,
      end: compactMonthRangeMatch.groups.end,
    };
  }

  return { start: trimmed, end: null };
}

function parseDateSegment(
  value: string | null,
  position: "end" | "single" | "start",
): ParsedDateSegment {
  const normalized = normalizeDateSegment(value ?? "");
  if (!normalized) {
    return { isCurrent: false, month: null, unparseable: false };
  }

  if (currentEndTokens.has(normalizeText(normalized))) {
    return { isCurrent: true, month: null, unparseable: false };
  }

  const isoDate = /^(?<year>\d{4})-(?<month>\d{1,2})-(?<day>\d{1,2})$/.exec(
    normalized,
  );
  if (isoDate?.groups?.year && isoDate.groups.month) {
    const year = Number(isoDate.groups.year);
    const month = Number(isoDate.groups.month) - 1;
    return month >= 0 && month <= 11
      ? {
          isCurrent: false,
          month: toMonthIndex(year, month),
          unparseable: false,
        }
      : { isCurrent: false, month: null, unparseable: true };
  }

  const isoMonth = /^(?<year>\d{4})-(?<month>\d{1,2})$/.exec(normalized);
  if (isoMonth?.groups?.year && isoMonth.groups.month) {
    const year = Number(isoMonth.groups.year);
    const month = Number(isoMonth.groups.month) - 1;
    return month >= 0 && month <= 11
      ? {
          isCurrent: false,
          month: toMonthIndex(year, month),
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
          month: toMonthIndex(year, month),
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
          month: toMonthIndex(year, month),
          unparseable: false,
        }
      : { isCurrent: false, month: null, unparseable: true };
  }

  const monthYear = /^(?<month>[A-Za-z]{3,9})\s+(?<year>\d{4})$/.exec(
    normalized,
  );
  if (monthYear?.groups?.month && monthYear.groups.year) {
    const month =
      monthNumbers.get(monthYear.groups.month.toLowerCase()) ?? null;
    return month !== null
      ? {
          isCurrent: false,
          month: toMonthIndex(Number(monthYear.groups.year), month),
          unparseable: false,
        }
      : { isCurrent: false, month: null, unparseable: true };
  }

  const yearOnly = /^(?<year>\d{4})$/.exec(normalized);
  if (yearOnly?.groups?.year) {
    const month = position === "end" || position === "single" ? 11 : 0;
    return {
      isCurrent: false,
      month: toMonthIndex(Number(yearOnly.groups.year), month),
      unparseable: false,
      yearOnly: true,
    };
  }

  return { isCurrent: false, month: null, unparseable: true };
}

export function parseResumeEntryDateRange(
  valueOrEntry:
    | string
    | Pick<
        ResumeDraftEntry,
        "dateRange" | "endDate" | "isCurrent" | "startDate"
      >
    | null
    | undefined,
  now = new Date(),
): ParsedResumeEntryDateRange {
  const structuredEntry =
    typeof valueOrEntry === "object" && valueOrEntry !== null
      ? valueOrEntry
      : null;
  const structuredHasAnyDate = Boolean(
    structuredEntry?.startDate?.trim() || structuredEntry?.endDate?.trim(),
  );
  const trimmed = structuredHasAnyDate
    ? [
        structuredEntry?.startDate,
        structuredEntry?.isCurrent ? "Present" : structuredEntry?.endDate,
      ]
        .filter((value): value is string => Boolean(value?.trim()))
        .join(" – ")
    : typeof valueOrEntry === "string"
      ? valueOrEntry.trim()
      : (structuredEntry?.dateRange?.trim() ?? "");
  if (!trimmed) {
    return {
      endBeforeStart: false,
      endMonth: null,
      hasFutureDate: false,
      hasMissingDateRange: true,
      hasParseableDate: false,
      hasUnparseableDateRange: false,
      isCurrent: false,
      startMonth: null,
      startYearOnly: false,
      endYearOnly: false,
    };
  }

  const range = splitDateRange(trimmed);
  const startSegment = parseDateSegment(
    range.start,
    range.end ? "start" : "single",
  );
  const endSegment = range.end
    ? parseDateSegment(range.end, "end")
    : startSegment;
  const isCurrent = Boolean(endSegment.isCurrent);
  const startMonth = startSegment.month;
  const endMonth = isCurrent ? null : endSegment.month;
  const hasParseableDate = Boolean(
    isCurrent || startMonth !== null || endMonth !== null,
  );
  const hasUnparseableDateRange = Boolean(
    startSegment.unparseable || endSegment.unparseable,
  );
  const currentMonth = getCurrentMonthIndex(now);
  const futureMonths = [startMonth, endMonth].filter(
    (month, index): month is number =>
      month !== null &&
      ((index === 0 ? startSegment.yearOnly : endSegment.yearOnly)
        ? Math.floor(month / 12) > Math.floor(currentMonth / 12)
        : month > currentMonth),
  );

  return {
    endBeforeStart: Boolean(
      startMonth !== null && endMonth !== null && endMonth < startMonth,
    ),
    endMonth,
    hasFutureDate: futureMonths.length > 0,
    hasMissingDateRange: false,
    hasParseableDate,
    hasUnparseableDateRange,
    isCurrent,
    startMonth,
    startYearOnly: startSegment.yearOnly === true,
    endYearOnly: !isCurrent && endSegment.yearOnly === true,
  };
}

export function sectionSupportsDeterministicEntryOrdering(
  section: Pick<ResumeDraftSection, "entries" | "kind">,
): boolean {
  return orderedSectionKinds.has(section.kind) && section.entries.length > 0;
}

function getEntryTieBreaker(entry: ResumeDraftEntry): string {
  return normalizeText(
    [entry.title, entry.subtitle, entry.location, entry.id]
      .filter(Boolean)
      .join(" "),
  );
}

function compareEntriesNewestFirst(
  left: { entry: ResumeDraftEntry; index: number },
  right: { entry: ResumeDraftEntry; index: number },
): number {
  const leftDate = parseResumeEntryDateRange(left.entry);
  const rightDate = parseResumeEntryDateRange(right.entry);
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
  if (tieBreaker !== 0) {
    return tieBreaker;
  }

  return left.index - right.index;
}

function renumberEntries(
  entries: readonly ResumeDraftEntry[],
  updatedEntryId?: string | null,
  updatedAt?: string | null,
): ResumeDraftEntry[] {
  return entries.map((entry, index) => {
    const shouldUpdateTimestamp = Boolean(
      updatedAt && updatedEntryId && entry.id === updatedEntryId,
    );
    if (entry.sortOrder === index && !shouldUpdateTimestamp) {
      return entry;
    }

    return {
      ...entry,
      sortOrder: index,
      ...(shouldUpdateTimestamp ? { updatedAt: updatedAt as string } : {}),
    };
  });
}

export function orderEntriesNewestFirst(
  entries: readonly ResumeDraftEntry[],
): ResumeDraftEntry[] {
  return renumberEntries(
    entries
      .map((entry, index) => ({ entry, index }))
      .sort(compareEntriesNewestFirst)
      .map(({ entry }) => entry),
  );
}

function orderEntriesByManualSortOrder(
  entries: readonly ResumeDraftEntry[],
): ResumeDraftEntry[] {
  return renumberEntries(
    entries
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => {
        const sortOrderDifference =
          left.entry.sortOrder - right.entry.sortOrder;
        return sortOrderDifference !== 0
          ? sortOrderDifference
          : left.index - right.index;
      })
      .map(({ entry }) => entry),
  );
}

export function normalizeResumeDraftSectionEntryOrdering(
  section: ResumeDraftSection,
): ResumeDraftSection {
  if (!sectionSupportsDeterministicEntryOrdering(section)) {
    return section;
  }

  const entryOrderMode =
    section.entryOrderMode === "manual" ? "manual" : "chronology";
  const entries =
    entryOrderMode === "manual"
      ? orderEntriesByManualSortOrder(section.entries)
      : orderEntriesNewestFirst(section.entries);

  return {
    ...section,
    entryOrderMode,
    entries,
  };
}

export function normalizeResumeDraftEntryOrdering(
  draft: ResumeDraft,
): ResumeDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) =>
      normalizeResumeDraftSectionEntryOrdering(section),
    ),
  };
}

export function resetSectionEntryOrderToChronology(
  section: ResumeDraftSection,
): ResumeDraftSection {
  if (!sectionSupportsDeterministicEntryOrdering(section)) {
    return section;
  }

  return {
    ...section,
    entryOrderMode: "chronology",
    entries: orderEntriesNewestFirst(section.entries),
  };
}

export function moveSectionEntry(input: {
  anchorEntryId: string | null;
  position: "after" | "before" | null;
  section: ResumeDraftSection;
  targetEntryId: string;
  updatedAt: string;
}): ResumeDraftSection {
  const normalizedSection = normalizeResumeDraftSectionEntryOrdering({
    ...input.section,
    entryOrderMode:
      input.section.entryOrderMode === "manual" ? "manual" : "chronology",
  });
  const entries = [...normalizedSection.entries];
  const currentIndex = entries.findIndex(
    (entry) => entry.id === input.targetEntryId,
  );

  if (currentIndex < 0) {
    throw new Error(`Unable to find entry '${input.targetEntryId}'.`);
  }

  const [movingEntry] = entries.splice(currentIndex, 1);
  if (!movingEntry) {
    return input.section;
  }

  if (!input.anchorEntryId) {
    entries.push(movingEntry);
  } else {
    const anchorIndex = entries.findIndex(
      (entry) => entry.id === input.anchorEntryId,
    );
    if (anchorIndex < 0) {
      throw new Error(`Unable to find anchor entry '${input.anchorEntryId}'.`);
    }

    const destinationIndex =
      input.position === "before" ? anchorIndex : anchorIndex + 1;
    entries.splice(destinationIndex, 0, movingEntry);
  }

  const nextEntries = renumberEntries(
    entries,
    input.targetEntryId,
    input.updatedAt,
  );
  const orderChanged = nextEntries.some(
    (entry, index) => normalizedSection.entries[index]?.id !== entry.id,
  );

  if (!orderChanged) {
    return input.section;
  }

  return {
    ...input.section,
    entryOrderMode: "manual",
    entries: nextEntries,
  };
}

interface DateSpan {
  start: number;
  end: number;
  startYearOnly: boolean;
  endYearOnly: boolean;
}

function getEffectiveDateSpan(
  parsed: ParsedResumeEntryDateRange,
  now = new Date(),
): DateSpan | null {
  const start = parsed.startMonth ?? parsed.endMonth;
  const end = parsed.isCurrent
    ? getCurrentMonthIndex(now)
    : (parsed.endMonth ?? parsed.startMonth);

  if (
    start === null ||
    start === undefined ||
    end === null ||
    end === undefined
  ) {
    return null;
  }

  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
    startYearOnly: parsed.startYearOnly,
    endYearOnly: parsed.endYearOnly,
  };
}

/**
 * Adjacent roles routinely share their boundary month ("Nov 2019 - Dec 2021"
 * followed by "Dec 2021 - Feb 2026"), and a year-only range resolves to whole
 * months, so a one-month intersection is ordinary handover, not a chronology
 * problem. Only a genuinely concurrent stretch is worth a review note.
 */
const RESUME_ENTRY_OVERLAP_TOLERANCE_MONTHS = 1;

/** Inclusive count of months shared by two spans; 0 when they do not touch. */
function getSpanOverlapMonths(
  left: { end: number; start: number },
  right: { end: number; start: number },
): number {
  const overlapStart = Math.max(left.start, right.start);
  const overlapEnd = Math.min(left.end, right.end);

  return overlapEnd < overlapStart ? 0 : overlapEnd - overlapStart + 1;
}

function spansOverlapBeyondTolerance(left: DateSpan, right: DateSpan): boolean {
  // A year-only boundary covers its whole year: roles that meet in the same
  // year ("2019 – 2023", then "2023 – Present") hand over within it.
  const [earlier, later] =
    left.start <= right.start ? [left, right] : [right, left];
  const tolerance =
    earlier.endYearOnly || later.startYearOnly
      ? 12
      : RESUME_ENTRY_OVERLAP_TOLERANCE_MONTHS;
  return getSpanOverlapMonths(left, right) > tolerance;
}

export function buildResumeEntryDateQualityIssues(
  draft: ResumeDraft,
  now = new Date(),
): ResumeValidationIssue[] {
  const issues: ResumeValidationIssue[] = [];

  for (const section of draft.sections) {
    if (!sectionSupportsDeterministicEntryOrdering(section)) {
      continue;
    }

    const parsedEntries = section.entries.map((entry) => ({
      entry,
      parsed: parseResumeEntryDateRange(entry, now),
    }));

    for (const { entry, parsed } of parsedEntries) {
      const name =
        [entry.title, entry.subtitle].filter(Boolean).join(" — ") ||
        section.label;
      const dates =
        entry.dateRange ??
        [entry.startDate, entry.endDate].filter(Boolean).join(" – ");
      if (
        parsed.hasMissingDateRange &&
        missingDateQualitySectionKinds.has(section.kind)
      ) {
        issues.push({
          id: `issue_date_missing_${entry.id}`,
          severity: "info",
          category: "date_quality",
          sectionId: section.id,
          entryId: entry.id,
          bulletId: null,
          message: `${name}: add a date or year if you know it.`,
        });
      } else if (
        parsed.hasUnparseableDateRange ||
        (!parsed.hasParseableDate &&
          Boolean(
            entry.dateRange?.trim() ||
            entry.startDate?.trim() ||
            entry.endDate?.trim(),
          ))
      ) {
        issues.push({
          id: `issue_date_ambiguous_${entry.id}`,
          severity: "info",
          category: "date_quality",
          sectionId: section.id,
          entryId: entry.id,
          bulletId: null,
          message: `${name}: check “${dates}”. The date could not be read; your wording was kept.`,
        });
      }

      if (parsed.endBeforeStart) {
        issues.push({
          id: `issue_date_reversed_${entry.id}`,
          severity: "warning",
          category: "date_quality",
          sectionId: section.id,
          entryId: entry.id,
          bulletId: null,
          message: `${name}: the end date in “${dates}” appears earlier than the start. Check the dates.`,
        });
      }

      if (parsed.hasFutureDate) {
        issues.push({
          id: `issue_date_future_${entry.id}`,
          severity: "warning",
          category: "date_quality",
          sectionId: section.id,
          entryId: entry.id,
          bulletId: null,
          message: `${name}: “${dates}” includes a future date. Check the dates.`,
        });
      }
    }

    const currentEntries = parsedEntries.filter(
      ({ parsed }) => parsed.isCurrent,
    );
    if (currentEntries.length > 1) {
      for (const { entry } of currentEntries) {
        const name =
          [entry.title, entry.subtitle].filter(Boolean).join(" — ") ||
          section.label;
        const dates =
          entry.dateRange ??
          [entry.startDate, "Present"].filter(Boolean).join(" – ");
        issues.push({
          id: `issue_date_duplicate_current_${entry.id}`,
          severity: "info",
          category: "date_quality",
          sectionId: section.id,
          entryId: entry.id,
          bulletId: null,
          message: `${name}: “${dates}” and another entry are marked current. Check whether both roles are still active.`,
        });
      }
    }

    const overlapEntryIds = new Set<string>();
    for (let leftIndex = 0; leftIndex < parsedEntries.length; leftIndex += 1) {
      const left = parsedEntries[leftIndex];
      if (!left) {
        continue;
      }
      const leftSpan = getEffectiveDateSpan(left.parsed, now);
      if (!leftSpan) {
        continue;
      }

      for (
        let rightIndex = leftIndex + 1;
        rightIndex < parsedEntries.length;
        rightIndex += 1
      ) {
        const right = parsedEntries[rightIndex];
        if (!right) {
          continue;
        }
        const rightSpan = getEffectiveDateSpan(right.parsed, now);
        if (rightSpan && spansOverlapBeyondTolerance(leftSpan, rightSpan)) {
          overlapEntryIds.add(left.entry.id);
          overlapEntryIds.add(right.entry.id);
        }
      }
    }

    for (const entryId of overlapEntryIds) {
      const entry = parsedEntries.find(
        (value) => value.entry.id === entryId,
      )!.entry;
      const name =
        [entry.title, entry.subtitle].filter(Boolean).join(" — ") ||
        section.label;
      const dates =
        entry.dateRange ??
        [entry.startDate, entry.endDate].filter(Boolean).join(" – ");
      issues.push({
        id: `issue_date_overlap_${entryId}`,
        severity: "info",
        category: "date_quality",
        sectionId: section.id,
        entryId,
        bulletId: null,
        message: `${name}: “${dates}” may overlap another ${section.label.toLowerCase()} entry. Concurrent roles are fine; check the months if only years were supplied.`,
      });
    }
  }

  return issues;
}
