import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ACCEPTANCE_VERSION,
  acceptanceEnvironment,
  assertReadOnlyInventoryTransform,
  assertComponentCompletion,
  artifactFingerprint,
  artifactRoot,
  attachProcessOutput,
  CANONICAL_LATENCY_BUDGETS,
  cleanupDirectory,
  createFinalAcceptanceSeal,
  createOwnedProcessLedger,
  dependencySnapshotFingerprint,
  exportAcceptedElectronApp,
  finalizeFileEvidence,
  finalizeProcessOutput,
  fingerprintSnapshot,
  isInside,
  makeEvidenceFilesReadOnly,
  makeTreeReadOnly,
  makeTreeWritable,
  materializeDependencySnapshot,
  materializeSourceSnapshot,
  PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
  repositoryRoot,
  resolvePrimaryRunError,
  sourceFingerprint,
  gitMetadata,
  sha256File,
  stableJson,
  stopAndVerifyOwnedElectron,
  verifyAcceptedElectronApp,
  verifyFinalAcceptanceSeal,
  writeJson,
} from "./release-acceptance-harness.mjs";
import { resolveBuildInvocation } from "./resolve-build-invocation.mjs";
import { _electron as electron } from "playwright";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bootstrapPaths = [
  fileURLToPath(import.meta.url),
  path.join(scriptDir, "release-acceptance-harness.mjs"),
  path.join(scriptDir, "resolve-build-invocation.mjs"),
];
const loadedBootstrapIdentity = await Promise.all(
  bootstrapPaths.map(async (filePath) => ({
    path: path.relative(repositoryRoot, filePath).split(path.sep).join("/"),
    bytes: (await stat(filePath)).size,
    sha256: await sha256File(filePath),
  })),
);
const initialBuildInvocation = resolveBuildInvocation({ repositoryRoot });
const captureScripts = [
  {
    id: "fresh",
    script: "capture-fresh-flows.mjs",
    report: "capture-report.json",
  },
  { id: "scale", script: "capture-scale-500.mjs", report: "report.json" },
  {
    id: "error-recovery",
    script: "capture-job-finder-error-recovery.mjs",
    report: "report.json",
  },
];
const EXPECTED_SCALE_ROUTE_SEQUENCE = Object.freeze([
  "profile",
  "findJobs",
  "shortlisted",
  "applications",
  "profile",
  "findJobs",
  "shortlisted",
  "applications",
  "profile",
  "findJobs",
  "shortlisted",
  "applications",
]);
const EXPECTED_SCALE_ROUTE_SWITCH_COUNT = EXPECTED_SCALE_ROUTE_SEQUENCE.length;

function now() {
  return new Date().toISOString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertFiniteNumber(value, message) {
  assert(Number.isFinite(value), message);
}

function assertAcceptanceBinding(id, report, acceptanceReport) {
  assert(
    isRecord(report.acceptance),
    `${id} report is missing its exact-build acceptance binding.`,
  );
  assert(
    report.acceptance.version === ACCEPTANCE_VERSION &&
      report.acceptance.runDir === acceptanceReport.runDir &&
      report.acceptance.manifestPath ===
        path.join(acceptanceReport.runDir, "build-manifest.json") &&
      report.acceptance.sourceFingerprint ===
        acceptanceReport.source.afterBuild?.digest &&
      report.acceptance.buildArtifactFingerprint ===
        acceptanceReport.artifacts?.digest,
    `${id} report is not bound to the exact source/build manifest.`,
  );
}

function assertCaptureSafety(id, report) {
  assert(isRecord(report.safety), `${id} report is missing safety evidence.`);
  const safety = report.safety;
  assert(
    (safety.syntheticCandidateDataOnly === true ||
      safety.syntheticTestDataOnly === true) &&
      safety.browserAgentEnabled === false &&
      safety.applicationActionsExecuted === false &&
      safety.finalSubmissionClicked === false &&
      safety.submitAuthorized === false &&
      safety.accountCreationAuthorized === false &&
      safety.prepareOnlyVerified === true &&
      isRecord(safety.authoritativePersistedFacts) &&
      safety.authoritativePersistedFacts.pass === true &&
      safety.authoritativePersistedFacts.submittedCount === 0 &&
      safety.authoritativePersistedFacts.externalWriteCount === 0 &&
      safety.cleanedUp === true,
    `${id} report does not prove an isolated prepare-only run: ${JSON.stringify(safety)}`,
  );
  const observedSafetyEvents = Array.isArray(safety.observedSafetyEvents)
    ? safety.observedSafetyEvents
    : report.safetyEvents;
  assert(
    Array.isArray(observedSafetyEvents) && observedSafetyEvents.length === 0,
    `${id} report contains missing or observed safety events: ${JSON.stringify(observedSafetyEvents)}`,
  );
}

function assertScenarioContract(id, report, entries) {
  assert(
    Array.isArray(report.requiredScenarioCompletionIds) &&
      report.requiredScenarioCompletionIds.length > 0 &&
      report.requiredScenarioCompletionIds.every(
        (scenarioId) => typeof scenarioId === "string" && scenarioId.length > 0,
      ),
    `${id} report is missing a non-empty required scenario list.`,
  );
  assert(
    Array.isArray(report.scenarioCompletionIds) &&
      report.scenarioCompletionIds.length > 0 &&
      report.scenarioCompletionIds.every(
        (scenarioId) => typeof scenarioId === "string" && scenarioId.length > 0,
      ),
    `${id} report is missing a non-empty completed scenario list.`,
  );
  assert(
    new Set(report.requiredScenarioCompletionIds).size ===
      report.requiredScenarioCompletionIds.length,
    `${id} report contains duplicate required scenario IDs.`,
  );
  assert(
    new Set(report.scenarioCompletionIds).size ===
      report.scenarioCompletionIds.length,
    `${id} report contains duplicate completed scenario IDs.`,
  );
  const completed = new Set(report.scenarioCompletionIds);
  assert(
    report.requiredScenarioCompletionIds.every((scenarioId) =>
      completed.has(scenarioId),
    ),
    `${id} report did not complete every required scenario.`,
  );
  for (const entry of entries) {
    assert(
      isRecord(entry) &&
        typeof entry.scenarioId === "string" &&
        entry.scenarioId.length > 0,
      `${id} capture entry is missing an explicit scenario ID.`,
    );
  }
}

const REQUIRED_SCALE_JOB_COUNT = 5_000;
const PRIOR_SCALE_CAP_BOUNDARY_COUNT = 1_001;
const PRIOR_SILENT_CAP_COUNT = 1_000;

// The scale capture must prove the hydrated production contract: the full
// discovery-job axis through real Electron bootstrap, persistence, hydration,
// and IPC, with every prior-cap boundary collection still present. Values are
// release-gate constants here, not values trusted from the capture report.
function assertScaleDataContract(report) {
  assert(
    isRecord(report.scaleBoundary) &&
      report.scaleBoundary.requiredJobCount === REQUIRED_SCALE_JOB_COUNT &&
      report.scaleBoundary.priorCapBoundaryCount ===
        PRIOR_SCALE_CAP_BOUNDARY_COUNT &&
      report.scaleBoundary.priorSilentCap === PRIOR_SILENT_CAP_COUNT,
    `Scale acceptance does not declare the ${REQUIRED_SCALE_JOB_COUNT}-job versus ${PRIOR_SCALE_CAP_BOUNDARY_COUNT}-record boundary contract: ${JSON.stringify(report.scaleBoundary)}`,
  );
  assert(
    isRecord(report.hydration) &&
      report.hydration.phase === "complete" &&
      report.hydration.jobs === REQUIRED_SCALE_JOB_COUNT &&
      Number.isFinite(report.hydration.shortlisted) &&
      Number.isFinite(report.hydration.applications) &&
      Number.isFinite(report.hydration.sources),
    `Scale acceptance did not prove ${REQUIRED_SCALE_JOB_COUNT} hydrated jobs after cold launch: ${JSON.stringify(report.hydration)}`,
  );
  for (const field of ["shortlisted", "applications", "sources"]) {
    assert(
      report.hydration[field] >= PRIOR_SCALE_CAP_BOUNDARY_COUNT,
      `Scale hydration retained only ${report.hydration[field]} ${field}; the prior-cap boundary requires at least ${PRIOR_SCALE_CAP_BOUNDARY_COUNT}.`,
    );
  }
  const synthetic = isRecord(report.syntheticData) ? report.syntheticData : {};
  assert(
    synthetic.jobs === REQUIRED_SCALE_JOB_COUNT &&
      synthetic.shortlisted >= PRIOR_SCALE_CAP_BOUNDARY_COUNT &&
      synthetic.applications >= PRIOR_SCALE_CAP_BOUNDARY_COUNT &&
      synthetic.sources >= PRIOR_SCALE_CAP_BOUNDARY_COUNT,
    `Scale synthetic seed data does not match the required contract: ${JSON.stringify(synthetic)}`,
  );
}

function assertScalePerformanceContract(report) {
  assert(
    isRecord(report.latencyBudgets) &&
      report.latencyBudgets.coldToUsableShellMs ===
        CANONICAL_LATENCY_BUDGETS.coldToUsableShellMs &&
      report.latencyBudgets.warmRouteSwitchMs ===
        CANONICAL_LATENCY_BUDGETS.warmRouteSwitchMs,
    "Scale acceptance did not record the canonical latency budgets.",
  );
  assertFiniteNumber(
    report.startup?.coldToUsableShellMs,
    "Scale acceptance did not record a finite cold usable-shell measurement.",
  );
  assert(
    report.startup.coldToUsableShellMs <=
      CANONICAL_LATENCY_BUDGETS.coldToUsableShellMs,
    `Scale cold-start latency exceeded ${CANONICAL_LATENCY_BUDGETS.coldToUsableShellMs} ms.`,
  );
  assert(
    Array.isArray(report.startup.timingMarks) &&
      report.startup.timingMarks.length > 0,
    "Scale acceptance did not record renderer timing marks.",
  );
  for (const mark of report.startup.timingMarks) {
    assert(
      isRecord(mark) &&
        typeof mark.name === "string" &&
        mark.name.length > 0 &&
        Number.isFinite(mark.startTime) &&
        Number.isFinite(mark.duration),
      `Scale acceptance contains an invalid renderer timing mark: ${JSON.stringify(mark)}`,
    );
  }
  assert(
    Array.isArray(report.routeSwitches) &&
      report.routeSwitches.length === EXPECTED_SCALE_ROUTE_SWITCH_COUNT,
    `Scale acceptance must record exactly ${EXPECTED_SCALE_ROUTE_SWITCH_COUNT} canonical route switches.`,
  );
  report.routeSwitches.forEach((routeEntry, index) => {
    assert(
      isRecord(routeEntry) &&
        routeEntry.route === EXPECTED_SCALE_ROUTE_SEQUENCE[index] &&
        routeEntry.cycle === Math.floor(index / 4) + 1,
      `Scale acceptance route ${index + 1} does not match the canonical route sequence.`,
    );
    assertFiniteNumber(
      routeEntry.latencyMs,
      `Scale route ${index + 1} has no finite latency mark.`,
    );
    assert(
      routeEntry.latencyMs >= 0 &&
        routeEntry.latencyMs <= CANONICAL_LATENCY_BUDGETS.warmRouteSwitchMs,
      `Scale route ${index + 1} exceeded the canonical warm-route budget.`,
    );
    assert(
      routeEntry.headingObservedLatencyMs >= 0 &&
        routeEntry.headingObservedLatencyMs <=
          CANONICAL_LATENCY_BUDGETS.warmRouteSwitchMs,
      `Scale route ${index + 1} exceeded the canonical warm-route budget for externally observed heading readiness (${routeEntry.headingObservedLatencyMs} ms).`,
    );
    for (const field of ["headingObservedLatencyMs", "rendererRoundTripMs"]) {
      assertFiniteNumber(
        routeEntry[field],
        `Scale route ${index + 1} has no finite ${field} mark.`,
      );
    }
    const rendererTiming = routeEntry.rendererTiming;
    assert(
      isRecord(rendererTiming) &&
        Number.isFinite(rendererTiming.start) &&
        Number.isFinite(rendererTiming.end) &&
        Number.isFinite(rendererTiming.durationMs) &&
        rendererTiming.end >= rendererTiming.start &&
        rendererTiming.durationMs >= 0 &&
        (rendererTiming.feedbackDurationMs === null ||
          Number.isFinite(rendererTiming.feedbackDurationMs)),
      `Scale route ${index + 1} has incomplete renderer timing marks.`,
    );
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function runCommand(command, args, options = {}) {
  const startedAt = now();
  const startedClock = performance.now();
  let result;
  try {
    result = await execFileAsync(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? acceptanceEnvironment(),
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    result = {
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      error,
    };
  }
  return {
    command,
    args,
    startedAt,
    finishedAt: now(),
    durationMs: Math.round((performance.now() - startedClock) * 100) / 100,
    exitCode:
      result.error?.code && typeof result.error.code === "number"
        ? result.error.code
        : result.error
          ? 1
          : 0,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    error: result.error
      ? result.error instanceof Error
        ? result.error.message
        : String(result.error)
      : null,
  };
}

// Spawn a capture component as a directly tracked child so its PID and exit
// are owned by this wrapper instead of being hidden behind a promisified
// execFile handle.
export function runTrackedCommand(command, args, options = {}) {
  const startedAt = now();
  const startedClock = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? acceptanceEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const outputLimit = 64 * 1024 * 1024;
    const streams = { stdout: "", stderr: "" };
    let spawnError = null;
    const tracked = new Map();
    const processGroupId = process.platform === "win32" ? null : child.pid;
    if (child.pid)
      tracked.set(child.pid, {
        pid: child.pid,
        parentPid: process.pid,
        command: [command, ...args].join(" "),
      });
    const sampleOwnedTree = async () => {
      if (!child.pid) return;
      try {
        const table = await readProcessTable();
        const pending = [child.pid];
        const descendants = new Set();
        while (pending.length > 0) {
          const pid = pending.pop();
          if (descendants.has(pid)) continue;
          descendants.add(pid);
          for (const row of table)
            if (row.parentPid === pid) pending.push(row.pid);
        }
        for (const row of table) {
          if (
            descendants.has(row.pid) ||
            (processGroupId !== null && row.processGroupId === processGroupId)
          )
            tracked.set(row.pid, {
              pid: row.pid,
              parentPid: row.parentPid,
              command: row.command,
            });
        }
      } catch {
        // Best effort sampler: the owned tree may vanish mid-walk while the
        // command is exiting, which must not fail the tracked run itself.
      }
    };
    void sampleOwnedTree();
    const ownershipSampler = setInterval(() => void sampleOwnedTree(), 10);
    for (const streamName of ["stdout", "stderr"]) {
      child[streamName]?.on("data", (chunk) => {
        if (streams[streamName].length <= outputLimit)
          streams[streamName] += String(chunk);
      });
    }
    let settled = false;
    const finish = async (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(ownershipSampler);
      await sampleOwnedTree();
      resolve({
        command,
        args,
        startedAt,
        finishedAt: now(),
        durationMs: Math.round((performance.now() - startedClock) * 100) / 100,
        exitCode: code ?? 1,
        stdout: streams.stdout,
        stderr: streams.stderr,
        error: spawnError
          ? spawnError.message
          : signal
            ? `exited on signal ${signal}`
            : null,
        childPid: child.pid ?? null,
        processGroupId,
        trackedProcesses: [...tracked.values()],
      });
    };
    child.once("error", (error) => {
      spawnError = error;
      if (!child.pid) void finish(1, null);
    });
    child.once("exit", (code, signal) => void finish(code, signal));
  });
}

// Read-only OS process-table snapshot. Used only to recheck PIDs that the
// acceptance run itself launched and recorded; no signal is ever sent through
// these queries.
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
      processGroupId: null,
      command: String(row.CommandLine ?? ""),
    }));
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-axww", "-o", "pid=,ppid=,pgid=,command="],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
      return match
        ? {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            processGroupId: Number(match[3]),
            command: match[4],
          }
        : null;
    })
    .filter((row) => row !== null);
}

export async function terminateAndVerifyTrackedCommand(result, label) {
  const trackedProcesses = Array.isArray(result?.trackedProcesses)
    ? result.trackedProcesses
    : [];
  if (process.platform !== "win32" && result?.processGroupId) {
    try {
      process.kill(-result.processGroupId, "SIGTERM");
    } catch {
      // Best effort: the tracked process group may already be gone.
    }
  } else {
    for (const entry of [...trackedProcesses].reverse()) {
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch {
        // Best effort: the tracked process may already be gone.
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    await assertNoSurvivingTrackedProcesses(trackedProcesses, label);
  } catch {
    if (process.platform !== "win32" && result?.processGroupId) {
      try {
        process.kill(-result.processGroupId, "SIGKILL");
      } catch {
        // Best effort escalation: the group may already be gone.
      }
    } else {
      for (const entry of [...trackedProcesses].reverse()) {
        try {
          process.kill(entry.pid, "SIGKILL");
        } catch {
          // Best effort escalation: the process may already be gone.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assertNoSurvivingTrackedProcesses(trackedProcesses, label);
  }
  return {
    verified: true,
    trackedProcesses,
    leftoverPids: [],
    processGroupId: result?.processGroupId ?? null,
  };
}

// Independent wrapper-side proof that every Electron process tracked by a
// capture is gone. A live PID only counts as a survivor when its exact command
// line still matches the identity snapshotted while the process was alive; a
// changed command line proves the PID was recycled by an unrelated process.
async function assertNoSurvivingTrackedProcesses(trackedProcesses, label) {
  assert(
    Array.isArray(trackedProcesses) && trackedProcesses.length > 0,
    `${label} did not record any tracked acceptance-owned processes.`,
  );
  const table = await readProcessTable();
  const commandsByPid = new Map(table.map((row) => [row.pid, row.command]));
  const survivors = [];
  for (const entry of trackedProcesses) {
    if (!isRecord(entry) || !Number.isInteger(entry.pid)) continue;
    const command = commandsByPid.get(entry.pid);
    if (command === undefined) continue;
    if (entry.command === "" || command === entry.command)
      survivors.push({ pid: entry.pid, role: entry.role, command });
  }
  assert(
    survivors.length === 0,
    `${label} left ${survivors.length} acceptance-owned process(es) alive after teardown: ${JSON.stringify(survivors.slice(0, 5))}`,
  );
}

async function assertExpectedBuildOutputs(rootDesktopDir) {
  const required = ["out/main", "out/preload", "out/renderer/index.html"];
  const inventory = [];
  for (const relativePath of required) {
    const fullPath = path.resolve(rootDesktopDir, relativePath);
    assert(
      existsSync(fullPath),
      `The exact build did not produce ${relativePath}.`,
    );
    const fileStat = await stat(fullPath);
    if (relativePath.endsWith("index.html"))
      assert(
        fileStat.isFile() && fileStat.size > 0,
        `${relativePath} is empty.`,
      );
    else assert(fileStat.isDirectory(), `${relativePath} is not a directory.`);
    inventory.push({
      path: relativePath,
      kind: fileStat.isDirectory() ? "directory" : "file",
      bytes: fileStat.isFile() ? fileStat.size : null,
    });
  }
  return inventory;
}

async function pngMetadata(filePath) {
  const contents = await readFile(filePath);
  assert(
    contents.length >= 24 &&
      contents.readUInt32BE(0) === 0x89504e47 &&
      contents.toString("ascii", 1, 4) === "PNG",
    `Invalid PNG screenshot: ${filePath}`,
  );
  return {
    bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  };
}

async function verifyScreenshots(runDir, report) {
  assert(
    Array.isArray(report.captures) || Array.isArray(report.screenshots),
    "Capture report has no screenshot entries.",
  );
  const entries = report.captures ?? report.screenshots;
  assert(entries.length > 0, "Capture report contains no screenshots.");
  const seen = new Set();
  for (const entry of entries) {
    const filePath = path.resolve(
      entry.path ?? entry.fullPath ?? path.join(runDir, entry.fileName),
    );
    assert(
      isInside(runDir, filePath),
      `Screenshot escaped the acceptance run directory: ${filePath}`,
    );
    assert(
      !seen.has(filePath),
      `Screenshot was recorded more than once: ${filePath}`,
    );
    seen.add(filePath);
    assert(
      existsSync(filePath),
      `Capture report references a missing screenshot: ${filePath}`,
    );
    const actual = await pngMetadata(filePath);
    const expected = entry.screenshot ?? {};
    assert(
      actual.sha256 === expected.sha256,
      `Screenshot hash changed after capture: ${filePath}`,
    );
    assert(
      actual.width === expected.width && actual.height === expected.height,
      `Screenshot dimensions changed after capture: ${filePath}`,
    );
    assert(
      entry.route || entry.viewport?.css || entry.viewport,
      `Screenshot lacks route/viewport metadata: ${filePath}`,
    );
  }
  const descendants = [];
  const walk = async (directory) => {
    for (const name of await (
      await import("node:fs/promises")
    ).readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, name.name);
      if (name.isDirectory()) await walk(child);
      else if (name.isFile() && name.name.toLowerCase().endsWith(".png"))
        descendants.push(child);
    }
  };
  await walk(runDir);
  assert(
    descendants.length === seen.size,
    `Acceptance run contains unreported or missing screenshots: reported=${seen.size} actual=${descendants.length}`,
  );
  return { screenshotCount: seen.size };
}

function assertScenarioMatrix(id, report) {
  const entries = report.captures ?? report.screenshots ?? [];
  const labels = entries.map((entry) =>
    `${entry.label ?? entry.fileName ?? ""}`.toLowerCase(),
  );
  const has = (pattern) => labels.some((label) => pattern.test(label));
  // Error/recovery now also captures a native-1.25 recovered-preview leg, so
  // every component must show a 1440 desktop scenario and a native 125%
  // scenario.
  assert(
    has(/1440|desktop|normal/),
    `${id} acceptance did not capture a 1440 desktop scenario.`,
  );
  assert(
    has(/125/),
    `${id} acceptance did not capture a native 125% scenario.`,
  );
  assert(
    has(/minimum|1024|narrow/),
    `${id} acceptance did not capture the 1024px minimum-width scenario.`,
  );
  if (id === "fresh")
    assert(
      has(/empty|zero|fresh/),
      `${id} acceptance did not capture a zero/empty state.`,
    );
  if (id === "error-recovery") {
    assert(
      has(/error|failure/),
      "Error/recovery acceptance did not capture an error state.",
    );
    assert(
      has(/recover/),
      "Error/recovery acceptance did not capture the recovered state.",
    );
  }
  if (id === "error-recovery")
    assert(
      has(/preview|resume/),
      "Error/recovery acceptance did not capture the resume surface.",
    );
  else
    assert(
      has(/populated|rows|sources|jobs|applications/),
      `${id} acceptance did not capture a populated state.`,
    );
  assert(
    labels.every((label, index) => entries[index].seedDigest),
    `${id} screenshot metadata is missing deterministic seed digests.`,
  );
}

async function writeCommandLogs(runDir, id, result) {
  await writeFile(path.join(runDir, `${id}-stdout.log`), result.stdout, "utf8");
  await writeFile(path.join(runDir, `${id}-stderr.log`), result.stderr, "utf8");
}

// Generic screenshot-state collision scan across every capture component the
// wrapper sees. Any repeated PNG digest is reported together with both
// component, scenario IDs, and files when those entries claim distinct visual
// states. A shared-shell assertion may retain a separate completion scenario
// while binding to the same screenshotStateId as its host capture.
function findCrossComponentScreenshotCollisions(entriesByComponent) {
  const byDigest = new Map();
  for (const componentId of Object.keys(entriesByComponent)) {
    for (const entry of entriesByComponent[componentId]) {
      const digest = entry?.screenshot?.sha256 ?? entry?.sha256 ?? null;
      const fileName =
        entry?.fullPath ?? entry?.path ?? entry?.fileName ?? null;
      const scenarioId = entry?.scenarioId ?? null;
      if (!digest || !scenarioId || !fileName) continue;
      const occurrences = byDigest.get(digest) ?? [];
      occurrences.push({
        component: componentId,
        scenarioId,
        screenshotStateId: entry?.screenshotStateId ?? scenarioId,
        fileName,
      });
      byDigest.set(digest, occurrences);
    }
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
  return { collisions };
}

export const REQUIRED_ERROR_RECOVERY_SCENARIOS = Object.freeze([
  Object.freeze({
    scenario: "recovery",
    scenarioId: "error-preview-recovered-native125",
  }),
  Object.freeze({
    scenario: "recovery",
    scenarioId: "error-preview-recovered-minimum",
  }),
]);

// Binds error-recovery capture entries to the two exact recovered-preview
// scenario IDs instead of the mutable scenario label: every required ID must
// appear exactly once, labeled recovery, carrying passing
// previewContentEvidence; duplicates, missing IDs, mislabeled or failing
// entries, and stray recovery labels all fail. The error entry is exempt.
// The zoomed recovered-preview leg runs at practical native 1.25 zoom, the
// same current-acceptance bar as the fresh/scale matrix; native 200% was
// removed from current acceptance by user decision.
export function evaluateErrorRecoveryCaptureEntries(entries) {
  const violations = [];
  const list = Array.isArray(entries) ? entries : [];
  const requiredScenarioIds = REQUIRED_ERROR_RECOVERY_SCENARIOS.map(
    (required) => required.scenarioId,
  );
  const seenScenarioIds = new Set();
  for (const [index, entry] of list.entries()) {
    const scenarioId = entry?.scenarioId;
    if (typeof scenarioId !== "string" || scenarioId.length === 0) {
      violations.push(`capture entry ${index} is missing scenarioId`);
      continue;
    }
    if (seenScenarioIds.has(scenarioId))
      violations.push(`duplicate capture entry scenarioId ${scenarioId}`);
    seenScenarioIds.add(scenarioId);
  }
  for (const required of REQUIRED_ERROR_RECOVERY_SCENARIOS) {
    const matches = list.filter(
      (entry) => entry?.scenarioId === required.scenarioId,
    );
    if (matches.length === 0) {
      violations.push(`missing required recovery entry ${required.scenarioId}`);
      continue;
    }
    if (matches.length > 1) {
      violations.push(
        `duplicate recovery entries for ${required.scenarioId} (${matches.length})`,
      );
      continue;
    }
    const entry = matches[0];
    if (entry.scenario !== required.scenario)
      violations.push(
        `recovery entry ${required.scenarioId} is mislabeled scenario ${JSON.stringify(entry.scenario)}`,
      );
    if (
      !isRecord(entry.previewContentEvidence) ||
      entry.previewContentEvidence.pass !== true
    )
      violations.push(
        `recovery entry ${required.scenarioId} lacks passing previewContentEvidence`,
      );
  }
  for (const [index, entry] of list.entries()) {
    if (
      entry?.scenario === "recovery" &&
      !requiredScenarioIds.includes(entry?.scenarioId)
    )
      violations.push(
        `capture entry ${index} claims scenario "recovery" without a required recovered-preview scenarioId: ${JSON.stringify(entry?.scenarioId)}`,
      );
  }
  return { pass: violations.length === 0, violations };
}

// Native-zoom binding authority for every current capture entry: the only
// accepted native webContents zoom factors are exactly 1 (compact desktop
// coverage) and 1.25 (the current low-vision acceptance bar). Required-row
// checks such as the product-surface matrix cannot see extra rows, so this
// sweep fails closed on ANY capture entry whose recorded
// viewportMetadata.nativeZoomFactor is not a finite number inside that exact
// set — including a reintroduced 2.0 row riding beside healthy evidence.
export const ACCEPTED_CAPTURE_NATIVE_ZOOM_FACTORS = Object.freeze([1, 1.25]);

export function findDisallowedCaptureNativeZoomFactors(component, entries) {
  if (!Array.isArray(entries))
    return [
      `${component} did not provide an array of capture entries for the native-zoom binding audit`,
    ];
  const violations = [];
  for (const [index, entry] of entries.entries()) {
    const observed = entry?.viewportMetadata?.nativeZoomFactor;
    if (
      !Number.isFinite(observed) ||
      !ACCEPTED_CAPTURE_NATIVE_ZOOM_FACTORS.includes(observed)
    )
      violations.push(
        `${component} capture entry ${index} (${
          entry?.scenarioId ?? entry?.label ?? entry?.fileName ?? "unlabeled"
        }) recorded nativeZoomFactor ${String(observed)} outside the accepted finite set ${JSON.stringify(ACCEPTED_CAPTURE_NATIVE_ZOOM_FACTORS)}`,
      );
  }
  return violations;
}

function assertProductSurfaceViewportMatrix(entriesByComponent) {
  // Every zoomed row runs at practical native 1.25 zoom (the current
  // acceptance bar). The Applications rows are captured by the scale
  // component; the Resume Studio rows are produced by the error-recovery
  // component, whose recovered-preview leg also converted from native zoom 2
  // to native 1.25 alongside the rest of the matrix.
  const entries = Object.values(entriesByComponent).flat();
  const required = [
    {
      surface: "Applications",
      route: /#\/job-finder\/applications/,
      viewport: { width: 1440, height: 920, zoomFactor: 1 },
    },
    {
      surface: "Applications",
      route: /#\/job-finder\/applications/,
      viewport: { width: 1440, height: 920, zoomFactor: 1.25 },
    },
    {
      surface: "Applications",
      route: /#\/job-finder\/applications/,
      viewport: { width: 1024, height: 768, zoomFactor: 1 },
    },
    {
      surface: "Resume Studio",
      route: /#\/job-finder\/review-queue\/[^/]+\/resume/,
      viewport: { width: 1440, height: 920, zoomFactor: 1 },
    },
    {
      surface: "Resume Studio",
      route: /#\/job-finder\/review-queue\/[^/]+\/resume/,
      viewport: { width: 1440, height: 920, zoomFactor: 1.25 },
    },
    {
      surface: "Resume Studio",
      route: /#\/job-finder\/review-queue\/[^/]+\/resume/,
      viewport: { width: 1024, height: 768, zoomFactor: 1 },
    },
  ];
  for (const expectation of required) {
    const found = entries.some((entry) => {
      const viewport = entry.viewportMetadata;
      return (
        expectation.route.test(entry.route ?? "") &&
        viewport?.physical?.width === expectation.viewport.width &&
        viewport?.physical?.height === expectation.viewport.height &&
        viewport?.nativeZoomFactor === expectation.viewport.zoomFactor &&
        entry.pass === true
      );
    });
    assert(
      found,
      `${expectation.surface} lacks observed production capture coverage at ${JSON.stringify(expectation.viewport)}.`,
    );
  }
}

export async function buildEvidenceInventory(
  runDir,
  captureReportsById,
  captureEntriesByComponent,
  acceptedApp,
  runtimeProbePath,
  additionalEvidenceFiles = [],
) {
  const files = [];
  for (const [component, report] of Object.entries(captureReportsById)) {
    const reportPath = report.__reportPath;
    const reportStat = await stat(reportPath);
    files.push({
      component,
      kind: "report",
      path: path.relative(runDir, reportPath).split(path.sep).join("/"),
      bytes: reportStat.size,
      sha256: await sha256File(reportPath),
    });
    for (const entry of captureEntriesByComponent[component] ?? []) {
      const screenshotPath = path.resolve(
        entry.path ??
          entry.fullPath ??
          path.join(runDir, component, entry.fileName),
      );
      if (!isInside(runDir, screenshotPath))
        throw new Error(
          `${component} screenshot path escaped the acceptance run directory: ${screenshotPath}`,
        );
      const screenshotStat = await stat(screenshotPath);
      files.push({
        component,
        kind: "screenshot",
        scenarioId: entry.scenarioId,
        path: path.relative(runDir, screenshotPath).split(path.sep).join("/"),
        bytes: screenshotStat.size,
        sha256: await sha256File(screenshotPath),
      });
    }
  }
  for (const entry of acceptedApp.files) {
    files.push({
      component: "accepted-app",
      kind: "accepted-app-file",
      path: `${acceptedApp.path}/${entry.path}`,
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
  }
  const runtimeProbeStat = await stat(runtimeProbePath);
  files.push({
    component: "accepted-app-runtime-probe",
    kind: "report",
    path: path.relative(runDir, runtimeProbePath).split(path.sep).join("/"),
    bytes: runtimeProbeStat.size,
    sha256: await sha256File(runtimeProbePath),
  });
  for (const extra of additionalEvidenceFiles) {
    if (!isInside(runDir, extra.path))
      throw new Error(
        `${extra.component} ${extra.kind} path escaped the acceptance run directory: ${extra.path}`,
      );
    const extraStat = await stat(extra.path);
    files.push({
      component: extra.component,
      kind: extra.kind,
      path: path.relative(runDir, extra.path).split(path.sep).join("/"),
      bytes: extraStat.size,
      sha256: await sha256File(extra.path),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    algorithm: "sha256",
    fileCount: files.length,
    files,
    digest: createHash("sha256").update(stableJson(files)).digest("hex"),
  };
}

// Binds the Electron runtime identity (executable bytes plus electron and
// playwright package versions) as seen from one package root. Every resolved
// electron/playwright path is contained: each candidate is realpath-resolved
// and must stay inside the accepted root, so a resolution that escapes —
// toward the original workspace, an ambient install, or any aliased parent —
// fails closed instead of sealing a foreign runtime identity.
export async function electronIdentityFromSnapshot(
  snapshotDesktopDir,
  { containmentRoot = path.resolve(snapshotDesktopDir, "..", "..") } = {},
) {
  const canonicalContainmentRoot = await realpath(containmentRoot);
  const requireFromDesktop = createRequire(
    path.join(snapshotDesktopDir, "package.json"),
  );
  const ensureInsideAcceptedRoot = async (candidate, label) => {
    const resolved = await realpath(candidate);
    if (!isInside(canonicalContainmentRoot, resolved))
      throw new Error(
        `${label} escaped the accepted root (${canonicalContainmentRoot}): ${resolved}`,
      );
    return resolved;
  };
  const executablePath = await ensureInsideAcceptedRoot(
    await realpath(requireFromDesktop("electron")),
    "Electron executable",
  );
  const electronEntry = await ensureInsideAcceptedRoot(
    requireFromDesktop.resolve("electron"),
    "Electron entry",
  );
  const electronPackagePath = await ensureInsideAcceptedRoot(
    path.join(path.dirname(electronEntry), "package.json"),
    "Electron package manifest",
  );
  const electronPackage = JSON.parse(
    await readFile(electronPackagePath, "utf8"),
  );
  const playwrightPackagePath = await ensureInsideAcceptedRoot(
    requireFromDesktop.resolve("playwright/package.json"),
    "Playwright package manifest",
  );
  const playwrightPackage = JSON.parse(
    await readFile(playwrightPackagePath, "utf8"),
  );
  const executableStat = await stat(executablePath);
  return {
    executablePath,
    bytes: executableStat.size,
    sha256: await sha256File(executablePath),
    electronPackageVersion: electronPackage.version,
    playwrightPackageVersion: playwrightPackage.version,
  };
}

// ---------------------------------------------------------------------------
// Production-like tester probe
//
// A second, fully isolated launch of the same sealed accepted-app that proves
// blind-persona-style tester session authority (allowlisted environment with
// the scripted test API absent, explicit startup geometry, live CDP channel)
// without consuming any P01-P14 persona workspace.
// ---------------------------------------------------------------------------

export const PRODUCTION_TESTER_GEOMETRY_REQUEST = Object.freeze({
  height: 720,
  width: 1280,
  zoomFactor: 1.25,
});

export const PRODUCTION_TESTER_USER_DATA_DIR_NAME =
  "production-tester-user-data";

export const PRODUCTION_TESTER_SCREENSHOT_FILE_NAME =
  "accepted-app-production-tester.png";

// Zero-network launch rules shared by every accepted-app launch in this
// wrapper: all non-resolved hosts map to the unroutable 0.0.0.0 dead end,
// localhost resolution is excluded, and traffic is forced through a loopback
// discard-port proxy that can never answer.
export const ACCEPTANCE_ZERO_NETWORK_LAUNCH_ARGS = Object.freeze([
  "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost",
  "--proxy-server=127.0.0.1:9",
]);

// Exact custom spawn arguments for the production-like tester launch: app
// positional, zero-network rules, and a loopback ephemeral CDP endpoint.
export const PRODUCTION_TESTER_LAUNCH_ARGS = Object.freeze([
  ".",
  ...ACCEPTANCE_ZERO_NETWORK_LAUNCH_ARGS,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
]);

const PRODUCTION_TESTER_MIN_WINDOW_DIMENSION_PX = 400;
// Mirrors the BrowserWindow minWidth/minHeight constraints in
// src/main/setup/window-shell.ts: Electron enforces these after any
// work-area clamp, so applied outer bounds can never be smaller.
const PRODUCTION_TESTER_WINDOW_MIN_WIDTH_PX = 1024;
const PRODUCTION_TESTER_WINDOW_MIN_HEIGHT_PX = 720;

// Ambient names copied into the production-like tester process. Everything
// else is dropped: provider keys/secrets, proxies, HOME, and every other
// ambient variable stay outside the sealed app's environment.
const productionTesterAmbientAllowlist = Object.freeze([
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "PATH",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);

// Ambient names recorded as stripped authority facts: the scripted test API,
// home-directory hints, and anything shaped like a credential or proxy.
const PRODUCTION_TESTER_FORBIDDEN_ENVIRONMENT_NAMES = Object.freeze([
  "NESTOR_ENABLE_TEST_API",
  "HOME",
]);
const productionTesterForbiddenNamePattern =
  /API_KEY|API_TOKEN|SECRET|TOKEN|PROXY/i;

function productionTesterGeometryEnvironmentNames() {
  return [
    "NESTOR_STARTUP_WINDOW_WIDTH",
    "NESTOR_STARTUP_WINDOW_HEIGHT",
    "NESTOR_STARTUP_ZOOM_FACTOR",
    "NESTOR_TESTER_SESSION_GEOMETRY",
  ];
}

export function productionTesterEnvironment(ambient, userDataRoot) {
  const copiedNames = [];
  const strippedNames = [];
  const env = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (
      PRODUCTION_TESTER_FORBIDDEN_ENVIRONMENT_NAMES.includes(name) ||
      productionTesterForbiddenNamePattern.test(name)
    ) {
      strippedNames.push(name);
      continue;
    }
    if (productionTesterGeometryEnvironmentNames().includes(name)) {
      // Ambient geometry requests never leak in: canonical values are
      // re-injected below together with the tester session marker.
      strippedNames.push(name);
      continue;
    }
    if (
      productionTesterAmbientAllowlist.includes(name) &&
      typeof value === "string" &&
      value !== ""
    ) {
      env[name] = value;
      copiedNames.push(name);
    }
  }
  // Defensive deletions keep forbidden authority out even if an ambient name
  // ever collides with an injected one below.
  delete env.HOME;
  delete env.NESTOR_ENABLE_TEST_API;
  for (const name of productionTesterGeometryEnvironmentNames())
    delete env[name];
  env.NESTOR_USER_DATA_DIR = userDataRoot;
  env.NESTOR_TEST_API_USE_LIVE_AI = "0";
  env.NESTOR_BROWSER_AGENT = "0";
  env.NESTOR_BROWSER_HEADLESS = "1";
  env.JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES = "0";
  env.JOB_FINDER_COMPLETE_FLOW_AUTHORIZED_WRITE_DIAGNOSTIC = "0";
  env.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES = "0";
  env.NESTOR_TESTER_SESSION_GEOMETRY = "1";
  env.NESTOR_STARTUP_WINDOW_WIDTH = String(
    PRODUCTION_TESTER_GEOMETRY_REQUEST.width,
  );
  env.NESTOR_STARTUP_WINDOW_HEIGHT = String(
    PRODUCTION_TESTER_GEOMETRY_REQUEST.height,
  );
  env.NESTOR_STARTUP_ZOOM_FACTOR = String(
    PRODUCTION_TESTER_GEOMETRY_REQUEST.zoomFactor,
  );
  return {
    copiedNames: copiedNames.sort(),
    env,
    injectedNames: Object.keys(env)
      .filter((name) => !copiedNames.includes(name))
      .sort(),
    strippedNames: [...new Set(strippedNames)].sort(),
  };
}

export function parseDevToolsActivePortContents(contents) {
  if (typeof contents !== "string") return null;
  const firstLine = (contents.split(/\r?\n/u, 1)[0] ?? "").trim();
  if (!/^\d{1,5}$/u.test(firstLine)) return null;
  const port = Number(firstLine);
  return port >= 1 && port <= 65535 ? port : null;
}

// Pure PNG header check: magic bytes plus IHDR width/height (offsets 16/20).
// Dimensions are only reported for a valid PNG header, never for junk bytes.
export function parsePngMetadata(contents) {
  const magicValid =
    Buffer.isBuffer(contents) &&
    contents.length >= 24 &&
    contents.readUInt32BE(0) === 0x89504e47 &&
    contents.toString("ascii", 1, 4) === "PNG";
  return {
    height: magicValid ? contents.readUInt32BE(20) : null,
    magicValid,
    width: magicValid ? contents.readUInt32BE(16) : null,
  };
}

// Pure /json/version body verdict. A reachable body without both required
// keys is NOT ready: the CDP resolver must keep polling until its deadline.
export function evaluateCdpVersionBody(body) {
  if (!isRecord(body)) return { ready: false, requiredKeys: null };
  const requiredKeys = {
    Browser: typeof body.Browser === "string" && body.Browser.length > 0,
    webSocketDebuggerUrl:
      typeof body.webSocketDebuggerUrl === "string" &&
      body.webSocketDebuggerUrl.length > 0,
  };
  return {
    ready:
      requiredKeys.Browser === true &&
      requiredKeys.webSocketDebuggerUrl === true,
    requiredKeys,
  };
}

// Pinned exact accepted key sets for the launched child main-process
// authority record: the flat sample and its nested launch-switch record must
// carry exactly these keys and nothing else.
export const CHILD_ENVIRONMENT_AUTHORITY_SAMPLE_KEYS = Object.freeze([
  "homeAbsent",
  "launchSwitches",
  "providerSecretNameCount",
  "testApiAbsent",
  "userDataDirConfigured",
  "writeAuthorizationFlagsZero",
]);
export const CHILD_LAUNCH_SWITCH_AUTHORITY_KEYS = Object.freeze([
  "hostResolverRulesDeadEnd",
  "proxyLoopbackDiscard",
  "remoteDebuggingAddressLoopback",
  "remoteDebuggingPortEphemeral",
]);

function hasExactKeys(record, acceptedKeys) {
  if (!isRecord(record)) return false;
  const names = Object.keys(record);
  return (
    names.length === acceptedKeys.length &&
    acceptedKeys.every((key) => names.includes(key))
  );
}

// Pure verdict over the launched child main-process authority record. Only
// safe booleans/count are produced; no environment values are recorded. The
// record shape is checked against the pinned exact key sets and every fact is
// a strict identity check, so unknown or missing keys and non-boolean or
// non-zero-count values fail closed without coercion.
export function evaluateTesterChildEnvironmentAuthority(sample) {
  const sampleKeysExact = hasExactKeys(
    sample,
    CHILD_ENVIRONMENT_AUTHORITY_SAMPLE_KEYS,
  );
  const launchSwitches = isRecord(sample) ? sample.launchSwitches : undefined;
  const launchSwitchesKeysExact = hasExactKeys(
    launchSwitches,
    CHILD_LAUNCH_SWITCH_AUTHORITY_KEYS,
  );
  const facts = {
    homeAbsent: sample?.homeAbsent === true,
    launchSwitchesExact: CHILD_LAUNCH_SWITCH_AUTHORITY_KEYS.every(
      (key) => launchSwitches?.[key] === true,
    ),
    launchSwitchesKeysExact,
    providerSecretNameCountExact: sample?.providerSecretNameCount === 0,
    sampleKeysExact,
    testApiAbsent: sample?.testApiAbsent === true,
    userDataDirConfigured: sample?.userDataDirConfigured === true,
    writeAuthorizationFlagsZero: sample?.writeAuthorizationFlagsZero === true,
  };
  return {
    facts,
    pass: Object.values(facts).every((fact) => fact === true),
  };
}

// Pure requested-versus-applied geometry truth. The applied size must match
// the requested 1280x720 exactly unless the actual display work area is
// smaller; the BrowserWindow minWidth/minHeight constraints (1024x720) are
// applied after the work-area clamp exactly like the desktop shell does, so
// a tiny work area yields the constrained minimum instead. In every case
// outerBoundsMatchRequest still records whether the exact request survived.
export function compareTesterStartupGeometry(requested, measured) {
  const workArea = measured?.workArea ?? null;
  // Mirrors clampStartupWindowSize in src/main/setup/window-shell.ts (floor
  // at 400px, clamp to the display work area) followed by the shell's
  // minWidth/minHeight enforcement.
  const expectedWidth = Math.max(
    PRODUCTION_TESTER_WINDOW_MIN_WIDTH_PX,
    Math.min(
      Math.max(requested.width, PRODUCTION_TESTER_MIN_WINDOW_DIMENSION_PX),
      workArea?.width ?? Number.POSITIVE_INFINITY,
    ),
  );
  const expectedHeight = Math.max(
    PRODUCTION_TESTER_WINDOW_MIN_HEIGHT_PX,
    Math.min(
      Math.max(requested.height, PRODUCTION_TESTER_MIN_WINDOW_DIMENSION_PX),
      workArea?.height ?? Number.POSITIVE_INFINITY,
    ),
  );
  const outerWidth = Number.isFinite(measured?.outerBounds?.width)
    ? measured.outerBounds.width
    : null;
  const outerHeight = Number.isFinite(measured?.outerBounds?.height)
    ? measured.outerBounds.height
    : null;
  const contentWidth = Number.isFinite(measured?.contentBounds?.width)
    ? measured.contentBounds.width
    : null;
  const contentHeight = Number.isFinite(measured?.contentBounds?.height)
    ? measured.contentBounds.height
    : null;
  const zoomFactor = Number.isFinite(measured?.zoomFactor)
    ? measured.zoomFactor
    : null;
  const displayMode =
    typeof measured?.displayMode === "string" ? measured.displayMode : null;
  const divergences = [];
  if (outerWidth !== expectedWidth)
    divergences.push(
      `applied outer width ${outerWidth} differs from expected ${expectedWidth}`,
    );
  if (outerHeight !== expectedHeight)
    divergences.push(
      `applied outer height ${outerHeight} differs from expected ${expectedHeight}`,
    );
  if (!(contentWidth > 0 && contentHeight > 0))
    divergences.push("content bounds were not measurable");
  const zoomFactorExact =
    zoomFactor !== null && Math.abs(zoomFactor - requested.zoomFactor) < 1e-6;
  if (!zoomFactorExact)
    divergences.push(
      `applied zoom factor ${zoomFactor} differs from requested ${requested.zoomFactor}`,
    );
  const displayModeNormal = displayMode === "normal";
  if (!displayModeNormal)
    divergences.push(`display mode ${displayMode ?? "unknown"} is not normal`);
  if (measured?.visible !== true)
    divergences.push("primary BrowserWindow was not visible");
  return {
    applied: {
      contentBounds: measured?.contentBounds ?? null,
      displayMode,
      outerBounds: measured?.outerBounds ?? null,
      visible: measured?.visible === true,
      workArea,
      zoomFactor,
    },
    divergences,
    displayModeNormal,
    expectedOuterBounds: { height: expectedHeight, width: expectedWidth },
    outerBoundsMatchRequest:
      outerWidth === requested.width && outerHeight === requested.height,
    pass: divergences.length === 0,
    requested: { ...requested },
    zoomFactorExact,
  };
}

export const SHELL_HEADER_LIVE_ASSISTANT_HREF = "#/live-assistant";

// The shell header only mounts on job-finder routes, so the tester session
// reaches it through the same real hash-router navigation the deterministic
// probe uses.
export const PRODUCTION_TESTER_SHELL_PROBE_ROUTE = "#/job-finder/campaigns";

// Sub-pixel slack for viewport/header containment so fractional CSS rounding
// at fractional zoom (1.25) cannot fail an on-frame control; overlap
// detection stays strict.
export const SHELL_HEADER_GEOMETRY_FRAME_TOLERANCE_PX = 0.5;
export const SHELL_HEADER_GEOMETRY_OVERLAP_EPSILON_PX = 0.5;

export const SHELL_HEADER_UTILITY_CONTROL_NAMES = Object.freeze([
  "needsYou",
  "search",
  "taskCenter",
]);

export const SHELL_HEADER_LAYOUT_TRIO_NAMES = Object.freeze([
  "liveAssistant",
  "planning",
  "routeScroller",
]);

export const SHELL_HEADER_GEOMETRY_SAMPLE_KEYS = Object.freeze([
  "brand",
  "documentOverflow",
  "focusableControls",
  "frame",
  "groups",
  "header",
  "liveAssistant",
  "layoutTrio",
  "moduleNav",
  "theme",
  "utilityControls",
]);

function geometryRectIsFinite(rect) {
  return (
    isRecord(rect) &&
    [rect.bottom, rect.left, rect.right, rect.top].every((value) =>
      Number.isFinite(value),
    )
  );
}

function geometryRectWithinFrame(rect, frame, tolerancePx) {
  return (
    geometryRectIsFinite(rect) &&
    Number.isFinite(frame?.width) &&
    frame.width > 0 &&
    Number.isFinite(frame?.height) &&
    frame.height > 0 &&
    rect.right - rect.left > 0 &&
    rect.bottom - rect.top > 0 &&
    rect.left >= -tolerancePx &&
    rect.top >= -tolerancePx &&
    rect.right <= frame.width + tolerancePx &&
    rect.bottom <= frame.height + tolerancePx
  );
}

function geometryRectContainsRect(outer, inner, tolerancePx) {
  return (
    geometryRectIsFinite(outer) &&
    geometryRectIsFinite(inner) &&
    inner.left >= outer.left - tolerancePx &&
    inner.right <= outer.right + tolerancePx &&
    inner.top >= outer.top - tolerancePx &&
    inner.bottom <= outer.bottom + tolerancePx
  );
}

function geometryRectsOverlap(first, second, epsilonPx) {
  if (!geometryRectIsFinite(first) || !geometryRectIsFinite(second))
    return false;
  const width =
    Math.min(first.right, second.right) - Math.max(first.left, second.left);
  const height =
    Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
  return width > epsilonPx && height > epsilonPx;
}

// Runs inside the accepted-app renderer page. Deliberately self-contained
// (Playwright serializes the function body): plain JSON out, no scripted test
// API access, no mutation of the document under measurement.
export function collectShellHeaderGeometrySample() {
  const round2 = (value) =>
    Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const rectOf = (element) => {
    const bounds = element.getBoundingClientRect();
    return {
      bottom: round2(bounds.bottom),
      left: round2(bounds.left),
      right: round2(bounds.right),
      top: round2(bounds.top),
    };
  };
  const overflowOf = (element) => ({
    x: Math.max(0, round2(element.scrollWidth - element.clientWidth)),
    y: Math.max(0, round2(element.scrollHeight - element.clientHeight)),
  });
  const isVisible = (element) => {
    if (element.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  // Positive computed-style flags for interactive controls: opacity:0 and
  // pointer-events:none both render a control unusable while passing naive
  // rect checks, so they are recorded explicitly and gated by the evaluator.
  const visibilityOf = (element) => {
    const style = window.getComputedStyle(element);
    return {
      opaque: style.opacity !== "0",
      pointerEnabled: style.pointerEvents !== "none",
    };
  };
  const hiddenVisibility = () => ({ opaque: false, pointerEnabled: false });
  const stateOf = (element) =>
    !element
      ? {
          present: false,
          rect: null,
          rendered: false,
          visibility: hiddenVisibility(),
        }
      : {
          present: true,
          rect: isVisible(element) ? rectOf(element) : null,
          rendered: isVisible(element),
          visibility: isVisible(element)
            ? visibilityOf(element)
            : hiddenVisibility(),
        };
  const centerHitOf = (element) => {
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const target = document.elementFromPoint(x, y);
    return {
      reached:
        target instanceof Element &&
        (target === element || element.contains(target)),
      x: round2(x),
      y: round2(y),
    };
  };
  const controlOfElement = (element) => {
    if (!element)
      return {
        ariaLabel: null,
        centerHit: null,
        elementTag: null,
        href: null,
        present: false,
        rect: null,
        rendered: false,
        visibility: hiddenVisibility(),
      };
    const rendered = isVisible(element);
    return {
      ariaLabel: element.getAttribute("aria-label"),
      centerHit: rendered ? centerHitOf(element) : null,
      elementTag: element.tagName.toLowerCase(),
      // Exact DOM attribute value, uncoerced; anchors only, null otherwise.
      href:
        element.tagName.toLowerCase() === "a"
          ? element.getAttribute("href")
          : null,
      present: true,
      rect: rendered ? rectOf(element) : null,
      rendered,
      visibility: rendered ? visibilityOf(element) : hiddenVisibility(),
    };
  };
  const controlOf = (selector) =>
    controlOfElement(document.querySelector(selector));
  const firstVisibleControlOf = (selector) => {
    const candidates = [...document.querySelectorAll(selector)];
    return controlOfElement(
      candidates.find((element) => isVisible(element)) ??
        candidates.at(0) ??
        null,
    );
  };

  const headerElement = document.querySelector(
    "[data-job-finder-shell-header]",
  );
  const compactScrollerElement = document.querySelector(
    "[data-job-finder-compact-navigation-scroll]",
  );
  const overflowState = (element) =>
    element ? overflowOf(element) : { x: null, y: null };
  const header = headerElement
    ? {
        overflow: overflowOf(headerElement),
        present: true,
        rect: rectOf(headerElement),
      }
    : { overflow: overflowState(null), present: false, rect: null };
  const brandElement = document.querySelector("[data-desktop-brand]");
  const brand = brandElement
    ? {
        overflow: overflowOf(brandElement),
        present: true,
        rect: isVisible(brandElement) ? rectOf(brandElement) : null,
        rendered: isVisible(brandElement),
      }
    : {
        overflow: overflowState(null),
        present: false,
        rect: null,
        rendered: false,
      };
  const routeScrollerBase = stateOf(compactScrollerElement);
  const routeScroller = compactScrollerElement
    ? {
        ...routeScrollerBase,
        scroll: {
          clientWidth: compactScrollerElement.clientWidth,
          scrollWidth: compactScrollerElement.scrollWidth,
          scrollableX:
            compactScrollerElement.scrollWidth >
            compactScrollerElement.clientWidth,
        },
      }
    : routeScrollerBase;
  // Rendered focusables only; chips clipped by the sanctioned compact-route
  // scroller are flagged separately instead of being treated as off-frame.
  const focusableControls = headerElement
    ? [
        ...headerElement.querySelectorAll(
          'a[href], button:not([disabled]), summary:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ]
        .filter((element) => {
          const closedDetails = element.closest("details:not([open])");
          const visibleSummary =
            closedDetails?.querySelector(":scope > summary");
          return (
            isVisible(element) &&
            (!closedDetails || visibleSummary?.contains(element))
          );
        })
        .map((element) => ({
          ariaLabel: element.getAttribute("aria-label"),
          insideCompactNavigationScroller: Boolean(
            compactScrollerElement?.contains(element),
          ),
          rect: rectOf(element),
          rendered: true,
          role: element.tagName.toLowerCase(),
        }))
    : [];
  // Honest appearance facts only: recorded as observed, never asserted equal
  // to a pinned value and never used to claim determinism.
  const themeHost = document.querySelector("[data-resolved-theme]");
  return {
    brand,
    // Fresh whole-document horizontal overflow measured on the same route the
    // header proof runs on, so gating uses current state instead of the stale
    // startup-route measurement taken before hash navigation.
    documentOverflow: {
      x: Math.max(
        0,
        round2(
          document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ),
    },
    focusableControls,
    frame: {
      height: document.documentElement.clientHeight,
      width: document.documentElement.clientWidth,
    },
    groups: {
      utility: controlOf(
        '[role="group"][aria-label="Notifications and actions"]',
      ),
      windowControls: controlOf('[role="group"][aria-label="Window controls"]'),
    },
    header,
    liveAssistant: firstVisibleControlOf(
      'a[aria-label="Open Live Assistant"],button[aria-label="Open Live Assistant"]',
    ),
    layoutTrio: {
      planning: controlOf('button[aria-label^="More"]'),
      routeScroller,
    },
    moduleNav: stateOf(
      document.querySelector("[data-desktop-module-navigation]"),
    ),
    theme: {
      appearancePreference:
        themeHost?.getAttribute("data-appearance-theme") ?? null,
      prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      resolvedTheme: themeHost?.getAttribute("data-resolved-theme") ?? null,
    },
    utilityControls: {
      needsYou: controlOf('button[aria-label^="Needs you"]'),
      search: controlOf(
        'button[aria-label="Search current plan and workspace"]',
      ),
      taskCenter: controlOf('summary[aria-label^="Task center"]'),
    },
  };
}

// Pure fail-closed verdict over a collected shell-header sample. Every gate
// must be proven true from the sample alone; unknown shapes, missing
// elements, non-rendered required controls, escaped rects, failed center hit
// tests, or unrecorded theme facts all produce violations and pass === false.
export function evaluateShellHeaderGeometry(sample) {
  const violations = [];
  const tolerancePx = SHELL_HEADER_GEOMETRY_FRAME_TOLERANCE_PX;
  const epsilonPx = SHELL_HEADER_GEOMETRY_OVERLAP_EPSILON_PX;
  if (!hasExactKeys(sample, SHELL_HEADER_GEOMETRY_SAMPLE_KEYS))
    violations.push(
      "shell header sample does not carry the exact pinned key set",
    );

  const frame = isRecord(sample?.frame) ? sample.frame : null;
  const frameValid =
    Number.isFinite(frame?.width) &&
    frame.width > 0 &&
    Number.isFinite(frame?.height) &&
    frame.height > 0;
  const safeFrame = frameValid ? { ...frame } : { height: 0, width: 0 };
  if (!frameValid)
    violations.push("viewport frame measurement is missing or non-finite");

  const readControl = (control) => {
    const rect = geometryRectIsFinite(control?.rect) ? control.rect : null;
    return {
      ariaLabel:
        typeof control?.ariaLabel === "string" ? control.ariaLabel : null,
      centerHitReached: control?.centerHit?.reached === true,
      elementTag:
        typeof control?.elementTag === "string" ? control.elementTag : null,
      href: typeof control?.href === "string" ? control.href : null,
      // Fail-closed defaults: a sample that omits computed-style visibility
      // can never prove an interactive control usable.
      opaque: control?.visibility?.opaque === true,
      pointerEnabled: control?.visibility?.pointerEnabled === true,
      rect,
      rendered: control?.rendered === true && rect !== null,
    };
  };

  // Interactive controls must be more than geometrically present: opacity:0
  // or pointer-events:none makes them unusable while passing rect checks.
  const pushInteractiveVisibilityViolations = (label, verdict) => {
    if (!verdict.rendered) return;
    if (!verdict.opaque)
      violations.push(`${label} computes opacity 0 while claimed rendered`);
    if (!verdict.pointerEnabled)
      violations.push(
        `${label} computes pointer-events none while claimed rendered`,
      );
  };

  const header = isRecord(sample?.header) ? sample.header : {};
  const headerRect = geometryRectIsFinite(header.rect) ? header.rect : null;
  const headerPresentAndWithinFrame =
    header.present === true &&
    headerRect !== null &&
    geometryRectWithinFrame(headerRect, safeFrame, tolerancePx);
  if (!headerPresentAndWithinFrame)
    violations.push("shell header is missing or escapes the viewport frame");
  const headerInternalOverflowZero =
    header.present === true && header.overflow?.x === 0;
  if (!headerInternalOverflowZero)
    violations.push(
      `shell header has internal horizontal overflow ${JSON.stringify(header.overflow ?? null)}`,
    );

  const brand = isRecord(sample?.brand) ? sample.brand : {};
  const brandRect = geometryRectIsFinite(brand.rect) ? brand.rect : null;
  const brandInternalOverflowZero =
    brand.present === true && brand.overflow?.x === 0;
  if (!brandInternalOverflowZero)
    violations.push(
      `brand block is missing or has internal horizontal overflow ${JSON.stringify(brand.overflow ?? null)}`,
    );
  // The brand is part of the claimed header proof, so it must be rendered and
  // contained, not merely free of internal overflow.
  const brandRenderedWithinHeaderAndViewport =
    brand.present === true &&
    brand.rendered === true &&
    brandRect !== null &&
    geometryRectWithinFrame(brandRect, safeFrame, tolerancePx) &&
    geometryRectContainsRect(headerRect, brandRect, tolerancePx);
  if (!brandRenderedWithinHeaderAndViewport)
    violations.push(
      "brand block is not rendered within both the shell header and the viewport frame",
    );

  const documentOverflow = isRecord(sample?.documentOverflow)
    ? sample.documentOverflow
    : {};
  const documentHorizontalOverflowZero = documentOverflow.x === 0;
  if (!documentHorizontalOverflowZero)
    violations.push(
      `document scrolls horizontally by ${JSON.stringify(documentOverflow.x ?? null)}px on the measured route`,
    );

  const moduleNav = isRecord(sample?.moduleNav) ? sample.moduleNav : {};
  const moduleNavRenderedContained =
    moduleNav.rendered === true &&
    geometryRectIsFinite(moduleNav.rect) &&
    geometryRectWithinFrame(moduleNav.rect, safeFrame, tolerancePx) &&
    geometryRectContainsRect(headerRect, moduleNav.rect, tolerancePx);
  const moduleNavigationHiddenOrContained =
    moduleNav.present === true &&
    (moduleNav.rendered !== true || moduleNavRenderedContained);
  if (moduleNav.present !== true)
    violations.push(
      "desktop module navigation element is absent from the shell DOM",
    );
  else if (!moduleNavigationHiddenOrContained)
    violations.push(
      "rendered desktop module navigation escapes the header or viewport frame",
    );

  const liveAssistant = readControl(sample?.liveAssistant);
  const liveAssistantRendered =
    liveAssistant.rendered &&
    liveAssistant.opaque &&
    liveAssistant.pointerEnabled;
  if (!liveAssistantRendered)
    violations.push(
      "compact Open Live Assistant link is not rendered or is opacity/pointer-events disabled",
    );
  pushInteractiveVisibilityViolations(
    "Open Live Assistant link",
    liveAssistant,
  );
  const liveAssistantHrefExact =
    liveAssistant.href === SHELL_HEADER_LIVE_ASSISTANT_HREF ||
    (liveAssistant.elementTag === "button" && liveAssistant.href === null);
  if (!liveAssistantHrefExact)
    violations.push(
      `Open Live Assistant href ${JSON.stringify(liveAssistant.href)} is not exactly ${JSON.stringify(SHELL_HEADER_LIVE_ASSISTANT_HREF)}`,
    );
  const liveAssistantContainedInHeaderAndViewport =
    liveAssistantRendered &&
    geometryRectWithinFrame(liveAssistant.rect, safeFrame, tolerancePx) &&
    geometryRectContainsRect(headerRect, liveAssistant.rect, tolerancePx);
  if (!liveAssistantContainedInHeaderAndViewport)
    violations.push(
      "Open Live Assistant link is not contained in both the shell header and the viewport frame",
    );
  const liveAssistantCenterHitReached = liveAssistant.centerHitReached;
  if (!liveAssistantCenterHitReached)
    violations.push(
      "Open Live Assistant link center point is not hit-test reachable",
    );

  const utilityControlsSource = isRecord(sample?.utilityControls)
    ? sample.utilityControls
    : {};
  const utilityControlVerdicts = new Map(
    SHELL_HEADER_UTILITY_CONTROL_NAMES.map((name) => [
      name,
      readControl(utilityControlsSource[name]),
    ]),
  );
  for (const [name, verdict] of utilityControlVerdicts.entries()) {
    if (!verdict.rendered)
      violations.push(
        `${name} utility control is not rendered in the shell header`,
      );
    else if (!geometryRectWithinFrame(verdict.rect, safeFrame, tolerancePx))
      violations.push(`${name} utility control escapes the viewport frame`);
    else if (!verdict.centerHitReached)
      violations.push(
        `${name} utility control center point is not hit-test reachable`,
      );
    pushInteractiveVisibilityViolations(`${name} utility control`, verdict);
  }
  const utilityControlsFullyContainedAndHitReachable = [
    ...utilityControlVerdicts.values(),
  ].every(
    (verdict) =>
      verdict.rendered &&
      verdict.opaque &&
      verdict.pointerEnabled &&
      geometryRectWithinFrame(verdict.rect, safeFrame, tolerancePx) &&
      verdict.centerHitReached,
  );

  const focusableList = Array.isArray(sample?.focusableControls)
    ? sample.focusableControls
    : null;
  let clippedInRouteScrollerCount = 0;
  let noOffFrameFocusableHeaderControls = false;
  if (!focusableList) {
    violations.push("focusable header control scan is missing from the sample");
  } else {
    const offFrame = [];
    for (const control of focusableList) {
      if (!isRecord(control) || control.rendered !== true) continue;
      if (!geometryRectIsFinite(control.rect)) {
        offFrame.push({ label: control.ariaLabel ?? null, rect: control.rect });
        continue;
      }
      if (control.insideCompactNavigationScroller === true) {
        if (!geometryRectWithinFrame(control.rect, safeFrame, tolerancePx))
          clippedInRouteScrollerCount += 1;
        continue;
      }
      if (!geometryRectWithinFrame(control.rect, safeFrame, tolerancePx))
        offFrame.push({ label: control.ariaLabel ?? null, rect: control.rect });
    }
    noOffFrameFocusableHeaderControls = offFrame.length === 0;
    if (!noOffFrameFocusableHeaderControls)
      violations.push(
        `${offFrame.length} focusable shell header control(s) render outside the viewport frame: ${JSON.stringify(offFrame.slice(0, 4))}`,
      );
  }

  const groups = isRecord(sample?.groups) ? sample.groups : {};
  const utilityGroup = readControl(groups.utility);
  const utilityGroupRenderedWithinViewportFrame =
    utilityGroup.rendered &&
    geometryRectWithinFrame(utilityGroup.rect, safeFrame, tolerancePx);
  if (!utilityGroupRenderedWithinViewportFrame)
    violations.push(
      "notifications-and-actions group is not rendered within the viewport frame",
    );
  const windowControls = readControl(groups.windowControls);
  const windowControlsGatePass =
    windowControls.rendered !== true ||
    geometryRectWithinFrame(windowControls.rect, safeFrame, tolerancePx);
  if (!windowControlsGatePass)
    violations.push("window controls group renders outside the viewport frame");

  const layoutTrioSource = isRecord(sample?.layoutTrio)
    ? sample.layoutTrio
    : {};
  const layoutTrioVerdicts = new Map(
    SHELL_HEADER_LAYOUT_TRIO_NAMES.map((name) => [
      name,
      name === "liveAssistant"
        ? liveAssistant
        : readControl(layoutTrioSource[name]),
    ]),
  );
  for (const [name, verdict] of layoutTrioVerdicts.entries()) {
    if (name === "liveAssistant") continue;
    if (!verdict.rendered)
      violations.push(`${name} compact navigation control is not rendered`);
    if (name !== "routeScroller")
      pushInteractiveVisibilityViolations(
        `${name} compact navigation control`,
        verdict,
      );
  }
  const layoutTrioWithinHeaderAndViewport = [
    ...layoutTrioVerdicts.values(),
  ].every((verdict, index) => {
    const name = SHELL_HEADER_LAYOUT_TRIO_NAMES[index];
    return (
      verdict.rendered &&
      (name === "routeScroller" ||
        (verdict.opaque && verdict.pointerEnabled)) &&
      geometryRectWithinFrame(verdict.rect, safeFrame, tolerancePx) &&
      geometryRectContainsRect(headerRect, verdict.rect, tolerancePx)
    );
  });
  if (!layoutTrioWithinHeaderAndViewport)
    violations.push(
      "route scroller, Planning control, or Live Assistant link escapes the header or viewport frame",
    );

  const trioRects = [...layoutTrioVerdicts.values()]
    .filter((verdict) => verdict.rendered)
    .map((verdict) => verdict.rect);
  const layoutTrioPairwiseNonOverlapping = trioRects.every((rect, index) =>
    trioRects
      .slice(index + 1)
      .every((other) => !geometryRectsOverlap(rect, other, epsilonPx)),
  );
  if (!layoutTrioPairwiseNonOverlapping)
    violations.push(
      "route scroller, Planning control, and Live Assistant link overlap each other",
    );
  const renderedGroupRects = [];
  if (utilityGroupRenderedWithinViewportFrame)
    renderedGroupRects.push({ name: "utility", rect: utilityGroup.rect });
  if (windowControls.rendered)
    renderedGroupRects.push({
      name: "windowControls",
      rect: windowControls.rect,
    });
  const layoutTrioClearOfRenderedGroups = renderedGroupRects.every((group) =>
    trioRects.every(
      (rect) => !geometryRectsOverlap(group.rect, rect, epsilonPx),
    ),
  );
  if (!layoutTrioClearOfRenderedGroups)
    violations.push(
      `compact navigation controls overlap a rendered control group: ${JSON.stringify(renderedGroupRects.map((group) => group.name))}`,
    );

  const theme = isRecord(sample?.theme) ? sample.theme : {};
  const themeFactsRecorded =
    typeof theme.appearancePreference === "string" &&
    typeof theme.resolvedTheme === "string" &&
    typeof theme.prefersDark === "boolean";
  if (!themeFactsRecorded)
    violations.push(
      "appearance theme facts were not recorded from the live document",
    );

  const facts = {
    brandInternalOverflowZero,
    brandRenderedWithinHeaderAndViewport,
    documentHorizontalOverflowZero,
    headerInternalOverflowZero,
    headerPresentAndWithinFrame,
    liveAssistantCenterHitReached,
    liveAssistantContainedInHeaderAndViewport,
    liveAssistantHrefExact,
    liveAssistantRendered,
    layoutTrioClearOfRenderedGroups,
    layoutTrioPairwiseNonOverlapping,
    layoutTrioWithinHeaderAndViewport,
    moduleNavigationHiddenOrContained,
    noOffFrameFocusableHeaderControls,
    themeFactsRecorded,
    utilityControlsFullyContainedAndHitReachable,
    utilityGroupRenderedWithinViewportFrame,
    windowControlsGatePass,
  };
  return {
    clippedInRouteScrollerCount,
    facts,
    kind: "shell-header-geometry",
    measurements: sample ?? null,
    pass:
      violations.length === 0 &&
      Object.values(facts).every((fact) => fact === true),
    schemaVersion: 1,
    viewport: safeFrame,
    violations,
  };
}

// Electron-free extracted fixtures for the shell-header geometry contract:
// a healthy sampler-shaped sample must pass, and each named regression
// (missing/wrong href, opacity/pointer-disabled or unrendered controls,
// escaping focusable, missing key) must fail. Returns a structured verdict
// instead of throwing so shared validators can bind the exact case results.
export function evaluateShellHeaderGeometryFixtureSuite() {
  const rect = (left, top, right, bottom) => ({
    bottom,
    left,
    right,
    top,
  });
  const usableControl = (left, top, right, bottom, extra = {}) => ({
    ariaLabel: null,
    centerHit: {
      reached: true,
      x: (left + right) / 2,
      y: (top + bottom) / 2,
    },
    href: null,
    present: true,
    rect: rect(left, top, right, bottom),
    rendered: true,
    visibility: { opaque: true, pointerEnabled: true },
    ...extra,
  });
  const healthySample = () => ({
    brand: {
      overflow: { x: 0, y: 0 },
      present: true,
      rect: rect(88, 8, 220, 48),
      rendered: true,
    },
    documentOverflow: { x: 0 },
    focusableControls: [],
    frame: { height: 360, width: 640 },
    groups: {
      utility: usableControl(470, 56, 636, 116, {
        ariaLabel: "Notifications and actions",
      }),
      windowControls: {
        present: false,
        rect: null,
        rendered: false,
        visibility: { opaque: false, pointerEnabled: false },
      },
    },
    header: {
      overflow: { x: 0, y: 0 },
      present: true,
      rect: rect(0, 0, 640, 116),
    },
    liveAssistant: usableControl(350, 64, 458, 100, {
      ariaLabel: "Open Live Assistant",
      href: SHELL_HEADER_LIVE_ASSISTANT_HREF,
    }),
    layoutTrio: {
      planning: usableControl(304, 64, 346, 100, {
        ariaLabel: "More",
      }),
      routeScroller: {
        present: true,
        rect: rect(8, 60, 296, 112),
        rendered: true,
        scroll: { clientWidth: 288, scrollWidth: 288, scrollableX: false },
        visibility: { opaque: true, pointerEnabled: true },
      },
    },
    moduleNav: {
      present: true,
      rect: null,
      rendered: false,
      visibility: { opaque: false, pointerEnabled: false },
    },
    theme: {
      appearancePreference: "system",
      prefersDark: false,
      resolvedTheme: "light",
    },
    utilityControls: {
      needsYou: usableControl(590, 62, 634, 110, {
        ariaLabel: "Needs you: 0 unresolved",
      }),
      search: usableControl(470, 62, 508, 110, {
        ariaLabel: "Search current plan and workspace",
      }),
      taskCenter: usableControl(512, 62, 550, 110, {
        ariaLabel: "Task center: 0 active",
      }),
    },
  });
  const offFrameFocusable = () => ({
    ariaLabel: "Runaway control",
    insideCompactNavigationScroller: false,
    rect: rect(600, 0, 700, 40),
    rendered: true,
  });

  const cases = [
    {
      expect: (verdict) =>
        verdict.pass === true &&
        Object.values(verdict.facts).every((fact) => fact === true) &&
        verdict.clippedInRouteScrollerCount === 0,
      name: "healthy-sampler-shaped-sample-passes",
      sample: healthySample(),
      shouldPass: true,
    },
    {
      name: "missing-live-assistant-href-fails",
      mutate: (sample) => {
        sample.liveAssistant.href = null;
      },
      shouldPass: false,
    },
    {
      name: "wrong-live-assistant-href-fails",
      mutate: (sample) => {
        sample.liveAssistant.href = "#/live-assistant/";
      },
      shouldPass: false,
    },
    {
      name: "opacity-zero-utility-control-fails",
      mutate: (sample) => {
        sample.utilityControls.search.visibility.opaque = false;
      },
      shouldPass: false,
    },
    {
      name: "pointer-events-none-live-assistant-fails",
      mutate: (sample) => {
        sample.liveAssistant.visibility.pointerEnabled = false;
      },
      shouldPass: false,
    },
    {
      name: "unrendered-brand-fails",
      mutate: (sample) => {
        sample.brand.rendered = false;
        sample.brand.rect = null;
      },
      shouldPass: false,
    },
    {
      name: "escaping-focusable-control-fails",
      mutate: (sample) => {
        sample.focusableControls.push(offFrameFocusable());
      },
      shouldPass: false,
    },
    {
      name: "missing-sample-key-fails",
      mutate: (sample) => {
        delete sample.theme;
      },
      shouldPass: false,
    },
    {
      name: "post-navigation-document-horizontal-overflow-fails",
      mutate: (sample) => {
        sample.documentOverflow.x = 12;
      },
      shouldPass: false,
    },
    {
      name: "brand-internal-horizontal-overflow-fails",
      mutate: (sample) => {
        sample.brand.overflow.x = 9;
      },
      shouldPass: false,
    },
    {
      name: "header-internal-horizontal-overflow-fails",
      mutate: (sample) => {
        sample.header.overflow.x = 3;
      },
      shouldPass: false,
    },
    {
      name: "rendered-module-nav-fully-contained-passes",
      mutate: (sample) => {
        sample.moduleNav = {
          present: true,
          rect: rect(240, 8, 400, 48),
          rendered: true,
          visibility: { opaque: true, pointerEnabled: true },
        };
        sample.liveAssistant.elementTag = "button";
        sample.liveAssistant.href = null;
      },
      shouldPass: true,
    },
    {
      name: "rendered-module-nav-escaping-frame-fails",
      mutate: (sample) => {
        sample.moduleNav = {
          present: true,
          rect: rect(0, -20, 640, 40),
          rendered: true,
          visibility: { opaque: true, pointerEnabled: true },
        };
      },
      shouldPass: false,
    },
    {
      name: "chip-clipped-by-sanctioned-route-scroller-is-recorded-not-fatal",
      expect: (verdict) => verdict.clippedInRouteScrollerCount === 1,
      mutate: (sample) => {
        sample.focusableControls.push({
          ariaLabel: "Applications",
          insideCompactNavigationScroller: true,
          rect: rect(500, 60, 700, 108),
          rendered: true,
        });
      },
      shouldPass: true,
    },
    {
      name: "layout-trio-overlap-fails",
      mutate: (sample) => {
        sample.layoutTrio.routeScroller.rect = rect(8, 60, 520, 112);
      },
      shouldPass: false,
    },
    {
      name: "layout-trio-overlapping-utility-group-fails",
      mutate: (sample) => {
        sample.layoutTrio.planning.rect = rect(480, 58, 522, 114);
      },
      shouldPass: false,
    },
    {
      name: "window-controls-rendered-off-frame-fail-their-gate",
      mutate: (sample) => {
        sample.groups.windowControls = {
          present: true,
          rect: rect(-30, 0, 90, 56),
          rendered: true,
          visibility: { opaque: true, pointerEnabled: true },
        };
      },
      shouldPass: false,
    },
    {
      name: "sub-pixel-frame-rounding-still-passes",
      mutate: (sample) => {
        sample.liveAssistant.rect = rect(350.4, 64, 458.6, 100);
      },
      shouldPass: true,
    },
  ];
  const failures = [];
  const results = [];
  for (const fixture of cases) {
    let outcome;
    try {
      const sample = "sample" in fixture ? fixture.sample : healthySample();
      fixture.mutate?.(sample);
      const verdict = evaluateShellHeaderGeometry(sample);
      const passMatches = verdict.pass === fixture.shouldPass;
      const expectMatches = fixture.expect ? fixture.expect(verdict) : true;
      outcome = { expectMatches, passMatches, violations: verdict.violations };
      if (!passMatches || !expectMatches)
        failures.push(
          `${fixture.name}: pass=${verdict.pass} expected=${fixture.shouldPass}${fixture.expect ? ` customExpect=${expectMatches}` : ""} violations=${JSON.stringify(verdict.violations.slice(0, 3))}`,
        );
    } catch (error) {
      outcome = {
        error: error instanceof Error ? error.message : String(error),
        expectMatches: false,
        passMatches: false,
        violations: [],
      };
      failures.push(`${fixture.name}: threw ${outcome.error}`);
    }
    results.push({
      name: fixture.name,
      outcome,
      shouldPass: fixture.shouldPass,
    });
  }
  return {
    cases: results,
    kind: "shell-header-geometry-fixture-suite",
    pass: failures.length === 0,
    schemaVersion: 1,
    ...(failures.length > 0 ? { failures } : {}),
  };
}

// Static drift guard: the tester session must reach the shell header through
// the single pinned PRODUCTION_TESTER_SHELL_PROBE_ROUTE constant (passed as
// the page.evaluate argument), never through a re-inlined route literal.
// The deterministic probe's own pre-existing literal is tolerated; any second
// inline campaigns assignment fails, so constant/session drift cannot hide.
export function auditTesterShellProbeRouteBinding(source) {
  const normalized = String(source ?? "").replace(/\s+/gu, " ");
  const boundCallPattern =
    /\(route\) => \{ location\.hash = route; \}, PRODUCTION_TESTER_SHELL_PROBE_ROUTE\)/u;
  const boundCallCount = (
    normalized.match(new RegExp(boundCallPattern.source, "gu")) ?? []
  ).length;
  const inlineCampaignLiteralCount = (
    normalized.match(/location\.hash = "#\/job-finder\/campaigns"/gu) ?? []
  ).length;
  const violations = [];
  if (boundCallCount !== 1)
    violations.push(
      `expected exactly one page.evaluate hash navigation bound to PRODUCTION_TESTER_SHELL_PROBE_ROUTE, found ${boundCallCount}`,
    );
  if (inlineCampaignLiteralCount > 1)
    violations.push(
      `found ${inlineCampaignLiteralCount} inline "#/job-finder/campaigns" hash assignments; only the pre-existing deterministic probe literal may remain`,
    );
  return {
    boundCallCount,
    facts: { inlineCampaignLiteralCount },
    kind: "tester-shell-probe-route-binding",
    pass: violations.length === 0,
    schemaVersion: 1,
    violations,
  };
}

async function resolveProductionTesterCdpEndpoint(userDataRoot) {
  const devToolsActivePortPath = path.join(userDataRoot, "DevToolsActivePort");
  const versionUrl = (port) => `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const contents = await readFile(devToolsActivePortPath, "utf8").catch(
      () => null,
    );
    const port = parseDevToolsActivePortContents(contents ?? "");
    if (port !== null) {
      const response = await fetch(versionUrl(port), {
        cache: "no-store",
        signal: AbortSignal.timeout(2_500),
      }).catch(() => null);
      // The webSocketDebuggerUrl value is deliberately never recorded: only
      // key presence is evidence, so no browser GUID path can leak.
      const body =
        response?.ok === true ? await response.json().catch(() => null) : null;
      const evaluation = evaluateCdpVersionBody(body);
      if (evaluation.ready) {
        return {
          bindAddress: "127.0.0.1",
          endpointUrl: versionUrl(port),
          loopbackPort: true,
          pass: true,
          port,
          resolution: "devtools-active-port-file",
          requiredKeys: evaluation.requiredKeys,
        };
      }
      // Reachable JSON without the required keys (or an unreadable body) is
      // not evidence of liveness: keep polling until the deadline.
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return {
    bindAddress: "127.0.0.1",
    endpointUrl: null,
    loopbackPort: false,
    pass: false,
    port: null,
    resolution: null,
    requiredKeys: null,
  };
}

// Pure acceptance gate for the runtime probe report: both the overall probe
// and its embedded production tester probe must have latched pass === true.
export function evaluateRuntimeProbePassRequirement(runtimeProbe) {
  return (
    !!runtimeProbe &&
    runtimeProbe.pass === true &&
    !!runtimeProbe.productionTesterProbe &&
    runtimeProbe.productionTesterProbe.pass === true
  );
}

// Pure negative-guard scan for ElectronApplication.evaluate callbacks that
// destructure a `process` property out of the Electron namespace. Sync/async
// arrow and function-expression callbacks all match; only destructured
// parameter names are returned, so ambient process property access inside a
// callback body never matches.
export function findEvaluateProcessDestructurings(source) {
  return [
    ...source.matchAll(
      /\.evaluate\(\s*(?:async\s+)?(?:function(?:\s+[A-Za-z_$][\w$]*)?\s*)?\(\s*\{([^}]+)\}/gu,
    ),
  ].map((match) => match[1]);
}

async function runAcceptedAppProductionTesterSession({
  acceptedAppRecord,
  acceptedAppRoot,
  electronIdentity,
  evidenceDir,
}) {
  const userDataRoot = path.join(
    evidenceDir,
    PRODUCTION_TESTER_USER_DATA_DIR_NAME,
  );
  assert(
    !existsSync(userDataRoot),
    "Production tester user-data root already exists; refusing a dirty isolated launch.",
  );
  const hardenedEnvironment = productionTesterEnvironment(
    process.env,
    userDataRoot,
  );
  const launchArgs = [...PRODUCTION_TESTER_LAUNCH_ARGS];

  let primaryFailure = null;
  let acceptedAppVerifiedBeforeLaunch = false;
  let executablePath = null;
  let shellHeaderEvidence = null;
  try {
    executablePath = await realpath(electronIdentity.executablePath);
    assert(
      (await sha256File(executablePath)) === electronIdentity.sha256 &&
        (await stat(executablePath)).size === electronIdentity.bytes,
      "Bound sealed Electron executable changed before the production tester probe.",
    );
    await verifyAcceptedElectronApp(acceptedAppRoot, acceptedAppRecord);
    acceptedAppVerifiedBeforeLaunch = true;
  } catch (error) {
    primaryFailure = `pre-launch integrity: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  let app = null;
  let observed = null;
  let rawChildEnvironmentAuthority = null;
  let screenshot = null;
  let processOutputState = null;
  let testerProcessReport = null;
  if (primaryFailure === null) {
    try {
      app = await electron.launch({
        executablePath,
        args: launchArgs,
        cwd: acceptedAppRoot,
        env: hardenedEnvironment.env,
      });
      // Main-process stdout/stderr are captured for this isolated launch too;
      // finalization after teardown fails on anything beyond the shared
      // inspector disconnect notice.
      testerProcessReport = {};
      processOutputState = attachProcessOutput(app, testerProcessReport);
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(
        () => Boolean(globalThis.nestor?.jobFinder?.getWorkspace),
        null,
        { timeout: 30_000 },
      );
      const renderer = await page.evaluate(() => ({
        devicePixelRatio: window.devicePixelRatio,
        horizontalOverflowPx: Math.max(
          0,
          document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
        href: location.href,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        preloadReady: Boolean(globalThis.nestor?.jobFinder?.getWorkspace),
        shellMounted: Boolean(
          document.querySelector("#root")?.childElementCount > 0,
        ),
        testApiPresent: Boolean(globalThis.nestor?.jobFinder?.test),
      }));
      const applied = await app.evaluate(({ app, BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) return null;
        const environmentNames = Object.keys(process.env);
        return {
          childEnvironmentAuthority: {
            // Safe booleans/count only: no environment values are sampled
            // into the record.
            homeAbsent: !("HOME" in process.env),
            // Exact Electron command-line launch-switch proof: presence plus
            // exact value equality for every zero-network/CDP rule.
            // Playwright may inject its own duplicate
            // --remote-debugging-port=0, so uniqueness is not required.
            launchSwitches: {
              hostResolverRulesDeadEnd:
                app.commandLine.hasSwitch("host-resolver-rules") &&
                app.commandLine.getSwitchValue("host-resolver-rules") ===
                  "MAP * 0.0.0.0,EXCLUDE localhost",
              proxyLoopbackDiscard:
                app.commandLine.hasSwitch("proxy-server") &&
                app.commandLine.getSwitchValue("proxy-server") ===
                  "127.0.0.1:9",
              remoteDebuggingAddressLoopback:
                app.commandLine.hasSwitch("remote-debugging-address") &&
                app.commandLine.getSwitchValue("remote-debugging-address") ===
                  "127.0.0.1",
              remoteDebuggingPortEphemeral:
                app.commandLine.hasSwitch("remote-debugging-port") &&
                app.commandLine.getSwitchValue("remote-debugging-port") === "0",
            },
            providerSecretNameCount: environmentNames.filter((name) =>
              /API_KEY|API_TOKEN|SECRET|TOKEN|PROXY/i.test(name),
            ).length,
            testApiAbsent: !("NESTOR_ENABLE_TEST_API" in process.env),
            userDataDirConfigured:
              typeof process.env.NESTOR_USER_DATA_DIR === "string" &&
              process.env.NESTOR_USER_DATA_DIR.length > 0,
            writeAuthorizationFlagsZero: [
              "JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES",
              "JOB_FINDER_COMPLETE_FLOW_AUTHORIZED_WRITE_DIAGNOSTIC",
              "NESTOR_TEST_API_USE_LIVE_AI",
              "NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES",
            ].every((name) => process.env[name] === "0"),
          },
          contentBounds: win.getContentBounds(),
          displayMode: win.isFullScreen()
            ? "fullscreen"
            : win.isMaximized()
              ? "maximized"
              : "normal",
          outerBounds: win.getBounds(),
          visible: win.isVisible(),
          workArea: screen.getPrimaryDisplay().workArea,
          zoomFactor: win.webContents.getZoomFactor(),
        };
      });
      assert(
        applied,
        "No live BrowserWindow answered the tester geometry probe.",
      );
      // The raw child authority sample is captured after the applied-window
      // assert and before the authority verdict so a failed gate still emits
      // per-field evidence instead of a bare aggregate.
      rawChildEnvironmentAuthority = applied.childEnvironmentAuthority;
      const childEnvironmentEvaluation =
        evaluateTesterChildEnvironmentAuthority(
          applied.childEnvironmentAuthority,
        );
      const childEnvironmentFailingFacts = Object.entries(
        childEnvironmentEvaluation.facts,
      )
        .filter(([, value]) => value !== true && value !== 0)
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
      assert(
        childEnvironmentEvaluation.pass,
        `Production tester child main-process environment authority failed (${childEnvironmentFailingFacts.join(", ") || "no failing fact"}): ${JSON.stringify(childEnvironmentEvaluation.facts)}; raw sample: ${JSON.stringify(rawChildEnvironmentAuthority)}`,
      );
      const geometry = compareTesterStartupGeometry(
        PRODUCTION_TESTER_GEOMETRY_REQUEST,
        applied,
      );
      const cdp = await resolveProductionTesterCdpEndpoint(userDataRoot);
      // Exercise navigation/reload and re-prove the scripted preload stays
      // absent in a production-like session.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => Boolean(globalThis.nestor?.jobFinder?.getWorkspace),
        null,
        { timeout: 30_000 },
      );
      const postReload = await page.evaluate(() => ({
        preloadReady: Boolean(globalThis.nestor?.jobFinder?.getWorkspace),
        testApiPresent: Boolean(globalThis.nestor?.jobFinder?.test),
      }));
      // Re-measure native zoom after the reload: Chromium re-applies
      // per-origin zoom at navigation commit, so post-reload zoom must still
      // equal the requested factor exactly.
      const reloadZoomFactor = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win && !win.isDestroyed()
          ? win.webContents.getZoomFactor()
          : null;
      });
      const reloadZoomFactorExact =
        typeof reloadZoomFactor === "number" &&
        Math.abs(
          reloadZoomFactor - PRODUCTION_TESTER_GEOMETRY_REQUEST.zoomFactor,
        ) < 1e-6;
      assert(
        reloadZoomFactorExact,
        `Production tester reload zoom ${reloadZoomFactor} differs from requested ${PRODUCTION_TESTER_GEOMETRY_REQUEST.zoomFactor}.`,
      );
      geometry.reloadZoomFactorExact = reloadZoomFactorExact;
      postReload.zoomFactor = reloadZoomFactor;
      // Structured shell-header proof at the tester surface (1280x720 native
      // zoom 1.25 => 1024x576 CSS): reach the production shell through the
      // real hash router, measure the live DOM, then hard-fail the probe on
      // any violation. The scripted test API stays absent throughout.
      await page.evaluate((route) => {
        location.hash = route;
      }, PRODUCTION_TESTER_SHELL_PROBE_ROUTE);
      await page
        .getByRole("heading", { level: 1, name: "Search plans", exact: true })
        .waitFor({ state: "visible", timeout: 30_000 });
      const shellHeaderVerdict = evaluateShellHeaderGeometry(
        await page.evaluate(collectShellHeaderGeometrySample),
      );
      // Persist the full sample+verdict (facts, measurements, violations)
      // before the hard assert so a geometry failure still ships rich
      // evidence in the probe report instead of the fallback reason alone.
      shellHeaderEvidence = shellHeaderVerdict;
      assert(
        shellHeaderVerdict.pass === true,
        `Production tester shell header geometry failed at ${JSON.stringify(shellHeaderVerdict.viewport)}: ${
          shellHeaderVerdict.violations.join("; ") || "no violations recorded"
        }`,
      );
      const screenshotPath = path.join(
        evidenceDir,
        PRODUCTION_TESTER_SCREENSHOT_FILE_NAME,
      );
      await page.screenshot({ path: screenshotPath });

      assert(
        renderer.href.startsWith("file:"),
        `Production tester renderer loaded a non-file URL: ${renderer.href}`,
      );
      assert(
        renderer.preloadReady === true && postReload.preloadReady === true,
        "Production tester preload public API never became ready.",
      );
      assert(
        renderer.testApiPresent === false &&
          postReload.testApiPresent === false,
        "Production tester session exposed the scripted test API.",
      );
      assert(
        geometry.pass,
        `Production tester geometry diverged: ${JSON.stringify(geometry.divergences)}`,
      );
      assert(
        cdp.pass,
        "Production tester CDP endpoint was not proven live through DevToolsActivePort.",
      );
      assert(
        renderer.horizontalOverflowPx === 0,
        `Production tester renderer has horizontal document overflow: ${renderer.horizontalOverflowPx}px`,
      );
      assert(
        renderer.shellMounted,
        "Production tester renderer did not mount the primary shell root.",
      );

      screenshot = {
        bytes: (await stat(screenshotPath)).size,
        path: PRODUCTION_TESTER_SCREENSHOT_FILE_NAME,
        sha256: await sha256File(screenshotPath),
      };
      const pngMetadata = parsePngMetadata(await readFile(screenshotPath));
      assert(
        pngMetadata.magicValid === true &&
          pngMetadata.width > 0 &&
          pngMetadata.height > 0,
        `Production tester screenshot is not a decodable PNG: ${JSON.stringify(pngMetadata)}`,
      );
      screenshot.metadata = {
        format: "png",
        height: pngMetadata.height,
        width: pngMetadata.width,
      };
      observed = {
        cdp,
        geometry,
        postReload,
        renderer,
      };
    } catch (error) {
      primaryFailure = error instanceof Error ? error.message : String(error);
    }
  }

  // Ownership teardown always runs once the app exists; cleanup and integrity
  // failures are preserved alongside the primary failure instead of masking it.
  let shutdown = null;
  const secondaryFailures = [];
  if (app) {
    try {
      shutdown = await stopAndVerifyOwnedElectron(
        app,
        createOwnedProcessLedger(),
        "production-tester",
      );
    } catch (error) {
      secondaryFailures.push(
        `owned-process teardown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (processOutputState && testerProcessReport) {
      try {
        finalizeProcessOutput(processOutputState, testerProcessReport, {
          acceptedStderrPatterns: [
            PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
          ],
        });
      } catch (error) {
        secondaryFailures.push(
          `main-process output: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  let electronUnchanged = false;
  let acceptedAppVerifiedAfterShutdown = false;
  if (executablePath) {
    try {
      electronUnchanged =
        (await sha256File(executablePath)) === electronIdentity.sha256 &&
        (await stat(executablePath)).size === electronIdentity.bytes;
      if (!electronUnchanged)
        throw new Error(
          "Sealed Electron executable changed during the production tester probe.",
        );
      await verifyAcceptedElectronApp(acceptedAppRoot, acceptedAppRecord);
      acceptedAppVerifiedAfterShutdown = true;
    } catch (error) {
      secondaryFailures.push(
        `post-probe integrity: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let userDataCleanedUp = false;
  try {
    const cleanupError = await cleanupDirectory(userDataRoot);
    if (cleanupError) throw new Error(String(cleanupError));
    userDataCleanedUp = !existsSync(userDataRoot);
    if (!userDataCleanedUp)
      throw new Error("Isolated user-data root survived cleanup.");
  } catch (error) {
    secondaryFailures.push(
      `isolated user-data cleanup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const failureParts = [
    ...(primaryFailure === null ? [] : [`primary: ${primaryFailure}`]),
    ...secondaryFailures,
  ];
  return {
    schemaVersion: 1,
    kind: "accepted-app-production-tester-probe",
    pass: failureParts.length === 0,
    ...(failureParts.length === 0 ? {} : { failure: failureParts.join("; ") }),
    environmentAuthority: {
      allowlistedCopiedNames: hardenedEnvironment.copiedNames,
      childMainProcess: {
        evaluation: evaluateTesterChildEnvironmentAuthority(
          rawChildEnvironmentAuthority,
        ),
        raw: rawChildEnvironmentAuthority ?? null,
      },
      forbiddenNamesVerifiedAbsent: ["HOME", "NESTOR_ENABLE_TEST_API"],
      injectedNames: hardenedEnvironment.injectedNames,
      strategy: "ambient-allowlist-plus-canonical-injection",
      strippedAmbientNames: hardenedEnvironment.strippedNames,
      testApiEnabledInProcess: false,
      userDataRootRelative: PRODUCTION_TESTER_USER_DATA_DIR_NAME,
    },
    launch: {
      args: launchArgs,
      cwd: "accepted-app",
    },
    geometry: observed
      ? observed.geometry
      : { pass: false, reason: primaryFailure ?? "not measured" },
    renderer: observed
      ? { postReload: observed.postReload, startup: observed.renderer }
      : null,
    cdp: observed ? observed.cdp : { pass: false },
    shellHeaderGeometry: shellHeaderEvidence ?? {
      kind: "shell-header-geometry",
      pass: false,
      reason: primaryFailure ?? "not measured",
      schemaVersion: 1,
    },
    screenshot,
    mainProcess: testerProcessReport?.mainProcess ?? null,
    cleanup: {
      leftoverPids: shutdown ? shutdown.leftoverPids : null,
      trackedProcessCount: shutdown ? shutdown.trackedProcessCount : null,
      userDataCleanedUp,
      verified: shutdown ? shutdown.verified === true : false,
    },
    integrity: {
      acceptedAppVerifiedBeforeLaunch,
      acceptedAppVerifiedAfterShutdown,
      electronUnchanged,
    },
  };
}

// Pre-launch module containment contract: every production runtime external
// the bundled main process requires (electron.vite.config.ts externals), the
// Electron runtime package whose binary launches the accepted app, and the
// exact pdfjs legacy worker subpath the bundled main resolves at runtime
// (src/main/adapters/resume-document/shared.ts). The modern build worker may
// also ship inside the package closure, but the legacy subpath is mandatory.
// Resolved through a require anchored at the accepted app root only, so a
// resolution falling back to the workspace or snapshot tree fails containment.
export const ACCEPTANCE_RUNTIME_MODULE_PROBE_SPECIFIERS = Object.freeze([
  "@mozilla/readability",
  "chromium-bidi",
  "electron",
  "jsdom",
  "pdfjs-dist/legacy/build/pdf.worker.mjs",
  "playwright",
  "playwright-core",
]);

// Resolve and load every probe specifier strictly from the exported accepted
// app and fail unless each resolves inside it. Runs before any Electron
// launch so a non-self-contained dependency export fails with the exact
// missing specifier instead of an opaque renderer/main crash.
export async function probeAcceptedAppRuntimeModules({
  acceptedAppRoot,
  specifiers = ACCEPTANCE_RUNTIME_MODULE_PROBE_SPECIFIERS,
}) {
  const requireFromAcceptedApp = createRequire(
    path.join(acceptedAppRoot, "package.json"),
  );
  const canonicalRoot = await realpath(acceptedAppRoot);
  const probes = [];
  const failures = [];
  for (const specifier of specifiers) {
    try {
      const resolvedPath = await realpath(
        requireFromAcceptedApp.resolve(specifier),
      );
      if (!isInside(canonicalRoot, resolvedPath))
        throw new Error(`resolved outside the accepted app: ${resolvedPath}`);
      await import(pathToFileURL(resolvedPath).href);
      probes.push({
        pass: true,
        resolvedInsideAcceptedApp: true,
        specifier,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${specifier}: ${message}`);
      probes.push({ error: message, pass: false, specifier });
    }
  }
  return {
    kind: "module-containment",
    pass: failures.length === 0,
    ...(failures.length > 0 ? { failure: failures.join("; ") } : {}),
    probes,
  };
}

async function runAcceptedAppRuntimeProbe({
  acceptedAppRecord,
  acceptedAppRoot,
  electronIdentity,
  outputPath,
}) {
  const before = {
    ...electronIdentity,
    executablePath: await realpath(electronIdentity.executablePath),
    sha256: await sha256File(electronIdentity.executablePath),
  };
  assert(
    before.sha256 === electronIdentity.sha256,
    "Bound Electron executable changed before accepted-app runtime probe.",
  );
  const acceptedRequire = createRequire(
    path.join(acceptedAppRoot, "package.json"),
  );
  // The exact runtime worker subpath is mandatory: the bundled main resolves
  // pdfjs-dist/legacy/build/pdf.worker.mjs (shared.ts), so probing whichever
  // worker variant happens to resolve would accept an export the runtime
  // cannot actually load.
  const workerSpecifier = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  let workerPath;
  try {
    workerPath = await realpath(acceptedRequire.resolve(workerSpecifier));
  } catch (error) {
    throw new Error(
      `Accepted app cannot resolve the runtime PDF.js worker subpath ${workerSpecifier}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    isInside(acceptedAppRoot, workerPath),
    "PDF.js worker escaped accepted app.",
  );
  const workerModule = await import(pathToFileURL(workerPath).href);
  assert(
    Object.keys(workerModule).length > 0,
    "Concrete PDF.js worker module imported without exports.",
  );
  const sidecarManifestPath = path.join(
    acceptedAppRoot,
    "dist/resume-parser-sidecar/manifest.json",
  );
  assert(
    existsSync(sidecarManifestPath),
    "Accepted app sidecar manifest is missing.",
  );
  // Pre-launch containment: the exported dependency closure must resolve and
  // load every production runtime external from the accepted app alone. This
  // fails before electron.launch ever runs, so a missing transitive package
  // surfaces as a named specifier instead of a runtime crash.
  const moduleContainment = await probeAcceptedAppRuntimeModules({
    acceptedAppRoot,
  });
  assert(
    moduleContainment.pass,
    `Accepted-app runtime module containment failed before launch: ${moduleContainment.failure}`,
  );
  const runtimeProbeUserDataDir = path.join(
    path.dirname(outputPath),
    "runtime-probe-user-data",
  );
  const app = await electron.launch({
    executablePath: electronIdentity.executablePath,
    args: [".", ...ACCEPTANCE_ZERO_NETWORK_LAUNCH_ARGS],
    cwd: acceptedAppRoot,
    env: acceptanceEnvironment({
      NESTOR_USER_DATA_DIR: runtimeProbeUserDataDir,
    }),
  });
  // Main-process stdout/stderr capture for the deterministic launch;
  // finalized below with the same exact allowlist as the tester launch.
  const processReport = {};
  const processOutputState = attachProcessOutput(app, processReport);
  let runtime;
  let probe = null;
  let primaryError = null;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(globalThis.nestor?.jobFinder),
      null,
      {
        timeout: 30_000,
      },
    );
    const startup = await page.evaluate(() => ({
      href: location.href,
      preloadReady: Boolean(globalThis.nestor?.jobFinder),
      rendererReady: document.documentElement.childElementCount > 0,
      scriptCount: document.scripts.length,
    }));
    await page
      .locator("[data-job-finder-shell]")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(() => {
      location.hash = "#/job-finder/campaigns";
    });
    try {
      await page
        .getByRole("heading", { level: 1, name: "Search plans", exact: true })
        .waitFor({
          state: "visible",
          timeout: 30_000,
        });
    } catch (error) {
      const routeDebug = await page.evaluate(() => ({
        bodyText: document.body.innerText.slice(0, 4_000),
        hash: location.hash,
        headings: [...document.querySelectorAll("h1,h2")]
          .map((heading) => heading.textContent?.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 20),
        shellPresent: Boolean(
          document.querySelector("[data-job-finder-shell]"),
        ),
      }));
      throw new Error(
        `Accepted-app lazy-route heading did not become visible: ${JSON.stringify(routeDebug)}`,
        { cause: error },
      );
    }
    const lazyRouteScriptCount = await page.evaluate(
      () => document.scripts.length,
    );
    runtime = await app.evaluate(({ app }) => ({
      execPath: app.getPath("exe"),
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
    }));
    // Freeze v11 regression guard: destructuring process from the Electron
    // namespace is unsupported, so identity is read via app.getPath plus the
    // ambient process global above and then proven against the bound sealed
    // executable and electron package version. The reported path is
    // realpathed first so alias roots cannot mask a mismatch.
    const runtimeExecutablePath = await realpath(runtime.execPath);
    assert(
      runtimeExecutablePath === before.executablePath,
      `Accepted-app runtime reported executable ${runtimeExecutablePath} instead of the bound ${before.executablePath}.`,
    );
    assert(
      typeof runtime.electronVersion === "string" &&
        runtime.electronVersion.length > 0,
      `Accepted-app runtime probe did not report a non-empty Electron version: ${JSON.stringify(runtime.electronVersion)}`,
    );
    assert(
      typeof electronIdentity.electronPackageVersion === "string" &&
        electronIdentity.electronPackageVersion.length > 0,
      `Bound accepted-app identity did not record a non-empty Electron package version: ${JSON.stringify(electronIdentity.electronPackageVersion)}`,
    );
    assert(
      runtime.electronVersion === electronIdentity.electronPackageVersion,
      `Accepted-app runtime Electron ${runtime.electronVersion} differs from the bound package version ${electronIdentity.electronPackageVersion}.`,
    );
    const measured = {
      schemaVersion: 1,
      pass:
        startup.href.startsWith("file:") &&
        startup.preloadReady &&
        startup.rendererReady &&
        moduleContainment.pass === true,
      moduleContainment,
      startup,
      lazyMainRoute: {
        route: "#/job-finder/campaigns",
        observedText: "Search plans",
        scriptCountBefore: startup.scriptCount,
        scriptCountAfter: lazyRouteScriptCount,
        pass: true,
      },
      pdfWorker: {
        specifier: workerSpecifier,
        path: path
          .relative(acceptedAppRoot, workerPath)
          .split(path.sep)
          .join("/"),
        bytes: (await stat(workerPath)).size,
        sha256: await sha256File(workerPath),
        moduleExports: Object.keys(workerModule).sort(),
        pass: true,
      },
      sidecar: {
        manifestPath: "dist/resume-parser-sidecar/manifest.json",
        sha256: await sha256File(sidecarManifestPath),
        pass: true,
      },
      networkDisabled: true,
      submissionActionsExecuted: false,
      electron: { ...before, ...runtime },
    };
    probe = measured;
    assert(
      probe.pass,
      "Accepted-app runtime probe did not initialize renderer/preload.",
    );
    // Second isolated production-like tester launch of the same sealed app.
    // It extends the deterministic probe with tester-session authority proof
    // without weakening any assertion above; overall pass now requires it.
    probe.productionTesterProbe = await runAcceptedAppProductionTesterSession({
      acceptedAppRecord,
      acceptedAppRoot,
      electronIdentity,
      evidenceDir: path.dirname(outputPath),
    });
    probe.pass =
      probe.pass === true && probe.productionTesterProbe.pass === true;
  } catch (error) {
    primaryError = error;
    if (!probe) probe = { schemaVersion: 1, pass: false };
  }

  // Owned teardown of the deterministic launch: SIGTERM/SIGKILL with a
  // zero-leftovers process-table proof, then main-process output
  // finalization, user-data removal, and integrity reverification. No step
  // may mask the primary failure: resolvePrimaryRunError below keeps the
  // primary error thrown and attaches the teardown aggregate as its cause.
  let shutdown = null;
  const teardownErrors = [];
  try {
    shutdown = await stopAndVerifyOwnedElectron(
      app,
      createOwnedProcessLedger(),
      "accepted-app-runtime-probe",
    );
  } catch (error) {
    teardownErrors.push(error);
  }
  try {
    finalizeProcessOutput(processOutputState, processReport, {
      acceptedStderrPatterns: [PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN],
    });
  } catch (error) {
    teardownErrors.push(error);
  }
  let userDataRemoved = false;
  try {
    const cleanupError = await cleanupDirectory(runtimeProbeUserDataDir);
    if (cleanupError) throw new Error(String(cleanupError));
    userDataRemoved = !existsSync(runtimeProbeUserDataDir);
    assert(
      userDataRemoved,
      "Runtime-probe user-data directory survived cleanup.",
    );
  } catch (error) {
    teardownErrors.push(error);
  }
  try {
    const afterHash = await sha256File(electronIdentity.executablePath);
    assert(
      afterHash === electronIdentity.sha256 &&
        (await stat(electronIdentity.executablePath)).size ===
          electronIdentity.bytes,
      "Bound Electron changed during runtime probe.",
    );
    await verifyAcceptedElectronApp(acceptedAppRoot, acceptedAppRecord);
  } catch (error) {
    teardownErrors.push(error);
  }

  const messageOf = (error) =>
    error instanceof Error ? error.message : String(error);
  probe.processOwnership = {
    leftoverPids: shutdown ? shutdown.leftoverPids : null,
    trackedProcessCount: shutdown ? shutdown.trackedProcessCount : null,
    userDataRemoved,
    verified: shutdown ? shutdown.verified === true : false,
  };
  probe.mainProcess = processReport.mainProcess ?? null;
  if (primaryError) {
    probe.pass = false;
    probe.failure ??= messageOf(primaryError);
  } else if (teardownErrors.length > 0) {
    probe.pass = false;
    probe.failure ??= `teardown: ${teardownErrors.map(messageOf).join(" | ")}`;
  }
  try {
    await writeJson(outputPath, probe);
  } catch (writeError) {
    // Never mask the primary or teardown failure with a report write issue,
    // but never let a failed evidence write slip through either.
    probe.reportWriteError =
      writeError instanceof Error ? writeError.message : String(writeError);
    teardownErrors.push(writeError);
  }
  const teardownAggregate =
    teardownErrors.length > 0
      ? new Error(
          `Accepted-app runtime probe teardown failed: ${teardownErrors.map(messageOf).join(" | ")}`,
        )
      : null;
  // A recorded-but-unthrown production tester failure must still fail the
  // run: the probe JSON above is already written, so the diagnostic survives.
  // When the deterministic probe itself threw first, it stays the primary
  // error and the tester detail remains bound in the written JSON.
  const testerFailure =
    primaryError === null &&
    (!probe ||
      !probe.productionTesterProbe ||
      probe.productionTesterProbe.pass !== true)
      ? new Error(
          `Production-like tester probe failed: ${
            probe?.productionTesterProbe?.failure ??
            "no production tester record"
          }`,
        )
      : null;
  const finalError = resolvePrimaryRunError(
    primaryError ?? testerFailure,
    teardownAggregate,
  );
  if (finalError) throw finalError;
  return probe;
}

async function verifyFinalEvidence(runDir, captureReportsById) {
  for (const [component, expectedReport] of Object.entries(
    captureReportsById,
  )) {
    const currentReport = await readJson(expectedReport.__reportPath);
    assert(
      stableJson(currentReport) === stableJson(expectedReport),
      `${component} report changed after initial verification.`,
    );
    await verifyScreenshots(path.join(runDir, component), currentReport);
  }
}

function rebasePathIntoSnapshot(candidate, snapshotRoot) {
  if (!candidate || !path.isAbsolute(candidate)) return candidate;
  if (!isInside(repositoryRoot, candidate)) return candidate;
  return path.join(snapshotRoot, path.relative(repositoryRoot, candidate));
}

function snapshotBuildInvocation(snapshotRoot) {
  const environment = { ...process.env };
  if (initialBuildInvocation.source === "npm_execpath")
    environment.npm_execpath = rebasePathIntoSnapshot(
      initialBuildInvocation.executable,
      snapshotRoot,
    );
  return resolveBuildInvocation({ repositoryRoot: snapshotRoot, environment });
}

function resolvePathExecutable(command, environment = process.env) {
  if (path.isAbsolute(command)) return command;
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  for (const directory of String(environment.PATH ?? "").split(
    path.delimiter,
  )) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${command}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function executableIdentity(buildInvocation) {
  const candidates = [
    process.execPath,
    resolvePathExecutable(buildInvocation.command),
    buildInvocation.args.find((argument) =>
      /pnpm\.(?:c|m)?js$/i.test(argument),
    ),
  ].filter(Boolean);
  const identities = [];
  for (const candidate of [
    ...new Set(candidates.map((value) => path.resolve(value))),
  ]) {
    const fileStat = await stat(candidate);
    identities.push({
      path: candidate,
      bytes: fileStat.size,
      mode: fileStat.mode & 0o777,
      sha256: await sha256File(candidate),
    });
  }
  return identities;
}

// Records the live-worktree continuity facts onto the acceptance report:
// currentWorktree (algorithm/digest/fileCount), currentWorktreeDiverged
// against the capture baseline, and currentWorktreeDivergenceError when the
// live worktree cannot be fingerprinted at all. Never throws; callers decide
// whether an unmeasurable worktree is fatal.
async function recordCurrentWorktreeContinuity(acceptanceReport) {
  try {
    const currentWorktree = await sourceFingerprint();
    acceptanceReport.source.currentWorktree = {
      algorithm: currentWorktree.algorithm,
      digest: currentWorktree.digest,
      fileCount: currentWorktree.fileCount,
    };
    acceptanceReport.source.currentWorktreeDiverged =
      currentWorktree.digest !==
      acceptanceReport.source.capturedWorktree?.digest;
  } catch (error) {
    acceptanceReport.source.currentWorktree = null;
    acceptanceReport.source.currentWorktreeDiverged = true;
    acceptanceReport.source.currentWorktreeDivergenceError =
      error instanceof Error ? error.message : String(error);
  }
}

// Pure live-worktree continuity verdict for production acceptance: every
// evidence artifact is bound to the worktree exactly as captured into the
// immutable snapshot at run start, so the only passing outcome is a live
// worktree still byte-identical to that baseline digest. A dirty-but-
// unchanged baseline passes — uncommitted files simply define the baseline —
// while mid-run drift, a missing baseline, or an unmeasurable live worktree
// all fail closed.
export function evaluateCurrentWorktreeContinuity(
  capturedWorktree,
  currentWorktree,
) {
  const digestOf = (fingerprint) =>
    isRecord(fingerprint) &&
    typeof fingerprint.digest === "string" &&
    fingerprint.digest.length > 0
      ? fingerprint.digest
      : null;
  const capturedDigest = digestOf(capturedWorktree);
  const currentDigest = digestOf(currentWorktree);
  if (!capturedDigest || !currentDigest)
    return {
      capturedDigest,
      currentDigest,
      diverged: true,
      measurable: false,
      pass: false,
      violation: !capturedDigest
        ? "Production acceptance has no captured worktree baseline digest to defend."
        : "The live worktree could not be re-fingerprinted at the end of the acceptance run.",
    };
  const diverged = currentDigest !== capturedDigest;
  return {
    capturedDigest,
    currentDigest,
    diverged,
    measurable: true,
    pass: !diverged,
    violation: diverged
      ? `The live worktree changed during the immutable acceptance run: captured ${capturedDigest}, live ${currentDigest}.`
      : null,
  };
}

async function prepareSnapshot(snapshotRoot, acceptanceReport) {
  const capturedSource = await sourceFingerprint();
  acceptanceReport.source.capturedWorktree = capturedSource;
  await materializeSourceSnapshot(repositoryRoot, snapshotRoot, capturedSource);
  const sourceAfterCopy = await sourceFingerprint();
  assert(
    sourceAfterCopy.digest === capturedSource.digest,
    "The worktree changed while its source snapshot was materialized.",
  );

  const dependencies = await materializeDependencySnapshot(
    repositoryRoot,
    snapshotRoot,
  );
  const snapshotSidecar = path.join(
    snapshotRoot,
    "apps",
    "desktop",
    "dist",
    "resume-parser-sidecar",
  );
  const generatedRoots = [
    path.join(snapshotRoot, "apps", "desktop", "out"),
    snapshotSidecar,
  ];
  // electron-vite writes its transient bundled config
  // (electron.vite.config.<timestamp>.mjs) beside the read-only source config.
  // Granting this single directory write access is safe because the full
  // source snapshot is re-fingerprinted after the build and any unexpected
  // byte change fails acceptance.
  const buildWritableRoots = [
    ...generatedRoots,
    path.join(snapshotRoot, "apps", "desktop"),
  ];
  for (const generatedRoot of generatedRoots)
    await (
      await import("node:fs/promises")
    ).mkdir(generatedRoot, {
      recursive: true,
    });
  assert(
    (await readdir(snapshotSidecar)).length === 0,
    "The derived sidecar output root was not fresh before the snapshot build.",
  );

  const dependencyAfterCopy = await dependencySnapshotFingerprint(
    snapshotRoot,
    dependencies.relativeRoots,
    {
      sourceEntries: capturedSource.files,
      generatedRoots,
    },
  );
  assert(
    dependencyAfterCopy.digest === dependencies.originalBeforeCopy.digest &&
      dependencyAfterCopy.fileCount ===
        dependencies.originalBeforeCopy.fileCount,
    "The dependency snapshot is not byte-for-byte bound to the stable original dependency endpoints.",
  );

  await makeTreeReadOnly(snapshotRoot);
  for (const writableRoot of buildWritableRoots)
    await makeTreeWritable(writableRoot);
  // The widened apps/desktop grant also covers its nested node_modules.
  // Restore exact read-only hardening on every dependency root so the
  // post-grant fingerprint keeps matching the expected mode transform;
  // electron-vite never writes inside dependency trees.
  for (const dependencyRoot of dependencies.relativeRoots)
    await makeTreeReadOnly(path.join(snapshotRoot, dependencyRoot));

  acceptanceReport.source.beforeBuild = await fingerprintSnapshot(
    snapshotRoot,
    capturedSource.files,
  );
  acceptanceReport.snapshot.capturedSourceDigest = capturedSource.digest;
  acceptanceReport.snapshot.digest = acceptanceReport.source.beforeBuild.digest;
  const dependencyBeforeBuild = await dependencySnapshotFingerprint(
    snapshotRoot,
    dependencies.relativeRoots,
    {
      sourceEntries: capturedSource.files,
      generatedRoots,
    },
  );
  assertReadOnlyInventoryTransform(dependencyAfterCopy, dependencyBeforeBuild);
  acceptanceReport.snapshot.dependencies = {
    strategy: dependencies.strategy,
    roots: dependencies.relativeRoots,
    originalBeforeCopy: dependencies.originalBeforeCopy,
    originalAfterCopy: dependencies.originalAfterCopy,
    copiedBeforeReadOnly: dependencyAfterCopy,
    beforeBuild: dependencyBeforeBuild,
  };
  acceptanceReport.snapshot.readOnlySource = true;
  acceptanceReport.snapshot.generatedWritableRoots = generatedRoots.map(
    (root) => path.relative(snapshotRoot, root).split(path.sep).join("/"),
  );
  acceptanceReport.snapshot.buildWritableRoots = buildWritableRoots.map(
    (root) => path.relative(snapshotRoot, root).split(path.sep).join("/"),
  );
  return { capturedSource, dependencies, generatedRoots };
}

// Fail-closed canonical-root preflight: an aliased JOB_FINDER_ACCEPTANCE_ARTIFACT_ROOT
// (symlinked parent, macOS /var vs /private/var, ".." spelling of the real
// path) would otherwise survive the whole multi-hour build/capture sequence
// and only then fail a canonical custody check such as verifyAcceptedElectronApp's
// "not canonical" assertion. Resolve and compare before anything expensive
// starts; downstream canonical assertions stay in force unchanged.
export async function assertCanonicalArtifactRoot(
  candidateArtifactRoot = artifactRoot,
) {
  const resolvedArtifactRoot = path.resolve(candidateArtifactRoot);
  let canonicalArtifactRoot;
  try {
    canonicalArtifactRoot = await realpath(resolvedArtifactRoot);
  } catch (error) {
    throw new Error(
      `Artifact root cannot be resolved: ${resolvedArtifactRoot} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (canonicalArtifactRoot !== resolvedArtifactRoot)
    throw new Error(
      `Artifact root is not canonical: ${resolvedArtifactRoot} resolves to ${canonicalArtifactRoot}. Export JOB_FINDER_ACCEPTANCE_ARTIFACT_ROOT (or relocate the default apps/desktop/test-artifacts/ui path) with the canonical absolute path; refusing to start the build and capture sequence against an alias that later canonical custody checks would reject.`,
    );
  return canonicalArtifactRoot;
}

async function main() {
  const startedAt = now();
  await (
    await import("node:fs/promises")
  ).mkdir(artifactRoot, { recursive: true });
  await assertCanonicalArtifactRoot();
  const runDir = await mkdtemp(
    path.join(artifactRoot, "production-acceptance-"),
  );
  assert(
    isInside(artifactRoot, runDir),
    `Acceptance run directory escaped ${artifactRoot}: ${runDir}`,
  );
  const manifestPath = path.join(runDir, "build-manifest.json");
  const reportPath = path.join(runDir, "acceptance-report.json");
  const approvedTempRoot = path.join(os.tmpdir(), "opencode");
  await (
    await import("node:fs/promises")
  ).mkdir(approvedTempRoot, {
    recursive: true,
  });
  const snapshotRoot = await mkdtemp(
    path.join(approvedTempRoot, "production-acceptance-source-"),
  );
  const snapshotDesktopDir = path.join(snapshotRoot, "apps", "desktop");
  const snapshotScriptDir = path.join(snapshotDesktopDir, "scripts");
  let scaleCaptureReport = null;
  let preparedSnapshot = null;
  const captureReportsById = {};
  const captureEntriesByComponent = {};
  const acceptanceReport = {
    acceptanceVersion: ACCEPTANCE_VERSION,
    runDir,
    pass: false,
    startedAt,
    snapshot: {
      root: snapshotRoot,
      approvedTempRoot,
      cleanedUp: false,
      sourceImmutable: false,
      dependencies: null,
      externalInputs: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
      },
    },
    build: {
      command: null,
      invocationSource: null,
      executable: null,
      cwd: snapshotRoot,
      rendererUrlEnvironmentRemoved: true,
    },
    source: {
      beforeBuild: null,
      afterBuild: null,
      gitBefore: null,
      gitAfter: null,
    },
    artifacts: null,
    acceptedApp: null,
    captures: {},
    screenshotCount: 0,
    safety: {
      syntheticTestDataOnly: true,
      isolatedUserDataDirectories: true,
      browserAgentDisabled: true,
      finalSubmitAndAccountCreationDisabled: true,
      prepareOnly: true,
      prepareOnlyVerified: false,
      applicationActionsExecuted: null,
      finalSubmissionClicked: null,
      submitAuthorized: null,
      accountCreationAuthorized: null,
      observedSafetyEvents: [],
    },
  };
  try {
    acceptanceReport.source.gitBefore = await gitMetadata();
    preparedSnapshot = await prepareSnapshot(snapshotRoot, acceptanceReport);
    acceptanceReport.snapshot.sourceImmutable = true;
    acceptanceReport.snapshot.loadedBootstrapIdentity = loadedBootstrapIdentity;
    const snapshotBootstrapIdentity = await Promise.all(
      loadedBootstrapIdentity.map(async (entry) => {
        const filePath = path.join(snapshotRoot, entry.path);
        return {
          path: entry.path,
          bytes: (await stat(filePath)).size,
          sha256: await sha256File(filePath),
        };
      }),
    );
    assert(
      stableJson(snapshotBootstrapIdentity) ===
        stableJson(loadedBootstrapIdentity),
      "Loaded acceptance bootstrap bytes differ from the captured snapshot.",
    );
    acceptanceReport.snapshot.bootstrapIdentity = snapshotBootstrapIdentity;
    const buildInvocation = snapshotBuildInvocation(snapshotRoot);
    const buildCommand = buildInvocation.command;
    const buildArgs = buildInvocation.args;
    acceptanceReport.build = {
      ...acceptanceReport.build,
      command: [buildCommand, ...buildArgs],
      invocationSource: buildInvocation.source,
      executable: buildInvocation.executable,
      executableIdentity: await executableIdentity(buildInvocation),
    };
    const buildResult = await runCommand(buildCommand, buildArgs, {
      cwd: snapshotRoot,
      env: acceptanceEnvironment(),
    });
    acceptanceReport.build = {
      ...acceptanceReport.build,
      ...buildResult,
      command: [buildCommand, ...buildArgs],
    };
    const executableIdentityAfterBuild =
      await executableIdentity(buildInvocation);
    assert(
      stableJson(executableIdentityAfterBuild) ===
        stableJson(acceptanceReport.build.executableIdentity),
      "Node or package-manager executable identity changed during the build.",
    );
    acceptanceReport.build.executableIdentityAfterBuild =
      executableIdentityAfterBuild;
    await writeCommandLogs(runDir, "build", buildResult);
    assert(
      buildResult.exitCode === 0,
      `Desktop build failed with exit code ${buildResult.exitCode}. See ${path.join(runDir, "build-stderr.log")}.`,
    );
    acceptanceReport.build.requiredOutputInventory =
      await assertExpectedBuildOutputs(snapshotDesktopDir);
    acceptanceReport.source.gitAfter = await gitMetadata();
    acceptanceReport.source.afterBuild = await fingerprintSnapshot(
      snapshotRoot,
      preparedSnapshot.capturedSource.files,
    );
    assert(
      acceptanceReport.source.beforeBuild.digest ===
        acceptanceReport.source.afterBuild.digest,
      "The build changed the immutable source snapshot.",
    );
    acceptanceReport.snapshot.dependencies.afterBuild =
      await dependencySnapshotFingerprint(
        snapshotRoot,
        preparedSnapshot.dependencies.relativeRoots,
        {
          sourceEntries: preparedSnapshot.capturedSource.files,
          generatedRoots: preparedSnapshot.generatedRoots,
        },
      );
    assert(
      acceptanceReport.snapshot.dependencies.beforeBuild.digest ===
        acceptanceReport.snapshot.dependencies.afterBuild.digest,
      "The build changed the immutable dependency snapshot.",
    );
    for (const relativeRoot of [
      "out",
      "assets",
      path.join("dist", "resume-parser-sidecar"),
    ]) {
      const root = path.join(snapshotDesktopDir, relativeRoot);
      if (existsSync(root)) await makeTreeReadOnly(root);
    }
    // Fingerprint only after hardening: the sealed artifact identity must
    // bind the exact read-only runtime state that ships, so every later
    // recompute (captures, post-run, export equality) sees identical modes.
    acceptanceReport.artifacts = await artifactFingerprint(snapshotDesktopDir);
    assert(
      acceptanceReport.artifacts.fileCount > 0,
      "Exact build produced no hashed artifacts.",
    );
    const sidecarFiles = acceptanceReport.artifacts.files.filter((entry) =>
      entry.path.startsWith("dist/resume-parser-sidecar/"),
    );
    acceptanceReport.snapshot.derivedOutputs = {
      resumeParserSidecar: {
        origin: "generated-inside-snapshot-from-captured-inputs",
        importedFromOriginalDist: false,
        fileCount: sidecarFiles.length,
        digest: createHash("sha256")
          .update(stableJson(sidecarFiles))
          .digest("hex"),
      },
    };
    acceptanceReport.electron = {
      capture: await electronIdentityFromSnapshot(snapshotDesktopDir),
    };
    const immutableManifest = JSON.parse(JSON.stringify(acceptanceReport));
    immutableManifest.manifestSha256 = createHash("sha256")
      .update(stableJson(immutableManifest))
      .digest("hex");
    acceptanceReport.initialManifestSha256 = immutableManifest.manifestSha256;
    await writeJson(manifestPath, immutableManifest);
    await makeEvidenceFilesReadOnly(runDir, [
      { path: path.basename(manifestPath) },
    ]);
    acceptanceReport.initialManifestFileSha256 = await sha256File(manifestPath);
    for (const capture of captureScripts) {
      const captureDir = path.join(runDir, capture.id);
      const environment = acceptanceEnvironment({
        JOB_FINDER_ACCEPTANCE_RUN_DIR: runDir,
        JOB_FINDER_ACCEPTANCE_MANIFEST: manifestPath,
        JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256: immutableManifest.manifestSha256,
        JOB_FINDER_ACCEPTANCE_COMPONENT: capture.id,
        JOB_FINDER_ACCEPTANCE_ARTIFACT_ROOT: artifactRoot,
      });
      const result = await runTrackedCommand(
        process.execPath,
        [path.join(snapshotScriptDir, capture.script)],
        { cwd: snapshotDesktopDir, env: environment },
      );
      let wrapperCleanup;
      try {
        wrapperCleanup = await terminateAndVerifyTrackedCommand(
          result,
          `${capture.id} wrapper-owned command`,
        );
      } catch (error) {
        wrapperCleanup = {
          verified: false,
          trackedProcesses: result.trackedProcesses,
          leftoverPids: result.trackedProcesses.map((entry) => entry.pid),
          processGroupId: result.processGroupId,
          error: error instanceof Error ? error.message : String(error),
        };
        acceptanceReport.captures[capture.id] = {
          childPid: result.childPid,
          wrapperCleanup,
          commandExitCode: result.exitCode,
        };
        throw error;
      }
      acceptanceReport.captures[capture.id] = {
        childPid: result.childPid,
        wrapperCleanup,
        commandExitCode: result.exitCode,
      };
      await writeCommandLogs(runDir, capture.id, result);
      assert(
        result.exitCode === 0,
        `${capture.id} acceptance failed with exit code ${result.exitCode}. See ${path.join(runDir, `${capture.id}-stderr.log`)}.`,
      );
      assert(
        result.stderr.trim() === "",
        `${capture.id} wrote to stderr; the run is not clean. See ${path.join(runDir, `${capture.id}-stderr.log`)}.`,
      );
      const reportFile = path.join(captureDir, capture.report);
      assert(
        existsSync(reportFile),
        `${capture.id} did not produce ${capture.report}.`,
      );
      const captureReport = await readJson(reportFile);
      Object.defineProperty(captureReport, "__reportPath", {
        value: reportFile,
        enumerable: false,
      });
      if (capture.id === "scale") scaleCaptureReport = captureReport;
      captureReportsById[capture.id] = captureReport;
      assertAcceptanceBinding(capture.id, captureReport, acceptanceReport);
      assertComponentCompletion(captureReport, capture.id);
      assert(
        Array.isArray(captureReport.runtimeErrors) &&
          captureReport.runtimeErrors.length === 0,
        `${capture.id} reported renderer/runtime errors.`,
      );
      assert(
        isRecord(captureReport.mainProcess) &&
          typeof captureReport.mainProcess.unexpectedStderr === "string" &&
          captureReport.mainProcess.unexpectedStderr.trim() === "",
        `${capture.id} reported unexpected Electron main stderr.`,
      );
      assertCaptureSafety(capture.id, captureReport);
      const captureEntries =
        captureReport.captures ?? captureReport.screenshots ?? [];
      captureEntriesByComponent[capture.id] = captureEntries;
      assert(
        Array.isArray(captureEntries) && captureEntries.length > 0,
        `${capture.id} produced no capture entries.`,
      );
      const disallowedNativeZoomViolations =
        findDisallowedCaptureNativeZoomFactors(capture.id, captureEntries);
      assert(
        disallowedNativeZoomViolations.length === 0,
        `Current acceptance captured a native zoom factor outside the accepted set {1, 1.25}: ${disallowedNativeZoomViolations.join("; ")}`,
      );
      for (const entry of captureEntries) {
        assert(
          entry.pass === true,
          `${capture.id} contains a failed capture entry: ${entry.label ?? entry.fileName}`,
        );
        assert(
          Array.isArray(entry.failures) && entry.failures.length === 0,
          `${capture.id} contains capture failures: ${entry.label ?? entry.fileName}: ${JSON.stringify(entry.failures)}`,
        );
        assert(
          entry.insideViewport === true,
          `${capture.id} contains an out-of-viewport capture: ${entry.label ?? entry.fileName}`,
        );
        assert(
          entry.noClip === true,
          `${capture.id} contains a clipped capture: ${entry.label ?? entry.fileName}`,
        );
      }
      if (capture.id === "error-recovery") {
        const recoveryEntryContract =
          evaluateErrorRecoveryCaptureEntries(captureEntries);
        assert(
          recoveryEntryContract.pass,
          `${capture.id} recovery capture entries violate the exact recovered-scenario contract: ${JSON.stringify(recoveryEntryContract.violations)}`,
        );
      }
      assertScenarioContract(capture.id, captureReport, captureEntries);
      if (capture.id === "scale") {
        assertScaleDataContract(captureReport);
        assertScalePerformanceContract(captureReport);
      }
      if (capture.id === "fresh") {
        const scrollProof = captureEntries
          .map((entry) => entry.nestedScroll)
          .filter(Boolean)
          .find(
            (entry) =>
              entry.available &&
              entry.wheelMoved &&
              entry.keyboardMoved &&
              !entry.wheelLeaked &&
              !entry.keyboardLeaked,
          );
        assert(
          scrollProof,
          "Fresh acceptance did not produce a real wheel-and-keyboard scroll-chain proof.",
        );
      }
      assertScenarioMatrix(capture.id, captureReport);
      const screenshotSummary = await verifyScreenshots(
        captureDir,
        captureReport,
      );
      acceptanceReport.captures[capture.id] = {
        ...acceptanceReport.captures[capture.id],
        report: reportFile,
        pass: true,
        completedAt: captureReport.completedAt,
        screenshotCount: screenshotSummary.screenshotCount,
        summary: captureReport.summary ?? null,
        childPid: result.childPid,
      };
      acceptanceReport.screenshotCount += screenshotSummary.screenshotCount;
      const currentArtifacts = await artifactFingerprint(snapshotDesktopDir);
      assert(
        currentArtifacts.digest === acceptanceReport.artifacts.digest,
        `${capture.id} changed the built artifacts after the exact build.`,
      );
      const postCaptureSource = await fingerprintSnapshot(
        snapshotRoot,
        preparedSnapshot.capturedSource.files,
      );
      assert(
        postCaptureSource.digest === acceptanceReport.source.afterBuild?.digest,
        `${capture.id} changed the immutable source snapshot; evidence would not be bound to ${acceptanceReport.source.afterBuild?.digest}.`,
      );
      acceptanceReport.captures[capture.id].sourceDigestAfterCapture =
        postCaptureSource.digest;
    }
    const afterRunArtifacts = await artifactFingerprint(snapshotDesktopDir);
    assert(
      afterRunArtifacts.digest === acceptanceReport.artifacts.digest,
      "Build artifacts changed after screenshots; evidence is not bound to the exact build.",
    );
    acceptanceReport.artifacts.postRun = afterRunArtifacts;
    const afterRunSource = await fingerprintSnapshot(
      snapshotRoot,
      preparedSnapshot.capturedSource.files,
    );
    assert(
      afterRunSource.digest === acceptanceReport.source.afterBuild?.digest,
      "The immutable source snapshot changed during acceptance.",
    );
    acceptanceReport.source.postRun = {
      algorithm: afterRunSource.algorithm,
      digest: afterRunSource.digest,
      fileCount: afterRunSource.fileCount,
    };
    acceptanceReport.snapshot.dependencies.postRun =
      await dependencySnapshotFingerprint(
        snapshotRoot,
        preparedSnapshot.dependencies.relativeRoots,
        {
          sourceEntries: preparedSnapshot.capturedSource.files,
          generatedRoots: preparedSnapshot.generatedRoots,
        },
      );
    assert(
      acceptanceReport.snapshot.dependencies.postRun.digest ===
        acceptanceReport.snapshot.dependencies.beforeBuild.digest,
      "The immutable dependency snapshot changed during acceptance.",
    );
    assert(
      (await sha256File(manifestPath)) ===
        acceptanceReport.initialManifestFileSha256,
      "The immutable initial exact-build manifest changed during acceptance.",
    );
    await assertNoSurvivingTrackedProcesses(
      scaleCaptureReport?.processOwnership?.trackedProcesses,
      "Scale acceptance",
    );
    for (const [componentId, componentReport] of Object.entries(
      captureReportsById,
    )) {
      if (componentId === "scale") continue;
      const tracked = componentReport?.processOwnership?.trackedProcesses;
      if (!Array.isArray(tracked) || tracked.length === 0) continue;
      await assertNoSurvivingTrackedProcesses(
        tracked,
        `${componentId} acceptance`,
      );
    }
    const screenshotCollisionScan = findCrossComponentScreenshotCollisions(
      captureEntriesByComponent,
    );
    assert(
      screenshotCollisionScan.collisions.length === 0,
      `Byte-identical screenshots claim distinct semantic states across capture components: ${JSON.stringify(screenshotCollisionScan.collisions.slice(0, 5))}`,
    );
    assertProductSurfaceViewportMatrix(captureEntriesByComponent);
    const acceptedAppRoot = path.join(runDir, "accepted-app");
    acceptanceReport.acceptedApp = await exportAcceptedElectronApp({
      sourceDesktopDir: snapshotDesktopDir,
      destinationRoot: acceptedAppRoot,
      artifacts: afterRunArtifacts,
      sourceDigest: afterRunSource.digest,
      snapshotRoot,
    });
    await verifyAcceptedElectronApp(
      acceptedAppRoot,
      acceptanceReport.acceptedApp,
    );
    acceptanceReport.snapshot.finalSource = afterRunSource;
    acceptanceReport.electron.accepted = await electronIdentityFromSnapshot(
      acceptedAppRoot,
      {
        containmentRoot: acceptedAppRoot,
      },
    );
    const { executablePath: capturePath, ...captureIdentity } =
      acceptanceReport.electron.capture;
    const { executablePath: acceptedPath, ...acceptedIdentity } =
      acceptanceReport.electron.accepted;
    assert(
      stableJson(captureIdentity) === stableJson(acceptedIdentity),
      `Accepted Electron identity differs from capture Electron: ${capturePath} !== ${acceptedPath}`,
    );
    await makeTreeWritable(snapshotRoot);
    const preProbeCleanupError = await cleanupDirectory(snapshotRoot);
    if (preProbeCleanupError) throw preProbeCleanupError;
    acceptanceReport.snapshot.cleanedUp = true;
    acceptanceReport.snapshot.cleanedUpAt = now();
    acceptanceReport.acceptedApp.verifiedAfterSnapshotCleanup = true;
    const runtimeProbePath = path.join(
      runDir,
      "accepted-app-runtime-probe.json",
    );
    acceptanceReport.runtimeProbe = await runAcceptedAppRuntimeProbe({
      acceptedAppRecord: acceptanceReport.acceptedApp,
      acceptedAppRoot,
      electronIdentity: acceptanceReport.electron.accepted,
      outputPath: runtimeProbePath,
    });
    // Second defense: a missing or failing runtime probe (either the
    // deterministic probe or the production tester probe) must never allow
    // acceptance pass or sealing.
    assert(
      evaluateRuntimeProbePassRequirement(acceptanceReport.runtimeProbe),
      "Accepted-app runtime probe (including the production tester probe) must pass before any further evidence or sealing.",
    );
    // Bind the tester screenshot into the cross-component collision scan
    // under its own component: an undeclared duplicate of any capture
    // screenshot must fail exactly like capture-internal duplicates do.
    if (acceptanceReport.runtimeProbe?.productionTesterProbe?.screenshot) {
      captureEntriesByComponent["accepted-app-production-tester"] = [
        {
          fileName:
            acceptanceReport.runtimeProbe.productionTesterProbe.screenshot.path,
          pass: acceptanceReport.runtimeProbe.pass === true,
          scenarioId: "accepted-app-production-tester-shell",
          sha256:
            acceptanceReport.runtimeProbe.productionTesterProbe.screenshot
              .sha256,
        },
      ];
      const postProbeCollisionScan = findCrossComponentScreenshotCollisions(
        captureEntriesByComponent,
      );
      assert(
        postProbeCollisionScan.collisions.length === 0,
        `Byte-identical screenshots claim distinct semantic states across capture components including the production tester probe: ${JSON.stringify(postProbeCollisionScan.collisions.slice(0, 5))}`,
      );
      acceptanceReport.screenshotCollisionScan = {
        scannedComponents: Object.keys(captureEntriesByComponent),
        collisionCount: postProbeCollisionScan.collisions.length,
      };
    }
    acceptanceReport.electron.final = {
      ...acceptanceReport.electron.accepted,
      sha256: await sha256File(
        acceptanceReport.electron.accepted.executablePath,
      ),
    };
    assert(
      stableJson(acceptanceReport.electron.final) ===
        stableJson(acceptanceReport.electron.accepted),
      "Electron executable identity changed during acceptance.",
    );
    acceptanceReport.evidence = await finalizeFileEvidence({
      root: runDir,
      verifyConsistency: async () => {
        await verifyFinalEvidence(runDir, captureReportsById);
        await verifyAcceptedElectronApp(
          acceptedAppRoot,
          acceptanceReport.acceptedApp,
        );
      },
      buildInventory: () =>
        buildEvidenceInventory(
          runDir,
          captureReportsById,
          captureEntriesByComponent,
          acceptanceReport.acceptedApp,
          runtimeProbePath,
          [
            // The exact-build command's own stdout/stderr, closed right
            // after the build finished and long before evidence sealing.
            {
              component: "build",
              kind: "build-log",
              path: path.join(runDir, "build-stdout.log"),
            },
            {
              component: "build",
              kind: "build-log",
              path: path.join(runDir, "build-stderr.log"),
            },
            ...captureScripts.flatMap((capture) => [
              {
                component: capture.id,
                kind: "component-log",
                path: path.join(runDir, `${capture.id}-stdout.log`),
              },
              {
                component: capture.id,
                kind: "component-log",
                path: path.join(runDir, `${capture.id}-stderr.log`),
              },
            ]),
            ...(acceptanceReport.runtimeProbe?.productionTesterProbe?.screenshot
              ? [
                  {
                    component: "accepted-app-production-tester",
                    kind: "screenshot",
                    path: path.join(
                      runDir,
                      acceptanceReport.runtimeProbe.productionTesterProbe
                        .screenshot.path,
                    ),
                  },
                ]
              : []),
          ],
        ),
    });
    await makeEvidenceFilesReadOnly(runDir, acceptanceReport.evidence.files);
    const componentSafety = Object.values(captureReportsById).map(
      (componentReport) => componentReport.safety,
    );
    acceptanceReport.safety = {
      ...acceptanceReport.safety,
      prepareOnlyVerified: componentSafety.every(
        (safety) => safety?.prepareOnlyVerified === true,
      ),
      applicationActionsExecuted: componentSafety.some(
        (safety) => safety?.applicationActionsExecuted === true,
      ),
      finalSubmissionClicked: componentSafety.some(
        (safety) => safety?.finalSubmissionClicked === true,
      ),
      submitAuthorized: componentSafety.some(
        (safety) => safety?.submitAuthorized === true,
      ),
      accountCreationAuthorized: componentSafety.some(
        (safety) => safety?.accountCreationAuthorized === true,
      ),
      observedSafetyEvents: componentSafety.flatMap((safety) =>
        Array.isArray(safety?.observedSafetyEvents)
          ? safety.observedSafetyEvents
          : [],
      ),
      authoritativePersistedFactsVerified: componentSafety.every(
        (safety) => safety?.authoritativePersistedFacts?.pass === true,
      ),
    };
    assert(
      acceptanceReport.safety.prepareOnlyVerified === true &&
        acceptanceReport.safety.applicationActionsExecuted === false &&
        acceptanceReport.safety.finalSubmissionClicked === false &&
        acceptanceReport.safety.submitAuthorized === false &&
        acceptanceReport.safety.accountCreationAuthorized === false &&
        acceptanceReport.safety.observedSafetyEvents.length === 0 &&
        acceptanceReport.safety.authoritativePersistedFactsVerified === true,
      `Final safety aggregation failed: ${JSON.stringify(acceptanceReport.safety)}`,
    );
    const executableIdentityAfterRun =
      await executableIdentity(buildInvocation);
    assert(
      stableJson(executableIdentityAfterRun) ===
        stableJson(acceptanceReport.build.executableIdentity),
      "Node or package-manager executable identity changed during acceptance.",
    );
    acceptanceReport.build.executableIdentityAfterRun =
      executableIdentityAfterRun;
    acceptanceReport.completedAt = now();
    // Final record reflects the full map including the production tester
    // screenshot component; zero collisions are re-asserted at seal time.
    const finalCollisionScan = findCrossComponentScreenshotCollisions(
      captureEntriesByComponent,
    );
    assert(
      finalCollisionScan.collisions.length === 0,
      `Byte-identical screenshots claim distinct semantic states across capture components: ${JSON.stringify(finalCollisionScan.collisions.slice(0, 5))}`,
    );
    acceptanceReport.screenshotCollisionScan = {
      scannedComponents: Object.keys(captureEntriesByComponent),
      collisionCount: finalCollisionScan.collisions.length,
    };
    acceptanceReport.durationMs =
      new Date(acceptanceReport.completedAt).getTime() -
      new Date(startedAt).getTime();
    // Live-worktree continuity gate: all evidence above binds to the worktree
    // exactly as captured into the immutable snapshot, so success may latch
    // only while the live worktree still matches that baseline digest. A
    // dirty-but-unchanged baseline passes; any mid-run drift — or an
    // unmeasurable worktree — fails here, before the success latch and
    // therefore before any seal can exist.
    await recordCurrentWorktreeContinuity(acceptanceReport);
    acceptanceReport.source.currentWorktreeContinuity =
      evaluateCurrentWorktreeContinuity(
        acceptanceReport.source.capturedWorktree,
        acceptanceReport.source.currentWorktree,
      );
    assert(
      acceptanceReport.source.currentWorktreeContinuity.pass === true,
      acceptanceReport.source.currentWorktreeContinuity.violation ??
        "The live worktree diverged from its captured baseline during acceptance.",
    );
    // Success latch: only after every throw-capable final assertion above
    // (safety, executable identity, collision scan, live-worktree continuity)
    // has passed.
    acceptanceReport.pass = true;
  } catch (error) {
    acceptanceReport.pass = false;
    acceptanceReport.failedAt = now();
    acceptanceReport.failure =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.exitCode = 1;
  }

  // Diagnostic-only recheck for runs that already failed before the pre-latch
  // continuity gate ran: it records the same live-worktree facts for
  // forensics. The guard keeps it off every passing run, so this path can
  // never flip pass back to true and can never reach seal creation.
  if (
    acceptanceReport.pass !== true &&
    acceptanceReport.source.currentWorktreeDiverged === undefined
  ) {
    await recordCurrentWorktreeContinuity(acceptanceReport);
  }
  if (preparedSnapshot && existsSync(snapshotRoot)) {
    try {
      acceptanceReport.snapshot.finalSource = await fingerprintSnapshot(
        snapshotRoot,
        preparedSnapshot.capturedSource.files,
      );
      if (
        acceptanceReport.snapshot.finalSource.digest !==
        acceptanceReport.source.beforeBuild?.digest
      ) {
        throw new Error("Snapshot source digest changed before cleanup.");
      }
    } catch (error) {
      acceptanceReport.pass = false;
      acceptanceReport.failure ??=
        error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  }
  try {
    await writeJson(reportPath, acceptanceReport);
  } catch (error) {
    acceptanceReport.pass = false;
    acceptanceReport.reportWriteError =
      error instanceof Error ? error.message : String(error);
    acceptanceReport.failure ??= `Acceptance report write failed: ${acceptanceReport.reportWriteError}`;
    process.exitCode = 1;
  }
  try {
    if (existsSync(snapshotRoot)) {
      await makeTreeWritable(snapshotRoot);
      const cleanupError = await cleanupDirectory(snapshotRoot);
      if (cleanupError) throw cleanupError;
      acceptanceReport.snapshot.cleanedUp = true;
      acceptanceReport.snapshot.cleanedUpAt = now();
    }
    if (acceptanceReport.acceptedApp) {
      await verifyAcceptedElectronApp(
        path.join(runDir, acceptanceReport.acceptedApp.path),
        acceptanceReport.acceptedApp,
      );
      acceptanceReport.acceptedApp.verifiedAfterSnapshotCleanup = true;
    }
  } catch (error) {
    acceptanceReport.pass = false;
    acceptanceReport.snapshot.cleanupError =
      error instanceof Error ? error.message : String(error);
    acceptanceReport.failure ??= `Snapshot cleanup failed: ${acceptanceReport.snapshot.cleanupError}`;
    process.exitCode = 1;
  }
  try {
    await writeJson(reportPath, acceptanceReport);
    if (acceptanceReport.pass) {
      const reportBytes = await readFile(reportPath);
      const seal = createFinalAcceptanceSeal({
        runId: path.basename(runDir),
        runDir,
        sourceId: acceptanceReport.source.afterBuild.digest,
        artifactId: acceptanceReport.artifacts.digest,
        initialBuildManifest: {
          path: "build-manifest.json",
          rawSha256: acceptanceReport.initialManifestFileSha256,
          canonicalSha256: acceptanceReport.initialManifestSha256,
        },
        finalReport: {
          path: "acceptance-report.json",
          rawSha256: createHash("sha256").update(reportBytes).digest("hex"),
          canonicalSha256: createHash("sha256")
            .update(stableJson(acceptanceReport))
            .digest("hex"),
        },
        acceptedApp: {
          path: acceptanceReport.acceptedApp.path,
          digest: acceptanceReport.acceptedApp.digest,
          fileCount: acceptanceReport.acceptedApp.fileCount,
        },
        electron: acceptanceReport.electron.final,
        evidence: {
          digest: acceptanceReport.evidence.digest,
          fileCount: acceptanceReport.evidence.fileCount,
        },
        runtimeProbeSha256: await sha256File(
          path.join(runDir, "accepted-app-runtime-probe.json"),
        ),
      });
      const sealPath = path.join(runDir, "acceptance-seal.json");
      await writeJson(sealPath, seal);
      await chmod(reportPath, 0o444);
      await chmod(sealPath, 0o444);
      verifyFinalAcceptanceSeal(
        JSON.parse(await readFile(sealPath, "utf8")),
        seal.sealSha256,
      );
      assert(
        (await sha256File(reportPath)) === seal.finalReport.rawSha256 &&
          (((await stat(reportPath)).mode | (await stat(sealPath)).mode) &
            0o222) ===
            0,
        "Final report/seal digest or read-only mode changed after sealing.",
      );
      acceptanceReport.finalSeal = {
        path: sealPath,
        expectedSealSha256: seal.sealSha256,
      };
    }
  } catch (error) {
    acceptanceReport.pass = false;
    acceptanceReport.finalReportWriteError =
      error instanceof Error ? error.message : String(error);
    acceptanceReport.failure ??= `Final acceptance report write failed: ${acceptanceReport.finalReportWriteError}`;
    process.exitCode = 1;
  }
  if (acceptanceReport.pass) {
    process.stdout.write(`Production acceptance passed. Run: ${runDir}\n`);
    process.stdout.write(`Screenshots: ${acceptanceReport.screenshotCount}\n`);
    process.stdout.write(
      `Externally custody expected acceptance seal SHA-256: ${acceptanceReport.finalSeal.expectedSealSha256}\n`,
    );
  } else {
    process.stderr.write(`${acceptanceReport.failure}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  // Electron-free contract fixtures plus the static route-binding guard; the
  // production acceptance run is untouched without this explicit flag.
  if (process.argv.includes("--self-test-shell-header-geometry")) {
    const fixtureSuite = evaluateShellHeaderGeometryFixtureSuite();
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    const routeAudit = auditTesterShellProbeRouteBinding(source);
    const pass = fixtureSuite.pass === true && routeAudit.pass === true;
    process.stdout.write(
      `${stableJson({ fixtureSuite, kind: "shell-header-self-test", pass, routeAudit })}\n`,
    );
    process.exitCode = pass ? 0 : 1;
  } else await main();
}
