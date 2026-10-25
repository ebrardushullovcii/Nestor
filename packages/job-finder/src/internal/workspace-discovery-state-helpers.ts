
import type {
  BrowserSessionState,
  DiscoveryLedgerEntry,
  JobFinderDiscoveryState,
  JobSource,
} from "@nestor/contracts";

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

const ledgerEntriesById = new WeakMap<
  readonly DiscoveryLedgerEntry[],
  ReadonlyMap<string, DiscoveryLedgerEntry>
>();

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
  // The run-start ledger is the same list at every save of a run.
  let baselineById = ledgerEntriesById.get(input.baselineLedger);
  if (!baselineById) {
    baselineById = new Map(
      input.baselineLedger.map((entry) => [entry.id, entry]),
    );
    ledgerEntriesById.set(input.baselineLedger, baselineById);
  }
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
