import {
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
  buildResumeDraftFromTailoredDraft,
  buildResumeRenderDocument,
  collectResumeWorkspaceEvidence,
  sanitizeResumeDraft,
  validateResumeDraft,
} from "../internal/resume-workspace-helpers";
import {
  applyResumeLanguage,
  collectResumeLanguageFields,
  hasUntranslatedResumeSourceProse,
  writeResumeLanguage,
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

/** Retires drafts made by the old skill-injecting/fallback writer on Apply. */
export const RESUME_WRITER_VERSION = 1;

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
  sales: [
    "sales",
    "account executive",
    "business development",
    "customer success",
  ],
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
      return (
        tokens.has("lead") || tokens.has("principal") || tokens.has("staff")
      );
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
    const overlap = [...targetCore].filter((token) =>
      ownCore.has(token),
    ).length;
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
 * Writes one job's resume at `level`, retaining the model's output.
 * Returns null for `original`, which sends the imported file.
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
                      ...(section.included === false || entry.included === false
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
    resumeHeadline: headline ?? ownHeadline(profile),
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
  // Every level keeps the model's written content; preview supplies layout facts
  // to the writer without an editorial pass over its claims or prose.
  const finalDraft = sanitized;
  // Translate any remaining source-language fields through the existing
  // whole-document translator. Same-language writes keep the one writer call.
  const localized = hasUntranslatedResumeSourceProse(finalDraft, profile)
    ? await writeResumeLanguage({
        aiClient: deps.aiClient,
        draft: finalDraft,
        job,
        ...(signal ? { signal } : {}),
      })
    : finalDraft;
  return {
    ...localized,
    status: "draft",
    writerVersion: RESUME_WRITER_VERSION,
  };
}
