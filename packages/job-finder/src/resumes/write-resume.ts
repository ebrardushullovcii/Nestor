import {
  collectListingRequestedSkills,
  completeTailoredResumeDraft,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import {
  isResumeTemplateApplyEligible,
  JobPostingSchema,
  SavedJobSchema,
  type CandidateProfile,
  type JobDetail,
  type JobFinderSettings,
  type JobSearchPreferences,
  type ResumeDraft,
  type ResumeLevel,
  type SavedJob,
  type TailoringMode,
} from "@nestor/contracts";

import {
  settleResumeClaimLines,
  withResumeClaimChecks,
} from "../internal/resume-claim-checks";
import {
  buildPersonsOwnResumeClaimMatcher,
  buildResumeClaimDescriptors,
  buildResumeClaimEvidenceBank,
  buildResumeDraftFromTailoredDraft,
  buildResumeRenderDocument,
  collectResumeWorkspaceEvidence,
  resumeClaimContentHash,
  sanitizeResumeDraft,
  validateResumeDraft,
} from "../internal/resume-workspace-helpers";
import {
  applyResumeLanguage,
  collectResumeLanguageFields,
} from "../internal/resume-workspace-language";
import { looksLikeCleanRoleTitle } from "../internal/resume-workspace-structure";
import type { JobFinderDocumentManager } from "../internal/workspace-service-contracts";

/** What every resume is written from: the person's profile and settings. */
export interface ResumeWriterInputs {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  settings: JobFinderSettings;
}

export interface ResumeWriterDeps {
  aiClient: JobFinderAiClient;
  documentManager: Pick<
    JobFinderDocumentManager,
    "listResumeTemplates" | "renderResumeArtifact" | "discardResumeArtifact"
  >;
}

export const TAILORING_MODE_BY_LEVEL: Record<
  Exclude<ResumeLevel, "original">,
  TailoringMode
> = { light: "conservative", tailored: "balanced", aggressive: "aggressive" };

/** The profile's default level: Settings' resume mode and tailoring strength. */
export function resolveProfileResumeLevel(
  inputs: Pick<ResumeWriterInputs, "searchPreferences" | "settings">,
): ResumeLevel {
  if (inputs.settings.resumeApplicationMode === "original_resume") {
    return "original";
  }
  const mode = inputs.searchPreferences.tailoringMode;
  return mode === "conservative"
    ? "light"
    : mode === "aggressive"
      ? "aggressive"
      : "tailored";
}

/**
 * The store's job in the shape the resume code reads. Only listing facts are
 * filled in; the writer never looks at search or fit state.
 */
export function toResumeJob(job: JobDetail): SavedJob {
  const id = String(job.id);
  const posting = JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: id,
    canonicalUrl: job.url,
    applicationUrl: job.applyUrl,
    title: job.title,
    company: job.company,
    location: job.location || "Unknown",
    workMode: job.workModes,
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: job.postedAt,
    discoveredAt: job.foundAt,
    salaryText: job.salaryText,
    detailQuality: "detail_enriched",
    summary: job.summary,
    description: job.description || job.summary || job.title,
    keySkills: job.facts.keySkills,
    responsibilities: job.facts.responsibilities,
    minimumQualifications: job.facts.minimumQualifications,
    preferredQualifications: job.facts.preferredQualifications,
    seniority: job.seniority,
    employmentType: job.employmentType,
    department: job.facts.department,
    team: job.facts.team,
    employerDomain: job.facts.employerDomain,
    atsProvider: job.facts.atsProvider,
    benefits: job.facts.benefits,
  });
  return SavedJobSchema.parse({
    ...posting,
    id,
    status: "shortlisted",
    matchAssessment: {
      score: job.fitScore ?? 0,
      reasons: job.fit?.reasons ?? [],
      gaps: job.fit?.gaps ?? [],
    },
  });
}

/** Drafts the person has not finished in Profile are not evidence yet. */
function savedProfile(profile: CandidateProfile): CandidateProfile {
  return {
    ...profile,
    experiences: profile.experiences.filter((record) => !record.isDraft),
    education: profile.education.filter((record) => !record.isDraft),
    certifications: profile.certifications.filter((record) => !record.isDraft),
    links: profile.links.filter((record) => !record.isDraft),
  };
}

/**
 * The role families a target title may move between. Aggressive may present a
 * close or adjacent title, but it must not turn an engineer into a nurse or a
 * teacher into a director.
 */
const TITLE_FAMILIES: Record<string, readonly string[]> = {
  engineering: [
    "engineer",
    "engineering",
    "developer",
    "programmer",
    "architect",
    "devops",
    "sre",
    "platform",
    "backend",
    "frontend",
    "fullstack",
    "full-stack",
    "mobile",
    "cloud",
    "security",
    "qa",
    "test",
  ],
  data: [
    "data",
    "analytics",
    "analyst",
    "scientist",
    "science",
    "insights",
    "machine learning",
    "artificial intelligence",
    "ai",
    "bi",
  ],
  design: ["designer", "design", "ux", "ui", "creative", "art"],
  marketing: [
    "marketing",
    "growth",
    "brand",
    "content",
    "communications",
    "seo",
    "lifecycle",
    "campaign",
    "social media",
  ],
  education: [
    "teacher",
    "teach",
    "instructor",
    "trainer",
    "lecturer",
    "tutor",
    "education",
    "instructional",
    "curriculum",
    "learning",
    "student",
  ],
  healthcare: [
    "nurse",
    "rn",
    "doctor",
    "physician",
    "surgeon",
    "clinician",
    "clinical",
    "patient",
    "medical",
    "healthcare",
    "therapist",
    "pharmacist",
    "dentist",
    "veterinarian",
  ],
  operations: [
    "operations",
    "ops",
    "logistics",
    "supply",
    "warehouse",
    "program",
    "project",
    "manager",
  ],
  finance: [
    "finance",
    "financial",
    "accountant",
    "accounting",
    "cpa",
    "audit",
    "tax",
    "controller",
  ],
  legal: ["lawyer", "attorney", "legal", "counsel", "paralegal"],
  sales: ["sales", "account executive", "business development", "customer success"],
  people: ["hr", "human resources", "recruiter", "talent", "people"],
  product: ["product manager", "product owner", "product"],
  support: ["administrator", "admin", "support", "coordinator", "assistant"],
};

const TITLE_LEVEL_WORDS = new Set([
  "junior",
  "jr",
  "senior",
  "sr",
  "lead",
  "principal",
  "staff",
  "director",
  "head",
  "vp",
  "vice",
  "president",
  "chief",
  "manager",
  "intern",
  "internship",
  "trainee",
  "associate",
  "ii",
  "iii",
  "iv",
]);

const TITLE_CONNECTOR_WORDS = new Set([
  "of",
  "and",
  "the",
  "for",
  "in",
  "at",
  "with",
  "a",
  "an",
  "&",
]);

const TITLE_HIGH_LEVEL_WORDS = new Set([
  "director",
  "head",
  "vp",
  "vice",
  "president",
  "chief",
]);

const TITLE_LICENSED_WORDS = new Set([
  "nurse",
  "rn",
  "doctor",
  "physician",
  "surgeon",
  "lawyer",
  "attorney",
  "cpa",
  "accountant",
  "pharmacist",
  "therapist",
  "dentist",
  "veterinarian",
  "electrician",
  "plumber",
  "welder",
]);

const TITLE_SYNONYMS: Record<string, string> = {
  developer: "engineer",
  programming: "engineer",
  programmer: "engineer",
  engineering: "engineer",
  dev: "engineer",
};

function rawTitleTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}+#.]+/u)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function coreTitleTokens(value: string): Set<string> {
  return new Set(
    [...rawTitleTokens(value)]
      .map((token) => TITLE_SYNONYMS[token] ?? token)
      .filter(
        (token) =>
          !TITLE_LEVEL_WORDS.has(token) &&
          !TITLE_CONNECTOR_WORDS.has(token) &&
          token.length > 0,
      ),
  );
}

function titleLevelRank(value: string): number {
  const tokens = rawTitleTokens(value);
  if ([...TITLE_HIGH_LEVEL_WORDS].some((word) => tokens.has(word))) return 6;
  if (
    tokens.has("manager") ||
    tokens.has("lead") ||
    tokens.has("principal") ||
    tokens.has("staff")
  ) {
    return 5;
  }
  if (tokens.has("senior") || tokens.has("sr")) return 4;
  if (tokens.has("junior") || tokens.has("jr")) return 1;
  if (tokens.has("intern") || tokens.has("internship") || tokens.has("trainee"))
    return 1;
  if (tokens.has("associate")) return 2;
  return 3;
}

function titleFamilies(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const tokens = rawTitleTokens(value);
  const families = new Set<string>();
  for (const [family, terms] of Object.entries(TITLE_FAMILIES)) {
    if (
      terms.some((term) =>
        term.includes(" ") ? normalized.includes(term) : tokens.has(term),
      )
    ) {
      families.add(family);
    }
  }
  return families;
}

/** The person's own headline, or their current/most recent role title. */
function ownHeadline(profile: CandidateProfile): string | null {
  const headline = profile.headline?.trim();
  if (headline) return headline;
  const current =
    profile.experiences.find((experience) => experience.isCurrent) ??
    profile.experiences[0];
  return current?.title?.trim() || null;
}

/**
 * A target title may become the headline only when it is the same or an
 * adjacent role family and not a level the person has never held. This is the
 * line between "uses TypeScript, so it can say Go" and "engineer becomes a
 * nurse" or "student becomes a director".
 */
export function isPlausibleAggressiveHeadline(
  targetTitle: string,
  profile: CandidateProfile,
): boolean {
  const target = targetTitle.trim();
  if (!target) return false;
  const ownTitles = [
    profile.headline?.trim(),
    ...profile.experiences.map((experience) => experience.title?.trim()),
  ].filter((title): title is string => Boolean(title));
  if (ownTitles.length === 0) return false;
  if (ownTitles.some((title) => title.toLowerCase() === target.toLowerCase())) {
    return true;
  }

  const targetTokens = rawTitleTokens(target);
  const targetLevel = titleLevelRank(target);
  const ownLevels = ownTitles.map(titleLevelRank);
  const ownLevel = Math.max(0, ...ownLevels);
  const years = profile.yearsExperience ?? 0;

  const targetLicensed = [...TITLE_LICENSED_WORDS].filter((word) =>
    targetTokens.has(word),
  );
  if (
    targetLicensed.length > 0 &&
    !targetLicensed.every((word) =>
      ownTitles.some((title) => rawTitleTokens(title).has(word)),
    )
  ) {
    return false;
  }

  if (
    [...TITLE_HIGH_LEVEL_WORDS].some((word) => targetTokens.has(word)) &&
    ownLevel < 6
  ) {
    return false;
  }
  if (targetTokens.has("manager") && ownLevel < 5 && years < 6) return false;
  if (
    (targetTokens.has("lead") ||
      targetTokens.has("principal") ||
      targetTokens.has("staff")) &&
    !ownTitles.some((title) => {
      const tokens = rawTitleTokens(title);
      return tokens.has("lead") || tokens.has("principal") || tokens.has("staff");
    })
  ) {
    return false;
  }
  if (
    (targetTokens.has("senior") || targetTokens.has("sr")) &&
    ownLevel < 4 &&
    years < 5
  ) {
    return false;
  }
  if (
    (targetTokens.has("junior") ||
      targetTokens.has("jr") ||
      targetTokens.has("intern") ||
      targetTokens.has("internship") ||
      targetTokens.has("trainee")) &&
    (ownLevel >= 4 || years >= 3)
  ) {
    return false;
  }
  // A director should not become a coordinator just to match a posting.
  if (ownLevel - targetLevel >= 2) return false;

  const targetFamilies = titleFamilies(target);
  if (targetFamilies.size === 0) return false;
  const ownFamilies = new Set(
    ownTitles.flatMap((title) => [...titleFamilies(title)]),
  );
  if ([...targetFamilies].some((family) => ownFamilies.has(family))) {
    return true;
  }

  // Last chance for a close title with distinctive shared words but no family
  // tag (for example "Solutions Consultant" to "Solutions Architect").
  const targetCore = coreTitleTokens(target);
  return ownTitles.some((title) => {
    const ownCore = coreTitleTokens(title);
    const overlap = [...targetCore].filter((token) => ownCore.has(token)).length;
    return (
      overlap >= 2 &&
      (ownLevel - targetLevel < 2 || targetLevel - ownLevel <= 1)
    );
  });
}

/**
 * Aggressive leads with the role being applied for when that is plausible;
 * otherwise it keeps the person's own title. The other levels keep the
 * person's own headline.
 */
function headlineFor(
  level: ResumeLevel,
  job: SavedJob,
  profile: CandidateProfile,
): string | null | undefined {
  if (level !== "aggressive") return undefined;
  // "Full-Stack Engineer (TypeScript) - Remote" leads as "Full-Stack Engineer".
  const title = job.title
    .replace(/\([^)]*\)|\[[^\]]*\]/gu, " ")
    .split(/\s[-–—|]\s|,\s/u)[0]!
    .replace(/\s+/gu, " ")
    .trim();
  if (
    looksLikeCleanRoleTitle(title) &&
    isPlausibleAggressiveHeadline(title, profile)
  ) {
    return title;
  }
  return ownHeadline(profile);
}

/**
 * Writes one job's resume at `level`. The model's own flagged lines are fixed
 * or left off here, so what comes back needs nothing from the person but a
 * read. Returns null for `original`, which sends the imported file.
 */
export async function writeResume(
  deps: ResumeWriterDeps,
  input: ResumeWriterInputs & {
    job: JobDetail;
    level: ResumeLevel;
    signal?: AbortSignal;
  },
): Promise<ResumeDraft | null> {
  if (input.level === "original") return null;
  const { settings, signal } = input;
  const tailoringMode = TAILORING_MODE_BY_LEVEL[input.level];
  const profile = savedProfile(input.profile);
  const job = toResumeJob(input.job);
  const searchPreferences = { ...input.searchPreferences, tailoringMode };
  const resumeText = profile.baseResume.textContent;
  const templates = deps.documentManager.listResumeTemplates();
  const now = () => new Date().toISOString();
  const headline = headlineFor(input.level, job, profile);
  const assemble = (
    draft: Parameters<typeof buildResumeDraftFromTailoredDraft>[0]["draft"],
    templateId: ResumeDraft["templateId"],
  ) => {
    const at = now();
    const assembled = buildResumeDraftFromTailoredDraft({
      job,
      profile,
      templateId,
      draft,
      createdAt: at,
      generationMethod: "ai",
      ...(headline !== undefined ? { headline } : {}),
    });
    return draft.languagePresentation
      ? applyResumeLanguage(
          assembled,
          draft.languagePresentation,
          profile.projects.map((project) => project.id),
        )
      : assembled;
  };
  const check = {
    aiClient: deps.aiClient,
    job,
    profile,
    tailoringStrength: tailoringMode,
    ...(signal ? { signal } : {}),
  };
  const roleIds = new Set(profile.experiences.map((record) => record.id));
  const sanitize = (draft: ResumeDraft, sourceSkills?: readonly string[]) => {
    const clean = sanitizeResumeDraft({
      draft,
      job,
      profile,
      ...(sourceSkills ? { sourceSkills } : {}),
    });
    return {
      ...clean,
      sections: clean.sections.map((section) =>
        section.kind !== "experience" || !roleIds.size
          ? section
          : {
              ...section,
              included: true,
              ...(section.included === false
                ? {
                    text: null,
                    bullets: section.bullets.map((bullet) => ({
                      ...bullet,
                      included: false,
                    })),
                  }
                : {}),
              entries: section.entries.map((entry) =>
                entry.profileRecordId && roleIds.has(entry.profileRecordId)
                  ? {
                      ...entry,
                      included: true,
                      // A model omission keeps the role and its real evidence
                      // rather than exporting a title with no bullets. Two
                      // source bullets are enough to avoid an empty role; the
                      // page-fill pass can show more when there is room.
                      ...(section.included === false ||
                      entry.included === false
                        ? {
                            summary: entry.summary ?? null,
                            bullets: entry.bullets.map((bullet, index) => ({
                              ...bullet,
                              included: index < 2,
                            })),
                          }
                        : {}),
                    }
                  : section.included !== false
                    ? entry
                    : { ...entry, included: false },
              ),
            },
      ),
    };
  };

  const baseDraft = assemble(
    completeTailoredResumeDraft(
      {},
      { profile, job, settings, searchPreferences, resumeText },
    ),
    settings.resumeTemplateId,
  );
  const written = await deps.aiClient.createResumeDraft({
    ...(signal ? { signal } : {}),
    profile,
    searchPreferences,
    settings,
    job,
    resumeText,
    evidence: collectResumeWorkspaceEvidence({ profile, job, research: [] }),
    availableTemplates: templates,
    selectedTemplateId: settings.resumeTemplateId,
    templateSelectionLocked: false,
    language: null,
    languageFields: collectResumeLanguageFields(baseDraft),
    targetPageCount: baseDraft.targetPageCount,
    renderPreview: async ({ draft, templateId, signal: previewSignal }) => {
      const template = templates.find((entry) => entry.id === templateId);
      if (!template || !isResumeTemplateApplyEligible(template)) {
        throw new Error(`Resume template '${templateId}' is unavailable.`);
      }
      const checkSignal =
        previewSignal && signal
          ? AbortSignal.any([previewSignal, signal])
          : (previewSignal ?? signal);
      const preview = sanitize(assemble(draft, template.id), draft.coreSkills);
      const rendered = await deps.documentManager.renderResumeArtifact({
        ...(checkSignal ? { signal: checkSignal } : {}),
        job,
        profile,
        renderDocument: buildResumeRenderDocument(profile, preview),
        templateId: template.id,
        settings,
      });
      await deps.documentManager.discardResumeArtifact?.(rendered);
      // Facts are checked once, after writing; here the writer only learns
      // whether the draft is well formed and fits its pages.
      const validation = validateResumeDraft({
        draft: preview,
        job,
        profile,
        pageCount: rendered.pageCount ?? null,
      });
      return {
        templateId: template.id,
        pageCount: rendered.pageCount ?? null,
        targetPageCount: preview.targetPageCount,
        warnings: rendered.warnings ?? [],
        fileName: rendered.fileName,
        requiredModelRepairs: validation.issues.filter(
          (issue) => issue.severity === "error",
        ),
        languageFields: collectResumeLanguageFields(preview),
      };
    },
  });

  const sanitized = sanitize(
    assemble(
      written,
      written.recommendedTemplateId ?? settings.resumeTemplateId,
    ),
    written.coreSkills,
  );
  // Aggressive accepted stretching when the person chose it, so only its
  // numbers are held to the evidence; the other levels have every written
  // line checked by the model once. Either way a failed line takes the
  // checker's fix, goes back to the person's own wording, or is left off.
  const withListingSkills =
    input.level === "aggressive"
      ? addMissingListingSkills(sanitized, job)
      : sanitized;
  const checked =
    input.level === "aggressive"
      ? stripRepeatedAppendedClauses(
          stripGenericPurposeClauses(
            withNumberChecks(withListingSkills, profile),
          ),
        )
      : await withResumeClaimChecks({ ...check, draft: sanitized });
  const settled = settleResumeClaimLines({
    draft: checked,
    profile,
    stretchesAreThePersons: input.level === "aggressive",
  });
  const settledDraft = settled ? sanitize(settled, written.coreSkills) : checked;
  const cleanedDraft =
    input.level === "aggressive" ? trimRepeatedSummary(settledDraft) : settledDraft;
  const polishedDraft =
    input.level === "aggressive" ? compactPercentages(cleanedDraft) : cleanedDraft;
  const prioritizedDraft =
    input.level === "aggressive"
      ? prioritizeMetricBullets(polishedDraft)
      : polishedDraft;
  const alignedDraft =
    input.level === "aggressive"
      ? alignAggressiveSummaryWithHeadline(prioritizedDraft, profile)
      : prioritizedDraft;

  /**
   * One page is the default, not a hard rule. A resume that naturally renders
   * to one or two pages keeps its content; only a render past the page target
   * trims older roles, one saved bullet each. Nothing is padded to fill pages.
   */
  async function trimOverTargetPages(
    initial: ResumeDraft,
  ): Promise<ResumeDraft> {
    let current = initial;
    for (let pass = 0; pass < 3; pass += 1) {
      const template =
        templates.find((entry) => entry.id === current.templateId) ??
        templates.find((entry) => entry.id === settings.resumeTemplateId);
      if (!template || !isResumeTemplateApplyEligible(template)) break;
      let pageCount: number | null = null;
      try {
        const rendered = await deps.documentManager.renderResumeArtifact({
          ...(signal ? { signal } : {}),
          job,
          profile,
          renderDocument: buildResumeRenderDocument(profile, current),
          templateId: template.id,
          settings,
        });
        pageCount = rendered.pageCount ?? null;
        await deps.documentManager.discardResumeArtifact?.(rendered);
      } catch {
        break;
      }
      if (
        pageCount === null ||
        initial.targetPageCount <= 1 ||
        pageCount < initial.targetPageCount
      ) {
        break;
      }
      // At or over the target, try the least relevant material first: older
      // roles keep one bullet. If the recent roles still need the page, the
      // next render keeps it.
      const trimmed = compressOlderRoles(current);
      if (trimmed === current) break;
      current = trimmed;
    }
    return current;
  }

  const finalDraft =
    input.level === "aggressive" && alignedDraft.targetPageCount > 1
      ? await trimOverTargetPages(alignedDraft)
      : alignedDraft;
  return { ...finalDraft, status: "draft" };
}

/**
 * The headline and the summary's first sentence should name the same role. The
 * writer sometimes opens with the person's saved title while the headline uses
 * the close target title; replace that leading title so the resume does not
 * contradict itself.
 */
function alignAggressiveSummaryWithHeadline(
  draft: ResumeDraft,
  profile: CandidateProfile,
): ResumeDraft {
  const headline = draft.identity?.headline?.trim();
  if (!headline) return draft;
  const summary = draft.sections.find(
    (section) => section.kind === "summary" && section.text?.trim(),
  );
  const text = summary?.text?.trim();
  if (!summary || !text) return draft;
  if (text.toLowerCase().startsWith(headline.toLowerCase())) return draft;
  const leadingTitle = [
    profile.headline?.trim(),
    ...profile.experiences.map((experience) => experience.title?.trim()),
  ]
    .filter((title): title is string => Boolean(title))
    .filter((title) => text.toLowerCase().startsWith(title.toLowerCase()))
    .sort((left, right) => right.length - left.length)[0];
  if (!leadingTitle) return draft;
  const nextText = `${headline}${text.slice(leadingTitle.length)}`;
  return {
    ...draft,
    sections: draft.sections.map((section) =>
      section.id === summary.id
        ? { ...section, text: nextText, origin: "ai_generated" }
        : section,
    ),
  };
}

// A digit inside a word is part of the name, not a claim: B2B, S/4HANA and
// SCORM 1.2 are skills, while "18 teams" is a number to check.
const LISTING_HARD_SKILL_PHRASES = [
  "data pipelines",
  "developer tools",
  "machine learning",
  "design systems",
  "rest apis",
  "ci/cd",
  "unit testing",
  "integration testing",
  "web accessibility",
  "distributed systems",
  "microservices",
  "data modeling",
  "cloud infrastructure",
  "containerization",
  "observability",
] as const;

const BOILERPLATE_SKILLS = new Set([
  "clear communication",
  "communication skills",
  "strong communication skills",
  "willingness to learn",
  "eager to learn",
  "fast learner",
  "team player",
  "hard working",
  "hard-working",
  "detail oriented",
  "detail-oriented",
  "self starter",
  "self-starter",
]);

const GENERIC_SKILL_TOKENS = new Set([
  "app",
  "apps",
  "software",
  "system",
  "systems",
  "tool",
  "tools",
  "technology",
  "technologies",
  "data",
  "platform",
  "platforms",
  "product",
  "products",
  "service",
  "services",
  "solution",
  "solutions",
  "workflow",
  "workflows",
  "monitoring",
  "safety",
  "telematics",
]);

const HARD_SKILL_HINTS =
  /\b(?:api|apis|sql|cloud|data|machine learning|artificial intelligence|web|mobile|frontend|backend|full[- ]?stack|devops|security|test|testing|automation|analytics|platform|framework|database|networking|kubernetes|docker|terraform|snowflake|databricks|bigquery|salesforce|marketo|salesloft|developer tools|design systems|accessibility|performance|reliability)\b/iu;

function normalizeSkill(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .trim();
}

/**
 * ATS keywords help only when they name a hard skill the candidate could
 * plausibly list. Listing phrases such as "Video-Based Safety" or
 * "Equipment Monitoring" are the job's domain, not the person's skills, and
 * putting them in Skills reads as stuffing to a recruiter.
 */
export function isResumeHardSkill(skill: string): boolean {
  const trimmed = skill.trim();
  const key = normalizeSkill(trimmed);
  if (!key || BOILERPLATE_SKILLS.has(key)) return false;
  const tokens = trimmed.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) return false;
  if (/^[CR]$/u.test(trimmed)) return true;
  if (/[+#./\d]/u.test(trimmed)) return true;
  if (tokens.length === 1) {
    return (
      !GENERIC_SKILL_TOKENS.has(key) &&
      trimmed.length >= 2 &&
      trimmed.length <= 24 &&
      /^[A-Za-z][A-Za-z0-9+#.]*$/u.test(trimmed)
    );
  }
  return HARD_SKILL_HINTS.test(trimmed);
}

/**
 * ATS screening looks for the listing's exact hard skills. When the writer
 * leaves one out, add it to the skills block rather than inventing a project
 * around it. The listing's own names come first; the person's real skills stay.
 */
export function addMissingListingSkills(
  draft: ResumeDraft,
  job: SavedJob,
): ResumeDraft {
  const requested = collectListingRequestedSkills(job).map((skill) =>
    skill.trim(),
  );
  const listingText = [
    job.description ?? "",
    ...(job.responsibilities ?? []),
    ...(job.minimumQualifications ?? []),
    ...(job.preferredQualifications ?? []),
  ]
    .join(" ")
    .toLowerCase();
  for (const phrase of LISTING_HARD_SKILL_PHRASES) {
    if (
      listingText.includes(phrase) &&
      !requested.some((skill) => normalizeSkill(skill) === phrase)
    ) {
      requested.push(phrase);
    }
  }
  const skillsToAdd = requested.filter(isResumeHardSkill);
  if (skillsToAdd.length === 0) return draft;
  const skillsSection =
    draft.sections.find(
      (section) => section.kind === "skills" && section.id === "section_skills",
    ) ?? draft.sections.find((section) => section.kind === "skills");
  if (!skillsSection) return draft;

  const resumeText = normalizeSkill(
    draft.sections
      .flatMap((section) => [
        section.text ?? "",
        ...section.bullets.map((bullet) => bullet.text),
        ...section.entries.flatMap((entry) => [
          entry.summary ?? "",
          ...entry.bullets.map((bullet) => bullet.text),
        ]),
      ])
      .join(" "),
  );
  const existing = new Set(
    skillsSection.bullets.map((bullet) => normalizeSkill(bullet.text)),
  );
  const at = new Date().toISOString();
  const missing = skillsToAdd
    .filter((skill) => {
      const key = normalizeSkill(skill);
      return key.length > 0 && !existing.has(key) && !resumeText.includes(key);
    })
    .slice(0, 12)
    .map((skill, index) => ({
      id: `${skillsSection.id}_listing_skill_${index + 1}`,
      text: skill,
      origin: "ai_generated" as const,
      locked: false,
      included: true,
      sourceRefs: [],
      lastGeneratedContentHash: null,
      updatedAt: at,
    }));
  if (missing.length === 0) return draft;
  return {
    ...draft,
    sections: draft.sections.map((section) =>
      section.id === skillsSection.id
        ? { ...section, bullets: [...section.bullets, ...missing] }
        : section,
    ),
  };
}

const NUMBER = /(?<![\p{L}\p{N}])\d[\d,.]*(?![\p{L}\p{N}])/gu;
const numbersIn = (text: string) =>
  (text.match(NUMBER) ?? []).map((value) =>
    value.replace(/[,.]+$/u, "").replace(/,/gu, ""),
  );

/**
 * Marks each written line that states a number the person's evidence does
 * not have as unsupported, so settling restores or drops it.
 */
function withNumberChecks(
  draft: ResumeDraft,
  profile: CandidateProfile,
): ResumeDraft {
  const known = new Set(
    [
      ...buildResumeClaimEvidenceBank(profile).map((entry) => entry.text),
      profile.baseResume.textContent ?? "",
      // Aggressive may round evidenced years up by one.
      ...(profile.yearsExperience
        ? [`${profile.yearsExperience} ${profile.yearsExperience + 1}`]
        : []),
    ].flatMap(numbersIn),
  );
  const isPersonsOwn = buildPersonsOwnResumeClaimMatcher({ draft, profile });
  // A skill name is not a prose number. SCORM 1.2 and S/4HANA are real skills;
  // treating their digits as unsupported claims silently removed them.
  const skillSectionIds = new Set(
    draft.sections
      .filter(
        (section) => section.kind === "skills" || section.kind === "keywords",
      )
      .map((section) => section.id),
  );
  const checkedAt = new Date().toISOString();
  const claimChecks = buildResumeClaimDescriptors(draft)
    .filter((line) => !skillSectionIds.has(line.sectionId))
    .filter((line) => !isPersonsOwn(line))
    .filter((line) => numbersIn(line.text).some((value) => !known.has(value)))
    .map((line) => ({
      contentHash: resumeClaimContentHash(line.text),
      verdict: "unsupported" as const,
      reason: "States a number the profile does not have.",
      evidenceIds: [],
      fix: null,
      evidenceKey: null,
      checkedAt,
    }));
  return { ...draft, claimChecks };
}

const APPENDED_CLAUSE_PATTERN =
  /(,\s*|\s+)((?:with|while|including|improving|using|for)\s+[^,;.!?]{8,90})$/iu;

function clauseKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .trim();
}

/**
 * Padding such as "with SQL and automated tests" on every bullet reads as
 * machine-written. Strip an appended clause when it repeats on three or more
 * texts; the first use stays, the rest lose it. A text is left alone if
 * removing the clause would leave too little.
 */
export function stripRepeatedAppendedClauseTexts(
  texts: readonly string[],
): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const match = text.match(APPENDED_CLAUSE_PATTERN);
    if (!match) continue;
    const clause = match[2]!.trim();
    const wordCount = clause.split(/\s+/u).length;
    if (wordCount < 3 || wordCount > 12) continue;
    const key = clauseKey(clause);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = new Set(
    [...counts].filter(([, count]) => count >= 3).map(([key]) => key),
  );
  if (repeated.size === 0) return [...texts];

  const kept = new Set<string>();
  return texts.map((text) => {
    const match = text.match(APPENDED_CLAUSE_PATTERN);
    if (!match) return text;
    const key = clauseKey(match[2]!.trim());
    if (!repeated.has(key)) return text;
    if (!kept.has(key)) {
      kept.add(key);
      return text;
    }
    const stripped = text
      .slice(0, match.index ?? 0)
      .replace(/[,\s]+$/u, "")
      .trim();
    return stripped.length >= 25 ? stripped : text;
  });
}

/**
 * A trailing purpose clause that repeats what the bullet already says ("to
 * improve reliability" on a reliability bullet) is the padding a recruiter
 * notices. Strip only generic outcome clauses and only when enough of the
 * bullet remains.
 */
const GENERIC_PURPOSE_PATTERNS = [
  /(?:,\s*|\s+)(?:to|for)\s+(?:improve|support|enable|ensure|maintain|deliver|drive|increase|reduce|help|strengthen)\s+(?:the\s+)?(?:performance|reliability|accessibility|quality|delivery|maintainability|scalability|user experience|efficiency|productivity|collaboration|security|velocity|throughput)\b[^.!?]*[.!?]?$/iu,
  /(?:,\s*|\s+)(?:supporting|improving|enhancing|enabling|ensuring|maintaining|delivering|driving|strengthening)\s+(?:the\s+)?(?:performance|reliability|accessibility|quality|delivery|maintainability|scalability|user experience|efficiency|productivity|collaboration|security|velocity|throughput|apis?|data pipelines?|developer tools?)\b[^.!?]*[.!?]?$/iu,
  /(?:,\s*|\s+)(?:collaborating|working)\s+(?:across|with)\s+[^.!?]{3,80}[.!?]?$/iu,
  /(?:,\s*|\s+)for\s+(?:maintainable|reliable|scalable|accessible|high-quality)\s+(?:delivery|software|systems|solutions|experiences)\b[^.!?]*[.!?]?$/iu,
  /(?:,\s*|\s+)(?:designing|building|delivering)\s+(?:maintainable|reliable|scalable|accessible)\s+(?:software|systems|solutions|experiences)\b[^.!?]*[.!?]?$/iu,
];

export function stripGenericPurposeClauseTexts(
  texts: readonly string[],
): string[] {
  return texts.map((text) => {
    let next = text;
    for (let pass = 0; pass < 3; pass += 1) {
      let changed = false;
      for (const pattern of GENERIC_PURPOSE_PATTERNS) {
        const match = pattern.exec(next);
        if (!match) continue;
        const trailing = /[.!?]$/u.exec(next)?.[0] ?? "";
        const stripped = next
          .slice(0, match.index)
          .replace(/[,\s]+$/u, "")
          .trim();
        if (stripped.length >= 40 && stripped.split(/\s+/u).length >= 6) {
          next = `${stripped}${trailing}`;
          changed = true;
          break;
        }
      }
      if (!changed) break;
    }
    return next;
  });
}

/** Recruiters skim metrics; keep a role's numbered proof above its prose. */
export function orderBulletsMetricsFirst<T extends { text: string }>(
  bullets: readonly T[],
): T[] {
  const numbered: T[] = [];
  const rest: T[] = [];
  for (const bullet of bullets) {
    (/\d/u.test(bullet.text) ? numbered : rest).push(bullet);
  }
  return [...numbered, ...rest];
}

function experienceBulletTexts(draft: ResumeDraft): string[] {
  return draft.sections
    .filter((section) => section.kind === "experience")
    .flatMap((section) => [
      ...section.bullets
        .filter((bullet) => bullet.included !== false)
        .map((bullet) => bullet.text),
      ...section.entries.flatMap((entry) =>
        entry.bullets
          .filter((bullet) => bullet.included !== false)
          .map((bullet) => bullet.text),
      ),
    ]);
}

function normalizeSummaryWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * The summary should pitch, not replay the first bullets. Drop a later summary
 * sentence when it shares a five-word run with any shown bullet; the opening
 * sentence always stays.
 */
export function summaryWithoutRepeatedBulletPhrases(
  summary: string,
  bullets: readonly string[],
  minWords = 5,
): string {
  const sentences = summary
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length <= 1) return summary;
  const windows = new Set<string>();
  for (const bullet of bullets) {
    const words = normalizeSummaryWords(bullet);
    for (let index = 0; index + minWords <= words.length; index += 1) {
      windows.add(words.slice(index, index + minWords).join(" "));
    }
  }
  const kept = [sentences[0]!];
  for (const sentence of sentences.slice(1)) {
    const words = normalizeSummaryWords(sentence);
    const repeated = words.some(
      (_word, index) =>
        index + minWords <= words.length &&
        windows.has(words.slice(index, index + minWords).join(" ")),
    );
    if (!repeated) kept.push(sentence);
  }
  return kept.join(" ");
}

function trimRepeatedSummary(draft: ResumeDraft): ResumeDraft {
  const summary = draft.sections.find(
    (section) => section.kind === "summary" && section.text?.trim(),
  );
  if (!summary?.text) return draft;
  const nextText = summaryWithoutRepeatedBulletPhrases(
    summary.text,
    experienceBulletTexts(draft),
  );
  if (nextText === summary.text.trim()) return draft;
  return {
    ...draft,
    sections: draft.sections.map((section) =>
      section.id === summary.id ? { ...section, text: nextText } : section,
    ),
  };
}

/** "42 percent" reads slower than "42%" on a resume. */
export function compactPercentageText(text: string): string {
  return text.replace(/\b(\d+(?:\.\d+)?)\s+percent\b/giu, "$1%");
}

function compactPercentages(draft: ResumeDraft): ResumeDraft {
  const text = (value: string | null) =>
    value ? compactPercentageText(value) : value;
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      text: text(section.text),
      bullets: section.bullets.map((bullet) => ({
        ...bullet,
        text: compactPercentageText(bullet.text),
      })),
      entries: section.entries.map((entry) => ({
        ...entry,
        summary: text(entry.summary),
        bullets: entry.bullets.map((bullet) => ({
          ...bullet,
          text: compactPercentageText(bullet.text),
        })),
      })),
    })),
  };
}

/**
 * Recruiters focus on the last 10-15 years. Older roles stay visible for
 * continuity but keep one bullet, preferably one with a number. This is not
 * an empty role; it is a compact earlier-experience entry.
 */
export function compressOlderRoles(
  draft: ResumeDraft,
  now: Date = new Date(),
): ResumeDraft {
  const cutoff = now.getFullYear() - 12;
  const endYear = (entry: ResumeDraft["sections"][number]["entries"][number]) => {
    const fromEnd = /^(\d{4})/u.exec(entry.endDate ?? "")?.[1];
    if (fromEnd) return Number(fromEnd);
    const matches = [...(entry.dateRange ?? "").matchAll(/(\d{4})/gu)];
    return matches.length > 0 ? Number(matches.at(-1)![1]) : null;
  };
  let changed = false;
  const sections = draft.sections.map((section) => {
    if (section.kind !== "experience") return section;
    return {
      ...section,
      entries: section.entries.map((entry) => {
        if (entry.isCurrent) return entry;
        const year = endYear(entry);
        if (year === null || year > cutoff) return entry;
        const included = entry.bullets.filter(
          (bullet) => bullet.included !== false,
        );
        if (included.length <= 1) return entry;
        const keep =
          included.find((bullet) => /\d/u.test(bullet.text)) ?? included[0]!;
        changed = true;
        return {
          ...entry,
          bullets: entry.bullets.map((bullet) =>
            bullet.id === keep.id ? bullet : { ...bullet, included: false },
          ),
        };
      }),
    };
  });
  return changed ? { ...draft, sections } : draft;
}

export function prioritizeMetricBullets(draft: ResumeDraft): ResumeDraft {
  return {
    ...draft,
    sections: draft.sections.map((section) =>
      section.kind !== "experience"
        ? section
        : {
            ...section,
            entries: section.entries.map((entry) => ({
              ...entry,
              bullets: orderBulletsMetricsFirst(entry.bullets),
            })),
          },
    ),
  };
}

function mapIncludedBulletTexts(
  draft: ResumeDraft,
  transform: (texts: readonly string[]) => string[],
): ResumeDraft {
  const includedBullets = draft.sections.flatMap((section) => [
    ...section.bullets.filter((bullet) => bullet.included !== false),
    ...section.entries.flatMap((entry) =>
      entry.bullets.filter((bullet) => bullet.included !== false),
    ),
  ]);
  const stripped = transform(includedBullets.map((bullet) => bullet.text));
  if (stripped.every((text, index) => text === includedBullets[index]!.text)) {
    return draft;
  }

  let cursor = 0;
  const rewriteBullet = (
    bullet: ResumeDraft["sections"][number]["bullets"][number],
  ) => {
    if (bullet.included === false) return bullet;
    const text = stripped[cursor++] ?? bullet.text;
    return text === bullet.text
      ? bullet
      : { ...bullet, text, lastGeneratedContentHash: null };
  };
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      bullets: section.bullets.map(rewriteBullet),
      entries: section.entries.map((entry) => ({
        ...entry,
        bullets: entry.bullets.map(rewriteBullet),
      })),
    })),
  };
}

function stripRepeatedAppendedClauses(draft: ResumeDraft): ResumeDraft {
  return mapIncludedBulletTexts(draft, stripRepeatedAppendedClauseTexts);
}

function stripGenericPurposeClauses(draft: ResumeDraft): ResumeDraft {
  return mapIncludedBulletTexts(draft, stripGenericPurposeClauseTexts);
}
