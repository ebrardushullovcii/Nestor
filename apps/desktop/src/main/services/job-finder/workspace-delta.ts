import type {
  JobFinderWorkspaceDelta,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderWorkspaceSyncResult,
  WorkspaceRevision,
} from "@nestor/contracts";
import { readRowChanges } from "@nestor/core";

type EntitySlice<T> = {
  upserts: T[];
  removedIds: string[];
};

const DELTA_OR_IGNORED_KEYS = new Set<keyof JobFinderRendererWorkspaceSnapshot>(
  [
    "generatedAt",
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
    "companyJobs",
    "reviewQueue",
    "userActionRequests",
    "userActionEvents",
    "selectedDiscoveryJobId",
    "selectedReviewJobId",
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

/**
 * Each list's rows by id. A refresh compares the list the window holds with
 * the new one; the list it holds was the new one of the refresh before, so
 * its index is kept with it instead of being built again for thousands of
 * jobs. `getId` must be the same for a given list.
 */
const rowsByIdOfList = new WeakMap<
  readonly object[],
  ReadonlyMap<string, unknown>
>();

function indexRowsById<T>(
  rows: readonly T[],
  getId: (value: T) => string,
): ReadonlyMap<string, T> {
  const cached = rowsByIdOfList.get(rows as readonly object[]);
  if (cached) return cached as ReadonlyMap<string, T>;
  const byId = new Map<string, T>();
  for (const value of rows) byId.set(getId(value), value);
  rowsByIdOfList.set(rows as readonly object[], byId);
  return byId;
}

function buildEntitySlice<T extends object>(
  previous: readonly T[],
  current: readonly T[],
  getId: (value: T) => string,
  same: (left: T, right: T) => boolean = sameValue,
): EntitySlice<T> {
  if (previous === current) return { upserts: [], removedIds: [] };
  const changes = readRowChanges(previous, current);
  if (changes) {
    const upserts: T[] = [];
    const removedIds: string[] = [];
    for (const { id, before, after } of changes) {
      if (after) {
        if (!before || !same(before, after)) upserts.push(after);
      } else if (before) removedIds.push(id);
    }
    return { upserts, removedIds };
  }
  const previousById = indexRowsById(previous, getId);
  const currentById = indexRowsById(current, getId);

  const upserts: T[] = [];
  for (const value of current) {
    const previousValue = previousById.get(getId(value));
    if (!previousValue || !same(previousValue, value)) {
      upserts.push(value);
    }
  }

  const removedIds: string[] = [];
  for (const id of previousById.keys()) {
    if (!currentById.has(id)) {
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

  return {
    baseRevision: input.baseRevision,
    currentRevision: input.currentRevision,
    generatedAt: input.current.generatedAt,
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
    discoveryJobs: buildEntitySlice(
      input.previous.discoveryJobs,
      input.current.discoveryJobs,
      (value) => value.id,
      sameJob,
    ),
    companyJobs: buildEntitySlice(
      input.previous.companyJobs,
      input.current.companyJobs,
      (value) => value.id,
      sameJob,
    ),
    reviewQueue: buildEntitySlice(
      input.previous.reviewQueue,
      input.current.reviewQueue,
      (value) => value.jobId,
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
  // The revision each window last said it shows, keyed by its WebContents.
  const heldRevisions = new WeakMap<object, WorkspaceRevision>();
  const remember = (snapshot: JobFinderRendererWorkspaceSnapshot) => {
    baselines.set(currentRevision, snapshot);
    while (baselines.size > 4) baselines.delete(baselines.keys().next().value!);
  };

  function synchronize(
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
  }

  /**
   * The answer to a change a window asked for. Sending the whole workspace
   * (about 30 MB with 6,000 jobs) cost each settings toggle or stage change
   * half a second of copying on both sides, and made the window's next
   * refresh send it all again. A delta from the revision the window holds
   * replaces both. A window holding nothing main still has gets the whole
   * view, without clearing the baselines other windows rely on.
   */
  function respond(
    holder: object | null | undefined,
    current: JobFinderRendererWorkspaceSnapshot,
  ): JobFinderWorkspaceSyncResult {
    const held = holder ? heldRevisions.get(holder) : undefined;
    if (held !== undefined && baselines.has(held)) {
      return synchronize(held, current);
    }
    currentRevision += 1;
    remember(current);
    return {
      kind: "snapshot",
      currentRevision,
      reason: "stale_base",
      snapshot: current,
    };
  }

  return {
    synchronize,
    respond,
    /** A window committed `revision`; 0 means it holds none main knows. */
    noteHeldRevision(holder: object, revision: WorkspaceRevision): void {
      if (revision === 0) heldRevisions.delete(holder);
      else heldRevisions.set(holder, revision);
    },
  };
}
