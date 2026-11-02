import { Disclosure } from "@renderer/components/ui/disclosure";
import type {
  ApplicationDetails,
  AssistantNeedsView,
  NeedsYouTask,
} from "@nestor/contracts";
import {
  ArrowRight,
  Check,
  CircleStop,
  ExternalLink,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";

import { formatWhen } from "./tracker-format";
import { describeError } from "./use-application";

/** Apply's own record of one job's application, kept current as Apply works. */
export function useApplicationWork(jobId: number | null) {
  const [details, setDetails] = useState<ApplicationDetails | null>(null);
  const latest = useRef(jobId);
  latest.current = jobId;

  const load = useCallback(async () => {
    const id = latest.current;
    if (id === null) return;
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
        const id = latest.current;
        if (id !== null && (change.ids === null || change.ids.includes(id)))
          void load().catch(() => undefined);
      }),
    [load],
  );

  return details;
}

/**
 * Apply's side of one application: Open (and Stop, unless the status line
 * above carries it) while it is in flight, and the read-only record of what
 * went on the form.
 */
export function ApplicationWork(props: {
  details: ApplicationDetails | null;
  /** Off where the detail's Apply status line shows {@link StopApply}. */
  showStop: boolean;
  /** The job's application page, for Apply by hand after a failure. */
  applyUrl?: string | null;
}) {
  const { details } = props;
  if (!details) return null;
  return (
    <>
      <ApplyActions
        applyUrl={props.applyUrl ?? null}
        details={details}
        showStop={props.showStop}
      />
      <SentReview details={details} />
    </>
  );
}

function canStopApply(details: ApplicationDetails) {
  return ["queued", "running", "needs_you", "ready"].includes(
    details.application.state,
  );
}

/**
 * Stop, as a quiet button on Apply's status line: it stops Apply before it
 * sends, so it sits with the state it ends rather than with the forward
 * actions. The action row then stays on one line beside it, even at the
 * narrowest pane ("Answer in Needs you · Open application").
 */
export function StopApply(props: { details: ApplicationDetails | null }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const { details } = props;
  if (!details || !canStopApply(details)) return null;
  const stop = async () => {
    setBusy(true);
    try {
      const done = await window.nestor.jobFinder.stopApplication({
        id: details.application.id,
      });
      showToast(
        done
          ? { title: "Stopped. Apply won't send it." }
          : { title: "It had already moved on.", tone: "warning" },
      );
    } catch (error) {
      showToast({ title: describeError(error), tone: "warning" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      className="-my-1"
      data-stop-apply
      onClick={() => void stop()}
      pending={busy}
      size="toolbar"
      variant="ghost"
    >
      <CircleStop aria-hidden />
      Stop
    </Button>
  );
}

/** Needs you, opened on one of its items. */
function needsYouPath(focusId: number) {
  const view: AssistantNeedsView = { tab: "tasks", focusId };
  return `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify(view))}`;
}

/**
 * The first open item an application waiting on the person waits for: the
 * step its status names, so its filled action leads there.
 */
function useWaitingTask(application: ApplicationDetails["application"]) {
  const [task, setTask] = useState<{
    id: number;
    kind: NeedsYouTask["kind"];
  } | null>(null);
  const waiting = application.state === "needs_you";
  useEffect(() => {
    setTask(null);
    if (!waiting) return;
    let live = true;
    void Promise.resolve()
      .then(() =>
        window.nestor.needsYou.run("application_needs", { id: application.id }),
      )
      .then((tasks) => {
        const first = tasks[0];
        if (live && first) setTask({ id: first.id, kind: first.kind });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [application.id, application.attempt, waiting]);
  return waiting ? task : null;
}

/**
 * Open the page Apply prepared, stop Apply before it sends, start a run
 * that failed or was stopped before sending again, or settle a send the app
 * could not confirm with what the person saw on the site.
 */
function ApplyActions(props: {
  details: ApplicationDetails;
  showStop: boolean;
  applyUrl: string | null;
}) {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<
    "open" | "stop" | "retry" | "sent" | "not_sent" | null
  >(null);
  const { application, receipt } = props.details;
  const waiting = useWaitingTask(application);
  const canOpen = ["ready", "needs_you", "uncertain"].includes(
    application.state,
  );
  const canStop = props.showStop && canStopApply(props.details);
  // Only a run that never reached a send, or one stopped after the site or
  // the person said it was not sent: anything else the guarded send tried
  // keeps its receipt, and trying again could send it twice.
  const canRetry =
    ["failed", "stopped"].includes(application.state) &&
    application.submittedAt === null &&
    (receipt === null ||
      (application.state === "stopped" && receipt.outcome === "not_submitted"));
  const canSettle = application.state === "uncertain";
  // A failed run offers both ways on, as its row says ("Try again or apply
  // by hand") and as Shortlisted does.
  const byHand =
    application.state === "failed" && props.applyUrl ? props.applyUrl : null;
  if (!canOpen && !canStop && !canRetry && !canSettle && !byHand) return null;

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
            ? { title: "Moved to Applied", tone: "success" }
            : {
                title: "Marked as not sent",
                description: "Apply won't send it again by itself.",
                tone: "success",
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
      {byHand ? (
        <Button
          onClick={() => openUrlInJobFinderBrowser(byHand)}
          size="toolbar"
          title="Open the application page and apply yourself"
          variant={canRetry ? "outline" : "primary"}
        >
          <ExternalLink aria-hidden />
          Apply by hand
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
      {waiting ? (
        <Button
          onClick={() => void navigate(needsYouPath(waiting.id))}
          size="toolbar"
        >
          <ArrowRight aria-hidden />
          {waiting.kind === "question"
            ? "Answer in Needs you"
            : "Finish in Needs you"}
        </Button>
      ) : null}
      {canOpen ? (
        <Button
          onClick={() => void act("open")}
          pending={busy === "open"}
          size="toolbar"
          variant={waiting ? "outline" : "primary"}
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
          <CircleStop aria-hidden />
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
  // Only what reached a form: before any page was filled (a run that could
  // not open the job's page) the resume alone was listed under "What Apply
  // filled in", beside "Nothing was sent".
  if (!card && !receipt) return null;
  const sent = receipt?.outcome === "submitted";
  // One line per file: a form that asks for the same PDF twice ("Resume"
  // and "Your CV") lists it once, under both of the form's names.
  const files: { fileName: string; labels: string[] }[] = [];
  for (const [label, fileName] of [
    ...(resumeFileName ? [["Resume", resumeFileName] as const] : []),
    ...(card?.attachments ?? []).map(
      (file) => [file.label, file.fileName] as const,
    ),
  ]) {
    const same = files.find((entry) => entry.fileName === fileName);
    if (!same) files.push({ fileName, labels: [label] });
    else if (!same.labels.includes(label)) same.labels.push(label);
  }
  const personConfirmed =
    sent &&
    receipt.evidence.some((entry) => entry.kind === "operator_confirmation");

  return (
    // The detail's one disclosure style: the same quiet summary as "Log a
    // reply…" below it, contents indented under the chevron.
    <Disclosure
      className="text-sm"
      contentClassName="grid gap-3 pl-7.5"
      defaultOpen={!sent}
      key={sent ? "sent" : "filled"}
      summary={sent ? "What was sent" : "What Apply filled in"}
    >
      {props.details.application.state === "ready" &&
      card?.intermediateSaved ? (
        <p className="text-foreground-soft">
          Earlier answers or attachments were saved on the employer’s site. This
          application has not been sent. Review it before you send.
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

      {files.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {files.map((file) => (
            <div className="contents" key={file.fileName}>
              <dt className="text-foreground-soft">{file.labels.join(", ")}</dt>
              <dd className="min-w-0 truncate">{file.fileName}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {card && card.waitingOnYou.length > 0 ? (
        // Body text with an amber marker: a run of amber prose read as a
        // warning banner, where amber only means "waiting on you".
        <ul className="grid gap-0.5 text-foreground">
          {card.waitingOnYou.map((item) => (
            <li className="flex items-baseline gap-2" key={item}>
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 -translate-y-0.5 rounded-full bg-(--warning-text)"
              />
              <span className="min-w-0">{item}</span>
            </li>
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
    </Disclosure>
  );
}
