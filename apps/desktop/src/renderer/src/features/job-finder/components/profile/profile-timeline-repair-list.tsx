import type {
  CandidateExperience,
  ResumeTimelineRepairAction,
  ResumeTimelineRepairProposal,
} from "@nestor/contracts";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@renderer/components/ui/button";

function formatIssueKind(value: ResumeTimelineRepairProposal["issueKind"]) {
  return value.replaceAll("_", " ");
}

function formatExperience(experience: CandidateExperience): string {
  const identity = [experience.title, experience.companyName]
    .filter(Boolean)
    .join(" at ");
  const dates = [experience.startDate, experience.endDate]
    .filter(Boolean)
    .join(" – ");
  const location = experience.location?.trim();

  return [identity || "Untitled experience", dates, location]
    .filter(Boolean)
    .join(" · ");
}

function ExperienceList(props: {
  experiences: readonly CandidateExperience[];
  label: string;
}) {
  return (
    <div className="grid gap-1.5">
      <p className="text-(length:--text-eyebrow) font-medium uppercase tracking-(--tracking-mono) text-foreground-muted">
        {props.label}
      </p>
      <ul className="grid gap-1 text-sm leading-6 text-foreground-soft">
        {props.experiences.map((experience) => (
          <li key={experience.id}>{formatExperience(experience)}</li>
        ))}
      </ul>
    </div>
  );
}

function TimelineRepairCard(props: {
  onAction: (
    proposalId: string,
    action: ResumeTimelineRepairAction,
  ) => Promise<void>;
  proposal: ResumeTimelineRepairProposal;
}) {
  const { onAction, proposal } = props;
  const [pendingAction, setPendingAction] =
    useState<ResumeTimelineRepairAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAction(action: ResumeTimelineRepairAction) {
    setError(null);
    setPendingAction(action);

    try {
      await onAction(proposal.id, action);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "This timeline change could not be saved. Refresh and try again.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  const isPending = pendingAction !== null;

  return (
    <li className="grid gap-4 rounded-(--radius-field) border border-(--surface-well-border) bg-(--surface-well) p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <strong className="text-sm text-(--text-headline)">
            {proposal.title}
          </strong>
          <p className="text-sm leading-6 text-foreground-muted">
            {proposal.explanation}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full border border-border-subtle px-2.5 py-1 text-(length:--text-tiny) font-medium uppercase tracking-[0.12em] text-foreground-muted">
            {formatIssueKind(proposal.issueKind)}
          </span>
          <span className="rounded-full border border-border-subtle px-2.5 py-1 text-(length:--text-tiny) font-medium uppercase tracking-[0.12em] text-foreground-muted">
            {proposal.certainty === "deterministic_normalization"
              ? "Evidence-preserving change"
              : "Review only"}
          </span>
          <span className="rounded-full border border-border-subtle px-2.5 py-1 text-(length:--text-tiny) font-medium uppercase tracking-[0.12em] text-foreground-muted">
            {proposal.status}
          </span>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ExperienceList
          experiences={proposal.beforeExperiences}
          label="Current value"
        />
        <ExperienceList
          experiences={proposal.proposedExperiences}
          label="Proposed value"
        />
      </div>

      <details className="rounded-(--radius-field) border border-border-subtle bg-background/30 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          View cited resume evidence
        </summary>
        <ul className="mt-2 grid gap-2 text-sm leading-6 text-foreground-muted">
          {proposal.evidence.map((evidence) => (
            <li key={evidence.candidateId + ":" + evidence.excerpt}>
              <blockquote>“{evidence.excerpt}”</blockquote>
              {evidence.sourceBlockIds.length > 0 ? (
                <p className="text-(length:--text-tiny)">
                  Source blocks: {evidence.sourceBlockIds.join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </details>

      {error ? (
        <p
          className="rounded-(--radius-field) border border-critical/35 bg-critical/10 px-3 py-2 text-sm text-critical"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {proposal.status === "pending" ? (
          <>
            <Button
              disabled={isPending}
              onClick={() => void handleAction("accept")}
              pending={pendingAction === "accept"}
              type="button"
              variant="primary"
            >
              {proposal.certainty === "review_only"
                ? "Accept as reviewed"
                : "Accept proposed change"}
            </Button>
            <Button
              disabled={isPending}
              onClick={() => void handleAction("reject")}
              pending={pendingAction === "reject"}
              type="button"
              variant="secondary"
            >
              Reject
            </Button>
          </>
        ) : (
          <Button
            disabled={isPending}
            onClick={() => void handleAction("undo")}
            pending={pendingAction === "undo"}
            type="button"
            variant="secondary"
          >
            <RotateCcw className="size-4" />
            Undo {proposal.status}
          </Button>
        )}
      </div>
    </li>
  );
}

export function ProfileTimelineRepairList(props: {
  onAction: (
    proposalId: string,
    action: ResumeTimelineRepairAction,
  ) => Promise<void>;
  proposals: readonly ResumeTimelineRepairProposal[];
}) {
  if (props.proposals.length === 0) {
    return null;
  }

  return (
    <section className="grid gap-3" aria-labelledby="timeline-repair-heading">
      <div className="grid gap-1">
        <p
          className="text-sm font-medium text-foreground"
          id="timeline-repair-heading"
        >
          Work history timeline review
        </p>
        <p className="text-sm leading-6 text-foreground-muted">
          Compare each suggestion with the cited resume evidence. Every choice
          is independent and reversible.
        </p>
      </div>
      <ul className="grid gap-3">
        {props.proposals.map((proposal) => (
          <TimelineRepairCard
            key={proposal.id}
            onAction={props.onAction}
            proposal={proposal}
          />
        ))}
      </ul>
    </section>
  );
}
