import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  InterviewAudioTranscriptionInput,
  InterviewCueCard,
  InterviewCueInputDisclosure,
  InterviewCueTriggerKind,
  InterviewTranscriptionEngineKind,
  InterviewTranscriptionEngine,
  InterviewTranscriptSegment,
  InterviewVisualObservation,
} from "@nestor/contracts";
import { InterviewCueCardSchema } from "@nestor/contracts";
import { z } from "zod";
import { classifyAgentTaskFailure } from "@nestor/agent-runtime";
import {
  buildAudioTranscriptionsUrl,
  buildModelRequestBody,
  buildModelUrl,
  DEFAULT_OPENCODE_GO_BASE_URL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TEXT_MODEL_API_MODE,
  DEFAULT_TEXT_MODEL_REASONING_EFFORT,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_MODEL_API_MODE,
  DEFAULT_VISION_MODEL_REASONING_EFFORT,
  modelApiModes,
  modelReasoningEfforts,
  parseModelApiMode,
  parseModelJsonResponse,
  parseModelReasoningEffort,
} from "./openai-compatible-transport";
import { buildModelRequestHeaders } from "./model-request-identity";

const execFileAsync = promisify(execFile);

export interface InterviewCueCardRequest {
  readonly sessionId: string;
  readonly triggerKind: InterviewCueTriggerKind;
  readonly question: string;
  readonly targetLabel: string;
  readonly targetContextKind: InterviewCueInputDisclosure["targetContextKind"];
  readonly transcriptSegments: readonly InterviewTranscriptSegment[];
  readonly visualObservations: readonly InterviewVisualObservation[];
  readonly disclosure: InterviewCueInputDisclosure;
  readonly createdAt: string;
}

export interface InterviewCueCardProvider {
  getStatus(): {
    ready: boolean;
    label: string;
    detail: string | null;
  };
  generateCueCard(input: InterviewCueCardRequest): Promise<InterviewCueCard>;
}

export interface InterviewSummaryProvider {
  summarize(input: {
    previousSummary: string;
    transcriptSegments: readonly InterviewTranscriptSegment[];
    cueCards: readonly InterviewCueCard[];
  }): Promise<string>;
}

export interface InterviewScreenshotVisionProvider {
  getStatus(): {
    ready: boolean;
    label: string;
    detail: string | null;
  };
  describeScreenshotBatch(input: {
    batchId: string;
    screenshotCount: number;
    overlayContaminated: boolean;
    images?: ReadonlyArray<{
      readonly mimeType: string;
      readonly base64: string;
    }>;
    createdAt: string;
  }): Promise<readonly InterviewVisualObservation[]>;
}

export interface InterviewTranscriptionProvider {
  getEngines(): {
    microphone: InterviewTranscriptionEngine;
    meetingAudio: InterviewTranscriptionEngine;
  };
  transcribeAudioChunk?(
    input: InterviewAudioTranscriptionInput,
  ): Promise<InterviewAudioTranscriptionResult | null>;
  createSampleSegments(input: {
    sessionId: string;
    createdAt: string;
    language: string;
  }): readonly InterviewTranscriptSegment[];
}

export interface InterviewAudioTranscriptionResult {
  readonly text: string;
  readonly confidence: number | null;
  readonly language: string;
  readonly engineKind: InterviewTranscriptionEngineKind;
}

function normalizeModelString(value: unknown) {
  if (Array.isArray(value)) {
    const joined = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .join("; ");

    return joined.length > 0 ? joined : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

function normalizeModelStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  return [];
}

const InterviewModelCueCardOutputSchema = z.object({
  title: z.preprocess(normalizeModelString, z.string().trim().min(1)),
  answerOutline: z.preprocess(
    normalizeModelStringArray,
    z.array(z.string().trim().min(1)).min(1).max(5),
  ),
  supportingPoints: z
    .preprocess(
      normalizeModelStringArray,
      z.array(z.string().trim().min(1)).max(6),
    )
    .default([]),
  clarifyingQuestion: z.preprocess(
    normalizeModelString,
    z.string().trim().min(1).nullable().default(null),
  ),
  avoidSaying: z.preprocess(
    normalizeModelString,
    z.string().trim().min(1).nullable().default(null),
  ),
  expandedContent: z.preprocess(
    normalizeModelString,
    z.string().trim().min(1).nullable().default(null),
  ),
});

function normalizeVisualConfidence(value: unknown) {
  if (typeof value === "number") {
    if (value >= 0.75) return "high";
    if (value >= 0.4) return "medium";
    return "low";
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "high" ||
      normalized === "medium" ||
      normalized === "low"
    ) {
      return normalized;
    }
  }

  return "medium";
}

const InterviewModelVisualObservationSchema = z.object({
  summary: z.string().trim().min(1),
  confidence: z.preprocess(
    normalizeVisualConfidence,
    z.enum(["low", "medium", "high"]).default("medium"),
  ),
});

const InterviewModelVisualObservationListSchema = z.preprocess(
  (value) => (Array.isArray(value) ? { observations: value } : value),
  z.object({
    observations: z.array(InterviewModelVisualObservationSchema).min(1).max(4),
  }),
);

const OpenAiCompatibleInterviewProviderOptionsSchema = z.object({
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  apiMode: z.enum(modelApiModes).optional(),
  reasoningEffort: z.enum(modelReasoningEfforts).optional(),
  requestTimeoutMs: z.number().int().min(1_000).optional(),
});

const LocalCommandInterviewTranscriptionProviderOptionsSchema = z.object({
  command: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  requestTimeoutMs: z.number().int().min(1_000).optional(),
  workingDirectory: z.string().trim().min(1).optional(),
});

const AudioTranscriptionResponseSchema = z.object({
  text: z.string().trim().min(1),
  language: z.string().trim().min(1).optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export type OpenAiCompatibleInterviewProviderOptions = z.infer<
  typeof OpenAiCompatibleInterviewProviderOptionsSchema
>;
export type LocalCommandInterviewTranscriptionProviderOptions = z.infer<
  typeof LocalCommandInterviewTranscriptionProviderOptionsSchema
>;

export interface LiveAssistantProviderBundle {
  readonly cueCardProvider: InterviewCueCardProvider;
  readonly screenshotVisionProvider: InterviewScreenshotVisionProvider;
  readonly transcriptionProvider: InterviewTranscriptionProvider;
  readonly summaryProvider: InterviewSummaryProvider;
}

const DEFAULT_INTERVIEW_MODEL_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVIEW_MODEL = DEFAULT_TEXT_MODEL;
const DEFAULT_INTERVIEW_BASE_URL = DEFAULT_OPENCODE_GO_BASE_URL;

function pickQuestion(input: InterviewCueCardRequest): string {
  const latestMeetingQuestion = [...input.transcriptSegments]
    .reverse()
    .find(
      (segment) =>
        segment.source === "meeting_audio" ||
        segment.source === "meeting_native_transcript" ||
        segment.source === "typed_question",
    );

  return latestMeetingQuestion?.text ?? input.question;
}

function parseConfiguredTimeoutMs(
  value: string | undefined,
): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : undefined;
}

function normalizeAbortLikeError(error: unknown, timeoutMs: number): unknown {
  const message = error instanceof Error ? error.message.trim() : "";
  const isAbortLikeMessage =
    message === "This operation was aborted" ||
    message === "The operation was aborted" ||
    message === "signal is aborted without reason";

  if (error instanceof DOMException && error.name === "AbortError") {
    return new DOMException(
      `Interview model request timed out after ${Math.floor(timeoutMs / 1000)}s`,
      "AbortError",
    );
  }

  if (error instanceof Error && error.name === "AbortError") {
    const abortError = new Error(
      `Interview model request timed out after ${Math.floor(timeoutMs / 1000)}s`,
    );
    abortError.name = "AbortError";
    return abortError;
  }

  if (isAbortLikeMessage) {
    const abortError = new Error(
      `Interview model request timed out after ${Math.floor(timeoutMs / 1000)}s`,
    );
    abortError.name = "AbortError";
    return abortError;
  }

  return error;
}

function summarizeError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : "Unknown provider failure";
}

function buildCueCardPrompt(): string {
  return [
    "You generate concise live interview cue cards.",
    "Return JSON only with title, answerOutline, supportingPoints, clarifyingQuestion, avoidSaying, and expandedContent.",
    "Keep the cue speakable while someone is in an interview.",
    "Ground every claim in the provided target context, prep artifacts, transcript window, and visual observations.",
    "Never invent candidate employers, achievements, metrics, credentials, tools, links, or external actions.",
    "When the interviewer asks for a personal story but the supplied context does not contain the candidate's real story, return a clearly labeled fill-in scaffold with bracketed placeholders instead of inventing an example.",
    "Visual observations come from images the user explicitly attached or captured. When model-backed visual observations are present, use them as evidence and never claim that you cannot see or access the screenshot.",
    "When visual observations are generic or uncertain, state what is unclear and ask for a tighter crop instead of guessing.",
    "For coding interviews, explain reasoning, edge cases, tradeoffs, and clarifying questions, but never instruct the app to operate an editor, browser, meeting tool, or coding platform.",
    "If visual context is marked overlay-contaminated, ignore Live Assistant UI and mention uncertainty only when it matters.",
    "Prefer 2-4 answer outline bullets and 2-4 supporting points.",
  ].join(" ");
}

const personalStoryRequestPattern =
  /\b(?:star\s+answer|tell\s+me\s+about\s+a\s+time|describe\s+(?:a\s+)?(?:time|situation)|give\s+me\s+(?:an?\s+)?example|example\s+of\s+(?:a\s+)?time)\b/i;

const screenshotDependentQuestionPattern =
  /\b(?:attached\s+)?(?:image|photo|picture|screen(?:shot)?)\b|\b(?:what|which)\s+(?:is|does|screen)\b[\s\S]{0,80}\b(?:show|shown|visible)\b/i;

const groundedStoryEvidencePattern =
  /\b(?:i|we|my|our)\b[\s\S]{0,220}\b(?:built|created|delivered|fixed|handled|implemented|improved|led|managed|reduced|resolved|shipped|worked)\b/i;

function hasGroundedPersonalStory(input: InterviewCueCardRequest): boolean {
  return input.transcriptSegments.some((segment) => {
    const text = segment.text.trim();
    return text.length >= 40 && groundedStoryEvidencePattern.test(text);
  });
}

function createPersonalStoryScaffold(
  input: InterviewCueCardRequest,
): InterviewCueCard {
  return InterviewCueCardSchema.parse({
    id: `cue_${input.createdAt.replace(/\W/g, "_")}`,
    sessionId: input.sessionId,
    title: "STAR answer scaffold",
    question: pickQuestion(input),
    answerOutline: [
      "Situation — [state the real context and stakes in one sentence].",
      "Task — [name your actual responsibility and constraint].",
      "Action — [describe the specific steps you truly took].",
      "Result — [share the verified outcome and what you learned].",
    ],
    supportingPoints: [
      "Use only details you can defend in a follow-up question.",
      "Add real metrics only when you know they are accurate.",
      "Keep the final answer to roughly 60–90 seconds.",
    ],
    clarifyingQuestion:
      "What actually happened, what did you personally do, and what verified result can we use?",
    avoidSaying:
      "Do not invent an employer, incident, technology, timeline, metric, or outcome.",
    expandedContent:
      "Situation—[real context]. Task—[your responsibility]. Action—[your real steps]. Result—[verified outcome and lesson]. Replace every bracket before saying this aloud.",
    triggerKind: input.triggerKind,
    disclosure: input.disclosure,
    createdAt: input.createdAt,
  });
}

function createVisionUnavailableCue(
  input: InterviewCueCardRequest,
): InterviewCueCard {
  return InterviewCueCardSchema.parse({
    id: `cue_${input.createdAt.replace(/\W/g, "_")}`,
    sessionId: input.sessionId,
    title: "Screenshot needs visual analysis",
    question: pickQuestion(input),
    answerOutline: [
      "The screenshot was attached successfully.",
      "This run does not have model-backed visual observations, so its contents cannot be identified reliably.",
      "Retry with a vision-capable provider or paste the visible text for immediate help.",
    ],
    supportingPoints: [
      "The attachment is available to the current turn.",
      "No claim about the screen should be made from a generic attachment placeholder.",
    ],
    clarifyingQuestion:
      "Can you paste the visible text, describe the screen, or retry after the vision provider reports ready?",
    avoidSaying:
      "Do not guess the screenshot contents or reuse an earlier interview question as visual evidence.",
    expandedContent:
      "I received the screenshot, but this run does not have model-backed visual analysis. I cannot reliably identify the screen yet. Paste the visible text or retry with a vision-capable provider, and I can help with the next step.",
    triggerKind: input.triggerKind,
    disclosure: input.disclosure,
    createdAt: input.createdAt,
  });
}

function replaceFalseVisionDisclaimer(value: string | null): string | null {
  if (value === null) return null;

  return value
    .replace(
      /\b(?:since\s+)?i\s+(?:do\s+not|don't)\s+have\s+(?:direct\s+)?access\s+to\s+(?:the|your)\s+screenshot\s*[,;:]?\s*/gi,
      "Using the attached screenshot context, ",
    )
    .replace(
      /\bi\s+(?:can\s*not|can't)\s+see\s+(?:the|your)\s+screenshot\b/gi,
      "a screenshot detail is unclear",
    );
}

function enforceGroundedCueCard(
  input: InterviewCueCardRequest,
  cue: InterviewCueCard,
): InterviewCueCard {
  if (
    personalStoryRequestPattern.test(pickQuestion(input)) &&
    !hasGroundedPersonalStory(input)
  ) {
    return createPersonalStoryScaffold(input);
  }

  const hasModelBackedVisualEvidence = input.visualObservations.some(
    (observation) => observation.source === "screenshot",
  );

  if (
    input.disclosure.screenshotCount > 0 &&
    screenshotDependentQuestionPattern.test(pickQuestion(input)) &&
    !hasModelBackedVisualEvidence
  ) {
    return createVisionUnavailableCue(input);
  }

  if (!hasModelBackedVisualEvidence) {
    return cue;
  }

  return InterviewCueCardSchema.parse({
    ...cue,
    answerOutline: cue.answerOutline.map(replaceFalseVisionDisclaimer),
    supportingPoints: cue.supportingPoints.map(replaceFalseVisionDisclaimer),
    clarifyingQuestion: replaceFalseVisionDisclaimer(cue.clarifyingQuestion),
    avoidSaying: replaceFalseVisionDisclaimer(cue.avoidSaying),
    expandedContent: replaceFalseVisionDisclaimer(cue.expandedContent),
  });
}

function buildCueCardPayload(input: InterviewCueCardRequest) {
  return {
    trigger: {
      kind: input.triggerKind,
      question: pickQuestion(input),
      createdAt: input.createdAt,
    },
    targetContext: {
      label: input.targetLabel,
      kind: input.targetContextKind,
    },
    disclosure: input.disclosure,
    transcriptWindow: input.transcriptSegments.map((segment) => ({
      source: segment.source,
      state: segment.state,
      text: segment.text,
      language: segment.language,
      confidence: segment.confidence,
      engineKind: segment.engineKind,
    })),
    visualObservations: input.visualObservations.map((observation) => ({
      summary: observation.summary,
      confidence: observation.confidence,
      source: observation.source,
    })),
  };
}

function buildScreenshotVisionPrompt(): string {
  return [
    "Describe screenshots for live interview assistance.",
    "Return JSON only with observations: an array of 1-4 items, each with summary and confidence.",
    "Focus on visible meeting content, coding prompts, diagrams, error messages, or text that helps answer the interviewer.",
    "Do not include selectors, click instructions, app-control directions, hidden workflow rules, or final-submit guidance.",
    "If the image includes Live Assistant overlays or cue cards, ignore that UI and summarize only the underlying interview context.",
  ].join(" ");
}

function buildScreenshotVisionPayload(input: {
  batchId: string;
  screenshotCount: number;
  overlayContaminated: boolean;
  createdAt: string;
}) {
  return {
    batchId: input.batchId,
    screenshotCount: input.screenshotCount,
    overlayContaminated: input.overlayContaminated,
    createdAt: input.createdAt,
  };
}

export function createOpenAiCompatibleInterviewCueCardProvider(
  options: OpenAiCompatibleInterviewProviderOptions,
): InterviewCueCardProvider {
  const configured =
    OpenAiCompatibleInterviewProviderOptionsSchema.safeParse(options);
  const validatedOptions = configured.success ? configured.data : null;
  const label =
    validatedOptions?.label ?? options.label ?? "AI interview cue provider";
  const deterministicFallback = createDeterministicInterviewCueCardProvider(
    "Model-backed Live Assistant cues are configured, with deterministic fallback on provider failure.",
  );
  function buildCueExecutionReceipt(input: {
    startedAtMs: number;
    providerCalls: number;
    fallbackUsed: boolean;
    stopReason: "completed" | "permanent_failure";
  }) {
    const completedAtMs = Date.now();
    return {
      taskId: `interview_cue_${completedAtMs}`,
      capability: "interview_cue",
      startedAt: new Date(input.startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - input.startedAtMs,
      model: validatedOptions?.model ?? null,
      reasoningEffort: validatedOptions?.reasoningEffort ?? null,
      providerCalls: input.providerCalls,
      repairAttempts: 0,
      fallbackUsed: input.fallbackUsed,
      stopReason: input.stopReason,
      finalValidationIssues: [],
      toolReceipts: [],
    } as const;
  }

  async function fetchCueCard(
    input: InterviewCueCardRequest,
  ): Promise<unknown> {
    if (!validatedOptions) {
      throw new Error(
        "The configured Live Assistant model provider settings are invalid.",
      );
    }

    const timeoutMs =
      validatedOptions.requestTimeoutMs ?? DEFAULT_INTERVIEW_MODEL_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const apiMode = validatedOptions.apiMode ?? "chat_completions";
      const response = await fetch(
        buildModelUrl(validatedOptions.baseUrl, apiMode),
        {
          method: "POST",
          signal: controller.signal,
          headers: buildModelRequestHeaders({
            apiKey: validatedOptions.apiKey,
            baseUrl: validatedOptions.baseUrl,
            conversationKey: `interview:${input.sessionId}`,
          }),
          body: JSON.stringify(
            buildModelRequestBody({
              apiMode,
              model: validatedOptions.model,
              reasoningEffort: validatedOptions.reasoningEffort,
              jsonOutput: true,
              messages: [
                { role: "system", content: buildCueCardPrompt() },
                {
                  role: "user",
                  content: JSON.stringify(buildCueCardPayload(input)),
                },
              ],
            }),
          ),
        },
      );

      return parseModelJsonResponse(response, apiMode);
    } catch (error) {
      throw normalizeAbortLikeError(error, timeoutMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    getStatus() {
      return {
        ready: configured.success,
        label,
        detail: validatedOptions
          ? `Configured OpenAI-compatible Live Assistant cue provider using ${validatedOptions.model}.`
          : "Live Assistant model provider settings are invalid. Deterministic fallback can still validate the flow.",
      };
    },
    async generateCueCard(input) {
      const startedAtMs = Date.now();
      let lastError: unknown = null;
      let providerCalls = 0;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          providerCalls += 1;
          const payload = await fetchCueCard(input);
          const modelCue = InterviewModelCueCardOutputSchema.parse(payload);

          const cue = InterviewCueCardSchema.parse({
            id: `cue_${input.createdAt.replace(/\W/g, "_")}`,
            sessionId: input.sessionId,
            question: pickQuestion(input),
            triggerKind: input.triggerKind,
            disclosure: input.disclosure,
            createdAt: input.createdAt,
            ...modelCue,
          });
          return InterviewCueCardSchema.parse({
            ...enforceGroundedCueCard(input, cue),
            executionReceipt: buildCueExecutionReceipt({
              startedAtMs,
              providerCalls,
              fallbackUsed: false,
              stopReason: "completed",
            }),
          });
        } catch (error) {
          lastError = error;
          const failureKind = classifyAgentTaskFailure(error);
          if (
            failureKind !== "transient_network" &&
            failureKind !== "transient_provider"
          ) {
            break;
          }
        }
      }

      console.error(
        `[AI Provider] Live Assistant cue generation failed after one retry; falling back to deterministic provider. ${summarizeError(lastError)}`,
      );
      const fallback = await deterministicFallback.generateCueCard(input);
      return InterviewCueCardSchema.parse({
        ...fallback,
        executionReceipt: buildCueExecutionReceipt({
          startedAtMs,
          providerCalls,
          fallbackUsed: true,
          stopReason: "permanent_failure",
        }),
      });
    },
  };
}

export function createOpenAiCompatibleInterviewScreenshotVisionProvider(
  options: OpenAiCompatibleInterviewProviderOptions,
): InterviewScreenshotVisionProvider {
  const configured =
    OpenAiCompatibleInterviewProviderOptionsSchema.safeParse(options);
  const validatedOptions = configured.success ? configured.data : null;
  const label =
    validatedOptions?.label ??
    options.label ??
    "AI interview screenshot vision provider";
  const deterministicFallback =
    createDeterministicInterviewScreenshotVisionProvider(
      "Model-backed Live Assistant screenshot vision is configured, with deterministic fallback on provider failure.",
    );

  async function fetchVisualObservations(input: {
    batchId: string;
    screenshotCount: number;
    overlayContaminated: boolean;
    images?: ReadonlyArray<{
      readonly mimeType: string;
      readonly base64: string;
    }>;
    createdAt: string;
  }): Promise<unknown> {
    if (!validatedOptions) {
      throw new Error(
        "The configured Live Assistant screenshot vision provider settings are invalid.",
      );
    }

    if (!input.images || input.images.length === 0) {
      throw new Error("No screenshot image payload was available for vision.");
    }

    const timeoutMs =
      validatedOptions.requestTimeoutMs ?? DEFAULT_INTERVIEW_MODEL_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const apiMode = validatedOptions.apiMode ?? "chat_completions";
      const response = await fetch(
        buildModelUrl(validatedOptions.baseUrl, apiMode),
        {
          method: "POST",
          signal: controller.signal,
          headers: buildModelRequestHeaders({
            apiKey: validatedOptions.apiKey,
            baseUrl: validatedOptions.baseUrl,
            conversationKey: `interview-screenshots:${input.batchId}`,
          }),
          body: JSON.stringify(
            buildModelRequestBody({
              apiMode,
              model: validatedOptions.model,
              reasoningEffort: validatedOptions.reasoningEffort,
              jsonOutput: true,
              messages: [
                { role: "system", content: buildScreenshotVisionPrompt() },
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(buildScreenshotVisionPayload(input)),
                    },
                    ...input.images.slice(0, 3).map((image) => ({
                      type: "image_url",
                      image_url: {
                        url: `data:${image.mimeType};base64,${image.base64}`,
                      },
                    })),
                  ],
                },
              ],
            }),
          ),
        },
      );

      return parseModelJsonResponse(response, apiMode);
    } catch (error) {
      throw normalizeAbortLikeError(error, timeoutMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    getStatus() {
      return {
        ready: configured.success,
        label,
        detail: validatedOptions
          ? `Configured OpenAI-compatible Live Assistant screenshot vision using ${validatedOptions.model}.`
          : "Live Assistant screenshot vision settings are invalid. Deterministic visual observations can still validate the flow.",
      };
    },
    async describeScreenshotBatch(input) {
      try {
        const payload = await fetchVisualObservations(input);
        const parsed = InterviewModelVisualObservationListSchema.parse(payload);

        return parsed.observations.map((observation, index) => ({
          id: `visual_${input.batchId}_${index + 1}`,
          summary: observation.summary,
          source: "screenshot" as const,
          confidence: observation.confidence,
          createdAt: input.createdAt,
        }));
      } catch (error) {
        console.error(
          `[AI Provider] Live Assistant screenshot vision failed; falling back to deterministic provider. ${summarizeError(error)}`,
        );
        return deterministicFallback.describeScreenshotBatch(input);
      }
    },
  };
}

function audioBase64ToBlob(input: InterviewAudioTranscriptionInput): Blob {
  const buffer = Buffer.from(input.audioBase64, "base64");
  return new Blob([buffer], {
    type: input.mimeType,
  });
}

function getAudioFileExtension(mimeType: string) {
  if (mimeType.includes("webm")) return ".webm";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return ".mp3";
  if (mimeType.includes("wav")) return ".wav";
  if (mimeType.includes("mp4")) return ".m4a";
  return ".audio";
}

function splitCommandLine(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of command) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("Local transcription command has an unterminated quote.");
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function replaceLocalCommandPlaceholders(
  value: string,
  input: {
    audioFilePath: string;
    outputFilePath: string;
    language: string;
    source: InterviewAudioTranscriptionInput["source"];
  },
) {
  return value
    .replaceAll("{audio}", input.audioFilePath)
    .replaceAll("{output}", input.outputFilePath)
    .replaceAll("{language}", input.language)
    .replaceAll("{source}", input.source);
}

function parseLocalTranscriptionOutput(
  output: string,
  language: string,
): Omit<InterviewAudioTranscriptionResult, "engineKind"> | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("{")) {
    const parsed = AudioTranscriptionResponseSchema.parse(
      JSON.parse(trimmed) as unknown,
    );
    return {
      text: parsed.text,
      confidence: parsed.confidence ?? null,
      language: parsed.language ?? language,
    };
  }

  return {
    text: trimmed,
    confidence: null,
    language,
  };
}

async function parseAudioTranscriptionResponse(
  response: Response,
): Promise<unknown> {
  const rawBody = await response.text();
  const payload =
    rawBody.length > 0
      ? (() => {
          try {
            return JSON.parse(rawBody) as unknown;
          } catch {
            return null;
          }
        })()
      : null;

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `Audio transcription request failed with status ${response.status}`;
    throw new Error(message);
  }

  if (!payload) {
    throw new Error("Audio transcription returned a non-JSON response");
  }

  return payload;
}

export function createOpenAiCompatibleInterviewTranscriptionProvider(
  options: OpenAiCompatibleInterviewProviderOptions,
): InterviewTranscriptionProvider {
  const configured =
    OpenAiCompatibleInterviewProviderOptionsSchema.safeParse(options);
  const validatedOptions = configured.success ? configured.data : null;

  function createCloudEngine(label: string): InterviewTranscriptionEngine {
    return {
      kind: "cloud_ai",
      label,
      ready: configured.success,
      privacy: "cloud",
      cost: "metered",
      latency: "medium",
      detail: validatedOptions
        ? `Configured OpenAI-compatible audio transcription using ${validatedOptions.model}. Audio chunks are sent transiently and are not retained by Live Assistant.`
        : "Live Assistant audio transcription settings are invalid.",
    };
  }

  async function transcribeAudioChunk(
    input: InterviewAudioTranscriptionInput,
  ): Promise<InterviewAudioTranscriptionResult | null> {
    if (!validatedOptions) {
      return null;
    }

    const timeoutMs =
      validatedOptions.requestTimeoutMs ?? DEFAULT_INTERVIEW_MODEL_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const language = input.language ?? "en-US";
    const formData = new FormData();
    formData.set("model", validatedOptions.model);
    formData.set(
      "file",
      audioBase64ToBlob(input),
      `interview-${input.source}-${Date.now()}.webm`,
    );
    formData.set("language", language);

    try {
      const response = await fetch(
        buildAudioTranscriptionsUrl(validatedOptions.baseUrl),
        {
          method: "POST",
          signal: controller.signal,
          headers: buildModelRequestHeaders({
            apiKey: validatedOptions.apiKey,
            baseUrl: validatedOptions.baseUrl,
            conversationKey: `interview-audio:${input.source}`,
            contentType: null,
          }),
          body: formData,
        },
      );
      const payload = await parseAudioTranscriptionResponse(response);
      const parsed = AudioTranscriptionResponseSchema.parse(payload);

      return {
        text: parsed.text,
        confidence: parsed.confidence ?? null,
        language: parsed.language ?? language,
        engineKind: "cloud_ai",
      };
    } catch (error) {
      throw normalizeAbortLikeError(error, timeoutMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    getEngines() {
      return {
        microphone: createCloudEngine("Cloud microphone transcription"),
        meetingAudio: createCloudEngine("Cloud meeting/system transcription"),
      };
    },
    transcribeAudioChunk,
    createSampleSegments() {
      return [];
    },
  };
}

export function createLocalCommandInterviewTranscriptionProvider(
  options: LocalCommandInterviewTranscriptionProviderOptions,
): InterviewTranscriptionProvider {
  const configured =
    LocalCommandInterviewTranscriptionProviderOptionsSchema.safeParse(options);
  const validatedOptions = configured.success ? configured.data : null;
  const label =
    validatedOptions?.label ?? options.label ?? "Local command transcription";
  const commandTokens = validatedOptions?.command
    ? splitCommandLine(validatedOptions.command)
    : [];
  const executable = commandTokens[0] ?? null;
  const commandArgs = commandTokens.slice(1);

  function createLocalEngine(
    engineLabel: string,
  ): InterviewTranscriptionEngine {
    return {
      kind: "local_model",
      label: engineLabel,
      ready: Boolean(validatedOptions && executable),
      privacy: "local",
      cost: "free",
      latency: "medium",
      detail: validatedOptions
        ? "Configured local transcription command. Audio chunks are written to a temporary file for the local engine and deleted after the command exits."
        : "Local transcription command settings are invalid.",
    };
  }

  async function transcribeAudioChunk(
    input: InterviewAudioTranscriptionInput,
  ): Promise<InterviewAudioTranscriptionResult | null> {
    if (!validatedOptions || !executable) {
      return null;
    }

    const timeoutMs =
      validatedOptions.requestTimeoutMs ?? DEFAULT_INTERVIEW_MODEL_TIMEOUT_MS;
    const language = input.language ?? "en-US";
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-interview-local-stt-"),
    );
    const audioFilePath = path.join(
      tempDirectory,
      `chunk${getAudioFileExtension(input.mimeType)}`,
    );
    const outputFilePath = path.join(tempDirectory, "transcript.txt");

    try {
      await writeFile(audioFilePath, Buffer.from(input.audioBase64, "base64"));
      const args = commandArgs.map((arg) =>
        replaceLocalCommandPlaceholders(arg, {
          audioFilePath,
          outputFilePath,
          language,
          source: input.source,
        }),
      );
      const { stdout } = await execFileAsync(executable, args, {
        cwd: validatedOptions.workingDirectory,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const fallbackOutput = await readFile(outputFilePath, "utf8").catch(
        () => "",
      );
      const parsed = parseLocalTranscriptionOutput(
        stdout.trim().length > 0 ? stdout : fallbackOutput,
        language,
      );

      return parsed
        ? {
            ...parsed,
            engineKind: "local_model",
          }
        : null;
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  return {
    getEngines() {
      return {
        microphone: createLocalEngine(`${label} microphone transcription`),
        meetingAudio: createLocalEngine(
          `${label} meeting/system transcription`,
        ),
      };
    },
    transcribeAudioChunk,
    createSampleSegments() {
      return [];
    },
  };
}

export function createFallbackInterviewTranscriptionProvider(
  primary: InterviewTranscriptionProvider,
  fallback: InterviewTranscriptionProvider,
): InterviewTranscriptionProvider {
  function selectEngine(
    primaryEngine: InterviewTranscriptionEngine,
    fallbackEngine: InterviewTranscriptionEngine,
  ): InterviewTranscriptionEngine {
    if (primaryEngine.ready) {
      return {
        ...primaryEngine,
        detail: fallbackEngine.ready
          ? `${primaryEngine.detail ?? "Primary transcription engine is ready."} Fallback available: ${fallbackEngine.label}.`
          : primaryEngine.detail,
      };
    }

    return fallbackEngine;
  }

  return {
    getEngines() {
      const primaryEngines = primary.getEngines();
      const fallbackEngines = fallback.getEngines();
      return {
        microphone: selectEngine(
          primaryEngines.microphone,
          fallbackEngines.microphone,
        ),
        meetingAudio: selectEngine(
          primaryEngines.meetingAudio,
          fallbackEngines.meetingAudio,
        ),
      };
    },
    async transcribeAudioChunk(input) {
      try {
        const primaryResult = await primary.transcribeAudioChunk?.(input);
        if (primaryResult) {
          return primaryResult;
        }
      } catch (error) {
        if (!fallback.transcribeAudioChunk) {
          throw error;
        }
        console.error(
          `[AI Provider] Primary Live Assistant transcription failed; trying fallback provider. ${summarizeError(error)}`,
        );
      }

      return fallback.transcribeAudioChunk?.(input) ?? null;
    },
    createSampleSegments(input) {
      const primarySegments = primary.createSampleSegments(input);
      return primarySegments.length > 0
        ? primarySegments
        : fallback.createSampleSegments(input);
    },
  };
}

export function createDeterministicInterviewCueCardProvider(
  reason = "Deterministic Live Assistant cue provider keeps local validation stable.",
): InterviewCueCardProvider {
  return {
    getStatus() {
      return {
        ready: true,
        label: "Deterministic cue-card provider",
        detail: reason,
      };
    },
    generateCueCard(input) {
      const question = pickQuestion(input);
      const visualContext = input.visualObservations[0]?.summary ?? null;
      if (
        personalStoryRequestPattern.test(question) &&
        !hasGroundedPersonalStory(input)
      ) {
        return Promise.resolve(createPersonalStoryScaffold(input));
      }

      return Promise.resolve(
        InterviewCueCardSchema.parse({
          id: `cue_${input.createdAt.replace(/\W/g, "_")}`,
          sessionId: input.sessionId,
          title:
            input.targetContextKind === "general_interview"
              ? "Answer cue"
              : `Answer cue for ${input.targetLabel}`,
          question,
          answerOutline: [
            "Start with the direct trade-off or recommendation.",
            "Anchor the answer in a concrete example from your background.",
            "Close with how you would measure success or reduce risk.",
          ],
          supportingPoints: [
            "Clarify constraints before jumping into implementation details.",
            "Name the highest-impact option first, then mention alternatives.",
            visualContext
              ? `Use the visible context carefully: ${visualContext}`
              : "Keep the response transcript-grounded because no visual context is active.",
          ],
          clarifyingQuestion:
            "Would you like me to optimize for speed of delivery, reliability, or long-term maintainability?",
          avoidSaying:
            "Avoid claiming specific metrics or project outcomes that are not in your confirmed context.",
          expandedContent:
            "Frame the answer as a concise decision process: clarify constraints, choose the approach, explain why alternatives were not chosen, then describe validation.",
          triggerKind: input.triggerKind,
          disclosure: input.disclosure,
          createdAt: input.createdAt,
        }),
      );
    },
  };
}

// Desktop test API runs must never reach live Live Assistant providers
// through ambient credentials. Live AI during a test-API run requires this
// explicit, narrowly named opt-in; production runs with the test API absent
// keep configured behavior unchanged. Capture and acceptance harnesses pin the
// same literal, so keep the three copies in sync
// (apps/desktop/scripts/capture-live-assistant.mjs and
// apps/desktop/scripts/release-acceptance-harness.mjs).
export const DESKTOP_TEST_API_ENV = "NESTOR_ENABLE_TEST_API";
export const LIVE_ASSISTANT_TEST_LIVE_AI_OPT_IN_ENV =
  "NESTOR_INTERVIEW_TEST_USE_LIVE_AI";

const TEST_API_FORCE_DETERMINISTIC_REASON =
  "Desktop test API forces deterministic Live Assistant AI providers so scripted UI flows stay stable even when interview or shared credentials exist.";

function isExplicitlyEnabledEnvFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function createLiveAssistantProvidersFromEnvironment(
  env: Partial<Record<string, string | undefined>> = process.env,
): LiveAssistantProviderBundle {
  const desktopTestApiEnabled = isExplicitlyEnabledEnvFlag(
    env[DESKTOP_TEST_API_ENV],
  );
  const testApiLiveAiOptIn = isExplicitlyEnabledEnvFlag(
    env[LIVE_ASSISTANT_TEST_LIVE_AI_OPT_IN_ENV],
  );
  const liveAiAllowed = !desktopTestApiEnabled || testApiLiveAiOptIn;
  const deterministicReason = liveAiAllowed
    ? undefined
    : TEST_API_FORCE_DETERMINISTIC_REASON;
  const apiKey = liveAiAllowed
    ? (env.NESTOR_INTERVIEW_AI_API_KEY ?? env.NESTOR_AI_API_KEY)
    : undefined;
  const visionApiKey = liveAiAllowed
    ? (env.NESTOR_INTERVIEW_VISION_API_KEY ??
      env.NESTOR_AI_VISION_API_KEY ??
      apiKey)
    : undefined;
  const requestTimeoutMs = parseConfiguredTimeoutMs(
    env.NESTOR_INTERVIEW_AI_TIMEOUT_MS ?? env.NESTOR_AI_TIMEOUT_MS,
  );
  const screenshotVisionProvider = visionApiKey
    ? createOpenAiCompatibleInterviewScreenshotVisionProvider({
        apiKey: visionApiKey,
        baseUrl:
          env.NESTOR_INTERVIEW_VISION_BASE_URL ??
          env.NESTOR_AI_VISION_BASE_URL ??
          env.NESTOR_INTERVIEW_AI_BASE_URL ??
          env.NESTOR_AI_BASE_URL ??
          DEFAULT_INTERVIEW_BASE_URL,
        model:
          env.NESTOR_INTERVIEW_VISION_MODEL ??
          env.NESTOR_AI_VISION_MODEL ??
          env.NESTOR_RESUME_VISION_MODEL ??
          DEFAULT_VISION_MODEL,
        apiMode:
          parseModelApiMode(
            env.NESTOR_INTERVIEW_VISION_API_MODE ??
              env.NESTOR_AI_VISION_API_MODE,
          ) ?? DEFAULT_VISION_MODEL_API_MODE,
        reasoningEffort:
          parseModelReasoningEffort(
            env.NESTOR_INTERVIEW_VISION_REASONING_EFFORT ??
              env.NESTOR_AI_VISION_REASONING_EFFORT,
          ) ?? DEFAULT_VISION_MODEL_REASONING_EFFORT,
        label: "AI interview screenshot vision provider",
        requestTimeoutMs,
      })
    : createDeterministicInterviewScreenshotVisionProvider(deterministicReason);
  const deterministicTranscriptionProvider =
    createDeterministicInterviewTranscriptionProvider();
  const summaryProvider = createDeterministicInterviewSummaryProvider();
  const localTranscriptionProvider = env.NESTOR_INTERVIEW_LOCAL_STT_COMMAND
    ? createLocalCommandInterviewTranscriptionProvider({
        command: env.NESTOR_INTERVIEW_LOCAL_STT_COMMAND,
        label: env.NESTOR_INTERVIEW_LOCAL_STT_LABEL,
        requestTimeoutMs: parseConfiguredTimeoutMs(
          env.NESTOR_INTERVIEW_LOCAL_STT_TIMEOUT_MS,
        ),
        workingDirectory: env.NESTOR_INTERVIEW_LOCAL_STT_CWD,
      })
    : null;
  const transcriptionModel =
    env.NESTOR_INTERVIEW_TRANSCRIPTION_MODEL ??
    env.NESTOR_INTERVIEW_STT_MODEL ??
    env.NESTOR_INTERVIEW_AUDIO_MODEL;

  if (!apiKey) {
    return {
      cueCardProvider:
        createDeterministicInterviewCueCardProvider(deterministicReason),
      screenshotVisionProvider,
      transcriptionProvider:
        localTranscriptionProvider ?? deterministicTranscriptionProvider,
      summaryProvider,
    };
  }

  const providerOptions = {
    apiKey,
    baseUrl:
      env.NESTOR_INTERVIEW_AI_BASE_URL ??
      env.NESTOR_AI_BASE_URL ??
      DEFAULT_INTERVIEW_BASE_URL,
    model:
      env.NESTOR_INTERVIEW_AI_MODEL ??
      env.NESTOR_AI_MODEL ??
      DEFAULT_INTERVIEW_MODEL,
    apiMode:
      parseModelApiMode(
        env.NESTOR_INTERVIEW_AI_API_MODE ?? env.NESTOR_AI_API_MODE,
      ) ?? DEFAULT_TEXT_MODEL_API_MODE,
    reasoningEffort:
      parseModelReasoningEffort(
        env.NESTOR_INTERVIEW_REASONING_EFFORT ??
          env.NESTOR_AI_REASONING_EFFORT,
      ) ?? DEFAULT_TEXT_MODEL_REASONING_EFFORT,
    requestTimeoutMs,
  };

  const cloudTranscriptionProvider = transcriptionModel
    ? createOpenAiCompatibleInterviewTranscriptionProvider({
        ...providerOptions,
        model: transcriptionModel,
        label: "AI interview transcription provider",
      })
    : null;

  return {
    cueCardProvider: createOpenAiCompatibleInterviewCueCardProvider({
      ...providerOptions,
      label: "AI interview cue provider",
    }),
    screenshotVisionProvider,
    transcriptionProvider:
      localTranscriptionProvider && cloudTranscriptionProvider
        ? createFallbackInterviewTranscriptionProvider(
            localTranscriptionProvider,
            cloudTranscriptionProvider,
          )
        : (localTranscriptionProvider ??
          cloudTranscriptionProvider ??
          deterministicTranscriptionProvider),
    summaryProvider,
  };
}

export function createDeterministicInterviewSummaryProvider(): InterviewSummaryProvider {
  return {
    summarize(input) {
      const latestQuestion = [...input.transcriptSegments]
        .reverse()
        .find((segment) => segment.source === "meeting_audio")?.text;
      const cueCount = input.cueCards.length;
      const previousSummary = input.previousSummary
        .replace(/(?:^|\s)\d+ cue cards? generated\.(?=\s|$)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const latestTopic = latestQuestion
        ? `Latest interviewer topic: ${latestQuestion}`
        : null;
      const summaryParts = [
        previousSummary === "No summary yet." || previousSummary.length === 0
          ? null
          : previousSummary,
        latestTopic && !previousSummary.includes(latestTopic)
          ? latestTopic
          : null,
        cueCount > 0
          ? `${cueCount} cue card${cueCount === 1 ? "" : "s"} generated.`
          : null,
      ].filter((part): part is string => Boolean(part));

      return Promise.resolve(summaryParts.join(" ") || "No summary yet.");
    },
  };
}

export function createDeterministicInterviewScreenshotVisionProvider(
  detail = "Local deterministic visual observations are used when no live vision provider is configured.",
): InterviewScreenshotVisionProvider {
  return {
    getStatus() {
      return {
        ready: true,
        label: "Deterministic screenshot vision",
        detail,
      };
    },
    describeScreenshotBatch(input) {
      return Promise.resolve([
        {
          id: `visual_${input.batchId}`,
          summary: input.overlayContaminated
            ? "Screenshot includes possible Live Assistant overlay content; ignore overlay UI and focus on the meeting or coding prompt underneath."
            : "Screenshot shows interview context for the next cue.",
          source: "deterministic",
          confidence: "medium",
          createdAt: input.createdAt,
        },
      ]);
    },
  };
}

export function createDeterministicInterviewTranscriptionProvider(): InterviewTranscriptionProvider {
  const engine = {
    kind: "deterministic",
    label: "Deterministic local transcript",
    ready: true,
    privacy: "local",
    cost: "free",
    latency: "low",
    detail:
      "Synthetic transcript engine used for automated validation when live audio hardware is unavailable.",
  } satisfies InterviewTranscriptionEngine;

  return {
    getEngines() {
      return {
        microphone: engine,
        meetingAudio: {
          ...engine,
          label: "Deterministic meeting transcript",
        },
      };
    },
    createSampleSegments(input) {
      return [
        {
          id: `segment_meeting_${input.createdAt.replace(/\W/g, "_")}`,
          sessionId: input.sessionId,
          source: "meeting_audio",
          state: "final",
          text: "Can you walk me through how you would optimize a React application that has slow initial load time?",
          startedAt: input.createdAt,
          endedAt: input.createdAt,
          language: input.language,
          confidence: 0.96,
          engineKind: "deterministic",
          usedInCueIds: [],
        },
        {
          id: `segment_mic_${input.createdAt.replace(/\W/g, "_")}`,
          sessionId: input.sessionId,
          source: "microphone",
          state: "final",
          text: "I would start by measuring bundle size and identifying the largest render-blocking work.",
          startedAt: input.createdAt,
          endedAt: input.createdAt,
          language: input.language,
          confidence: 0.94,
          engineKind: "deterministic",
          usedInCueIds: [],
        },
      ];
    },
  };
}
