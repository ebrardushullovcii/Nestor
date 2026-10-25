import { jobSiteTarget } from "@nestor/contracts";
import {
  SourceDebugRunDetailsSchema,
  SourceDebugRunRecordSchema,
  SourceInstructionArtifactSchema,
  type EditableSourceInstructionArtifact,
} from "@nestor/contracts";
import type { WorkspaceServiceContext } from "./workspace-service-context";

export function createWorkspaceSourceDebugStoreMethods(
  ctx: WorkspaceServiceContext,
) {
  return {
    async getSourceDebugRun(runId: string) {
      const run = (await ctx.repository.listSourceDebugRuns()).find(
        (entry) => entry.id === runId,
      );

      if (!run) {
        throw new Error(`Unknown source debug run '${runId}'.`);
      }

      return SourceDebugRunRecordSchema.parse(run);
    },
    async getSourceDebugRunDetails(runId: string) {
      const [runs, attempts, evidenceRefs, instructionArtifacts] =
        await Promise.all([
          ctx.repository.listSourceDebugRuns(),
          ctx.repository.listSourceDebugAttempts(),
          ctx.repository.listSourceDebugEvidenceRefs(),
          ctx.repository.listSourceInstructionArtifacts(),
        ]);
      const run = runs.find((entry) => entry.id === runId);

      if (!run) {
        throw new Error(`Unknown source debug run '${runId}'.`);
      }

      return SourceDebugRunDetailsSchema.parse({
        run,
        attempts: attempts
          .filter((entry) => entry.runId === runId)
          .sort(
            (left, right) =>
              new Date(left.startedAt).getTime() -
              new Date(right.startedAt).getTime(),
          ),
        evidenceRefs: evidenceRefs
          .filter((entry) => entry.runId === runId)
          .sort(
            (left, right) =>
              new Date(left.capturedAt).getTime() -
              new Date(right.capturedAt).getTime(),
          ),
        instructionArtifact:
          instructionArtifacts.find(
            (artifact) => artifact.id === run.instructionArtifactId,
          ) ?? null,
      });
    },
    async listSourceDebugRuns(targetId: string) {
      return (await ctx.repository.listSourceDebugRuns())
        .filter((run) => run.targetId === targetId)
        .sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime(),
        )
        .map((run) => SourceDebugRunRecordSchema.parse(run));
    },
    async saveSourceInstructionArtifact(
      targetId: string,
      artifact: EditableSourceInstructionArtifact,
    ) {
      const site = ctx.jobSites?.get(Number(targetId));
      const target = site ? jobSiteTarget(site) : null;

      if (!target) {
        throw new Error(`Unknown discovery target '${targetId}'.`);
      }

      const existingArtifact = (
        await ctx.repository.listSourceInstructionArtifacts()
      ).find(
        (entry) => entry.id === artifact.id && entry.targetId === targetId,
      );

      if (!existingArtifact) {
        throw new Error(`Unknown source instruction '${artifact.id}'.`);
      }

      const isBoundInstruction =
        existingArtifact.id === target.draftInstructionId ||
        existingArtifact.id === target.validatedInstructionId;

      if (!isBoundInstruction) {
        throw new Error(
          `Source instruction '${existingArtifact.id}' is not bound to target '${targetId}'.`,
        );
      }

      const normalizedArtifact = SourceInstructionArtifactSchema.parse({
        ...existingArtifact,
        ...artifact,
        targetId,
        updatedAt: new Date().toISOString(),
      });

      await ctx.repository.upsertSourceInstructionArtifact(normalizedArtifact);
      return ctx.getWorkspaceSnapshot();
    },
    async acceptSourceInstructionDraft(
      targetId: string,
      instructionId: string,
    ) {
      const artifact = (
        await ctx.repository.listSourceInstructionArtifacts()
      ).find(
        (entry) => entry.id === instructionId && entry.targetId === targetId,
      );

      if (!artifact) {
        throw new Error(`Unknown source instruction '${instructionId}'.`);
      }

      const acceptedArtifact = SourceInstructionArtifactSchema.parse({
        ...artifact,
        updatedAt: new Date().toISOString(),
        acceptedAt: new Date().toISOString(),
      });
      await ctx.repository.upsertSourceInstructionArtifact(acceptedArtifact);
      await ctx.saveDiscoveryTargetUpdate(targetId, (target) => ({
        ...target,
        draftInstructionId: acceptedArtifact.id,
        instructionStatus: acceptedArtifact.status,
      }));
      return ctx.getWorkspaceSnapshot();
    },
  };
}
