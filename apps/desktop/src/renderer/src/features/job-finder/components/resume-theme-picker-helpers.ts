import type {
  ResumeTemplateDefinition,
  ResumeTemplateId,
} from "@nestor/contracts";
import { getResumeTemplateVariantLabel } from "@nestor/contracts";

export interface ResumeThemePickerRecommendationContext {
  jobTitle: string | null;
  jobKeywords: readonly string[];
  hasProjects: boolean;
  hasCertifications: boolean;
  hasFormalEducation: boolean;
  experienceEntryCount: number;
  totalIncludedBulletCount: number;
}

export interface ResumeThemePickerRecommendation {
  templateId: ResumeTemplateId;
  reason: string;
}

export function getLaneLabel(lane: "apply_safe" | "share_ready") {
  return lane === "apply_safe" ? "Apply-safe" : "Share-ready";
}

/**
 * What this layout's machine-readability rating means, said without the trade
 * acronym. "ATS" is the industry's word for the software an employer screens
 * with; a job seeker reading their own resume has no reason to know it.
 */
export function getAtsConfidenceLabel(confidence: "high" | "medium" | "low") {
  switch (confidence) {
    case "high":
      return "Reads reliably on job sites";
    case "medium":
      return "Usually reads well on job sites";
    case "low":
      return "May not read cleanly on job sites";
    default:
      return "Not checked against job sites";
  }
}

export function getLaneBadgeVariant(lane: "apply_safe" | "share_ready") {
  return lane === "apply_safe" ? "default" : "outline";
}

export function sortResumeThemeOptions(
  themes: readonly ResumeTemplateDefinition[],
): readonly ResumeTemplateDefinition[] {
  return [...themes].sort(
    (left, right) =>
      (left.sortOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
      left.label.localeCompare(right.label),
  );
}

export function getTemplateOptionLabel(
  theme: Pick<ResumeTemplateDefinition, "label" | "variantLabel">,
): string {
  const variantLabel = getResumeTemplateVariantLabel(theme);

  return variantLabel === theme.label
    ? theme.label
    : `${theme.label} · ${variantLabel}`;
}

function normalizeRecommendationSignal(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasAnySignal(
  haystack: readonly string[],
  needles: readonly string[],
): boolean {
  const signalTokenSets = haystack.map(
    (signal) =>
      new Set(normalizeRecommendationSignal(signal).split(" ").filter(Boolean)),
  );

  return needles.some((needle) => {
    const needleTokens = normalizeRecommendationSignal(needle)
      .split(" ")
      .filter(Boolean);
    if (needleTokens.length === 0) {
      return false;
    }

    return signalTokenSets.some((signalTokens) =>
      needleTokens.every((token) => signalTokens.has(token)),
    );
  });
}

export function buildResumeThemePickerRecommendations(input: {
  recommendationContext?: ResumeThemePickerRecommendationContext | null;
  themes: readonly ResumeTemplateDefinition[];
}): readonly ResumeThemePickerRecommendation[] {
  const context = input.recommendationContext;

  if (!context) {
    return [];
  }

  const jobSignals = [context.jobTitle ?? "", ...context.jobKeywords]
    .map(normalizeRecommendationSignal)
    .filter(Boolean);
  const hasDenseSignal =
    context.experienceEntryCount >= 3 || context.totalIncludedBulletCount >= 10;
  const hasLongHistorySignal = context.experienceEntryCount >= 5;
  const isTechnicalRole = hasAnySignal(jobSignals, [
    "engineer",
    "engineering",
    "developer",
    "frontend",
    "backend",
    "software",
    "platform",
    "data",
    "analytics",
    "analyst",
    "security",
    "infrastructure",
    "sql",
  ]);
  const isProductOrDesignRole = hasAnySignal(jobSignals, [
    "product",
    "design",
    "designer",
    "ux",
    "ui",
    "brand",
    "creative",
    "marketing",
  ]);
  const isCredentialSensitiveRole = hasAnySignal(jobSignals, [
    "compliance",
    "regulated",
    "certification",
    "credential",
    "audit",
    "security",
    "healthcare",
    "finance",
    "education",
  ]);
  const scoredRecommendations: Array<
    ResumeThemePickerRecommendation & { score: number; sortOrder: number }
  > = [];

  for (const theme of input.themes) {
    let score = 0;
    let reason: string | null = null;

    switch (theme.id) {
      case "timeline_longform":
        if (hasLongHistorySignal) {
          score = 5;
          reason =
            "This draft has a long work history, so the longform timeline gives recruiters a snapshot before the full chronology.";
        }
        break;
      case "technical_matrix":
        if (isTechnicalRole) {
          score = 4;
          reason =
            "This role reads technical, so the skills-first systems variant should land faster without leaving the apply-safe lane.";
        }
        break;
      case "project_showcase":
        if (context.hasProjects) {
          score = 4;
          reason =
            "You already have project proof in this draft, so the proof-led layout can earn more attention early.";
        }
        break;
      case "career_pivot":
        if (
          context.hasProjects &&
          (isTechnicalRole || isProductOrDesignRole) &&
          !hasLongHistorySignal
        ) {
          score = 4;
          reason =
            "The draft has bridgeable project proof, so the hybrid pivot layout connects transferable experience to the target role early.";
        }
        break;
      case "credentials_focus":
        if (
          context.hasCertifications &&
          (context.hasFormalEducation || isCredentialSensitiveRole)
        ) {
          score = 4;
          reason =
            "Formal proof matters here, so moving certifications and education higher can improve trust quickly.";
        }
        break;
      case "compact_exec":
        if (hasDenseSignal) {
          score = 3;
          reason =
            "This draft is dense, and the tighter executive variant keeps more signal visible before page pressure becomes a problem.";
        }
        break;
      case "modern_split":
        if (isProductOrDesignRole && !isTechnicalRole) {
          score = 2;
          reason =
            "The role leans product or design, so the sharper summary-led variant may read as more intentional.";
        }
        break;
      default:
        break;
    }

    if (score > 0 && reason) {
      scoredRecommendations.push({
        templateId: theme.id,
        reason,
        score,
        sortOrder: theme.sortOrder ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }

  if (scoredRecommendations.length === 0) {
    const fallbackTheme =
      input.themes.find((theme) => theme.id === "classic_ats") ??
      input.themes[0];

    return fallbackTheme
      ? [
          {
            templateId: fallbackTheme.id,
            reason:
              "No layout stands out for this job, so this stays the safest general choice for job sites that read your resume by machine.",
          },
        ]
      : [];
  }

  return scoredRecommendations
    .sort(
      (left, right) =>
        right.score - left.score || left.sortOrder - right.sortOrder,
    )
    .slice(0, 3)
    .map(({ templateId, reason }) => ({ templateId, reason }));
}
