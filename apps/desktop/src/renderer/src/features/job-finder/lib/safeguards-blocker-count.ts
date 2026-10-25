import type {
  JobFinderIntelligenceSafeguards,
  ListingSignalRecord,
} from "@nestor/contracts";

/**
 * Client-side mirror of the deterministic safeguard gate used for badges and
 * the task center. The renderer cannot import the job-finder package, so this
 * counts active (non-dismissed) blockers with the same semantics: only the
 * latest signal per job counts, contradictions stay advisory and do not count
 * as blockers, and dismissals suppress entries. Counts are presentation-only;
 * the authoritative gate lives in the workspace service.
 */
export function countActiveSafeguardBlockers(
  safeguards: JobFinderIntelligenceSafeguards,
): number {
  const dismissals = new Set(
    safeguards.safeguardDismissals.map(
      (dismissal) => `${dismissal.kind}\u0000${dismissal.referenceId}`,
    ),
  );
  const dismissed = (kind: string, id: string) =>
    dismissals.has(`${kind}\u0000${id}`);

  let count = 0;

  for (const cap of safeguards.companyApplicationCaps) {
    if (cap.limitReached && !dismissed("company_cap_limit", cap.id)) {
      count += 1;
    }
  }

  for (const conflict of safeguards.simultaneousApplicationConflicts) {
    if (
      conflict.status === "detected" &&
      !dismissed("simultaneous_application_conflict", conflict.id) &&
      sameCompanyConflictStillHolds(conflict)
    ) {
      count += 1;
    }
  }

  const latestSignalByJob = new Map<string, ListingSignalRecord>();
  for (const signal of safeguards.listingSignals) {
    const current = latestSignalByJob.get(signal.jobId);
    if (
      !current ||
      signal.detectedAt > current.detectedAt ||
      (signal.detectedAt === current.detectedAt && signal.id > current.id)
    ) {
      latestSignalByJob.set(signal.jobId, signal);
    }
  }
  for (const signal of latestSignalByJob.values()) {
    if (!dismissed("listing_signal", signal.id)) {
      count += 1;
    }
  }

  for (const pause of safeguards.abnormalFailurePauses) {
    if (pause.paused && !dismissed("abnormal_failure_pause", pause.id)) {
      count += 1;
    }
  }

  return count;
}

/**
 * A company's conflict (one record per company) holds work only while some
 * pair of its jobs has not been allowed: the service checks each send against
 * the allowed pairs and lets an allowed pair through. "Send both anyway" left
 * the hold notice up after both applications were sent (STAB-006). An older
 * per-record conflict has no pairs and holds until it is resolved.
 */
export function sameCompanyConflictStillHolds(
  conflict: JobFinderIntelligenceSafeguards["simultaneousApplicationConflicts"][number],
): boolean {
  const jobIds = conflict.jobIds ?? [];
  if (!conflict.companyKey || jobIds.length < 2) return true;
  const allowed = new Set(
    (conflict.allowedPairs ?? [])
      .filter((pair) => pair.revokedAt === null)
      .map((pair) => [...pair.jobIds].sort().join("\u0000")),
  );
  for (let left = 0; left < jobIds.length; left += 1)
    for (let right = left + 1; right < jobIds.length; right += 1)
      if (!allowed.has([jobIds[left]!, jobIds[right]!].sort().join("\u0000")))
        return true;
  return false;
}
