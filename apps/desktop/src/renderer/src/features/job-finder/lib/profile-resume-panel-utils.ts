import type {
  ResumeImportFieldCandidateSummary,
  ResumeImportRun,
  ResumeImportProgressEvent,
} from "@nestor/contracts";

export function getRunningResumeImportProgress(
  run: ResumeImportRun | null,
): ResumeImportProgressEvent | null {
  if (
    !run ||
    !["queued", "parsing", "extracting", "reconciling"].includes(run.status)
  )
    return null;
  return {
    stage:
      run.status === "reconciling"
        ? "saving_results"
        : run.status === "extracting"
          ? "building_profile"
          : "reading_document",
    message: "The latest resume import is still in progress.",
    occurredAt: run.startedAt,
  };
}

const monthIndexByName: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function getPendingYearsExperience(
  candidates: readonly ResumeImportFieldCandidateSummary[],
): number | null {
  const yearsCandidate = candidates.find(
    (candidate) =>
      candidate.target.section === "identity" &&
      candidate.target.key === "yearsExperience" &&
      typeof candidate.value === "number",
  );

  return typeof yearsCandidate?.value === "number"
    ? yearsCandidate.value
    : null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMonthStart(value: string): Date | null {
  const trimmed = value.trim().toLowerCase();

  if (!trimmed) {
    return null;
  }

  const isoMonthMatch = trimmed.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (isoMonthMatch) {
    const yearValue = isoMonthMatch[1];
    const monthValue = isoMonthMatch[2];

    if (!yearValue || !monthValue) {
      return null;
    }

    const year = Number.parseInt(yearValue, 10);
    const monthIndex = Number.parseInt(monthValue, 10) - 1;

    return Number.isFinite(year) && monthIndex >= 0 && monthIndex <= 11
      ? new Date(Date.UTC(year, monthIndex, 1))
      : null;
  }

  const slashMonthMatch = trimmed.match(/^(\d{2})\/(\d{4})$/);
  if (slashMonthMatch) {
    const monthValue = slashMonthMatch[1];
    const yearValue = slashMonthMatch[2];

    if (!monthValue || !yearValue) {
      return null;
    }

    const monthIndex = Number.parseInt(monthValue, 10) - 1;
    const year = Number.parseInt(yearValue, 10);

    return Number.isFinite(year) && monthIndex >= 0 && monthIndex <= 11
      ? new Date(Date.UTC(year, monthIndex, 1))
      : null;
  }

  const monthYearMatch = trimmed
    .replace(/\./g, "")
    .match(/^([a-z]+)\s+(\d{4})$/);
  if (monthYearMatch) {
    const monthName = monthYearMatch[1];
    const yearValue = monthYearMatch[2];

    if (!monthName || !yearValue) {
      return null;
    }

    const monthIndex = monthIndexByName[monthName];
    const year = Number.parseInt(yearValue, 10);

    return monthIndex !== undefined && Number.isFinite(year)
      ? new Date(Date.UTC(year, monthIndex, 1))
      : null;
  }

  const yearMatch = trimmed.match(/^(\d{4})$/);
  if (yearMatch) {
    const yearValue = yearMatch[1];
    return yearValue
      ? new Date(Date.UTC(Number.parseInt(yearValue, 10), 0, 1))
      : null;
  }

  return null;
}

function parseMonthEnd(
  value: string,
  isCurrent: boolean,
  today = new Date(),
): Date | null {
  if (isCurrent || /^(present|current)$/i.test(value.trim())) {
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  }

  return parseMonthStart(value);
}

function getEstimatedYearsExperienceFromRecords(
  candidates: readonly ResumeImportFieldCandidateSummary[],
  today = new Date(),
): number | null {
  const monthRanges = candidates.flatMap((candidate) => {
    if (
      candidate.target.section !== "experience" ||
      candidate.target.key !== "record"
    ) {
      return [];
    }

    if (!isRecordValue(candidate.value)) {
      return [];
    }

    const startDate =
      typeof candidate.value.startDate === "string"
        ? candidate.value.startDate
        : "";
    const endDate =
      typeof candidate.value.endDate === "string"
        ? candidate.value.endDate
        : "";
    const isCurrent = candidate.value.isCurrent === true;
    const start = parseMonthStart(startDate);
    const end = parseMonthEnd(endDate, isCurrent, today);

    if (!start || !end || end < start) {
      return [];
    }

    return [{ start, end }];
  });

  if (monthRanges.length === 0) {
    return null;
  }

  const coveredMonthKeys = new Set<number>();

  for (const range of monthRanges) {
    let year = range.start.getUTCFullYear();
    let month = range.start.getUTCMonth();
    const endYear = range.end.getUTCFullYear();
    const endMonth = range.end.getUTCMonth();

    while (year < endYear || (year === endYear && month <= endMonth)) {
      coveredMonthKeys.add(year * 12 + month);
      month += 1;

      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
  }

  const totalMonths = coveredMonthKeys.size;

  return Math.max(0, Math.floor(totalMonths / 12));
}

export function getVisibleYearsExperience(input: {
  profileYearsExperience: number | null;
  reviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  today?: Date;
}): number | null {
  const reviewedCandidates = input.reviewCandidates.filter(
    (candidate) =>
      candidate.resolution === "auto_applied" &&
      candidate.resolutionReason === "review_confirmed",
  );
  const pendingYearsExperience = getPendingYearsExperience(reviewedCandidates);
  const estimatedYearsExperience = getEstimatedYearsExperienceFromRecords(
    reviewedCandidates,
    input.today,
  );

  return input.profileYearsExperience !== null &&
    input.profileYearsExperience > 0
    ? input.profileYearsExperience
    : (pendingYearsExperience ??
        estimatedYearsExperience ??
        input.profileYearsExperience);
}
