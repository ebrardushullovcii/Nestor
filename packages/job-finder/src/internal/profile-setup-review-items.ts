import {
  ProfileReviewItemSchema,
  ProfileSetupStateSchema,
  evaluateProfileSetupReadiness,
  hasProfileSetupPlaceholderValue,
  type CandidateProfile,
  type JobSearchPreferences,
  type ProfileReviewItem,
  type ProfileSetupState,
  type ResumeDocumentBundle,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";
import { buildExtractionId } from "./profile-merge";
import {
  shouldIncludeCandidateInSetupReview,
  summarizeValue,
  toReviewDraft,
  type DerivedReviewDraft,
} from "./profile-setup-review-mapping";
import { normalizeText, uniqueStrings } from "./shared";

interface BuildProfileSetupReviewItemsInput {
  currentState: ProfileSetupState | null;
  documentBundle: ResumeDocumentBundle | null;
  now: string;
  profile: CandidateProfile;
  candidates: readonly ResumeImportFieldCandidate[];
  searchPreferences: JobSearchPreferences;
}

type TargetDomain = ProfileReviewItem["target"]["domain"];
type TargetKey = ProfileReviewItem["target"]["key"];

function getPreferredApplicationLinkUrls(profile: CandidateProfile): string[] {
  return uniqueStrings(
    profile.applicationIdentity.preferredLinkIds.flatMap((linkId) => {
      const url = profile.links.find((entry) => entry.id === linkId)?.url;
      return typeof url === "string" && url.trim().length > 0 ? [url] : [];
    }),
  );
}

function getCurrentTargetValue(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  target: ProfileReviewItem["target"],
): unknown {
  switch (target.domain) {
    case "identity":
      if (target.key === "contactPath") {
        return uniqueStrings([profile.email ?? "", profile.phone ?? ""]);
      }

      return (profile as Record<string, unknown>)[target.key] ?? null;
    case "application_identity":
      if (target.key === "preferredLinkUrls") {
        return getPreferredApplicationLinkUrls(profile);
      }

      return (
        (profile.applicationIdentity as Record<string, unknown>)[target.key] ??
        null
      );
    case "work_eligibility":
      switch (target.key) {
        case "authorizedWorkCountries":
          return profile.workEligibility.authorizedWorkCountries;
        case "requiresVisaSponsorship":
          return profile.workEligibility.requiresVisaSponsorship;
        case "willingToRelocate":
          return profile.workEligibility.willingToRelocate;
        case "willingToTravel":
          return profile.workEligibility.willingToTravel;
        case "remoteEligible":
          return profile.workEligibility.remoteEligible;
        case "availableStartDate":
          return profile.workEligibility.availableStartDate;
        default:
          return null;
      }
    case "professional_summary":
      return profile.professionalSummary[
        target.key as keyof CandidateProfile["professionalSummary"]
      ];
    case "search_preferences":
      return searchPreferences[target.key as keyof JobSearchPreferences];
    case "narrative":
      return profile.narrative[
        target.key as keyof CandidateProfile["narrative"]
      ];
    case "answer_bank":
      return null;
    case "experience":
      if (target.key !== "record") {
        return null;
      }
      return target.recordId
        ? (profile.experiences.find(
            (record) => record.id === target.recordId,
          ) ?? null)
        : profile.experiences;
    case "education":
      if (target.key !== "record") {
        return null;
      }
      return target.recordId
        ? (profile.education.find((record) => record.id === target.recordId) ??
            null)
        : profile.education;
    case "certification":
      if (target.key !== "record") {
        return null;
      }
      return target.recordId
        ? (profile.certifications.find(
            (record) => record.id === target.recordId,
          ) ?? null)
        : profile.certifications;
    case "project":
      if (target.key !== "record") {
        return null;
      }
      return target.recordId
        ? (profile.projects.find((record) => record.id === target.recordId) ??
            null)
        : profile.projects;
    case "link":
      if (target.key !== "record") {
        return null;
      }
      return target.recordId
        ? (profile.links.find((record) => record.id === target.recordId) ??
            null)
        : profile.links;
    case "language":
      if (target.key !== "record") {
        return null;
      }
      return target.recordId
        ? (profile.spokenLanguages.find(
            (record) => record.id === target.recordId,
          ) ?? null)
        : profile.spokenLanguages;
    case "proof_point":
      if (target.key !== "record") {
        return null;
      }
      return target.recordId
        ? (profile.proofBank.find((record) => record.id === target.recordId) ??
            null)
        : profile.proofBank;
    default:
      return null;
  }
}

function hasCurrentTargetValue(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  target: ProfileReviewItem["target"],
): boolean {
  const value = getCurrentTargetValue(profile, searchPreferences, target);

  if (typeof value === "string") {
    if (
      target.domain === "identity" &&
      target.key === "headline" &&
      !hasPlaceholderAwareIdentityValue(value, "headline")
    ) {
      return false;
    }

    if (
      target.domain === "identity" &&
      target.key === "currentLocation" &&
      !hasPlaceholderAwareIdentityValue(value, "currentLocation")
    ) {
      return false;
    }

    return hasMeaningfulText(value);
  }

  if (typeof value === "number") {
    if (target.domain === "identity" && target.key === "yearsExperience") {
      // Zero is a valid, intentional answer for a first-job profile. The
      // editor rejects empty/invalid values before they reach this canonical
      // review pipeline, while the profile schema keeps the stored value a
      // non-negative integer.
      return value >= 0;
    }

    return true;
  }

  if (typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (value && typeof value === "object") {
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

function normalizeComparableSummary(value: string | null): string | null {
  return value ? normalizeText(value) : null;
}

function isReviewDraftAlreadySatisfied(input: {
  draft: DerivedReviewDraft;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
}): boolean {
  if (
    !hasCurrentTargetValue(
      input.profile,
      input.searchPreferences,
      input.draft.target,
    )
  ) {
    return false;
  }

  const currentSummary = normalizeComparableSummary(
    summarizeValue(
      getCurrentTargetValue(
        input.profile,
        input.searchPreferences,
        input.draft.target,
      ),
    ),
  );
  const proposedSummary = normalizeComparableSummary(
    input.draft.proposedValue ?? null,
  );
  return Boolean(
    currentSummary && proposedSummary && currentSummary === proposedSummary,
  );
}

export function resolvePendingReviewItemsAfterExplicitSave(input: {
  currentProfile: CandidateProfile;
  currentSearchPreferences: JobSearchPreferences;
  nextProfile: CandidateProfile;
  nextSearchPreferences: JobSearchPreferences;
  profileSetupState: ProfileSetupState;
  now: string;
}): ProfileSetupState {
  return ProfileSetupStateSchema.parse({
    ...input.profileSetupState,
    reviewItems: input.profileSetupState.reviewItems.map((item) => {
      if (item.status !== "pending") {
        return item;
      }

      const previousValue = getCurrentTargetValue(
        input.currentProfile,
        input.currentSearchPreferences,
        item.target,
      );
      const nextValue = getCurrentTargetValue(
        input.nextProfile,
        input.nextSearchPreferences,
        item.target,
      );

      if (
        !hasCurrentTargetValue(
          input.nextProfile,
          input.nextSearchPreferences,
          item.target,
        )
      ) {
        return item;
      }

      const previousSummary = normalizeComparableSummary(
        summarizeValue(previousValue),
      );
      const nextSummary = normalizeComparableSummary(summarizeValue(nextValue));

      if (!nextSummary || previousSummary === nextSummary) {
        return item;
      }

      const proposedSummary = normalizeComparableSummary(
        item.proposedValue ?? null,
      );
      const nextStatus =
        proposedSummary && proposedSummary === nextSummary
          ? "confirmed"
          : "edited";

      return ProfileReviewItemSchema.parse({
        ...item,
        status: nextStatus,
        resolvedAt: item.resolvedAt ?? input.now,
      });
    }),
  });
}

function resolvePendingItemIfSatisfied(input: {
  item: ProfileReviewItem;
  draft: DerivedReviewDraft;
  now: string;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
}): ProfileReviewItem {
  const currentValue = getCurrentTargetValue(
    input.profile,
    input.searchPreferences,
    input.draft.target,
  );
  const currentSummary = summarizeValue(currentValue);
  const proposedSummary = input.draft.proposedValue ?? null;
  const sourceCandidateId =
    input.draft.sourceCandidateId ?? input.item.sourceCandidateId;

  if (
    !hasCurrentTargetValue(
      input.profile,
      input.searchPreferences,
      input.draft.target,
    )
  ) {
    return ProfileReviewItemSchema.parse({
      ...input.item,
      step: input.draft.step,
      target: input.draft.target,
      label: input.draft.label,
      reason: input.draft.reason,
      severity: input.draft.severity,
      proposedValue: proposedSummary,
      sourceSnippet: input.draft.sourceSnippet ?? null,
      sourceCandidateId,
      sourceRunId: input.draft.sourceRunId ?? null,
    });
  }

  if (
    sourceCandidateId &&
    (!proposedSummary ||
      !currentSummary ||
      normalizeText(proposedSummary) !== normalizeText(currentSummary))
  ) {
    return ProfileReviewItemSchema.parse({
      ...input.item,
      step: input.draft.step,
      target: input.draft.target,
      label: input.draft.label,
      reason: input.draft.reason,
      severity: input.draft.severity,
      proposedValue: proposedSummary,
      sourceSnippet: input.draft.sourceSnippet ?? null,
      sourceCandidateId,
      sourceRunId: input.draft.sourceRunId ?? null,
    });
  }

  return ProfileReviewItemSchema.parse({
    ...input.item,
    step: input.draft.step,
    target: input.draft.target,
    label: input.draft.label,
    reason: input.draft.reason,
    severity: input.draft.severity,
    status:
      proposedSummary && currentSummary
        ? normalizeText(proposedSummary) === normalizeText(currentSummary)
          ? "confirmed"
          : "edited"
        : "edited",
    proposedValue: proposedSummary,
    sourceSnippet: input.draft.sourceSnippet ?? null,
    sourceCandidateId,
    sourceRunId: input.draft.sourceRunId ?? null,
    resolvedAt: input.item.resolvedAt ?? input.now,
  });
}

function hasMeaningfulText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasMeaningfulStringList(
  values: readonly string[] | null | undefined,
): boolean {
  return values?.some((value) => hasMeaningfulText(value)) ?? false;
}

/**
 * True when the person has said where they are, in whichever place the app
 * offered them.
 *
 * Guided setup writes one compact line; Profile Basics writes city, region and
 * country. Reading only the compact line left a person who filled in
 * "Budapest" and "Hungary" on Basics staring at "Add your current location"
 * with no way to clear it.
 */
function hasStatedCurrentLocation(profile: CandidateProfile): boolean {
  return (
    hasPlaceholderAwareIdentityValue(
      profile.currentLocation,
      "currentLocation",
    ) ||
    hasMeaningfulText(profile.currentCity) ||
    hasMeaningfulText(profile.currentRegion) ||
    hasMeaningfulText(profile.currentCountry)
  );
}

function hasPlaceholderAwareIdentityValue(
  value: string | null | undefined,
  field: "headline" | "currentLocation",
): boolean {
  return Boolean(
    hasMeaningfulText(value) && !hasProfileSetupPlaceholderValue(field, value),
  );
}

/**
 * True when the stored full name is a real fact rather than missing or a
 * stale first-run placeholder. Split name fields only count as covered when
 * this real assembled identity exists.
 */
function hasPlaceholderAwareFullNameValue(profile: CandidateProfile): boolean {
  return Boolean(
    hasMeaningfulText(profile.fullName) &&
    !hasProfileSetupPlaceholderValue("fullName", profile.fullName),
  );
}

/**
 * A split name field needs its own critical review item when no real assembled
 * full name already carries identity and this field is either missing or only
 * feeds the stale first-run placeholder name.
 */
function needsSplitIdentityNameDraft(
  profile: CandidateProfile,
  partValue: string | null,
): boolean {
  if (hasPlaceholderAwareFullNameValue(profile)) {
    return false;
  }

  return (
    !hasMeaningfulText(partValue) ||
    hasProfileSetupPlaceholderValue("fullName", profile.fullName)
  );
}

function hasDraftForTarget(
  candidateDrafts: readonly DerivedReviewDraft[],
  domain: TargetDomain,
  key?: TargetKey,
): boolean {
  return candidateDrafts.some(
    (draft) =>
      draft.target.domain === domain &&
      (key === undefined || draft.target.key === key),
  );
}

function educationRecordFieldForScalarKey(key: string): string | null {
  const normalizedKey = normalizeText(key).replace(/\s+/g, "");

  switch (normalizedKey) {
    case "institution":
    case "school":
    case "schoolname":
      return "schoolName";
    case "degree":
      return "degree";
    case "field":
    case "fieldofstudy":
      return "fieldOfStudy";
    case "location":
      return "location";
    case "start":
    case "startdate":
      return "startDate";
    case "end":
    case "enddate":
    case "graduationdate":
      return "endDate";
    case "summary":
      return "summary";
    default:
      return null;
  }
}

function isEducationScalarCoveredByRecord(
  candidate: ResumeImportFieldCandidate,
  allCandidates: readonly ResumeImportFieldCandidate[],
): boolean {
  if (
    candidate.target.section !== "education" ||
    candidate.target.key === "record"
  ) {
    return false;
  }

  const recordField = educationRecordFieldForScalarKey(candidate.target.key);
  if (!recordField) {
    return false;
  }

  return allCandidates.some((recordCandidate) => {
    if (
      recordCandidate.runId !== candidate.runId ||
      recordCandidate.target.section !== "education" ||
      recordCandidate.target.key !== "record" ||
      !recordCandidate.value ||
      typeof recordCandidate.value !== "object" ||
      Array.isArray(recordCandidate.value)
    ) {
      return false;
    }

    if (
      candidate.target.recordId &&
      recordCandidate.target.recordId &&
      candidate.target.recordId !== recordCandidate.target.recordId
    ) {
      return false;
    }

    const recordValue = recordCandidate.value[recordField];
    return summarizeValue(recordValue) !== null;
  });
}

function buildMissingFieldDrafts(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidateDrafts: readonly DerivedReviewDraft[],
): DerivedReviewDraft[] {
  const drafts: DerivedReviewDraft[] = [];

  // Canonical readiness requires a real full name assembled from the split
  // name fields, so missing first or last names are critical field-targeted
  // gaps. Separate first and last names let Job Finder prepare profile and
  // application fields; a preferred display name only controls how the app
  // may address or show the person.
  if (
    !hasDraftForTarget(candidateDrafts, "identity", "fullName") &&
    !hasDraftForTarget(candidateDrafts, "identity", "firstName") &&
    needsSplitIdentityNameDraft(profile, profile.firstName)
  ) {
    drafts.push({
      step: "essentials",
      target: { domain: "identity", key: "firstName", recordId: null },
      label: "First name",
      reason:
        "Add your first name so profile and application fields can be prepared correctly; your preferred display name remains how Job Finder addresses you.",
      severity: "critical",
      proposedValue: null,
      sourceSnippet: null,
    });
  }

  if (
    !hasDraftForTarget(candidateDrafts, "identity", "fullName") &&
    !hasDraftForTarget(candidateDrafts, "identity", "lastName") &&
    needsSplitIdentityNameDraft(profile, profile.lastName)
  ) {
    drafts.push({
      step: "essentials",
      target: { domain: "identity", key: "lastName", recordId: null },
      label: "Last name",
      reason:
        "Add your last name so profile and application fields can be prepared correctly; your preferred display name remains how Job Finder addresses you.",
      severity: "critical",
      proposedValue: null,
      sourceSnippet: null,
    });
  }

  if (
    !hasPlaceholderAwareIdentityValue(profile.headline, "headline") &&
    !hasDraftForTarget(candidateDrafts, "identity", "headline")
  ) {
    drafts.push({
      step: "essentials",
      target: { domain: "identity", key: "headline", recordId: null },
      label: "Headline",
      reason:
        "Add a headline so discovery, resume exports, and profile reviews can describe your target focus clearly.",
      severity: "critical",
      proposedValue: null,
      sourceSnippet: null,
    });
  }

  if (
    !hasStatedCurrentLocation(profile) &&
    !hasDraftForTarget(candidateDrafts, "identity", "currentLocation")
  ) {
    drafts.push({
      step: "essentials",
      target: { domain: "identity", key: "currentLocation", recordId: null },
      label: "Location",
      reason:
        "Add your current location so searches and applications can respect where you can realistically work.",
      // Recommended, not blocking: a person who could not get the card to
      // clear was locked out of finishing setup over a field the search
      // plan's own locations already cover.
      severity: "recommended",
      proposedValue: null,
      sourceSnippet: null,
    });
  }

  if (
    (profile.yearsExperience === null || profile.yearsExperience <= 0) &&
    !hasDraftForTarget(candidateDrafts, "identity", "yearsExperience")
  ) {
    // Recommended, never blocking: zero is a true answer for a first job.
    drafts.push({
      step: "essentials",
      target: { domain: "identity", key: "yearsExperience", recordId: null },
      label: "Years of experience",
      reason:
        "Add your years of experience so search results and resumes match your level. Zero is fine if this is your first job.",
      severity: "recommended",
      proposedValue: null,
      sourceSnippet: null,
    });
  }

  if (
    !hasMeaningfulText(profile.email) &&
    !hasMeaningfulText(profile.phone) &&
    !hasDraftForTarget(candidateDrafts, "identity", "email") &&
    !hasDraftForTarget(candidateDrafts, "identity", "phone")
  ) {
    drafts.push({
      step: "essentials",
      target: { domain: "identity", key: "contactPath", recordId: null },
      label: "Contact details",
      reason:
        "Add at least one contact path before applications and recruiter follow-up flows can work reliably.",
      severity: "critical",
      proposedValue: null,
      sourceSnippet: null,
    });
  }

  if (
    !profile.experiences.some(
      (experience) =>
        hasMeaningfulText(experience.companyName) ||
        hasMeaningfulText(experience.title),
    ) &&
    !hasDraftForTarget(candidateDrafts, "experience", "record")
  ) {
    drafts.push({
      step: "background",
      target: { domain: "experience", key: "record", recordId: null },
      label: "Work history",
      reason:
        "Add work history if you have it so resumes and fit scoring can use your background. You can finish setup without a previous role.",
      severity: "recommended",
      proposedValue: null,
      sourceSnippet: null,
    });
  }

  const hasEligibility =
    hasMeaningfulStringList(profile.workEligibility.authorizedWorkCountries) ||
    profile.workEligibility.requiresVisaSponsorship !== null ||
    profile.workEligibility.willingToRelocate !== null ||
    profile.workEligibility.willingToTravel !== null ||
    profile.workEligibility.remoteEligible !== null ||
    profile.workEligibility.noticePeriodDays !== null ||
    hasMeaningfulText(profile.workEligibility.availableStartDate) ||
    hasMeaningfulStringList(searchPreferences.locations) ||
    hasMeaningfulStringList(searchPreferences.workModes);

  if (
    !hasEligibility &&
    !(
      hasDraftForTarget(candidateDrafts, "work_eligibility") ||
      hasDraftForTarget(candidateDrafts, "search_preferences", "locations") ||
      hasDraftForTarget(candidateDrafts, "search_preferences", "workModes")
    )
  ) {
    drafts.push({
      step: "targeting",
      target: {
        domain: "work_eligibility",
        key: "authorizedWorkCountries",
        recordId: null,
      },
      label: "Work eligibility",
      reason:
        "Capture work eligibility or location preferences so discovery and application defaults reflect real constraints.",
      severity: "recommended",
      proposedValue: null,
      sourceSnippet: null,
    });
  }

  return drafts;
}

function reviewIdentityKey(
  item: Pick<ProfileReviewItem, "target" | "label">,
): string {
  return normalizeText(
    `${item.target.domain}|${item.target.key}|${item.target.recordId ?? ""}|${item.label}`,
  );
}

function rebuildResolvedItem(
  item: ProfileReviewItem,
  nextDraft: DerivedReviewDraft,
): ProfileReviewItem {
  return ProfileReviewItemSchema.parse({
    ...item,
    step: nextDraft.step,
    target: nextDraft.target,
    label: nextDraft.label,
    reason: nextDraft.reason,
    severity: nextDraft.severity,
    proposedValue: nextDraft.proposedValue ?? null,
    sourceSnippet: nextDraft.sourceSnippet ?? null,
    sourceCandidateId: nextDraft.sourceCandidateId ?? null,
    sourceRunId: nextDraft.sourceRunId ?? null,
  });
}

function shouldReopenResolvedItem(input: {
  item: ProfileReviewItem;
  draft: DerivedReviewDraft;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
}): boolean {
  const currentValue = getCurrentTargetValue(
    input.profile,
    input.searchPreferences,
    input.draft.target,
  );
  const currentSummary = summarizeValue(currentValue);
  const proposedSummary = input.draft.proposedValue ?? null;
  const previousProposedSummary = input.item.proposedValue ?? null;

  // "Dismiss for now" is checked first. An item offered for a field the person
  // left empty is exactly the item they dismissed, so reopening it because the
  // field is still empty put the card straight back and made the button look
  // like it did nothing. New proposed evidence still reopens it below.
  if (input.item.status === "dismissed" && !proposedSummary) {
    return false;
  }

  if (
    !hasCurrentTargetValue(
      input.profile,
      input.searchPreferences,
      input.draft.target,
    )
  ) {
    return true;
  }

  if (!proposedSummary && !previousProposedSummary) {
    return false;
  }

  if (
    proposedSummary &&
    previousProposedSummary &&
    normalizeText(proposedSummary) === normalizeText(previousProposedSummary)
  ) {
    return false;
  }

  if (
    proposedSummary &&
    currentSummary &&
    normalizeText(proposedSummary) === normalizeText(currentSummary)
  ) {
    return false;
  }

  if (proposedSummary || previousProposedSummary) {
    return true;
  }

  return false;
}

function buildPendingItem(
  draft: DerivedReviewDraft,
  now: string,
): ProfileReviewItem {
  const id = buildExtractionId("profile_setup_review", 0, [
    draft.step,
    draft.target.domain,
    draft.target.key,
    draft.target.recordId,
    draft.label,
  ]);

  return ProfileReviewItemSchema.parse({
    id,
    step: draft.step,
    target: draft.target,
    label: draft.label,
    reason: draft.reason,
    severity: draft.severity,
    status: "pending",
    proposedValue: draft.proposedValue ?? null,
    sourceSnippet: draft.sourceSnippet ?? null,
    sourceCandidateId: draft.sourceCandidateId ?? null,
    sourceRunId: draft.sourceRunId ?? null,
    createdAt: now,
    resolvedAt: null,
  });
}

export function buildProfileSetupReviewItems(
  input: BuildProfileSetupReviewItemsInput,
): ProfileReviewItem[] {
  const readiness = evaluateProfileSetupReadiness(
    input.profile,
    input.searchPreferences,
  );
  const unresolvedCandidateDrafts = input.candidates
    .filter(
      (candidate) =>
        candidate.target.section !== "answer_bank" &&
        (candidate.resolution === "needs_review" ||
          candidate.resolution === "abstained") &&
        shouldIncludeCandidateInSetupReview(candidate) &&
        !isEducationScalarCoveredByRecord(candidate, input.candidates),
    )
    .map((candidate) => toReviewDraft(candidate, input.documentBundle))
    .filter((draft): draft is DerivedReviewDraft => draft !== null)
    .filter(
      (draft) =>
        !isReviewDraftAlreadySatisfied({
          draft,
          profile: input.profile,
          searchPreferences: input.searchPreferences,
        }),
    );
  const missingFieldDrafts =
    readiness.started || unresolvedCandidateDrafts.length > 0
      ? buildMissingFieldDrafts(
          input.profile,
          input.searchPreferences,
          unresolvedCandidateDrafts,
        )
      : [];
  const nextDrafts = [...unresolvedCandidateDrafts, ...missingFieldDrafts];
  const currentItems = input.currentState?.reviewItems ?? [];
  const currentByIdentity = new Map(
    currentItems.map((item) => [reviewIdentityKey(item), item]),
  );
  const seenIdentities = new Set<string>();
  const nextItems: ProfileReviewItem[] = [];

  for (const draft of nextDrafts) {
    const identity = reviewIdentityKey({
      target: draft.target,
      label: draft.label,
    });
    if (seenIdentities.has(identity)) {
      continue;
    }

    seenIdentities.add(identity);
    const existing = currentByIdentity.get(identity);

    if (existing && existing.status !== "pending") {
      if (
        shouldReopenResolvedItem({
          item: existing,
          draft,
          profile: input.profile,
          searchPreferences: input.searchPreferences,
        })
      ) {
        nextItems.push(buildPendingItem(draft, input.now));
        continue;
      }

      nextItems.push(rebuildResolvedItem(existing, draft));
      continue;
    }

    if (existing) {
      nextItems.push(
        resolvePendingItemIfSatisfied({
          item: existing,
          draft,
          now: input.now,
          profile: input.profile,
          searchPreferences: input.searchPreferences,
        }),
      );
      continue;
    }

    nextItems.push(buildPendingItem(draft, input.now));
  }

  for (const item of currentItems) {
    const identity = reviewIdentityKey(item);

    if (seenIdentities.has(identity)) {
      continue;
    }

    if (item.status !== "pending") {
      nextItems.push(item);
      continue;
    }

    if (
      hasCurrentTargetValue(input.profile, input.searchPreferences, item.target)
    ) {
      nextItems.push(
        resolvePendingItemIfSatisfied({
          item,
          draft: {
            step: item.step,
            target: item.target,
            label: item.label,
            reason: item.reason,
            severity: item.severity,
            proposedValue: item.proposedValue,
            sourceSnippet: item.sourceSnippet,
            sourceCandidateId: item.sourceCandidateId,
            sourceRunId: item.sourceRunId,
          },
          now: input.now,
          profile: input.profile,
          searchPreferences: input.searchPreferences,
        }),
      );
    }
  }

  return nextItems.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}
