import type {
  JobFinderSetResumeClaimConfirmationInput,
  ResumeClaimAssessment,
  ResumeDraft,
} from "@nordri/contracts";
import {
  isResumeClaimAssessmentApprovable,
  resumeClaimOwnershipStatement,
} from "@nordri/contracts";

/**
 * Approving a flagged line as accurate. Only an unbacked generated line can
 * hold a resume back, and generation settles those itself, so this is the
 * rare manual path from the issue list; stretches chosen with Aggressive
 * never need it (ADR 0018).
 */
export type ResumeClaimConfirmationRequest =
  | {
      intent: "add";
      target: Pick<
        ResumeClaimAssessment,
        "field" | "sectionId" | "entryId" | "bulletId" | "contentHash"
      >;
    }
  | {
      intent: "add_many";
      targets: readonly Pick<
        ResumeClaimAssessment,
        "field" | "sectionId" | "entryId" | "bulletId" | "contentHash"
      >[];
    }
  | { intent: "remove"; confirmationId: string };

function findProjectedAssessment(input: {
  captured: Pick<
    ResumeClaimAssessment,
    "field" | "sectionId" | "entryId" | "bulletId" | "contentHash"
  >;
  claimAssessments: readonly ResumeClaimAssessment[];
}): ResumeClaimAssessment | null {
  const captured = input.captured;

  return (
    input.claimAssessments.find(
      (candidate) =>
        candidate.field === captured.field &&
        candidate.sectionId === captured.sectionId &&
        (candidate.entryId ?? null) === (captured.entryId ?? null) &&
        (candidate.bulletId ?? null) === (captured.bulletId ?? null) &&
        candidate.contentHash === captured.contentHash,
    ) ?? null
  );
}

/**
 * Builds the typed command from the current saved snapshot. The request only
 * carries identity (locator plus hash, or confirmation id); if that identity no
 * longer matches the projection the builder returns null so the caller shows a
 * truthful stale error instead of submitting a doomed command.
 */
export function buildResumeClaimConfirmationCommandInput(input: {
  claimAssessments: readonly ResumeClaimAssessment[];
  draft: Pick<ResumeDraft, "id" | "updatedAt" | "claimConfirmations">;
  jobId: string;
  request: ResumeClaimConfirmationRequest;
}): JobFinderSetResumeClaimConfirmationInput | null {
  const request = input.request;
  if (request.intent === "remove") {
    const confirmation = input.draft.claimConfirmations.find(
      (candidate) =>
        candidate.id === request.confirmationId &&
        candidate.draftId === input.draft.id,
    );

    if (!confirmation) {
      return null;
    }

    return {
      intent: "remove",
      jobId: input.jobId,
      draftId: input.draft.id,
      expectedDraftUpdatedAt: input.draft.updatedAt,
      confirmationId: confirmation.id,
    };
  }

  if (request.intent === "add_many") {
    const assessments = request.targets.map((target) =>
      findProjectedAssessment({
        captured: target,
        claimAssessments: input.claimAssessments,
      }),
    );
    if (
      assessments.some(
        (assessment) =>
          !assessment || !isResumeClaimAssessmentApprovable(assessment),
      )
    ) {
      return null;
    }

    return {
      intent: "add_many",
      jobId: input.jobId,
      draftId: input.draft.id,
      expectedDraftUpdatedAt: input.draft.updatedAt,
      ownershipStatement: resumeClaimOwnershipStatement,
      targets: assessments.map((assessment) => ({
        field: assessment!.field,
        sectionId: assessment!.sectionId,
        entryId: assessment!.entryId,
        bulletId: assessment!.bulletId,
        confirmedClaimContentHash: assessment!.contentHash,
      })),
    };
  }

  const assessment = findProjectedAssessment({
    captured: request.target,
    claimAssessments: input.claimAssessments,
  });

  if (!assessment || !isResumeClaimAssessmentApprovable(assessment)) {
    return null;
  }

  return {
    intent: "add",
    jobId: input.jobId,
    draftId: input.draft.id,
    expectedDraftUpdatedAt: input.draft.updatedAt,
    field: assessment.field,
    sectionId: assessment.sectionId,
    entryId: assessment.entryId,
    bulletId: assessment.bulletId,
    confirmedClaimContentHash: assessment.contentHash,
    ownershipStatement: resumeClaimOwnershipStatement,
  };
}
