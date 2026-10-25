import {
  deriveScopeBlockers,
  type SafeguardBlocker,
} from "./safeguard-operations";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import { reconcileAutomaticBatchSampleReviews } from "./automatic-batch-review-recovery";

// Search-side guards remain shared with discovery.
export function createWorkspaceSafeguardMethods(input: {
  ctx: WorkspaceServiceContext;
}) {
  const { ctx } = input;

  /**
   * Reviews of prepared applications gate later application preparation,
   * not read-only discovery. Discovery still reconciles them for the UI.
   */
  async function evaluateGlobalDiscoveryBlockers(): Promise<
    SafeguardBlocker[]
  > {
    await reconcileAutomaticBatchSampleReviews(ctx);
    const state = await ctx.repository.getIntelligenceState();

    return deriveScopeBlockers({
      safeguards: state.safeguards,
      jobIds: [],
      companyIds: [],
      applicationRecordJobIds: new Map(),
      operation: "discovery",
    }).filter((blocker) => blocker.kind === "batch_sample_review_pending");
  }

  function requireNoBlockers(blockers: readonly SafeguardBlocker[]): void {
          const blocker = blockers.find(
            (entry) => entry.severity === "blocker");
          if (
            !blocker) return;

    // The exact reason and recovery action come from the persisted entry; the
    // thrown message surfaces both and points at the Safeguards screen.
    // The person reads the reason and the thing to do next. The internal
    // reference travels on the blocker itself (`code`), for logs and for a
    // renderer that wants it behind a details control.
    throw new Error(
      `${blocker.explanation} ${blocker.recoveryGuidance} ` +
        `Open Safeguards to resolve, dismiss, or retry before continuing.`,
    );
  }

  return {
    evaluateGlobalDiscoveryBlockers,
    requireNoBlockers,
  };
}
