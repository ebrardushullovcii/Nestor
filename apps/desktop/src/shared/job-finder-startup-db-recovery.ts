import { JobFinderStartupDatabaseRecoveryFactSchema } from "@nestor/contracts";
import type { JobFinderStartupDatabaseRecoveryFact } from "@nestor/contracts";

export type {
  JobFinderStartupDatabaseRecoveryBlockedCandidate,
  JobFinderStartupDatabaseRecoveryBlockedFact,
  JobFinderStartupDatabaseRecoveryFact,
  JobFinderStartupDatabaseRecoveryIdleFact,
  JobFinderStartupDatabaseRecoveryLossWindow,
  JobFinderStartupDatabaseRecoveryOutcome,
  JobFinderStartupDatabaseRecoveryRestoredFact,
  JobFinderStartupDatabaseRecoverySnapshotKind,
} from "@nestor/contracts";

export {
  JOB_FINDER_STARTUP_DATABASE_RECOVERY_RESTORED_DETAIL,
  JOB_FINDER_STARTUP_DATABASE_RECOVERY_RESTORED_MESSAGE,
  buildJobFinderStartupDatabaseRecoveryBlockedDetail,
} from "./job-finder-startup-db-recovery-copy";

/**
 * Backward-compatible guard over the shared contract schema so renderer and
 * preload callers keep failing closed on anything the union rejects.
 */
export function isJobFinderStartupDatabaseRecoveryFact(
  value: unknown,
): value is JobFinderStartupDatabaseRecoveryFact {
  return JobFinderStartupDatabaseRecoveryFactSchema.safeParse(value).success;
}
