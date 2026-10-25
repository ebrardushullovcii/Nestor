import type {
  ResumeStrategy,
  ResumeStrategyCoveragePolicy,
  ResumeStrategyEvidenceBoundaries,
  ResumeStrategyHeadlinePolicy,
  ResumeStrategySkillsPolicy,
  ResumeTemplateId,
} from "@nestor/contracts";
import type { ResumeApplicationMode, TailoringMode } from "@nestor/contracts";

// The same names the resume picker shows (job-finder-resume-catalog); a
// second vocabulary here made one template look like two.
export const resumeTemplateLabels: Record<ResumeTemplateId, string> = {
  classic_ats: "Chronology Classic",
  modern_split: "Modern Editorial",
  compact_exec: "Senior Brief",
  technical_matrix: "Engineering Spec",
  project_showcase: "Proof Portfolio",
  credentials_focus: "Formal Proof",
  timeline_longform: "Longform Timeline",
  career_pivot: "Career Pivot Bridge",
};

export const resumeHeadlinePolicyLabels: Record<
  ResumeStrategyHeadlinePolicy,
  string
> = {
  fixed: "Keep my headline",
  role_family_template: "One headline for this kind of role",
  per_job_tailored: "A headline per job",
};

export const resumeSkillsPolicyLabels: Record<
  ResumeStrategySkillsPolicy,
  string
> = {
  base_only: "Only the skills on my resume",
  role_family_expanded: "Skills common to this kind of role",
  per_job_tailored: "Skills picked per job",
};

export const resumeCoveragePolicyLabels: Record<
  ResumeStrategyCoveragePolicy,
  string
> = {
  base_omissions: "Fill gaps my resume leaves",
  role_family_recommended: "Cover what this kind of role expects",
  full_tailoring: "Tailor fully per job",
};

export const resumeTailoringStrengthLabels: Record<TailoringMode, string> = {
  // Same names the setup screen uses; "Conservative" and "Aggressive" were a
  // second vocabulary for one setting. The names say what happens to the
  // person's own words rather than grading an invisible effort.
  conservative: "Light: small edits, every fact kept",
  balanced: "Tailored: a fuller rewrite, every fact kept",
  aggressive: "Aggressive: may stretch, with your say-so",
};

/**
 * Every resume approach a person can choose, tailoring strengths and the
 * unchanged original together.
 *
 * The original-file choice used to exist only in Settings, so a list of the
 * three strengths read as the complete set of options. It is one vocabulary:
 * guided setup, Preferences, Settings, and the per-job choice all name it the
 * same way.
 */
export const resumeApproachLabels: Record<
  ResumeApplicationMode | TailoringMode,
  string
> = {
  original_resume: "Original: keep my resume as it is",
  tailored_per_job: "Tailor a resume for each job",
  ...resumeTailoringStrengthLabels,
};

export function describeEvidenceBoundaries(
  boundaries: ResumeStrategyEvidenceBoundaries,
): string {
  const parts: string[] = [];
  // What the user reads on the saved card; the evidence-ref count is a
  // generator bound, not a choice they made, so it stays out of the summary.
  parts.push(
    boundaries.allowExactClaims ? "Quotes allowed" : "No word-for-word quotes",
  );
  parts.push(
    boundaries.allowParaphrasedClaims ? "Rewording allowed" : "No rewording",
  );
  parts.push(
    boundaries.requireVerifierPass
      ? "Checked against your resume before export"
      : "Not checked against your resume before export",
  );
  return parts.join(" · ");
}

export function strategySearchTokens(strategy: ResumeStrategy): string[] {
  return [
    strategy.name,
    strategy.roleFamily,
    strategy.templateId,
    strategy.headlinePolicy,
    strategy.skillsPolicy,
    strategy.coveragePolicy,
    strategy.tailoringStrength,
    strategy.enabled ? "enabled" : "disabled",
    strategy.baseResumeDocumentId,
  ];
}

/**
 * Display-only normalization for persisted selection/recommendation reasons.
 * Older records were stored with the word "strategy"; the product now calls
 * the same object a "resume approach". Stored history is never rewritten —
 * this only rewords provenance text at render time.
 */
export function formatPersistedStrategyReason(reason: string): string {
  return reason
    .replace(/\bstrategies\b/gi, (match) =>
      match.startsWith("S") ? "Approaches" : "approaches",
    )
    .replace(/\bstrategy\b/gi, (match) =>
      match.startsWith("S") ? "Approach" : "approach",
    );
}
