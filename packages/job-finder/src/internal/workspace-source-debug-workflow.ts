import { jobSiteTarget } from "@nestor/contracts";
import {
  SharedAgentCompactionPolicySchema,
  SourceDebugCompactionStateSchema,
  SourceDebugEvidenceRefSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  SourceInstructionArtifactSchema,
  SourceInstructionVerificationSchema,
  type AgentDebugFindings,
  type BrowserVisualEvidenceSummary,
  type JobDiscoveryTarget,
  type SourceDebugProgressEvent,
  type SourceDebugPhase,
  type SourceDebugVisualFinding,
  type SourceInstructionArtifact,
  type SourceDebugWorkerAttempt,
} from "@nestor/contracts";
import { runSequentialArtifactOrchestrator } from "../orchestrator";
import {
  filterSourceDebugWarnings,
  formatStatusLabel,
  isInternalSourceDebugFailure,
  prefixedLines,
  reviewSourceInstructionArtifactWithAi,
  type SourceInstructionFinalReviewPhaseContext,
} from "./source-instructions";
import { uniqueStrings } from "./shared";
import {
  buildSourceInstructionVersionInfo,
  resolveActiveSourceInstructionArtifact,
  resolveAdapterKind,
} from "./workspace-helpers";
import { DEFAULT_ROLE, discoveryAdapters } from "./workspace-defaults";
import {
  buildSourceDebugPhasePacket,
  buildSourceDebugPhaseSummary,
  classifySourceDebugAttemptOutcome,
  composeSourceDebugInstructions,
  deriveSourceDebugStartingUrls,
  getSourceDebugTargetJobCount,
  resolveSourceDebugCompletion,
  resolveSourceDebugPhases,
  shouldFinishSourceDebugEarly,
  synthesizeSourceInstructionArtifact,
} from "./workspace-service-helpers";
import type { ProfileContext } from "./profile-context";
import {
  buildSourceDebugProgressEmitter,
  describeSourceDebugOpenFailure,
  summarizeAgentProgressForSourceDebug,
} from "./source-debug-progress";
import {
  buildSourceDebugRunTimingSummary,
  buildSourceDebugTimingSummary,
} from "./source-debug-timing";
import { runPublicProviderSourceCheck } from "./workspace-public-provider-source-check";
import { inferSourceIntelligenceFromTarget } from "./workspace-source-intelligence";

const MAX_PROGRESS_EVENTS = 1000;

function buildSourceDebugVisualEvidenceSummary(
  finding: SourceDebugVisualFinding,
): BrowserVisualEvidenceSummary {
  return {
    snapshotId: finding.snapshotId,
    observationSetId: finding.observationSetId,
    summary: finding.summary,
    capturedAt: finding.capturedAt,
    storagePath: finding.storagePath,
    retention: finding.retention,
    redactionLevel: finding.redactionLevel,
    confidence: finding.confidence,
    reconciliationStatus: finding.reconciliationStatus,
  };
}

function buildSourceDebugVisualArtifacts(input: {
  attemptId: string;
  debugFindings: AgentDebugFindings | null;
  phase: SourceDebugPhase;
  phaseVisualFindings: readonly SourceDebugVisualFinding[];
  runId: string;
  targetId: string;
}) {
  const observationSetsById = new Map(
    (input.debugFindings?.visualObservationSets ?? []).map((observationSet) => [
      observationSet.id,
      observationSet,
    ]),
  );
  const evidenceByKey = new Map<string, BrowserVisualEvidenceSummary>();

  for (const finding of input.debugFindings?.visualFindings ?? []) {
    const key = `${finding.snapshotId}:${finding.observationSetId}`;
    evidenceByKey.set(key, finding);
  }

  for (const finding of input.phaseVisualFindings) {
    const key = `${finding.snapshotId}:${finding.observationSetId}`;
    if (!evidenceByKey.has(key)) {
      evidenceByKey.set(key, buildSourceDebugVisualEvidenceSummary(finding));
    }
  }

  const visualEvidence = [...evidenceByKey.values()];
  const evidenceRefs = visualEvidence.flatMap((evidence, index) => {
    if (!evidence.storagePath) {
      return [];
    }

    const observationSet =
      observationSetsById.get(evidence.observationSetId) ?? null;

    return [
      SourceDebugEvidenceRefSchema.parse({
        id: `${input.attemptId}_visual_${index + 1}`,
        runId: input.runId,
        attemptId: input.attemptId,
        targetId: input.targetId,
        phase: input.phase,
        kind: "screenshot",
        label: "Visual source-debug evidence",
        capturedAt: evidence.capturedAt,
        url: observationSet?.url ?? null,
        storagePath: evidence.storagePath,
        excerpt: evidence.summary,
        visualSnapshotId: evidence.snapshotId,
        visualObservationSetId: evidence.observationSetId,
        visualMode: null,
        visualRetention: {
          retention: evidence.retention,
          redactionLevel: evidence.redactionLevel,
          reason:
            "Source-debug visual evidence explains a phase outcome or blocker.",
        },
        visualObservations: observationSet,
      }),
    ];
  });

  return {
    evidenceRefs,
    visualEvidence,
  };
}

function buildSourceDebugCompactionPolicy(
  modelContextWindowTokens: number | null,
) {
  const baseline = modelContextWindowTokens ?? 196_000;
  const minimumResponseHeadroomTokens = Math.max(
    2_048,
    Math.floor(baseline * 0.06),
  );
  const maxTargetBudget = Math.max(1, baseline - minimumResponseHeadroomTokens);
  const targetTokenBudget = Math.min(
    Math.floor(baseline * 0.94),
    maxTargetBudget,
  );
  const warningTokenBudget = Math.min(
    Math.floor(baseline * 0.9),
    targetTokenBudget,
  );

  return SharedAgentCompactionPolicySchema.parse({
    warningTokenBudget,
    targetTokenBudget,
    minimumResponseHeadroomTokens,
    preserveRecentMessages: 6,
    minimumPreserveRecentMessages: 3,
    maxToolPayloadChars: 180,
    messageCountFallbackThreshold: 16,
  });
}

export async function runSourceDebugWorkflow(
  ctx: ProfileContext,
  targetId: string,
  signal?: AbortSignal,
  options?: {
    clearExistingInstructions?: boolean;
    reviewInstructionId?: string | null;
  },
  onProgress?: (event: SourceDebugProgressEvent) => void,
) {
  if (ctx.activeSourceDebugAbortControllerRef.current) {
    throw new Error(
      "A source-debug run is already in progress. Cancel it before starting another run.",
    );
  }

  const executionController = new AbortController();
  ctx.activeSourceDebugAbortControllerRef.current = executionController;
  const onExternalAbort = () => executionController.abort();
  if (signal?.aborted) {
    executionController.abort();
  } else {
    signal?.addEventListener("abort", onExternalAbort);
  }
  const executionSignal = executionController.signal;
  const clearActiveController = () => {
    signal?.removeEventListener("abort", onExternalAbort);
    if (
      ctx.activeSourceDebugAbortControllerRef.current === executionController
    ) {
      ctx.activeSourceDebugAbortControllerRef.current = null;
    }
  };

  const modelContextWindowTokensSnapshot =
    ctx.aiClient.getStatus().modelContextWindowTokens;
  const [profile, searchPreferences] = await Promise.all([
    ctx.repository.getProfile(),
    ctx.repository.getSearchPreferences(),
  ]).catch((error: unknown) => {
    clearActiveController();
    throw error;
  });
  const site = ctx.jobSites?.get(Number(targetId));
  const target = site ? jobSiteTarget(site) : null;
  const sourceDebugCompactionPolicy = buildSourceDebugCompactionPolicy(
    modelContextWindowTokensSnapshot,
  );

  if (!target) {
    clearActiveController();
    throw new Error(`Unknown discovery target '${targetId}'.`);
  }

  const targetUrl = (() => {
    try {
      return new URL(target.startingUrl);
    } catch {
      return null;
    }
  })();

  if (!targetUrl) {
    clearActiveController();
    throw new Error(
      `Target '${target.label}' does not have a valid starting URL.`,
    );
  }

  const clearExistingInstructions =
    options?.clearExistingInstructions !== false;
  const instructionArtifacts = await ctx.repository
    .listSourceInstructionArtifacts()
    .catch((error: unknown) => {
      clearActiveController();
      throw error;
    });
  const preservedRouteHintArtifact = resolveActiveSourceInstructionArtifact(
    target,
    instructionArtifacts,
  );
  const normalizedTarget: JobDiscoveryTarget = clearExistingInstructions
    ? {
        ...target,
        instructionStatus: "missing",
        validatedInstructionId: null,
        draftInstructionId: null,
        lastVerifiedAt: null,
        staleReason: null,
      }
    : target;
  const reviewInstructionArtifact = options?.reviewInstructionId
    ? (instructionArtifacts.find(
        (artifact) =>
          artifact.id === options.reviewInstructionId &&
          artifact.targetId === normalizedTarget.id,
      ) ?? null)
    : null;

  if (options?.reviewInstructionId && !reviewInstructionArtifact) {
    clearActiveController();
    throw new Error(
      `Source instruction '${options.reviewInstructionId}' does not belong to target '${normalizedTarget.id}'.`,
    );
  }

  if (clearExistingInstructions) {
    await ctx.repository
      .deleteSourceInstructionArtifactsForTarget(target.id)
      .catch((error: unknown) => {
        clearActiveController();
        throw error;
      });
    await ctx
      .saveJobSiteMetadata(target.id, (currentTarget) => ({
        ...currentTarget,
        instructionStatus: "missing",
        validatedInstructionId: null,
        draftInstructionId: null,
        lastVerifiedAt: null,
        staleReason: null,
      }))
      .catch((error: unknown) => {
        clearActiveController();
        throw error;
      });
  }

  const adapterKind = resolveAdapterKind(normalizedTarget);
  const adapter = discoveryAdapters[adapterKind];
  const sourceDebugPhases = resolveSourceDebugPhases({
    target: normalizedTarget,
    instructionArtifact:
      reviewInstructionArtifact ?? preservedRouteHintArtifact,
  });
  const runId = `source_debug_${normalizedTarget.id}_${Date.now()}`;
  const progressEvents: SourceDebugProgressEvent[] = [];
  const emitProgress = buildSourceDebugProgressEmitter({
    runId,
    targetId: normalizedTarget.id,
    onProgress: (event) => {
      if (progressEvents.length >= MAX_PROGRESS_EVENTS) {
        progressEvents.shift();
      }
      progressEvents.push(event);
      onProgress?.(event);
    },
  });

  let run = SourceDebugRunRecordSchema.parse({
    id: runId,
    targetId: normalizedTarget.id,
    state: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    activePhase: sourceDebugPhases[0] ?? null,
    phases: sourceDebugPhases,
    targetLabel: normalizedTarget.label,
    targetUrl: normalizedTarget.startingUrl,
    targetHostname: targetUrl.hostname,
    manualPrerequisiteSummary: null,
    finalSummary: null,
    attemptIds: [],
    phaseSummaries: [],
    instructionArtifactId:
      reviewInstructionArtifact?.id ??
      normalizedTarget.draftInstructionId ??
      normalizedTarget.validatedInstructionId ??
      null,
  });

  ctx.activeSourceDebugExecutionIdRef.current = runId;
  await ctx.persistSourceDebugRun(run).catch((error: unknown) => {
    clearActiveController();
    ctx.activeSourceDebugExecutionIdRef.current = null;
    throw error;
  });
  await ctx
    .saveJobSiteMetadata(normalizedTarget.id, (currentTarget) => ({
      ...currentTarget,
      lastDebugRunId: run.id,
    }))
    .catch((error: unknown) => {
      clearActiveController();
      ctx.activeSourceDebugExecutionIdRef.current = null;
      throw error;
    });

  const attempts: SourceDebugWorkerAttempt[] = [];
  const internalRuntimeFailureAttemptIds = new Set<string>();
  const strategyFingerprints: string[] = [];
  const finalReviewContextsByAttemptId = new Map<
    string,
    SourceInstructionFinalReviewPhaseContext
  >();
  let synthesizedInstruction: SourceInstructionArtifact | null =
    reviewInstructionArtifact ??
    resolveActiveSourceInstructionArtifact(
      normalizedTarget,
      instructionArtifacts,
    );
  let browserSessionOpened = false;
  let browserSetupMs: number | null = null;
  let finalReviewMs: number | null = null;
  let finalizationMs: number | null = null;
  let shouldKeepBrowserSessionOpen = false;
  let finishedEarlyAfterUsefulDraft = false;

  try {
    const inferredSourceIntelligence = inferSourceIntelligenceFromTarget({
      target: normalizedTarget,
      currentArtifact: null,
    });

    if (inferredSourceIntelligence.provider?.apiAvailability === "available") {
      run = SourceDebugRunRecordSchema.parse({
        ...run,
        phases: ["replay_verification"],
        activePhase: "replay_verification",
        updatedAt: new Date().toISOString(),
      });
      await ctx.persistSourceDebugRun(run);
      emitProgress({
        phase: "replay_verification",
        waitReason: "extracting_jobs",
        message: `Checking the public ${inferredSourceIntelligence.provider.label} provider API for reusable source capabilities.`,
        currentUrl: normalizedTarget.startingUrl,
      });
      const publicProviderCheck = await runPublicProviderSourceCheck({
        target: normalizedTarget,
        source: adapterKind,
        runId: run.id,
        versionInfo: buildSourceInstructionVersionInfo(adapterKind),
        signal: executionSignal,
      });

      if (publicProviderCheck) {
        const attempt = SourceDebugWorkerAttemptSchema.parse({
          ...publicProviderCheck.attempt,
          timing: buildSourceDebugTimingSummary(
            progressEvents.filter(
              (event) => event.phase === "replay_verification",
            ),
            publicProviderCheck.attempt.startedAt,
            publicProviderCheck.attempt.completedAt ??
              publicProviderCheck.attempt.startedAt,
          ),
        });
        const phaseSummary = buildSourceDebugPhaseSummary(attempt);
        const instruction = SourceInstructionArtifactSchema.parse({
          ...publicProviderCheck.artifact,
          basedOnAttemptIds: [attempt.id],
        });
        const finalizationStartedAtMs = Date.now();

        emitProgress({
          phase: "replay_verification",
          waitReason: "finalizing",
          message: `Saving verified ${inferredSourceIntelligence.provider.label} provider capabilities.`,
          currentUrl: normalizedTarget.startingUrl,
          jobsFound: publicProviderCheck.jobCount,
        });
        await ctx.repository.upsertSourceDebugEvidenceRefs(
          publicProviderCheck.evidenceRefs,
        );
        await ctx.repository.upsertSourceDebugAttempt(attempt);
        await ctx.repository.upsertSourceInstructionArtifact(instruction);
        await ctx.saveJobSiteMetadata(normalizedTarget.id, (currentTarget) => ({
          ...currentTarget,
          instructionStatus:
            instruction.status === "validated"
              ? "validated"
              : currentTarget.validatedInstructionId
                ? "validated"
                : instruction.status,
          draftInstructionId:
            instruction.status === "validated" ? null : instruction.id,
          validatedInstructionId:
            instruction.status === "validated"
              ? instruction.id
              : currentTarget.validatedInstructionId,
          lastDebugRunId: run.id,
          lastVerifiedAt: instruction.verification?.verifiedAt ?? null,
          staleReason: null,
        }));
        finalizationMs = Date.now() - finalizationStartedAtMs;
        const completedAt = new Date().toISOString();
        run = SourceDebugRunRecordSchema.parse({
          ...run,
          state: "completed",
          updatedAt: completedAt,
          completedAt,
          activePhase: null,
          finalSummary: publicProviderCheck.proofSummary,
          attemptIds: [attempt.id],
          phaseSummaries: [phaseSummary],
          instructionArtifactId: instruction.id,
          timing: buildSourceDebugRunTimingSummary({
            events: progressEvents,
            run,
            completedAt,
            browserSetupMs: null,
            finalReviewMs: null,
            finalizationMs,
          }),
        });
        await ctx.persistSourceDebugRun(run);
        return run;
      }

      run = SourceDebugRunRecordSchema.parse({
        ...run,
        phases: sourceDebugPhases,
        activePhase: sourceDebugPhases[0] ?? null,
        updatedAt: new Date().toISOString(),
      });
      await ctx.persistSourceDebugRun(run);
    }

    const browserSetupStartedAtMs = Date.now();
    emitProgress({
      waitReason: "starting_browser",
      message: `Starting or attaching the browser profile for ${normalizedTarget.label}.`,
      currentUrl: normalizedTarget.startingUrl,
    });
    await ctx.openRunBrowserSession(adapterKind, {
      purpose: "automation",
      targetUrl: normalizedTarget.startingUrl,
      targetId: normalizedTarget.id,
    });
    browserSessionOpened = true;
    browserSetupMs = Date.now() - browserSetupStartedAtMs;
    emitProgress({
      waitReason: "attaching_browser",
      message: `Browser ready for ${normalizedTarget.label}. Preparing the first debug phase.`,
      currentUrl: normalizedTarget.startingUrl,
    });
    await runSequentialArtifactOrchestrator<
      SourceDebugPhase,
      SourceDebugWorkerAttempt
    >({
      phases: sourceDebugPhases,
      beforePhase: async (phase) => {
        if (executionSignal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        run = SourceDebugRunRecordSchema.parse({
          ...run,
          activePhase: phase,
          updatedAt: new Date().toISOString(),
        });
        await ctx.persistSourceDebugRun(run);
        emitProgress({
          phase,
          waitReason: "waiting_on_ai",
          message: `${formatStatusLabel(phase)} started. Waiting on AI to choose the next browser action.`,
          currentUrl: normalizedTarget.startingUrl,
        });
      },
      executePhase: async (phase, index) => {
        const phasePacket = buildSourceDebugPhasePacket(
          phase,
          run.phaseSummaries,
          strategyFingerprints,
          run.manualPrerequisiteSummary,
        );
        const strategyFingerprint = `${phase}:${adapterKind}:${phasePacket.strategyLabel?.toLowerCase() ?? "default"}`;
        strategyFingerprints.push(strategyFingerprint);
        const phaseInstructionArtifact =
          phase === "replay_verification"
            ? (reviewInstructionArtifact ?? synthesizedInstruction)
            : null;
        const phaseStartingUrlArtifact =
          reviewInstructionArtifact ?? synthesizedInstruction;
        const nextPhase = sourceDebugPhases[index + 1] ?? null;
        const currentRouteHintStartingUrls = deriveSourceDebugStartingUrls(
          normalizedTarget,
          phaseStartingUrlArtifact,
          phase,
        );
        const currentRunHasDistinctRouteHint =
          currentRouteHintStartingUrls.some(
            (url) => url !== normalizedTarget.startingUrl,
          );
        const preservedRouteHintStartingUrls =
          clearExistingInstructions && !currentRunHasDistinctRouteHint
            ? deriveSourceDebugStartingUrls(
                normalizedTarget,
                preservedRouteHintArtifact,
                phase,
              )
            : [];
        const phaseStartingUrls = uniqueStrings(
          currentRunHasDistinctRouteHint
            ? [
                ...currentRouteHintStartingUrls,
                ...preservedRouteHintStartingUrls,
              ]
            : [
                ...preservedRouteHintStartingUrls,
                ...currentRouteHintStartingUrls,
              ],
        ).filter(Boolean);
        let lastProgressUrl: string | null = null;
        const phasePrimaryStartingUrl =
          phaseStartingUrls[0] ?? normalizedTarget.startingUrl;
        // No per-phase step quota. The agent is told the goal and decides
        // when it is done; a stall (nothing new after repeated tries, even
        // after being asked to change approach) or the agent saying it is
        // stuck ends the phase. The step and time figures below are safety
        // ceilings far above what any honest phase needs, not budgets.
        const phaseMaxSteps = SOURCE_DEBUG_PHASE_STEP_CEILING;
        const debugResult = await ctx.browserRuntime.runAgentDiscovery?.(
          adapterKind,
          {
            userProfile: profile,
            searchPreferences: {
              targetRoles:
                searchPreferences.targetRoles.length > 0
                  ? searchPreferences.targetRoles
                  : [DEFAULT_ROLE],
              locations: searchPreferences.locations,
            },
            targetJobCount: getSourceDebugTargetJobCount(phase),
            maxSteps: phaseMaxSteps,
            runControl: {
              timeBudgetMs: SOURCE_DEBUG_PHASE_TIME_CEILING_MS,
              noProgressStepLimit: SOURCE_DEBUG_STALL_STEP_WINDOW,
            },
            startingUrls: phaseStartingUrls,
            siteLabel: `${normalizedTarget.label} ${formatStatusLabel(phase)}`,
            navigationHostnames: [targetUrl.hostname],
            siteInstructions: composeSourceDebugInstructions(
              normalizedTarget,
              adapter,
              phase,
              phaseInstructionArtifact,
              phasePacket,
            ),
            toolUsageNotes: uniqueStrings([
              ...adapter.toolUsageNotes,
              "Prefer concise, high-confidence evidence over broad exploration.",
              "Stop when the phase goal has been proven or blocked.",
            ]),
            taskPacket: phasePacket,
            relevantUrlSubstrings: adapter.relevantUrlSubstrings,
            skipSessionValidation: true,
            aiClient: ctx.aiClient,
            signal: executionSignal,
            onProgress: (progress) => {
              const summary = summarizeAgentProgressForSourceDebug(
                progress,
                phase,
              );
              if (progress.currentUrl) lastProgressUrl = progress.currentUrl;
              emitProgress({
                phase,
                waitReason: summary.waitReason,
                message: summary.message,
                currentUrl: progress.currentUrl,
                stepCount: progress.stepCount,
                jobsFound: progress.jobsFound,
              });
            },
          },
        );
        if (!debugResult) {
          throw new Error(
            "Browser runtime does not support agent discovery for source debugging.",
          );
        }
        const internalRuntimeFailure = isInternalSourceDebugFailure(
          debugResult.warning,
        );

        const outcome = classifySourceDebugAttemptOutcome(debugResult, phase);
        const completion = resolveSourceDebugCompletion(debugResult);
        const attemptId = `source_debug_attempt_${phase}_${Date.now()}`;
        if (internalRuntimeFailure) {
          internalRuntimeFailureAttemptIds.add(attemptId);
        }
        const debugFindings = debugResult.agentMetadata?.debugFindings ?? null;
        const visualArtifacts = buildSourceDebugVisualArtifacts({
          attemptId,
          debugFindings,
          phase,
          phaseVisualFindings: completion.phaseEvidence?.visualFindings ?? [],
          runId: run.id,
          targetId: normalizedTarget.id,
        });
        emitProgress({
          phase,
          waitReason: "persisting_results",
          message: `Saving the findings from ${formatStatusLabel(phase)}.`,
          currentUrl:
            debugResult.jobs[0]?.canonicalUrl ?? normalizedTarget.startingUrl,
          stepCount: debugResult.agentMetadata?.steps ?? 0,
          jobsFound: debugResult.jobs.length,
        });
        const evidenceRefs = [
          SourceDebugEvidenceRefSchema.parse({
            id: `${attemptId}_start`,
            runId: run.id,
            attemptId,
            targetId: normalizedTarget.id,
            phase,
            kind: "url",
            label: "Starting URL",
            capturedAt: new Date().toISOString(),
            url: phasePrimaryStartingUrl,
            storagePath: null,
            excerpt: debugResult.warning ?? null,
          }),
          ...debugResult.jobs.slice(0, 3).map((job, evidenceIndex) =>
            SourceDebugEvidenceRefSchema.parse({
              id: `${attemptId}_job_${evidenceIndex + 1}`,
              runId: run.id,
              attemptId,
              targetId: normalizedTarget.id,
              phase,
              kind: "url",
              label: `${job.title} at ${job.company}`,
              capturedAt: new Date().toISOString(),
              url: job.canonicalUrl,
              storagePath: null,
              excerpt: job.summary ?? job.description ?? null,
            }),
          ),
          ...visualArtifacts.evidenceRefs,
        ];

        await ctx.repository.upsertSourceDebugEvidenceRefs(evidenceRefs);

        const applyReadyCount = debugResult.jobs.filter(
          (job) => job.applyPath !== "unknown" || job.easyApplyEligible,
        ).length;
        const confirmedFacts = uniqueStrings([
          ...(debugFindings?.summary ? [debugFindings.summary] : []),
          ...prefixedLines(
            "Reliable control: ",
            debugFindings?.reliableControls ?? [],
          ),
          ...prefixedLines("Filter note: ", debugFindings?.trickyFilters ?? []),
          ...prefixedLines(
            "Navigation note: ",
            debugFindings?.navigationTips ?? [],
          ),
          ...prefixedLines("Apply note: ", debugFindings?.applyTips ?? []),
          ...prefixedLines(
            "Visual evidence: ",
            visualArtifacts.visualEvidence.map((evidence) => evidence.summary),
          ),
          ...filterSourceDebugWarnings(debugFindings?.warnings ?? []),
          ...filterSourceDebugWarnings([debugResult.warning]),
        ]);
        const phaseTiming = buildSourceDebugTimingSummary(
          progressEvents.filter((event) => event.phase === phase),
          debugResult.startedAt,
          debugResult.completedAt,
        );

        const artifact = SourceDebugWorkerAttemptSchema.parse({
          id: attemptId,
          runId: run.id,
          targetId: normalizedTarget.id,
          phase,
          startedAt: debugResult.startedAt,
          completedAt: debugResult.completedAt,
          outcome,
          completionMode: completion.completionMode,
          completionReason: completion.completionReason,
          strategyLabel: phasePacket.strategyLabel ?? formatStatusLabel(phase),
          strategyFingerprint,
          confirmedFacts,
          attemptedActions: uniqueStrings([
            `Started from ${phasePrimaryStartingUrl}.`,
            ...(phase === "apply_path_validation"
              ? [
                  "Inspected discovered jobs for apply entry points without submitting an application.",
                ]
              : []),
            ...(completion.phaseEvidence?.attemptedControls ?? []),
            ...prefixedLines(
              "Validated behavior: ",
              debugFindings?.reliableControls ?? [],
            ),
            ...prefixedLines(
              "Validated navigation: ",
              debugFindings?.navigationTips ?? [],
            ),
          ]),
          blockerSummary: isInternalSourceDebugFailure(debugResult.warning)
            ? null
            : (debugResult.warning ??
              (completion.completionMode ===
                "timed_out_with_partial_evidence" ||
              completion.completionMode === "timed_out_without_evidence" ||
              completion.completionMode === "stalled"
                ? describeSourceCheckStop({
                    mode: completion.completionMode,
                    phase,
                    startingUrl: phasePrimaryStartingUrl,
                    lastUrl: lastProgressUrl,
                    jobsFound: debugResult.jobs.length,
                    agentReason: completion.completionReason,
                  })
                : completion.completionMode !== "structured_finish" &&
                    completion.completionMode !== "forced_finish"
                  ? completion.completionReason
                  : null)),
          resultSummary: debugFindings?.summary
            ? debugFindings.summary
            : phase === "replay_verification"
              ? debugResult.jobs.length > 0
                ? `Replay verification reached ${debugResult.jobs.length} job result${debugResult.jobs.length === 1 ? "" : "s"} again.`
                : isInternalSourceDebugFailure(debugResult.warning)
                  ? "Replay verification did not complete because the agent runtime failed."
                  : (debugResult.warning ??
                    "Replay verification did not reproduce the expected path.")
              : phase === "apply_path_validation"
                ? applyReadyCount > 0
                  ? `Apply path validation confirmed reusable apply guidance on ${applyReadyCount} job${applyReadyCount === 1 ? "" : "s"} without submitting.`
                  : isInternalSourceDebugFailure(debugResult.warning)
                    ? "Apply path validation did not complete because the agent runtime failed."
                    : (debugResult.warning ??
                      "Apply path validation did not confirm a reusable apply path.")
                : debugResult.jobs.length > 0
                  ? `${formatStatusLabel(phase)} found ${debugResult.jobs.length} credible job result${debugResult.jobs.length === 1 ? "" : "s"}.`
                  : isInternalSourceDebugFailure(debugResult.warning)
                    ? `${formatStatusLabel(phase)} did not complete because the agent runtime failed.`
                    : (debugResult.warning ??
                      `${formatStatusLabel(phase)} produced no reusable evidence.`),
          confidenceScore:
            phase === "apply_path_validation"
              ? applyReadyCount > 0
                ? 76
                : 42
              : debugResult.jobs.length > 0
                ? 80
                : 45,
          nextRecommendedStrategies:
            phase === "replay_verification"
              ? []
              : nextPhase
                ? [formatStatusLabel(nextPhase)]
                : [],
          avoidStrategyFingerprints: [strategyFingerprint],
          evidenceRefIds: evidenceRefs.map((evidenceRef) => evidenceRef.id),
          phaseEvidence: completion.phaseEvidence,
          visualEvidence: visualArtifacts.visualEvidence,
          compactionState: (() => {
            const parsedCompactionState = debugResult.agentMetadata
              ?.compactionState
              ? SourceDebugCompactionStateSchema.safeParse(
                  debugResult.agentMetadata.compactionState,
                )
              : null;

            if (parsedCompactionState && !parsedCompactionState.success) {
              console.warn(
                "[Source Debug] Ignoring invalid compaction state from browser runtime.",
                parsedCompactionState.error,
              );
            }

            return parsedCompactionState?.success
              ? parsedCompactionState.data
              : null;
          })(),
          timing: phaseTiming,
        });
        const visualResultSummary = artifact.visualEvidence[0]?.summary;
        const attemptResultSummary =
          !debugFindings?.summary &&
          visualResultSummary &&
          artifact.resultSummary.includes("produced no reusable evidence")
            ? `Visual evidence noted: ${visualResultSummary}`
            : artifact.resultSummary;
        const finalizedAttempt = SourceDebugWorkerAttemptSchema.parse({
          ...artifact,
          resultSummary: attemptResultSummary,
        });

        finalReviewContextsByAttemptId.set(finalizedAttempt.id, {
          phase,
          phaseGoal: phasePacket.phaseGoal,
          successCriteria: [...phasePacket.successCriteria],
          stopConditions: [...phasePacket.stopConditions],
          knownFactsAtStart: [...phasePacket.knownFacts],
          startedAt: finalizedAttempt.startedAt,
          completedAt: finalizedAttempt.completedAt,
          outcome: finalizedAttempt.outcome,
          completionMode: finalizedAttempt.completionMode,
          completionReason: finalizedAttempt.completionReason,
          resultSummary: finalizedAttempt.resultSummary,
          blockerSummary: finalizedAttempt.blockerSummary,
          confirmedFacts: [...finalizedAttempt.confirmedFacts],
          attemptedActions: [...finalizedAttempt.attemptedActions],
          phaseEvidence: finalizedAttempt.phaseEvidence,
          visualEvidence: finalizedAttempt.visualEvidence,
          compactionState: finalizedAttempt.compactionState,
          reviewTranscript: [
            ...(debugResult.agentMetadata?.reviewTranscript ?? []),
          ],
        });

        // The replay is what turns guidance from draft into validated, and
        // it is short. It is never skipped for having "enough" evidence.
        const shouldStopEarly =
          phase !== "site_structure_mapping" &&
          shouldFinishSourceDebugEarly({
            attempts: [...attempts, finalizedAttempt],
            currentPhase: phase,
          });

        if (shouldStopEarly) {
          finishedEarlyAfterUsefulDraft = true;
        }

        return {
          artifact: finalizedAttempt,
          stop:
            outcome === "blocked_auth" ||
            outcome === "blocked_manual_step" ||
            shouldStopEarly,
        };
      },
      afterPhase: async (phase, _index, attempt) => {
        if (!attempt) {
          return;
        }

        await ctx.repository.upsertSourceDebugAttempt(attempt);
        attempts.push(attempt);
        const phaseSummary = buildSourceDebugPhaseSummary(attempt);

        if (
          attempt.outcome === "blocked_auth" ||
          attempt.outcome === "blocked_manual_step"
        ) {
          shouldKeepBrowserSessionOpen = true;
          emitProgress({
            phase,
            waitReason: "manual_prerequisite",
            message:
              attempt.blockerSummary ??
              `${formatStatusLabel(phase)} is paused until a manual browser step is completed.`,
            currentUrl: normalizedTarget.startingUrl,
          });
          const pausedAt = new Date().toISOString();
          run = SourceDebugRunRecordSchema.parse({
            ...run,
            state: "paused_manual",
            updatedAt: pausedAt,
            completedAt: pausedAt,
            manualPrerequisiteSummary: attempt.blockerSummary,
            finalSummary: attempt.resultSummary,
            attemptIds: [...run.attemptIds, attempt.id],
            phaseSummaries: [...run.phaseSummaries, phaseSummary],
            timing: buildSourceDebugRunTimingSummary({
              events: progressEvents,
              run,
              completedAt: pausedAt,
              browserSetupMs,
              finalReviewMs,
              finalizationMs,
            }),
          });
          await ctx.persistSourceDebugRun(run);
          await ctx.saveJobSiteMetadata(
            normalizedTarget.id,
            (currentTarget) => ({
              ...currentTarget,
              instructionStatus: currentTarget.validatedInstructionId
                ? currentTarget.instructionStatus
                : "missing",
              lastDebugRunId: run.id,
            }),
          );
          return;
        }

        run = SourceDebugRunRecordSchema.parse({
          ...run,
          updatedAt: new Date().toISOString(),
          attemptIds: [...run.attemptIds, attempt.id],
          phaseSummaries: [...run.phaseSummaries, phaseSummary],
        });

        if (
          phase !== "replay_verification" &&
          !internalRuntimeFailureAttemptIds.has(attempt.id)
        ) {
          const nextSynthesizedInstruction =
            synthesizeSourceInstructionArtifact(
              normalizedTarget,
              run,
              attempts,
              adapterKind,
              null,
              undefined,
              synthesizedInstruction ?? preservedRouteHintArtifact,
            );
          synthesizedInstruction = nextSynthesizedInstruction;

          if (!reviewInstructionArtifact) {
            run = SourceDebugRunRecordSchema.parse({
              ...run,
              instructionArtifactId: nextSynthesizedInstruction.id,
            });
            await ctx.repository.upsertSourceInstructionArtifact(
              nextSynthesizedInstruction,
            );
            await ctx.saveJobSiteMetadata(
              normalizedTarget.id,
              (currentTarget) => ({
                ...currentTarget,
                draftInstructionId: nextSynthesizedInstruction.id,
                instructionStatus: nextSynthesizedInstruction.status,
                lastDebugRunId: run.id,
              }),
            );
          }
        }

        await ctx.persistSourceDebugRun(run);
      },
    });

    if (run.state === "paused_manual") {
      return run;
    }

    const settings = await ctx.repository.getSettings();
    shouldKeepBrowserSessionOpen = settings.keepSessionAlive;

    const onlyInternalRuntimeFailures =
      attempts.length > 0 &&
      attempts.every((attempt) => attempt.outcome !== "succeeded") &&
      attempts.every((attempt) =>
        internalRuntimeFailureAttemptIds.has(attempt.id),
      );
    if (onlyInternalRuntimeFailures) {
      const completedAt = new Date().toISOString();
      run = SourceDebugRunRecordSchema.parse({
        ...run,
        state: "failed",
        updatedAt: completedAt,
        completedAt,
        activePhase: null,
        finalSummary:
          "Source check could not run because the agent service was unavailable. Existing saved guidance was left unchanged; retry this source when the service is available.",
        timing: buildSourceDebugRunTimingSummary({
          events: progressEvents,
          run,
          completedAt,
          browserSetupMs,
          finalReviewMs,
          finalizationMs,
        }),
      });
      await ctx.persistSourceDebugRun(run);
      await ctx.saveJobSiteMetadata(normalizedTarget.id, (currentTarget) => ({
        ...currentTarget,
        lastDebugRunId: run.id,
      }));
      return run;
    }

    const verification = SourceInstructionVerificationSchema.parse({
      id: `source_instruction_verification_${run.id}`,
      replayRunId: run.id,
      verifiedAt: new Date().toISOString(),
      outcome: attempts.some(
        (attempt) =>
          attempt.phase === "replay_verification" &&
          attempt.outcome === "succeeded",
      )
        ? "passed"
        : "failed",
      proofSummary:
        attempts.find((attempt) => attempt.phase === "replay_verification")
          ?.resultSummary ?? null,
      reason:
        attempts.find((attempt) => attempt.phase === "replay_verification")
          ?.blockerSummary ?? null,
      versionInfo: buildSourceInstructionVersionInfo(adapterKind),
    });

    const heuristicFinalizedInstruction = synthesizeSourceInstructionArtifact(
      normalizedTarget,
      run,
      attempts,
      adapterKind,
      verification,
      undefined,
      reviewInstructionArtifact ??
        synthesizedInstruction ??
        preservedRouteHintArtifact,
    );
    const shouldRunAiFinalReview =
      !finishedEarlyAfterUsefulDraft &&
      (verification.outcome === "passed" || Boolean(reviewInstructionArtifact));
    const successfulAttemptCount = attempts.filter(
      (attempt) => attempt.outcome === "succeeded",
    ).length;
    const reviewOverride = shouldRunAiFinalReview
      ? await (async () => {
          emitProgress({
            waitReason: "waiting_on_ai",
            message:
              "Reviewing the collected evidence and organizing the final source instructions.",
            currentUrl: normalizedTarget.startingUrl,
            jobsFound: successfulAttemptCount,
          });
          const finalReviewStartedAtMs = Date.now();
          const review = () =>
            reviewSourceInstructionArtifactWithAi({
              aiClient: ctx.aiClient,
              target: normalizedTarget,
              run,
              adapterKind,
              verification,
              instructionUnderReview: reviewInstructionArtifact,
              heuristicInstruction: heuristicFinalizedInstruction,
              phaseContexts: attempts.flatMap((attempt) => {
                const context = finalReviewContextsByAttemptId.get(attempt.id);
                return context ? [context] : [];
              }),
              compactionPolicy: sourceDebugCompactionPolicy,
              modelContextWindowTokens: modelContextWindowTokensSnapshot,
              signal: executionSignal,
            });
          try {
            // A review that fails for a passing reason is asked once more
            // before the check's notes are kept as an unorganized draft.
            return (
              (await review()) ??
              (executionSignal.aborted ? null : await review())
            );
          } finally {
            finalReviewMs = Date.now() - finalReviewStartedAtMs;
          }
        })()
      : null;
    const finalizedInstruction = reviewOverride
      ? synthesizeSourceInstructionArtifact(
          normalizedTarget,
          run,
          attempts,
          adapterKind,
          verification,
          reviewOverride,
          reviewInstructionArtifact ??
            synthesizedInstruction ??
            preservedRouteHintArtifact,
        )
      : SourceInstructionArtifactSchema.parse({
          ...heuristicFinalizedInstruction,
          warnings: uniqueStrings([
            ...heuristicFinalizedInstruction.warnings,
            "The AI could not organize what this check learned, so these are the check's own notes. Check the source again to complete them.",
          ]),
        });
    const preserveExistingValidatedInstruction =
      reviewInstructionArtifact?.status === "validated" &&
      verification.outcome !== "passed";
    const shouldCreateSuccessorArtifact = Boolean(reviewInstructionArtifact);
    const instructionToPersist = shouldCreateSuccessorArtifact
      ? SourceInstructionArtifactSchema.parse({
          ...finalizedInstruction,
          id: `source_instruction_${normalizedTarget.id}_${Date.now()}`,
          status: preserveExistingValidatedInstruction
            ? "draft"
            : finalizedInstruction.status,
          acceptedAt: preserveExistingValidatedInstruction
            ? null
            : finalizedInstruction.acceptedAt,
          updatedAt: new Date().toISOString(),
        })
      : finalizedInstruction;
    emitProgress({
      waitReason: "finalizing",
      message: "Saving the final source instructions and verification result.",
      currentUrl: normalizedTarget.startingUrl,
      jobsFound: successfulAttemptCount,
    });
    executionSignal.throwIfAborted();
    const finalizationStartedAtMs = Date.now();
    await ctx.repository.upsertSourceInstructionArtifact(instructionToPersist);
    await ctx.saveJobSiteMetadata(normalizedTarget.id, (currentTarget) => ({
      ...currentTarget,
      instructionStatus: preserveExistingValidatedInstruction
        ? currentTarget.validatedInstructionId
          ? "validated"
          : instructionToPersist.status
        : instructionToPersist.status,
      draftInstructionId:
        preserveExistingValidatedInstruction ||
        instructionToPersist.status !== "validated"
          ? instructionToPersist.id
          : null,
      validatedInstructionId:
        instructionToPersist.status === "validated"
          ? instructionToPersist.id
          : currentTarget.validatedInstructionId,
      lastDebugRunId: run.id,
      lastVerifiedAt: verification.verifiedAt,
      staleReason:
        verification.outcome === "passed" ? null : verification.reason,
    }));
    finalizationMs = Date.now() - finalizationStartedAtMs;
    const completedAt = new Date().toISOString();
    run = SourceDebugRunRecordSchema.parse({
      ...run,
      state:
        verification.outcome === "passed"
          ? "completed"
          : finishedEarlyAfterUsefulDraft
            ? "completed"
            : "failed",
      updatedAt: completedAt,
      completedAt,
      activePhase: null,
      finalSummary:
        verification.proofSummary ??
        (finishedEarlyAfterUsefulDraft
          ? "Source debug stopped after proving a useful draft route on an auth-limited surface."
          : // A failed check tells the footer why, in the row's own words.
            (verification.outcome === "failed" && verification.reason) ||
            "Source debug workflow completed."),
      instructionArtifactId: instructionToPersist.id,
      timing: buildSourceDebugRunTimingSummary({
        events: progressEvents,
        run,
        completedAt,
        browserSetupMs,
        finalReviewMs,
        finalizationMs,
      }),
    });
    await ctx.persistSourceDebugRun(run);
  } catch (error) {
    const interrupted =
      executionSignal.aborted ||
      (error instanceof Error && error.name === "AbortError");
    const openFailure = interrupted
      ? null
      : describeSourceDebugOpenFailure(error, normalizedTarget.label);
    const completedAt = new Date().toISOString();
    if (openFailure) {
      await ctx.repository
        .upsertSourceDebugEvidenceRefs([
          SourceDebugEvidenceRefSchema.parse({
            id: `${run.id}_open_failure_technical_details`,
            runId: run.id,
            attemptId: `${run.id}_open_failure`,
            targetId: normalizedTarget.id,
            phase: run.phases[0] ?? "access_auth_probe",
            kind: "note",
            label: "Technical details",
            capturedAt: completedAt,
            url: normalizedTarget.startingUrl,
            storagePath: null,
            excerpt: openFailure.technicalDetails,
          }),
        ])
        .catch(() => {});
    }
    run = SourceDebugRunRecordSchema.parse({
      ...run,
      state: interrupted ? "cancelled" : "failed",
      updatedAt: completedAt,
      completedAt,
      activePhase: null,
      finalSummary: interrupted
        ? "Source debug run was interrupted before completion."
        : (openFailure?.summary ??
          `Source debug run failed: ${error instanceof Error ? error.message : "Unknown error"}`),
      timing: buildSourceDebugRunTimingSummary({
        events: progressEvents,
        run,
        completedAt,
        browserSetupMs,
        finalReviewMs,
        finalizationMs,
      }),
    });
    await ctx.persistSourceDebugRun(run);
    if (!interrupted && !openFailure) {
      throw error;
    }
  } finally {
    if (browserSessionOpened && !shouldKeepBrowserSessionOpen) {
      await ctx.closeRunBrowserSession(adapterKind).catch(() => {});
    }
    clearActiveController();
    ctx.activeSourceDebugExecutionIdRef.current = null;
  }

  return run;
}

/** What each check phase is doing, in the words a source row can show. */
function describeSourceCheckPhaseActivity(phase: SourceDebugPhase): string {
  switch (phase) {
    case "access_auth_probe":
      return "checking whether the site opens without a sign-in";
    case "site_structure_mapping":
      return "learning how the site works: where the jobs are, how search behaves, and how applying starts";
    case "search_filter_probe":
      return "trying the site's search and filters";
    case "job_detail_validation":
      return "opening job pages to read their details";
    case "apply_path_validation":
      return "looking for how an application starts";
    case "replay_verification":
      return "re-running the saved steps to confirm they still find jobs";
    default:
      return "checking the site";
  }
}

/**
 * Safety ceilings for one check phase. They are not budgets: a phase ends
 * when the agent finishes, says it is stuck, or stalls (nothing new for
 * SOURCE_DEBUG_STALL_STEP_WINDOW steps, twice: once to warn, once to stop).
 */
const SOURCE_DEBUG_PHASE_STEP_CEILING = 60;
const SOURCE_DEBUG_PHASE_TIME_CEILING_MS = 6 * 60_000;
const SOURCE_DEBUG_STALL_STEP_WINDOW = 6;

/**
 * The agent's own wording for a stop ("the phase timed out before the worker
 * returned a structured finish call", "nothing new after N tries") is kept
 * on the attempt for engineers; the source row gets a sentence that says
 * where the check was, why it stopped, what it managed, and what to do next.
 */
export function describeSourceCheckStop(input: {
  mode:
    | "stalled"
    | "timed_out_with_partial_evidence"
    | "timed_out_without_evidence";
  phase: SourceDebugPhase;
  startingUrl: string;
  lastUrl: string | null;
  jobsFound: number;
  agentReason: string | null;
}): string {
  const host = (() => {
    try {
      return new URL(input.startingUrl).hostname.replace(/^www\./, "");
    } catch {
      return "this site";
    }
  })();
  const activity = describeSourceCheckPhaseActivity(input.phase);
  const why =
    input.mode === "stalled"
      ? input.agentReason && !/^Nothing new appeared/.test(input.agentReason)
        ? `Job Finder stopped on ${host} while ${activity} because it got stuck: ${input.agentReason.replace(/\.?$/, ".")}`
        : `Job Finder stopped on ${host} while ${activity} because the site kept showing the same thing: nothing new appeared after repeated tries, even after it changed approach.`
      : `Job Finder hit its safety limit on ${host} while ${activity}, which means it kept working without reaching a conclusion.`;
  const progress =
    input.jobsFound > 0
      ? `It found ${input.jobsFound} job${input.jobsFound === 1 ? "" : "s"} before stopping`
      : "It did not reach a job list before stopping";
  const where =
    input.lastUrl && input.lastUrl !== input.startingUrl
      ? `; the last page it reached was ${input.lastUrl}.`
      : ".";
  return `${why} ${progress}${where} Check this source again; if it keeps stopping at the same point, open ${host} in the browser to see what the site shows.`;
}
