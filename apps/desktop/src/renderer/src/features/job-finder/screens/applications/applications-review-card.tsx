import { useState } from "react";
import type { ApplicationReviewCard } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import {
  TECHNICAL_DETAILS_LABEL,
  describeFailure,
  type FailureDescription,
} from "../../lib/describe-failure";
import type { ApplyMode } from "../../lib/apply-mode-contracts-stub";
import { runAgainLabel } from "./applications-recovery-state";

/**
 * What Job Finder wrote, before you send it.
 *
 * This is the whole point of choosing "ask me before sending": a person should
 * be able to read every answer that is about to go out, see where each one came
 * from, and read the letter in full. A review that hides the generated answers
 * is not a review, so nothing here is collapsed by default.
 *
 * The card is what the run that filled the form in actually recorded, so the
 * wording under each answer is the run's own phrase for where it came from.
 */

export interface ApplicationsReviewCardProps {
  card: ApplicationReviewCard;
  /**
   * True when the browser no longer holds the page this was filled in on.
   * Sending is impossible until it is prepared again.
   */
  pageClosed?: boolean | undefined;
  onSubmit?: (() => Promise<void>) | undefined;
  onOpenPage?: (() => Promise<void>) | undefined;
  onPrepareAgain?: (() => Promise<void>) | undefined;
  /** The mode saved in Settings; preparing again runs in it. */
  applyMode?: ApplyMode | undefined;
  isSubmitPending?: boolean | undefined;
}

export function ApplicationsReviewCard({
  card,
  pageClosed,
  onSubmit,
  onOpenPage,
  onPrepareAgain,
  applyMode = "fill_only",
  isSubmitPending,
}: ApplicationsReviewCardProps) {
  // In Send for me the new run sends, so the button says so.
  const sendsAgain = applyMode === "apply_for_me";
  const prepareAgainLabel = runAgainLabel(applyMode, "Prepare again");
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [pending, setPending] = useState(false);
  const busy = pending || isSubmitPending === true;
  const readyToSend =
    card.waitingOnYou.length === 0 &&
    pageClosed !== true &&
    !card.letter?.needsRefresh;

  const run = async (
    action: (() => Promise<void>) | undefined,
    describeAs: string,
  ) => {
    if (!action || busy) {
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await action();
    } catch (cause) {
      setFailure(describeFailure(cause, { action: describeAs }));
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      aria-label="Review before sending"
      className="surface-panel-shell grid min-w-0 gap-3 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4"
    >
      <div className="grid gap-1">
        <h3 className="font-semibold text-(--text-headline)">
          Read this before you send it
        </h3>
        <p className="text-(length:--text-description) leading-5 text-foreground-soft">
          {card.answers.length > 0 ||
          card.attachments.length > 0 ||
          card.letter?.fields?.length
            ? `Job Finder filled in the items below on ${card.siteLabel}. Nothing has been sent yet.`
            : `Nothing has been filled in on ${card.siteLabel} yet. Nothing has been sent.`}
        </p>
        {card.pageUrl ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 break-all text-(length:--text-small) leading-5 text-foreground-soft">
              Page: {card.pageUrl}
            </p>
            {onOpenPage && !pageClosed ? (
              <Button
                size="sm"
                variant="secondary"
                type="button"
                pending={busy}
                onClick={() =>
                  void run(onOpenPage, "open this application page")
                }
              >
                Open this page
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {pageClosed ? (
        <div
          className="grid gap-2 rounded-(--radius-field) border border-warning/40 bg-warning/8 px-3.5 py-3"
          role="status"
        >
          <p className="text-(length:--text-small) leading-6 text-foreground">
            The application page was closed before you reviewed it.{" "}
            {sendsAgain
              ? "Apply again fills it in again and sends it."
              : "Prepare it again to continue."}
          </p>
          {onPrepareAgain ? (
            <div>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(onPrepareAgain, "prepare this application again")
                }
                pending={busy}
                type="button"
                variant="secondary"
              >
                {prepareAgainLabel}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {card.answers.length > 0 ? (
        <div className="grid gap-2">
          <p className="label-mono-xs">Answers going out</p>
          {card.answers.map((answer) => (
            <div
              className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3"
              key={answer.fieldKey ?? `${answer.question}:${answer.answer}`}
            >
              <strong className="text-foreground">{answer.question}</strong>
              <p className="mt-1 whitespace-pre-wrap text-(length:--text-small) leading-6 text-foreground">
                {answer.answer}
              </p>
              <p className="mt-1 text-(length:--text-small) leading-6 text-foreground-soft">
                {answer.source === "chosen on the form" ||
                answer.source === "chosen on the form by Job Finder"
                  ? "Chosen on the form by Job Finder"
                  : answer.source === "your answer on the form"
                    ? "Your answer on the form"
                    : answer.written
                      ? "Written for this application"
                      : `From ${answer.source}`}
                {answer.written &&
                answer.source !== "chosen on the form" &&
                answer.source !== "chosen on the form by Job Finder" &&
                answer.source !== "your answer on the form" &&
                answer.groundedIn.length > 0
                  ? `, based on ${answer.groundedIn.join(", ")}`
                  : ""}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {card.letter ? (
        <div className="grid gap-2">
          <p className="label-mono-xs">
            {card.letter.reviewReason
              ? "Letter draft for your review"
              : "The letter going with it"}
          </p>
          {card.letter.needsRefresh ? (
            <div
              role="alert"
              className="grid gap-2 rounded-(--radius-field) border border-warning/40 bg-warning/8 px-3.5 py-3"
            >
              <p>
                {card.letter.fields?.length
                  ? "The form still holds the earlier letter."
                  : "The approved letter has not been added to the form yet."}{" "}
                {sendsAgain
                  ? "Apply again to attach the letter you approved and send it."
                  : "Prepare again to attach the letter you approved."}
              </p>
              {onPrepareAgain ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  pending={busy}
                  onClick={() =>
                    void run(onPrepareAgain, "prepare this application again")
                  }
                >
                  {prepareAgainLabel}
                </Button>
              ) : null}
            </div>
          ) : null}
          {card.letter.reviewReason ? (
            <p
              role="alert"
              className="text-(length:--text-small) text-foreground-soft"
            >
              {card.letter.reviewReason}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3 text-(length:--text-small) leading-6 text-foreground">
            {card.letter.text}
          </p>
          {card.letter.groundedIn.length > 0 ? (
            <p className="text-(length:--text-small) leading-6 text-foreground-soft">
              Written from {card.letter.groundedIn.join(", ")}.
            </p>
          ) : null}
        </div>
      ) : null}

      {card.attachments.length > 0 ? (
        <div className="grid gap-2">
          <p className="label-mono-xs">Files attached</p>
          <ul className="grid gap-1">
            {card.attachments.map((attachment) => (
              <li
                className="text-(length:--text-small) leading-6 text-foreground-soft"
                key={
                  attachment.fieldKey ??
                  `${attachment.field}:${attachment.fileName}`
                }
              >
                {attachment.label} — {attachment.fileName} ({attachment.field})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {card.waitingOnYou.length > 0 ? (
        <div
          className="grid gap-1 rounded-(--radius-field) border border-warning/40 bg-warning/8 px-3.5 py-3"
          role="status"
        >
          <p className="font-semibold text-foreground">
            Waiting on you before this can be sent
          </p>
          {card.waitingOnYou.map((item) => (
            <p
              className="text-(length:--text-small) leading-6 text-foreground-soft"
              key={item}
            >
              {item}
            </p>
          ))}
        </div>
      ) : null}

      {failure ? (
        <div className="grid gap-1" role="alert">
          <p className="text-(length:--text-small) leading-6 text-destructive">
            {failure.userMessage} Nothing on the site was changed.
          </p>
          {failure.technicalDetails ? (
            <details className="text-(length:--text-small) leading-6 text-foreground-soft">
              <summary>{TECHNICAL_DETAILS_LABEL}</summary>
              <p className="mt-1 break-all">{failure.technicalDetails}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      {onSubmit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!readyToSend || busy}
            onClick={() => void run(onSubmit, "send this application")}
            pending={busy}
            type="button"
            variant="primary"
          >
            Submit application
          </Button>
          <p className="text-(length:--text-small) leading-5 text-foreground-soft">
            {pageClosed || card.letter?.needsRefresh
              ? "Prepare it again before it can be sent."
              : readyToSend
                ? "This sends it to the employer once. Job Finder never sends it twice."
                : "Answer what is waiting on you above first."}
          </p>
        </div>
      ) : null}
    </section>
  );
}
