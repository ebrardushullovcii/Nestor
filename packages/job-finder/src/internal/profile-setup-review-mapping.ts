import type {
  ProfileReviewItem,
  ProfileReviewTargetDomain,
  ResumeDocumentBundle,
  ResumeImportFieldCandidate,
} from "@nestor/contracts";
import {
  isSearchLocationCandidateTarget,
  sanitizeSearchLocationCandidateValue,
} from "./profile-setup-location-suggestions";
import { normalizeText } from "./shared";

export type DerivedReviewDraft = {
  step: ProfileReviewItem["step"];
  target: ProfileReviewItem["target"];
  label: string;
  reason: string;
  severity: ProfileReviewItem["severity"];
  proposedValue?: string | null;
  sourceSnippet?: string | null;
  sourceCandidateId?: string | null;
  sourceRunId?: string | null;
};

function humanizeRecordFieldKey(key: string): string {
  switch (key) {
    case "companyName":
      return "Company";
    case "isCurrent":
      return "Current role";
    case "startDate":
      return "Start";
    case "endDate":
      return "End";
    case "fieldOfStudy":
      return "Field of study";
    case "workMode":
      return "Work mode";
    case "dateEarned":
      return "Date earned";
    default:
      return (
        key.charAt(0).toUpperCase() +
        key
          .slice(1)
          .replace(/([A-Z])/g, " $1")
          .trim()
      );
  }
}

function humanizePrimitive(value: boolean | number): string {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value);
}

export function summarizeValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return humanizePrimitive(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .flatMap((entry) => summarizeValue(entry) ?? [])
      .filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .flatMap(([key, entry]) => {
        const summarized = summarizeValue(entry);
        return summarized
          ? [`${humanizeRecordFieldKey(key)}: ${summarized}`]
          : [];
      })
      .filter(Boolean);
    return entries.length > 0 ? entries.join(" · ") : null;
  }

  return null;
}

function uniqueEvidenceFragments(values: readonly string[]): string[] {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    const key = normalizeText(trimmed) || trimmed.toLowerCase();
    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [trimmed];
  });
}

function getSourceSnippet(
  candidate: ResumeImportFieldCandidate,
  documentBundle: ResumeDocumentBundle | null,
): string | null {
  if (candidate.evidenceText && candidate.evidenceText.trim().length > 0) {
    return (
      uniqueEvidenceFragments(candidate.evidenceText.split(/\r?\n/))
        .join(" ")
        .slice(0, 400) || null
    );
  }

  const blockTexts = uniqueEvidenceFragments(
    candidate.sourceBlockIds
      .map(
        (blockId) =>
          documentBundle?.blocks.find((block) => block.id === blockId)?.text ??
          null,
      )
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      ),
  );

  if (blockTexts.length === 0) {
    return null;
  }

  return blockTexts.join(" ").slice(0, 400);
}

function mapTargetDomain(
  candidate: ResumeImportFieldCandidate,
): ProfileReviewTargetDomain | null {
  switch (candidate.target.section) {
    case "identity":
    case "experience":
    case "education":
    case "certification":
    case "project":
    case "link":
    case "language":
    case "narrative":
    case "proof_point":
    case "answer_bank":
    case "application_identity":
      return candidate.target.section;
    case "location":
      return "identity";
    case "contact":
      return "identity";
    case "skill":
      return candidate.target.key === "skills" ? "identity" : null;
    case "search_preferences":
      return "search_preferences";
    case "work_eligibility":
      return "work_eligibility";
    default:
      return null;
  }
}

function mapCandidateToStep(
  candidate: ResumeImportFieldCandidate,
): ProfileReviewItem["step"] | null {
  switch (candidate.target.section) {
    // The summary field lives on Basics in both guided setup and Profile, so
    // its review item belongs to the step that actually edits it.
    case "identity":
    case "contact":
    case "location":
      return "essentials";
    case "skill":
      return candidate.target.key === "skills" ? "essentials" : null;
    case "experience":
    case "education":
    case "certification":
    case "project":
    case "link":
    case "language":
      return "background";
    case "search_preferences":
    case "work_eligibility":
      return "targeting";
    // Story, proof, reusable answers, and application identity all live on
    // the merged optional Extras step.
    case "narrative":
    case "proof_point":
    case "answer_bank":
    case "application_identity":
      return "extras";
    default:
      return null;
  }
}

function mapCandidateToSeverity(
  candidate: ResumeImportFieldCandidate,
): ProfileReviewItem["severity"] {
  // Background is optional even for a first job. Imported roles and schools
  // stay available for review without preventing setup from finishing.
  if (
    candidate.target.section === "experience" ||
    candidate.target.section === "education"
  ) {
    return "recommended";
  }

  if (
    candidate.target.section === "identity" ||
    candidate.target.section === "contact" ||
    candidate.target.section === "location" ||
    candidate.target.section === "skill" ||
    candidate.target.section === "search_preferences" ||
    candidate.target.section === "application_identity" ||
    candidate.target.section === "work_eligibility"
  ) {
    return "recommended";
  }

  return "optional";
}

function buildCandidateReason(candidate: ResumeImportFieldCandidate): string {
  switch (candidate.target.section) {
    case "identity":
    case "contact":
    case "location":
    case "skill":
      return "Imported profile details need confirmation before discovery, resumes, and applications rely on them everywhere.";
    case "experience":
      return "Work-history records stay review-first so resume tailoring and fit scoring do not assume the wrong role details.";
    case "education":
      return "Education records stay review-first until the imported school and degree details are confirmed.";
    case "search_preferences":
      return "Targeting details need review so discovery avoids generic or mismatched searches.";
    case "work_eligibility":
      return "Your resume says this about where you can work. It differs from what you saved, so confirm which one application forms should use.";
    case "narrative":
      return "Check this story before using it in your resume.";
    case "proof_point":
      return "Check this achievement before saving it for future applications.";
    case "answer_bank":
      return "Reusable screener answers should be confirmed before apply flows reuse them.";
    case "application_identity":
      return "Application identity defaults should be confirmed before forms reuse them automatically.";
    default:
      return "This imported suggestion should be reviewed before setup is complete.";
  }
}

export function shouldIncludeCandidateInSetupReview(
  candidate: ResumeImportFieldCandidate,
): boolean {
  switch (candidate.target.section) {
    case "identity":
      return ["fullName", "headline", "summary", "yearsExperience"].includes(
        candidate.target.key,
      );
    case "contact":
      return ["email", "phone", "linkedinUrl", "portfolioUrl"].includes(
        candidate.target.key,
      );
    case "location":
      return candidate.target.key === "currentLocation";
    case "skill":
      return candidate.target.key === "skills";
    case "search_preferences":
      return ["targetRoles", "locations", "workModes"].includes(
        candidate.target.key,
      );
    case "work_eligibility":
      return true;
    case "experience":
    case "education":
    case "certification":
    case "project":
    case "link":
    case "language":
    case "narrative":
    case "proof_point":
    case "answer_bank":
    case "application_identity":
      return true;
    default:
      return false;
  }
}

export function toReviewDraft(
  candidate: ResumeImportFieldCandidate,
  documentBundle: ResumeDocumentBundle | null,
): DerivedReviewDraft | null {
  const step = mapCandidateToStep(candidate);
  const domain = mapTargetDomain(candidate);

  if (!step || !domain) {
    return null;
  }

  return {
    step,
    target: {
      domain,
      key: candidate.target.key,
      recordId: candidate.target.recordId,
    },
    label: candidate.label,
    reason: buildCandidateReason(candidate),
    severity: mapCandidateToSeverity(candidate),
    proposedValue:
      candidate.target.section === "proof_point" &&
      candidate.value &&
      typeof candidate.value === "object" &&
      !Array.isArray(candidate.value)
        ? [
            candidate.value.claim,
            candidate.value.heroMetric,
            candidate.value.supportingContext,
          ]
            .filter(
              (value): value is string =>
                typeof value === "string" && value.length > 0,
            )
            .filter((value, index, values) => values.indexOf(value) === index)
            .join(" · ") || null
        : summarizeValue(
            isSearchLocationCandidateTarget(candidate.target)
              ? sanitizeSearchLocationCandidateValue(candidate.value)
              : candidate.value,
          ),
    sourceSnippet: getSourceSnippet(candidate, documentBundle),
    sourceCandidateId: candidate.id,
    sourceRunId: candidate.runId,
  };
}
