import {
  isBlockingResumeClaimAssessment,
  isBlockingResumeValidationIssue,
  type CandidateProfile,
  type ResumeDraft,
  type SavedJob,
  type TailoredAsset,
} from "@nestor/contracts";

import {
  createMonotonicTimestamp,
  preserveWorkHistoryReviewGuidance,
} from "./resume-draft-commit-support";
import { settleResumeClaimLines } from "./resume-claim-checks";
import {
  buildTailoredAssetBridge,
  sanitizeResumeDraft,
  validateResumeDraft,
} from "./resume-workspace-helpers";
import type { WorkspaceServiceContext } from "./workspace-service-context";

// Kept from load time: a yield is a real turn of the event loop even where
// a test has replaced the timers.
const realSetImmediate = globalThis.setImmediate;
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => realSetImmediate(resolve));
}

/**
 * Drafts written before ADR 0051 can still hold generated lines their fact
 * check called unsupported, each waiting for the person. This settles them
 * once, from the verdicts already stored on each draft and without calling the
 * model: a line goes back to the person's saved wording or is left off. Only
 * drafts that are not approved are touched; the result is saved the way an
 * ordinary save is, so approving still builds a fresh PDF.
 *
 * Some older drafts were blocked by a word-matching check that ran before the
 * model's fact check existed ("Angular" in a skills list called unsupported),
 * and carry no stored verdict to settle from. Their saved check is simply out
 * of date: checked again under today's rules a line the AI has not checked
 * never blocks, so the fresh check is saved and the draft is left as it is.
 */
export async function settleStoredResumeDrafts(
  ctx: WorkspaceServiceContext,
): Promise<number> {
  // The display read the snapshot already uses, so loading the workspace
  // reads no validation history.
  const display = await ctx.repository.readDisplayCollections?.();
  const drafts = (
    display?.resumeDrafts ?? (await ctx.repository.listResumeDrafts())
  ).filter(
    (draft) => draft.status === "draft" || draft.status === "needs_review",
  );
  if (drafts.length === 0) return 0;
  const validations = new Map(
    (
      display?.latestResumeValidationResults ??
      (await ctx.repository.listLatestResumeValidationResults(
        drafts.map((draft) => draft.id),
      ))
    ).map((validation) => [validation.draftId, validation]),
  );
  // Checking a draft's claims is string-heavy work. It runs as the app
  // opens, so it lets the window's own requests in between drafts instead of
  // holding the main process for a third of a second.
  const pending: typeof drafts = [];
  for (const draft of drafts) {
    await yieldToEventLoop();
    const validation = validations.get(draft.id);
    if (
      validation?.claimAssessments.some((assessment) =>
        isBlockingResumeClaimAssessment({ assessment, draft }),
      ) ||
      // An older check wrote its verdict only as a blocking issue.
      validation?.issues.some(
        (issue) =>
          issue.category === "unsupported_claim" &&
          isBlockingResumeValidationIssue(issue),
      )
    ) {
      pending.push(draft);
    }
  }
  if (pending.length === 0) return 0;

  const [jobs, assets, profile, searchPreferences] = await Promise.all([
    ctx.repository.listSavedJobsByIds(pending.map((draft) => draft.jobId)),
    ctx.repository.listTailoredAssets(),
    ctx.repository.getProfile(),
    ctx.repository.getSearchPreferences(),
  ]);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const assetsByJobId = new Map(assets.map((asset) => [asset.jobId, asset]));
  const templates = ctx.documentManager.listResumeTemplates();
  let settledCount = 0;

  for (const draft of pending) {
    await yieldToEventLoop();
    const job = jobsById.get(draft.jobId);
    if (!job) continue;
    const tailoringMode =
      job.resumeTailoringMode ?? searchPreferences.tailoringMode;
    const settled = settleResumeClaimLines({
      draft,
      profile,
      stretchesAreThePersons: tailoringMode === "aggressive",
    });
    if (!settled) {
      // Only a check written before the model's fact check is redone here.
      // A line the model itself found unsupported keeps waiting for the
      // person, even when the draft does not carry that verdict itself.
      const modelFlagged = validations
        .get(draft.id)
        ?.claimAssessments.some(
          (assessment) =>
            assessment.verifier.startsWith("model_") &&
            isBlockingResumeClaimAssessment({ assessment, draft }),
        );
      if (!modelFlagged)
        await saveRecheckedDraft(ctx, {
          draft,
          job,
          profile,
          previousValidation: validations.get(draft.id) ?? null,
          existingAsset: assetsByJobId.get(job.id) ?? null,
          templates,
        });
      continue;
    }
    const sanitized = sanitizeResumeDraft({
      draft: {
        ...settled,
        updatedAt: createMonotonicTimestamp(draft.updatedAt),
      },
      job,
      profile,
    });
    const previousValidation = validations.get(draft.id) ?? null;
    const validation = preserveWorkHistoryReviewGuidance({
      validation: validateResumeDraft({
        draft: sanitized,
        job,
        profile,
        pageCount: previousValidation?.pageCount ?? null,
        validatedAt: sanitized.updatedAt,
      }),
      previousValidation,
      draft: sanitized,
    });
    const existingAsset = assetsByJobId.get(job.id) ?? null;
    await ctx.repository.saveResumeDraftWithValidation({
      draft: sanitized,
      validation,
      tailoredAsset: buildTailoredAssetBridge({
        draft: sanitized,
        job,
        profile,
        existingAsset,
        storagePath: existingAsset?.storagePath ?? null,
        templates,
      }),
    });
    settledCount += 1;
  }

  return settledCount;
}

/**
 * Saves a fresh check of an unchanged draft when today's rules no longer
 * block it. A draft the fresh check still blocks is left alone, so this does
 * no work on the next launch either.
 */
async function saveRecheckedDraft(
  ctx: WorkspaceServiceContext,
  input: {
    draft: ResumeDraft;
    job: SavedJob;
    profile: CandidateProfile;
    previousValidation: Parameters<
      typeof preserveWorkHistoryReviewGuidance
    >[0]["previousValidation"];
    existingAsset: TailoredAsset | null;
    templates: NonNullable<
      Parameters<typeof buildTailoredAssetBridge>[0]["templates"]
    >;
  },
): Promise<void> {
  const { draft, job, profile, previousValidation } = input;
  const validation = preserveWorkHistoryReviewGuidance({
    validation: validateResumeDraft({
      draft,
      job,
      profile,
      pageCount: previousValidation?.pageCount ?? null,
      validatedAt: createMonotonicTimestamp(draft.updatedAt),
    }),
    previousValidation,
    draft,
  });
  if (
    validation.claimAssessments.some((assessment) =>
      isBlockingResumeClaimAssessment({ assessment, draft }),
    )
  ) {
    return;
  }
  await ctx.repository.saveResumeDraftWithValidation({
    draft,
    validation,
    tailoredAsset: buildTailoredAssetBridge({
      draft,
      job,
      profile,
      existingAsset: input.existingAsset,
      storagePath: input.existingAsset?.storagePath ?? null,
      templates: input.templates,
    }),
  });
}
