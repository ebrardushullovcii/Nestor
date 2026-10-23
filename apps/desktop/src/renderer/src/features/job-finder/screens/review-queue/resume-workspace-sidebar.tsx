import type { JobFinderResumeWorkspace } from "@nestor/contracts";
import { isBlockingResumeValidationIssue } from "@nestor/contracts";
import { formatStatedNormalizedCompensation } from "../../lib/normalized-compensation";
import { ExternalUrlLink } from "../../components/open-outside-links";
import { ResumeClaimTrustPanel } from "./resume-claim-trust-panel";
import { formatOptionalDate } from "./resume-workspace-utils";

interface ResumeWorkspaceSidebarProps {
  hasUnsavedChanges: boolean;
  workspace: JobFinderResumeWorkspace;
}

function formatHostLabel(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value.trim();
  }
}

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const normalized = value?.trim();

    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function ResumeWorkspaceSidebar({
  hasUnsavedChanges,
  workspace,
}: ResumeWorkspaceSidebarProps) {
  const { job, research, sharedProfile, validation } = workspace;
  const researchCount = research.length;
  const validationIssues = validation?.issues ?? [];
  const blockingIssueCount = validationIssues.filter(
    isBlockingResumeValidationIssue,
  ).length;
  const normalizedCompensation = formatStatedNormalizedCompensation(job);
  const roleSnapshot = [
    job.salaryText ? `Compensation: ${job.salaryText}` : null,
    normalizedCompensation ? `Normalized: ${normalizedCompensation}` : null,
    job.team ? `Team: ${job.team}` : null,
    job.department ? `Department: ${job.department}` : null,
  ].filter(Boolean) as string[];
  const targetingCues = [
    ...job.keywordSignals.map((signal) => signal.label),
    ...job.responsibilities,
    ...job.minimumQualifications,
  ];
  const profileSummary = firstNonEmpty(
    sharedProfile.narrativeSummary,
    sharedProfile.selfIntroduction,
    sharedProfile.nextChapterSummary,
  );
  const highlightedProof = sharedProfile.highlightedProofs[0] ?? null;
  const screeningSummary = firstNonEmpty(
    job.screeningHints.sponsorshipText,
    job.screeningHints.relocationText,
    job.screeningHints.travelText,
    job.screeningHints.remoteGeographies[0]
      ? `Remote geography: ${job.screeningHints.remoteGeographies[0]}`
      : null,
  );
  const targetingSummary = firstNonEmpty(targetingCues.join(" • "));
  const leadResearch = research[0] ?? null;
  const employerHost = formatHostLabel(job.employerWebsiteUrl);
  const applicationHost = formatHostLabel(job.applicationUrl);
  const titleId = "resume-workspace-job-context-title";

  return (
    <aside
      aria-labelledby={titleId}
      className="surface-panel-shell relative grid min-h-0 min-w-0 gap-3 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) p-(--resume-sidebar-padding)"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          id={titleId}
          className="font-display text-(length:--text-label) font-bold uppercase tracking-(--tracking-caps) text-primary"
        >
          Job context
        </p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground-soft">
        <p>
          {researchCount === 1 ? "Saved research note" : "Saved research notes"}
          : {researchCount}
        </p>
        <p>
          {validationIssues.length === 1
            ? "Validation check"
            : "Validation checks"}
          : {validationIssues.length}
        </p>
        {blockingIssueCount > 0 ? (
          <p className="font-medium text-(--warning-text)">
            {blockingIssueCount} blocking issue
            {blockingIssueCount === 1 ? "" : "s"} must be fixed before approval.
          </p>
        ) : null}
        {hasUnsavedChanges ? (
          <p className="text-(--warning-text)">
            Unsaved edits stay local until you save or run another action.
          </p>
        ) : null}
      </div>

      <div className="grid min-h-0 gap-3 xl:grid-cols-(--resume-sidebar-columns)">
        <div className="surface-card-tint grid min-w-0 gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-4">
          <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-foreground-soft">
            Role snapshot
          </p>
          <div className="grid gap-1.5 text-sm text-foreground-soft">
            <p>
              <strong className="text-foreground">Work mode:</strong>{" "}
              {job.workMode.join(", ") || "Not specified"}
            </p>
            <p>
              <strong className="text-foreground">Posted:</strong>{" "}
              {formatOptionalDate(job.postedAt, job.postedAtText)}
            </p>
            {job.seniority || job.employmentType ? (
              <p>
                <strong className="text-foreground">Role:</strong>{" "}
                {[job.seniority, job.employmentType]
                  .filter(Boolean)
                  .join(" • ")}
              </p>
            ) : null}
            {roleSnapshot.map((snapshot) => (
              <p key={snapshot} className="break-words">
                {snapshot}
              </p>
            ))}
            {targetingSummary ? (
              <p className="break-words">
                <strong className="text-foreground">Targeting:</strong>{" "}
                {targetingSummary}
              </p>
            ) : null}
            {screeningSummary ? (
              <p className="break-words">
                <strong className="text-foreground">Screening:</strong>{" "}
                {screeningSummary}
              </p>
            ) : null}
          </div>
        </div>

        <div className="surface-card-tint grid min-w-0 gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-4">
          <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-foreground-soft">
            Shared profile inputs
          </p>
          {profileSummary ? (
            <p className="break-words text-sm leading-6 text-foreground-soft">
              {profileSummary}
            </p>
          ) : null}
          {highlightedProof ? (
            <div className="grid gap-1 text-sm text-foreground-soft">
              <strong className="break-words text-foreground">
                {highlightedProof.title}
              </strong>
              <p className="break-words">{highlightedProof.claim}</p>
              {highlightedProof.heroMetric ? (
                <p className="break-words">
                  Metric: {highlightedProof.heroMetric}
                </p>
              ) : null}
            </div>
          ) : null}
          {!profileSummary && !highlightedProof ? (
            <p className="text-sm text-foreground-soft">
              No reusable profile context saved yet.
            </p>
          ) : null}
        </div>

        <div className="surface-card-tint grid min-w-0 gap-2 rounded-(--radius-field) border border-(--surface-panel-border) p-4">
          <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-foreground-soft">
            Saved research
          </p>
          {research.length === 0 ? (
            <p className="text-sm text-foreground-soft">
              No research saved yet.
            </p>
          ) : null}
          {leadResearch ? (
            <div className="grid gap-1 text-sm text-foreground-soft">
              <strong className="break-words text-foreground">
                <ExternalUrlLink
                  className="break-words"
                  label={leadResearch.pageTitle ?? leadResearch.sourceUrl}
                  url={leadResearch.sourceUrl}
                />
              </strong>
              <span className="break-words">
                {formatHostLabel(leadResearch.sourceUrl)}
              </span>
            </div>
          ) : null}

          {job.applicationUrl || job.employerWebsiteUrl || job.atsProvider ? (
            <div className="grid gap-1 border-t border-(--surface-panel-border) pt-2 text-(length:--text-small) leading-5 text-foreground-soft">
              {job.atsProvider ? (
                <p className="break-words">Provider: {job.atsProvider}</p>
              ) : null}
              {employerHost && job.employerWebsiteUrl ? (
                <p className="break-words">
                  Employer site:{" "}
                  <ExternalUrlLink
                    className="break-words"
                    label={employerHost}
                    url={job.employerWebsiteUrl}
                  />
                </p>
              ) : null}
              {applicationHost && job.applicationUrl ? (
                <p className="break-words">
                  Apply route:{" "}
                  <ExternalUrlLink
                    className="break-words"
                    label={applicationHost}
                    url={job.applicationUrl}
                  />
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <ResumeClaimTrustPanel
          draft={workspace.draft}
          hasUnsavedChanges={hasUnsavedChanges}
          validation={validation}
        />
      </div>
    </aside>
  );
}
