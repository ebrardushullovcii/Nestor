import { useState } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { OPEN_JOB_FINDER_BROWSER_ACTION } from "@renderer/features/job-finder/lib/job-finder-browser-handoff-copy";
import { JOB_FINDER_ROUTE_PATHS } from "@renderer/features/job-finder/lib/job-finder-route-hrefs";
import {
  getDiscoveryRunFailureRecovery,
  type DiscoveryRunFeedback,
} from "./discovery-run-feedback";

/** The fallback recovery, which explains nothing a note could repeat. */
const GENERIC_RECOVERY_HEADLINE = getDiscoveryRunFailureRecovery("").headline;

const TONE_CLASS_NAMES: Record<DiscoveryRunFeedback["status"], string> = {
  failed:
    "border-(--warning-border) bg-(--warning-surface) text-(--warning-text)",
  started: "border-(--info-border) bg-(--info-surface) text-(--info-text)",
  cancelled: "border-(--info-border) bg-(--info-surface) text-(--info-text)",
  paused:
    "border-(--warning-border) bg-(--warning-surface) text-(--warning-text)",
  succeeded:
    "border-(--success-border) bg-(--success-surface) text-(--success-text)",
};

/**
 * Shared outcome feedback for every visible Search now entry point. The
 * clicked control stays truthful: pending is shown by the control itself,
 * and this callout reports started/succeeded/cancelled/failed — cancelled
 * stays a neutral status (never success, never an alert) because the run was
 * stopped deliberately.
 */
export function DiscoveryRunFeedbackCallout(props: {
  feedback: DiscoveryRunFeedback;
  isRecoveryPending?: boolean;
  /**
   * Run-level warnings recorded by the run itself, printed verbatim. They
   * describe what the finished run did or did not read, so they carry no
   * corrective action of their own.
   */
  notices?: readonly string[];
  /**
   * Lets the reader clear the banner once they have read it. Every notice
   * like this is temporary, and on Find jobs it sits above the results, so
   * without this it takes list space for as long as the run stays newest.
   */
  onDismiss?: () => void;
  onOpenBrowserSession?: () => void;
  suppressBrowserRecovery?: boolean;
}) {
  const {
    feedback,
    isRecoveryPending = false,
    onDismiss,
    onOpenBrowserSession,
    suppressBrowserRecovery = false,
  } = props;
  // A run note that is the engine's own wording of the failure the recovery
  // line already explains ("Agent discovery failed: AI client does not
  // support tool calling") said the same thing again in internal terms.
  const notices = (props.notices ?? []).filter(
    (notice) =>
      !feedback.recovery ||
      getDiscoveryRunFailureRecovery(notice).headline !==
        feedback.recovery.headline ||
      feedback.recovery.headline === GENERIC_RECOVERY_HEADLINE,
  );
  // Several run notes fold behind one line so the banner stays short; a
  // single note reads inline. Open by default only while there is little.
  const [notesOpen, setNotesOpen] = useState(false);
  const foldNotes = notices.length > 1;
  const recovery = feedback.recovery;
  const isBrowserRecoverySuppressed =
    suppressBrowserRecovery && recovery?.kind === "browser_session";
  // Interrupted feedback already owns the stopped headline; never reprint the
  // same sentence from recovery.headline (Priya WAVE 3 double-banner).
  const recoveryHeadline =
    recovery &&
    !isBrowserRecoverySuppressed &&
    recovery.headline !== feedback.headline
      ? recovery.headline
      : null;

  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className={`relative grid gap-1 rounded-(--radius-field) border px-3 py-2.5 text-(length:--text-description) leading-6 ${onDismiss ? "pr-10" : ""} ${TONE_CLASS_NAMES[feedback.status]}`}
      data-testid="discovery-run-feedback"
      role={feedback.status === "failed" ? "alert" : "status"}
    >
      {onDismiss ? (
        <Button
          aria-label="Dismiss this notice"
          className="absolute right-1.5 top-1.5 h-7 w-7 rounded-full p-0 text-current opacity-70 hover:opacity-100"
          onClick={onDismiss}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      ) : null}
      <p className="font-medium">
        {feedback.headline}
        {feedback.safeguardAction ? (
          <>
            {" · "}
            <Link
              className="underline underline-offset-2"
              to={feedback.safeguardAction.route}
            >
              {feedback.safeguardAction.label}
            </Link>
          </>
        ) : null}
      </p>
      {recoveryHeadline ? (
        <p className="opacity-90">{recoveryHeadline}</p>
      ) : null}
      {foldNotes ? (
        <button
          aria-expanded={notesOpen}
          className="w-fit text-left underline underline-offset-2 opacity-90"
          onClick={() => setNotesOpen((open) => !open)}
          type="button"
        >
          {notesOpen
            ? "Hide the notes from this search"
            : `${notices.length} notes from this search`}
        </button>
      ) : null}
      {!foldNotes || notesOpen
        ? notices.map((notice) => (
            <p
              className="opacity-90"
              data-testid="discovery-run-notice"
              key={notice}
            >
              {notice}
            </p>
          ))
        : null}
      {recovery && !isBrowserRecoverySuppressed ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          {recovery.kind === "browser_session" && onOpenBrowserSession ? (
            <Button
              onClick={onOpenBrowserSession}
              pending={isRecoveryPending}
              size="sm"
              type="button"
              variant="primary"
            >
              {recovery.actionLabel ?? OPEN_JOB_FINDER_BROWSER_ACTION}
            </Button>
          ) : null}
          {recovery.kind === "source_setup" ? (
            <Button asChild size="sm" type="button" variant="primary">
              <Link to={JOB_FINDER_ROUTE_PATHS.profileSources}>
                {recovery.actionLabel ?? "Review job sources"}
              </Link>
            </Button>
          ) : null}
          <span className="text-(length:--text-small) opacity-80">
            {recovery.nextStep}
          </span>
        </div>
      ) : null}
    </div>
  );
}
