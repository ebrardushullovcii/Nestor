import { useState } from "react";
import type {
  ResumeClaimAssessment,
  ResumeDraft,
  ResumeDraftOrigin,
  ResumeValidationResult,
} from "@nordri/contracts";
import { isBlockingResumeClaimAssessment } from "@nordri/contracts";
import { Button } from "@renderer/components/ui/button";
import { StatusBadge } from "../../components/status-badge";

const INITIAL_VISIBLE_CLAIMS = 6;
const CLAIM_PAGE_SIZE = 6;
type ClaimDraft = Pick<ResumeDraft, "id" | "claimConfirmations">;

// The export gate's own rule, so a line the person approved stops counting
// and their own edits are counted as theirs, not as "generated" blockers.
function isBlockingClaim(claim: ResumeClaimAssessment, draft: ClaimDraft) {
  return isBlockingResumeClaimAssessment({ assessment: claim, draft });
}

/**
 * What a line is, as the person reads it.
 *
 * A claim marked "Exact evidence" is their own sentence, kept word for word;
 * the origin field only records which pass last touched it, so printing
 * "AI generated" beside "EXACT EVIDENCE" told them their own wording had been
 * written for them. A verbatim line is credited to them.
 */
function formatOriginLabel(claim: ResumeClaimAssessment) {
  if (claim.status === "exact") {
    return "Your wording, kept word for word";
  }
  return formatDraftOriginLabel(claim.claimOrigin);
}

function formatDraftOriginLabel(origin: ResumeDraftOrigin) {
  switch (origin) {
    case "ai_generated":
      return "AI generated";
    case "assistant_edited":
      return "Assistant edited";
    case "deterministic_fallback":
      return "Generated fallback";
    case "user_edited":
      return "Your edit";
    case "imported":
      return "Imported";
  }
}

function formatEvidenceKind(
  kind: ResumeClaimAssessment["evidenceRefs"][number]["sourceKind"],
) {
  switch (kind) {
    case "resume":
      return "Original resume";
    case "profile":
      return "Profile";
    case "proof":
      return "Saved proof";
    case "user":
      return "Your input";
  }
}

function getStatusPresentation(
  claim: ResumeClaimAssessment,
  draft: ClaimDraft,
) {
  const approved = draft.claimConfirmations.some(
    (confirmation) =>
      confirmation.draftId === draft.id &&
      confirmation.field === claim.field &&
      confirmation.sectionId === claim.sectionId &&
      confirmation.entryId === claim.entryId &&
      confirmation.bulletId === claim.bulletId &&
      confirmation.confirmedClaimContentHash === claim.contentHash,
  );
  if (approved && claim.status !== "exact" && claim.status !== "paraphrase") {
    return {
      label: "Approved by you",
      tone: "positive" as const,
      explanation: "You approved this exact wording as accurate.",
    };
  }
  if (claim.status === "exact") {
    return {
      label: "Exact evidence",
      tone: "positive" as const,
      explanation: "Matches candidate evidence directly.",
    };
  }
  if (claim.status === "paraphrase") {
    return {
      label: "Supported paraphrase",
      tone: "active" as const,
      explanation: "Reworded, with candidate evidence linked below.",
    };
  }
  // Only a generated line the evidence contradicts asks for a decision; a
  // stretch, an unchecked line and the person's own edit never do.
  if (claim.status === "confirm_needed") {
    return {
      label: "Aggressive stretch",
      tone: "neutral" as const,
      explanation:
        "A deliberate stretch from Aggressive tailoring. Edit or remove it if you would rather not use it.",
    };
  }
  if (claim.claimOrigin === "user_edited") {
    return {
      label: "Yours",
      tone: "neutral" as const,
      explanation: "Your own wording.",
    };
  }
  if (claim.status === "review") {
    return {
      label: "Not checked",
      tone: "neutral" as const,
      explanation: "The AI has not checked this line yet.",
    };
  }
  return {
    label: "Needs your decision",
    tone: "critical" as const,
    explanation:
      "Your saved evidence does not show this. Edit it, or approve it as accurate in Tools if you can stand behind it.",
  };
}

function claimPriority(claim: ResumeClaimAssessment, draft: ClaimDraft) {
  if (isBlockingClaim(claim, draft)) return 0;
  if (claim.status === "review") return 1;
  return 2;
}

export function ResumeClaimTrustPanel(props: {
  draft: ClaimDraft;
  hasUnsavedChanges: boolean;
  validation: ResumeValidationResult | null;
}) {
  const [visibleClaimCount, setVisibleClaimCount] = useState(
    INITIAL_VISIBLE_CLAIMS,
  );
  const assessments = props.validation?.claimAssessments ?? [];

  if (assessments.length === 0) {
    return (
      <section
        aria-label="Resume claim trust"
        className="surface-card-tint grid min-w-0 gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-muted-foreground">
            Claim trust
          </p>
          <StatusBadge tone="muted">Not checked</StatusBadge>
        </div>
        <p className="text-sm leading-6 text-foreground-soft">
          Save and validate this draft to check each visible claim against your
          resume, profile, proofs, and direct input.
        </p>
      </section>
    );
  }

  const orderedAssessments = assessments
    .map((claim, index) => ({ claim, index }))
    .sort(
      (left, right) =>
        claimPriority(left.claim, props.draft) -
          claimPriority(right.claim, props.draft) || left.index - right.index,
    )
    .map(({ claim }) => claim);
  const blocking = assessments.filter((claim) =>
    isBlockingClaim(claim, props.draft),
  );
  const blockingCount = blocking.length;
  const supportedCount = assessments.filter(
    (claim) => claim.status === "exact" || claim.status === "paraphrase",
  ).length;
  const visibleAssessments = orderedAssessments.slice(0, visibleClaimCount);
  const remainingCount = assessments.length - visibleAssessments.length;

  return (
    <section
      aria-label="Resume claim trust"
      className="surface-card-tint grid min-w-0 gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-4 xl:col-span-full"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-muted-foreground">
            Claim trust
          </p>
          <p className="text-sm leading-6 text-foreground-soft">
            Candidate evidence only. Job descriptions and company research do
            not count as proof about you.
          </p>
        </div>
        <StatusBadge tone={blockingCount > 0 ? "critical" : "positive"}>
          {blockingCount > 0 ? `${blockingCount} blocking` : "Nothing blocking"}
        </StatusBadge>
      </div>

      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        {[
          ["Supported", supportedCount],
          ["Lines to decide", blockingCount],
        ].map(([label, value]) => (
          <div
            className="rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) p-3"
            key={label}
          >
            <dt className="text-foreground-muted">{label}</dt>
            <dd className="mt-1 font-display text-lg font-semibold text-foreground">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {props.hasUnsavedChanges ? (
        <p
          className="text-(length:--text-small) leading-6 text-foreground-muted"
          role="status"
        >
          These checks describe the last saved draft. Save your edits to refresh
          claim evidence.
        </p>
      ) : null}

      <div className="grid gap-2">
        {visibleAssessments.map((claim) => {
          const presentation = getStatusPresentation(claim, props.draft);
          return (
            <details
              className="group min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) p-3 [&_summary::-webkit-details-marker]:hidden"
              key={claim.id}
            >
              <summary className="grid min-w-0 cursor-pointer list-none gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <span className="min-w-0 text-sm leading-6 text-foreground">
                  <span className="line-clamp-2 break-words">
                    {claim.claimText}
                  </span>
                  <span className="mt-1 block text-(length:--text-small) text-foreground-muted">
                    {formatOriginLabel(claim)}
                  </span>
                </span>
                <StatusBadge tone={presentation.tone}>
                  {presentation.label}
                </StatusBadge>
              </summary>
              <div className="mt-3 grid gap-3 border-t border-(--surface-panel-border) pt-3 text-sm">
                <p className="leading-6 text-foreground-soft">
                  {presentation.explanation}
                </p>
                {claim.evidenceRefs.length > 0 ? (
                  <ul aria-label="Candidate evidence" className="grid gap-2">
                    {claim.evidenceRefs.slice(0, 3).map((evidence) => (
                      <li
                        className="min-w-0 rounded-(--radius-field) bg-background/60 p-3"
                        key={evidence.id}
                      >
                        <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-muted-foreground">
                          {formatEvidenceKind(evidence.sourceKind)}
                        </p>
                        <p className="mt-1 break-words leading-6 text-foreground-soft">
                          {evidence.snippet}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="font-medium text-critical">
                    No candidate evidence is linked to this claim.
                  </p>
                )}
              </div>
            </details>
          );
        })}
      </div>

      {remainingCount > 0 ? (
        <Button
          className="w-full sm:w-fit"
          onClick={() =>
            setVisibleClaimCount((current) => current + CLAIM_PAGE_SIZE)
          }
          size="compact"
          type="button"
          variant="secondary"
        >
          Show {Math.min(CLAIM_PAGE_SIZE, remainingCount)} more claims
        </Button>
      ) : null}
    </section>
  );
}
