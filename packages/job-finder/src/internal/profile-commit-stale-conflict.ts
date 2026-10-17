import type { CandidateProfile } from "@nestor/contracts";
import type { JobFinderRepository, ProfileCommitOutcome } from "@nestor/db";

/**
 * Surfaces a profile compare-and-swap conflict that survived one deterministic
 * remerge attempt. The workspace changed twice while a long-running profile
 * flow was computing; the user should retry instead of the app silently
 * overwriting either change.
 */
export class ProfileCommitStaleError extends Error {
  constructor() {
    super(
      "Your profile changed while this update was being prepared, and again before it could be retried. Review the latest profile changes, then repeat the request so nothing is overwritten.",
    );
    this.name = "ProfileCommitStaleError";
  }
}

const MAX_PROFILE_COMMIT_ATTEMPTS = 2;

export type AppliedProfileCommit = Extract<
  ProfileCommitOutcome,
  { status: "applied" }
>;

/**
 * Commits a deterministic profile merge through the repository CAS boundary.
 * On a stale outcome it retries exactly once: `createUpdater` is invoked again
 * so the merge recomputes over the freshest persisted profile without redoing
 * any model work. A second stale outcome raises ProfileCommitStaleError
 * instead of overwriting concurrent edits.
 */
export async function commitMergedProfileUpdateWithStaleRetry(
  repository: Pick<
    JobFinderRepository,
    "getProfileWithRevision" | "commitProfileUpdate"
  >,
  createUpdater: () => (current: CandidateProfile) => CandidateProfile,
): Promise<AppliedProfileCommit> {
  const baseline = await repository.getProfileWithRevision();
  let outcome = await repository.commitProfileUpdate(createUpdater(), {
    expectedRevision: baseline.revision,
  });

  if (outcome.status === "stale") {
    outcome = await repository.commitProfileUpdate(createUpdater(), {
      expectedRevision: outcome.revision,
    });
  }

  if (outcome.status === "stale") {
    throw new ProfileCommitStaleError();
  }

  return outcome;
}

export type CommitProfileCopilotStateInput = Parameters<
  JobFinderRepository["commitProfileCopilotState"]
>[0];

export type AppliedProfileCopilotCommit = Extract<
  Awaited<ReturnType<JobFinderRepository["commitProfileCopilotState"]>>,
  { status: "applied" }
>;

/**
 * Commits profile copilot workspace state through the repository CAS
 * boundary. Each attempt calls `prepareAttempt` so the payload and the
 * expected revision are captured together; a stale outcome triggers exactly
 * one deterministic reprepare-and-commit before surfacing
 * ProfileCommitStaleError.
 */
export async function commitProfileCopilotStateWithStaleRetry(
  repository: Pick<JobFinderRepository, "commitProfileCopilotState">,
  prepareAttempt: () => Promise<CommitProfileCopilotStateInput>,
): Promise<AppliedProfileCopilotCommit> {
  let outcome = await repository.commitProfileCopilotState(
    await prepareAttempt(),
  );

  for (let attempt = 1; outcome.status === "stale"; attempt += 1) {
    if (attempt >= MAX_PROFILE_COMMIT_ATTEMPTS) {
      throw new ProfileCommitStaleError();
    }
    outcome = await repository.commitProfileCopilotState(
      await prepareAttempt(),
    );
  }

  return outcome;
}
