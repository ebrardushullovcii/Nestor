import { setTimeout as delay } from "node:timers/promises";
import {
  hasProfileSetupPlaceholderValue,
  type CandidateProfile,
  type ResumeImportRun,
} from "@nestor/contracts";
import type { ProfileService } from "@nestor/job-finder";

type ImportSnapshot = {
  profile: CandidateProfile;
  latestResumeImportRun: ResumeImportRun | null;
  visionProvider?: { requestTimeoutMs?: number | null } | null;
};
type ImportService = Pick<ProfileService, "getResumeImportState">;

function hasProfileDetails(profile: CandidateProfile): boolean {
  return (
    (["fullName", "headline", "summary", "currentLocation"] as const).some(
      (key) => {
        return (
          (profile[key]?.trim().length ?? 0) > 0 &&
          !hasProfileSetupPlaceholderValue(key, profile[key])
        );
      },
    ) ||
    Boolean(profile.email || profile.phone) ||
    [
      profile.skills,
      profile.experiences,
      profile.education,
      profile.certifications,
      profile.projects,
      profile.links,
    ].some((values) => values.length > 0)
  );
}

/** The sidebar needs the completed import, while the Profile UI can show text early. */
export async function waitForAssistantResumeImport(
  service: ImportService,
  imported: ImportSnapshot,
  options: {
    signal?: AbortSignal;
    readProfile: () => Promise<CandidateProfile>;
  },
): Promise<void> {
  options.signal?.throwIfAborted();
  const sourceResumeId = imported.profile.baseResume.id;
  const run =
    imported.latestResumeImportRun?.sourceResumeId === sourceResumeId
      ? imported.latestResumeImportRun
      : null;
  const timeoutMs =
    run?.modelRoles?.vision.timeoutMs ??
    imported.visionProvider?.requestTimeoutMs ??
    600_000;
  const deadline = Date.now() + timeoutMs;
  let state = await service.getResumeImportState();
  while (run && state.activeVisionRunIds.includes(run.id)) {
    options.signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        "The resume file was saved, but its visual scan is still finishing. Imported profile details are not confirmed yet.",
      );
    }
    await delay(Math.min(200, remainingMs), undefined, {
      signal: options.signal,
    });
    state = await service.getResumeImportState();
  }
  options.signal?.throwIfAborted();
  // An active run can finish during the preceding repository read. Read again
  // after observing its removal so results cannot predate the profile commit.
  state = await service.getResumeImportState();
  const completedProfile = await options.readProfile();
  options.signal?.throwIfAborted();
  if (completedProfile.baseResume.id !== sourceResumeId) {
    throw new Error(
      "Another resume replaced this import. Its details were not confirmed as the current profile.",
    );
  }
  const completedRun = run
    ? state.resumeImportRuns.find((entry) => entry.id === run.id)
    : null;
  const usableCandidates =
    (completedRun?.candidateCounts.autoApplied ?? 0) +
    (completedRun?.candidateCounts.needsReview ?? 0);
  if (usableCandidates === 0 && !hasProfileDetails(completedProfile)) {
    throw new Error(
      "The resume file was saved, but no usable profile details were recovered. Try a clearer copy or provide the resume text.",
    );
  }
}
