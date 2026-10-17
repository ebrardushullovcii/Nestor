import { AgentProviderStatusSchema } from "@nestor/contracts";
import type { JobFinderAiClient } from "../shared";
import { createDeterministicBrowserVisualAnalysisProvider } from "../browser-visual-analysis";
import { buildDeterministicProfileCopilotReply } from "./profile-copilot";
import { buildDeterministicResumeImportStageExtraction } from "./resume-import";
import { buildDeterministicResumeProfileExtraction } from "./resume-parser";
import {
  buildDeterministicResumeAssistantReply,
  buildDeterministicStructuredResumeDraft,
  buildDeterministicTailoredResume,
} from "./tailoring";

function buildDeterministicStatus(detail: string) {
  return AgentProviderStatusSchema.parse({
    kind: "deterministic",
    ready: true,
    label: "Built-in deterministic agent fallback",
    model: null,
    baseUrl: null,
    modelContextWindowTokens: null,
    reservedHeadroomTokens: null,
    requestTimeoutMs: null,
    detail,
  });
}

export interface DeterministicJobFinderAiClientOptions {
  /**
   * Why this client, rather than a configured model, owns generation. The
   * environment factory passes `no_provider_configured`; the desktop test API
   * passes `forced_deterministic`. Recorded on generated drafts so the UI can
   * explain the path truthfully instead of guessing from note prose.
   */
  generationReason?: DeterministicGenerationReason;
}

export type DeterministicGenerationReason =
  | "no_provider_configured"
  | "forced_deterministic";

export function createDeterministicJobFinderAiClient(
  detail?: string,
  options: DeterministicJobFinderAiClientOptions = {},
): JobFinderAiClient {
  const status = buildDeterministicStatus(
    detail ??
      "Deterministic fallback is active. Set NESTOR_AI_API_KEY to use the configured OpenAI-compatible provider for resume extraction and tailoring.",
  );
  const generationProvenance = {
    method: "deterministic" as const,
    reason: options.generationReason ?? "no_provider_configured",
    detail: status.detail ?? null,
  };
  const visualProvider = createDeterministicBrowserVisualAnalysisProvider(
    "Deterministic AI client fallback provides browser visual observations from page text and runtime metadata.",
  );

  return {
    getStatus() {
      return status;
    },
    extractProfileFromResume(input) {
      return Promise.resolve(
        buildDeterministicResumeProfileExtraction(
          input,
          "deterministic",
          status.label,
        ),
      );
    },
    extractResumeImportStage(input) {
      const startedAtMs = performance.now();
      const result = buildDeterministicResumeImportStageExtraction(
        input,
        status.label,
      );
      const durationMs = Math.max(
        0,
        Math.round(performance.now() - startedAtMs),
      );
      return Promise.resolve({
        ...result,
        timing: {
          durationMs,
          primaryProviderMs: null,
          deterministicFallbackMs: durationMs,
        },
      });
    },
    adjudicateResumeImportCandidates() {
      return Promise.resolve({
        candidates: [],
        notes: [
          "Deterministic resume import adjudication deferred material conflicts to review.",
        ],
        warnings: [],
      });
    },
    createResumeDraft(input) {
      return Promise.resolve({
        ...buildDeterministicStructuredResumeDraft(input),
        generationProvenance,
      });
    },
    reviseResumeDraft(input) {
      return Promise.resolve(buildDeterministicResumeAssistantReply(input));
    },
    reviseCandidateProfile(input) {
      return Promise.resolve(buildDeterministicProfileCopilotReply(input));
    },
    tailorResume(input) {
      return Promise.resolve({
        ...buildDeterministicTailoredResume(input),
        generationProvenance,
      });
    },
    assessJobFit() {
      return Promise.resolve(null);
    },
    extractJobsFromPage(input) {
      if (input.signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }

      return Promise.resolve([]);
    },
    analyzeBrowserVisualSnapshot(input) {
      return visualProvider.analyzeBrowserVisualSnapshot(input);
    },
  };
}
