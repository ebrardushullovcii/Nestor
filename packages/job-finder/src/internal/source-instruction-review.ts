import type { JobFinderAiClient } from "@nestor/ai-providers";
import {
  SharedAgentCompactionPolicySchema,
  type SharedAgentCompactionPolicy,
  type SharedAgentHandoffCompaction,
  type SourceIntelligenceArtifact,
  type JobDiscoveryTarget,
  type JobSource,
  type SourceDebugRunRecord,
  type SourceInstructionArtifact,
} from "@nestor/contracts";
import type {
  SourceInstructionFinalReviewPhaseContext,
  SourceInstructionReviewOverride,
} from "./source-instruction-types";
import { parseSourceInstructionReviewOverride } from "./source-instruction-types";
import { compactSourceInstructionReviewPhaseContexts } from "./shared-agent-handoff-compaction";
import { SOURCE_DEBUG_PHASES } from "./workspace-defaults";

function resolveSourceInstructionReviewCompactionPolicy(input: {
  compactionPolicy: Partial<SharedAgentCompactionPolicy>;
  modelContextWindowTokens: number | null;
}): SharedAgentCompactionPolicy {
  const basePolicy = SharedAgentCompactionPolicySchema.parse(
    input.compactionPolicy,
  );

  if (
    typeof input.modelContextWindowTokens !== "number" ||
    !Number.isFinite(input.modelContextWindowTokens) ||
    input.modelContextWindowTokens <= 0
  ) {
    return basePolicy;
  }

  return SharedAgentCompactionPolicySchema.parse({
    ...basePolicy,
    minimumResponseHeadroomTokens: Math.min(
      basePolicy.minimumResponseHeadroomTokens,
      Math.max(64, Math.floor(input.modelContextWindowTokens / 4)),
    ),
  });
}

const SOURCE_INSTRUCTION_REVIEW_RESPONSE_SHAPE = {
  ready: false,
  navigationGuidance: [],
  searchGuidance: [],
  detailGuidance: [],
  applyGuidance: [],
  warnings: [],
  intelligence: {
    provider: null,
    collection: {
      preferredMethod: "fallback_search",
      rankedMethods: [],
      startingRoutes: [],
      searchRouteTemplates: [],
      detailRoutePatterns: [],
      listingMarkers: [],
    },
    apply: {
      applyPath: "unknown",
      authMarkers: [],
      consentMarkers: [],
      questionSurfaceHints: [],
      resumeUploadHints: [],
    },
    reliability: {
      selectorFingerprints: [],
      stableControlNames: [],
      failureFingerprints: [],
      verifiedAt: null,
      freshnessNotes: [],
    },
    overrides: {
      forceMethod: null,
      deniedRoutePatterns: [],
      extraStartingRoutes: [],
    },
  } satisfies SourceIntelligenceArtifact,
} satisfies SourceInstructionReviewOverride;

const MIN_SOURCE_INSTRUCTION_REVIEW_OUTPUT_TOKENS = 512;
const MAX_SOURCE_INSTRUCTION_REVIEW_OUTPUT_TOKENS = 4_096;
const SOURCE_INSTRUCTION_REVIEW_TIMEOUT_MS = 60_000;

function buildReviewTimeoutSignal(signal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  if (
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
  ) {
    const timeoutSignal = AbortSignal.timeout(
      SOURCE_INSTRUCTION_REVIEW_TIMEOUT_MS,
    );

    if (!signal) {
      return {
        signal: timeoutSignal,
        cleanup: () => undefined,
      };
    }

    if (signal.aborted || timeoutSignal.aborted) {
      const controller = new AbortController();
      controller.abort();
      return {
        signal: controller.signal,
        cleanup: () => undefined,
      };
    }

    const controller = new AbortController();
    const abort = () => {
      cleanup();
      controller.abort();
    };
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      timeoutSignal.removeEventListener("abort", abort);
    };

    signal.addEventListener("abort", abort, { once: true });
    timeoutSignal.addEventListener("abort", abort, { once: true });

    return {
      signal: controller.signal,
      cleanup,
    };
  }

  if (!signal) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      SOURCE_INSTRUCTION_REVIEW_TIMEOUT_MS,
    );

    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timeoutHandle),
    };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    cleanup();
    controller.abort();
  }, SOURCE_INSTRUCTION_REVIEW_TIMEOUT_MS);
  const abort = () => {
    cleanup();
    controller.abort();
  };
  const cleanup = () => {
    clearTimeout(timeoutHandle);
    signal.removeEventListener("abort", abort);
  };

  if (signal.aborted) {
    cleanup();
    controller.abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup,
  };
}

export function buildSourceInstructionFinalReviewPrompt(input: {
  target: JobDiscoveryTarget;
  run: SourceDebugRunRecord;
  adapterKind: JobSource;
  verification: SourceInstructionArtifact["verification"];
  instructionUnderReview: SourceInstructionArtifact | null;
  heuristicInstruction: SourceInstructionArtifact;
  phaseContexts: readonly SourceInstructionFinalReviewPhaseContext[];
  handoffCompaction?: SharedAgentHandoffCompaction | null;
}): string {
  const payload = {
    target: {
      id: input.target.id,
      label: input.target.label,
      startingUrl: input.target.startingUrl,
      adapterKind: input.adapterKind,
    },
    run: {
      id: input.run.id,
      startedAt: input.run.startedAt,
      completedAt: input.run.completedAt,
      phaseOrder: SOURCE_DEBUG_PHASES,
    },
    verification: input.verification,
    instructionUnderReview: input.instructionUnderReview
      ? {
          id: input.instructionUnderReview.id,
          status: input.instructionUnderReview.status,
          acceptedAt: input.instructionUnderReview.acceptedAt,
          verification: input.instructionUnderReview.verification,
          navigationGuidance: input.instructionUnderReview.navigationGuidance,
          searchGuidance: input.instructionUnderReview.searchGuidance,
          detailGuidance: input.instructionUnderReview.detailGuidance,
          applyGuidance: input.instructionUnderReview.applyGuidance,
          warnings: input.instructionUnderReview.warnings,
          intelligence: input.instructionUnderReview.intelligence,
        }
      : null,
    checkNotes: {
      navigationGuidance: input.heuristicInstruction.navigationGuidance,
      searchGuidance: input.heuristicInstruction.searchGuidance,
      detailGuidance: input.heuristicInstruction.detailGuidance,
      applyGuidance: input.heuristicInstruction.applyGuidance,
      warnings: input.heuristicInstruction.warnings,
      intelligence: input.heuristicInstruction.intelligence,
    },
    phaseTests: input.phaseContexts,
    handoffCompaction: input.handoffCompaction ?? null,
  };

  return [
    "Review the full source-debug evidence and organize it into the final instruction artifact.",
    "You are seeing the full sequence of agent-led phase tests, their goals, outcomes, and evidence.",
    "Use the richer phase context, timestamps, compaction summaries, attempted actions, evidence, and review transcript to decide what is actually valid.",
    "Prefer later proven evidence over earlier failed or weaker notes when they describe the same control, route, detail pattern, or apply path.",
    "Drop duplicates, raw tool chatter, step-budget chatter, and superseded contradiction lines.",
    "These outputs are reusable instructions for future discovery runs on the same site, not a report about this specific run.",
    "If an instruction artifact is already under review, compare it with the newer phase-test results and keep only the best supported guidance.",
    "If a line would not change how a future discovery run behaves, drop it.",
    "Keep uncertainty only when it still matters after reconciling the later evidence.",
    "Do not invent routes, controls, or outcomes that are not supported by the evidence.",
    "checkNotes are the check's own notes, roughly filed by the field it wrote them in. File each line you keep in the category it is about: navigation (how to reach the jobs), search (search, filters, sorting, paging), detail (job pages and their addresses), apply (how applying works).",
    "When the evidence shows search or filter controls but never shows one changing the results, say so in warnings.",
    "ready: true only when the evidence proves a future run can reach and read this site's jobs by following these lines; false when a key step is unproven or the run ended early.",
    "Keep the output concise and operator-facing.",
    "If handoffCompaction.mode is summary_first, do not ask for the missing raw transcript lines; use the typed summaries, confirmed facts, blocker notes, attempted actions, phase evidence, and compaction evidence as the authoritative handoff.",
    "Return JSON only with this shape:",
    JSON.stringify(SOURCE_INSTRUCTION_REVIEW_RESPONSE_SHAPE),
    "Guidance rules:",
    "- Prefer stable routes, visible controls, canonical detail behavior, and safe apply-entry rules.",
    "- Keep typed intelligence aligned with the evidence: provider classification, ranked routes, preferred collection method, apply hints, reliability notes, and structured overrides should reflect what the run actually proved.",
    "- The values shown in SOURCE_INSTRUCTION_REVIEW_RESPONSE_SHAPE are schema placeholders, not defaults. Do not copy placeholder literals such as provider: null, fallback_search, or empty arrays into the final output unless the evidence for this run actually proves them. Preserve stronger existing proven hints and only populate fields when this run validated them.",
    "- When a control was first flaky or unproven but later worked, keep the proven instruction and drop the earlier failure note.",
    "- When a later phase disproves an earlier claim, keep the later warning and remove the stale claim.",
    "- Empty arrays are intentional. If a category has no reliable instruction after organizing the evidence, return an empty array for that category instead of inheriting weaker lines.",
    "- Never keep extracted-job counts, sampled-job totals, step counts, tool names, or raw timeout/extraction chatter as final guidance unless they describe a durable site constraint future runs must remember.",
    "- Ask: if a future discovery run followed this line, would it behave better? If not, drop it.",
    "- Keep warnings factual and specific.",
    "Mandatory drop rules — always remove lines that match any of these patterns:",
    '- Auth-not-needed observations: any line stating the site is "accessible without login", "no authentication required", "no consent wall", or equivalent. These are default assumptions, not learned instructions.',
    "- Non-actionable observations: any line that merely describes what job cards display, what the results page shows, or how listings are formatted without telling a future agent what to DO differently.",
    "- Role-match results: any line reporting whether specific job titles or roles were found or not found (e.g. 'No React Developer positions found'). Role availability is transient and not a site instruction.",
    '- Generic fallback templates: any line like "Treat applications as manual until a reliable on-site apply entry is proven" or "Treat stable slug-style paths on the same host as the canonical detail route". These are system defaults, not site-specific knowledge.',
    "- Site identity statements: any line that merely states the site is a job board, platform, or portal without providing actionable routing or interaction guidance.",
    "Evidence payload:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

export async function reviewSourceInstructionArtifactWithAi(input: {
  aiClient: JobFinderAiClient;
  target: JobDiscoveryTarget;
  run: SourceDebugRunRecord;
  adapterKind: JobSource;
  verification: SourceInstructionArtifact["verification"];
  instructionUnderReview: SourceInstructionArtifact | null;
  heuristicInstruction: SourceInstructionArtifact;
  phaseContexts: readonly SourceInstructionFinalReviewPhaseContext[];
  compactionPolicy: Partial<SharedAgentCompactionPolicy>;
  modelContextWindowTokens: number | null;
  signal?: AbortSignal;
}): Promise<SourceInstructionReviewOverride | null> {
  if (!input.aiClient.chatWithTools || input.phaseContexts.length === 0) {
    return null;
  }

  const effectiveCompactionPolicy =
    resolveSourceInstructionReviewCompactionPolicy({
      compactionPolicy: input.compactionPolicy,
      modelContextWindowTokens: input.modelContextWindowTokens,
    });
  const chatWithTools = input.aiClient.chatWithTools;
  const maxOutputTokens = Math.min(
    MAX_SOURCE_INSTRUCTION_REVIEW_OUTPUT_TOKENS,
    Math.max(
      MIN_SOURCE_INSTRUCTION_REVIEW_OUTPUT_TOKENS,
      effectiveCompactionPolicy.minimumResponseHeadroomTokens,
    ),
  );

  const compacted = compactSourceInstructionReviewPhaseContexts({
    phaseContexts: input.phaseContexts,
    heuristicInstructionText: JSON.stringify(input.heuristicInstruction),
    instructionUnderReviewText: JSON.stringify(input.instructionUnderReview),
    verificationText: JSON.stringify(input.verification),
    compactionPolicy: effectiveCompactionPolicy,
    modelContextWindowTokens: input.modelContextWindowTokens,
  });

  if (compacted.handoffCompaction.normalizedFailureReason) {
    console.warn(
      `[Source Instruction Review] Skipping AI final review for run ${input.run.id} target ${input.target.id}: ${compacted.handoffCompaction.normalizedFailureReason}`,
    );
    return null;
  }

  try {
    const reviewTimeout = buildReviewTimeoutSignal(input.signal);
    const response = await (async () => {
      try {
        return await chatWithTools(
          [
            {
              role: "system",
              content:
                "You are the final organizer for learned source instructions. Review the full sequence of agent-led tests, reconcile conflicts, prefer stronger later evidence, and return strict JSON only.",
            },
            {
              role: "user",
              content: buildSourceInstructionFinalReviewPrompt({
                target: input.target,
                run: input.run,
                adapterKind: input.adapterKind,
                verification: input.verification,
                instructionUnderReview: input.instructionUnderReview,
                heuristicInstruction: input.heuristicInstruction,
                phaseContexts: compacted.phaseContexts,
                handoffCompaction: compacted.handoffCompaction,
              }),
            },
          ],
          [],
          {
            signal: reviewTimeout.signal,
            maxOutputTokens,
          },
        );
      } finally {
        reviewTimeout.cleanup();
      }
    })();

    if (!response.content) {
      return null;
    }

    if (!response.content.includes("{")) {
      return null;
    }

    return parseSourceInstructionReviewOverride(
      JSON.parse(extractJsonObjectString(response.content)) as unknown,
    );
  } catch (error) {
    console.warn(
      `[Source Instruction Review] AI final review failed for run ${input.run.id} target ${input.target.id}:`,
      error,
    );
    return null;
  }
}

function extractJsonObjectString(rawContent: string): string {
  const trimmed = rawContent.trim();

  if (!trimmed) {
    throw new Error("Model review returned empty content.");
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBraceIndex = trimmed.indexOf("{");
  const lastBraceIndex = trimmed.lastIndexOf("}");

  if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
    return trimmed.slice(firstBraceIndex, lastBraceIndex + 1);
  }

  return trimmed;
}
