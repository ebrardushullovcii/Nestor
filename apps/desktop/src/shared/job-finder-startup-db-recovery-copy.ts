import type { JobFinderStartupDatabaseRecoveryOutcome } from "@nestor/contracts";

// The recovery copy alone, without the schema that checks a recovery fact, so
// the first screen can show it without building that schema.

export const JOB_FINDER_STARTUP_DATABASE_RECOVERY_RESTORED_MESSAGE =
  "Your workspace database was recovered from an automatic snapshot.";

export const JOB_FINDER_STARTUP_DATABASE_RECOVERY_RESTORED_DETAIL =
  "Only the saved workspace database was recovered. Changes made after the last snapshot may be missing, and generated documents, candidate assets, and browser sign-in data are not part of database snapshots.";

const JOB_FINDER_STARTUP_DATABASE_RECOVERY_BLOCKED_MESSAGES: Record<
  JobFinderStartupDatabaseRecoveryOutcome,
  string
> = {
  "no-valid-candidate":
    "The saved workspace database is damaged and none of its automatic snapshots could be validated.",
  "quarantine-incomplete":
    "The damaged workspace database could not be fully set aside, so automatic recovery stopped to keep every file unchanged.",
  "restore-revalidation-rejected":
    "A workspace snapshot was found but it did not pass the final safety check, so nothing was changed.",
  "restore-promotion-failed":
    "A workspace snapshot passed its safety check but could not be put back into place, so automatic recovery stopped.",
  "salvage-required":
    "The saved workspace database needs manual review before Job Finder can open safely.",
};

const JOB_FINDER_STARTUP_DATABASE_RECOVERY_BLOCKED_GUIDANCE =
  "Your workspace files were retained and nothing was deleted or replaced automatically. Export diagnostics if that option is available and contact support for manual recovery options.";

export function buildJobFinderStartupDatabaseRecoveryBlockedDetail(input: {
  outcome: JobFinderStartupDatabaseRecoveryOutcome;
  incidentId: string;
}): string {
  return [
    JOB_FINDER_STARTUP_DATABASE_RECOVERY_BLOCKED_MESSAGES[input.outcome],
    JOB_FINDER_STARTUP_DATABASE_RECOVERY_BLOCKED_GUIDANCE,
    `Incident ID: ${input.incidentId}`,
  ].join(" ");
}
