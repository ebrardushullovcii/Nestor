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
  withResumeClaimFixes,
  withResumeClaimChecks,
} from "../internal/resume-claim-checks";
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
 * Aggressive leads with the role being applied for; the other levels keep the
 * person's own headline.
 */
function headlineFor(level: ResumeLevel, job: SavedJob): string | undefined {
  if (level !== "aggressive") return undefined;
  // "Full-Stack Engineer (TypeScript) - Remote" leads as "Full-Stack Engineer".
  const title = job.title
    .replace(/\([^)]*\)|\[[^\]]*\]/gu, " ")
    .split(/\s[-–—|]\s|,\s/u)[0]!
    .replace(/\s+/gu, " ")
    .trim();
  return looksLikeCleanRoleTitle(title) ? title : undefined;
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
  const headline = headlineFor(input.level, job);
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
      ...(headline ? { headline } : {}),
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
  const sanitize = (draft: ResumeDraft, sourceSkills?: readonly string[]) =>
    sanitizeResumeDraft({
      draft,
      job,
      profile,
      ...(sourceSkills ? { sourceSkills } : {}),
    });

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
  // The model checks every generated level, including Aggressive's hard limits.
  // Choosing Aggressive accepts stretches; unsupported lines still take the
  // checker's fix, return to saved wording or are left off (ADR 0051).
  const checked = await withResumeClaimChecks({ ...check, draft: sanitized });
  const settled = await withResumeClaimFixes({
    ...check,
    draft: checked,
    stretchesAreThePersons: input.level === "aggressive",
  });
  return {
    ...sanitize(settled, written.coreSkills),
    status: "draft",
  };
}
