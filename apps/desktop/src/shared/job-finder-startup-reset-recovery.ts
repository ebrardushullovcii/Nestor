import { JobFinderStartupResetRecoveryFactSchema } from "@nestor/contracts";
import type { JobFinderStartupResetRecoveryFact } from "@nestor/contracts";
import type { JobFinderStartupResetRecoveryDegradedReason } from "@nestor/contracts";

export type {
  JobFinderStartupResetRecoveryCompletedFact,
  JobFinderStartupResetRecoveryDegradedFact,
  JobFinderStartupResetRecoveryDegradedReason,
  JobFinderStartupResetRecoveryFact,
  JobFinderStartupResetRecoveryIdleFact,
} from "@nestor/contracts";

export const JOB_FINDER_STARTUP_RESET_RECOVERY_COMPLETED_MESSAGE =
  "An interrupted workspace reset was completed during startup.";

export const JOB_FINDER_STARTUP_RESET_RECOVERY_COMPLETED_DETAIL =
  "The app finished a previously interrupted workspace reset while opening, so previous workspace contents were cleared.";

const jobFinderStartupResetRecoveryDegradedQuarantineMessages: Record<
  "marker_quarantined_malformed" | "marker_quarantined_oversized",
  { quarantined: string; notQuarantined: string }
> = {
  marker_quarantined_malformed: {
    quarantined:
      "An unreadable workspace reset marker was quarantined during startup, so the pending workspace reset stayed paused. No workspace files were deleted.",
    notQuarantined:
      "An unreadable workspace reset marker was found during startup but could not be moved aside, so recovery paused without changing any files.",
  },
  marker_quarantined_oversized: {
    quarantined:
      "An unexpectedly large workspace reset marker was quarantined during startup, so the pending workspace reset stayed paused. No workspace files were deleted.",
    notQuarantined:
      "An unexpectedly large workspace reset marker was found during startup but could not be moved aside, so recovery paused without changing any files.",
  },
};

const JOB_FINDER_STARTUP_RESET_RECOVERY_PENDING_TRASH_QUARANTINED_MESSAGE =
  "An unreadable workspace reset marker was quarantined during startup while set-aside reset files were still pending, so the pending workspace reset stayed paused. Those files are retained and nothing will be deleted automatically.";

const JOB_FINDER_STARTUP_RESET_RECOVERY_PENDING_TRASH_NOT_QUARANTINED_MESSAGE =
  "An unreadable workspace reset marker was found during startup but could not be moved aside while set-aside reset files were still pending, so recovery paused and every pending file stays retained. Nothing will be deleted automatically.";

const JOB_FINDER_STARTUP_RESET_RECOVERY_FAILED_MESSAGE =
  "A previously interrupted workspace reset could not be finished during startup, so recovery paused. Your workspace files are retained and nothing was deleted automatically.";

export function buildJobFinderStartupResetRecoveryDegradedDetail(input: {
  reason: JobFinderStartupResetRecoveryDegradedReason;
  quarantinedFileName: string | null;
}): string {
  const segments: string[] = [];

  if (
    input.reason === "marker_quarantined_malformed" ||
    input.reason === "marker_quarantined_oversized"
  ) {
    const messages =
      jobFinderStartupResetRecoveryDegradedQuarantineMessages[input.reason];
    segments.push(
      input.quarantinedFileName
        ? messages.quarantined
        : messages.notQuarantined,
    );
  } else if (input.reason === "marker_quarantined_with_pending_trash") {
    segments.push(
      input.quarantinedFileName
        ? JOB_FINDER_STARTUP_RESET_RECOVERY_PENDING_TRASH_QUARANTINED_MESSAGE
        : JOB_FINDER_STARTUP_RESET_RECOVERY_PENDING_TRASH_NOT_QUARANTINED_MESSAGE,
    );
  } else {
    segments.push(JOB_FINDER_STARTUP_RESET_RECOVERY_FAILED_MESSAGE);
  }

  if (input.quarantinedFileName && input.reason !== "reset_recovery_failed") {
    segments.push(
      `The marker file was kept for support diagnostics as ${input.quarantinedFileName}.`,
    );
  }

  if (
    input.reason === "marker_quarantined_with_pending_trash" ||
    input.reason === "reset_recovery_failed"
  ) {
    segments.push("Contact support before removing anything.");
  }

  return segments.join(" ");
}

/**
 * Backward-compatible guard over the shared contract schema so renderer and
 * preload callers keep failing closed on anything the union rejects.
 */
export function isJobFinderStartupResetRecoveryFact(
  value: unknown,
): value is JobFinderStartupResetRecoveryFact {
  return JobFinderStartupResetRecoveryFactSchema.safeParse(value).success;
}
