import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFileJobFinderRepository } from "./index";
import { createSeed } from "./test-fixtures";
import type {
  ResumeDocumentBundle,
  ResumeImportFieldCandidate,
  ResumeImportRun,
  SavedJob,
} from "@nestor/contracts";
import { SavedJobSchema } from "@nestor/contracts";

export type FileRepository = Awaited<
  ReturnType<typeof createFileJobFinderRepository>
>;

export async function createTempRepository(prefix: string) {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(tempDirectory, "job-finder-state.sqlite");

  return {
    tempDirectory,
    filePath,
    createRepository: () =>
      createFileJobFinderRepository({
        filePath,
        seed: createSeed(),
      }),
    cleanup: () => rm(tempDirectory, { recursive: true, force: true }),
  };
}

export async function cleanupTempDirectoryWithRetry(
  tempDirectory: string,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await rm(tempDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

export function createSavedJob(overrides: Partial<SavedJob> = {}): SavedJob {
  return SavedJobSchema.parse({
    id: "job_1",
    source: "target_site",
    sourceJobId: "target_job_1",
    discoveryMethod: "catalog_seed",
    canonicalUrl: "https://jobs.example.com/roles/target_job_1",
    applicationUrl: "https://jobs.example.com/roles/target_job_1/apply",
    title: "Lead Designer",
    company: "Signal Systems",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: "2026-03-20T10:00:00.000Z",
    postedAtText: null,
    discoveredAt: "2026-03-20T10:01:00.000Z",
    firstSeenAt: "2026-03-20T10:01:00.000Z",
    lastSeenAt: "2026-03-20T10:01:00.000Z",
    lastVerifiedActiveAt: "2026-03-20T10:01:00.000Z",
    salaryText: "$180k",
    normalizedCompensation: {
      currency: "USD",
      interval: "year",
      minAmount: 180000,
      maxAmount: 180000,
      minAnnualUsd: 180000,
      maxAnnualUsd: 180000,
    },
    summary: "Lead product design.",
    description: "Lead product design for operational software.",
    keySkills: ["Figma"],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: [],
    },
    keywordSignals: [],
    benefits: [],
    status: "ready_for_review",
    matchAssessment: {
      score: 94,
      reasons: ["Strong overlap"],
      gaps: [],
    },
    provenance: [],
    ...overrides,
  });
}

export function createResumeImportArtifactsFixture(): {
  run: ResumeImportRun;
  documentBundles: ResumeDocumentBundle[];
  fieldCandidates: ResumeImportFieldCandidate[];
} {
  return {
    run: {
      id: "resume_import_run_1",
      sourceResumeId: "resume_1",
      sourceResumeFileName: "resume.pdf",
      trigger: "import",
      status: "review_ready",
      startedAt: "2026-04-10T10:00:00.000Z",
      completedAt: "2026-04-10T10:00:03.000Z",
      primaryParserKind: "pdfjs_text",
      parserKinds: ["pdfjs_text"],
      routeKind: "native_first",
      parserManifestVersion: "parser-manifest-v1",
      qualityScore: 0.94,
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Built-in deterministic agent fallback",
      warnings: [
        "1 imported suggestion still needs review before the app should rely on it everywhere.",
      ],
      errorMessage: null,
      candidateCounts: {
        total: 2,
        autoApplied: 1,
        needsReview: 1,
        rejected: 0,
        abstained: 0,
      },
    },
    documentBundles: [
      {
        id: "resume_bundle_1",
        runId: "resume_import_run_1",
        sourceResumeId: "resume_1",
        sourceFileKind: "pdf",
        primaryParserKind: "pdfjs_text",
        parserKinds: ["pdfjs_text"],
        createdAt: "2026-04-10T10:00:01.000Z",
        languageHints: [],
        warnings: [],
        parserManifest: {
          workerKind: "python_sidecar",
          workerVersion: "0.1.0",
          manifestVersion: "parser-manifest-v1",
          runtimeLabel: "local-python",
          availableCapabilities: ["pdf_text_probe"],
          executorVersions: {
            pdfjs_text: "legacy",
          },
        },
        route: {
          routeKind: "native_first",
          triageReasons: ["healthy_native_text"],
          preferredExecutors: ["pdfjs_text"],
          usedExecutors: ["pdfjs_text"],
        },
        quality: {
          score: 0.94,
          textDensity: 0.91,
          tokenCount: 2,
          lineCount: 1,
          blockCount: 1,
          columnLikelihood: 0.05,
          readingOrderConfidence: 0.98,
          nativeTextCoverage: 1,
          ocrConfidence: null,
          imageCoverageRatio: 0,
          invalidUnicodeRatio: 0,
        },
        qualityWarnings: [],
        pages: [
          {
            pageNumber: 1,
            text: "Alex Vanguard",
            charCount: 13,
            parserKinds: ["pdfjs_text"],
            usedOcr: false,
            width: 612,
            height: 792,
            rotationDegrees: 0,
            routeKind: "native_first",
            quality: {
              score: 0.94,
              textDensity: 0.91,
              tokenCount: 2,
              lineCount: 1,
              blockCount: 1,
              columnLikelihood: 0.05,
              readingOrderConfidence: 0.98,
              nativeTextCoverage: 1,
              ocrConfidence: null,
              imageCoverageRatio: 0,
              invalidUnicodeRatio: 0,
            },
            qualityWarnings: [],
          },
        ],
        blocks: [
          {
            id: "block_1",
            pageNumber: 1,
            readingOrder: 0,
            text: "Alex Vanguard",
            kind: "heading",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["pdfjs_text"],
            sourceConfidence: 1,
            lineIds: ["line_1"],
            parserLineage: ["pdfjs_text"],
            readingOrderConfidence: 0.99,
            textSpan: { start: 0, end: 13 },
          },
        ],
        fullText: "Alex Vanguard",
      },
    ],
    fieldCandidates: [
      {
        id: "candidate_1",
        runId: "resume_import_run_1",
        target: { section: "identity", key: "fullName", recordId: null },
        label: "Full name",
        sourceKind: "parser_literal",
        value: "Alex Vanguard",
        normalizedValue: "Alex Vanguard",
        valuePreview: "Alex Vanguard",
        evidenceText: "Alex Vanguard",
        sourceBlockIds: ["block_1"],
        confidence: 0.99,
        confidenceBreakdown: {
          overall: 0.99,
          parserQuality: 0.98,
          evidenceQuality: 0.99,
          agreementScore: 0.98,
          normalizationRisk: 0.01,
          conflictRisk: 0.01,
          fieldSensitivity: "low",
          recommendation: "auto_apply",
        },
        notes: [],
        alternatives: [],
        resolution: "auto_applied",
        resolutionReason: "high_confidence_literal_with_direct_evidence",
        createdAt: "2026-04-10T10:00:02.000Z",
        resolvedAt: "2026-04-10T10:00:03.000Z",
      },
      {
        id: "candidate_2",
        runId: "resume_import_run_1",
        target: {
          section: "narrative",
          key: "professionalStory",
          recordId: null,
        },
        label: "Professional story",
        sourceKind: "model_shared_memory",
        value: "Builds resilient workflows.",
        normalizedValue: null,
        valuePreview: "Builds resilient workflows.",
        evidenceText: "Builds resilient workflows.",
        sourceBlockIds: ["block_1"],
        confidence: 0.44,
        confidenceBreakdown: {
          overall: 0.44,
          parserQuality: 0.94,
          evidenceQuality: 0.62,
          agreementScore: 0.28,
          normalizationRisk: 0.42,
          conflictRisk: 0.1,
          fieldSensitivity: "medium",
          recommendation: "needs_review",
        },
        notes: [],
        alternatives: [],
        resolution: "needs_review",
        resolutionReason: "shared_memory_requires_review",
        createdAt: "2026-04-10T10:00:02.000Z",
        resolvedAt: null,
      },
    ],
  };
}
