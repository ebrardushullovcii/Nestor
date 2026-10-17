import type { JobFinderAiClient } from "@nestor/ai-providers";
import type {
  ResumeAssistantConversationTurn,
  ResumeProposalCheckResult,
} from "@nestor/ai-providers";
import {
  isBlockingResumeClaimAssessment,
  type CandidateProfile,
  type ResumeAssistantMessage,
  type ResumeClaimAssessment,
  type ResumeDraft,
  type ResumeDraftPatch,
  type SavedJob,
} from "@nestor/contracts";
import { sanitizeResumeDraft } from "./resume-workspace-helpers";
import { evaluateCheckedResumeProposalGrounding } from "./resume-claim-checks";
import { applyPatchToResumeDraft } from "./resume-workspace-patches";

/** Turns the Resume Studio Assistant sees before the new request. */
export const RESUME_ASSISTANT_CONVERSATION_TURNS = 8;

/**
 * The last few turns of one job's Assistant thread, oldest first, with each
 * proposal's changes and what became of them. Without them "do it", "yes" or
 * "the second one" reached a model that did not know what "it" was.
 */
export function buildRecentResumeAssistantConversation(
  messages: readonly ResumeAssistantMessage[],
  limit = RESUME_ASSISTANT_CONVERSATION_TURNS,
): ResumeAssistantConversationTurn[] {
  return messages.slice(-limit).map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: message.content.slice(0, 2_000),
    proposal:
      message.role === "assistant" && message.patches.length > 0
        ? {
            status:
              message.proposalStatus === "accepted"
                ? "accepted"
                : message.proposalStatus === "rejected"
                  ? "rejected"
                  : "waiting_for_review",
            changes: message.patches.map((patch) => ({
              patchId: patch.id,
              operation: patch.operation,
              sectionId: patch.targetSectionId,
              entryId: patch.targetEntryId ?? null,
              bulletId: patch.targetBulletId ?? null,
              newText:
                patch.newText ??
                (patch.newIncluded === null || patch.newIncluded === undefined
                  ? null
                  : patch.newIncluded
                    ? "(show)"
                    : "(hide)"),
              applied:
                message.proposalStatus === "accepted"
                  ? message.resolvedPatchIds.includes(patch.id)
                  : null,
            })),
          }
        : null,
  }));
}

/**
 * The approval gate over the draft these changes would produce, in the shape
 * the Assistant's agent reads. It is the same evaluation the service applies
 * to the finished reply, so what the agent repairs is what the card reports.
 */
export async function checkResumeAssistantProposal(input: {
  aiClient: Pick<JobFinderAiClient, "checkResumeClaims">;
  baselineDraft: ResumeDraft;
  patches: readonly ResumeDraftPatch[];
  job: SavedJob;
  profile: CandidateProfile;
}): Promise<ResumeProposalCheckResult> {
  const patches = input.patches.map((patch) => ({
    ...patch,
    draftId: input.baselineDraft.id,
    origin: "assistant" as const,
  }));
  try {
    const droppedOnSave = findResumeAssistantPatchesDroppedOnSave({
      baselineDraft: input.baselineDraft,
      patches,
      job: input.job,
      profile: input.profile,
    });
    const gate = await evaluateCheckedResumeProposalGrounding(
      { aiClient: input.aiClient },
      {
        baselineDraft: input.baselineDraft,
        patches,
        job: input.job,
        profile: input.profile,
        evaluatedAt: new Date().toISOString(),
      },
    );
    return {
      applyError: null,
      findings: gate.approvalBlockers.map((blocker) => ({
        patchId: blocker.patchId,
        sectionId: blocker.sectionId,
        entryId: blocker.entryId,
        bulletId: blocker.bulletId,
        flaggedText: blocker.flaggedText,
        message: blocker.message,
        kind: blocker.kind ?? "unsupported",
      })),
      droppedOnSave,
    };
  } catch (error) {
    return {
      applyError:
        error instanceof Error
          ? error.message
          : "A change could not be applied.",
      findings: [],
    };
  }
}

/** What a person sees of the draft, without timestamps or origins. */
function visibleResumeSignature(draft: ResumeDraft): string {
  return JSON.stringify(
    draft.sections.map((section) => [
      section.id,
      section.included,
      section.text ?? null,
      section.bullets.map((bullet) => [
        bullet.id,
        bullet.text,
        bullet.included,
      ]),
      section.entries.map((entry) => [
        entry.id,
        entry.included,
        entry.summary ?? null,
        entry.bullets.map((bullet) => [
          bullet.id,
          bullet.text,
          bullet.included,
        ]),
      ]),
    ]),
  );
}

/**
 * Changes that leave no visible trace once the resume is saved. The save
 * cleanup removes a skill that is neither in the saved profile nor named in
 * the listing (and listing text copied as a claim, keyword stuffing, repeated
 * lines); a change that sets what is already there changes nothing. Either
 * way, accepting it used to report "Applied" while the preview stayed the
 * same.
 */
export function findResumeAssistantPatchesDroppedOnSave(input: {
  baselineDraft: ResumeDraft;
  patches: readonly ResumeDraftPatch[];
  job: SavedJob;
  profile: CandidateProfile;
}): { patchId: string; message: string }[] {
  const sanitize = (draft: ResumeDraft) =>
    sanitizeResumeDraft({ draft, job: input.job, profile: input.profile });
  const baselineSignature = visibleResumeSignature(
    sanitize(input.baselineDraft),
  );
  const dropped: { patchId: string; message: string }[] = [];
  for (const patch of input.patches) {
    let changed: ResumeDraft;
    try {
      changed = applyPatchToResumeDraft({
        draft: input.baselineDraft,
        patch: {
          ...patch,
          draftId: input.baselineDraft.id,
          origin: "assistant",
        },
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Depends on another change in the set (an anchor it inserts); the
      // combined check reports anything wrong with it.
      continue;
    }
    if (visibleResumeSignature(sanitize(changed)) !== baselineSignature) {
      continue;
    }
    const unchangedBeforeCleanup =
      visibleResumeSignature(changed) ===
      visibleResumeSignature(input.baselineDraft);
    dropped.push({
      patchId: patch.id,
      message: unchangedBeforeCleanup
        ? "This change sets what the resume already has, so it changes nothing."
        : patch.operation === "insert_bullet" ||
            patch.operation === "update_bullet"
          ? `"${patch.newText ?? "This line"}" would be removed when the resume is saved: a skill has to be in the saved profile or named in this job's listing, and listing wording, keyword lists, and repeated lines are removed.`
          : "This change would be undone when the resume is saved, because the save cleanup removes the wording it adds.",
    });
  }
  return dropped;
}

/**
 * The lines on this draft still waiting for the person's Keep or Remove, in
 * the shape the Assistant reads.
 */
export function listResumeLinesToConfirm(input: {
  draft: Pick<ResumeDraft, "id" | "claimConfirmations">;
  claimAssessments: readonly ResumeClaimAssessment[];
}): {
  text: string;
  sectionId: string;
  entryId: string | null;
  bulletId: string | null;
}[] {
  return input.claimAssessments
    .filter((assessment) =>
      isBlockingResumeClaimAssessment({ assessment, draft: input.draft }),
    )
    .map((assessment) => ({
      text: assessment.claimText,
      sectionId: assessment.sectionId,
      entryId: assessment.entryId ?? null,
      bulletId: assessment.bulletId ?? null,
    }));
}
