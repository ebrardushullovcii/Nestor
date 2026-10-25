import { z } from "zod";

import {
  JobApplyPathSchema,
  JobDiscoveryCollectionMethodSchema,
  BrowserRunWaitReasonSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  SourceIntelligenceApiAvailabilitySchema,
  SourceIntelligenceProviderKeySchema,
  SourceDebugAttemptOutcomeSchema,
  SourceDebugPhaseCompletionModeSchema,
  SourceDebugPhaseSchema,
  SourceDebugRunStateSchema,
  SourceInstructionStatusSchema,
  SourceInstructionVerificationOutcomeSchema,
  UrlStringSchema,
} from "./base";
import {
  SharedAgentCompactionSnapshotSchema,
  type SharedAgentCompactionSnapshot,
} from "./agent-compaction";
import {
  BrowserVisualEvidenceSummarySchema,
  BrowserVisualObservationSetSchema,
  BrowserVisualRetentionPolicySchema,
  BrowserVisualSnapshotModeSchema,
  SourceDebugVisualFindingSchema,
} from "./visual";

export const SourceInstructionVersionInfoSchema = z.object({
  promptProfileVersion: NonEmptyStringSchema,
  toolsetVersion: NonEmptyStringSchema,
  adapterVersion: NonEmptyStringSchema,
  appSchemaVersion: NonEmptyStringSchema.nullable().default(null),
});
export type SourceInstructionVersionInfo = z.infer<
  typeof SourceInstructionVersionInfoSchema
>;

export const SourceDebugCompactionStateSchema =
  SharedAgentCompactionSnapshotSchema;
export type SourceDebugCompactionState = SharedAgentCompactionSnapshot;

export const SourceDebugPhaseEvidenceSchema = z.object({
  visibleControls: z.array(NonEmptyStringSchema).default([]),
  successfulInteractions: z.array(NonEmptyStringSchema).default([]),
  routeSignals: z.array(NonEmptyStringSchema).default([]),
  attemptedControls: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
  visualFindings: z.array(SourceDebugVisualFindingSchema).default([]),
});
export type SourceDebugPhaseEvidence = z.infer<
  typeof SourceDebugPhaseEvidenceSchema
>;

const SourceDebugEvidenceRefBaseSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  attemptId: NonEmptyStringSchema,
  targetId: NonEmptyStringSchema,
  phase: SourceDebugPhaseSchema,
  label: NonEmptyStringSchema,
  capturedAt: IsoDateTimeSchema,
});

const SourceDebugUrlEvidenceRefSchema = SourceDebugEvidenceRefBaseSchema.extend({
  kind: z.literal("url"),
  url: UrlStringSchema,
  storagePath: z.null().default(null),
  excerpt: NonEmptyStringSchema.nullable().default(null),
});

const SourceDebugScreenshotEvidenceRefSchema =
  SourceDebugEvidenceRefBaseSchema.extend({
    kind: z.literal("screenshot"),
    url: UrlStringSchema.nullable().default(null),
    storagePath: NonEmptyStringSchema,
    excerpt: NonEmptyStringSchema.nullable().default(null),
    visualSnapshotId: NonEmptyStringSchema.nullable().default(null),
    visualObservationSetId: NonEmptyStringSchema.nullable().default(null),
    visualMode: BrowserVisualSnapshotModeSchema.nullable().default(null),
    visualRetention: BrowserVisualRetentionPolicySchema.nullable().default(null),
    visualObservations: BrowserVisualObservationSetSchema.nullable().default(null),
  });

const SourceDebugNoteEvidenceRefSchema = SourceDebugEvidenceRefBaseSchema.extend(
  {
    kind: z.literal("note"),
    url: UrlStringSchema.nullable().default(null),
    storagePath: z.null().default(null),
    excerpt: NonEmptyStringSchema,
  },
);

export const SourceDebugEvidenceRefSchema = z.discriminatedUnion("kind", [
  SourceDebugUrlEvidenceRefSchema,
  SourceDebugScreenshotEvidenceRefSchema,
  SourceDebugNoteEvidenceRefSchema,
]);
export type SourceDebugEvidenceRef = z.infer<
  typeof SourceDebugEvidenceRefSchema
>;

export const SourceDebugWaitReasonDurationSchema = z.object({
  waitReason: BrowserRunWaitReasonSchema,
  durationMs: z.number().int().nonnegative().default(0),
});
export type SourceDebugWaitReasonDuration = z.infer<
  typeof SourceDebugWaitReasonDurationSchema
>;

export const SourceDebugTimingSummarySchema = z.object({
  totalDurationMs: z.number().int().nonnegative().default(0),
  firstProgressMs: z.number().int().nonnegative().nullable().default(null),
  longestGapMs: z.number().int().nonnegative().default(0),
  eventCount: z.number().int().nonnegative().default(0),
  waitReasonDurations: z.array(SourceDebugWaitReasonDurationSchema).default([]),
});
export type SourceDebugTimingSummary = z.infer<
  typeof SourceDebugTimingSummarySchema
>;

export const SourceDebugRunTimingSummarySchema = SourceDebugTimingSummarySchema.extend(
  {
    browserSetupMs: z.number().int().nonnegative().nullable().default(null),
    finalReviewMs: z.number().int().nonnegative().nullable().default(null),
    finalizationMs: z.number().int().nonnegative().nullable().default(null),
  },
);
export type SourceDebugRunTimingSummary = z.infer<
  typeof SourceDebugRunTimingSummarySchema
>;

export const SourceDebugWorkerAttemptSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  targetId: NonEmptyStringSchema,
  phase: SourceDebugPhaseSchema,
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable().default(null),
  outcome: SourceDebugAttemptOutcomeSchema,
  completionMode:
    SourceDebugPhaseCompletionModeSchema.default("structured_finish"),
  completionReason: NonEmptyStringSchema.nullable().default(null),
  strategyLabel: NonEmptyStringSchema,
  strategyFingerprint: NonEmptyStringSchema,
  confirmedFacts: z.array(NonEmptyStringSchema).default([]),
  attemptedActions: z.array(NonEmptyStringSchema).default([]),
  blockerSummary: NonEmptyStringSchema.nullable().default(null),
  resultSummary: NonEmptyStringSchema,
  confidenceScore: z.number().int().min(0).max(100).default(0),
  nextRecommendedStrategies: z.array(NonEmptyStringSchema).default([]),
  avoidStrategyFingerprints: z.array(NonEmptyStringSchema).default([]),
  evidenceRefIds: z.array(NonEmptyStringSchema).default([]),
  phaseEvidence: SourceDebugPhaseEvidenceSchema.nullable().default(null),
  visualEvidence: z.array(BrowserVisualEvidenceSummarySchema).default([]),
  compactionState: SourceDebugCompactionStateSchema.nullable().default(null),
  timing: SourceDebugTimingSummarySchema.nullable().default(null),
});
export type SourceDebugWorkerAttempt = z.infer<
  typeof SourceDebugWorkerAttemptSchema
>;
export type SourceDebugWorkerAttemptInput = z.input<
  typeof SourceDebugWorkerAttemptSchema
>;

export const SourceDebugPhaseSummarySchema = z.object({
  phase: SourceDebugPhaseSchema,
  summary: NonEmptyStringSchema,
  completionMode:
    SourceDebugPhaseCompletionModeSchema.default("structured_finish"),
  completionReason: NonEmptyStringSchema.nullable().default(null),
  confirmedFacts: z.array(NonEmptyStringSchema).default([]),
  blockerNotes: z.array(NonEmptyStringSchema).default([]),
  nextRecommendedStrategies: z.array(NonEmptyStringSchema).default([]),
  avoidStrategyFingerprints: z.array(NonEmptyStringSchema).default([]),
  producedAttemptIds: z.array(NonEmptyStringSchema).default([]),
  timing: SourceDebugTimingSummarySchema.nullable().default(null),
});
export type SourceDebugPhaseSummary = z.infer<
  typeof SourceDebugPhaseSummarySchema
>;

export const SourceInstructionVerificationSchema = z
  .object({
    id: NonEmptyStringSchema,
    replayRunId: NonEmptyStringSchema.nullable().default(null),
    verifiedAt: IsoDateTimeSchema.nullable().default(null),
    outcome: SourceInstructionVerificationOutcomeSchema.default("unverified"),
    proofSummary: NonEmptyStringSchema.nullable().default(null),
    reason: NonEmptyStringSchema.nullable().default(null),
    versionInfo: SourceInstructionVersionInfoSchema,
  })
  .superRefine((value, ctx) => {
    if (value.outcome === "unverified") {
      if (value.replayRunId !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Unverified source-instruction verification cannot point at a replay run.",
          path: ["replayRunId"],
        });
      }

      if (value.verifiedAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Unverified source-instruction verification cannot have a verified timestamp.",
          path: ["verifiedAt"],
        });
      }

      if (value.proofSummary !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Unverified source-instruction verification cannot include proof summary text.",
          path: ["proofSummary"],
        });
      }

      if (value.reason !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Unverified source-instruction verification cannot include a failure reason.",
          path: ["reason"],
        });
      }

      return;
    }

    if (value.replayRunId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Verified source-instruction outcomes must reference the replay run.",
        path: ["replayRunId"],
      });
    }

    if (value.verifiedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Verified source-instruction outcomes must include a verified timestamp.",
        path: ["verifiedAt"],
      });
    }

    if (value.outcome === "passed" && value.proofSummary === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Passed source-instruction verification must include a proof summary.",
        path: ["proofSummary"],
      });
    }
  });
export type SourceInstructionVerification = z.infer<
  typeof SourceInstructionVerificationSchema
>;

export const SourceIntelligenceConfidenceSchema = z
  .number()
  .min(0)
  .max(1)
  .default(0.5);
export type SourceIntelligenceConfidence = z.infer<
  typeof SourceIntelligenceConfidenceSchema
>;

export const SourceIntelligenceProviderSchema = z.object({
  key: SourceIntelligenceProviderKeySchema.default("other"),
  label: NonEmptyStringSchema,
  confidence: SourceIntelligenceConfidenceSchema,
  apiAvailability:
    SourceIntelligenceApiAvailabilitySchema.default("unconfirmed"),
  publicApiUrlTemplate: NonEmptyStringSchema.nullable().default(null),
  boardToken: NonEmptyStringSchema.nullable().default(null),
  boardSlug: NonEmptyStringSchema.nullable().default(null),
  providerIdentifier: NonEmptyStringSchema.nullable().default(null),
});
export type SourceIntelligenceProvider = z.infer<
  typeof SourceIntelligenceProviderSchema
>;

export const SourceIntelligenceRouteSchema = z.object({
  url: UrlStringSchema,
  label: NonEmptyStringSchema,
  kind: z
    .enum(["anchor", "listing", "search", "detail", "apply", "collection"])
    .default("listing"),
  confidence: SourceIntelligenceConfidenceSchema,
});
export type SourceIntelligenceRoute = z.infer<
  typeof SourceIntelligenceRouteSchema
>;

export const SourceIntelligenceRoutePatternSchema = z.object({
  pattern: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  confidence: SourceIntelligenceConfidenceSchema,
});
export type SourceIntelligenceRoutePattern = z.infer<
  typeof SourceIntelligenceRoutePatternSchema
>;

export const SourceIntelligenceCollectionStrategySchema = z.object({
  preferredMethod:
    JobDiscoveryCollectionMethodSchema.default("fallback_search"),
  rankedMethods: z.array(JobDiscoveryCollectionMethodSchema).default([]),
  startingRoutes: z.array(SourceIntelligenceRouteSchema).default([]),
  searchRouteTemplates: z.array(SourceIntelligenceRouteSchema).default([]),
  detailRoutePatterns: z.array(SourceIntelligenceRoutePatternSchema).default([]),
  listingMarkers: z.array(NonEmptyStringSchema).default([]),
});
export type SourceIntelligenceCollectionStrategy = z.infer<
  typeof SourceIntelligenceCollectionStrategySchema
>;

export const SourceIntelligenceApplyHintsSchema = z.object({
  applyPath: JobApplyPathSchema.default("unknown"),
  authMarkers: z.array(NonEmptyStringSchema).default([]),
  consentMarkers: z.array(NonEmptyStringSchema).default([]),
  questionSurfaceHints: z.array(NonEmptyStringSchema).default([]),
  resumeUploadHints: z.array(NonEmptyStringSchema).default([]),
});
export type SourceIntelligenceApplyHints = z.infer<
  typeof SourceIntelligenceApplyHintsSchema
>;

export const SourceIntelligenceReliabilitySchema = z.object({
  selectorFingerprints: z.array(NonEmptyStringSchema).default([]),
  stableControlNames: z.array(NonEmptyStringSchema).default([]),
  failureFingerprints: z.array(NonEmptyStringSchema).default([]),
  verifiedAt: IsoDateTimeSchema.nullable().default(null),
  freshnessNotes: z.array(NonEmptyStringSchema).default([]),
});
export type SourceIntelligenceReliability = z.infer<
  typeof SourceIntelligenceReliabilitySchema
>;

export const SourceIntelligenceOverridesSchema = z.object({
  forceMethod: JobDiscoveryCollectionMethodSchema.nullable().default(null),
  deniedRoutePatterns: z.array(NonEmptyStringSchema).default([]),
  extraStartingRoutes: z.array(UrlStringSchema).default([]),
});
export type SourceIntelligenceOverrides = z.infer<
  typeof SourceIntelligenceOverridesSchema
>;

export const SourceIntelligenceArtifactSchema = z.object({
  provider: SourceIntelligenceProviderSchema.nullable().default(null),
  collection: SourceIntelligenceCollectionStrategySchema.default({}),
  apply: SourceIntelligenceApplyHintsSchema.default({}),
  reliability: SourceIntelligenceReliabilitySchema.default({}),
  overrides: SourceIntelligenceOverridesSchema.default({}),
});
export type SourceIntelligenceArtifact = z.infer<
  typeof SourceIntelligenceArtifactSchema
>;

export const SourceInstructionArtifactSchema = z
  .object({
    id: NonEmptyStringSchema,
    targetId: NonEmptyStringSchema,
    status: SourceInstructionStatusSchema.default("draft"),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    acceptedAt: IsoDateTimeSchema.nullable().default(null),
    basedOnRunId: NonEmptyStringSchema,
    basedOnAttemptIds: z.array(NonEmptyStringSchema).default([]),
    notes: NonEmptyStringSchema.nullable().default(null),
    navigationGuidance: z.array(NonEmptyStringSchema).default([]),
    searchGuidance: z.array(NonEmptyStringSchema).default([]),
    detailGuidance: z.array(NonEmptyStringSchema).default([]),
    applyGuidance: z.array(NonEmptyStringSchema).default([]),
    warnings: z.array(NonEmptyStringSchema).default([]),
    intelligence: SourceIntelligenceArtifactSchema.default({}),
    versionInfo: SourceInstructionVersionInfoSchema,
    verification: SourceInstructionVerificationSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.status !== "validated") {
      return;
    }

    if (value.acceptedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Validated source instructions must record when they were accepted.",
        path: ["acceptedAt"],
      });
    }

    if (!value.verification || value.verification.outcome !== "passed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Validated source instructions must carry a passed verification record.",
        path: ["verification"],
      });
    }
  });
export type SourceInstructionArtifact = z.infer<
  typeof SourceInstructionArtifactSchema
>;

export const EditableSourceInstructionArtifactSchema = z.object({
  id: NonEmptyStringSchema,
  notes: NonEmptyStringSchema.nullable().default(null),
  navigationGuidance: z.array(NonEmptyStringSchema).default([]),
  searchGuidance: z.array(NonEmptyStringSchema).default([]),
  detailGuidance: z.array(NonEmptyStringSchema).default([]),
  applyGuidance: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
  intelligence: SourceIntelligenceArtifactSchema.default({}),
});
export type EditableSourceInstructionArtifact = z.infer<
  typeof EditableSourceInstructionArtifactSchema
>;

export const SourceDebugRunRecordSchema = z
  .object({
    id: NonEmptyStringSchema,
    targetId: NonEmptyStringSchema,
    state: SourceDebugRunStateSchema.default("idle"),
    startedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable().default(null),
    activePhase: SourceDebugPhaseSchema.nullable().default(null),
    phases: z.array(SourceDebugPhaseSchema).default([]),
    targetLabel: NonEmptyStringSchema,
    targetUrl: UrlStringSchema,
    targetHostname: NonEmptyStringSchema,
    manualPrerequisiteSummary: NonEmptyStringSchema.nullable().default(null),
    finalSummary: NonEmptyStringSchema.nullable().default(null),
    attemptIds: z.array(NonEmptyStringSchema).default([]),
    phaseSummaries: z.array(SourceDebugPhaseSummarySchema).default([]),
    instructionArtifactId: NonEmptyStringSchema.nullable().default(null),
    timing: SourceDebugRunTimingSummarySchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const isTerminalState =
      value.state === "completed" ||
      value.state === "cancelled" ||
      value.state === "failed" ||
      value.state === "interrupted";

    if (value.state === "idle") {
      if (value.completedAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Idle source-debug runs cannot have a completion timestamp.",
          path: ["completedAt"],
        });
      }

      if (value.activePhase !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Idle source-debug runs cannot have an active phase.",
          path: ["activePhase"],
        });
      }

      return;
    }

    if (value.state === "running") {
      if (value.completedAt !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Running source-debug runs cannot have a completion timestamp.",
          path: ["completedAt"],
        });
      }

      if (value.activePhase === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Running source-debug runs must keep track of the active phase.",
          path: ["activePhase"],
        });
      }

      return;
    }

    if (value.state === "paused_manual") {
      if (value.completedAt === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Manually paused source-debug runs must record when the pause happened.",
          path: ["completedAt"],
        });
      }

      if (value.activePhase === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Manually paused source-debug runs must keep the phase that needs attention.",
          path: ["activePhase"],
        });
      }

      return;
    }

    if (isTerminalState && value.completedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Finished source-debug runs must record a completion timestamp.",
        path: ["completedAt"],
      });
    }

    if (isTerminalState && value.activePhase !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Finished source-debug runs cannot keep an active phase.",
        path: ["activePhase"],
      });
    }
  });
export type SourceDebugRunRecord = z.infer<typeof SourceDebugRunRecordSchema>;

export const SourceDebugRunDetailsSchema = z.object({
  run: SourceDebugRunRecordSchema,
  attempts: z.array(SourceDebugWorkerAttemptSchema).default([]),
  evidenceRefs: z.array(SourceDebugEvidenceRefSchema).default([]),
  instructionArtifact: SourceInstructionArtifactSchema.nullable().default(null),
});
export type SourceDebugRunDetails = z.infer<typeof SourceDebugRunDetailsSchema>;

export const SourceDebugProgressEventSchema = z.object({
  runId: NonEmptyStringSchema,
  targetId: NonEmptyStringSchema,
  phase: SourceDebugPhaseSchema.nullable().default(null),
  waitReason: BrowserRunWaitReasonSchema,
  timestamp: IsoDateTimeSchema,
  elapsedMs: z.number().int().nonnegative(),
  lastActivityAt: IsoDateTimeSchema,
  message: NonEmptyStringSchema,
  /**
   * The raw note the browser workflow recorded for this step, when it differs
   * from the plain sentence above.
   *
   * `message` is the only line a person reads; internal phase names, tool
   * calls and request logs belong here, behind the renderer's "Technical
   * details" disclosure. Optional so every producer written before this field
   * existed keeps validating.
   */
  technicalDetail: NonEmptyStringSchema.nullable().default(null),
  currentUrl: UrlStringSchema.nullable().default(null),
  stepCount: z.number().int().nonnegative().default(0),
  jobsFound: z.number().int().nonnegative().default(0),
});
export type SourceDebugProgressEvent = z.infer<
  typeof SourceDebugProgressEventSchema
>;
