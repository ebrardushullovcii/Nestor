import type { JobFinderResumeWorkspaceStrategyContext } from "@nordri/contracts";
import {
  formatPersistedStrategyReason,
  resumeCoveragePolicyLabels,
  resumeHeadlinePolicyLabels,
  resumeSkillsPolicyLabels,
  resumeApproachLabels,
  resumeTemplateLabels,
} from "../resume-strategies/resume-strategy-presentation";

function SourceBadge(props: { children: string }) {
  return (
    <span className="inline-flex h-5 items-center rounded-full bg-(--input) px-2 text-[0.65rem] font-medium text-foreground">
      {props.children}
    </span>
  );
}

function describeEffectiveApproachLine(
  strength: "conservative" | "balanced" | "aggressive",
  source: "strategy" | "default",
): string {
  const label = resumeApproachLabels[strength];
  return source === "default"
    ? `Your default: ${label}`
    : `This draft: ${label}`;
}

export function ResumeStrategyContextPanel(props: {
  context: JobFinderResumeWorkspaceStrategyContext | null;
  effectiveTailoringStrength?:
    | "conservative"
    | "balanced"
    | "aggressive"
    | null;
}) {
  const { context } = props;

  if (!context) {
    if (!props.effectiveTailoringStrength) {
      return null;
    }

    return (
      <details className="group min-w-0">
        <summary className="surface-panel-shell flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-2 outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-[3px] focus-visible:ring-ring/40">
          <span className="grid min-w-0 gap-0.5">
            <span className="font-display text-(length:--text-label) font-bold uppercase tracking-(--tracking-caps) text-primary">
              Resume approach
            </span>
            <span className="min-w-0 text-(length:--text-small) leading-5 text-foreground-soft [overflow-wrap:anywhere]">
              {describeEffectiveApproachLine(
                props.effectiveTailoringStrength,
                "default",
              )}
            </span>
          </span>
        </summary>
        <div className="grid gap-3 pt-2">
          <p className="text-(length:--text-small) leading-6 text-foreground-soft">
            No named resume approach is selected for this job. This draft uses
            your default tailoring strength.
          </p>
          {props.effectiveTailoringStrength === "aggressive" ? (
            <p className="text-(length:--text-small) leading-6 text-foreground-soft">
              That default can stretch evidenced years by one toward the job's
              stated ask and add technologies the listing names — including in
              qualifications — so the resume can clear screening for a first
              interview. You confirm each stretch before export.
            </p>
          ) : null}
        </div>
      </details>
    );
  }

  const hasRecommendation = Boolean(context.recommendedStrategyId);
  const hasSelection = Boolean(context.selectedStrategyId);

  return (
    <details className="group min-w-0">
      <summary className="surface-panel-shell flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-2 outline-none [&::-webkit-details-marker]:hidden focus-visible:ring-[3px] focus-visible:ring-ring/40">
        <span className="grid min-w-0 gap-0.5">
          <span className="font-display text-(length:--text-label) font-bold uppercase tracking-(--tracking-caps) text-primary">
            Resume approach
          </span>
          <span className="min-w-0 text-(length:--text-small) leading-5 text-foreground-soft [overflow-wrap:anywhere]">
            {hasRecommendation
              ? `Recommended: ${context.recommendedStrategyName ?? "an approach"}. Advisory only — it never approves this resume.`
              : "No resume approach recommended for this job. Advisory only — it never approves this resume."}
          </span>
          {context.tailoringStrength ? (
            <span className="min-w-0 text-(length:--text-small) leading-5 text-foreground-soft [overflow-wrap:anywhere]">
              {describeEffectiveApproachLine(
                context.tailoringStrength,
                "strategy",
              )}
            </span>
          ) : props.effectiveTailoringStrength ? (
            <span className="min-w-0 text-(length:--text-small) leading-5 text-foreground-soft [overflow-wrap:anywhere]">
              {describeEffectiveApproachLine(
                props.effectiveTailoringStrength,
                "default",
              )}
            </span>
          ) : null}
        </span>
      </summary>
      <div className="grid gap-3 pt-2">
        <div className="surface-panel-shell grid min-w-0 gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-4">
          {hasRecommendation ? (
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-(length:--text-label) uppercase tracking-(--tracking-heading) text-muted-foreground">
                  Why this was recommended
                </span>
                <SourceBadge>
                  {context.recommendationSource === "role_family"
                    ? "Role-family match"
                    : context.recommendationSource === "campaign_default"
                      ? "Search plan default"
                      : "No match"}
                </SourceBadge>
              </div>
              <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                {context.recommendationReason
                  ? formatPersistedStrategyReason(context.recommendationReason)
                  : null}
              </p>
              {context.roleFamily ? (
                <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                  Matched role family: {context.roleFamily}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-1">
              <span className="text-(length:--text-label) uppercase tracking-(--tracking-heading) text-muted-foreground">
                No recommendation
              </span>
              <p className="text-(length:--text-small) leading-6 text-foreground-soft">
                {context.recommendationReason ??
                  "No enabled approach matches this job's role family and no search plan default is set."}
              </p>
            </div>
          )}

          {hasSelection ? (
            <div className="grid gap-1 rounded-(--radius-small) border border-border-subtle bg-background/35 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-(length:--text-label) uppercase tracking-(--tracking-heading) text-muted-foreground">
                  Your choice
                </span>
                <SourceBadge>
                  {context.selectionSource === "user"
                    ? "Manual"
                    : context.selectionSource === "campaign_default"
                      ? "Search plan default"
                      : context.selectionSource === "rule_match"
                        ? "Role-family match"
                        : "Selection"}
                </SourceBadge>
              </div>
              <p className="text-(length:--text-small) font-semibold text-(--text-headline)">
                {context.selectedStrategyName ?? context.selectedStrategyId}
              </p>
              <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                {context.selectionReason
                  ? formatPersistedStrategyReason(context.selectionReason)
                  : null}
              </p>
              {context.selectedAt ? (
                <p className="text-(length:--text-tiny) leading-5 text-foreground-muted">
                  Selected {new Date(context.selectedAt).toLocaleString()}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-(length:--text-small) leading-5 text-foreground-soft">
              No resume approach is selected for this job yet. You can choose
              one on the Shortlisted job panel.
            </p>
          )}

          {context.templateId ||
          context.headlinePolicy ||
          context.evidenceBoundaries ||
          context.tailoringStrength ||
          props.effectiveTailoringStrength ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {context.templateId ? (
                <div>
                  <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                    Template
                  </dt>
                  <dd className="text-foreground-soft">
                    {resumeTemplateLabels[context.templateId] ??
                      context.templateId}
                  </dd>
                </div>
              ) : null}
              {context.tailoringStrength ? (
                <div>
                  <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                    Tailoring strength
                  </dt>
                  <dd className="text-foreground-soft">
                    {resumeApproachLabels[context.tailoringStrength]}
                  </dd>
                </div>
              ) : props.effectiveTailoringStrength ? (
                <div>
                  <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                    Tailoring strength
                  </dt>
                  <dd className="text-foreground-soft">
                    Your default:{" "}
                    {resumeApproachLabels[props.effectiveTailoringStrength]}
                  </dd>
                </div>
              ) : null}
              {context.headlinePolicy ? (
                <div>
                  <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                    Headline policy
                  </dt>
                  <dd className="text-foreground-soft">
                    {resumeHeadlinePolicyLabels[context.headlinePolicy]}
                  </dd>
                </div>
              ) : null}
              {context.skillsPolicy ? (
                <div>
                  <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                    Skills policy
                  </dt>
                  <dd className="text-foreground-soft">
                    {resumeSkillsPolicyLabels[context.skillsPolicy]}
                  </dd>
                </div>
              ) : null}
              {context.coveragePolicy ? (
                <div>
                  <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                    Coverage policy
                  </dt>
                  <dd className="text-foreground-soft">
                    {resumeCoveragePolicyLabels[context.coveragePolicy]}
                  </dd>
                </div>
              ) : null}
              {context.evidenceBoundaries ? (
                <div className="sm:col-span-2">
                  <dt className="text-(length:--text-tiny) uppercase tracking-(--tracking-badge) text-foreground-muted">
                    Evidence boundaries
                  </dt>
                  <dd className="text-foreground-soft">
                    {[
                      context.evidenceBoundaries.allowExactClaims
                        ? "Exact claims allowed"
                        : "Exact claims blocked",
                      context.evidenceBoundaries.allowParaphrasedClaims
                        ? "Paraphrased claims allowed"
                        : "Paraphrased claims blocked",
                      `Up to ${context.evidenceBoundaries.maxEvidenceRefsPerBullet} evidence refs per bullet`,
                      context.evidenceBoundaries.requireVerifierPass
                        ? "Verifier pass required"
                        : "Verifier pass not required",
                    ].join(" · ")}
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          <p className="text-(length:--text-tiny) leading-5 text-foreground-muted">
            Reusing an approach never approves this resume. Approval happens
            when you review this job&apos;s resume on this screen.
          </p>
        </div>
      </div>
    </details>
  );
}
