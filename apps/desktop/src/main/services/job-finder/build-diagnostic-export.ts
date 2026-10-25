import type {
  AssistantConversation,
  AssistantMessage,
  ApplicationQuestionRecord,
  ApplicationAnswerRecord,
} from "@nestor/contracts";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  getJobFinderDocumentsDirectory,
  getCandidateAssetsDirectory,
  getApplicationDocumentsDirectory,
} from "./paths";
import {
  type JobFinderRepositoryState,
  JobFinderDiagnosticExportSchema,
  type JobFinderDiagnosticExport,
  type JobFinderPerformanceSnapshot,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";

export function buildJobFinderDiagnosticExport(input: {
  workspace: JobFinderWorkspaceSnapshot;
  performance: JobFinderPerformanceSnapshot;
  build: JobFinderDiagnosticExport["build"];
  generatedAt?: string;
}): JobFinderDiagnosticExport {
  const latestAttempt = input.workspace.applicationAttempts.at(0) ?? null;
  const latestApplyDurationMs =
    latestAttempt?.executionTimings.find((entry) => entry.stage === "total")
      ?.durationMs ?? null;
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
        applications: input.workspace.applicationRecords.length,
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
      prepareOnlyApplicationCount: input.workspace.applyJobResults.length,
      finalSubmissionAuthorized: false,
      accountCreationAuthorized: false,
    },
    evidence: {
      sourceDebugRuns: input.workspace.recentSourceDebugRuns.length,
      resumeImports: input.workspace.latestResumeImportRun ? 1 : 0,
      applicationAttempts: input.workspace.applicationAttempts.length,
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

export function personalWorkspaceExportFileName(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `nestor-workspace-${date.getFullYear()}-${month}-${day}.json`;
}

/** Personal backup, separate from the redacted support report. No sign-in storage. */
export async function buildPersonalWorkspaceExport(input: {
  workspace: JobFinderWorkspaceSnapshot;
  repositoryState?: JobFinderRepositoryState;
  applicationQuestions?: readonly ApplicationQuestionRecord[];
  applicationAnswers?: readonly ApplicationAnswerRecord[];
  assistantHistory?: readonly {
    conversation: AssistantConversation;
    messages: readonly AssistantMessage[];
  }[];
  directories?: readonly { name: string; directory: string }[];
  generatedAt?: string;
}) {
  const files: { path: string; encoding: "base64"; content: string }[] = [];
  async function collect(directory: string, prefix: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw error;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = path.join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(absolute, relative);
      else if (entry.isFile())
        files.push({
          path: relative,
          encoding: "base64",
          content: (await readFile(absolute)).toString("base64"),
        });
      else
        throw new Error(
          "A workspace file could not be safely exported. Your workspace was kept.",
        );
    }
  }
  for (const directory of input.directories ?? [
    { name: "resumes", directory: getJobFinderDocumentsDirectory() },
    { name: "attachments", directory: getCandidateAssetsDirectory() },
    {
      name: "application-documents",
      directory: getApplicationDocumentsDirectory(),
    },
  ])
    await collect(directory.directory, directory.name);
  // The session describes site sign-ins; it is not personal application data.
  const workspace = {
    ...input.workspace,
    browserSession: undefined,
    agentProvider: undefined,
    visionProvider: undefined,
  };
  return JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt: input.generatedAt ?? new Date().toISOString(),
      workspace,
      repositoryState: input.repositoryState,
      fileRoots: input.directories ?? [
        { name: "resumes", directory: getJobFinderDocumentsDirectory() },
        { name: "attachments", directory: getCandidateAssetsDirectory() },
        {
          name: "application-documents",
          directory: getApplicationDocumentsDirectory(),
        },
      ],
      applicationQuestions: input.applicationQuestions ?? [],
      applicationAnswers: input.applicationAnswers ?? [],
      assistantHistory: input.assistantHistory ?? [],
      files,
      excluded: [
        "Browser sign-ins and cookies",
        "AI credentials",
        "AI provider configuration and model names",
      ],
    },
    // Model names in historical receipts are configuration metadata too.
    (key, value: unknown) => (key === "modelLabel" ? undefined : value),
    2,
  );
}
