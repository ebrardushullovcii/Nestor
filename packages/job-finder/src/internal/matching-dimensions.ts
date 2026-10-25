import {
  assessJobPostingDetailQuality,
  type JobRequirementAssessment,
  type JobSearchPreferences,
  type MatchDimensionEvidence,
  type MatchDimensionsAssessment,
} from "@nestor/contracts";

import type { MatchAssessmentPostingInput } from "./match-assessment-posting-input";
import type {
  LocationCompatibilityState,
  WorkModeCompatibilityState,
} from "./matching";

type BuildMatchDimensionsAssessmentInput = {
  posting: MatchAssessmentPostingInput;
  searchPreferences: JobSearchPreferences;
  requirements: readonly JobRequirementAssessment[];
  matchesRole: boolean;
  roleFamilyMismatch: boolean;
  roleFamilyUnclear: boolean;
  locationCompatibility: LocationCompatibilityState;
  /**
   * The listing is remote and remote is a preferred work mode, so the place
   * comparison was settled by the work-mode preference instead of the city.
   */
  locationRemotePreferenceApplied?: boolean;
  workModeCompatibility: WorkModeCompatibilityState;
  isPreferredCompany: boolean;
};

/**
 * How much of the listing this panel may claim was read.
 *
 * `assessJobPostingDetailQuality` is the one shared rule for that question, so
 * the depth row states what the posting's own fields support rather than
 * repeating a stored label that may have been written before the body was
 * (or was not) fetched. The wording stays the existing three-value
 * vocabulary the score panel already turns into sentences.
 */
function describeListingDetailDepth(
  posting: MatchAssessmentPostingInput,
): string {
  const assessed = assessJobPostingDetailQuality({
    title: posting.title,
    company: posting.company,
    description: posting.description,
    keySkills: posting.keySkills,
    responsibilities: posting.responsibilities,
    minimumQualifications: posting.minimumQualifications,
    preferredQualifications: posting.preferredQualifications,
    benefits: posting.benefits,
  });
  // Never claims more than the stored label, and never more than the text
  // supports: the weaker of the two wins.
  const order: Record<string, number> = {
    card_only: 0,
    partial_detail: 1,
    detail_enriched: 2,
  };
  const claimed =
    (order[assessed] ?? 0) <= (order[posting.detailQuality] ?? 0)
      ? assessed
      : posting.detailQuality;
  return claimed.replaceAll("_", " ");
}

// Absence placeholders are shared across boards, so both labels use the one
// source-generic rule instead of a per-phrase pattern.

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1).trim()}…`;
}

function evidence(
  source: MatchDimensionEvidence["source"],
  label: string,
  detail: string,
): MatchDimensionEvidence {
  return {
    source,
    label: clip(label, 120),
    detail: clip(detail, 240),
  };
}

function buildApplicationEffort(
  input: BuildMatchDimensionsAssessmentInput,
): MatchDimensionsAssessment["applicationEffort"] {
  const { posting } = input;
  const effortEvidence = [
    evidence(
      "listing",
      "Application path",
      posting.applyPath.replaceAll("_", " "),
    ),
  ];

  if (posting.screeningHints.requiresConsentInterrupt === true) {
    const kind = posting.screeningHints.requiresConsentInterruptKind;
    effortEvidence.push(
      evidence(
        "listing",
        "User-action checkpoint",
        kind
          ? `The listing signals a ${kind.replaceAll("_", " ")} step.`
          : "The listing signals an account or verification step.",
      ),
    );
    return {
      level: "high",
      explanation:
        "The application path requires an account, decision, or verification step that needs user action.",
      evidence: effortEvidence,
    };
  }

  if (posting.applyPath === "easy_apply" && posting.easyApplyEligible) {
    effortEvidence.push(
      evidence(
        "derived",
        "Easy Apply signal",
        "Both application-path fields confirm an in-platform Easy Apply route.",
      ),
    );
    return {
      level: "low",
      explanation:
        "The listing consistently exposes an in-platform application path with fewer expected handoff steps.",
      evidence: effortEvidence,
    };
  }

  if (
    (posting.applyPath === "easy_apply" && !posting.easyApplyEligible) ||
    (posting.applyPath !== "easy_apply" && posting.easyApplyEligible)
  ) {
    effortEvidence.push(
      evidence(
        "derived",
        "Inconsistent path signal",
        "The application path and Easy Apply eligibility fields disagree.",
      ),
    );
    return {
      level: "unknown",
      explanation:
        "The listing exposes inconsistent application-path signals, so effort is not inferred.",
      evidence: effortEvidence,
    };
  }

  if (posting.applyPath === "external_redirect") {
    return {
      level: "moderate",
      explanation:
        "The application redirects to an employer or ATS form, which usually requires more review and form entry.",
      evidence: effortEvidence,
    };
  }

  return {
    level: "unknown",
    explanation:
      "The listing does not expose a reliable application path, so effort cannot be estimated yet.",
    evidence: effortEvidence,
  };
}

function buildEvidenceConfidence(
  input: BuildMatchDimensionsAssessmentInput,
): MatchDimensionsAssessment["evidenceConfidence"] {
  const counts = {
    supportedCount: 0,
    partialCount: 0,
    missingCount: 0,
    unknownCount: 0,
    conflictCount: 0,
  };
  const evidenceRequirements = input.requirements.filter(
    (requirement) =>
      requirement.category !== "location" &&
      requirement.category !== "work_mode",
  );
  const unverifiedPreferences = input.requirements.filter(
    (requirement) =>
      (requirement.category === "location" ||
        requirement.category === "work_mode") &&
      requirement.status === "unknown",
  );
  const unverifiedPreferenceNote =
    unverifiedPreferences.length > 0
      ? ` Your saved ${unverifiedPreferences
          .map((requirement) =>
            requirement.category === "work_mode" ? "work-mode" : "location",
          )
          .join(
            " and ",
          )} preference could not be confirmed against this listing.`
      : "";

  // Saved location/work-mode comparisons are preference checks, not proof that
  // the listing exposes enough role evidence for a reliable fit decision.
  for (const requirement of evidenceRequirements) {
    switch (requirement.status) {
      case "supported":
        counts.supportedCount += 1;
        break;
      case "partial":
        counts.partialCount += 1;
        break;
      case "missing":
        counts.missingCount += 1;
        break;
      case "unknown":
        counts.unknownCount += 1;
        break;
      case "conflict":
        counts.conflictCount += 1;
        break;
    }
  }

  const total = evidenceRequirements.length;
  const supportableCount = total - counts.unknownCount;
  const supportableRatio = total > 0 ? supportableCount / total : 0;
  const evidenceRows = [
    evidence(
      "listing",
      "Listing detail depth",
      // Re-derived from the text actually in hand rather than echoed from the
      // stored label. A row whose `detailQuality` was set optimistically
      // upstream printed "The full listing detail was available." directly
      // above "the listing text was not captured"; the depth this panel
      // claims is now the same reading of the same body the capture state
      // makes, so the two lines cannot contradict each other.
      describeListingDetailDepth(input.posting),
    ),
    evidence(
      "derived",
      "Requirement supportability",
      total === 0
        ? "No requirements were extracted for comparison."
        : `${supportableCount} of ${total} role or eligibility requirements have explicit positive or negative evidence.`,
    ),
  ];

  if (total === 0 && input.posting.detailQuality === "card_only") {
    return {
      level: "unavailable",
      explanation:
        "Only the search-result card was available, so no requirements could be checked. This describes how much was read, not how good the job is.",
      evidence: evidenceRows,
      ...counts,
    };
  }

  if (
    input.posting.detailQuality === "detail_enriched" &&
    total >= 2 &&
    supportableRatio >= 0.75
  ) {
    return {
      level: "high",
      // Names the scope ("role requirements") and any saved preference that
      // stayed unverified, so "5 of 5 checked" no longer reads as "remote was
      // confirmed" when the work-mode row is the one that could not be.
      explanation: `The listing body was read and ${counts.supportedCount + counts.partialCount + counts.missingCount + counts.conflictCount} of ${total} role requirements were checked. A gap that was found still counts against the fit.${unverifiedPreferenceNote}`,
      evidence: evidenceRows,
      ...counts,
    };
  }

  if (input.posting.detailQuality === "detail_enriched" && total === 0) {
    return {
      level: "moderate",
      explanation:
        "The listing body was read, but it did not expose structured requirements to compare one by one. The fit still uses the readable role and listing evidence; nothing missing is assumed.",
      evidence: evidenceRows,
      ...counts,
    };
  }

  if (
    input.posting.detailQuality !== "card_only" &&
    total > 0 &&
    supportableRatio >= 0.5
  ) {
    return {
      level: "moderate",
      explanation:
        "Several requirements could be checked, but some evidence is still incomplete. This describes how much was read, not how good the job is.",
      evidence: evidenceRows,
      ...counts,
    };
  }

  return {
    level: "low",
    explanation:
      "Not much of the listing could be read, so few requirements could be checked. Gaps that were found are kept; nothing else is assumed.",
    evidence: evidenceRows,
    ...counts,
  };
}

/**
 * The dimensions that need no judgment: how much effort the application path
 * takes and how much requirement evidence was compared. A job the model has
 * not judged yet carries only these (ADR 0041).
 */
export function buildBookkeepingDimensions(input: {
  posting: MatchAssessmentPostingInput;
  searchPreferences: JobSearchPreferences;
  requirements: readonly JobRequirementAssessment[];
}): Pick<MatchDimensionsAssessment, "applicationEffort" | "evidenceConfidence"> {
  const neutral: BuildMatchDimensionsAssessmentInput = {
    ...input,
    matchesRole: false,
    roleFamilyMismatch: false,
    roleFamilyUnclear: false,
    locationCompatibility: "unknown",
    workModeCompatibility: "unknown",
    isPreferredCompany: false,
  };
  return {
    applicationEffort: buildApplicationEffort(neutral),
    evidenceConfidence: buildEvidenceConfidence(neutral),
  };
}
