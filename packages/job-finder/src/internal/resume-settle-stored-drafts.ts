import { isBlockingResumeClaimAssessment } from "@nestor/contracts";

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
    if (
      validations
        .get(draft.id)
        ?.claimAssessments.some((assessment) =>
          isBlockingResumeClaimAssessment({ assessment, draft }),
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
    if (!settled) continue;
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
