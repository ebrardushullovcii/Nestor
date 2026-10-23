import { useState } from "react";
import { CheckCircle2, ChevronDown, Sparkles, Undo2 } from "lucide-react";
import type { ResumeValidationIssue } from "@nestor/contracts";
import {
  getResumeEntryBulletTargetId,
  getResumeEntryFieldTargetId,
  getResumeIdentityTargetId,
  getResumeSectionBulletTargetId,
  getResumeSectionTextTargetId,
  getResumeValidationIssueSeverity,
  isBlockingResumeValidationIssue,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { StatusBadge } from "../../components/status-badge";

const severityRank = {
  error: 0,
  warning: 1,
  info: 2,
} as const;

export function orderResumeValidationIssues(
  issues: readonly ResumeValidationIssue[],
): ResumeValidationIssue[] {
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort(
      (left, right) =>
        severityRank[getResumeValidationIssueSeverity(left.issue)] -
          severityRank[getResumeValidationIssueSeverity(right.issue)] ||
        left.index - right.index,
    )
    .map(({ issue }) => issue);
}

export function countBlockingResumeValidationIssues(
  issues: readonly ResumeValidationIssue[],
): number {
  return issues.filter(isBlockingResumeValidationIssue).length;
}

type ResumeValidationIssueIdentityField = Parameters<
  typeof getResumeIdentityTargetId
>[0];
type ResumeValidationIssueDateField = "startDate" | "endDate" | "isCurrent";

type ResumeValidationIssueTarget =
  | {
      id: string;
      kind: "identity";
      field: ResumeValidationIssueIdentityField;
      label: string;
    }
  | {
      id: string;
      kind: "section-text";
      label: string;
    }
  | {
      id: string;
      kind: "section-bullet";
      label: string;
    }
  | {
      id: string;
      kind: "entry-summary";
      label: string;
    }
  | {
      id: string;
      kind: "entry-bullet";
      label: string;
    }
  | {
      id: string;
      kind: "entry-date";
      field: ResumeValidationIssueDateField;
      label: string;
    };

type ResumeValidationIssueTargetInput = Pick<
  ResumeValidationIssue,
  "sectionId" | "entryId" | "bulletId"
> &
  Partial<Pick<ResumeValidationIssue, "category" | "message">>;

function getIdentityIssueField(
  issue: ResumeValidationIssueTargetInput,
): Parameters<typeof getResumeIdentityTargetId>[0] {
  const message = issue.message?.toLowerCase() ?? "";

  if (message.includes("email")) {
    return "email";
  }
  if (message.includes("phone")) {
    return "phone";
  }
  if (message.includes("headline")) {
    return "headline";
  }
  if (message.includes("location")) {
    return "location";
  }
  if (message.includes("linkedin")) {
    return "linkedinUrl";
  }
  if (message.includes("github")) {
    return "githubUrl";
  }
  if (message.includes("portfolio")) {
    return "portfolioUrl";
  }
  if (message.includes("website")) {
    return "personalWebsiteUrl";
  }
  if (message.includes("additional link")) {
    return "additionalLinks";
  }

  return "fullName";
}

function getDateIssueField(
  issue: ResumeValidationIssueTargetInput,
): ResumeValidationIssueDateField {
  const message = issue.message?.toLowerCase() ?? "";

  if (/(?:\bcurrent\b|\bpresent\b|\bactive\b)/.test(message)) {
    return "isCurrent";
  }
  if (/(?:\bend date\b|\bending\b)/.test(message)) {
    return "endDate";
  }
  if (/(?:\bstart date\b|\bstarting\b)/.test(message)) {
    return "startDate";
  }

  // The editor intentionally exposes the normalized start/end/current fields,
  // not the display-only dateRange string. Start date is the stable first
  // control for generic missing, ambiguous, future, and overlap messages.
  return "startDate";
}

function resolveResumeValidationIssueTarget(
  issue: ResumeValidationIssueTargetInput,
): ResumeValidationIssueTarget | null {
  if (issue.category === "identity_mismatch") {
    const field = getIdentityIssueField(issue);
    return {
      id: getResumeIdentityTargetId(field),
      kind: "identity",
      field,
      label: `Resume identity · ${field}`,
    };
  }

  if (!issue.sectionId) {
    return null;
  }

  if (issue.category === "date_quality") {
    if (!issue.entryId) {
      return null;
    }

    const field = getDateIssueField(issue);
    return {
      id: getResumeEntryFieldTargetId(issue.sectionId, issue.entryId, field),
      kind: "entry-date",
      field,
      label: `Entry date · ${field}`,
    };
  }

  if (issue.bulletId && issue.entryId) {
    return {
      id: getResumeEntryBulletTargetId(
        issue.sectionId,
        issue.entryId,
        issue.bulletId,
      ),
      kind: "entry-bullet",
      label: "Entry bullet",
    };
  }

  if (issue.bulletId) {
    return {
      id: getResumeSectionBulletTargetId(issue.sectionId, issue.bulletId),
      kind: "section-bullet",
      label: "Section bullet",
    };
  }

  if (issue.entryId) {
    return {
      id: getResumeEntryFieldTargetId(
        issue.sectionId,
        issue.entryId,
        "summary",
      ),
      kind: "entry-summary",
      label: "Entry summary",
    };
  }

  return {
    id: getResumeSectionTextTargetId(issue.sectionId),
    kind: "section-text",
    label: "Section text",
  };
}

export function getResumeValidationIssueTargetId(
  issue: ResumeValidationIssueTargetInput,
): string | null {
  return resolveResumeValidationIssueTarget(issue)?.id ?? null;
}

const resumeValidationIdentityActionLabels: Record<
  ResumeValidationIssueIdentityField,
  string
> = {
  fullName: "Edit name",
  headline: "Edit headline",
  location: "Edit location",
  email: "Edit email",
  phone: "Edit phone",
  portfolioUrl: "Edit portfolio",
  linkedinUrl: "Edit LinkedIn",
  githubUrl: "Edit GitHub",
  personalWebsiteUrl: "Edit website",
  additionalLinks: "Edit links",
};

const resumeValidationDateActionLabels: Record<
  ResumeValidationIssueDateField,
  string
> = {
  startDate: "Edit start date",
  endDate: "Edit end date",
  isCurrent: "Edit current-role status",
};

export function getResumeValidationIssueActionLabel(
  issue: ResumeValidationIssue,
): string {
  const target = resolveResumeValidationIssueTarget(issue);

  if (!target) {
    return issue.category === "work_history_review"
      ? "Review work history"
      : "Review issue";
  }

  switch (target.kind) {
    case "identity":
      return resumeValidationIdentityActionLabels[target.field];
    case "entry-date":
      return resumeValidationDateActionLabels[target.field];
    case "entry-summary":
      return "Edit entry summary";
    case "entry-bullet":
    case "section-bullet":
      return "Edit bullet";
    case "section-text":
      return "Edit section";
  }
}

/**
 * Some validation issues have an editor destination without a field target.
 * Keep that distinction explicit so the list can offer a useful action while
 * the shell routes the request to the right container.
 */
export function hasResumeValidationIssueEditorDestination(
  issue: ResumeValidationIssue,
): boolean {
  return (
    issue.category === "work_history_review" ||
    resolveResumeValidationIssueTarget(issue) !== null
  );
}

export function isResumeValidationIssueAiPatchSupported(
  issue: ResumeValidationIssue,
): boolean {
  const target = resolveResumeValidationIssueTarget(issue);

  return (
    target?.kind === "section-text" ||
    target?.kind === "section-bullet" ||
    target?.kind === "entry-summary" ||
    target?.kind === "entry-bullet"
  );
}

export function buildResumeValidationAiPrompt(
  issue: ResumeValidationIssue,
): string {
  const target = resolveResumeValidationIssueTarget(issue);
  const targetContext = target
    ? `Editor target: ${target.id} (${target.label}).`
    : "No exact editor target is available for this issue.";

  return [
    "Suggest a grounded fix for this Resume Studio validation issue.",
    `Issue category: ${issue.category}.`,
    `Issue: ${issue.message}`,
    targetContext,
    "Only propose changes expressible by the resume patch schema: section text, entry summaries, or bullets.",
    "Return a reviewable proposal only. Do not apply or overwrite the draft; nothing changes until I accept a proposed patch.",
  ].join("\n");
}

function getIssueSeverityLabel(severity: ResumeValidationIssue["severity"]) {
  switch (severity) {
    case "error":
      return "Blocks approval";
    case "warning":
      return "Warning";
    case "info":
      return "Note";
  }
}

function getIssueSeverityTone(severity: ResumeValidationIssue["severity"]) {
  switch (severity) {
    case "error":
      return "critical" as const;
    case "warning":
      return "neutral" as const;
    case "info":
      return "neutral" as const;
  }
}

interface ResumeValidationIssueListProps {
  issues: readonly ResumeValidationIssue[];
  /**
   * Whether this blocker can be cleared by the person approving the claim as
   * accurate in their own name, instead of rewriting it. Only claims the
   * evidence cannot prove qualify; a claim that contradicts the evidence
   * never does.
   */
  canApproveClaim?: (issue: ResumeValidationIssue) => boolean;
  canRestorePreviousText?: (issue: ResumeValidationIssue) => boolean;
  onApproveClaim?: (issue: ResumeValidationIssue) => void;
  onAskAiFix?: (issue: ResumeValidationIssue) => void;
  /**
   * Resolves an identity mismatch the other way: the document really is this
   * person's, under a name they no longer use. Without it the block was a
   * dead end — the only offered action edited a profile field that was
   * already correct.
   */
  onClaimResumeIdentity?: () => void;
  onFixIssue: (issue: ResumeValidationIssue) => void;
  onRestorePreviousText?: (issue: ResumeValidationIssue) => void;
}

function ResumeValidationIssueRow(props: {
  issue: ResumeValidationIssue;
  canApproveClaim?: (issue: ResumeValidationIssue) => boolean;
  canRestorePreviousText?: (issue: ResumeValidationIssue) => boolean;
  onApproveClaim?: (issue: ResumeValidationIssue) => void;
  onAskAiFix?: (issue: ResumeValidationIssue) => void;
  onClaimResumeIdentity?: () => void;
  onFixIssue: (issue: ResumeValidationIssue) => void;
  onRestorePreviousText?: (issue: ResumeValidationIssue) => void;
}) {
  const target = resolveResumeValidationIssueTarget(props.issue);
  const hasEditorDestination = hasResumeValidationIssueEditorDestination(
    props.issue,
  );
  const canAskAi = isResumeValidationIssueAiPatchSupported(props.issue);
  const canApprove = Boolean(
    props.onApproveClaim && props.canApproveClaim?.(props.issue),
  );
  const actionLabel = getResumeValidationIssueActionLabel(props.issue);
  const canRestore = Boolean(
    props.onRestorePreviousText &&
    props.canRestorePreviousText?.(props.issue) === true,
  );

  return (
    <li
      className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5 rounded-(--radius-field) border border-(--border-strong)/45 bg-(--surface-panel) px-3 py-2"
      data-resume-validation-issue={props.issue.id}
      key={props.issue.id}
      tabIndex={-1}
    >
      <span className="grid min-w-0 max-w-prose items-start gap-1.5 text-left">
        <StatusBadge
          tone={getIssueSeverityTone(
            getResumeValidationIssueSeverity(props.issue),
          )}
        >
          {getIssueSeverityLabel(getResumeValidationIssueSeverity(props.issue))}
        </StatusBadge>
        <span className="min-w-0 text-(length:--text-small) leading-5 text-(--text-headline)">
          {props.issue.message}
        </span>
        {props.issue.flaggedText ? (
          <span
            className="min-w-0 text-(length:--text-tiny) leading-4 text-foreground-soft"
            data-resume-validation-flagged-text
          >
            Flagged sentence: <q>{props.issue.flaggedText}</q>
          </span>
        ) : null}
        {!target && !hasEditorDestination ? (
          <span
            className="text-(length:--text-tiny) leading-4 text-foreground-soft"
            data-resume-validation-no-target
          >
            No matching editor field is available; review this issue in the
            preview and validation notes.
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        {canApprove ? (
          <Button
            aria-label={`Approve as accurate: ${props.issue.message}`}
            data-resume-validation-approve
            onClick={() => props.onApproveClaim?.(props.issue)}
            size="compact"
            title="Records that you can stand behind this exact wording. Editing the line removes the approval."
            type="button"
            variant="primary"
          >
            <CheckCircle2 className="size-4" />
            Approve as accurate
          </Button>
        ) : null}
        <Button
          aria-label={`${actionLabel}: ${props.issue.message}`}
          onClick={() => props.onFixIssue(props.issue)}
          size="compact"
          type="button"
          variant="secondary"
        >
          {actionLabel}
        </Button>
        {props.issue.category === "identity_mismatch" &&
        props.onClaimResumeIdentity ? (
          <Button
            data-resume-identity-claim
            onClick={() => props.onClaimResumeIdentity?.()}
            size="compact"
            type="button"
            variant="secondary"
          >
            This is my resume, use my profile name
          </Button>
        ) : null}
        {canRestore ? (
          <Button
            aria-label={`Restore previous text: ${props.issue.message}`}
            data-resume-validation-restore
            onClick={() => props.onRestorePreviousText?.(props.issue)}
            size="compact"
            type="button"
            variant="secondary"
          >
            <Undo2 className="size-4" />
            Restore previous text
          </Button>
        ) : null}
        {canAskAi && props.onAskAiFix ? (
          <Button
            onClick={() => props.onAskAiFix?.(props.issue)}
            size="compact"
            type="button"
            variant="ghost"
          >
            <Sparkles className="size-4" />
            Ask AI to suggest a fix
          </Button>
        ) : null}
      </span>
    </li>
  );
}

export function ResumeValidationIssueList(
  props: ResumeValidationIssueListProps,
) {
  const [aiRequestIssueId, setAiRequestIssueId] = useState<string | null>(null);

  if (props.issues.length === 0) {
    return null;
  }

  const orderedIssues = orderResumeValidationIssues(props.issues);
  const blockingIssues = orderedIssues.filter(isBlockingResumeValidationIssue);
  const reviewIssues = orderedIssues.filter(
    (issue) => !isBlockingResumeValidationIssue(issue),
  );
  const blockingCount = blockingIssues.length;
  const reviewCount = reviewIssues.length;
  const aiSupportedCount = props.onAskAiFix
    ? orderedIssues.filter(isResumeValidationIssueAiPatchSupported).length
    : 0;
  const headingId = "resume-validation-issues-heading";
  const handleAskAiFix = (issue: ResumeValidationIssue) => {
    setAiRequestIssueId(issue.id);
    props.onAskAiFix?.(issue);
  };
  const validationSummary =
    blockingCount > 0
      ? "Fix blockers before approval; notes stay review-only."
      : "Review-only; these notes do not block approval.";

  if (blockingCount === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 shrink-0 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 px-3 py-2"
      data-resume-validation-issues
    >
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <h3 className="font-display text-primary" id={headingId}>
            Fix before approval
          </h3>
          <span className="text-(length:--text-tiny) text-foreground-soft">
            {blockingCount} required fix{blockingCount === 1 ? "" : "es"}
            {aiSupportedCount > 0 ? (
              <>
                <span aria-hidden="true"> · </span>
                <span data-resume-validation-ai-availability>
                  {aiSupportedCount} AI suggestion
                  {aiSupportedCount === 1 ? "" : "s"} available
                </span>
              </>
            ) : null}
          </span>
        </div>
        <StatusBadge tone={blockingCount > 0 ? "critical" : "neutral"}>
          {blockingCount} approval blocker{blockingCount === 1 ? "" : "s"}
        </StatusBadge>
      </div>
      <p
        className="mt-1 max-w-prose shrink-0 text-(length:--text-tiny) leading-4 text-foreground-soft"
        data-resume-validation-summary
      >
        {validationSummary}
      </p>
      <ul
        className="mt-1.5 grid min-w-0 gap-1.5 pr-1"
        data-resume-validation-blockers
      >
        {blockingIssues.map((issue) => (
          <ResumeValidationIssueRow
            {...(props.canApproveClaim
              ? { canApproveClaim: props.canApproveClaim }
              : {})}
            {...(props.onApproveClaim
              ? { onApproveClaim: props.onApproveClaim }
              : {})}
            issue={issue}
            key={issue.id}
            {...(props.canRestorePreviousText
              ? { canRestorePreviousText: props.canRestorePreviousText }
              : {})}
            onAskAiFix={handleAskAiFix}
            {...(props.onClaimResumeIdentity
              ? { onClaimResumeIdentity: props.onClaimResumeIdentity }
              : {})}
            onFixIssue={props.onFixIssue}
            {...(props.onRestorePreviousText
              ? { onRestorePreviousText: props.onRestorePreviousText }
              : {})}
          />
        ))}
      </ul>
      {reviewIssues.length > 0 ? (
        <details className="group mt-1.5 min-w-0" data-resume-validation-notes>
          <summary className="flex min-h-8 shrink-0 cursor-pointer list-none items-center justify-between gap-2 rounded-(--radius-field) border border-(--control-border) bg-background/45 px-3 py-1 text-(length:--text-small) font-semibold text-(--text-headline) outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-2 focus-visible:ring-ring">
            <span>
              Other suggestions ({reviewCount})
              <span className="ml-1 font-normal text-foreground-soft">
                — warnings and notes do not block approval
              </span>
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <ul className="mt-1.5 grid min-w-0 gap-1.5 pr-1">
            {reviewIssues.map((issue) => (
              <ResumeValidationIssueRow
                {...(props.canApproveClaim
                  ? { canApproveClaim: props.canApproveClaim }
                  : {})}
                {...(props.onApproveClaim
                  ? { onApproveClaim: props.onApproveClaim }
                  : {})}
                issue={issue}
                key={issue.id}
                {...(props.canRestorePreviousText
                  ? { canRestorePreviousText: props.canRestorePreviousText }
                  : {})}
                onAskAiFix={handleAskAiFix}
                {...(props.onClaimResumeIdentity
                  ? { onClaimResumeIdentity: props.onClaimResumeIdentity }
                  : {})}
                onFixIssue={props.onFixIssue}
                {...(props.onRestorePreviousText
                  ? { onRestorePreviousText: props.onRestorePreviousText }
                  : {})}
              />
            ))}
          </ul>
        </details>
      ) : null}
      {aiRequestIssueId ? (
        <p
          aria-live="polite"
          className="mt-1.5 shrink-0 rounded-(--radius-field) border border-primary/25 bg-primary/10 px-3 py-1.5 text-(length:--text-small) leading-5 text-foreground-soft"
          data-resume-validation-ai-status
          role="status"
        >
          AI suggestion requested. Nothing changes until you accept a proposed
          patch in Guided Edits.
        </p>
      ) : null}
    </section>
  );
}
