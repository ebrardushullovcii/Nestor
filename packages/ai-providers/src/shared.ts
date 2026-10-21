import {
  AssetGenerationReasonSchema,
  ResumeLanguageTranslationSchema,
  JobRequirementAssessmentSchema,
  type AiProfileAssistantBehavior,
  type AgentProviderStatus,
  type AgentTaskValidationIssue,
  AgentTaskExecutionReceiptSchema,
  BrowserVisualObservationSetSchema,
  type BrowserVisualAnalysisInput,
  type BrowserVisualObservationSet,
  NonEmptyStringSchema,
  type ProfileCopilotContext,
  type ProfileCopilotRelevantReviewItem,
  type ProfileCopilotReply,
  type ResumeDocumentBundle,
  type ResumeCareerFamilyFit,
  type ResumeCoverageClassification,
  ResumeDraftPatchSchema,
  TailoredResumeCoverageMetadataSchema,
  type TailoredResumeCoverageMetadata,
  WorkModeListSchema,
  candidateLinkKindValues,
  type CandidateProfile,
  type FitRecommendation,
  FitRecommendationSchema,
  type JobFinderSettings,
  type JobPosting,
  MatchLocationReachSchema,
  type MatchLocationReach,
  PreferenceAlignmentStateSchema,
  type PreferenceAlignmentState,
  RoleSuitabilityStateSchema,
  type RoleSuitabilityState,
  type JobSearchPreferences,
  type ResumeApproach,
  type ResumeDraft,
  type ResumeDraftPatch,
  type ResumeTemplateDefinition,
  type ResumeValidationIssue,
  ResumeStrategyCoveragePolicySchema,
  ResumeStrategyEvidenceBoundariesSchema,
  ResumeStrategyHeadlinePolicySchema,
  ResumeStrategyRecommendationSourceSchema,
  ResumeStrategySkillsPolicySchema,
  ResumeTemplateIdSchema,
  TailoringModeSchema,
  type TailoringMode,
  type Tool,
  type ToolCall,
  type ModelContinuation,
} from "@nestor/contracts";
import { z } from "zod";
import {
  modelApiModes,
  modelReasoningEfforts,
  type ModelReasoningTask,
} from "./openai-compatible-transport";
import type { ModelStreamEvent } from "./model-request-transport";
import type {
  AdjudicateResumeImportCandidatesInput,
  ExtractResumeImportStageInput,
  ResumeImportAdjudicationResult,
  ResumeImportStageExtractionResult,
} from "./resume-import";

const NullableStringSchema = NonEmptyStringSchema.nullable().default(null);
const ResumeExtractionWorkModeSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.map((entry): unknown => entry);
  }

  return [];
}, WorkModeListSchema);

const ResumeExtractionProfessionalSummarySchema = z.object({
  shortValueProposition: NullableStringSchema,
  fullSummary: NullableStringSchema,
  careerThemes: z.array(NonEmptyStringSchema).default([]),
  leadershipSummary: NullableStringSchema,
  domainFocusSummary: NullableStringSchema,
  strengths: z.array(NonEmptyStringSchema).default([]),
});

const ResumeExtractionSkillGroupSchema = z.object({
  coreSkills: z.array(NonEmptyStringSchema).default([]),
  tools: z.array(NonEmptyStringSchema).default([]),
  languagesAndFrameworks: z.array(NonEmptyStringSchema).default([]),
  softSkills: z.array(NonEmptyStringSchema).default([]),
  highlightedSkills: z.array(NonEmptyStringSchema).default([]),
});

const ResumeExtractionExperienceSchema = z.object({
  companyName: NullableStringSchema,
  companyUrl: NullableStringSchema,
  title: NullableStringSchema,
  employmentType: NullableStringSchema,
  location: NullableStringSchema,
  workMode: ResumeExtractionWorkModeSchema,
  startDate: NullableStringSchema,
  endDate: NullableStringSchema,
  isCurrent: z.boolean().default(false),
  summary: NullableStringSchema,
  achievements: z.array(NonEmptyStringSchema).default([]),
  skills: z.array(NonEmptyStringSchema).default([]),
  domainTags: z.array(NonEmptyStringSchema).default([]),
  peopleManagementScope: NullableStringSchema,
  ownershipScope: NullableStringSchema,
});

const ResumeExtractionEducationSchema = z.object({
  schoolName: NullableStringSchema,
  degree: NullableStringSchema,
  fieldOfStudy: NullableStringSchema,
  location: NullableStringSchema,
  startDate: NullableStringSchema,
  endDate: NullableStringSchema,
  summary: NullableStringSchema,
});

const ResumeExtractionCertificationSchema = z.object({
  name: NullableStringSchema,
  issuer: NullableStringSchema,
  issueDate: NullableStringSchema,
  expiryDate: NullableStringSchema,
  credentialUrl: NullableStringSchema,
});

const ResumeExtractionLinkSchema = z.object({
  label: NullableStringSchema,
  url: NullableStringSchema,
  kind: z.enum(candidateLinkKindValues).nullable().default(null),
});

const ResumeExtractionProjectSchema = z.object({
  name: NullableStringSchema,
  projectType: NullableStringSchema,
  summary: NullableStringSchema,
  role: NullableStringSchema,
  skills: z.array(NonEmptyStringSchema).default([]),
  outcome: NullableStringSchema,
  projectUrl: NullableStringSchema,
  repositoryUrl: NullableStringSchema,
  caseStudyUrl: NullableStringSchema,
});

const ResumeExtractionLanguageSchema = z.object({
  language: NullableStringSchema,
  proficiency: NullableStringSchema,
  interviewPreference: z.boolean().default(false),
  notes: NullableStringSchema,
});

export const ResumeProfileExtractionSchema = z.object({
  firstName: NullableStringSchema,
  lastName: NullableStringSchema,
  middleName: NullableStringSchema,
  fullName: NullableStringSchema,
  headline: NullableStringSchema,
  summary: NullableStringSchema,
  currentLocation: NullableStringSchema,
  timeZone: NullableStringSchema,
  salaryCurrency: NullableStringSchema,
  yearsExperience: z.number().int().min(0).nullable().optional(),
  email: NullableStringSchema,
  phone: NullableStringSchema,
  portfolioUrl: NullableStringSchema,
  linkedinUrl: NullableStringSchema,
  githubUrl: NullableStringSchema,
  personalWebsiteUrl: NullableStringSchema,
  professionalSummary: ResumeExtractionProfessionalSummarySchema.default({}),
  skillGroups: ResumeExtractionSkillGroupSchema.default({}),
  skills: z.array(NonEmptyStringSchema).default([]),
  targetRoles: z.array(NonEmptyStringSchema).default([]),
  preferredLocations: z.array(NonEmptyStringSchema).default([]),
  experiences: z.array(ResumeExtractionExperienceSchema).default([]),
  education: z.array(ResumeExtractionEducationSchema).default([]),
  certifications: z.array(ResumeExtractionCertificationSchema).default([]),
  links: z.array(ResumeExtractionLinkSchema).default([]),
  projects: z.array(ResumeExtractionProjectSchema).default([]),
  spokenLanguages: z.array(ResumeExtractionLanguageSchema).default([]),
  analysisProviderKind: z.enum(["deterministic", "openai_compatible"]),
  analysisProviderLabel: NonEmptyStringSchema,
  notes: z.array(NonEmptyStringSchema).default([]),
});

export type ResumeProfileExtraction = z.infer<
  typeof ResumeProfileExtractionSchema
>;

export type {
  ResumeCareerFamilyFit,
  ResumeCoverageClassification,
  TailoredResumeCoverageMetadata,
};

export const TailoredResumeGenerationProvenanceSchema = z.object({
  method: z.enum(["ai", "deterministic"]),
  reason: AssetGenerationReasonSchema.nullable().default(null),
  detail: NullableStringSchema,
});
export type TailoredResumeGenerationProvenance = z.infer<
  typeof TailoredResumeGenerationProvenanceSchema
>;

export const TailoredResumeDraftSchema = z.object({
  languagePresentation: ResumeLanguageTranslationSchema.optional(),
  recommendedTemplateId: ResumeTemplateIdSchema.nullable().optional(),
  label: NullableStringSchema,
  // A candidate without a saved summary may omit it in a fallback.
  summary: z.string(),
  experienceHighlights: z.array(NonEmptyStringSchema).default([]),
  coreSkills: z.array(NonEmptyStringSchema).default([]),
  targetedKeywords: z.array(NonEmptyStringSchema).default([]),
  experienceEntries: z
    .array(
      z.object({
        title: NullableStringSchema,
        employer: NullableStringSchema,
        location: NullableStringSchema,
        dateRange: NullableStringSchema,
        summary: NullableStringSchema,
        bullets: z.array(NonEmptyStringSchema).default([]),
        bulletSourceAchievementIds: z
          .array(z.array(NonEmptyStringSchema))
          .optional(),
        profileRecordId: NullableStringSchema,
      }),
    )
    .default([]),
  projectEntries: z
    .array(
      z.object({
        name: NullableStringSchema,
        role: NullableStringSchema,
        summary: NullableStringSchema,
        outcome: NullableStringSchema,
        bullets: z.array(NonEmptyStringSchema).default([]),
        profileRecordId: NullableStringSchema,
      }),
    )
    .default([]),
  educationEntries: z
    .array(
      z.object({
        school: NullableStringSchema,
        degree: NullableStringSchema,
        fieldOfStudy: NullableStringSchema,
        location: NullableStringSchema,
        dateRange: NullableStringSchema,
        summary: NullableStringSchema,
        profileRecordId: NullableStringSchema,
      }),
    )
    .default([]),
  certificationEntries: z
    .array(
      z.object({
        name: NullableStringSchema,
        issuer: NullableStringSchema,
        dateRange: NullableStringSchema,
        profileRecordId: NullableStringSchema,
      }),
    )
    .default([]),
  coverageMetadata: z.array(TailoredResumeCoverageMetadataSchema).default([]),
  additionalSkills: z.array(NonEmptyStringSchema).default([]),
  languages: z.array(NonEmptyStringSchema).default([]),
  fullText: NonEmptyStringSchema,
  compatibilityScore: z.number().int().min(0).max(100).nullable(),
  generationQuality: z
    .object({
      strategy: z.enum(["deterministic", "evidence_linked"]),
      proposedRewriteCount: z.number().int().min(0),
      acceptedRewriteCount: z.number().int().min(0),
      rejectedRewriteCount: z.number().int().min(0),
      acceptedRewriteCharacters: z.number().int().min(0),
    })
    .optional(),
  /**
   * Structured provenance recorded by the boundary that chose the generation
   * path. Product code must read this instead of string-matching note prose.
   */
  generationProvenance: TailoredResumeGenerationProvenanceSchema.optional(),
  notes: z.array(NonEmptyStringSchema).default([]),
});

export type TailoredResumeDraft = z.infer<typeof TailoredResumeDraftSchema>;

/**
 * The resolved, enabled resume strategy that the generation boundary is
 * allowed to consume. Selection and recommendation provenance stay attached so
 * generated artifacts can explain which policy was used without granting any
 * approval or application authority.
 */
export const ResumeGenerationStrategyPolicySchema = z
  .object({
    strategyId: NonEmptyStringSchema,
    strategyName: NonEmptyStringSchema,
    roleFamily: NonEmptyStringSchema,
    baseResumeDocumentId: NonEmptyStringSchema,
    templateId: ResumeTemplateIdSchema,
    headlinePolicy: ResumeStrategyHeadlinePolicySchema,
    skillsPolicy: ResumeStrategySkillsPolicySchema,
    coveragePolicy: ResumeStrategyCoveragePolicySchema,
    tailoringStrength: TailoringModeSchema,
    evidenceBoundaries: ResumeStrategyEvidenceBoundariesSchema,
    effectiveSource: z.enum(["selection", "recommendation"]),
    effectiveReason: NonEmptyStringSchema,
    recommendationSource: ResumeStrategyRecommendationSourceSchema,
    recommendationReason: NonEmptyStringSchema.nullable().default(null),
    selectionSource: z
      .enum(["user", "campaign_default", "rule_match"])
      .nullable()
      .default(null),
    selectionReason: NonEmptyStringSchema.nullable().default(null),
  })
  .strict();
export type ResumeGenerationStrategyPolicy = z.infer<
  typeof ResumeGenerationStrategyPolicySchema
>;

export const JobFitAssessmentSchema = z.object({
  requirements: z.array(JobRequirementAssessmentSchema).max(40).optional(),
  score: z.number().int().min(0).max(100),
  reasons: z.array(NonEmptyStringSchema).default([]),
  gaps: z.array(NonEmptyStringSchema).default([]),
  // The model's verdict on the same terms as a search's batch judging. Older
  // replies and fakes without a recommendation remain review-only.
  recommendation: FitRecommendationSchema.optional().catch(undefined),
  role: RoleSuitabilityStateSchema.optional().catch(undefined),
  roleExplanation: NonEmptyStringSchema.max(320).optional().catch(undefined),
  preferences: PreferenceAlignmentStateSchema.optional().catch(undefined),
  preferencesExplanation: NonEmptyStringSchema.max(320)
    .optional()
    .catch(undefined),
  locationReach: MatchLocationReachSchema.optional().catch(undefined),
  listingClosed: z.boolean().optional().catch(undefined),
  listingClosedEvidence: NonEmptyStringSchema.max(240)
    .optional()
    .catch(undefined),
});

export type JobFitAssessment = z.infer<typeof JobFitAssessmentSchema>;

export const OpenAiCompatibleJobFinderAiClientOptionsSchema = z.object({
  apiKey: NonEmptyStringSchema,
  baseUrl: z.string().trim().url(),
  model: NonEmptyStringSchema,
  label: NonEmptyStringSchema.optional(),
  apiMode: z.enum(modelApiModes).optional(),
  reasoningEffort: z.enum(modelReasoningEfforts).optional(),
  /**
   * Effort for tool-calling work that names no task (resume import
   * sections, the profile and resume assistants, letters). Resume writing
   * keeps `reasoningEffort`.
   */
  agentReasoningEffort: z.enum(modelReasoningEfforts).optional(),
  /**
   * Effort per task (see `modelReasoningTasks`). A task without an entry
   * uses `agentReasoningEffort`; the writer and a full listing read use
   * `reasoningEffort`.
   */
  taskReasoningEfforts: z
    .object({
      resume_writer: z.enum(modelReasoningEfforts).optional(),
      listing_read: z.enum(modelReasoningEfforts).optional(),
      search: z.enum(modelReasoningEfforts).optional(),
      page_read: z.enum(modelReasoningEfforts).optional(),
      fit_batch: z.enum(modelReasoningEfforts).optional(),
      listing_screen: z.enum(modelReasoningEfforts).optional(),
      claim_check: z.enum(modelReasoningEfforts).optional(),
      apply: z.enum(modelReasoningEfforts).optional(),
    } satisfies Record<ModelReasoningTask, z.ZodTypeAny>)
    .optional(),
  contextWindowTokens: z.number().int().min(1_000).optional(),
  requestTimeoutMs: z.number().int().min(1_000).optional(),
  resumeExtractionTimeoutMs: z.number().int().min(1_000).optional(),
  /** Longest silence tolerated on a streamed request before it is retried. */
  idleTimeoutMs: z.number().int().min(1_000).optional(),
  /** Attempts per logical request, including the first. */
  maxAttempts: z.number().int().min(1).max(10).optional(),
  /** Stream responses (server-sent events) for liveness. Default true. */
  streaming: z.boolean().optional(),
  retryBaseDelayMs: z.number().int().min(0).optional(),
});

export interface ExtractProfileFromResumeInput {
  existingProfile: CandidateProfile;
  existingSearchPreferences: JobSearchPreferences;
  resumeText: string;
}

export interface TailorResumeInput {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  settings: JobFinderSettings;
  job: JobPosting;
  resumeText: string | null;
}

/** Invalid writer output can be repaired; provider and local execution failures cannot. */
export class ResumeProposalValidationError extends Error {
  override readonly name = "ResumeProposalValidationError";

  constructor(
    message: string,
    readonly issues: readonly AgentTaskValidationIssue[],
    readonly languageFields?: readonly { id: string; text: string }[],
  ) {
    super(message);
  }
}

export interface CreateResumeDraftInput extends TailorResumeInput {
  /** Trusted local PDF-slot queue wait only; rendering and AI validation still count. */
  getExcludedElapsedMs?: () => number;
  /** Workspace replacement/shutdown cancels obsolete writers; ordinary batch Stop does not. */
  signal?: AbortSignal;
  availableTemplates?: readonly ResumeTemplateDefinition[];
  selectedTemplateId?: string | null;
  templateSelectionLocked?: boolean;
  /** Null asks the writer to follow the actual listing language. */
  language?: string | null;
  languageFields?: Array<{ id: string; text: string }>;
  /** Pages the person's resume should fit on; the writer decides what to show. */
  targetPageCount?: number;
  renderPreview?: (input: {
    draft: TailoredResumeDraft;
    templateId: string;
    signal?: AbortSignal;
    getRemainingBudgetMs?: () => number;
  }) => Promise<{
    templateId: string;
    pageCount: number | null;
    /** Pages the person's resume should fit on; the writer aims for it. */
    targetPageCount?: number;
    warnings: readonly string[];
    fileName: string | null;
    requiredModelRepairs?: readonly ResumeValidationIssue[];
    personConfirmationCount?: number;
    languageFields?: Array<{ id: string; text: string }>;
  }>;
  strategy?: ResumeGenerationStrategyPolicy | null;
  evidence?: {
    summary: readonly string[];
    candidateSummary: readonly string[];
    experience: readonly string[];
    skills: readonly string[];
    keywords: readonly string[];
  };
  researchContext?: {
    companyNotes: readonly string[];
    domainVocabulary: readonly string[];
    priorityThemes: readonly string[];
  };
}

export const ResumeAssistantReplySchema = z.object({
  content: NonEmptyStringSchema,
  patches: z.array(ResumeDraftPatchSchema).default([]),
  executionReceipt: AgentTaskExecutionReceiptSchema.nullable().optional(),
});
export type ResumeAssistantReply = z.infer<typeof ResumeAssistantReplySchema>;

/** One earlier turn of the Resume Studio Assistant, as the model sees it. */
export interface ResumeAssistantConversationTurn {
  role: "user" | "assistant";
  content: string;
  /**
   * The changes this reply proposed and what became of them, so "do it",
   * "yes" or "the second one" can refer to them.
   */
  proposal: {
    status: "waiting_for_review" | "accepted" | "rejected";
    changes: readonly {
      patchId: string;
      operation: string;
      sectionId: string;
      entryId: string | null;
      bulletId: string | null;
      newText: string | null;
      applied: boolean | null;
    }[];
  } | null;
}

/**
 * The approval gate's verdict on a proposed set of changes, from the same
 * classifier that later decides whether the resume can be approved.
 */
export interface ResumeProposalCheckFinding {
  patchId: string | null;
  sectionId: string | null;
  entryId: string | null;
  bulletId: string | null;
  flaggedText: string | null;
  message: string;
  /**
   * `needs_confirmation`: a stretch past the saved evidence the person keeps
   * or removes under Lines to confirm after accepting. `unsupported`: the
   * saved evidence does not back the wording, so it blocks approval until the
   * person rewrites it or approves it as accurate.
   */
  kind: "needs_confirmation" | "unsupported";
}

export interface ResumeProposalCheckResult {
  /** A change that cannot be applied at all; nothing else was checked. */
  applyError: string | null;
  findings: readonly ResumeProposalCheckFinding[];
  /**
   * Changes that leave no visible trace once the resume is saved: the save
   * cleanup removes them (a skill that is neither in the saved profile nor in
   * the listing) or they change nothing.
   */
  droppedOnSave?: readonly { patchId: string; message: string }[];
}

export interface ReviseResumeDraftInput {
  draft: ResumeDraft;
  job: JobPosting;
  request: string;
  validationIssues?: readonly string[];
  /**
   * The last few turns of this job's Assistant thread, oldest first, not
   * counting `request`.
   */
  recentConversation?: readonly ResumeAssistantConversationTurn[];
  /**
   * Lines already on the draft that wait for the person's Keep or Remove
   * under Lines to confirm. Without them the Assistant told the person a
   * line on that list had "nothing to flag".
   */
  linesToConfirm?: readonly {
    text: string;
    sectionId: string;
    entryId: string | null;
    bulletId: string | null;
  }[];
  /**
   * Runs the approval gate over the draft that accepting these changes would
   * produce, so the agent can repair its proposal before it finishes.
   */
  checkProposal?: (
    patches: readonly ResumeDraftPatch[],
  ) => ResumeProposalCheckResult | Promise<ResumeProposalCheckResult>;
  /** Pages the current draft renders to, when known. */
  currentPageCount?: number | null;
  /**
   * Renders the draft these changes would produce to the application PDF and
   * returns its page count, so a request like "fit it on one page" can be
   * checked instead of guessed.
   */
  measurePages?: (
    patches: readonly ResumeDraftPatch[],
  ) => Promise<{ pageCount: number | null; targetPageCount: number }>;
  /** Templates the person can switch to in the studio, for plain answers. */
  availableTemplates?: readonly {
    id: string;
    label: string;
    density: "comfortable" | "balanced" | "compact";
  }[];
  /**
   * The job's effective tailoring strength when known. Model-backed review
   * and section-regeneration passes route through the aggressive model for
   * aggressive drafts so the whole lifecycle stays on one provider; when
   * absent the primary provider is used.
   */
  tailoringStrength?: TailoringMode | null;
  researchContext?: {
    companyNotes: readonly string[];
    domainVocabulary: readonly string[];
    priorityThemes: readonly string[];
  };
}

/** One earlier turn of the Profile chat, as the model sees it. */
export interface ReviseCandidateProfileConversationTurn {
  role: "user" | "assistant";
  content: string;
  proposals: readonly {
    summary: string;
    status: "applied" | "rejected" | "waiting_for_review";
  }[];
}

export interface ReviseCandidateProfileInput {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  context: ProfileCopilotContext;
  relevantReviewItems: readonly ProfileCopilotRelevantReviewItem[];
  request: string;
  conversationFacts?: readonly string[];
  /**
   * The last few turns of this conversation, oldest first, so "fix it" or
   * "do the second one" can refer to what was just said or proposed.
   */
  recentConversation?: readonly ReviseCandidateProfileConversationTurn[];
  /** The saved AI behavior for the Profile chat (Settings). */
  assistantBehavior?: AiProfileAssistantBehavior;
  /**
   * The resume level Settings shows for jobs shortlisted from now on,
   * including Original, which is not a search preference.
   */
  resumeApproach?: ResumeApproach;
}

/**
 * The Profile chat's saved behavior, as prompt sentences.
 *
 * Absent behavior means the product's original manner: propose the edits the
 * request implies and keep replies short. Each sentence changes what the
 * assistant volunteers or how long it talks, never what it may invent.
 */
export function describeProfileAssistantBehavior(
  behavior: AiProfileAssistantBehavior | undefined,
): string[] {
  const initiative = behavior?.initiative ?? "suggest";
  const replyStyle = behavior?.replyStyle ?? "brief";
  // A built-app check found Proactive and Only what I ask answering a small
  // request identically: the level sat among twenty tool rules and read as
  // optional, and "mention it in one clause" contradicted the rule that every
  // gap mentioned must be proposed or asked about. Each level now says what
  // to add, or that nothing may be added, in words the model cannot skip.
  return [
    initiative === "answer_only"
      ? "How much to volunteer (the person chose Only what I ask): do only what the person asked. Do not propose, mention, or ask about anything else, not even a gap you notice."
      : initiative === "proactive"
        ? "How much to volunteer (the person chose Proactive): do what the person asked, then look over the whole profile and add up to three further improvements, every time, even after a small request. Each is its own reviewable change with a one-line reason when the saved profile or resume supports it (a skill the resume names that the skills list lacks, vague wording, a missing summary), or one direct question when only the person knows the fact (a missing date or employer). An empty skills list is the first gap to raise, because matching and every resume lean on it: propose the skills the resume or work history names outright, and when it names none, ask which languages, tools and platforms they use."
        : "How much to volunteer (the person chose Suggest a little): do what the person asked, then add exactly one closely related improvement the saved profile or resume supports, as its own reviewable change with a one-line reason. If nothing related is supported, add nothing.",
    replyStyle === "conversational"
      ? "Reply in a conversational tone with the reasoning behind each change, a short paragraph at most."
      : "Reply briefly: one or two plain sentences that say what you prepared or what you found, with no preamble; each proposal card carries its own detail.",
  ];
}

/** User-facing Settings names that differ from stored preference values. */
export const PROFILE_RESUME_APPROACH_VOCABULARY = [
  "resumeApproach is the saved resume level for jobs shortlisted from now on (Settings > AI behavior > Resumes): original_resume is Original and sends the imported resume file exactly as it is, so nothing in it can be edited; conservative is Light, balanced is Tailored and aggressive is Aggressive, and each of those writes an editable resume for each job from the profile.",
  "To change the resume level, including onto or off Original, propose set_resume_approach with original_resume, conservative, balanced or aggressive (map the Settings names Light to conservative, Tailored to balanced, Aggressive to aggressive); never tell the person to change it in Settings. A job already on Shortlisted keeps the level it has.",
  "When resumeApproach is original_resume and the person asks to change the resume itself (its wording, length, layout or what it shows), say in one sentence that Original sends their imported file unchanged, and propose set_resume_approach conservative so Job Finder writes a resume they can edit. When the request also implies a profile change, put both in one propose_profile_operations call so a single Apply & save does both.",
].join(" ");

export interface AssessJobFitInput {
  signal?: AbortSignal;
  /**
   * A re-read nobody is waiting on (a search refreshing an older full read)
   * runs at the fit-check effort; one the person asked for keeps the main
   * effort.
   */
  background?: boolean;
  assessmentDate?: string;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  job: JobPosting;
}

/** One job's verdict from batch fit judging (ADR 0041). */
export interface JobFitJudgmentResult {
  jobId: string;
  score: number;
  recommendation: FitRecommendation;
  role: RoleSuitabilityState;
  roleExplanation: string | null;
  preferences: PreferenceAlignmentState;
  preferencesExplanation: string | null;
  locationReach: MatchLocationReach;
  reasons: string[];
  gaps: string[];
  /** The main reason for the recommendation, in one sentence. */
  summary?: string | null;
  listingClosed: boolean;
  listingClosedEvidence: string | null;
}

export interface JudgeJobFitsInput {
  signal?: AbortSignal;
  assessmentDate: string;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  /** At most one batch; callers split larger sets. */
  jobs: ReadonlyArray<{ jobId: string; posting: JobPosting }>;
}

/** Resume lines the model checks against the candidate's evidence. */
export interface ResumeClaimCheckInput {
  signal?: AbortSignal;
  /** Remaining writer budget for this nested validation call. */
  timeoutMs?: number;
  /** How far the person allowed the resume to stretch. */
  tailoringStrength: string;
  job: {
    title: string;
    company: string;
    description: string;
    /** The posting's duties and qualifications, as listed. */
    requirements?: ReadonlyArray<string>;
  };
  /** The candidate's evidence, each entry with an id the verdict can cite. */
  evidence: ReadonlyArray<{ id: string; text: string }>;
  resumeText: string | null;
  /** All visible lines, including other batches, for repetition and context. */
  resumeLines?: ReadonlyArray<{ section: string; text: string }>;
  /** At most one batch; callers split larger sets. */
  claims: ReadonlyArray<{ id: string; section: string; text: string }>;
}

export interface ResumeClaimCheckResult {
  id: string;
  verdict: "supported" | "stretch" | "unsupported";
  reason: string;
  evidenceIds: string[];
  /**
   * For a stretch or an unsupported line: the line rewritten to claim only
   * what the evidence backs, or "" when nothing in it can be kept. Null when
   * no fix was given.
   */
  fix: string | null;
  /**
   * A short note, addressed to the candidate, when the line is not finished
   * resume writing (a keyword list, a fragment, filler, first-person prose).
   */
  style?: string | null;
}

export interface ExtractJobsFromPageInput {
  pageText: string;
  pageUrl: string;
  pageType: "search_results" | "job_detail";
  maxJobs: number;
  selectionContext?: string;
  signal?: AbortSignal;
}

export const BrowserVisualAnalysisResultSchema =
  BrowserVisualObservationSetSchema;
export type BrowserVisualAnalysisResult = z.infer<
  typeof BrowserVisualAnalysisResultSchema
>;

export type { BrowserVisualAnalysisInput, BrowserVisualObservationSet };

export interface ExtractResumeImportStageTransportInput extends ExtractResumeImportStageInput {
  documentBundle: ResumeDocumentBundle;
}

export type { ModelContinuation } from "@nestor/contracts";

export interface ModelTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      continuation?: ModelContinuation;
    }
  | { role: "tool"; toolCallId: string; content: string };

export interface JobFinderAiClient {
  getStatus(): AgentProviderStatus;
  extractProfileFromResume(
    input: ExtractProfileFromResumeInput,
  ): Promise<ResumeProfileExtraction>;
  extractResumeImportStage(
    input: ExtractResumeImportStageTransportInput,
  ): Promise<ResumeImportStageExtractionResult>;
  adjudicateResumeImportCandidates?(
    input: AdjudicateResumeImportCandidatesInput,
  ): Promise<ResumeImportAdjudicationResult>;
  createResumeDraft(
    input: CreateResumeDraftInput,
  ): Promise<TailoredResumeDraft>;
  reviseResumeDraft(
    input: ReviseResumeDraftInput,
  ): Promise<ResumeAssistantReply>;
  reviseCandidateProfile(
    input: ReviseCandidateProfileInput,
  ): Promise<ProfileCopilotReply>;
  tailorResume(input: TailorResumeInput): Promise<TailoredResumeDraft>;
  assessJobFit(input: AssessJobFitInput): Promise<JobFitAssessment | null>;
  /**
   * Judges many jobs in one call. Absent on clients without a model; an
   * empty answer leaves those jobs unjudged.
   */
  judgeJobFits?(input: JudgeJobFitsInput): Promise<JobFitJudgmentResult[]>;
  /**
   * Checks resume lines against the candidate's evidence, many per call.
   * Absent on clients without a model; unchecked lines go to the person.
   */
  checkResumeClaims?(
    input: ResumeClaimCheckInput,
  ): Promise<ResumeClaimCheckResult[]>;
  extractJobsFromPage(input: ExtractJobsFromPageInput): Promise<JobPosting[]>;
  analyzeBrowserVisualSnapshot?(
    input: BrowserVisualAnalysisInput,
  ): Promise<BrowserVisualObservationSet>;
  chatWithTools?: AgentCapableJobFinderAiClient["chatWithTools"];
}

export interface ChatWithToolsOptions {
  signal?: AbortSignal;
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
  /** Which product conversation this turn continues; see model-request-identity. */
  conversationKey?: string;
  /** Normalized deltas while the answer streams (assistant sidebar). */
  onStreamEvent?: (event: ModelStreamEvent) => void;
  /** Which work this turn belongs to; picks its reasoning effort. */
  reasoningTask?: ModelReasoningTask;
}

export interface ChatWithToolsResult {
  content?: string;
  toolCalls?: ToolCall[];
  reasoning?: string;
  usage?: ModelTurnUsage;
  finishReason?: string;
  continuation?: ModelContinuation;
}

export interface AgentCapableJobFinderAiClient extends JobFinderAiClient {
  chatWithTools(
    messages: AgentMessage[],
    tools: Tool[],
    options?: ChatWithToolsOptions,
  ): Promise<ChatWithToolsResult>;
}

export type OpenAiCompatibleJobFinderAiClientOptions = z.infer<
  typeof OpenAiCompatibleJobFinderAiClientOptionsSchema
>;

export type StringMap = Record<string, string | undefined>;
