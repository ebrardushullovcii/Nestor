import {
  ResumeDraftPatchSchema,
  isResumeTemplateApplyEligible,
  type ResumeDraftPatch,
} from "@nestor/contracts";

import {
  checkResumeAssistantProposal,
  findResumeAssistantPatchesDroppedOnSave,
  listResumeLinesToConfirm,
} from "./resume-assistant-conversation";
import { createMonotonicTimestamp } from "./resume-draft-commit-support";
import { applyPatchToResumeDraft } from "./resume-workspace-patches";
import {
  collectResearchContext,
  sanitizeResumeDraft,
} from "./resume-workspace-helpers";
import { evaluateCheckedResumeProposalGrounding } from "./resume-claim-checks";
import { buildResumeRenderDocument } from "./resume-workspace-structure";
import { createUniqueId } from "./shared";
import {
  ensureResumeDraft,
  fetchAndPersistResearch,
  resolveEffectiveResumeTailoringStrengthForJob,
} from "./workspace-application-resume-support";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/**
 * The resume revision specialist (ADR 0037).
 *
 * A substantial rewrite ("tailor this section harder", "fit it on two
 * pages") runs the existing resume edit agent as a bounded task: an explicit
 * brief, the draft, the job and a short chat excerpt in; structured patches
 * checked by the approval gate and measured for pages out. It owns no
 * conversation and stores no chat message.
 */

export interface ResumeSpecialistResult {
  note: string;
  patches: ResumeDraftPatch[];
  baseDraftUpdatedAt: string;
  approvalBlockers: readonly { message: string }[];
  droppedNotes: string[];
}

export async function runResumeRevisionSpecialist(
  ctx: WorkspaceServiceContext,
  input: {
    jobId: string;
    brief: string;
    recentExcerpt: readonly { role: "user" | "assistant"; content: string }[];
    signal?: AbortSignal;
  },
): Promise<ResumeSpecialistResult> {
  const state = await ensureResumeDraft(ctx, input.jobId);
  const validations = await ctx.repository.listResumeValidationResults(
    state.draft.id,
  );
  const research = await fetchAndPersistResearch(ctx, state.job);
  const tailoringStrength = await resolveEffectiveResumeTailoringStrengthForJob(
    ctx,
    input.jobId,
  );
  const reply = await ctx.aiClient.reviseResumeDraft({
    draft: state.draft,
    job: state.job,
    request: input.brief,
    validationIssues:
      validations[0]?.issues.map((issue) => issue.message) ?? [],
    tailoringStrength,
    researchContext: collectResearchContext(research),
    recentConversation: input.recentExcerpt.slice(-6).map((turn) => ({
      role: turn.role,
      content: turn.content.slice(0, 2_000),
      proposal: null,
    })),
    linesToConfirm: listResumeLinesToConfirm({
      draft: state.draft,
      claimAssessments: validations[0]?.claimAssessments ?? [],
    }),
    checkProposal: (patches) =>
      checkResumeAssistantProposal({
        aiClient: ctx.aiClient,
        baselineDraft: state.draft,
        patches,
        job: state.job,
        profile: state.profile,
      }),
    currentPageCount:
      validations[0]?.pageCount ??
      validations[0]?.coverageComparison?.pageCount ??
      null,
    measurePages: async (patches) => {
      let candidate = state.draft;
      for (const patch of patches) {
        candidate = applyPatchToResumeDraft({
          draft: candidate,
          patch: { ...patch, draftId: state.draft.id, origin: "assistant" },
          updatedAt: createMonotonicTimestamp(candidate.updatedAt),
        });
      }
      const measured = sanitizeResumeDraft({
        draft: candidate,
        job: state.job,
        profile: state.profile,
      });
      const rendered = await ctx.documentManager.renderResumeArtifact({
        job: state.job,
        profile: state.profile,
        renderDocument: buildResumeRenderDocument(state.profile, measured),
        templateId: measured.templateId,
        settings: state.settings,
      });
      await ctx.documentManager.discardResumeArtifact?.(rendered);
      return {
        pageCount: rendered.pageCount ?? null,
        targetPageCount: measured.targetPageCount,
      };
    },
    availableTemplates: state.templates
      .filter(isResumeTemplateApplyEligible)
      .map((template) => ({
        id: template.id,
        label: template.label,
        density: template.density,
      })),
  });
  const normalized = reply.patches.map((patch) =>
    ResumeDraftPatchSchema.parse({
      ...patch,
      id: patch.id || createUniqueId("specialist_patch"),
      draftId: state.draft.id,
      targetEntryId: patch.targetEntryId ?? null,
      origin: "assistant",
    }),
  );
  const dropped = findResumeAssistantPatchesDroppedOnSave({
    baselineDraft: state.draft,
    patches: normalized,
    job: state.job,
    profile: state.profile,
  });
  const kept = normalized.filter(
    (patch) => !dropped.some((drop) => drop.patchId === patch.id),
  );
  const gate =
    kept.length > 0
      ? await evaluateCheckedResumeProposalGrounding(
          { aiClient: ctx.aiClient },
          {
            baselineDraft: state.draft,
            patches: kept,
            job: state.job,
            profile: state.profile,
            evaluatedAt: new Date().toISOString(),
          },
        )
      : { accepted: true, approvalBlockers: [] };
  return {
    note: reply.content,
    patches: kept,
    baseDraftUpdatedAt: state.draft.updatedAt,
    approvalBlockers: gate.approvalBlockers.map((blocker) => ({
      message: blocker.message,
    })),
    droppedNotes: dropped.map((drop) => drop.message),
  };
}
