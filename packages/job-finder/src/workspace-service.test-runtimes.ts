import {
  createDeterministicJobFinderAiClient,
  type JobFinderAiClient,
  type ResumeProfileExtraction,
} from "@nestor/ai-providers";
import { createCatalogBrowserSessionRuntime } from "@nestor/browser-runtime";
import type {
  AgentDiscoveryOptions,
  BrowserSessionRuntime,
} from "@nestor/browser-runtime";
import {
  AgentDebugFindingsSchema,
  JobPostingSchema,
  ResumeTemplateDefinitionSchema,
  SourceDebugPhaseEvidenceSchema,
} from "@nestor/contracts";
import type {
  AgentDebugFindings,
  AgentDiscoveryProgress,
  DiscoveryRunResult,
  EditableSourceInstructionArtifact,
  JobPosting,
  SharedAgentCompactionSnapshot,
  SourceIntelligenceArtifact,
  ResumeDocumentBundle,
  ResumeImportFieldCandidateDraft,
  ResumeResearchArtifact,
  SourceDebugPhaseCompletionMode,
  SourceDebugPhaseEvidence,
} from "@nestor/contracts";
import { SourceIntelligenceArtifactSchema } from "@nestor/contracts";

import type { JobFinderDocumentManager } from "./internal/workspace-service-contracts";
import type { SourceDebugPhase } from "@nestor/contracts";
import type { SourceDebugPhaseMap } from "./workspace-service.test-fixtures";

export type AgentDebugFindingsInput = Omit<
  AgentDebugFindings,
  "visualFindings" | "visualObservationSets"
> &
  Partial<Pick<AgentDebugFindings, "visualFindings" | "visualObservationSets">>;

export type SourceDebugPhaseEvidenceInput = Omit<
  SourceDebugPhaseEvidence,
  "visualFindings"
> &
  Partial<Pick<SourceDebugPhaseEvidence, "visualFindings">>;

export function createAgentDebugFindings(
  input: AgentDebugFindingsInput,
): AgentDebugFindings {
  return AgentDebugFindingsSchema.parse({
    ...input,
    visualFindings: input.visualFindings ?? [],
    visualObservationSets: input.visualObservationSets ?? [],
  });
}

export function createSourceDebugPhaseEvidence(
  input: SourceDebugPhaseEvidenceInput,
): SourceDebugPhaseEvidence {
  return SourceDebugPhaseEvidenceSchema.parse(input);
}

function normalizeTestJobPosting(job: Record<string, unknown>): JobPosting {
  return JobPostingSchema.parse({
    ...job,
    postedAtText: job.postedAtText ?? null,
    responsibilities: job.responsibilities ?? [],
    minimumQualifications: job.minimumQualifications ?? [],
    preferredQualifications: job.preferredQualifications ?? [],
    seniority: job.seniority ?? null,
    employmentType: job.employmentType ?? null,
    department: job.department ?? null,
    team: job.team ?? null,
    employerWebsiteUrl: job.employerWebsiteUrl ?? null,
    employerDomain: job.employerDomain ?? null,
    benefits: job.benefits ?? [],
  });
}

export function createBrowserRuntime() {
  return createCatalogBrowserSessionRuntime({
    sessions: [
      {
        source: "target_site",
        status: "ready",
        driver: "catalog_seed",
        label: "Browser session ready",
        detail: "Validated recently.",
        lastCheckedAt: "2026-03-20T10:04:00.000Z",
      },
    ],
    catalog: [
      {
        source: "target_site",
        sourceJobId: "linkedin_signal_ready",
        discoveryMethod: "catalog_seed",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_signal_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:00:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T10:04:00.000Z",
        salaryText: "$180k - $220k",
        summary: "Own the design system.",
        description: "Own the design system and workflow platform.",
        keySkills: ["Figma", "Design Systems"],
        responsibilities: ["Own the design system roadmap."],
        minimumQualifications: ["Strong product design systems experience."],
        preferredQualifications: ["Workflow-platform product background."],
        seniority: "Senior",
        employmentType: "Full-time",
        department: "Design",
        team: "Design Systems",
        employerWebsiteUrl: "https://signalsystems.example.com",
        employerDomain: "signalsystems.example.com",
        benefits: ["Remote-first collaboration"],
      },
      {
        source: "target_site",
        sourceJobId: "linkedin_pause_case",
        discoveryMethod: "catalog_seed",
        canonicalUrl: "https://www.linkedin.com/jobs/view/linkedin_pause_case",
        title: "Principal UX Engineer",
        company: "Void Industries",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:30:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T10:04:00.000Z",
        salaryText: "$185k - $210k",
        summary: "Lead UI platform work.",
        description:
          "Lead UI platform work. Additional work authorization details are required during apply.",
        keySkills: ["React", "Design Systems"],
        responsibilities: ["Lead UI platform architecture."],
        minimumQualifications: ["Deep React experience."],
        preferredQualifications: ["Accessibility leadership experience."],
        seniority: "Principal",
        employmentType: "Full-time",
        department: "Engineering",
        team: "UI Platform",
        employerWebsiteUrl: "https://void.example.com",
        employerDomain: "void.example.com",
        benefits: ["Remote-first collaboration"],
      },
    ].map((job) => normalizeTestJobPosting(job)),
  });
}

export function createAiClient() {
  return createDeterministicJobFinderAiClient(
    "Tests use the deterministic fallback agent.",
  );
}

/**
 * A stand-in for the model's resume fact check (ADR 0041): each line gets the
 * verdict the test names for its exact text, and "supported" otherwise, plus
 * the fix the test names for it, if any.
 */
export function fakeResumeClaimCheck(
  verdicts: Readonly<
    Record<string, "supported" | "stretch" | "unsupported">
  > = {},
  fixes: Readonly<Record<string, string>> = {},
): NonNullable<JobFinderAiClient["checkResumeClaims"]> {
  return (input) =>
    Promise.resolve(
      input.claims.map((claim) => ({
        id: claim.id,
        verdict: verdicts[claim.text.trim()] ?? "supported",
        reason: "Test verdict.",
        evidenceIds: [],
        fix: fixes[claim.text.trim()] ?? null,
      })),
    );
}

export function createAgentAiClient() {
  const fallbackClient = createDeterministicJobFinderAiClient(
    "Tests use the deterministic fallback agent.",
  );

  return {
    ...fallbackClient,
    // The source check's final review (ADR 0041) keeps the check's notes as
    // filed, the way a model with nothing to reconcile would, and calls them
    // ready when nothing in them warns otherwise.
    chatWithTools: (messages) => {
      const prompt = extractLatestUserPrompt(messages);
      const payloadAt = prompt.indexOf("Evidence payload:\n");
      if (
        prompt.startsWith("Review the full source-debug evidence") &&
        payloadAt >= 0
      ) {
        const payload = JSON.parse(
          prompt.slice(payloadAt + "Evidence payload:\n".length),
        ) as { checkNotes: { warnings?: unknown[] } };
        return Promise.resolve({
          content: JSON.stringify({
            ...payload.checkNotes,
            ready: (payload.checkNotes.warnings ?? []).length === 0,
          }),
          toolCalls: [],
        });
      }
      return Promise.resolve({ content: "ok", toolCalls: [] });
    },
  } satisfies JobFinderAiClient;
}

export function extractLatestUserPrompt(
  messages: readonly { role: string; content: string }[],
): string {
  return (
    [...messages].reverse().find((message) => message.role === "user")
      ?.content ?? ""
  );
}

export function toEditableSourceInstructionArtifactInput(artifact: {
  id: string;
  notes: string | null;
  navigationGuidance: readonly string[];
  searchGuidance: readonly string[];
  detailGuidance: readonly string[];
  applyGuidance: readonly string[];
  warnings: readonly string[];
  intelligence?: SourceIntelligenceArtifact | null;
}): EditableSourceInstructionArtifact {
  return {
    id: artifact.id,
    notes: artifact.notes,
    navigationGuidance: [...artifact.navigationGuidance],
    searchGuidance: [...artifact.searchGuidance],
    detailGuidance: [...artifact.detailGuidance],
    applyGuidance: [...artifact.applyGuidance],
    warnings: [...artifact.warnings],
    intelligence:
      artifact.intelligence ?? SourceIntelligenceArtifactSchema.parse({}),
  };
}

export function createAgentBrowserRuntime(
  catalog: readonly Record<string, unknown>[],
  runtimeOptions?: {
    sessionStatus?: "ready" | "login_required" | "blocked";
    sessionDetail?: string;
    compactionState?: SharedAgentCompactionSnapshot | null;
    compactionUsedFallbackTrigger?: boolean;
    debugFindingsByPhase?: SourceDebugPhaseMap<AgentDebugFindingsInput | null>;
    reviewTranscriptByPhase?: SourceDebugPhaseMap<string[]>;
    phaseCompletionModeByPhase?: SourceDebugPhaseMap<SourceDebugPhaseCompletionMode | null>;
    phaseCompletionReasonByPhase?: SourceDebugPhaseMap<string | null>;
    phaseEvidenceByPhase?: SourceDebugPhaseMap<SourceDebugPhaseEvidenceInput | null>;
  },
): BrowserSessionRuntime {
  const baseRuntime = createCatalogBrowserSessionRuntime({
    sessions: [
      {
        source: "target_site",
        status: runtimeOptions?.sessionStatus ?? "ready",
        driver: "chrome_profile_agent",
        label: "Browser session ready",
        detail: runtimeOptions?.sessionDetail ?? "Validated recently.",
        lastCheckedAt: "2026-03-20T10:04:00.000Z",
      },
    ],
    catalog: catalog.map((job) => normalizeTestJobPosting(job)),
  });

  return {
    ...baseRuntime,
    async runAgentDiscovery(
      source,
      options: AgentDiscoveryOptions,
    ): Promise<DiscoveryRunResult> {
      const phaseId = options.taskPacket?.phase ?? null;
      // One learning run now does what the old access, structure, search,
      // detail, and apply phases did between them (ADR 0023). A fixture that
      // still describes those phases separately is read as one answer: what
      // that run would have learned.
      const findingsInput = phaseId
        ? mergeLearningPhaseFindings(
            runtimeOptions?.debugFindingsByPhase,
            phaseId,
          )
        : null;
      const debugFindings = findingsInput
        ? createAgentDebugFindings(findingsInput)
        : null;
      const phaseCompletionMode = phaseId
        ? (resolveLearningPhaseValue(
            runtimeOptions?.phaseCompletionModeByPhase,
            phaseId,
            (value) => value !== null && value !== "structured_finish",
          ) ?? "structured_finish")
        : "structured_finish";
      const phaseCompletionReason = phaseId
        ? (resolveLearningPhaseValue(
            runtimeOptions?.phaseCompletionReasonByPhase,
            phaseId,
            (value) => value !== null,
          ) ?? null)
        : null;
      const evidenceInput = phaseId
        ? mergeLearningPhaseEvidence(
            runtimeOptions?.phaseEvidenceByPhase,
            phaseId,
          )
        : null;
      const phaseEvidence = evidenceInput
        ? createSourceDebugPhaseEvidence(evidenceInput)
        : null;
      const reviewTranscript = phaseId
        ? (mergeLearningPhaseTranscript(
            runtimeOptions?.reviewTranscriptByPhase,
            phaseId,
          ) ?? [])
        : [];
      const emitProgress = (progress: AgentDiscoveryProgress) => {
        options.onProgress?.(progress);
      };

      emitProgress({
        currentUrl:
          options.startingUrls[0] ?? "https://www.linkedin.com/jobs/search/",
        jobsFound: 0,
        stepCount: 1,
        currentAction: "navigate",
        targetId: null,
        adapterKind: source,
      });

      if (options.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      await Promise.resolve();

      emitProgress({
        currentUrl:
          options.startingUrls[0] ?? "https://www.linkedin.com/jobs/search/",
        jobsFound: catalog.length,
        stepCount: 2,
        currentAction: `extract_result:${catalog.length}:${catalog.length}:${catalog.length}`,
        targetId: null,
        adapterKind: source,
      });

      if (options.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      return {
        source,
        startedAt: "2026-03-20T10:00:00.000Z",
        completedAt: "2026-03-20T10:01:00.000Z",
        querySummary: "Agent discovery test run",
        warning: null,
        inventoryCompleteness: "complete",
        jobs: catalog.map((job) => normalizeTestJobPosting(job)),
        agentMetadata: {
          steps: 2,
          incomplete: false,
          transcriptMessageCount: 7,
          reviewTranscript,
          compactionState: runtimeOptions?.compactionState ?? null,
          compactionUsedFallbackTrigger:
            runtimeOptions?.compactionUsedFallbackTrigger ?? false,
          phaseCompletionMode,
          phaseCompletionReason,
          phaseEvidence,
          debugFindings,
        },
      };
    },
  };
}

/** The old phases whose work the one learning run now does. */
const LEARNING_PHASES: readonly SourceDebugPhase[] = [
  "access_auth_probe",
  "site_structure_mapping",
  "search_filter_probe",
  "job_detail_validation",
  "apply_path_validation",
];

function learningPhaseKeys(
  phaseId: SourceDebugPhase,
): readonly SourceDebugPhase[] {
  return phaseId === "site_structure_mapping" ? LEARNING_PHASES : [phaseId];
}

function resolveLearningPhaseValue<T>(
  map: Partial<Record<SourceDebugPhase, T>> | undefined,
  phaseId: SourceDebugPhase,
  isDecisive: (value: T) => boolean,
): T | undefined {
  if (!map) return undefined;
  const keys = learningPhaseKeys(phaseId);
  for (const key of keys) {
    const value = map[key];
    if (value !== undefined && isDecisive(value)) return value;
  }
  return map[phaseId];
}

function mergeLearningPhaseFindings(
  map: SourceDebugPhaseMap<AgentDebugFindingsInput | null> | undefined,
  phaseId: SourceDebugPhase,
): AgentDebugFindingsInput | null {
  if (!map) return null;
  const parts = learningPhaseKeys(phaseId)
    .map((key) => map[key])
    .filter((value): value is AgentDebugFindingsInput => Boolean(value));
  if (parts.length === 0) return null;
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      const current = merged[key];
      if (Array.isArray(value)) {
        const currentValues: unknown[] = Array.isArray(current)
          ? Array.from(current as unknown[])
          : [];
        const values: unknown[] = Array.from(value as unknown[]);
        merged[key] = currentValues.concat(values);
      } else if (current === undefined || current === null) {
        merged[key] = value;
      }
    }
  }
  return merged as AgentDebugFindingsInput;
}

function mergeLearningPhaseEvidence(
  map: SourceDebugPhaseMap<SourceDebugPhaseEvidenceInput | null> | undefined,
  phaseId: SourceDebugPhase,
): SourceDebugPhaseEvidenceInput | null {
  if (!map) return null;
  const parts = learningPhaseKeys(phaseId)
    .map((key) => map[key])
    .filter((value): value is SourceDebugPhaseEvidenceInput => Boolean(value));
  if (parts.length === 0) return null;
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      const current = merged[key];
      if (Array.isArray(value)) {
        const currentValues: unknown[] = Array.isArray(current)
          ? Array.from(current as unknown[])
          : [];
        const values: unknown[] = Array.from(value as unknown[]);
        merged[key] = currentValues.concat(values);
      } else {
        merged[key] = current ?? value;
      }
    }
  }
  return merged as SourceDebugPhaseEvidenceInput;
}

function mergeLearningPhaseTranscript(
  map: SourceDebugPhaseMap<string[]> | undefined,
  phaseId: SourceDebugPhase,
): string[] | undefined {
  if (!map) return undefined;
  const parts = learningPhaseKeys(phaseId).flatMap((key) => map[key] ?? []);
  return parts.length > 0 ? parts : map[phaseId];
}

export function createExtractionAiClient(
  extraction: ResumeProfileExtraction,
): JobFinderAiClient {
  const fallbackClient = createDeterministicJobFinderAiClient(
    "Tests use the deterministic fallback agent.",
  );

  function normalizeEvidenceText(value: string): string {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function buildEvidenceCandidates(value: unknown): string[] {
    if (typeof value === "string") {
      return value.trim() ? [value.trim()] : [];
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return [String(value)];
    }

    if (Array.isArray(value)) {
      return value.flatMap((entry) => buildEvidenceCandidates(entry));
    }

    if (value && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).flatMap((entry) =>
        buildEvidenceCandidates(entry),
      );
    }

    return [];
  }

  function groundCandidatesToBundle<
    TCandidate extends {
      value?: unknown;
      evidenceText?: string | null;
      sourceBlockIds: string[];
    },
  >(
    documentBundle: ResumeDocumentBundle,
    candidates: readonly TCandidate[],
  ): TCandidate[] {
    return candidates.map((candidate): TCandidate => {
      if (candidate.sourceBlockIds.length > 0) {
        return candidate;
      }

      const evidenceCandidates = buildEvidenceCandidates(candidate.value).map(
        normalizeEvidenceText,
      );
      const matchedBlocks = documentBundle.blocks.filter((block) => {
        const blockText = normalizeEvidenceText(block.text);
        return evidenceCandidates.some(
          (entry) => entry.length >= 4 && blockText.includes(entry),
        );
      });

      if (matchedBlocks.length === 0) {
        return candidate;
      }

      return {
        ...candidate,
        sourceBlockIds: matchedBlocks.slice(0, 3).map((block) => block.id),
        evidenceText: candidate.evidenceText ?? matchedBlocks[0]?.text ?? null,
      } as TCandidate;
    });
  }

  function buildStageCandidates(
    stage: Parameters<
      JobFinderAiClient["extractResumeImportStage"]
    >[0]["stage"],
    documentBundle: ResumeDocumentBundle,
  ): ResumeImportFieldCandidateDraft[] {
    type StageCandidates = ResumeImportFieldCandidateDraft[];

    if (stage === "identity_summary") {
      const candidates: StageCandidates = [];

      if (extraction.fullName) {
        candidates.push({
          target: {
            section: "identity" as const,
            key: "fullName",
            recordId: null,
          },
          label: "Full name",
          value: extraction.fullName,
          normalizedValue: extraction.fullName,
          valuePreview: extraction.fullName,
          evidenceText: extraction.fullName,
          sourceBlockIds: [],
          confidence: 0.95,
          notes: [],
          alternatives: [],
        });
      }

      if (extraction.headline) {
        candidates.push({
          target: {
            section: "identity" as const,
            key: "headline",
            recordId: null,
          },
          label: "Headline",
          value: extraction.headline,
          normalizedValue: extraction.headline,
          valuePreview: extraction.headline,
          evidenceText: extraction.headline,
          sourceBlockIds: [],
          confidence: 0.9,
          notes: [],
          alternatives: [],
        });
      }

      if (extraction.summary) {
        candidates.push({
          target: {
            section: "identity" as const,
            key: "summary",
            recordId: null,
          },
          label: "Summary",
          value: extraction.summary,
          normalizedValue: extraction.summary,
          valuePreview: extraction.summary,
          evidenceText: extraction.summary,
          sourceBlockIds: [],
          confidence: 0.84,
          notes: [],
          alternatives: [],
        });
      }

      if (extraction.currentLocation) {
        candidates.push({
          target: {
            section: "location" as const,
            key: "currentLocation",
            recordId: null,
          },
          label: "Current location",
          value: extraction.currentLocation,
          normalizedValue: extraction.currentLocation,
          valuePreview: extraction.currentLocation,
          evidenceText: extraction.currentLocation,
          sourceBlockIds: [],
          confidence: 0.99,
          notes: [],
          alternatives: [],
        });
      }

      if (extraction.email) {
        candidates.push({
          target: { section: "contact" as const, key: "email", recordId: null },
          label: "Email",
          value: extraction.email,
          normalizedValue: extraction.email,
          valuePreview: extraction.email,
          evidenceText: extraction.email,
          sourceBlockIds: [],
          confidence: 0.96,
          notes: [],
          alternatives: [],
        });
      }

      if (extraction.phone) {
        candidates.push({
          target: { section: "contact" as const, key: "phone", recordId: null },
          label: "Phone",
          value: extraction.phone,
          normalizedValue: extraction.phone,
          valuePreview: extraction.phone,
          evidenceText: extraction.phone,
          sourceBlockIds: [],
          confidence: 0.94,
          notes: [],
          alternatives: [],
        });
      }

      if (extraction.salaryCurrency) {
        candidates.push({
          target: {
            section: "search_preferences" as const,
            key: "salaryCurrency",
            recordId: null,
          },
          label: "Salary currency",
          value: extraction.salaryCurrency,
          normalizedValue: extraction.salaryCurrency,
          valuePreview: extraction.salaryCurrency,
          evidenceText: extraction.salaryCurrency,
          sourceBlockIds: [],
          confidence: 0.95,
          notes: [],
          alternatives: [],
        });
      }

      return groundCandidatesToBundle(documentBundle, candidates);
    }

    if (stage === "experience") {
      const candidates: StageCandidates = extraction.experiences.map(
        (entry, index) => ({
          target: {
            section: "experience" as const,
            key: "record",
            recordId: `experience_${index + 1}`,
          },
          label: entry.title ?? `Experience ${index + 1}`,
          value: entry,
          normalizedValue: entry,
          valuePreview: entry.title ?? entry.companyName ?? null,
          evidenceText: entry.summary,
          sourceBlockIds: [],
          confidence: 0.85,
          notes: [],
          alternatives: [],
        }),
      );

      return groundCandidatesToBundle(documentBundle, candidates);
    }

    if (stage === "background") {
      const candidates: StageCandidates = [
        ...extraction.links.map((entry, index) => ({
          target: {
            section: "link" as const,
            key: "record",
            recordId: `link_${index + 1}`,
          },
          label: entry.label ?? `Link ${index + 1}`,
          value: entry,
          normalizedValue: entry,
          valuePreview: entry.url,
          evidenceText: entry.url,
          sourceBlockIds: [],
          confidence: 0.9,
          notes: [],
          alternatives: [],
        })),
        ...extraction.projects.map((entry, index) => ({
          target: {
            section: "project" as const,
            key: "record",
            recordId: `project_${index + 1}`,
          },
          label: entry.name ?? `Project ${index + 1}`,
          value: entry,
          normalizedValue: entry,
          valuePreview: entry.name,
          evidenceText: entry.summary,
          sourceBlockIds: [],
          confidence: 0.8,
          notes: [],
          alternatives: [],
        })),
        ...extraction.spokenLanguages.map((entry, index) => ({
          target: {
            section: "language" as const,
            key: "record",
            recordId: `language_${index + 1}`,
          },
          label: entry.language ?? `Language ${index + 1}`,
          value: entry,
          normalizedValue: entry,
          valuePreview: entry.language,
          evidenceText: entry.language,
          sourceBlockIds: [],
          confidence: 0.88,
          notes: [],
          alternatives: [],
        })),
      ];

      return groundCandidatesToBundle(documentBundle, candidates);
    }

    return [];
  }

  return {
    ...fallbackClient,
    extractProfileFromResume: () => Promise.resolve(extraction),
    extractResumeImportStage: (input) =>
      Promise.resolve({
        stage: input.stage,
        analysisProviderKind: extraction.analysisProviderKind,
        analysisProviderLabel: extraction.analysisProviderLabel,
        candidates: buildStageCandidates(input.stage, input.documentBundle),
        notes: extraction.notes,
      }),
  };
}

export function createDocumentManager() {
  return {
    listResumeTemplates() {
      return ResumeTemplateDefinitionSchema.array().parse([
        {
          id: "classic_ats" as const,
          label: "Chronology Classic",
          familyId: "chronology_classic",
          familyLabel: "Chronology Classic",
          variantLabel: "Recruiter Standard",
          deliveryLane: "apply_safe",
          atsConfidence: "high",
          applyEligible: true,
          approvalEligible: true,
          description:
            "Quiet single-column resume with restrained typography and balanced spacing for broad ATS-safe use.",
          bestFor: ["General applications", "Recruiter-heavy funnels"],
          visualTags: ["Minimal", "Balanced", "Single column"],
          density: "balanced" as const,
          sortOrder: 10,
        },
        {
          id: "compact_exec" as const,
          label: "Senior Brief",
          familyId: "senior_brief",
          familyLabel: "Senior Brief",
          variantLabel: "Dense Timeline",
          deliveryLane: "apply_safe",
          atsConfidence: "high",
          applyEligible: true,
          approvalEligible: true,
          description:
            "Tighter spacing and a centered hierarchy for experienced candidates who need a denser executive-style read.",
          bestFor: ["Experienced candidates", "Content-dense resumes"],
          visualTags: ["Dense", "Centered header", "High signal"],
          density: "compact" as const,
          sortOrder: 20,
        },
        {
          id: "modern_split" as const,
          label: "Modern Editorial",
          familyId: "modern_editorial",
          familyLabel: "Modern Editorial",
          variantLabel: "Polished Default",
          deliveryLane: "apply_safe",
          atsConfidence: "high",
          applyEligible: true,
          approvalEligible: true,
          description:
            "Same calm backbone with a stronger header band and summary callout for polished but still ATS-safe exports.",
          bestFor: [
            "Product roles",
            "Design-adjacent teams",
            "Startup hiring loops",
          ],
          visualTags: ["Accent header", "Summary callout", "Balanced"],
          density: "balanced" as const,
          sortOrder: 30,
        },
        {
          id: "technical_matrix" as const,
          label: "Engineering Spec",
          familyId: "engineering_spec",
          familyLabel: "Engineering Spec",
          variantLabel: "Skills First",
          deliveryLane: "apply_safe",
          atsConfidence: "high",
          applyEligible: true,
          approvalEligible: true,
          description:
            "Skills-forward single-column layout that highlights technical depth before chronology.",
          bestFor: ["Engineering roles", "Data roles", "Security roles"],
          visualTags: ["Skills matrix", "Technical", "Compact"],
          density: "compact" as const,
          sortOrder: 40,
        },
        {
          id: "project_showcase" as const,
          label: "Proof Portfolio",
          familyId: "proof_portfolio",
          familyLabel: "Proof Portfolio",
          variantLabel: "Projects First",
          deliveryLane: "apply_safe",
          atsConfidence: "high",
          applyEligible: true,
          approvalEligible: true,
          description:
            "Project-forward single-column layout for candidates whose proof lands best through shipped work.",
          bestFor: [
            "Portfolio-heavy candidates",
            "Career changers",
            "Product builders",
          ],
          visualTags: ["Projects first", "Proof led", "Comfortable"],
          density: "comfortable" as const,
          sortOrder: 50,
        },
        {
          id: "credentials_focus" as const,
          label: "Formal Proof",
          familyId: "credential_ledger",
          familyLabel: "Formal Proof",
          variantLabel: "Certs & Education",
          deliveryLane: "apply_safe",
          atsConfidence: "high",
          applyEligible: true,
          approvalEligible: true,
          description:
            "Formal-proof single-column layout that surfaces certifications and education earlier without leaving ATS-safe structure.",
          bestFor: [
            "Regulated industries",
            "Certification-heavy roles",
            "Academic backgrounds",
          ],
          visualTags: ["Formal proof first", "Centered header", "Balanced"],
          density: "balanced" as const,
          sortOrder: 60,
        },
        {
          id: "timeline_longform" as const,
          label: "Longform Timeline",
          familyId: "longform_timeline",
          familyLabel: "Longform Timeline",
          variantLabel: "Career Depth",
          deliveryLane: "apply_safe",
          atsConfidence: "high",
          applyEligible: true,
          approvalEligible: true,
          description:
            "Long-history timeline with a compact career snapshot and chaptered chronology.",
          bestFor: ["Long work histories", "Senior ICs"],
          visualTags: ["Long history", "Career snapshot", "Compact"],
          density: "compact" as const,
          sortOrder: 70,
        },
        {
          id: "career_pivot" as const,
          label: "Career Pivot Bridge",
          familyId: "career_pivot_bridge",
          familyLabel: "Career Pivot Bridge",
          variantLabel: "Hybrid Bridge",
          deliveryLane: "apply_safe",
          atsConfidence: "high",
          applyEligible: true,
          approvalEligible: true,
          description:
            "Hybrid career-pivot layout that connects transferable history, role-ready skills, and project proof.",
          bestFor: ["Career pivots", "Mixed backgrounds"],
          visualTags: ["Hybrid bridge", "Transferable proof", "Balanced"],
          density: "balanced" as const,
          sortOrder: 80,
        },
      ]);
    },
    renderResumePreview(
      input: Parameters<JobFinderDocumentManager["renderResumePreview"]>[0],
    ) {
      const previewBody = input.renderDocument.sections
        .map((section) => {
          const lines = [
            ...(section.text ? [section.text] : []),
            ...section.bullets.map((bullet) => bullet.text),
            ...section.entries.flatMap((entry) => [
              ...(entry.heading ? [entry.heading] : []),
              ...(entry.summary ? [entry.summary] : []),
              ...entry.bullets.map((bullet) => bullet.text),
            ]),
          ];

          return `<section data-resume-section-id="${section.id}">${lines.join(" ")}</section>`;
        })
        .join("");

      return Promise.resolve({
        html: `<!doctype html><html><body><article data-template-id="${input.templateId}"><h1>${input.renderDocument.fullName}</h1>${previewBody}</article></body></html>`,
        warnings: [],
      });
    },
    renderResumeArtifact(
      input: Parameters<JobFinderDocumentManager["renderResumeArtifact"]>[0],
    ) {
      const fileStem = `generated-${input.templateId}`;
      return Promise.resolve({
        fileName: `${fileStem}.pdf`,
        storagePath: `/tmp/${fileStem}.pdf`,
        format: "pdf" as const,
        intermediateFileName: `${fileStem}.html`,
        intermediateStoragePath: `/tmp/${fileStem}.html`,
        pageCount: 1,
        warnings: [],
      });
    },
  };
}

export function createResearchAdapter(
  artifacts: readonly ResumeResearchArtifact[] = [
    {
      id: "research_job_ready_company",
      jobId: "job_ready",
      sourceUrl: "https://signalsystems.example/about",
      pageTitle: "About Signal Systems",
      fetchedAt: "2026-04-03T10:00:00.000Z",
      extractedText:
        "Signal Systems builds workflow automation and incident response software for operations teams.",
      companyNotes:
        "Signal Systems builds workflow automation and incident response software for operations teams.",
      domainVocabulary: ["workflow", "automation", "incident", "operations"],
      priorityThemes: ["workflow automation", "incident response"],
      fetchStatus: "success",
    },
  ],
) {
  return {
    fetchResearchPages(input: { job: { id: string } }) {
      return Promise.resolve(
        artifacts.filter((artifact) => artifact.jobId === input.job.id),
      );
    },
  };
}
