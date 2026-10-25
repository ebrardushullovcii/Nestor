import {
  normalizeProfileSetupStep,
  getProfileSetupReadinessBlockers,
  hasProfileSetupPlaceholderValue,
  isFreshStartCandidateProfile,
  type CandidateProfile,
  type JobSearchPreferences,
  type ProfileCopilotContext,
  type ProfileSetupReadinessBlockerId,
  type ProfileSetupReadiness,
  type ProfileSetupState,
  type ProfileSetupStep,
} from "@nestor/contracts";
import { profileSetupStepDefinitions } from "./profile-setup-steps";

/** Stable id of the single canonical setup validation alert element. */
export const PROFILE_SETUP_VALIDATION_ALERT_ID =
  "profile-setup-validation-alert";

export type ProfileSetupReviewItem = ProfileSetupState["reviewItems"][number];
export type ProfileSetupReviewItemDisplay = ProfileSetupReviewItem & {
  savedStatus: ProfileSetupReviewItem["status"];
  statusSource: "saved" | "draft";
};

export function getProfileSetupReviewItemCopy(
  item: Pick<ProfileSetupReviewItem, "label" | "reason" | "target"> &
    Partial<Pick<ProfileSetupReviewItem, "sourceCandidateId">>,
): { label: string; reason: string } {
  if (item.target.domain === "work_eligibility") {
    if (item.sourceCandidateId) {
      return { label: item.label, reason: item.reason };
    }
    if (
      item.target.key === "authorizedWorkCountries" ||
      item.target.key === "requiresVisaSponsorship"
    ) {
      return {
        label: "Work eligibility",
        reason:
          "Answer where you can work and whether you need visa sponsorship before finishing setup. Nothing is inferred from where you live.",
      };
    }
    return {
      label: "Work details",
      reason:
        "Optional. Relocation, travel, and remote eligibility help matching and applications. Leave anything you do not know as Not set; nothing here is guessed.",
    };
  }

  return { label: item.label, reason: item.reason };
}

export function isBlockingPendingReviewItem(
  item: Pick<ProfileSetupReviewItem, "severity" | "status">,
): boolean {
  return item.status === "pending" && item.severity !== "optional";
}

type ProfileSetupFinishGateReviewItem = Pick<
  ProfileSetupReviewItem,
  "severity" | "status"
> &
  Partial<
    Pick<
      ProfileSetupReviewItem,
      | "proposedValue"
      | "sourceCandidateId"
      | "sourceRunId"
      | "sourceSnippet"
      | "target"
    >
  >;

/**
 * Finishing setup is gated only by what setup genuinely requires: a missing
 * required field (the "required setup item" drafts) or a critical pending
 * item. Pending RECOMMENDED imported suggestions still deserve a look, but a
 * person must never be forced back into a step to click Confirm/Dismiss
 * before they can finish; those stay optional to review.
 */
export function isFinishBlockingReviewItem(
  item: ProfileSetupFinishGateReviewItem,
): boolean {
  if (item.status !== "pending") {
    return false;
  }

  if (item.severity === "critical") {
    return true;
  }

  // ADR 0029 requires these answers at Finish. Older review drafts still
  // carry recommended severity, so present the missing answers consistently
  // with the footer without changing persisted review or completed setups.
  if (
    item.target?.domain === "work_eligibility" &&
    (item.target.key === "authorizedWorkCountries" ||
      item.target.key === "requiresVisaSponsorship") &&
    item.sourceCandidateId === null &&
    item.sourceRunId === null &&
    item.proposedValue === null
  ) {
    return true;
  }

  // Finishing needs a name, a way to be contacted, and a job source (ADR
  // 0024). Other recommended fields that the resume did not fill are hints,
  // not gates: they must not stand
  // between a person with a resume and their first search.
  return false;
}

/** Pending items that do not gate finishing: recommended imports and optional hints. */
export function isReviewableSuggestionItem(
  item: ProfileSetupFinishGateReviewItem,
): boolean {
  return item.status === "pending" && !isFinishBlockingReviewItem(item);
}

export type ProfileSetupReadinessPresentation = {
  blockers: ReturnType<typeof getProfileSetupReadinessBlockers>;
  blockingPendingReviewItemCount: number;
  remainingBlockerCount: number;
};

const PROFILE_SETUP_READINESS_BLOCKER_LABELS: Record<
  ProfileSetupReadinessBlockerId,
  string
> = {
  background: "Add work history",
  discovery_source: "Add a job source",
  // Any one work or location answer satisfies this gate, so the label must
  // not promise that a location was saved.
  eligibility_preferences: "Answer one work or location detail",
  identity_contact: "Add your name and an email or phone",
  work_mode_preference:
    "Pick where you want to work (remote, hybrid, onsite, or flexible)",
  work_eligibility_answers:
    "Say where you can work and whether you need visa sponsorship",
};

export function getProfileSetupReadinessBlockerLabel(
  blockerId: ProfileSetupReadinessBlockerId,
): string {
  return PROFILE_SETUP_READINESS_BLOCKER_LABELS[blockerId];
}

/** The step whose editor fills each blocker, so the footer can say where to go. */
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

export function getProfileSetupReadinessBlockerStep(
  blockerId: ProfileSetupReadinessBlockerId,
): ProfileSetupStep {
  return PROFILE_SETUP_READINESS_BLOCKER_STEPS[blockerId];
}

/**
 * Shared presentation model for every visible setup readiness count. The
 * canonical blocker list covers path readiness; only pending blocking review
 * items add review work. Edited or optional review items must not inflate the
 * count shown in the summary or sticky finish action.
 */
export function isReadinessCoveredSetupReviewItem(
  item: ProfileSetupFinishGateReviewItem,
): boolean {
  if (
    item.target?.recordId !== null ||
    item.proposedValue !== null ||
    item.sourceCandidateId !== null ||
    item.sourceRunId !== null ||
    item.sourceSnippet !== null
  ) {
    return false;
  }
  const { domain, key } = item.target;
  return (
    (domain === "identity" &&
      ["firstName", "lastName", "contactPath"].includes(key)) ||
    (domain === "work_eligibility" &&
      ["authorizedWorkCountries", "requiresVisaSponsorship"].includes(key))
  );
}

export function buildProfileSetupReadinessPresentation(input: {
  readiness: Pick<
    ProfileSetupReadiness,
    | "hasCoreIdentity"
    | "hasContactPath"
    | "hasMeaningfulBackground"
    | "hasEligibilityPreferences"
    | "hasWorkModePreference"
    | "hasDiscoverySource"
    | "hasWorkEligibilityAnswers"
  >;
  reviewItems: readonly ProfileSetupFinishGateReviewItem[];
}): ProfileSetupReadinessPresentation {
  const blockers = getProfileSetupReadinessBlockers(input.readiness);
  // Only finish-gating items count toward the remaining total; recommended
  // imported suggestions are reported separately so they can never disable
  // the Finish action.
  const blockingPendingReviewItemCount = input.reviewItems.filter((item) => {
    // Saved screener answers also satisfy ADR 0029, even if an older
    // missing-field review item still points at the structured country list.
    if (
      input.readiness.hasWorkEligibilityAnswers &&
      item.severity !== "critical" &&
      item.target?.domain === "work_eligibility" &&
      item.sourceCandidateId === null
    ) {
      return false;
    }
    // Missing basics are already listed once as readiness blockers.
    return (
      isFinishBlockingReviewItem(item) &&
      !isReadinessCoveredSetupReviewItem(item)
    );
  }).length;

  return {
    blockers,
    blockingPendingReviewItemCount,
    remainingBlockerCount: blockers.length + blockingPendingReviewItemCount,
  };
}

/**
 * Missing-field drafts are required setup work, not imported values waiting
 * for confirmation. Keep this distinction visible anywhere setup counts or
 * describes pending work.
 */
export function isProfileSetupMissingFieldReviewItem(
  item: Pick<
    ProfileSetupReviewItem,
    | "proposedValue"
    | "sourceCandidateId"
    | "sourceRunId"
    | "sourceSnippet"
    | "target"
  >,
): boolean {
  return (
    item.target.recordId === null &&
    item.proposedValue === null &&
    item.sourceCandidateId === null &&
    item.sourceRunId === null &&
    item.sourceSnippet === null
  );
}

export function formatProfileSetupRequiredItemCount(count: number): string {
  return `${count} required setup item${count === 1 ? "" : "s"}`;
}

export function isOptionalPendingReviewItem(
  item: Pick<ProfileSetupReviewItem, "severity" | "status">,
): boolean {
  return item.status === "pending" && item.severity === "optional";
}

function hasMeaningfulText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPreferredApplicationLinkUrls(profile: CandidateProfile): string[] {
  return Array.from(
    new Set(
      profile.applicationIdentity.preferredLinkIds.flatMap((linkId) => {
        const url = profile.links.find((entry) => entry.id === linkId)?.url;
        return typeof url === "string" && url.trim().length > 0 ? [url] : [];
      }),
    ),
  );
}

function getCurrentTargetValue(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  target: ProfileSetupReviewItem["target"],
): unknown {
  switch (target.domain) {
    case "identity": {
      if (target.key === "contactPath") {
        return [profile.email ?? "", profile.phone ?? ""].filter((value) =>
          hasMeaningfulText(value),
        );
      }

      return (profile as Record<string, unknown>)[target.key] ?? null;
    }
    case "application_identity":
      if (target.key === "preferredLinkUrls") {
        return getPreferredApplicationLinkUrls(profile);
      }

      return (
        (profile.applicationIdentity as Record<string, unknown>)[target.key] ??
        null
      );
    case "work_eligibility":
      return (
        (profile.workEligibility as Record<string, unknown>)[target.key] ?? null
      );
    case "professional_summary":
      return (
        (profile.professionalSummary as Record<string, unknown>)[target.key] ??
        null
      );
    case "search_preferences":
      return (searchPreferences as Record<string, unknown>)[target.key] ?? null;
    case "narrative":
      return (profile.narrative as Record<string, unknown>)[target.key] ?? null;
    case "answer_bank":
      return (
        (profile.answerBank as Record<string, unknown>)[target.key] ?? null
      );
    case "experience": {
      const record = target.recordId
        ? (profile.experiences.find((entry) => entry.id === target.recordId) ??
          null)
        : profile.experiences;

      return target.key === "record" || !isObjectRecord(record)
        ? record
        : ((record as Record<string, unknown>)[target.key] ?? null);
    }
    case "education": {
      const record = target.recordId
        ? (profile.education.find((entry) => entry.id === target.recordId) ??
          null)
        : profile.education;

      return target.key === "record" || !isObjectRecord(record)
        ? record
        : ((record as Record<string, unknown>)[target.key] ?? null);
    }
    case "certification": {
      const record = target.recordId
        ? (profile.certifications.find(
            (entry) => entry.id === target.recordId,
          ) ?? null)
        : profile.certifications;

      return target.key === "record" || !isObjectRecord(record)
        ? record
        : ((record as Record<string, unknown>)[target.key] ?? null);
    }
    case "project": {
      const record = target.recordId
        ? (profile.projects.find((entry) => entry.id === target.recordId) ??
          null)
        : profile.projects;

      return target.key === "record" || !isObjectRecord(record)
        ? record
        : ((record as Record<string, unknown>)[target.key] ?? null);
    }
    case "link": {
      const record = target.recordId
        ? (profile.links.find((entry) => entry.id === target.recordId) ?? null)
        : profile.links;

      return target.key === "record" || !isObjectRecord(record)
        ? record
        : ((record as Record<string, unknown>)[target.key] ?? null);
    }
    case "language": {
      const record = target.recordId
        ? (profile.spokenLanguages.find(
            (entry) => entry.id === target.recordId,
          ) ?? null)
        : profile.spokenLanguages;

      return target.key === "record" || !isObjectRecord(record)
        ? record
        : ((record as Record<string, unknown>)[target.key] ?? null);
    }
    case "proof_point": {
      const record = target.recordId
        ? (profile.proofBank.find((entry) => entry.id === target.recordId) ??
          null)
        : profile.proofBank;

      return target.key === "record" || !isObjectRecord(record)
        ? record
        : ((record as Record<string, unknown>)[target.key] ?? null);
    }
  }
}

function hasCurrentTargetValue(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  target: ProfileSetupReviewItem["target"],
): boolean {
  const value = getCurrentTargetValue(profile, searchPreferences, target);

  if (typeof value === "string") {
    return hasMeaningfulText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (isObjectRecord(value)) {
    return Object.values(value).some((entry) => {
      if (typeof entry === "string") {
        return hasMeaningfulText(entry);
      }

      if (typeof entry === "number" || typeof entry === "boolean") {
        return true;
      }

      return Array.isArray(entry) ? entry.length > 0 : false;
    });
  }

  return false;
}

function humanizeRecordFieldKey(key: string): string {
  switch (key) {
    case "schoolName":
      return "School name";
    case "companyName":
      return "Company";
    case "isCurrent":
      return "Current role";
    case "startDate":
      return "Start";
    case "endDate":
      return "End";
    case "fieldOfStudy":
      return "Field of study";
    case "interviewPreference":
      return "Interview preference";
    case "workMode":
      return "Where you worked at this job";
    case "dateEarned":
      return "Date earned";
    default:
      return (
        key.charAt(0).toUpperCase() +
        key
          .slice(1)
          .replace(/([A-Z])/g, " $1")
          .trim()
      );
  }
}

function humanizePrimitive(value: boolean | number): string {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value);
}

function summarizeValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return humanizePrimitive(value);
  }

  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => summarizeValue(entry) ?? []);
    return parts.length > 0 ? parts.join(", ") : null;
  }

  if (isObjectRecord(value)) {
    const parts = Object.entries(value).flatMap(([key, entry]) => {
      if (key === "id" || key === "recordId" || key.endsWith("Id")) {
        return [];
      }

      const summary = summarizeValue(entry);
      return summary ? [`${humanizeRecordFieldKey(key)}: ${summary}`] : [];
    });

    return parts.length > 0 ? parts.join(" · ") : null;
  }

  return null;
}

/** Formats imported structured values for people instead of exposing serialized storage objects. */
export function formatProfileSetupReviewValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return summarizeValue(value);
  }

  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return summarizeValue(value);
  }

  try {
    return summarizeValue(JSON.parse(trimmed)) ?? summarizeValue(value);
  } catch {
    return summarizeValue(value);
  }
}

function normalizeComparableSummary(value: string | null): string | null {
  return value ? value.trim().replace(/\s+/g, " ").toLowerCase() : null;
}

/** Whitespace-normalised but case-preserving: "Nico" and "NICO" differ. */
function normalizeExactSummary(value: string | null): string | null {
  return value ? value.trim().replace(/\s+/g, " ") : null;
}

export function buildDraftAwareSetupReviewItems(input: {
  currentProfile: CandidateProfile;
  currentSearchPreferences: JobSearchPreferences;
  draftProfile: CandidateProfile;
  draftSearchPreferences: JobSearchPreferences;
  reviewItems: readonly ProfileSetupReviewItem[];
}): ProfileSetupReviewItemDisplay[] {
  return input.reviewItems.map((item) => {
    if (
      item.status !== "pending" ||
      (item.target.domain === "experience" &&
        item.target.key === "record" &&
        item.target.recordId &&
        item.sourceCandidateId)
    ) {
      return {
        ...item,
        savedStatus: item.status,
        statusSource: "saved",
      };
    }

    const previousValue = getCurrentTargetValue(
      input.currentProfile,
      input.currentSearchPreferences,
      item.target,
    );
    const draftValue = getCurrentTargetValue(
      input.draftProfile,
      input.draftSearchPreferences,
      item.target,
    );

    if (
      !hasCurrentTargetValue(
        input.draftProfile,
        input.draftSearchPreferences,
        item.target,
      )
    ) {
      return {
        ...item,
        savedStatus: item.status,
        statusSource: "saved",
      };
    }

    const previousSummary = normalizeComparableSummary(
      summarizeValue(previousValue),
    );
    const draftSummary = normalizeComparableSummary(summarizeValue(draftValue));

    if (!draftSummary || previousSummary === draftSummary) {
      return {
        ...item,
        savedStatus: item.status,
        statusSource: "saved",
      };
    }

    // Exact match only: a person who retypes "NICO TURNER" as "Nico Turner"
    // has edited the value. Treating that as a confirmation re-applied the
    // imported spelling on save while the toast said "Saved".
    const proposedExact = normalizeExactSummary(item.proposedValue ?? null);
    const draftExact = normalizeExactSummary(summarizeValue(draftValue));

    return {
      ...item,
      savedStatus: item.status,
      status:
        proposedExact && proposedExact === draftExact ? "confirmed" : "edited",
      statusSource: "draft",
    };
  });
}

export function formatReviewStatus(
  status: ProfileSetupReviewItem["status"],
): string {
  return status.replace("_", " ");
}

export function formatReviewSeverity(
  severity: ProfileSetupReviewItem["severity"],
): string {
  return severity === "critical"
    ? "Critical"
    : severity === "recommended"
      ? "Recommended"
      : "Optional";
}

export function badgeVariantForSeverity(
  severity: ProfileSetupReviewItem["severity"],
): "destructive" | "status" | "outline" {
  if (severity === "critical") {
    return "destructive";
  }

  return severity === "recommended" ? "status" : "outline";
}

export function canConfirmReviewItem(item: ProfileSetupReviewItem): boolean {
  return item.sourceCandidateId !== null && item.status === "pending";
}

export function canClearReviewItem(item: ProfileSetupReviewItem): boolean {
  return !(
    item.target.domain === "identity" && item.target.key === "yearsExperience"
  );
}

export function getReviewItemEditHint(
  item: ProfileSetupReviewItem,
): string | null {
  if (item.target.domain === "experience") {
    if (item.target.key === "record" && !item.target.recordId) {
      return "Add a role in Work history on the left. Work mode and location can be added after you create the role.";
    }

    return "Edit this in Work history on the left. Use the role's Work mode field to mark it Remote, Hybrid, or Onsite. Keep Location for the city or region you want shown, and use Job targets later if you also want future job searches to prefer remote roles.";
  }

  if (
    item.target.domain === "search_preferences" ||
    item.target.domain === "work_eligibility"
  ) {
    return "Edit this in the Job targets step — preferences say what you want, work details say what you can accept.";
  }

  if (
    item.target.domain === "identity" &&
    item.target.key === "currentLocation"
  ) {
    return "Edit this in Basics. Displayed location is the location shown on your profile and generated resumes, not your remote-job preference.";
  }

  return null;
}

export function getReviewItemEditActionLabel(
  item: Pick<ProfileSetupReviewItem, "target">,
): string {
  return item.target.domain === "experience" &&
    item.target.key === "record" &&
    !item.target.recordId
    ? "Add a role"
    : "Edit this";
}

export function buildSetupCopilotPlaceholder(step: ProfileSetupStep): string {
  switch (step) {
    case "essentials":
      return 'Example: update my headline to "Principal product designer focused on workflow systems"';
    case "targeting":
      return "Example: help me tighten my target roles for remote design systems work";
    case "extras":
      return 'Example: rewrite my professional story: "..."';
    default:
      return "Ask for a grounded profile improvement or a structured edit for this setup step.";
  }
}

export function buildStepEditorContext(
  step: ProfileSetupStep,
): ProfileCopilotContext {
  return {
    surface: "setup",
    step,
  };
}

function formatRequirementList(values: readonly string[]): string {
  if (values.length <= 1) {
    return values[0] ?? "";
  }

  return `${values.slice(0, -1).join(", ")}, and ${
    values[values.length - 1] as string
  }`;
}

/**
 * One honest identity-blocker sentence for every surface that shows why the
 * essentials step still blocks setup. It names exactly what is missing — full
 * name, headline, location, contact, and years of experience only for
 * fresh-start profiles — instead of hiding behind a generic "identity" label
 * or listing requirements that are already satisfied.
 */
export function buildProfileSetupIdentityBlockerReason(
  profile: CandidateProfile,
): string {
  const missingRequirements: string[] = [];

  if (
    !hasMeaningfulText(profile.fullName) ||
    hasProfileSetupPlaceholderValue("fullName", profile.fullName)
  ) {
    missingRequirements.push("your full name");
  }

  // Same canonical placeholder-aware rule readiness uses: a missing or
  // first-run placeholder headline still blocks core identity.
  if (
    !hasMeaningfulText(profile.headline) ||
    hasProfileSetupPlaceholderValue("headline", profile.headline)
  ) {
    missingRequirements.push("a headline");
  }

  // Either place the app offers counts: guided setup writes one compact line,
  // Profile Basics writes city, region and country. Reading only the compact
  // line kept "Add your current location" on screen for someone who had
  // already filled in the structured fields.
  if (
    (!hasMeaningfulText(profile.currentLocation) ||
      hasProfileSetupPlaceholderValue(
        "currentLocation",
        profile.currentLocation,
      )) &&
    !hasMeaningfulText(profile.currentCity) &&
    !hasMeaningfulText(profile.currentRegion) &&
    !hasMeaningfulText(profile.currentCountry)
  ) {
    missingRequirements.push("your location");
  }

  if (!hasMeaningfulText(profile.email) && !hasMeaningfulText(profile.phone)) {
    missingRequirements.push("at least one contact method");
  }

  if (
    isFreshStartCandidateProfile(profile) &&
    profile.yearsExperience === null
  ) {
    missingRequirements.push("your years of experience");
  }

  if (missingRequirements.length === 0) {
    return "Add a real identity, location, and at least one contact method.";
  }

  return `Add ${formatRequirementList(missingRequirements)} before discovery and applications rely on your identity.`;
}

/**
 * Narrow slice of the canonical setup readiness evaluation that the setup
 * path rows use as per-step completion evidence. The full
 * `evaluateProfileSetupReadiness` output satisfies it structurally, so
 * callers can pass that result without reshaping anything.
 */
export type ProfileSetupPathStepReadiness = Pick<
  ProfileSetupReadiness,
  | "hasAnswerBank"
  | "hasContactPath"
  | "hasCoreIdentity"
  | "hasDiscoverySource"
  | "hasEligibilityPreferences"
  | "hasMeaningfulBackground"
  | "hasNarrative"
  | "hasWorkEligibilityAnswers"
  | "hasWorkModePreference"
>;

/**
 * Per-step domain evidence for the setup path rows, mapped to the same
 * canonical signals the ready check and derived setup state already use.
 * Import keeps its dedicated imported-asset guard and the ready check row is
 * complete only when setup itself finished.
 */
function hasProfileSetupPathStepEvidence(input: {
  hasImportedResume: boolean;
  readiness: ProfileSetupPathStepReadiness | null;
  setupCompleted: boolean;
  stepId: ProfileSetupStep;
}): boolean {
  if (input.stepId === "import") {
    return input.hasImportedResume;
  }

  // Callers without draft evidence keep the legacy chronology-only rule
  // instead of guessing at domain completeness.
  if (input.readiness === null) {
    return true;
  }

  switch (input.stepId) {
    case "essentials":
      return input.readiness.hasCoreIdentity && input.readiness.hasContactPath;
    case "background":
      return input.readiness.hasMeaningfulBackground;
    case "targeting":
      return (
        input.readiness.hasEligibilityPreferences &&
        input.readiness.hasWorkEligibilityAnswers &&
        input.readiness.hasWorkModePreference &&
        input.readiness.hasDiscoverySource
      );
    // Extras stays optional by product semantics: real content earns a
    // Complete claim, while an empty optional step simply earns no claim
    // instead of becoming a new obligation.
    case "extras":
      return input.readiness.hasNarrative || input.readiness.hasAnswerBank;
    default:
      return input.setupCompleted;
  }
}

/**
 * Shared completion rule for the setup path rows so no row can present
 * chronology alone as completion. Reaching a step (or finishing setup) only
 * makes it eligible; each row must additionally prove its own domain content
 * through the shared canonical readiness evaluation, so blitz-clicking
 * through untouched steps can never mint false Complete badges. Blocking
 * review items always hold their row open regardless of evidence.
 */
export function isProfileSetupPathStepComplete(input: {
  currentStep: ProfileSetupStep;
  hasImportedResume: boolean;
  pendingBlockingReviewCount: number;
  readiness: ProfileSetupPathStepReadiness | null;
  setupStatus: ProfileSetupState["status"];
  stepId: ProfileSetupStep;
}): boolean {
  if (input.pendingBlockingReviewCount > 0) {
    return false;
  }

  const setupCompleted = input.setupStatus === "completed";
  // A stored step id can still be a retired one; compare visible steps only.
  const currentStep = normalizeProfileSetupStep(input.currentStep);
  const stepId = normalizeProfileSetupStep(input.stepId);
  const chronologicallyReached =
    setupCompleted ||
    profileSetupStepDefinitions.findIndex((entry) => entry.id === currentStep) >
      profileSetupStepDefinitions.findIndex((entry) => entry.id === stepId);

  return (
    chronologicallyReached &&
    hasProfileSetupPathStepEvidence({
      hasImportedResume: input.hasImportedResume,
      readiness: input.readiness,
      setupCompleted,
      stepId,
    })
  );
}

export function summarizeSavedSetupReviewValue(
  profile: CandidateProfile,
  preferences: JobSearchPreferences,
  item: ProfileSetupReviewItem,
): string | null {
  return summarizeValue(
    getCurrentTargetValue(profile, preferences, item.target),
  );
}
