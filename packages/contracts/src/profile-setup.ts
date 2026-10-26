import { z } from "zod";

import { IsoDateTimeSchema, NonEmptyStringSchema } from "./base";
import { type JobSearchPreferences } from "./discovery";
import { CandidateProfileSchema, type CandidateProfile } from "./profile";

export const profileSetupStepValues = [
  "import",
  "essentials",
  "background",
  "targeting",
  "extras",
  // Retired step ids. They stay in the enum so an existing workspace still
  // parses; `normalizeProfileSetupStep` maps every stored value onto one of
  // the five visible steps above at parse time.
  "narrative",
  "answers",
  "ready_check",
] as const;
export const ProfileSetupStepSchema = z.enum(profileSetupStepValues);
export type ProfileSetupStep = z.infer<typeof ProfileSetupStepSchema>;

/**
 * The five steps guided setup actually shows, in order. "Your story" and
 * "Screener answers" merged into one optional "Extras" step, and the old
 * "Ready check" step became the finish action on Job targets.
 */
export const profileSetupVisibleStepValues = [
  "import",
  "essentials",
  "background",
  "targeting",
  "extras",
] as const;
export type ProfileSetupVisibleStep =
  (typeof profileSetupVisibleStepValues)[number];

/**
 * Maps any stored step id — including the retired `narrative`, `answers`, and
 * `ready_check` values — onto the visible step that now owns its content.
 * This is the single migration point for persisted `currentStep` values and
 * for review items recorded against a retired step.
 */
export function normalizeProfileSetupStep(
  step: ProfileSetupStep,
): ProfileSetupVisibleStep {
  switch (step) {
    case "narrative":
    case "answers":
      return "extras";
    case "ready_check":
      // Finishing setup now happens on Job targets, so a workspace parked on
      // the old summary screen resumes at the step that owns the finish
      // action instead of a step that no longer exists.
      return "targeting";
    default:
      return step;
  }
}

const CanonicalProfileSetupStepSchema = ProfileSetupStepSchema.transform(
  (step): ProfileSetupStep => normalizeProfileSetupStep(step),
);

const profileSetupStepOrder = new Map(
  profileSetupVisibleStepValues.map((step, index) => [step, index]),
);

export const ProfileSetupStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "completed",
]);
export type ProfileSetupStatus = z.infer<typeof ProfileSetupStatusSchema>;

export const ProfileReviewItemStatusSchema = z.enum([
  "pending",
  "confirmed",
  "edited",
  "dismissed",
]);
export type ProfileReviewItemStatus = z.infer<
  typeof ProfileReviewItemStatusSchema
>;

export const ProfileReviewItemSeveritySchema = z.enum([
  "critical",
  "recommended",
  "optional",
]);
export type ProfileReviewItemSeverity = z.infer<
  typeof ProfileReviewItemSeveritySchema
>;

export const profileReviewTargetDomainValues = [
  "identity",
  "application_identity",
  "work_eligibility",
  "professional_summary",
  "search_preferences",
  "experience",
  "education",
  "certification",
  "project",
  "link",
  "language",
  "narrative",
  "proof_point",
  "answer_bank",
] as const;
export const ProfileReviewTargetDomainSchema = z.enum(
  profileReviewTargetDomainValues,
);
export type ProfileReviewTargetDomain = z.infer<
  typeof ProfileReviewTargetDomainSchema
>;

export const ProfileReviewTargetSchema = z.object({
  domain: ProfileReviewTargetDomainSchema,
  key: NonEmptyStringSchema,
  recordId: NonEmptyStringSchema.nullable().default(null),
});
export type ProfileReviewTarget = z.infer<typeof ProfileReviewTargetSchema>;

export const ProfileReviewItemSchema = z.object({
  id: NonEmptyStringSchema,
  step: CanonicalProfileSetupStepSchema,
  target: ProfileReviewTargetSchema,
  label: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
  severity: ProfileReviewItemSeveritySchema,
  status: ProfileReviewItemStatusSchema,
  proposedValue: NonEmptyStringSchema.nullable().default(null),
  sourceSnippet: NonEmptyStringSchema.nullable().default(null),
  sourceCandidateId: NonEmptyStringSchema.nullable().default(null),
  sourceRunId: NonEmptyStringSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable().default(null),
});
export type ProfileReviewItem = z.infer<typeof ProfileReviewItemSchema>;

export const profileSetupReviewActionValues = [
  "confirm",
  "dismiss",
  "clear_value",
] as const;
export const ProfileSetupReviewActionSchema = z.enum(
  profileSetupReviewActionValues,
);
export type ProfileSetupReviewAction = z.infer<
  typeof ProfileSetupReviewActionSchema
>;

export const ProfileSetupReviewActionOptionsSchema = z
  .object({
    selectedConflictChoiceId: NonEmptyStringSchema.optional(),
  })
  .default({});
export type ProfileSetupReviewActionOptions = z.infer<
  typeof ProfileSetupReviewActionOptionsSchema
>;

export const ProfileSetupStateSchema = z.object({
  status: ProfileSetupStatusSchema.default("not_started"),
  currentStep: CanonicalProfileSetupStepSchema.default("import"),
  completedAt: IsoDateTimeSchema.nullable().default(null),
  reviewItems: z.array(ProfileReviewItemSchema).default([]),
  reviewedSteps: z.array(CanonicalProfileSetupStepSchema).optional(),
  lastResumedAt: IsoDateTimeSchema.nullable().default(null),
});
export type ProfileSetupState = z.infer<typeof ProfileSetupStateSchema>;

export interface ProfileSetupReadiness {
  freshStart: boolean;
  hasContactPath: boolean;
  hasCoreIdentity: boolean;
  hasDiscoverySource: boolean;
  hasEligibilityPreferences: boolean;
  hasMeaningfulBackground: boolean;
  hasNarrative: boolean;
  hasResumeText: boolean;
  hasTargeting: boolean;
  /**
   * Both reusable answers application forms ask for: where the person may
   * work, and whether they need visa sponsorship. Setup collects them so the
   * first application never stops on them.
   */
  hasWorkEligibilityAnswers: boolean;
  hasWorkModePreference: boolean;
  materiallyComplete: boolean;
  recommendedStep: ProfileSetupStep;
  started: boolean;
}

/** Canonical setup blockers, ordered by the step that resolves them. */
export const profileSetupReadinessBlockerValues = [
  "identity_contact",
  "background",
  "eligibility_preferences",
  "work_mode_preference",
  "discovery_source",
  "work_eligibility_answers",
] as const;
export type ProfileSetupReadinessBlockerId =
  (typeof profileSetupReadinessBlockerValues)[number];

export interface ProfileSetupReadinessBlocker {
  id: ProfileSetupReadinessBlockerId;
  step: ProfileSetupStep;
}

const PROFILE_SETUP_READINESS_BLOCKER_STEPS: Record<
  ProfileSetupReadinessBlockerId,
  ProfileSetupStep
> = {
  background: "background",
  discovery_source: "targeting",
  eligibility_preferences: "targeting",
  identity_contact: "essentials",
  work_mode_preference: "targeting",
  work_eligibility_answers: "targeting",
};

/**
 * The single canonical blocker list for first-run readiness. Every readiness
 * surface (setup summary cards, ready check, and derived setup state) must
 * derive its "ready" claim from this list so no surface can report ready
 * while a blocker remains.
 */
export function getProfileSetupReadinessBlockers(
  readiness: Pick<
    ProfileSetupReadiness,
    | "hasCoreIdentity"
    | "hasContactPath"
    | "hasMeaningfulBackground"
    | "hasEligibilityPreferences"
    | "hasWorkModePreference"
    | "hasDiscoverySource"
    | "hasWorkEligibilityAnswers"
  >,
): ProfileSetupReadinessBlocker[] {
  const blockers: ProfileSetupReadinessBlocker[] = [];

  if (!readiness.hasCoreIdentity || !readiness.hasContactPath) {
    blockers.push({
      id: "identity_contact",
      step: PROFILE_SETUP_READINESS_BLOCKER_STEPS.identity_contact,
    });
  }
  // Work history, eligibility and work mode are no longer blockers; the
  // ids stay in the type for older persisted states.
  if (!readiness.hasDiscoverySource) {
    blockers.push({
      id: "discovery_source",
      step: PROFILE_SETUP_READINESS_BLOCKER_STEPS.discovery_source,
    });
  }
  // Almost every application form asks both. Without them the first
  // application stopped on "Are you authorized to work here?" and sent the
  // person to Profile to answer what setup never asked.
  if (!readiness.hasWorkEligibilityAnswers) {
    blockers.push({
      id: "work_eligibility_answers",
      step: PROFILE_SETUP_READINESS_BLOCKER_STEPS.work_eligibility_answers,
    });
  }

  return blockers;
}

/**
 * The first guided-setup step that still needs the person: the step of the
 * earliest canonical blocker or critical review item. When nothing blocks,
 * Job targets, which owns Finish. Optional and recommended suggestions never
 * choose the step, so an import lands where there is something to do rather
 * than on a step whose only content is an optional hint.
 */
export function getProfileSetupLandingStep(
  readiness: Parameters<typeof getProfileSetupReadinessBlockers>[0] &
    Pick<ProfileSetupReadiness, "hasResumeText">,
  reviewItems: readonly ProfileReviewItem[],
): ProfileSetupVisibleStep {
  if (!readiness.hasResumeText && !readiness.hasCoreIdentity) {
    return "import";
  }
  const candidateSteps = [
    ...getProfileSetupReadinessBlockers(readiness).map((blocker) =>
      normalizeProfileSetupStep(blocker.step),
    ),
    ...reviewItems
      .filter(isProfileSetupFinishBlockingReviewItem)
      .map((item) => normalizeProfileSetupStep(item.step)),
  ];
  let landing: ProfileSetupVisibleStep | null = null;
  for (const step of candidateSteps) {
    if (
      landing === null ||
      (profileSetupStepOrder.get(step) ?? Number.MAX_SAFE_INTEGER) <
        (profileSetupStepOrder.get(landing) ?? Number.MAX_SAFE_INTEGER)
    ) {
      landing = step;
    }
  }
  return landing ?? "targeting";
}

export interface DeriveProfileSetupStateOptions {
  enabledSiteCount?: number;
  currentState?: ProfileSetupState | null;
  /** At least one search attempt is recorded for this workspace. */
  hasRunSearch?: boolean;
  now?: string | null;
}

const FRESH_START_DISPLAY_NAME = "new candidate";
const FRESH_START_FIRST_NAME = "new";
export const PROFILE_SETUP_PLACEHOLDER_HEADLINE = "Import your resume to begin";
export const PROFILE_SETUP_PLACEHOLDER_LOCATION = "Set your preferred location";
export const PROFILE_SETUP_PLACEHOLDER_SUMMARY =
  "Import a resume or paste resume text to build your profile, targeting, and tailored documents.";
const FRESH_START_HEADLINE = PROFILE_SETUP_PLACEHOLDER_HEADLINE.toLowerCase();
const FRESH_START_LAST_NAME = "candidate";
const FRESH_START_LOCATION = PROFILE_SETUP_PLACEHOLDER_LOCATION.toLowerCase();
const FRESH_START_SUMMARY = PROFILE_SETUP_PLACEHOLDER_SUMMARY.toLowerCase();

export type ProfileSetupPlaceholderField =
  | "fullName"
  | "headline"
  | "currentLocation"
  | "summary";

export const FRESH_START_CANDIDATE_PROFILE_ID = "candidate_fresh_start";
const FRESH_START_RESUME_ID = "resume_fresh_start";

/**
 * Canonical first-run profile seed. Factual identity fields stay null so no
 * instructional placeholder string is ever persisted as a candidate fact;
 * surfaces render their own placeholders for the missing values.
 */
export function createFreshStartCandidateProfile(): CandidateProfile {
  return CandidateProfileSchema.parse({
    id: FRESH_START_CANDIDATE_PROFILE_ID,
    baseResume: {
      id: FRESH_START_RESUME_ID,
      fileName: "No resume imported yet",
      uploadedAt: new Date(0).toISOString(),
      extractionStatus: "needs_text",
    },
    yearsExperience: null,
  });
}

function normalizeProfileSetupPlaceholderValue(
  value: string | null | undefined,
): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * True only when a stored identity string is one of the instructional
 * first-run placeholder strings. Legacy workspaces that already persisted
 * these strings keep parsing, but no readiness signal treats them as facts.
 */
export function hasProfileSetupPlaceholderValue(
  field: ProfileSetupPlaceholderField,
  value: string | null | undefined,
): boolean {
  const normalized = normalizeProfileSetupPlaceholderValue(value);

  switch (field) {
    case "fullName":
      return normalized === FRESH_START_DISPLAY_NAME;
    case "headline":
      return normalized === FRESH_START_HEADLINE;
    case "currentLocation":
      return normalized === FRESH_START_LOCATION;
    case "summary":
      return normalized === FRESH_START_SUMMARY;
  }
}

/**
 * Only critical items gate completion. Recommended items, whether an imported
 * suggestion or a field the resume left empty (location, years of
 * experience, work eligibility), stay optional to review: finishing needs a
 * name, a contact path, and a job source, and a person with those should be
 * searching rather than answering a questionnaire (ADR 0024). The guided
 * setup footer applies the same rule, so Finish is never offered and then
 * refused.
 */
export function isProfileSetupFinishBlockingReviewItem(
  item: ProfileReviewItem,
): boolean {
  return item.status === "pending" && item.severity === "critical";
}

function hasBlockingPendingReviewItems(
  reviewItems: readonly ProfileReviewItem[],
): boolean {
  return reviewItems.some(isProfileSetupFinishBlockingReviewItem);
}

function hasMeaningfulText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasMeaningfulStringList(
  values: readonly string[] | null | undefined,
): boolean {
  return (
    Array.isArray(values) &&
    values.some(
      (value) => typeof value === "string" && hasMeaningfulText(value),
    )
  );
}

function hasMeaningfulExperience(profile: CandidateProfile): boolean {
  return profile.experiences.some((experience) =>
    Boolean(
      hasMeaningfulText(experience.companyName) ||
      hasMeaningfulText(experience.title) ||
      hasMeaningfulText(experience.summary) ||
      hasMeaningfulStringList(experience.achievements) ||
      hasMeaningfulStringList(experience.skills),
    ),
  );
}

function hasMeaningfulProject(profile: CandidateProfile): boolean {
  return profile.projects.some((project) =>
    Boolean(
      hasMeaningfulText(project.name) ||
      hasMeaningfulText(project.summary) ||
      hasMeaningfulText(project.role) ||
      hasMeaningfulText(project.outcome) ||
      hasMeaningfulStringList(project.skills),
    ),
  );
}

function hasMeaningfulNarrative(profile: CandidateProfile): boolean {
  return Boolean(
    hasMeaningfulText(profile.professionalSummary.shortValueProposition) ||
    hasMeaningfulText(profile.professionalSummary.fullSummary) ||
    hasMeaningfulStringList(profile.professionalSummary.careerThemes) ||
    hasMeaningfulText(profile.professionalSummary.leadershipSummary) ||
    hasMeaningfulText(profile.professionalSummary.domainFocusSummary) ||
    hasMeaningfulStringList(profile.professionalSummary.strengths) ||
    hasMeaningfulText(profile.narrative.professionalStory) ||
    hasMeaningfulText(profile.narrative.nextChapterSummary) ||
    hasMeaningfulText(profile.narrative.careerTransitionSummary) ||
    hasMeaningfulStringList(profile.narrative.differentiators) ||
    hasMeaningfulStringList(profile.narrative.motivationThemes) ||
    profile.proofBank.length > 0,
  );
}

/**
 * True when this profile is still the untouched first-run seed, detected by
 * the reserved fresh-start id or by the exact legacy placeholder identity
 * values that older seeds persisted.
 */
export function isFreshStartCandidateProfile(
  profile: CandidateProfile,
): boolean {
  if (profile.id === FRESH_START_CANDIDATE_PROFILE_ID) {
    return true;
  }

  const normalizedFullName = profile.fullName?.trim().toLowerCase() ?? "";
  const normalizedFirstName = profile.firstName?.trim().toLowerCase() ?? "";
  const normalizedLastName = profile.lastName?.trim().toLowerCase() ?? "";

  return (
    normalizedFullName === FRESH_START_DISPLAY_NAME &&
    normalizedFirstName === FRESH_START_FIRST_NAME &&
    normalizedLastName === FRESH_START_LAST_NAME &&
    hasProfileSetupPlaceholderValue("headline", profile.headline) &&
    hasProfileSetupPlaceholderValue("currentLocation", profile.currentLocation)
  );
}

export function evaluateProfileSetupReadiness(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  enabledSiteCount?: number,
): ProfileSetupReadiness {
  const freshStart = isFreshStartCandidateProfile(profile);
  const hasResumeText = hasMeaningfulText(profile.baseResume.textContent);
  // Identity is the name. Headline and location have their own review items
  // and their own labels; folding them in here produced a footer that said
  // "add your name and an email" to people who had typed both.
  const hasRealIdentityText = hasMeaningfulText(profile.fullName);
  // Placeholder strings left over from legacy first-run seeds are not facts.
  const hasPlaceholderOnlyIdentity = Boolean(
    (profile.fullName === null ||
      hasProfileSetupPlaceholderValue("fullName", profile.fullName)) &&
    (profile.headline === null ||
      hasProfileSetupPlaceholderValue("headline", profile.headline)) &&
    (profile.currentLocation === null ||
      hasProfileSetupPlaceholderValue(
        "currentLocation",
        profile.currentLocation,
      )),
  );
  // Years of experience is not part of identity: a first-jobber with zero
  // years was told to "complete your essentials" with no way to find out
  // that a 0 was the reason.
  const hasCoreIdentity = Boolean(
    hasRealIdentityText && (!freshStart || !hasPlaceholderOnlyIdentity),
  );

  const hasContactPath = Boolean(
    hasMeaningfulText(profile.email) || hasMeaningfulText(profile.phone),
  );
  const hasMeaningfulBackground =
    hasMeaningfulExperience(profile) || hasMeaningfulProject(profile);
  const hasTargeting = Boolean(
    hasMeaningfulStringList(searchPreferences.targetRoles) ||
    hasMeaningfulStringList(searchPreferences.jobFamilies) ||
    hasMeaningfulStringList(profile.targetRoles) ||
    hasMeaningfulBackground,
  );
  const hasDiscoverySource = (enabledSiteCount ?? 0) > 0;
  const hasEligibilityPreferences = Boolean(
    hasMeaningfulStringList(profile.workEligibility.authorizedWorkCountries) ||
    profile.workEligibility.requiresVisaSponsorship !== null ||
    profile.workEligibility.willingToRelocate !== null ||
    hasMeaningfulStringList(
      profile.workEligibility.preferredRelocationRegions,
    ) ||
    profile.workEligibility.willingToTravel !== null ||
    profile.workEligibility.remoteEligible !== null ||
    profile.workEligibility.noticePeriodDays !== null ||
    hasMeaningfulText(profile.workEligibility.availableStartDate) ||
    hasMeaningfulText(profile.workEligibility.securityClearance) ||
    hasMeaningfulStringList(searchPreferences.locations) ||
    hasMeaningfulStringList(searchPreferences.workModes),
  );
  const hasWorkModePreference = hasMeaningfulStringList(
    searchPreferences.workModes,
  );
  const hasWorkEligibilityAnswers =
    hasMeaningfulStringList(profile.workEligibility.authorizedWorkCountries) &&
    profile.workEligibility.requiresVisaSponsorship !== null;
  const hasNarrative = hasMeaningfulNarrative(profile);
  // Finishing needs a name, one way to be contacted, and one place to look.
  // Work history, targeting, eligibility and work mode improve results and
  // stay visible as hints, but a person with a resume and a job board should
  // be searching, not answering a questionnaire (ADR 0024).
  const materiallyComplete =
    hasCoreIdentity && hasContactPath && hasDiscoverySource;
  const started = Boolean(
    hasResumeText ||
    hasCoreIdentity ||
    hasContactPath ||
    hasMeaningfulBackground ||
    hasTargeting ||
    hasEligibilityPreferences ||
    hasNarrative,
  );

  // Job targets owns the finish action, so a materially complete profile
  // resumes there rather than on a summary screen that no longer exists.
  let recommendedStep: ProfileSetupStep = "targeting";
  if (!hasResumeText) {
    recommendedStep = "import";
  } else if (!hasCoreIdentity || !hasContactPath) {
    recommendedStep = "essentials";
  } else if (!hasMeaningfulBackground) {
    recommendedStep = "background";
  } else if (!hasDiscoverySource || !hasWorkEligibilityAnswers) {
    recommendedStep = "targeting";
  } else if (!hasNarrative) {
    recommendedStep = "extras";
  }

  return {
    freshStart,
    hasContactPath,
    hasCoreIdentity,
    hasDiscoverySource,
    hasEligibilityPreferences,
    hasMeaningfulBackground,
    hasNarrative,
    hasResumeText,
    hasTargeting,
    hasWorkEligibilityAnswers,
    hasWorkModePreference,
    materiallyComplete,
    recommendedStep,
    started,
  };
}

export function deriveProfileSetupState(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  options: DeriveProfileSetupStateOptions = {},
): ProfileSetupState {
  const readiness = evaluateProfileSetupReadiness(
    profile,
    searchPreferences,
    options.enabledSiteCount,
  );
  const currentState = options.currentState
    ? ProfileSetupStateSchema.parse(options.currentState)
    : null;
  const pendingReviewItems = currentState?.reviewItems ?? [];

  // An explicit Finish stays authoritative while the profile is still
  // materially complete: a later import's review items wait in Profile
  // instead of reopening setup. Before Finish, blocking items still gate it.
  const canBeCompleted =
    readiness.materiallyComplete &&
    (currentState?.status === "completed" ||
      !hasBlockingPendingReviewItems(pendingReviewItems));

  let status: ProfileSetupStatus = "not_started";
  // An explicit Finish stays authoritative. A materially ready setup also
  // stops nagging once the person has used it for a real search, even if an
  // older setup state was left in progress by Save and continue.
  const hasCompletionEvidence =
    currentState?.status === "completed" || options.hasRunSearch === true;
  if (
    canBeCompleted &&
    (currentState?.status !== "in_progress" || hasCompletionEvidence)
  ) {
    status = "completed";
  } else if (
    readiness.started ||
    pendingReviewItems.length > 0 ||
    currentState?.status === "in_progress"
  ) {
    status = "in_progress";
  }

  const currentStep =
    status === "completed"
      ? "targeting"
      : status === "not_started"
        ? "import"
        : currentState?.status === "in_progress"
          ? currentState.currentStep
          : // An optional suggestion (a proof point on Extras, a summary to
            // confirm on Basics) used to choose this step, so a fresh import
            // landed where there was nothing to do.
            getProfileSetupLandingStep(readiness, pendingReviewItems);

  return ProfileSetupStateSchema.parse({
    status,
    currentStep,
    completedAt:
      status === "completed"
        ? (currentState?.completedAt ?? options.now ?? null)
        : null,
    reviewItems: currentState?.reviewItems ?? [],
    ...(currentState?.reviewedSteps
      ? { reviewedSteps: currentState.reviewedSteps }
      : {}),
    lastResumedAt: currentState?.lastResumedAt ?? null,
  });
}
