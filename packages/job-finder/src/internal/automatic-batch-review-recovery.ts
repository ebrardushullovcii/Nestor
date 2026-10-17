import { JobFinderIntelligenceStateSchema } from "@nordri/contracts";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/**
 * Prepared batches no longer wait for a sample review before more
 * applications are prepared: the person reviews what they want from
 * Applications. Pending automatic reviews from before are retired here.
 * Completed reviews and person-created reviews keep their history.
 */
export async function reconcileAutomaticBatchSampleReviews(
  ctx: Pick<
    WorkspaceServiceContext,
    "repository" | "withIntelligenceTransition"
  >,
): Promise<void> {
  const initial = await (ctx.repository.readIntelligenceProjection?.() ??
    ctx.repository.getIntelligenceState());
  if (
    !initial.safeguards.preparedBatchSampleReviews.some(
      (review) =>
        review.id.startsWith("automatic_batch_sample_review:") &&
        !review.reviewCompleted,
    )
  ) {
    return;
  }

  await ctx.withIntelligenceTransition(async () => {
    const state = await ctx.repository.getIntelligenceState();
    const reviews = state.safeguards.preparedBatchSampleReviews;
    const settled = reviews.filter(
      (review) =>
        !review.id.startsWith("automatic_batch_sample_review:") ||
        review.reviewCompleted,
    );
    if (settled.length === reviews.length) return;
    const now = new Date().toISOString();
    await ctx.repository.saveIntelligenceState(
      JobFinderIntelligenceStateSchema.parse({
        ...state,
        safeguards: {
          ...state.safeguards,
          preparedBatchSampleReviews: settled,
          updatedAt: now,
        },
        updatedAt: now,
      }),
    );
  });
}
