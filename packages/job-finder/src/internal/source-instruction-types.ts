import { SourceIntelligenceArtifactSchema } from "@nestor/contracts";
import type {
  SourceIntelligenceArtifact,
  BrowserVisualEvidenceSummary,
  SourceDebugCompactionState,
  SourceDebugPhase,
  SourceDebugPhaseCompletionMode,
  SourceDebugPhaseEvidence,
  SourceDebugWorkerAttempt,
} from "@nestor/contracts";
import { uniqueStrings } from "./shared";

export interface SourceInstructionQualityAssessment {
  highSignalNavigationOrSearch: string[];
  highSignalDetailOrApply: string[];
  qualifiesForValidation: boolean;
  qualityWarnings: string[];
}

export interface SourceInstructionReviewOverride {
  navigationGuidance: string[] | null;
  searchGuidance: string[] | null;
  detailGuidance: string[] | null;
  applyGuidance: string[] | null;
  warnings: string[] | null;
  intelligence: SourceIntelligenceArtifact | null;
  /**
   * The review's own call on whether a future search can rely on this
   * guidance (ADR 0041). Null when it did not say.
   */
  ready?: boolean | null;
}

export interface SourceInstructionFinalReviewPhaseContext {
  phase: SourceDebugPhase;
  phaseGoal: string;
  successCriteria: string[];
  stopConditions: string[];
  knownFactsAtStart: string[];
  startedAt: string;
  completedAt: string | null;
  outcome: SourceDebugWorkerAttempt["outcome"];
  completionMode: SourceDebugPhaseCompletionMode;
  completionReason: string | null;
  resultSummary: string;
  blockerSummary: string | null;
  confirmedFacts: string[];
  attemptedActions: string[];
  phaseEvidence: SourceDebugPhaseEvidence | null;
  visualEvidence: BrowserVisualEvidenceSummary[];
  compactionState: SourceDebugCompactionState | null;
  reviewTranscript: string[];
}

export function readReviewOverrideStringArray(
  payload: Record<string, unknown>,
  key: keyof SourceInstructionReviewOverride,
): string[] | null {
  if (!(key in payload)) {
    return null;
  }

  const value = payload[key];

  if (!Array.isArray(value)) {
    return null;
  }

  return uniqueStrings(
    value.flatMap((entry) => (typeof entry === "string" ? [entry.trim()] : [])),
  );
}

export function parseSourceInstructionReviewOverride(
  raw: unknown,
): SourceInstructionReviewOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const payload = raw as Record<string, unknown>;

  const intelligence = (() => {
    if (!("intelligence" in payload)) {
      return null;
    }

    try {
      const rawIntelligence = payload.intelligence;
      if (
        !rawIntelligence ||
        typeof rawIntelligence !== "object" ||
        Array.isArray(rawIntelligence)
      ) {
        return null;
      }
      const normalized = structuredClone(rawIntelligence) as Record<
        string,
        unknown
      >;
      const collection = normalized.collection;
      if (
        collection &&
        typeof collection === "object" &&
        !Array.isArray(collection) &&
        (collection as Record<string, unknown>).preferredMethod === null
      ) {
        delete (collection as Record<string, unknown>).preferredMethod;
      }
      const apply = normalized.apply;
      if (
        apply &&
        typeof apply === "object" &&
        !Array.isArray(apply) &&
        (apply as Record<string, unknown>).applyPath === null
      ) {
        delete (apply as Record<string, unknown>).applyPath;
      }
      return SourceIntelligenceArtifactSchema.parse(normalized);
    } catch (error) {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          "Failed to parse payload.intelligence into SourceIntelligenceArtifactSchema",
          error,
        );
      }
      return null;
    }
  })();

  return {
    navigationGuidance: readReviewOverrideStringArray(
      payload,
      "navigationGuidance",
    ),
    searchGuidance: readReviewOverrideStringArray(payload, "searchGuidance"),
    detailGuidance: readReviewOverrideStringArray(payload, "detailGuidance"),
    applyGuidance: readReviewOverrideStringArray(payload, "applyGuidance"),
    warnings: readReviewOverrideStringArray(payload, "warnings"),
    intelligence,
    ready: typeof payload.ready === "boolean" ? payload.ready : null,
  };
}
