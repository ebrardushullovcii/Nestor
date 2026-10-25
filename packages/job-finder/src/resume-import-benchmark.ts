import {
  type JobFinderAiClient,
  type ResumeVisionProvider,
  buildDeterministicResumeProfileExtraction,
  buildDeterministicResumeImportStageExtraction,
} from "@nestor/ai-providers";
import { createCatalogBrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  JobFinderIntelligenceStateSchema,
  ResumeImportBenchmarkReportSchema,
  ResumeImportBenchmarkRequestSchema,
  type CandidateProfile,
  type JobSearchPreferences,
  type ResumeDocumentBundle,
  type ResumeImportBenchmarkCase,
  type ResumeImportBenchmarkCaseResult,
  type ResumeImportBenchmarkMetrics,
  type ResumeImportBenchmarkReport,
  type ResumeImportBenchmarkRequest,
  type ResumeImportErrorTaxonomy,
  type ResumeImportFieldCandidate,
  type ResumeImportVisionArtifact,
  type JobFinderRepositoryState,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";

import { runResumeImportWorkflow } from "./internal/resume-import-workflow";
import type { WorkspaceServiceContext } from "./internal/workspace-service-context";
import type { JobFinderDocumentManager } from "./internal/workspace-service-contracts";

type ResumeImportBenchmarkHarness = {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  documentBundle: ResumeDocumentBundle;
  aiClient: JobFinderAiClient | null;
  visionProvider?: ResumeVisionProvider | null;
  parseMethod: string;
  workerManifestVersion: string | null;
  visionArtifact?: ResumeImportVisionArtifact | null;
};

export type ResumeImportBenchmarkHarnessFactory = (
  benchmarkCase: ResumeImportBenchmarkCase,
  request: ResumeImportBenchmarkRequest,
) => Promise<ResumeImportBenchmarkHarness>;

function safeDivide(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizeLooseString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeBenchmarkRecordString(value: unknown): string | null {
  const normalized = normalizeLooseString(value);
  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/[–—]/g, "-")
    .replace(/\s+-\s*(?:\d{1,2}\/|\d{1,2}\/\d{4}|\d{4})\s*$/g, "")
    .replace(/\s+llc\b/g, " l.l.c")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBenchmarkRecordIdentityParts(
  value: Record<string, unknown> | null,
  keys: readonly string[],
): string[] {
  if (!value) {
    return [];
  }

  return keys
    .map((key) => normalizeBenchmarkRecordString(value[key]))
    .filter((entry): entry is string => Boolean(entry));
}

function getBenchmarkActualRecordValues(input: {
  actual: readonly ResumeImportFieldCandidate[];
  section: ResumeImportFieldCandidate["target"]["section"];
}): Record<string, unknown>[] {
  const candidateRecords = input.actual
    .filter(
      (candidate) =>
        candidate.resolution === "auto_applied" ||
        candidate.resolution === "needs_review",
    )
    .map((candidate) => toRecordValue(candidate.value))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const autoAppliedRecords = input.actual
    .filter(
      (candidate) =>
        candidate.target.section === input.section &&
        candidate.resolution === "auto_applied" &&
        typeof candidate.target.recordId === "string",
    )
    .reduce<Map<string, Record<string, unknown>>>((recordsById, candidate) => {
      const recordId = candidate.target.recordId;
      if (!recordId) {
        return recordsById;
      }

      const current = recordsById.get(recordId) ?? {};
      recordsById.set(recordId, {
        ...current,
        [candidate.target.key]: candidate.value,
      });
      return recordsById;
    }, new Map());

  return [...candidateRecords, ...autoAppliedRecords.values()];
}

function toRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeRecordIdentity(
  value: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!value) {
    return null;
  }

  const parts = normalizeBenchmarkRecordIdentityParts(value, keys);

  if (parts.length === 0) {
    return null;
  }

  return parts.join("|");
}

function recordValueMatchesExpected(input: {
  actual: Record<string, unknown>;
  expected: Record<string, unknown>;
  keys: readonly string[];
}): boolean {
  return input.keys.every((key) => {
    const expectedValue = normalizeBenchmarkRecordString(input.expected[key]);
    const actualValue = normalizeBenchmarkRecordString(input.actual[key]);

    if (!expectedValue) {
      return true;
    }

    if (!actualValue) {
      return false;
    }

    return (
      actualValue === expectedValue ||
      actualValue.includes(expectedValue) ||
      expectedValue.includes(actualValue)
    );
  });
}

function normalizeRecordCollection(
  values: readonly Record<string, unknown>[],
  keys: readonly string[],
): Set<string> {
  const normalized = new Set<string>();

  for (const value of values) {
    const identity = normalizeRecordIdentity(value, keys);

    if (identity) {
      normalized.add(identity);
    }
  }

  return normalized;
}

function buildBenchmarkAiClient(useConfiguredAi: boolean): JobFinderAiClient {
  const providerLabel = useConfiguredAi
    ? "Configured benchmark provider"
    : "Deterministic benchmark provider";
  const providerKind = useConfiguredAi ? "openai_compatible" : "deterministic";

  return {
    getStatus() {
      return {
        kind: providerKind,
        role: "chat",
        ready: true,
        label: providerLabel,
        model: null,
        baseUrl: null,
        modelContextWindowTokens: null,
        reservedHeadroomTokens: null,
        requestTimeoutMs: null,
        detail: "Resume import benchmark harness",
      };
    },
    extractProfileFromResume(input) {
      return Promise.resolve(
        buildDeterministicResumeProfileExtraction(
          input,
          providerKind,
          providerLabel,
        ),
      );
    },
    extractResumeImportStage(input) {
      return Promise.resolve(
        buildDeterministicResumeImportStageExtraction(input, providerLabel),
      );
    },
    adjudicateResumeImportCandidates() {
      return Promise.resolve({
        candidates: [],
        notes: [
          "Benchmark import adjudication uses deterministic review-first handling.",
        ],
        warnings: [],
      });
    },
    createResumeDraft() {
      return Promise.reject(
        new Error(
          "Resume draft generation is not supported by the benchmark harness.",
        ),
      );
    },
    reviseResumeDraft() {
      return Promise.reject(
        new Error(
          "Resume draft revision is not supported by the benchmark harness.",
        ),
      );
    },
    reviseCandidateProfile() {
      return Promise.reject(
        new Error(
          "Profile copilot revision is not supported by the benchmark harness.",
        ),
      );
    },
    tailorResume() {
      return Promise.reject(
        new Error(
          "Resume tailoring is not supported by the benchmark harness.",
        ),
      );
    },
    assessJobFit() {
      return Promise.resolve(null);
    },
    extractJobsFromPage(input) {
      if (input.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      return Promise.resolve([]);
    },
  } satisfies JobFinderAiClient;
}

export function buildBenchmarkRepositoryState(input: {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
}): JobFinderRepositoryState {
  return {
    profile: input.profile,
    searchPreferences: input.searchPreferences,
    profileSetupState: {
      status: "not_started" as const,
      currentStep: "import" as const,
      completedAt: null,
      reviewItems: [],
      lastResumedAt: null,
    },
    savedJobs: [],
    tailoredAssets: [],
    resumeDrafts: [],
    resumeDraftRevisions: [],
    resumeExportArtifacts: [],
    resumeResearchArtifacts: [],
    resumeValidationResults: [],
    resumeAssistantMessages: [],
    profileCopilotMessages: [],
    profileRevisions: [],
    applyRuns: [],
    applyJobResults: [],
    applySubmitApprovals: [],
    applicationQuestionRecords: [],
    applicationAnswerRecords: [],
    applicationArtifactRefs: [],
    applicationReplayCheckpoints: [],
    applicationConsentRequests: [],
    applicationAuthorityEnvelopes: [],
    submissionPreflights: [],
    submissionExecutionGrants: [],
    submissionIdempotencyRecords: [],
    submissionArmedMarkers: [],
    submissionOutcomeRecords: [],
    applicationRecords: [],
    applicationAttempts: [],
    userActionRequests: [],
    userActionEvents: [],
    sourceDebugRuns: [],
    sourceDebugAttempts: [],
    sourceInstructionArtifacts: [],
    sourceDebugEvidenceRefs: [],
    resumeImportRuns: [],
    resumeImportDocumentBundles: [],
    resumeImportFieldCandidates: [],
    settings: {
      resumeFormat: "pdf" as const,
      resumeTemplateId: "classic_ats" as const,
      fontPreset: "inter_requisite" as const,
      appearanceTheme: "system" as const,
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
      keepSessionAlive: true,
      discoveryOnly: false,
    },
    discovery: {
      sessions: [],
      runState: "idle" as const,
      activeRun: null,
      recentRuns: [],
      activeSourceDebugRun: null,
      recentSourceDebugRuns: [],
      discoveryLedger: [],
      pendingDiscoveryJobs: [],
    },
    campaigns: [],
    activeCampaignId: null,
    campaignNotifications: [],
    activityControl: { paused: false, pausedAt: null, reason: null },
    intelligence: JobFinderIntelligenceStateSchema.parse({}),
  };
}

function createBenchmarkVisionProvider(): ResumeVisionProvider {
  return {
    getStatus() {
      return {
        kind: "deterministic",
        role: "vision",
        ready: true,
        label: "Benchmark rendered-preview vision fallback",
        model: null,
        baseUrl: null,
        modelContextWindowTokens: null,
        reservedHeadroomTokens: null,
        requestTimeoutMs: null,
        detail:
          "Benchmark harness validates local vision artifact wiring without calling an external model.",
      };
    },
    extractResumeVision() {
      return Promise.resolve({
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Benchmark rendered-preview vision fallback",
        candidates: [],
        notes: [
          "Benchmark vision branch consumed local rendered resume page images.",
        ],
        warnings: [],
        primaryErrorMessage: null,
      });
    },
  };
}

function buildTaxonomy(input: {
  benchmarkCase: ResumeImportBenchmarkCase;
  workflowCandidates: readonly ResumeImportFieldCandidate[];
  profile: CandidateProfile;
}): ResumeImportErrorTaxonomy[] {
  const taxonomy = new Set<ResumeImportErrorTaxonomy>();
  const expectedFields = input.benchmarkCase.expected.literalFields;
  const normalizedExpectedName = normalizeLooseString(expectedFields.fullName);
  const normalizedActualName = normalizeLooseString(input.profile.fullName);
  const normalizedExpectedLocation = normalizeLooseString(
    expectedFields.currentLocation,
  );
  const normalizedActualLocation = normalizeLooseString(
    input.profile.currentLocation,
  );

  if (
    normalizedExpectedName &&
    normalizedActualName &&
    normalizedExpectedName !== normalizedActualName
  ) {
    taxonomy.add("FIELD_MISATTRIBUTION");
  }

  if (
    normalizedExpectedLocation &&
    normalizedActualLocation &&
    normalizedExpectedLocation !== normalizedActualLocation
  ) {
    taxonomy.add("SECTION_BOUNDARY");
  }

  if (
    input.workflowCandidates.some(
      (candidate) =>
        candidate.resolution === "auto_applied" &&
        candidate.sourceBlockIds.length === 0 &&
        !normalizeString(candidate.evidenceText),
    )
  ) {
    taxonomy.add("MISSING_EVIDENCE");
  }

  if (
    input.workflowCandidates.some(
      (candidate) =>
        candidate.resolution === "auto_applied" &&
        candidate.target.key === "fullName" &&
        normalizedExpectedName !== null &&
        normalizeLooseString(candidate.value) !== normalizedExpectedName,
    )
  ) {
    taxonomy.add("OVERCONFIDENT_AUTO_APPLY");
  }

  const safeLiteralKeys = [
    "fullName",
    "currentLocation",
    "email",
    "phone",
  ] as const;

  for (const key of safeLiteralKeys) {
    const expectedValue = normalizeLooseString(
      input.benchmarkCase.expected.literalFields[key],
    );

    if (!expectedValue) {
      continue;
    }

    const autoAppliedMatchingCandidate = input.workflowCandidates.find(
      (candidate) =>
        candidate.target.key === key &&
        candidate.resolution === "auto_applied" &&
        normalizeLooseString(candidate.value) === expectedValue,
    );

    const unresolvedMatchingCandidate = input.workflowCandidates.find(
      (candidate) =>
        candidate.target.key === key &&
        normalizeLooseString(candidate.value) === expectedValue &&
        (candidate.resolution === "needs_review" ||
          candidate.resolution === "abstained"),
    );

    if (unresolvedMatchingCandidate && !autoAppliedMatchingCandidate) {
      taxonomy.add("UNRESOLVED_SHOULD_HAVE_RESOLVED");
      break;
    }
  }

  return [...taxonomy];
}

function scoreLiteralFields(input: {
  expected: Record<string, unknown>;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
}): Pick<
  ResumeImportBenchmarkMetrics,
  "literalFieldPrecision" | "literalFieldRecall"
> {
  const actualByKey: Record<string, unknown> = {
    fullName: input.profile.fullName,
    currentLocation: input.profile.currentLocation,
    email: input.profile.email,
    phone: input.profile.phone,
    linkedinUrl: input.profile.linkedinUrl,
    githubUrl: input.profile.githubUrl,
    portfolioUrl: input.profile.portfolioUrl,
    personalWebsiteUrl: input.profile.personalWebsiteUrl,
    salaryCurrency: input.searchPreferences.salaryCurrency,
  };

  const expectedEntries = Object.entries(input.expected);
  if (expectedEntries.length === 0) {
    return {
      literalFieldPrecision: 1,
      literalFieldRecall: 1,
    };
  }

  let matches = 0;
  let comparableActual = 0;

  for (const [key, expectedValue] of expectedEntries) {
    const expectedNormalized = normalizeLooseString(expectedValue);
    const actualNormalized = normalizeLooseString(actualByKey[key]);

    if (actualNormalized !== null) {
      comparableActual += 1;
    }

    if (
      expectedNormalized !== null &&
      actualNormalized === expectedNormalized
    ) {
      matches += 1;
    }
  }

  return {
    literalFieldPrecision: safeDivide(
      matches,
      comparableActual || expectedEntries.length,
    ),
    literalFieldRecall: safeDivide(matches, expectedEntries.length),
  };
}

function scoreRecordF1(input: {
  expected: readonly Record<string, unknown>[];
  actual: readonly Record<string, unknown>[];
  keys: readonly string[];
}): number {
  if (input.expected.length === 0 && input.actual.length === 0) {
    return 1;
  }

  const expectedSet = normalizeRecordCollection(input.expected, input.keys);
  const actualSet = normalizeRecordCollection(input.actual, input.keys);

  if (expectedSet.size === 0 && actualSet.size === 0) {
    return 1;
  }

  const unmatchedExpected = new Set(expectedSet);
  const matchedActualIndexes = new Set<number>();
  let truePositives = 0;
  for (const [actualIndex, actualValue] of input.actual.entries()) {
    const actualIdentity = normalizeRecordIdentity(actualValue, input.keys);
    if (actualIdentity && unmatchedExpected.has(actualIdentity)) {
      truePositives += 1;
      unmatchedExpected.delete(actualIdentity);
      matchedActualIndexes.add(actualIndex);
      continue;
    }

    const actualParts = normalizeBenchmarkRecordIdentityParts(
      actualValue,
      input.keys,
    );
    if (actualParts.length === 0) {
      continue;
    }

    const containedExpected = [...unmatchedExpected].find(
      (expectedIdentity) => {
        const expectedParts = expectedIdentity.split("|");
        return expectedParts.every((expectedPart) =>
          actualParts.some(
            (actualPart) =>
              actualPart === expectedPart ||
              actualPart.includes(expectedPart) ||
              expectedPart.includes(actualPart),
          ),
        );
      },
    );

    if (containedExpected) {
      truePositives += 1;
      unmatchedExpected.delete(containedExpected);
      matchedActualIndexes.add(actualIndex);
    }
  }

  for (const expectedValue of input.expected) {
    const expectedIdentity = normalizeRecordIdentity(expectedValue, input.keys);
    if (!expectedIdentity || !unmatchedExpected.has(expectedIdentity)) {
      continue;
    }

    const matchingActualIndex = input.actual.findIndex(
      (actualValue, actualIndex) =>
        !matchedActualIndexes.has(actualIndex) &&
        recordValueMatchesExpected({
          actual: actualValue,
          expected: expectedValue,
          keys: input.keys,
        }),
    );

    if (matchingActualIndex !== -1) {
      truePositives += 1;
      unmatchedExpected.delete(expectedIdentity);
      matchedActualIndexes.add(matchingActualIndex);
    }
  }

  const precision = safeDivide(truePositives, actualSet.size);
  const recall = safeDivide(truePositives, expectedSet.size);

  if (precision === 0 && recall === 0) {
    return 0;
  }

  return (2 * precision * recall) / (precision + recall);
}

function scoreOptionalRecordF1(input: {
  expected: readonly Record<string, unknown>[] | undefined;
  actual: readonly Record<string, unknown>[];
  keys: readonly string[];
}): number {
  return input.expected === undefined
    ? 1
    : scoreRecordF1({ ...input, expected: input.expected });
}

function normalizeComparableDateValue(value: unknown): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  const isoMonthMatch = normalized.match(/^((?:19|20)\d{2})-(0[1-9]|1[0-2])$/);
  if (isoMonthMatch) {
    return `${isoMonthMatch[1]}-${isoMonthMatch[2]}`;
  }

  const numericMonthMatch = normalized.match(
    /^(0?[1-9]|1[0-2])\/((?:19|20)\d{2})$/,
  );
  if (numericMonthMatch) {
    return `${numericMonthMatch[2]}-${numericMonthMatch[1]?.padStart(2, "0")}`;
  }

  const namedMonthMatch = normalized.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+((?:19|20)\d{2})$/i,
  );
  if (namedMonthMatch) {
    const monthIndex = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].indexOf((namedMonthMatch[1] ?? "").slice(0, 3).toLowerCase());
    return monthIndex === -1
      ? null
      : `${namedMonthMatch[2]}-${String(monthIndex + 1).padStart(2, "0")}`;
  }

  return /^((?:19|20)\d{2})$/.test(normalized) ? normalized : null;
}

function normalizeComparableRecordValue(
  value: unknown,
  fieldKey?: string,
): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => normalizeComparableRecordValue(entry, fieldKey))
      .filter(Boolean)
      .sort();
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, entry]) =>
        normalizeComparableRecordValue(entry, key).map(
          (normalized) =>
            `${normalizeBenchmarkRecordString(key)}:${normalized}`,
        ),
      );
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return [String(value)];
  }

  if (fieldKey && /(?:^|_)(?:start|end|issue|expiry)?date$/i.test(fieldKey)) {
    const normalizedDate = normalizeComparableDateValue(value);
    if (normalizedDate) {
      return [normalizedDate];
    }
  }

  const normalized = normalizeBenchmarkRecordString(value);
  return normalized ? [normalized] : [];
}

function recordFieldMatches(
  expected: unknown,
  actual: unknown,
  fieldKey: string,
): boolean {
  const expectedValues = normalizeComparableRecordValue(expected, fieldKey);
  if (expectedValues.length === 0) {
    return true;
  }
  const actualValues = normalizeComparableRecordValue(actual, fieldKey);
  return expectedValues.every((expectedValue) =>
    actualValues.some(
      (actualValue) =>
        actualValue === expectedValue ||
        actualValue.includes(expectedValue) ||
        expectedValue.includes(actualValue),
    ),
  );
}

function scoreRecordDetailAccuracy(input: {
  expected: readonly Record<string, unknown>[];
  actual: readonly Record<string, unknown>[];
  identityKeys: readonly string[];
  detailKeys: readonly string[];
}): number {
  let comparedFields = 0;
  let matchedFields = 0;

  for (const expectedRecord of input.expected) {
    const actualRecord = input.actual.find((candidate) =>
      recordValueMatchesExpected({
        actual: candidate,
        expected: expectedRecord,
        keys: input.identityKeys,
      }),
    );

    for (const key of input.detailKeys) {
      if (
        normalizeComparableRecordValue(expectedRecord[key], key).length === 0
      ) {
        continue;
      }
      comparedFields += 1;
      if (
        actualRecord &&
        recordFieldMatches(expectedRecord[key], actualRecord[key], key)
      ) {
        matchedFields += 1;
      }
    }
  }

  return comparedFields === 0 ? 1 : safeDivide(matchedFields, comparedFields);
}

function scoreContradictionFreeRate(input: {
  profile: CandidateProfile;
  forbiddenProfileText: readonly string[];
}): number {
  if (input.forbiddenProfileText.length === 0) {
    return 1;
  }

  const serializedProfile = normalizeBenchmarkRecordString(
    JSON.stringify(input.profile),
  );
  const contradictionCount = input.forbiddenProfileText.filter((value) => {
    const normalized = normalizeBenchmarkRecordString(value);
    return Boolean(normalized && serializedProfile?.includes(normalized));
  }).length;

  return 1 - safeDivide(contradictionCount, input.forbiddenProfileText.length);
}

function summarizeRecordIdentities(input: {
  records: readonly Record<string, unknown>[];
  keys: readonly string[];
}): string[] {
  return input.records
    .map((record) => normalizeRecordIdentity(record, input.keys))
    .filter((entry): entry is string => Boolean(entry));
}

function scoreEvidenceCoverage(
  candidates: readonly ResumeImportFieldCandidate[],
): number {
  const autoApplied = candidates.filter(
    (candidate) => candidate.resolution === "auto_applied",
  );

  if (autoApplied.length === 0) {
    return 1;
  }

  const grounded = autoApplied.filter(
    (candidate) =>
      candidate.sourceBlockIds.length > 0 ||
      Boolean(normalizeString(candidate.evidenceText)),
  );

  return safeDivide(grounded.length, autoApplied.length);
}

function scoreAutoApplyPrecision(input: {
  expected: Record<string, unknown>;
  candidates: readonly ResumeImportFieldCandidate[];
}): number {
  const expectedKeys = new Set(Object.keys(input.expected));
  const comparableAutoApplied = input.candidates.filter(
    (candidate) =>
      candidate.resolution === "auto_applied" &&
      expectedKeys.has(candidate.target.key),
  );

  if (comparableAutoApplied.length === 0) {
    return 1;
  }

  let correct = 0;

  for (const candidate of comparableAutoApplied) {
    const expectedValue = input.expected[candidate.target.key];

    if (
      normalizeLooseString(candidate.value) ===
      normalizeLooseString(expectedValue)
    ) {
      correct += 1;
    }
  }

  return safeDivide(correct, comparableAutoApplied.length);
}

function scoreUnresolvedRate(
  candidates: readonly ResumeImportFieldCandidate[],
): number {
  if (candidates.length === 0) {
    return 0;
  }

  const unresolved = candidates.filter(
    (candidate) =>
      candidate.resolution === "needs_review" ||
      candidate.resolution === "abstained",
  );

  return safeDivide(unresolved.length, candidates.length);
}

export function buildCaseResult(input: {
  benchmarkCase: ResumeImportBenchmarkCase;
  parserStrategy: string;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  candidates: readonly ResumeImportFieldCandidate[];
}): ResumeImportBenchmarkCaseResult {
  const literalScores = scoreLiteralFields({
    expected: input.benchmarkCase.expected.literalFields,
    profile: input.profile,
    searchPreferences: input.searchPreferences,
  });
  const experienceCandidates = input.candidates.filter(
    (candidate) => candidate.target.section === "experience",
  );
  const educationCandidates = input.candidates.filter(
    (candidate) => candidate.target.section === "education",
  );
  const experienceRecords = getBenchmarkActualRecordValues({
    actual: experienceCandidates,
    section: "experience",
  });
  const shouldUseProfileExperienceRecords =
    input.benchmarkCase.expected.experienceRecords.length > 0;
  const scoredExperienceRecords = shouldUseProfileExperienceRecords
    ? [...experienceRecords, ...input.profile.experiences]
    : experienceRecords;
  const educationRecords = getBenchmarkActualRecordValues({
    actual: educationCandidates,
    section: "education",
  });
  const shouldUseProfileEducationRecords =
    input.benchmarkCase.expected.educationRecords.length > 0;
  const scoredEducationRecords = shouldUseProfileEducationRecords
    ? [...educationRecords, ...input.profile.education]
    : educationRecords;
  const projectRecords = getBenchmarkActualRecordValues({
    actual: input.candidates.filter(
      (candidate) => candidate.target.section === "project",
    ),
    section: "project",
  });
  const expectedProjectRecords = input.benchmarkCase.expected.projectRecords;
  const scoredProjectRecords =
    expectedProjectRecords !== undefined
      ? [...projectRecords, ...input.profile.projects]
      : projectRecords;
  const certificationRecords = getBenchmarkActualRecordValues({
    actual: input.candidates.filter(
      (candidate) => candidate.target.section === "certification",
    ),
    section: "certification",
  });
  const scoredCertificationRecords =
    input.benchmarkCase.expected.certificationRecords !== undefined
      ? [...certificationRecords, ...input.profile.certifications]
      : certificationRecords;
  const languageRecords = getBenchmarkActualRecordValues({
    actual: input.candidates.filter(
      (candidate) => candidate.target.section === "language",
    ),
    section: "language",
  });
  const scoredLanguageRecords =
    input.benchmarkCase.expected.languageRecords !== undefined
      ? [...languageRecords, ...input.profile.spokenLanguages]
      : languageRecords;
  const metrics: ResumeImportBenchmarkMetrics = {
    literalFieldPrecision: literalScores.literalFieldPrecision,
    literalFieldRecall: literalScores.literalFieldRecall,
    experienceRecordF1: scoreRecordF1({
      expected: input.benchmarkCase.expected.experienceRecords,
      actual: scoredExperienceRecords,
      keys: ["title", "companyName"],
    }),
    experienceDetailAccuracy: scoreRecordDetailAccuracy({
      expected: input.benchmarkCase.expected.experienceRecords,
      actual: scoredExperienceRecords,
      identityKeys: ["title", "companyName"],
      detailKeys: [
        "startDate",
        "endDate",
        "isCurrent",
        "location",
        "summary",
        "achievements",
      ],
    }),
    educationRecordF1: scoreRecordF1({
      expected: input.benchmarkCase.expected.educationRecords,
      actual: scoredEducationRecords,
      keys: ["schoolName", "degree"],
    }),
    projectRecordF1: scoreOptionalRecordF1({
      expected: expectedProjectRecords,
      actual: scoredProjectRecords,
      keys: ["name"],
    }),
    certificationRecordF1: scoreOptionalRecordF1({
      expected: input.benchmarkCase.expected.certificationRecords,
      actual: scoredCertificationRecords,
      keys: ["name", "issuer"],
    }),
    languageRecordF1: scoreOptionalRecordF1({
      expected: input.benchmarkCase.expected.languageRecords,
      actual: scoredLanguageRecords,
      keys: ["language"],
    }),
    contradictionFreeRate: scoreContradictionFreeRate({
      profile: input.profile,
      forbiddenProfileText:
        input.benchmarkCase.expected.forbiddenProfileText ?? [],
    }),
    evidenceCoverage: scoreEvidenceCoverage(input.candidates),
    autoApplyPrecision: scoreAutoApplyPrecision({
      expected: input.benchmarkCase.expected.literalFields,
      candidates: input.candidates,
    }),
    unresolvedRate: scoreUnresolvedRate(input.candidates),
  };
  const taxonomy = buildTaxonomy({
    benchmarkCase: input.benchmarkCase,
    workflowCandidates: input.candidates,
    profile: input.profile,
  });

  const passed =
    metrics.literalFieldRecall >= 0.75 &&
    metrics.experienceRecordF1 >= 0.5 &&
    metrics.experienceDetailAccuracy >= 0.75 &&
    metrics.educationRecordF1 >= 0.5 &&
    metrics.projectRecordF1 >= 0.5 &&
    metrics.certificationRecordF1 >= 0.5 &&
    metrics.languageRecordF1 >= 0.5 &&
    metrics.contradictionFreeRate === 1 &&
    metrics.autoApplyPrecision >= 0.9 &&
    !taxonomy.includes("MISSING_EVIDENCE") &&
    !taxonomy.includes("OVERCONFIDENT_AUTO_APPLY") &&
    !taxonomy.includes("UNRESOLVED_SHOULD_HAVE_RESOLVED");
  const notes =
    metrics.experienceRecordF1 < 0.5
      ? [
          `Expected experience identities: ${summarizeRecordIdentities({ records: input.benchmarkCase.expected.experienceRecords, keys: ["title", "companyName"] }).join(", ")}`,
          `Actual experience identities: ${summarizeRecordIdentities({ records: scoredExperienceRecords, keys: ["title", "companyName"] }).join(", ")}`,
        ]
      : [];

  return {
    caseId: input.benchmarkCase.id,
    label: input.benchmarkCase.label,
    parserStrategy: input.parserStrategy,
    passed,
    metrics,
    taxonomy,
    notes,
  };
}

export function aggregateBenchmarkMetrics(
  results: readonly ResumeImportBenchmarkCaseResult[],
): ResumeImportBenchmarkMetrics {
  return {
    literalFieldPrecision: average(
      results.map((result) => result.metrics.literalFieldPrecision),
    ),
    literalFieldRecall: average(
      results.map((result) => result.metrics.literalFieldRecall),
    ),
    experienceRecordF1: average(
      results.map((result) => result.metrics.experienceRecordF1),
    ),
    experienceDetailAccuracy: average(
      results.map((result) => result.metrics.experienceDetailAccuracy),
    ),
    educationRecordF1: average(
      results.map((result) => result.metrics.educationRecordF1),
    ),
    projectRecordF1: average(
      results.map((result) => result.metrics.projectRecordF1),
    ),
    certificationRecordF1: average(
      results.map((result) => result.metrics.certificationRecordF1),
    ),
    languageRecordF1: average(
      results.map((result) => result.metrics.languageRecordF1),
    ),
    contradictionFreeRate: average(
      results.map((result) => result.metrics.contradictionFreeRate),
    ),
    evidenceCoverage: average(
      results.map((result) => result.metrics.evidenceCoverage),
    ),
    autoApplyPrecision: average(
      results.map((result) => result.metrics.autoApplyPrecision),
    ),
    unresolvedRate: average(
      results.map((result) => result.metrics.unresolvedRate),
    ),
  };
}

function createBenchmarkContext(input: {
  aiClient: JobFinderAiClient;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  visionProvider?: ResumeVisionProvider;
}): WorkspaceServiceContext {
  const repository = createInMemoryJobFinderRepository(
    buildBenchmarkRepositoryState({
      profile: input.profile,
      searchPreferences: input.searchPreferences,
    }),
  );
  const browserRuntime = createCatalogBrowserSessionRuntime({
    sessions: [],
    catalog: [],
  });
  const documentManager = {
    listResumeTemplates: () => [],
    renderResumePreview() {
      return Promise.reject(
        new Error("Resume preview is not available in the benchmark harness."),
      );
    },
    renderResumeArtifact(
      input: Parameters<JobFinderDocumentManager["renderResumeArtifact"]>[0],
    ) {
      void input;
      return Promise.reject(
        new Error(
          "Resume rendering is not available in the benchmark harness.",
        ),
      );
    },
  } satisfies JobFinderDocumentManager;

  return {
    aiClient: input.aiClient,
    ...(input.visionProvider ? { visionProvider: input.visionProvider } : {}),
    browserRuntime,
    documentManager,
    repository,
    activeDiscoveryAbortControllerRef: { current: null },
    activeDiscoveryRunIdRef: { current: null },
    activeDiscoveryPromiseRef: { current: null },
    activeSourceDebugExecutionIdRef: { current: null },
    activeSourceDebugAbortControllerRef: { current: null },
    activeSourceDebugPromiseRef: { current: null },
    activeApplyRunAbortControllers: new Map<string, AbortController>(),
    activeApplyRunPromises: new Map<string, Promise<void>>(),
    applyRunTransitionTails: new Map<string, Promise<void>>(),
    markApplicationPreparationStarted: () =>
      Promise.reject(
        new Error(
          "Application preparation is not available in the benchmark harness.",
        ),
      ),
    withApplicationCrmTransition: (operation) => operation(),
    withIntelligenceTransition: (operation) => operation(),
    withCampaignTransition: (operation) => operation(),
    activeResumeVisionRunIds: new Set<string>(),
    activeResumeEvidenceRunIds: new Set<string>(),
    getWorkspaceSnapshot: () =>
      Promise.reject(
        new Error(
          "Workspace snapshots are not available in the benchmark harness.",
        ),
      ),
    readWorkspaceSnapshot: () =>
      Promise.reject(
        new Error(
          "Workspace snapshots are not available in the benchmark harness.",
        ),
      ),
    getActiveCampaignId: () => Promise.resolve(null),
    resumeApplicationUserAction: () => Promise.resolve(undefined),
    continueDiscoveryForSource: () =>
      Promise.resolve({ status: "continued" as const }),
    runSourceDebugWorkflow: () =>
      Promise.reject(
        new Error("Source debug is not available in the benchmark harness."),
      ),
    persistDiscoveryState: (updater) =>
      repository.commitDiscoveryStateUpdate(updater),
    refreshDiscoverySessions: () => Promise.resolve([]),
    saveDiscoveryTargetUpdate: () => repository.getSearchPreferences(),
    saveJobSiteMetadata: () =>
      Promise.reject(
        new Error("Source metadata is not used by resume import."),
      ),
    persistSourceDebugRun: () => Promise.resolve(undefined),
    persistBrowserSessionState: () => Promise.resolve(undefined),
    staleApprovedResumeDrafts: () => Promise.resolve(undefined),
    openRunBrowserSession: () => Promise.resolve(undefined),
    closeRunBrowserSession: () => Promise.resolve(undefined),
    closeParkedBrowserTab: () => Promise.resolve(undefined),
    hasActiveBrowserWorkflow: () => false,
    resumeActivityForExplicitStart: () => Promise.resolve(),
    updateJob: () => Promise.resolve(undefined),
  };
}

export async function runResumeImportBenchmark(input: {
  request: ResumeImportBenchmarkRequest;
  createHarness: ResumeImportBenchmarkHarnessFactory;
}): Promise<ResumeImportBenchmarkReport> {
  const request = ResumeImportBenchmarkRequestSchema.parse(input.request);
  const benchmarkCases = request.canaryOnly
    ? request.cases.filter((benchmarkCase) => benchmarkCase.canary)
    : request.cases;
  const results: ResumeImportBenchmarkCaseResult[] = [];
  const manifestVersions = new Set<string>();
  const providerKinds = new Set<string>();
  const providerLabels = new Set<string>();

  for (const benchmarkCase of benchmarkCases) {
    const harness = await input.createHarness(benchmarkCase, request);
    const aiClient =
      harness.aiClient ?? buildBenchmarkAiClient(request.useConfiguredAi);
    const ctx = createBenchmarkContext({
      aiClient,
      profile: harness.profile,
      searchPreferences: harness.searchPreferences,
      ...(request.useVision && harness.visionArtifact
        ? {
            visionProvider:
              harness.visionProvider ?? createBenchmarkVisionProvider(),
          }
        : {}),
    });
    const expectedProfileRevision = (
      await ctx.repository.getProfileWithRevision()
    ).revision;
    const workflowResult = await runResumeImportWorkflow(ctx, {
      profile: harness.profile,
      searchPreferences: harness.searchPreferences,
      documentBundle: harness.documentBundle,
      trigger: "import",
      expectedProfileRevision,
      importWarnings: harness.documentBundle.warnings,
      ...(request.useVision && harness.visionArtifact
        ? { visionArtifact: harness.visionArtifact }
        : {}),
    });
    const providerStatus = aiClient.getStatus();

    if (harness.workerManifestVersion) {
      manifestVersions.add(harness.workerManifestVersion);
    }

    providerKinds.add(providerStatus.kind);
    providerLabels.add(providerStatus.label);

    results.push(
      buildCaseResult({
        benchmarkCase,
        parserStrategy: harness.parseMethod,
        profile: workflowResult.profile,
        searchPreferences: workflowResult.searchPreferences,
        candidates: workflowResult.candidates,
      }),
    );
  }

  const parserManifestVersions = [...manifestVersions].sort();
  const parserManifestVersion =
    parserManifestVersions.length === 0
      ? null
      : parserManifestVersions.length === 1
        ? (parserManifestVersions[0] ?? null)
        : `mixed:${parserManifestVersions.join(",")}`;

  return ResumeImportBenchmarkReportSchema.parse({
    benchmarkVersion: request.benchmarkVersion,
    generatedAt: new Date().toISOString(),
    parserManifestVersion,
    parserManifestVersions,
    analysisProviderKind:
      providerKinds.size === 1
        ? ([
            ...providerKinds,
          ][0] as ResumeImportBenchmarkReport["analysisProviderKind"])
        : null,
    analysisProviderLabel:
      providerLabels.size === 1 ? ([...providerLabels][0] ?? null) : null,
    cases: results,
    aggregate: aggregateBenchmarkMetrics(results),
    notes: request.useVision
      ? ["Vision branch enabled for benchmark run."]
      : [],
  });
}

export { buildBenchmarkAiClient };
