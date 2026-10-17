import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import {
  getApplicationRecordIndex,
  getDiscoverySelectionIndex,
  getLatestApplicationAttemptIndex,
  getReviewSelectionIndex,
} from "./job-finder-page-selection";

type SelectedState = string | null;

export function useApplicationSelection(initialValue: SelectedState) {
  const [value, setValue] = useState<SelectedState>(initialValue);

  useEffect(() => {
    // Restore the initial selection after hydration, then keep the current
    // application while background work updates the service suggestion.
    setValue((current) => current ?? initialValue);
  }, [initialValue]);

  return [value, setValue] as const;
}

const NO_VALID_IDS: ReadonlySet<string> = new Set();

/**
 * Bounded, versioned local UI preferences for the inspected Discovery and
 * Shortlisted jobs. The document lives under a single storage key and its
 * entries are keyed by `<surface>:<campaignId>`, so each surface within each
 * campaign keeps its own value without cross-scope leakage. Entries are
 * length-bound and structurally checked on every read; anything malformed is
 * dropped instead of breaking selection.
 */
const INSPECTED_SELECTION_STORAGE_KEY =
  "nestor.job-finder.inspected-job-selections";
const INSPECTED_SELECTION_SCHEMA_VERSION = 1;
const INSPECTED_SELECTION_MAX_ENTRIES = 32;
const INSPECTED_SELECTION_MAX_ID_LENGTH = 200;
const INSPECTED_SELECTION_MAX_KEY_LENGTH =
  INSPECTED_SELECTION_MAX_ID_LENGTH + 16;

export type InspectedSelectionSurface = "discovery" | "review";

type InspectedSelectionStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

type InspectedSelectionPrefs = {
  version: number;
  entries: Record<string, string>;
};

// One parsed document per Storage instance, shared by every selection hook
// in the page. Interleaved discovery/shortlist writes then mutate the same
// in-memory doc instead of clobbering each other's entries through dueling
// read-modify-write cycles.
const inspectedSelectionPrefsCache = new WeakMap<
  InspectedSelectionStorage,
  InspectedSelectionPrefs
>();

function isEmptyInspectedSelectionPrefs(): InspectedSelectionPrefs {
  return {
    version: INSPECTED_SELECTION_SCHEMA_VERSION,
    entries: {},
  };
}

function isKnownInspectedSelectionEntryKey(key: string): boolean {
  return (
    (key.startsWith("discovery:") || key.startsWith("review:")) &&
    key.length > "discovery:".length &&
    key.length <= INSPECTED_SELECTION_MAX_KEY_LENGTH
  );
}

function parseInspectedSelectionPrefs(
  raw: string | null,
): InspectedSelectionPrefs {
  if (raw === null) {
    return isEmptyInspectedSelectionPrefs();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt payloads fall back to an empty document; the next write
    // replaces them wholesale.
    return isEmptyInspectedSelectionPrefs();
  }

  if (typeof parsed !== "object" || parsed === null) {
    return isEmptyInspectedSelectionPrefs();
  }

  const candidate = parsed as { version?: unknown; entries?: unknown };
  if (
    candidate.version !== INSPECTED_SELECTION_SCHEMA_VERSION ||
    typeof candidate.entries !== "object" ||
    candidate.entries === null
  ) {
    return isEmptyInspectedSelectionPrefs();
  }

  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate.entries)) {
    if (!isKnownInspectedSelectionEntryKey(key)) {
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    if (value.length > INSPECTED_SELECTION_MAX_ID_LENGTH) {
      continue;
    }
    entries[key] = value;
  }

  return { version: INSPECTED_SELECTION_SCHEMA_VERSION, entries };
}

function readInspectedSelectionPrefs(
  storage: InspectedSelectionStorage,
): InspectedSelectionPrefs {
  const cached = inspectedSelectionPrefsCache.get(storage);
  if (cached) {
    return cached;
  }

  let raw: string | null = null;
  try {
    raw = storage.getItem(INSPECTED_SELECTION_STORAGE_KEY);
  } catch {
    // Unreadable storage falls back to an empty document; selection itself
    // never depends on persistence.
  }

  const prefs = parseInspectedSelectionPrefs(raw);
  inspectedSelectionPrefsCache.set(storage, prefs);
  return prefs;
}

/** Restores a previously persisted inspected job id for one surface+scope. */
export function readInspectedSelectionId(input: {
  storage: InspectedSelectionStorage;
  surface: InspectedSelectionSurface;
  campaignId: string | null;
}): string | null {
  const { storage, surface, campaignId } = input;
  if (
    campaignId === null ||
    campaignId.length === 0 ||
    campaignId.length > INSPECTED_SELECTION_MAX_ID_LENGTH
  ) {
    return null;
  }

  const entry =
    readInspectedSelectionPrefs(storage).entries[`${surface}:${campaignId}`];
  return typeof entry === "string" ? entry : null;
}

/**
 * Persists (or, with `jobId: null`, prunes) the inspected job id for one
 * surface+scope. No-op when nothing changes, the scope is unusable, or
 * storage rejects the write; selection keeps working regardless.
 */
export function writeInspectedSelectionId(input: {
  storage: InspectedSelectionStorage;
  surface: InspectedSelectionSurface;
  campaignId: string | null;
  jobId: string | null;
}): void {
  const { storage, surface, campaignId, jobId } = input;
  if (
    campaignId === null ||
    campaignId.length === 0 ||
    campaignId.length > INSPECTED_SELECTION_MAX_ID_LENGTH
  ) {
    return;
  }
  if (
    jobId !== null &&
    (jobId.length === 0 || jobId.length > INSPECTED_SELECTION_MAX_ID_LENGTH)
  ) {
    return;
  }

  const prefs = readInspectedSelectionPrefs(storage);
  const key = `${surface}:${campaignId}`;
  const nextEntries: Record<string, string> = { ...prefs.entries };

  if (jobId === null) {
    if (!(key in nextEntries)) {
      return;
    }
    delete nextEntries[key];
  } else {
    if (nextEntries[key] === jobId) {
      return;
    }
    if (
      !(key in nextEntries) &&
      Object.keys(nextEntries).length >= INSPECTED_SELECTION_MAX_ENTRIES
    ) {
      // The bound is hit only by brand-new scopes; drop the oldest inserted
      // entry so recent campaigns keep their persisted picks.
      const evicted = Object.keys(nextEntries).find(
        (candidate) => candidate !== key,
      );
      if (evicted === undefined) {
        return;
      }
      delete nextEntries[evicted];
    }
    nextEntries[key] = jobId;
  }

  const nextPrefs: InspectedSelectionPrefs = {
    version: INSPECTED_SELECTION_SCHEMA_VERSION,
    entries: nextEntries,
  };
  try {
    storage.setItem(INSPECTED_SELECTION_STORAGE_KEY, JSON.stringify(nextPrefs));
  } catch {
    // Quota or serialization failure: keep the pick in memory only.
    return;
  }
  inspectedSelectionPrefsCache.set(storage, nextPrefs);
}

type RetainedSelectionOrigin = "user" | "system";

type RetainedSelectionState = {
  campaignId: string | null;
  value: SelectedState;
  origin: RetainedSelectionOrigin;
};

function resolveRetainedSelection(
  input: Parameters<typeof useRetainedSelection>[0],
  retained: RetainedSelectionState,
  validIdSet: ReadonlySet<string>,
): RetainedSelectionState {
  const { snapshotValue, validIds, activeCampaignId, persistedSelection } =
    input;
  const canValidate =
    persistedSelection !== undefined &&
    persistedSelection.collectionReady &&
    validIds != null;
  const isValidId = (id: string) => validIdSet.has(id);

  if (retained.campaignId === activeCampaignId) {
    // A healthy hold wins over every default, whatever produced it.
    if (retained.value !== null && isValidId(retained.value)) {
      return retained;
    }

    if (persistedSelection === undefined) {
      return {
        campaignId: activeCampaignId,
        value: snapshotValue,
        origin: "system",
      };
    }

    // Before the scoped collection is loaded (bootstrap, retry), neither a
    // restore nor a prune decision has evidence; suspend with what is held.
    if (!canValidate) {
      return retained;
    }

    if (retained.value === null) {
      // Nothing user-owned is held yet for this scope: try the persisted
      // pick once before falling back to the snapshot default.
      const restored = readInspectedSelectionId({
        storage: persistedSelection.storage,
        surface: persistedSelection.surface,
        campaignId: activeCampaignId,
      });
      if (restored !== null && isValidId(restored)) {
        return {
          campaignId: activeCampaignId,
          value: restored,
          origin: "system",
        };
      }
    }

    return {
      campaignId: activeCampaignId,
      value: snapshotValue,
      origin: "system",
    };
  }

  // Scope switch. Resolve against the NEW scope in the same render so the
  // previous campaign's pick never flashes under the new scope.
  if (
    persistedSelection === undefined ||
    activeCampaignId === null ||
    !canValidate
  ) {
    return {
      campaignId: activeCampaignId,
      value: persistedSelection === undefined ? snapshotValue : null,
      origin: "system",
    };
  }

  const restored = readInspectedSelectionId({
    storage: persistedSelection.storage,
    surface: persistedSelection.surface,
    campaignId: activeCampaignId,
  });
  if (restored !== null && isValidId(restored)) {
    return { campaignId: activeCampaignId, value: restored, origin: "system" };
  }

  return {
    campaignId: activeCampaignId,
    value: snapshotValue,
    origin: "system",
  };
}

/**
 * Selection that survives background workspace refreshes. Workspace
 * snapshots derive their selection ids as collection defaults (the first
 * row), so adopting a fresh snapshot verbatim would yank the operator off
 * the job they are inspecting whenever a refresh reorders results.
 *
 * Instead, the locally selected id is kept while it still exists in the
 * current collection and the active campaign scope is unchanged. The
 * snapshot value is adopted only when nothing valid is held locally:
 * initial load, removal of the selected item, or a campaign switch (which
 * must never retain a job outside the new campaign's scope). Explicit
 * navigation through the setter always wins over any default.
 *
 * When `persistedSelection` is provided, the user-picked id additionally
 * survives restarts: it is written per surface+campaign into bounded
 * versioned local preferences, restored only if it exists in the hydrated
 * scoped collection, and pruned/self-healed whenever it goes stale. Snapshot
 * defaults themselves are never persisted, so background refreshes cause no
 * writes at all.
 */
export function useRetainedSelection(input: {
  snapshotValue: SelectedState;
  validIds: readonly string[] | ReadonlySet<string> | null | undefined;
  activeCampaignId: string | null;
  persistedSelection?: {
    storage: InspectedSelectionStorage;
    surface: InspectedSelectionSurface;
    collectionReady: boolean;
  };
}): [SelectedState, Dispatch<SetStateAction<SelectedState>>] {
  // `snapshotValue` is consumed inside resolveRetainedSelection via `input`.
  const { validIds, activeCampaignId, persistedSelection } = input;
  const validIdSet = useMemo(
    () =>
      validIds == null
        ? NO_VALID_IDS
        : "has" in validIds
          ? validIds
          : new Set(validIds),
    [validIds],
  );
  const storage = persistedSelection?.storage;
  const surface = persistedSelection?.surface;
  const collectionReady = persistedSelection?.collectionReady;
  const [retained, setRetained] = useState<RetainedSelectionState>(() => ({
    campaignId: activeCampaignId,
    value: null,
    origin: "system",
  }));

  // Render-phase resolution keeps the committed value truthful for the
  // current scope in a single pass: restores, removals, and campaign swaps
  // settle here instead of flashing an intermediate default first. The
  // resolver is deterministic for given inputs, so the adjustment converges
  // immediately without looping.
  const resolved = resolveRetainedSelection(input, retained, validIdSet);
  if (
    resolved.campaignId !== retained.campaignId ||
    resolved.value !== retained.value ||
    resolved.origin !== retained.origin
  ) {
    setRetained(resolved);
  }

  useEffect(() => {
    if (!storage || !surface || activeCampaignId === null) {
      return;
    }
    if (!collectionReady || validIds == null) {
      return;
    }
    if (retained.campaignId !== activeCampaignId) {
      return;
    }

    const stored = readInspectedSelectionId({
      storage,
      surface,
      campaignId: activeCampaignId,
    });
    let desiredEntry: string | null;
    if (retained.origin === "user" && retained.value !== null) {
      desiredEntry = retained.value;
    } else if (
      retained.value !== null &&
      stored === retained.value &&
      validIdSet.has(retained.value)
    ) {
      // A system-restored pick that is still live stays persisted.
      desiredEntry = stored;
    } else {
      // Defaults are never persisted; stale or dead entries self-heal away.
      desiredEntry = null;
    }

    writeInspectedSelectionId({
      storage,
      surface,
      campaignId: activeCampaignId,
      jobId: desiredEntry,
    });
  }, [
    activeCampaignId,
    collectionReady,
    retained,
    storage,
    surface,
    validIds,
    validIdSet,
  ]);

  const select = useCallback<Dispatch<SetStateAction<SelectedState>>>(
    (next) => {
      setRetained((current) => {
        const resolvedValue =
          typeof next === "function" ? next(current.value) : next;

        return current.campaignId === activeCampaignId &&
          current.value === resolvedValue
          ? current
          : {
              campaignId: activeCampaignId,
              value: resolvedValue,
              origin: "user",
            };
      });
    },
    [activeCampaignId],
  );

  return [retained.value, select] as const;
}

export { getResumeWorkspaceJobIdFromPathname as getActiveResumeWorkspaceJobId } from "@renderer/features/job-finder/lib/resume-workspace-route";

export function isProfileSetupPath(pathname: string): boolean {
  return pathname === "/job-finder/profile/setup";
}

export function getLatestApplicationAttempt(
  workspace: {
    applicationRecords: Readonly<
      JobFinderRendererWorkspaceSnapshot["applicationRecords"]
    >;
    applicationAttempts: Readonly<
      JobFinderRendererWorkspaceSnapshot["applicationAttempts"]
    >;
  },
  selectedApplicationRecordId: string | null,
) {
  const selectedApplicationRecord = selectedApplicationRecordId
    ? (getApplicationRecordIndex(workspace.applicationRecords).get(
        selectedApplicationRecordId,
      ) ?? null)
    : (workspace.applicationRecords[0] ?? null);

  const selectedApplicationAttempt = selectedApplicationRecord
    ? (getLatestApplicationAttemptIndex(workspace.applicationAttempts).get(
        selectedApplicationRecord.id,
      ) ?? null)
    : null;

  return {
    selectedApplicationAttempt,
    selectedApplicationRecord,
  };
}

export function getJobFinderWorkspaceSelection(
  workspace: {
    discoveryJobs: readonly JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number][];
    reviewQueue: readonly JobFinderRendererWorkspaceSnapshot["reviewQueue"][number][];
  },
  selectedDiscoveryJobId: string | null,
  selectedReviewJobId: string | null,
) {
  const { jobsById } = getDiscoverySelectionIndex(workspace.discoveryJobs);
  const selectedDiscoveryJob =
    (selectedDiscoveryJobId
      ? (jobsById.get(selectedDiscoveryJobId) ?? null)
      : null) ??
    workspace.discoveryJobs[0] ??
    null;
  const selectedReviewItem =
    (selectedReviewJobId
      ? getReviewSelectionIndex(workspace.reviewQueue).itemsByJobId.get(
          selectedReviewJobId,
        )
      : null) ??
    workspace.reviewQueue[0] ??
    null;
  const selectedReviewJob =
    (selectedReviewItem
      ? (jobsById.get(selectedReviewItem.jobId) ?? null)
      : null) ?? selectedDiscoveryJob;

  return {
    selectedDiscoveryJob,
    selectedReviewItem,
    selectedReviewJob,
  };
}
