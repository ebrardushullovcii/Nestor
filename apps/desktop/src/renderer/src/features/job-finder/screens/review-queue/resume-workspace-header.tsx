import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { ResumeDraft } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { formatRelativeTimestamp } from "./resume-workspace-time";
import {
  resolveJobEmployerDisplay,
  resolveJobLocationDisplay,
} from "../../lib/job-employer-location-display";

interface ResumeWorkspaceHeaderProps {
  draft: ResumeDraft;
  jobCompany: string;
  jobLocation: string;
  jobCanonicalUrl?: string | null;
  jobTitle: string;
  onBack: () => void;
  /** Controls for this resume that share the row, such as its language. */
  actions?: ReactNode;
}

export function ResumeWorkspaceHeader({
  draft,
  jobCompany,
  jobLocation,
  jobCanonicalUrl = null,
  jobTitle,
  onBack,
  actions,
}: ResumeWorkspaceHeaderProps) {
  const employerLocation = [
    resolveJobEmployerDisplay({
      company: jobCompany,
      canonicalUrl: jobCanonicalUrl,
    }),
    resolveJobLocationDisplay(jobLocation),
  ]
    .filter(Boolean)
    .join(" • ");
  const updated = formatRelativeTimestamp(draft.updatedAt);
  const approved = draft.approvedAt
    ? formatRelativeTimestamp(draft.approvedAt)
    : null;

  return (
    /* One row, and one owner of draft state. This header used to stack a Back
       row carrying an `Approved` / `Unsaved draft` badge above the title row,
       directly on top of the studio's own state banner, which says the same
       two things in the same words plus the next step and its action. Two
       stacked approval banners cost ~110px of a 640px-tall window, so the
       badges are gone: the studio banner owns state, and this row owns
       navigation, identity and timestamps. */
    <section className="surface-panel-shell relative flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-(--radius-field) border border-(--surface-panel-border) px-5 py-2">
      <Button
        className="-ml-2 self-center text-foreground-soft"
        onClick={onBack}
        size="xs"
        type="button"
        variant="ghost"
      >
        <ArrowLeft className="size-3.5" />
        Back to Shortlisted
      </Button>

      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        {/* Same compact page title as every other Job Finder route. The
            element defaults in `globals.css` now live in `@layer base`, so
            these utilities win on their own and no important modifier is
            needed here. */}
        <h1 className="min-w-0 break-words font-display text-(length:--text-page-title-compact) font-semibold leading-tight tracking-(--tracking-page-title-compact) text-(--headline-primary)">
          {jobTitle}
        </h1>
        <p className="min-w-0 break-words text-(length:--text-small) leading-5 text-foreground-soft">
          {employerLocation ? <span>{employerLocation}</span> : null}
          {employerLocation ? (
            <span className="text-foreground-muted"> · </span>
          ) : null}
          <span
            className="text-foreground-muted"
            {...(updated.absolute ? { title: updated.absolute } : {})}
          >
            Updated {updated.label}
          </span>
          {approved ? (
            <>
              <span className="text-foreground-muted"> · </span>
              <span
                className="text-foreground-muted"
                {...(approved.absolute ? { title: approved.absolute } : {})}
              >
                Approved {approved.label}
              </span>
            </>
          ) : null}
        </p>
      </div>
      {actions ? (
        <div className="ml-auto flex shrink-0 items-center self-center">
          {actions}
        </div>
      ) : null}
    </section>
  );
}
