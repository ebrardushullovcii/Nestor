import type {
  JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  ResumeDraft,
  ResumeCoverageRoleComparison,
  WorkHistoryReviewAcknowledgment,
  WorkHistoryReviewSuggestion,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";

import { describeReviewRole } from "./resume-review-context";

type DraftAcknowledgments = ResumeDraft["workHistoryReviewAcknowledgments"];

export type ResumeWorkHistoryDecisionRequest =
  | {
      intent: "acknowledge";
      suggestion: Pick<
        WorkHistoryReviewSuggestion,
        "id" | "profileRecordId" | "kind" | "action" | "messageContentHash"
      >;
    }
  | {
      intent: "remove";
      acknowledgmentId: string;
    };

export function isWorkHistoryOmissionDecisionSuggestion<
  T extends Pick<WorkHistoryReviewSuggestion, "kind" | "action">,
>(
  suggestion: T,
): suggestion is T & {
  kind: "weak_fit" | "gap_coverage";
  action: "consider_showing";
} {
  return (
    (suggestion.kind === "weak_fit" || suggestion.kind === "gap_coverage") &&
    suggestion.action === "consider_showing"
  );
}

export function matchWorkHistoryOmissionDecisionAcknowledgment(input: {
  draftId: string;
  suggestion: WorkHistoryReviewSuggestion;
  acknowledgments: DraftAcknowledgments;
}): WorkHistoryReviewAcknowledgment | null {
  return (
    input.acknowledgments.find(
      (acknowledgment) =>
        acknowledgment.draftId === input.draftId &&
        acknowledgment.profileRecordId === input.suggestion.profileRecordId &&
        acknowledgment.kind === input.suggestion.kind &&
        acknowledgment.action === input.suggestion.action &&
        acknowledgment.messageContentHash ===
          input.suggestion.messageContentHash,
    ) ?? null
  );
}

export function listUnresolvedWorkHistoryOmissionSuggestions(input: {
  draftId: string;
  suggestions: readonly WorkHistoryReviewSuggestion[];
  acknowledgments: DraftAcknowledgments;
}): WorkHistoryReviewSuggestion[] {
  return input.suggestions.filter(
    (suggestion) =>
      isWorkHistoryOmissionDecisionSuggestion(suggestion) &&
      !matchWorkHistoryOmissionDecisionAcknowledgment({
        draftId: input.draftId,
        suggestion,
        acknowledgments: input.acknowledgments,
      }),
  );
}

export function buildWorkHistoryReviewAcknowledgmentCommandInput(input: {
  jobId: string;
  draft: Pick<ResumeDraft, "id" | "updatedAt"> & {
    workHistoryReviewAcknowledgments: DraftAcknowledgments;
  };
  suggestions: readonly WorkHistoryReviewSuggestion[];
  decision: ResumeWorkHistoryDecisionRequest;
}): JobFinderSetWorkHistoryReviewAcknowledgmentInput | null {
  const { decision } = input;

  if (decision.intent === "remove") {
    const acknowledgmentId = decision.acknowledgmentId;
    const acknowledgment = input.draft.workHistoryReviewAcknowledgments.find(
      (candidate) => candidate.id === acknowledgmentId,
    );

    if (!acknowledgment || acknowledgment.draftId !== input.draft.id) {
      return null;
    }

    return {
      intent: "remove",
      jobId: input.jobId,
      draftId: input.draft.id,
      expectedDraftUpdatedAt: input.draft.updatedAt,
      acknowledgmentId: acknowledgment.id,
    };
  }

  const captured = decision.suggestion;
  const suggestion = input.suggestions.find(
    (candidate) => candidate.id === captured.id,
  );

  if (!suggestion || !isWorkHistoryOmissionDecisionSuggestion(suggestion)) {
    return null;
  }

  const stillProjected =
    suggestion.profileRecordId === captured.profileRecordId &&
    suggestion.kind === captured.kind &&
    suggestion.action === captured.action &&
    suggestion.messageContentHash === captured.messageContentHash;

  if (!stillProjected) {
    return null;
  }

  return {
    intent: "acknowledge",
    jobId: input.jobId,
    draftId: input.draft.id,
    expectedDraftUpdatedAt: input.draft.updatedAt,
    suggestionId: suggestion.id,
    profileRecordId: suggestion.profileRecordId,
    kind: suggestion.kind,
    action: suggestion.action,
    messageContentHash: suggestion.messageContentHash,
    reason: "intentional_omission",
  };
}

interface ResumeWorkHistoryDecisionsProps {
  sections?: ResumeDraft["sections"];
  roles?: readonly ResumeCoverageRoleComparison[];
  acknowledgments: DraftAcknowledgments;
  disabled: boolean;
  draftId: string;
  suggestions: readonly WorkHistoryReviewSuggestion[];
  onAcknowledge: (suggestion: WorkHistoryReviewSuggestion) => void;
  /**
   * Puts the role back on the resume. Undoing a leave-off used to return the
   * role to "needs a choice", which blocked approval again: the person had
   * decided, and the only way to act on it was to find the entry in the
   * editor. Both choices now sit on the row.
   */
  onIncludeRole?: (suggestion: WorkHistoryReviewSuggestion) => void;
  onRemoveAcknowledgment: (acknowledgmentId: string) => void;
}

/**
 * The roles the writer left off this resume, as a plain list with a way to
 * add any of them back. Which roles show is the writer's call for the job;
 * nothing here asks the person to decide or holds anything back.
 */
export function ResumeWorkHistoryDecisions(
  props: ResumeWorkHistoryDecisionsProps,
) {
  const decisions = props.suggestions.filter(
    isWorkHistoryOmissionDecisionSuggestion,
  );

  if (decisions.length === 0 || !props.onIncludeRole) {
    return null;
  }

  return (
    <section
      aria-labelledby="resume-work-history-decisions-heading"
      className="grid min-w-0 grid-cols-1 gap-1.5 text-(length:--text-small) leading-5 text-foreground-soft"
      data-resume-work-history-decisions
      tabIndex={-1}
    >
      <h3
        className="font-display text-(--text-headline)"
        id="resume-work-history-decisions-heading"
      >
        Left off this resume
      </h3>
      <ul className="grid min-w-0 grid-cols-1 gap-1">
        {decisions.map((suggestion) => {
          const context = describeReviewRole(
            suggestion,
            props.sections ?? [],
            props.roles ?? [],
          );
          return (
            <li
              className="flex min-w-0 flex-wrap items-center justify-between gap-2"
              key={suggestion.id}
            >
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {context.title}
                {context.detail ? (
                  <span className="text-xs"> · {context.detail}</span>
                ) : null}
              </span>
              <Button
                aria-label={`Add back: ${context.title}`}
                data-resume-work-history-include
                disabled={props.disabled}
                onClick={() => props.onIncludeRole?.(suggestion)}
                pending={props.disabled}
                size="compact"
                type="button"
                variant="ghost"
              >
                Add back
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
