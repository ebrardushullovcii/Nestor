import type {
  JobFinderWorkspaceDelta,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderWorkspaceSyncResult,
  WorkspaceRevision,
} from "@nestor/contracts";

type EntitySlice<T> = {
  upserts: T[];
  removedIds: string[];
};

const DELTA_OR_IGNORED_KEYS = new Set<keyof JobFinderRendererWorkspaceSnapshot>(
  [
    "generatedAt",
    "discoveryRunState",
    "fitJudgmentProgress",
    "activeDiscoveryRun",
    "discoverySessions",
    "sourceAccessPrompts",
    "latestResumeImportRun",
    "campaigns",
    "activeCampaignId",
    "campaignNotifications",
    "dashboard",
    "activityControl",
    "intelligence",
    "discoveryJobs",
    "dismissedDiscoveryJobs",
    "companyJobs",
    "recentDiscoveryRuns",
    "reviewQueue",
    "applyRuns",
    "applyJobResults",
    "applicationRecords",
    "applicationAttempts",
    "userActionRequests",
    "userActionEvents",
    "selectedDiscoveryJobId",
    "selectedReviewJobId",
    "selectedApplyRunId",
    "selectedApplicationRecordId",
  ],
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compare parsed contract values without allocating a serialized copy of the
 * entire entity. Workspace snapshots can contain hundreds of jobs and long
 * answer histories, so JSON.stringify on every entity makes a small delta
 * pay for a full payload-sized allocation repeatedly.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }

    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!sameValue(left[index], right[index])) {
        return false;
      }
    }

    return true;
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(right, key) ||
      !sameValue(left[key], right[key])
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Job rows from a view an earlier run of the app saved carry that run's
 * detail revisions, which name row identities and never match this run's.
 * The rest of the row says whether it changed; the receiver keeps its old
 * revision until the row really changes and arrives with a new one.
 */
function sameRowAcrossProcesses(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return sameValue(left, right);
  const keys = Object.keys(left).filter((key) => key !== "detailRevision");
  if (
    keys.length !==
    Object.keys(right).filter((key) => key !== "detailRevision").length
  ) {
    return false;
  }
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      sameValue(left[key], right[key]),
  );
}

function buildEntitySlice<T>(
  previous: readonly T[],
  current: readonly T[],
  getId: (value: T) => string,
  same: (left: T, right: T) => boolean = sameValue,
): EntitySlice<T> {
  const previousById = new Map<string, T>();
  for (const value of previous) {
    previousById.set(getId(value), value);
  }

  const currentIds = new Set<string>();
  const upserts: T[] = [];
  for (const value of current) {
    const id = getId(value);
    currentIds.add(id);
    const previousValue = previousById.get(id);
    if (!previousValue || !same(previousValue, value)) {
      upserts.push(value);
    }
  }

  const removedIds: string[] = [];
  for (const value of previous) {
    const id = getId(value);
    if (!currentIds.has(id)) {
      removedIds.push(id);
    }
  }

  return { upserts, removedIds };
}

/** Top-level fields outside the delta's own slots that changed. */
function changedUntrackedValues(
  previous: JobFinderRendererWorkspaceSnapshot,
  current: JobFinderRendererWorkspaceSnapshot,
): Partial<JobFinderRendererWorkspaceSnapshot> | null {
  const replaced: Record<string, unknown> = {};
  let changed = false;
  for (const key of Object.keys(current) as Array<
    keyof JobFinderRendererWorkspaceSnapshot
  >) {
    if (
      DELTA_OR_IGNORED_KEYS.has(key) ||
      sameValue(previous[key], current[key])
    ) {
      continue;
    }
    replaced[key] = current[key];
    changed = true;
  }
  return changed
    ? (replaced as Partial<JobFinderRendererWorkspaceSnapshot>)
    : null;
}

/** The value when it changed since the receiver's copy, otherwise nothing. */
function ifChanged<K extends keyof JobFinderRendererWorkspaceSnapshot>(
  previous: JobFinderRendererWorkspaceSnapshot,
  current: JobFinderRendererWorkspaceSnapshot,
  key: K,
): Partial<Pick<JobFinderRendererWorkspaceSnapshot, K>> {
  return sameValue(previous[key], current[key])
    ? {}
    : ({ [key]: current[key] } as Pick<JobFinderRendererWorkspaceSnapshot, K>);
}

/**
 * A running search's activity only grows. When the receiver holds the same
 * run, only the events after the ones it has are sent; a long search would
 * otherwise resend its whole history on every refresh.
 */
function activeRunForDelta(
  previous: JobFinderRendererWorkspaceSnapshot["activeDiscoveryRun"],
  current: JobFinderRendererWorkspaceSnapshot["activeDiscoveryRun"],
): {
  run: JobFinderRendererWorkspaceSnapshot["activeDiscoveryRun"];
  activityFrom: number | null;
} {
  if (!previous || !current || previous.id !== current.id) {
    return { run: current, activityFrom: null };
  }
  const from = previous.activity.length;
  if (
    current.activity.length < from ||
    (from > 0 &&
      current.activity[from - 1]?.id !== previous.activity[from - 1]?.id)
  ) {
    return { run: current, activityFrom: null };
  }
  return {
    run: { ...current, activity: current.activity.slice(from) },
    activityFrom: from,
  };
}

export function buildJobFinderWorkspaceDelta(input: {
  baseRevision: WorkspaceRevision;
  currentRevision: WorkspaceRevision;
  previous: JobFinderRendererWorkspaceSnapshot;
  current: JobFinderRendererWorkspaceSnapshot;
  /** The previous view was saved by an earlier run of the app. */
  previousFromEarlierProcess?: boolean;
}): JobFinderWorkspaceDelta | null {
  const sameJob = input.previousFromEarlierProcess
    ? sameRowAcrossProcesses
    : sameValue;
  const replaced = changedUntrackedValues(input.previous, input.current);
  const activeRun = activeRunForDelta(
    input.previous.activeDiscoveryRun,
    input.current.activeDiscoveryRun,
  );

  return {
    baseRevision: input.baseRevision,
    currentRevision: input.currentRevision,
    generatedAt: input.current.generatedAt,
    discoveryRunState: input.current.discoveryRunState,
    fitJudgmentProgress: input.current.fitJudgmentProgress ?? null,
    activeDiscoveryRun: activeRun.run,
    activeDiscoveryRunActivityFrom: activeRun.activityFrom,
    ...ifChanged(input.previous, input.current, "discoverySessions"),
    ...ifChanged(input.previous, input.current, "sourceAccessPrompts"),
    ...ifChanged(input.previous, input.current, "latestResumeImportRun"),
    ...ifChanged(input.previous, input.current, "campaigns"),
    activeCampaignId: input.current.activeCampaignId,
    ...ifChanged(input.previous, input.current, "campaignNotifications"),
    ...ifChanged(input.previous, input.current, "dashboard"),
    ...ifChanged(input.previous, input.current, "activityControl"),
    ...(replaced ? { replaced } : {}),
    ...(!sameValue(input.previous.intelligence, input.current.intelligence)
      ? { intelligence: input.current.intelligence }
      : {}),
    selectedDiscoveryJobId: input.current.selectedDiscoveryJobId,
    selectedReviewJobId: input.current.selectedReviewJobId,
    selectedApplyRunId: input.current.selectedApplyRunId,
    selectedApplicationRecordId: input.current.selectedApplicationRecordId,
    discoveryJobs: buildEntitySlice(
      input.previous.discoveryJobs,
      input.current.discoveryJobs,
      (value) => value.id,
      sameJob,
    ),
    dismissedDiscoveryJobs: buildEntitySlice(
      input.previous.dismissedDiscoveryJobs,
      input.current.dismissedDiscoveryJobs,
      (value) => value.id,
      sameJob,
    ),
    companyJobs: buildEntitySlice(
      input.previous.companyJobs,
      input.current.companyJobs,
      (value) => value.id,
      sameJob,
    ),
    recentDiscoveryRuns: buildEntitySlice(
      input.previous.recentDiscoveryRuns,
      input.current.recentDiscoveryRuns,
      (value) => value.id,
    ),
    reviewQueue: buildEntitySlice(
      input.previous.reviewQueue,
      input.current.reviewQueue,
      (value) => value.jobId,
    ),
    applyRuns: buildEntitySlice(
      input.previous.applyRuns,
      input.current.applyRuns,
      (value) => value.id,
    ),
    applyJobResults: buildEntitySlice(
      input.previous.applyJobResults,
      input.current.applyJobResults,
      (value) => value.id,
    ),
    applicationRecords: buildEntitySlice(
      input.previous.applicationRecords,
      input.current.applicationRecords,
      (value) => value.id,
    ),
    applicationAttempts: buildEntitySlice(
      input.previous.applicationAttempts,
      input.current.applicationAttempts,
      (value) => value.id,
    ),
    userActionRequests: buildEntitySlice(
      input.previous.userActionRequests,
      input.current.userActionRequests,
      (value) => value.id,
    ),
    userActionEvents: buildEntitySlice(
      input.previous.userActionEvents,
      input.current.userActionEvents,
      (value) => value.id,
    ),
  };
}

export function createJobFinderWorkspaceDeltaTracker() {
  let currentRevision: WorkspaceRevision = 0;
  // Mutation replies and background updates can share a renderer revision.
  // Keep a small window of shared immutable rows for those concurrent reads.
  const baselines = new Map<
    WorkspaceRevision,
    JobFinderRendererWorkspaceSnapshot
  >();
  const fromEarlierProcess = new WeakSet<JobFinderRendererWorkspaceSnapshot>();
  const remember = (snapshot: JobFinderRendererWorkspaceSnapshot) => {
    baselines.set(currentRevision, snapshot);
    while (baselines.size > 4) baselines.delete(baselines.keys().next().value!);
  };

  return {
    synchronize(
      baseRevision: WorkspaceRevision | null,
      current: JobFinderRendererWorkspaceSnapshot,
      options: { earlierProcess?: boolean } = {},
    ): JobFinderWorkspaceSyncResult {
      if (options.earlierProcess) fromEarlierProcess.add(current);
      if (baselines.size === 0 || baseRevision === null) {
        baselines.clear();
        currentRevision += 1;
        remember(current);
        return {
          kind: "snapshot",
          currentRevision,
          reason: "initial",
          snapshot: current,
        };
      }

      const baseline = baselines.get(baseRevision);
      if (!baseline) {
        const reason =
          baseRevision < currentRevision ? "stale_base" : "revision_gap";
        currentRevision += 1;
        remember(current);
        return {
          kind: "snapshot",
          currentRevision,
          reason,
          snapshot: current,
        };
      }

      const nextRevision = currentRevision + 1;
      const delta = buildJobFinderWorkspaceDelta({
        baseRevision,
        currentRevision: nextRevision,
        previous: baseline,
        current,
        previousFromEarlierProcess: fromEarlierProcess.has(baseline),
      });

      currentRevision = nextRevision;
      remember(current);

      return delta
        ? { kind: "delta", delta }
        : {
            kind: "snapshot",
            currentRevision,
            reason: "unsupported_change",
            snapshot: current,
          };
    },
  };
}
