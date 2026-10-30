import type { ApplicationDetails } from "@nestor/contracts";
import { Check, ExternalLink, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";

import { formatWhen } from "./tracker-format";
import { describeError } from "./use-application";

/** Apply's own record of one job's application, kept current as Apply works. */
function useApplicationWork(jobId: number) {
  const [details, setDetails] = useState<ApplicationDetails | null>(null);
  const latest = useRef(jobId);
  latest.current = jobId;

  const load = useCallback(async () => {
    const id = latest.current;
    const [row] = await window.nestor.jobFinder.applicationsForJobs({
      jobIds: [id],
    });
    const next = row
      ? await window.nestor.jobFinder.getApplicationDetails({ id: row.id })
      : null;
    if (latest.current === id) setDetails(next);
  }, []);

  useEffect(() => {
    setDetails(null);
    void load().catch(() => undefined);
  }, [jobId, load]);

  useEffect(
    () =>
      window.nestor.jobFinder.onApplicationsChange((change) => {
        if (change.ids === null || change.ids.includes(latest.current))
          void load().catch(() => undefined);
      }),
    [load],
  );

  return details;
}

/**
 * Apply's side of one application: Open and Stop while it is in flight, and
 * the read-only record of what went on the form.
 */
export function ApplicationWork(props: { jobId: number }) {
  const details = useApplicationWork(props.jobId);
  if (!details) return null;
  return (
    <>
      <ApplyActions details={details} />
      <SentReview details={details} />
    </>
  );
}

/**
 * Open the page Apply prepared, stop Apply before it sends, start a run
 * that failed or was stopped before sending again, or settle a send the app
 * could not confirm with what the person saw on the site.
 */
function ApplyActions(props: { details: ApplicationDetails }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState<
    "open" | "stop" | "retry" | "sent" | "not_sent" | null
  >(null);
  const { application, receipt } = props.details;
  const canOpen = ["ready", "needs_you", "uncertain"].includes(
    application.state,
  );
  const canStop = ["queued", "running", "needs_you", "ready"].includes(
    application.state,
  );
  // Only a run that never reached a send, or one stopped after the site or
  // the person said it was not sent: anything else the guarded send tried
  // keeps its receipt, and trying again could send it twice.
  const canRetry =
    ["failed", "stopped"].includes(application.state) &&
    application.submittedAt === null &&
    (receipt === null ||
      (application.state === "stopped" && receipt.outcome === "not_submitted"));
  const canSettle = application.state === "uncertain";
  if (!canOpen && !canStop && !canRetry && !canSettle) return null;

  const settle = async (sent: boolean) => {
    setBusy(sent ? "sent" : "not_sent");
    try {
      const done = await window.nestor.jobFinder.resolveUncertainSend({
        id: application.id,
        sent,
      });
      showToast(
        done
          ? sent
            ? { title: "Moved to Applied" }
            : {
                title: "Marked as not sent",
                description: "Apply won't send it again by itself.",
              }
          : { title: "It had already moved on.", tone: "warning" },
      );
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy("retry");
    try {
      const result = await window.nestor.jobFinder.applyJobs({
        selection: { ids: [application.jobId] },
      });
      showToast(
        result.queued > 0
          ? {
              title:
                application.state === "stopped"
                  ? "Applying again"
                  : "Trying again",
              description:
                "Apply fills the form in again with your saved answers.",
            }
          : {
              title: "It couldn't start again",
              description:
                result.notApproved > 0
                  ? "This job no longer has an approved resume. Approve one, then apply."
                  : "It has already moved on.",
              tone: "warning",
            },
      );
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: "open" | "stop") => {
    setBusy(kind);
    try {
      const target = { id: application.id };
      const done =
        kind === "open"
          ? await window.nestor.jobFinder.openApplication(target)
          : await window.nestor.jobFinder.stopApplication(target);
      const restoring =
        kind === "open" &&
        done &&
        ["queued", "running"].includes(
          (await window.nestor.jobFinder.getApplicationDetails(target))
            ?.application.state ?? "",
        );
      showToast(
        done
          ? {
              title:
                kind === "open"
                  ? restoring
                    ? "Restoring the form for your review. Restoring it won't send it."
                    : "Opened the application page"
                  : "Stopped. Apply won't send it.",
            }
          : {
              title:
                kind === "open"
                  ? "The application page isn't open any more."
                  : "It had already moved on.",
              ...(kind === "open" && canSettle
                ? {
                    description:
                      "Check your account on the employer's site before settling this outcome. Nestor has not reopened or resent the application.",
                  }
                : {}),
              tone: "warning",
            },
      );
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {canRetry ? (
        <Button
          onClick={() => void retry()}
          pending={busy === "retry"}
          size="toolbar"
        >
          <RotateCcw aria-hidden />
          {application.state === "stopped" ? "Apply again" : "Try again"}
        </Button>
      ) : null}
      {canSettle ? (
        <>
          <Button
            disabled={busy !== null}
            onClick={() => void settle(true)}
            pending={busy === "sent"}
            size="toolbar"
          >
            <Check aria-hidden />
            It went through
          </Button>
          <Button
            disabled={busy !== null}
            onClick={() => void settle(false)}
            pending={busy === "not_sent"}
            size="toolbar"
            variant="outline"
          >
            <X aria-hidden />
            It didn’t go through
          </Button>
        </>
      ) : null}
      {canOpen ? (
        <Button
          onClick={() => void act("open")}
          pending={busy === "open"}
          size="toolbar"
        >
          <ExternalLink aria-hidden />
          {canSettle ? "Check site" : "Open application"}
        </Button>
      ) : null}
      {canStop ? (
        <Button
          onClick={() => void act("stop")}
          pending={busy === "stop"}
          size="toolbar"
          variant="outline"
        >
          <Square aria-hidden />
          Stop
        </Button>
      ) : null}
    </div>
  );
}

const OUTCOME_LABEL = {
  submitted: "Sent",
  not_submitted: "Not sent",
  outcome_uncertain: "Not sure it went through",
} as const;

/**
 * What Apply put on the form, and its receipt once sent. Read-only: it shows
 * what the run recorded, and nothing here can change or send it.
 */
function SentReview(props: { details: ApplicationDetails }) {
  const { reviewCard: card, receipt, resumeFileName } = props.details;
  if (!card && !receipt && !resumeFileName) return null;
  const sent = receipt?.outcome === "submitted";
  const personConfirmed =
    sent &&
    receipt.evidence.some((entry) => entry.kind === "operator_confirmation");

  return (
    <details
      className="group rounded-(--radius-field) border border-(--surface-panel-border) px-3 py-2 text-sm"
      open={!sent}
    >
      <summary className="cursor-pointer font-semibold text-(--text-headline)">
        {sent ? "What was sent" : "What Apply filled in"}
      </summary>
      <div className="mt-2 grid gap-3">
        {props.details.application.state === "ready" &&
        card?.intermediateSaved ? (
          <p className="text-foreground-soft">
            Earlier answers or attachments were saved on the employer’s site.
            This application has not been sent. Review it before you send.
          </p>
        ) : null}
        {receipt ? (
          <div className="grid gap-0.5">
            <p>
              <span className="font-semibold">
                {OUTCOME_LABEL[receipt.outcome]}
              </span>
              {` · tried ${formatWhen(receipt.attemptedAt)}`}
              {receipt.verifiedAt
                ? ` · ${personConfirmed ? "you confirmed" : "site confirmed"} ${formatWhen(receipt.verifiedAt)}`
                : ""}
            </p>
            {receipt.outcome === "outcome_uncertain" ? (
              <p className="text-xs text-foreground-soft">
                {receipt.browserAction
                  ? receipt.browserAction.requestsAfterClick?.some(
                      (request) => request.finalSubmit,
                    )
                    ? "A send request was observed, but the site has not confirmed receipt. Nestor will not send it again automatically."
                    : "No application request or receipt was confirmed after the press. Nestor will not send it again automatically."
                  : "A press was recorded, but receipt is unconfirmed. Check the site before marking the outcome."}
              </p>
            ) : null}
            {receipt.evidence.map((entry) => (
              <p className="text-xs text-foreground-soft" key={entry.id}>
                {entry.summary}
              </p>
            ))}
          </div>
        ) : null}

        {card ? (
          <p className="text-foreground-soft">
            {card.siteLabel}
            {card.pageUrl && props.details.application.state !== "uncertain" ? (
              <>
                {" · "}
                <button
                  className="text-(--link) underline underline-offset-4 hover:text-(--link-hover)"
                  onClick={() => openUrlInJobFinderBrowser(card.pageUrl!)}
                  type="button"
                >
                  the form
                </button>
              </>
            ) : null}
            {` · filled ${formatWhen(card.preparedAt)}`}
          </p>
        ) : null}

        {resumeFileName || (card?.attachments.length ?? 0) > 0 ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {resumeFileName ? (
              <>
                <dt className="text-foreground-soft">Resume</dt>
                <dd className="min-w-0 truncate">{resumeFileName}</dd>
              </>
            ) : null}
            {card?.attachments.map((file) => (
              <div className="contents" key={`${file.field}:${file.fileName}`}>
                <dt className="text-foreground-soft">{file.label}</dt>
                <dd className="min-w-0 truncate">{file.fileName}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {card && card.waitingOnYou.length > 0 ? (
          <ul className="grid gap-0.5 text-(--warning-text)">
            {card.waitingOnYou.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}

        {card && card.answers.length > 0 ? (
          <dl className="grid gap-2">
            {card.answers.map((answer, index) => (
              <div key={answer.fieldKey ?? `${answer.question}:${index}`}>
                <dt className="text-foreground-soft">{answer.question}</dt>
                <dd className="whitespace-pre-wrap">
                  {answer.answer}
                  {answer.written ? (
                    <span className="ml-2 text-xs text-foreground-muted">
                      written for this job
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {card?.letter ? (
          <div className="grid gap-1">
            <p className="text-foreground-soft">Cover letter</p>
            <p className="whitespace-pre-wrap">{card.letter.text}</p>
          </div>
        ) : null}
      </div>
    </details>
  );
}
