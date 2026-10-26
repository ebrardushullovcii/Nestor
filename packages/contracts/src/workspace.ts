import { z } from "zod";

import {
  AiProviderKindSchema,
  AppearanceThemeSchema,
  BrowserRunWaitReasonSchema,
  BrowserDriverSchema,
  BrowserSessionStatusSchema,
  DocumentFontPresetSchema,
  DocumentFormatSchema,
  IsoDateTimeSchema,
  JobSourceSchema,
  NonEmptyStringSchema,
  ResumeApplicationModeSchema,
  ResumeTemplateIdSchema,
  SourceDebugPhaseSchema,
  TailoringModeSchema,
} from "./base";
import { ApplicationCrmSettingsSchema } from "./application-crm";

import {
  ApplicationAttestationKindSchema,
  ApplicationApplyModeSchema,
  ApplicationSalaryDisclosureRuleSchema,
} from "./application-authority";
import type { ApplicationAttestationKind } from "./application-authority";

import {
  DiscoveryAdapterSessionStateSchema,
  JobSearchPreferencesSchema,
} from "./discovery";
import { CandidateProfileSchema } from "./profile";
import {
  ProfileSetupReviewActionOptionsSchema,
  ProfileSetupReviewActionSchema,
} from "./profile-setup";

import { ResumePreviewSchema } from "./resume";
import {
  EditableSourceInstructionArtifactSchema,
  SourceDebugRunRecordSchema,
} from "./source-debug";
import { ResumeTimelineRepairActionSchema } from "./resume-import";

export const JobFinderProfileSetupReviewActionInputSchema = z.object({
  reviewItemId: NonEmptyStringSchema,
  action: ProfileSetupReviewActionSchema,
  options: ProfileSetupReviewActionOptionsSchema.optional(),
});

export const JobFinderResumeTimelineRepairActionInputSchema = z.object({
  runId: NonEmptyStringSchema,
  proposalId: NonEmptyStringSchema,
  action: ResumeTimelineRepairActionSchema,
});

export const JobFinderUndoProfileRevisionInputSchema = z.object({
  revisionId: NonEmptyStringSchema,
});

export const JobFinderSourceDebugActionInputSchema = z.object({
  targetId: NonEmptyStringSchema,
});

export const JobFinderSourceDebugRunQuerySchema = z.object({
  runId: NonEmptyStringSchema,
});

export const JobFinderSourceInstructionActionInputSchema = z.object({
  targetId: NonEmptyStringSchema,
  instructionId: NonEmptyStringSchema,
});

export const JobFinderSaveSourceInstructionInputSchema = z.object({
  targetId: NonEmptyStringSchema,
  artifact: EditableSourceInstructionArtifactSchema,
});

export { JOB_FINDER_BROWSER_LABEL } from "./plain-values";

export const BrowserSessionStateSchema = z.object({
  source: JobSourceSchema,
  status: BrowserSessionStatusSchema,
  driver: BrowserDriverSchema.default("catalog_seed"),
  label: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.nullable(),
  lastCheckedAt: IsoDateTimeSchema,
});
export type BrowserSessionState = z.infer<typeof BrowserSessionStateSchema>;

export const AgentProviderStatusSchema = z.object({
  kind: AiProviderKindSchema,
  role: z.enum(["chat", "vision", "embedding", "stt"]).default("chat"),
  ready: z.boolean(),
  label: NonEmptyStringSchema,
  model: NonEmptyStringSchema.nullable().default(null),
  baseUrl: NonEmptyStringSchema.nullable().default(null),
  modelContextWindowTokens: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null),
  reservedHeadroomTokens: z.number().int().positive().nullable().default(null),
  requestTimeoutMs: z.number().int().positive().nullable().default(null),
  detail: NonEmptyStringSchema.nullable().default(null),
});
export type AgentProviderStatus = z.infer<typeof AgentProviderStatusSchema>;

export const ResumeTemplateDeliveryLaneSchema = z.enum([
  "apply_safe",
  "share_ready",
]);
export type ResumeTemplateDeliveryLane = z.infer<
  typeof ResumeTemplateDeliveryLaneSchema
>;

export const ResumeTemplateAtsConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
]);
export type ResumeTemplateAtsConfidence = z.infer<
  typeof ResumeTemplateAtsConfidenceSchema
>;

export const ResumeTemplateDefinitionSchema = z.object({
  id: ResumeTemplateIdSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  familyId: NonEmptyStringSchema.optional(),
  familyLabel: NonEmptyStringSchema.optional(),
  familyDescription: NonEmptyStringSchema.optional(),
  variantLabel: NonEmptyStringSchema.optional(),
  deliveryLane: ResumeTemplateDeliveryLaneSchema.optional(),
  atsConfidence: ResumeTemplateAtsConfidenceSchema.optional(),
  fitSummary: NonEmptyStringSchema.nullable().optional(),
  avoidSummary: NonEmptyStringSchema.nullable().optional(),
  bestFor: z.array(NonEmptyStringSchema).default([]),
  visualTags: z.array(NonEmptyStringSchema).optional(),
  density: z.enum(["comfortable", "balanced", "compact"]),
  applyEligible: z.boolean().optional(),
  approvalEligible: z.boolean().optional(),
  benchmarkEligible: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});
export type ResumeTemplateDefinition = z.infer<
  typeof ResumeTemplateDefinitionSchema
>;

export function getResumeTemplateFamilyId(
  template: Pick<ResumeTemplateDefinition, "familyId" | "id">,
): string {
  return template.familyId ?? template.id;
}

export function getResumeTemplateFamilyLabel(
  template: Pick<ResumeTemplateDefinition, "familyLabel" | "label">,
): string {
  return template.familyLabel ?? template.label;
}

export function getResumeTemplateVariantLabel(
  template: Pick<ResumeTemplateDefinition, "variantLabel" | "label">,
): string {
  return template.variantLabel ?? template.label;
}

export function getResumeTemplateVisualTags(
  template: Pick<ResumeTemplateDefinition, "visualTags" | "bestFor">,
): readonly string[] {
  return template.visualTags ?? template.bestFor;
}

export function getResumeTemplateDeliveryLane(
  template: Pick<ResumeTemplateDefinition, "deliveryLane">,
): ResumeTemplateDeliveryLane {
  return template.deliveryLane ?? "apply_safe";
}

export function getResumeTemplateAtsConfidence(
  template: Pick<ResumeTemplateDefinition, "atsConfidence">,
): ResumeTemplateAtsConfidence {
  return template.atsConfidence ?? "high";
}

export function isResumeTemplateApprovalEligible(
  template: Pick<ResumeTemplateDefinition, "approvalEligible" | "deliveryLane">,
): boolean {
  if (template.approvalEligible !== undefined) {
    return template.approvalEligible;
  }

  return getResumeTemplateDeliveryLane(template) === "apply_safe";
}

export function isResumeTemplateApplyEligible(
  template: Pick<
    ResumeTemplateDefinition,
    "applyEligible" | "approvalEligible" | "deliveryLane"
  >,
): boolean {
  if (template.applyEligible !== undefined) {
    return template.applyEligible;
  }

  return isResumeTemplateApprovalEligible(template);
}

/**
 * How a cover or motivation letter should read when Job Finder writes one.
 *
 * The defaults are the safe, unremarkable choice: plain professional, about a
 * page's worth, in whatever language the posting is written in. Everything
 * here shapes the writing; none of it adds a fact the resume and profile do
 * not already support.
 */
export const coverLetterToneValues = [
  "plain_professional",
  "warm",
  "direct",
  "formal",
] as const;
export const CoverLetterToneSchema = z.enum(coverLetterToneValues);
export type CoverLetterTone = z.infer<typeof CoverLetterToneSchema>;

export const coverLetterLengthValues = [
  "short",
  "standard",
  "detailed",
] as const;
export const CoverLetterLengthSchema = z.enum(coverLetterLengthValues);
export type CoverLetterLength = z.infer<typeof CoverLetterLengthSchema>;

export const CoverLetterPreferenceSchema = z
  .object({
    tone: CoverLetterToneSchema.default("plain_professional"),
    length: CoverLetterLengthSchema.default("standard"),
    /**
     * The language to write in. Null follows the posting, which is almost
     * always what the employer expects.
     */
    language: NonEmptyStringSchema.nullable().default(null),
    /**
     * A letter the person wrote themselves, kept only as an example of how
     * they sound. Its facts are never reused for another job.
     */
    sample: NonEmptyStringSchema.max(8_000).nullable().default(null),
  })
  .strict();
export type CoverLetterPreference = z.infer<typeof CoverLetterPreferenceSchema>;

/**
 * How the AI behaves on each surface, chosen by the person in one place.
 *
 * Every value here changes what the model is told, never what it is allowed
 * to do: the safety boundaries (ADR 0012, ADR 0022) and the resume grounding
 * gate (ADR 0018) are unchanged by any choice below. Defaults are the
 * behaviour the product had before the choices existed.
 */
export const profileAssistantInitiativeValues = [
  "answer_only",
  "suggest",
  "proactive",
] as const;
export const ProfileAssistantInitiativeSchema = z.enum(
  profileAssistantInitiativeValues,
);
export type ProfileAssistantInitiative = z.infer<
  typeof ProfileAssistantInitiativeSchema
>;

export const profileAssistantReplyStyleValues = [
  "brief",
  "conversational",
] as const;
export const ProfileAssistantReplyStyleSchema = z.enum(
  profileAssistantReplyStyleValues,
);
export type ProfileAssistantReplyStyle = z.infer<
  typeof ProfileAssistantReplyStyleSchema
>;

export const jobSearchSelectivityValues = [
  "best_matches",
  "balanced",
  "wide_net",
] as const;
export const JobSearchSelectivitySchema = z.enum(jobSearchSelectivityValues);

export const coverLetterPolicyValues = [
  "when_required",
  "when_possible",
  "never",
] as const;
export const CoverLetterPolicySchema = z.enum(coverLetterPolicyValues);
export type CoverLetterPolicy = z.infer<typeof CoverLetterPolicySchema>;

export const writtenAnswerLengthValues = ["short", "full"] as const;
export const WrittenAnswerLengthSchema = z.enum(writtenAnswerLengthValues);
export type WrittenAnswerLength = z.infer<typeof WrittenAnswerLengthSchema>;

export const AiProfileAssistantBehaviorSchema = z
  .object({
    /** How much the Profile chat volunteers beyond what was asked. */
    initiative: ProfileAssistantInitiativeSchema.default("suggest"),
    /** How long its replies run. */
    replyStyle: ProfileAssistantReplyStyleSchema.default("brief"),
  })
  .strict();
export type AiProfileAssistantBehavior = z.infer<
  typeof AiProfileAssistantBehaviorSchema
>;

export const AiJobSearchBehaviorSchema = z
  .object({
    /**
     * How picky a search is. `best_matches` also turns on the strict
     * collection filter (title, location, work mode must match); `wide_net`
     * runs the search in its broad mode.
     */
    selectivity: JobSearchSelectivitySchema.default("balanced"),
    /** Whether a remote posting counts as matching any preferred location. */
    remoteCountsAsAnyLocation: z.boolean().default(true),
  })
  .strict();
export type AiJobSearchBehavior = z.infer<typeof AiJobSearchBehaviorSchema>;

/**
 * The declarations Job Finder may tick for the person without asking each
 * time. The routine ones (the answers are true, the privacy notice, the
 * site's terms, consent to the employer's background check) are on by
 * default: an applicant has to accept them to be considered at all, and
 * leaving them for the person only turns every application into a stop.
 * Self-identification and marketing contact stay off until the person turns
 * them on: neither is needed to apply (ADR 0027).
 */
export const defaultPreApprovedDeclarations = [
  "truthfulness_certification",
  "privacy_notice_acknowledgement",
  "terms_acceptance",
  "background_check_consent",
] as const satisfies readonly ApplicationAttestationKind[];

export const AiApplyingBehaviorSchema = z
  .object({
    /** When the apply agent writes a cover or motivation letter. */
    coverLetterPolicy: CoverLetterPolicySchema.default("when_required"),
    /** How long the answers it writes for open questions run. */
    writtenAnswerLength: WrittenAnswerLengthSchema.default("short"),
    /** Declaration kinds the run may tick for the person (ADR 0027). */
    preApprovedDeclarations: z
      .array(ApplicationAttestationKindSchema)
      .default([...defaultPreApprovedDeclarations]),
  })
  .strict();
export type AiApplyingBehavior = z.infer<typeof AiApplyingBehaviorSchema>;

export const AiBehaviorPreferenceSchema = z
  .object({
    profileAssistant: AiProfileAssistantBehaviorSchema.default({}),
    jobSearch: AiJobSearchBehaviorSchema.default({}),
    applying: AiApplyingBehaviorSchema.default({}),
  })
  .strict();

export const JobFinderSettingsSchema = z.object({
  resumeFormat: DocumentFormatSchema,
  resumeTemplateId: ResumeTemplateIdSchema,
  fontPreset: DocumentFontPresetSchema,
  appearanceTheme: AppearanceThemeSchema.default("system"),
  /**
   * Fold the left side menu to icons while the assistant sidebar is docked,
   * so the page keeps room. Absent means on (older workspaces never stored
   * it): read it through `collapsesSideMenuWithAssistant`.
   */
  collapseSideMenuWithAssistant: z.boolean().optional(),
  /**
   * Start writing a job's resume as soon as it is shortlisted (ADR 0076).
   * Absent means on: read it through `writesResumesOnShortlist`.
   */
  writeResumesOnShortlist: z.boolean().optional(),
  humanReviewRequired: z.boolean(),
  allowAutoSubmitOverride: z.boolean(),
  /** Fill and leave for the person's click, or send for them. */
  applicationAutomationMode: ApplicationApplyModeSchema.optional(),
  salaryDisclosure: ApplicationSalaryDisclosureRuleSchema.optional(),
  keepSessionAlive: z.boolean(),
  discoveryOnly: z.boolean().default(false),
  resumeApplicationMode: ResumeApplicationModeSchema.optional(),
  applicationCrm: ApplicationCrmSettingsSchema.default({}).optional(),
  // Optional so a workspace saved before letters existed still loads; every
  // read goes through the schema default.
  coverLetter: CoverLetterPreferenceSchema.default({}).optional(),
  // Same reason: absent on older workspaces, defaulted on every read.
  aiBehavior: AiBehaviorPreferenceSchema.default({}).optional(),
});
export type JobFinderSettings = z.infer<typeof JobFinderSettingsSchema>;

/** On unless the person turned it off. */
export function writesResumesOnShortlist(
  settings: Pick<JobFinderSettings, "writeResumesOnShortlist">,
): boolean {
  return settings.writeResumesOnShortlist !== false;
}

export { collapsesSideMenuWithAssistant } from "./plain-values";

export const JobFinderDiscoveryStateSchema = z.object({
  sessions: z.array(DiscoveryAdapterSessionStateSchema).default([]),
  activeSourceDebugRun: SourceDebugRunRecordSchema.nullable().default(null),
  recentSourceDebugRuns: z.array(SourceDebugRunRecordSchema).default([]),
});
export type JobFinderDiscoveryState = z.infer<
  typeof JobFinderDiscoveryStateSchema
>;

export const JobFinderResumePreviewSchema = ResumePreviewSchema;
export type JobFinderResumePreview = z.infer<
  typeof JobFinderResumePreviewSchema
>;

export const SaveJobFinderWorkspaceInputSchema = z.object({
  profile: CandidateProfileSchema,
  searchPreferences: JobSearchPreferencesSchema,
  settings: JobFinderSettingsSchema.optional(),
});

export const UpdateApplicationDefaultsInputSchema = z.object({
  resumeApplicationMode: ResumeApplicationModeSchema.optional(),
  resumeTemplateId: ResumeTemplateIdSchema.optional(),
  fontPreset: DocumentFontPresetSchema.optional(),
  /** How a letter Job Finder writes should read. */
  coverLetter: CoverLetterPreferenceSchema.optional(),
  applicationAutomationMode: ApplicationApplyModeSchema.optional(),
  salaryDisclosure: ApplicationSalaryDisclosureRuleSchema.optional(),
});
export type UpdateApplicationDefaultsInput = z.infer<
  typeof UpdateApplicationDefaultsInputSchema
>;

export const UpdateWorkspaceBehaviorInputSchema = z.object({
  keepSessionAlive: z.boolean().optional(),
  discoveryOnly: z.boolean().optional(),
  collapseSideMenuWithAssistant: z.boolean().optional(),
  writeResumesOnShortlist: z.boolean().optional(),
});
export type UpdateWorkspaceBehaviorInput = z.infer<
  typeof UpdateWorkspaceBehaviorInputSchema
>;

/**
 * Everything the AI behavior section of Settings saves in one action, plus
 * the resume level saved from Profile.
 *
 * `resumeApproach` is the person's one four-way choice: keep the imported
 * file, or tailor at one of three strengths. It writes two stored fields
 * (`settings.resumeApplicationMode` and `searchPreferences.tailoringMode`)
 * that older surfaces edited separately.
 */
export const ResumeApproachSchema = z.union([
  z.literal("original_resume"),
  TailoringModeSchema,
]);
export type ResumeApproach = z.infer<typeof ResumeApproachSchema>;

export const UpdateAiBehaviorInputSchema = z.object({
  aiBehavior: z
    .object({
      profileAssistant: AiProfileAssistantBehaviorSchema.partial().optional(),
      jobSearch: AiJobSearchBehaviorSchema.partial().optional(),
      applying: AiApplyingBehaviorSchema.partial().optional(),
    })
    .strict()
    .optional(),
  coverLetter: CoverLetterPreferenceSchema.partial().optional(),
  resumeApproach: ResumeApproachSchema.optional(),
});
export type UpdateAiBehaviorInput = z.infer<typeof UpdateAiBehaviorInputSchema>;

export const DesktopPlatformPingSchema = z.object({
  ok: z.literal(true),
  platform: z.enum(["darwin", "win32", "linux"]),
});
export type DesktopPlatformPing = z.infer<typeof DesktopPlatformPingSchema>;

/**
 * Renderer-owned close protection state mirrored to the main process. The
 * renderer stays the single owner of dirty Profile/setup/Resume Studio state;
 * main only caches this flag so a native window close can be paused and
 * confirmed through the app-owned dialog instead of discarding drafts.
 */
export const DesktopWindowCloseGuardStateSchema = z.object({
  blocked: z.boolean(),
});
export type DesktopWindowCloseGuardState = z.infer<
  typeof DesktopWindowCloseGuardStateSchema
>;

/**
 * A right-click menu the window asks main to show as the system's own menu.
 * Main answers with the chosen item's id, or null when it was dismissed.
 */
export const DesktopContextMenuItemSchema = z.union([
  z
    .object({
      id: z.string().trim().min(1).max(80),
      label: z.string().trim().min(1).max(120),
      enabled: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("separator") }).strict(),
]);

export const DesktopContextMenuInputSchema = z
  .object({ items: z.array(DesktopContextMenuItemSchema).min(1).max(24) })
  .strict();
export type DesktopContextMenuInput = z.infer<
  typeof DesktopContextMenuInputSchema
>;

export const DesktopContextMenuResultSchema = z
  .object({ id: z.string().nullable() })
  .strict();
export type DesktopContextMenuResult = z.infer<
  typeof DesktopContextMenuResultSchema
>;

/**
 * Main-to-renderer request pushed after a native close was paused. The
 * renderer answers through `DesktopWindowCloseResolution`; an unanswered
 * request is bounded by a main-process watchdog instead of blocking forever.
 */
export const DesktopWindowCloseRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
});
export type DesktopWindowCloseRequest = z.infer<
  typeof DesktopWindowCloseRequestSchema
>;

export const DesktopWindowCloseDecisionSchema = z.enum(["proceed", "cancel"]);

export const DesktopWindowCloseResolutionSchema = z.object({
  requestId: NonEmptyStringSchema,
  decision: DesktopWindowCloseDecisionSchema,
});
export type DesktopWindowCloseResolution = z.infer<
  typeof DesktopWindowCloseResolutionSchema
>;

export const DesktopWindowControlsStateSchema = z.object({
  isFullScreen: z.boolean(),
  isMaximized: z.boolean(),
  isMinimizable: z.boolean(),
  isClosable: z.boolean(),
});
export type DesktopWindowControlsState = z.infer<
  typeof DesktopWindowControlsStateSchema
>;

export const AgentDiscoveryProgressSchema = z.object({
  currentUrl: z.string().min(1),
  jobsFound: z.number().int().nonnegative(),
  stepCount: z.number().int().nonnegative(),
  completedUnits: z.number().int().nonnegative().nullable().optional(),
  totalUnits: z.number().int().positive().nullable().optional(),
  progressLabel: NonEmptyStringSchema.nullable().optional(),
  currentAction: z.string().optional(),
  message: NonEmptyStringSchema.nullable().optional(),
  waitReason: BrowserRunWaitReasonSchema.nullable().optional(),
  phase: SourceDebugPhaseSchema.nullable().optional(),
  elapsedMs: z.number().nonnegative().optional(),
  lastActivityAt: IsoDateTimeSchema.nullable().optional(),
  targetId: NonEmptyStringSchema.nullable().default(null),
  adapterKind: JobSourceSchema.nullable().default(null),
});
export type AgentDiscoveryProgress = z.infer<
  typeof AgentDiscoveryProgressSchema
>;

export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Private model state retained only across turns on its originating route. */
export interface ModelContinuation {
  kind: "reasoning_content";
  route: string;
  text: string;
}
