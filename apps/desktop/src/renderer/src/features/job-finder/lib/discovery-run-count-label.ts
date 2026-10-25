import type {
  DiscoveryActivityEvent,
  DiscoveryRunRecord,
  DiscoveryRunReport,
} from "@nestor/contracts";
import {
  formatDiscoveryAccounting,
  formatDiscoverySourceAccounting,
} from "@nestor/contracts";

/**
 * The counts a finished run froze about itself, read verbatim.
 *
 * A run recorded before the report existed genuinely has no such numbers, so
 * every field is nullable and renders as "not recorded". Nothing here is ever
 * recomputed from current inventory: that is exactly what let one search read
 * as 100 on Home, 50 on Find jobs and 15 in the plan card.
 */
export interface DiscoveryRunReportCounts {
  rejected?: number | null;
  deferred?: number | null;
  pagesCovered?: number | null;
  found: number | null;
  unique?: number | null;
  new: number | null;
  saved: number | null;
  retained: number | null;
  worthOpening: number | null;
  duplicates: number | null;
  /**
   * Listings the plan already held before this run started. Null for runs
   * recorded before the split existed, which is why the duplicate tally is
   * still read as a fallback below.
   */
  alreadyHere: number | null;
}

const MISSING_RUN_COUNT_LABEL = "not recorded";

const EMPTY_RUN_REPORT_COUNTS: DiscoveryRunReportCounts = {
  found: null,
  new: null,
  saved: null,
  retained: null,
  worthOpening: null,
  duplicates: null,
  alreadyHere: null,
};

function readReportCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/** Reads one run's frozen report. Never derives a missing count. */
export function getDiscoveryRunReportCounts(
  run: Pick<DiscoveryRunRecord, "summary"> | null | undefined,
): DiscoveryRunReportCounts {
  return readDiscoveryRunReportCounts(run?.summary?.report ?? null);
}

/**
 * The same reading, for a report held somewhere other than a run record — a
 * search plan's digest carries its run's frozen report so the plan card can
 * print it without the run.
 */
export function readDiscoveryRunReportCounts(
  report: DiscoveryRunReport | null | undefined,
): DiscoveryRunReportCounts {
  if (!report) {
    return EMPTY_RUN_REPORT_COUNTS;
  }

  return {
    ...(report.rejected !== undefined
      ? {
          rejected: report.rejected,
          deferred: report.deferred ?? null,
          pagesCovered: report.pagesCovered ?? null,
        }
      : {}),
    found: readReportCount(report.found),
    unique: readReportCount(report.unique),
    new: readReportCount(report.new),
    saved: readReportCount(report.saved),
    retained: readReportCount(report.retained),
    worthOpening: readReportCount(report.worthOpening),
    duplicates: readReportCount(report.duplicates),
    alreadyHere: readReportCount(report.alreadyHere),
  };
}

function formatReportSegment(value: number | null, noun: string): string {
  // A run recorded before this accounting existed has no such number. Saying
  // so is the only honest option: printing 0 would claim the search found
  // nothing, which is a different and false statement.
  return value === null
    ? `${noun} ${MISSING_RUN_COUNT_LABEL}`
    : `${value} ${noun}`;
}

/**
 * How many of this run's listings were already saved, from the run's own
 * frozen report.
 *
 * Exported because the plan card's headline and its breakdown row have to be
 * the same number: the headline read this while the "Seen before" tile read
 * the change digest's sighting tally, so one plan card printed "7 already
 * here" above "Seen before 0".
 */
export function resolveDiscoveryRunAlreadyHereCount(
  counts: DiscoveryRunReportCounts,
): number | null {
  return resolveAlreadyHereCount(counts);
}

function resolveAlreadyHereCount(
  counts: DiscoveryRunReportCounts,
): number | null {
  // "Already here" means the plan held these listings before the run. The run
  // measures that itself now; the duplicate tally below is only the reading
  // for runs recorded before the two were told apart, and it is why a first
  // search on an empty workspace once reported 47 listings as already here.
  if (counts.alreadyHere !== null) return counts.alreadyHere;
  if (counts.duplicates === null) return null;
  if (
    counts.found !== null &&
    counts.duplicates >= counts.found &&
    ((counts.new ?? 0) > 0 || (counts.retained ?? 0) > 0)
  ) {
    return Math.max(0, counts.found - (counts.new ?? 0));
  }
  return counts.duplicates;
}

/**
 * The one sentence every surface prints about a finished search:
 * "N looked at · M new · K kept · D already here". Same run, same frozen
 * population and vocabulary everywhere.
 *
 * "Kept" is the search plan's retained population, decided once at the plan's
 * terminal commit. A run that never belonged to a plan keeps everything it
 * saved, and the pipeline records that at freeze time, so this reads the same
 * field either way.
 */
export function formatDiscoveryRunReportLabel(
  counts: DiscoveryRunReportCounts,
): string {
  if (!hasDiscoveryRunReportCounts(counts)) {
    return `Counts ${MISSING_RUN_COUNT_LABEL} for this run`;
  }

  if (counts.unique != null || counts.rejected !== undefined) {
    return formatDiscoveryAccounting(counts);
  }
  // "N found · M new"; "kept" only when fewer were kept than found, and
  // "already here" only when there were any. Four numbers where two say
  // everything was the sentence people skipped.
  const segments = [
    formatReportSegment(counts.found, "found"),
    formatReportSegment(counts.new, "new"),
  ];
  if (
    counts.retained !== null &&
    counts.found !== null &&
    counts.retained !== counts.found
  ) {
    segments.push(formatReportSegment(counts.retained, "kept"));
  }

  const alreadyHere = resolveAlreadyHereCount(counts);
  if (alreadyHere !== null && alreadyHere > 0) {
    const everythingWasAlreadyHere =
      counts.found !== null &&
      counts.found > 0 &&
      alreadyHere === counts.found &&
      (counts.new ?? 0) === 0 &&
      (counts.retained ?? 0) === 0;
    segments.push(
      everythingWasAlreadyHere
        ? "all already here"
        : formatReportSegment(alreadyHere, "already here"),
    );
  }

  // A listing two sources both returned inside this one run was merged, not
  // met before. It is its own fact and says so, beside — never instead of —
  // what the plan already held. Runs recorded before the split read their
  // "already here" from this same number, so stating it twice is suppressed.
  if (counts.alreadyHere !== null && (counts.duplicates ?? 0) > 0) {
    const duplicates = counts.duplicates ?? 0;
    segments.push(
      `${duplicates} ${duplicates === 1 ? "duplicate" : "duplicates"} merged`,
    );
  }

  return segments.join(" · ");
}

/** True when the run froze at least one count worth printing. */
export function hasDiscoveryRunReportCounts(
  counts: DiscoveryRunReportCounts,
): boolean {
  return (
    counts.found !== null || counts.new !== null || counts.retained !== null
  );
}

export interface DiscoveryRunCountEvidence {
  /**
   * Distinct jobs this run added to the workspace, already deduplicated:
   * duplicates never inflate this count, so it displays as-is.
   */
  distinctJobsRetained: number;
  /**
   * Valid listings that merged into already-known jobs instead of being
   * added.
   */
  duplicatesMerged: number;
}

function readCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeCount(value: number): number {
  return Math.max(0, Math.trunc(value) || 0);
}

/**
 * Compact, truthful count phrasing for one discovery run's result volume,
 * meaning everything the run saved to this device.
 *
 * `distinctJobsRetained` is authoritative and shown directly; it must already
 * exclude duplicates, so this formatter never subtracts one count from
 * another. Duplicate context comes only from the run's own duplicate counter,
 * and the label never claims a raw "found" volume, because reviewed-listing
 * totals share no base with what the run kept.
 */
export function formatDiscoveryRunCountLabel(
  evidence: DiscoveryRunCountEvidence,
): string {
  const retained = normalizeCount(evidence.distinctJobsRetained);
  const duplicatesMerged = normalizeCount(evidence.duplicatesMerged);
  // "Saved", never "kept". This is the device-level population — everything
  // the run added to the workspace — while "kept" belongs to the smaller
  // population the active search plan holds. Home printed both numbers with
  // the same verb, so "50 new jobs kept" and "the 15 kept in your current
  // search plan" read as a contradiction rather than two different facts.
  const retainedLabel = `${retained} new ${
    retained === 1 ? "job" : "jobs"
  } saved`;

  if (duplicatesMerged > 0) {
    const duplicateLabel =
      duplicatesMerged === 1
        ? "1 duplicate merged"
        : `${duplicatesMerged} duplicates merged`;
    return `${retainedLabel} · ${duplicateLabel}`;
  }

  return retainedLabel;
}

/**
 * Only live events whose listings have already been through the merge may
 * contribute counts: the per-target persistence event and terminal target/run
 * events. Earlier progress stages publish candidate totals (collected,
 * budgeted, or scored listings) whose review volume shares no base with the
 * run's duplicate counter yet, so deriving retained counts from them would
 * misstate what the run has kept.
 */
function carriesMergedResultCounts(event: DiscoveryActivityEvent): boolean {
  // Plain objects may omit the field entirely instead of carrying the schema
  // default, so both undefined and null mean "not terminal".
  return (
    event.stage === "persistence" || (event.terminalState ?? null) !== null
  );
}

/**
 * Resolves the strongest available count evidence for a run.
 *
 * The persisted summary is authoritative: its `validJobsFound` already counts
 * only distinct retained additions, so it is displayed directly and Task
 * Center and Search history agree on the settled result. While a run is still
 * streaming and its summary has not caught up yet, the newest merged-result
 * live event stands in (see {@link carriesMergedResultCounts}): that event's
 * `jobsFound` carries review volume (valid cards merged, duplicates included),
 * so its own `duplicatesMerged` is subtracted to yield the distinct additions
 * that event settled. The two bases are never mixed — no subtraction runs
 * against summary numbers and no maximum is taken across bases.
 */
export function getDiscoveryRunCountEvidence(
  run: DiscoveryRunRecord | null,
  liveEvent: DiscoveryActivityEvent | null,
): DiscoveryRunCountEvidence {
  // The frozen report is authoritative whenever the run has one: it was
  // measured once, at the run's own terminal moment, so it cannot drift as
  // the workspace changes underneath it.
  const report = getDiscoveryRunReportCounts(run);
  if (report.new !== null || report.duplicates !== null) {
    return {
      distinctJobsRetained: report.new ?? 0,
      duplicatesMerged: report.duplicates ?? 0,
    };
  }

  // Partial fixtures and legacy rows can reach here without a summary.
  const summaryRetained = readCount(run?.summary?.validJobsFound);
  const summaryDuplicates = readCount(run?.summary?.duplicatesMerged);

  if (summaryRetained > 0 || summaryDuplicates > 0) {
    return {
      distinctJobsRetained: summaryRetained,
      duplicatesMerged: summaryDuplicates,
    };
  }

  if (liveEvent && carriesMergedResultCounts(liveEvent)) {
    const reviewedListings = readCount(liveEvent.jobsFound);
    const duplicatesMerged = readCount(liveEvent.duplicatesMerged);
    return {
      distinctJobsRetained: Math.max(0, reviewedListings - duplicatesMerged),
      duplicatesMerged,
    };
  }

  return { distinctJobsRetained: 0, duplicatesMerged: 0 };
}

export interface DiscoveryResultBandCounts {
  /** Results the app is willing to recommend opening. */
  worthOpening: number;
  /**
   * Listings matched by title alone and never checked further. They are
   * neither recommended nor demoted, so they are counted separately instead
   * of being folded into either of the other two numbers.
   */
  titleMatches?: number;
  /** Weaker matches plus clear mismatches, kept but not recommended. */
  alsoFound: number;
}

/**
 * The banded phrasing for one search's kept results.
 *
 * This is the SAME population the run-count sentence describes, split by how
 * strongly the app recommends each row:
 *
 *     kept === worthOpening + titleMatches + alsoFound
 *
 * Every surface that talks about a finished search uses one of these two
 * formatters, so "15 jobs kept in this search plan" and "0 worth opening · 13
 * title matches · 2 also found" can never disagree about the total. Nothing
 * anywhere may report a raw reviewed volume (the 50 listings a run looked at)
 * as if it were a result count.
 *
 * The middle number is printed whenever it is non-zero, and once it is
 * printed the other two are printed beside it even at zero: "0 worth opening"
 * is the honest headline for a search that checked nothing past the titles,
 * and dropping it would leave the middle number reading as a recommendation.
 */
export function formatDiscoveryResultBandLabel(
  counts: DiscoveryResultBandCounts,
): string {
  const worthOpening = normalizeCount(counts.worthOpening);
  const titleMatches = normalizeCount(counts.titleMatches ?? 0);
  const alsoFound = normalizeCount(counts.alsoFound);

  if (titleMatches > 0) {
    // "0 worth opening" printed above four jobs the person had just said were
    // exactly what they were after is a verdict the app has not earned: those
    // rows are listed, they matched the saved role, and the only thing that
    // did not happen is the scoring. When nothing earned a score, the
    // headline says that instead of leading with a zero that reads as "we
    // found you nothing".
    if (worthOpening === 0) {
      return `${titleMatches} awaiting assessment · ${alsoFound} also found`;
    }
    return `${worthOpening} worth opening · ${titleMatches} awaiting assessment · ${alsoFound} also found`;
  }

  if (alsoFound > 0) {
    return `${worthOpening} worth opening · ${alsoFound} also found`;
  }

  return `${worthOpening} ${worthOpening === 1 ? "job" : "jobs"}`;
}

/**
 * The reconciling sentence that lets a user connect the banded headline with
 * the "kept" count Home prints.
 *
 * "Kept" means one thing everywhere: the rows this list shows — the current
 * plan's job ids intersected with the workspace's live discovery jobs, so a
 * dismissed, applied, or otherwise retired row leaves the count. Every caller
 * that prints this word must derive it from that same intersection and not
 * from the plan's own `jobIds` ledger, which is never pruned. A search can
 * save more listings to the device than the active plan's rules retain, so
 * this sentence deliberately does not attribute the total to the last run.
 */
export function formatDiscoveryResultBandTotal(
  counts: DiscoveryResultBandCounts,
): string {
  const kept =
    normalizeCount(counts.worthOpening) +
    normalizeCount(counts.titleMatches ?? 0) +
    normalizeCount(counts.alsoFound);
  return `${kept} ${kept === 1 ? "job" : "jobs"} kept in this search.`;
}

/**
 * Home's one sentence about the last finished search.
 *
 * Two real numbers exist and they are not the same population: a run can save
 * 50 listings to the device while the active plan's rules keep 15, which is
 * what Find jobs lists. Printing only the larger number made Home over-claim
 * and visibly disagree with Find jobs; printing only the smaller one would
 * lose the run's own accounting. When they differ, both are stated with the
 * meaning that separates them, so the two screens can be reconciled instead
 * of read as a contradiction.
 */
export function formatLastSearchSummarySentence(input: {
  runCountLabel: string;
  savedByRun: number;
  keptInPlan: number;
}): string {
  const savedByRun = normalizeCount(input.savedByRun);
  const keptInPlan = normalizeCount(input.keptInPlan);

  if (savedByRun === 0 || keptInPlan === savedByRun) {
    // `runCountLabel` already reads "N new jobs saved · M duplicates merged",
    // so the sentence must not repeat the verb around it.
    return `Your last search: ${input.runCountLabel}.`;
  }

  return `Your last search: ${formatSavedAndKeptCounts(savedByRun, keptInPlan)}.`;
}

/**
 * Home's status line for a search that has just finished.
 *
 * It describes the same two populations as {@link
 * formatLastSearchSummarySentence} and can appear in the same card, so it uses
 * the same clause rather than a second phrasing of the same facts. Printing
 * only the run's own total here ("Search finished · 50 new jobs saved") beside
 * Find jobs' "15 jobs kept in this search plan" read as two screens
 * contradicting each other about one search.
 *
 * When both numbers are the same population there is nothing to reconcile, so
 * the run's own label — which may also carry its duplicate count — stands.
 */
export function formatSearchFinishedStatusLine(input: {
  runCountLabel: string;
  savedByRun: number;
  keptInPlan: number;
}): string {
  const savedByRun = normalizeCount(input.savedByRun);
  const keptInPlan = normalizeCount(input.keptInPlan);

  if (savedByRun === 0 || keptInPlan === savedByRun) {
    return `Search finished · ${input.runCountLabel}, all on this device.`;
  }

  return `Search finished · ${formatSavedAndKeptCounts(savedByRun, keptInPlan)}.`;
}

/**
 * The one clause that states both populations with the noun that separates
 * them: "saved" is the device, "kept" is the active search plan. Both numbers
 * were once introduced as "kept", which read as one number contradicting
 * itself; later the second lost its verb entirely, which left "· 15 in your
 * current search plan" beside Find jobs' "15 jobs kept in this search plan"
 * as two different vocabularies for one fact.
 */
function formatSavedAndKeptCounts(
  savedByRun: number,
  keptInPlan: number,
): string {
  // Names the cause of the gap and where to change it; "50 saved · 15 kept"
  // sent people looking for 35 jobs that no screen lists.
  return `${savedByRun} new ${
    savedByRun === 1 ? "job" : "jobs"
  } saved on this device · ${keptInPlan} kept in this search`;
}

/** A source's part of the same run report; older runs say what was not recorded. */
export function getDiscoverySourceRunCountLabel(
  run: Pick<DiscoveryRunRecord, "summary"> &
    Partial<Pick<DiscoveryRunRecord, "targetExecutions">>,
  targetId: string,
): string {
  const source = run.summary.report?.sources?.find(
    (source) => source.targetId === targetId,
  );
  if (source) return formatDiscoverySourceAccounting(source);
  const execution = run.targetExecutions?.find(
    (source) => source.targetId === targetId,
  );
  if (!execution) return "Counts not recorded for this source";
  return formatDiscoverySourceAccounting({
    targetId,
    inspected: execution.jobsInspected ?? null,
    saved: execution.jobsPersisted + execution.jobsStaged,
    rejected:
      execution.jobsInspected !== undefined
        ? (execution.rejectedListings?.length ?? 0) + execution.invalidSkipped
        : null,
    duplicates: execution.duplicatesMerged + execution.jobsSkippedByLedger,
    deferred: execution.listingsDeferred ?? null,
    pagesCovered: execution.pagesCovered ?? null,
  });
}
