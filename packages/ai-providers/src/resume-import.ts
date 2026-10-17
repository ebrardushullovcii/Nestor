import type {
  CandidateProfile,
  JobSearchPreferences,
  ResumeDocumentBlock,
  ResumeDocumentBundle,
  ResumeImportFieldCandidate,
  ResumeImportTargetSection,
} from "@nestor/contracts";
import {
  NonEmptyStringSchema,
  ResumeImportFieldCandidateDraftSchema,
  type ResumeImportVisionArtifact,
  type AgentProviderStatus,
} from "@nestor/contracts";
import { z } from "zod";

import {
  experienceSectionHeadingPattern,
  nonExperienceSectionHeadingPattern,
} from "./deterministic/constants";
import { buildCandidateConfidenceBreakdown } from "./resume-import-helpers";

export const resumeImportExtractionStageValues = [
  "identity_summary",
  "experience",
  "background",
  "shared_memory",
] as const;
export const ResumeImportExtractionStageSchema = z.enum(
  resumeImportExtractionStageValues,
);
export type ResumeImportExtractionStage = z.infer<
  typeof ResumeImportExtractionStageSchema
>;
export const ResumeImportStageExtractionTimingSchema = z.object({
  durationMs: z.number().int().min(0),
  primaryProviderMs: z.number().int().min(0).nullable().default(null),
  deterministicFallbackMs: z.number().int().min(0).nullable().default(null),
});
export type ResumeImportStageExtractionTiming = z.infer<
  typeof ResumeImportStageExtractionTimingSchema
>;

/**
 * Recorded when a stage asked the configured model, did not get an answer, and
 * silently continued on the deterministic reader. The stage still returns
 * candidates, so nothing else in the pipeline can tell the difference; this is
 * the only place the degradation is observable.
 */
export const ResumeImportStageFallbackSchema = z.object({
  kind: z.enum(["timeout", "provider_error"]),
  reason: NonEmptyStringSchema,
});
export type ResumeImportStageFallback = z.infer<
  typeof ResumeImportStageFallbackSchema
>;

export const ResumeImportStageExtractionResultSchema = z.object({
  stage: ResumeImportExtractionStageSchema,
  analysisProviderKind: z.enum(["deterministic", "openai_compatible"]),
  analysisProviderLabel: NonEmptyStringSchema,
  candidates: z.array(ResumeImportFieldCandidateDraftSchema).default([]),
  notes: z.array(NonEmptyStringSchema).default([]),
  timing: ResumeImportStageExtractionTimingSchema.nullable().optional(),
  // Optional, like `timing`: only the fallback-aware client records it, and a
  // stage that reached the model has nothing to declare.
  fallback: ResumeImportStageFallbackSchema.nullable().optional(),
});
export type ResumeImportStageExtractionResult = z.infer<
  typeof ResumeImportStageExtractionResultSchema
>;

export interface ExtractResumeImportStageInput {
  stage: ResumeImportExtractionStage;
  existingProfile: CandidateProfile;
  existingSearchPreferences: JobSearchPreferences;
  documentBundle: ResumeDocumentBundle;
}

const stageSectionHints: Record<
  ResumeImportExtractionStage,
  readonly ResumeDocumentBlock["sectionHint"][]
> = {
  identity_summary: ["identity", "summary", "contact"],
  experience: ["experience"],
  background: [
    "skills",
    "education",
    "certifications",
    "projects",
    "languages",
  ],
  shared_memory: ["summary", "experience", "projects", "skills", "contact"],
};

function matchesAnyPattern(
  value: string,
  patterns: readonly RegExp[],
): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function findHeadingIndex(
  blocks: readonly ResumeDocumentBlock[],
  startIndex: number,
  patterns: readonly RegExp[],
): number {
  for (let index = startIndex; index < blocks.length; index += 1) {
    const block = blocks[index];

    if (!block) {
      continue;
    }

    if (matchesAnyPattern(block.text.trim(), patterns)) {
      return index;
    }
  }

  return -1;
}

function sliceHeadingRange(
  blocks: readonly ResumeDocumentBlock[],
  startPatterns: readonly RegExp[],
  stopPatterns: readonly RegExp[],
): ResumeDocumentBlock[] {
  const startIndex = findHeadingIndex(blocks, 0, startPatterns);

  if (startIndex === -1) {
    return [];
  }

  const stopIndex = findHeadingIndex(blocks, startIndex + 1, stopPatterns);
  return blocks.slice(startIndex, stopIndex === -1 ? undefined : stopIndex);
}

function dedupeBlocks(
  blocks: readonly ResumeDocumentBlock[],
): ResumeDocumentBlock[] {
  const seen = new Set<string>();

  return blocks.filter((block) => {
    if (seen.has(block.id)) {
      return false;
    }

    seen.add(block.id);
    return true;
  });
}

function sortBlocksForStructuredExtraction(
  blocks: readonly ResumeDocumentBlock[],
): ResumeDocumentBlock[] {
  return [...blocks].sort((left, right) => {
    if (left.pageNumber !== right.pageNumber) {
      return left.pageNumber - right.pageNumber;
    }

    const topDelta =
      (left.bbox?.top ?? left.readingOrder) -
      (right.bbox?.top ?? right.readingOrder);
    if (Math.abs(topDelta) > 1) {
      return topDelta;
    }

    const leftColumn = left.bbox?.left ?? 0;
    const rightColumn = right.bbox?.left ?? 0;

    if (Math.abs(leftColumn - rightColumn) > 14) {
      return leftColumn - rightColumn;
    }

    return left.readingOrder - right.readingOrder;
  });
}

const stageTargetSections: Record<
  ResumeImportExtractionStage,
  readonly ResumeImportTargetSection[]
> = {
  identity_summary: [
    "identity",
    "contact",
    "location",
    "search_preferences",
    "work_eligibility",
  ],
  experience: ["experience"],
  background: [
    "education",
    "certification",
    "link",
    "project",
    "language",
    "skill",
  ],
  shared_memory: [
    "narrative",
    "proof_point",
    "answer_bank",
    "application_identity",
  ],
};

export function buildValuePreview(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const preview = value
      .map((entry) => buildValuePreview(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 4)
      .join(", ");
    return preview || null;
  }

  if (value && typeof value === "object") {
    const preview = Object.values(value as Record<string, unknown>)
      .map((entry) => buildValuePreview(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 4)
      .join(" | ");
    return preview || null;
  }

  return null;
}

export function selectBlocksForResumeImportStage(
  documentBundle: ResumeDocumentBundle,
  stage: ResumeImportExtractionStage,
): ResumeDocumentBlock[] {
  const blocks = sortBlocksForStructuredExtraction(documentBundle.blocks);
  const experienceBlocks = sliceHeadingRange(
    blocks,
    [experienceSectionHeadingPattern],
    [nonExperienceSectionHeadingPattern],
  );
  const skillsBlocks = sliceHeadingRange(
    blocks,
    [/^skills$/i, /^technical skills$/i, /^core skills$/i, /^key skills$/i],
    [experienceSectionHeadingPattern],
  );
  const educationBlocks = sliceHeadingRange(
    blocks,
    [/^education(?: and training)?$/i, /^education$/i],
    [/^language skills$/i, /^certifications?$/i],
  );
  const languageBlocks = sliceHeadingRange(
    blocks,
    [/^language skills$/i],
    [/^certifications?$/i],
  );
  const preSkillsCutoff = findHeadingIndex(blocks, 0, [
    /^skills$/i,
    experienceSectionHeadingPattern,
  ]);
  const introBlocks = blocks.slice(
    0,
    preSkillsCutoff === -1 ? Math.min(blocks.length, 16) : preSkillsCutoff,
  );

  if (stage === "identity_summary") {
    const selected = dedupeBlocks([
      ...introBlocks,
      ...blocks.filter((block) => block.kind === "contact"),
    ]);

    if (selected.length > 0) {
      return selected;
    }
  }

  if (stage === "experience" && experienceBlocks.length > 0) {
    return experienceBlocks;
  }

  if (stage === "background") {
    const selected = dedupeBlocks([
      ...skillsBlocks,
      ...educationBlocks,
      ...languageBlocks,
    ]);

    if (selected.length > 0) {
      return selected;
    }
  }

  if (stage === "shared_memory") {
    const selected = dedupeBlocks([
      ...introBlocks,
      ...experienceBlocks.slice(0, 28),
    ]);

    if (selected.length > 0) {
      return selected;
    }
  }

  const preferredHints = new Set(stageSectionHints[stage]);
  const preferredBlocks = blocks.filter((block) =>
    preferredHints.has(block.sectionHint),
  );

  if (preferredBlocks.length > 0) {
    return preferredBlocks;
  }

  return blocks.slice(0, 40);
}

export function sanitizeStageCandidates(
  input: ExtractResumeImportStageInput,
  output: ResumeImportStageExtractionResult,
): ResumeImportStageExtractionResult {
  const validBlockIds = new Set(
    input.documentBundle.blocks.map((block) => block.id),
  );
  const validSections = new Set(stageTargetSections[input.stage]);

  const candidates = output.candidates.flatMap((candidate) => {
    if (!validSections.has(candidate.target.section)) {
      return [];
    }

    return [
      ResumeImportFieldCandidateDraftSchema.parse({
        ...candidate,
        valuePreview:
          candidate.valuePreview ?? buildValuePreview(candidate.value),
        sourceBlockIds: candidate.sourceBlockIds.filter((id) =>
          validBlockIds.has(id),
        ),
        confidenceBreakdown:
          candidate.confidenceBreakdown ??
          buildCandidateConfidenceBreakdown({
            candidate,
            bundle: input.documentBundle,
          }),
      }),
    ];
  });

  return ResumeImportStageExtractionResultSchema.parse({
    ...output,
    stage: input.stage,
    candidates,
  });
}

export function createEmptyStageExtractionResult(
  stage: ResumeImportExtractionStage,
  status: AgentProviderStatus,
): ResumeImportStageExtractionResult {
  return ResumeImportStageExtractionResultSchema.parse({
    stage,
    analysisProviderKind: status.kind,
    analysisProviderLabel: status.label,
    candidates: [],
    notes: [],
  });
}

export const ResumeVisionExtractionResultSchema = z.object({
  analysisProviderKind: z.enum(["deterministic", "openai_compatible_vision"]),
  analysisProviderLabel: NonEmptyStringSchema,
  candidates: z.array(ResumeImportFieldCandidateDraftSchema).default([]),
  notes: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
  primaryErrorMessage: NonEmptyStringSchema.nullable().default(null),
  fallbackUsed: z.boolean().optional(),
  // Same optional contract as the text stages: only a provider that actually
  // lost its model call declares one, and the declared kind is what the run
  // reports, so a degraded visual scan can never read as a model result.
  fallback: ResumeImportStageFallbackSchema.nullable().optional(),
});
export type ResumeVisionExtractionResult = z.infer<
  typeof ResumeVisionExtractionResultSchema
>;

export interface ExtractResumeVisionInput {
  existingProfile: CandidateProfile;
  existingSearchPreferences: JobSearchPreferences;
  documentBundle: ResumeDocumentBundle;
  visionArtifact: ResumeImportVisionArtifact;
}

export interface ResumeVisionProvider {
  getStatus(): AgentProviderStatus;
  extractResumeVision(
    input: ExtractResumeVisionInput,
  ): Promise<ResumeVisionExtractionResult>;
}

export const ResumeImportAdjudicationResultSchema = z.object({
  candidates: z.array(ResumeImportFieldCandidateDraftSchema).default([]),
  notes: z.array(NonEmptyStringSchema).default([]),
  warnings: z.array(NonEmptyStringSchema).default([]),
});
export type ResumeImportAdjudicationResult = z.infer<
  typeof ResumeImportAdjudicationResultSchema
>;

export interface AdjudicateResumeImportCandidatesInput {
  existingProfile: CandidateProfile;
  existingSearchPreferences: JobSearchPreferences;
  documentBundle: ResumeDocumentBundle;
  candidates: readonly ResumeImportFieldCandidate[];
}
