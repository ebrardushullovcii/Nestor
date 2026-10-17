import type {
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmExportInput,
  ApplicationCrmExportResult,
  ApplicationCrmMutationInput,
  ApplicationCrmSettings,
  ApplicationCrmStage,
  JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import {
  APPLICATION_CRM_STAGES_AFTER_SENDING,
  ApplicationCrmBulkStageMutationInputSchema,
  ApplicationCrmSettingsSchema,
} from "@nestor/contracts";

import {
  exportApplicationCrm,
  mutateApplicationCrmBulkStage,
  mutateApplicationCrm,
  runApplicationNoResponseAutomation,
} from "./application-crm";
import {
  closeApplicationStepsTrackedByPerson,
  restoreWithdrawnApplicationPreparation,
} from "./workspace-application-user-action";
import type { WorkspaceServiceContext } from "./workspace-service-context";

function trackedStageCloseReason(
  stage: ApplicationCrmStage,
): "sent" | "withdrawn" | null {
  if (stage === "withdrawn") return "withdrawn";
  return APPLICATION_CRM_STAGES_AFTER_SENDING.has(stage) ? "sent" : null;
}

/**
 * Keeps CRM persistence and Candidate Asset validation out of the public
 * workspace service. The service can spread these methods into its typed API.
 */
export function createWorkspaceCrmMethods(input: {
  ctx: WorkspaceServiceContext;
  getWorkspaceSnapshot: () => Promise<JobFinderWorkspaceSnapshot>;
}) {
  return {
    async mutateApplicationCrm(
      command: ApplicationCrmMutationInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      await input.ctx.withApplicationCrmTransition(async () => {
        const mutation = command.mutation;
        if (mutation.type === "set_stage" && mutation.customStageId) {
          const settings = ApplicationCrmSettingsSchema.parse(
            (await input.ctx.repository.getSettings()).applicationCrm ?? {},
          );
          const customStage = settings.customStages.find(
            (stage) => stage.id === mutation.customStageId,
          );
          if (!customStage || customStage.baseStage !== mutation.stage) {
            throw new Error(
              "That custom application stage is no longer available. Refresh and choose another stage.",
            );
          }
        }

        return mutateApplicationCrm({
          repository: input.ctx.repository,
          command,
          validateCandidateAsset: async (assetId) => {
            if (!input.ctx.candidateAssetResolver) {
              throw new Error(
                "Candidate Assets are unavailable in this workspace.",
              );
            }
            const resolved =
              await input.ctx.candidateAssetResolver.resolveForApplication(
                assetId,
              );
            return resolved.asset;
          },
        });
      });
      // Recording the send, or withdrawing, closes what the application was
      // still waiting on.
      const closeReason =
        command.mutation.type === "set_stage"
          ? trackedStageCloseReason(command.mutation.stage)
          : null;
      if (closeReason) {
        await closeApplicationStepsTrackedByPerson(
          input.ctx.repository,
          [command.applicationRecordId],
          closeReason,
        );
      }
      return input.getWorkspaceSnapshot();
    },

    async mutateApplicationCrmBulkStage(
      command: ApplicationCrmBulkStageMutationInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      await input.ctx.withApplicationCrmTransition(async () => {
        const parsedCommand =
          ApplicationCrmBulkStageMutationInputSchema.parse(command);
        if (
          (!parsedCommand.action || parsedCommand.action === "stage") &&
          parsedCommand.customStageId
        ) {
          const settings = ApplicationCrmSettingsSchema.parse(
            (await input.ctx.repository.getSettings()).applicationCrm ?? {},
          );
          const customStage = settings.customStages.find(
            (stage) => stage.id === parsedCommand.customStageId,
          );
          if (!customStage || customStage.baseStage !== parsedCommand.stage) {
            throw new Error(
              "That custom application stage is no longer available. Refresh and choose another stage.",
            );
          }
        }

        return mutateApplicationCrmBulkStage({
          repository: input.ctx.repository,
          command: parsedCommand,
        });
      });
      const parsedCommand =
        ApplicationCrmBulkStageMutationInputSchema.parse(command);
      const closeReason =
        !parsedCommand.action || parsedCommand.action === "stage"
          ? trackedStageCloseReason(parsedCommand.stage)
          : null;
      if (closeReason) {
        await closeApplicationStepsTrackedByPerson(
          input.ctx.repository,
          parsedCommand.items.map((item) => item.applicationRecordId),
          closeReason,
        );
      }
      if (parsedCommand.action === "undo") {
        await restoreWithdrawnApplicationPreparation(
          input.ctx.repository,
          parsedCommand.items.map((item) => item.applicationRecordId),
        );
      }
      return input.getWorkspaceSnapshot();
    },

    async runApplicationNoResponseAutomation(
      settings?: ApplicationCrmSettings,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const effectiveSettings =
        settings ??
        ApplicationCrmSettingsSchema.parse(
          (await input.ctx.repository.getSettings()).applicationCrm ?? {},
        );
      await input.ctx.withApplicationCrmTransition(() =>
        runApplicationNoResponseAutomation({
          repository: input.ctx.repository,
          settings: effectiveSettings,
        }),
      );
      return input.getWorkspaceSnapshot();
    },

    async exportApplicationCrm(
      command: ApplicationCrmExportInput,
    ): Promise<ApplicationCrmExportResult> {
      const snapshot = await input.getWorkspaceSnapshot();
      return input.ctx.withApplicationCrmTransition(async () => {
        const [records, settings] = await Promise.all([
          input.ctx.repository.listApplicationRecords(),
          input.ctx.repository.getSettings(),
        ]);
        return exportApplicationCrm({
          records,
          results: snapshot.applyJobResults,
          runs: snapshot.applyRuns,
          request: command,
          outcomes: snapshot.intelligence.outcomeEvents,
          customStages: settings.applicationCrm?.customStages ?? [],
        });
      });
    },
  };
}
