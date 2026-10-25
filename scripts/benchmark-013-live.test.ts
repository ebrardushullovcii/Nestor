import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createJobFinderAiClientFromEnvironment } from "@nestor/ai-providers";
import { createBrowserAgentRuntime } from "@nestor/browser-runtime";
import {
  CandidateProfileSchema,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import {
  buildBenchmarkRepositoryState,
  createJobFinderWorkspaceService,
  type JobFinderDocumentManager,
  type JobFinderWorkspaceService,
} from "@nestor/job-finder";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const defaultOutputDir = path.join(
  repoRoot,
  "apps",
  "desktop",
  "test-artifacts",
  "ui",
  "013-benchmark-service",
);
const outputDir = process.env.BENCHMARK_OUTPUT_DIR
  ? path.resolve(process.env.BENCHMARK_OUTPUT_DIR)
  : defaultOutputDir;
const outputVariant = process.env.BENCHMARK_VARIANT ?? "after";
const headless = (process.env.NESTOR_BROWSER_HEADLESS ?? "1") === "1";
const runLiveBenchmark = process.env.NESTOR_RUN_013_LIVE_BENCHMARK === "1";

function getDefaultChromeExecutablePath(): string {
  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    return path.join(
      programFiles,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    );
  }

  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  return "/usr/bin/google-chrome";
}

const chromeExecutablePath =
  process.env.NESTOR_CHROME_PATH ?? getDefaultChromeExecutablePath();
const rawChromeDebugPort = process.env.NESTOR_CHROME_DEBUG_PORT
  ? Number.parseInt(process.env.NESTOR_CHROME_DEBUG_PORT, 10)
  : null;
const chromeDebugPort =
  rawChromeDebugPort !== null &&
  Number.isInteger(rawChromeDebugPort) &&
  rawChromeDebugPort > 0 &&
  rawChromeDebugPort <= 65535
    ? rawChromeDebugPort
    : null;
const PARTIAL_STATE_POLL_DEADLINE_MS = 6_000;
const PARTIAL_STATE_POLL_INTERVAL_MS = 200;

const defaultBenchmarkTargetRoles = [
  "Engineer",
  "Developer",
  "Designer",
  "Product",
  "Manager",
  "Marketing",
  "Sales",
  "Data",
  "Analyst",
] as const;

const benchmarkTargets = [
  {
    id: "target_greenhouse_remote",
    label: "Remote Greenhouse",
    startingUrl: "https://job-boards.greenhouse.io/remote",
    expectedProvider: "greenhouse",
    expectedApiCapable: true,
  },
  {
    id: "target_lever_aircall",
    label: "Aircall Lever",
    startingUrl: "https://jobs.lever.co/aircall",
    expectedProvider: "lever",
    expectedApiCapable: true,
  },
  {
    id: "target_kosovajob_home",
    label: "Kosovajob",
    startingUrl: "https://kosovajob.com/",
    expectedProvider: null,
    expectedApiCapable: false,
    benchmarkTargetRoles: [
      ...defaultBenchmarkTargetRoles,
      "Software",
      "Backend",
      "Frontend",
      "React",
      "QA",
      "Inxhinier",
      "Zhvillues",
      "Programer",
    ],
  },
] as const;

const availableBenchmarkTargetIds = benchmarkTargets.map((target) => target.id);

function selectBenchmarkTargets(
  requestedTargetIds: readonly string[],
): Array<(typeof benchmarkTargets)[number]> {
  if (requestedTargetIds.length === 0) {
    return [...benchmarkTargets];
  }

  const unknownTargetIds = requestedTargetIds.filter(
    (targetId) => !availableBenchmarkTargetIds.includes(targetId),
  );
  if (unknownTargetIds.length > 0) {
    throw new Error(
      `BENCHMARK_TARGET_IDS contained unknown benchmark targets. Unknown: ${unknownTargetIds.join(", ")}. Available: ${availableBenchmarkTargetIds.join(", ")}`,
    );
  }

  return benchmarkTargets.filter((target) =>
    requestedTargetIds.includes(target.id),
  );
}

const requestedBenchmarkTargetIds = (process.env.BENCHMARK_TARGET_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const selectedBenchmarkTargets = selectBenchmarkTargets(
  requestedBenchmarkTargetIds,
);

function getBenchmarkTargetRoles(
  target: (typeof benchmarkTargets)[number],
): string[] {
  return [...(target.benchmarkTargetRoles ?? defaultBenchmarkTargetRoles)];
}

function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const unquotedValue =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;

    parsed[key] = unquotedValue.replace(/\\n/g, "\n");
  }

  return parsed;
}

function loadEnvOverrides(root: string): Record<string, string> {
  const candidates = [
    path.join(root, ".env"),
    path.join(root, ".env.local"),
    path.join(root, "apps", "desktop", ".env"),
    path.join(root, "apps", "desktop", ".env.local"),
  ];

  const merged: Record<string, string> = {};
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const parsed = parseEnvFile(readFileSync(candidate, "utf8"));
    Object.assign(merged, parsed);
  }

  return merged;
}

async function loadFixture() {
  const fixturePath = path.join(
    repoRoot,
    "apps",
    "desktop",
    "test-fixtures",
    "job-finder",
    "profile-baseline-workspace.json",
  );
  try {
    return JSON.parse(await readFile(fixturePath, "utf8")) as {
      profile: Record<string, unknown>;
      searchPreferences: Record<string, unknown>;
      settings: Record<string, unknown>;
    };
  } catch (error) {
    throw new Error(
      `Failed to load benchmark fixture at ${fixturePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function buildSeed(
  fixture: Awaited<ReturnType<typeof loadFixture>>,
  target: (typeof benchmarkTargets)[number],
) {
  const parsedProfile = CandidateProfileSchema.parse(fixture.profile);
  const parsedSearchPreferences = JobSearchPreferencesSchema.parse(
    fixture.searchPreferences,
  );
  const parsedSettings = JobFinderSettingsSchema.parse(fixture.settings);
  const emptyState = buildBenchmarkRepositoryState({
    profile: parsedProfile,
    searchPreferences: parsedSearchPreferences,
  });

  return {
    ...emptyState,
    profile: parsedProfile,
    searchPreferences: {
      ...emptyState.searchPreferences,
      ...parsedSearchPreferences,
      targetRoles: getBenchmarkTargetRoles(target),
      locations: [],
      excludedLocations: [],
      workModes: [],
      seniorityLevels: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: {
        historyLimit: 5,
        targets: [
          {
            id: target.id,
            label: target.label,
            startingUrl: target.startingUrl,
            enabled: true,
            adapterKind: "auto",
            customInstructions: null,
            instructionStatus: "missing",
            validatedInstructionId: null,
            draftInstructionId: null,
            lastDebugRunId: null,
            lastVerifiedAt: null,
            staleReason: null,
          },
        ],
      },
    },
    settings: {
      ...emptyState.settings,
      ...parsedSettings,
      keepSessionAlive: true,
      discoveryOnly: false,
    },
  };
}

const noopDocumentManager: JobFinderDocumentManager = {
  listResumeTemplates() {
    return [];
  },
  async renderResumePreview() {
    throw new Error(
      "Resume preview is not needed for the 013 benchmark harness.",
    );
  },
  async renderResumeArtifact(
    input: Parameters<JobFinderDocumentManager["renderResumeArtifact"]>[0],
  ) {
    void input;
    throw new Error(
      "Resume rendering is not needed for the 013 benchmark harness.",
    );
  },
};

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function titleMatchRate(
  jobs: Array<Record<string, unknown>>,
  targetRoles: string[],
): number | null {
  if (jobs.length === 0 || targetRoles.length === 0) {
    return null;
  }

  const normalizedRoles = targetRoles
    .map((role) => normalizeText(role))
    .filter(Boolean);
  if (normalizedRoles.length === 0) {
    return null;
  }

  const matched = jobs.filter((job) => {
    const title = normalizeText(job.title);
    return normalizedRoles.some((role) => title.includes(role));
  }).length;

  return Number((matched / jobs.length).toFixed(3));
}

type RunWithTimeoutResult<TValue> = {
  value: TValue | null;
  partial: TValue | null;
  wallClockMs: number;
  timedOut: boolean;
  error: string | null;
};

type SourceDebugBenchmarkRunResult = {
  snapshot: Record<string, unknown>;
  details: Record<string, unknown> | null;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      })
    : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function findLatestSourceDebugRunSnapshot(
  snapshot: Record<string, unknown> | null,
  targetId: string,
): Record<string, unknown> | null {
  const recentRuns = asArrayOfRecords(snapshot?.recentSourceDebugRuns);
  const activeRun = asRecord(snapshot?.activeSourceDebugRun);

  return (
    recentRuns.find((run) => run.targetId === targetId) ??
    (activeRun?.targetId === targetId ? activeRun : null)
  );
}

function findLatestDiscoveryRunSnapshot(
  snapshot: Record<string, unknown> | null,
  targetId: string,
): Record<string, unknown> | null {
  const recentRuns = asArrayOfRecords(snapshot?.recentDiscoveryRuns);
  const activeRun = asRecord(snapshot?.activeDiscoveryRun);
  const runMatchesTarget = (run: Record<string, unknown>) =>
    asArrayOfRecords(run.targetExecutions).some(
      (execution) => execution.targetId === targetId,
    ) ||
    (Array.isArray(run.targetIds) && run.targetIds.includes(targetId));

  return (
    (activeRun && runMatchesTarget(activeRun) ? activeRun : null) ??
    recentRuns.find(runMatchesTarget)
  );
}

async function collectSourceDebugBenchmarkPartialState(
  workspaceService: JobFinderWorkspaceService,
  targetId: string,
): Promise<SourceDebugBenchmarkRunResult | null> {
  const deadline = Date.now() + PARTIAL_STATE_POLL_DEADLINE_MS;
  let latestSnapshot: Record<string, unknown> | null = null;
  let latestDetails: Record<string, unknown> | null = null;

  while (Date.now() <= deadline) {
    latestSnapshot = (await workspaceService
      .getWorkspaceSnapshot()
      .catch(() => null)) as Record<string, unknown> | null;
    const latestRun = findLatestSourceDebugRunSnapshot(
      latestSnapshot,
      targetId,
    );
    const latestRunId = readString(latestRun?.id);

    if (latestRunId) {
      latestDetails = (await workspaceService
        .getSourceDebugRunDetails(latestRunId)
        .catch(() => null)) as Record<string, unknown> | null;
    }

    const detailsRun = asRecord(latestDetails?.run);
    const runState = readString(detailsRun?.state ?? latestRun?.state);
    if (runState !== "running") {
      break;
    }

    await sleep(PARTIAL_STATE_POLL_INTERVAL_MS);
  }

  return latestSnapshot
    ? {
        snapshot: latestSnapshot,
        details: latestDetails,
      }
    : null;
}

async function collectDiscoveryBenchmarkPartialState(
  workspaceService: JobFinderWorkspaceService,
  targetId: string,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + PARTIAL_STATE_POLL_DEADLINE_MS;
  let latestSnapshot: Record<string, unknown> | null = null;

  while (Date.now() <= deadline) {
    latestSnapshot = (await workspaceService
      .getWorkspaceSnapshot()
      .catch(() => null)) as Record<string, unknown> | null;
    const latestRun = findLatestDiscoveryRunSnapshot(latestSnapshot, targetId);
    const discoveryRunState = readString(latestSnapshot?.discoveryRunState);
    const runState = readString(latestRun?.state);

    if (discoveryRunState !== "running" && runState !== "running") {
      break;
    }

    await sleep(PARTIAL_STATE_POLL_INTERVAL_MS);
  }

  return latestSnapshot;
}

async function runWithTimeout<TValue>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<TValue>,
  collectPartial?: () => Promise<TValue | null>,
): Promise<RunWithTimeoutResult<TValue>> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutMessage = `${label} timed out after ${timeoutMs}ms`;
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort(new Error(timeoutMessage));
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    const value = await Promise.race([run(controller.signal), timeoutPromise]);
    return {
      value,
      partial: null,
      wallClockMs: Date.now() - startedAt,
      timedOut: false,
      error: null,
    } satisfies RunWithTimeoutResult<TValue>;
  } catch (error) {
    const partial = collectPartial
      ? await collectPartial().catch(() => null)
      : null;

    return {
      value: null,
      partial,
      wallClockMs: Date.now() - startedAt,
      timedOut:
        controller.signal.aborted ||
        (error instanceof Error && error.message === timeoutMessage),
      error: error instanceof Error ? error.message : String(error),
    } satisfies RunWithTimeoutResult<TValue>;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function buildDiscoveryBenchmarkVerdict(input: {
  summary: Record<string, unknown> | null;
  jobsCount: number;
  timedOut: boolean;
}): string {
  const jobsPersisted = readNumber(input.summary?.jobsPersisted) ?? 0;
  const validJobsFound = readNumber(input.summary?.validJobsFound) ?? 0;
  const invalidSkipped = readNumber(input.summary?.invalidSkipped) ?? 0;
  const jobsSkippedByTitleTriage =
    readNumber(input.summary?.jobsSkippedByTitleTriage) ?? 0;

  if (jobsPersisted > 0) {
    return input.timedOut ? "timed_out_with_kept_jobs" : "kept_jobs";
  }

  if (validJobsFound > 0 || input.jobsCount > 0) {
    return input.timedOut
      ? "timed_out_with_partial_jobs"
      : "partial_jobs_found";
  }

  if (invalidSkipped > 0 || jobsSkippedByTitleTriage > 0) {
    return input.timedOut
      ? "timed_out_with_quality_signals"
      : "quality_signals_only";
  }

  return input.timedOut ? "timed_out_without_quality" : "no_usable_jobs";
}

function buildSourceDebugBenchmarkVerdict(input: {
  artifact: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  timedOut: boolean;
}): string {
  const verificationOutcome = readString(
    asRecord(input.artifact?.verification)?.outcome,
  );
  const attempts = asArrayOfRecords(input.details?.attempts);
  const evidenceRefs = asArrayOfRecords(input.details?.evidenceRefs);

  if (verificationOutcome === "passed") {
    return input.timedOut
      ? "timed_out_with_verified_artifact"
      : "verified_artifact";
  }

  if (input.artifact && (attempts.length > 0 || evidenceRefs.length > 0)) {
    return input.timedOut
      ? "timed_out_with_partial_artifact"
      : "partial_artifact";
  }

  if (attempts.length > 0 || evidenceRefs.length > 0) {
    return input.timedOut
      ? "timed_out_with_partial_evidence"
      : "partial_evidence_only";
  }

  return input.timedOut ? "timed_out_without_artifact" : "no_artifact";
}

const failingSourceDebugBenchmarkVerdicts = new Set([
  "no_artifact",
  "timed_out_without_artifact",
]);
const failingDiscoveryBenchmarkVerdicts = new Set([
  "no_usable_jobs",
  "timed_out_without_quality",
]);

function isPassingBenchmarkVerdict(
  verdict: unknown,
  failingVerdicts: ReadonlySet<string>,
): boolean {
  const normalizedVerdict = readString(verdict);
  return normalizedVerdict !== null && !failingVerdicts.has(normalizedVerdict);
}

function isPassingBenchmarkResultEntry(
  entry: Record<string, unknown>,
): boolean {
  const sourceDebug = asRecord(entry.sourceDebug);
  const discovery = asRecord(entry.discovery);

  return (
    isPassingBenchmarkVerdict(
      asRecord(sourceDebug?.qualitySignals)?.benchmarkVerdict,
      failingSourceDebugBenchmarkVerdicts,
    ) &&
    isPassingBenchmarkVerdict(
      asRecord(discovery?.qualitySignals)?.benchmarkVerdict,
      failingDiscoveryBenchmarkVerdicts,
    )
  );
}

function summarizeSourceDebug(
  target: (typeof benchmarkTargets)[number],
  searchPreferences: { targetRoles: string[] },
  result: {
    snapshot: Record<string, unknown>;
    details: Record<string, unknown> | null;
  } | null,
  meta: {
    wallClockMs: number;
    timedOut: boolean;
    error: string | null;
    partialStateCaptured: boolean;
  },
) {
  const details = asRecord(result?.details);
  const run = asRecord(details?.run);
  const artifact = asRecord(details?.instructionArtifact);
  const attempts = asArrayOfRecords(details?.attempts);
  const evidenceRefs = asArrayOfRecords(details?.evidenceRefs);
  const verification = asRecord(artifact?.verification);

  return {
    targetId: target.id,
    targetLabel: target.label,
    targetUrl: target.startingUrl,
    expectedProvider: target.expectedProvider,
    wallClockMs: meta.wallClockMs,
    error: meta.error,
    timedOut: meta.timedOut,
    partialStateCaptured: meta.partialStateCaptured,
    state: run?.state ?? null,
    finalSummary: run?.finalSummary ?? null,
    manualPrerequisiteSummary: run?.manualPrerequisiteSummary ?? null,
    timing: run?.timing ?? null,
    attemptCount: attempts.length,
    evidenceRefCount: evidenceRefs.length,
    attempts: attempts.map((attempt) => ({
      phase: attempt.phase ?? null,
      outcome: attempt.outcome ?? null,
      completionMode: attempt.completionMode ?? null,
      completionReason: attempt.completionReason ?? null,
      resultSummary: attempt.resultSummary ?? null,
      blockerSummary: attempt.blockerSummary ?? null,
      attemptedActions: Array.isArray(attempt.attemptedActions)
        ? attempt.attemptedActions.slice(0, 6)
        : [],
      confirmedFacts: Array.isArray(attempt.confirmedFacts)
        ? attempt.confirmedFacts.slice(0, 6)
        : [],
    })),
    evidenceRefs: evidenceRefs.slice(0, 8).map((evidenceRef) => ({
      phase: evidenceRef.phase ?? null,
      label: evidenceRef.label ?? null,
      url: evidenceRef.url ?? null,
      excerpt: evidenceRef.excerpt ?? null,
    })),
    artifact: artifact
      ? {
          id: artifact.id ?? null,
          status: artifact.status ?? null,
          guidanceCounts: {
            navigation: Array.isArray(artifact.navigationGuidance)
              ? artifact.navigationGuidance.length
              : 0,
            search: Array.isArray(artifact.searchGuidance)
              ? artifact.searchGuidance.length
              : 0,
            detail: Array.isArray(artifact.detailGuidance)
              ? artifact.detailGuidance.length
              : 0,
            apply: Array.isArray(artifact.applyGuidance)
              ? artifact.applyGuidance.length
              : 0,
            warnings: Array.isArray(artifact.warnings)
              ? artifact.warnings.length
              : 0,
          },
          verificationOutcome:
            typeof artifact.verification === "object" && artifact.verification
              ? ((artifact.verification as Record<string, unknown>).outcome ??
                null)
              : null,
          guidanceSamples: {
            navigation: Array.isArray(artifact.navigationGuidance)
              ? artifact.navigationGuidance.slice(0, 8)
              : [],
            search: Array.isArray(artifact.searchGuidance)
              ? artifact.searchGuidance.slice(0, 8)
              : [],
            detail: Array.isArray(artifact.detailGuidance)
              ? artifact.detailGuidance.slice(0, 8)
              : [],
            apply: Array.isArray(artifact.applyGuidance)
              ? artifact.applyGuidance.slice(0, 8)
              : [],
            warnings: Array.isArray(artifact.warnings)
              ? artifact.warnings.slice(0, 8)
              : [],
          },
          intelligence:
            typeof artifact.intelligence === "object" && artifact.intelligence
              ? {
                  providerKey:
                    typeof (artifact.intelligence as Record<string, unknown>)
                      .provider === "object" &&
                    (artifact.intelligence as Record<string, unknown>).provider
                      ? ((
                          (artifact.intelligence as Record<string, unknown>)
                            .provider as Record<string, unknown>
                        ).key ?? null)
                      : null,
                  preferredMethod:
                    typeof (artifact.intelligence as Record<string, unknown>)
                      .collection === "object" &&
                    (artifact.intelligence as Record<string, unknown>)
                      .collection
                      ? ((
                          (artifact.intelligence as Record<string, unknown>)
                            .collection as Record<string, unknown>
                        ).preferredMethod ?? null)
                      : null,
                }
              : null,
        }
      : null,
    qualitySignals: {
      hasArtifact: Boolean(artifact),
      hasTypedIntelligence: Boolean(artifact && "intelligence" in artifact),
      verificationOutcome: readString(verification?.outcome),
      preferredMethod:
        artifact &&
        typeof artifact.intelligence === "object" &&
        artifact.intelligence &&
        typeof (artifact.intelligence as Record<string, unknown>).collection ===
          "object" &&
        (artifact.intelligence as Record<string, unknown>).collection
          ? ((
              (artifact.intelligence as Record<string, unknown>)
                .collection as Record<string, unknown>
            ).preferredMethod ?? null)
          : null,
      providerMatchedExpectation:
        artifact &&
        typeof artifact.intelligence === "object" &&
        artifact.intelligence &&
        typeof (artifact.intelligence as Record<string, unknown>).provider ===
          "object" &&
        (artifact.intelligence as Record<string, unknown>).provider
          ? ((
              (artifact.intelligence as Record<string, unknown>)
                .provider as Record<string, unknown>
            ).key ?? null) === target.expectedProvider
          : null,
      targetRoles: searchPreferences.targetRoles,
      benchmarkVerdict: buildSourceDebugBenchmarkVerdict({
        artifact,
        details,
        timedOut: meta.timedOut,
      }),
    },
  };
}

function summarizeDiscovery(
  target: (typeof benchmarkTargets)[number],
  searchPreferences: { targetRoles: string[] },
  snapshot: Record<string, unknown> | null,
  meta: {
    wallClockMs: number;
    timedOut: boolean;
    error: string | null;
    partialStateCaptured: boolean;
  },
) {
  const run = findLatestDiscoveryRunSnapshot(snapshot, target.id);
  const targetExecutions = asArrayOfRecords(run?.targetExecutions);
  const jobs = Array.isArray(snapshot?.discoveryJobs)
    ? (snapshot.discoveryJobs as Array<Record<string, unknown>>)
    : [];
  const summary = asRecord(run?.summary);

  return {
    targetId: target.id,
    targetLabel: target.label,
    targetUrl: target.startingUrl,
    expectedProvider: target.expectedProvider,
    wallClockMs: meta.wallClockMs,
    error: meta.error,
    timedOut: meta.timedOut,
    partialStateCaptured: meta.partialStateCaptured,
    state: run?.state ?? null,
    scope: run?.scope ?? null,
    summary: summary ?? null,
    targetExecutions,
    jobs: {
      count: jobs.length,
      withSummary: jobs.filter((job) => Boolean(job.summary)).length,
      withApplicationUrl: jobs.filter((job) => Boolean(job.applicationUrl))
        .length,
      withEmployerDomain: jobs.filter((job) => Boolean(job.employerDomain))
        .length,
      withAtsProvider: jobs.filter((job) => Boolean(job.atsProvider)).length,
      withProviderKey: jobs.filter((job) => Boolean(job.providerKey)).length,
      withCollectionMethodApi: jobs.filter(
        (job) => job.collectionMethod === "api",
      ).length,
      withSourceIntelligence: jobs.filter((job) =>
        Boolean(job.sourceIntelligence),
      ).length,
      titleMatchRate: titleMatchRate(jobs, searchPreferences.targetRoles),
      sample: jobs.slice(0, 5).map((job) => ({
        title: job.title ?? null,
        company: job.company ?? null,
        location: job.location ?? null,
        canonicalUrl: job.canonicalUrl ?? null,
        discoveryMethod: job.discoveryMethod ?? null,
        collectionMethod: job.collectionMethod ?? null,
        providerKey: job.providerKey ?? null,
        atsProvider: job.atsProvider ?? null,
      })),
    },
    qualitySignals: {
      usedExpectedApiFastPath:
        target.expectedApiCapable === true
          ? jobs.some((job) => job.collectionMethod === "api") ||
            targetExecutions.some(
              (execution) => execution.collectionMethod === "api",
            )
          : false,
      providerTaggedJobs:
        target.expectedProvider === null
          ? jobs.filter((job) => Boolean(job.providerKey)).length
          : jobs.filter((job) => job.providerKey === target.expectedProvider)
              .length,
      typedSourceIntelligenceJobs: jobs.filter((job) =>
        Boolean(job.sourceIntelligence),
      ).length,
      invalidSkipped: readNumber(summary?.invalidSkipped),
      jobsSkippedByLedger: summary
        ? (summary.jobsSkippedByLedger ?? null)
        : null,
      jobsSkippedByTitleTriage: summary
        ? (summary.jobsSkippedByTitleTriage ?? null)
        : null,
      benchmarkVerdict: buildDiscoveryBenchmarkVerdict({
        summary,
        jobsCount: jobs.length,
        timedOut: meta.timedOut,
      }),
    },
  };
}

test("summarizeDiscovery preserves timed-out partial quality signals", () => {
  const target = benchmarkTargets[2];
  const summary = summarizeDiscovery(
    target,
    { targetRoles: getBenchmarkTargetRoles(target) },
    {
      discoveryRunState: "idle",
      recentDiscoveryRuns: [
        {
          state: "cancelled",
          scope: "single_target",
          targetExecutions: [
            { targetId: target.id, collectionMethod: "browser_agent" },
          ],
          summary: {
            jobsPersisted: 0,
            validJobsFound: 0,
            invalidSkipped: 3,
            jobsSkippedByTitleTriage: 1,
          },
        },
      ],
      discoveryJobs: [],
    },
    {
      wallClockMs: 180000,
      timedOut: true,
      error: "discovery timed out",
      partialStateCaptured: true,
    },
  );

  expect(summary.partialStateCaptured).toBe(true);
  expect(summary.state).toBe("cancelled");
  expect(summary.qualitySignals.invalidSkipped).toBe(3);
  expect(summary.qualitySignals.benchmarkVerdict).toBe(
    "timed_out_with_quality_signals",
  );
});

test("summarizeSourceDebug preserves timed-out partial artifact evidence", () => {
  const target = benchmarkTargets[2];
  const summary = summarizeSourceDebug(
    target,
    { targetRoles: getBenchmarkTargetRoles(target) },
    {
      snapshot: {},
      details: {
        run: {
          state: "cancelled",
          finalSummary: "Source debug run was interrupted before completion.",
        },
        attempts: [{ id: "attempt_1" }],
        evidenceRefs: [{ id: "evidence_1" }],
        instructionArtifact: {
          id: "artifact_1",
          status: "draft",
          navigationGuidance: ["Use the jobs homepage first."],
          searchGuidance: [],
          detailGuidance: [],
          applyGuidance: [],
          warnings: [],
          intelligence: {
            provider: null,
            collection: { preferredMethod: "careers_page" },
          },
          verification: { outcome: "failed" },
        },
      },
    },
    {
      wallClockMs: 240000,
      timedOut: true,
      error: "source debug timed out",
      partialStateCaptured: true,
    },
  );

  expect(summary.partialStateCaptured).toBe(true);
  expect(summary.attemptCount).toBe(1);
  expect(summary.evidenceRefCount).toBe(1);
  expect(summary.qualitySignals.benchmarkVerdict).toBe(
    "timed_out_with_partial_artifact",
  );
});

test("selectBenchmarkTargets rejects unknown ids even when some targets match", () => {
  expect(() =>
    selectBenchmarkTargets(["target_greenhouse_remote", "typoed_target"]),
  ).toThrow(/Unknown: typoed_target/u);
});

test("isPassingBenchmarkResultEntry rejects empty benchmark outcomes and keeps partial progress", () => {
  expect(
    isPassingBenchmarkResultEntry({
      sourceDebug: {
        qualitySignals: { benchmarkVerdict: "verified_artifact" },
      },
      discovery: { qualitySignals: { benchmarkVerdict: "no_usable_jobs" } },
    }),
  ).toBe(false);

  expect(
    isPassingBenchmarkResultEntry({
      sourceDebug: { qualitySignals: { benchmarkVerdict: "no_artifact" } },
      discovery: {
        qualitySignals: { benchmarkVerdict: "quality_signals_only" },
      },
    }),
  ).toBe(false);

  expect(
    isPassingBenchmarkResultEntry({
      sourceDebug: {
        qualitySignals: { benchmarkVerdict: "timed_out_with_partial_artifact" },
      },
      discovery: {
        qualitySignals: { benchmarkVerdict: "quality_signals_only" },
      },
    }),
  ).toBe(true);
});

describe.sequential("013 live before/after benchmark harness", () => {
  const benchmarkTest = runLiveBenchmark ? test : test.skip;

  benchmarkTest(
    `writes ${outputVariant} benchmark results`,
    { timeout: 0 },
    async () => {
      const envOverrides = loadEnvOverrides(repoRoot);
      const aiEnv = {
        ...envOverrides,
        ...process.env,
      };
      const aiClient = createJobFinderAiClientFromEnvironment(aiEnv);
      const fixture = await loadFixture();
      const results: Array<Record<string, unknown>> = [];

      for (const target of selectedBenchmarkTargets) {
        const seed = buildSeed(fixture, target);
        const repository = createInMemoryJobFinderRepository(seed);
        const userDataDir = await mkdtemp(
          path.join(
            os.tmpdir(),
            `nestor-013-benchmark-${outputVariant}-${target.id}-`,
          ),
        );
        const browserRuntime = createBrowserAgentRuntime({
          userDataDir,
          headless,
          chromeExecutablePath,
          ...(chromeDebugPort !== null ? { debugPort: chromeDebugPort } : {}),
          jobExtractor: (input) => aiClient.extractJobsFromPage(input),
          aiClient,
        });
        const workspaceService = createJobFinderWorkspaceService({
          aiClient,
          browserRuntime,
          documentManager: noopDocumentManager,
          repository,
        });

        try {
          const sourceDebugRun =
            await runWithTimeout<SourceDebugBenchmarkRunResult>(
              `source debug ${target.id}`,
              240_000,
              (signal) =>
                workspaceService
                  .runSourceDebug(target.id, signal)
                  .then(async (snapshot) => {
                    const latestRun = snapshot.recentSourceDebugRuns[0] ?? null;
                    const details = latestRun
                      ? await workspaceService.getSourceDebugRunDetails(
                          latestRun.id,
                        )
                      : null;
                    return {
                      snapshot: snapshot as unknown as Record<string, unknown>,
                      details: details as unknown as Record<
                        string,
                        unknown
                      > | null,
                    };
                  }),
              () =>
                collectSourceDebugBenchmarkPartialState(
                  workspaceService,
                  target.id,
                ),
            );

          const discoveryRun = await runWithTimeout(
            `discovery ${target.id}`,
            180_000,
            (signal) =>
              workspaceService.runAgentDiscovery(undefined, signal, target.id),
            () =>
              collectDiscoveryBenchmarkPartialState(
                workspaceService,
                target.id,
              ),
          );

          results.push({
            variant: outputVariant,
            target,
            sourceDebug: summarizeSourceDebug(
              target,
              seed.searchPreferences as { targetRoles: string[] },
              sourceDebugRun.value ?? sourceDebugRun.partial,
              {
                wallClockMs: sourceDebugRun.wallClockMs,
                timedOut: sourceDebugRun.timedOut,
                error: sourceDebugRun.error,
                partialStateCaptured:
                  sourceDebugRun.value === null &&
                  sourceDebugRun.partial !== null,
              },
            ),
            discovery: summarizeDiscovery(
              target,
              seed.searchPreferences as { targetRoles: string[] },
              (discoveryRun.value ?? discoveryRun.partial) as Record<
                string,
                unknown
              > | null,
              {
                wallClockMs: discoveryRun.wallClockMs,
                timedOut: discoveryRun.timedOut,
                error: discoveryRun.error,
                partialStateCaptured:
                  discoveryRun.value === null && discoveryRun.partial !== null,
              },
            ),
          });
        } finally {
          await browserRuntime
            .closeSession("target_site")
            .catch(() => undefined);
          await repository.close().catch(() => undefined);
          await rm(userDataDir, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      }

      const payload = {
        generatedAt: new Date().toISOString(),
        variant: outputVariant,
        headless,
        chromeExecutablePath,
        targets: selectedBenchmarkTargets,
        results,
      };

      await mkdir(outputDir, { recursive: true });
      await writeFile(
        path.join(outputDir, `${outputVariant}.json`),
        JSON.stringify(payload, null, 2),
        "utf8",
      );

      expect(results.length).toBe(selectedBenchmarkTargets.length);
      expect(results.every(isPassingBenchmarkResultEntry)).toBe(true);
    },
  );
});
