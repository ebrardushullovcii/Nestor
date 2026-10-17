import type {
  ResumeDocumentBundle,
  ResumeImportFieldCandidateDraft,
  ResumeImportJsonValue,
  ResumeImportVisionPageImage,
} from "@nestor/contracts";
import {
  AgentProviderStatusSchema,
  NonEmptyStringSchema,
  ResumeImportFieldCandidateDraftSchema,
  ResumeImportTargetSectionSchema,
} from "@nestor/contracts";
import { z } from "zod";
import {
  buildValuePreview,
  type ExtractResumeVisionInput,
  ResumeVisionExtractionResultSchema,
  type ResumeVisionProvider,
} from "./resume-import";
import { buildCandidateConfidenceBreakdown } from "./resume-import-helpers";
import {
  buildModelRequestHeaders,
  modelConversationKeys,
} from "./model-request-identity";
import {
  buildModelRequestBody,
  buildModelUrl,
  DEFAULT_OPENCODE_GO_BASE_URL,
  DEFAULT_VISION_MODEL_API_MODE,
  DEFAULT_VISION_MODEL_REASONING_EFFORT,
  modelApiModes,
  modelReasoningEfforts,
  parseModelApiMode,
  extractModelJsonFromPayload,
  parseModelReasoningEffort,
} from "./openai-compatible-transport";
import {
  ModelRequestTimeoutError,
  parseConfiguredBoolean,
  parseConfiguredPositiveInteger,
  performModelRequest,
} from "./model-request-transport";

const DEFAULT_RESUME_VISION_MODEL = "muse-spark-1.3-contributor";
const DEFAULT_VISION_TIMEOUT_MS = 600_000;
const DEFAULT_VISION_CONTEXT_WINDOW_TOKENS = 139_000;
const DEFAULT_VISION_RESERVED_HEADROOM_TOKENS = 30_000;
const MAX_PAGES_PER_BATCH = 8;

export const OpenAiCompatibleResumeVisionProviderOptionsSchema = z.object({
  apiKey: NonEmptyStringSchema,
  baseUrl: z.string().trim().url(),
  model: NonEmptyStringSchema,
  label: NonEmptyStringSchema.optional(),
  apiMode: z.enum(modelApiModes).optional(),
  reasoningEffort: z.enum(modelReasoningEfforts).optional(),
  contextWindowTokens: z.number().int().min(1_000).optional(),
  reservedHeadroomTokens: z.number().int().min(1_000).optional(),
  requestTimeoutMs: z.number().int().min(1_000).optional(),
  idleTimeoutMs: z.number().int().min(1_000).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  streaming: z.boolean().optional(),
  retryBaseDelayMs: z.number().int().min(0).optional(),
  maxPagesPerBatch: z.number().int().min(1).max(16).optional(),
});
export type OpenAiCompatibleResumeVisionProviderOptions = z.infer<
  typeof OpenAiCompatibleResumeVisionProviderOptionsSchema
>;

type StringMap = Record<string, string | undefined>;

function normalizeTimeoutLikeError(error: unknown, timeoutMs: number): Error {
  if (error instanceof ModelRequestTimeoutError) {
    return error;
  }
  const message = error instanceof Error ? error.message.trim() : "";
  const isAbortLikeMessage =
    message === "This operation was aborted" ||
    message === "The operation was aborted" ||
    message === "signal is aborted without reason";

  if (error instanceof DOMException && error.name === "AbortError") {
    return new DOMException(
      `Vision model request timed out after ${Math.floor(timeoutMs / 1000)}s`,
      "AbortError",
    );
  }

  if (error instanceof Error && error.name === "AbortError") {
    const abortError = new Error(
      `Vision model request timed out after ${Math.floor(timeoutMs / 1000)}s`,
    );
    abortError.name = "AbortError";
    return abortError;
  }

  if (isAbortLikeMessage) {
    const abortError = new Error(
      `Vision model request timed out after ${Math.floor(timeoutMs / 1000)}s`,
    );
    abortError.name = "AbortError";
    return abortError;
  }

  return error instanceof Error ? error : new Error(String(error));
}

function parseConfiguredNumber(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }

    const trimmed = entry.trim();
    return trimmed ? [trimmed] : [];
  });
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }

  return undefined;
}

function normalizeTarget(
  value: unknown,
): ResumeImportFieldCandidateDraft["target"] | undefined {
  if (typeof value === "string") {
    const [rawSection, ...rest] = value.trim().split(".");
    const section = rawSection?.trim() ?? "";
    const key = rest.join(".").trim();
    const sectionResult = ResumeImportTargetSectionSchema.safeParse(section);

    if (!sectionResult.success || !key) {
      return undefined;
    }

    return { section: sectionResult.data, key, recordId: null };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const section =
    typeof record.section === "string" ? record.section.trim() : "";
  const key = typeof record.key === "string" ? record.key.trim() : "";
  const recordId =
    typeof record.recordId === "string" && record.recordId.trim()
      ? record.recordId.trim()
      : null;

  const sectionResult = ResumeImportTargetSectionSchema.safeParse(section);

  if (!sectionResult.success || !key) {
    return undefined;
  }

  return { section: sectionResult.data, key, recordId };
}

function normalizeAlternatives(value: unknown): ResumeImportJsonValue[] {
  if (Array.isArray(value)) {
    return value as ResumeImportJsonValue[];
  }

  return value === null || value === undefined
    ? []
    : [value as ResumeImportJsonValue];
}

function normalizeVisualEvidence(
  page: ResumeImportVisionPageImage,
  value: unknown,
): ResumeImportFieldCandidateDraft["visualEvidence"] {
  if (!Array.isArray(value)) {
    return [
      {
        branch: "vision",
        sourceFileKind: page.sourceFileKind,
        pageNumber: page.pageNumber,
        regionHint: null,
        confidence: null,
        uncertaintyNotes: [],
      },
    ];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    return [
      {
        branch: "vision" as const,
        sourceFileKind: page.sourceFileKind,
        pageNumber:
          typeof record.pageNumber === "number"
            ? record.pageNumber
            : page.pageNumber,
        regionHint:
          typeof record.regionHint === "string" && record.regionHint.trim()
            ? record.regionHint.trim()
            : null,
        confidence: normalizeConfidence(record.confidence) ?? null,
        uncertaintyNotes: toStringArray(record.uncertaintyNotes),
      },
    ];
  });
}

function normalizeVisionCandidate(
  value: unknown,
  page: ResumeImportVisionPageImage,
  bundle: ResumeDocumentBundle,
): ResumeImportFieldCandidateDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const target = normalizeTarget(record.target);
  if (!target) {
    return null;
  }

  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label.trim()
      : `${target.section}.${target.key}`;
  const candidate = ResumeImportFieldCandidateDraftSchema.parse({
    target,
    label,
    value: (record.value ?? null) as ResumeImportJsonValue,
    normalizedValue: (record.normalizedValue ?? null) as ResumeImportJsonValue,
    valuePreview:
      typeof record.valuePreview === "string" ? record.valuePreview : null,
    evidenceText:
      typeof record.evidenceText === "string" ? record.evidenceText : null,
    sourceBlockIds: toStringArray(record.sourceBlockIds),
    confidence: normalizeConfidence(record.confidence) ?? 0.54,
    confidenceBreakdown: null,
    notes: toStringArray(record.notes),
    alternatives: normalizeAlternatives(record.alternatives),
    visualEvidence: normalizeVisualEvidence(page, record.visualEvidence),
  });

  return ResumeImportFieldCandidateDraftSchema.parse({
    ...candidate,
    valuePreview: candidate.valuePreview ?? buildValuePreview(candidate.value),
    confidenceBreakdown: buildCandidateConfidenceBreakdown({
      candidate: {
        target: candidate.target,
        confidence: candidate.confidence,
        sourceBlockIds: candidate.sourceBlockIds,
      },
      bundle,
      normalizationRisk: 0.2,
      conflictRisk: 0.18,
    }),
  });
}

function pageBatches<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

function inferFullNameFromText(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const topLines = lines.slice(0, 10);
  const resumeHeadings =
    /^(?:about(?: me)?|profile|summary|professional summary|skills|technical skills|work experience|experience|education|certifications?|projects|languages)$/i;
  const roleOrContactTerms =
    /\b(?:engineer|developer|designer|manager|director|analyst|consultant|specialist|officer|architect|lead|senior|staff|principal|intern|email|phone|linkedin|github|portfolio|address|remote)\b/i;

  return (
    topLines.find((line) => {
      if (
        line.length > 56 ||
        /[@\d]|https?:\/\//i.test(line) ||
        resumeHeadings.test(line)
      ) {
        return false;
      }

      if (roleOrContactTerms.test(line)) {
        return false;
      }

      const parts = line.split(/\s+/).filter(Boolean);
      return (
        parts.length >= 2 &&
        parts.length <= 4 &&
        parts.every((part) => /^[A-Z][A-Za-z.'-]*$/.test(part))
      );
    }) ?? null
  );
}

function inferEmailFromText(text: string): string | null {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
}

function createDeterministicVisionCandidates(
  input: ExtractResumeVisionInput,
): ResumeImportFieldCandidateDraft[] {
  const text = input.documentBundle.fullText ?? "";
  const firstPage = input.visionArtifact.pages[0] ?? null;
  const visualEvidence = firstPage
    ? [
        {
          branch: "vision" as const,
          sourceFileKind: firstPage.sourceFileKind,
          pageNumber: firstPage.pageNumber,
          regionHint: "top of rendered resume preview",
          confidence: 0.72,
          uncertaintyNotes: ["deterministic_visual_preview_text_fallback"],
        },
      ]
    : [];
  const drafts: ResumeImportFieldCandidateDraft[] = [];
  const fullName = inferFullNameFromText(text);
  const email = inferEmailFromText(text);

  if (fullName) {
    drafts.push(
      ResumeImportFieldCandidateDraftSchema.parse({
        target: { section: "identity", key: "fullName", recordId: null },
        label: "Full name",
        value: fullName,
        normalizedValue: fullName,
        valuePreview: fullName,
        evidenceText: fullName,
        sourceBlockIds: input.documentBundle.blocks
          .slice(0, 2)
          .map((block) => block.id),
        confidence: 0.72,
        notes: ["deterministic_vision_preview"],
        alternatives: [],
        visualEvidence,
        confidenceBreakdown: buildCandidateConfidenceBreakdown({
          candidate: {
            target: { section: "identity", key: "fullName", recordId: null },
            confidence: 0.72,
            sourceBlockIds: input.documentBundle.blocks
              .slice(0, 2)
              .map((block) => block.id),
          },
          bundle: input.documentBundle,
          normalizationRisk: 0.2,
          conflictRisk: 0.18,
        }),
      }),
    );
  }

  if (email) {
    drafts.push(
      ResumeImportFieldCandidateDraftSchema.parse({
        target: { section: "contact", key: "email", recordId: null },
        label: "Email",
        value: email,
        normalizedValue: email,
        valuePreview: email,
        evidenceText: email,
        sourceBlockIds: input.documentBundle.blocks
          .filter((block) => block.text.includes(email))
          .map((block) => block.id),
        confidence: 0.74,
        notes: ["deterministic_vision_preview"],
        alternatives: [],
        visualEvidence,
        confidenceBreakdown: buildCandidateConfidenceBreakdown({
          candidate: {
            target: { section: "contact", key: "email", recordId: null },
            confidence: 0.74,
            sourceBlockIds: input.documentBundle.blocks
              .filter((block) => block.text.includes(email))
              .map((block) => block.id),
          },
          bundle: input.documentBundle,
          normalizationRisk: 0.18,
          conflictRisk: 0.14,
        }),
      }),
    );
  }

  return drafts;
}

export function createDeterministicResumeVisionProvider(
  detail = "Built-in deterministic vision fallback inspects locally rendered resume previews without calling a model.",
): ResumeVisionProvider {
  const status = AgentProviderStatusSchema.parse({
    kind: "deterministic",
    role: "vision",
    ready: true,
    label: "Deterministic resume vision fallback",
    model: null,
    baseUrl: null,
    modelContextWindowTokens: null,
    reservedHeadroomTokens: null,
    requestTimeoutMs: null,
    detail,
  });

  return {
    getStatus() {
      return status;
    },
    extractResumeVision(input) {
      return Promise.resolve(
        ResumeVisionExtractionResultSchema.parse({
          analysisProviderKind: "deterministic",
          analysisProviderLabel: status.label,
          candidates: createDeterministicVisionCandidates(input),
          notes:
            input.visionArtifact.pages.length > 0
              ? ["Vision branch used deterministic rendered-preview fallback."]
              : ["Vision branch had no page images available."],
          warnings: input.visionArtifact.warnings,
          fallbackUsed: true,
        }),
      );
    },
  };
}

export function createOpenAiCompatibleResumeVisionProvider(
  options: OpenAiCompatibleResumeVisionProviderOptions,
): ResumeVisionProvider {
  const configuredOptions =
    OpenAiCompatibleResumeVisionProviderOptionsSchema.safeParse(options);
  const validatedOptions = configuredOptions.success
    ? configuredOptions.data
    : null;
  const timeoutMs =
    validatedOptions?.requestTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;
  const contextWindowTokens =
    validatedOptions?.contextWindowTokens ??
    DEFAULT_VISION_CONTEXT_WINDOW_TOKENS;
  const reservedHeadroomTokens =
    validatedOptions?.reservedHeadroomTokens ??
    DEFAULT_VISION_RESERVED_HEADROOM_TOKENS;
  const status = AgentProviderStatusSchema.parse({
    kind: "openai_compatible_vision",
    role: "vision",
    ready: configuredOptions.success,
    label: validatedOptions?.label ?? "Resume visual scan",
    model: validatedOptions?.model ?? null,
    baseUrl: validatedOptions?.baseUrl ?? null,
    modelContextWindowTokens: configuredOptions.success
      ? contextWindowTokens
      : null,
    reservedHeadroomTokens: configuredOptions.success
      ? reservedHeadroomTokens
      : null,
    requestTimeoutMs: configuredOptions.success ? timeoutMs : null,
    detail: configuredOptions.success
      ? "The configured vision provider reads locally generated resume page images. App code validates the result before reconciliation."
      : "The configured vision provider settings are invalid; resume import will use text extraction and deterministic visual fallback only.",
  });

  async function fetchVisionJson(
    pages: readonly ResumeImportVisionPageImage[],
    input: ExtractResumeVisionInput,
  ): Promise<unknown> {
    if (!validatedOptions) {
      throw new Error(
        "The configured resume vision provider settings are invalid.",
      );
    }

    try {
      const apiMode = validatedOptions.apiMode ?? "chat_completions";
      const payload = await performModelRequest({
        url: buildModelUrl(validatedOptions.baseUrl, apiMode),
        // Same conversation key as the text stages of this import: the
        // gateway routes one import's requests together, and OpenCode Go
        // rejects a request that carries no session header at all.
        headers: buildModelRequestHeaders({
          apiKey: validatedOptions.apiKey,
          baseUrl: validatedOptions.baseUrl,
          conversationKey: modelConversationKeys.resumeImport(
            input.documentBundle.fullText ??
              input.documentBundle.sourceResumeId,
          ),
        }),
        body: buildModelRequestBody({
          apiMode,
          model: validatedOptions.model,
          reasoningEffort: validatedOptions.reasoningEffort,
          reasoningSummary: validatedOptions.streaming !== false,
          jsonOutput: true,
          messages: [
            {
              role: "system",
              content: [
                "You extract structured resume import candidates from resume page images.",
                "Return JSON only with a candidates array and notes array.",
                "Use the visual layout for columns, scanned content, section grouping, and parser recovery.",
                "Do not invent values. Keep exact names, dates, emails, URLs, company names, and titles literal when visible.",
                "Each candidate must include target, label, value, evidenceText, confidence, notes, alternatives, and visualEvidence.",
                'Use a target object with section, key, and recordId: for example {"section":"identity","key":"fullName","recordId":null}. Never return a bare field name such as "fullName" or a bare section such as "experience" as the target.',
                'For an experience, education, certification, link, project, or language record, use its section and key "record". Keep separate records as separate candidates.',
                "visualEvidence must be an array of objects with pageNumber, regionHint, confidence, and uncertaintyNotes. Cite the actual page shown, and use notes and alternatives arrays.",
              ].join(" "),
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    sourceFileKind: input.visionArtifact.sourceFileKind,
                    pageNumbers: pages.map((page) => page.pageNumber),
                    existingProfile: input.existingProfile,
                    existingSearchPreferences: input.existingSearchPreferences,
                    parserQuality: input.documentBundle.quality ?? null,
                    parserWarnings: input.documentBundle.warnings,
                    targetContract: {
                      targetShape: {
                        section: "One of the sections below",
                        key: "A key allowed for that section below",
                        recordId: null,
                      },
                      candidateExample: {
                        target: {
                          section: "identity",
                          key: "fullName",
                          recordId: null,
                        },
                        label: "Full name",
                        value: "Alex Sample",
                        evidenceText: "Alex Sample",
                        confidence: 0.95,
                        notes: [],
                        alternatives: [],
                        visualEvidence: [
                          {
                            pageNumber: pages[0]?.pageNumber ?? 1,
                            regionHint: "Name at the top of the page",
                            confidence: 0.95,
                            uncertaintyNotes: [],
                          },
                        ],
                      },
                      identity: [
                        "fullName",
                        "headline",
                        "summary",
                        "yearsExperience",
                      ],
                      contact: [
                        "email",
                        "phone",
                        "linkedinUrl",
                        "portfolioUrl",
                        "githubUrl",
                        "personalWebsiteUrl",
                      ],
                      location: ["currentLocation"],
                      experience: {
                        key: "record",
                        valueShape:
                          "{ companyName, companyUrl, title, employmentType, location, workMode, startDate, endDate, isCurrent, summary, achievements, skills, domainTags, peopleManagementScope, ownershipScope }",
                      },
                      education: {
                        key: "record",
                        valueShape:
                          "{ schoolName, degree, fieldOfStudy, location, startDate, endDate, summary }",
                      },
                      skill: [
                        "skills",
                        "skillGroups.coreSkills",
                        "skillGroups.tools",
                        "skillGroups.languagesAndFrameworks",
                        "skillGroups.softSkills",
                        "skillGroups.highlightedSkills",
                      ],
                      recordTargets: [
                        "experience.record",
                        "education.record",
                        "certification.record",
                        "link.record",
                        "project.record",
                        "language.record",
                      ],
                      invalidTargets: [
                        "background",
                        "education.institution",
                        "education.startDate",
                        "education.graduationDate",
                        "education.education",
                      ],
                    },
                  }),
                },
                ...pages
                  .filter((page) => page.dataUrl)
                  .map((page) => ({
                    type: "image_url",
                    image_url: {
                      url: page.dataUrl,
                      detail: "high",
                    },
                  })),
              ],
            },
          ],
        }),
        apiMode,
        totalTimeoutMs: timeoutMs,
        idleTimeoutMs: validatedOptions.idleTimeoutMs,
        maxAttempts: validatedOptions.maxAttempts,
        streaming: validatedOptions.streaming,
        retryBaseDelayMs: validatedOptions.retryBaseDelayMs,
      });

      return extractModelJsonFromPayload(payload);
    } catch (error) {
      throw normalizeTimeoutLikeError(error, timeoutMs);
    }
  }

  return {
    getStatus() {
      return status;
    },
    async extractResumeVision(input) {
      const fallback = createDeterministicResumeVisionProvider(
        "Deterministic fallback ran alongside the configured resume vision provider.",
      );
      const fallbackResult = await fallback.extractResumeVision(input);

      if (!validatedOptions || input.visionArtifact.pages.length === 0) {
        return fallbackResult;
      }

      const candidates: ResumeImportFieldCandidateDraft[] = [];
      const notes: string[] = [];
      const warnings: string[] = [...input.visionArtifact.warnings];
      const maxPagesPerBatch =
        validatedOptions.maxPagesPerBatch ?? MAX_PAGES_PER_BATCH;

      // Filter pages with valid dataUrl before batching
      const visiblePages = input.visionArtifact.pages.filter(
        (page) => page.dataUrl !== null,
      );

      if (visiblePages.length === 0) {
        return fallbackResult;
      }

      try {
        for (const batch of pageBatches(visiblePages, maxPagesPerBatch)) {
          const payload = await fetchVisionJson(batch, input);
          const record =
            payload && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)
              : {};
          if (!Array.isArray(record.candidates)) {
            throw new Error(
              "The resume visual scan did not return a candidates array.",
            );
          }
          const batchCandidates = record.candidates.flatMap((candidate) => {
            const fallbackPage = batch[0];
            if (!fallbackPage) {
              return [];
            }

            const visualEvidence =
              candidate &&
              typeof candidate === "object" &&
              !Array.isArray(candidate)
                ? (normalizeVisualEvidence(
                    fallbackPage,
                    (candidate as Record<string, unknown>).visualEvidence,
                  ) ?? [])
                : [];
            const pageNumber = visualEvidence[0]?.pageNumber ?? null;
            const page =
              batch.find((entry) => entry.pageNumber === pageNumber) ??
              fallbackPage;
            return page
              ? [
                  normalizeVisionCandidate(
                    candidate,
                    page,
                    input.documentBundle,
                  ),
                ].filter(
                  (entry): entry is ResumeImportFieldCandidateDraft =>
                    entry !== null,
                )
              : [];
          });
          const rejectedCount =
            record.candidates.length - batchCandidates.length;
          if (rejectedCount > 0) {
            warnings.push(
              `${rejectedCount} resume visual candidate(s) were ignored because their targets did not match the required section and key format.`,
            );
            if (batchCandidates.length === 0) {
              throw new Error(
                "The resume visual scan returned candidates, but none had a valid target with a section and key. No model extraction was accepted.",
              );
            }
          }
          candidates.push(...batchCandidates);
          notes.push(...toStringArray(record.notes));
          warnings.push(...toStringArray(record.warnings));
        }

        return ResumeVisionExtractionResultSchema.parse({
          analysisProviderKind: "openai_compatible_vision",
          analysisProviderLabel: status.label,
          candidates: [...candidates, ...fallbackResult.candidates],
          notes,
          warnings,
          primaryErrorMessage: null,
          fallbackUsed: false,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Resume vision provider failed.";
        // Every candidate below comes from the deterministic provider, so the
        // reported kind and label must be the deterministic ones. Reporting
        // the configured vision provider here made a timed-out scan
        // indistinguishable from a model scan everywhere the run is shown.
        return ResumeVisionExtractionResultSchema.parse({
          analysisProviderKind: fallbackResult.analysisProviderKind,
          analysisProviderLabel: fallbackResult.analysisProviderLabel,
          candidates: fallbackResult.candidates,
          warnings: [...fallbackResult.warnings, message],
          notes: [
            ...fallbackResult.notes,
            "Configured resume vision provider failed; deterministic visual fallback was used.",
          ],
          primaryErrorMessage: message,
          fallbackUsed: true,
          fallback: {
            kind: /timed out after \d+s/i.test(message)
              ? ("timeout" as const)
              : ("provider_error" as const),
            reason: message,
          },
        });
      }
    },
  };
}

export function createResumeVisionProviderFromEnvironment(
  env: StringMap = process.env,
): ResumeVisionProvider {
  const apiKey =
    env.NESTOR_RESUME_VISION_API_KEY ??
    env.NESTOR_AI_VISION_API_KEY ??
    env.NESTOR_AI_API_KEY;
  if (!apiKey) {
    return createDeterministicResumeVisionProvider();
  }

  return createOpenAiCompatibleResumeVisionProvider({
    apiKey,
    baseUrl:
      env.NESTOR_RESUME_VISION_BASE_URL ??
      env.NESTOR_AI_VISION_BASE_URL ??
      env.NESTOR_AI_BASE_URL ??
      DEFAULT_OPENCODE_GO_BASE_URL,
    model:
      env.NESTOR_RESUME_VISION_MODEL ??
      env.NESTOR_AI_VISION_MODEL ??
      DEFAULT_RESUME_VISION_MODEL,
    apiMode:
      parseModelApiMode(
        env.NESTOR_RESUME_VISION_API_MODE ?? env.NESTOR_AI_VISION_API_MODE,
      ) ?? DEFAULT_VISION_MODEL_API_MODE,
    reasoningEffort:
      parseModelReasoningEffort(
        env.NESTOR_RESUME_VISION_REASONING_EFFORT ??
          env.NESTOR_AI_VISION_REASONING_EFFORT,
      ) ?? DEFAULT_VISION_MODEL_REASONING_EFFORT,
    label: "Resume visual scan",
    requestTimeoutMs:
      parseConfiguredNumber(env.NESTOR_RESUME_VISION_TIMEOUT_MS) ??
      DEFAULT_VISION_TIMEOUT_MS,
    idleTimeoutMs: parseConfiguredNumber(env.NESTOR_AI_IDLE_TIMEOUT_MS),
    maxAttempts: parseConfiguredPositiveInteger(env.NESTOR_AI_MAX_ATTEMPTS),
    streaming: parseConfiguredBoolean(env.NESTOR_AI_STREAMING),
    retryBaseDelayMs: parseConfiguredPositiveInteger(
      env.NESTOR_AI_RETRY_BASE_DELAY_MS,
      0,
    ),
    contextWindowTokens:
      parseConfiguredNumber(env.NESTOR_RESUME_VISION_CONTEXT_WINDOW_TOKENS) ??
      DEFAULT_VISION_CONTEXT_WINDOW_TOKENS,
    reservedHeadroomTokens:
      parseConfiguredNumber(env.NESTOR_RESUME_VISION_HEADROOM_TOKENS) ??
      DEFAULT_VISION_RESERVED_HEADROOM_TOKENS,
    maxPagesPerBatch:
      parseConfiguredNumber(env.NESTOR_RESUME_VISION_MAX_PAGES_PER_BATCH) ??
      MAX_PAGES_PER_BATCH,
  });
}
