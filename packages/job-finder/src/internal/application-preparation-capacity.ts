import type {
  ApplicationRecord,
  ApplyJobResult,
  ApplyRun,
  JobFinderDashboardSummary,
} from "@nestor/contracts";

export const MAX_EMPLOYER_APPLICATION_JOBS_PER_RUN = 1000;
export const MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY = 20;

type DailyCapacity = NonNullable<
  JobFinderDashboardSummary["globalDailyApplicationPreparationCapacity"]
>;

export function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * The day's begun employer applications.
 *
 * Apply-job results are the exact ledger for work this app drove. A legacy
 * application prepared without one can be counted only when its event history
 * records that the employer application was actually opened. Record creation
 * is staging, not evidence that preparation began.
 */
export function deriveGlobalDailyApplicationPreparationCapacity(input: {
  applyRuns: readonly ApplyRun[];
  applyJobResults: readonly ApplyJobResult[];
  applicationRecords?: readonly ApplicationRecord[];
  /** The person's saved daily limit. Twenty remains the default from ADR 0012. */
  limit?: number;
  /**
   * Jobs whose slot a live in-flight reservation already holds. A record is
   * created the moment preparation begins, a beat before the run's apply-job
   * result exists, so counting it here as well would charge that job twice
   * and halve the day's real limit.
   */
  reservedJobIds?: readonly string[];
  now?: Date;
}): DailyCapacity {
  const now = input.now ?? new Date();
  const limit = Math.max(
    1,
    Math.trunc(input.limit ?? MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY),
  );
  const localDate = localDateKey(now);
  const localDayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const localDayEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  ).getTime();
  const exactLineages = new Set<string>();
  const uncertainLegacyLineages = new Set<string>();
  for (const result of input.applyJobResults) {
    // A technical navigation failure never opened the employer page, so the
    // application never truly began and must not consume a begun slot.
    if (
      result.state === "failed" &&
      result.blockerReason === "application_page_unreachable"
    ) {
      continue;
    }
    const lineage = `${result.runId}\0${result.jobId}`;
    if (result.applicationPreparationStartedLocalDate === localDate) {
      exactLineages.add(lineage);
      continue;
    }
    if (
      result.applicationPreparationStartedAt !== undefined ||
      result.applicationPreparationStartedLocalDate !== undefined ||
      result.state === "planned"
    ) {
      continue;
    }
    const startedAt = Date.parse(result.startedAt);
    const updatedAt = Date.parse(result.updatedAt);
    if (startedAt < localDayEnd && updatedAt >= localDayStart) {
      uncertainLegacyLineages.add(lineage);
    }
  }
  for (const lineage of exactLineages) {
    uncertainLegacyLineages.delete(lineage);
  }

  // A job the apply ledger already knows about is skipped entirely: that
  // ledger, not the record, decides whether the job spent a slot. For a legacy
  // record without a result, only an employer-page-open checkpoint is start
  // evidence; approval-request and record-creation timestamps are not.
  const countedJobIds = new Set([
    ...input.applyJobResults.map((result) => result.jobId),
    ...(input.reservedJobIds ?? []),
  ]);
  for (const record of input.applicationRecords ?? []) {
    if (countedJobIds.has(record.jobId)) {
      continue;
    }
    const startedAt = record.events
      .filter((event) =>
        [
          "Application preparation started",
          "Opened exact application target",
          "Opened Easy Apply",
        ].includes(event.title),
      )
      .map((event) => event.at)
      .sort()
      .at(0);
    if (!startedAt) {
      continue;
    }
    const preparedAt = Date.parse(startedAt);
    if (Number.isNaN(preparedAt)) {
      continue;
    }
    if (localDateKey(new Date(preparedAt)) !== localDate) {
      continue;
    }
    countedJobIds.add(record.jobId);
    exactLineages.add(`application_record\0${record.jobId}`);
    uncertainLegacyLineages.delete(`application_record\0${record.jobId}`);
  }

  const used = exactLineages.size;
  const legacyUncertain = uncertainLegacyLineages.size;
  const resetsAt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  ).toISOString();

  return {
    limit,
    used,
    legacyUncertain,
    remaining: Math.max(0, limit - used - legacyUncertain),
    localDate,
    resetsAt,
  };
}
