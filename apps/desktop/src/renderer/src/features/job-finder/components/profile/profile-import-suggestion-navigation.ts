import {
  resumeImportAnswer,
  type AssistantNeedsView,
  type ResumeImportFieldCandidateSummary,
} from "@nestor/contracts";
import type { ProfileSection } from "../../lib/profile-screen-progress";
import { getJobFinderScrollBehavior } from "../../lib/job-finder-scroll-behavior";

export interface ProfileImportSuggestionDestination {
  actionLabel: string;
  /** Null: form answers live only in Needs you (Saved answers). */
  section: ProfileSection | null;
}

const sectionDestination: Record<
  ResumeImportFieldCandidateSummary["target"]["section"],
  ProfileImportSuggestionDestination
> = {
  identity: { actionLabel: "Review in Basics", section: "basics" },
  contact: { actionLabel: "Review in Basics", section: "basics" },
  location: { actionLabel: "Review in Basics", section: "basics" },
  skill: { actionLabel: "Review in Basics", section: "basics" },
  narrative: { actionLabel: "Review in Basics", section: "basics" },
  experience: {
    actionLabel: "Review in Experience",
    section: "experience",
  },
  education: { actionLabel: "Review in Background", section: "background" },
  certification: {
    actionLabel: "Review in Background",
    section: "background",
  },
  link: { actionLabel: "Review in Background", section: "background" },
  project: { actionLabel: "Review in Background", section: "background" },
  language: { actionLabel: "Review in Background", section: "background" },
  proof_point: {
    actionLabel: "Review in Background",
    section: "background",
  },
  search_preferences: {
    actionLabel: "Review in Preferences",
    section: "preferences",
  },
  answer_bank: { actionLabel: "Review in Needs you", section: null },
  application_identity: {
    actionLabel: "Review in Preferences",
    section: "preferences",
  },
  work_eligibility: {
    actionLabel: "Review in Preferences",
    section: "preferences",
  },
};

const recordPrefixBySection: Partial<
  Record<ResumeImportFieldCandidateSummary["target"]["section"], string>
> = {
  experience: "experience-record",
  education: "education-record",
  certification: "certification-record",
  project: "project-record",
  link: "link-record",
  language: "language-record",
  proof_point: "proof-record",
};

const scalarFieldNameByTarget: Record<string, string> = {
  "identity.fullName": "identity.firstName",
  "identity.headline": "identity.headline",
  "identity.summary": "summary.fullSummary",
  "identity.yearsExperience": "identity.yearsExperience",
  "contact.email": "identity.email",
  "contact.phone": "identity.phone",
  "contact.linkedinUrl": "identity.linkedinUrl",
  "contact.portfolioUrl": "identity.portfolioUrl",
  "location.currentLocation": "identity.currentLocation",
  "narrative.professionalStory": "narrative.professionalStory",
  "narrative.nextChapterSummary": "narrative.nextChapterSummary",
  "narrative.careerTransitionSummary": "narrative.careerTransitionSummary",
  "narrative.differentiators": "narrative.differentiators",
  "narrative.motivationThemes": "narrative.motivationThemes",
  "application_identity.preferredEmail": "applicationIdentity.preferredEmail",
  "application_identity.preferredPhone": "applicationIdentity.preferredPhone",
  "work_eligibility.authorizedWorkCountries":
    "eligibility.authorizedWorkCountries",
  "work_eligibility.requiresVisaSponsorship":
    "eligibility.requiresVisaSponsorship",
};

const fixedElementIdByTarget: Record<string, string> = {
  "search_preferences.targetRoles":
    "profile-setup-field-search-preferences-target-roles",
  "search_preferences.locations":
    "profile-setup-field-search-preferences-locations",
};

export function getProfileImportSuggestionDestination(
  candidate: ResumeImportFieldCandidateSummary,
): ProfileImportSuggestionDestination {
  return sectionDestination[candidate.target.section];
}

/**
 * Where to review a suggested form answer: its saved answer in Needs you,
 * found by the key the import saved it under, else Saved answers searched for
 * its question.
 */
export async function getNeedsYouSuggestionPath(
  candidate: ResumeImportFieldCandidateSummary,
): Promise<string> {
  const saved = resumeImportAnswer(candidate.target.key);
  const answer = saved
    ? await window.nestor.needsYou
        .run("get_form_answer_by_key", { key: saved.key })
        .catch(() => null)
    : null;
  const view: AssistantNeedsView = answer
    ? { tab: "saved", focusId: answer.id }
    : { tab: "saved", text: candidate.label };
  return `/job-finder/actions?needs=${encodeURIComponent(JSON.stringify(view))}`;
}

function getExactTarget(
  candidate: ResumeImportFieldCandidateSummary,
  documentRef: Document,
): HTMLElement | null {
  const targetKey = `${candidate.target.section}.${candidate.target.key}`;
  const fixedElementId = fixedElementIdByTarget[targetKey];

  if (fixedElementId) {
    return documentRef.getElementById(fixedElementId);
  }

  const scalarFieldName = scalarFieldNameByTarget[targetKey];
  if (scalarFieldName) {
    return documentRef.querySelector<HTMLElement>(
      `[name="${scalarFieldName}"]`,
    );
  }

  const recordPrefix = recordPrefixBySection[candidate.target.section];
  if (recordPrefix && candidate.target.recordId) {
    const record = documentRef.getElementById(
      `${recordPrefix}-${candidate.target.recordId}`,
    );

    if (record instanceof HTMLDetailsElement) {
      record.open = true;
    }

    return (
      record?.querySelector<HTMLElement>("input, textarea, select") ??
      record?.querySelector<HTMLElement>(
        "button, summary, [tabindex]:not([tabindex='-1'])",
      ) ??
      record
    );
  }

  return null;
}

export function focusProfileImportSuggestion(
  candidate: ResumeImportFieldCandidateSummary,
  documentRef: Document = document,
): boolean {
  const destination = getProfileImportSuggestionDestination(candidate);
  const exactTarget = getExactTarget(candidate, documentRef);
  const fallbackTarget = destination.section
    ? documentRef.getElementById(`${destination.section}-tab`)
    : null;
  const target = exactTarget ?? fallbackTarget;

  if (!target) {
    return false;
  }

  const containingDetails = target.closest("details");
  if (containingDetails instanceof HTMLDetailsElement) {
    containingDetails.open = true;
  }

  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({
      behavior: getJobFinderScrollBehavior(documentRef.defaultView),
      block: "center",
    });
  }
  target.focus({ preventScroll: true });
  return true;
}
