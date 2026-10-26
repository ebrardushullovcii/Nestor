import {
  JobFinderDiagnosticExportSchema,
  type JobFinderDiagnosticExport,
  type WaitingFormMemory,
} from "@nestor/contracts";

/** Counts and readiness flags only: nothing a person wrote or uploaded. */
export interface JobFinderDiagnosticFacts {
  profileSetupStatus: JobFinderDiagnosticExport["state"]["profileSetupStatus"];
  browserStatus: JobFinderDiagnosticExport["state"]["browserStatus"];
  configuredSources: number;
  visibleJobs: number;
  shortlistedJobs: number;
  /** The job store's applications, counted by state. */
  applications: Partial<Record<string, number>>;
  unresolvedActions: number;
  approvedResumes: number;
  siteChecks: number;
  latestResumeImport: { durationMs: number | null; ready: boolean } | null;
  agentReady: boolean;
  visionReady: boolean;
  waitingFormMemory?: WaitingFormMemory;
}

export function buildJobFinderDiagnosticExport(input: {
  facts: JobFinderDiagnosticFacts;
  build: JobFinderDiagnosticExport["build"];
  generatedAt?: string;
}): JobFinderDiagnosticExport {
  const { facts } = input;
  const applicationTotal = Object.values(facts.applications).reduce<number>(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  const warnings: JobFinderDiagnosticExport["warnings"] = [];
  if (!facts.agentReady)
    warnings.push({
      category: "provider_availability",
      code: "agent_not_ready",
      status: "warning",
    });
  if (!facts.visionReady)
    warnings.push({
      category: "provider_availability",
      code: "vision_not_ready",
      status: "warning",
    });

  return JobFinderDiagnosticExportSchema.parse({
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    build: input.build,
    state: {
      profileSetupStatus: facts.profileSetupStatus,
      browserStatus: facts.browserStatus,
      counts: {
        configuredSources: facts.configuredSources,
        visibleJobs: facts.visibleJobs,
        shortlistedJobs: facts.shortlistedJobs,
        applications: applicationTotal,
        unresolvedActions: facts.unresolvedActions,
      },
    },
    timings: {
      latestDiscoveryDurationMs: null,
      latestResumeImportDurationMs:
        facts.latestResumeImport?.durationMs ?? null,
      // Preparation timings live on each application's own work now.
      latestApplyDurationMs: null,
    },
    performance: {
      ...(facts.waitingFormMemory
        ? { waitingFormMemory: facts.waitingFormMemory }
        : {}),
      measurements: [],
      budgetEvaluations: [],
    },
    warnings,
    capabilities: {
      agentReady: facts.agentReady,
      visionReady: facts.visionReady,
      browserReady: facts.browserStatus === "ready",
      originalResumeReady: facts.latestResumeImport?.ready ?? false,
      tailoredResumeCount: facts.approvedResumes,
      prepareOnlyApplicationCount: facts.applications.ready ?? 0,
      finalSubmissionAuthorized: false,
      accountCreationAuthorized: false,
    },
    evidence: {
      sourceDebugRuns: facts.siteChecks,
      resumeImports: facts.latestResumeImport ? 1 : 0,
      applications: applicationTotal,
      userActionEvents: 0,
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
