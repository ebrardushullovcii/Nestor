import {
  JobFinderDiagnosticExportSchema,
  type JobFinderDiagnosticExport,
  type JobFinderPerformanceSnapshot,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";

export function buildJobFinderDiagnosticExport(input: {
  workspace: JobFinderWorkspaceSnapshot;
  /** The job store's applications, counted by state. */
  applications: Partial<Record<string, number>>;
  performance: JobFinderPerformanceSnapshot;
  build: JobFinderDiagnosticExport["build"];
  generatedAt?: string;
}): JobFinderDiagnosticExport {
  const applicationTotal = Object.values(input.applications).reduce<number>(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  // Preparation timings live on each application's own work now.
  const latestApplyDurationMs = null;
  const warnings: JobFinderDiagnosticExport["warnings"] =
    input.performance.budgetEvaluations.flatMap((entry, index) =>
      entry.status === "pass"
        ? []
        : [
            {
              category: "performance_budget" as const,
              code: "performance_budget_" + String(index + 1),
              status: entry.status,
            },
          ],
    );
  if (!input.workspace.agentProvider.ready) {
    warnings.push({
      category: "provider_availability",
      code: "agent_not_ready",
      status: "warning",
    });
  }
  if (input.workspace.visionProvider && !input.workspace.visionProvider.ready) {
    warnings.push({
      category: "provider_availability",
      code: "vision_not_ready",
      status: "warning",
    });
  }

  return JobFinderDiagnosticExportSchema.parse({
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    build: input.build,
    state: {
      profileSetupStatus: input.workspace.profileSetupState.status,
      browserStatus: input.workspace.browserSession.status,
      counts: {
        configuredSources:
          input.workspace.searchPreferences.discovery.targets.length,
        visibleJobs: input.workspace.discoveryJobs.length,
        shortlistedJobs: input.workspace.reviewQueue.length,
        applications: applicationTotal,
        unresolvedActions: input.workspace.userActionRequests.filter(
          (request) =>
            request.state !== "resolved" &&
            request.state !== "cancelled" &&
            request.state !== "skipped" &&
            request.state !== "superseded",
        ).length,
      },
    },
    timings: {
      latestDiscoveryDurationMs:
        input.performance.latestDiscoveryRun?.summary.durationMs ?? null,
      latestResumeImportDurationMs:
        input.workspace.latestResumeImportRun?.timing?.totalMs ?? null,
      latestApplyDurationMs,
    },
    performance: {
      ...(input.performance.waitingFormMemory
        ? { waitingFormMemory: input.performance.waitingFormMemory }
        : {}),
      measurements: input.performance.evidence.map((entry) => ({
        area: entry.area,
        measurementStatus: entry.measurementStatus,
        durationMs: entry.durationMs,
        recordedAt: entry.recordedAt,
        sampleCount: entry.sampleCount,
        budgetStatus: entry.budgetStatus,
        stageDurations: entry.stageDurations,
      })),
      budgetEvaluations: input.performance.budgetEvaluations.map(
        (evaluation) => ({
          id: evaluation.id,
          status: evaluation.status,
          unit: evaluation.unit,
          observed: evaluation.observed,
          limit: evaluation.limit,
          sampleCount: evaluation.sampleCount,
          minimumSamples: evaluation.minimumSamples,
        }),
      ),
    },
    warnings,
    capabilities: {
      agentReady: input.workspace.agentProvider.ready,
      visionReady: input.workspace.visionProvider?.ready ?? false,
      browserReady: input.workspace.browserSession.status === "ready",
      originalResumeReady:
        input.workspace.latestResumeImportRun?.status === "review_ready",
      tailoredResumeCount: input.workspace.resumeExportArtifacts.length,
      prepareOnlyApplicationCount: input.applications.ready ?? 0,
      finalSubmissionAuthorized: false,
      accountCreationAuthorized: false,
    },
    evidence: {
      sourceDebugRuns: input.workspace.recentSourceDebugRuns.length,
      resumeImports: input.workspace.latestResumeImportRun ? 1 : 0,
      applications: applicationTotal,
      userActionEvents: input.workspace.userActionEvents.length,
    },
    redactionManifest: {
      policy: "strict_allowlist_v1",
      localOnly: true,
      transmitted: false,
      excluded: [
        "credentials",
        "raw_resumes",
        "screenshots",
        "transcripts_and_audio",
        "browser_storage",
        "private_payloads",
        "url_secrets",
        "local_paths",
      ],
    },
  });
}
