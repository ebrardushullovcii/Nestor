import {
  createDeterministicJobFinderAiClient,
  createOpenAiCompatibleBrowserVisualAnalysisProvider,
  createOpenAiCompatibleInterviewCueCardProvider,
  createOpenAiCompatibleInterviewScreenshotVisionProvider,
  createOpenAiCompatibleJobFinderAiClient,
  createOpenAiCompatibleResumeVisionProvider,
  runProfileCopilotAgentTask,
  runResumeEditAgentTask,
} from "@nestor/ai-providers";
import {
  createApplyPageHands,
  runJobSearchAgent,
  type AgentConfig,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "@nestor/browser-runtime";
import {
  BrowserVisualAnalysisInputSchema,
  JobDiscoveryTargetSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  SourceInstructionVerificationSchema,
} from "@nestor/contracts";
import {
  reviewSourceInstructionArtifactWithAi,
  synthesizeSourceInstructionArtifact,
  type SourceInstructionFinalReviewPhaseContext,
} from "@nestor/job-finder/source-instruction-review";
import { chromium } from "playwright";

import {
  CapturedModelRunError,
  parseCapturedModelContribution,
  parseLastCapturedModelJson,
  withCapturedModelFetch,
} from "./capture-fetch";
import {
  EvalAttemptSchema,
  type EvalAttempt,
  type EvalCase,
  type EvalLane,
} from "./contracts";
import {
  createSyntheticCandidateProfile,
  createSyntheticJobFinderSettings,
  createSyntheticJobPosting,
  createSyntheticResumeDocumentBundle,
  createSyntheticResumeDraft,
  createSyntheticSearchPreferences,
} from "./synthetic-context";
import { buildSyntheticBoardHtml } from "./synthetic-board";
import { renderSyntheticSceneDataUrl } from "./synthetic-image";

export type SystemLaneEnvironment = {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
};

function readStringField(value: unknown, field: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Evaluation case input must be an object.");
  }
  const record = value as Record<string, unknown>;
  const fieldValue = record[field];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new Error(`Evaluation case is missing string input ${field}.`);
  }
  return fieldValue;
}

function readNumberField(value: unknown, field: string): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Evaluation case input must be an object.");
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new Error(`Evaluation case is missing number input ${field}.`);
  }
  return fieldValue;
}

function readStringArrayField(
  value: unknown,
  field: string,
): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Evaluation case input must be an object.");
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  if (
    !Array.isArray(fieldValue) ||
    !fieldValue.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`Evaluation case is missing string-array input ${field}.`);
  }
  return fieldValue;
}

function serializeProductOutput(
  value: unknown,
): null | boolean | number | string | unknown[] | Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as
    | null
    | boolean
    | number
    | string
    | unknown[]
    | Record<string, unknown>;
}

function serializeCapturedModelOutputs(
  captures: readonly EvalAttempt["rawHttp"][number][],
) {
  return serializeProductOutput(
    captures.map((capture) => parseCapturedModelContribution(capture)),
  );
}

function rawJobCount(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  const jobs = (value as Record<string, unknown>).jobs;
  return Array.isArray(jobs) ? jobs.length : 0;
}

function rawPatchCount(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  const patches = (value as Record<string, unknown>).patches;
  return Array.isArray(patches) ? patches.length : 0;
}

function rawCandidateCount(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  const candidates = (value as Record<string, unknown>).candidates;
  return Array.isArray(candidates) ? candidates.length : 0;
}

function rawObservationCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value === null || typeof value !== "object") return 0;
  const observations = (value as Record<string, unknown>).observations;
  return Array.isArray(observations) ? observations.length : 0;
}

function hasValidInterviewCueShape(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.title === "string" &&
    Array.isArray(record.answerOutline) &&
    record.answerOutline.length > 0 &&
    Array.isArray(record.supportingPoints)
  );
}

async function withQuietAgentConsole<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalDebug = console.debug;
  console.log = () => undefined;
  console.debug = () => undefined;
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.debug = originalDebug;
  }
}

function createPrimaryClient(
  lane: EvalLane,
  environment: SystemLaneEnvironment,
) {
  return createOpenAiCompatibleJobFinderAiClient({
    apiKey: environment.apiKey,
    baseUrl: environment.baseUrl,
    model: lane.model,
    reasoningEffort: lane.reasoningEffort,
    apiMode: "responses",
    requestTimeoutMs: environment.requestTimeoutMs,
    resumeExtractionTimeoutMs: environment.requestTimeoutMs,
    label: `AI eval ${lane.id}`,
  });
}

async function finalizeSyntheticSourceInstruction(input: {
  readonly client: ReturnType<typeof createPrimaryClient>;
  readonly workerResult: Awaited<ReturnType<typeof runJobSearchAgent>>;
  readonly runId: string;
  readonly startingUrl: string;
}) {
  const now = new Date().toISOString();
  const target = JobDiscoveryTargetSchema.parse({
    id: `target_${input.runId}`,
    label: "Example Careers",
    startingUrl: input.startingUrl,
    enabled: true,
    adapterKind: "auto",
    instructionStatus: "missing",
  });
  const phase = "search_filter_probe" as const;
  const completionMode =
    input.workerResult.phaseCompletionMode ?? "forced_finish";
  const resultSummary =
    input.workerResult.debugFindings?.summary ??
    input.workerResult.phaseCompletionReason ??
    "Synthetic source-check phase completed.";
  const confirmedFacts = [
    ...(input.workerResult.phaseEvidence?.routeSignals ?? []),
    ...(input.workerResult.phaseEvidence?.successfulInteractions ?? []),
  ];
  const attemptedActions = [
    ...(input.workerResult.phaseEvidence?.attemptedControls ?? []),
  ];
  const blockerSummary =
    input.workerResult.phaseEvidence?.warnings.join(" ").trim() || null;
  const attempt = SourceDebugWorkerAttemptSchema.parse({
    id: `attempt_${input.runId}`,
    runId: input.runId,
    targetId: target.id,
    phase,
    startedAt: now,
    completedAt: now,
    outcome: input.workerResult.error ? "partial" : "succeeded",
    completionMode,
    completionReason: input.workerResult.phaseCompletionReason,
    strategyLabel: "Synthetic source-check evidence",
    strategyFingerprint: `synthetic:${input.runId}`,
    confirmedFacts,
    attemptedActions,
    blockerSummary,
    resultSummary,
    confidenceScore: input.workerResult.error ? 45 : 85,
    phaseEvidence: input.workerResult.phaseEvidence,
    visualEvidence: [],
    compactionState: input.workerResult.compactionState,
  });
  const run = SourceDebugRunRecordSchema.parse({
    id: input.runId,
    targetId: target.id,
    state: input.workerResult.error ? "failed" : "completed",
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    activePhase: null,
    phases: [phase],
    targetLabel: target.label,
    targetUrl: target.startingUrl,
    targetHostname: new URL(target.startingUrl).hostname,
    finalSummary: resultSummary,
    attemptIds: [attempt.id],
    phaseSummaries: [
      {
        phase,
        summary: resultSummary,
        completionMode,
        completionReason: attempt.completionReason,
        confirmedFacts,
        blockerNotes: blockerSummary ? [blockerSummary] : [],
        producedAttemptIds: [attempt.id],
      },
    ],
  });
  const verification = SourceInstructionVerificationSchema.parse({
    id: `verification_${input.runId}`,
    replayRunId: input.runId,
    verifiedAt: now,
    outcome: "passed",
    proofSummary:
      "The synthetic browser phase evidence was captured for review.",
    versionInfo: {
      promptProfileVersion: "ai-eval-v1",
      toolsetVersion: "ai-eval-v1",
      adapterVersion: "target-site-v1",
      appSchemaVersion: "ai-eval-v1",
    },
  });
  const heuristicInstruction = synthesizeSourceInstructionArtifact(
    target,
    run,
    [attempt],
    "target_site",
    verification,
  );
  const phaseContext: SourceInstructionFinalReviewPhaseContext = {
    phase,
    phaseGoal:
      "Map a replayable anonymous search path and report only observed controls and routes.",
    successCriteria: [
      "Record observed routes and result-changing controls.",
      "Distinguish verified behavior from untested assumptions.",
    ],
    stopConditions: [
      "Stop after enough evidence exists for truthful guidance.",
    ],
    knownFactsAtStart: ["The fixture is public and synthetic."],
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    outcome: attempt.outcome,
    completionMode: attempt.completionMode,
    completionReason: attempt.completionReason,
    resultSummary: attempt.resultSummary,
    blockerSummary: attempt.blockerSummary,
    confirmedFacts: attempt.confirmedFacts,
    attemptedActions: attempt.attemptedActions,
    phaseEvidence: attempt.phaseEvidence,
    visualEvidence: attempt.visualEvidence,
    compactionState: attempt.compactionState,
    reviewTranscript: input.workerResult.reviewTranscript ?? [],
  };
  const reviewOverride = await reviewSourceInstructionArtifactWithAi({
    aiClient: input.client,
    target,
    run,
    adapterKind: "target_site",
    verification,
    instructionUnderReview: heuristicInstruction,
    heuristicInstruction,
    phaseContexts: [phaseContext],
    compactionPolicy: {},
    modelContextWindowTokens: null,
  });
  const finalizedInstruction = synthesizeSourceInstructionArtifact(
    target,
    run,
    [attempt],
    "target_site",
    verification,
    reviewOverride,
    heuristicInstruction,
  );
  return {
    worker: input.workerResult,
    heuristicInstruction,
    reviewOverride,
    finalizedInstruction,
  };
}

export function readSystemLaneEnvironment(
  env: Record<string, string | undefined>,
): SystemLaneEnvironment {
  const apiKey = env.NESTOR_AI_API_KEY?.trim();
  const baseUrl = env.NESTOR_AI_BASE_URL?.trim();
  if (!apiKey || !baseUrl) {
    throw new Error(
      "Configured benchmark requires NESTOR_AI_API_KEY and NESTOR_AI_BASE_URL.",
    );
  }
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    requestTimeoutMs: 180_000,
  };
}

export async function runProfileCopilotSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  if (input.lane.kind !== "system") {
    throw new Error("System runner cannot execute the Codex reference lane.");
  }
  if (input.evalCase.capability !== "profile_copilot") {
    throw new Error("Profile Copilot runner received the wrong capability.");
  }

  const client = createPrimaryClient(input.lane, input.environment);
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();

  try {
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: () =>
        runProfileCopilotAgentTask({
          client,
          request: {
            profile: createSyntheticCandidateProfile(),
            searchPreferences: createSyntheticSearchPreferences(),
            context: { surface: "profile", section: "preferences" },
            relevantReviewItems: [],
            request: readStringField(input.evalCase.input, "request"),
          },
        }),
    });
    const fallbackDetected =
      captured.captures.length === 0 ||
      captured.captures.some(
        (capture) =>
          capture.error !== null ||
          capture.responseStatus === null ||
          capture.responseStatus < 200 ||
          capture.responseStatus >= 300,
      );
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected,
      guardedRejectionDetected: false,
      rawHttp: captured.captures,
      modelOutput: serializeProductOutput(
        parseLastCapturedModelJson(captured.captures),
      ),
      productOutput: serializeProductOutput(captured.result),
      error: null,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    const message =
      rootError instanceof Error ? rootError.message : String(rootError);
    const deterministicFallback = createDeterministicJobFinderAiClient();
    let fallbackOutput: unknown = null;
    try {
      fallbackOutput = await deterministicFallback.reviseCandidateProfile({
        profile: createSyntheticCandidateProfile(),
        searchPreferences: createSyntheticSearchPreferences(),
        context: { surface: "profile", section: "preferences" },
        relevantReviewItems: [],
        request: readStringField(input.evalCase.input, "request"),
      });
    } catch {
      fallbackOutput = null;
    }
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status:
        fallbackOutput !== null
          ? "fallback_succeeded"
          : /timed out|abort/i.test(message)
            ? "timed_out"
            : "failed",
      providerCallCount: captures.length,
      fallbackDetected: fallbackOutput !== null,
      guardedRejectionDetected: true,
      rawHttp: captures,
      modelOutput: serializeProductOutput(parseLastCapturedModelJson(captures)),
      productOutput: serializeProductOutput(fallbackOutput),
      error: message,
    });
  }
}

export async function runJobPageExtractionSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  if (input.lane.kind !== "system") {
    throw new Error("System runner cannot execute the Codex reference lane.");
  }
  if (input.evalCase.capability !== "job_page_extraction") {
    throw new Error("Job extraction runner received the wrong capability.");
  }
  const primaryClient = createPrimaryClient(input.lane, input.environment);
  const pageKind = readStringField(input.evalCase.input, "pageKind");
  if (pageKind !== "search_results" && pageKind !== "job_detail") {
    throw new Error(`Unsupported synthetic page kind: ${pageKind}`);
  }
  const request: Parameters<typeof primaryClient.extractJobsFromPage>[0] = {
    pageText: readStringField(input.evalCase.input, "pageText"),
    pageUrl: readStringField(input.evalCase.input, "url"),
    pageType: pageKind,
    maxJobs: Math.max(
      1,
      Math.min(12, readNumberField(input.evalCase.expected, "count") + 2),
    ),
  };
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  try {
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: () => primaryClient.extractJobsFromPage(request),
    });
    const rawModelOutput = parseLastCapturedModelJson(captured.captures);
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected: false,
      guardedRejectionDetected:
        rawJobCount(rawModelOutput) > captured.result.length,
      rawHttp: captured.captures,
      modelOutput: serializeProductOutput(rawModelOutput),
      productOutput: serializeProductOutput(captured.result),
      error: null,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    const message =
      rootError instanceof Error ? rootError.message : String(rootError);
    const fallbackOutput =
      await createDeterministicJobFinderAiClient().extractJobsFromPage(request);
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "fallback_succeeded",
      providerCallCount: captures.length,
      fallbackDetected: true,
      guardedRejectionDetected: true,
      rawHttp: captures,
      modelOutput: serializeProductOutput(parseLastCapturedModelJson(captures)),
      productOutput: serializeProductOutput(fallbackOutput),
      error: message,
    });
  }
}

export async function runResumeTextImportSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  if (input.evalCase.capability !== "resume_text_import") {
    throw new Error("Resume import runner received the wrong capability.");
  }
  const stages = ["identity_summary", "experience", "background"] as const;
  const profile = createSyntheticCandidateProfile();
  const searchPreferences = createSyntheticSearchPreferences();
  const documentBundle = createSyntheticResumeDocumentBundle(
    readStringField(input.evalCase.input, "resumeText"),
  );
  const primaryClient = createPrimaryClient(input.lane, input.environment);
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  try {
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: async () => {
        const results = [];
        for (const stage of stages) {
          results.push(
            await primaryClient.extractResumeImportStage({
              stage,
              existingProfile: profile,
              existingSearchPreferences: searchPreferences,
              documentBundle,
            }),
          );
        }
        return results;
      },
    });
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected: false,
      guardedRejectionDetected: false,
      rawHttp: captured.captures,
      modelOutput: serializeCapturedModelOutputs(captured.captures),
      productOutput: serializeProductOutput(captured.result),
      error: null,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    const message =
      rootError instanceof Error ? rootError.message : String(rootError);
    const fallbackClient = createDeterministicJobFinderAiClient();
    const fallbackResults = [];
    for (const stage of stages) {
      fallbackResults.push(
        await fallbackClient.extractResumeImportStage({
          stage,
          existingProfile: profile,
          existingSearchPreferences: searchPreferences,
          documentBundle,
        }),
      );
    }
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "fallback_succeeded",
      providerCallCount: captures.length,
      fallbackDetected: true,
      guardedRejectionDetected: true,
      rawHttp: captures,
      modelOutput: serializeCapturedModelOutputs(captures),
      productOutput: serializeProductOutput(fallbackResults),
      error: message,
    });
  }
}

export async function runResumeGenerationSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  if (input.evalCase.capability !== "resume_generation") {
    throw new Error("Resume generation runner received the wrong capability.");
  }
  const candidateHeadline = readStringField(
    input.evalCase.input,
    "candidateHeadline",
  );
  const evidence = readStringField(input.evalCase.input, "evidence");
  const jobTitle = readStringField(input.evalCase.input, "jobTitle");
  const jobKeywords = readStringField(input.evalCase.input, "jobKeywords");
  const profile = {
    ...createSyntheticCandidateProfile(),
    headline: candidateHeadline,
    summary: evidence,
    professionalSummary: {
      ...createSyntheticCandidateProfile().professionalSummary,
      shortValueProposition: evidence,
      fullSummary: evidence,
    },
  };
  const request = {
    profile,
    searchPreferences: createSyntheticSearchPreferences(),
    settings: createSyntheticJobFinderSettings(),
    job: createSyntheticJobPosting({
      title: jobTitle,
      description: jobKeywords,
      keySkills: jobKeywords.split(/[,;]/).map((value) => value.trim()),
    }),
    resumeText: `${candidateHeadline}. ${evidence}`,
    evidence: {
      summary: [evidence],
      candidateSummary: [candidateHeadline],
      experience: [evidence],
      skills: profile.skills,
      keywords: jobKeywords.split(/[,;]/).map((value) => value.trim()),
    },
    researchContext: {
      companyNotes: [],
      domainVocabulary: [],
      priorityThemes: [],
    },
  };
  const primaryClient = createPrimaryClient(input.lane, input.environment);
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  try {
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: () => primaryClient.createResumeDraft(request),
    });
    const fallbackDetected =
      /fell back to the deterministic resume draft creator after the model call failed/i.test(
        JSON.stringify(captured.result),
      );
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: fallbackDetected ? "fallback_succeeded" : "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected,
      guardedRejectionDetected:
        fallbackDetected ||
        (captured.result.generationQuality?.rejectedRewriteCount ?? 0) > 0,
      rawHttp: captured.captures,
      modelOutput: serializeProductOutput(
        parseLastCapturedModelJson(captured.captures),
      ),
      productOutput: serializeProductOutput(captured.result),
      error: null,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    const message =
      rootError instanceof Error ? rootError.message : String(rootError);
    const fallbackOutput =
      await createDeterministicJobFinderAiClient().createResumeDraft(request);
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "fallback_succeeded",
      providerCallCount: captures.length,
      fallbackDetected: true,
      guardedRejectionDetected: true,
      rawHttp: captures,
      modelOutput: serializeProductOutput(parseLastCapturedModelJson(captures)),
      productOutput: serializeProductOutput(fallbackOutput),
      error: message,
    });
  }
}

export async function runGuidedResumeEditSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  if (input.evalCase.capability !== "guided_resume_edits") {
    throw new Error("Guided Edits runner received the wrong capability.");
  }
  const draftText = readStringField(input.evalCase.input, "draft");
  const evidence = readStringField(input.evalCase.input, "evidence");
  const requestText = readStringField(input.evalCase.input, "request");
  const request = {
    draft: createSyntheticResumeDraft(
      draftText,
      input.evalCase.id.includes("locked"),
    ),
    job: createSyntheticJobPosting({ description: evidence }),
    request: requestText,
    validationIssues: [],
    researchContext: {
      companyNotes: [],
      domainVocabulary: [],
      priorityThemes: [],
    },
  };
  const primaryClient = createPrimaryClient(input.lane, input.environment);
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  try {
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: () => runResumeEditAgentTask({ client: primaryClient, request }),
    });
    const rawModelOutput = parseLastCapturedModelJson(captured.captures);
    const productPatchCount = captured.result.patches.length;
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected: false,
      guardedRejectionDetected:
        rawPatchCount(rawModelOutput) > productPatchCount,
      rawHttp: captured.captures,
      modelOutput: serializeProductOutput(rawModelOutput),
      productOutput: serializeProductOutput(captured.result),
      error: null,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    const message =
      rootError instanceof Error ? rootError.message : String(rootError);
    const fallbackOutput =
      await createDeterministicJobFinderAiClient().reviseResumeDraft(request);
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "fallback_succeeded",
      providerCallCount: captures.length,
      fallbackDetected: true,
      guardedRejectionDetected: true,
      rawHttp: captures,
      modelOutput: serializeProductOutput(parseLastCapturedModelJson(captures)),
      productOutput: serializeProductOutput(fallbackOutput),
      error: message,
    });
  }
}

export async function runResumeVisionSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  if (input.evalCase.capability !== "resume_vision") {
    throw new Error("Resume vision runner received the wrong capability.");
  }
  const visibleFacts = readStringArrayField(
    input.evalCase.input,
    "visibleFacts",
  );
  const visualFixture = readStringField(input.evalCase.input, "visualFixture");
  const dataUrls =
    visualFixture === "repeated_headers"
      ? await Promise.all(
          [
            "resume_repeated_header_page_1",
            "resume_repeated_header_page_2",
          ].map((sceneKind) =>
            renderSyntheticSceneDataUrl({
              title: input.evalCase.title,
              lines: visibleFacts,
              sceneKind,
            }),
          ),
        )
      : [
          await renderSyntheticSceneDataUrl({
            title: input.evalCase.title,
            lines: visibleFacts,
            lowResolution: input.evalCase.id.includes("low_resolution"),
            sceneKind: `resume_${visualFixture}`,
          }),
        ];
  const provider = createOpenAiCompatibleResumeVisionProvider({
    apiKey: input.environment.apiKey,
    baseUrl: input.environment.baseUrl,
    model: input.lane.model,
    apiMode: "responses",
    reasoningEffort: input.lane.reasoningEffort,
    requestTimeoutMs: input.environment.requestTimeoutMs,
    maxPagesPerBatch: 1,
    label: `AI eval ${input.lane.id}`,
  });
  const request = {
    existingProfile: createSyntheticCandidateProfile(),
    existingSearchPreferences: createSyntheticSearchPreferences(),
    documentBundle: createSyntheticResumeDocumentBundle(
      "Rendered page available; text extraction intentionally withheld.",
    ),
    visionArtifact: {
      id: `vision_${input.evalCase.id}`,
      runId: input.runId,
      sourceResumeId: "resume_synthetic_eval",
      sourceFileKind: "pdf" as const,
      createdAt: "2026-08-01T10:00:00.000Z",
      retained: "temporary" as const,
      pages: dataUrls.map((dataUrl, index) => ({
        id: `vision_page_${input.evalCase.id}_${index + 1}`,
        sourceResumeId: "resume_synthetic_eval",
        sourceFileKind: "pdf" as const,
        pageNumber: index + 1,
        renderKind: "pdf_page_image" as const,
        mimeType: "image/png",
        width: input.evalCase.id.includes("low_resolution") ? 480 : 1200,
        height: input.evalCase.id.includes("low_resolution") ? 320 : 800,
        byteLength: Math.floor(dataUrl.length * 0.75),
        sha256: `synthetic-${input.evalCase.id}-${index + 1}`,
        dataUrl,
        storagePath: null,
        retained: "temporary" as const,
        generatedAt: "2026-08-01T10:00:00.000Z",
        warnings: [],
      })),
      warnings: [],
    },
  };
  try {
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: () => provider.extractResumeVision(request),
    });
    const fallbackDetected =
      captured.result.analysisProviderKind !== "openai_compatible_vision";
    const rawModelOutput = parseLastCapturedModelJson(captured.captures);
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: fallbackDetected ? "fallback_succeeded" : "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected,
      guardedRejectionDetected:
        fallbackDetected ||
        rawCandidateCount(rawModelOutput) > captured.result.candidates.length,
      rawHttp: captured.captures,
      modelOutput: serializeProductOutput(rawModelOutput),
      productOutput: serializeProductOutput(captured.result),
      error: null,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "failed",
      providerCallCount: captures.length,
      fallbackDetected: false,
      guardedRejectionDetected: true,
      rawHttp: captures,
      modelOutput: serializeCapturedModelOutputs(captures),
      productOutput: null,
      error: rootError instanceof Error ? rootError.message : String(rootError),
    });
  }
}

export async function runBrowserVisualSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  if (input.evalCase.capability !== "browser_visual_analysis") {
    throw new Error("Browser visual runner received the wrong capability.");
  }
  const visibleScene = readStringField(input.evalCase.input, "visibleScene");
  const visualFixture = readStringField(input.evalCase.input, "visualFixture");
  const purpose = readStringField(input.evalCase.input, "purpose");
  if (purpose !== "source_debug" && purpose !== "apply_checkpoint") {
    throw new Error(`Unsupported visual purpose: ${purpose}`);
  }
  const dataUrl = await renderSyntheticSceneDataUrl({
    title: input.evalCase.title,
    lines: [visibleScene],
    sceneKind: `browser_${visualFixture}`,
  });
  const analysisInput = BrowserVisualAnalysisInputSchema.parse({
    snapshot: {
      id: `snapshot_${input.evalCase.id}`,
      capturedAt: "2026-08-01T10:00:00.000Z",
      url: "https://jobs.example.com/synthetic-visual",
      pageTitle: input.evalCase.title,
      mode: "viewport",
      purpose,
      label: input.evalCase.title,
      region: null,
      viewport: { x: 0, y: 0, width: 1200, height: 800 },
      mimeType: "image/png",
      dataUrl,
      storagePath: null,
      retention: {
        retention: "temporary",
        redactionLevel: input.evalCase.id.includes("sensitive")
          ? "sensitive"
          : "standard",
        reason: "Synthetic AI evaluation screenshot.",
        expiresAt: null,
      },
      warnings: [],
    },
    context: {
      purpose,
      taskGoal: "Classify visible state without taking browser action.",
      pageUrl: "https://jobs.example.com/synthetic-visual",
      pageTitle: input.evalCase.title,
      visibleTextSample: visibleScene,
      domSignals: [],
      sourceDebug:
        purpose === "source_debug"
          ? {
              phase: "site_structure_mapping",
              targetLabel: "Synthetic jobs board",
              knownFacts: [],
            }
          : null,
      apply:
        purpose === "apply_checkpoint"
          ? {
              jobTitle: "Synthetic Engineer",
              company: "Example Labs",
              checkpointLabel: "Review visible form state",
              recoveryMode: false,
            }
          : null,
    },
  });
  const provider = createOpenAiCompatibleBrowserVisualAnalysisProvider({
    apiKey: input.environment.apiKey,
    baseUrl: input.environment.baseUrl,
    model: input.lane.model,
    apiMode: "responses",
    reasoningEffort: input.lane.reasoningEffort,
    requestTimeoutMs: input.environment.requestTimeoutMs,
    label: `AI eval ${input.lane.id}`,
  });
  try {
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: () => provider.analyzeBrowserVisualSnapshot(analysisInput),
    });
    const fallbackDetected = captured.result.fallbackUsed === true;
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: fallbackDetected ? "fallback_succeeded" : "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected,
      guardedRejectionDetected: fallbackDetected,
      rawHttp: captured.captures,
      modelOutput: serializeCapturedModelOutputs(captured.captures),
      productOutput: serializeProductOutput(captured.result),
      error: null,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "failed",
      providerCallCount: captures.length,
      fallbackDetected: false,
      guardedRejectionDetected: true,
      rawHttp: captures,
      modelOutput: serializeCapturedModelOutputs(captures),
      productOutput: null,
      error: rootError instanceof Error ? rootError.message : String(rootError),
    });
  }
}

export async function runInterviewCueSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  if (input.evalCase.capability !== "interview_cue") {
    throw new Error("Interview cue runner received the wrong capability.");
  }
  const question = readStringField(input.evalCase.input, "question");
  const evidence = readStringField(input.evalCase.input, "transcriptEvidence");
  const provider = createOpenAiCompatibleInterviewCueCardProvider({
    apiKey: input.environment.apiKey,
    baseUrl: input.environment.baseUrl,
    model: input.lane.model,
    apiMode: "responses",
    reasoningEffort: input.lane.reasoningEffort,
    requestTimeoutMs: input.environment.requestTimeoutMs,
    label: `AI eval ${input.lane.id}`,
  });
  const request = {
    sessionId: "session_synthetic_eval",
    triggerKind: "automatic_question" as const,
    question,
    targetLabel: "Synthetic Software Engineer interview",
    targetContextKind: "general_interview" as const,
    transcriptSegments: [
      {
        id: "segment_synthetic_eval",
        sessionId: "session_synthetic_eval",
        source: "meeting_audio" as const,
        state: "final" as const,
        text: `${question} ${evidence}`,
        startedAt: "2026-08-01T10:00:00.000Z",
        endedAt: "2026-08-01T10:00:05.000Z",
        language: "en-US",
        confidence: 0.98,
        engineKind: "platform_local" as const,
        usedInCueIds: [],
      },
    ],
    visualObservations: [],
    disclosure: {
      transcriptWindow: "1 synthetic source-labeled segment",
      triggerSource: "meeting_audio" as const,
      targetContextKind: "general_interview" as const,
      screenshotCount: 0,
      overlayContaminated: false,
      degradedCapabilityIds: [],
      usedPartialTranscript: false,
    },
    createdAt: "2026-08-01T10:00:06.000Z",
  };
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  try {
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: () => provider.generateCueCard(request),
    });
    const rawModelOutput = parseLastCapturedModelJson(captured.captures);
    const fallbackDetected = !hasValidInterviewCueShape(rawModelOutput);
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: fallbackDetected ? "fallback_succeeded" : "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected,
      guardedRejectionDetected: fallbackDetected,
      rawHttp: captured.captures,
      modelOutput: serializeProductOutput(rawModelOutput),
      productOutput: serializeProductOutput(captured.result),
      error: null,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "failed",
      providerCallCount: captures.length,
      fallbackDetected: false,
      guardedRejectionDetected: true,
      rawHttp: captures,
      modelOutput: serializeCapturedModelOutputs(captures),
      productOutput: null,
      error: rootError instanceof Error ? rootError.message : String(rootError),
    });
  }
}

export async function runInterviewScreenshotVisionSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  if (input.evalCase.capability !== "interview_screenshot_vision") {
    throw new Error(
      "Interview screenshot runner received the wrong capability.",
    );
  }
  const visibleScene = readStringField(input.evalCase.input, "visibleScene");
  const visualFixture = readStringField(input.evalCase.input, "visualFixture");
  const dataUrls =
    visualFixture === "conflicting"
      ? await Promise.all(
          ["interview_deployment_success", "interview_deployment_failure"].map(
            (sceneKind) =>
              renderSyntheticSceneDataUrl({
                title: input.evalCase.title,
                lines: [visibleScene],
                sceneKind,
              }),
          ),
        )
      : [
          await renderSyntheticSceneDataUrl({
            title: input.evalCase.title,
            lines: [visibleScene],
            lowResolution: input.evalCase.id.includes("cropped"),
            sceneKind: `interview_${visualFixture}`,
          }),
        ];
  const provider = createOpenAiCompatibleInterviewScreenshotVisionProvider({
    apiKey: input.environment.apiKey,
    baseUrl: input.environment.baseUrl,
    model: input.lane.model,
    apiMode: "responses",
    reasoningEffort: input.lane.reasoningEffort,
    requestTimeoutMs: input.environment.requestTimeoutMs,
    label: `AI eval ${input.lane.id}`,
  });
  const request = {
    batchId: `batch_${input.evalCase.id}`,
    screenshotCount: dataUrls.length,
    overlayContaminated: false,
    images: dataUrls.map((dataUrl) => ({
      mimeType: "image/png",
      base64: dataUrl.replace(/^data:image\/png;base64,/, ""),
    })),
    createdAt: "2026-08-01T10:00:06.000Z",
  };
  try {
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: () => provider.describeScreenshotBatch(request),
    });
    const rawModelOutput = parseLastCapturedModelJson(captured.captures);
    const fallbackDetected = rawObservationCount(rawModelOutput) === 0;
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: fallbackDetected ? "fallback_succeeded" : "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected,
      guardedRejectionDetected: fallbackDetected,
      rawHttp: captured.captures,
      modelOutput: serializeProductOutput(rawModelOutput),
      productOutput: serializeProductOutput(captured.result),
      error: null,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "failed",
      providerCallCount: captures.length,
      fallbackDetected: false,
      guardedRejectionDetected: true,
      rawHttp: captures,
      modelOutput: serializeCapturedModelOutputs(captures),
      productOutput: null,
      error: rootError instanceof Error ? rootError.message : String(rootError),
    });
  }
}

export async function runBrowserAgentSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  const startedAt = new Date().toISOString();
  const startedAtMs = performance.now();
  const isSourceDebug = input.evalCase.capability === "source_debug";
  if (!isSourceDebug && input.evalCase.capability !== "agentic_job_discovery") {
    throw new Error("Browser-agent runner received the wrong capability.");
  }
  const summary = readStringField(input.evalCase.input, "fixtureSummary");
  const fixtureKind = readStringField(
    input.evalCase.input,
    isSourceDebug ? "sourceFixture" : "browserFixture",
  );
  const targetJobCount = isSourceDebug
    ? 2
    : readNumberField(input.evalCase.expected, "usefulDistinctJobs");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (new URL(requestUrl).hostname !== "jobs.example.com") {
        await route.abort("blockedbyclient");
        return;
      }
      const requestPath = new URL(requestUrl).pathname;
      if (fixtureKind === "login_redirect" && requestPath !== "/login") {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: buildSyntheticBoardHtml({
            title: input.evalCase.title,
            summary,
            jobCount: targetJobCount,
            fixtureKind,
            url: "https://jobs.example.com/login",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: buildSyntheticBoardHtml({
          title: input.evalCase.title,
          summary,
          jobCount: targetJobCount,
          fixtureKind,
          url: requestUrl,
        }),
      });
    });
    const startingPath =
      fixtureKind === "jobs_route"
        ? "/"
        : fixtureKind === "one_navigation"
          ? "/careers"
          : fixtureKind === "broken_route"
            ? "/downloads/jobs"
            : fixtureKind === "login_redirect"
              ? "/careers/jobs"
              : "/jobs";
    const startingUrl = `https://jobs.example.com${startingPath}`;
    await page.goto(startingUrl);
    const client = createPrimaryClient(input.lane, input.environment);
    const config: AgentConfig = {
      source: "target_site",
      maxSteps: isSourceDebug ? 7 : 6,
      runControl: {
        timeBudgetMs: isSourceDebug ? 120_000 : 90_000,
        noProgressStepLimit: isSourceDebug ? 10 : 8,
      },
      targetJobCount,
      userProfile: createSyntheticCandidateProfile(),
      searchPreferences: {
        targetRoles: ["Frontend Engineer", "Platform Engineer"],
        locations: ["Remote"],
        workModes: ["remote"],
      },
      startingUrls: [startingUrl],
      navigationPolicy: { allowedHostnames: ["jobs.example.com"] },
      promptContext: isSourceDebug
        ? {
            siteLabel: "Example Careers",
            taskPacket: {
              phase: "search_filter_probe",
              phaseGoal:
                "Map a replayable anonymous search path and report only observed controls and routes.",
              knownFacts: ["The fixture is public and synthetic."],
              priorPhaseSummary: null,
              avoidStrategyFingerprints: [],
              successCriteria: [
                "Observe the public jobs route.",
                "Record whether search controls and job detail links are usable.",
              ],
              stopConditions: [
                "Stop after enough evidence exists for truthful replay guidance.",
              ],
              manualPrerequisiteState: null,
              strategyLabel: "Synthetic source check",
            },
          }
        : { siteLabel: "Example Careers" },
    };
    const runWorker = () =>
      withQuietAgentConsole(() =>
        runJobSearchAgent({
          hands: createApplyPageHands(createPlaywrightApplyPageMechanics(page)),
          page,
          config,
          llmClient: client,
          jobExtractor: client,
        }),
      );
    if (isSourceDebug) {
      const captured = await withCapturedModelFetch({
        endpointPrefix: input.environment.baseUrl,
        run: async () => {
          const workerResult = await runWorker();
          return finalizeSyntheticSourceInstruction({
            client,
            workerResult,
            runId: input.runId,
            startingUrl,
          });
        },
      });
      const workerResult = captured.result.worker;
      const sourceDebugIncomplete =
        !workerResult.phaseEvidence ||
        !workerResult.debugFindings ||
        !workerResult.phaseCompletionMode;
      const workflowError =
        workerResult.error ??
        (sourceDebugIncomplete
          ? "Source debug ended without the required phase evidence and findings."
          : null);
      const finalReviewFallback = captured.result.reviewOverride === null;
      return EvalAttemptSchema.parse({
        runId: input.runId,
        caseId: input.evalCase.id,
        laneId: input.lane.id,
        startedAt,
        durationMs: Math.max(0, performance.now() - startedAtMs),
        status:
          workflowError !== null
            ? "failed"
            : finalReviewFallback
              ? "fallback_succeeded"
              : "succeeded",
        providerCallCount: captured.captures.length,
        fallbackDetected: finalReviewFallback,
        guardedRejectionDetected: finalReviewFallback,
        rawHttp: captured.captures,
        modelOutput: serializeCapturedModelOutputs(captured.captures),
        productOutput: serializeProductOutput(captured.result),
        error: workflowError,
      });
    }
    const captured = await withCapturedModelFetch({
      endpointPrefix: input.environment.baseUrl,
      run: runWorker,
    });
    const discoveryIncomplete =
      captured.result.incomplete === true ||
      captured.result.jobs.length < targetJobCount;
    const workflowError =
      captured.result.error ??
      (discoveryIncomplete
        ? `Discovery ended before reaching ${targetJobCount} distinct jobs.`
        : null);
    const workflowFailed = workflowError !== null;
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: workflowFailed ? "failed" : "succeeded",
      providerCallCount: captured.captures.length,
      fallbackDetected: false,
      guardedRejectionDetected: false,
      rawHttp: captured.captures,
      modelOutput: serializeCapturedModelOutputs(captured.captures),
      productOutput: serializeProductOutput(captured.result),
      error: workflowError,
    });
  } catch (error) {
    const captures =
      error instanceof CapturedModelRunError ? error.captures : [];
    const rootError =
      error instanceof CapturedModelRunError ? error.cause : error;
    return EvalAttemptSchema.parse({
      runId: input.runId,
      caseId: input.evalCase.id,
      laneId: input.lane.id,
      startedAt,
      durationMs: Math.max(0, performance.now() - startedAtMs),
      status: "failed",
      providerCallCount: captures.length,
      fallbackDetected: false,
      guardedRejectionDetected: false,
      rawHttp: captures,
      modelOutput: serializeCapturedModelOutputs(captures),
      productOutput: null,
      error: rootError instanceof Error ? rootError.message : String(rootError),
    });
  } finally {
    await browser.close();
  }
}

export function runSystemCase(input: {
  readonly runId: string;
  readonly lane: EvalLane;
  readonly evalCase: EvalCase;
  readonly environment: SystemLaneEnvironment;
}): Promise<EvalAttempt> {
  switch (input.evalCase.capability) {
    case "agentic_job_discovery":
    case "source_debug":
      return runBrowserAgentSystemCase(input);
    case "resume_vision":
      return runResumeVisionSystemCase(input);
    case "browser_visual_analysis":
      return runBrowserVisualSystemCase(input);
    case "interview_cue":
      return runInterviewCueSystemCase(input);
    case "interview_screenshot_vision":
      return runInterviewScreenshotVisionSystemCase(input);
    case "resume_text_import":
      return runResumeTextImportSystemCase(input);
    case "resume_generation":
      return runResumeGenerationSystemCase(input);
    case "guided_resume_edits":
      return runGuidedResumeEditSystemCase(input);
    case "profile_copilot":
      return runProfileCopilotSystemCase(input);
    case "job_page_extraction":
      return runJobPageExtractionSystemCase(input);
    default:
      throw new Error("System runner received an unsupported capability.");
  }
}
