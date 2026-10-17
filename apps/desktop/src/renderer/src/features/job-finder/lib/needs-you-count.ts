import type {
  GroupedManualAnswerDecision,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import {
  projectNeedsYou,
  projectWorkspaceAttention,
} from "@nestor/job-finder/assistant-attention";

/**
 * The one renderer-side owner of the "Needs you" population.
 *
 * Before this module the same twenty lines existed twice — once in
 * `job-finder-shell.tsx` for the badge and once in `job-search-home-screen.tsx`
 * for Home's next action — and `campaign-dashboard.ts` derived a third,
 * un-collapsed number. One grouped decision covering three questions therefore
 * read as 1 in the badge, 3 on Home and 0 in the Needs you toolbar.
 *
 * The population is: every user action request that is not in a final state,
 * minus the requests a pending grouped decision already represents, plus one
 * entry per pending grouped decision. That is exactly what the Needs you screen
 * renders, so the badge and the page cannot disagree.
 */
const FINAL_ACTION_REQUEST_STATES: readonly string[] = [
  "resolved",
  "skipped",
  "cancelled",
  "expired",
  "superseded",
];

export interface NeedsYouCountInput {
  reviewQueue?: readonly JobFinderRendererWorkspaceSnapshot["reviewQueue"][number][];
  /**
   * Applications the Applications screen badges "Needs you". They belong to
   * the same population: an application paused on a site step the person has
   * to finish was badged NEEDS YOU while this count said "0 unresolved",
   * because it only ever counted live browser-step requests.
   */
  applicationRecords?:
    | readonly JobFinderRendererWorkspaceSnapshot["applicationRecords"][number][]
    | undefined;
  applyJobResults?:
    | readonly JobFinderRendererWorkspaceSnapshot["applyJobResults"][number][]
    | undefined;
  groupedDecisions?: readonly GroupedManualAnswerDecision[] | undefined;
  requests?:
    | readonly JobFinderRendererWorkspaceSnapshot["userActionRequests"][number][]
    | undefined;
}

/** The application-record ledger is the one application population. */
export function countApplicationLedgerEntries<
  TRecord extends { jobId: string },
>(records: readonly TRecord[], jobIds?: ReadonlySet<string>): number {
  return jobIds
    ? records.filter((record) => jobIds.has(record.jobId)).length
    : records.length;
}

/**
 * Applications waiting on the person that no live request already represents.
 * Exported so the Needs you screen lists exactly what the badge counts.
 */
export function listApplicationsAwaitingUser({
  applicationRecords,
  applyJobResults,
  requests,
}: Pick<
  NeedsYouCountInput,
  "applicationRecords" | "applyJobResults" | "requests"
>): readonly JobFinderRendererWorkspaceSnapshot["applicationRecords"][number][] {
  return projectNeedsYou({ applicationRecords, applyJobResults, requests })
    .applications;
}

export function countNeedsYouItems(input: NeedsYouCountInput): number {
  return projectNeedsYou(input).count;
}

/**
 * How many of one apply run's jobs the Needs you population holds.
 *
 * The Applications run summary used to count the run's own blocked and failed
 * results directly, so a finished batch printed "5 need attention" beside a
 * header badge reading "Needs you: 4 unresolved" for the same five jobs: one
 * of them was blocked without ever becoming something the person could act
 * on. Both numbers now come from this module — the summary counts this run's
 * share of exactly the population the badge totals — so the two can only
 * differ by what belongs to another run.
 */
export function countApplyRunItemsNeedingYou({
  applicationRecords,
  applyJobResults,
  requests,
  runId,
  runJobIds,
}: NeedsYouCountInput & {
  runId: string;
  runJobIds: ReadonlySet<string>;
}): number {
  const runRequests = (requests ?? []).filter(
    (request) =>
      request.scope?.type === "application" &&
      (request.scope.runId === runId || runJobIds.has(request.scope.jobId)),
  );
  const unresolvedRunRequests = runRequests.filter(
    (request) => !FINAL_ACTION_REQUEST_STATES.includes(request.state),
  );
  const runApplications = (applicationRecords ?? []).filter((record) =>
    runJobIds.has(record.jobId),
  );

  return (
    unresolvedRunRequests.length +
    listApplicationsAwaitingUser({
      applicationRecords: runApplications,
      applyJobResults,
      requests: runRequests,
    }).length
  );
}

/** Convenience reader for callers that already hold the whole snapshot. */
export function countWorkspaceNeedsYouItems(
  workspace: JobFinderRendererWorkspaceSnapshot,
): number {
  return projectWorkspaceAttention(workspace).count;
}
