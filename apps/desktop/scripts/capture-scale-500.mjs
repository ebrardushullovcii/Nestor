import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import {
  ACCEPTANCE_VERSION,
  acceptanceEnvironment,
  assertFileRenderer,
  assertPrepareOnly,
  assertViewportEvidence,
  attachProcessOutput,
  cleanupDirectory,
  digestSeed,
  ensureFreshOutputDir,
  finalizeProcessOutput,
  loadAcceptanceContext,
  makeIsolatedUserDataDirectory,
  installPrepareOnlySafetyProbe,
  resolvePrimaryRunError,
  resolveStartupBrowserWindow,
  screenshotMetadata,
  verifyAcceptanceArtifacts,
} from "./release-acceptance-harness.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const acceptance = loadAcceptanceContext("scale");
const outputDir = acceptance.outputDir;
const screenshotDir = path.resolve(outputDir, "screenshots");
const viewportNormal = { width: 1440, height: 920, zoomFactor: 1 };
const viewportNative125 = { width: 1440, height: 920, zoomFactor: 1.25 };
const viewportMinimum = { width: 1024, height: 768, zoomFactor: 1 };
// At >=1440 CSS px the sidebar owns every destination inline: the journey, both
// "Everything else" groups, and the trailing keyboard-shortcuts entry. There is
// no sidebar More trigger to open, so the wide layout is proven by the rows
// themselves rather than by a popover.
const WIDE_SIDEBAR_DESTINATIONS = Object.freeze([
  "Home",
  "Profile",
  "Find jobs",
  "Shortlisted",
  "Applications",
  "Companies",
  "Outcomes",
  "Search plans",
  "Resume approaches",
  "Safeguards",
  "Settings",
  "Keyboard shortcuts",
]);
const PLANNING_SETTINGS_MENU_DESTINATIONS = Object.freeze([
  "Search plans",
  "Resume approaches",
  "Settings",
]);
// Local selector/limit tokens for the compact-navigation runtime evidence.
// The static validator parses these markers from this file's source text; it
// must not import this module because importing would execute the capture
// harness. The shortcut table no longer lives inside the More menu: the menu
// carries one footer entry that opens the shortcuts dialog, so there is no
// collapsed/expanded height mode left to assert.
const COMPACT_NAVIGATION_EVIDENCE_TOKENS = Object.freeze({
  selectors: Object.freeze({
    navigation: 'nav[aria-label="Job Finder sections"]',
    panel: "[data-job-finder-compact-navigation]",
    scroller: "[data-job-finder-compact-navigation-scroll]",
    content: "[data-job-finder-compact-navigation-content]",
    fadeStart: "[data-job-finder-compact-navigation-fade-start]",
    fadeEnd: "[data-job-finder-compact-navigation-fade-end]",
    planningButton: 'button[aria-label^="More"]',
    liveAssistantLink: 'a[aria-label="Open Live Assistant"]',
    notificationsGroup:
      '[role="group"][aria-label="Notifications and actions"]',
    windowControlsGroup: '[role="group"][aria-label="Window controls"]',
    planningMenu: '[role="navigation"][aria-label="More"]',
    planningMenuScrollRegion: "[data-job-finder-more-menu-scroll-region]",
    shortcutsMenuEntry: "[data-job-finder-more-menu-shortcuts-entry]",
    shortcutsDialog: "[data-job-finder-shortcuts-dialog]",
    shortcutsDialogRow: "[data-job-finder-shortcut-row]",
  }),
  viewportEpsilonPx: 2,
  containmentEpsilonPx: 2,
  edgeFadeEpsilonPx: 1,
  overlapTolerancePx: 1,
  // Fail-closed floors for compact route-strip geometry. The stale
  // [1120,1440) shell-grid regime collapsed this strip to ~8px at native
  // 125% zoom (physical 1440x920 -> CSS 1152x736); a healthy strip keeps
  // hundreds of px of usable width and full-height route buttons.
  minUsableRouteStripWidthPx: 320,
  minRouteChipHeightPx: 32,
});
const CANONICAL_ROUTE_DEFINITIONS = Object.freeze([
  {
    id: "profile",
    route: "/job-finder/profile",
    label: "Profile",
    heading: "Your profile",
    surface: "profile",
  },
  {
    id: "findJobs",
    route: "/job-finder/discovery",
    label: "Find jobs",
    heading: "Find jobs",
    surface: "findJobs",
  },
  {
    id: "shortlisted",
    route: "/job-finder/review-queue",
    label: "Shortlisted",
    heading: "Shortlisted",
    surface: "shortlisted",
  },
  {
    id: "applications",
    route: "/job-finder/applications",
    label: "Applications",
    heading: "Applications",
    surface: "applications",
  },
]);
// Canonical accepted scale evidence measured a 1,780.86 ms cold usable shell
// and a 307.42 ms worst warm route switch. Keep a hard margin without hiding
// regressions in the user's reported 1–2 second navigation lag.
const CANONICAL_LATENCY_BUDGETS = Object.freeze({
  coldToUsableShellMs: 2_000,
  warmRouteSwitchMs: 500,
});
// Scale axis: discovery jobs prove production volume through real Electron
// bootstrap, SQLite persistence, hydration, IPC, and rendering. Every other
// paged collection intentionally stays exactly at the historical 1,001-record
// boundary so the prior silent-cap guard survives instead of every collection
// blindly multiplying with the job axis.
const priorCapBoundaryCount = 1_001;
const requiredJobCount = 5_000;
const counts = {
  jobs: requiredJobCount,
  shortlisted: priorCapBoundaryCount,
  applications: priorCapBoundaryCount,
  sources: priorCapBoundaryCount,
};
const routeCycles = 3;
// Renderer pagination checks must stay bounded as the job axis grows: the
// sampled discovery walk exhaustively verifies fixed head pages plus the
// final boundary page, reached through a hard-capped Next-click budget.
// Growth beyond this budget fails loudly instead of silently walking an
// unbounded number of rendered pages.
const MAX_PAGINATION_FAST_FORWARD_CLICKS = 200;
const REVIEW_QUEUE_DRAFT_PREPARATION_LIMIT = 10;

const report = {
  startedAt: new Date().toISOString(),
  pass: false,
  outputDir,
  screenshotDir,
  acceptance: {
    version: ACCEPTANCE_VERSION,
    manifestPath: acceptance.manifestPath,
    runDir: acceptance.runDir,
    sourceFingerprint: acceptance.manifest.source?.afterBuild?.digest ?? null,
    buildArtifactFingerprint: acceptance.manifest.artifacts?.digest ?? null,
    seedDigest: acceptance.seedDigest,
  },
  syntheticData: counts,
  scaleBoundary: {
    priorSilentCap: 1_000,
    priorCapBoundaryCount,
    requiredJobCount,
  },
  viewports: [viewportNormal, viewportNative125, viewportMinimum],
  routeCycles,
  requiredScenarioCompletionIds: [
    "scale-bootstrap",
    "scale-find-jobs-pagination",
    "scale-shortlisted-pagination",
    "scale-applications-pagination",
    "scale-profile-sources-pagination",
    "scale-rapid-review-pagination",
    "scale-review-queue-batch-actions",
    "scale-sidebar-1440",
    "scale-planning-settings-native125",
    "scale-planning-settings-minimum-width",
    "scale-find-jobs-native125",
    "scale-minimum-width",
    "scale-applications-minimum-width",
  ],
  requiredCanonicalRoutes: CANONICAL_ROUTE_DEFINITIONS.map(({ id }) => id),
  scenarioCompletionIds: [],
  safety: {
    isolatedUserDataDir: null,
    syntheticCandidateDataOnly: true,
    browserAgentEnabled: false,
    applicationActionsExecuted: false,
    finalSubmissionClicked: false,
    submitAuthorized: false,
    accountCreationAuthorized: false,
  },
  startup: {},
  latencyBudgets: CANONICAL_LATENCY_BUDGETS,
  hydration: null,
  routeSwitches: [],
  pagination: {},
  screenshots: [],
  screenshotCollisions: [],
  verifications: {
    paginationFlexWrap: [],
    horizontalOverflow: [],
    dropdownClipping: [],
    navigation: {
      wideSidebar: {},
      compactPlanning: {},
      planningSettingsMenu: {},
      compactRail: {},
      compactActiveRoute: {},
      planningShortcutsMenu: {},
    },
  },
  memory: [],
  renderer: { longTaskSupported: null, samples: [] },
  runtimeErrors: [],
  safetyEvents: [],
  mainProcess: { pid: null, stdout: "", stderr: "" },
  processOwnership: {
    trackedProcesses: [],
    verifications: [],
    leftoverPids: [],
    verified: false,
  },
};
let activeBrowserWindow = null;
let activeViewport = null;
let processOutputState = null;
let scenarioSucceeded = false;
const processOutputStates = [];
const capturedScreenshotDigests = [];

// Pure collision detector: byte-identical screenshots cannot simultaneously
// evidence distinct visual states. A capture scenario may be a shared-shell
// assertion (for example, the wide-sidebar check on the profile surface), so
// screenshotStateId lets that assertion retain its own completion ID without
// pretending that it produced a different set of pixels.
function findScreenshotStateCollisions(entries) {
  const byDigest = new Map();
  for (const entry of entries) {
    if (!entry.digest || !entry.scenarioId || !entry.fileName) continue;
    const occurrences = byDigest.get(entry.digest) ?? [];
    occurrences.push({
      scenarioId: entry.scenarioId,
      screenshotStateId: entry.screenshotStateId ?? entry.scenarioId,
      fileName: entry.fileName,
    });
    byDigest.set(entry.digest, occurrences);
  }
  const collisions = [];
  for (const [digest, occurrences] of byDigest.entries()) {
    if (occurrences.length < 2) continue;
    const distinctScreenshotStateIds = [
      ...new Set(occurrences.map((entry) => entry.screenshotStateId)),
    ];
    if (distinctScreenshotStateIds.length < 2) continue;
    collisions.push({
      digest,
      occurrences,
      distinctScenarioIds: [
        ...new Set(occurrences.map((entry) => entry.scenarioId)),
      ],
      distinctScreenshotStateIds,
    });
  }
  return collisions;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function completeScenario(id) {
  if (!report.scenarioCompletionIds.includes(id))
    report.scenarioCompletionIds.push(id);
}

async function writeReport() {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

function describeTeardownFailure(error) {
  return error instanceof Error ? error.message : String(error);
}

// Terminal-error precedence after teardown: the resolved primary/finalization
// failure wins (resolvePrimaryRunError already folds finalization into the
// primary as its cause), then owned-process teardown, then isolated-directory
// cleanup, then report persistence itself.
function resolveScaleTerminalError(
  teardownFailure,
  ownershipError,
  cleanupError,
  persistenceError,
) {
  return (
    teardownFailure ??
    ownershipError ??
    (cleanupError
      ? new Error(
          `Unable to clean isolated user data directory: ${cleanupError}`,
        )
      : null) ??
    persistenceError ??
    null
  );
}

function sourceTargets(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `scale_source_${index + 1}`,
    label: `Synthetic source ${String(index + 1).padStart(3, "0")}`,
    startingUrl: `https://jobs.example.test/source/${index + 1}`,
    enabled: false,
    adapterKind: "auto",
    customInstructions: null,
    instructionStatus: "missing",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
  }));
}

function createScaleState(baseSnapshot) {
  const jobTemplate =
    baseSnapshot.discoveryJobs[0] ?? baseSnapshot.savedJobs?.[0];
  const applicationTemplate = baseSnapshot.applicationRecords[0] ?? {
    id: "scale_application_template",
    jobId: "scale_job_template",
    title: "Synthetic application",
    company: "Synthetic Company",
    status: "drafting",
    lastActionLabel: "Application prepared without submission",
    nextActionLabel: "Review final application",
    lastUpdatedAt: "2026-08-18T08:00:00.000Z",
    lastAttemptState: null,
    questionSummary: {},
    latestBlocker: null,
    consentSummary: {},
    replaySummary: {},
    events: [],
    crm: null,
  };
  const campaignTemplate = baseSnapshot.campaigns[0] ?? {
    id: "scale_campaign_template",
    name: "Synthetic campaign",
    description: "",
    mode: "scale",
    status: "active",
    createdAt: "2026-08-18T08:00:00.000Z",
    updatedAt: "2026-08-18T08:00:00.000Z",
    searchPreferences: structuredClone(baseSnapshot.searchPreferences),
    sourceTargetIds: [],
    jobIds: [],
    minimumFitScore: null,
    limits: {
      retainedJobTarget: 1000,
      analysisConcurrency: 4,
      preparationBatchSize: 50,
      dailyPreparationLimit: 500,
    },
    stopRules: {
      pauseOnLoginRequired: true,
      pauseOnChangedForm: true,
      pauseOnUncertainEligibility: true,
      pauseOnFailureRatePercent: 20,
      failureRateMinimumSample: 5,
    },
    applicationPolicy: {
      resumeStrategy: "job_family_variants",
      defaultResumeStrategyId: null,
      requireReviewBeforePreparation: true,
      requireReviewBeforeExternalWrite: true,
      finalSubmitAuthorized: false,
      qualityReviewSampleRatio: 0.2,
      simultaneousApplicationWindowDays: 1,
    },
    rules: [],
    schedule: {},
    latestDigest: null,
    progress: { lastUpdatedAt: "2026-08-18T08:00:00.000Z" },
    history: [],
  };
  assert(
    jobTemplate,
    "The demo workspace did not provide a saved-job template.",
  );

  const targets = sourceTargets(counts.sources);
  const jobs = Array.from({ length: counts.jobs }, (_, index) => {
    const ordinal = index + 1;
    const id = `scale_job_${String(ordinal).padStart(4, "0")}`;
    const target = targets[index % targets.length];
    const status =
      index < counts.shortlisted ? "ready_for_review" : "discovered";
    return {
      ...structuredClone(jobTemplate),
      id,
      sourceJobId: `scale_source_job_${ordinal}`,
      canonicalUrl: `https://jobs.example.test/roles/${ordinal}`,
      applicationUrl: `https://jobs.example.test/roles/${ordinal}/apply`,
      title: `Senior Platform Engineer ${String(ordinal).padStart(3, "0")}`,
      company: `Synthetic Company ${index % 50}`,
      location: index % 2 === 0 ? "Remote" : "Prishtina, Kosovo",
      status,
      discoveredAt: "2026-08-18T08:00:00.000Z",
      firstSeenAt: "2026-08-18T08:00:00.000Z",
      lastSeenAt: "2026-08-18T08:00:00.000Z",
      lastVerifiedActiveAt: "2026-08-18T08:00:00.000Z",
      summary: "Synthetic scale-probe job; no external listing is opened.",
      description: "Synthetic scale-probe description.",
      matchAssessment: {
        ...jobTemplate.matchAssessment,
        score: 60 + (index % 40),
      },
      provenance: [
        {
          ...structuredClone(jobTemplate.provenance[0]),
          targetId: target.id,
          startingUrl: target.startingUrl,
          adapterKind: "auto",
          discoveredAt: "2026-08-18T08:00:00.000Z",
        },
      ],
      keywordSignals: jobTemplate.keywordSignals.map((signal, signalIndex) => ({
        ...signal,
        id: `scale_signal_${ordinal}_${signalIndex}`,
      })),
    };
  });

  const applicationRecords = Array.from(
    { length: counts.applications },
    (_, index) => {
      // Keep the Applications scale axis distinct from the Shortlisted axis.
      // Jobs already in Applications are intentionally excluded from the new
      // all-jobs row, so reusing the first 1,001 jobs would leave no Shortlisted
      // action to verify.
      const job = jobs[counts.shortlisted + index];
      return {
        ...structuredClone(applicationTemplate),
        id: `scale_application_${index + 1}`,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: "drafting",
        lastActionLabel: "Application prepared without submission",
        nextActionLabel: "Review final application",
        lastUpdatedAt: "2026-08-18T08:00:00.000Z",
        lastAttemptState: null,
      };
    },
  );

  const campaign = {
    ...structuredClone(campaignTemplate),
    name: "Synthetic scale probe 500",
    jobIds: jobs.map((job) => job.id),
    sourceTargetIds: targets.map((target) => target.id),
    applicationPolicy: {
      ...campaignTemplate.applicationPolicy,
      requireReviewBeforeExternalWrite: true,
      finalSubmitAuthorized: false,
    },
  };

  return {
    ...structuredClone(baseSnapshot),
    savedJobs: jobs,
    applicationRecords,
    applicationAttempts: [],
    applyRuns: [],
    applyJobResults: [],
    userActionRequests: [],
    userActionEvents: [],
    searchPreferences: {
      ...structuredClone(baseSnapshot.searchPreferences),
      discovery: {
        ...structuredClone(baseSnapshot.searchPreferences.discovery),
        targets,
      },
    },
    campaigns: [campaign],
    activeCampaignId: campaign.id,
  };
}

async function sampleProcessMemory(pid) {
  if (process.platform !== "win32" || !Number.isInteger(pid))
    return { available: false, reason: "windows-process-sample-unavailable" };
  const command = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{pid=$p.Id; name=$p.ProcessName; workingSetBytes=$p.WorkingSet64; privateBytes=$p.PrivateMemorySize64} | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true },
    );
    const value = JSON.parse(stdout.trim());
    return {
      available: true,
      pid: Number(value.pid),
      name: value.name,
      workingSetBytes: Number(value.workingSetBytes),
      privateBytes: Number(value.privateBytes),
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// Force-stops an Electron main process and waits for its real exit event,
// preserving the strict Windows taskkill /T /F semantics while remaining
// functional on POSIX runners. Waiting for the exit is mandatory: SQLite/WAL
// files must be released before the cold launch or directory cleanup starts.
async function forceStopElectronProcess(processHandle) {
  const pid = processHandle?.pid;
  if (!pid) return false;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } else {
    try {
      processHandle.kill("SIGTERM");
    } catch {
      // The process can vanish before the signal lands; the exit race below decides the outcome.
    }
    const exited = await Promise.race([
      new Promise((resolve) => processHandle.once("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_500)),
    ]);
    if (!exited) {
      try {
        processHandle.kill("SIGKILL");
      } catch {
        // A process that already exited cannot be signaled again; the exit wait below still resolves.
      }
    }
  }
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => processHandle.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  return true;
}

// On macOS the Electron binary prints the Node SQLite experimental warning
// with the capitalized process title, leaving the trace-warnings hint line
// unmatched by the harness's canonical accepted-warning strip. Accept only
// that exact hint line; every other stderr byte still fails the run.
const ACCEPTED_SCALE_STDERR_PATTERNS = [
  {
    name: "node-sqlite-experimental-trace-hint-electron-title",
    pattern:
      /\(Use `Electron --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/g,
  },
  {
    // Benign, deterministic teardown notice from Playwright's inspector-based
    // Electron transport on POSIX. Only the exact full line is accepted.
    name: "playwright-inspector-disconnect-notice",
    pattern: /^Waiting for the debugger to disconnect\.\.\.\r?\n/gm,
  },
];

// Read-only snapshot of the OS process table. It is used exclusively to prove
// teardown of Electron trees this capture launched: enumeration is anchored to
// PIDs recorded while those trees were alive, and nothing is ever signaled or
// killed through these queries.
async function readProcessTable() {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim() || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      command: String(row.CommandLine ?? ""),
    }));
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-axww", "-o", "pid=,ppid=,command="],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
      return match
        ? {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            command: match[3],
          }
        : null;
    })
    .filter((row) => row !== null);
}

function descendantPidsFromTable(table, rootPid) {
  const childrenByParent = new Map();
  for (const row of table) {
    const siblings = childrenByParent.get(row.parentPid);
    if (siblings) siblings.push(row.pid);
    else childrenByParent.set(row.parentPid, [row.pid]);
  }
  const descendants = [];
  const pending = [rootPid];
  const seen = new Set([rootPid]);
  while (pending.length > 0) {
    const pid = pending.pop();
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      descendants.push(childPid);
      pending.push(childPid);
    }
  }
  return descendants;
}

// Ownership ledger for every Electron process this capture launched. Identities
// (exact command lines) are snapshotted while the tree is still alive so a
// recycled PID cannot mask a leftover.
function createOwnedProcessLedger() {
  const tracked = new Map();
  return {
    track(pid, role, command) {
      if (!Number.isInteger(pid)) return;
      tracked.set(pid, { pid, role, command });
    },
    entries() {
      return [...tracked.values()];
    },
  };
}

async function snapshotOwnedProcessTree(ledger, rootPid, role) {
  const table = await readProcessTable();
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const rootRow = byPid.get(rootPid);
  if (!rootRow)
    throw new Error(
      `Tracked ${role} root pid ${rootPid} vanished before its process tree could be snapshotted.`,
    );
  ledger.track(rootPid, `${role}:root`, rootRow.command);
  for (const pid of descendantPidsFromTable(table, rootPid)) {
    const row = byPid.get(pid);
    if (row) ledger.track(pid, `${role}:descendant`, row.command);
  }
}

// Fails closed: every tracked PID must be absent from a fresh process-table
// read. A live PID counts as a leftover unless its exact command line changed,
// which proves the PID was recycled by an unrelated process.
async function verifyZeroLeftoverOwnedProcesses(ledger, label) {
  const startedAt = performance.now();
  const deadline = startedAt + 10_000;
  let leftover = [];
  let enumerationError = null;
  let attempts = 0;
  while (performance.now() <= deadline) {
    attempts += 1;
    leftover = [];
    enumerationError = null;
    try {
      const table = await readProcessTable();
      const byPid = new Map(table.map((row) => [row.pid, row]));
      for (const entry of ledger.entries()) {
        const row = byPid.get(entry.pid);
        if (!row) continue;
        if (entry.command === "" || row.command === entry.command)
          leftover.push({
            pid: entry.pid,
            role: entry.role,
            command: row.command,
          });
      }
    } catch (error) {
      enumerationError = error instanceof Error ? error.message : String(error);
    }
    if (enumerationError === null && leftover.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    label,
    trackedProcessCount: ledger.entries().length,
    attempts,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    verified: enumerationError === null && leftover.length === 0,
    enumerationError,
    leftoverPids: leftover.map((entry) => entry.pid),
    leftoverDetail: leftover.slice(0, 5),
  };
}

async function installRendererProbe(page) {
  await page.evaluate(() => {
    if (globalThis.__productionScaleProbe) return;
    const state = {
      longTaskSupported: false,
      longTasks: [],
      heartbeatTicks: 0,
      maxHeartbeatGapMs: 0,
      lastHeartbeatAt: performance.now(),
    };
    globalThis.__productionScaleProbe = state;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          state.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
      });
      observer.observe({ type: "longtask", buffered: true });
      state.longTaskSupported = true;
    } catch {
      state.longTaskSupported = false;
    }
    window.setInterval(() => {
      const now = performance.now();
      state.heartbeatTicks += 1;
      state.maxHeartbeatGapMs = Math.max(
        state.maxHeartbeatGapMs,
        now - state.lastHeartbeatAt,
      );
      state.lastHeartbeatAt = now;
    }, 16);
  });
}

async function readRendererProbe(page) {
  return page.evaluate(() => {
    const state = globalThis.__productionScaleProbe;
    return state
      ? {
          longTaskSupported: state.longTaskSupported,
          longTaskCount: state.longTasks.length,
          longTaskTotalMs: state.longTasks.reduce((t, e) => t + e.duration, 0),
          maxLongTaskMs: Math.max(0, ...state.longTasks.map((e) => e.duration)),
          heartbeatTicks: state.heartbeatTicks,
          maxHeartbeatGapMs: state.maxHeartbeatGapMs,
        }
      : null;
  });
}

async function readJobFinderTimingMarks(page) {
  return page.evaluate(() =>
    performance
      .getEntriesByType("mark")
      .filter(
        (entry) =>
          entry.name.startsWith("job-finder:") ||
          entry.name.startsWith("acceptance-"),
      )
      .map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
        duration: entry.duration,
      })),
  );
}

async function readSurface(page, route, paginationLabel = null) {
  return page.evaluate(
    ({ surface, paginationLabel: expectedPaginationLabel }) => {
      const rowSelector = {
        profile:
          '[data-job-sources-library] [aria-label="Configured job sources"] > li',
        findJobs:
          '[aria-labelledby="discovery-job-results-heading"] [data-collection-item-id]',
        shortlisted: "[data-collection-item-id]",
        applications: '[aria-label="Applications"] [data-collection-item-id]',
        rapidReview: 'ul[aria-label="Jobs to review"] > li',
      }[surface];
      const rows = rowSelector
        ? Array.from(document.querySelectorAll(rowSelector))
        : [];
      const selectedCollectionIds = Array.from(
        document.querySelectorAll(
          '[data-collection-item-id][aria-current="true"]',
        ),
      ).map((e) => e.getAttribute("data-collection-item-id"));
      const selectedApplicationButtons = Array.from(
        document.querySelectorAll(
          'ul[aria-label="Applications"] button[aria-current="true"]',
        ),
      ).map((e) => e.getAttribute("aria-label"));
      const pagination = Array.from(document.querySelectorAll("nav")).find(
        (el) => {
          const label = el.getAttribute("aria-label") ?? "";
          return expectedPaginationLabel
            ? label === expectedPaginationLabel
            : /pagination|pages/i.test(label);
        },
      );
      return {
        hash: window.location.hash,
        mountedRows: rows.length,
        rowIds: rows
          .map((r) => r.getAttribute("data-collection-item-id"))
          .filter(Boolean),
        selectedCollectionIds,
        selectedApplicationButtons,
        paginationLabel: pagination?.getAttribute("aria-label") ?? null,
        paginationText:
          pagination?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        paginationButtons: pagination
          ? Array.from(pagination.querySelectorAll("button")).map((b) => ({
              label: b.textContent?.trim() ?? "",
              disabled: b.disabled,
            }))
          : [],
        sourceStatus:
          document
            .querySelector('[data-job-sources-library] [role="status"]')
            ?.textContent?.replace(/\s+/g, " ")
            .trim() ?? null,
      };
    },
    { surface: route, paginationLabel },
  );
}

async function waitForHeading(
  page,
  heading,
  timingMark = null,
  expectedRoute = null,
) {
  try {
    return await page.evaluate(
      ({ expectedHeading, timingMark: startMark, expectedRoute, timeoutMs }) =>
        new Promise((resolve, reject) => {
          if (startMark) performance.mark(startMark);
          const startTime = performance.now();
          let frameId = null;
          let timeoutId = null;
          let settled = false;
          let observer = null;

          const findVisibleHeading = () =>
            Array.from(document.querySelectorAll("h1")).find((candidate) => {
              if (!(candidate instanceof HTMLElement)) return false;
              const style = getComputedStyle(candidate);
              const bounds = candidate.getBoundingClientRect();
              return (
                (expectedRoute === null ||
                  window.location.hash === `#${expectedRoute}`) &&
                candidate.textContent?.trim() === expectedHeading &&
                candidate.getClientRects().length > 0 &&
                bounds.width > 0 &&
                bounds.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden"
              );
            }) ?? null;

          const cleanup = () => {
            observer?.disconnect();
            if (frameId !== null) cancelAnimationFrame(frameId);
            if (timeoutId !== null) clearTimeout(timeoutId);
            frameId = null;
            timeoutId = null;
          };

          const finish = (headingElement) => {
            if (settled) return;
            settled = true;
            const observedAt = performance.now();
            const endMark = startMark ? `${startMark}-heading-visible` : null;
            if (endMark) performance.mark(endMark);
            const feedbackEntry = startMark
              ? performance
                  .getEntriesByName(
                    `job-finder:route:${expectedRoute}:feedback-committed`,
                    "mark",
                  )
                  .filter((entry) => entry.startTime >= startTime)
                  .at(0)
              : null;
            cleanup();
            resolve({
              startTime,
              endTime: observedAt,
              elapsedMs: observedAt - startTime,
              headingText: headingElement.textContent?.trim() ?? null,
              headingTagName: headingElement.tagName,
              observedRoute: window.location.hash,
              expectedRoute,
              exactVisibleH1:
                headingElement.tagName === "H1" &&
                headingElement.textContent?.trim() === expectedHeading,
              measurementSource: "renderer-heading-readiness",
              observerMechanism: "MutationObserver+requestAnimationFrame",
              feedbackDurationMs: feedbackEntry
                ? feedbackEntry.startTime - startTime
                : null,
            });
          };

          const fail = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(
              new Error(
                `Renderer heading readiness timed out after ${timeoutMs} ms for exact h1 ${JSON.stringify(expectedHeading)}.`,
              ),
            );
          };

          const check = () => {
            if (settled) return;
            const headingElement = findVisibleHeading();
            if (headingElement) {
              finish(headingElement);
              return;
            }
            frameId = requestAnimationFrame(() => {
              frameId = null;
              check();
            });
          };

          observer = new MutationObserver(check);
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["class", "style", "hidden", "aria-hidden"],
          });
          timeoutId = setTimeout(fail, timeoutMs);
          check();
        }),
      {
        expectedHeading: heading,
        timingMark,
        expectedRoute,
        timeoutMs: 15_000,
      },
    );
  } catch (error) {
    try {
      report.routeDebug = await page.evaluate(() => ({
        href: window.location.href,
        readyState: document.readyState,
        bodyText: document.body.innerText.slice(0, 4000),
        headings: Array.from(document.querySelectorAll("h1,h2"))
          .map((e) => ({ tag: e.tagName, text: e.textContent?.trim() ?? "" }))
          .slice(0, 20),
        mainText:
          document.querySelector("main")?.textContent?.slice(0, 3000) ?? null,
      }));
    } catch (debugError) {
      report.routeDebug = {
        unavailable:
          debugError instanceof Error ? debugError.message : String(debugError),
      };
    }
    throw error;
  }
}

async function waitForWorkspaceHydrationComplete(page, timeout = 30_000) {
  await page.waitForFunction(
    async () => {
      const workspace = await window.nestor?.jobFinder?.getWorkspace?.();
      return workspace?.hydration?.phase === "complete";
    },
    undefined,
    { timeout },
  );
}

async function navigateHash(page, route, heading) {
  await page.evaluate((nextRoute) => {
    window.location.hash = `#${nextRoute}`;
  }, route);
  await waitForHeading(page, heading, null, route);
  await page.waitForTimeout(60);
}

async function switchRoute(page, definition, memoryPid) {
  const beforeProbe = await readRendererProbe(page);
  const navigationName = await page.evaluate(() =>
    window.innerWidth >= 1440
      ? "Job Finder sidebar destinations"
      : "Job Finder sections",
  );
  const button = page
    .getByRole("navigation", { name: navigationName })
    .getByRole("button", { name: new RegExp(`^${definition.label}(?:\\s|$)`) });
  await button.waitFor({ state: "visible", timeout: 10_000 });
  const timingMark = `acceptance-route-start-${report.routeSwitches.length + 1}`;
  const headingReady = waitForHeading(
    page,
    definition.heading,
    timingMark,
    definition.route,
  );
  const [, headingReadiness] = await Promise.all([
    button.click({ timeout: 10_000 }),
    headingReady,
  ]);
  const headingObservedLatencyMs = headingReadiness.elapsedMs;
  const rendererTiming = {
    start: headingReadiness.startTime,
    end: headingReadiness.endTime,
    durationMs: headingReadiness.elapsedMs,
    feedbackDurationMs: headingReadiness.feedbackDurationMs,
    headingText: headingReadiness.headingText,
    headingTagName: headingReadiness.headingTagName,
    observedRoute: headingReadiness.observedRoute,
    expectedRoute: headingReadiness.expectedRoute,
    measurementSource: headingReadiness.measurementSource,
    observerMechanism: headingReadiness.observerMechanism,
    exactVisibleH1: headingReadiness.exactVisibleH1,
  };
  const latencyMs = rendererTiming.durationMs;
  assert(
    headingReadiness.exactVisibleH1 === true &&
      headingReadiness.headingText === definition.heading &&
      headingReadiness.headingTagName === "H1" &&
      headingReadiness.expectedRoute === definition.route &&
      headingReadiness.observedRoute === `#${definition.route}`,
    `${definition.label}: renderer readiness did not observe the exact visible destination h1 and route ${JSON.stringify(headingReadiness)}.`,
  );
  assert(
    Number.isFinite(headingObservedLatencyMs) &&
      Number.isFinite(rendererTiming.durationMs) &&
      Number.isFinite(latencyMs),
    `${definition.label}: route switch did not produce finite timing evidence ${JSON.stringify({ headingObservedLatencyMs, rendererTiming, latencyMs })}`,
  );
  if (rendererTiming.feedbackDurationMs !== null)
    assert(
      Number.isFinite(rendererTiming.feedbackDurationMs),
      `${definition.label}: renderer feedback timing was not finite.`,
    );
  // The route is usable when its heading is visible. Keep a short settling
  // period for the later layout/memory probes, but do not charge that
  // deliberate evidence delay to the user-facing navigation budget.
  await page.waitForTimeout(60);
  assert(
    latencyMs <= CANONICAL_LATENCY_BUDGETS.warmRouteSwitchMs,
    `${definition.label}: warm route switch exceeded ${CANONICAL_LATENCY_BUDGETS.warmRouteSwitchMs} ms (${latencyMs.toFixed(2)} ms).`,
  );
  // Renderer feedback marks commit before the destination surface renders,
  // so they are optimistic and remain diagnostics only. The release gate is
  // the renderer-native external observation until the destination's exact
  // level-1 heading is visible.
  assert(
    headingObservedLatencyMs <= CANONICAL_LATENCY_BUDGETS.warmRouteSwitchMs,
    `${definition.label}: externally observed heading readiness exceeded ${CANONICAL_LATENCY_BUDGETS.warmRouteSwitchMs} ms (${headingObservedLatencyMs.toFixed(2)} ms; renderer feedback mark ${latencyMs.toFixed(2)} ms).`,
  );
  if (definition.surface === "shortlisted") {
    await page.waitForFunction(
      () => Boolean(document.querySelector("[data-collection-item-id]")),
      undefined,
      { timeout: 15_000 },
    );
  }
  const afterProbe = await readRendererProbe(page);
  const surface = await readSurface(page, definition.surface);
  const roundTripStartedAt = performance.now();
  await page.evaluate(() => document.visibilityState);
  const roundTripMs = performance.now() - roundTripStartedAt;
  const memory = await sampleProcessMemory(memoryPid);
  const selectedIds = surface.selectedCollectionIds.filter(Boolean);
  assert(
    selectedIds.every((id) => surface.rowIds.includes(id)),
    `${definition.label}: stale selected collection row is not mounted on the current route.`,
  );
  report.routeSwitches.push({
    cycle:
      Math.floor(
        report.routeSwitches.length / CANONICAL_ROUTE_DEFINITIONS.length,
      ) + 1,
    route: definition.id,
    latencyMs: Math.round(latencyMs * 100) / 100,
    headingObservedLatencyMs: Math.round(headingObservedLatencyMs * 100) / 100,
    rendererRoundTripMs: Math.round(roundTripMs * 100) / 100,
    mountedRows: surface.mountedRows,
    selectedCollectionIds: selectedIds,
    selectedApplicationButtons: surface.selectedApplicationButtons,
    longTaskCountDelta:
      afterProbe && beforeProbe
        ? afterProbe.longTaskCount - beforeProbe.longTaskCount
        : null,
    longTaskTotalDeltaMs:
      afterProbe && beforeProbe
        ? afterProbe.longTaskTotalMs - beforeProbe.longTaskTotalMs
        : null,
    maxHeartbeatGapMs: afterProbe?.maxHeartbeatGapMs ?? null,
    rendererTiming,
    memory,
  });
}

async function setViewportAndZoom(page, browserWindow, vp) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await browserWindow.evaluate((win, factor) => {
    win.webContents.setZoomFactor(factor);
  }, vp.zoomFactor);
  await page.waitForTimeout(300);
  activeViewport = vp;
}

async function captureScreenshot(page, name, meta = {}) {
  await mkdir(screenshotDir, { recursive: true });
  const fileName = `${String(report.screenshots.length + 1).padStart(2, "0")}-${name}.png`;
  const fullPath = path.join(screenshotDir, fileName);
  await page.screenshot({ path: fullPath, animations: "disabled" });
  const screenshot = await screenshotMetadata(
    page,
    activeBrowserWindow,
    fullPath,
    {
      viewport: activeViewport,
      seedDigest: acceptance.seedDigest,
      route: meta.route,
    },
  );
  assertViewportEvidence(screenshot.viewport, activeViewport);
  const navigation = await inspectNavigation(page);
  const failures = [];
  if (navigation.documentHorizontalOverflow > 0)
    failures.push(
      `document horizontal overflow ${navigation.documentHorizontalOverflow}`,
    );
  if ((navigation.mainHorizontalOverflow ?? 0) > 0)
    failures.push(
      `main horizontal overflow ${navigation.mainHorizontalOverflow}`,
    );
  if (meta.expectWideSidebar && !navigation.wideSidebar.pass)
    failures.push(
      `1440 sidebar does not list every destination inline with its own scroll owner ${JSON.stringify(navigation.wideSidebar)}`,
    );
  if (meta.expectCompactPlanningButton && !navigation.compactPlanning.pass)
    failures.push(
      `compact More navigation missing ${JSON.stringify(navigation.compactPlanning)}`,
    );
  if (meta.expectPlanningSettingsMenu && !navigation.planningSettingsMenu.pass)
    failures.push(
      `More menu is not inside the viewport with required destinations ${JSON.stringify(navigation.planningSettingsMenu)}`,
    );
  if (
    meta.expectPlanningSettingsKeyboard &&
    meta.planningSettingsKeyboard?.pass !== true
  )
    failures.push(
      `More menu is not keyboard reachable ${JSON.stringify(meta.planningSettingsKeyboard)}`,
    );
  if (meta.expectRoute && screenshot.route !== meta.expectRoute)
    failures.push(
      `observed route ${screenshot.route} does not match expected ${meta.expectRoute}`,
    );
  if (screenshot.clickablePointEvidence.pass !== true)
    failures.push(
      `interactive controls have no unobscured clickable point: ${JSON.stringify(screenshot.clickablePointEvidence.failures)}`,
    );
  const digestEntry = {
    digest: screenshot.screenshot?.sha256 ?? null,
    scenarioId: meta.scenarioId ?? name,
    screenshotStateId: meta.screenshotStateId ?? meta.scenarioId ?? name,
    fileName,
  };
  capturedScreenshotDigests.push(digestEntry);
  const collisions = findScreenshotStateCollisions(capturedScreenshotDigests);
  if (collisions.length > 0) {
    report.screenshotCollisions = collisions;
    await writeReport();
    throw new Error(
      `Byte-identical screenshots claim distinct semantic states: ${JSON.stringify(collisions.slice(0, 5))}`,
    );
  }
  const insideViewport = failures.length === 0;
  const entry = {
    fileName,
    fullPath,
    scenarioId: meta.scenarioId ?? name,
    route: screenshot.route,
    seedDigest: screenshot.seedDigest,
    viewportMetadata: screenshot.viewport,
    screenshot: screenshot.screenshot,
    clickablePointEvidence: screenshot.clickablePointEvidence,
    ...meta,
    navigation,
    insideViewport,
    noClip: insideViewport,
    failures,
    pass: failures.length === 0,
    capturedAt: new Date().toISOString(),
  };
  report.screenshots.push(entry);
  completeScenario(entry.scenarioId);
  await writeReport();
  return entry;
}

async function checkHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("main");
    const docOverflow = Math.max(
      0,
      document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    const mainOverflow =
      main instanceof HTMLElement
        ? Math.max(0, main.scrollWidth - main.clientWidth)
        : null;
    const bodyOverflow = Math.max(
      0,
      document.body.scrollWidth - document.body.clientWidth,
    );
    return {
      docOverflow,
      mainOverflow,
      bodyOverflow,
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    };
  });
  const passed =
    overflow.docOverflow === 0 && (overflow.mainOverflow ?? 0) === 0;
  report.verifications.horizontalOverflow.push({ label, ...overflow, passed });
  assert(
    passed,
    `${label}: horizontal overflow detected doc=${overflow.docOverflow} main=${overflow.mainOverflow}`,
  );
  return overflow;
}

async function checkPaginationFlexWrap(page, label) {
  const flexChecks = await page.evaluate(() => {
    const navs = Array.from(
      document.querySelectorAll(
        'nav[aria-label*="pagination" i], nav[aria-label*="pages" i], nav[aria-label="Job result pages"]',
      ),
    );
    return navs.map((nav) => {
      const style = getComputedStyle(nav);
      return {
        label: nav.getAttribute("aria-label"),
        flexWrap: style.flexWrap,
        display: style.display,
        className: nav.className,
        rect: nav.getBoundingClientRect().toJSON
          ? {
              width: Math.round(nav.getBoundingClientRect().width),
              height: Math.round(nav.getBoundingClientRect().height),
            }
          : null,
      };
    });
  });
  for (const check of flexChecks) {
    const passed = check.flexWrap === "wrap";
    report.verifications.paginationFlexWrap.push({
      label,
      navLabel: check.label,
      flexWrap: check.flexWrap,
      passed,
      className: check.className,
    });
    // Only enforce if pagination is present; Job sources pagination uses flex without wrap in current code - verify it doesn't overflow instead
    // For collection-pagination and job-results-pagination we expect wrap. Allow profile sources to be non-wrap but must not overflow.
    if (
      check.label &&
      /pagination/i.test(check.label) &&
      check.label !== "Job source pages"
    ) {
      assert(
        passed,
        `${label}: pagination ${check.label} flex-wrap is ${check.flexWrap} expected wrap`,
      );
    }
  }
  // Additional check: ensure pagination nav itself does not overflow viewport
  const overflowCheck = await page.evaluate(() => {
    const nav = document.querySelector(
      'nav[aria-label*="pagination" i], nav[aria-label="Job result pages"]',
    );
    if (!nav) return null;
    const rect = nav.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      innerWidth: window.innerWidth,
      overflows: rect.right > window.innerWidth + 2 || rect.left < -2,
    };
  });
  if (overflowCheck)
    assert(
      !overflowCheck.overflows,
      `${label}: pagination nav overflows viewport ${JSON.stringify(overflowCheck)}`,
    );
  return flexChecks;
}

async function checkDropdownsNotClipped(page, label) {
  const dropdowns = await page.evaluate(() => {
    const selectors = [
      '[data-slot="select-trigger"]',
      "select",
      '[role="combobox"]',
      '[aria-haspopup="listbox"]',
      '[aria-haspopup="menu"]',
      "button[aria-expanded]",
    ];
    const elements = Array.from(document.querySelectorAll(selectors.join(",")));
    return elements
      .filter((el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          ariaLabel: el.getAttribute("aria-label"),
          text: el.textContent?.slice(0, 80)?.replace(/\s+/g, " ").trim(),
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          clipped:
            rect.left < -2 ||
            rect.right > window.innerWidth + 2 ||
            rect.top < -2 ||
            rect.bottom > window.innerHeight + 2,
          overflow: style.overflow,
        };
      });
  });
  const clipped = dropdowns.filter((d) => d.clipped);
  report.verifications.dropdownClipping.push({
    label,
    totalDropdowns: dropdowns.length,
    clippedCount: clipped.length,
    clipped,
    all: dropdowns.slice(0, 10),
  });
  // Dropdowns vertically below viewport are scrollable and expected; only horizontal clipping is a failure.
  const innerWidth = await page.evaluate(() => window.innerWidth);
  const bad = dropdowns.filter(
    (d) => d.rect.left < -2 || d.rect.right > innerWidth + 5,
  );
  assert(
    bad.length === 0,
    `${label}: dropdowns horizontally clipped ${JSON.stringify(bad.slice(0, 3))}`,
  );
  return dropdowns;
}

async function inspectNavigation(page) {
  return page.evaluate(
    ({ wideSidebarDestinations, planningSettingsDestinations }) => {
      const rendered = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const textLabel = (element) =>
        element.getAttribute("aria-label") ??
        element.textContent?.replace(/\s+/g, " ").trim() ??
        element.tagName.toLowerCase();
      const inside = (rect) =>
        Boolean(
          rect &&
          rect.left >= -1 &&
          rect.right <= window.innerWidth + 1 &&
          rect.top >= -1 &&
          rect.bottom <= window.innerHeight + 1,
        );
      const sidebar = document.querySelector("[data-job-finder-sidebar]");
      const sidebarNavigation = sidebar?.querySelector(
        'nav[aria-label="Job Finder sidebar destinations"]',
      );
      const sidebarButtons = sidebarNavigation
        ? Array.from(sidebarNavigation.querySelectorAll("button")).filter(
            (button) => rendered(button),
          )
        : [];
      const sidebarLabels = sidebarButtons.map(textLabel);
      const sidebarRect = sidebar?.getBoundingClientRect() ?? null;
      const wideSidebar = {
        exists: sidebar instanceof HTMLElement,
        visible: rendered(sidebar),
        insideViewport: inside(sidebarRect),
        horizontalOverflow:
          sidebar instanceof HTMLElement
            ? Math.max(0, sidebar.scrollWidth - sidebar.clientWidth)
            : null,
        horizontalOverflowSuppressed:
          sidebar instanceof HTMLElement
            ? ["hidden", "clip"].includes(getComputedStyle(sidebar).overflowX)
            : false,
        labels: sidebarLabels,
        requiredLabels: wideSidebarDestinations,
        requiredDestinationsVisible: wideSidebarDestinations.every((label) =>
          sidebarLabels.some((sidebarLabel) => sidebarLabel.startsWith(label)),
        ),
        // A dropdown inside a persistent navigation column only added a click:
        // the sidebar must expose no More trigger at all at this width.
        moreTriggerCount: sidebarNavigation
          ? sidebarNavigation.querySelectorAll(
              '[data-job-finder-sidebar-more], button[aria-label^="More"]',
            ).length
          : null,
        shortcutsEntryCount: sidebarNavigation
          ? sidebarNavigation.querySelectorAll(
              "[data-job-finder-sidebar-shortcuts-entry]",
            ).length
          : null,
        // The rail owns its own vertical scrolling, so a short window scrolls
        // the destination list instead of clipping it.
        scrollOwner: (() => {
          const region = sidebar?.querySelector(
            "[data-job-finder-sidebar-scroll-region]",
          );
          if (!(region instanceof HTMLElement)) return null;
          const style = getComputedStyle(region);
          const asideStyle =
            sidebar instanceof HTMLElement ? getComputedStyle(sidebar) : null;
          return {
            asideOverflowY: asideStyle?.overflowY ?? null,
            regionOverflowY: style.overflowY,
            regionScrollable: region.scrollHeight > region.clientHeight + 2,
            clientHeight: region.clientHeight,
            scrollHeight: region.scrollHeight,
            togglePinned: Boolean(
              sidebar?.querySelector("[data-job-finder-sidebar-toggle]") &&
              !region.querySelector("[data-job-finder-sidebar-toggle]"),
            ),
          };
        })(),
        rect: sidebarRect
          ? {
              left: Math.round(sidebarRect.left),
              top: Math.round(sidebarRect.top),
              right: Math.round(sidebarRect.right),
              bottom: Math.round(sidebarRect.bottom),
            }
          : null,
      };
      wideSidebar.pass = Boolean(
        wideSidebar.visible &&
        wideSidebar.insideViewport &&
        wideSidebar.horizontalOverflowSuppressed &&
        wideSidebar.requiredDestinationsVisible &&
        wideSidebar.moreTriggerCount === 0 &&
        wideSidebar.shortcutsEntryCount === 1 &&
        wideSidebar.scrollOwner &&
        /(auto|scroll)/.test(wideSidebar.scrollOwner.regionOverflowY) &&
        ["hidden", "clip"].includes(wideSidebar.scrollOwner.asideOverflowY) &&
        wideSidebar.scrollOwner.togglePinned,
      );

      const compactNavigation = document.querySelector(
        'nav[aria-label="Job Finder sections"]',
      );
      const planningButton = document.querySelector(
        'button[aria-label^="More"]',
      );
      const compactPlanning = {
        navigationVisible: rendered(compactNavigation),
        buttonVisible: rendered(planningButton),
        sidebarHidden: !wideSidebar.visible,
      };
      compactPlanning.pass =
        compactPlanning.navigationVisible &&
        compactPlanning.buttonVisible &&
        compactPlanning.sidebarHidden;

      const menu = document.querySelector(
        '[role="navigation"][aria-label="More"]',
      );
      const menuRect = menu?.getBoundingClientRect() ?? null;
      const menuStyle = menu ? getComputedStyle(menu) : null;
      const menuScrollable = Boolean(
        menu &&
        (menu.scrollHeight > menu.clientHeight + 2 ||
          (menuStyle && /(auto|scroll)/.test(menuStyle.overflowY))),
      );
      const menuItems = menu
        ? Array.from(menu.querySelectorAll("button")).map((item) => {
            const itemRect = item.getBoundingClientRect();
            const itemVisible = rendered(item);
            return {
              label:
                item.getAttribute("aria-label") ??
                item.textContent?.replace(/\s+/g, " ").trim() ??
                "",
              visible: itemVisible,
              withinViewport: inside(itemRect),
              reachable: itemVisible && (inside(itemRect) || menuScrollable),
              tabIndex: item.getAttribute("tabindex"),
            };
          })
        : [];
      const planningSettingsMenu = {
        exists: menu instanceof HTMLElement,
        visible: rendered(menu),
        rect: menuRect
          ? {
              left: Math.round(menuRect.left),
              top: Math.round(menuRect.top),
              right: Math.round(menuRect.right),
              bottom: Math.round(menuRect.bottom),
              width: Math.round(menuRect.width),
              height: Math.round(menuRect.height),
            }
          : null,
        menuScrollable,
        labels: menuItems.map((item) => item.label),
        requiredLabels: planningSettingsDestinations,
        requiredDestinationsVisible: planningSettingsDestinations.every(
          (label) => menuItems.some((item) => item.label === label),
        ),
        items: menuItems,
        horizontallyInside: inside(menuRect)
          ? true
          : Boolean(
              menuRect &&
              menuRect.left >= -1 &&
              menuRect.right <= window.innerWidth + 1,
            ),
        verticallyInside: Boolean(
          menuRect && menuRect.top >= -1 && menuRect.top < window.innerHeight,
        ),
      };
      planningSettingsMenu.insideViewport = Boolean(
        planningSettingsMenu.visible &&
        planningSettingsMenu.horizontallyInside &&
        planningSettingsMenu.verticallyInside &&
        menuRect &&
        (menuRect.bottom <= window.innerHeight + 1 || menuScrollable) &&
        menuItems.every((item) => item.reachable),
      );
      planningSettingsMenu.pass = Boolean(
        planningSettingsMenu.insideViewport &&
        planningSettingsMenu.requiredDestinationsVisible,
      );
      const documentHorizontalOverflow = Math.max(
        0,
        document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      const main = document.querySelector("main");
      const mainHorizontalOverflow =
        main instanceof HTMLElement
          ? Math.max(0, main.scrollWidth - main.clientWidth)
          : null;
      return {
        documentHorizontalOverflow,
        mainHorizontalOverflow,
        wideSidebar,
        compactPlanning,
        planningSettingsMenu,
      };
    },
    {
      wideSidebarDestinations: WIDE_SIDEBAR_DESTINATIONS,
      planningSettingsDestinations: PLANNING_SETTINGS_MENU_DESTINATIONS,
    },
  );
}

function rectInsideViewport(rect, viewport, epsilonPx) {
  return Boolean(
    rect &&
    rect.left >= -epsilonPx &&
    rect.top >= -epsilonPx &&
    rect.right <= viewport.width + epsilonPx &&
    rect.bottom <= viewport.height + epsilonPx,
  );
}

// Overlap means a real area intersection, not border adjacency; the tolerance
// absorbs 1px rounding so touching clusters never count as overlapping.
function rectsOverlap(left, right, tolerancePx) {
  if (!left || !right) return false;
  const width =
    Math.min(left.right, right.right) - Math.max(left.left, right.left);
  const height =
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
  return width > tolerancePx && height > tolerancePx;
}

async function inspectCompactNavigationRail(page) {
  return page.evaluate(
    ({ selectors, containmentEpsilonPx }) => {
      const describe = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          present:
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number.parseFloat(style.opacity || "1") > 0 &&
            rect.width > 0 &&
            rect.height > 0,
          rect: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
        };
      };
      const query = (selector) => document.querySelector(selector);
      const navigation = describe(query(selectors.navigation));
      const panel = describe(query(selectors.panel));
      const scrollerElement = query(selectors.scroller);
      const scrollerDescribe = describe(scrollerElement);
      const scrollerRect = scrollerElement?.getBoundingClientRect() ?? null;
      const scrollerStyle =
        scrollerElement instanceof HTMLElement
          ? getComputedStyle(scrollerElement)
          : null;
      const scrollWidth = scrollerElement?.scrollWidth ?? null;
      const clientWidth = scrollerElement?.clientWidth ?? null;
      const clientHeight = scrollerElement?.clientHeight ?? null;
      const offsetWidth = scrollerElement?.offsetWidth ?? null;
      const offsetHeight = scrollerElement?.offsetHeight ?? null;
      const scrollLeft = scrollerElement?.scrollLeft ?? null;
      const maxScrollLeft =
        scrollWidth !== null && clientWidth !== null
          ? scrollWidth - clientWidth
          : null;
      const contentScrollWidth = query(selectors.content)?.scrollWidth ?? null;
      const scroller = {
        ...scrollerDescribe,
        exists: scrollerElement instanceof HTMLElement,
        scrollWidth,
        clientWidth,
        clientHeight,
        offsetWidth,
        offsetHeight,
        scrollLeft,
        maxScrollLeft,
        overflowPx: maxScrollLeft,
        contentScrollWidth,
        horizontalScrollbarThicknessPx:
          offsetHeight !== null && clientHeight !== null
            ? offsetHeight - clientHeight
            : null,
        verticalScrollbarThicknessPx:
          offsetWidth !== null && clientWidth !== null
            ? offsetWidth - clientWidth
            : null,
        computedScrollbarWidth: scrollerStyle?.scrollbarWidth ?? null,
        computedPaddingLeftPx: scrollerStyle
          ? Number.parseFloat(scrollerStyle.paddingLeft)
          : null,
        computedPaddingRightPx: scrollerStyle
          ? Number.parseFloat(scrollerStyle.paddingRight)
          : null,
        webkitScrollbarPseudoDisplay: scrollerStyle
          ? getComputedStyle(scrollerElement, "::-webkit-scrollbar").display
          : null,
      };
      const fadeState = (selector) => {
        const element = query(selector);
        if (!(element instanceof HTMLElement)) return null;
        const opacity = Number.parseFloat(
          getComputedStyle(element).opacity || "0",
        );
        return { opacity, visible: opacity > 0.5 };
      };
      const content = query(selectors.content);
      const chipElements = content
        ? Array.from(content.querySelectorAll(":scope > button"))
        : [];
      const classifyChip = (rect) => {
        if (!rect || !scrollerRect) return "unmeasured";
        const contained =
          rect.left >= scrollerRect.left - containmentEpsilonPx &&
          rect.right <= scrollerRect.right + containmentEpsilonPx &&
          rect.top >= scrollerRect.top - containmentEpsilonPx &&
          rect.bottom <= scrollerRect.bottom + containmentEpsilonPx;
        if (contained) return "contained";
        const outside =
          rect.right <= scrollerRect.left + containmentEpsilonPx ||
          rect.left >= scrollerRect.right - containmentEpsilonPx;
        return outside ? "outside" : "partial";
      };
      const chips = chipElements.map((chip, index) => {
        const described = describe(chip);
        return {
          index,
          label: chip.textContent?.replace(/\s+/g, " ").trim() ?? "",
          ariaCurrent: chip.getAttribute("aria-current"),
          classification: classifyChip(described?.rect ?? null),
          ...described,
        };
      });
      const activeChips = chips.filter((chip) => chip.ariaCurrent === "page");
      return {
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        navigation,
        panel,
        scroller,
        fades: {
          start: fadeState(selectors.fadeStart),
          end: fadeState(selectors.fadeEnd),
        },
        chips,
        activeChipCount: activeChips.length,
        activeChip: activeChips[0] ?? null,
        clusters: {
          panel,
          planningButton: describe(query(selectors.planningButton)),
          liveAssistantLink: describe(query(selectors.liveAssistantLink)),
          notificationsGroup: describe(query(selectors.notificationsGroup)),
          windowControlsGroup: describe(query(selectors.windowControlsGroup)),
        },
      };
    },
    {
      selectors: COMPACT_NAVIGATION_EVIDENCE_TOKENS.selectors,
      containmentEpsilonPx:
        COMPACT_NAVIGATION_EVIDENCE_TOKENS.containmentEpsilonPx,
    },
  );
}

// Fail-closed audit of the compact header clusters: every control cluster must
// sit inside the viewport and no two sibling clusters may intersect. Window
// controls are legitimately absent on macOS (native traffic lights), so their
// absence is only a failure on other platforms.
function auditCompactRailClusters(state, platform) {
  const failures = [];
  const epsilon = COMPACT_NAVIGATION_EVIDENCE_TOKENS.containmentEpsilonPx;
  const tolerance = COMPACT_NAVIGATION_EVIDENCE_TOKENS.overlapTolerancePx;
  const clusters = state.clusters;
  for (const name of ["panel", "planningButton", "notificationsGroup"]) {
    const cluster = clusters[name];
    if (!cluster?.present) {
      failures.push(`${name} is missing or not rendered`);
      continue;
    }
    if (!rectInsideViewport(cluster.rect, state.viewport, epsilon))
      failures.push(
        `${name} is not contained in the viewport: ${JSON.stringify(cluster.rect)}`,
      );
  }
  const liveAssistantLink = clusters.liveAssistantLink;
  if (state.viewport.width < 900) {
    if (!liveAssistantLink?.present)
      failures.push("liveAssistantLink is missing below 900px CSS width");
    else if (
      !rectInsideViewport(liveAssistantLink.rect, state.viewport, epsilon)
    )
      failures.push(
        `liveAssistantLink is not contained in the viewport: ${JSON.stringify(liveAssistantLink.rect)}`,
      );
  }
  const windowControls = clusters.windowControlsGroup;
  if (platform === "darwin") {
    if (
      windowControls?.present &&
      !rectInsideViewport(windowControls.rect, state.viewport, epsilon)
    )
      failures.push(
        `windowControlsGroup is not contained in the viewport: ${JSON.stringify(windowControls.rect)}`,
      );
  } else if (!windowControls?.present) {
    failures.push("windowControlsGroup is missing on a non-macOS platform");
  } else if (
    !rectInsideViewport(windowControls.rect, state.viewport, epsilon)
  ) {
    failures.push(
      `windowControlsGroup is not contained in the viewport: ${JSON.stringify(windowControls.rect)}`,
    );
  }
  const headerPairs = [
    ["panel", "notificationsGroup"],
    ["panel", "windowControlsGroup"],
    ["notificationsGroup", "windowControlsGroup"],
  ];
  for (const [leftName, rightName] of headerPairs) {
    const left = clusters[leftName];
    const right = clusters[rightName];
    if (
      left?.present &&
      right?.present &&
      rectsOverlap(left.rect, right.rect, tolerance)
    )
      failures.push(`${leftName} overlaps ${rightName}`);
  }
  const siblings = [
    ["routeScrollerBand", state.scroller.present ? state.scroller.rect : null],
    [
      "planningButton",
      clusters.planningButton?.present ? clusters.planningButton.rect : null,
    ],
  ];
  if (liveAssistantLink?.present)
    siblings.push(["liveAssistantLink", liveAssistantLink.rect]);
  for (let leftIndex = 0; leftIndex < siblings.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < siblings.length;
      rightIndex += 1
    ) {
      const [leftName, leftRect] = siblings[leftIndex];
      const [rightName, rightRect] = siblings[rightIndex];
      if (leftRect && rightRect && rectsOverlap(leftRect, rightRect, tolerance))
        failures.push(
          `${leftName} overlaps ${rightName} inside the compact panel`,
        );
    }
  }
  return failures;
}

async function verifyCompactNavigationRail(page, label, expectedCssViewport) {
  const tokens = COMPACT_NAVIGATION_EVIDENCE_TOKENS;
  const selectors = tokens.selectors;
  await page.locator(selectors.scroller).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const phases = {};
  const readPhase = async (phase) => {
    const state = await inspectCompactNavigationRail(page);
    phases[phase] = state;
    return state;
  };
  const resting = await readPhase("resting");
  assert(
    resting.navigation?.present === true,
    `${label}: compact sections navigation missing at CSS ${viewportLabel(resting.viewport)}: ${JSON.stringify(resting.navigation)}`,
  );
  assert(
    Math.abs(resting.viewport.width - expectedCssViewport.width) <=
      tokens.viewportEpsilonPx &&
      Math.abs(resting.viewport.height - expectedCssViewport.height) <=
        tokens.viewportEpsilonPx,
    `${label}: CSS viewport ${JSON.stringify(resting.viewport)} does not match expected ${JSON.stringify(expectedCssViewport)}`,
  );

  const assertScrollerEvidence = (state, phase) => {
    const scroller = state.scroller;
    assert(
      scroller.exists && scroller.present,
      `${label}/${phase}: compact route scroller missing`,
    );
    assert(
      scroller.horizontalScrollbarThicknessPx === 0 &&
        scroller.verticalScrollbarThicknessPx === 0,
      `${label}/${phase}: classic scrollbar consumes space h=${scroller.horizontalScrollbarThicknessPx}px v=${scroller.verticalScrollbarThicknessPx}px`,
    );
    assert(
      scroller.computedScrollbarWidth === "none" ||
        scroller.webkitScrollbarPseudoDisplay === "none",
      `${label}/${phase}: no scrollbar suppression mechanism active (${JSON.stringify({ computedScrollbarWidth: scroller.computedScrollbarWidth, webkitScrollbarPseudoDisplay: scroller.webkitScrollbarPseudoDisplay })})`,
    );
    // Padding-corrected content stability: the scroller's own horizontal
    // padding is part of its scrollable span, so scrollWidth must equal the
    // content span plus both paddings within rounding tolerance. The identity
    // holds for zero overflow and real overflow alike, and fails if any
    // measurement node or padding assumption drifts.
    const paddingPx =
      (scroller.computedPaddingLeftPx ?? 0) +
      (scroller.computedPaddingRightPx ?? 0);
    const contentSpanDeltaPx =
      scroller.contentScrollWidth === null
        ? null
        : scroller.scrollWidth - (scroller.contentScrollWidth + paddingPx);
    assert(
      scroller.clientWidth > 0 &&
        scroller.scrollWidth >= scroller.clientWidth &&
        contentSpanDeltaPx !== null &&
        Math.abs(contentSpanDeltaPx) <= tokens.containmentEpsilonPx,
      `${label}/${phase}: scroller overflow dimensions disagree with the padded chip content: ${JSON.stringify({ scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, contentScrollWidth: scroller.contentScrollWidth, paddingLeftPx: scroller.computedPaddingLeftPx, paddingRightPx: scroller.computedPaddingRightPx, contentSpanDeltaPx })}`,
    );
  };

  const assertFadeTruth = (state, phase) => {
    const { scroller, fades } = state;
    assert(
      fades.start && fades.end,
      `${label}/${phase}: edge fade elements missing`,
    );
    const expectedStart = scroller.scrollLeft > tokens.edgeFadeEpsilonPx;
    const expectedEnd =
      scroller.scrollLeft < scroller.maxScrollLeft - tokens.edgeFadeEpsilonPx;
    assert(
      fades.start.visible === expectedStart &&
        fades.end.visible === expectedEnd,
      `${label}/${phase}: fades do not match LTR overflow/position: ${JSON.stringify({ scrollLeft: scroller.scrollLeft, maxScrollLeft: scroller.maxScrollLeft, fadeStartVisible: fades.start.visible, fadeEndVisible: fades.end.visible, expectedStart, expectedEnd })}`,
    );
  };

  const assertChipIntegrity = (state, phase) => {
    assert(
      state.chips.length > 0,
      `${label}/${phase}: no route chips rendered in the compact scroller`,
    );
    const partial = state.chips.filter(
      (chip) => chip.classification === "partial",
    );
    // With zero LTR overflow every chip must be fully contained. With real
    // overflow a single chip may legitimately straddle an outer clip edge
    // mid-layout; it must then be provably an edge straddler and never the
    // active route.
    if (state.scroller.overflowPx <= tokens.edgeFadeEpsilonPx) {
      assert(
        partial.length === 0,
        `${label}/${phase}: route chips partially clipped without scroller overflow: ${JSON.stringify(partial.map((chip) => ({ label: chip.label, rect: chip.rect })))}`,
      );
    } else {
      assert(
        partial.length <= 1,
        `${label}/${phase}: more than one route chip partially clipped by the scroller edge: ${JSON.stringify(partial.map((chip) => ({ label: chip.label, rect: chip.rect })))}`,
      );
      const band = state.scroller.rect;
      for (const chip of partial) {
        const straddlesLeftEdge =
          band !== null &&
          chip.rect.left < band.left &&
          chip.rect.right > band.left;
        const straddlesRightEdge =
          band !== null &&
          chip.rect.left < band.right &&
          chip.rect.right > band.right;
        assert(
          straddlesLeftEdge || straddlesRightEdge,
          `${label}/${phase}: interior/non-edge partial route chip "${chip.label}": ${JSON.stringify({ rect: chip.rect, band })}`,
        );
      }
    }
    assert(
      !partial.some((chip) => chip.ariaCurrent === "page"),
      `${label}/${phase}: active route chip is partially clipped: ${JSON.stringify(partial.filter((chip) => chip.ariaCurrent === "page").map((chip) => ({ label: chip.label, rect: chip.rect })))}`,
    );
    assert(
      state.activeChipCount === 1 && state.activeChip,
      `${label}/${phase}: expected exactly one active route chip, got ${state.activeChipCount}`,
    );
    // The app guarantees the revealed route is visible wherever it left the
    // scroll position (resting/restored states, and any state without
    // overflow). scrolled-to-end/scrolled-to-start are harness-forced
    // diagnostic positions: there the active chip may legitimately sit fully
    // outside the band, so only partial clipping stays a failure — an outside
    // active chip in those phases is harness scroll, not app regression.
    const forcedDiagnosticPhase =
      phase === "scrolled-to-end" || phase === "scrolled-to-start";
    if (
      !forcedDiagnosticPhase ||
      state.scroller.overflowPx <= tokens.edgeFadeEpsilonPx
    ) {
      assert(
        state.activeChip.classification === "contained",
        `${label}/${phase}: active route chip "${state.activeChip.label}" is not fully contained in the scroller (${state.activeChip.classification}): ${JSON.stringify(state.activeChip.rect)}`,
      );
    } else {
      assert(
        state.activeChip.classification !== "partial",
        `${label}/${phase}: active route chip is partially clipped under harness-forced scroll: ${JSON.stringify(state.activeChip.rect)}`,
      );
    }
  };

  // Usable-width/full-button geometry floors: the compact strip must keep a
  // real usable width (never the ~8px collapse from the broken grid regime)
  // and every route button must render at its full pinned height.
  const assertUsableGeometry = (state, phase) => {
    const { scroller, chips } = state;
    assert(
      scroller.clientWidth !== null &&
        scroller.clientWidth >= tokens.minUsableRouteStripWidthPx,
      `${label}/${phase}: compact route strip lost its usable width (${scroller.clientWidth}px < ${tokens.minUsableRouteStripWidthPx}px floor): ${JSON.stringify({ viewport: state.viewport, clientWidth: scroller.clientWidth })}`,
    );
    const crushed = chips.filter((chip) => {
      const rect = chip.rect;
      return (
        !rect ||
        !Number.isFinite(rect.height) ||
        rect.height < tokens.minRouteChipHeightPx ||
        !(rect.width > 0)
      );
    });
    assert(
      crushed.length === 0,
      `${label}/${phase}: compact route buttons lost full-button geometry: ${JSON.stringify(crushed.map((chip) => ({ label: chip.label, rect: chip.rect })))}`,
    );
  };

  for (const [phase, state] of Object.entries(phases)) {
    assertScrollerEvidence(state, phase);
    assertFadeTruth(state, phase);
    assertChipIntegrity(state, phase);
    assertUsableGeometry(state, phase);
  }

  await page.evaluate(
    ({ selector }) => {
      document.querySelector(selector)?.scrollTo({
        left: Number.MAX_SAFE_INTEGER,
      });
    },
    { selector: selectors.scroller },
  );
  await page.waitForTimeout(150);
  const scrolledToEnd = await readPhase("scrolled-to-end");

  await page.evaluate(
    ({ selector }) => {
      document.querySelector(selector)?.scrollTo({ left: 0 });
    },
    { selector: selectors.scroller },
  );
  await page.waitForTimeout(150);
  const scrolledToStart = await readPhase("scrolled-to-start");

  for (const [phase, state] of Object.entries(phases)) {
    assertScrollerEvidence(state, phase);
    assertFadeTruth(state, phase);
    assertChipIntegrity(state, phase);
    assertUsableGeometry(state, phase);
  }

  const hasOverflow = resting.scroller.overflowPx > tokens.edgeFadeEpsilonPx;
  assert(
    scrolledToEnd.scroller.overflowPx === resting.scroller.overflowPx &&
      scrolledToStart.scroller.overflowPx === resting.scroller.overflowPx,
    `${label}: scroller overflow dimension drifted between scroll phases: ${JSON.stringify([resting.scroller.overflowPx, scrolledToEnd.scroller.overflowPx, scrolledToStart.scroller.overflowPx])}`,
  );
  if (hasOverflow) {
    assert(
      scrolledToEnd.scroller.scrollLeft >=
        scrolledToEnd.scroller.maxScrollLeft - 1 &&
        scrolledToEnd.fades.start.visible &&
        !scrolledToEnd.fades.end.visible,
      `${label}/scrolled-to-end: full LTR scroll did not flip the edge fades: ${JSON.stringify({ scrollLeft: scrolledToEnd.scroller.scrollLeft, maxScrollLeft: scrolledToEnd.scroller.maxScrollLeft, ...scrolledToEnd.fades })}`,
    );
    assert(
      scrolledToStart.scroller.scrollLeft <= 1 &&
        !scrolledToStart.fades.start.visible &&
        scrolledToStart.fades.end.visible,
      `${label}/scrolled-to-start: zero scroll position did not restore the edge fades: ${JSON.stringify({ scrollLeft: scrolledToStart.scroller.scrollLeft, ...scrolledToStart.fades })}`,
    );
  } else {
    for (const phase of ["resting", "scrolled-to-end", "scrolled-to-start"])
      assert(
        !phases[phase].fades.start.visible && !phases[phase].fades.end.visible,
        `${label}/${phase}: both edge fades must hide when the scroller has no LTR overflow`,
      );
  }

  await page.evaluate(
    ({ selector, scrollLeft }) => {
      document.querySelector(selector)?.scrollTo({ left: scrollLeft });
    },
    { selector: selectors.scroller, scrollLeft: resting.scroller.scrollLeft },
  );
  await page.waitForTimeout(120);
  const restored = await readPhase("restored");
  assertScrollerEvidence(restored, "restored");
  assertFadeTruth(restored, "restored");
  assertChipIntegrity(restored, "restored");
  assertUsableGeometry(restored, "restored");
  assert(
    Math.abs(restored.scroller.scrollLeft - resting.scroller.scrollLeft) <= 1,
    `${label}/restored: original scroll position was not recovered: ${JSON.stringify({ before: resting.scroller.scrollLeft, after: restored.scroller.scrollLeft })}`,
  );

  const clusterFailures = auditCompactRailClusters(resting, process.platform);
  assert(
    clusterFailures.length === 0,
    `${label}: compact header cluster containment/overlap failures: ${JSON.stringify(clusterFailures)}`,
  );

  report.verifications.navigation.compactRail[label] = {
    pass: true,
    expectedCssViewport,
    observedCssViewport: resting.viewport,
    scrollerOverflowPx: resting.scroller.overflowPx,
    contentStability: {
      scrollWidth: resting.scroller.scrollWidth,
      clientWidth: resting.scroller.clientWidth,
      contentScrollWidth: resting.scroller.contentScrollWidth,
      paddingLeftPx: resting.scroller.computedPaddingLeftPx,
      paddingRightPx: resting.scroller.computedPaddingRightPx,
      contentSpanDeltaPx:
        resting.scroller.contentScrollWidth === null
          ? null
          : resting.scroller.scrollWidth -
            (resting.scroller.contentScrollWidth +
              (resting.scroller.computedPaddingLeftPx ?? 0) +
              (resting.scroller.computedPaddingRightPx ?? 0)),
    },
    classicScrollbarThicknessPx: {
      horizontal: resting.scroller.horizontalScrollbarThicknessPx,
      vertical: resting.scroller.verticalScrollbarThicknessPx,
    },
    scrollbarSuppression: {
      computedScrollbarWidth: resting.scroller.computedScrollbarWidth,
      webkitScrollbarPseudoDisplay:
        resting.scroller.webkitScrollbarPseudoDisplay,
    },
    chipLabels: resting.chips.map((chip) => chip.label),
    activeChipLabel: resting.activeChip?.label ?? null,
    usableGeometry: {
      usableRouteStripWidthPx: resting.scroller.clientWidth,
      minUsableRouteStripWidthPx: tokens.minUsableRouteStripWidthPx,
      routeChipHeightsPx: resting.chips.map(
        (chip) => chip.rect?.height ?? null,
      ),
      minRouteChipHeightPx: tokens.minRouteChipHeightPx,
    },
    clusterAudit: { failures: clusterFailures },
    phases: Object.fromEntries(
      Object.entries(phases).map(([phase, state]) => [
        phase,
        {
          phaseKind:
            phase === "scrolled-to-end" || phase === "scrolled-to-start"
              ? "forced-diagnostic"
              : "app-reveal",
          scrollLeft: state.scroller.scrollLeft,
          maxScrollLeft: state.scroller.maxScrollLeft,
          fadeStartVisible: state.fades.start.visible,
          fadeEndVisible: state.fades.end.visible,
          chipClassifications: state.chips.map((chip) => ({
            label: chip.label,
            classification: chip.classification,
          })),
          activeChipClassification: state.activeChip?.classification ?? null,
        },
      ]),
    ),
  };
  return report.verifications.navigation.compactRail[label];
}

function viewportLabel(viewport) {
  return `${Math.round(viewport?.width ?? -1)}x${Math.round(viewport?.height ?? -1)}`;
}

// Small fail-closed active-route probe for the existing native-125 navigation
// points: the compact chip carrying aria-current="page" must be the expected
// route label (first span; badges are trailing siblings) and must be fully
// contained in the scroller band after layout settles. Read-only, so it never
// disturbs surrounding captures or route-switch contracts.
async function verifyCompactActiveRoute(page, config) {
  const { label, expectedLabel } = config;
  const tokens = COMPACT_NAVIGATION_EVIDENCE_TOKENS;
  await page.waitForFunction(
    ({ contentSelector, expected }) => {
      const chip = document.querySelector(
        `${contentSelector} > button[aria-current="page"]`,
      );
      return (
        chip instanceof HTMLButtonElement &&
        (chip.querySelector("span")?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim() === expected
      );
    },
    { contentSelector: tokens.selectors.content, expected: expectedLabel },
    { timeout: 10_000 },
  );
  const evidence = await page.evaluate(
    ({ contentSelector, scrollerSelector, containmentEpsilonPx }) => {
      const chip = document.querySelector(
        `${contentSelector} > button[aria-current="page"]`,
      );
      const scroller = document.querySelector(scrollerSelector);
      if (!(chip instanceof HTMLElement) || !(scroller instanceof HTMLElement))
        return null;
      const chipRect = chip.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      return {
        ariaCurrent: chip.getAttribute("aria-current"),
        observedLabel:
          (chip.querySelector("span")?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim() || null,
        contained:
          chipRect.left >= scrollerRect.left - containmentEpsilonPx &&
          chipRect.right <= scrollerRect.right + containmentEpsilonPx &&
          chipRect.top >= scrollerRect.top - containmentEpsilonPx &&
          chipRect.bottom <= scrollerRect.bottom + containmentEpsilonPx,
        chipRect: {
          left: chipRect.left,
          top: chipRect.top,
          right: chipRect.right,
          bottom: chipRect.bottom,
          width: chipRect.width,
          height: chipRect.height,
        },
        scrollerRect: {
          left: scrollerRect.left,
          top: scrollerRect.top,
          right: scrollerRect.right,
          bottom: scrollerRect.bottom,
          width: scrollerRect.width,
          height: scrollerRect.height,
        },
        scrollLeft: scroller.scrollLeft,
        overflowPx: scroller.scrollWidth - scroller.clientWidth,
      };
    },
    {
      contentSelector: tokens.selectors.content,
      scrollerSelector: tokens.selectors.scroller,
      containmentEpsilonPx: tokens.containmentEpsilonPx,
    },
  );
  assert(
    evidence !== null,
    `${label}: active route chip or compact scroller missing`,
  );
  assert(
    evidence.ariaCurrent === "page" && evidence.observedLabel === expectedLabel,
    `${label}: compact active-route label was ${JSON.stringify(evidence.observedLabel)} with aria-current=${JSON.stringify(evidence.ariaCurrent)}, expected exactly ${JSON.stringify(expectedLabel)}`,
  );
  assert(
    evidence.contained === true,
    `${label}: active route chip "${expectedLabel}" is not fully contained after layout settle: ${JSON.stringify({ chipRect: evidence.chipRect, scrollerRect: evidence.scrollerRect })}`,
  );
  report.verifications.navigation.compactActiveRoute[label] = {
    pass: true,
    expectedLabel,
    ...evidence,
  };
  return report.verifications.navigation.compactActiveRoute[label];
}

// Proves the More menu's keyboard-shortcuts affordance. The ~270px shortcut
// table used to live inside this menu and crowded out its own destinations; it
// now sits in a dedicated dialog reached from a single footer entry (and from
// `?`). The evidence therefore covers: exactly one entry, no shortcut table
// left in the menu, the entry as the terminal roving participant reachable
// with End, an unobstructed activation point inside the menu, Enter opening
// the dialog with its rows fully inside the viewport, and Escape restoring the
// menu-free state.
async function verifyPlanningShortcutsEvidence(page, config) {
  const { label, expectedCssViewport } = config;
  const tokens = COMPACT_NAVIGATION_EVIDENCE_TOKENS;
  const selectors = tokens.selectors;
  const planningButton = page.getByRole("button", {
    name: /^More/,
    exact: false,
  });
  await planningButton.waitFor({ state: "visible", timeout: 10_000 });
  await planningButton.click();
  const menu = page.getByRole("navigation", { name: "More" });
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () =>
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.closest(
        '[role="navigation"][aria-label="More"]',
      ) !== null,
    undefined,
    { timeout: 10_000 },
  );
  const menuGeometry = await page.evaluate(
    ({ menuSelector }) => {
      const menu = document.querySelector(menuSelector);
      if (!(menu instanceof HTMLElement)) return null;
      const rect = menu.getBoundingClientRect();
      return {
        maxHeightToken: menu.style.maxHeight ?? "",
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
      };
    },
    { menuSelector: selectors.planningMenu },
  );
  assert(menuGeometry !== null, `${label}: More menu geometry unavailable`);
  const maxHeightPx = Number.parseFloat(menuGeometry.maxHeightToken);
  assert(
    Number.isFinite(maxHeightPx) && maxHeightPx > 0,
    `${label}: More menu inline max-height token missing: ${JSON.stringify(menuGeometry)}`,
  );
  const evidence = await collectShortcutsEntryEvidence(page, label);

  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached", timeout: 5_000 });

  report.verifications.navigation.planningShortcutsMenu[label] = {
    pass: true,
    menuMaxHeightPx: maxHeightPx,
    cssViewport: expectedCssViewport,
    ...evidence,
  };
  return report.verifications.navigation.planningShortcutsMenu[label];
}

async function collectShortcutsEntryEvidence(page, label) {
  const tokens = COMPACT_NAVIGATION_EVIDENCE_TOKENS;
  const selectors = tokens.selectors;
  const entry = page.locator(selectors.shortcutsMenuEntry);
  assert(
    (await entry.count()) === 1,
    `${label}: More menu did not render exactly one keyboard-shortcuts entry`,
  );
  // The removed table is a regression, not a style question: reference
  // material inside this menu is what pushed the real destinations below the
  // fold.
  const residualTable = await page.evaluate(
    ({ menuSelector }) => {
      const menu = document.querySelector(menuSelector);
      if (!(menu instanceof HTMLElement))
        return { menuFound: false, kbdCount: 0 };
      return {
        menuFound: true,
        kbdCount: menu.querySelectorAll("kbd").length,
      };
    },
    { menuSelector: selectors.planningMenu },
  );
  assert(
    residualTable.menuFound && residualTable.kbdCount === 0,
    `${label}: shortcut keycaps are still rendered inside the More menu: ${JSON.stringify(residualTable)}`,
  );
  const initialState = await entry.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? null,
      tabIndex: element instanceof HTMLElement ? element.tabIndex : null,
      size: { width: rect.width, height: rect.height },
    };
  });
  assert(
    initialState.tag === "button" &&
      initialState.text !== null &&
      initialState.text.includes("Keyboard shortcuts"),
    `${label}: shortcuts entry is not a "Keyboard shortcuts" button: ${JSON.stringify(initialState)}`,
  );
  assert(
    initialState.size.width > 0 && initialState.size.height > 0,
    `${label}: shortcuts entry is not visible: ${JSON.stringify(initialState)}`,
  );
  const rovingOrder = await page.evaluate(
    ({ menuSelector }) => {
      const items = Array.from(
        document.querySelectorAll(`${menuSelector} [tabindex]`),
      );
      return {
        itemCount: items.length,
        terminalTag: items.at(-1)?.tagName.toLowerCase() ?? null,
        terminalText:
          items.at(-1)?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      };
    },
    { menuSelector: selectors.planningMenu },
  );
  assert(
    rovingOrder.itemCount > 1 &&
      rovingOrder.terminalTag === "button" &&
      (rovingOrder.terminalText ?? "").includes("Keyboard shortcuts"),
    `${label}: shortcuts entry is not the terminal roving participant: ${JSON.stringify(rovingOrder)}`,
  );
  await page.keyboard.press("End");
  await page.waitForFunction(
    ({ entrySelector }) =>
      document.activeElement === document.querySelector(entrySelector),
    { entrySelector: selectors.shortcutsMenuEntry },
    { timeout: 5_000 },
  );
  const rovingFocus = await page.evaluate(
    ({ entrySelector, menuSelector }) => {
      const entry = document.querySelector(entrySelector);
      const menu = document.querySelector(menuSelector);
      const items = Array.from(
        document.querySelectorAll(`${menuSelector} [tabindex]`),
      );
      const entryRect =
        entry instanceof HTMLElement ? entry.getBoundingClientRect() : null;
      const menuRect = menu?.getBoundingClientRect() ?? null;
      return {
        activeIsEntry: document.activeElement === entry,
        entryTabIndex: entry instanceof HTMLElement ? entry.tabIndex : null,
        screenItemTabIndexes: items
          .filter((item) => item !== entry)
          .map((item) => item.tabIndex),
        focusedEntryWithinMenu:
          entryRect !== null &&
          menuRect !== null &&
          entryRect.top >= menuRect.top - 1 &&
          entryRect.bottom <= menuRect.bottom + 1,
        entryRect:
          entryRect !== null
            ? {
                top: entryRect.top,
                bottom: entryRect.bottom,
                left: entryRect.left,
                right: entryRect.right,
              }
            : null,
      };
    },
    {
      entrySelector: selectors.shortcutsMenuEntry,
      menuSelector: selectors.planningMenu,
    },
  );
  assert(
    rovingFocus.activeIsEntry === true &&
      rovingFocus.entryTabIndex === 0 &&
      rovingFocus.screenItemTabIndexes.every((tabIndex) => tabIndex === -1),
    `${label}: End key did not move roving focus to the shortcuts entry: ${JSON.stringify(rovingFocus)}`,
  );
  assert(
    rovingFocus.focusedEntryWithinMenu,
    `${label}: focused shortcuts entry is clipped outside the More menu: ${JSON.stringify(rovingFocus.entryRect)}`,
  );
  const hitTest = await page.evaluate(
    ({ entrySelector }) => {
      const entry = document.querySelector(entrySelector);
      if (!(entry instanceof HTMLElement))
        return { blocked: true, hitDescriptor: "missing-entry" };
      const rect = entry.getBoundingClientRect();
      const point = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return {
        blocked: !(point === entry || entry.contains(point)),
        hitDescriptor:
          point === null
            ? "no-element-at-point"
            : `${point.tagName.toLowerCase()}${point.getAttribute("role") ? `[role="${point.getAttribute("role")}"]` : ""}`,
      };
    },
    { entrySelector: selectors.shortcutsMenuEntry },
  );
  assert(
    hitTest.blocked === false,
    `${label}: shortcuts entry activation is blocked by an overlay: ${JSON.stringify(hitTest)}`,
  );
  await page.keyboard.press("Enter");
  const dialog = page.locator(selectors.shortcutsDialog);
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  const dialogEvidence = await page.evaluate(
    ({ dialogSelector, rowSelector }) => {
      const dialog = document.querySelector(dialogSelector);
      if (!(dialog instanceof HTMLElement)) return null;
      const rows = Array.from(dialog.querySelectorAll(rowSelector));
      const dialogRect = dialog.getBoundingClientRect();
      return {
        role: dialog.getAttribute("role"),
        ariaModal: dialog.getAttribute("aria-modal"),
        rowCount: rows.length,
        kbdCount: dialog.querySelectorAll("kbd").length,
        rowLabels: rows.map(
          (row) => row.textContent?.replace(/\s+/g, " ").trim() ?? "",
        ),
        withinViewport:
          dialogRect.top >= -1 &&
          dialogRect.left >= -1 &&
          dialogRect.right <= window.innerWidth + 1 &&
          dialogRect.bottom <= window.innerHeight + 1,
        dialogRect: {
          top: dialogRect.top,
          bottom: dialogRect.bottom,
          left: dialogRect.left,
          right: dialogRect.right,
        },
      };
    },
    {
      dialogSelector: selectors.shortcutsDialog,
      rowSelector: selectors.shortcutsDialogRow,
    },
  );
  assert(
    dialogEvidence !== null,
    `${label}: shortcuts dialog became unavailable immediately after opening`,
  );
  assert(
    dialogEvidence.role === "dialog" && dialogEvidence.ariaModal === "true",
    `${label}: shortcuts dialog is not an aria-modal dialog: ${JSON.stringify(dialogEvidence)}`,
  );
  assert(
    dialogEvidence.rowCount >= 2 &&
      dialogEvidence.kbdCount >= dialogEvidence.rowCount,
    `${label}: shortcuts dialog did not render keycapped shortcut rows: ${JSON.stringify(dialogEvidence)}`,
  );
  assert(
    dialogEvidence.withinViewport,
    `${label}: shortcuts dialog is clipped outside the viewport: ${JSON.stringify(dialogEvidence.dialogRect)}`,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", timeout: 5_000 });
  return {
    entryHitTest: hitTest,
    rovingOrder,
    dialogRowLabels: dialogEvidence.rowLabels,
    escapeClosedDialog: true,
  };
}

function paginationVisitPlan(config) {
  const sampling = config.sampling;
  if (!sampling)
    return Array.from({ length: config.pageCount }, (_, index) => index + 1);
  const headPages = sampling.headPages.filter(
    (pageNumber) => pageNumber >= 1 && pageNumber <= config.pageCount,
  );
  const plan = [...headPages];
  if (!plan.includes(config.pageCount)) plan.push(config.pageCount);
  return [...new Set(plan)].sort((left, right) => left - right);
}

async function clickPaginationNextInPage(page, config) {
  const isFindJobs =
    config.id === "findJobs" || config.id === "findJobs-native125";
  const result = await page.evaluate(
    ({ paginationLabel, heading, isFindJobs }) => {
      const navigations = Array.from(document.querySelectorAll("nav")).filter(
        (candidate) =>
          candidate instanceof HTMLElement &&
          candidate.getAttribute("aria-label") === paginationLabel,
      );
      if (navigations.length !== 1) {
        return {
          ok: false,
          reason: `expected exactly one pagination navigation, found ${navigations.length}`,
        };
      }
      const navigation = navigations[0];
      const nextButtons = Array.from(
        navigation.querySelectorAll("button"),
      ).filter(
        (candidate) =>
          candidate instanceof HTMLButtonElement &&
          (candidate.getAttribute("aria-label") === "Next page" ||
            candidate.textContent?.replace(/\s+/g, " ").trim() === "Next"),
      );
      if (nextButtons.length !== 1) {
        return {
          ok: false,
          reason: `expected exactly one Next button, found ${nextButtons.length}`,
        };
      }
      const nextButton = nextButtons[0];
      if (nextButton.disabled) {
        return { ok: false, reason: "Next button is disabled" };
      }

      let geometry = null;
      if (isFindJobs) {
        const scrollAreas = Array.from(
          document.querySelectorAll("[data-locked-screen-scroll-area]"),
        ).filter((candidate) => candidate instanceof HTMLElement);
        if (scrollAreas.length !== 1) {
          return {
            ok: false,
            reason: `expected exactly one locked screen scroll area, found ${scrollAreas.length}`,
          };
        }
        const headings = Array.from(document.querySelectorAll("h1")).filter(
          (candidate) =>
            candidate instanceof HTMLElement &&
            candidate.textContent?.trim() === heading &&
            candidate.getClientRects().length > 0,
        );
        if (headings.length !== 1) {
          return {
            ok: false,
            reason: `expected exactly one visible ${JSON.stringify(heading)} h1, found ${headings.length}`,
          };
        }
        const headingRect = headings[0].getBoundingClientRect();
        geometry = {
          outerScrollTop: scrollAreas[0].scrollTop,
          findJobsH1: {
            left: headingRect.left,
            top: headingRect.top,
            right: headingRect.right,
            bottom: headingRect.bottom,
            width: headingRect.width,
            height: headingRect.height,
          },
        };
      }
      nextButton.click();
      return geometry
        ? { ok: true, reason: null, before: geometry }
        : { ok: true, reason: null };
    },
    {
      paginationLabel: config.paginationLabel,
      heading: config.heading,
      isFindJobs,
    },
  );
  assert(
    result.ok,
    `${config.id}: in-page pagination Next click failed: ${result.reason}.`,
  );
  if (isFindJobs) {
    assert(
      result.before && Number.isFinite(result.before.outerScrollTop),
      `${config.id}: in-page pagination click did not return pre-click scroll geometry evidence.`,
    );
    assert(
      result.before.findJobsH1,
      `${config.id}: in-page pagination click did not return pre-click Find Jobs H1 geometry evidence.`,
    );
  }
  return result;
}

async function waitForPaginationPage(page, config, pageNumber) {
  const expectedRows = config.expectedRows(pageNumber);
  const expectedText = config.expectedText(pageNumber);
  await page.waitForFunction(
    ({ surface, paginationLabel, expectedRows, expectedText }) => {
      const rowSelector = {
        profile:
          '[data-job-sources-library] [aria-label="Configured job sources"] > li',
        findJobs:
          '[aria-labelledby="discovery-job-results-heading"] [data-collection-item-id]',
        shortlisted: "[data-collection-item-id]",
        applications: 'ul[aria-label="Applications"] > li',
        rapidReview: 'ul[aria-label="Jobs to review"] > li',
      }[surface];
      const pagination = Array.from(document.querySelectorAll("nav")).find(
        (el) => el.getAttribute("aria-label") === paginationLabel,
      );
      return (
        document.querySelectorAll(rowSelector).length === expectedRows &&
        pagination?.textContent?.replace(/\s+/g, " ").includes(expectedText)
      );
    },
    {
      surface: config.surface,
      paginationLabel: config.paginationLabel,
      expectedRows,
      expectedText,
    },
    { timeout: 15_000 },
  );
}

async function readFindJobsPaginationGeometry(page) {
  return page.evaluate(() => {
    const outerScrollArea = document.querySelector(
      "[data-locked-screen-scroll-area]",
    );
    const findJobsH1 = Array.from(document.querySelectorAll("h1")).find(
      (candidate) =>
        candidate instanceof HTMLElement &&
        candidate.textContent?.trim() === "Find jobs" &&
        candidate.getClientRects().length > 0,
    );
    const headingRect = findJobsH1?.getBoundingClientRect() ?? null;
    return {
      outerScrollTop:
        outerScrollArea instanceof HTMLElement
          ? outerScrollArea.scrollTop
          : null,
      findJobsH1: headingRect
        ? {
            left: headingRect.left,
            top: headingRect.top,
            right: headingRect.right,
            bottom: headingRect.bottom,
            width: headingRect.width,
            height: headingRect.height,
          }
        : null,
    };
  });
}

function paginationGeometryDifferences(before, after) {
  const failures = [];
  if (
    !before ||
    !after ||
    !Number.isFinite(before.outerScrollTop) ||
    !Number.isFinite(after.outerScrollTop)
  ) {
    failures.push(
      "real outer [data-locked-screen-scroll-area] scrollTop is unavailable",
    );
  } else if (before.outerScrollTop !== after.outerScrollTop) {
    failures.push(
      `outer scrollTop changed from ${before.outerScrollTop} to ${after.outerScrollTop}`,
    );
  }
  if (!before?.findJobsH1 || !after?.findJobsH1) {
    failures.push("Find Jobs H1 geometry is unavailable");
  } else {
    for (const property of [
      "left",
      "top",
      "right",
      "bottom",
      "width",
      "height",
    ]) {
      if (before.findJobsH1[property] !== after.findJobsH1[property]) {
        failures.push(
          `Find Jobs H1 ${property} changed from ${before.findJobsH1[property]} to ${after.findJobsH1[property]}`,
        );
      }
    }
  }
  return failures;
}

function assertFindJobsPaginationGeometryStable(before, after, label) {
  const failures = paginationGeometryDifferences(before, after);
  assert(
    failures.length === 0,
    `${label}: pagination changed the outer scroll position or Find Jobs H1 geometry: ${JSON.stringify({ before, after, failures })}`,
  );
  return { before, after, failures, pass: true };
}

async function advancePagination(page, config, fromPage, toPage) {
  const clicks = toPage - fromPage;
  assert(
    clicks > 0 && clicks <= MAX_PAGINATION_FAST_FORWARD_CLICKS,
    `${config.id}: pagination advance from page ${fromPage} to ${toPage} exceeds the bounded fast-forward budget of ${MAX_PAGINATION_FAST_FORWARD_CLICKS} clicks.`,
  );
  let lastClickEvidence = null;
  for (let remaining = clicks; remaining > 0; remaining -= 1) {
    lastClickEvidence = await clickPaginationNextInPage(page, config);
    await waitForPaginationPage(
      page,
      config,
      fromPage + (clicks - remaining + 1),
    );
  }
  return lastClickEvidence;
}

async function assertPagination(page, config) {
  await navigateHash(page, config.route, config.heading);
  if (config.waitFor) await config.waitFor(page);
  const visitPlan = paginationVisitPlan(config);
  const pages = [];
  let findJobsPage1Geometry = null;
  let findJobsPage2Geometry = null;
  let paginationClickEvidence = null;
  let previousPageNumber = null;
  for (const pageNumber of visitPlan) {
    if (previousPageNumber !== null) {
      paginationClickEvidence = await advancePagination(
        page,
        config,
        previousPageNumber,
        pageNumber,
      );
    }
    previousPageNumber = pageNumber;
    if (config.screenshotOnPages?.includes(pageNumber)) {
      await checkHorizontalOverflow(
        page,
        `${config.id} page ${pageNumber} pre-check`,
      );
    }
    await waitForPaginationPage(page, config, pageNumber);
    if (config.assertPage) await config.assertPage(page, pageNumber);
    const paginationGeometry =
      config.id === "findJobs"
        ? await readFindJobsPaginationGeometry(page)
        : null;
    if (config.id === "findJobs" && pageNumber === 1)
      findJobsPage1Geometry = paginationGeometry;
    if (config.id === "findJobs" && pageNumber === 2) {
      findJobsPage2Geometry = paginationGeometry;
      assertFindJobsPaginationGeometryStable(
        paginationClickEvidence?.before ?? findJobsPage1Geometry,
        findJobsPage2Geometry,
        `${config.id} page 1 -> page 2`,
      );
    }
    const state = await readSurface(
      page,
      config.surface,
      config.paginationLabel,
    );
    assert(
      state.mountedRows === config.expectedRows(pageNumber),
      `${config.id} page ${pageNumber}: expected ${config.expectedRows(pageNumber)} mounted rows, got ${state.mountedRows}.`,
    );
    assert(
      state.paginationText?.includes(config.expectedText(pageNumber)),
      `${config.id} page ${pageNumber}: pagination text was ${state.paginationText}.`,
    );
    const next = state.paginationButtons.find((b) => b.label === "Next");
    const previous = state.paginationButtons.find(
      (b) => b.label === "Previous",
    );
    assert(next && previous, `${config.id}: pagination buttons are missing.`);
    assert(
      next.disabled === (pageNumber === config.pageCount),
      `${config.id} page ${pageNumber}: Next disabled incorrect.`,
    );
    assert(
      previous.disabled === (pageNumber === 1),
      `${config.id} page ${pageNumber}: Previous disabled incorrect.`,
    );
    pages.push({
      page: pageNumber,
      mountedRows: state.mountedRows,
      text: state.paginationText,
      nextDisabled: next.disabled,
      previousDisabled: previous.disabled,
      ...(paginationGeometry ? { paginationGeometry } : {}),
    });
    if (config.screenshotOnPages?.includes(pageNumber)) {
      await checkPaginationFlexWrap(page, `${config.id}-p${pageNumber}`);
      await checkHorizontalOverflow(page, `${config.id}-p${pageNumber}`);
      await checkDropdownsNotClipped(page, `${config.id}-p${pageNumber}`);
      await captureScreenshot(
        page,
        `${config.id}-p${pageNumber}-${(typeof page.viewportSize === "function" ? page.viewportSize()?.width : page.viewportSize?.width) ?? 1440}`,
        {
          scenarioId: config.scenarioId
            ? `${config.scenarioId}-page-${pageNumber}`
            : undefined,
          surface: config.id,
          page: pageNumber,
          viewport: await page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
            zoom: window.devicePixelRatio,
          })),
          pagination: state.paginationText,
          mountedRows: state.mountedRows,
        },
      );
    }
  }
  report.pagination[config.id] = {
    pageCount: config.pageCount,
    strategy: config.sampling ? "bounded-head-tail" : "exhaustive-walk",
    visitedPages: visitPlan,
    pages,
    ...(config.id === "findJobs"
      ? {
          page1ToPage2Geometry: {
            page1: findJobsPage1Geometry,
            page2: findJobsPage2Geometry,
            pass:
              paginationGeometryDifferences(
                findJobsPage1Geometry,
                findJobsPage2Geometry,
              ).length === 0,
          },
        }
      : {}),
  };
  if (config.scenarioId) completeScenario(config.scenarioId);
  return {
    visitedPages: visitPlan,
    pages,
    lastVisitedPage: previousPageNumber,
  };
}

async function verifyWideSidebar(page) {
  // Arriving from ?section=sources keeps the sources library mounted because
  // the app reads the section query on mount. Force a real remount through
  // another route and prove the sources library detached before recording
  // sidebar evidence. The sidebar assertion shares the profile screenshot
  // state; its separate completion ID is retained in metadata without claiming
  // a distinct visual state.
  await navigateHash(page, "/job-finder/discovery", "Find jobs");
  await navigateHash(page, "/job-finder/profile", "Your profile");
  await page.waitForFunction(
    () => !document.querySelector("[data-job-sources-library]"),
    undefined,
    { timeout: 15_000 },
  );
  const sidebar = page.getByRole("complementary", {
    name: "Job Finder sidebar",
  });
  await sidebar.waitFor({ state: "visible", timeout: 10_000 });
  const navigation = await inspectNavigation(page);
  report.verifications.navigation.wideSidebar = navigation.wideSidebar;
  assert(
    navigation.wideSidebar.pass,
    `1440 sidebar did not list every destination inline without a More trigger: ${JSON.stringify(navigation.wideSidebar)}`,
  );
  await captureScreenshot(page, "sidebar-1440", {
    viewport: "1440-normal",
    scenario: "wide-sidebar",
    scenarioId: "scale-sidebar-1440",
    screenshotStateId: "1440-profile-baseline",
    expectWideSidebar: true,
    expectRoute: "#/job-finder/profile",
  });
  completeScenario("scale-sidebar-1440");
}

async function verifyPlanningSettingsMenu(page, viewportLabel) {
  await navigateHash(page, "/job-finder/profile", "Your profile");
  const planningButton = page.getByRole("button", {
    name: /^More/,
    exact: false,
  });
  await planningButton.waitFor({ state: "visible", timeout: 10_000 });
  await planningButton.click();
  const menu = page.getByRole("navigation", { name: "More" });
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  const items = menu.getByRole("button");
  await page.waitForFunction(
    () =>
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.closest(
        '[role="navigation"][aria-label="More"]',
      ) !== null,
    undefined,
    { timeout: 10_000 },
  );
  const labels = await items.evaluateAll((elements) =>
    elements.map(
      (element) =>
        element.getAttribute("aria-label") ??
        element.textContent?.replace(/\s+/g, " ").trim() ??
        "",
    ),
  );
  for (const requiredLabel of PLANNING_SETTINGS_MENU_DESTINATIONS)
    assert(
      labels.includes(requiredLabel),
      `More menu did not expose ${requiredLabel} at ${viewportLabel}: ${JSON.stringify(labels)}`,
    );
  const verticalClipEvidence = await menu.evaluate((element) => {
    const menu = element;
    const items = Array.from(menu.querySelectorAll("button"));
    const lastItem = items.at(-1);
    const beforeScrollTop = menu.scrollTop;
    const beforeRect = lastItem?.getBoundingClientRect() ?? null;
    lastItem?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const afterScrollTop = menu.scrollTop;
    const afterRect = lastItem?.getBoundingClientRect() ?? null;
    const menuRect = menu.getBoundingClientRect();
    const withinMenu = (rect) =>
      Boolean(
        rect &&
        rect.top >= menuRect.top - 1 &&
        rect.bottom <= menuRect.bottom + 1,
      );
    return {
      checked: true,
      itemCount: items.length,
      scrollable: menu.scrollHeight > menu.clientHeight + 2,
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
      beforeScrollTop,
      afterScrollTop,
      scrollChanged: afterScrollTop !== beforeScrollTop,
      lastItemBeforeWithinMenu: withinMenu(beforeRect),
      lastItemAfterWithinMenu: withinMenu(afterRect),
    };
  });
  assert(
    verticalClipEvidence.checked &&
      verticalClipEvidence.itemCount >=
        PLANNING_SETTINGS_MENU_DESTINATIONS.length &&
      verticalClipEvidence.lastItemAfterWithinMenu,
    `More menu vertical clipping evidence failed at ${viewportLabel}: ${JSON.stringify(verticalClipEvidence)}`,
  );
  await page.keyboard.press("Home");
  const firstFocused = await page.evaluate(
    () =>
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.closest(
        '[role="navigation"][aria-label="More"]',
      ) !== null,
  );
  await page.keyboard.press("End");
  const lastFocused = await page.evaluate(
    () =>
      document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.closest(
        '[role="navigation"][aria-label="More"]',
      ) !== null,
  );
  const planningSettingsKeyboard = {
    pass: firstFocused && lastFocused,
    firstFocused,
    lastFocused,
    labels,
  };
  assert(
    planningSettingsKeyboard.pass,
    `More menu keyboard traversal failed at ${viewportLabel}: ${JSON.stringify(planningSettingsKeyboard)}`,
  );
  const navigation = await inspectNavigation(page);
  report.verifications.navigation.compactPlanning[viewportLabel] =
    navigation.compactPlanning;
  assert(
    navigation.compactPlanning.pass,
    `Compact More navigation is missing at ${viewportLabel}: ${JSON.stringify(navigation.compactPlanning)}`,
  );
  report.verifications.navigation.planningSettingsMenu[viewportLabel] = {
    ...navigation.planningSettingsMenu,
    verticalClipEvidence,
    keyboard: planningSettingsKeyboard,
  };
  assert(
    navigation.planningSettingsMenu.pass,
    `More menu is clipped or missing required destinations at ${viewportLabel}: ${JSON.stringify(navigation.planningSettingsMenu)}`,
  );
  await captureScreenshot(page, `planning-settings-menu-${viewportLabel}`, {
    viewport: viewportLabel,
    scenario: "planning-settings-menu",
    scenarioId: `scale-planning-settings-${viewportLabel}`,
    expectPlanningSettingsMenu: true,
    expectPlanningSettingsKeyboard: true,
    planningSettingsKeyboard,
  });
  completeScenario(`scale-planning-settings-${viewportLabel}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
}

// The CRM lifecycle control is a native <select>: its open popup is rendered by
// the OS and never appears in page pixels, which is why the previous
// "lifecycle dropdown" capture came out byte-identical to the closed-state
// capture. Open-state is therefore proven through DOM-observable semantics -
// the focused select plus frame-to-frame geometry stability - recorded as
// evidence, and a non-default lifecycle view is applied so the capture carries
// real filtered state instead of duplicating the default view.
async function captureApplicationsLifecycleView(page) {
  // The lifecycle select is rendered only inside the Stages (CRM) workspace
  // view; the default Preparation view never mounts it. Switch explicitly
  // through the workspace view toggle, then restore Preparation after evidence
  // collection so later captures stay comparable.
  const workspaceViewGroup = page.getByRole("group", {
    name: "Applications workspace view",
  });
  await workspaceViewGroup.waitFor({ state: "visible", timeout: 10_000 });
  await workspaceViewGroup
    .getByRole("button", { name: "Stages", exact: true })
    .click();
  const trigger = page.getByLabel("Lifecycle view");
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  const beforeState = await trigger.evaluate((element) => ({
    tagName: element.tagName.toLowerCase(),
    value: element.value,
    optionLabels: Array.from(
      element.options ?? [],
      (option) => option.textContent?.trim() ?? "",
    ),
  }));
  const applicationsPaginationText = () =>
    page.evaluate(() => {
      const nav = Array.from(document.querySelectorAll("nav")).find((el) =>
        /applications/i.test(el.getAttribute("aria-label") ?? ""),
      );
      return nav?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    });
  const beforePaginationText = await applicationsPaginationText();
  await trigger.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForFunction(
    () => document.activeElement instanceof HTMLSelectElement,
    undefined,
    { timeout: 5_000 },
  );
  const geometryStability = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const select = document.activeElement;
        if (!(select instanceof HTMLSelectElement)) {
          resolve({ stable: false, rects: [] });
          return;
        }
        const first = select.getBoundingClientRect().toJSON();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const second = select.getBoundingClientRect().toJSON();
            resolve({
              stable:
                Math.abs(first.width - second.width) <= 0.5 &&
                Math.abs(first.height - second.height) <= 0.5 &&
                Math.abs(first.left - second.left) <= 0.5 &&
                Math.abs(first.top - second.top) <= 0.5,
              rects: [first, second],
            });
          }),
        );
      }),
  );
  assert(
    geometryStability.stable,
    `Applications lifecycle control geometry did not stabilize while open: ${JSON.stringify(geometryStability.rects)}`,
  );
  await page.keyboard.press("Escape");
  await trigger.selectOption("needs_follow_up");
  const selectedValue = await trigger.inputValue();
  assert(
    selectedValue === "needs_follow_up",
    `Applications lifecycle view selection did not apply: ${selectedValue}`,
  );
  await page.waitForFunction(
    ({ previous }) => {
      const emptyHeading = Array.from(document.querySelectorAll("h3")).find(
        (element) =>
          (element.textContent ?? "").includes(
            "No applications match this lifecycle view",
          ),
      );
      const nav = Array.from(document.querySelectorAll("nav")).find((el) =>
        /applications/i.test(el.getAttribute("aria-label") ?? ""),
      );
      const text = nav?.textContent?.replace(/\s+/g, " ").trim() ?? null;
      return Boolean(emptyHeading) || (text !== null && text !== previous);
    },
    { previous: beforePaginationText },
    { timeout: 10_000 },
  );
  const appliedOutcome = await applicationsPaginationText();
  await captureScreenshot(
    page,
    `applications-lifecycle-${selectedValue}-1440`,
    {
      surface: "applications",
      expectRoute: "#/job-finder/applications",
      note: "Native lifecycle select opened via Alt+ArrowDown; the OS popup cannot appear in page pixels, so open-state is recorded as focused-select semantics with geometry stability, then a non-default lifecycle view is applied.",
      lifecycleEvidence: {
        controlLabel: "Lifecycle view",
        tagName: beforeState.tagName,
        optionLabels: beforeState.optionLabels,
        previousValue: beforeState.value,
        selectedValue,
        openFocused: true,
        geometryStable: geometryStability.stable,
        rects: geometryStability.rects,
        appliedOutcome,
      },
    },
  );
  // Restore the default lifecycle view so later captures are not contaminated
  // by the filtered state. Wait for the unfiltered total instead of the exact
  // prior page text; a filter change may legitimately reset the page counter.
  await trigger.selectOption(beforeState.value);
  await page.waitForFunction(
    ({ totalCount }) => {
      const emptyHeading = Array.from(document.querySelectorAll("h3")).find(
        (element) =>
          (element.textContent ?? "").includes(
            "No applications match this lifecycle view",
          ),
      );
      const nav = Array.from(document.querySelectorAll("nav")).find((el) =>
        /applications/i.test(el.getAttribute("aria-label") ?? ""),
      );
      const text = nav?.textContent?.replace(/\s+/g, " ").trim() ?? null;
      return (
        !emptyHeading &&
        text !== null &&
        text.includes(`of ${totalCount} applications`)
      );
    },
    { totalCount: counts.applications },
    { timeout: 10_000 },
  );
  // Restore the default Preparation workspace view; the Stages-only
  // lifecycle control must be gone before any later capture runs.
  await workspaceViewGroup
    .getByRole("button", { name: "Preparation", exact: true })
    .click();
  await trigger.waitFor({ state: "detached", timeout: 10_000 });
}

async function assertRapidReviewPagination(page) {
  const pageCount = Math.ceil(counts.jobs / 40);
  return assertPagination(page, {
    id: "rapidReview",
    scenarioId: "scale-rapid-review-pagination",
    route: "/job-finder/rapid-review",
    heading: "Rapid review",
    surface: "rapidReview",
    pageCount,
    sampling: { headPages: [1, 2] },
    paginationLabel: "jobs pagination",
    expectedRows: (pageNumber) =>
      Math.min(40, counts.jobs - (pageNumber - 1) * 40),
    expectedText: (pageNumber) => {
      const first = (pageNumber - 1) * 40 + 1;
      const last = Math.min(pageNumber * 40, counts.jobs);
      return `Showing ${first}–${last} of ${counts.jobs} jobs`;
    },
    assertPage: async (_currentPage, pageNumber) => {
      const pageCounter = await page.evaluate(() => {
        const nav = Array.from(document.querySelectorAll("nav")).find(
          (el) => el.getAttribute("aria-label") === "jobs pagination",
        );
        return (
          nav
            ?.querySelector('[aria-current="page"]')
            ?.textContent?.replace(/\s+/g, " ")
            .trim() ?? null
        );
      });
      assert(
        pageCounter === `Page ${pageNumber} of ${pageCount}`,
        `rapidReview page ${pageNumber}: page counter was ${pageCounter}, expected Page ${pageNumber} of ${pageCount}.`,
      );
    },
    screenshotOnPages: [1, pageCount],
  });
}

async function assertReviewQueueBatchActions(page) {
  const draftRemainder =
    counts.shortlisted - REVIEW_QUEUE_DRAFT_PREPARATION_LIMIT;
  const expectedCreateLabel = `Create ${REVIEW_QUEUE_DRAFT_PREPARATION_LIMIT} missing resumes`;
  const expectedHelpText = `About a minute each, ${REVIEW_QUEUE_DRAFT_PREPARATION_LIMIT} at a time; ${draftRemainder} more after that.`;
  await navigateHash(page, "/job-finder/review-queue", "Shortlisted");
  const allJobsRow = page.locator('[data-testid="shortlisted-all-jobs"]');
  await allJobsRow.waitFor({ state: "visible", timeout: 15_000 });
  const batchActionsEvidence = await page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? null;
    const panel = document.querySelector(
      '[data-testid="shortlisted-all-jobs"]',
    );
    const createButton = panel?.querySelector(
      '[data-testid="create-missing-resumes"]',
    );
    const applyButton = panel?.querySelector('[data-testid="apply-all-ready"]');
    const panelParagraphs = panel
      ? Array.from(panel.querySelectorAll("p")).map((paragraph) =>
          normalize(paragraph.textContent),
        )
      : [];
    return {
      panelMounted: Boolean(panel),
      helpText: panelParagraphs[0] ?? null,
      createButtonLabel: createButton
        ? normalize(createButton.textContent)
        : null,
      createButtonDisabled: createButton?.disabled ?? null,
      applyButtonPresent: Boolean(applyButton),
      removedBatchDisclosurePresent: Boolean(
        document.querySelector('details[data-testid="batch-actions"]'),
      ),
      removedBatchSelectionCount: Array.from(
        document.querySelectorAll("label"),
      ).filter((label) => normalize(label.textContent) === "Select for batch")
        .length,
    };
  });
  assert(
    batchActionsEvidence.panelMounted,
    `scale-review-queue-batch-actions: the all-jobs action row did not render: ${JSON.stringify(batchActionsEvidence)}`,
  );
  assert(
    batchActionsEvidence.helpText === expectedHelpText,
    `scale-review-queue-batch-actions: helper was "${batchActionsEvidence.helpText}", expected "${expectedHelpText}".`,
  );
  assert(
    batchActionsEvidence.createButtonLabel === expectedCreateLabel &&
      batchActionsEvidence.createButtonDisabled === false,
    `scale-review-queue-batch-actions: Create action was "${batchActionsEvidence.createButtonLabel}" disabled=${batchActionsEvidence.createButtonDisabled}, expected enabled "${expectedCreateLabel}".`,
  );
  assert(
    !batchActionsEvidence.applyButtonPresent &&
      !batchActionsEvidence.removedBatchDisclosurePresent &&
      batchActionsEvidence.removedBatchSelectionCount === 0,
    `scale-review-queue-batch-actions: removed batch controls or an ineligible Apply-to-all action rendered: ${JSON.stringify(batchActionsEvidence)}`,
  );
  await captureScreenshot(page, "review-queue-batch-actions-1440", {
    viewport: "1440-normal",
    expectRoute: "#/job-finder/review-queue",
    batchActionsEvidence: {
      ...batchActionsEvidence,
      eligibleTotal: counts.shortlisted,
      draftPreparationLimit: REVIEW_QUEUE_DRAFT_PREPARATION_LIMIT,
      expectedCreateLabel,
      expectedHelpText,
    },
  });
  completeScenario("scale-review-queue-batch-actions");
}

async function run() {
  const log = (m) => process.stdout.write(`[capture-scale-500] ${m}\n`);
  await ensureFreshOutputDir(outputDir);
  await verifyAcceptanceArtifacts(acceptance);
  await mkdir(screenshotDir, { recursive: true });
  const userDataDirectory =
    await makeIsolatedUserDataDirectory("nestor-scale-500-");
  report.safety.isolatedUserDataDir = userDataDirectory;
  report.safety.syntheticTestDataDigest = digestSeed({
    seed: acceptance.seedDigest,
    component: "scale",
    source: "preload.test",
  });
  const createdDemoFiles = new Set();
  const observedSafetyEvents = [];
  const ownedProcesses = createOwnedProcessLedger();
  let app = null;
  let page = null;
  let memoryPid = null;

  const launch = async () => {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: acceptanceEnvironment({
        NESTOR_USER_DATA_DIR: userDataDirectory,
      }),
    });
    processOutputState = attachProcessOutput(app, report);
    processOutputStates.push(processOutputState);
    page = await app.firstWindow();
    await page.exposeFunction("__jobFinderAcceptanceSafetyEvents", (record) => {
      observedSafetyEvents.push(record);
    });
    await page.addInitScript(installPrepareOnlySafetyProbe);
    await page.evaluate(installPrepareOnlySafetyProbe);
    memoryPid = app.process()?.pid ?? null;
    ownedProcesses.track(
      memoryPid,
      `electron-root-${processOutputStates.length}`,
      "",
    );
    page.on("pageerror", (e) =>
      report.runtimeErrors.push({ type: "pageerror", message: e.message }),
    );
    page.on("console", (m) => {
      if (m.type() === "error")
        report.runtimeErrors.push({ type: "console", message: m.text() });
    });
    await page.waitForLoadState("domcontentloaded");
    await assertFileRenderer(page);
    await page.waitForSelector("[data-job-finder-shell]", { timeout: 15_000 });
    return page;
  };

  let primaryScenarioError = null;
  let postTeardownFailure = null;
  try {
    log("launching bootstrap app");
    const bootstrapPage = await launch();
    await bootstrapPage.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 15_000 },
    );
    const beforeFiles = new Set();
    const baseSnapshot = await bootstrapPage.evaluate(() =>
      window.nestor.jobFinder.test.loadApplyQueueDemo(),
    );
    for (const filePath of [
      baseSnapshot.profile.baseResume.storagePath,
      ...baseSnapshot.resumeExportArtifacts.map((a) => a.filePath),
    ]) {
      if (!filePath) continue;
      try {
        await access(filePath);
        beforeFiles.add(filePath);
      } catch {
        // The demo had not created this file, so it must not be tracked for deletion.
      }
    }
    const scaleState = createScaleState(baseSnapshot);
    log(
      `persisting synthetic scale state ${counts.jobs} jobs / ${counts.shortlisted} shortlisted / ${counts.applications} apps / ${counts.sources} sources`,
    );
    await bootstrapPage.evaluate(
      (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      scaleState,
    );
    for (const filePath of [
      scaleState.profile.baseResume.storagePath,
      ...scaleState.resumeExportArtifacts.map((a) => a.filePath),
    ]) {
      if (filePath && !beforeFiles.has(filePath))
        createdDemoFiles.add(filePath);
    }
    await bootstrapPage.reload();
    log("bootstrap state persisted; validating snapshot");
    await bootstrapPage.waitForSelector("[data-job-finder-shell]", {
      timeout: 15_000,
    });
    await waitForWorkspaceHydrationComplete(bootstrapPage);
    const bootstrappedWorkspace = await bootstrapPage.evaluate(() =>
      window.nestor.jobFinder.getWorkspace(),
    );
    assert(
      bootstrappedWorkspace.hydration?.phase === "complete",
      `Bootstrap hydration did not complete before scale assertions: ${bootstrappedWorkspace.hydration?.phase}`,
    );
    assert(
      bootstrappedWorkspace.savedJobs?.length === counts.jobs ||
        bootstrappedWorkspace.discoveryJobs?.length === counts.jobs,
      `Bootstrap did not persist ${counts.jobs} jobs. got savedJobs=${bootstrappedWorkspace.savedJobs?.length} discoveryJobs=${bootstrappedWorkspace.discoveryJobs?.length}`,
    );
    // The repository exposes discoveryJobs + reviewQueue separation; check both representations
    const totalJobs =
      bootstrappedWorkspace.savedJobs?.length ??
      bootstrappedWorkspace.discoveryJobs?.length ??
      0;
    const reviewQueueLen =
      bootstrappedWorkspace.reviewQueue?.length ??
      bootstrappedWorkspace.savedJobs?.filter(
        (j) => j.status === "ready_for_review",
      ).length ??
      0;
    log(
      `bootstrapped totals: jobs=${totalJobs} reviewQueue=${reviewQueueLen} applications=${bootstrappedWorkspace.applicationRecords.length} sources=${bootstrappedWorkspace.searchPreferences.discovery.targets.length}`,
    );
    assert(
      totalJobs === requiredJobCount,
      `Bootstrap persisted ${totalJobs} jobs instead of the required ${requiredJobCount}.`,
    );
    assert(
      bootstrappedWorkspace.applicationRecords.length === priorCapBoundaryCount,
      `Bootstrap persisted ${bootstrappedWorkspace.applicationRecords.length} applications instead of the required ${priorCapBoundaryCount}.`,
    );
    assert(
      reviewQueueLen === counts.shortlisted,
      `Bootstrap shortlisted ${reviewQueueLen} jobs instead of the required ${counts.shortlisted}.`,
    );
    assert(
      bootstrappedWorkspace.searchPreferences.discovery.targets.length ===
        counts.sources,
      `Bootstrap persisted ${bootstrappedWorkspace.searchPreferences.discovery.targets.length} sources instead of the required ${counts.sources}.`,
    );
    completeScenario("scale-bootstrap");

    log("stopping bootstrap app");
    const bootstrapProcess = app.process();
    if (!bootstrapProcess)
      throw new Error("Bootstrap Electron process was unavailable.");
    await snapshotOwnedProcessTree(
      ownedProcesses,
      bootstrapProcess.pid,
      "bootstrap",
    );
    await forceStopElectronProcess(bootstrapProcess);
    const bootstrapTeardown = await verifyZeroLeftoverOwnedProcesses(
      ownedProcesses,
      "bootstrap",
    );
    report.processOwnership.verifications.push(bootstrapTeardown);
    assert(
      bootstrapTeardown.verified,
      `Bootstrap Electron teardown left ${bootstrapTeardown.leftoverPids.length} tracked process(es) alive: ${JSON.stringify(bootstrapTeardown.leftoverDetail)}`,
    );
    // Let Windows finish terminating Chromium descendants and releasing the
    // SQLite/WAL files before starting the measured launch. The timer begins
    // only after this cleanup period, so harness teardown is not charged to or
    // hidden inside the product startup budget.
    await new Promise((r) => setTimeout(r, 3000));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await access(
          path.join(userDataDirectory, "job-finder-workspace.sqlite"),
        );
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    log("bootstrap app stopped");
    app = null;
    page = null;

    const coldStartedAt = performance.now();
    log("launching cold app");
    let coldLaunched = false;
    let lastColdError = null;
    for (let attempt = 0; attempt < 2 && !coldLaunched; attempt += 1) {
      try {
        if (attempt > 0) {
          log(`cold launch retry ${attempt + 1}`);
          try {
            if (app) {
              const proc = app.process();
              if (proc?.pid) {
                await snapshotOwnedProcessTree(
                  ownedProcesses,
                  proc.pid,
                  `cold-retry-${attempt}`,
                ).catch(() => {});
                await forceStopElectronProcess(proc).catch(() => {});
                await new Promise((r) => setTimeout(r, 800));
              }
            }
          } catch {
            // Retry teardown is best effort; the fresh launch below re-proves liveness.
          }
          app = null;
          page = null;
          if (process.platform === "win32") {
            try {
              await execFileAsync("icacls", [
                userDataDirectory,
                "/reset",
                "/T",
                "/C",
                "/Q",
              ]);
            } catch {
              // ACL repair is Windows-only best effort; launch failures surface on their own.
            }
          }
          await new Promise((r) => setTimeout(r, 800));
        }
        await launch();
        await page.waitForFunction(
          () => Boolean(window.nestor?.jobFinder?.getWorkspace),
          undefined,
          { timeout: 15_000 },
        );
        await page
          .getByRole("heading", { level: 1 })
          .first()
          .waitFor({ state: "visible", timeout: 15_000 });
        coldLaunched = true;
      } catch (error) {
        lastColdError = error;
        if (page)
          try {
            const diag = await page.evaluate(() => ({
              href: window.location.href,
              body: document.body.innerText.slice(0, 2000),
            }));
            report.coldLaunchDiagnostic = diag;
          } catch {
            // Diagnostics are opportunistic; the original launch error still propagates.
          }
        if (attempt === 1) throw error;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!coldLaunched && lastColdError) throw lastColdError;
    const playwrightLaunchToUsableShellMs =
      Math.round((performance.now() - coldStartedAt) * 100) / 100;
    const openingShellEpochMs = await page.evaluate(() => {
      const mark = performance
        .getEntriesByName("job-finder:opening-shell:committed", "mark")
        .at(-1);
      return mark ? performance.timeOrigin + mark.startTime : null;
    });
    const mainProcessTiming = await app.evaluate(() => ({
      nowEpochMs: Date.now(),
      uptimeMs: process.uptime() * 1000,
    }));
    assert(
      typeof openingShellEpochMs === "number",
      "The interactive opening-shell timing mark was not recorded.",
    );
    const mainProcessStartedAtEpochMs =
      mainProcessTiming.nowEpochMs - mainProcessTiming.uptimeMs;
    report.startup.playwrightLaunchToUsableShellMs =
      playwrightLaunchToUsableShellMs;
    report.startup.measurementOrigin = "electron-main-process-start";
    report.startup.mainProcessStartedAtEpochMs = mainProcessStartedAtEpochMs;
    report.startup.openingShellEpochMs = openingShellEpochMs;
    report.startup.coldToUsableShellMs =
      Math.round((openingShellEpochMs - mainProcessStartedAtEpochMs) * 100) /
      100;
    report.startup.electronPid = memoryPid;
    report.startup.memory = await sampleProcessMemory(memoryPid);
    await waitForWorkspaceHydrationComplete(page);
    // Prove the cold production app actually hydrated the full scale axis
    // through IPC before any rendering assertion runs. This is the hydrated
    // contract: 5,000 discovery jobs plus every prior-cap boundary collection.
    const hydratedWorkspace = await page.evaluate(() =>
      window.nestor.jobFinder.getWorkspace(),
    );
    assert(
      hydratedWorkspace.hydration?.phase === "complete",
      `Cold launch hydration did not complete: ${hydratedWorkspace.hydration?.phase}`,
    );
    const hydratedJobRecords =
      hydratedWorkspace.discoveryJobs ?? hydratedWorkspace.savedJobs ?? [];
    const hydratedJobs = hydratedJobRecords.length;
    const hydratedShortlisted =
      hydratedWorkspace.reviewQueue?.length ??
      hydratedJobRecords.filter((job) => job?.status === "ready_for_review")
        .length;
    const hydrationProof = {
      phase: hydratedWorkspace.hydration?.phase ?? null,
      jobs: hydratedJobs,
      requiredJobs: requiredJobCount,
      shortlisted: hydratedShortlisted,
      applications: hydratedWorkspace.applicationRecords?.length ?? 0,
      sources:
        hydratedWorkspace.searchPreferences?.discovery?.targets?.length ?? 0,
    };
    assert(
      hydrationProof.jobs === requiredJobCount,
      `Cold launch hydrated ${hydrationProof.jobs} jobs instead of ${requiredJobCount}: ${JSON.stringify(hydrationProof)}`,
    );
    assert(
      hydrationProof.shortlisted >= priorCapBoundaryCount &&
        hydrationProof.applications >= priorCapBoundaryCount &&
        hydrationProof.sources >= priorCapBoundaryCount,
      `Cold launch dropped below the ${priorCapBoundaryCount}-record boundary collections: ${JSON.stringify(hydrationProof)}`,
    );
    report.hydration = hydrationProof;
    log(
      `hydrated jobs=${hydrationProof.jobs} shortlisted=${hydrationProof.shortlisted} applications=${hydrationProof.applications} sources=${hydrationProof.sources}`,
    );
    report.startup.timingMarks = await readJobFinderTimingMarks(page);
    assert(
      report.startup.coldToUsableShellMs <=
        CANONICAL_LATENCY_BUDGETS.coldToUsableShellMs,
      `Cold usable shell exceeded ${CANONICAL_LATENCY_BUDGETS.coldToUsableShellMs} ms (${report.startup.coldToUsableShellMs} ms).`,
    );
    await installRendererProbe(page);
    report.renderer.longTaskSupported =
      (await readRendererProbe(page))?.longTaskSupported ?? false;
    const browserWindow = await resolveStartupBrowserWindow(app, page);
    activeBrowserWindow = browserWindow;
    await setViewportAndZoom(page, browserWindow, viewportNormal);
    log(`cold usable shell ${report.startup.coldToUsableShellMs} ms at 1440`);

    for (let cycle = 0; cycle < routeCycles; cycle += 1) {
      for (const route of CANONICAL_ROUTE_DEFINITIONS)
        await switchRoute(page, route, memoryPid);
    }
    const observedRouteIds = [
      ...new Set(report.routeSwitches.map((entry) => entry.route)),
    ];
    const missingCanonicalRoutes = report.requiredCanonicalRoutes.filter(
      (routeId) => !observedRouteIds.includes(routeId),
    );
    assert(
      report.routeSwitches.length ===
        routeCycles * CANONICAL_ROUTE_DEFINITIONS.length &&
        missingCanonicalRoutes.length === 0 &&
        observedRouteIds.length === report.requiredCanonicalRoutes.length,
      `Scale acceptance did not cover the canonical route set: ${JSON.stringify({ observedRouteIds, requiredRouteIds: report.requiredCanonicalRoutes, routeSwitchCount: report.routeSwitches.length })}`,
    );
    log("route switch cycles complete");

    // Capture baseline screenshots at 1440. The route cycles end on
    // Applications, so navigate explicitly and gate the label on the observed
    // route instead of trusting wherever the previous step left the app.
    await navigateHash(page, "/job-finder/profile", "Your profile");
    await captureScreenshot(page, "1440-profile-baseline", {
      viewport: "1440-normal",
      expectRoute: "#/job-finder/profile",
    });
    await checkHorizontalOverflow(page, "1440-profile");
    await checkDropdownsNotClipped(page, "1440-profile");

    log("checking Find Jobs pagination 1-50 / 51-100 with bounded tail proof");
    // The discovery axis scales with requiredJobCount (5,000 jobs => 100 pages
    // of 50). Keep renderer checks bounded: exhaustively verify head pages
    // 1-2 (with screenshots) plus the final boundary page (last rows, Next
    // disabled) reached through the capped fast-forward.
    await assertPagination(page, {
      id: "findJobs",
      scenarioId: "scale-find-jobs-pagination",
      route: "/job-finder/discovery",
      heading: "Find jobs",
      surface: "findJobs",
      pageCount: Math.ceil(counts.jobs / 50),
      sampling: { headPages: [1, 2] },
      paginationLabel: "Job result pages",
      expectedRows: (pn) => Math.min(50, counts.jobs - (pn - 1) * 50),
      expectedText: (pn) => {
        const first = (pn - 1) * 50 + 1;
        const last = Math.min(pn * 50, counts.jobs);
        return `${first}–${last} of ${counts.jobs}`;
      },
      assertPage: async (currentPage, pageNumber) => {
        await currentPage.waitForFunction(
          () => {
            const selectedTitle = document
              .querySelector('[data-job-result-id][aria-current="true"] strong')
              ?.textContent?.trim();
            const inspectorTitle = document
              .querySelector("#discovery-selected-job-heading")
              ?.textContent?.trim();
            return Boolean(
              selectedTitle &&
              inspectorTitle &&
              selectedTitle === inspectorTitle,
            );
          },
          undefined,
          { timeout: 10_000 },
        );
        const parity = await currentPage.evaluate(() => ({
          inspectorTitle:
            document
              .querySelector("#discovery-selected-job-heading")
              ?.textContent?.trim() ?? null,
          selectedTitle:
            document
              .querySelector('[data-job-result-id][aria-current="true"] strong')
              ?.textContent?.trim() ?? null,
        }));
        assert(
          parity.selectedTitle === parity.inspectorTitle,
          `findJobs page ${pageNumber}: inspector does not match the highlighted result: ${JSON.stringify(parity)}.`,
        );
      },
      screenshotOnPages: [1, 2],
    });
    log("checking Shortlisted pagination");
    const shortlistedPagination = await assertPagination(page, {
      id: "shortlisted",
      scenarioId: "scale-shortlisted-pagination",
      route: "/job-finder/review-queue",
      heading: "Shortlisted",
      surface: "shortlisted",
      pageCount: Math.ceil(counts.shortlisted / 40),
      paginationLabel: "shortlisted jobs pagination",
      expectedRows: (pn) => Math.min(40, counts.shortlisted - (pn - 1) * 40),
      expectedText: (pn) => {
        const first = (pn - 1) * 40 + 1;
        const last = Math.min(pn * 40, counts.shortlisted);
        return `Showing ${first}–${last} of ${counts.shortlisted} shortlisted jobs`;
      },
      screenshotOnPages: [1],
    });
    // The bounded walk ends on the final boundary page; label the extra
    // capture with the page counter actually observed at capture time instead
    // of a static page number that would misdescribe the evidence.
    const shortlistedFinalPage = shortlistedPagination.lastVisitedPage ?? 1;
    const shortlistedFinalState = shortlistedPagination.pages.at(-1);
    await captureScreenshot(
      page,
      `shortlisted-final-p${shortlistedFinalPage}-1440`,
      {
        surface: "shortlisted",
        page: shortlistedFinalPage,
        pagination: shortlistedFinalState?.text ?? null,
        mountedRows: shortlistedFinalState?.mountedRows ?? null,
      },
    );
    log("checking Applications pagination");
    const applicationsPagination = await assertPagination(page, {
      id: "applications",
      scenarioId: "scale-applications-pagination",
      route: "/job-finder/applications",
      heading: "Applications",
      surface: "applications",
      pageCount: Math.ceil(counts.applications / 40),
      paginationLabel: "applications pagination",
      expectedRows: (pn) => Math.min(40, counts.applications - (pn - 1) * 40),
      expectedText: (pn) => {
        const first = (pn - 1) * 40 + 1;
        const last = Math.min(pn * 40, counts.applications);
        return `Showing ${first}–${last} of ${counts.applications} applications`;
      },
      screenshotOnPages: [1],
    });
    const applicationsFinalPage = applicationsPagination.lastVisitedPage ?? 1;
    const applicationsFinalState = applicationsPagination.pages.at(-1);
    await captureScreenshot(
      page,
      `applications-crm-final-p${applicationsFinalPage}-1440`,
      {
        surface: "applications",
        page: applicationsFinalPage,
        pagination: applicationsFinalState?.text ?? null,
        mountedRows: applicationsFinalState?.mountedRows ?? null,
      },
    );
    // Verify Applications CRM specific: ensure pagination is outside table scroll and table not horizontally overflowing
    await page.evaluate(
      () => (window.location.hash = "#/job-finder/applications"),
    );
    await waitForHeading(page, "Applications");
    await checkHorizontalOverflow(page, "applications-crm-1440");
    await checkDropdownsNotClipped(page, "applications-crm-1440");
    await captureApplicationsLifecycleView(page);

    log("checking Profile source pagination");
    const profileSourcesPagination = await assertPagination(page, {
      id: "profileSources",
      scenarioId: "scale-profile-sources-pagination",
      route: "/job-finder/profile?section=sources&focus=job-sources",
      heading: "Your profile",
      surface: "profile",
      pageCount: Math.ceil(counts.sources / 25),
      paginationLabel: "Job source pages",
      waitFor: async (currentPage) => {
        await currentPage
          .locator("[data-job-sources-library]")
          .waitFor({ state: "visible", timeout: 15_000 });
      },
      expectedRows: (pn) => Math.min(25, counts.sources - (pn - 1) * 25),
      expectedText: (pn) => {
        const first = (pn - 1) * 25 + 1;
        const last = Math.min(pn * 25, counts.sources);
        return `${first}–${last} of ${counts.sources}`;
      },
      screenshotOnPages: [1, 2],
    });
    const sourcesFinalPage = profileSourcesPagination.lastVisitedPage ?? 1;
    const sourcesFinalState = profileSourcesPagination.pages.at(-1);
    await captureScreenshot(
      page,
      `profile-sources-final-p${sourcesFinalPage}-1440`,
      {
        surface: "profileSources",
        page: sourcesFinalPage,
        pagination: sourcesFinalState?.text ?? null,
        mountedRows: sourcesFinalState?.mountedRows ?? null,
      },
    );
    log("pagination checks at 1440 complete");

    log("checking Rapid review pagination across all active-campaign jobs");
    await assertRapidReviewPagination(page);
    log("checking Review queue batch actions disclosure");
    await assertReviewQueueBatchActions(page);

    // Verify the wide sidebar at 1440.
    await verifyWideSidebar(page);

    // Now test practical native 125% zoom: the shell keeps its desktop-like
    // layout (CSS 1152x736) instead of the removed 200% mobile-like collapse.
    log("switching to native 125% zoom");
    await setViewportAndZoom(page, browserWindow, viewportNative125);
    await page.waitForTimeout(400);
    // Capture screenshots at native 125%
    await navigateHash(page, "/job-finder/discovery", "Find jobs");
    const native125FindJobsPagination = {
      id: "findJobs-native125",
      heading: "Find jobs",
      surface: "findJobs",
      paginationLabel: "Job result pages",
      expectedRows: (pageNumber) =>
        Math.min(50, counts.jobs - (pageNumber - 1) * 50),
      expectedText: (pageNumber) => {
        const first = (pageNumber - 1) * 50 + 1;
        const last = Math.min(pageNumber * 50, counts.jobs);
        return `${first}–${last} of ${counts.jobs}`;
      },
    };
    await waitForPaginationPage(page, native125FindJobsPagination, 1);
    const native125Page1Geometry = await readFindJobsPaginationGeometry(page);
    await checkHorizontalOverflow(page, "findJobs-native125");
    await checkPaginationFlexWrap(page, "findJobs-native125");
    await checkDropdownsNotClipped(page, "findJobs-native125");
    await captureScreenshot(page, "findJobs-p1-native125", {
      viewport: "native125",
      zoom: 1.25,
      screenshotStateId: "findJobs-p1-native125",
    });
    completeScenario("scale-find-jobs-native125");
    await verifyCompactActiveRoute(page, {
      label: "native125-find-jobs",
      expectedLabel: "Find jobs",
    });

    // Go to page 2 at native 125% and capture
    const native125PaginationClickEvidence = await clickPaginationNextInPage(
      page,
      native125FindJobsPagination,
    );
    await waitForPaginationPage(page, native125FindJobsPagination, 2);
    const native125Page2Geometry = await readFindJobsPaginationGeometry(page);
    const native125PaginationGeometry = assertFindJobsPaginationGeometryStable(
      native125PaginationClickEvidence.before ?? native125Page1Geometry,
      native125Page2Geometry,
      "native125 Find Jobs page 1 -> page 2",
    );
    await checkHorizontalOverflow(page, "findJobs-p2-native125");
    await captureScreenshot(page, "findJobs-p2-native125", {
      viewport: "native125",
      paginationGeometry: native125PaginationGeometry,
    });

    await navigateHash(page, "/job-finder/review-queue", "Shortlisted");
    await checkHorizontalOverflow(page, "shortlisted-native125");
    await captureScreenshot(page, "shortlisted-p1-native125", {
      viewport: "native125",
    });
    await verifyCompactActiveRoute(page, {
      label: "native125-shortlisted",
      expectedLabel: "Shortlisted",
    });

    await navigateHash(page, "/job-finder/applications", "Applications");
    await checkHorizontalOverflow(page, "applications-native125");
    await captureScreenshot(page, "applications-crm-p1-native125", {
      viewport: "native125",
    });
    await verifyCompactActiveRoute(page, {
      label: "native125-applications",
      expectedLabel: "Applications",
    });

    await navigateHash(
      page,
      "/job-finder/profile?section=sources&focus=job-sources",
      "Your profile",
    );
    await page
      .locator("[data-job-sources-library]")
      .waitFor({ state: "visible", timeout: 15_000 });
    await checkHorizontalOverflow(page, "profile-sources-native125");
    await captureScreenshot(page, "profile-sources-p1-native125", {
      viewport: "native125",
    });
    await verifyCompactActiveRoute(page, {
      label: "native125-profile-sources",
      expectedLabel: "Profile",
    });

    // Verify compact More navigation at native 125%. The CSS
    // viewport is 1440/1.25 x 920/1.25 = 1152x736; the More menu carries only
    // its destinations plus the single shortcuts entry, exactly like the
    // minimum-width desktop surface.
    await verifyPlanningSettingsMenu(page, "native125");
    await verifyCompactNavigationRail(page, "native125", {
      width: 1152,
      height: 736,
    });
    await verifyPlanningShortcutsEvidence(page, {
      label: "native125",
      expectedCssViewport: { width: 1152, height: 736 },
    });

    // Final overall checks
    await navigateHash(page, "/job-finder/discovery", "Find jobs");
    await checkPaginationFlexWrap(page, "final-native125");
    await checkHorizontalOverflow(page, "final-native125");
    await captureScreenshot(page, "final-native125-overview", {
      viewport: "native125",
      screenshotStateId: "findJobs-p1-native125",
    });

    // Exercise the actual Electron minimum window width after the populated and zoomed matrix.
    log("switching to the 1024px minimum-width viewport");
    await setViewportAndZoom(page, browserWindow, viewportMinimum);
    await verifyPlanningSettingsMenu(page, "minimum-width");
    await verifyCompactNavigationRail(page, "minimum-width", {
      width: 1024,
      height: 768,
    });
    await verifyPlanningShortcutsEvidence(page, {
      label: "minimum-width",
      expectedCssViewport: { width: 1024, height: 768 },
    });
    await navigateHash(page, "/job-finder/discovery", "Find jobs");
    await checkHorizontalOverflow(page, "minimum-width-discovery");
    await checkPaginationFlexWrap(page, "minimum-width-discovery");
    await captureScreenshot(page, "minimum-width-discovery-populated", {
      viewport: viewportMinimum,
      scenario: "minimum-width-populated",
    });
    completeScenario("scale-minimum-width");
    await navigateHash(page, "/job-finder/applications", "Applications");
    await checkHorizontalOverflow(page, "minimum-width-applications");
    await captureScreenshot(page, "minimum-width-applications-populated", {
      viewport: viewportMinimum,
      scenario: "minimum-width-applications-populated",
      scenarioId: "scale-applications-minimum-width",
    });

    // Return to normal zoom for final report screenshot
    await setViewportAndZoom(page, browserWindow, viewportNormal);
    await navigateHash(page, "/job-finder/profile", "Your profile");
    await captureScreenshot(page, "final-1440-overview", { viewport: "1440" });

    report.renderer.final = await readRendererProbe(page);
    report.memory.push({
      phase: "final",
      sample: await sampleProcessMemory(memoryPid),
    });
    assert(
      report.runtimeErrors.length === 0,
      `Runtime errors detected: ${JSON.stringify(report.runtimeErrors)}`,
    );
    const finalWorkspace = await page.evaluate(() =>
      window.nestor.jobFinder.getWorkspace(),
    );
    report.safetyEvents = observedSafetyEvents;
    report.safety.authoritativePersistedFacts = assertPrepareOnly(
      finalWorkspace,
      observedSafetyEvents,
    );
    report.safety.prepareOnlyVerified = true;
    report.safety.applicationActionsExecuted = false;
    report.safety.finalSubmissionClicked = false;
    report.safety.submitAuthorized = false;
    report.safety.accountCreationAuthorized = false;
    const missingScenarioIds = report.requiredScenarioCompletionIds.filter(
      (scenarioId) => !report.scenarioCompletionIds.includes(scenarioId),
    );
    assert(
      missingScenarioIds.length === 0,
      `Scale acceptance did not complete required scenarios: ${missingScenarioIds.join(", ")}`,
    );
    const planningMenuChecks = Object.values(
      report.verifications.navigation.planningSettingsMenu,
    );
    const compactNavigationChecks = Object.values(
      report.verifications.navigation.compactPlanning,
    );
    const moreMenuWithinViewport =
      planningMenuChecks.length === 2 &&
      planningMenuChecks.every(
        (check) =>
          check.pass === true &&
          check.insideViewport === true &&
          check.verticalClipEvidence?.checked === true &&
          check.verticalClipEvidence?.lastItemAfterWithinMenu === true,
      ) &&
      compactNavigationChecks.length === 2 &&
      compactNavigationChecks.every((check) => check.pass === true);
    assert(
      moreMenuWithinViewport,
      `Compact navigation/menu clipping checks did not pass: ${JSON.stringify({ planningMenuChecks, compactNavigationChecks })}`,
    );
    const compactRailChecks = Object.values(
      report.verifications.navigation.compactRail,
    );
    const planningShortcutsChecks = Object.values(
      report.verifications.navigation.planningShortcutsMenu,
    );
    const compactActiveRouteChecks =
      report.verifications.navigation.compactActiveRoute;
    const compactActiveRouteLabels = Object.keys(
      compactActiveRouteChecks,
    ).sort();
    const expectedCompactActiveRouteLabels = [
      "native125-applications",
      "native125-find-jobs",
      "native125-profile-sources",
      "native125-shortlisted",
    ];
    const compactNavigationEvidencePassed =
      compactRailChecks.length === 2 &&
      compactRailChecks.every((check) => check.pass === true) &&
      planningShortcutsChecks.length === 2 &&
      planningShortcutsChecks.every((check) => check.pass === true) &&
      JSON.stringify(compactActiveRouteLabels) ===
        JSON.stringify(expectedCompactActiveRouteLabels) &&
      Object.values(compactActiveRouteChecks).every(
        (check) => check.pass === true,
      );
    assert(
      compactNavigationEvidencePassed,
      `Compact navigation rail evidence incomplete: ${JSON.stringify({ compactRailLabels: Object.keys(report.verifications.navigation.compactRail), planningShortcutsLabels: Object.keys(report.verifications.navigation.planningShortcutsMenu), compactActiveRouteLabels, expectedCompactActiveRouteLabels })}`,
    );
    report.summary = {
      coldToUsableShellMs: report.startup.coldToUsableShellMs,
      hydratedJobs: report.hydration?.jobs ?? null,
      requiredJobCount,
      priorCapBoundaryCount,
      routeSwitchCount: report.routeSwitches.length,
      maxRouteSwitchMs: Math.max(
        ...report.routeSwitches.map((e) => e.latencyMs),
      ),
      maxHeadingObservedRouteSwitchMs: Math.max(
        ...report.routeSwitches.map((e) => e.headingObservedLatencyMs),
      ),
      runtimeErrorCount: report.runtimeErrors.length,
      longTaskSupported: report.renderer.longTaskSupported,
      paginationBounded: Object.values(report.pagination).every((p) =>
        p.pages.every((pg) => pg.mountedRows <= 50),
      ),
      horizontalOverflowPassed: report.verifications.horizontalOverflow.every(
        (v) => v.passed,
      ),
      paginationFlexWrapPassed: report.verifications.paginationFlexWrap.filter(
        (v) => v.passed,
      ).length,
      canonicalRouteCoverage: report.requiredCanonicalRoutes.every((routeId) =>
        observedRouteIds.includes(routeId),
      ),
      moreMenuWithinViewport,
      compactNavigationEvidencePassed,
      screenshotCount: report.screenshots.length,
    };
    scenarioSucceeded = true;
    await writeReport();
    process.stdout.write(`Saved capture-scale-500 report to ${outputDir}\n`);
    process.stdout.write(
      `Screenshots: ${report.screenshots.map((s) => s.fileName).join(", ")}\n`,
    );
    process.stdout.write(JSON.stringify(report.summary, null, 2) + "\n");
  } catch (error) {
    primaryScenarioError = error;
  } finally {
    let finalizationError = null;
    let ownershipError = null;
    for (const filePath of createdDemoFiles) {
      try {
        await rm(filePath, { force: true });
      } catch {
        try {
          await execFileAsync("icacls", [filePath, "/reset"]).catch(() => {});
        } catch {
          // ACL repair is best effort; the unlink retry below decides success.
        }
        try {
          await rm(filePath, { force: true });
        } catch {
          // Last-resort removal of a synthetic file created by this run.
        }
      }
    }
    if (app) {
      try {
        const appProcess = app.process();
        if (appProcess?.pid) {
          try {
            await snapshotOwnedProcessTree(
              ownedProcesses,
              appProcess.pid,
              "final",
            );
          } catch (snapshotError) {
            ownershipError =
              snapshotError instanceof Error
                ? snapshotError
                : new Error(String(snapshotError));
          }
          await forceStopElectronProcess(appProcess);
          await new Promise((r) => setTimeout(r, 800));
        }
      } catch {
        // Teardown is proven separately by verifyZeroLeftoverOwnedProcesses below.
      }
    }
    const finalTeardown = await verifyZeroLeftoverOwnedProcesses(
      ownedProcesses,
      "final",
    );
    report.processOwnership.verifications.push(finalTeardown);
    report.processOwnership.trackedProcesses = ownedProcesses.entries();
    report.processOwnership.leftoverPids = [
      ...new Set(
        report.processOwnership.verifications.flatMap(
          (verification) => verification.leftoverPids,
        ),
      ),
    ];
    report.processOwnership.verified =
      !ownershipError &&
      report.processOwnership.verifications.every(
        (verification) => verification.verified === true,
      );
    if (!report.processOwnership.verified && !ownershipError)
      ownershipError = new Error(
        `Acceptance Electron teardown left tracked process(es) alive: ${JSON.stringify(report.processOwnership.verifications.filter((v) => !v.verified))}`,
      );
    for (const output of processOutputStates) {
      try {
        finalizeProcessOutput(output, report, {
          acceptedStderrPatterns: ACCEPTED_SCALE_STDERR_PATTERNS,
        });
      } catch (error) {
        finalizationError = finalizationError ?? error;
      }
    }
    const cleanupError = await cleanupDirectory(userDataDirectory);
    report.safety.cleanedUp = !cleanupError;
    if (cleanupError) report.safety.cleanupError = String(cleanupError);
    if (
      scenarioSucceeded &&
      !finalizationError &&
      !ownershipError &&
      !cleanupError &&
      report.processOwnership.verified
    ) {
      report.pass = true;
      report.completedAt = new Date().toISOString();
    }
    let persistenceError = null;
    try {
      await writeReport();
    } catch (error) {
      persistenceError = error;
      report.pass = false;
      delete report.completedAt;
    }
    const secondaryTeardownFailures = [
      ...(ownershipError
        ? [`owned-process teardown: ${describeTeardownFailure(ownershipError)}`]
        : []),
      ...(cleanupError
        ? [
            `isolated user-data cleanup: ${describeTeardownFailure(cleanupError)}`,
          ]
        : []),
      ...(persistenceError
        ? [`report persistence: ${describeTeardownFailure(persistenceError)}`]
        : []),
    ];
    if (secondaryTeardownFailures.length > 0)
      report.teardownSecondaryFailures = [...secondaryTeardownFailures];
    const teardownFailure = resolvePrimaryRunError(
      primaryScenarioError,
      finalizationError,
    );
    if (teardownFailure && secondaryTeardownFailures.length > 0)
      Object.defineProperty(teardownFailure, "secondaryTeardownFailures", {
        value: [...secondaryTeardownFailures],
        enumerable: false,
        configurable: true,
      });
    postTeardownFailure = resolveScaleTerminalError(
      teardownFailure,
      ownershipError,
      cleanupError,
      persistenceError,
    );
  }
  if (postTeardownFailure) throw postTeardownFailure;
}

run().catch(async (error) => {
  report.failedAt = new Date().toISOString();
  report.failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.pass = false;
  delete report.completedAt;
  try {
    await writeReport();
  } catch (writeError) {
    process.stderr.write(
      `[capture-scale-500] unable to persist the failed scale report: ${describeTeardownFailure(writeError)}\n`,
    );
  }
  process.stderr.write(`${report.failure}\n`);
  process.exitCode = 1;
});
