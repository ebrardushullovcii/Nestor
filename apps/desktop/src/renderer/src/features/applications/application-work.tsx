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
  Send,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";

import {
  actionSite,
  doneSoFar,
  sentStatus,
  taskAction,
  type ActionNeeded,
} from "./action-needed";
import { ActionNeededLine } from "./action-needed-line";
import { formatWhen } from "./tracker-format";
import { describeError } from "./use-application";

/**
 * A multi-select answer is stored as a JSON list of its exact options so an
 * option containing a comma keeps its identity. Show it as the plain list
 * the person chose; any other answer is shown exactly as stored.
 */
function reviewAnswerText(answer: string): string {
  if (!answer.startsWith("[")) return answer;
  try {
    const choices: unknown = JSON.parse(answer);
    return Array.isArray(choices) &&
      choices.length > 0 &&
      choices.every((choice) => typeof choice === "string")
      ? choices.join(", ")
      : answer;
  } catch {
    return answer;
  }
}

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
  return (
    !isConfirmedSent(details) &&
    ["queued", "running", "needs_you", "ready"].includes(
      details.application.state,
    )
  );
}

/** The application record, timestamp and receipt each retain a confirmed send. */
function isConfirmedSent({ application, receipt }: ApplicationDetails) {
  return (
    application.state === "submitted" ||
    application.submittedAt !== null ||
    receipt?.outcome === "submitted"
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
 * The first open item an application waiting on the person waits for, and
 * how many it waits on: the step its status names, so its filled action
 * leads there and its lead line names it.
 */
function useWaitingTask(application: ApplicationDetails["application"]) {
  const [waiting, setWaiting] = useState<{
    task: NeedsYouTask;
    count: number;
  } | null>(null);
  const isWaiting = application.state === "needs_you";
  useEffect(() => {
    setWaiting(null);
    if (!isWaiting) return;
    let live = true;
    void Promise.resolve()
      .then(() =>
        window.nestor.needsYou.run("application_needs", { id: application.id }),
      )
      .then((tasks) => {
        const first = tasks[0];
        if (live && first) setWaiting({ task: first, count: tasks.length });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [application.id, application.attempt, isWaiting]);
  return isWaiting ? waiting : null;
}

/**
 * The lead line of an application handed to the person: what to do on which
 * site, what the run recorded doing, and whether anything was sent. A send
 * the app could not confirm leads with checking the site.
 */
function applicationActionLine(
  details: ApplicationDetails,
  waiting: { task: NeedsYouTask; count: number } | null,
): ActionNeeded | null {
  const { application } = details;
  const done = doneSoFar(details);
  const sent = sentStatus(details);
  if (application.state === "uncertain")
    return {
      site: application.company,
      action:
        "Check your account on the employer’s site, then press “It went through” or “It didn’t go through”.",
      done,
      sent,
    };
  if (!waiting) return null;
  const more = waiting.count - 1;
  return {
    site: actionSite(waiting.task, [application]),
    action: `${taskAction(waiting.task, {
      onApplication: true,
      accessDetail: details.accessDetail ?? null,
    })}${more > 0 ? ` ${more === 1 ? "1 more item waits" : `${more} more items wait`} in Needs you.` : ""}`,
    done,
    sent,
  };
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
    "open" | "stop" | "retry" | "send" | "sent" | "not_sent" | null
  >(null);
  const { application, receipt } = props.details;
  const confirmedSent = isConfirmedSent(props.details);
  const waitingOn = useWaitingTask(application);
  const waiting = waitingOn?.task ?? null;
  const line = confirmedSent
    ? null
    : applicationActionLine(props.details, waitingOn);
  const canOpen = ["ready", "needs_you", "uncertain"].includes(
    application.state,
  );
  const canStop = props.showStop && canStopApply(props.details);
  // A failed attempt can start a new run; its old send stays in the ledger.
  const canRetry =
    ["ready", "needs_you", "failed", "stopped"].includes(application.state) &&
    !confirmedSent &&
    (application.state === "failed" ||
      receipt === null ||
      (application.state === "stopped" && receipt.outcome === "not_submitted"));
  const canSettle = !confirmedSent;
  const canSend = !confirmedSent && application.state === "ready";
  // A failed run offers both ways on, as its row says ("Try again or apply
  // by hand") and as Shortlisted does.
  const byHand =
    application.state === "failed" && props.applyUrl ? props.applyUrl : null;
  // A line only leads a handoff (needs you, or an unconfirmed send), and
  // both always offer an action below it.
  if (!canOpen && !canStop && !canRetry && !canSettle && !byHand) return null;

  const settle = async (sent: boolean) => {
    setBusy(sent ? "sent" : "not_sent");
    try {
      const done = await window.nestor.jobFinder.reportApplicationSend({
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
      const queued = await window.nestor.jobFinder.retryApplication({
        id: application.id,
      });
      showToast(
        queued
          ? {
              title:
                application.state !== "failed"
                  ? "Applying again"
                  : "Trying again",
              description:
                "Apply fills the form in again with your saved answers.",
            }
          : {
              title: "It couldn't start again",
              description:
                "Check that this job has a ready resume and has not already been sent.",
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
      const opened =
        kind === "open"
          ? await window.nestor.jobFinder.openApplication(target)
          : null;
      const done = opened
        ? opened.opened
        : await window.nestor.jobFinder.stopApplication(target);
      showToast(
        done
          ? {
              title:
                kind === "open"
                  ? !opened?.retained
                    ? "The earlier page is gone. Opened the application URL."
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

  const send = async () => {
    setBusy("send");
    try {
      await window.nestor.jobFinder.sendApplication({ id: application.id });
      const next = await window.nestor.jobFinder.getApplicationDetails({
        id: application.id,
      });
      showToast(
        next?.application.state === "submitted"
          ? { title: "Application sent", tone: "success" }
          : {
              title:
                next?.application.state === "uncertain"
                  ? "Send recorded; receipt is unconfirmed"
                  : "The application has not been confirmed sent",
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
    <>
      {line ? <ActionNeededLine line={line} /> : null}
      <div className="flex flex-wrap gap-2">
        {canSend ? (
          <Button
            disabled={busy !== null}
            onClick={() => void send()}
            pending={busy === "send"}
            size="toolbar"
          >
            <Send aria-hidden />
            Send
          </Button>
        ) : null}
        {canRetry && ["failed", "stopped"].includes(application.state) ? (
          <Button
            onClick={() => void retry()}
            pending={busy === "retry"}
            size="toolbar"
          >
            <RotateCcw aria-hidden />
            Apply again
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
        {canSettle && application.state === "uncertain" ? (
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
            variant={waiting || canSend ? "outline" : "primary"}
          >
            <ExternalLink aria-hidden />
            {application.state === "uncertain"
              ? "Check site"
              : "Open application"}
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
      {canSettle && application.state !== "uncertain" ? (
        <Disclosure
          className="text-sm"
          contentClassName="flex flex-wrap gap-2 pl-7.5"
          summary="More actions…"
        >
          <Button
            disabled={busy !== null}
            onClick={() => void settle(true)}
            pending={busy === "sent"}
            size="toolbar"
            variant="outline"
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
          {canRetry && ["ready", "needs_you"].includes(application.state) ? (
            <Button
              disabled={busy !== null}
              onClick={() => void retry()}
              pending={busy === "retry"}
              size="toolbar"
              variant="ghost"
            >
              <RotateCcw aria-hidden />
              Apply again
            </Button>
          ) : null}
        </Disclosure>
      ) : null}
    </>
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
                {reviewAnswerText(answer.answer)}
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
