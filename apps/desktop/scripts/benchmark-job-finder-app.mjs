import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import {
  isDisabled,
  isEnabled,
} from "../src/main/services/job-finder/env-flags.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const fixturePath = path.join(
  desktopDir,
  "test-fixtures",
  "job-finder",
  "profile-baseline-workspace.json",
);
const outputLabel = process.env.UI_CAPTURE_LABEL ?? "job-finder-app-benchmark";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", outputLabel);
const parsedPerScenarioTimeoutMs = Number.parseInt(
  process.env.JOB_FINDER_APP_BENCHMARK_TIMEOUT_MS ?? "900000",
  10,
);
const perScenarioTimeoutMs =
  Number.isInteger(parsedPerScenarioTimeoutMs) && parsedPerScenarioTimeoutMs > 0
    ? parsedPerScenarioTimeoutMs
    : 900000;

const useCurrentWorkspace =
  process.argv.includes("--use-current-workspace") ||
  isEnabled(process.env.JOB_FINDER_APP_BENCHMARK_USE_CURRENT_WORKSPACE);

function resolveBrowserAgentEnabledEffective(env = process.env) {
  return !isDisabled(env.NESTOR_BROWSER_AGENT);
}

if (useCurrentWorkspace) {
  // TODO(plan 017): Re-enable current-workspace benchmarking only after the live
  // reset/restore flow captures and restores full repository state instead of the
  // flattened workspace snapshot. The current snapshot omits full resume/apply/import
  // artifacts, so piping it back through resetWorkspaceState is not a safe round-trip.
  // Until then, keep the current-workspace branches in launchAppForScenario,
  // resetDiscoveryState, restoreWorkspaceSnapshot,
  // withScopedCurrentWorkspaceTargets, resolveCurrentWorkspaceTargets,
  // toCurrentWorkspaceTarget, getPreferredCurrentTargets,
  // resolveRequestedCurrentWorkspaceTargets,
  // runCurrentWorkspaceSingleTargetBenchmarkPair,
  // runCurrentWorkspaceRunAllScenario, and the useCurrentWorkspace scenario block
  // disabled to avoid deleting live workspace data.
  throw new Error(
    "--use-current-workspace is disabled because the benchmark reset flow is not safe for live workspace data.",
  );
}

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
];

// These targets and role terms are intentionally source-branded benchmark fixtures only; never reuse them in shared discovery or production source-generic code.
const benchmarkTargets = [
  {
    id: "target_linkedin_default",
    label: "LinkedIn",
    startingUrl: "https://www.linkedin.com/jobs/search/",
    benchmarkTargetRoles: [...defaultBenchmarkTargetRoles],
  },
  {
    id: "target_greenhouse_remote",
    label: "Remote Greenhouse",
    startingUrl: "https://job-boards.greenhouse.io/remote",
    benchmarkTargetRoles: [...defaultBenchmarkTargetRoles],
  },
  {
    id: "target_lever_aircall",
    label: "Aircall Lever",
    startingUrl: "https://jobs.lever.co/aircall",
    benchmarkTargetRoles: [...defaultBenchmarkTargetRoles],
  },
  {
    id: "target_kosovajob_home",
    label: "Kosovajob",
    startingUrl: "https://kosovajob.com/",
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
];

function readCliOption(flag) {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return null;
  }

  return process.argv[index + 1] ?? null;
}

function parseCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pickTargets(ids, fallbackIds) {
  const effectiveIds = ids.length > 0 ? ids : fallbackIds;
  return effectiveIds
    .map((id) => benchmarkTargets.find((target) => target.id === id) ?? null)
    .filter(Boolean);
}

function toCurrentWorkspaceTarget(target) {
  return {
    id: target.id,
    label: target.label,
    startingUrl: target.startingUrl,
    benchmarkTargetRoles: [...defaultBenchmarkTargetRoles],
  };
}

function getPreferredCurrentTargets(enabledTargets) {
  const byUrlSubstring = (substring) =>
    enabledTargets.find((target) =>
      String(target.startingUrl ?? "")
        .toLowerCase()
        .includes(substring),
    ) ?? null;

  const preferred = [
    byUrlSubstring("linkedin.com"),
    byUrlSubstring("kosovajob.com"),
  ].filter(Boolean);
  const preferredIds = new Set(preferred.map((target) => target.id));
  const remaining = enabledTargets.filter(
    (target) => !preferredIds.has(target.id),
  );
  return [...preferred, ...remaining];
}

function resolveRequestedCurrentWorkspaceTargets(
  allTargets,
  requestedIds,
  mode,
) {
  return requestedIds.map((id) => {
    const match = allTargets.find((target) => target.id === id);
    if (!match) {
      throw new Error(
        `Requested ${mode} target '${id}' was not found in the current workspace. Available targets: ${allTargets.map((target) => target.id).join(", ")}`,
      );
    }
    return match;
  });
}

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function buildSearchPreferences(baseSearchPreferences, targets, targetRoles) {
  return {
    ...baseSearchPreferences,
    targetRoles,
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
      targets: targets.map((target) => ({
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
      })),
    },
  };
}

function buildSettings(baseSettings) {
  return {
    ...baseSettings,
    keepSessionAlive: true,
    discoveryOnly: false,
  };
}

async function launchAppForScenario({ seededInput }) {
  const userDataDirectory = useCurrentWorkspace
    ? null
    : await mkdtemp(path.join(os.tmpdir(), "nestor-app-benchmark-"));
  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      ...(useCurrentWorkspace
        ? {
            NESTOR_ENABLE_TEST_API: "1",
            NESTOR_TEST_API_USE_LIVE_AI: "1",
          }
        : {}),
      ...(userDataDirectory ? { NESTOR_USER_DATA_DIR: userDataDirectory } : {}),
    },
  });
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    await app.close().catch(() => undefined);
    if (userDataDirectory) {
      await rm(userDataDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  };

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await waitForJobFinderBridge(window);
    let resetWorkspaceSnapshot = null;
    if (seededInput) {
      await seedWorkspace(window, seededInput);
    } else {
      resetWorkspaceSnapshot = await resetDiscoveryState(window);
    }

    return {
      app,
      cleanup,
      resetWorkspaceSnapshot,
      window,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function waitForJobFinderBridge(window, timeout = 15000) {
  await window.waitForFunction(
    () => Boolean(window.nestor?.jobFinder),
    undefined,
    { timeout },
  );
}

async function resolveUsableWindow(app, preferredWindow = null) {
  const candidateWindows = [preferredWindow, ...app.windows()].filter(Boolean);

  for (const candidate of candidateWindows) {
    if (candidate.isClosed()) {
      continue;
    }

    await candidate.waitForLoadState("domcontentloaded").catch(() => undefined);
    await waitForJobFinderBridge(candidate).catch(() => undefined);
    if (!candidate.isClosed()) {
      return candidate;
    }
  }

  let timeoutHandle = null;
  const firstWindowPromise = app.firstWindow().finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
  const firstWindow = await Promise.race([
    firstWindowPromise,
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error("Timed out waiting for a usable window."));
      }, 30000);
    }),
  ]);
  await firstWindow.waitForLoadState("domcontentloaded");
  await waitForJobFinderBridge(firstWindow);
  return firstWindow;
}

async function seedWorkspace(window, input) {
  await window.evaluate(async ({ profile, searchPreferences, settings }) => {
    await window.nestor.jobFinder.saveWorkspaceInputs({
      profile,
      searchPreferences,
    });
    await window.nestor.jobFinder.saveSettings(settings);
    return window.nestor.jobFinder.getWorkspace();
  }, input);
}

async function getWorkspace(window) {
  return window.evaluate(async () => window.nestor.jobFinder.getWorkspace());
}

async function resetDiscoveryState(window) {
  const workspace = await getWorkspace(window);
  const originalWorkspaceSnapshot = structuredClone(workspace);
  const resetState = {
    profile: workspace.profile,
    searchPreferences: workspace.searchPreferences,
    profileSetupState: workspace.profileSetupState,
    savedJobs: [],
    tailoredAssets: [],
    resumeDrafts: [],
    resumeDraftRevisions: [],
    resumeExportArtifacts: [],
    resumeResearchArtifacts: [],
    resumeValidationResults: [],
    resumeAssistantMessages: [],
    profileCopilotMessages: workspace.profileCopilotMessages ?? [],
    profileRevisions: workspace.profileRevisions ?? [],
    applyRuns: [],
    applyJobResults: [],
    applySubmitApprovals: [],
    applicationQuestionRecords: [],
    applicationAnswerRecords: [],
    applicationArtifactRefs: [],
    applicationReplayCheckpoints: [],
    applicationConsentRequests: [],
    applicationRecords: [],
    applicationAttempts: [],
    sourceDebugRuns: workspace.recentSourceDebugRuns ?? [],
    sourceDebugAttempts: [],
    sourceInstructionArtifacts: workspace.sourceInstructionArtifacts ?? [],
    sourceDebugEvidenceRefs: [],
    settings: workspace.settings,
    discovery: {
      sessions: workspace.discoverySessions ?? [],
      runState: "idle",
      activeRun: null,
      recentRuns: [],
      activeSourceDebugRun: null,
      recentSourceDebugRuns: workspace.recentSourceDebugRuns ?? [],
      discoveryLedger: [],
      pendingDiscoveryJobs: [],
    },
  };

  await window.evaluate(async (state) => {
    if (!window.nestor.jobFinder.test?.resetWorkspaceState) {
      throw new Error(
        "Current-workspace benchmark reset requires desktop test API support.",
      );
    }

    return window.nestor.jobFinder.test.resetWorkspaceState(state);
  }, resetState);

  return originalWorkspaceSnapshot;
}

async function restoreWorkspaceSnapshot(window, snapshot) {
  await window.evaluate(async (state) => {
    if (!window.nestor.jobFinder.test?.resetWorkspaceState) {
      throw new Error(
        "Current-workspace benchmark restore requires desktop test API support.",
      );
    }

    return window.nestor.jobFinder.test.resetWorkspaceState(state);
  }, snapshot);
}

async function withScopedCurrentWorkspaceTargets(
  app,
  window,
  targetIds,
  runner,
  originalWorkspaceOverride = null,
) {
  const scopedTargetIds = [...new Set(targetIds.filter(Boolean))];
  if (!useCurrentWorkspace || scopedTargetIds.length === 0) {
    return runner(window);
  }

  const originalWorkspace =
    originalWorkspaceOverride ?? (await getWorkspace(window));
  const originalSearchPreferences = originalWorkspace?.searchPreferences;
  const originalTargets = Array.isArray(
    originalSearchPreferences?.discovery?.targets,
  )
    ? originalSearchPreferences.discovery.targets
    : [];

  if (originalTargets.length === 0) {
    return runner(window);
  }

  const scopedTargets = originalTargets.map((target) => ({
    ...target,
    enabled: scopedTargetIds.includes(target.id),
  }));
  const needsScopeChange = scopedTargets.some(
    (target, index) =>
      Boolean(target.enabled) !== Boolean(originalTargets[index]?.enabled),
  );

  if (!needsScopeChange) {
    return runner(window);
  }

  const scopedWorkspaceInput = {
    profile: originalWorkspace.profile,
    searchPreferences: {
      ...originalSearchPreferences,
      discovery: {
        ...originalSearchPreferences.discovery,
        targets: scopedTargets,
      },
    },
  };
  let activeWindow = window;
  const saveScopedTargets = async (targetWindow) =>
    targetWindow.evaluate(
      async ({ profile, searchPreferences }) =>
        window.nestor.jobFinder.saveWorkspaceInputs({
          profile,
          searchPreferences,
        }),
      scopedWorkspaceInput,
    );

  try {
    await saveScopedTargets(activeWindow);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Target page, context or browser has been closed/i.test(message)) {
      throw error;
    }

    activeWindow = await resolveUsableWindow(app, activeWindow);
    await saveScopedTargets(activeWindow);
  }

  try {
    return await runner(activeWindow);
  } finally {
    await activeWindow
      .evaluate(
        async ({ profile, searchPreferences }) =>
          window.nestor.jobFinder.saveWorkspaceInputs({
            profile,
            searchPreferences,
          }),
        {
          profile: originalWorkspace.profile,
          searchPreferences: originalSearchPreferences,
        },
      )
      .catch((error) => {
        process.stderr.write(
          `Warning: failed to restore workspace inputs: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
  }
}

async function resolveCurrentWorkspaceTargets(
  window,
  requestedSingleTargetIds,
  requestedRunAllTargetIds,
) {
  const workspace = await getWorkspace(window);
  const allTargets = Array.isArray(
    workspace?.searchPreferences?.discovery?.targets,
  )
    ? workspace.searchPreferences.discovery.targets.filter(Boolean)
    : [];
  const enabledTargets = allTargets.filter((target) => target?.enabled);

  if (allTargets.length === 0) {
    throw new Error("The current workspace has no discovery targets.");
  }

  if (enabledTargets.length === 0) {
    if (
      requestedSingleTargetIds.length === 0 &&
      requestedRunAllTargetIds.length === 0
    ) {
      throw new Error(
        "The current workspace has no enabled discovery targets.",
      );
    }
  }

  const availableTargets = allTargets.map(toCurrentWorkspaceTarget);
  const enabledAvailableTargets = enabledTargets.map(toCurrentWorkspaceTarget);

  if (enabledAvailableTargets.length === 0) {
    return {
      availableTargets,
      singleTargets: resolveRequestedCurrentWorkspaceTargets(
        availableTargets,
        requestedSingleTargetIds,
        "single",
      ),
      runAllTargets: resolveRequestedCurrentWorkspaceTargets(
        availableTargets,
        requestedRunAllTargetIds,
        "run-all",
      ),
      workspace,
    };
  }

  const preferredTargets = getPreferredCurrentTargets(enabledAvailableTargets);
  const singleTargets =
    requestedSingleTargetIds.length > 0
      ? resolveRequestedCurrentWorkspaceTargets(
          availableTargets,
          requestedSingleTargetIds,
          "single",
        )
      : preferredTargets.slice(0, Math.min(2, preferredTargets.length));
  const runAllTargets =
    requestedRunAllTargetIds.length > 0
      ? resolveRequestedCurrentWorkspaceTargets(
          availableTargets,
          requestedRunAllTargetIds,
          "run-all",
        )
      : enabledAvailableTargets;

  return {
    availableTargets,
    singleTargets,
    runAllTargets,
    workspace,
  };
}

async function withTimedScenario(label, runner) {
  const startedAt = Date.now();
  let timeoutHandle = null;

  try {
    const value = await Promise.race([
      runner(),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(`${label} timed out after ${perScenarioTimeoutMs}ms`),
          );
        }, perScenarioTimeoutMs);
      }),
    ]);

    return {
      ok: true,
      wallClockMs: Date.now() - startedAt,
      error: null,
      value,
    };
  } catch (error) {
    return {
      ok: false,
      wallClockMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      value: null,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function buildSourceDebugSummary(result) {
  if (!result?.snapshot) {
    return null;
  }

  const target = Array.isArray(
    result.snapshot?.searchPreferences?.discovery?.targets,
  )
    ? (result.snapshot.searchPreferences.discovery.targets[0] ?? null)
    : null;
  const latestRun = Array.isArray(result.snapshot?.recentSourceDebugRuns)
    ? (result.snapshot.recentSourceDebugRuns[0] ?? null)
    : null;
  const details = result.details ?? null;

  return {
    targetInstructionStatus: target?.instructionStatus ?? null,
    targetValidatedInstructionId: target?.validatedInstructionId ?? null,
    targetDraftInstructionId: target?.draftInstructionId ?? null,
    runState: latestRun?.state ?? null,
    finalSummary: latestRun?.finalSummary ?? null,
    manualPrerequisiteSummary: latestRun?.manualPrerequisiteSummary ?? null,
    runTiming: latestRun?.timing ?? null,
    attemptCount: Array.isArray(details?.attempts)
      ? details.attempts.length
      : null,
    phases: Array.isArray(details?.run?.phases)
      ? details.run.phases
      : (latestRun?.phases ?? []),
    phaseSummaries: Array.isArray(details?.run?.phaseSummaries)
      ? details.run.phaseSummaries.map((summary) => ({
          phase: summary.phase,
          summary: summary.summary,
          completionMode: summary.completionMode,
          completionReason: summary.completionReason,
          timing: summary.timing ?? null,
        }))
      : [],
  };
}

function buildDiscoverySummary(snapshot) {
  snapshot = snapshot?.snapshot ?? snapshot;
  if (!snapshot) {
    return null;
  }

  const latestRun = Array.isArray(snapshot?.recentDiscoveryRuns)
    ? (snapshot.recentDiscoveryRuns[0] ?? null)
    : null;

  return {
    runState: latestRun?.state ?? null,
    summary: latestRun?.summary ?? null,
    targetExecutions: Array.isArray(latestRun?.targetExecutions)
      ? latestRun.targetExecutions.map((execution) => ({
          targetId: execution.targetId,
          resolvedAdapterKind: execution.resolvedAdapterKind,
          collectionMethod: execution.collectionMethod,
          state: execution.state,
          jobsFound: execution.jobsFound,
          jobsPersisted: execution.jobsPersisted,
          jobsStaged: execution.jobsStaged,
          warning: execution.warning,
          timing: execution.timing ?? null,
        }))
      : [],
    keptJobs: Array.isArray(snapshot?.discoveryJobs)
      ? snapshot.discoveryJobs.map((job) => ({
          id: job.id,
          title: job.title,
          company: job.company,
          canonicalUrl: job.canonicalUrl,
          source: job.source,
          discoveryMethod: job.discoveryMethod,
        }))
      : [],
  };
}

async function runSingleScenario({
  scenario,
  targets,
  targetRoles,
  runner,
  seededInput,
  scopeCurrentWorkspaceTargets = false,
}) {
  const { app, cleanup, resetWorkspaceSnapshot, window } =
    await launchAppForScenario({ seededInput });

  try {
    const timed = await withTimedScenario(scenario, () =>
      scopeCurrentWorkspaceTargets
        ? withScopedCurrentWorkspaceTargets(
            app,
            window,
            targets.map((target) => target.id),
            (activeWindow) => runner(activeWindow),
            resetWorkspaceSnapshot,
          )
        : runner(window),
    );
    const snapshot = timed.value?.snapshot ?? timed.value ?? null;
    const effectiveTargetRoles = Array.isArray(
      snapshot?.searchPreferences?.targetRoles,
    )
      ? snapshot.searchPreferences.targetRoles
      : targetRoles;
    return {
      scenario,
      targets: targets.map((target) => ({
        id: target.id,
        label: target.label,
        startingUrl: target.startingUrl,
      })),
      targetRoles: effectiveTargetRoles,
      wallClockMs: timed.wallClockMs,
      ok: timed.ok,
      error: timed.error,
      result: timed.value,
    };
  } finally {
    await cleanup();
  }
}

async function runSingleTargetBenchmarkPair(target) {
  const fixture = useCurrentWorkspace ? null : await loadFixture();
  const seededInput = useCurrentWorkspace
    ? null
    : {
        profile: fixture.profile,
        searchPreferences: buildSearchPreferences(
          fixture.searchPreferences,
          [target],
          [...target.benchmarkTargetRoles],
        ),
        settings: buildSettings(fixture.settings),
      };
  const { app, cleanup, resetWorkspaceSnapshot, window } =
    await launchAppForScenario({ seededInput });

  try {
    return await executeBenchmarkPairScenarios({
      app,
      window,
      target,
      resetWorkspaceSnapshot,
      preflightWorkspace: useCurrentWorkspace,
    });
  } finally {
    await cleanup();
  }
}

async function executeBenchmarkPairScenarios({
  app,
  window,
  target,
  resetWorkspaceSnapshot = null,
  preflightWorkspace = false,
}) {
  const wrapResult = (entry) => ({
    ...entry,
    targets: [
      {
        id: target.id,
        label: target.label,
        startingUrl: target.startingUrl,
      },
    ],
  });

  return withScopedCurrentWorkspaceTargets(
    app,
    window,
    [target.id],
    async (scopedWindow) => {
      if (preflightWorkspace) {
        await getWorkspace(scopedWindow);
      }

      const sourceDebugTimed = await withTimedScenario(
        `check_source:${target.id}`,
        async () => {
          const snapshot = await scopedWindow.evaluate(
            async (targetId) =>
              window.nestor.jobFinder.runSourceDebug(targetId),
            target.id,
          );
          const latestRunId = snapshot?.recentSourceDebugRuns?.[0]?.id ?? null;
          const details = latestRunId
            ? await scopedWindow.evaluate(
                async (runId) =>
                  window.nestor.jobFinder.getSourceDebugRunDetails(runId),
                latestRunId,
              )
            : null;

          return {
            snapshot,
            details,
          };
        },
      );
      const sourceDebugSnapshot = sourceDebugTimed.value?.snapshot ?? null;
      const sourceDebugTargetRoles = Array.isArray(
        sourceDebugSnapshot?.searchPreferences?.targetRoles,
      )
        ? sourceDebugSnapshot.searchPreferences.targetRoles
        : [...target.benchmarkTargetRoles];
      const sourceDebugEntry = wrapResult({
        scenario: `check_source:${target.id}`,
        targetRoles: sourceDebugTargetRoles,
        wallClockMs: sourceDebugTimed.wallClockMs,
        ok: sourceDebugTimed.ok,
        error: sourceDebugTimed.error,
        result: sourceDebugTimed.value,
        sourceDebug: buildSourceDebugSummary(sourceDebugTimed.value),
      });

      printScenarioSummary(sourceDebugEntry);

      if (!sourceDebugTimed.ok) {
        return [sourceDebugEntry];
      }

      const discoveryTimed = await withTimedScenario(
        `search_now:${target.id}`,
        () =>
          scopedWindow.evaluate(async (targetId) => {
            const reply = await window.nestor.jobFinder.runAgentDiscovery(
              undefined,
              targetId,
            );
            // The route answers with what changed; read the whole workspace.
            return {
              ...reply,
              snapshot: await window.nestor.jobFinder.getWorkspace(),
            };
          }, target.id),
      );
      const discoverySnapshot =
        discoveryTimed.value?.snapshot ?? discoveryTimed.value ?? null;
      const discoveryTargetRoles = Array.isArray(
        discoverySnapshot?.searchPreferences?.targetRoles,
      )
        ? discoverySnapshot.searchPreferences.targetRoles
        : [...target.benchmarkTargetRoles];
      const discoveryEntry = wrapResult({
        scenario: `search_now:${target.id}`,
        targetRoles: discoveryTargetRoles,
        wallClockMs: discoveryTimed.wallClockMs,
        ok: discoveryTimed.ok,
        error: discoveryTimed.error,
        result: discoveryTimed.value,
        discovery: buildDiscoverySummary(discoveryTimed.value),
      });

      printScenarioSummary(discoveryEntry);

      return [sourceDebugEntry, discoveryEntry];
    },
    resetWorkspaceSnapshot,
  );
}

async function runCurrentWorkspaceSingleTargetBenchmarkPair(
  app,
  window,
  target,
) {
  let activeWindow = await resolveUsableWindow(app, window);
  const resetWorkspaceSnapshot = await resetDiscoveryState(activeWindow);
  let pairResults;

  try {
    pairResults = await executeBenchmarkPairScenarios({
      app,
      window: activeWindow,
      target,
      resetWorkspaceSnapshot,
      preflightWorkspace: true,
    });
  } finally {
    activeWindow = await resolveUsableWindow(app, activeWindow);
    await restoreWorkspaceSnapshot(activeWindow, resetWorkspaceSnapshot);
  }

  activeWindow = await resolveUsableWindow(app, activeWindow);
  return {
    window: activeWindow,
    results: pairResults,
  };
}

async function runCurrentWorkspaceRunAllScenario(app, window, targets) {
  let activeWindow = await resolveUsableWindow(app, window);
  const resetWorkspaceSnapshot = await resetDiscoveryState(activeWindow);
  const targetRoles = [
    ...new Set(targets.flatMap((target) => target.benchmarkTargetRoles)),
  ];
  let result;

  try {
    result = await withTimedScenario("search_jobs:run_all", () =>
      withScopedCurrentWorkspaceTargets(
        app,
        activeWindow,
        targets.map((target) => target.id),
        (scopedWindow) =>
          scopedWindow.evaluate(async () => {
            const reply = await window.nestor.jobFinder.runAgentDiscovery();
            // The route answers with what changed; read the whole workspace.
            return {
              ...reply,
              snapshot: await window.nestor.jobFinder.getWorkspace(),
            };
          }),
        resetWorkspaceSnapshot,
      ),
    );
  } finally {
    activeWindow = await resolveUsableWindow(app, activeWindow);
    await restoreWorkspaceSnapshot(activeWindow, resetWorkspaceSnapshot);
  }

  const snapshot = result.value?.snapshot ?? result.value ?? null;
  const effectiveTargetRoles = Array.isArray(
    snapshot?.searchPreferences?.targetRoles,
  )
    ? snapshot.searchPreferences.targetRoles
    : targetRoles;
  activeWindow = await resolveUsableWindow(app, activeWindow);

  return {
    window: activeWindow,
    entry: {
      scenario: "search_jobs:run_all",
      targets: targets.map((target) => ({
        id: target.id,
        label: target.label,
        startingUrl: target.startingUrl,
      })),
      targetRoles: effectiveTargetRoles,
      wallClockMs: result.wallClockMs,
      ok: result.ok,
      error: result.error,
      result: result.value,
    },
  };
}

async function runRunAllScenario(targets) {
  const targetRoles = [
    ...new Set(targets.flatMap((target) => target.benchmarkTargetRoles)),
  ];
  const fixture = useCurrentWorkspace ? null : await loadFixture();
  return runSingleScenario({
    scenario: "search_jobs:run_all",
    targets,
    targetRoles,
    seededInput: useCurrentWorkspace
      ? null
      : {
          profile: fixture.profile,
          searchPreferences: buildSearchPreferences(
            fixture.searchPreferences,
            targets,
            targetRoles,
          ),
          settings: buildSettings(fixture.settings),
        },
    runner: async (window) =>
      window.evaluate(async () => {
        const reply = await window.nestor.jobFinder.runAgentDiscovery();
        // The route answers with what changed; read the whole workspace.
        return {
          ...reply,
          snapshot: await window.nestor.jobFinder.getWorkspace(),
        };
      }),
    scopeCurrentWorkspaceTargets: true,
  });
}

function printScenarioSummary(entry) {
  const durationSeconds = (entry.wallClockMs / 1000).toFixed(1);
  process.stdout.write(
    `\n[${entry.scenario}] ${entry.ok ? "ok" : "failed"} in ${durationSeconds}s\n`,
  );
  if (entry.error) {
    process.stdout.write(`error: ${entry.error}\n`);
    return;
  }

  if (entry.scenario.startsWith("check_source:")) {
    const summary = buildSourceDebugSummary(entry.result);
    process.stdout.write(
      `runState: ${summary?.runState ?? "unknown"} | instructionStatus: ${summary?.targetInstructionStatus ?? "unknown"} | attempts: ${summary?.attemptCount ?? "n/a"}\n`,
    );
    process.stdout.write(`finalSummary: ${summary?.finalSummary ?? "none"}\n`);
    return;
  }

  const summary = buildDiscoverySummary(entry.result);
  process.stdout.write(
    `runState: ${summary?.runState ?? "unknown"} | validJobsFound: ${summary?.summary?.validJobsFound ?? "n/a"} | jobsPersisted: ${summary?.summary?.jobsPersisted ?? "n/a"} | jobsStaged: ${summary?.summary?.jobsStaged ?? "n/a"}\n`,
  );
}

async function main() {
  const requestedSingleTargetIds = parseCsv(
    readCliOption("--targets") ?? process.env.BENCHMARK_TARGET_IDS,
  );
  const requestedRunAllTargetIds = parseCsv(
    readCliOption("--run-all-targets") ??
      process.env.BENCHMARK_RUN_ALL_TARGET_IDS,
  );
  let singleTargets = pickTargets(requestedSingleTargetIds, [
    "target_linkedin_default",
    "target_kosovajob_home",
  ]);
  let runAllTargets = pickTargets(requestedRunAllTargetIds, [
    "target_linkedin_default",
    "target_greenhouse_remote",
    "target_lever_aircall",
    "target_kosovajob_home",
  ]);

  if (!useCurrentWorkspace && singleTargets.length === 0) {
    throw new Error("No benchmark targets were selected.");
  }

  await mkdir(outputDir, { recursive: true });
  const results = [];
  let currentWorkspaceApp = null;
  let currentWorkspaceWindow = null;

  try {
    if (useCurrentWorkspace) {
      currentWorkspaceApp = await electron.launch({
        args: ["."],
        cwd: desktopDir,
        env: {
          ...process.env,
          NESTOR_ENABLE_TEST_API: "1",
          NESTOR_TEST_API_USE_LIVE_AI: "1",
        },
      });

      currentWorkspaceWindow = await currentWorkspaceApp.firstWindow();
      await currentWorkspaceWindow.waitForLoadState("domcontentloaded");
      await waitForJobFinderBridge(currentWorkspaceWindow);
      const resolved = await resolveCurrentWorkspaceTargets(
        currentWorkspaceWindow,
        requestedSingleTargetIds,
        requestedRunAllTargetIds,
      );
      singleTargets = resolved.singleTargets;
      runAllTargets = resolved.runAllTargets;
      process.stdout.write(
        `Using current workspace targets: ${resolved.availableTargets.map((target) => `${target.id} (${target.label})`).join(", ")}\n`,
      );
      process.stdout.write(
        `Single-target scenarios: ${singleTargets.map((target) => target.id).join(", ")}\n`,
      );
      process.stdout.write(
        `Run-all scenarios will use enabled targets: ${runAllTargets.map((target) => target.id).join(", ")}\n`,
      );
    }

    for (const target of singleTargets) {
      if (
        useCurrentWorkspace &&
        currentWorkspaceApp &&
        currentWorkspaceWindow
      ) {
        const pairRun = await runCurrentWorkspaceSingleTargetBenchmarkPair(
          currentWorkspaceApp,
          currentWorkspaceWindow,
          target,
        );
        currentWorkspaceWindow = pairRun.window;
        results.push(...pairRun.results);
      } else {
        const pairResults = await runSingleTargetBenchmarkPair(target);
        results.push(...pairResults);
      }
    }

    if (runAllTargets.length > 0) {
      if (
        useCurrentWorkspace &&
        currentWorkspaceApp &&
        currentWorkspaceWindow
      ) {
        const runAll = await runCurrentWorkspaceRunAllScenario(
          currentWorkspaceApp,
          currentWorkspaceWindow,
          runAllTargets,
        );
        currentWorkspaceWindow = runAll.window;
        printScenarioSummary(runAll.entry);
        results.push({
          ...runAll.entry,
          discovery: buildDiscoverySummary(runAll.entry.result),
        });
      } else {
        const runAllResult = await runRunAllScenario(runAllTargets);
        printScenarioSummary(runAllResult);
        results.push({
          ...runAllResult,
          discovery: buildDiscoverySummary(runAllResult.result),
        });
      }
    }
  } finally {
    if (currentWorkspaceApp) {
      await currentWorkspaceApp.close().catch(() => undefined);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    invocation: "electron_preload_bridge",
    notes: [
      "These benchmarks run through the desktop Electron app and preload bridge, not the older service-only 013 harness.",
      ...(useCurrentWorkspace
        ? [
            "Desktop test API is enabled for current-workspace reuse, with live AI/runtime forced through NESTOR_TEST_API_USE_LIVE_AI.",
          ]
        : [
            "Desktop test API is intentionally not enabled here so the configured live AI/runtime path remains active.",
          ]),
      ...(useCurrentWorkspace
        ? [
            "This run reused the current persisted workspace and browser profile instead of a seeded temporary workspace.",
          ]
        : ["This run used a seeded temporary workspace for isolation."]),
    ],
    useCurrentWorkspace,
    browserAgentEnabled: process.env.NESTOR_BROWSER_AGENT ?? "(default=true)",
    browserAgentEnabledEffective: resolveBrowserAgentEnabledEffective(),
    browserHeadless: process.env.NESTOR_BROWSER_HEADLESS ?? "(default=false)",
    browserHeadlessEffective: isEnabled(process.env.NESTOR_BROWSER_HEADLESS),
    outputLabel,
    results,
  };
  const reportPath = path.join(
    outputDir,
    "job-finder-app-benchmark-report.json",
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`\nSaved app benchmark report to ${reportPath}\n`);
}

main().catch((error) => {
  console.error("Uncaught error in main:", error);
  process.exitCode = 1;
});
