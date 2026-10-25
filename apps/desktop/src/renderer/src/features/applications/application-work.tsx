import type { ApplicationDetails } from "@nestor/contracts";
import { ExternalLink, Square } from "lucide-react";
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

/** Open the page Apply prepared, or stop Apply before it sends. */
function ApplyActions(props: { details: ApplicationDetails }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState<"open" | "stop" | null>(null);
  const { application } = props.details;
  const canOpen = ["ready", "needs_you"].includes(application.state);
  const canStop = ["queued", "running", "needs_you", "ready"].includes(
    application.state,
  );
  if (!canOpen && !canStop) return null;

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
                    ? "Restoring the form for your review. Apply won't send it."
                    : "Opened the application page"
                  : "Stopped. Apply won't send it.",
            }
          : {
              title:
                kind === "open"
                  ? "The application page isn't open any more."
                  : "It had already moved on.",
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
      {canOpen ? (
        <Button
          onClick={() => void act("open")}
          pending={busy === "open"}
          size="toolbar"
        >
          <ExternalLink aria-hidden />
          Open application
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

  return (
    <details
      className="group rounded-(--radius-field) border border-(--surface-panel-border) px-3 py-2 text-sm"
      open={!sent}
    >
      <summary className="cursor-pointer font-semibold text-(--text-headline)">
        {sent ? "What was sent" : "What Apply filled in"}
      </summary>
      <div className="mt-2 grid gap-3">
        {receipt ? (
          <div className="grid gap-0.5">
            <p>
              <span className="font-semibold">
                {OUTCOME_LABEL[receipt.outcome]}
              </span>
              {` · tried ${formatWhen(receipt.attemptedAt)}`}
              {receipt.verifiedAt
                ? ` · confirmed ${formatWhen(receipt.verifiedAt)}`
                : ""}
            </p>
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
            {card.pageUrl ? (
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
