import {
  AgentProviderStatusSchema,
  BrowserVisualAnalysisInputSchema,
  BrowserVisualObservationSchema,
  BrowserVisualObservationSetSchema,
  type AgentProviderStatus,
  type BrowserVisualAnalysisInput,
  type BrowserVisualObservation,
  type BrowserVisualObservationSet,
  type BrowserVisualQuestionContext,
} from "@nestor/contracts";
import { z } from "zod";
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
import {
  buildModelRequestHeaders,
  modelConversationKeys,
} from "./model-request-identity";

const DEFAULT_BROWSER_VISUAL_MODEL = "muse-spark-1.3-contributor";
const DEFAULT_BROWSER_VISUAL_BASE_URL = DEFAULT_OPENCODE_GO_BASE_URL;
const DEFAULT_BROWSER_VISUAL_TIMEOUT_MS = 120_000;

export const OpenAiCompatibleBrowserVisualProviderOptionsSchema = z.object({
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  apiMode: z.enum(modelApiModes).optional(),
  reasoningEffort: z.enum(modelReasoningEfforts).optional(),
  requestTimeoutMs: z.number().int().min(1_000).optional(),
  idleTimeoutMs: z.number().int().min(1_000).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  streaming: z.boolean().optional(),
  retryBaseDelayMs: z.number().int().min(0).optional(),
});
export type OpenAiCompatibleBrowserVisualProviderOptions = z.infer<
  typeof OpenAiCompatibleBrowserVisualProviderOptionsSchema
>;

export interface BrowserVisualAnalysisProvider {
  getStatus(): AgentProviderStatus;
  analyzeBrowserVisualSnapshot(
    input: BrowserVisualAnalysisInput,
  ): Promise<BrowserVisualObservationSet>;
}

type StringMap = Record<string, string | undefined>;

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

function uniqueBy<T>(values: readonly T[], getKey: (value: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const value of values) {
    const key = getKey(value);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(value);
  }

  return unique;
}

function visualObservationKey(value: BrowserVisualObservation): string {
  return [
    value.id,
    value.kind,
    value.label,
    value.description,
    value.relatedText ?? "",
  ].join("\u0000");
}

function visualQuestionContextKey(value: BrowserVisualQuestionContext): string {
  return [
    value.id,
    value.snapshotId,
    value.observationSetId,
    value.promptHint,
    value.fieldKindHint ?? "",
  ].join("\u0000");
}

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
      `Browser visual analysis timed out after ${Math.floor(timeoutMs / 1000)}s`,
      "AbortError",
    );
  }

  if (error instanceof Error && error.name === "AbortError") {
    const abortError = new Error(
      `Browser visual analysis timed out after ${Math.floor(timeoutMs / 1000)}s`,
    );
    abortError.name = "AbortError";
    return abortError;
  }

  if (isAbortLikeMessage) {
    const abortError = new Error(
      `Browser visual analysis timed out after ${Math.floor(timeoutMs / 1000)}s`,
    );
    abortError.name = "AbortError";
    return abortError;
  }

  return error instanceof Error ? error : new Error(String(error));
}

function createObservationSetId(snapshotId: string): string {
  return `visual_observation_${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function createQuestionContextId(input: {
  snapshotId: string;
  observationSetId: string;
  index: number;
}): string {
  return `visual_question_${input.snapshotId.replace(/[^a-zA-Z0-9_-]/g, "_")}_${input.observationSetId.replace(/[^a-zA-Z0-9_-]/g, "_")}_${input.index + 1}`;
}

function normalizeObservationKind(
  value: unknown,
): BrowserVisualObservation["kind"] {
  if (typeof value !== "string") return "uncertainty";
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const aliases: Record<string, BrowserVisualObservation["kind"]> = {
    application_data: "field_control",
    control: "visible_control",
    page: "uncertainty",
    submit_control: "button_state",
  };
  return (
    aliases[normalized] ??
    ([
      "blocker",
      "visible_control",
      "job_card_clue",
      "apply_path_clue",
      "field_control",
      "validation_error",
      "button_state",
      "upload_control",
      "question_context",
      "recovery_note",
      "uncertainty",
    ].includes(normalized)
      ? (normalized as BrowserVisualObservation["kind"])
      : "uncertainty")
  );
}

function normalizeObservationSeverity(
  value: unknown,
): BrowserVisualObservation["severity"] {
  if (value === "critical" || value === "warning" || value === "info") {
    return value;
  }
  if (value === "blocking" || value === "error" || value === "high") {
    return "critical";
  }
  if (value === "warn" || value === "medium") return "warning";
  return "info";
}

function normalizeObservations(
  value: unknown,
  snapshotId: string,
): BrowserVisualObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const candidate = entry as Record<string, unknown>;
    const label =
      typeof candidate.label === "string" ? candidate.label.trim() : "";
    const description =
      typeof candidate.description === "string"
        ? candidate.description.trim()
        : "";
    if (!label || !description) return [];
    const parsed = BrowserVisualObservationSchema.safeParse({
      ...candidate,
      id:
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : `visual_observation_${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "_")}_${index + 1}`,
      kind: normalizeObservationKind(candidate.kind),
      severity: normalizeObservationSeverity(candidate.severity),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function normalizeQuestionContexts(
  value: unknown,
  base: { snapshotId: string; observationSetId: string },
): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const candidate = entry as Record<string, unknown>;

    return [
      {
        ...candidate,
        id:
          typeof candidate.id === "string" && candidate.id.trim()
            ? candidate.id.trim()
            : createQuestionContextId({ ...base, index }),
        snapshotId: base.snapshotId,
        observationSetId: base.observationSetId,
      },
    ];
  });
}

function normalizeVisualPayload(input: {
  rawPayload: unknown;
  analysisInput: BrowserVisualAnalysisInput;
  status: AgentProviderStatus;
}): BrowserVisualObservationSet {
  const payload =
    input.rawPayload &&
    typeof input.rawPayload === "object" &&
    !Array.isArray(input.rawPayload)
      ? (input.rawPayload as Record<string, unknown>)
      : {};
  const base = {
    id:
      typeof payload.id === "string" && payload.id.trim()
        ? payload.id.trim()
        : createObservationSetId(input.analysisInput.snapshot.id),
    snapshotId: input.analysisInput.snapshot.id,
    observedAt: new Date().toISOString(),
    url: input.analysisInput.snapshot.url,
    purpose: input.analysisInput.snapshot.purpose,
    providerKind: input.status.kind,
    providerLabel: input.status.label,
  };
  const observationSetId = base.id;
  const normalized = {
    ...payload,
    ...base,
    summary:
      typeof payload.summary === "string" && payload.summary.trim()
        ? payload.summary.trim()
        : null,
    blockers: toStringArray(payload.blockers),
    visibleControls: toStringArray(payload.visibleControls),
    jobCardClues: toStringArray(payload.jobCardClues),
    applyPathClues: toStringArray(payload.applyPathClues),
    fieldControls: toStringArray(payload.fieldControls),
    validationErrors: toStringArray(payload.validationErrors),
    buttonStates: toStringArray(payload.buttonStates),
    recoveryNotes: toStringArray(payload.recoveryNotes),
    uncertainty: toStringArray(payload.uncertainty),
    observations: normalizeObservations(
      payload.observations,
      input.analysisInput.snapshot.id,
    ),
    questionContexts: normalizeQuestionContexts(payload.questionContexts, {
      snapshotId: input.analysisInput.snapshot.id,
      observationSetId,
    }),
    reconciliations: [],
    rejectedOutputReasons: toStringArray(payload.rejectedOutputReasons),
  };

  const parsed = BrowserVisualObservationSetSchema.safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }

  const rejectedOutputReasons = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });

  // Targeted stripping: only null/empty the specific top-level fields that failed validation.
  const recovery: Record<string, unknown> = { ...normalized };
  const clearedKeys = new Set<string>();
  for (const issue of parsed.error.issues) {
    const topKey = issue.path[0];
    if (typeof topKey === "string" && !clearedKeys.has(topKey)) {
      clearedKeys.add(topKey);
      const current = recovery[topKey];
      recovery[topKey] = Array.isArray(current) ? [] : null;
    }
  }

  return BrowserVisualObservationSetSchema.parse({
    ...recovery,
    rejectedOutputReasons,
    uncertainty: [
      ...toStringArray((recovery as { uncertainty?: unknown }).uncertainty),
      "The browser visual provider returned output that did not satisfy the safe observation schema.",
    ],
  });
}

function buildDeterministicObservationSet(input: {
  analysisInput: BrowserVisualAnalysisInput;
  status: AgentProviderStatus;
  extraUncertainty?: readonly string[];
}): BrowserVisualObservationSet {
  const context = input.analysisInput.context;
  const visibleText = context.visibleTextSample ?? "";
  const normalizedText = visibleText.toLowerCase();
  const blockers = [
    /\blog\s?in\b|\bsign\s?in\b|\bauthentication\b/.test(normalizedText)
      ? "Visible text suggests a sign-in or authentication blocker."
      : null,
    /\bcaptcha\b|\bverify you are human\b|\bsecurity check\b/.test(
      normalizedText,
    )
      ? "Visible text suggests a bot-protection or manual verification blocker."
      : null,
  ].filter((value): value is string => Boolean(value));
  const visibleControls = [
    /\bsearch\b/.test(normalizedText)
      ? "Visible text includes a search control or search area."
      : null,
    /\bfilter\b/.test(normalizedText)
      ? "Visible text includes a filter control or filter area."
      : null,
    /\bshow all\b|\bview all\b/.test(normalizedText)
      ? "Visible text includes a show-all or view-all control."
      : null,
  ].filter((value): value is string => Boolean(value));
  const jobCardClues = [
    /\bjob\b|\brole\b|\bposition\b|\bopening\b/.test(normalizedText)
      ? "Visible text includes job, role, position, or opening language."
      : null,
  ].filter((value): value is string => Boolean(value));
  const applyPathClues = [
    /\bapply\b/.test(normalizedText)
      ? "Visible text includes apply-entry language."
      : null,
  ].filter((value): value is string => Boolean(value));
  const fieldControls = [
    /\bresume\b|\bcv\b/.test(normalizedText)
      ? "Visible text includes a resume or CV field/control clue."
      : null,
    /\bupload\b|\battach\b/.test(normalizedText)
      ? "Visible text includes an upload or attachment control clue."
      : null,
  ].filter((value): value is string => Boolean(value));
  const validationErrors = [
    /\brequired\b|\berror\b|\binvalid\b/.test(normalizedText)
      ? "Visible text includes required/error/invalid validation language."
      : null,
  ].filter((value): value is string => Boolean(value));
  const summary =
    blockers[0] ??
    visibleControls[0] ??
    jobCardClues[0] ??
    applyPathClues[0] ??
    fieldControls[0] ??
    validationErrors[0] ??
    "Deterministic visual fallback found no strong visual clue in the provided text sample.";

  return BrowserVisualObservationSetSchema.parse({
    id: createObservationSetId(input.analysisInput.snapshot.id),
    snapshotId: input.analysisInput.snapshot.id,
    observedAt: new Date().toISOString(),
    url: input.analysisInput.snapshot.url,
    purpose: input.analysisInput.snapshot.purpose,
    providerKind: input.status.kind,
    providerLabel: input.status.label,
    summary,
    blockers,
    visibleControls,
    jobCardClues,
    applyPathClues,
    fieldControls,
    validationErrors,
    recoveryNotes:
      input.analysisInput.snapshot.warnings.length > 0
        ? input.analysisInput.snapshot.warnings
        : [],
    uncertainty: [
      ...(input.extraUncertainty ?? []),
      input.analysisInput.snapshot.dataUrl
        ? "Deterministic fallback did not inspect image pixels; it used page text and runtime metadata only."
        : "No image data was available for visual analysis.",
    ],
  });
}

export function createDeterministicBrowserVisualAnalysisProvider(
  detail = "Built-in deterministic browser visual fallback summarizes page text and runtime metadata without reading image pixels.",
): BrowserVisualAnalysisProvider {
  const status = AgentProviderStatusSchema.parse({
    kind: "deterministic",
    role: "vision",
    ready: true,
    label: "Deterministic browser visual analysis",
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
    analyzeBrowserVisualSnapshot(input) {
      const analysisInput = BrowserVisualAnalysisInputSchema.parse(input);
      return Promise.resolve(
        buildDeterministicObservationSet({ analysisInput, status }),
      );
    },
  };
}

export function createOpenAiCompatibleBrowserVisualAnalysisProvider(
  options: OpenAiCompatibleBrowserVisualProviderOptions,
): BrowserVisualAnalysisProvider {
  const configuredOptions =
    OpenAiCompatibleBrowserVisualProviderOptionsSchema.safeParse(options);
  const validatedOptions = configuredOptions.success
    ? configuredOptions.data
    : null;
  const timeoutMs =
    validatedOptions?.requestTimeoutMs ?? DEFAULT_BROWSER_VISUAL_TIMEOUT_MS;
  const status = AgentProviderStatusSchema.parse({
    kind: "openai_compatible_vision",
    role: "vision",
    ready: configuredOptions.success,
    label: validatedOptions?.label ?? "Browser visual analysis",
    model: validatedOptions?.model ?? null,
    baseUrl: validatedOptions?.baseUrl ?? null,
    modelContextWindowTokens: null,
    reservedHeadroomTokens: null,
    requestTimeoutMs: configuredOptions.success ? timeoutMs : null,
    detail: configuredOptions.success
      ? "The configured vision provider classifies bounded browser screenshots into schema-validated observations only."
      : "The configured browser vision provider settings are invalid; deterministic visual fallback will be used.",
  });
  const fallback = createDeterministicBrowserVisualAnalysisProvider(
    "Deterministic browser visual fallback ran alongside the configured vision provider.",
  );

  async function fetchVisualJson(
    input: BrowserVisualAnalysisInput,
  ): Promise<unknown> {
    if (!validatedOptions) {
      throw new Error(
        "The configured browser vision provider settings are invalid.",
      );
    }

    const includeImagePayload =
      Boolean(input.snapshot.dataUrl) &&
      input.snapshot.retention.redactionLevel !== "sensitive";

    try {
      const apiMode = validatedOptions.apiMode ?? "chat_completions";
      const payload = await performModelRequest({
        url: buildModelUrl(validatedOptions.baseUrl, apiMode),
        headers: buildModelRequestHeaders({
          apiKey: validatedOptions.apiKey,
          baseUrl: validatedOptions.baseUrl,
          conversationKey: modelConversationKeys.pageExtraction(
            input.snapshot.url ?? "",
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
                "You classify a browser screenshot into safe structured observations.",
                "Return JSON only. Do not provide browser actions, selectors, generated answers, saved jobs, final submit advice, or site-specific workflow rules.",
                "Allowed content: blockers, visibleControls, jobCardClues, applyPathClues, fieldControls, validationErrors, buttonStates, questionContexts, recoveryNotes, uncertainty, observations, and reconciliations.",
                "Keep findings generic and descriptive; no CSS selectors, no click/fill/navigate instructions, and no final-submit guidance.",
              ].join(" "),
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    snapshot: {
                      id: input.snapshot.id,
                      purpose: input.snapshot.purpose,
                      mode: input.snapshot.mode,
                      url: input.snapshot.url,
                      pageTitle: input.snapshot.pageTitle,
                      label: input.snapshot.label,
                      warnings: input.snapshot.warnings,
                    },
                    context: input.context,
                    outputContract: {
                      summary: "short descriptive text or null",
                      blockers: "string[]",
                      visibleControls: "string[]",
                      jobCardClues: "string[]",
                      applyPathClues: "string[]",
                      fieldControls: "string[]",
                      validationErrors: "string[]",
                      buttonStates: "string[]",
                      recoveryNotes: "string[]",
                      uncertainty: "string[]",
                      observations:
                        "array of {label,description,kind,confidence,severity,tags}; kind must be blocker, visible_control, job_card_clue, apply_path_clue, field_control, validation_error, button_state, upload_control, question_context, recovery_note, or uncertainty; severity must be info, warning, or critical; no selectors/actions",
                      reconciliations:
                        "Return an empty array; DOM reconciliation is performed locally.",
                    },
                  }),
                },
                ...(includeImagePayload
                  ? [
                      {
                        type: "image_url",
                        image_url: {
                          url: input.snapshot.dataUrl!,
                          detail:
                            input.snapshot.mode === "full_page"
                              ? "high"
                              : "auto",
                        },
                      },
                    ]
                  : []),
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
    async analyzeBrowserVisualSnapshot(input) {
      const analysisInput = BrowserVisualAnalysisInputSchema.parse(input);
      const fallbackResult =
        await fallback.analyzeBrowserVisualSnapshot(analysisInput);

      if (!validatedOptions || !analysisInput.snapshot.dataUrl) {
        return BrowserVisualObservationSetSchema.parse({
          ...fallbackResult,
          fallbackUsed: Boolean(validatedOptions),
        });
      }

      if (analysisInput.snapshot.retention.redactionLevel === "sensitive") {
        return BrowserVisualObservationSetSchema.parse({
          ...fallbackResult,
          uncertainty: [
            ...fallbackResult.uncertainty,
            "Sensitive visual snapshot was not uploaded to the configured vision provider; deterministic visual fallback was used.",
          ],
          fallbackUsed: true,
        });
      }

      try {
        const payload = await fetchVisualJson(analysisInput);
        const primary = normalizeVisualPayload({
          rawPayload: payload,
          analysisInput,
          status,
        });

        return BrowserVisualObservationSetSchema.parse({
          ...primary,
          blockers: [
            ...new Set([...primary.blockers, ...fallbackResult.blockers]),
          ],
          visibleControls: [
            ...new Set([
              ...primary.visibleControls,
              ...fallbackResult.visibleControls,
            ]),
          ],
          jobCardClues: [
            ...new Set([
              ...primary.jobCardClues,
              ...fallbackResult.jobCardClues,
            ]),
          ],
          applyPathClues: [
            ...new Set([
              ...primary.applyPathClues,
              ...fallbackResult.applyPathClues,
            ]),
          ],
          fieldControls: [
            ...new Set([
              ...primary.fieldControls,
              ...fallbackResult.fieldControls,
            ]),
          ],
          validationErrors: [
            ...new Set([
              ...primary.validationErrors,
              ...fallbackResult.validationErrors,
            ]),
          ],
          buttonStates: [
            ...new Set([
              ...primary.buttonStates,
              ...fallbackResult.buttonStates,
            ]),
          ],
          recoveryNotes: [
            ...new Set([
              ...primary.recoveryNotes,
              ...fallbackResult.recoveryNotes,
            ]),
          ],
          observations: uniqueBy(
            [...primary.observations, ...fallbackResult.observations],
            visualObservationKey,
          ),
          questionContexts: uniqueBy(
            [...primary.questionContexts, ...fallbackResult.questionContexts],
            visualQuestionContextKey,
          ),
          uncertainty: [
            ...new Set([...primary.uncertainty, ...fallbackResult.uncertainty]),
          ],
          fallbackUsed: false,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Browser visual provider failed.";

        return BrowserVisualObservationSetSchema.parse({
          ...fallbackResult,
          providerKind: status.kind,
          providerLabel: status.label,
          rejectedOutputReasons: [
            ...fallbackResult.rejectedOutputReasons,
            message,
          ],
          uncertainty: [
            ...fallbackResult.uncertainty,
            "Configured browser visual provider failed; deterministic visual fallback was used.",
          ],
          fallbackUsed: true,
        });
      }
    },
  };
}

export function createBrowserVisualAnalysisProviderFromEnvironment(
  env: StringMap = process.env,
): BrowserVisualAnalysisProvider {
  const apiKey =
    env.NESTOR_BROWSER_VISION_API_KEY ??
    env.NESTOR_AI_VISION_API_KEY ??
    env.NESTOR_AI_API_KEY;

  if (!apiKey) {
    return createDeterministicBrowserVisualAnalysisProvider();
  }

  return createOpenAiCompatibleBrowserVisualAnalysisProvider({
    apiKey,
    baseUrl:
      env.NESTOR_BROWSER_VISION_BASE_URL ??
      env.NESTOR_AI_VISION_BASE_URL ??
      env.NESTOR_AI_BASE_URL ??
      DEFAULT_BROWSER_VISUAL_BASE_URL,
    model:
      env.NESTOR_BROWSER_VISION_MODEL ??
      env.NESTOR_AI_VISION_MODEL ??
      DEFAULT_BROWSER_VISUAL_MODEL,
    apiMode:
      parseModelApiMode(
        env.NESTOR_BROWSER_VISION_API_MODE ?? env.NESTOR_AI_VISION_API_MODE,
      ) ?? DEFAULT_VISION_MODEL_API_MODE,
    reasoningEffort:
      parseModelReasoningEffort(
        env.NESTOR_BROWSER_VISION_REASONING_EFFORT ??
          env.NESTOR_AI_VISION_REASONING_EFFORT,
      ) ?? DEFAULT_VISION_MODEL_REASONING_EFFORT,
    label: "Browser visual analysis",
    requestTimeoutMs:
      parseConfiguredNumber(env.NESTOR_BROWSER_VISION_TIMEOUT_MS) ??
      DEFAULT_BROWSER_VISUAL_TIMEOUT_MS,
    idleTimeoutMs: parseConfiguredNumber(env.NESTOR_AI_IDLE_TIMEOUT_MS),
    maxAttempts: parseConfiguredPositiveInteger(env.NESTOR_AI_MAX_ATTEMPTS),
    streaming: parseConfiguredBoolean(env.NESTOR_AI_STREAMING),
    retryBaseDelayMs: parseConfiguredPositiveInteger(
      env.NESTOR_AI_RETRY_BASE_DELAY_MS,
      0,
    ),
  });
}
