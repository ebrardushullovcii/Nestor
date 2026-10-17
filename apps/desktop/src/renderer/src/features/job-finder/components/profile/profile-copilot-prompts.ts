import type { ProfileSetupState } from "@nestor/contracts";
import type { ProfileSection } from "../../lib/profile-screen-progress";

const reviewSeverityRank = {
  critical: 0,
  recommended: 1,
  optional: 2,
} as const;

function getTopPriorityPendingReviewItem(
  reviewItems: readonly ProfileSetupState["reviewItems"][number][],
) {
  return (
    [...reviewItems]
      .filter((item) => item.status === "pending")
      .sort((left, right) => {
        const leftRank = reviewSeverityRank[left.severity];
        const rightRank = reviewSeverityRank[right.severity];

        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }

        return left.createdAt.localeCompare(right.createdAt);
      })[0] ?? null
  );
}

function extractExperienceCompanyLabel(
  item: ProfileSetupState["reviewItems"][number],
): string | null {
  const companyMatch = item.proposedValue?.match(/Company:\s*([^·]+)/i);
  if (companyMatch?.[1]) {
    return companyMatch[1].trim();
  }

  const snippetMatch = item.sourceSnippet?.match(/^([^\-\u2013\u2014]+)/);
  return snippetMatch?.[1]?.trim() || null;
}

export function buildCopilotStarterQuestion(
  reviewItems: readonly ProfileSetupState["reviewItems"][number][],
): string | null {
  const item = getTopPriorityPendingReviewItem(reviewItems);

  if (!item) {
    return null;
  }

  if (item.target.domain === "experience") {
    if (
      item.target.key === "record" &&
      !item.proposedValue &&
      !item.sourceSnippet
    ) {
      return "What work experience should I add first?";
    }

    const companyLabel = extractExperienceCompanyLabel(item);
    return companyLabel
      ? `For ${companyLabel}, should I mark that role as Remote, Hybrid, or Onsite?`
      : "Should I mark this role as Remote, Hybrid, or Onsite?";
  }

  if (item.target.domain === "identity" && item.target.key === "headline") {
    return "What headline should I save on your profile?";
  }

  if (
    item.target.domain === "identity" &&
    item.target.key === "currentLocation"
  ) {
    return "What location should I show on your profile and generated resumes?";
  }

  if (item.target.domain === "identity" && item.target.key === "contactPath") {
    return "What contact path should I save for applications: email, phone, or both?";
  }

  if (
    item.target.domain === "search_preferences" &&
    item.target.key === "targetRoles"
  ) {
    return "What target role or roles should I use for your job search?";
  }

  if (item.target.domain === "work_eligibility") {
    return "Which countries can you work in, and do you want remote, hybrid, onsite, or flexible roles?";
  }

  if (item.target.domain === "narrative") {
    return `What should I save for ${item.label.toLowerCase()}?`;
  }

  return `What should I save for ${item.label.toLowerCase()}?`;
}

const reviewDomainsByProfileSection: Record<
  ProfileSection,
  readonly ProfileSetupState["reviewItems"][number]["target"]["domain"][]
> = {
  basics: ["identity", "professional_summary", "narrative"],
  experience: ["experience"],
  background: [
    "education",
    "certification",
    "project",
    "link",
    "language",
    "proof_point",
  ],
  preferences: [
    "application_identity",
    "work_eligibility",
    "search_preferences",
    "answer_bank",
  ],
  sources: ["search_preferences"],
  // Files hold no profile facts, so the assistant has nothing to review there.
  files: [],
};

export function buildProfileSectionStarterQuestion(
  reviewItems: readonly ProfileSetupState["reviewItems"][number][],
  section: ProfileSection,
): string | null {
  const allowedDomains = reviewDomainsByProfileSection[section];

  return buildCopilotStarterQuestion(
    reviewItems.filter((item) => allowedDomains.includes(item.target.domain)),
  );
}
