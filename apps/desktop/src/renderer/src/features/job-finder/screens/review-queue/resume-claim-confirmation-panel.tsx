import { useState } from "react";
import type {
  JobFinderSetResumeClaimConfirmationInput,
  ResumeClaimAssessment,
  ResumeClaimConfirmation,
  ResumeDraft,
} from "@nordri/contracts";
import {
  isBlockingResumeClaimAssessment,
  isCurrentResumeClaimVerifier,
  isResumeClaimAssessmentApprovable,
  isResumeSkillClaimAssessment,
  resumeClaimOwnershipStatement,
} from "@nordri/contracts";
import { Button } from "@renderer/components/ui/button";
import { StatusBadge } from "../../components/status-badge";
import { formatResumeClaimLocatorLabel } from "./resume-assistant-proposal-provenance";

const STALE_PROJECTION_ERROR =
  "This wording no longer matches the saved resume. Reload and try again.";

const UNKNOWN_FAILURE_ERROR =
  "That did not save. Reload the resume and try again.";

/**
 * Mirrors the export gate's matcher exactly: only the same draft, locator
 * (field, section, entry, bullet), and confirmed normalized-content hash count.
 * Origin alone never satisfies a row.
 */
export function matchResumeClaimConfirmation(input: {
  assessment: ResumeClaimAssessment;
  confirmations: readonly ResumeClaimConfirmation[];
  draftId: string;
}): ResumeClaimConfirmation | null {
  return (
    input.confirmations.find(
      (confirmation) =>
        confirmation.draftId === input.draftId &&
        confirmation.field === input.assessment.field &&
        confirmation.sectionId === input.assessment.sectionId &&
        confirmation.entryId === input.assessment.entryId &&
        confirmation.bulletId === input.assessment.bulletId &&
        confirmation.confirmedClaimContentHash === input.assessment.contentHash,
    ) ?? null
  );
}

/**
 * Every line the person decides on here: the current verifier's
 * `confirm_needed` claims, kept or not (a kept line stays visible so the
 * decision is reversible). Stale-verifier rows must revalidate first, so they
 * never appear. Claims that contradict the evidence stay in the validation
 * list, where Edit, Restore previous text, and Approve as accurate live.
 *
 * One list, on purpose. The same line used to appear twice: once as a
 * "confirm this wording" row and once as a "Blocks approval" validation row
 * with a different verb, and people finished one list and were told the
 * other still blocked them.
 */
/** The start of a flagged line, short enough for a control's name. */
export function abbreviateClaimText(text: string, maxLength = 60): string {
  const flattened = text.replace(/\s+/gu, " ").trim();
  return flattened.length > maxLength
    ? `${flattened.slice(0, maxLength).replace(/\s+\S*$/u, "")}…`
    : flattened;
}

export function listDecidableClaimAssessments(
  claimAssessments: readonly ResumeClaimAssessment[],
): ResumeClaimAssessment[] {
  return claimAssessments.filter(
    (assessment) =>
      assessment.status === "confirm_needed" &&
      isCurrentResumeClaimVerifier(assessment.verifier),
  );
}

/** Alias kept for callers that named the subset by its verdict. */
export const listConfirmNeededClaimAssessments = listDecidableClaimAssessments;

/**
 * Validation issues that only restate a line in the decision list, so the
 * issue list does not print them a second time with a different verb.
 */
export function isClaimIssueCoveredByDecisionList(
  issueId: string,
  claimAssessments: readonly ResumeClaimAssessment[],
): boolean {
  const decidable = listDecidableClaimAssessments(claimAssessments);
  if (decidable.length === 0) {
    return false;
  }
  const confirmationPrefix = "issue_claim_confirmation_";
  const groundingPrefix = "issue_claim_grounding_";
  const assessmentId = issueId.startsWith(confirmationPrefix)
    ? issueId.slice(confirmationPrefix.length)
    : issueId.startsWith(groundingPrefix)
      ? issueId.slice(groundingPrefix.length)
      : null;
  return (
    assessmentId !== null &&
    decidable.some((assessment) => assessment.id === assessmentId)
  );
}

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

interface ResumeClaimConfirmationPanelProps {
  claimAssessments: readonly ResumeClaimAssessment[];
  /** The saved workspace draft; confirmations and revisions describe it. */
  draft: ResumeDraft;
  hasUnsavedChanges: boolean;
  isWorkspacePending: boolean;
  jobId: string;
  onSetResumeClaimConfirmation: (
    input: JobFinderSetResumeClaimConfirmationInput,
  ) => Promise<unknown>;
  /**
   * Removes the line from the resume. Present only for a line the draft
   * patch schema can remove: a bullet, including every added core skill.
   */
  onRejectClaim?: (assessment: ResumeClaimAssessment) => void;
  /** Opens the line in the editor so the person can reword it. */
  onEditClaim?: (assessment: ResumeClaimAssessment) => void;
}

function buildAddRequestKey(
  target: Pick<
    ResumeClaimAssessment,
    "field" | "sectionId" | "entryId" | "bulletId" | "contentHash"
  >,
): string {
  return [
    "add",
    target.field,
    target.sectionId,
    target.entryId ?? "",
    target.bulletId ?? "",
    target.contentHash,
  ].join(":");
}

/**
 * "Lines to confirm": every line that stretches past the saved evidence, in
 * one list with two verbs, Keep and Remove. Keeping a line records the
 * ownership statement for that exact wording (ADR 0018); editing the line
 * clears it. Skills the job asked for can be kept together; wording lines
 * are kept one at a time, because each is a separate claim the person is
 * making.
 */
export function ResumeClaimConfirmationPanel(
  props: ResumeClaimConfirmationPanelProps,
) {
  const [pendingRequestKey, setPendingRequestKey] = useState<string | null>(
    null,
  );
  const [feedback, setFeedback] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);

  const assessments = listDecidableClaimAssessments(props.claimAssessments);

  if (assessments.length === 0) {
    return null;
  }

  const rows = assessments.map((assessment) => ({
    assessment,
    confirmation: matchResumeClaimConfirmation({
      assessment,
      confirmations: props.draft.claimConfirmations,
      draftId: props.draft.id,
    }),
    blocking: isBlockingResumeClaimAssessment({
      assessment,
      draft: props.draft,
    }),
    requestKey: buildAddRequestKey(assessment),
    targetLabel: formatResumeClaimLocatorLabel({
      draft: props.draft,
      locator: assessment,
    }),
    isSkill: isResumeSkillClaimAssessment(props.draft, assessment),
  }));
  const skillRows = rows.filter((row) => row.isSkill);
  const wordingRows = rows.filter((row) => !row.isSkill);
  const undecidedCount = rows.filter((row) => row.blocking).length;
  const undecidedSkillTargets = skillRows
    .filter((row) => row.blocking)
    .map((row) => row.assessment);
  const requestInFlight =
    pendingRequestKey !== null || props.isWorkspacePending;

  const runRequest = async (
    request: ResumeClaimConfirmationRequest,
    requestKey: string,
    successMessage: string | null,
  ) => {
    if (pendingRequestKey !== null || props.isWorkspacePending) {
      return;
    }

    const commandInput = buildResumeClaimConfirmationCommandInput({
      claimAssessments: props.claimAssessments,
      draft: props.draft,
      jobId: props.jobId,
      request,
    });

    if (!commandInput) {
      setFeedback({ kind: "error", message: STALE_PROJECTION_ERROR });
      return;
    }

    setFeedback(null);
    setPendingRequestKey(requestKey);

    try {
      await props.onSetResumeClaimConfirmation(commandInput);
      if (successMessage) {
        setFeedback({ kind: "success", message: successMessage });
      }
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : UNKNOWN_FAILURE_ERROR,
      });
    } finally {
      setPendingRequestKey(null);
    }
  };

  const renderControls = (row: (typeof rows)[number]) => {
    // A screen reader hears the line itself, not only where it sits:
    // "Keep · Core Skills · Bullet 4" did not say which skill was kept.
    const lineName = `“${abbreviateClaimText(row.assessment.claimText)}” · ${row.targetLabel}`;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {row.confirmation ? (
          <Button
            aria-label={`Undo keeping ${lineName}`}
            disabled={requestInFlight}
            onClick={() => {
              void runRequest(
                {
                  intent: "remove",
                  confirmationId: row.confirmation!.id,
                },
                `remove:${row.confirmation!.id}`,
                null,
              );
            }}
            pending={requestInFlight}
            size="compact"
            type="button"
            variant="ghost"
          >
            Undo
          </Button>
        ) : (
          <>
            {/* Pending keeps the control exposed but inert instead of natively
              disabled, so focus survives the in-flight request. */}
            <Button
              aria-label={`Keep ${lineName}`}
              data-resume-claim-keep={row.requestKey}
              disabled={requestInFlight}
              onClick={() => {
                void runRequest(
                  { intent: "add", target: row.assessment },
                  row.requestKey,
                  null,
                );
              }}
              pending={requestInFlight}
              size="compact"
              type="button"
              variant="primary"
            >
              Keep
            </Button>
            {props.onRejectClaim && row.assessment.bulletId ? (
              <Button
                aria-label={`Remove ${lineName}`}
                data-resume-claim-reject={row.requestKey}
                disabled={requestInFlight}
                onClick={() => props.onRejectClaim?.(row.assessment)}
                size="compact"
                type="button"
                variant="secondary"
              >
                Remove
              </Button>
            ) : null}
            {props.onEditClaim && !row.isSkill ? (
              <Button
                aria-label={`Edit ${lineName}`}
                data-resume-claim-edit={row.requestKey}
                disabled={requestInFlight}
                onClick={() => props.onEditClaim?.(row.assessment)}
                size="compact"
                type="button"
                variant="ghost"
              >
                Edit
              </Button>
            ) : null}
          </>
        )}
      </div>
    );
  };

  const renderSkillRow = (row: (typeof rows)[number]) => (
    <li
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) px-2.5 py-1.5 text-(length:--text-small) leading-5"
      data-resume-claim-confirmation-row={row.requestKey}
      data-resume-claim-kept={row.confirmation ? "true" : undefined}
      key={row.assessment.id}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words font-medium text-(length:--text-body) leading-6 text-(--text-headline)">
          {row.assessment.claimText}
        </span>
        {row.confirmation ? (
          <StatusBadge tone="positive">Kept</StatusBadge>
        ) : null}
      </div>
      {renderControls(row)}
    </li>
  );

  const renderWordingRow = (row: (typeof rows)[number]) => (
    <li
      className="grid min-w-0 gap-1.5 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) px-2.5 py-2 text-(length:--text-small) leading-5"
      data-resume-claim-confirmation-row={row.requestKey}
      data-resume-claim-kept={row.confirmation ? "true" : undefined}
      key={row.assessment.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 grid gap-0.5">
          <span className="text-foreground-muted">{row.targetLabel}</span>
          <span className="min-w-0 break-words text-(length:--text-body) leading-6 text-(--text-headline)">
            {row.assessment.claimText}
          </span>
        </span>
        {row.confirmation ? (
          <StatusBadge tone="positive">Kept</StatusBadge>
        ) : null}
      </div>
      {renderControls(row)}
    </li>
  );

  return (
    <section
      aria-labelledby="resume-claim-confirmation-heading"
      className="grid min-w-0 gap-3 rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface)/40 px-4 py-3"
      data-resume-claim-confirmations
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          className="font-display text-(--text-headline)"
          id="resume-claim-confirmation-heading"
        >
          Lines to confirm
        </h3>
        <StatusBadge tone={undecidedCount > 0 ? "warning" : "positive"}>
          {undecidedCount > 0 ? `${undecidedCount} to decide` : "All decided"}
        </StatusBadge>
      </div>
      <p aria-live="polite" role="status">
        {undecidedCount > 0
          ? "These lines go a little past what your saved evidence proves, to help this resume clear screening. Keep the ones you can back up in an interview and remove the rest. Keeping a line records that it is accurate and your own."
          : props.draft.status === "approved" && !props.hasUnsavedChanges
            ? "Every line is decided. This resume is approved."
            : "Every line is decided. Approve the resume when you are ready."}
      </p>
      {props.hasUnsavedChanges ? (
        <p
          className="rounded-(--radius-field) border border-(--warning-border) bg-(--warning-surface) p-3 text-(length:--text-small) leading-5 text-(--warning-text)"
          role="status"
        >
          This list describes the last saved version. Save your edits to refresh
          it.
        </p>
      ) : null}
      {feedback ? (
        <p
          className={
            feedback.kind === "error"
              ? "rounded-(--radius-field) border border-destructive/30 bg-destructive/10 p-3 text-(length:--text-small) leading-5 text-destructive"
              : "rounded-(--radius-field) border border-positive/30 bg-positive/10 p-3 text-(length:--text-small) leading-5 text-positive"
          }
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}
      {skillRows.length > 0 ? (
        <div className="grid min-w-0 gap-2" data-resume-claim-confirm-skills>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-medium text-(--text-headline)">
              Skills the job asked for
            </h4>
            {undecidedSkillTargets.length >= 2 ? (
              <Button
                aria-label={`Keep all ${undecidedSkillTargets.length} skills`}
                data-resume-claim-confirm-all-skills
                disabled={requestInFlight}
                onClick={() => {
                  void runRequest(
                    {
                      intent: "add_many",
                      targets: undecidedSkillTargets,
                    },
                    "add_many:skills",
                    null,
                  );
                }}
                pending={requestInFlight}
                size="compact"
                type="button"
                variant="primary"
              >
                Keep all {undecidedSkillTargets.length}
              </Button>
            ) : null}
          </div>
          <ul className="grid min-w-0 gap-1.5">
            {skillRows.map(renderSkillRow)}
          </ul>
        </div>
      ) : null}
      {wordingRows.length > 0 ? (
        <div className="grid min-w-0 gap-2" data-resume-claim-confirm-wording>
          <h4 className="font-medium text-(--text-headline)">
            Wording that stretches your evidence
          </h4>
          <ul className="grid min-w-0 gap-1.5">
            {wordingRows.map(renderWordingRow)}
          </ul>
        </div>
      ) : null}
      <p className="text-(length:--text-tiny) leading-4 text-foreground-muted">
        Keep records: “{resumeClaimOwnershipStatement}”
      </p>
    </section>
  );
}
