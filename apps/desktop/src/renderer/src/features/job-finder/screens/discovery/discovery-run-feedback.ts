import {
  DISCOVERY_RUN_ALREADY_ACTIVE_MESSAGE,
  type DiscoveryRunRecord,
  type PlanSafeguardPause,
} from "@nestor/contracts";
import {
  JOB_FINDER_BROWSER_NAME,
  JOB_FINDER_BROWSER_NAME_SENTENCE_START,
  OPEN_JOB_FINDER_BROWSER_ACTION,
} from "../../lib/job-finder-browser-handoff-copy";

export type DiscoveryRunFeedbackStatus =
  | "started"
  | "succeeded"
  | "paused"
  | "cancelled"
  | "failed";

/**
 * Terminal truth about the most recent discovery attempt, derived from run
 * history so empty results never claim a verdict the newest run cannot back.
 * `interrupted` covers failed and cancelled runs plus completed runs whose
 * source executions failed without producing any results; `hasEarlierCompleted`
 * keeps the partial-completed distinction so copy can acknowledge that an older
 * completed search exists behind the newer stopped one.
 */
export type DiscoveryLatestRunVerdict =
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "completed" }
  | {
      hasEarlierCompleted: boolean;
      /**
       * Why the newest attempt cannot back a "no matches" claim:
       * `cancelled`/`failed` mean the run itself stopped early;
       * `sources_failed` means the run finished but at least one enabled
       * source execution failed and the whole run still returned zero results.
       */
      interruptState: "cancelled" | "failed" | "sources_failed";
      kind: "interrupted";
    };

/**
 * Run history evidence for verdict resolution. `summary` stays optional so
 * minimal `{ state, startedAt }` rows keep working; absent summary evidence can
 * only preserve (never weaken) a completed verdict.
 */
export type DiscoveryRunVerdictInput = Pick<
  DiscoveryRunRecord,
  "state" | "startedAt"
> & {
  summary?: Pick<
    DiscoveryRunRecord["summary"],
    "validJobsFound" | "sourceHealth"
  > & {
    duplicatesMerged?: number;
  };
};

function hasFailedSourceExecution(run: DiscoveryRunVerdictInput): boolean {
  return (
    run.summary?.sourceHealth.some((source) => source.health === "failed") ??
    false
  );
}

function hasZeroValidResults(run: DiscoveryRunVerdictInput): boolean {
  // Only an explicit zero count is proof the run produced nothing; an absent
  // count keeps the conservative completed verdict.
  return run.summary?.validJobsFound === 0;
}

/**
 * Orders run history newest-first by `startedAt` — never by array order —
 * dropping `idle` placeholder rows, which are not attempts. Runs sharing an
 * identical start time keep their first-listed position (stable sort).
 */
function orderSettledRunsNewestFirst<
  TRun extends { startedAt: string; state: DiscoveryRunRecord["state"] },
>(
  runs: readonly TRun[],
): (TRun & { state: Exclude<DiscoveryRunRecord["state"], "idle"> })[] {
  return runs
    .filter(
      (
        run,
      ): run is TRun & {
        state: Exclude<DiscoveryRunRecord["state"], "idle">;
      } => run.state !== "idle",
    )
    .sort(
      (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
    );
}

/**
 * Resolves the newest settled run by `startedAt` — never by array order — and
 * classifies it. Runs sharing an identical start time keep their first-listed
 * position as the authority (stable sort), and `idle` placeholder rows are
 * ignored entirely.
 */
export function getDiscoveryLatestRunVerdict(
  runs: readonly DiscoveryRunVerdictInput[],
): DiscoveryLatestRunVerdict {
  // `idle` rows are placeholders, not attempts; every other state is a
  // settled or live verdict candidate.
  const orderedRuns = orderSettledRunsNewestFirst(runs);
  const newestRun = orderedRuns[0];
  if (!newestRun) {
    return { kind: "none" };
  }

  const newestStartedMs = Date.parse(newestRun.startedAt);
  const hasEarlierCompleted = orderedRuns.some(
    (run) =>
      run.state === "completed" && Date.parse(run.startedAt) < newestStartedMs,
  );

  if (newestRun.state === "running") {
    return { kind: "running" };
  }
  if (newestRun.state === "completed") {
    // A finished run still cannot claim "no matches" when a source execution
    // failed and the whole run produced zero results; results or fully
    // successful executions keep the completed verdict. Zero new additions
    // with duplicate merges are a completed repeat search — not an interrupt.
    const duplicatesMerged = newestRun.summary?.duplicatesMerged ?? 0;
    if (
      hasFailedSourceExecution(newestRun) &&
      hasZeroValidResults(newestRun) &&
      duplicatesMerged === 0
    ) {
      return {
        hasEarlierCompleted,
        interruptState: "sources_failed",
        kind: "interrupted",
      };
    }
    return { kind: "completed" };
  }

  return {
    hasEarlierCompleted,
    interruptState: newestRun.state,
    kind: "interrupted",
  };
}

/**
 * Run-history evidence for run-level notices. Only the recorded `warnings`
 * are read, so this stays valid for lightweight history rows.
 */
export type DiscoveryRunNoticeInput = Pick<
  DiscoveryRunRecord,
  "state" | "startedAt"
> & {
  /** Mirrors `DiscoveryRunSummary.warnings`; nothing here is written back. */
  summary?: { warnings: readonly string[] };
};

/**
 * Run-level warnings the newest settled attempt recorded, kept verbatim.
 *
 * The condition behind each warning is decided once, where the run is
 * produced, and travels on `summary.warnings`; deriving it a second time in
 * the renderer would let the two copies drift. This selector therefore only
 * chooses whose warnings to show — never what they say — and only the newest
 * attempt's, so an older run can never keep warning about work it no longer
 * describes.
 */
export function getDiscoveryLatestRunNotices(
  runs: readonly DiscoveryRunNoticeInput[],
): readonly string[] {
  const newestRun = orderSettledRunsNewestFirst(runs)[0];
  const notices: string[] = [];
  const seen = new Set<string>();

  for (const warning of newestRun?.summary?.warnings ?? []) {
    if (warning.trim().length === 0 || seen.has(warning)) {
      continue;
    }
    seen.add(warning);
    notices.push(warning);
  }

  return notices;
}

export type DiscoveryRunRecoveryKind =
  | "browser_session"
  | "source_setup"
  | "connection"
  | "retry";

export interface DiscoveryRunRecovery {
  kind: DiscoveryRunRecoveryKind;
  headline: string;
  actionLabel: string | null;
  nextStep: string;
}

export interface DiscoveryRunFeedback {
  status: DiscoveryRunFeedbackStatus;
  /** Distinguishes immediate failure copy from a later completed continuation. */
  recordedAtMs?: number;
  /** Classified service detail kept verbatim so failures stay truthful. */
  detail: string | null;
  headline: string;
  recovery: DiscoveryRunRecovery | null;
  safeguardAction?: {
    label: "Open Safeguards";
    route: PlanSafeguardPause["route"];
  };
  targetLabel: string | null;
  targetId?: string | null;
  /**
   * Set on outcomes that need nothing from the person (a finished or stopped
   * search). Find jobs shows these as a short toast instead of a banner over
   * the results (ADR 0042); `headline` stays the full sentence for Home,
   * Search history and tests.
   */
  partial?: boolean;
  toast?: { title: string; description: string | null };
}

const BROWSER_RUNTIME_FAILURE_RE =
  /\bbrowser\b|\bchrome\b|\bchromium\b|browser profile|dedicated browser|agent runtime|launch/i;
const NO_JOB_SITES_FAILURE_RE = /no job sites to search/i;
const SOURCE_SETUP_FAILURE_RE =
  /single_target|not found or unavailable|missing, disabled|no runnable|no enabled|enable at least one|add at least one|add or enable/i;
const CONNECTION_FAILURE_RE =
  /fetch failed|network|offline|\bdns\b|ENOTFOUND|ECONNREFUSED|ERR_CONNECTION_REFUSED|ECONNRESET|ETIMEDOUT|timed?\s?out|unreachable|socket|provider (is )?(unavailable|unreachable)/i;
const AI_SERVICE_TIMEOUT_RE =
  /(?:model request|AI service|AI provider|model provider|the model)[^\n]*(?:timed?\s?out|timeout|silence|stopped responding)|(?:timed?\s?out|timeout|silence)[^\n]*(?:AI service|AI provider|model provider|the model)/i;
const SITE_PROTECTION_FAILURE_RE =
  /bot check|human-verification check|verification check|verify you are human|\bcaptcha\b|are you a robot/i;
const SIGN_IN_WALL_FAILURE_RE =
  /asks you to sign in before it shows job listings/i;
const NO_PROGRESS_FAILURE_RE =
  /repeated actions produced no new jobs|no new jobs, page evidence|showed nothing new after several tries/i;
const MISSING_PAGE_FAILURE_RE =
  /\b(?:page|address|url)\b[^.]*?\bHTTP (?:404|410)\b/i;
const AI_TOOL_CALLING_FAILURE_RE =
  /does not support tool calling|chatWithTools|tool calling|Cannot run agent discovery/i;

/**
 * The search failed for the app's own reason (its AI was unavailable), not
 * because of a source: nothing about the person's sources needs a look.
 */
export function isAppSideDiscoveryFailure(detail: string): boolean {
  return AI_TOOL_CALLING_FAILURE_RE.test(detail);
}

/**
 * Maps a classified discovery failure to the exact corrective action using
 * source-generic wording only. The service message itself stays verbatim in
 * `detail`; this mapping never invents a different failure cause.
 */
export function getDiscoveryRunFailureRecovery(
  detail: string,
): DiscoveryRunRecovery {
  // Access walls first: their sentences mention the browser and job sites,
  // which the broader classifiers below would read as a runtime failure.
  if (SITE_PROTECTION_FAILURE_RE.test(detail)) {
    return {
      kind: "browser_session",
      headline:
        "This site asked for a human verification check, so the search could not read it.",
      actionLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
      nextStep:
        "Open the site in the browser, get past the check, then search again.",
    };
  }

  if (SIGN_IN_WALL_FAILURE_RE.test(detail)) {
    return {
      kind: "browser_session",
      headline: "This site asks you to sign in before it shows job listings.",
      actionLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
      nextStep: `Open ${JOB_FINDER_BROWSER_NAME}, sign in on that site, then search again.`,
    };
  }

  if (NO_PROGRESS_FAILURE_RE.test(detail)) {
    return {
      kind: "retry",
      headline: "This source did not show any readable job listings.",
      actionLabel: null,
      nextStep: `Open the source in ${JOB_FINDER_BROWSER_NAME} to see what it shows, or try another job site, then search again.`,
    };
  }

  // A plan with nothing left to search is a Profile job, not a retry: the
  // sites it named are switched off or gone, so searching again changes
  // nothing until one is added back.
  if (NO_JOB_SITES_FAILURE_RE.test(detail)) {
    return {
      kind: "source_setup",
      headline: "This plan has no job sites to search.",
      actionLabel: "Review job sources",
      nextStep: "Add a job site in Profile, then run this plan again.",
    };
  }

  // A source address that leads to a missing page stays missing however
  // often the search is repeated; the address is what needs changing.
  if (MISSING_PAGE_FAILURE_RE.test(detail)) {
    return {
      kind: "source_setup",
      headline: "A job source's address leads to a page that does not exist.",
      actionLabel: "Review job sources",
      nextStep:
        "Correct or remove that address in Profile › Job sources, then search again.",
    };
  }

  if (SOURCE_SETUP_FAILURE_RE.test(detail)) {
    return {
      kind: "source_setup",
      headline: "No searchable source was ready for this run.",
      actionLabel: "Review job sources",
      nextStep: "Enable a valid public job-source URL, then search again.",
    };
  }

  // The AI going quiet mid-search is the service, not the person's network:
  // telling them to check their internet sent them looking for a fault that
  // was not there.
  if (AI_SERVICE_TIMEOUT_RE.test(detail)) {
    return {
      kind: "retry",
      headline: "The AI service stopped responding.",
      actionLabel: null,
      nextStep: "Jobs found so far are saved. Search again to continue.",
    };
  }

  // A navigation error can mention the dedicated browser while the browser
  // itself is healthy. Prefer the concrete transport cause in that case.
  if (CONNECTION_FAILURE_RE.test(detail)) {
    return {
      kind: "connection",
      headline: "A public provider or network request did not respond.",
      actionLabel: null,
      nextStep:
        "Check your internet connection, then search again. Nothing was submitted anywhere.",
    };
  }

  if (BROWSER_RUNTIME_FAILURE_RE.test(detail)) {
    return {
      kind: "browser_session",
      headline: `${JOB_FINDER_BROWSER_NAME_SENTENCE_START} could not start or stay reachable.`,
      actionLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
      nextStep: `Open ${JOB_FINDER_BROWSER_NAME}, sign in if the source asks, then search again.`,
    };
  }

  if (AI_TOOL_CALLING_FAILURE_RE.test(detail)) {
    return {
      kind: "retry",
      // AI is bundled with the product, so a missing or non-tool-capable
      // model is an outage from the user's side, never something to set up.
      headline: "Live search needs AI, which is not available right now.",
      actionLabel: null,
      nextStep:
        "Try again in a few minutes from the same button. Nothing was submitted anywhere.",
    };
  }

  return {
    kind: "retry",
    // Keep this distinct from interrupted feedback.headline so the callout
    // never prints the same "stopped before it could finish" line twice.
    headline: "Something unexpected stopped this search.",
    actionLabel: null,
    nextStep: "Wait a moment, then search again from the same button.",
  };
}

export function createDiscoveryRunStartedFeedback(
  targetLabel: string | null = null,
): DiscoveryRunFeedback {
  return {
    status: "started",
    detail: null,
    headline: targetLabel
      ? `Checking ${targetLabel}. Progress appears here and in Search history.`
      : "Search started. Results appear here as each enabled source finishes.",
    recovery: null,
    targetLabel,
  };
}

/**
 * `runCountLabel` is the run's own frozen "N found · M new · K kept" line.
 * The banner quotes it verbatim so Find jobs states the same three numbers as
 * Home, Search history, the plan card and Tasks instead of describing the
 * same search a sixth way.
 */
export function createDiscoveryRunSucceededFeedback(
  targetLabel: string | null = null,
  runCountLabel: string | null = null,
  /** Jobs new to the person, for the toast's one short line. */
  newJobCount: number | null = null,
  failedSourceCount = 0,
): DiscoveryRunFeedback {
  const partialTitle =
    failedSourceCount > 0
      ? `Search finished, ${failedSourceCount} ${failedSourceCount === 1 ? "source failed" : "sources failed"}`
      : null;
  const finished = partialTitle
    ? `${partialTitle}. Results from the other sources are saved.`
    : targetLabel
      ? `Search finished for ${targetLabel} and results were saved on this device.`
      : "Search finished and results were saved on this device.";

  return {
    status: "succeeded",
    detail: null,
    headline: runCountLabel ? `${finished} ${runCountLabel}.` : finished,
    partial: failedSourceCount > 0,
    recovery: null,
    targetLabel,
    toast: {
      title:
        partialTitle ??
        (targetLabel
          ? `Search finished for ${targetLabel}`
          : "Search finished"),
      description:
        newJobCount === null
          ? runCountLabel
          : newJobCount === 0
            ? "No new jobs this time."
            : `${newJobCount} new ${newJobCount === 1 ? "job" : "jobs"} saved to this plan.`,
    },
  };
}

export function createDiscoveryRunSafeguardPausedFeedback(
  route: PlanSafeguardPause["route"],
): DiscoveryRunFeedback {
  return {
    status: "paused",
    detail: null,
    headline: "Search paused by a safety limit",
    recovery: null,
    safeguardAction: { label: "Open Safeguards", route },
    targetLabel: null,
  };
}

/**
 * Success feedback when a run completed but every reviewed listing merged
 * into jobs already on this device. Keeps the visible results list truthful:
 * zero new additions does not mean the search failed.
 */
export function shouldPresentRepeatedDiscoveryFeedback(input: {
  duplicatesMerged: number;
  validJobsFound: number;
}): boolean {
  return input.duplicatesMerged > 0 && input.validJobsFound === 0;
}

export function createDiscoveryRunRepeatedFeedback(input: {
  duplicatesMerged: number;
  /** Listings the run looked at, new or not. Reported when it is known. */
  reviewedListingCount?: number | null;
  targetLabel?: string | null;
}): DiscoveryRunFeedback {
  const targetLabel = input.targetLabel ?? null;
  // `duplicatesMerged` counts the listings that merged, not the listings the
  // run read: a re-run that re-checked fifty postings and found one changed
  // reported "1 listing was already saved", which reads as if the search
  // barely ran. Lead with what was checked whenever that count is known.
  const reviewed = input.reviewedListingCount ?? null;
  const summary =
    reviewed !== null && reviewed > 0
      ? `Checked ${reviewed} ${reviewed === 1 ? "listing" : "listings"} — nothing new since your last search`
      : input.duplicatesMerged === 1
        ? "1 listing was already saved"
        : `${input.duplicatesMerged} listings were already saved`;

  return {
    status: "succeeded",
    detail: null,
    headline: targetLabel
      ? `Search finished for ${targetLabel}. ${summary}; your existing results are unchanged.`
      : `Search finished. ${summary}; your existing results are unchanged.`,
    recovery: null,
    targetLabel,
    toast: {
      title: targetLabel
        ? `Search finished for ${targetLabel}`
        : "Search finished",
      description: `${summary}; your results are unchanged.`,
    },
  };
}

/**
 * Terminal feedback for a run the user (or the runtime) deliberately stopped.
 * Never carries failure recovery — nothing went wrong that a corrective
 * action could fix — and never claims unconditional success: when the run had
 * already committed jobs, the copy says exactly what was kept; otherwise it
 * matches the interrupted verdict wording so an empty cancellation cannot
 * imply results exist.
 */
export function createDiscoveryRunCancelledFeedback(input: {
  savedJobCount: number | null;
  targetLabel?: string | null;
}): DiscoveryRunFeedback {
  const targetLabel = input.targetLabel ?? null;

  if ((input.savedJobCount ?? 0) > 0) {
    return {
      status: "cancelled",
      detail: null,
      headline: targetLabel
        ? `Search stopped for ${targetLabel}. Jobs found so far were kept on this device.`
        : "Search stopped. Jobs found so far were kept on this device.",
      recovery: null,
      targetLabel,
      toast: {
        title: targetLabel
          ? `Search stopped for ${targetLabel}`
          : "Search stopped",
        description: "Jobs found so far were kept.",
      },
    };
  }

  return {
    status: "cancelled",
    detail: null,
    headline: targetLabel
      ? `The search for ${targetLabel} stopped before it could finish.`
      : "The search stopped before it could finish.",
    recovery: null,
    targetLabel,
    toast: {
      title: targetLabel
        ? `Search stopped for ${targetLabel}`
        : "Search stopped",
      description: "It stopped before any jobs were saved.",
    },
  };
}

/**
 * Minimal run-history evidence for cancelled-run classification. Like
 * `DiscoveryRunVerdictInput`, rows only need the fields this decision reads,
 * so lightweight history entries keep working.
 */
export type DiscoveryCancelledSavedJobCountInput = readonly {
  state: DiscoveryRunRecord["state"];
  summary: Pick<DiscoveryRunRecord["summary"], "validJobsFound">;
}[];

/**
 * Truthful "what survived the cancel" evidence from the post-run workspace:
 * the newest discovery run record only counts when it is itself the
 * cancelled run, so a stale or superseded history entry can never fabricate
 * kept-jobs copy.
 */
export function getDiscoveryCancelledSavedJobCount(
  recentDiscoveryRuns: DiscoveryCancelledSavedJobCountInput,
): number | null {
  const newestRun = recentDiscoveryRuns[0];
  return newestRun?.state === "cancelled"
    ? newestRun.summary.validJobsFound
    : null;
}

export function createDiscoveryRunInterruptedFeedback(input: {
  detail: string | null;
  targetLabel?: string | null;
  targetId?: string | null;
}): DiscoveryRunFeedback {
  const detail = input.detail?.trim() || null;

  return {
    status: "failed",
    recordedAtMs: Date.now(),
    detail,
    headline: input.targetLabel
      ? `The search for ${input.targetLabel} stopped before it could finish.`
      : "The search stopped before it could finish.",
    recovery: detail ? getDiscoveryRunFailureRecovery(detail) : null,
    targetLabel: input.targetLabel ?? null,
    targetId: input.targetId ?? null,
  };
}

/**
 * True when the service refused a second search because the first one is still
 * live. A Stop that has not finished yet lands here, so this is the one
 * rejection that must never read as a failure.
 */
export function isDiscoveryAlreadyRunningDetail(
  detail: string | null | undefined,
): boolean {
  return (detail ?? "").includes(DISCOVERY_RUN_ALREADY_ACTIVE_MESSAGE);
}

export function createDiscoveryRunAlreadyRunningFeedback(
  targetLabel: string | null = null,
): DiscoveryRunFeedback {
  return {
    status: "started",
    detail: null,
    headline: targetLabel
      ? `The search for ${targetLabel} is still finishing. Wait for it to stop, then search again.`
      : "The last search is still finishing. Wait for it to stop, then search again.",
    recovery: null,
    targetLabel,
    toast: {
      title: "A search is still finishing",
      description: "Wait for it to stop, then search again.",
    },
  };
}

export function createDiscoveryRunRefreshIncompleteFeedback(
  targetLabel: string | null = null,
): DiscoveryRunFeedback {
  return {
    status: "succeeded",
    detail: null,
    headline: targetLabel
      ? `Search finished for ${targetLabel}, but this view could not refresh automatically.`
      : "Search finished, but this view could not refresh automatically.",
    recovery: null,
    targetLabel,
  };
}

export function createDiscoveryRunFailedFeedback(input: {
  detail: string | null;
  targetLabel?: string | null;
  targetId?: string | null;
}): DiscoveryRunFeedback {
  const detail = input.detail?.trim() || null;

  return {
    status: "failed",
    recordedAtMs: Date.now(),
    detail,
    headline: input.targetLabel
      ? `Search could not start for ${input.targetLabel}.`
      : "Search could not start.",
    recovery: detail ? getDiscoveryRunFailureRecovery(detail) : null,
    targetLabel: input.targetLabel ?? null,
    targetId: input.targetId ?? null,
  };
}

/** A source error is obsolete only after that same source succeeds later. */
export function isDiscoveryFailureSuperseded(input: {
  feedback: DiscoveryRunFeedback | null | undefined;
  targetId: string | null;
  runs: readonly DiscoveryRunRecord[];
}): boolean {
  const { feedback } = input;
  if (feedback?.status !== "failed" || feedback.recordedAtMs === undefined) {
    return false;
  }
  const recordedAtMs = feedback.recordedAtMs;
  return input.runs.some((run) => {
    if (input.targetId) {
      return (run.targetExecutions ?? []).some(
        (execution) =>
          execution.targetId === input.targetId &&
          execution.state === "completed" &&
          execution.completedAt !== null &&
          Date.parse(execution.completedAt) > recordedAtMs,
      );
    }
    // A named source without an identity cannot be cleared by another source.
    return (
      !feedback.targetLabel &&
      run.state === "completed" &&
      run.completedAt !== null &&
      Date.parse(run.completedAt) > recordedAtMs
    );
  });
}
