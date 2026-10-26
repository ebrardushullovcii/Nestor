import { ShieldAlert, ShieldCheck } from "lucide-react";
import type {
  DesktopBrowserState,
  JobFinderSettings,
} from "@nestor/contracts";
import { StatusBadge } from "../../components/status-badge";
import type { BadgeTone } from "../../lib/job-finder-types";

interface SettingsRuntimeSummaryProps {
  /** The built-in browser; null until its first state arrives. */
  browser: DesktopBrowserState | null;
  settings: JobFinderSettings;
}

function describeBrowser(browser: DesktopBrowserState | null): {
  status: string;
  tone: BadgeTone;
  detail: string;
} {
  switch (browser?.phase) {
    case "ready":
      return { status: "Ready", tone: "positive", detail: "Open and idle." };
    case "working":
      return {
        status: "Working",
        tone: "active",
        detail: browser.activity ?? "Working on a search or an application.",
      };
    case "needs_you":
      return {
        status: "Needs you",
        tone: "active",
        detail: "A page is waiting for you in the browser.",
      };
    case "pausing":
    case "paused":
      return {
        status: "Paused",
        tone: "muted",
        detail: "Browser work is paused until you resume it.",
      };
    default:
      // Closed, closing, or not read yet: the browser opens when a search or
      // an application needs it.
      return {
        status: "Not open",
        tone: "muted",
        detail: "It opens when a search or an application needs it.",
      };
  }
}
export function getApplySafeguardCopy(usesOriginalResume: boolean): {
  title: string;
  description: string;
} {
  return usesOriginalResume
    ? {
        title: "Original resume required",
        description:
          "Job Finder uses the exact imported resume only while that file is still available and unchanged. Sending follows the mode you choose under Applying.",
      }
    : {
        title: "Resume checked before applying",
        description:
          "Job Finder checks the resume selected for each job. Original files keep their format; generated resumes use the approved version. Sending follows the mode you choose under Applying.",
      };
}

export function SettingsRuntimeSummary({
  browser,
  settings,
}: SettingsRuntimeSummaryProps) {
  const browserStatus = describeBrowser(browser);
  const applySafeguardCopy = getApplySafeguardCopy(
    settings.resumeApplicationMode === "original_resume",
  );
  return (
    <section className="surface-panel-shell relative grid content-start gap-2.5 rounded-(--radius-field) border border-(--surface-panel-border) px-3.5 py-3.5">
      <div className="grid gap-0.5">
        <div className="flex items-center gap-3">
          <ShieldCheck className="size-4 text-primary" />
          <p className="font-display text-(length:--text-eyebrow) font-semibold uppercase tracking-(--tracking-badge) text-foreground">
            Live status
          </p>
        </div>
        <h2 className="font-semibold text-(--text-headline)">
          What&apos;s running right now
        </h2>
        <p className="text-(length:--text-description) leading-5 text-foreground-soft">
          The state of the Job Finder browser, and the rule that applies the
          next time an application is prepared.
        </p>
      </div>

      <section className="surface-card-tint grid gap-2.5 rounded-(--radius-field) border border-(--surface-panel-border) px-3.5 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[10px] uppercase tracking-(--tracking-badge) text-muted-foreground">
            Browser
          </span>
          <StatusBadge tone={browserStatus.tone}>
            {browserStatus.status}
          </StatusBadge>
        </div>
        <strong className="text-(length:--text-body) font-semibold text-foreground">
          Built-in browser
        </strong>
        <p className="text-(length:--text-description) leading-5 text-foreground-soft">
          {browserStatus.detail}
        </p>
        <p className="text-(length:--text-small) leading-5 text-foreground-soft">
          Browser session persistence is currently{" "}
          {settings.keepSessionAlive ? "on" : "off"}.
        </p>
      </section>

      <section className="surface-card-tint grid gap-2.5 rounded-(--radius-field) border border-(--surface-panel-border) px-3.5 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[10px] uppercase tracking-(--tracking-badge) text-muted-foreground">
            Search results
          </span>
          <StatusBadge tone={settings.discoveryOnly ? "muted" : "active"}>
            {settings.discoveryOnly
              ? "Only jobs you shortlist"
              : "Keep every result"}
          </StatusBadge>
        </div>
        <strong className="text-(length:--text-body) font-semibold text-foreground">
          {settings.discoveryOnly
            ? "Only jobs you shortlist are kept"
            : "Every new result can stay visible"}
        </strong>
        <p className="text-(length:--text-description) leading-5 text-foreground-soft">
          {settings.discoveryOnly
            ? "Only jobs you actively shortlist are kept in the workspace."
            : "Fresh search results remain available until you clean them up or move them forward."}
        </p>
      </section>

      <section className="surface-card-tint grid gap-2.5 rounded-(--radius-field) border border-(--surface-panel-border) px-3.5 py-3.5">
        <div className="flex items-center gap-3">
          <ShieldAlert className="size-4 text-destructive" />
          {/* This was an <h2> styled as a 14px uppercase badge, so it sat
              below the 19px "Runtime guardrails" <h2> it belongs under and
              inverted the scale. An eyebrow is never a heading: the label is
              a div at the eyebrow token, and the card's real title carries
              the heading level under it. */}
          <div className="font-display text-(length:--text-eyebrow) font-semibold uppercase tracking-(--tracking-badge) text-foreground">
            Apply safeguard
          </div>
        </div>
        <h3 className="font-semibold text-foreground">
          {applySafeguardCopy.title}
        </h3>
        <p className="text-(length:--text-description) leading-5 text-foreground-soft">
          {applySafeguardCopy.description}
        </p>
      </section>
    </section>
  );
}
