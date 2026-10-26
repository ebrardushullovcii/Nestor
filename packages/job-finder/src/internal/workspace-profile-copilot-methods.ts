import {
  AiBehaviorPreferenceSchema,
  applyCompensationPreferenceChange,
  CandidateCertificationSchema,
  CandidateEducationSchema,
  CandidateExperienceSchema,
  CandidateLanguageSchema,
  CandidateLinkSchema,
  CandidateProfileSchema,
  CandidateProjectSchema,
  CandidateProofBankEntrySchema,
  JobSearchPreferencesSchema,
  ProfileCopilotPatchGroupSchema,
  ProfileSetupStateSchema,
  type CandidateProfile,
  type JobSearchPreferences,
  type ProfileCopilotContext,
  type ProfileCopilotRelevantReviewItem,
  type ProfileCopilotMessage,
  type ProfileCopilotPatchGroup,
  type ProfileRevision,
  type ProfileSetupState,
  type ProfileCopilotPatchOperation,
  type ResumeApplicationMode,
  type ResumeApproach,
  type TailoringMode,
} from "@nestor/contracts";

import type { ReviseCandidateProfileConversationTurn } from "@nestor/ai-providers";

import { resolvePendingReviewItemsAfterExplicitSave } from "./profile-setup-review-items";
import { deriveAndPersistProfileSetupState } from "./profile-workspace-state";
import {
  commitProfileCopilotStateWithStaleRetry,
  type CommitProfileCopilotStateInput,
} from "./profile-commit-stale-conflict";
import { followPrimaryContacts } from "@nestor/contracts";
import {
  MIRRORED_PROFILE_LIST_FIELDS,
  mergeMirroredListHalves,
  mirrorProfileListEdits,
  type MirroredProfileListField,
} from "./profile-copilot-mirrored-lists";
import { hasResumeAffectingProfileChange } from "./resume-workspace-staleness";
import {
  areEquivalentEducationRecords,
  areEquivalentExperienceRecords,
} from "./resume-record-identity";
import { createUniqueId } from "./shared";
import { normalizeSearchPreferences } from "./workspace-helpers";
import type { WorkspaceServiceContext } from "./workspace-service-context";

function isSearchPreferencesPatchSafeForAutoApply(
  value: Extract<
    ProfileCopilotPatchGroup["operations"][number],
    { operation: "replace_search_preferences_fields" }
  >["value"],
): boolean {
  // `tailoringMode` is not here: it is half of the resume level, which also
  // moves a person off Original in Settings, so it waits for review exactly
  // like `set_resume_approach`.
  const safeScalarFields = new Set([
    "minimumSalaryUsd",
    "salaryCurrency",
    "targetSalaryUsd",
  ]);

  const currencyIsValid =
    value.salaryCurrency === undefined ||
    value.salaryCurrency === null ||
    /^[A-Z]{3}$/.test(value.salaryCurrency.trim().toUpperCase());
  const salaryValuesAreValid = [value.minimumSalaryUsd, value.targetSalaryUsd]
    .filter((entry): entry is number => entry !== undefined && entry !== null)
    .every((entry) => Number.isInteger(entry) && entry >= 0);

  return (
    currencyIsValid &&
    salaryValuesAreValid &&
    Object.keys(value).every((key) => safeScalarFields.has(key))
  );
}

function isCompensationPatchSafeForAutoApply(
  value: Extract<
    ProfileCopilotPatchGroup["operations"][number],
    { operation: "replace_compensation_preferences_fields" }
  >["value"],
): boolean {
  const amountsAreValid = [value.minimum, value.maximum]
    .filter((entry): entry is number => entry !== undefined && entry !== null)
    .every((entry) => Number.isInteger(entry) && entry >= 0);
  const currencyIsComparable =
    value.currencyStatus !== "needs_clarification" &&
    value.currency !== null &&
    value.currency !== undefined &&
    /^[A-Z]{3}$/.test(value.currency);

  return amountsAreValid && currencyIsComparable;
}

function hasValidPatchValues(patchGroup: ProfileCopilotPatchGroup): boolean {
  return patchGroup.operations.every((operation) => {
    if (operation.operation !== "replace_search_preferences_fields") {
      if (operation.operation !== "replace_compensation_preferences_fields") {
        return true;
      }

      return [operation.value.minimum, operation.value.maximum]
        .filter(
          (entry): entry is number => entry !== undefined && entry !== null,
        )
        .every((entry) => Number.isInteger(entry) && entry >= 0);
    }

    const currencyIsValid =
      operation.value.salaryCurrency === undefined ||
      operation.value.salaryCurrency === null ||
      /^[A-Z]{3}$/.test(operation.value.salaryCurrency.trim().toUpperCase());
    const salaryValuesAreValid = [
      operation.value.minimumSalaryUsd,
      operation.value.targetSalaryUsd,
    ]
      .filter((entry): entry is number => entry !== undefined && entry !== null)
      .every((entry) => Number.isInteger(entry) && entry >= 0);

    return currencyIsValid && salaryValuesAreValid;
  });
}

function isPatchGroupSafeForAutoApply(
  patchGroup: ProfileCopilotPatchGroup,
): boolean {
  return patchGroup.operations.every((operation) => {
    if (operation.operation === "replace_search_preferences_fields") {
      return isSearchPreferencesPatchSafeForAutoApply(operation.value);
    }

    if (operation.operation === "replace_compensation_preferences_fields") {
      return isCompensationPatchSafeForAutoApply(operation.value);
    }

    return (
      operation.operation === "replace_identity_fields" ||
      operation.operation === "replace_profile_list_fields" ||
      operation.operation === "replace_work_eligibility_fields" ||
      operation.operation === "replace_professional_summary_fields" ||
      operation.operation === "replace_narrative_fields" ||
      operation.operation === "replace_application_identity_fields" ||
      operation.operation === "replace_skill_group_fields" ||
      operation.operation === "resolve_review_items"
    );
  });
}

function describeCopilotContext(context: ProfileCopilotContext): string {
  if (context.surface === "setup") {
    return `setup ${context.step.replaceAll("_", " ")}`;
  }

  if (context.surface === "profile") {
    return `${context.section} profile section`;
  }

  return "profile";
}

function formatPatchGroupSummaryList(
  patchGroups: readonly ProfileCopilotPatchGroup[],
): string {
  const summaries = patchGroups
    .slice(0, 2)
    .map((patchGroup) => patchGroup.summary);

  if (summaries.length === 0) {
    return "";
  }

  if (patchGroups.length > summaries.length) {
    return `${summaries.join(" and ")} and ${patchGroups.length - summaries.length} more`;
  }

  return summaries.join(" and ");
}

function findUniqueProfileCopilotPatchGroup(
  messages: readonly ProfileCopilotMessage[],
  patchGroupId: string,
): {
  message: ProfileCopilotMessage;
  patchGroup: ProfileCopilotPatchGroup;
} | null {
  let match: {
    message: ProfileCopilotMessage;
    patchGroup: ProfileCopilotPatchGroup;
  } | null = null;

  for (const message of messages) {
    for (const patchGroup of message.patchGroups) {
      if (patchGroup.id !== patchGroupId) {
        continue;
      }

      if (match) {
        // Legacy provider IDs may have been persisted more than once. A
        // caller that has only the group ID must never silently apply the
        // oldest matching proposal.
        return null;
      }

      match = { message, patchGroup };
    }
  }

  return match;
}

/** JSON with object keys sorted, so key order never makes two equal values differ. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A tailoring strength inside a preferences change is the resume level,
 * which Settings owns together with Original. The model often repeats the
 * saved strength beside an unrelated edit ("add Staff Designer" plus
 * `tailoringMode: balanced`); applied as written, that moved a person off
 * Original with no word on the card. An unchanged strength is dropped. A
 * changed one becomes the explicit `set_resume_approach`, so its card names
 * the level and it waits for review. An explicit level in the same group wins.
 */
export function routeTailoringModeThroughResumeApproach(
  operations: readonly ProfileCopilotPatchOperation[],
  savedTailoringMode: TailoringMode,
): ProfileCopilotPatchOperation[] {
  const hasExplicitLevel = operations.some(
    (operation) => operation.operation === "set_resume_approach",
  );
  const routed: ProfileCopilotPatchOperation[] = [];
  let requestedStrength: TailoringMode | null = null;
  for (const operation of operations) {
    if (
      operation.operation !== "replace_search_preferences_fields" ||
      operation.value.tailoringMode === undefined
    ) {
      routed.push(operation);
      continue;
    }
    const { tailoringMode, ...otherFields } = operation.value;
    if (tailoringMode !== savedTailoringMode) {
      requestedStrength = tailoringMode;
    }
    if (
      Object.values(otherFields).some((fieldValue) => fieldValue !== undefined)
    ) {
      routed.push({ ...operation, value: otherFields });
    }
  }
  if (requestedStrength && !hasExplicitLevel) {
    routed.push({ operation: "set_resume_approach", value: requestedStrength });
  }
  return routed;
}

function normalizeAssistantPatchGroups(input: {
  patchGroups: readonly ProfileCopilotPatchGroup[];
  context: ProfileCopilotContext;
  content: string;
  assistantMessageId: string;
  savedTailoringMode: TailoringMode;
  /** The saved copies of target roles and locations the reply edits. */
  lists: {
    profile: Pick<CandidateProfile, MirroredProfileListField>;
    searchPreferences: Pick<JobSearchPreferences, MirroredProfileListField>;
  };
}): {
  patchGroups: ProfileCopilotPatchGroup[];
  content: string;
} {
  // Groups left with nothing to change (only a repeated strength) are gone,
  // and so is a group that repeats an earlier one in the same reply: the
  // model sometimes calls the same tool twice, and a built-app run showed
  // five cards for "add a target role", two of them exact copies.
  const seenOperations = new Set<string>();
  const routedPatchGroups = input.patchGroups.flatMap((patchGroup) => {
    const operations = routeTailoringModeThroughResumeApproach(
      patchGroup.operations,
      input.savedTailoringMode,
    );
    const operationsKey = stableStringify(operations);
    if (operations.length === 0 || seenOperations.has(operationsKey)) {
      return [];
    }
    seenOperations.add(operationsKey);
    return [{ original: patchGroup, routed: { ...patchGroup, operations } }];
  });
  // The same target-role or location change proposed once per stored copy
  // is one card; the other copy follows when it is applied.
  const mergedPatchGroups = mergeMirroredListHalves(
    routedPatchGroups.map((entry) => ({
      operations: entry.routed.operations,
      summary: entry.routed.summary,
      entry,
    })),
    input.lists,
  ).map(({ summary, entry }) => ({
    original: entry.original,
    routed: { ...entry.routed, summary },
  }));
  const normalizedPatchGroups = mergedPatchGroups.map(({ routed }, index) => {
    const parsedPatchGroup = ProfileCopilotPatchGroupSchema.parse(routed);
    const normalizedPatchGroup = ProfileCopilotPatchGroupSchema.parse({
      ...parsedPatchGroup,
      // Provider-generated IDs are only proposal-local and may repeat on a
      // later response. Persist an identity owned by this assistant message
      // so the renderer can safely carry it across apply/reject/undo flows.
      id: `${input.assistantMessageId}_patch_${index + 1}`,
    });

    if (
      normalizedPatchGroup.applyMode === "applied" &&
      !isPatchGroupSafeForAutoApply(normalizedPatchGroup)
    ) {
      return {
        ...normalizedPatchGroup,
        applyMode: "needs_review",
      } satisfies ProfileCopilotPatchGroup;
    }

    return normalizedPatchGroup;
  });

  const downgradedPatchGroups = normalizedPatchGroups.filter(
    (patchGroup, index) => {
      const originalPatchGroup = mergedPatchGroups[index]?.original;
      return (
        originalPatchGroup?.applyMode === "applied" &&
        patchGroup.applyMode === "needs_review"
      );
    },
  );

  if (downgradedPatchGroups.length === 0) {
    return {
      patchGroups: normalizedPatchGroups,
      content: input.content,
    };
  }

  const contextLabel = describeCopilotContext(input.context);
  const downgradedSummary = formatPatchGroupSummaryList(downgradedPatchGroups);
  const downgradedSuffix = downgradedSummary ? `: ${downgradedSummary}.` : ".";
  const appliedCount = normalizedPatchGroups.filter(
    (patchGroup) => patchGroup.applyMode === "applied",
  ).length;

  return {
    patchGroups: normalizedPatchGroups,
    content:
      appliedCount > 0
        ? `I applied the safest changes automatically and left higher-risk edits for review in the ${contextLabel} context${downgradedSuffix}`
        : `I prepared higher-risk edits for review in the ${contextLabel} context instead of auto-applying them${downgradedSuffix}`,
  };
}

function getStoredPatchGroupApplyMode(
  patchGroup: ProfileCopilotPatchGroup,
): ProfileCopilotPatchGroup["applyMode"] {
  return patchGroup.applyMode === "applied"
    ? "needs_review"
    : patchGroup.applyMode;
}

function setPatchGroupApplyMode(
  patchGroup: ProfileCopilotPatchGroup,
  applyMode: ProfileCopilotPatchGroup["applyMode"],
): ProfileCopilotPatchGroup {
  return {
    ...patchGroup,
    applyMode,
  };
}

function formatCopilotFactLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function isBasicsSectionItem(item: ProfileCopilotRelevantReviewItem): boolean {
  return (
    item.target.domain === "identity" ||
    item.target.domain === "professional_summary"
  );
}

function isExperienceSectionItem(
  item: ProfileCopilotRelevantReviewItem,
): boolean {
  return item.target.domain === "experience";
}

function isBackgroundSectionItem(
  item: ProfileCopilotRelevantReviewItem,
): boolean {
  return [
    "education",
    "certification",
    "project",
    "link",
    "language",
    "proof_point",
  ].includes(item.target.domain);
}

function isPreferencesSectionItem(
  item: ProfileCopilotRelevantReviewItem,
): boolean {
  return [
    "search_preferences",
    "work_eligibility",
    "application_identity",
  ].includes(item.target.domain);
}

function filterRelevantReviewItemsForContext(input: {
  context: ProfileCopilotContext;
  reviewItems: ProfileSetupState["reviewItems"];
}): ProfileCopilotRelevantReviewItem[] {
  const { context, reviewItems } = input;

  if (context.surface === "setup") {
    return reviewItems.filter((item) => item.step === context.step);
  }

  if (context.surface === "profile") {
    switch (context.section) {
      case "basics":
        return reviewItems.filter(isBasicsSectionItem);
      case "experience":
        return reviewItems.filter(isExperienceSectionItem);
      case "background":
        return reviewItems.filter(isBackgroundSectionItem);
      case "preferences":
        return reviewItems.filter(isPreferencesSectionItem);
    }
  }

  return reviewItems.filter((item) => item.status === "pending");
}

/** The resume level Settings shows, from its two stored halves. */
export function resolveSavedResumeApproach(input: {
  resumeApplicationMode: ResumeApplicationMode | null | undefined;
  tailoringMode: JobSearchPreferences["tailoringMode"];
}): ResumeApproach {
  return input.resumeApplicationMode === "original_resume"
    ? "original_resume"
    : input.tailoringMode;
}

const RESUME_APPROACH_FACT: Record<ResumeApproach, string> = {
  original_resume:
    "Resume level for new jobs (Settings): Original. Applications send the imported resume file unchanged; nothing in it can be edited.",
  conservative:
    "Resume level for new jobs (Settings): Light. Job Finder writes an editable resume for each job with small edits.",
  balanced:
    "Resume level for new jobs (Settings): Tailored. Job Finder writes an editable resume for each job with a fuller rewrite.",
  aggressive:
    "Resume level for new jobs (Settings): Aggressive. Job Finder writes an editable resume for each job that may stretch, with the person's confirmation.",
};

/**
 * The Settings half of the resume level a patch group leaves behind, or null
 * when it leaves `settings.resumeApplicationMode` alone. A tailoring strength
 * chosen while the person is on Original moves them off it: asking for Light
 * means a written resume, and changing only the strength left Settings on
 * Original while the Assistant said the change was made. The saved strength
 * repeated beside another edit is not a choice and keeps Original; new
 * replies drop it before they are stored, and this covers cards saved
 * earlier.
 */
export function resolveResumeApplicationModeAfterPatchGroup(
  patchGroup: Pick<ProfileCopilotPatchGroup, "operations">,
  current: ResumeApplicationMode,
  savedTailoringMode: TailoringMode,
): ResumeApplicationMode | null {
  let next: ResumeApplicationMode = current;
  for (const operation of patchGroup.operations) {
    if (operation.operation === "set_resume_approach") {
      next =
        operation.value === "original_resume"
          ? "original_resume"
          : "tailored_per_job";
    } else if (
      operation.operation === "replace_search_preferences_fields" &&
      operation.value.tailoringMode !== undefined &&
      operation.value.tailoringMode !== savedTailoringMode &&
      next === "original_resume"
    ) {
      next = "tailored_per_job";
    }
  }
  return next === current ? null : next;
}

function buildConversationFacts(input: {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  relevantReviewItems: readonly ProfileCopilotRelevantReviewItem[];
  resumeApproach?: ResumeApproach;
}): string[] {
  const facts: string[] = [];

  if (input.resumeApproach) {
    facts.push(RESUME_APPROACH_FACT[input.resumeApproach]);
  }

  if (input.profile.headline?.trim()) {
    facts.push(`Headline: ${input.profile.headline.trim()}`);
  }

  if (input.profile.currentLocation?.trim()) {
    facts.push(`Location: ${input.profile.currentLocation.trim()}`);
  }

  const compensation = input.searchPreferences.compensation;
  if (compensation.minimum !== null || compensation.maximum !== null) {
    facts.push(
      `Compensation preference: ${compensation.minimum ?? "unset"} to ${compensation.maximum ?? "unset"} per ${compensation.interval} | currency: ${compensation.currency ?? "unset"} | currency status: ${compensation.currencyStatus}`,
    );
  }

  input.profile.experiences.slice(0, 6).forEach((experience) => {
    const company = experience.companyName ?? "Unknown company";
    const title = experience.title ?? "Unknown title";
    const startDate = experience.startDate ?? "unknown start";
    const endDate = experience.isCurrent
      ? "present"
      : (experience.endDate ?? "unknown end");
    const workMode =
      experience.workMode.length > 0
        ? experience.workMode.map(formatCopilotFactLabel).join(", ")
        : "not set";
    facts.push(
      `Experience: ${title} at ${company} (${startDate} to ${endDate}) | work mode: ${workMode}`,
    );
  });

  input.relevantReviewItems.slice(0, 6).forEach((item) => {
    facts.push(
      `Review item: ${item.label} | status: ${item.status} | step: ${item.step}${item.proposedValue ? ` | proposed: ${item.proposedValue}` : ""}`,
    );
  });

  return facts;
}

export function buildProfileRevision(input: {
  trigger: ProfileRevision["trigger"];
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  profileSetupState: ProfileSetupState;
  /** State the change left behind; see `snapshotProfileAfter`. */
  profileAfter?: CandidateProfile | null;
  searchPreferencesAfter?: JobSearchPreferences | null;
  /** `settings.resumeApplicationMode` around this change, when it moved. */
  resumeApplicationMode?: ResumeApplicationMode | null;
  resumeApplicationModeAfter?: ResumeApplicationMode | null;
  /** Monotonic position in the log; see `sequence`. */
  sequence: number;
  reason?: string | null;
  messageId?: string | null;
  patchGroupId?: string | null;
  restoredFromRevisionId?: string | null;
}): ProfileRevision {
  return {
    id: createUniqueId("profile_revision"),
    sequence: input.sequence,
    createdAt: new Date().toISOString(),
    reason: input.reason ?? null,
    trigger: input.trigger,
    messageId: input.messageId ?? null,
    patchGroupId: input.patchGroupId ?? null,
    restoredFromRevisionId: input.restoredFromRevisionId ?? null,
    snapshotProfile: CandidateProfileSchema.parse(input.profile),
    snapshotSearchPreferences: JobSearchPreferencesSchema.parse(
      input.searchPreferences,
    ),
    snapshotProfileSetupState: ProfileSetupStateSchema.parse(
      input.profileSetupState,
    ),
    snapshotProfileAfter: input.profileAfter
      ? CandidateProfileSchema.parse(input.profileAfter)
      : null,
    snapshotSearchPreferencesAfter: input.searchPreferencesAfter
      ? JobSearchPreferencesSchema.parse(input.searchPreferencesAfter)
      : null,
    snapshotResumeApplicationMode: input.resumeApplicationMode ?? null,
    snapshotResumeApplicationModeAfter:
      input.resumeApplicationModeAfter ?? null,
  };
}

/**
 * The next free position in the revision log.
 *
 * Ids alone cannot order two revisions written in the same millisecond, and
 * "undo back to here" needs an order it can trust.
 */
export function nextProfileRevisionSequence(
  revisions: readonly ProfileRevision[],
): number {
  let highest = 0;
  for (const revision of revisions) {
    if (revision.sequence > highest) {
      highest = revision.sequence;
    }
  }

  return highest + 1;
}

/**
 * Plain-language names of the top-level fields that differ.
 *
 * Used to tell a person which of their own edits an undo would have thrown
 * away, by name, instead of refusing without saying why.
 */
function collectChangedFieldLabels(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const labels: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      labels.push(
        key
          .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
          .replace(/_/gu, " ")
          .toLowerCase(),
      );
    }
  }

  return labels.sort();
}

/**
 * Fields a person changed by hand after the assistant last wrote.
 *
 * The log stores what each assistant change left behind, so anything that
 * differs between that and the state the next change found was written by
 * somebody other than the assistant.
 */
function collectManualEditsAfterRevision(input: {
  currentProfile: CandidateProfile;
  currentSearchPreferences: JobSearchPreferences;
  /** Newest first, exactly as the repository returns them. */
  revisionsNewestFirst: readonly ProfileRevision[];
  fromSequence: number;
}): string[] {
  const labels = new Set<string>();
  const ordered = [...input.revisionsNewestFirst]
    .filter((revision) => revision.sequence >= input.fromSequence)
    .sort((left, right) => left.sequence - right.sequence);

  for (const [index, revision] of ordered.entries()) {
    if (!revision.snapshotProfileAfter) {
      // Recorded before the after-state existed: nothing can be compared, so
      // this gap is left uncounted rather than reported as a manual edit.
      continue;
    }

    const next = ordered[index + 1];
    const nextProfile = next?.snapshotProfile ?? input.currentProfile;
    const nextSearchPreferences =
      next?.snapshotSearchPreferences ?? input.currentSearchPreferences;

    for (const label of collectChangedFieldLabels(
      revision.snapshotProfileAfter,
      nextProfile,
    )) {
      labels.add(label);
    }

    if (revision.snapshotSearchPreferencesAfter) {
      for (const label of collectChangedFieldLabels(
        revision.snapshotSearchPreferencesAfter,
        nextSearchPreferences,
      )) {
        labels.add(label);
      }
    }
  }

  return [...labels].sort();
}

type RecordPatch<TRecord extends { id: string }> = {
  [TKey in keyof Omit<TRecord, "id">]?: TRecord[TKey] | undefined;
} & { id: string };

/**
 * A role the Assistant adds goes where it belongs in time. Appended, the
 * newest job from a split ("Senior Backend Engineer from 2023") sat below a
 * 2015 internship. Only a list that already runs newest first is reordered,
 * and only the new card moves.
 */
export function placeNewExperiencesByDate<
  TRecord extends { id: string; startDate?: string | null },
>(before: readonly TRecord[], after: readonly TRecord[]): TRecord[] {
  const beforeIds = new Set(before.map((entry) => entry.id));
  const added = after.filter((entry) => !beforeIds.has(entry.id));
  const kept = after.filter((entry) => beforeIds.has(entry.id));
  if (added.length === 0) {
    return [...after];
  }
  const startOf = (entry: TRecord) => entry.startDate?.trim() || null;
  const datedKept = kept.map(startOf).filter((date): date is string => !!date);
  const newestFirst = datedKept.every(
    (date, index) => index === 0 || (datedKept[index - 1] ?? "") >= date,
  );
  if (!newestFirst) {
    return [...after];
  }
  const next = [...kept];
  for (const entry of added) {
    const start = startOf(entry);
    const index = start
      ? next.findIndex((existing) => {
          const existingStart = startOf(existing);
          return existingStart !== null && existingStart < start;
        })
      : -1;
    if (index === -1) {
      next.push(entry);
    } else {
      next.splice(index, 0, entry);
    }
  }
  return next;
}

function replaceOrInsertRecord<TRecord extends { id: string }>(
  records: readonly TRecord[],
  record: RecordPatch<TRecord>,
  materializeRecord: (incoming: RecordPatch<TRecord>) => TRecord,
  isSameRecord?: (existing: TRecord, incoming: RecordPatch<TRecord>) => boolean,
): TRecord[] {
  const existingIndex = records.findIndex((entry) => entry.id === record.id);

  if (existingIndex >= 0) {
    const existing = records[existingIndex] as TRecord;
    const next = [...records];
    next[existingIndex] = mergeRecordIntoExisting(existing, record);
    return next;
  }

  // The assistant usually describes the record it means ("my Marketing
  // Manager role") instead of quoting its id. Matching on identity fields
  // turns "add the company to that role" into an edit of the existing card
  // rather than a second card beside it.
  const equivalentIndex = isSameRecord
    ? records.findIndex((entry) => isSameRecord(entry, record))
    : -1;
  if (equivalentIndex >= 0) {
    const existing = records[equivalentIndex] as TRecord;
    const next = [...records];
    next[equivalentIndex] = mergeRecordIntoExisting(existing, record);
    return next;
  }

  return [...records, materializeRecord(record)];
}

/**
 * Omitted fields keep the value already on the card. Explicit nulls, empty
 * lists, and booleans win, so the assistant can clear a location or remove
 * the final bullet without disturbing unrelated fields.
 */
function mergeRecordIntoExisting<TRecord extends { id: string }>(
  existing: TRecord,
  incoming: RecordPatch<TRecord>,
): TRecord {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(
    incoming as Record<string, unknown>,
  )) {
    if (key === "id") {
      continue;
    }
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as TRecord;
}

function removeRecord<TRecord extends { id: string }>(
  records: readonly TRecord[],
  recordId: string,
): TRecord[] {
  return records.filter((entry) => entry.id !== recordId);
}

function reorderRecords<TRecord extends { id: string }>(
  records: readonly TRecord[],
  orderedRecordIds: readonly string[],
): TRecord[] {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  if (
    orderedRecordIds.length !== records.length ||
    orderedRecordIds.some((recordId) => !recordsById.has(recordId))
  ) {
    throw new Error(
      "The education order must name every saved education card once.",
    );
  }
  return orderedRecordIds.map((recordId) => recordsById.get(recordId)!);
}

/** What an applied patch group found and left behind. */
export interface AppliedProfilePatchGroup {
  profileBefore: CandidateProfile;
  searchPreferencesBefore: JobSearchPreferences;
  profileAfter: CandidateProfile;
  searchPreferencesAfter: JobSearchPreferences;
  resumeApplicationMode: {
    before: ResumeApplicationMode | null;
    after: ResumeApplicationMode;
  } | null;
}

export const PROFILE_ASSISTANT_UNAVAILABLE_MESSAGE =
  "The Assistant's AI provider is unavailable right now, so nothing was changed. Your question is kept; ask it again in a moment.";

/** Placeholder the agent runtime starts from before the model writes anything. */
const UNWRITTEN_ASSISTANT_CONTENT =
  /^I need to inspect the saved profile before proposing a change\.?$/i;

/**
 * The words shown with a reply.
 *
 * What the model wrote is kept: it is where the Assistant asks for a fact it
 * needs or says what it could not do. Replacing it with the list of proposal
 * titles (already on the cards below the reply) hid exactly that, so a reply
 * could drop half of what was asked without a word.
 *
 * Text the model did not write is not trusted to describe a proposal: the
 * built-in editor says "I applied one safe change" in its own mode, which is
 * false while the change waits for Apply & save. Such a reply, or one with no
 * words at all, is described from the proposals themselves.
 */
export function buildAssistantReplyContent(input: {
  content: string;
  patchGroups: readonly ProfileCopilotPatchGroup[];
  proposalsWaitForReview: boolean;
  modelUnavailable: boolean;
  /** The model wrote `content`; false for the built-in editor or a stub. */
  writtenByModel: boolean;
  /**
   * The model's run stopped before it finished (it circled or ran out of
   * turns), and the cards are what it had prepared by then.
   */
  stoppedBeforeFinishing?: boolean;
}): string {
  const written = input.content.trim();
  const hasWrittenContent =
    written.length > 0 && !UNWRITTEN_ASSISTANT_CONTENT.test(written);
  const proposalCount = input.patchGroups.length;
  const waitsForReview = input.proposalsWaitForReview && proposalCount > 0;
  const outageNote = input.modelUnavailable
    ? "The AI did not answer, so Job Finder's built-in editor prepared this."
    : null;
  const describedProposals =
    proposalCount > 0
      ? `I prepared ${proposalCount === 1 ? "this change" : `${proposalCount} changes`}${waitsForReview ? " for your review" : ""}: ${input.patchGroups.map((patchGroup) => patchGroup.summary).join("; ")}.`
      : null;
  const keepWritten =
    hasWrittenContent && (input.writtenByModel || !waitsForReview);
  const body = keepWritten ? written : (describedProposals ?? written);
  // The proposal card carries Apply & save; the Profile chat hides this
  // sentence whenever the cards are shown, and every other reader of the
  // message still learns that nothing changed.
  const reviewNote =
    waitsForReview && !/nothing changed yet/i.test(body)
      ? "Nothing changed yet."
      : null;
  // Kept cards from a run that stopped early may cover only part of what
  // was asked; the person hears that instead of assuming it is all there.
  const unfinishedNote =
    input.stoppedBeforeFinishing && proposalCount > 0
      ? "I stopped before finishing every step, so check that these cards cover all of your request."
      : null;
  return [outageNote, body, unfinishedNote, reviewNote]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ");
}

/**
 * Changes the person already applied or turned down, from the whole chat.
 * Asked "what is weak here" after removing a skill, the Assistant offered to
 * add that skill back: the removal had scrolled out of the recent turns.
 */
export function buildPersonDecisionFacts(
  messages: readonly ProfileCopilotMessage[],
  limit = 20,
): string[] {
  return messages
    .flatMap((message) => message.patchGroups)
    .filter(
      (patchGroup) =>
        patchGroup.applyMode === "applied" ||
        patchGroup.applyMode === "rejected",
    )
    .slice(-limit)
    .map((patchGroup) =>
      patchGroup.applyMode === "applied"
        ? `The person applied: ${patchGroup.summary}. Do not propose undoing it unless they ask.`
        : `The person turned down: ${patchGroup.summary}. Do not propose it again unless they ask.`,
    );
}

/**
 * The last few turns in this conversation, so "fix it", "do the second one",
 * or "yes" refer to what the Assistant just said or proposed. The model sees
 * no transcript otherwise; each turn used to start from nothing.
 */
export function buildRecentConversation(
  messages: readonly ProfileCopilotMessage[],
  limit = 8,
): ReviseCandidateProfileConversationTurn[] {
  return messages.slice(-limit).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 2_000),
    proposals: message.patchGroups.map((patchGroup) => ({
      summary: patchGroup.summary,
      status:
        patchGroup.applyMode === "applied"
          ? "applied"
          : patchGroup.applyMode === "rejected"
            ? "rejected"
            : "waiting_for_review",
    })),
  }));
}

export function createWorkspaceProfileCopilotMethods(input: {
  ctx: WorkspaceServiceContext;
  getCurrentSetupStateContext: () => Promise<{
    profile: CandidateProfile;
    searchPreferences: JobSearchPreferences;
    profileSetupState: ProfileSetupState;
    latestResumeImportRun: Awaited<
      ReturnType<
        WorkspaceServiceContext["repository"]["getLatestResumeImportRun"]
      >
    >;
    latestResumeImportAllCandidates: Awaited<
      ReturnType<
        WorkspaceServiceContext["repository"]["listResumeImportFieldCandidates"]
      >
    >;
  }>;
  getWorkspaceSnapshot: () => Promise<
    Awaited<ReturnType<WorkspaceServiceContext["getWorkspaceSnapshot"]>>
  >;
  /**
   * Writes the Settings half of the resume level exactly as Settings does,
   * so a job already on Shortlisted keeps the level it was given.
   */
  commitResumeApplicationMode: (mode: ResumeApplicationMode) => Promise<void>;
}) {
  const {
    commitResumeApplicationMode,
    ctx,
    getCurrentSetupStateContext,
    getWorkspaceSnapshot,
  } = input;

  async function persistProfileCopilotMessage(
    content: string,
    context: ProfileCopilotContext,
    autoApplySafeGroups: boolean,
  ) {
    const { profile, searchPreferences, profileSetupState } =
      await getCurrentSetupStateContext();
    const existingMessages = await ctx.repository.listProfileCopilotMessages();
    const contextKey = JSON.stringify(context);
    const messagesInContext = existingMessages.filter(
      (message) => JSON.stringify(message.context) === contextKey,
    );
    const lastInContext = messagesInContext.at(-1) ?? null;
    // Asking again after the app closed mid-answer, or after the AI did not
    // answer, answers the question already on screen instead of adding it a
    // second time.
    const unansweredRepeat =
      lastInContext?.role === "user" &&
      lastInContext.content.trim() === content.trim()
        ? lastInContext
        : null;
    const userMessage: ProfileCopilotMessage = unansweredRepeat ?? {
      id: createUniqueId("profile_copilot_user_message"),
      role: "user",
      content,
      context,
      patchGroups: [],
      createdAt: new Date().toISOString(),
    };
    // Saved before the model is asked, so closing the app mid-answer keeps
    // the question and the Assistant can offer to ask it again.
    if (!unansweredRepeat) {
      await ctx.repository.upsertProfileCopilotMessage(userMessage);
    }
    const relevantReviewItems = filterRelevantReviewItemsForContext({
      context,
      reviewItems: profileSetupState.reviewItems,
    });
    const settings = await ctx.repository.getSettings();
    // Original lives in Settings, not in the preferences the Assistant reads.
    // Without it the Assistant told a person on Original "you're already on
    // Light" and could not move them either way.
    const resumeApproach = resolveSavedResumeApproach({
      resumeApplicationMode: settings.resumeApplicationMode,
      tailoringMode: searchPreferences.tailoringMode,
    });
    const assistantReply = await ctx.aiClient.reviseCandidateProfile({
      profile,
      searchPreferences,
      context,
      relevantReviewItems,
      request: content,
      assistantBehavior: AiBehaviorPreferenceSchema.parse(
        settings.aiBehavior ?? {},
      ).profileAssistant,
      resumeApproach,
      conversationFacts: [
        ...buildConversationFacts({
          profile,
          searchPreferences,
          relevantReviewItems,
          resumeApproach,
        }),
        ...buildPersonDecisionFacts(existingMessages),
      ],
      // One chat panel shows every step or tab of its surface, so "fix it"
      // on Work history can refer to what was said on Basics.
      recentConversation: buildRecentConversation(
        existingMessages.filter(
          (message) =>
            message.context.surface === context.surface &&
            message.id !== userMessage.id,
        ),
      ),
    });
    const modelUnavailable =
      assistantReply.executionReceipt?.fallbackUsed === true &&
      assistantReply.executionReceipt.stopReason === "permanent_failure";
    if (modelUnavailable && assistantReply.patchGroups.length === 0) {
      // Nothing useful came back, so nothing is recorded as an answer: the
      // question stays on screen unanswered with Ask again under it. The
      // renderer states the outage in plain words.
      throw new Error(PROFILE_ASSISTANT_UNAVAILABLE_MESSAGE);
    }
    const assistantMessageId = createUniqueId(
      "profile_copilot_assistant_message",
    );
    const normalizedAssistantReply = normalizeAssistantPatchGroups({
      patchGroups: assistantReply.patchGroups,
      context,
      content: assistantReply.content,
      assistantMessageId,
      savedTailoringMode: searchPreferences.tailoringMode,
      lists: { profile, searchPreferences },
    });
    const assistantContent = buildAssistantReplyContent({
      content: normalizedAssistantReply.content,
      patchGroups: normalizedAssistantReply.patchGroups,
      proposalsWaitForReview: !autoApplySafeGroups,
      modelUnavailable,
      writtenByModel:
        assistantReply.executionReceipt !== null &&
        assistantReply.executionReceipt !== undefined &&
        assistantReply.executionReceipt.fallbackUsed === false,
      stoppedBeforeFinishing:
        assistantReply.executionReceipt?.fallbackUsed === false &&
        assistantReply.executionReceipt.stopReason !== "completed",
    });
    const assistantMessage: ProfileCopilotMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: assistantContent,
      context,
      patchGroups: normalizedAssistantReply.patchGroups.map((patchGroup) => {
        const storedMode = getStoredPatchGroupApplyMode(patchGroup);
        return setPatchGroupApplyMode(
          patchGroup,
          autoApplySafeGroups ? storedMode : "needs_review",
        );
      }),
      executionAttribution: assistantReply.executionReceipt ?? null,
      // Always after the question, even when a built-in reply lands in the
      // same millisecond: the list sorts by time, then by id, and the
      // assistant's id sorted ahead of the person's.
      createdAt: new Date(
        Math.max(Date.now(), Date.parse(userMessage.createdAt) + 1),
      ).toISOString(),
    };

    await ctx.repository.upsertProfileCopilotMessage(assistantMessage);

    for (const patchGroup of normalizedAssistantReply.patchGroups) {
      if (autoApplySafeGroups && patchGroup.applyMode === "applied") {
        await applyProfileCopilotPatchGroupInternal(patchGroup.id, {
          messageId: assistantMessage.id,
          patchGroup,
        });
      }
    }

    return getWorkspaceSnapshot();
  }

  function sendProfileCopilotMessage(
    content: string,
    context: ProfileCopilotContext = { surface: "general" },
  ) {
    return persistProfileCopilotMessage(content, context, true);
  }

  function proposeProfileCopilotChange(
    content: string,
    context: ProfileCopilotContext = { surface: "general" },
  ) {
    return persistProfileCopilotMessage(content, context, false);
  }

  function applyPatchGroupOperationsToWorkspace(
    workspace: {
      profile: CandidateProfile;
      searchPreferences: JobSearchPreferences;
      profileSetupState: ProfileSetupState;
    },
    patchGroup: ProfileCopilotPatchGroup,
    now: string,
  ): {
    profile: CandidateProfile;
    searchPreferences: JobSearchPreferences;
    profileSetupState: ProfileSetupState;
  } {
    let nextProfile = workspace.profile;
    let nextSearchPreferences = workspace.searchPreferences;
    let nextProfileSetupState = workspace.profileSetupState;

    for (const operation of patchGroup.operations) {
      switch (operation.operation) {
        case "replace_identity_fields": {
          const previousProfile = nextProfile;
          nextProfile = followPrimaryContacts(
            previousProfile,
            CandidateProfileSchema.parse({
              ...previousProfile,
              ...operation.value,
              ...(Object.hasOwn(operation.value, "summary")
                ? {
                    professionalSummary: {
                      ...previousProfile.professionalSummary,
                      fullSummary: operation.value.summary,
                    },
                  }
                : {}),
            }),
          );
          break;
        }
        case "replace_work_eligibility_fields":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            workEligibility: {
              ...nextProfile.workEligibility,
              ...operation.value,
            },
          });
          break;
        case "replace_profile_list_fields":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            ...operation.value,
          });
          break;
        case "replace_professional_summary_fields":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            ...(Object.hasOwn(operation.value, "fullSummary")
              ? { summary: operation.value.fullSummary }
              : {}),
            professionalSummary: {
              ...nextProfile.professionalSummary,
              ...operation.value,
            },
          });
          break;
        case "replace_narrative_fields":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            narrative: {
              ...nextProfile.narrative,
              ...operation.value,
            },
          });
          break;
        case "replace_application_identity_fields":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            applicationIdentity: {
              ...nextProfile.applicationIdentity,
              ...operation.value,
            },
          });
          break;
        case "replace_skill_group_fields":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            skillGroups: {
              ...nextProfile.skillGroups,
              ...operation.value,
            },
          });
          break;
        case "remove_profile_list_entries": {
          // A removal names its entries, so nothing the person did not name
          // can disappear, and the whole change is one reversible revision
          // like any assistant edit.
          const removedValues = new Set(
            operation.values.map((value) => value.trim().toLowerCase()),
          );
          const keep = (value: string) =>
            !removedValues.has(value.trim().toLowerCase());
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            ...(operation.field === "locations"
              ? { locations: nextProfile.locations.filter(keep) }
              : operation.field === "skills"
                ? { skills: nextProfile.skills.filter(keep) }
                : { targetRoles: nextProfile.targetRoles.filter(keep) }),
          });
          // Target roles and locations are one list to the person: a named
          // entry leaves the copy Preferences shows too, even when the
          // profile copy had already lost it.
          const mirroredField = MIRRORED_PROFILE_LIST_FIELDS.find(
            (field) => field === operation.field,
          );
          if (mirroredField) {
            nextSearchPreferences = normalizeSearchPreferences(
              JobSearchPreferencesSchema.parse({
                ...nextSearchPreferences,
                [mirroredField]:
                  nextSearchPreferences[mirroredField].filter(keep),
              }),
            );
          }
          break;
        }
        case "replace_search_preferences_fields": {
          const hasLegacyCompensationAmount =
            operation.value.minimumSalaryUsd !== undefined ||
            operation.value.targetSalaryUsd !== undefined;
          const hasLegacyCurrency =
            operation.value.salaryCurrency !== undefined;
          const requestedCurrency = hasLegacyCurrency
            ? (operation.value.salaryCurrency?.trim().toUpperCase() ?? null)
            : hasLegacyCompensationAmount
              ? "USD"
              : nextSearchPreferences.compensation.currency;

          nextSearchPreferences = normalizeSearchPreferences(
            JobSearchPreferencesSchema.parse({
              ...nextSearchPreferences,
              ...operation.value,
              compensation:
                hasLegacyCompensationAmount || hasLegacyCurrency
                  ? {
                      ...nextSearchPreferences.compensation,
                      ...(operation.value.minimumSalaryUsd !== undefined
                        ? { minimum: operation.value.minimumSalaryUsd }
                        : {}),
                      ...(operation.value.targetSalaryUsd !== undefined
                        ? { maximum: operation.value.targetSalaryUsd }
                        : {}),
                      ...(hasLegacyCompensationAmount
                        ? { interval: "year" }
                        : {}),
                      currency: requestedCurrency,
                      currencyStatus:
                        requestedCurrency === null
                          ? "needs_clarification"
                          : hasLegacyCurrency
                            ? "explicit"
                            : "inherited",
                    }
                  : nextSearchPreferences.compensation,
            }),
          );
          break;
        }
        case "replace_compensation_preferences_fields":
          nextSearchPreferences = normalizeSearchPreferences(
            JobSearchPreferencesSchema.parse({
              ...nextSearchPreferences,
              // A change that names a currency sets it. Merging the raw patch
              // kept the stored "awaiting clarification" status, so the first
              // pay change a person asked for could never be saved.
              compensation: applyCompensationPreferenceChange(
                nextSearchPreferences.compensation,
                operation.value,
              ),
            }),
          );
          break;
        case "upsert_experience_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            experiences: placeNewExperiencesByDate(
              nextProfile.experiences,
              replaceOrInsertRecord(
                nextProfile.experiences,
                {
                  ...operation.record,
                  id: operation.record.id ?? createUniqueId("experience"),
                },
                (record) => CandidateExperienceSchema.parse(record),
                areEquivalentExperienceRecords,
              ),
            ),
          });
          break;
        case "remove_experience_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            experiences: removeRecord(
              nextProfile.experiences,
              operation.recordId,
            ),
          });
          break;
        case "upsert_education_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            education: replaceOrInsertRecord(
              nextProfile.education,
              {
                ...operation.record,
                id: operation.record.id ?? createUniqueId("education"),
              },
              (record) => CandidateEducationSchema.parse(record),
              areEquivalentEducationRecords,
            ),
          });
          break;
        case "remove_education_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            education: removeRecord(nextProfile.education, operation.recordId),
          });
          break;
        case "reorder_education_records":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            education: reorderRecords(
              nextProfile.education,
              operation.orderedRecordIds,
            ),
          });
          break;
        case "upsert_certification_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            certifications: replaceOrInsertRecord(
              nextProfile.certifications,
              {
                ...operation.record,
                id: operation.record.id ?? createUniqueId("certification"),
              },
              (record) => CandidateCertificationSchema.parse(record),
            ),
          });
          break;
        case "remove_certification_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            certifications: removeRecord(
              nextProfile.certifications,
              operation.recordId,
            ),
          });
          break;
        case "upsert_project_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            projects: replaceOrInsertRecord(
              nextProfile.projects,
              {
                ...operation.record,
                id: operation.record.id ?? createUniqueId("project"),
              },
              (record) => CandidateProjectSchema.parse(record),
            ),
          });
          break;
        case "remove_project_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            projects: removeRecord(nextProfile.projects, operation.recordId),
          });
          break;
        case "upsert_link_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            links: replaceOrInsertRecord(
              nextProfile.links,
              {
                ...operation.record,
                id: operation.record.id ?? createUniqueId("link"),
              },
              (record) => CandidateLinkSchema.parse(record),
            ),
          });
          break;
        case "remove_link_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            links: removeRecord(nextProfile.links, operation.recordId),
          });
          break;
        case "upsert_language_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            spokenLanguages: replaceOrInsertRecord(
              nextProfile.spokenLanguages,
              {
                ...operation.record,
                id: operation.record.id ?? createUniqueId("language"),
              },
              (record) => CandidateLanguageSchema.parse(record),
            ),
          });
          break;
        case "remove_language_record":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            spokenLanguages: removeRecord(
              nextProfile.spokenLanguages,
              operation.recordId,
            ),
          });
          break;
        case "upsert_proof_point":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            proofBank: replaceOrInsertRecord(
              nextProfile.proofBank,
              {
                ...operation.record,
                id: operation.record.id ?? createUniqueId("proof"),
              },
              (record) => CandidateProofBankEntrySchema.parse(record),
            ),
          });
          break;
        case "remove_proof_point":
          nextProfile = CandidateProfileSchema.parse({
            ...nextProfile,
            proofBank: removeRecord(nextProfile.proofBank, operation.recordId),
          });
          break;
        case "set_resume_approach":
          // The strength half lives with the preferences; the Original half
          // is Settings and is written after this commit.
          if (operation.value !== "original_resume") {
            nextSearchPreferences = normalizeSearchPreferences(
              JobSearchPreferencesSchema.parse({
                ...nextSearchPreferences,
                tailoringMode: operation.value,
              }),
            );
          }
          break;
        case "resolve_review_items":
          nextProfileSetupState = ProfileSetupStateSchema.parse({
            ...nextProfileSetupState,
            reviewItems: nextProfileSetupState.reviewItems.map((item) =>
              operation.reviewItemIds.includes(item.id)
                ? {
                    ...item,
                    status: operation.resolutionStatus,
                    resolvedAt: now,
                  }
                : item,
            ),
          });
          break;
      }
    }

    // A card that changed one copy of target roles or locations carries the
    // same additions and removals to the other copy.
    const mirrored = mirrorProfileListEdits({
      before: {
        profile: workspace.profile,
        searchPreferences: workspace.searchPreferences,
      },
      after: { profile: nextProfile, searchPreferences: nextSearchPreferences },
    });

    return {
      profile:
        mirrored.profile === nextProfile
          ? nextProfile
          : CandidateProfileSchema.parse(mirrored.profile),
      searchPreferences:
        mirrored.searchPreferences === nextSearchPreferences
          ? nextSearchPreferences
          : normalizeSearchPreferences(
              JobSearchPreferencesSchema.parse(mirrored.searchPreferences),
            ),
      profileSetupState: nextProfileSetupState,
    };
  }

  async function applyProfileCopilotPatchGroupInternal(
    patchGroupId: string,
    options?: {
      messageId?: string | null;
      patchGroup?: ProfileCopilotPatchGroup;
      /** Overrides the revision reason (assistant sidebar edits). */
      reason?: string;
    },
  ): Promise<AppliedProfilePatchGroup> {
    // The Settings half of a resume-level change, from the attempt that
    // committed. Written once the profile commit has landed.
    let pendingResumeApplicationMode: ResumeApplicationMode | null = null;
    let committedResumeApplicationModeBefore: ResumeApplicationMode | null =
      null;
    // What the committing attempt found and left, for per-change undo.
    const lastAttempt: {
      value: {
        profileBefore: CandidateProfile;
        searchPreferencesBefore: JobSearchPreferences;
        profileAfter: CandidateProfile;
        searchPreferencesAfter: JobSearchPreferences;
      } | null;
    } = { value: null };
    const prepareAttempt =
      async (): Promise<CommitProfileCopilotStateInput> => {
        const [messages, currentSetupContext, existingRevisions, settings] =
          await Promise.all([
            ctx.repository.listProfileCopilotMessages(),
            getCurrentSetupStateContext(),
            ctx.repository.listProfileRevisions(),
            ctx.repository.getSettings(),
          ]);
        const captured = await ctx.repository.getProfileWithRevision();
        const now = new Date().toISOString();
        const persistedMatch = findUniqueProfileCopilotPatchGroup(
          messages,
          patchGroupId,
        );
        const patchGroup = options?.patchGroup ?? persistedMatch?.patchGroup;

        if (!patchGroup) {
          throw new Error(
            `Unknown profile copilot patch group '${patchGroupId}'.`,
          );
        }

        if (!hasValidPatchValues(patchGroup)) {
          throw new Error(
            "Profile Copilot returned a malformed field value. Rewrite the request with the field and value stated directly.",
          );
        }

        const sourceMessage =
          (options?.messageId
            ? (messages.find(
                (message) =>
                  message.id === options.messageId &&
                  message.patchGroups.some(
                    (group) => group.id === patchGroupId,
                  ),
              ) ?? null)
            : null) ??
          persistedMatch?.message ??
          null;

        const patched = applyPatchGroupOperationsToWorkspace(
          {
            profile: captured.profile,
            searchPreferences: currentSetupContext.searchPreferences,
            profileSetupState: currentSetupContext.profileSetupState,
          },
          patchGroup,
          now,
        );
        const currentResumeApplicationMode =
          settings.resumeApplicationMode ?? "tailored_per_job";
        pendingResumeApplicationMode =
          resolveResumeApplicationModeAfterPatchGroup(
            patchGroup,
            currentResumeApplicationMode,
            currentSetupContext.searchPreferences.tailoringMode,
          );
        committedResumeApplicationModeBefore = currentResumeApplicationMode;
        lastAttempt.value = {
          profileBefore: captured.profile,
          searchPreferencesBefore: currentSetupContext.searchPreferences,
          profileAfter: patched.profile,
          searchPreferencesAfter: patched.searchPreferences,
        };

        const nextProfileSetupState =
          resolvePendingReviewItemsAfterExplicitSave({
            currentProfile: captured.profile,
            currentSearchPreferences: currentSetupContext.searchPreferences,
            nextProfile: patched.profile,
            nextSearchPreferences: patched.searchPreferences,
            profileSetupState: patched.profileSetupState,
            now,
          });

        if (
          hasResumeAffectingProfileChange(captured.profile, patched.profile)
        ) {
          await ctx.staleApprovedResumeDrafts(
            "Profile details changed after approval and the resume needs a fresh review.",
          );
        }

        const refreshedLatestResumeImportReviewCandidates =
          currentSetupContext.latestResumeImportAllCandidates.filter(
            (candidate) =>
              candidate.resolution === "needs_review" ||
              candidate.resolution === "abstained",
          );
        const derivedProfileSetupState =
          await deriveAndPersistProfileSetupState(ctx, {
            persistedState: nextProfileSetupState,
            profile: patched.profile,
            searchPreferences: patched.searchPreferences,
            latestResumeImportRunId:
              currentSetupContext.latestResumeImportRun?.id ?? null,
            latestResumeImportReviewCandidates:
              refreshedLatestResumeImportReviewCandidates,
            persist: false,
          });

        return {
          profile: patched.profile,
          searchPreferences: patched.searchPreferences,
          profileSetupState: derivedProfileSetupState,
          // A flag delta instead of a whole-message snapshot: sibling groups
          // keep their transaction-current apply/reject status even if they
          // change between this capture and the commit.
          ...(sourceMessage
            ? {
                messagePatchFlags: [
                  {
                    messageId: sourceMessage.id,
                    patchGroupId,
                    applyMode: "applied",
                  },
                ],
              }
            : {}),
          revisions: [
            buildProfileRevision({
              trigger: "assistant_patch",
              profile: captured.profile,
              searchPreferences: currentSetupContext.searchPreferences,
              profileSetupState: currentSetupContext.profileSetupState,
              // Recorded beside the "before" state so a later undo can tell
              // this change apart from the person's own edits.
              profileAfter: patched.profile,
              searchPreferencesAfter: patched.searchPreferences,
              ...(pendingResumeApplicationMode
                ? {
                    resumeApplicationMode: currentResumeApplicationMode,
                    resumeApplicationModeAfter: pendingResumeApplicationMode,
                  }
                : {}),
              sequence: nextProfileRevisionSequence(existingRevisions),
              reason:
                options?.reason ?? `Assistant patch: ${patchGroup.summary}`,
              messageId: options?.messageId ?? sourceMessage?.id ?? null,
              patchGroupId,
            }),
          ],
          expectedProfileRevision: captured.revision,
        };
      };

    await commitProfileCopilotStateWithStaleRetry(
      ctx.repository,
      prepareAttempt,
    );
    if (pendingResumeApplicationMode) {
      await commitResumeApplicationMode(pendingResumeApplicationMode);
    }
    if (!lastAttempt.value) {
      throw new Error("The profile change was not committed.");
    }
    return {
      ...lastAttempt.value,
      resumeApplicationMode: pendingResumeApplicationMode
        ? {
            before: committedResumeApplicationModeBefore,
            after: pendingResumeApplicationMode,
          }
        : null,
    };
  }

  /**
   * Commits a patch group written by the assistant sidebar (ADR 0037). No
   * chat message is stored here; the revision is attributed to the sidebar
   * message and the before and after states come back for the undo receipt.
   */
  function applyAssistantProfilePatchGroup(
    patchGroup: ProfileCopilotPatchGroup,
    attribution: { messageId: string | null; reason: string },
  ): Promise<AppliedProfilePatchGroup> {
    return applyProfileCopilotPatchGroupInternal(patchGroup.id, {
      patchGroup,
      messageId: attribution.messageId,
      reason: attribution.reason,
    });
  }

  async function applyProfileCopilotPatchGroup(patchGroupId: string) {
    await applyProfileCopilotPatchGroupInternal(patchGroupId);
    return getWorkspaceSnapshot();
  }

  async function rejectProfileCopilotPatchGroup(patchGroupId: string) {
    const messages = await ctx.repository.listProfileCopilotMessages();
    const match = findUniqueProfileCopilotPatchGroup(messages, patchGroupId);

    if (!match) {
      throw new Error(`Unknown profile copilot patch group '${patchGroupId}'.`);
    }

    // The flag flip resolves against transaction-current persisted state, so
    // a sibling group applied or rejected while this call was in flight keeps
    // its status instead of being reverted by a stale whole-message write.
    const didUpdate = await ctx.repository.commitProfileCopilotPatchFlagUpdate({
      patchGroupId,
      applyMode: "rejected",
    });

    if (!didUpdate) {
      throw new Error(`Unknown profile copilot patch group '${patchGroupId}'.`);
    }

    return getWorkspaceSnapshot();
  }

  async function undoProfileRevision(revisionId: string) {
    const currentSetupContext = await getCurrentSetupStateContext();
    const revisions = await ctx.repository.listProfileRevisions();
    const targetRevision = revisions.find(
      (revision) => revision.id === revisionId,
    );

    if (!targetRevision) {
      throw new Error(`Unknown profile revision '${revisionId}'.`);
    }

    // Undo reaches back to the state this revision found, which also reverses
    // every assistant change recorded after it. That is the point — an undo
    // list you can only use from the top is not an undo list — but it must
    // never take a person's own later edit with it.
    const laterAssistantRevisionCount = revisions.filter(
      (revision) =>
        revision.sequence > targetRevision.sequence &&
        revision.trigger === "assistant_patch",
    ).length;
    const fieldsThisUndoWouldChange = new Set([
      ...collectChangedFieldLabels(
        currentSetupContext.profile,
        targetRevision.snapshotProfile,
      ),
      ...collectChangedFieldLabels(
        currentSetupContext.searchPreferences,
        targetRevision.snapshotSearchPreferences,
      ),
    ]);
    const conflictingManualEdits = collectManualEditsAfterRevision({
      currentProfile: currentSetupContext.profile,
      currentSearchPreferences: currentSetupContext.searchPreferences,
      revisionsNewestFirst: revisions,
      fromSequence: targetRevision.sequence,
    }).filter((label) => fieldsThisUndoWouldChange.has(label));

    if (conflictingManualEdits.length > 0) {
      throw new Error(
        `This change cannot be undone: you edited ${conflictingManualEdits.join(", ")} yourself afterwards, and undoing would overwrite your own edit. Change ${conflictingManualEdits.length === 1 ? "that field" : "those fields"} by hand instead.`,
      );
    }

    // Original lives in Settings, so the profile snapshot cannot put it back.
    // The assistant changes being undone recorded the Settings half; undo
    // restores the first one's "before" unless the person has chosen a level
    // in Settings since, which is theirs to keep.
    const resumeLevelChanges = revisions
      .filter(
        (revision) =>
          revision.sequence >= targetRevision.sequence &&
          revision.trigger === "assistant_patch" &&
          revision.snapshotResumeApplicationMode !== null &&
          revision.snapshotResumeApplicationModeAfter !== null,
      )
      .sort((left, right) => left.sequence - right.sequence);
    const currentResumeApplicationMode =
      (await ctx.repository.getSettings()).resumeApplicationMode ??
      "tailored_per_job";
    const firstResumeLevelChange = resumeLevelChanges[0] ?? null;
    const lastResumeLevelChange = resumeLevelChanges.at(-1) ?? null;
    const restoredResumeApplicationMode =
      firstResumeLevelChange?.snapshotResumeApplicationMode &&
      lastResumeLevelChange?.snapshotResumeApplicationModeAfter ===
        currentResumeApplicationMode &&
      firstResumeLevelChange.snapshotResumeApplicationMode !==
        currentResumeApplicationMode
        ? firstResumeLevelChange.snapshotResumeApplicationMode
        : null;

    const undoReason = targetRevision.reason
      ? `Undo: ${targetRevision.reason}`
      : "Undo profile revision";
    const undoRevision = buildProfileRevision({
      trigger: "undo",
      profile: currentSetupContext.profile,
      searchPreferences: currentSetupContext.searchPreferences,
      profileSetupState: currentSetupContext.profileSetupState,
      profileAfter: targetRevision.snapshotProfile,
      searchPreferencesAfter: targetRevision.snapshotSearchPreferences,
      ...(restoredResumeApplicationMode
        ? {
            resumeApplicationMode: currentResumeApplicationMode,
            resumeApplicationModeAfter: restoredResumeApplicationMode,
          }
        : {}),
      sequence: nextProfileRevisionSequence(revisions),
      reason:
        laterAssistantRevisionCount > 0
          ? `${undoReason} (and ${laterAssistantRevisionCount} later assistant change${laterAssistantRevisionCount === 1 ? "" : "s"})`
          : undoReason,
      restoredFromRevisionId: targetRevision.id,
    });

    if (
      hasResumeAffectingProfileChange(
        currentSetupContext.profile,
        targetRevision.snapshotProfile,
      )
    ) {
      await ctx.staleApprovedResumeDrafts(
        "Profile details changed after approval and the resume needs a fresh review.",
      );
    }

    await commitProfileCopilotStateWithStaleRetry(ctx.repository, async () => {
      const captured = await ctx.repository.getProfileWithRevision();
      return {
        profile: targetRevision.snapshotProfile,
        searchPreferences: normalizeSearchPreferences(
          targetRevision.snapshotSearchPreferences,
        ),
        profileSetupState: targetRevision.snapshotProfileSetupState,
        revisions: [undoRevision],
        expectedProfileRevision: captured.revision,
      };
    });
    if (restoredResumeApplicationMode) {
      await commitResumeApplicationMode(restoredResumeApplicationMode);
    }

    return getWorkspaceSnapshot();
  }

  return {
    sendProfileCopilotMessage,
    proposeProfileCopilotChange,
    applyAssistantProfilePatchGroup,
    applyProfileCopilotPatchGroup,
    rejectProfileCopilotPatchGroup,
    undoProfileRevision,
  };
}
