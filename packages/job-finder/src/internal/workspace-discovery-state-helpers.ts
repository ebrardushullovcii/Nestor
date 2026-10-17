import { preserveCompletedAssessment } from "./fit-judgment-apply";
import type {
  BrowserSessionState,
  DiscoveryLedgerEntry,
  JobFinderDiscoveryState,
  JobSource,
  SavedJob,
} from "@nestor/contracts";

import { compareDiscoveryJobs } from "./matching-review-queue";

/**
 * Decision identity of a ledger entry. Metadata such as lastSeenAt changes on
 * every observation, so ownership comparisons use only the user-visible
 * decision: the latest status plus its skip reason.
 */
function getDiscoveryLedgerDecisionKey(
  entry: DiscoveryLedgerEntry | null,
): string | null {
  return entry ? `${entry.latestStatus}\u0000${entry.skipReason ?? ""}` : null;
}

/**
 * Rebases the run-owned ledger onto the latest persisted ledger.
 *
 * Ownership rules:
 * - Entries whose decision differs from the run-start baseline are run-owned
 *   deltas; they win unless the persisted ledger also changed.
 * - Decisions recorded outside the run after it started (dismissal -> skipped,
 *   application -> applied, restore -> seen) win over the run's stale echo of
 *   its start-of-run knowledge.
 * - When both sides moved, explicit user decisions ("skipped", "applied")
 *   outrank run observations; every other conflict takes the run's fresher
 *   entry.
 * - Persisted entries the run never touched, and run-discovered entries not
 *   yet persisted, pass through unchanged.
 */
export function rebaseRunLedgerOntoPersisted(input: {
  baselineLedger: readonly DiscoveryLedgerEntry[];
  workingLedger: readonly DiscoveryLedgerEntry[];
  persistedLedger: readonly DiscoveryLedgerEntry[];
}): DiscoveryLedgerEntry[] {
  const baselineById = new Map(
    input.baselineLedger.map((entry) => [entry.id, entry]),
  );
  const workingById = new Map(
    input.workingLedger.map((entry) => [entry.id, entry]),
  );
  const rebased: DiscoveryLedgerEntry[] = [];
  const consumedWorkingIds = new Set<string>();

  for (const persistedEntry of input.persistedLedger) {
    const workingEntry = workingById.get(persistedEntry.id);
    if (!workingEntry) {
      rebased.push(persistedEntry);
      continue;
    }
    consumedWorkingIds.add(persistedEntry.id);

    const baselineEntry = baselineById.get(persistedEntry.id) ?? null;
    const runChangedDecision =
      getDiscoveryLedgerDecisionKey(workingEntry) !==
      getDiscoveryLedgerDecisionKey(baselineEntry);
    const persistedChangedDecision =
      getDiscoveryLedgerDecisionKey(persistedEntry) !==
      getDiscoveryLedgerDecisionKey(baselineEntry);

    if (!persistedChangedDecision || !runChangedDecision) {
      rebased.push(persistedChangedDecision ? persistedEntry : workingEntry);
      continue;
    }

    rebased.push(
      persistedEntry.latestStatus === "skipped" ||
        persistedEntry.latestStatus === "applied"
        ? persistedEntry
        : workingEntry,
    );
  }

  for (const workingEntry of input.workingLedger) {
    if (!consumedWorkingIds.has(workingEntry.id)) {
      rebased.push(workingEntry);
    }
  }

  return rebased;
}

export function mergeSessionStates(
  currentSessions: ReadonlyArray<JobFinderDiscoveryState["sessions"][number]>,
  nextSession: JobFinderDiscoveryState["sessions"][number],
): JobFinderDiscoveryState["sessions"] {
  const nextByKind = new Map(
    currentSessions.map((session) => [session.adapterKind, session]),
  );
  nextByKind.set(nextSession.adapterKind, nextSession);
  return [...nextByKind.values()];
}

export function mergePendingJobs(
  currentJobs: readonly SavedJob[],
  nextJobs: readonly SavedJob[],
): SavedJob[] {
  const nextById = new Map(currentJobs.map((job) => [job.id, job]));
  for (const job of nextJobs) {
    const current = nextById.get(job.id);
    nextById.set(job.id, {
      ...job,
      ...(current?.planAssessments || job.planAssessments
        ? {
            planAssessments: {
              ...current?.planAssessments,
              ...job.planAssessments,
            },
          }
        : {}),
      matchAssessment: preserveCompletedAssessment(
        current?.matchAssessment,
        job.matchAssessment,
      ),
    });
  }
  return [...nextById.values()].sort(compareDiscoveryJobs);
}

export function mergeSavedJobs(
  currentJobs: readonly SavedJob[],
  nextJobs: readonly SavedJob[],
): SavedJob[] {
  const nextById = new Map(currentJobs.map((job) => [job.id, job]));
  for (const job of nextJobs) {
    const currentJob = nextById.get(job.id);
    const jobWithPersistedLocalChoices = {
      ...job,
      ...(currentJob?.planAssessments || job.planAssessments
        ? {
            planAssessments: {
              ...currentJob?.planAssessments,
              ...job.planAssessments,
            },
          }
        : {}),
      matchAssessment: preserveCompletedAssessment(
        currentJob?.matchAssessment,
        job.matchAssessment,
      ),
      resumeApplicationMode:
        currentJob?.resumeApplicationMode ?? job.resumeApplicationMode,
      resumeTailoringMode:
        currentJob?.resumeTailoringMode ?? job.resumeTailoringMode ?? null,
      latestMatchAssessmentAudit:
        job.latestMatchAssessmentAudit ??
        currentJob?.latestMatchAssessmentAudit ??
        null,
    };
    const preservesExplicitDismissal =
      currentJob?.status === "archived" &&
      currentJob.discoveryFeedback !== null &&
      job.status === "discovered";
    nextById.set(
      job.id,
      preservesExplicitDismissal
        ? {
            ...jobWithPersistedLocalChoices,
            status: "archived",
            discoveryFeedback: currentJob.discoveryFeedback,
          }
        : jobWithPersistedLocalChoices,
    );
  }
  return [...nextById.values()];
}

export function overlayTouchedSavedJobs(
  currentJobs: readonly SavedJob[],
  nextJobs: readonly SavedJob[],
  touchedIds: ReadonlySet<string>,
): SavedJob[] {
  return mergeSavedJobs(
    currentJobs.filter((job) => !touchedIds.has(job.id)),
    nextJobs.filter((job) => touchedIds.has(job.id)),
  );
}

/**
 * Overlays the run's touched pending jobs onto the latest persisted pending
 * jobs. A touched job that existed at run start but was removed from the
 * persisted state while the run was in flight (an explicit user dismissal)
 * stays removed; only run-staged jobs may (re)enter the pending list.
 */
export function overlayTouchedPendingJobs(
  currentJobs: readonly SavedJob[],
  nextJobs: readonly SavedJob[],
  touchedIds: ReadonlySet<string>,
  baselineIds?: ReadonlySet<string>,
): SavedJob[] {
  const currentIds = new Set(currentJobs.map((job) => job.id));
  return mergePendingJobs(
    currentJobs.filter((job) => !touchedIds.has(job.id)),
    nextJobs.filter(
      (job) =>
        touchedIds.has(job.id) &&
        (!baselineIds || !baselineIds.has(job.id) || currentIds.has(job.id)),
    ),
  );
}

/**
 * Projects the browser session a workspace snapshot reports.
 *
 * Before the first discovery run a workspace has no persisted adapter session.
 * That is "not started yet", never "this build has no browser": the runtime's
 * own session state is the truth when the host can hand it over, and the
 * last-resort fallback reports the `uninitialized` driver so no reader can
 * mistake a cold start for the catalog-only lane.
 */
export function createBrowserSessionSnapshot(
  sessions: ReadonlyArray<JobFinderDiscoveryState["sessions"][number]>,
  preferredAdapter: JobSource,
  runtimeSession?: BrowserSessionState | null,
) {
  const preferredSession =
    sessions.find((session) => session.adapterKind === preferredAdapter) ??
    sessions[0];

  if (preferredSession) {
    return {
      source: preferredSession.adapterKind,
      status: preferredSession.status,
      driver: preferredSession.driver,
      label: preferredSession.label,
      detail: preferredSession.detail,
      lastCheckedAt: preferredSession.lastCheckedAt,
    };
  }

  if (runtimeSession) {
    return {
      source: preferredAdapter,
      status: runtimeSession.status,
      driver: runtimeSession.driver,
      label: runtimeSession.label,
      detail: runtimeSession.detail,
      lastCheckedAt: runtimeSession.lastCheckedAt,
    };
  }

  return {
    source: preferredAdapter,
    status: "unknown" as const,
    driver: "uninitialized" as const,
    label: "Session status unavailable",
    detail: "No discovery adapter session has been initialized yet.",
    lastCheckedAt: new Date(0).toISOString(),
  };
}
