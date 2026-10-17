import {
  type ApplyAgentTiming,
  JobFinderPerformanceEvidenceSchema,
  JobFinderPerformanceSnapshotSchema,
  type JobFinderPerformanceEvidence,
  type JobFinderPerformanceSnapshot,
  type JobFinderWorkspaceSnapshot,
  type PerformanceBudgetEvaluation,
  type PerformanceEvidenceArea,
  type PerformanceEvidenceBudgetStatus,
  type PerformanceEvidenceStageDuration,
  type SourceDebugRunDetails,
} from "@nestor/contracts";

import { buildDiscoveryPerformanceBudgetEvaluations } from "./performance-budget-evaluation";

const performanceAreaOrder: readonly PerformanceEvidenceArea[] = [
  "resume_import",
  "resume_generation",
  "discovery",
  "application_preparation",
  "persistence",
  "ipc",
  "renderer_commit",
];

const budgetIdPrefixByArea: Record<PerformanceEvidenceArea, string> = {
  resume_import: "resume-import-",
  resume_generation: "resume-generation-",
  discovery: "discovery-",
  application_preparation: "application-preparation-",
  persistence: "persistence-",
  ipc: "ipc-",
  renderer_commit: "renderer-commit-",
};

type RuntimePerformanceArea = Extract<
  PerformanceEvidenceArea,
  "resume_generation" | "persistence" | "ipc" | "renderer_commit"
>;

export type JobFinderRuntimePerformanceObservation = {
  area: RuntimePerformanceArea;
  durationMs: number | null;
  recordedAt: string;
  sampleCount?: number;
  stageDurations?: readonly PerformanceEvidenceStageDuration[];
};

type PerformanceEvidenceWorkspace = Pick<
  JobFinderWorkspaceSnapshot,
  | "activeDiscoveryRun"
  | "applicationAttempts"
  | "latestResumeImportRun"
  | "recentDiscoveryRuns"
>;

function buildBudgetMetadata(
  area: PerformanceEvidenceArea,
  evaluations: readonly PerformanceBudgetEvaluation[],
): {
  budgetEvaluationIds: string[];
  budgetStatus: Exclude<PerformanceEvidenceBudgetStatus, "unavailable">;
} {
  const matching = evaluations.filter((evaluation) =>
    evaluation.id.startsWith(budgetIdPrefixByArea[area]),
  );
  const budgetStatus = matching.some(
    (evaluation) => evaluation.status === "fail",
  )
    ? "fail"
    : matching.some((evaluation) => evaluation.status === "warning")
      ? "warning"
      : matching.length > 0
        ? "pass"
        : "not_evaluated";

  return {
    budgetEvaluationIds: matching.map((evaluation) => evaluation.id),
    budgetStatus,
  };
}

function unavailableEvidence(
  area: PerformanceEvidenceArea,
): JobFinderPerformanceEvidence {
  return JobFinderPerformanceEvidenceSchema.parse({
    area,
    measurementStatus: "unavailable",
    durationMs: null,
    recordedAt: null,
    method: "none",
    sampleCount: 0,
    budgetStatus: "unavailable",
    unavailableReason: "no_recorded_measurement",
  });
}

function measuredEvidence(input: {
  agentTiming?: ApplyAgentTiming;
  area: PerformanceEvidenceArea;
  budgetEvaluations: readonly PerformanceBudgetEvaluation[];
  durationMs: number | null;
  method: Exclude<JobFinderPerformanceEvidence["method"], "none">;
  recordedAt: string;
  sampleCount?: number;
  stageDurations: readonly PerformanceEvidenceStageDuration[];
}): JobFinderPerformanceEvidence {
  const budget = buildBudgetMetadata(input.area, input.budgetEvaluations);
  if (input.durationMs !== null) {
    return JobFinderPerformanceEvidenceSchema.parse({
      area: input.area,
      measurementStatus: "available",
      durationMs: input.durationMs,
      recordedAt: input.recordedAt,
      method: input.method,
      sampleCount: input.sampleCount ?? 1,
      ...budget,
      stageDurations: input.stageDurations,
      agentTiming: input.agentTiming,
    });
  }

  if (input.stageDurations.length > 0) {
    return JobFinderPerformanceEvidenceSchema.parse({
      area: input.area,
      measurementStatus: "partial",
      durationMs: null,
      recordedAt: input.recordedAt,
      method: input.method,
      sampleCount: input.sampleCount ?? 1,
      ...budget,
      stageDurations: input.stageDurations,
      agentTiming: input.agentTiming,
      unavailableReason: "total_not_recorded",
    });
  }

  return unavailableEvidence(input.area);
}

function buildResumeImportEvidence(
  workspace: PerformanceEvidenceWorkspace,
  budgetEvaluations: readonly PerformanceBudgetEvaluation[],
): JobFinderPerformanceEvidence {
  const run = workspace.latestResumeImportRun;
  if (!run?.timing) {
    return unavailableEvidence("resume_import");
  }

  const stageDurations: PerformanceEvidenceStageDuration[] = [
    {
      id: "resume_import.text_branch",
      durationMs: run.timing.textBranchMs,
    },
    {
      id: "resume_import.literal_extraction",
      durationMs: run.timing.literalExtractionMs,
    },
    {
      id: "resume_import.reconciliation",
      durationMs: run.timing.reconciliationMs,
    },
    ...(run.timing.finalizationMs === null
      ? []
      : [
          {
            id: "resume_import.finalization" as const,
            durationMs: run.timing.finalizationMs,
          },
        ]),
    ...run.timing.textStages.map((stage) => ({
      id: `resume_import.${stage.stage}` as const,
      durationMs: stage.durationMs,
    })),
  ];

  return measuredEvidence({
    area: "resume_import",
    budgetEvaluations,
    durationMs: run.timing.totalMs,
    method: "resume_import_run",
    recordedAt: run.completedAt ?? run.startedAt,
    stageDurations,
  });
}

function buildDiscoveryEvidence(
  workspace: PerformanceEvidenceWorkspace,
  budgetEvaluations: readonly PerformanceBudgetEvaluation[],
): JobFinderPerformanceEvidence {
  const run =
    workspace.activeDiscoveryRun ?? workspace.recentDiscoveryRuns[0] ?? null;
  if (!run?.summary.timing) {
    return unavailableEvidence("discovery");
  }

  return measuredEvidence({
    area: "discovery",
    budgetEvaluations,
    durationMs: run.summary.durationMs,
    method: "discovery_run",
    recordedAt: run.completedAt ?? run.startedAt,
    stageDurations: run.summary.timing.stageDurations.map((stage) => ({
      id: `discovery.${stage.stage}` as const,
      durationMs: stage.durationMs,
    })),
  });
}

function buildApplicationPreparationEvidence(
  workspace: PerformanceEvidenceWorkspace,
  budgetEvaluations: readonly PerformanceBudgetEvaluation[],
): JobFinderPerformanceEvidence {
  const attempt = [...workspace.applicationAttempts]
    .filter(
      (candidate) =>
        candidate.executionTimings.length > 0 || candidate.agentTiming,
    )
    .sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )[0];
  if (!attempt) {
    return unavailableEvidence("application_preparation");
  }

  const total = attempt.executionTimings.find(
    (timing) => timing.stage === "total",
  );
  const stageDurations = attempt.executionTimings.flatMap((timing) =>
    timing.stage === "total"
      ? []
      : [
          {
            id: `application_preparation.${timing.stage}` as const,
            durationMs: timing.durationMs,
          },
        ],
  );

  return measuredEvidence({
    area: "application_preparation",
    budgetEvaluations,
    durationMs: total?.durationMs ?? attempt.agentTiming?.totalMs ?? null,
    ...(attempt.agentTiming ? { agentTiming: attempt.agentTiming } : {}),
    method: "application_attempt",
    recordedAt: total?.completedAt ?? attempt.updatedAt,
    stageDurations,
  });
}

function buildRuntimeEvidence(
  observation: JobFinderRuntimePerformanceObservation,
  budgetEvaluations: readonly PerformanceBudgetEvaluation[],
): JobFinderPerformanceEvidence {
  return measuredEvidence({
    area: observation.area,
    budgetEvaluations,
    durationMs: observation.durationMs,
    method: "runtime_observation",
    recordedAt: observation.recordedAt,
    ...(observation.sampleCount === undefined
      ? {}
      : { sampleCount: observation.sampleCount }),
    stageDurations: observation.stageDurations ?? [],
  });
}

export function buildJobFinderPerformanceSnapshot(input: {
  workspace: PerformanceEvidenceWorkspace;
  latestSourceDebugRun: SourceDebugRunDetails | null;
  generatedAt?: string;
  runtimeObservations?: readonly JobFinderRuntimePerformanceObservation[];
}): JobFinderPerformanceSnapshot {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const latestDiscoveryRun =
    input.workspace.activeDiscoveryRun ??
    input.workspace.recentDiscoveryRuns[0] ??
    null;
  const budgetEvaluations = buildDiscoveryPerformanceBudgetEvaluations(
    input.workspace.recentDiscoveryRuns,
  );
  const evidenceByArea = new Map<
    PerformanceEvidenceArea,
    JobFinderPerformanceEvidence
  >([
    [
      "resume_import",
      buildResumeImportEvidence(input.workspace, budgetEvaluations),
    ],
    ["resume_generation", unavailableEvidence("resume_generation")],
    ["discovery", buildDiscoveryEvidence(input.workspace, budgetEvaluations)],
    [
      "application_preparation",
      buildApplicationPreparationEvidence(input.workspace, budgetEvaluations),
    ],
    ["persistence", unavailableEvidence("persistence")],
    ["ipc", unavailableEvidence("ipc")],
    ["renderer_commit", unavailableEvidence("renderer_commit")],
  ]);

  for (const observation of input.runtimeObservations ?? []) {
    evidenceByArea.set(
      observation.area,
      buildRuntimeEvidence(observation, budgetEvaluations),
    );
  }

  return JobFinderPerformanceSnapshotSchema.parse({
    generatedAt,
    latestDiscoveryRun,
    latestSourceDebugRun: input.latestSourceDebugRun,
    budgetEvaluations,
    evidence: performanceAreaOrder.map((area) => evidenceByArea.get(area)),
  });
}
