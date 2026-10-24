import {
  ProfileSetupStateSchema,
  deriveProfileSetupState,
  evaluateProfileSetupReadiness,
  getProfileSetupLandingStep,
  type CandidateProfile,
  type JobSearchPreferences,
  type ProfileSetupState,
  type ResumeImportFieldCandidate,
  type ResumeImportFieldCandidateSummary,
} from "@nestor/contracts";

import { buildProfileSetupReviewItems } from "./profile-setup-review-items";
import type { WorkspaceServiceContext } from "./workspace-service-context";

function mergeReviewItems(
  storedItems: ProfileSetupState["reviewItems"],
  incomingItems: ProfileSetupState["reviewItems"],
): ProfileSetupState["reviewItems"] {
  const incomingById = new Map(incomingItems.map((item) => [item.id, item]));
  const merged: ProfileSetupState["reviewItems"] = [];

  for (const storedItem of storedItems) {
    const incomingItem = incomingById.get(storedItem.id);

    if (!incomingItem) {
      merged.push(storedItem);
      continue;
    }

    incomingById.delete(storedItem.id);

    if (storedItem.status !== "pending" && incomingItem.status === "pending") {
      merged.push(storedItem);
      continue;
    }

    if (incomingItem.status !== "pending" && storedItem.status === "pending") {
      merged.push(incomingItem);
      continue;
    }

    if (storedItem.status !== "pending" && incomingItem.status !== "pending") {
      const storedResolvedAt = storedItem.resolvedAt ?? "";
      const incomingResolvedAt = incomingItem.resolvedAt ?? "";
      merged.push(
        incomingResolvedAt >= storedResolvedAt ? incomingItem : storedItem,
      );
      continue;
    }

    merged.push(incomingItem);
  }

  merged.push(...incomingById.values());
  return merged;
}

export function summarizeReviewCandidates(
  candidates: readonly ResumeImportFieldCandidate[],
): ResumeImportFieldCandidateSummary[] {
  return candidates.slice(0, 8).map((candidate) => ({
    id: candidate.id,
    target: candidate.target,
    label: candidate.label,
    value: candidate.value,
    valuePreview: candidate.valuePreview,
    evidenceText: candidate.evidenceText,
    confidence: candidate.confidence,
    resolution: candidate.resolution,
    resolutionReason: candidate.resolutionReason ?? null,
    notes: candidate.notes,
    conflictChoices: candidate.conflictChoices ?? [],
    visualEvidence: candidate.visualEvidence ?? [],
  }));
}

export async function deriveAndPersistProfileSetupState(
  ctx: WorkspaceServiceContext,
  input: {
    profile: CandidateProfile;
    searchPreferences: JobSearchPreferences;
    persistedState: ProfileSetupState;
    latestResumeImportRunId?: string | null;
    latestResumeImportReviewCandidates?: readonly ResumeImportFieldCandidate[];
    persist?: boolean;
  },
): Promise<ProfileSetupState> {
  const now = new Date().toISOString();
  const storedState = await ctx.repository.getProfileSetupState();
  const basePersistedState = ProfileSetupStateSchema.parse({
    ...storedState,
    ...input.persistedState,
    reviewItems: mergeReviewItems(
      storedState.reviewItems,
      input.persistedState.reviewItems,
    ),
  });
  const reviewCandidates =
    input.latestResumeImportReviewCandidates ??
    (input.latestResumeImportRunId
      ? await ctx.repository.listResumeImportFieldCandidates({
          runId: input.latestResumeImportRunId,
          resolutions: ["needs_review", "abstained"],
        })
      : []);
  const latestBundle = input.latestResumeImportRunId
    ? ((
        await ctx.repository.listResumeImportDocumentBundles({
          runId: input.latestResumeImportRunId,
        })
      )[0] ?? null)
    : null;
  const nextState = ProfileSetupStateSchema.parse({
    ...basePersistedState,
    reviewItems: buildProfileSetupReviewItems({
      currentState: basePersistedState,
      documentBundle: latestBundle,
      now,
      profile: input.profile,
      candidates: reviewCandidates,
      searchPreferences: input.searchPreferences,
    }),
  });
  const discoveryRuns = await ctx.repository.readDiscoveryRunStates();
  const derivedState = deriveProfileSetupState(
    input.profile,
    input.searchPreferences,
    {
      currentState: nextState,
      hasRunSearch: discoveryRuns.some((run) => !run.isActive),
      now,
    },
  );

  if (
    input.persist !== false &&
    JSON.stringify(derivedState) !== JSON.stringify(storedState)
  ) {
    await ctx.repository.saveProfileSetupState(derivedState);
  }

  return derivedState;
}

/**
 * After a resume import, guided setup opens on the first step that still
 * needs the person. It used to open wherever an optional suggestion sat
 * (a proof point on Extras, a summary to confirm on Basics), so the first
 * press after every import was a stepper chip. A person who moved to another
 * step while the import ran keeps the step they chose, and a finished setup
 * is left alone.
 */
export async function landProfileSetupAfterImport(
  ctx: WorkspaceServiceContext,
  input: { importStartedAt: string },
): Promise<void> {
  const [profile, rawSearchPreferences, storedState, latestRun] =
    await Promise.all([
      ctx.repository.getProfile(),
      ctx.repository.getSearchPreferences(),
      ctx.repository.getProfileSetupState(),
      ctx.repository.getLatestResumeImportRun(),
    ]);
  if (storedState.status === "completed") {
    return;
  }
  if (
    storedState.lastResumedAt !== null &&
    storedState.lastResumedAt > input.importStartedAt
  ) {
    return;
  }
  const readiness = evaluateProfileSetupReadiness(
    profile,
    rawSearchPreferences,
  );
  if (!readiness.hasResumeText) {
    return;
  }
  const latestResumeImportRunId = latestRun?.id ?? null;
  // Derive first so the landing step sees the review items this import just
  // raised, not only the ones stored before it ran.
  const derived = await deriveAndPersistProfileSetupState(ctx, {
    persistedState: ProfileSetupStateSchema.parse({
      ...storedState,
      status: "in_progress",
    }),
    profile,
    searchPreferences: rawSearchPreferences,
    latestResumeImportRunId,
    persist: false,
  });
  const landingStep =
    derived.status === "completed"
      ? derived.currentStep
      : getProfileSetupLandingStep(readiness, derived.reviewItems);
  await deriveAndPersistProfileSetupState(ctx, {
    persistedState: ProfileSetupStateSchema.parse({
      ...derived,
      currentStep: landingStep,
    }),
    profile,
    searchPreferences: rawSearchPreferences,
    latestResumeImportRunId,
  });
}
