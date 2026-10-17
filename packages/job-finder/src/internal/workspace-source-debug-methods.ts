import type {
  EditableSourceInstructionArtifact,
  SourceDebugProgressEvent,
  SourceDebugRunDetails,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import {
  persistAutomaticSourceDebugSafeguard,
  persistSourceDebugCampaignNotifications,
  selectLatestSourceDebugRun,
} from "./automatic-safeguards";
import { createWorkspaceSourceDebugStoreMethods } from "./workspace-source-debug-store-methods";
import { runSourceDebugWorkflow } from "./workspace-source-debug-workflow";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import type { JobFinderWorkspaceService } from "./workspace-service-contracts";

export function createWorkspaceSourceDebugMethods(
  ctx: WorkspaceServiceContext,
): Pick<
  JobFinderWorkspaceService,
  | "runSourceDebug"
  | "cancelSourceDebug"
  | "getSourceDebugRun"
  | "getSourceDebugRunDetails"
  | "listSourceDebugRuns"
  | "saveSourceInstructionArtifact"
  | "acceptSourceInstructionDraft"
  | "verifySourceInstructions"
> & {
  runSourceDebugWorkflow: (
    targetId: string,
    signal?: AbortSignal,
    options?: {
      clearExistingInstructions?: boolean;
      reviewInstructionId?: string | null;
    },
    onProgress?: (event: SourceDebugProgressEvent) => void,
  ) => Promise<
    ReturnType<WorkspaceServiceContext["getWorkspaceSnapshot"]> extends Promise<
      infer T
    >
      ? T
      : never
  >;
} {
  const storeMethods = createWorkspaceSourceDebugStoreMethods(ctx);

  function trackSourceDebugPromise<T>(promise: Promise<T>): Promise<T> {
    ctx.activeSourceDebugPromiseRef.current = promise;
    void promise
      .finally(() => {
        if (ctx.activeSourceDebugPromiseRef.current === promise) {
          ctx.activeSourceDebugPromiseRef.current = null;
        }
      })
      .catch(() => {});
    return promise;
  }

  async function runSourceDebugWithAutomaticEffects(
    targetId: string,
    signal?: AbortSignal,
    options?: {
      clearExistingInstructions?: boolean;
      reviewInstructionId?: string | null;
    },
    onProgress?: (event: SourceDebugProgressEvent) => void,
  ) {
    try {
      return await runSourceDebugWorkflow(
        ctx,
        targetId,
        signal,
        options,
        onProgress,
      );
    } finally {
      // The workflow persists its terminal record before returning (and also
      // before rethrowing a non-cancellation failure). Re-read that durable
      // record so a restart/retry derives the same notification and safeguard
      // facts without relying on an in-memory result.
      try {
        const runs = await ctx.repository.listSourceDebugRuns();
        const run = selectLatestSourceDebugRun(runs, targetId);
        if (run) {
          await persistSourceDebugCampaignNotifications(ctx, run).catch(
            () => {},
          );

          const campaignState = await ctx.repository.getCampaignState();
          if (campaignState) {
            const relevantCampaigns = campaignState.campaigns.filter(
              (campaign) => campaign.sourceTargetIds.includes(targetId),
            );
            await Promise.all(
              relevantCampaigns.map((campaign) =>
                persistAutomaticSourceDebugSafeguard({
                  ctx,
                  campaign,
                  targetIds: [targetId],
                  now: run.completedAt ?? run.updatedAt,
                }).catch(() => {}),
              ),
            );
          }
        }
      } catch {
        // Automatic facts are secondary to the source-debug result. Never
        // mask the original workflow result/error with a bookkeeping issue.
      }
    }
  }

  return {
    runSourceDebugWorkflow: (targetId, signal, options, onProgress) =>
      trackSourceDebugPromise(
        runSourceDebugWithAutomaticEffects(
          targetId,
          signal,
          options,
          onProgress,
        ),
      ),
    async runSourceDebug(targetId, signal, onProgress) {
      return trackSourceDebugPromise(
        runSourceDebugWithAutomaticEffects(
          targetId,
          signal,
          {
            clearExistingInstructions: true,
          },
          onProgress,
        ),
      );
    },
    async cancelSourceDebug(runId) {
      if (
        ctx.activeSourceDebugExecutionIdRef.current !== runId ||
        !ctx.activeSourceDebugAbortControllerRef.current
      ) {
        return ctx.getWorkspaceSnapshot();
      }

      ctx.activeSourceDebugAbortControllerRef.current.abort();

      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (ctx.activeSourceDebugExecutionIdRef.current === null) {
          break;
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }

      return ctx.getWorkspaceSnapshot();
    },
    getSourceDebugRun(runId): Promise<SourceDebugRunRecord> {
      return storeMethods.getSourceDebugRun(runId);
    },
    getSourceDebugRunDetails(runId): Promise<SourceDebugRunDetails> {
      return storeMethods.getSourceDebugRunDetails(runId);
    },
    listSourceDebugRuns(targetId) {
      return storeMethods.listSourceDebugRuns(targetId);
    },
    saveSourceInstructionArtifact(
      targetId: string,
      artifact: EditableSourceInstructionArtifact,
    ) {
      return storeMethods.saveSourceInstructionArtifact(targetId, artifact);
    },
    acceptSourceInstructionDraft(targetId, instructionId) {
      return storeMethods.acceptSourceInstructionDraft(targetId, instructionId);
    },
    async verifySourceInstructions(
      targetId,
      instructionId,
      signal,
      onProgress,
    ) {
      const artifacts = await ctx.repository.listSourceInstructionArtifacts();
      const artifact = artifacts.find(
        (entry) => entry.id === instructionId && entry.targetId === targetId,
      );

      if (!artifact) {
        throw new Error(`Unknown source instruction '${instructionId}'.`);
      }

      return trackSourceDebugPromise(
        runSourceDebugWithAutomaticEffects(
          targetId,
          signal,
          {
            clearExistingInstructions: false,
            reviewInstructionId: artifact.id,
          },
          onProgress,
        ),
      );
    },
  };
}
