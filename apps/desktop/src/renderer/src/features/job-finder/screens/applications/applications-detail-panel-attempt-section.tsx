import type { ApplicationAttemptListRow } from "@nestor/contracts";
import {
  formatDuration,
  formatStatusLabel,
} from "@renderer/features/job-finder/lib/job-finder-utils";
import { APPLICATION_BLOCKER_LABELS } from "../../lib/status-copy";
import { StatusBadge } from "../../components/status-badge";
import { formatQuestionPrompt } from "./applications-recovery-state";
import { cn } from "@renderer/lib/utils";
import {
  getApplyBlockedAttemptDetail,
  getCustomerFacingApplyText,
  TECHNICAL_DETAILS_LABEL,
} from "./applications-detail-panel-helpers";
import { APPLICATION_DETAIL_FACT_LABEL_CLASS } from "./applications-detail-fact-strip";

const executionTimingLabels: Record<
  ApplicationAttemptListRow["executionTimings"][number]["stage"],
  string
> = {
  browser_preparation: "Browser setup",
  form_preparation: "Form preparation",
  visual_diagnostics: "Visual checks",
  total: "Total",
};

export function ApplicationsDetailPanelAttemptSection(props: {
  selectedAttempt: ApplicationAttemptListRow | null;
}) {
  const { selectedAttempt } = props;
  const attemptSummary = getCustomerFacingApplyText(selectedAttempt?.summary);
  const attemptDetail = getCustomerFacingApplyText(selectedAttempt?.detail);
  // Kept, not printed in the sentence: what the page actually tried when the
  // runtime stopped it. Engineers need it; a person reading "what do I do
  // now?" does not need a request line in the middle of the answer.
  const blockedAttemptDetails = [
    ...new Set(
      [
        selectedAttempt?.summary,
        selectedAttempt?.detail,
        selectedAttempt?.blocker?.summary,
        selectedAttempt?.blocker?.detail,
      ]
        .map((value) => getApplyBlockedAttemptDetail(value))
        .filter((detail): detail is string => Boolean(detail)),
    ),
  ];

  if (!selectedAttempt) {
    return (
      <section className="surface-card-tint grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
        <h3 className={cn(APPLICATION_DETAIL_FACT_LABEL_CLASS, "text-primary")}>
          Preparation details
        </h3>
        <p className="text-(length:--text-body) leading-7 text-foreground-soft">
          No preparation details were saved for this application yet.
        </p>
      </section>
    );
  }

  return (
    <section className="surface-card-tint grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <h3 className={cn(APPLICATION_DETAIL_FACT_LABEL_CLASS, "text-primary")}>
        Preparation details
      </h3>
      {attemptSummary ? (
        <strong className="text-(length:--text-body) leading-7 text-foreground">
          {attemptSummary}
        </strong>
      ) : (
        <strong className="text-(length:--text-body) leading-7 text-foreground">
          No summary available
        </strong>
      )}
      {attemptDetail ? (
        <p className="text-(length:--text-body) leading-7 text-foreground-soft">
          {attemptDetail}
        </p>
      ) : null}
      {selectedAttempt.blocker ? (
        <div className="grid gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3">
          {/* The shared label table, not the enum name: "requires manual
              review" is the code, not something a person says. */}
          <strong>
            {APPLICATION_BLOCKER_LABELS[selectedAttempt.blocker.code]}
          </strong>
          <p className="text-(length:--text-small) leading-6 text-foreground-soft">
            {getCustomerFacingApplyText(selectedAttempt.blocker.summary)}
          </p>
          {selectedAttempt.blocker.detail ? (
            <p className="text-(length:--text-small) leading-6 text-foreground-soft">
              {getCustomerFacingApplyText(selectedAttempt.blocker.detail)}
            </p>
          ) : null}
        </div>
      ) : null}
      {blockedAttemptDetails.length > 0 ? (
        <details className="min-w-0">
          <summary className="cursor-pointer text-(length:--text-small) text-muted-foreground">
            {TECHNICAL_DETAILS_LABEL}
          </summary>
          <ul
            className="mt-1 grid gap-1 break-all text-(length:--text-small) leading-5 text-muted-foreground"
            role="list"
          >
            {blockedAttemptDetails.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {selectedAttempt.executionTimings.length ? (
        <div className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3">
          <p className={cn(APPLICATION_DETAIL_FACT_LABEL_CLASS)}>
            Preparation timing
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-(length:--text-small) leading-6 text-foreground-soft">
            {selectedAttempt.executionTimings.map((timing) => (
              <span key={timing.stage}>
                {executionTimingLabels[timing.stage]}:{" "}
                {formatDuration(timing.durationMs)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {selectedAttempt.questions.length ? (
        <div className="grid gap-2">
          <p className={cn(APPLICATION_DETAIL_FACT_LABEL_CLASS)}>
            Question memory
          </p>
          {selectedAttempt.questions.map((question) => (
            <div
              key={question.id}
              className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{formatQuestionPrompt(question.prompt)}</strong>
                <StatusBadge
                  tone={
                    question.status === "submitted" ||
                    question.status === "answered"
                      ? "positive"
                      : "active"
                  }
                >
                  {formatStatusLabel(question.status)}
                </StatusBadge>
              </div>
              <p className="mt-2 text-(length:--text-small) leading-6 text-foreground-soft">
                {formatStatusLabel(question.kind)}
                {question.isRequired ? " • Required" : " • Optional"}
              </p>
              {question.submittedAnswer ? (
                <p className="mt-2 text-(length:--text-small) leading-6 text-foreground-soft">
                  {question.status === "submitted"
                    ? "Submitted"
                    : "Prepared answer"}
                  : {question.submittedAnswer}
                </p>
              ) : null}
              {question.suggestedAnswers[0] ? (
                <p className="mt-2 text-(length:--text-small) leading-6 text-foreground-soft">
                  Suggested: {question.suggestedAnswers[0].text}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {selectedAttempt.consentDecisions.length ? (
        <div className="grid gap-2">
          <p className={cn(APPLICATION_DETAIL_FACT_LABEL_CLASS)}>
            Consent history
          </p>
          {selectedAttempt.consentDecisions.map((decision) => (
            <div
              key={decision.id}
              className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3 text-(length:--text-small) leading-6 text-foreground-soft"
            >
              <strong className="text-foreground">{decision.label}</strong>
              <p>{formatStatusLabel(decision.status)}</p>
              {decision.detail ? <p>{decision.detail}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
