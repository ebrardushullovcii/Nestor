import {
  DiscoveryRunRecordSchema,
  DiscoveryRunReportSchema,
  DiscoveryTimingSummarySchema,
  DISCOVERY_RUN_JOB_BUDGET_MAX,
  browserRunWaitReasonValues,
  discoveryActivityStageValues,
  type DiscoveryActivityEvent,
  type DiscoveryRunRecord,
  type DiscoveryRunReport,
  type DiscoveryTargetExecution,
} from "@nordri/contracts";

import {
  appendDiscoveryEvent,
  countCompletedTargetExecutions,
  createDiscoveryEvent,
  updateTargetExecution,
} from "./discovery-state";
import {
  calculateDurationMs,
  computeTimelineSummary,
  serializeOrderedDurationEntries,
} from "./performance-timing";
import {
  DEFAULT_TARGET_JOB_COUNT,
  SCALED_DISCOVERY_MAX_STEPS,
} from "./workspace-defaults";

function calculateFirstMilestoneMs(
  events: readonly DiscoveryActivityEvent[],
  startedAt: string,
  completedAt: string,
  predicate: (event: DiscoveryActivityEvent) => boolean,
): number | null {
  return computeTimelineSummary({
    startedAt,
    completedAt,
    events: events.filter(predicate).map((event) => ({
      timestamp: event.timestamp,
      key: "milestone" as const,
    })),
  }).firstEventMs;
}

function isCandidateMilestone(event: DiscoveryActivityEvent): boolean {
  return event.targetId !== null && (event.jobsFound ?? 0) > 0;
}

function isDistinctUsefulJobMilestone(event: DiscoveryActivityEvent): boolean {
  return (
    event.targetId !== null &&
    event.stage === "persistence" &&
    (event.jobsPersisted ?? 0) + (event.jobsStaged ?? 0) > 0
  );
}

function buildDiscoveryTimingSummary(
  events: readonly DiscoveryActivityEvent[],
  startedAt: string,
  completedAt: string,
) {
  const stageTimeline = computeTimelineSummary({
    startedAt,
    completedAt,
    events: events.map((event) => ({
      timestamp: event.timestamp,
      key: event.stage,
    })),
  });
  const waitReasonTimeline = computeTimelineSummary({
    startedAt,
    completedAt,
    events: events
      .filter(
        (
          event,
        ): event is DiscoveryActivityEvent & {
          waitReason: NonNullable<DiscoveryActivityEvent["waitReason"]>;
        } => event.waitReason !== null,
      )
      .map((event) => ({
        timestamp: event.timestamp,
        key: event.waitReason,
      })),
  });

  return DiscoveryTimingSummarySchema.parse({
    totalDurationMs: stageTimeline.totalDurationMs,
    firstActivityMs: stageTimeline.firstEventMs,
    firstCandidateMs: calculateFirstMilestoneMs(
      events,
      startedAt,
      completedAt,
      isCandidateMilestone,
    ),
    firstDistinctUsefulJobMs: calculateFirstMilestoneMs(
      events,
      startedAt,
      completedAt,
      isDistinctUsefulJobMilestone,
    ),
    longestGapMs: stageTimeline.longestGapMs,
    eventCount: events.length,
    stageDurations: serializeOrderedDurationEntries(
      stageTimeline.durationsMsByKey,
      discoveryActivityStageValues,
      (stage, durationMs) => ({
        stage,
        durationMs,
      }),
    ),
    waitReasonDurations: serializeOrderedDurationEntries(
      waitReasonTimeline.durationsMsByKey,
      browserRunWaitReasonValues,
      (waitReason, durationMs) => ({
        waitReason,
        durationMs,
      }),
    ),
  });
}

function summarizeTargetExecutions(
  targetExecutions: readonly DiscoveryTargetExecution[],
) {
  const changeDigest = targetExecutions.reduce(
    (total, execution) => ({
      new: total.new + execution.changeDigest.new,
      unchanged: total.unchanged + execution.changeDigest.unchanged,
      changed: total.changed + execution.changeDigest.changed,
      reactivated: total.reactivated + execution.changeDigest.reactivated,
      inactive: total.inactive + execution.changeDigest.inactive,
      known: total.known + execution.changeDigest.known,
      skipped: total.skipped + execution.changeDigest.skipped,
    }),
    {
      new: 0,
      unchanged: 0,
      changed: 0,
      reactivated: 0,
      inactive: 0,
      known: 0,
      skipped: 0,
    },
  );
  const sourceHealth = targetExecutions.map((execution) => {
    // A source whose listing was empty is marked "warning" so Home can say,
    // neutrally, that it found nothing. Listings it skipped because they are
    // already saved count as found: a quiet re-run did find them.
    const health =
      execution.state === "completed"
        ? execution.jobsFound +
            execution.duplicatesMerged +
            execution.jobsSkippedByLedger ===
          0
          ? "warning"
          : "healthy"
        : execution.state === "failed"
          ? "failed"
          : execution.state === "cancelled"
            ? "cancelled"
            : execution.state === "skipped"
              ? "skipped"
              : "pending";

    return {
      targetId: execution.targetId,
      health,
      durationMs: execution.timing?.totalDurationMs ?? 0,
      warnings: execution.warning ? [execution.warning] : [],
    };
  });
  const warnings = sourceHealth.flatMap((source) => source.warnings);

  return { changeDigest, sourceHealth, warnings };
}

export function completeTargetExecution(
  run: DiscoveryRunRecord,
  targetId: string,
  completedAt: string,
  patch: Partial<DiscoveryTargetExecution>,
): DiscoveryRunRecord {
  const nextRun = updateTargetExecution(run, targetId, (entry) => ({
    ...entry,
    ...patch,
    completedAt,
    timing:
      entry.startedAt === null
        ? null
        : buildDiscoveryTimingSummary(
            run.activity.filter((event) => event.targetId === entry.targetId),
            entry.startedAt,
            completedAt,
          ),
  }));

  const executionSummary = summarizeTargetExecutions(nextRun.targetExecutions);

  return DiscoveryRunRecordSchema.parse({
    ...nextRun,
    summary: {
      ...nextRun.summary,
      ...executionSummary,
      targetsCompleted: countCompletedTargetExecutions(nextRun),
    },
  });
}

export function finalizeRunningTargetExecutions(
  run: DiscoveryRunRecord,
  state: "cancelled" | "failed",
  completedAt: string,
): DiscoveryRunRecord {
  let nextRun = run;

  for (const targetExecution of run.targetExecutions) {
    if (targetExecution.state !== "running") {
      continue;
    }

    nextRun = completeTargetExecution(
      nextRun,
      targetExecution.targetId,
      completedAt,
      {
        state,
        warning:
          state === "cancelled"
            ? "Discovery was cancelled before this target finished."
            : targetExecution.warning,
      },
    );
  }

  return nextRun;
}

/**
 * Freezes the run's own accounting the moment the pipeline stops.
 *
 * Everything here comes from the run's own execution ledger, never from
 * current workspace inventory, so reloading the app or pruning jobs later
 * cannot change what this run reports. Retention is decided by the search
 * plan, so `retained`/`worthOpening` stay null for a plan-owned run until
 * its terminal commit fills them in; a run with no plan retains everything
 * it saved and says so here.
 */
export function buildDiscoveryRunReport(
  run: DiscoveryRunRecord,
  measuredAt: string,
): DiscoveryRunReport {
  const reviewed = run.targetExecutions.reduce(
    (total, execution) => total + execution.jobsReviewed,
    0,
  );
  const saved = run.summary.jobsPersisted + run.summary.jobsStaged;
  const duplicates = run.summary.duplicatesMerged;
  // Legacy and checkpoint-only executions can report no reviewed volume at
  // all. Claiming fewer listings reviewed than the run demonstrably merged
  // would be its own contradiction, so the merged population is the floor.
  // Listings skipped because an unchanged earlier search already kept them
  // were found too: leaving them out made a quiet re-run read "0 found ·
  // 10 already here" beside a source list saying 10 were found.
  const skippedAsSaved = run.targetExecutions.reduce(
    (total, execution) => total + execution.jobsSkippedByLedger,
    0,
  );
  const unique = Math.max(
    new Set(
      run.targetExecutions.flatMap((execution) => execution.encounteredJobIds),
    ).size,
    run.summary.validJobsFound,
  );
  const found = Math.max(
    unique,
    Math.max(reviewed, run.summary.validJobsFound + duplicates) +
      Math.max(skippedAsSaved, run.summary.jobsSkippedByLedger),
  );

  const counted =
    run.targetExecutions.length > 0 &&
    run.targetExecutions.every((source) => source.jobsInspected !== undefined);
  const inspected = run.targetExecutions.reduce(
    (sum, source) => sum + (source.jobsInspected ?? 0),
    0,
  );
  return DiscoveryRunReportSchema.parse({
    sources: run.targetExecutions.map((source) => ({
      targetId: source.targetId,
      inspected: source.jobsInspected ?? null,
      saved: source.jobsPersisted + source.jobsStaged,
      rejected:
        source.jobsInspected !== undefined
          ? (source.rejectedListings?.length ?? 0) + source.invalidSkipped
          : null,
      duplicates: source.duplicatesMerged + source.jobsSkippedByLedger,
      deferred: source.listingsDeferred ?? null,
      pagesCovered: source.pagesCovered ?? null,
    })),
    ...(counted
      ? {
          rejected: run.targetExecutions.reduce(
            (sum, source) =>
              sum +
              (source.rejectedListings?.length ?? 0) +
              source.invalidSkipped,
            0,
          ),
          deferred: run.targetExecutions.reduce(
            (sum, source) => sum + (source.listingsDeferred ?? 0),
            0,
          ),
          pagesCovered: run.targetExecutions.every(
            (source) => source.pagesCovered !== undefined,
          )
            ? run.targetExecutions.reduce(
                (sum, source) => sum + (source.pagesCovered ?? 0),
                0,
              )
            : null,
        }
      : {}),
    version: 2,
    measuredAt,
    found: counted ? inspected : found,
    unique:
      counted &&
      run.targetExecutions.some(
        (source) => source.uniqueInspectionsKnown === false,
      )
        ? null
        : counted &&
            run.targetExecutions.every(
              (source) => source.inspectedJobIds !== undefined,
            )
          ? new Set(
              run.targetExecutions.flatMap(
                (source) => source.inspectedJobIds ?? [],
              ),
            ).size
          : unique,
    new: run.summary.validJobsFound,
    saved,
    retained: run.campaignId === null ? saved : null,
    worthOpening: null,
    duplicates: counted
      ? run.targetExecutions.reduce(
          (sum, source) =>
            sum + source.duplicatesMerged + source.jobsSkippedByLedger,
          0,
        )
      : duplicates,
  });
}

/**
 * Completes a frozen report with the retention facts only the search plan's
 * terminal commit knows. Nothing else in the report is recomputed: the run's
 * own reviewed/new/saved counts stay exactly as the pipeline froze them.
 */
export function applyDiscoveryRunRetentionCounts(
  run: DiscoveryRunRecord,
  counts: {
    measuredAt: string;
    alreadyHere?: number;
    retained: number;
    worthOpening: number;
  },
): DiscoveryRunRecord {
  const report =
    run.summary.report ?? buildDiscoveryRunReport(run, counts.measuredAt);

  return DiscoveryRunRecordSchema.parse({
    ...run,
    summary: {
      ...run.summary,
      report: DiscoveryRunReportSchema.parse({
        ...report,
        alreadyHere: counts.alreadyHere ?? report.alreadyHere,
        retained: counts.retained,
        worthOpening: counts.worthOpening,
      }),
    },
  });
}

export function finalizeDiscoveryRun(
  run: DiscoveryRunRecord,
  state: "completed" | "cancelled" | "failed",
  completedAt: string,
): DiscoveryRunRecord {
  return DiscoveryRunRecordSchema.parse({
    ...run,
    state,
    completedAt,
    summary: {
      ...run.summary,
      durationMs: calculateDurationMs(run.startedAt, completedAt),
      outcome: state,
      timing: buildDiscoveryTimingSummary(
        run.activity,
        run.startedAt,
        completedAt,
      ),
      report: buildDiscoveryRunReport(run, completedAt),
    },
  });
}

export function recoverInterruptedDiscoveryRun(
  run: DiscoveryRunRecord,
  completedAt: string,
): DiscoveryRunRecord {
  // Recovery receives borrowed frozen canonical rows. Own the two mutable
  // accumulator containers while sharing checkpoint bodies and untouched rows.
  let recoveredRun = {
    ...run,
    targetExecutions: [...run.targetExecutions],
    activity: [...run.activity],
  };

  for (const targetExecution of run.targetExecutions) {
    if (targetExecution.state !== "running") {
      continue;
    }

    recoveredRun = completeTargetExecution(
      recoveredRun,
      targetExecution.targetId,
      completedAt,
      {
        state: "failed",
        warning:
          "Discovery was interrupted because the app closed before this source finished.",
      },
    );
  }

  recoveredRun = appendDiscoveryEvent(
    recoveredRun,
    createDiscoveryEvent({
      runId: recoveredRun.id,
      timestamp: completedAt,
      kind: "error",
      stage: "run",
      targetId: null,
      adapterKind: null,
      terminalState: "failed",
      message:
        "The previous discovery run was interrupted when the app closed. Jobs saved before the interruption remain available; start a new search to continue.",
      url: null,
      jobsFound: recoveredRun.summary.validJobsFound,
      jobsPersisted: recoveredRun.summary.jobsPersisted,
      jobsStaged: recoveredRun.summary.jobsStaged,
      duplicatesMerged: recoveredRun.summary.duplicatesMerged,
      invalidSkipped: recoveredRun.summary.invalidSkipped,
    }),
  );

  return DiscoveryRunRecordSchema.parse({
    ...finalizeDiscoveryRun(recoveredRun, "failed", completedAt),
    runPhase: "interrupted",
  });
}

/**
 * Resolves the per-target discovery budgets for a whole run up front.
 *
 * Allocation is positional over the stable, configuration-derived target
 * order: every non-final target takes the floor fair share of the remaining
 * total and the final target absorbs the exact non-negative remainder, so the
 * plan sums to exactly the configured budget whenever the budget can fund
 * every target. When the remaining budget cannot fund every remaining target,
 * scarce single-job shares are granted to the leading (highest-priority)
 * positions forward; trailing lowest-priority positions receive zero and are
 * skipped by the runner. Because the plan is fixed
 * before any network work, the per-target budgets are identical regardless of
 * readiness or completion order. Duplicate or empty target ids fail fast here,
 * before any discovery work starts; every unique id receives exactly one plan
 * entry. `resolveDiscoveryTargetBudget` supplies every per-position invariant
 * (caps, floors, step ceilings).
 */
export interface DiscoveryTargetBudget {
  /** Collection planning hint; an uncapped run does not stop at this count. */
  targetJobCount: number;
  /** Retention share, enforced only when the person specified a run budget. */
  retentionJobCount: number;
  maxSteps: number;
}

export function resolveDiscoveryBudgetPlan(input: {
  targetIds: readonly string[];
  runJobBudget?: number | null;
}): ReadonlyMap<string, DiscoveryTargetBudget> {
  const plan = new Map<string, DiscoveryTargetBudget>();
  let plannedJobsFoundSoFar = 0;

  for (let index = 0; index < input.targetIds.length; index += 1) {
    const targetId = input.targetIds[index];
    if (!targetId) {
      throw new Error(
        `Discovery budget plan requires a non-empty target id at position ${index}.`,
      );
    }
    if (plan.has(targetId)) {
      throw new Error(
        `Duplicate discovery target id "${targetId}" at position ${index}; each enabled source must have a unique id.`,
      );
    }

    const allocation = resolveDiscoveryTargetBudget({
      targetsRemaining: input.targetIds.length - index,
      validJobsFoundSoFar: plannedJobsFoundSoFar,
      ...(input.runJobBudget != null
        ? { runJobBudget: input.runJobBudget }
        : {}),
    });
    const budget: DiscoveryTargetBudget = {
      ...allocation,
      // Even when this source has no remaining save allocation, give the
      // agent a one-job sampling target so selected sources are attempted.
      targetJobCount: Math.max(1, allocation.targetJobCount),
      retentionJobCount: allocation.targetJobCount,
    };
    plan.set(targetId, budget);
    plannedJobsFoundSoFar += budget.retentionJobCount;
  }

  return plan;
}

const SINGLE_TARGET_DISCOVERY_JOB_COUNT = 50;
/**
 * Safety ceiling on agent steps for one source in an interactive search. It
 * is not a budget: the agent decides when a site is done or says it is
 * stuck, and a stall (nothing new after repeated tries, even after being
 * asked to change approach) ends the source. Scaled runs keep their own
 * ceiling because total cost across many sources must stay bounded.
 */
const DISCOVERY_TARGET_STEP_CEILING = 120;

/**
 * Resolves the per-target discovery budget for one position in a run.
 *
 * A configured `runJobBudget` is an explicit result cap. Its shares sum to
 * the requested total, with scarce slots assigned in source-priority order.
 * Each source still receives a nonzero sampling opportunity from the planner.
 *
 * With no configured cap, the legacy 100-job total / 50-job single-source
 * figures are collection planning hints only. The pipeline retains every
 * eligible listing collected and tells the agent there is no numeric cap.
 * Default and explicitly scaled runs retain their separate safety ceilings.
 */
export function resolveDiscoveryTargetBudget(input: {
  targetsRemaining: number;
  validJobsFoundSoFar: number;
  runJobBudget?: number | null;
}) {
  if (input.targetsRemaining <= 0) {
    throw new Error(
      "resolveDiscoveryTargetBudget requires at least one remaining target.",
    );
  }

  const rawRunJobBudget = input.runJobBudget;
  const scaled = typeof rawRunJobBudget === "number" && rawRunJobBudget > 0;
  const totalJobBudget = scaled
    ? Math.min(
        DISCOVERY_RUN_JOB_BUDGET_MAX,
        Math.max(1, Math.trunc(rawRunJobBudget)),
      )
    : DEFAULT_TARGET_JOB_COUNT;
  const remainingJobs = Math.max(0, totalJobBudget - input.validJobsFoundSoFar);
  const maxStepsCeiling = scaled
    ? SCALED_DISCOVERY_MAX_STEPS
    : DISCOVERY_TARGET_STEP_CEILING;

  if (input.targetsRemaining <= 1) {
    const targetJobCount = Math.min(
      scaled ? totalJobBudget : SINGLE_TARGET_DISCOVERY_JOB_COUNT,
      remainingJobs,
    );

    return { targetJobCount, maxSteps: maxStepsCeiling };
  }

  // Scarce-budget guard: when the remaining total cannot fund every remaining
  // target with at least one job each, grant one-job units from this
  // (highest-priority remaining) position forward instead of letting the
  // proportional/fair-share math below push the whole budget onto the
  // trailing lowest-priority target.
  if (remainingJobs < input.targetsRemaining) {
    const targetJobCount = Math.min(1, remainingJobs);

    return { targetJobCount, maxSteps: maxStepsCeiling };
  }

  const targetJobCount = scaled
    ? Math.floor(remainingJobs / input.targetsRemaining)
    : Math.min(
        DEFAULT_TARGET_JOB_COUNT,
        Math.ceil(remainingJobs / Math.max(1, input.targetsRemaining)),
      );

  return { targetJobCount, maxSteps: maxStepsCeiling };
}
