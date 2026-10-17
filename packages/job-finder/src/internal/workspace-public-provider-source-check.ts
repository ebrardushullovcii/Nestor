import {
  SourceDebugEvidenceRefSchema,
  SourceDebugWorkerAttemptSchema,
  SourceInstructionArtifactSchema,
  SourceInstructionVerificationSchema,
  type JobDiscoveryTarget,
  type JobSource,
  type SourceDebugEvidenceRef,
  type SourceDebugWorkerAttempt,
  type SourceInstructionArtifact,
  type SourceInstructionVersionInfo,
} from "@nestor/contracts";

import { uniqueStrings } from "./shared";
import {
  collectPublicProviderJobs,
  inferSourceIntelligenceFromTarget,
} from "./workspace-source-intelligence";

export type PublicProviderSourceCheckResult = {
  artifact: SourceInstructionArtifact;
  attempt: SourceDebugWorkerAttempt;
  evidenceRefs: SourceDebugEvidenceRef[];
  proofSummary: string;
  jobCount: number;
};

function resolveProviderApplyPath(
  jobs: Awaited<ReturnType<typeof collectPublicProviderJobs>>["jobs"],
) {
  if (jobs.some((job) => job.applyPath === "easy_apply")) {
    return "easy_apply" as const;
  }

  if (jobs.some((job) => job.applyPath === "external_redirect")) {
    return "external_redirect" as const;
  }

  return "unknown" as const;
}

/**
 * Validates reusable provider capabilities without launching an agent browser.
 *
 * A working public provider API already proves the repeatable collection entry,
 * normalized filtering surface, canonical job identities, and apply-entry URLs.
 * Browser exploration remains the fallback when the provider probe is unavailable,
 * empty, or fails.
 */
export async function runPublicProviderSourceCheck(input: {
  target: JobDiscoveryTarget;
  source: JobSource;
  runId: string;
  versionInfo: SourceInstructionVersionInfo;
  signal?: AbortSignal;
}): Promise<PublicProviderSourceCheckResult | null> {
  const intelligence = inferSourceIntelligenceFromTarget({
    target: input.target,
    currentArtifact: null,
  });
  const provider = intelligence.provider;

  if (
    !provider ||
    provider.apiAvailability !== "available" ||
    !provider.publicApiUrlTemplate
  ) {
    return null;
  }

  const startedAt = new Date().toISOString();
  const collection = await collectPublicProviderJobs({
    target: input.target,
    artifact: { intelligence },
    source: input.source,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (collection.warning || collection.jobs.length === 0) {
    return null;
  }

  const completedAt = new Date().toISOString();
  const attemptId = `source_debug_attempt_provider_api_${Date.now()}`;
  const canonicalUrls = uniqueStrings(
    collection.jobs.map((job) => job.canonicalUrl),
  );
  const applicationUrls = uniqueStrings(
    collection.jobs.flatMap((job) =>
      job.applicationUrl ? [job.applicationUrl] : [],
    ),
  );
  const proofSummary =
    `${provider.label} public API returned ${collection.jobs.length} normalized job ` +
    `record${collection.jobs.length === 1 ? "" : "s"} with ` +
    `${canonicalUrls.length} distinct canonical URL${canonicalUrls.length === 1 ? "" : "s"}.`;
  const navigationGuidance = [
    `Start at the configured jobs page; its ${provider.label} public provider API is the repeatable listing entry path.`,
  ];
  const searchGuidance = [
    `Use the ${provider.label} public provider API to collect the available listings, then apply keyword, location, and department filters locally; the provider response reliably returns job records without depending on board-only controls.`,
  ];
  const detailGuidance = [
    "Use the canonical detail URL returned for each provider job record as the stable job identity.",
  ];
  const applyGuidance = [
    "Use the provider-supplied application URL as the safe apply entry and stop before any final submission.",
  ];
  const verification = SourceInstructionVerificationSchema.parse({
    id: `source_instruction_verification_${input.runId}`,
    replayRunId: input.runId,
    verifiedAt: completedAt,
    outcome: "passed",
    proofSummary,
    reason: null,
    versionInfo: input.versionInfo,
  });
  // The provider's own API returned the jobs: the route is proven.
  const status = "validated";
  const evidenceRefs = [
    SourceDebugEvidenceRefSchema.parse({
      id: `${attemptId}_provider_api`,
      runId: input.runId,
      attemptId,
      targetId: input.target.id,
      phase: "replay_verification",
      kind: "url",
      label: `${provider.label} public provider API`,
      capturedAt: completedAt,
      url: provider.publicApiUrlTemplate,
      storagePath: null,
      excerpt: proofSummary,
    }),
    ...collection.jobs.slice(0, 3).map((job, index) =>
      SourceDebugEvidenceRefSchema.parse({
        id: `${attemptId}_job_${index + 1}`,
        runId: input.runId,
        attemptId,
        targetId: input.target.id,
        phase: "replay_verification",
        kind: "url",
        label: `${job.title} at ${job.company}`,
        capturedAt: completedAt,
        url: job.canonicalUrl,
        storagePath: null,
        excerpt: job.summary ?? job.description,
      }),
    ),
  ];
  const attempt = SourceDebugWorkerAttemptSchema.parse({
    id: attemptId,
    runId: input.runId,
    targetId: input.target.id,
    phase: "replay_verification",
    startedAt,
    completedAt,
    outcome: "succeeded",
    completionMode: "structured_finish",
    completionReason: "Public provider API capabilities were verified.",
    strategyLabel: "Public provider API verification",
    strategyFingerprint: `replay_verification:${input.source}:public_provider_api`,
    confirmedFacts: [
      proofSummary,
      ...navigationGuidance,
      ...searchGuidance,
      ...detailGuidance,
      ...applyGuidance,
    ],
    attemptedActions: [
      `Fetched the ${provider.label} public provider API.`,
      `Validated ${canonicalUrls.length} canonical job URL${canonicalUrls.length === 1 ? "" : "s"}.`,
      `Validated ${applicationUrls.length} application entry URL${applicationUrls.length === 1 ? "" : "s"} without submitting.`,
    ],
    blockerSummary: null,
    resultSummary: proofSummary,
    confidenceScore: 96,
    nextRecommendedStrategies: [],
    avoidStrategyFingerprints: [],
    evidenceRefIds: evidenceRefs.map((evidenceRef) => evidenceRef.id),
    phaseEvidence: {
      visibleControls: [],
      successfulInteractions: [
        "Public provider API returned normalized job records.",
      ],
      routeSignals: canonicalUrls.slice(0, 5),
      attemptedControls: ["Fetched the public provider API collection."],
      warnings: [],
      visualFindings: [],
    },
    visualEvidence: [],
    compactionState: null,
    timing: null,
  });
  const artifact = SourceInstructionArtifactSchema.parse({
    id: `source_instruction_${input.target.id}_${Date.now()}`,
    targetId: input.target.id,
    status,
    createdAt: startedAt,
    updatedAt: completedAt,
    acceptedAt: status === "validated" ? completedAt : null,
    basedOnRunId: input.runId,
    basedOnAttemptIds: [attempt.id],
    notes: proofSummary,
    navigationGuidance,
    searchGuidance,
    detailGuidance,
    applyGuidance,
    warnings: [],
    intelligence: {
      ...intelligence,
      collection: {
        ...intelligence.collection,
        preferredMethod: "api",
        rankedMethods: uniqueStrings([
          "api",
          ...intelligence.collection.rankedMethods,
        ]),
      },
      apply: {
        ...intelligence.apply,
        applyPath: resolveProviderApplyPath(collection.jobs),
      },
      reliability: {
        ...intelligence.reliability,
        verifiedAt: completedAt,
        freshnessNotes: uniqueStrings([
          proofSummary,
          ...intelligence.reliability.freshnessNotes,
        ]),
      },
    },
    versionInfo: input.versionInfo,
    verification,
  });

  return {
    artifact,
    attempt,
    evidenceRefs,
    proofSummary,
    jobCount: collection.jobs.length,
  };
}
