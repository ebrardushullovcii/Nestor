import {
  CandidateProfileSchema,
  RESUME_IMPORT_INTERRUPTED_MESSAGE,
  ResumeImportModelRoleStateSchema,
  ResumeImportRunSchema,
  type CandidateProfile,
  type ResumeImportRun,
} from "@nestor/contracts";

const deferredVisionWarningPattern =
  /^Visual scan is still running(?: after text import completed;|\.)/;

export const interruptedVisionMessage =
  "Visual scan stopped when the app closed. Your text import is ready; choose Refresh from resume to retry the visual scan.";

export function recoverInterruptedDeferredVisionRun(input: {
  run: ResumeImportRun;
  isActiveInCurrentProcess: boolean;
  now?: string;
}): ResumeImportRun {
  const run = ResumeImportRunSchema.parse(input.run);
  const modelRoles = ResumeImportModelRoleStateSchema.parse(
    run.modelRoles ?? {},
  );

  if (
    modelRoles.vision.status !== "running" ||
    input.isActiveInCurrentProcess
  ) {
    return run;
  }

  const now = input.now ?? new Date().toISOString();
  return ResumeImportRunSchema.parse({
    ...run,
    warnings: [
      ...run.warnings.filter(
        (warning) => !deferredVisionWarningPattern.test(warning),
      ),
      interruptedVisionMessage,
    ],
    modelRoles: {
      ...modelRoles,
      vision: {
        ...modelRoles.vision,
        status: "failed",
        completedAt: now,
        warning: interruptedVisionMessage,
        errorMessage: interruptedVisionMessage,
      },
    },
  });
}

export const interruptedTextImportMessage = RESUME_IMPORT_INTERRUPTED_MESSAGE;

const inProgressImportStatuses = new Set<ResumeImportRun["status"]>([
  "queued",
  "parsing",
  "extracting",
  "reconciling",
]);

/**
 * A text import still marked in progress when no import runs in this process
 * was cut off by the app closing. Left alone it read "Importing" forever on
 * Profile and gave no hint on guided setup that anything had happened.
 *
 * A run whose visual scan is still running here is live, and a run the text
 * stage already finalized (`completedAt` set) was not cut off mid-text: older
 * builds marked it in progress again while the visual scan ran. Such a run
 * goes back to the settled status its candidates imply; it is never reported
 * as stopped, because its text import was applied.
 */
export function recoverInterruptedTextImportRun(input: {
  run: ResumeImportRun;
  isImportActiveInCurrentProcess: boolean;
  isVisionActiveInCurrentProcess?: boolean;
  now?: string;
}): ResumeImportRun {
  const run = ResumeImportRunSchema.parse(input.run);
  if (
    !inProgressImportStatuses.has(run.status) ||
    input.isImportActiveInCurrentProcess ||
    input.isVisionActiveInCurrentProcess
  ) {
    return run;
  }
  if (run.completedAt !== null) {
    const pendingReview =
      run.candidateCounts.needsReview + (run.candidateCounts.abstained ?? 0);
    return ResumeImportRunSchema.parse({
      ...run,
      status: pendingReview > 0 ? "review_ready" : "applied",
    });
  }
  const now = input.now ?? new Date().toISOString();
  return ResumeImportRunSchema.parse({
    ...run,
    status: "failed",
    completedAt: now,
    errorMessage: interruptedTextImportMessage,
    failureKind: "interrupted",
    warnings: [
      ...run.warnings.filter(
        (warning) => warning !== interruptedTextImportMessage,
      ),
      interruptedTextImportMessage,
    ],
  });
}

export function clearSettledVisionDeferredWarnings(input: {
  profile: CandidateProfile;
  run: ResumeImportRun | null;
}): CandidateProfile {
  const visionStatus = input.run?.modelRoles?.vision.status;
  const currentWarnings = input.profile.baseResume.analysisWarnings;

  if (
    !visionStatus ||
    visionStatus === "running" ||
    !currentWarnings.some((warning) =>
      deferredVisionWarningPattern.test(warning),
    )
  ) {
    return input.profile;
  }

  return CandidateProfileSchema.parse({
    ...input.profile,
    baseResume: {
      ...input.profile.baseResume,
      analysisWarnings: currentWarnings.filter(
        (warning) => !deferredVisionWarningPattern.test(warning),
      ),
    },
  });
}
