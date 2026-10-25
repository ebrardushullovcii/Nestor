import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");

function readOption(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function getDefaultUserDataDirectory() {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("APPDATA is unavailable; pass --user-data-dir explicitly.");
  }
  return path.join(appData, "@nestor", "desktop");
}

function getDefaultReportPath() {
  const documents = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, "Documents")
    : repoRoot;
  return path.join(documents, "JobSources", "source-check-all-progress.json");
}

function toTimestampSlug(value = new Date()) {
  return value.toISOString().replaceAll(":", "-").replace(".", "-");
}

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sourceKind(startingUrl) {
  const hostname = new URL(startingUrl).hostname.toLowerCase();
  if (
    hostname === "boards.greenhouse.io" ||
    hostname === "job-boards.greenhouse.io" ||
    hostname.endsWith(".lever.co") ||
    hostname === "jobs.ashbyhq.com"
  ) {
    return "provider";
  }
  return "browser";
}

function loadWorkspacePreferences(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = String(
      database.prepare("PRAGMA integrity_check").get()?.integrity_check,
    );
    if (integrity !== "ok") {
      throw new Error(`Workspace integrity check failed: ${integrity}`);
    }
    const row = database
      .prepare(
        "SELECT value FROM singleton_state WHERE key = 'search_preferences'",
      )
      .get();
    if (!row) {
      throw new Error("The workspace has no saved search preferences.");
    }
    return JSON.parse(String(row.value));
  } finally {
    database.close();
  }
}

function createWorkspaceBackup(databasePath, backupDirectory) {
  const database = new DatabaseSync(databasePath);
  const backupPath = path.join(
    backupDirectory,
    `job-finder-workspace-before-source-check-all-${toTimestampSlug()}.sqlite`,
  );
  try {
    database.exec("PRAGMA wal_checkpoint(FULL)");
    database.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  } finally {
    database.close();
  }
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const integrity = String(
      backup.prepare("PRAGMA integrity_check").get()?.integrity_check,
    );
    if (integrity !== "ok") {
      throw new Error(`Backup integrity check failed: ${integrity}`);
    }
  } finally {
    backup.close();
  }
  return backupPath;
}

async function readCheckpoint(reportPath) {
  try {
    const parsed = JSON.parse(await readFile(reportPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeCheckpoint(reportPath, report) {
  const temporaryPath = `${reportPath}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, reportPath);
}

function summarizeCounts(results) {
  const counts = {
    completed: 0,
    failed: 0,
    pausedManual: 0,
    partial: 0,
    timedOut: 0,
    unexpectedError: 0,
    validated: 0,
    draft: 0,
    missing: 0,
  };
  for (const result of Object.values(results)) {
    if (result.outcome === "completed") counts.completed += 1;
    if (result.outcome === "failed") counts.failed += 1;
    if (result.outcome === "paused_manual") counts.pausedManual += 1;
    if (result.outcome.startsWith("partial_")) counts.partial += 1;
    if (result.outcome === "timed_out") counts.timedOut += 1;
    if (result.outcome === "unexpected_error") counts.unexpectedError += 1;
    if (result.instructionStatus === "validated") counts.validated += 1;
    else if (result.instructionStatus === "draft") counts.draft += 1;
    else counts.missing += 1;
  }
  return counts;
}

const userDataDirectory = path.resolve(
  readOption("--user-data-dir", getDefaultUserDataDirectory()),
);
const databasePath = path.join(
  userDataDirectory,
  "job-finder-workspace.sqlite",
);
const reportPath = path.resolve(readOption("--report", getDefaultReportPath()));
const reportDirectory = path.dirname(reportPath);
const backupDirectory = path.join(reportDirectory, "profile-backups");
const targetPrefix = readOption("--target-prefix", "target_research_");
const mode = readOption("--mode", "all");
const browserHeadless = !hasFlag("--headed");
const retryFailed = hasFlag("--retry-failed");
const retryPartial = hasFlag("--retry-partial");
const limitValue = readOption("--limit");
const limit = limitValue ? parsePositiveInteger(limitValue, "--limit") : null;
const providerTimeoutMs = parsePositiveInteger(
  readOption("--provider-timeout-ms", "45000"),
  "--provider-timeout-ms",
);
const browserTimeoutMs = parsePositiveInteger(
  readOption("--browser-timeout-ms", "240000"),
  "--browser-timeout-ms",
);

if (!["all", "provider", "browser"].includes(mode)) {
  throw new Error("--mode must be all, provider, or browser.");
}

await mkdir(reportDirectory, { recursive: true });
await mkdir(backupDirectory, { recursive: true });

const preferences = loadWorkspacePreferences(databasePath);
const selectedTargets = preferences.discovery.targets
  .filter((target) => target.id.startsWith(targetPrefix))
  .map((target) => ({ ...target, sourceKind: sourceKind(target.startingUrl) }))
  .filter((target) => mode === "all" || target.sourceKind === mode)
  .sort((left, right) => {
    if (left.sourceKind !== right.sourceKind) {
      return left.sourceKind === "provider" ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });

if (selectedTargets.length === 0) {
  throw new Error(
    `No workspace targets match prefix ${JSON.stringify(targetPrefix)}.`,
  );
}

const existingCheckpoint = await readCheckpoint(reportPath);
const results = existingCheckpoint?.results ?? {};
const targetStatusById = new Map(
  preferences.discovery.targets.map((target) => [
    target.id,
    target.instructionStatus,
  ]),
);
for (const result of Object.values(results)) {
  const currentInstructionStatus = targetStatusById.get(result.targetId);
  if (currentInstructionStatus) {
    result.instructionStatus = currentInstructionStatus;
    if (
      currentInstructionStatus !== "missing" &&
      result.outcome === "timed_out"
    ) {
      result.outcome = "partial_timeout";
    }
  }
}
const alreadyTerminal = new Set(
  Object.entries(results).flatMap(([targetId, result]) => {
    if (
      (retryFailed &&
        ["failed", "timed_out", "unexpected_error"].includes(result.outcome)) ||
      (retryPartial && result.outcome.startsWith("partial_"))
    ) {
      return [];
    }
    return [targetId];
  }),
);
let pendingTargets = selectedTargets.filter(
  (target) => !alreadyTerminal.has(target.id),
);
if (limit !== null) {
  pendingTargets = pendingTargets.slice(0, limit);
}

const backupPath = createWorkspaceBackup(databasePath, backupDirectory);
const report = {
  schemaVersion: 1,
  startedAt: existingCheckpoint?.startedAt ?? new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  branch: execFileSync("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim(),
  mode,
  targetPrefix,
  selectedTargetCount: selectedTargets.length,
  pendingAtStart: pendingTargets.length,
  backupPaths: [
    ...new Set([...(existingCheckpoint?.backupPaths ?? []), backupPath]),
  ],
  safety: {
    sequential: true,
    browserHeadless,
    computerUse: false,
    finalSubmitAuthorized: false,
    accountCreationAuthorized: false,
    loginOrManualGatesAreSkipped: true,
  },
  counts: summarizeCounts(results),
  results,
  rendererErrors: existingCheckpoint?.rendererErrors ?? [],
};
await writeCheckpoint(reportPath, report);

let app = null;
let page = null;
let activeProgress = null;

async function closeApp() {
  const currentApp = app;
  app = null;
  page = null;
  activeProgress = null;
  if (currentApp) {
    await currentApp.close().catch(() => undefined);
  }
}

async function openApp() {
  if (app && page) return;
  app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_BROWSER_AGENT: "1",
      NESTOR_BROWSER_HEADLESS: browserHeadless ? "1" : "0",
      NESTOR_ENABLE_TEST_API: "0",
      NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES: "0",
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  });
  page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") {
      report.rendererErrors.push({
        at: new Date().toISOString(),
        message: message.text(),
      });
    }
  });
  page.on("pageerror", (error) => {
    report.rendererErrors.push({
      at: new Date().toISOString(),
      message: error.message,
    });
  });
  await page.exposeFunction("__nestorSourceCheckProgress", (event) => {
    activeProgress = event;
  });
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.nestor.jobFinder.getWorkspace());
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach((window) => window.hide());
  });
}

async function cancelActiveRun() {
  const runId = activeProgress?.runId;
  if (!page || !runId) return;
  await page
    .evaluate(
      (activeRunId) => window.nestor.jobFinder.cancelSourceDebug(activeRunId),
      runId,
    )
    .catch(() => undefined);
}

async function runOneTarget(target, index) {
  await openApp();
  activeProgress = null;
  const timeoutMs =
    target.sourceKind === "provider" ? providerTimeoutMs : browserTimeoutMs;
  process.stdout.write(
    `[${index + 1}/${pendingTargets.length}] START ${target.sourceKind} ${target.label} ${target.startingUrl}\n`,
  );
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let timeoutHandle;
  const runPromise = page.evaluate(
    (targetId) =>
      window.nestor.jobFinder.runSourceDebug(targetId, (event) => {
        window.__nestorSourceCheckProgress(event);
      }),
    target.id,
  );

  try {
    await Promise.race([
      runPromise,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Source check exceeded ${timeoutMs} ms.`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    const timedOut =
      error instanceof Error && error.message.includes("Source check exceeded");
    if (timedOut) {
      await cancelActiveRun();
    }
    await runPromise.catch(() => undefined);
    const [workspace, runs] = await Promise.all([
      page.evaluate(() => window.nestor.jobFinder.getWorkspace()),
      page.evaluate(
        (targetId) => window.nestor.jobFinder.listSourceDebugRuns(targetId),
        target.id,
      ),
    ]);
    const savedTarget = workspace.searchPreferences.discovery.targets.find(
      (entry) => entry.id === target.id,
    );
    const latestRun = [...runs].sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    )[0];
    const instructionStatus = savedTarget?.instructionStatus ?? "missing";
    const hasUsefulDraft = instructionStatus !== "missing";
    return {
      targetId: target.id,
      label: target.label,
      startingUrl: target.startingUrl,
      sourceKind: target.sourceKind,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      outcome: hasUsefulDraft
        ? timedOut
          ? "partial_timeout"
          : "partial_error"
        : timedOut
          ? "timed_out"
          : "unexpected_error",
      runState: latestRun?.state ?? null,
      instructionStatus,
      runId: activeProgress?.runId ?? null,
      instructionArtifactId: latestRun?.instructionArtifactId ?? null,
      summary: [
        error instanceof Error ? error.message : String(error),
        latestRun?.finalSummary,
      ]
        .filter(Boolean)
        .join(" "),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }

  const [workspace, runs] = await Promise.all([
    page.evaluate(() => window.nestor.jobFinder.getWorkspace()),
    page.evaluate(
      (targetId) => window.nestor.jobFinder.listSourceDebugRuns(targetId),
      target.id,
    ),
  ]);
  const savedTarget = workspace.searchPreferences.discovery.targets.find(
    (entry) => entry.id === target.id,
  );
  const latestRun = [...runs].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  )[0];
  const outcome =
    latestRun?.state === "completed"
      ? "completed"
      : latestRun?.state === "paused_manual"
        ? "paused_manual"
        : "failed";

  return {
    targetId: target.id,
    label: target.label,
    startingUrl: target.startingUrl,
    sourceKind: target.sourceKind,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    outcome,
    runState: latestRun?.state ?? null,
    instructionStatus: savedTarget?.instructionStatus ?? "missing",
    runId: latestRun?.id ?? null,
    instructionArtifactId: latestRun?.instructionArtifactId ?? null,
    summary:
      latestRun?.finalSummary ?? latestRun?.manualPrerequisiteSummary ?? null,
  };
}

try {
  for (const [index, target] of pendingTargets.entries()) {
    let result;
    try {
      result = await runOneTarget(target, index);
    } catch (error) {
      result = {
        targetId: target.id,
        label: target.label,
        startingUrl: target.startingUrl,
        sourceKind: target.sourceKind,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        outcome: "unexpected_error",
        runState: null,
        instructionStatus: "missing",
        runId: activeProgress?.runId ?? null,
        summary: error instanceof Error ? error.message : String(error),
      };
    }

    report.results[target.id] = result;
    report.counts = summarizeCounts(report.results);
    report.updatedAt = new Date().toISOString();
    await writeCheckpoint(reportPath, report);
    process.stdout.write(
      `[${index + 1}/${pendingTargets.length}] DONE ${result.outcome} ${result.instructionStatus} ${target.label} ${result.durationMs}ms${result.summary ? ` - ${result.summary}` : ""}\n`,
    );

    if (
      result.outcome === "paused_manual" ||
      result.outcome.startsWith("partial_") ||
      result.outcome === "timed_out" ||
      result.outcome === "unexpected_error"
    ) {
      await closeApp();
    }
  }

  report.completedAt = new Date().toISOString();
  report.updatedAt = report.completedAt;
  report.counts = summarizeCounts(report.results);
  await writeCheckpoint(reportPath, report);
  process.stdout.write(
    `${JSON.stringify({ reportPath, counts: report.counts }, null, 2)}\n`,
  );
} finally {
  await closeApp();
}
