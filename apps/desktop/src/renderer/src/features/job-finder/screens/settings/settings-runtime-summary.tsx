import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { BrowserSessionState, JobFinderSettings } from "@nestor/contracts";
import { StatusBadge } from "../../components/status-badge";
import { formatStatusLabel, getSessionTone } from "../../lib/job-finder-utils";

interface SettingsRuntimeSummaryProps {
  browserSession: BrowserSessionState;
  settings: JobFinderSettings;
}

function getBrowserLabel(driver: BrowserSessionState["driver"]): string {
  switch (driver) {
    case "embedded_browser_agent":
      return "Built-in browser session";
    case "chrome_profile_agent":
      return "Connected Chrome session";
    // Not started yet: the first search opens the browser, so this is a
    // waiting state rather than the catalog-only build.
    case "uninitialized":
      return "Browser session not started";
    default:
      return "Catalog search only";
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
  browserSession,
  settings,
}: SettingsRuntimeSummaryProps) {
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
          <StatusBadge tone={getSessionTone(browserSession)}>
            {formatStatusLabel(browserSession.status)}
          </StatusBadge>
        </div>
        <strong className="text-(length:--text-body) font-semibold text-foreground">
          {getBrowserLabel(browserSession.driver)}
        </strong>
        <p className="text-(length:--text-description) leading-5 text-foreground-soft">
          {browserSession.detail?.trim() || browserSession.label}
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
