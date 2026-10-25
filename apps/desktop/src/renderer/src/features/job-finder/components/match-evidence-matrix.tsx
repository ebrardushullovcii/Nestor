import { joinUniqueSentences } from "../lib/sentence-copy";
import type {
  ApplicationEffortLevel,
  CompensationFitState,
  EvidenceConfidenceLevel,
  JobRequirementAssessment,
  JobRequirementEvidenceStatus,
  JobRequirementImportance,
  ListingDetailCaptureState,
  MatchAssessment,
  MatchDimensionEvidence,
  PreferenceAlignmentState,
} from "@nestor/contracts";
import { useId, useState } from "react";
import type { BadgeTone } from "../lib/job-finder-types";
import {
  fitRecommendationCopy,
  getFitEvidenceDepth,
  getRoleAndRequirementsStatus,
} from "../lib/match-assessment-presentation";
import {
  scrubJobAbsencePlaceholders,
  scrubJobAbsencePlaceholdersList,
} from "../lib/job-employer-location-display";
import { StatusBadge } from "./status-badge";

const preferenceAlignmentCopy: Record<
  PreferenceAlignmentState,
  { label: string; tone: BadgeTone }
> = {
  unknown: { label: "Unknown", tone: "neutral" },
  not_configured: { label: "Not set", tone: "muted" },
  aligned: { label: "Aligned", tone: "positive" },
  mixed: { label: "Mixed", tone: "active" },
  conflict: { label: "Outside preferences", tone: "critical" },
};

const compensationCopy: Record<
  CompensationFitState,
  { label: string; tone: BadgeTone }
> = {
  not_requested: { label: "Not requested", tone: "muted" },
  unknown: { label: "Pay unknown", tone: "neutral" },
  meets_minimum: { label: "Meets minimum", tone: "positive" },
  below_minimum: { label: "Below minimum", tone: "critical" },
  currency_incomparable: { label: "Currency not compared", tone: "neutral" },
};

const applicationEffortCopy: Record<
  ApplicationEffortLevel,
  { label: string; tone: BadgeTone }
> = {
  unknown: { label: "Unknown", tone: "muted" },
  low: { label: "Lower effort", tone: "neutral" },
  moderate: { label: "Typical effort", tone: "neutral" },
  high: { label: "Higher effort", tone: "critical" },
};

const evidenceConfidenceCopy: Record<
  EvidenceConfidenceLevel,
  { label: string; tone: BadgeTone }
> = {
  unavailable: { label: "Unavailable", tone: "muted" },
  low: { label: "Low coverage", tone: "critical" },
  moderate: { label: "Medium coverage", tone: "neutral" },
  high: { label: "High coverage", tone: "active" },
};

const statusCopy: Record<
  JobRequirementEvidenceStatus,
  { label: string; tone: BadgeTone }
> = {
  supported: { label: "Supported", tone: "positive" },
  partial: { label: "Partial", tone: "active" },
  missing: { label: "Missing", tone: "critical" },
  unknown: { label: "Unknown", tone: "neutral" },
  conflict: { label: "Conflict", tone: "critical" },
};

const importanceLabel: Record<JobRequirementImportance, string> = {
  required: "Required",
  preferred: "Preferred",
  inferred: "Inferred",
};

interface DimensionRowProps {
  evidence: readonly MatchDimensionEvidence[];
  explanation: string;
  id: string;
  label: string;
  /**
   * What actually happened when Job Finder tried to read this listing. The
   * scorer's stored depth label is not that fact: a job whose page was walled
   * or never opened still carries "card only", which the panel then narrated
   * as "Only the listing summary was available" — a summary the app never
   * had. The capture state is the field of record, so it wins here.
   */
  listingCapture?: ListingDetailCaptureState | null;
  status: { label: string; tone: BadgeTone };
}

/**
 * Plain-language rewrite of the one machine-shaped evidence row the scorer
 * emits ("Listing detail depth — card only"); every other evidence row is
 * already a sentence.
 */
function presentDimensionEvidence(
  primaryEvidence: MatchDimensionEvidence,
  listingCapture?: ListingDetailCaptureState | null,
): string {
  const label = scrubJobAbsencePlaceholders(primaryEvidence.label);
  const detail = scrubJobAbsencePlaceholders(primaryEvidence.detail);
  if (label === "Listing detail depth") {
    if (listingCapture === "blocked") {
      return "Job Finder could not read this listing.";
    }
    if (listingCapture === "not_attempted") {
      return "Job Finder could not read this listing. It has not opened the listing page yet.";
    }
    switch (detail) {
      case "card only":
        return "Only the listing summary was available.";
      case "partial detail":
        return "Scored from partial listing text.";
      case "detail enriched":
        return "The full listing detail was available.";
      default:
        break;
    }
  }
  return [label, detail].filter(Boolean).join(" — ");
}

function DimensionRow({
  evidence,
  explanation,
  id,
  label,
  listingCapture,
  status,
}: DimensionRowProps) {
  const primaryEvidence = evidence[0];
  const scrubbedExplanation = scrubJobAbsencePlaceholders(explanation);
  const presentedEvidence = primaryEvidence
    ? presentDimensionEvidence(primaryEvidence, listingCapture)
    : "";

  return (
    <div
      className="grid min-w-0 gap-2 rounded-(--radius-small) border border-(--surface-panel-border) bg-background/25 px-3 py-3"
      data-testid={`fit-dimension-${id}`}
    >
      <dt className="min-w-0 text-(length:--text-small) font-medium text-(--text-headline)">
        {label}
      </dt>
      <dd className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <StatusBadge className="shrink-0" tone={status.tone}>
            {status.label}
          </StatusBadge>
          {scrubbedExplanation ? (
            <p className="min-w-0 flex-1 break-words text-(length:--text-small) leading-6 text-foreground-soft">
              {scrubbedExplanation}
            </p>
          ) : null}
        </div>
        {presentedEvidence ? (
          <p className="break-words text-(length:--text-tiny) leading-5 text-foreground-muted">
            <span className="font-medium text-foreground-soft">Evidence:</span>{" "}
            {presentedEvidence}
          </p>
        ) : null}
      </dd>
    </div>
  );
}

/**
 * A requirement row only earns its space when it carries evidence from one
 * side or the other.
 *
 * Most listings reached the screen with their text uncaptured, so the
 * disclosure filled with rows that named a requirement and then said nothing
 * about it on either side — the panel's "requirement rows are empty for most
 * jobs". One sentence naming them is the honest, readable version.
 */
function hasRequirementEvidence(
  requirement: JobRequirementAssessment,
): boolean {
  // An "unknown" status means nothing was decided, and with no resume
  // evidence beside it there is no comparison left for the row to print —
  // only a label, a badge and a line saying nothing was found.
  return requirement.status !== "unknown" || requirement.resumeEvidence.length > 0;
}

function describeUnevidencedRequirements(
  requirements: readonly JobRequirementAssessment[],
): string {
  const labels = requirements
    .map((requirement) => requirement.label.trim())
    .filter((label) => label.length > 0)
    .slice(0, 4);
  const named =
    labels.length > 0
      ? `${labels.join(", ")}${requirements.length > labels.length ? " and others" : ""}`
      : "";
  const subject =
    requirements.length === 1
      ? "1 requirement was not checked"
      : `${requirements.length} requirements were not checked`;
  return named
    ? `${subject} — ${named}. Neither the listing nor your resume gave anything to compare.`
    : `${subject}. Neither the listing nor your resume gave anything to compare.`;
}

function RequirementRow({
  requirement,
}: {
  requirement: JobRequirementAssessment;
}) {
  const status = statusCopy[requirement.status];
  const scrubbedExplanation = scrubJobAbsencePlaceholders(
    requirement.explanation,
  );
  const scrubbedJobEvidence = scrubJobAbsencePlaceholders(
    requirement.jobEvidence,
  );

  return (
    <li className="grid gap-3 border-t border-(--surface-panel-border) py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="text-(length:--text-small) text-(--text-headline)">
              {requirement.label}
            </strong>
            <span className="rounded-full border border-(--surface-panel-border) px-2 py-0.5 text-(length:--text-tiny) text-foreground-muted">
              {importanceLabel[requirement.importance]}
            </span>
          </div>
          {scrubbedExplanation ? (
            <p className="text-(length:--text-small) leading-6 text-foreground-soft">
              {scrubbedExplanation}
            </p>
          ) : null}
        </div>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </div>

      {scrubbedJobEvidence ? (
        <div className="grid gap-1.5 rounded-(--radius-small) border border-(--surface-panel-border) bg-background/25 px-3 py-2.5">
          <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
            Listing says
          </span>
          <p className="text-(length:--text-small) leading-6 text-foreground-soft">
            “{scrubbedJobEvidence}”
          </p>
        </div>
      ) : null}

      <div className="grid gap-2">
        <span className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
          Resume evidence
        </span>
        {requirement.resumeEvidence.length > 0 ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {requirement.resumeEvidence.slice(0, 2).map((evidence) => (
              <li
                className="grid gap-0.5 border-l-2 border-primary/35 pl-3"
                key={`${requirement.id}_${evidence.sourceKind}_${evidence.sourceId ?? evidence.label}`}
              >
                <strong className="text-(length:--text-small) font-medium text-foreground">
                  {evidence.label}
                </strong>
                <span className="text-(length:--text-small) leading-6 text-foreground-soft">
                  {evidence.detail}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-(length:--text-small) leading-6 text-foreground-muted">
            No explicit evidence was located in the imported resume.
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * The evidence-depth rule lives with the rest of the score presentation so
 * the row, the inspector and this breakdown cannot disagree about whether a
 * percentage was earned. Re-exported here for the surfaces that already
 * import it from the matrix.
 */
export {
  FIT_NOT_JUDGED_REASON,
  getFitEvidenceDepth,
  type FitEvidenceDepth,
} from "../lib/match-assessment-presentation";

interface MatchEvidenceMatrixProps {
  assessment: MatchAssessment;
  /**
   * The job's own listing-capture state, when the caller has the job. One
   * state drives both the "About this job" sentence and this breakdown, so
   * the two halves of one screen can never disagree about whether the listing
   * was read.
   */
  listingCapture?: ListingDetailCaptureState | null;
  /**
   * The qualified score sentence for this breakdown. This is the only place a
   * withheld percentage may appear, so callers that know the job's binding
   * state pass their own label; the default is derived from the assessment's
   * own evidence depth. Pass `null` to print no number at all.
   */
  scoreLabel?: string | null;
  showRecommendation?: boolean;
}

export function MatchEvidenceMatrix({
  assessment,
  listingCapture,
  scoreLabel,
  showRecommendation = true,
}: MatchEvidenceMatrixProps) {
  const [requirementsOpen, setRequirementsOpen] = useState(false);
  const requirementsPanelId = useId();
  const requirements = assessment.requirements ?? [];
  const recommendation =
    fitRecommendationCopy[
      assessment.recommendation ?? "review_before_applying"
    ];
  const supportedCount = requirements.filter(
    (requirement) => requirement.status === "supported",
  ).length;
  const requiredGapCount = requirements.filter(
    (requirement) =>
      requirement.importance === "required" &&
      requirement.status !== "supported",
  ).length;
  const evidencedRequirements = requirements.filter(hasRequirementEvidence);
  const unevidencedRequirements = requirements.filter(
    (requirement) => !hasRequirementEvidence(requirement),
  );
  const evidenceDepth = getFitEvidenceDepth(assessment);
  const resolvedScoreLabel =
    scoreLabel === undefined
      ? evidenceDepth.isNotJudged
        ? "Not judged yet"
        : `${assessment.score}% fit`
      : scoreLabel;
  const hasDetailedFitEvidence =
    assessment.scorerVersion >= 3 || requirements.length > 0;
  const legacyReasons = scrubJobAbsencePlaceholdersList(
    [...new Set(assessment.reasons.map((reason) => joinUniqueSentences([reason])).filter(Boolean))],
  );
  const legacyGaps = scrubJobAbsencePlaceholdersList(
    assessment.gaps.filter((gap) => gap.trim().length > 0),
  );
  const showLegacySummary =
    !hasDetailedFitEvidence &&
    (legacyReasons.length > 0 || legacyGaps.length > 0);
  const roleSuitability = assessment.dimensions?.roleSuitability ?? {
    state: "unknown" as const,
    explanation:
      "Role suitability has not been assessed from saved target roles.",
    evidence: [],
  };
  const preferenceAlignment = assessment.dimensions?.preferenceAlignment ?? {
    state: "unknown" as const,
    explanation:
      "Preference alignment has not been assessed from saved search preferences.",
    evidence: [],
  };
  const applicationEffort = assessment.dimensions?.applicationEffort ?? {
    level: "unknown" as const,
    explanation:
      "The listing does not provide enough application-path evidence to estimate effort.",
    evidence: [],
  };
  const evidenceConfidence = assessment.dimensions?.evidenceConfidence ?? {
    level: "unavailable" as const,
    explanation:
      "No supportability assessment is available for the extracted evidence.",
    evidence: [],
  };
  const compensationFit = assessment.compensationFit ?? {
    state: "unknown" as const,
    explanation:
      "The listing does not provide comparable compensation evidence.",
  };
  const informativeDimensions = [
    roleSuitability.state === "unknown"
      ? null
      : {
          evidence: roleSuitability.evidence,
          explanation: roleSuitability.explanation,
          id: "role-suitability",
          label: "Role and requirements",
          // Derived from the requirement evidence printed right below it, so
          // the headline can never claim more than that evidence supports.
          status: getRoleAndRequirementsStatus(
            roleSuitability.state,
            requirements,
          ),
        },
    preferenceAlignment.state === "unknown" ||
    preferenceAlignment.state === "not_configured"
      ? null
      : {
          evidence: preferenceAlignment.evidence,
          explanation: preferenceAlignment.explanation,
          id: "preference-alignment",
          label: "Your preferences",
          status: preferenceAlignmentCopy[preferenceAlignment.state],
        },
    compensationFit.state === "unknown" ||
    compensationFit.state === "not_requested"
      ? null
      : {
          evidence: [] as readonly MatchDimensionEvidence[],
          explanation: compensationFit.explanation,
          id: "compensation",
          label: "Compensation",
          status: compensationCopy[compensationFit.state],
        },
    applicationEffort.level === "unknown"
      ? null
      : {
          evidence: applicationEffort.evidence,
          explanation: applicationEffort.explanation,
          id: "application-effort",
          label: "Application effort",
          status: applicationEffortCopy[applicationEffort.level],
        },
    evidenceConfidence.level === "unavailable"
      ? null
      : {
          evidence: evidenceConfidence.evidence,
          explanation: evidenceConfidence.explanation,
          id: "evidence-confidence",
          // "Evidence coverage" is a scoring term, not something a person
          // reading about one job has any reason to decode.
          label: "How much could be checked",
          status: evidenceConfidenceCopy[evidenceConfidence.level],
        },
  ].filter((dimension) => dimension !== null);

  return (
    <section
      aria-labelledby="fit-breakdown-heading"
      className="surface-card-tint grid min-w-0 gap-4 rounded-(--radius-field) border border-(--surface-panel-border) p-4"
    >
      {/* One heading, not three. The percentage lives here — beside the
          evidence it came from — and never in the row or inspector headline
          when the evidence behind it is only the listing title. */}
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h3
            className="break-words text-(length:--text-body) text-(--text-headline)"
            id="fit-breakdown-heading"
          >
            Score and evidence
          </h3>
          {resolvedScoreLabel ? (
            <strong
              className="text-(length:--text-small) font-medium text-foreground-soft"
              data-testid="fit-breakdown-score"
            >
              {resolvedScoreLabel}
            </strong>
          ) : null}
        </div>
        {showRecommendation ? (
          <StatusBadge tone={recommendation.tone}>
            {recommendation.label}
          </StatusBadge>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        {evidenceDepth.isNotJudged ? (
          <p
            className="rounded-(--radius-small) border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-small) leading-6 text-(--warning-text)"
            data-testid="fit-title-only-note"
          >
            {evidenceDepth.reason}
          </p>
        ) : null}
        <p className="text-(length:--text-small) leading-6 text-foreground-soft">
          {scrubJobAbsencePlaceholders(
            joinUniqueSentences([assessment.recommendationRationale ?? ""]) ||
              "Review the listing and resume evidence before applying.",
          ) || "Review the listing and resume evidence before applying."}
        </p>
      </div>

      {showLegacySummary ? (
        <div
          className="grid min-w-0 gap-4 rounded-(--radius-small) border border-(--surface-panel-border) bg-background/25 px-3 py-3"
          data-testid="legacy-fit-summary"
        >
          <p className="text-(length:--text-small) font-medium text-(--text-headline)">
            Evidence saved with this assessment
          </p>
          {legacyReasons.length > 0 ? (
            <div className="grid min-w-0 gap-2">
              <h4 className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
                Why it may fit
              </h4>
              <ul className="m-0 grid min-w-0 gap-2 pl-5 text-(length:--text-small) leading-6 text-foreground-soft">
                {legacyReasons.map((reason, index) => (
                  <li className="break-words" key={`${index}_${reason}`}>
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {legacyGaps.length > 0 ? (
            <div className="grid min-w-0 gap-2">
              <h4 className="text-(length:--text-small) font-semibold leading-5 text-foreground-muted">
                Questions to review
              </h4>
              <ul className="m-0 grid min-w-0 gap-2 pl-5 text-(length:--text-small) leading-6 text-foreground-soft">
                {legacyGaps.map((gap, index) => (
                  <li className="break-words" key={`${index}_${gap}`}>
                    {gap}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* A dimension that knows nothing is not evidence. Five cards reading
          UNKNOWN / NOT REQUESTED / UNAVAILABLE restate the title-only note
          above them in ~900px, so only rows that actually carry a finding are
          rendered; the rest are dropped until they have something to show. */}
      {informativeDimensions.length > 0 ? (
        <dl className="grid min-w-0 gap-2" data-testid="fit-dimensions">
          {informativeDimensions.map((dimension) => (
            <DimensionRow
              evidence={dimension.evidence}
              explanation={dimension.explanation}
              id={dimension.id}
              key={dimension.id}
              label={dimension.label}
              listingCapture={listingCapture ?? null}
              status={dimension.status}
            />
          ))}
        </dl>
      ) : (
        <p
          className="text-(length:--text-small) leading-6 text-foreground-muted"
          data-testid="fit-dimensions-empty"
        >
          {/* The app has no external-URL capability, so this must not tell the
              user to "open the listing". Copying the link is the action the
              product actually offers, and is the same wording the title-only
              note uses. */}
          Nothing else has been checked yet. Copy the listing link to check the
          role, preference, pay, and evidence details.
        </p>
      )}

      {requiredGapCount > 0 ? (
        <div className="rounded-(--radius-small) border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-(length:--text-small) leading-6 text-destructive">
          {requiredGapCount} required item{requiredGapCount === 1 ? "" : "s"}{" "}
          still {requiredGapCount === 1 ? "needs" : "need"} evidence or{" "}
          {requiredGapCount === 1 ? "conflicts" : "conflict"} with your profile.
        </div>
      ) : null}

      {requirements.length > 0 ? (
        <div className="min-w-0 rounded-(--radius-small) border border-(--surface-panel-border) px-3 py-3">
          <button
            aria-controls={requirementsPanelId}
            aria-expanded={requirementsOpen}
            className="w-full cursor-pointer text-left text-(length:--text-small) font-medium text-foreground-soft outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
            onClick={() => setRequirementsOpen((open) => !open)}
            type="button"
          >
            Review requirement evidence — {supportedCount} of{" "}
            {requirements.length} supported
          </button>
          {requirementsOpen ? (
            <div id={requirementsPanelId}>
              {evidencedRequirements.length > 0 ? (
                <ul className="m-0 mt-4 grid list-none p-0">
                  {evidencedRequirements.map((requirement) => (
                    <RequirementRow
                      key={requirement.id}
                      requirement={requirement}
                    />
                  ))}
                </ul>
              ) : null}
              {unevidencedRequirements.length > 0 ? (
                <p
                  className="mt-4 text-(length:--text-small) leading-6 text-foreground-muted"
                  data-testid="fit-requirements-unchecked"
                >
                  {describeUnevidencedRequirements(unevidencedRequirements)}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : evidenceDepth.isNotJudged ? null : (
        <p className="text-(length:--text-small) leading-6 text-foreground-muted">
          Requirement-by-requirement evidence is unavailable for this listing.
        </p>
      )}
    </section>
  );
}
