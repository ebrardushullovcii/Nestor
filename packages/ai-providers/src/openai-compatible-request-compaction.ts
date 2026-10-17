/** A full read cannot omit supplied evidence to fit the model budget. */
export class FullFitEvidenceBudgetError extends Error {}

const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 196_000;
const APPROX_CHARS_PER_TOKEN = 3;
const INPUT_BUDGET_RATIO = 0.72;
const MIN_USER_PAYLOAD_CHARS = 8_000;
const MAX_OMITTED_EVIDENCE_ID_PREVIEW = 12;
const MAX_OMITTED_EVIDENCE_ID_CHARS = 96;

// Candidate-critical grounding scopes are kept ahead of generic profile
// evidence when request compaction must drop items to fit the model budget.
const GROUNDING_EVIDENCE_SCOPE_PRIORITY: Record<string, number> = {
  experience: 0,
  project: 1,
  proof: 2,
  import_evidence: 3,
  profile: 4,
};

// Reserved anchors survive request compaction ahead of every other evidence
// item. The original resume text ranks first, followed by the authoritative
// skill anchors that ground stack- and domain-aware wording.
const RESERVED_GROUNDING_ANCHOR_IDS = new Set([
  "baseResume:text",
  "profile:skills",
]);
const FIRST_RESERVED_GROUNDING_ANCHOR_ID = "baseResume:text";
const RESERVED_GROUNDING_ANCHOR_ID_PREFIX = "profile:skillGroup:";
// One representative per candidate-critical non-experience scope is reserved
// so heavy work-history catalogs cannot fully crowd out project, proof, and
// imported-resume context.
const REPRESENTATIVE_GROUNDING_SCOPES = ["project", "proof", "import_evidence"];
// Redundant per-record facets are the first in-scope items to drop.
const REDUNDANT_EVIDENCE_ID_SUFFIXES = [":domainTags"];

import {
  ResumeImportJsonValueSchema,
  type ResumeImportJsonValue,
} from "@nestor/contracts";

export type OpenAiCompatibleJsonOperation =
  | "extractProfileFromResume"
  | "extractResumeImportStage"
  | "adjudicateResumeImportCandidates"
  | "createResumeDraft"
  | "reviseResumeDraft"
  | "reviseCandidateProfile"
  | "tailorResume"
  | "assessJobFit"
  | "judgeJobFits"
  | "checkResumeClaims"
  | "extractJobsFromPage";

// Declared as a type alias (not an interface) so the shape carries an
// implicit index signature and satisfies ResumeImportJsonValue's record
// member when embedded into compacted payloads, without any/casts.
type GroundingEvidenceCompactionMetadata = {
  applied: true;
  note: string;
  originalItemCount: number;
  includedItemCount: number;
  omittedItemCount: number;
  omittedScopeCounts: Record<string, number>;
  omittedIdsPreview: string[];
};

interface CompactionAttemptContext {
  groundingEvidenceCompaction: GroundingEvidenceCompactionMetadata | null;
}

function estimateSerializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function pickLevelValue(level: number, values: readonly number[]): number {
  const index = Math.max(0, Math.min(values.length - 1, level - 1));
  return values[index] ?? values[values.length - 1] ?? Number.MAX_SAFE_INTEGER;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const omittedCount = value.length - maxChars;
  const marker = ` ...[truncated ${omittedCount} chars for model fit]... `;

  if (maxChars <= marker.length + 2) {
    return value.slice(0, maxChars);
  }

  const available = maxChars - marker.length;
  const headLength = Math.max(1, Math.ceil(available * 0.65));
  const tailLength = Math.max(1, available - headLength);

  return `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`;
}

function matchesPathSuffix(
  path: readonly string[],
  suffix: readonly string[],
): boolean {
  if (suffix.length > path.length) {
    return false;
  }

  return suffix.every(
    (segment, index) => path[path.length - suffix.length + index] === segment,
  );
}

function stringLimitForPath(path: readonly string[], level: number): number {
  const key = path[path.length - 1] ?? "";

  if (!Number.isFinite(level) || level < 1) {
    return Number.MAX_SAFE_INTEGER;
  }

  if (
    key === "id" ||
    key === "jobId" ||
    key === "draftId" ||
    key === "runId" ||
    key === "recordId" ||
    key.endsWith("Id") ||
    key === "email" ||
    key === "phone" ||
    key === "pageUrl" ||
    key.endsWith("Url")
  ) {
    return 512;
  }

  if (key === "request") {
    return pickLevelValue(level, [16_000, 10_000, 6_000]);
  }

  if (
    key === "resumeText" ||
    key === "baseResumeText" ||
    key === "textContent" ||
    key === "fullText"
  ) {
    return pickLevelValue(level, [28_000, 16_000, 9_000]);
  }

  if (matchesPathSuffix(path, ["documentBundle", "blocks", "text"])) {
    return pickLevelValue(level, [2_400, 1_400, 800]);
  }

  if (key === "description") {
    return pickLevelValue(level, [12_000, 7_000, 4_000]);
  }

  if (key === "content") {
    return pickLevelValue(level, [6_000, 3_000, 1_600]);
  }

  if (key === "summary" || key.endsWith("Summary")) {
    return pickLevelValue(level, [2_400, 1_200, 700]);
  }

  if (key === "text" || key === "evidenceText") {
    return pickLevelValue(level, [1_400, 800, 500]);
  }

  if (
    key === "valuePreview" ||
    key === "reason" ||
    key === "supportingContext"
  ) {
    return pickLevelValue(level, [800, 500, 300]);
  }

  return pickLevelValue(level, [600, 360, 220]);
}

function arrayLimitForPath(
  path: readonly string[],
  level: number,
  value: readonly unknown[],
): number {
  const key = path[path.length - 1] ?? "";
  const containsObjects = value.some(
    (entry) =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );

  if (!Number.isFinite(level) || level < 1) {
    return Number.MAX_SAFE_INTEGER;
  }

  if (matchesPathSuffix(path, ["documentBundle", "blocks"])) {
    return pickLevelValue(level, [32, 24, 20]);
  }

  if (matchesPathSuffix(path, ["groundingEvidence", "items"])) {
    return pickLevelValue(level, [64, 48, 32]);
  }

  if (key === "sections") {
    return pickLevelValue(level, [8, 7, 6]);
  }

  if (key === "entries") {
    return pickLevelValue(level, [8, 6, 4]);
  }

  if (key === "bullets") {
    return pickLevelValue(level, [8, 6, 4]);
  }

  if (key === "experiences") {
    return pickLevelValue(level, [8, 6, 4]);
  }

  if (key === "projects") {
    return pickLevelValue(level, [6, 4, 3]);
  }

  if (key === "education") {
    return pickLevelValue(level, [4, 4, 3]);
  }

  if (key === "certifications") {
    return pickLevelValue(level, [6, 4, 3]);
  }

  if (key === "links" || key === "targets") {
    return pickLevelValue(level, [10, 8, 6]);
  }

  if (key === "spokenLanguages" || key === "proofBank") {
    return pickLevelValue(level, [8, 6, 4]);
  }

  if (
    key === "validationIssues" ||
    key === "evidenceRefs" ||
    key === "summaryEvidenceRefs" ||
    key === "outcomeEvidenceRefs" ||
    key === "bulletEvidenceRefs" ||
    key === "conversationFacts" ||
    key === "relevantReviewItems" ||
    key === "companyNotes" ||
    key === "domainVocabulary" ||
    key === "priorityThemes" ||
    key === "responsibilities" ||
    key === "minimumQualifications" ||
    key === "preferredQualifications" ||
    key === "benefits" ||
    key === "skills" ||
    key === "targetRoles" ||
    key === "locations" ||
    key === "excludedLocations" ||
    key === "jobFamilies" ||
    key === "targetIndustries" ||
    key === "targetCompanyStages" ||
    key === "employmentTypes" ||
    key === "companyBlacklist" ||
    key === "companyWhitelist" ||
    key === "experienceHighlights" ||
    key === "coreSkills" ||
    key === "listingRequestedSkills" ||
    key === "targetedKeywords" ||
    key === "additionalSkills" ||
    key === "languages" ||
    key === "customAnswers" ||
    key === "notes" ||
    key === "warnings"
  ) {
    return pickLevelValue(level, [20, 12, 8]);
  }

  return containsObjects
    ? pickLevelValue(level, [12, 8, 6])
    : pickLevelValue(level, [20, 12, 8]);
}

function shouldDropKey(path: readonly string[], level: number): boolean {
  const key = path[path.length - 1] ?? "";

  if (level < 1) {
    return false;
  }

  if (
    key === "sourceRefs" ||
    key === "alternatives" ||
    key === "confidenceBreakdown"
  ) {
    return true;
  }

  if (level >= 2 && key === "analysisWarnings") {
    return true;
  }

  return false;
}

function groundingEvidenceField(
  item: ResumeImportJsonValue,
  field: string,
): ResumeImportJsonValue | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  return (item as Record<string, ResumeImportJsonValue>)[field] ?? null;
}

function isReservedGroundingAnchorId(id: string | null): boolean {
  if (id === null) {
    return false;
  }

  return (
    RESERVED_GROUNDING_ANCHOR_IDS.has(id) ||
    id.startsWith(RESERVED_GROUNDING_ANCHOR_ID_PREFIX)
  );
}

function groundingEvidenceAnchorRank(id: string | null): number | null {
  if (!isReservedGroundingAnchorId(id)) {
    return null;
  }

  return id === FIRST_RESERVED_GROUNDING_ANCHOR_ID ? -3 : -2;
}

function groundingEvidenceSortKey(
  item: ResumeImportJsonValue,
  index: number,
  representativeIndexes: ReadonlySet<number>,
): { primary: number; secondary: number; index: number } {
  const id = groundingEvidenceField(item, "id");
  const scope = groundingEvidenceField(item, "scope");
  const scopePriority =
    typeof scope === "string"
      ? (GROUNDING_EVIDENCE_SCOPE_PRIORITY[scope] ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;

  const anchorRank = groundingEvidenceAnchorRank(
    typeof id === "string" ? id : null,
  );
  const primary =
    anchorRank ?? (representativeIndexes.has(index) ? -1 : scopePriority);

  const secondary =
    typeof id === "string" &&
    REDUNDANT_EVIDENCE_ID_SUFFIXES.some((suffix) => id.endsWith(suffix))
      ? 1
      : 0;

  return { primary, secondary, index };
}

function prioritizeGroundingEvidenceEntries(
  items: readonly ResumeImportJsonValue[],
): Array<{ item: ResumeImportJsonValue; index: number }> {
  const representativeIndexes = new Set<number>();

  for (const scope of REPRESENTATIVE_GROUNDING_SCOPES) {
    const index = items.findIndex(
      (item) => groundingEvidenceField(item, "scope") === scope,
    );

    if (index >= 0) {
      representativeIndexes.add(index);
    }
  }

  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftKey = groundingEvidenceSortKey(
        left.item,
        left.index,
        representativeIndexes,
      );
      const rightKey = groundingEvidenceSortKey(
        right.item,
        right.index,
        representativeIndexes,
      );

      return (
        leftKey.primary - rightKey.primary ||
        leftKey.secondary - rightKey.secondary ||
        leftKey.index - rightKey.index
      );
    });
}

function countOmittedItemsByScope(
  items: readonly ResumeImportJsonValue[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const item of items) {
    const scope = groundingEvidenceField(item, "scope");
    const key = typeof scope === "string" ? scope : "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort(([leftKey], [rightKey]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0,
    ),
  );
}

function boundOmittedEvidenceId(id: string): string {
  return id.length <= MAX_OMITTED_EVIDENCE_ID_CHARS
    ? id
    : `${id.slice(0, MAX_OMITTED_EVIDENCE_ID_CHARS - 1)}…`;
}

function buildGroundingCompactionNote(input: {
  includedItemCount: number;
  omittedItemCount: number;
  omittedScopeCounts: Record<string, number>;
  omittedIdsPreview: string[];
}): string {
  const scopeSummary =
    Object.entries(input.omittedScopeCounts)
      .map(([scope, count]) => `${scope}=${count}`)
      .join(", ") || "none";
  const idPreview =
    input.omittedIdsPreview.length > 0
      ? ` First omitted evidence ids: ${input.omittedIdsPreview.join(", ")}.`
      : "";

  return (
    `Request compaction kept ${input.includedItemCount} of ${
      input.includedItemCount + input.omittedItemCount
    } grounding evidence items to fit the model input budget. ` +
    "Original-resume and authoritative skill anchors were reserved first, " +
    "followed by representative work history, project, and proof evidence. " +
    `Omitted ${input.omittedItemCount} items by scope: ${scopeSummary}.${idPreview}`
  );
}

function buildGroundingEvidenceCompactionMetadata(input: {
  originalItemCount: number;
  includedItemCount: number;
  omittedItems: readonly ResumeImportJsonValue[];
}): GroundingEvidenceCompactionMetadata {
  const omittedItemCount = input.originalItemCount - input.includedItemCount;
  const omittedScopeCounts = countOmittedItemsByScope(input.omittedItems);
  const omittedIdsPreview = input.omittedItems
    .map((item) => groundingEvidenceField(item, "id"))
    .filter((id): id is string => typeof id === "string")
    .map(boundOmittedEvidenceId)
    .slice(0, MAX_OMITTED_EVIDENCE_ID_PREVIEW);

  return {
    applied: true,
    note: buildGroundingCompactionNote({
      includedItemCount: input.includedItemCount,
      omittedItemCount,
      omittedScopeCounts,
      omittedIdsPreview,
    }),
    originalItemCount: input.originalItemCount,
    includedItemCount: input.includedItemCount,
    omittedItemCount,
    omittedScopeCounts,
    omittedIdsPreview,
  };
}

function compactGroundingEvidenceItems(
  items: readonly ResumeImportJsonValue[],
  path: readonly string[],
  level: number,
  context: CompactionAttemptContext,
): ResumeImportJsonValue[] {
  const limit = Math.min(arrayLimitForPath(path, level, items), items.length);

  // Within the cap there is no omission pressure: evidence keeps its
  // original catalog order so level-one normalization stays a structural
  // no-op for already-lean payloads.
  if (limit >= items.length) {
    return items.map((item) => compactValue(item, path, level, context));
  }

  const prioritizedEntries = prioritizeGroundingEvidenceEntries(items);
  const keptEntries = prioritizedEntries.slice(0, limit);
  const keptIndexes = new Set(keptEntries.map((entry) => entry.index));
  const omittedItems = items.filter((_item, index) => !keptIndexes.has(index));

  if (omittedItems.length > 0) {
    context.groundingEvidenceCompaction =
      buildGroundingEvidenceCompactionMetadata({
        originalItemCount: items.length,
        includedItemCount: keptEntries.length,
        omittedItems,
      });
  }

  return keptEntries.map((entry) =>
    compactValue(entry.item, path, level, context),
  );
}

function compactValue(
  value: ResumeImportJsonValue,
  path: readonly string[],
  level: number,
  context: CompactionAttemptContext,
): ResumeImportJsonValue {
  if (typeof value === "string") {
    return truncateMiddle(value, stringLimitForPath(path, level));
  }

  if (Array.isArray(value)) {
    if (matchesPathSuffix(path, ["groundingEvidence", "items"])) {
      return compactGroundingEvidenceItems(value, path, level, context);
    }

    const limited = value.slice(0, arrayLimitForPath(path, level, value));
    return limited.map((entry) => compactValue(entry, path, level, context));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, ResumeImportJsonValue>;
  const nextRecord: Record<string, ResumeImportJsonValue> = {};

  for (const [key, nestedValue] of Object.entries(record)) {
    const nextPath = [...path, key];

    if (shouldDropKey(nextPath, level)) {
      continue;
    }

    nextRecord[key] = compactValue(nestedValue, nextPath, level, context);
  }

  return nextRecord;
}

function responseHeadroomTokensForOperation(
  operation: OpenAiCompatibleJsonOperation,
): number {
  switch (operation) {
    case "extractProfileFromResume":
    case "extractResumeImportStage":
    case "adjudicateResumeImportCandidates":
    case "createResumeDraft":
    case "tailorResume":
    case "judgeJobFits":
    case "checkResumeClaims":
      return 4_096;
    case "reviseResumeDraft":
    case "reviseCandidateProfile":
      return 2_048;
    case "assessJobFit":
    case "extractJobsFromPage":
      return 1_024;
  }
}

function computeUserPayloadCharBudget(input: {
  operation: OpenAiCompatibleJsonOperation;
  modelContextWindowTokens: number | null;
  systemPrompt: string;
}): number {
  const modelContextWindowTokens =
    input.modelContextWindowTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
  const reservedOutputTokens = responseHeadroomTokensForOperation(
    input.operation,
  );
  const promptTokens = Math.ceil(
    input.systemPrompt.length / APPROX_CHARS_PER_TOKEN,
  );
  const availableInputTokens =
    Math.floor(modelContextWindowTokens * INPUT_BUDGET_RATIO) -
    reservedOutputTokens -
    promptTokens;

  if (availableInputTokens * APPROX_CHARS_PER_TOKEN < MIN_USER_PAYLOAD_CHARS) {
    throw new Error(
      `OpenAI-compatible request budget is too small for ${input.operation} after reserving prompt and response tokens.`,
    );
  }

  return availableInputTokens * APPROX_CHARS_PER_TOKEN;
}

function withGroundingEvidenceCompactionMetadata(
  payload: ResumeImportJsonValue,
  context: CompactionAttemptContext,
): ResumeImportJsonValue {
  const metadata = context.groundingEvidenceCompaction;

  if (
    !metadata ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }

  const groundingEvidence = (payload as Record<string, ResumeImportJsonValue>)
    .groundingEvidence;

  if (
    !groundingEvidence ||
    typeof groundingEvidence !== "object" ||
    Array.isArray(groundingEvidence)
  ) {
    return payload;
  }

  return {
    ...(payload as Record<string, ResumeImportJsonValue>),
    groundingEvidence: {
      ...(groundingEvidence as Record<string, ResumeImportJsonValue>),
      compaction: metadata,
    },
  };
}

const PRESIZED_OPERATIONS: ReadonlySet<OpenAiCompatibleJsonOperation> = new Set(
  ["extractJobsFromPage", "judgeJobFits", "checkResumeClaims", "assessJobFit"],
);

export function compactOpenAiCompatibleUserPayload(input: {
  operation: OpenAiCompatibleJsonOperation;
  modelContextWindowTokens: number | null;
  systemPrompt: string;
  userPayload: unknown;
  /** Supplied facts must fit intact; report an oversized request instead of dropping them. */
  preserveFullPayload?: boolean;
}): ResumeImportJsonValue {
  const parsedPayload = ResumeImportJsonValueSchema.safeParse(
    input.userPayload,
  );

  if (!parsedPayload.success) {
    throw new Error(
      `OpenAI-compatible payload for ${input.operation} must be JSON-serializable before compaction.`,
    );
  }

  const charBudget = computeUserPayloadCharBudget(input);
  const originalSize = estimateSerializedLength(parsedPayload.data);

  if (input.preserveFullPayload) {
    if (originalSize <= charBudget) return parsedPayload.data;
    throw new Error(
      `The complete context for ${input.operation} exceeds the model's input limit; no candidate facts or listing details were omitted.`,
    );
  }

  // Operations whose payload builders already size every list skip
  // normalization while within budget: the level-one array bounds would
  // otherwise drop the jobs, claims or evidence entries past the twelfth
  // that the call was built to send. Grounded resume generation requests
  // always normalize through the level-one field bounds so oversized
  // individual fields (for example a long targetJob description) stay lean
  // even when the total payload fits; candidate-safe evidence anchoring
  // engages only under omission pressure, and payloads already within every
  // level-one bound pass through unchanged.
  if (PRESIZED_OPERATIONS.has(input.operation) && originalSize <= charBudget) {
    return parsedPayload.data;
  }

  // A full assessment must read all supplied evidence. Report an oversized
  // request rather than silently removing requirements from its middle.
  if (input.operation === "assessJobFit") {
    throw new FullFitEvidenceBudgetError(
      "The full listing and profile exceed the model's input limit. The assessment could not be completed; your previous assessment was kept. Choose a model with a larger context window and try again.",
    );
  }

  for (const level of [1, 2, 3]) {
    const context: CompactionAttemptContext = {
      groundingEvidenceCompaction: null,
    };
    const compacted = withGroundingEvidenceCompactionMetadata(
      compactValue(parsedPayload.data, [], level, context),
      context,
    );

    if (estimateSerializedLength(compacted) <= charBudget) {
      return compacted;
    }
  }

  throw new Error(
    `OpenAI-compatible payload exceeds charBudget after compaction for ${input.operation}.`,
  );
}
