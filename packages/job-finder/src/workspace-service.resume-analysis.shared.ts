import type {
  ResumeDocumentBundle,
  ResumeImportFieldCandidate,
} from "@nestor/contracts";
import type { createWorkspaceServiceHarness } from "./workspace-service.test-support";

export function createTestBundle(input: {
  fullText: string;
  primaryParserKind?: ResumeDocumentBundle["primaryParserKind"];
  parserKinds?: ResumeDocumentBundle["parserKinds"];
  routeKind?: NonNullable<ResumeDocumentBundle["route"]>["routeKind"];
  qualityScore?: number;
  blocks?: ResumeDocumentBundle["blocks"];
  pages?: ResumeDocumentBundle["pages"];
}): ResumeDocumentBundle {
  return {
    id: "bundle_test",
    runId: "bundle_run_test",
    sourceResumeId: "resume_test",
    sourceFileKind: "pdf",
    primaryParserKind: input.primaryParserKind ?? "pdfjs_text",
    parserKinds: input.parserKinds ?? [input.primaryParserKind ?? "pdfjs_text"],
    createdAt: "2026-04-10T00:00:00.000Z",
    warnings: [],
    languageHints: [],
    pages:
      input.pages ??
      [
        {
          pageNumber: 1,
          text: input.fullText,
          charCount: input.fullText.length,
          parserKinds: input.parserKinds ?? [input.primaryParserKind ?? "pdfjs_text"],
          usedOcr: false,
          routeKind: input.routeKind ?? "native_first",
          quality: {
            score: input.qualityScore ?? 0.92,
            textDensity: 0.9,
            tokenCount: input.fullText.split(/\s+/).filter(Boolean).length,
            lineCount: input.fullText.split(/\r?\n/).filter(Boolean).length,
            blockCount: input.blocks?.length ?? input.fullText.split(/\r?\n/).filter(Boolean).length,
            columnLikelihood: 0.08,
            readingOrderConfidence: 0.95,
            nativeTextCoverage: 1,
            ocrConfidence: null,
            imageCoverageRatio: 0.04,
            invalidUnicodeRatio: 0,
          },
          qualityWarnings: [],
        },
      ],
    blocks:
      input.blocks ??
      input.fullText.split(/\r?\n/).filter(Boolean).map((text, index) => ({
        id: `page_1_block_${index + 1}`,
        pageNumber: 1,
        readingOrder: index,
        text,
        kind: index === 0 ? "heading" : "paragraph",
        sectionHint: index === 0 ? "identity" : "other",
        bbox: null,
        sourceParserKinds: input.parserKinds ?? [input.primaryParserKind ?? "pdfjs_text"],
        sourceConfidence: 0.9,
        parserLineage: input.parserKinds ?? [input.primaryParserKind ?? "pdfjs_text"],
        readingOrderConfidence: 0.94,
        lineIds: [`line_${index + 1}`],
        textSpan: null,
      })),
    fullText: input.fullText,
    route: {
      routeKind: input.routeKind ?? "native_first",
      triageReasons: ["test_fixture"],
      preferredExecutors: input.parserKinds ?? [input.primaryParserKind ?? "pdfjs_text"],
      usedExecutors: input.parserKinds ?? [input.primaryParserKind ?? "pdfjs_text"],
    },
    parserManifest: {
      workerKind: "embedded_node",
      workerVersion: process.versions.node,
      manifestVersion: "019-test-v1",
      runtimeLabel: "vitest",
      availableCapabilities: ["resume_import"],
      executorVersions: {
        [input.primaryParserKind ?? "pdfjs_text"]: process.versions.node,
      },
    },
    quality: {
      score: input.qualityScore ?? 0.92,
      textDensity: 0.9,
      tokenCount: input.fullText.split(/\s+/).filter(Boolean).length,
      lineCount: input.fullText.split(/\r?\n/).filter(Boolean).length,
      blockCount: input.blocks?.length ?? input.fullText.split(/\r?\n/).filter(Boolean).length,
      columnLikelihood: 0.08,
      readingOrderConfidence: 0.95,
      nativeTextCoverage: 1,
      ocrConfidence: null,
      imageCoverageRatio: 0.04,
      invalidUnicodeRatio: 0,
    },
    qualityWarnings: [],
  };
}

export function createStageCandidate(input: {
  target: ResumeImportFieldCandidate["target"];
  label: string;
  value: ResumeImportFieldCandidate["value"];
  sourceBlockIds?: string[];
  confidence?: number;
  recommendation?: NonNullable<ResumeImportFieldCandidate["confidenceBreakdown"]>["recommendation"];
  overall?: number;
}): Omit<ResumeImportFieldCandidate, "id" | "runId" | "sourceKind" | "resolution" | "createdAt" | "resolvedAt"> {
  const fieldSensitivity =
    input.target.section === "experience"
      ? "high"
      : input.target.section === "link"
        ? "low"
        : "medium";

  return {
    target: input.target,
    label: input.label,
    value: input.value,
    normalizedValue: null,
    valuePreview: typeof input.value === "string" ? input.value : JSON.stringify(input.value),
    evidenceText: typeof input.value === "string" ? input.value : JSON.stringify(input.value),
    sourceBlockIds: input.sourceBlockIds ?? [],
    confidence: input.confidence ?? 0.82,
    confidenceBreakdown: {
      overall: input.overall ?? input.confidence ?? 0.82,
      parserQuality: 0.92,
      evidenceQuality: input.sourceBlockIds?.length ? 0.94 : 0.4,
      agreementScore: 0.9,
      normalizationRisk: 0.08,
      conflictRisk: 0.06,
      fieldSensitivity,
      recommendation: input.recommendation ?? "needs_review",
    },
    notes: [],
    alternatives: [],
    conflictChoices: [],
    visualEvidence: [],
  };
}

export async function listLatestRunCandidates(
  repository: ReturnType<typeof createWorkspaceServiceHarness>["repository"],
  filter: {
    resolution?: ResumeImportFieldCandidate["resolution"];
    resolutions?: readonly ResumeImportFieldCandidate["resolution"][];
  } = {},
): Promise<readonly ResumeImportFieldCandidate[]> {
  const run = await repository.getLatestResumeImportRun();

  return repository.listResumeImportFieldCandidates({
    runId: run?.id ?? "",
    ...filter,
  });
}

export function findExperienceCandidateByTitle(
  candidates: readonly ResumeImportFieldCandidate[],
  title: string,
): ResumeImportFieldCandidate | undefined {
  return candidates.find((candidate) => {
    if (candidate.target.section !== "experience") {
      return false;
    }

    if (!candidate.value || typeof candidate.value !== "object") {
      return false;
    }

    return (candidate.value as { title?: unknown }).title === title;
  });
}
