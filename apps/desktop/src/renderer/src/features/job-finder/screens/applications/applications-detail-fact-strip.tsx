import { ApplicationsDisclosureSummary } from "./applications-disclosure-summary";
import type {
  ApplicationAttemptListRow,
  ApplicationRecord,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import type { ReactNode } from "react";
import {
  isApplicationTrackedAsSentByPerson,
  isApplicationWithdrawnByPerson,
  PREPARED_PAGE_CLOSED_SUMMARY,
} from "@nestor/contracts";
import {
  formatStatusLabel,
  formatTimestamp,
  getAttemptLabel,
} from "@renderer/features/job-finder/lib/job-finder-utils";
import {
  applyResultIsFieldSavePause,
  FIELD_SAVE_PAUSE_ACTIVITY,
  getCustomerFacingApplyText,
  applyResultIsServiceWorkerBlocked,
} from "./applications-detail-panel-helpers";
import type { PlannedApplyStanding } from "./applications-recovery-state";

// The eyebrow token, not a literal `text-xs`: at 12px these labels sat between
// the 11px eyebrow floor and the neighbouring `.label-mono-xs` labels in the
// same panel, so the detail pane had two label sizes with no rule behind them.
export const APPLICATION_DETAIL_FACT_LABEL_CLASS =
  "text-(length:--text-eyebrow) font-semibold uppercase leading-4 tracking-(--tracking-badge) text-muted-foreground";

interface DetailFact {
  content: ReactNode;
  label: string;
  muted?: boolean;
  note?: string;
  title?: string;
  /** A sentence-length value takes the whole row instead of one column. */
  wide?: boolean;
}

function DetailFactCell({ fact }: { fact: DetailFact }) {
  const { content, label, muted = false, note, title, wide = false } = fact;
  const valueTitle =
    title ??
    (note && typeof content === "string"
      ? `${content} • ${note}`
      : (note ?? undefined));

  return (
    <div
      className={
        wide ? "min-w-0 sm:col-span-2 @[32rem]/detail:col-span-3" : "min-w-0"
      }
    >
      <dt className={APPLICATION_DETAIL_FACT_LABEL_CLASS}>{label}</dt>
      <dd
        className={`mt-1 block min-w-0 break-words text-(length:--text-field) leading-6 ${muted ? "font-normal text-foreground-muted" : "font-semibold text-foreground"}`}
        {...(valueTitle ? { title: valueTitle } : {})}
      >
        {content}
      </dd>
      {note ? (
        <p
          className="mt-1 block min-w-0 break-words text-(length:--text-small) leading-5 text-foreground-soft"
          title={note}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

export function ApplicationsDetailFactStrip(props: {
  selectedAttempt: ApplicationAttemptListRow | null;
  selectedRecord: ApplicationRecord;
  visibleApplyResult:
    | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    | null;
  visibleApplyRunId: string | null;
  waitingOnSafetyLimitReview?: boolean;
  /** A job its batch has not started: the facts follow the status block. */
  plannedStanding?: PlannedApplyStanding | null;
  /** The status badge beside the title, so the strip does not repeat it. */
  headerStatusLabel?: string | null;
}) {
  const {
    selectedAttempt,
    selectedRecord,
    visibleApplyResult,
    visibleApplyRunId,
  } = props;
  const { consentSummary, latestBlocker, questionSummary, replaySummary } =
    selectedRecord;
  const resolvedRunId = visibleApplyRunId ?? visibleApplyResult?.runId ?? null;
  const plannedStanding = props.plannedStanding ?? null;
  const visibleRunIsActive =
    plannedStanding === null &&
    visibleApplyResult?.completedAt === null &&
    (visibleApplyResult.state === "planned" ||
      visibleApplyResult.state === "question_capture" ||
      visibleApplyResult.state === "filling" ||
      visibleApplyResult.state === "submitting");
  const selectedAttemptBelongsToVisibleRun =
    selectedAttempt?.userActionResumption?.runId === resolvedRunId;
  const submissionOutcome =
    visibleApplyResult?.privacyReceipt?.submissionOutcome?.outcome ?? null;
  const isResolvedAwaitingReview =
    visibleApplyResult?.state === "awaiting_review" &&
    !visibleApplyResult.blockerReason;
  const persistedAttemptState =
    selectedRecord.lastAttemptState === "failed" ||
    selectedRecord.lastAttemptState === "cancelled"
      ? selectedRecord.lastAttemptState
      : (selectedAttempt?.state ?? selectedRecord.lastAttemptState);
  const fallbackAttemptLabel =
    persistedAttemptState === "paused" ||
    persistedAttemptState === "unsupported"
      ? "Needs you"
      : persistedAttemptState === "failed"
        ? "Could not apply"
        : persistedAttemptState
          ? getAttemptLabel(persistedAttemptState)
          : null;
  const runAttemptStateLabel =
    plannedStanding === "not_started"
      ? "Not started"
      : plannedStanding === "paused"
        ? "Paused"
        : plannedStanding === "waiting_turn"
          ? "Waiting its turn"
          : plannedStanding === "waiting_tab"
            ? "Waiting for a browser tab"
            : submissionOutcome === "not_submitted"
              ? "Not sent"
              : submissionOutcome === "submitted"
                ? "Submitted (verified)"
                : submissionOutcome === "outcome_uncertain"
                  ? "Outcome needs verification"
                  : visibleApplyResult?.state === "submitted"
                    ? "Submitted"
                    : visibleApplyResult?.state === "cancelled"
                      ? "Cancelled by you"
                      : visibleApplyResult?.state === "failed" &&
                          visibleApplyResult.summary ===
                            PREPARED_PAGE_CLOSED_SUMMARY
                        ? "Form closed"
                        : visibleApplyResult?.state === "failed"
                          ? "Could not apply"
                        : visibleRunIsActive &&
                            !selectedAttemptBelongsToVisibleRun
                          ? "In progress"
                          : isResolvedAwaitingReview
                            ? "Ready to send"
                            : visibleApplyResult?.state === "blocked" ||
                                (visibleApplyResult?.state ===
                                  "awaiting_review" &&
                                  visibleApplyResult.blockerReason)
                              ? "Needs you"
                              : fallbackAttemptLabel;
  // The person's own tracker record wins over the run's last state, short of
  // a verified send: they sent it, or withdrew it, themselves.
  const personRecordedLabel =
    submissionOutcome === "submitted" ||
    visibleApplyResult?.state === "submitted"
      ? null
      : isApplicationTrackedAsSentByPerson(selectedRecord.crm)
        ? "Marked applied by you"
        : isApplicationWithdrawnByPerson(selectedRecord.crm)
          ? "Withdrawn by you"
          : null;
  const attemptStateLabel = personRecordedLabel ?? runAttemptStateLabel;

  const replayNoteSegments = [
    replaySummary.evidenceCount > 0
      ? `${replaySummary.evidenceCount} retained evidence item${replaySummary.evidenceCount === 1 ? "" : "s"}`
      : null,
    replaySummary.lastUrl,
  ].filter((segment): segment is string => segment !== null);

  const blockerNote = latestBlocker
    ? getCustomerFacingApplyText(latestBlocker.summary)
    : null;

  const isSiteBlockedPause =
    applyResultIsServiceWorkerBlocked(visibleApplyResult) ||
    (Boolean(blockerNote) &&
      /service worker|job site blocked|safeguards/i.test(
        `${latestBlocker?.summary ?? ""} ${blockerNote ?? ""} ${selectedRecord.lastActionLabel ?? ""}`,
      ));
  // Next step already tells the user the site acted and Job Finder stopped it.
  // The runtime's own sentence describes the same event as a site failure, so
  // the strip reuses the exact shared labels instead of a rival account.
  const isFieldSavePause = applyResultIsFieldSavePause(visibleApplyResult);
  // A stop reason already printed in the status block above is not repeated
  // as "latest activity" beside it.
  const repeatsStatusBlock =
    selectedRecord.lastActionLabel !== null &&
    selectedRecord.lastActionLabel !== undefined &&
    (visibleApplyResult?.detail === selectedRecord.lastActionLabel ||
      visibleApplyResult?.summary === selectedRecord.lastActionLabel);
  const latestActivityContent =
    isResolvedAwaitingReview ||
    selectedRecord.status === "submitted" ||
    Boolean(selectedRecord.personSendReceipt) ||
    visibleApplyResult?.state === "submitted" ||
    plannedStanding !== null ||
    ["failed", "cancelled", "skipped"].includes(visibleApplyResult?.state ?? "")
      ? null
      : visibleRunIsActive
        ? getCustomerFacingApplyText(visibleApplyResult.detail)
        : isFieldSavePause
          ? FIELD_SAVE_PAUSE_ACTIVITY
          : selectedRecord.lastActionLabel && !repeatsStatusBlock
            ? isSiteBlockedPause
              ? "Automatic prep paused"
              : selectedRecord.lastActionLabel
            : null;
  // On a finish-yourself pause the Next step callout directly above already
  // prints the whole sentence — the site acted, Job Finder stopped, finish in
  // the browser. "Latest activity" and "What stopped progress" were its two
  // halves relabelled, so one event arrived as three labelled facts.
  const nextStepOwnsPauseCause = isFieldSavePause || isSiteBlockedPause;
  const preparationStatusFact: DetailFact = attemptStateLabel
    ? {
        content: attemptStateLabel,
        label: "Preparation status",
      }
    : {
        content: "Not started",
        label: "Preparation status",
        muted: true,
      };
  // "FORM CLOSED" beside the title and "Preparation status: Form closed"
  // under it said one thing twice.
  const repeatsHeaderStatus =
    attemptStateLabel !== null &&
    attemptStateLabel !== undefined &&
    props.headerStatusLabel?.trim().toLowerCase() ===
      attemptStateLabel.trim().toLowerCase();
  const statusFacts = repeatsHeaderStatus ? [] : [preparationStatusFact];
  const primaryFacts: DetailFact[] = nextStepOwnsPauseCause
    ? statusFacts
    : [
        // "What stopped progress" is gone: the status block at the top of the
        // panel now carries that sentence, and printing it here as well made
        // one event arrive in four places. Latest activity only survives when
        // it is not the status title said again.
        ...(latestActivityContent
          ? [
              {
                content: latestActivityContent,
                label: "Latest activity",
                wide: latestActivityContent.length > 60,
              },
            ]
          : []),
        ...statusFacts,
      ];

  const formQuestionCount = Math.max(
    questionSummary.total,
    visibleApplyResult?.latestQuestionCount ?? 0,
    visibleApplyResult?.reviewCard?.answers.length ?? 0,
  );
  const formAnswerCount = Math.min(
    formQuestionCount,
    Math.max(
      questionSummary.answered,
      visibleApplyResult?.latestAnswerCount ?? 0,
      visibleApplyResult?.reviewCard?.answers.filter((answer) =>
        answer.answer.trim(),
      ).length ?? 0,
    ),
  );
  const detailFacts: DetailFact[] = [
    {
      content: formatTimestamp(selectedRecord.lastUpdatedAt),
      label: "Last updated",
    },
    {
      content: formQuestionCount,
      label: "Form questions",
      note: `${formAnswerCount} answered • ${questionSummary.unansweredRequired} required left`,
    },
    {
      content: formatStatusLabel(consentSummary.status),
      label: "Consent decisions",
      muted: consentSummary.status === "none",
      ...(consentSummary.pendingCount > 0
        ? { note: `${consentSummary.pendingCount} waiting` }
        : {}),
    },
    replaySummary.checkpointCount > 0
      ? {
          content: `${replaySummary.checkpointCount} saved`,
          label: "Saved progress",
          ...(replayNoteSegments.length
            ? { note: replayNoteSegments.join(" • ") }
            : {}),
        }
      : {
          content: "None yet",
          label: "Saved progress",
          muted: true,
        },
  ];

  if (visibleApplyResult) {
    const questionsFound = Math.max(
      visibleApplyResult.latestQuestionCount,
      visibleApplyResult.reviewCard?.answers.length ?? 0,
    );
    const answersFilled = Math.max(
      visibleApplyResult.latestAnswerCount,
      visibleApplyResult.reviewCard?.answers.filter((answer) =>
        answer.answer.trim(),
      ).length ?? 0,
    );
    const runNote = [
      `${questionsFound} ${questionsFound === 1 ? "question" : "questions"} found`,
      `${answersFilled} ${answersFilled === 1 ? "answer" : "answers"} filled`,
      // The autosave pause already has its cause stated once above; repeating
      // the runtime sentence here made the same event read four ways.
      visibleApplyResult.blockerSummary && !isFieldSavePause
        ? (getCustomerFacingApplyText(visibleApplyResult.blockerSummary) ?? "")
        : null,
    ]
      .filter((segment) => segment !== null && segment.length > 0)
      .join(" • ");

    detailFacts.push({
      content:
        submissionOutcome === "outcome_uncertain"
          ? "Outcome needs verification"
          : submissionOutcome === "not_submitted"
            ? "Final action not submitted"
            : submissionOutcome === "submitted"
              ? "Submitted (verified)"
              : formatStatusLabel(visibleApplyResult.state),
      label: "Latest preparation run",
      ...(runNote.length > 0 ? { note: runNote } : {}),
    });
  }

  return (
    <section
      aria-label="Application status"
      className={
        primaryFacts.length > 0
          ? "surface-card-tint grid gap-4 rounded-(--radius-field) border border-(--border-strong) bg-(--surface-overlay-soft) px-5 py-4"
          : // Only the disclosure is left: a link, not a card around a link.
            "grid gap-4"
      }
    >
      {primaryFacts.length > 0 ? (
        <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 @[32rem]/detail:grid-cols-3">
          {primaryFacts.map((fact) => (
            <DetailFactCell fact={fact} key={fact.label} />
          ))}
        </dl>
      ) : null}
      <details className="group min-w-0">
        <ApplicationsDisclosureSummary count={detailFacts.length}>
          More about this application
        </ApplicationsDisclosureSummary>
        <dl className="mt-2 grid min-w-0 grid-cols-2 gap-x-6 gap-y-2 border-t border-(--border-strong)/70 pt-2 @[32rem]/detail:grid-cols-3">
          {detailFacts.map((fact) => (
            <DetailFactCell fact={fact} key={fact.label} />
          ))}
        </dl>
      </details>
    </section>
  );
}
