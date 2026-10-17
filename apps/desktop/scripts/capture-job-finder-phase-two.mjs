import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const execFileAsync = promisify(execFile);

const gracefulCloseTimeoutMs = 5_000;
const processTreeExitTimeoutMs = 5_000;
const termExitTimeoutMs = 2_000;
const processTreePollIntervalMs = 100;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const artifactRoot = path.resolve(desktopDir, "test-artifacts", "ui");
const requestedRunLabel =
  process.env.UI_CAPTURE_LABEL ?? "job-finder-phase-two";
const runLabel =
  requestedRunLabel
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "job-finder-phase-two";
const outputDir = path.resolve(artifactRoot, runLabel);
if (path.dirname(outputDir) !== artifactRoot) {
  throw new Error("The UI capture artifact path escaped test-artifacts/ui.");
}
const viewports = [
  { slug: "desktop", width: 1440, height: 920, zoomFactor: 1 },
  { slug: "compact", width: 1280, height: 720, zoomFactor: 1 },
  { slug: "zoom-200", width: 1440, height: 920, zoomFactor: 2 },
];

const routeDefinitions = [
  { route: "/job-finder/home", heading: "Today", label: "Home" },
  { route: "/job-finder/campaigns", heading: "Campaigns", label: "Campaigns" },
  {
    route: "/job-finder/rapid-review",
    heading: "Rapid review",
    label: "Rapid review",
  },
  {
    route: "/job-finder/applications",
    heading: "Applications",
    label: "Applications",
  },
  { route: "/job-finder/analytics", heading: "Outcomes", label: "Analytics" },
  {
    route: "/job-finder/resume-strategies",
    heading: "Resume strategies",
    label: "Resume strategies",
  },
  { route: "/job-finder/companies", heading: "Companies", label: "Companies" },
  {
    route: "/job-finder/safeguards",
    heading: "Safeguards",
    label: "Safeguards",
  },
  { route: "/job-finder/actions", heading: "Action inbox", label: "Needs you" },
];

const report = {
  startedAt: new Date().toISOString(),
  outputDir,
  safety: {
    syntheticCandidateDataOnly: true,
    browserAgentEnabled: false,
    applicationActionsExecuted: null,
    finalSubmissionClicked: null,
    submitAuthorized: null,
    accountCreationAuthorized: null,
    observedSafetyClicks: [],
    demoFilesTracked: [],
    demoFilesRemoved: [],
  },
  runtimeErrors: [],
  captures: [],
  scenarios: {},
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

async function writeReport() {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "capture-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

async function cleanCaptureArtifacts() {
  await mkdir(outputDir, { recursive: true });
  for (const fileName of await readdir(outputDir)) {
    if (!fileName.endsWith(".png")) continue;
    await rm(path.join(outputDir, fileName), { force: true });
  }
}

function hasExited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null;
}

function waitForProcessExit(processHandle, timeoutMs) {
  if (!processHandle || hasExited(processHandle)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      processHandle.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    processHandle.once("exit", onExit);
    timeoutId = setTimeout(() => finish(false), timeoutMs);
    if (hasExited(processHandle)) finish(true);
  });
}

async function readPosixProcessTable() {
  const { stdout } = await execFileAsync(
    "ps",
    ["-axww", "-o", "pid=,ppid=,command="],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
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

async function snapshotOwnedProcessTree(rootPid) {
  if (process.platform === "win32") {
    return [{ pid: rootPid, command: "" }];
  }

  const table = await readPosixProcessTable();
  const byPid = new Map(table.map((row) => [row.pid, row]));
  if (!byPid.has(rootPid)) return [];

  const pending = [rootPid];
  const seen = new Set();
  const owned = [];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row) owned.push({ pid: row.pid, command: row.command });
    for (const child of table) {
      if (child.parentPid === pid) pending.push(child.pid);
    }
  }
  return owned;
}

async function getSurvivingOwnedProcesses(ownedProcesses) {
  if (ownedProcesses.length === 0) return [];
  if (process.platform === "win32") {
    return ownedProcesses.filter((entry) => {
      try {
        process.kill(entry.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  }

  const table = await readPosixProcessTable();
  const byPid = new Map(table.map((row) => [row.pid, row]));
  return ownedProcesses.filter((entry) => {
    const current = byPid.get(entry.pid);
    return current !== undefined && current.command === entry.command;
  });
}

async function waitForProcessTreeExit(ownedProcesses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      if ((await getSurvivingOwnedProcesses(ownedProcesses)).length === 0) {
        return true;
      }
    } catch {
      return false;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, processTreePollIntervalMs),
    );
  }
  return false;
}

async function signalOwnedProcessTree(ownedProcesses, processHandle, signal) {
  if (process.platform === "win32") {
    const args = ["/PID", String(processHandle.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try {
      await execFileAsync("taskkill", args);
    } catch {
      // The owned process tree may have exited between graceful close and fallback.
    }
    return;
  }

  let survivors;
  try {
    survivors = await getSurvivingOwnedProcesses(ownedProcesses);
  } catch {
    survivors = [{ pid: processHandle.pid, command: "" }];
  }
  if (survivors.length === 0 && !hasExited(processHandle)) {
    survivors = [{ pid: processHandle.pid, command: "" }];
  }
  for (const entry of survivors) {
    try {
      process.kill(entry.pid, signal);
    } catch {
      // The owned process may have exited between the table read and signal.
    }
  }
}

async function stopOwnedElectronProcessTree(app) {
  const appProcess = app.process();
  if (!appProcess?.pid) return true;
  const ownedProcesses = await snapshotOwnedProcessTree(appProcess.pid);

  const gracefulClose = Promise.resolve()
    .then(() => app.close())
    .then(
      () => "completed",
      () => "failed",
    );
  const gracefulOutcome = await Promise.race([
    gracefulClose,
    new Promise((resolve) =>
      setTimeout(() => resolve("timed-out"), gracefulCloseTimeoutMs),
    ),
  ]);
  const processExited = await waitForProcessExit(
    appProcess,
    processTreeExitTimeoutMs,
  );
  const treeExited = await waitForProcessTreeExit(
    ownedProcesses,
    processTreeExitTimeoutMs,
  );
  if (gracefulOutcome === "completed" && processExited && treeExited)
    return true;

  await signalOwnedProcessTree(ownedProcesses, appProcess, "SIGTERM");
  const termExited = await waitForProcessExit(appProcess, termExitTimeoutMs);
  const termTreeExited = await waitForProcessTreeExit(
    ownedProcesses,
    termExitTimeoutMs,
  );
  if (!termExited || !termTreeExited) {
    await signalOwnedProcessTree(ownedProcesses, appProcess, "SIGKILL");
    await waitForProcessExit(appProcess, processTreeExitTimeoutMs);
    await waitForProcessTreeExit(ownedProcesses, processTreeExitTimeoutMs);
  }

  const survivors = await getSurvivingOwnedProcesses(ownedProcesses);
  if (survivors.length > 0) {
    throw new Error(
      `Electron teardown left owned processes alive: ${survivors
        .map((entry) => entry.pid)
        .join(", ")}`,
    );
  }
  return true;
}

function workspaceDemoFilePaths(snapshot) {
  return [
    snapshot?.profile?.baseResume?.storagePath,
    ...(snapshot?.resumeExportArtifacts ?? []).map(
      (artifact) => artifact.filePath,
    ),
  ].filter((filePath) => typeof filePath === "string" && filePath.length > 0);
}

function knownDemoFilePaths() {
  const demoDirectory = path.join(os.tmpdir(), "nestor-demo-resume-files");
  return [
    path.join(demoDirectory, "alex-vanguard.pdf"),
    path.join(demoDirectory, "job-ready-resume.pdf"),
    path.join(demoDirectory, "job-consent-queue-resume.pdf"),
  ];
}

async function existingFiles(filePaths) {
  const existing = new Set();
  for (const filePath of filePaths) {
    try {
      await access(filePath);
      existing.add(filePath);
    } catch {
      // A missing path is the safe case for tracking a demo-created file.
    }
  }
  return existing;
}

function installSafetyClickProbe() {
  if (window.__phaseTwoSafetyClickProbeInstalled) return;
  window.__phaseTwoSafetyClickProbeInstalled = true;
  document.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest("button,a,[role=button]")
          : null;
      if (!(target instanceof HTMLElement)) return;
      if (
        target.closest(
          'nav[aria-label="Job Finder sections"], [aria-label="Notifications and actions"]',
        )
      ) {
        return;
      }
      const label =
        target.getAttribute("aria-label") ??
        target.textContent?.replace(/\s+/g, " ").trim() ??
        target.tagName.toLowerCase();
      const finalSubmit =
        /final\s+submit|submit\s+(?:an?\s+)?application|submit\s+form|create\s+account|sign[ -]?up|log(?:in|\s+in)|captcha|mfa|legal\s+consent/i.test(
          label,
        );
      const applicationAction =
        /\b(?:apply|application|prepare\s+(?:an?\s+)?application|external\s+write|start\s+(?:an?\s+)?application)\b/i.test(
          label,
        );
      if (!finalSubmit && !applicationAction) return;
      const record = {
        kind: finalSubmit ? "final-submit" : "application-action",
        label,
        href: target instanceof HTMLAnchorElement ? target.href : null,
        at: new Date().toISOString(),
      };
      window.__phaseTwoRecordSafetyClick?.(record);
    },
    true,
  );
}

async function waitForCondition(check, description, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function getWorkspace(page) {
  return page.evaluate(() => window.nestor.jobFinder.getWorkspace());
}

async function navigate(page, route, expectedHeading) {
  await page.evaluate((nextRoute) => {
    window.location.hash = `#${nextRoute}`;
  }, route);
  await page
    .getByRole("heading", { level: 1, name: expectedHeading })
    .waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(160);
  const definition = routeDefinitions.find((entry) => entry.route === route);
  report.scenarios.routeContext ??= [];
  report.scenarios.routeContext.push({
    route,
    label: definition?.label ?? expectedHeading,
    title: await page.title(),
    hash: await page.evaluate(() => window.location.hash),
  });
}

async function setViewport(page, browserWindow, viewport) {
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  await browserWindow.evaluate((window, zoomFactor) => {
    window.webContents.setZoomFactor(zoomFactor);
  }, viewport.zoomFactor);
  await page.waitForTimeout(240);
}

async function resetScroll(page) {
  await page.evaluate(() => {
    document.querySelector("main")?.scrollTo({ top: 0, left: 0 });
    for (const element of document.querySelectorAll("*")) {
      if (!(element instanceof HTMLElement)) continue;
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY)) {
        element.scrollTo({ top: 0, left: 0 });
      }
    }
  });
}

async function scanLayout(page) {
  return page.evaluate(() => {
    const rendered = (element) => {
      // Browser-disclosure children keep their layout box in some Chromium
      // zoom/layout states even while the <details> is closed. Treat those
      // descendants as unreachable unless they are the summary that opens it.
      const closedDetails = element.closest("details:not([open])");
      if (closedDetails && !element.matches("summary")) return false;
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
    const label = (element) =>
      element.getAttribute("aria-label") ??
      element.getAttribute("title") ??
      element.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ??
      element.tagName.toLowerCase();
    const descriptor = (element) =>
      `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
        element.getAttribute("data-testid")
          ? `[data-testid=${element.getAttribute("data-testid")}]`
          : ""
      }${
        element.getAttribute("aria-label")
          ? `[aria-label=${element.getAttribute("aria-label")}]`
          : ""
      }`;
    const interactive = Array.from(
      document.querySelectorAll(
        "button,a,input,select,textarea,summary,[role=button],[role=checkbox],[role=radio],[tabindex]",
      ),
    ).filter((element) => element instanceof HTMLElement && rendered(element));
    const clippedInteractive = interactive
      .flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const intersects =
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth;
        const scrollableAncestor = (() => {
          let ancestor = element.parentElement;
          while (ancestor) {
            const style = getComputedStyle(ancestor);
            if (
              /(auto|scroll)/.test(style.overflowY) &&
              ancestor.scrollHeight > ancestor.clientHeight + 2
            ) {
              return ancestor;
            }
            ancestor = ancestor.parentElement;
          }
          return null;
        })();
        const verticallyClipped =
          rect.top < -1 || rect.bottom > window.innerHeight + 1;
        const horizontallyClipped =
          rect.left < -1 || rect.right > window.innerWidth + 1;
        if (
          !intersects ||
          (rect.left >= -1 &&
            rect.right <= window.innerWidth + 1 &&
            rect.top >= -1 &&
            rect.bottom <= window.innerHeight + 1)
        ) {
          return [];
        }
        // A long page is expected to place lower cards/controls below the
        // viewport. They remain reachable through the ancestor's scroll
        // container, while fixed and horizontally clipped controls are still
        // release failures.
        if (verticallyClipped && !horizontallyClipped && scrollableAncestor) {
          return [];
        }
        return [
          {
            label: label(element),
            selector: descriptor(element),
            rect: {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom),
            },
          },
        ];
      })
      .slice(0, 20);
    const scrollables = Array.from(document.querySelectorAll("*"))
      .flatMap((element) => {
        if (!(element instanceof HTMLElement) || !rendered(element)) return [];
        const style = getComputedStyle(element);
        if (
          !/(auto|scroll)/.test(style.overflowY) ||
          element.scrollHeight <= element.clientHeight + 2
        ) {
          return [];
        }
        const rect = element.getBoundingClientRect();
        if (
          rect.bottom <= 0 ||
          rect.right <= 0 ||
          rect.top >= window.innerHeight ||
          rect.left >= window.innerWidth
        ) {
          return [];
        }
        return [
          {
            selector: descriptor(element),
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            scrollTop: element.scrollTop,
          },
        ];
      })
      .slice(0, 12);
    const shell = document.querySelector("[data-job-finder-shell]");
    const shellRect = shell?.getBoundingClientRect();
    const shellStyle =
      shell instanceof HTMLElement ? getComputedStyle(shell) : null;
    const shellScrollable =
      shell instanceof HTMLElement &&
      Boolean(shellStyle && /(auto|scroll)/.test(shellStyle.overflowY)) &&
      shell.scrollHeight > shell.clientHeight + 2;
    const shellControls = Array.from(
      document.querySelectorAll(
        'nav[aria-label="Job Finder sections"] button, [aria-label="Notifications and actions"] > button, [aria-label="Notifications and actions"] > details > summary',
      ),
    );
    const shellDestinations = shellControls.map((element) => {
      const rect = element.getBoundingClientRect();
      const horizontal = rect.left >= -1 && rect.right <= window.innerWidth + 1;
      const vertical = rect.top >= -1 && rect.bottom <= window.innerHeight + 1;
      const shellTop =
        shell instanceof HTMLElement && shellRect
          ? rect.top - shellRect.top + shell.scrollTop
          : null;
      const verticallyReachable =
        shellScrollable &&
        shellTop !== null &&
        shellTop >= -1 &&
        shellTop + rect.height <= shell.scrollHeight + 1;
      return {
        label: label(element),
        visible: rendered(element) && horizontal && vertical,
        reachable:
          rendered(element) && horizontal && (vertical || verticallyReachable),
      };
    });
    const main = document.querySelector("main");
    return {
      route: window.location.hash,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentHorizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
      mainHorizontalOverflow:
        main instanceof HTMLElement
          ? Math.max(0, main.scrollWidth - main.clientWidth)
          : null,
      clippedInteractive,
      scrollables,
      shellDestinations,
      hiddenShellDestinations: shellDestinations
        .filter((entry) => !entry.visible)
        .map((entry) => entry.label),
      unreachableShellDestinations: shellDestinations
        .filter((entry) => !entry.reachable)
        .map((entry) => entry.label),
    };
  });
}

async function probeNestedScroll(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("*"))
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 2 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth
        );
      })
      .sort(
        (left, right) =>
          right.clientWidth * right.clientHeight -
          left.clientWidth * left.clientHeight,
      );
    const target = candidates[0];
    if (!(target instanceof HTMLElement)) {
      return { available: false, leaked: false, targetMoved: false };
    }
    const before = candidates.map((element) => element.scrollTop);
    target.scrollTop = 0;
    const start = target.scrollTop;
    target.scrollTop = Math.min(
      target.scrollHeight - target.clientHeight,
      Math.max(16, Math.min(180, target.scrollHeight - target.clientHeight)),
    );
    const after = candidates.map((element) => element.scrollTop);
    const targetMoved = target.scrollTop !== start;
    const leaked = candidates.some(
      (element, index) => element !== target && after[index] !== before[index],
    );
    target.scrollTop = 0;
    return {
      available: true,
      targetMoved,
      leaked,
      target: target.tagName.toLowerCase(),
    };
  });
}

async function capture(page, label, metadata = {}) {
  await resetScroll(page);
  const fileName = `${String(report.captures.length + 1).padStart(3, "0")}-${slugify(label)}.png`;
  await page.screenshot({
    animations: "disabled",
    path: path.join(outputDir, fileName),
  });
  const layout = await scanLayout(page);
  const nestedScroll = await probeNestedScroll(page);
  assert(
    layout.documentHorizontalOverflow === 0 &&
      (layout.mainHorizontalOverflow ?? 0) === 0,
    `${label}: horizontal overflow detected (${layout.documentHorizontalOverflow}/${layout.mainHorizontalOverflow}).`,
  );
  assert(
    layout.clippedInteractive.length === 0,
    `${label}: clipped interactive controls detected.`,
  );
  assert(
    layout.unreachableShellDestinations.length === 0,
    `${label}: unreachable shell destinations: ${layout.unreachableShellDestinations.join(", ")}.`,
  );
  assert(
    !nestedScroll.leaked,
    `${label}: nested scroll leaked to another scroller.`,
  );
  if (nestedScroll.available) {
    assert(
      nestedScroll.targetMoved,
      `${label}: expected the nested scroll target to move.`,
    );
  }
  const entry = {
    id: report.captures.length + 1,
    label,
    fileName,
    ...metadata,
    layout,
    nestedScroll,
  };
  report.captures.push(entry);
  await writeReport();
  return entry;
}

function createRequest(id, jobId, createdAt) {
  return {
    schemaVersion: 1,
    id,
    dedupeKey: `phase-two:${id}`,
    revision: 1,
    kind: "manual_answer",
    state: "pending",
    requirement: "required",
    scope: {
      type: "application",
      runId: `phase-two-run-${jobId}`,
      jobId,
      resultId: null,
      replayCheckpointId: null,
      source: "target_site",
    },
    verification: {
      type: "page_blocker_absent",
      blockerFingerprint: `phase-two-blocker-${id}`,
      expectedPageFingerprint: `phase-two-page-${id}`,
    },
    title: "Manual answer needed for a synthetic application",
    summary:
      "Review the synthetic question and record the user-owned answer before continuing.",
    instructions: ["Complete only the named manual-answer step."],
    actionUrl: "https://jobs.example.test/phase-two/manual-answer",
    displayOrigin: "https://jobs.example.test/",
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
    attemptCount: 0,
    maxAttempts: 3,
    createdAt,
    updatedAt: createdAt,
    openedAt: null,
    resolvedAt: null,
    expiresAt: null,
  };
}

function createPhaseTwoState(snapshot) {
  const state = structuredClone(snapshot);
  const now = "2026-08-17T10:00:00.000Z";
  const templates =
    (snapshot.discoveryJobs?.length
      ? snapshot.discoveryJobs
      : snapshot.reviewQueue?.map((item) => item.job).filter(Boolean)) ?? [];
  assert(
    templates.length > 0,
    "The apply-queue demo did not expose a saved job template.",
  );

  const jobs = Array.from({ length: 6 }, (_, index) => {
    const template = structuredClone(templates[index % templates.length]);
    const ordinal = index + 1;
    return {
      ...template,
      id: `phase_two_job_${ordinal}`,
      sourceJobId: `phase_two_source_${ordinal}`,
      canonicalUrl: `https://jobs.example.test/phase-two/${ordinal}`,
      applicationUrl: `https://jobs.example.test/phase-two/${ordinal}/apply`,
      title: `Phase Two Platform Engineer ${ordinal}`,
      company: ordinal < 4 ? "Northstar Systems" : "Atlas Works",
      status: "ready_for_review",
      summary:
        "Synthetic phase-two listing for deterministic acceptance coverage.",
      description:
        "Synthetic listing content; no external source is opened by this harness.",
    };
  });
  state.savedJobs = jobs;

  const baseCampaign = state.campaigns?.[0];
  assert(baseCampaign, "The apply-queue demo did not expose a campaign.");
  const campaign = {
    ...baseCampaign,
    name: "Phase Two Campaign",
    description:
      "Synthetic campaign covering rules, funnel, schedule, digest, and safeguards.",
    jobIds: jobs.map((job) => job.id),
    rules: [
      {
        id: "phase_two_rule_role",
        kind: "prefer",
        field: "role",
        operator: "contains",
        value: "engineer",
        numericValue: null,
        currency: null,
        enabled: true,
        provenance: {
          source: "user",
          confidence: 1,
          note: "Synthetic acceptance fixture",
          recordedAt: now,
        },
        effect: {
          sampleSize: 0,
          removedCount: 0,
          downgradedCount: 0,
          unknownCount: 0,
          measuredAt: null,
        },
      },
    ],
    schedule: {
      mode: "selected_days",
      enabled: true,
      daysOfWeek: [1, 3, 5],
      localStartTime: "09:30",
      timeZone: "Europe/Budapest",
      pauseWindows: [
        {
          id: "phase_two_pause_window",
          startsAt: "2026-08-20T08:00:00.000Z",
          endsAt: "2026-08-20T09:00:00.000Z",
          reason: "Synthetic maintenance window",
          enabled: true,
        },
      ],
      runFacts: {
        nextRunAt: "2026-08-19T07:30:00.000Z",
        lastRunAt: "2026-08-17T08:30:00.000Z",
        lastRunOutcome: "partial",
        lastRunSummary:
          "Five synthetic listings retained; one source was blocked for review.",
        consecutiveFailures: 0,
      },
    },
    latestDigest: {
      id: "phase_two_digest",
      campaignId: baseCampaign.id,
      discoveryRunId: null,
      generatedAt: now,
      counts: {
        new: 4,
        changed: 1,
        reactivated: 0,
        inactive: 0,
        known: 1,
        skipped: 0,
      },
      failedSources: [
        {
          sourceTargetId:
            baseCampaign.sourceTargetIds?.[0] ?? "phase-two-source-target",
          reason: "Synthetic source requires user review",
          failedAt: now,
          retryable: true,
        },
      ],
      jobIds: jobs.slice(0, 5).map((job) => job.id),
    },
    progress: {
      jobsFound: 6,
      jobsRetained: 5,
      applicationsPrepared: 2,
      applicationsApplied: 0,
      currentBatchCompleted: 2,
      currentBatchTotal: 3,
      blockedCount: 1,
      remainingQueueSize: 4,
      lastRunAt: "2026-08-17T08:30:00.000Z",
      lastUpdatedAt: now,
    },
    history: [
      ...(baseCampaign.history ?? []),
      {
        id: "phase_two_history",
        campaignId: baseCampaign.id,
        kind: "discovery_run",
        occurredAt: now,
        summary: "Synthetic phase-two discovery run",
        discoveryRunId: null,
      },
    ],
    applicationPolicy: {
      ...baseCampaign.applicationPolicy,
      requireReviewBeforeExternalWrite: true,
      finalSubmitAuthorized: false,
    },
  };
  state.campaigns = [campaign];
  state.activeCampaignId = campaign.id;
  state.campaignNotifications = [
    {
      id: "phase_two_notification_digest",
      campaignId: campaign.id,
      kind: "digest_ready",
      title: "Phase-two digest is ready",
      body: "Review the synthetic campaign digest before any preparation step.",
      createdAt: now,
      readAt: null,
      unread: true,
      jobId: null,
      sourceTargetId: null,
    },
    {
      id: "phase_two_notification_blocked",
      campaignId: campaign.id,
      kind: "blocked_work",
      title: "One synthetic item needs you",
      body: "A manual answer is grouped for review; no external action is authorized.",
      createdAt: "2026-08-17T09:00:00.000Z",
      readAt: "2026-08-17T09:30:00.000Z",
      unread: false,
      jobId: jobs[0].id,
      sourceTargetId: null,
    },
  ];

  const applicationRecords = jobs.slice(0, 3).map((job, index) => ({
    id: `phase_two_application_${index + 1}`,
    jobId: job.id,
    title: job.title,
    company: job.company,
    status: "ready_for_review",
    lastActionLabel: "Synthetic review recorded",
    nextActionLabel:
      index === 0 ? "Track employer outcome" : "Review application",
    lastUpdatedAt: now,
    lastAttemptState: null,
    questionSummary: {},
    latestBlocker: null,
    consentSummary: {},
    replaySummary: {},
    events: [],
    crm: {
      revision: 0,
      stage: index === 0 ? "interview" : "applied",
      customStageId: null,
      stageChangedAt: now,
      tags: ["phase-two"],
      events: [],
      contacts: [],
      reminders: [],
      interviews: [],
      notes: [],
      attachments: [],
      compensation: {},
      lastEmployerActivityAt: null,
      appliedAt: now,
    },
  }));
  state.applicationRecords = applicationRecords;
  state.applicationAttempts = [];

  const requestOne = createRequest(
    "phase_two_manual_answer_1",
    jobs[0].id,
    now,
  );
  const requestTwo = createRequest(
    "phase_two_manual_answer_2",
    jobs[1].id,
    now,
  );
  state.userActionRequests = [requestOne, requestTwo];
  state.intelligence = {
    ...(state.intelligence ?? {}),
    rapidReviewLogs: [
      {
        campaignId: campaign.id,
        entries: [
          {
            id: "phase_two_review_1",
            campaignId: campaign.id,
            jobId: jobs[0].id,
            kind: "inspect",
            revision: 1,
            reason: "Synthetic prior review",
            createdAt: now,
            updatedAt: now,
            undo: null,
          },
        ],
      },
    ],
    groupedDecisions: [
      {
        id: "phase_two_grouped_answer",
        groupKey: "phase-two:work-authorization",
        kind: "manual_answer",
        blockerKind: "manual_answer",
        authority: "manual_answer",
        reuseScope: "reusable",
        requestId: requestOne.id,
        applicationRecordId: applicationRecords[0].id,
        jobId: jobs[0].id,
        resultId: null,
        questionId: "phase_two_question_work_authorization",
        expectedRevision: 1,
        expectedQuestionRevision: 1,
        expectedAnswerRevision: 0,
        fingerprints: {
          questionMeaning: "1".repeat(64),
          answerPolicy: "2".repeat(64),
        },
        answer: { type: "text", value: "Synthetic answer retained for review" },
        approval: "pending",
        approvedAt: null,
        conflict: {
          status: "none",
          detectedAt: null,
          resolvedAt: null,
          conflictingDecisionId: null,
          summary: null,
        },
        snooze: null,
        lineage: [
          {
            requestId: requestOne.id,
            jobId: jobs[0].id,
            applicationRecordId: applicationRecords[0].id,
            resultId: null,
            questionId: "phase_two_question_work_authorization",
            answerRecordId: null,
            expectedRequestRevision: 1,
            expectedQuestionRevision: 1,
            expectedAnswerRevision: 0,
            appliedAt: null,
          },
          {
            requestId: requestTwo.id,
            jobId: jobs[1].id,
            applicationRecordId: applicationRecords[1].id,
            resultId: null,
            questionId: "phase_two_question_work_authorization",
            answerRecordId: null,
            expectedRequestRevision: 1,
            expectedQuestionRevision: 1,
            expectedAnswerRevision: 0,
            appliedAt: null,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    outcomeEvents: [
      {
        id: "phase_two_outcome_interview",
        outcome: "interview",
        applicationRecordId: applicationRecords[0].id,
        jobId: jobs[0].id,
        campaignId: campaign.id,
        source: "synthetic",
        company: jobs[0].company,
        jobTitle: jobs[0].title,
        resumeStrategyId: "phase_two_strategy",
        occurredAt: now,
        note: "Synthetic interview outcome",
        userControlled: true,
      },
      {
        id: "phase_two_outcome_rejected",
        outcome: "rejected",
        applicationRecordId: applicationRecords[1].id,
        jobId: jobs[1].id,
        campaignId: campaign.id,
        source: "synthetic",
        company: jobs[1].company,
        jobTitle: jobs[1].title,
        resumeStrategyId: null,
        occurredAt: "2026-08-16T10:00:00.000Z",
        note: "Synthetic rejected outcome",
        userControlled: true,
      },
    ],
    outcomeAnalytics: null,
    resumeStrategies: [
      {
        id: "phase_two_strategy",
        name: "Platform engineering focus",
        roleFamily: "Platform engineering",
        baseResumeDocumentId: "resume_1",
        templateId: "classic_ats",
        headlinePolicy: "role_family_template",
        skillsPolicy: "role_family_expanded",
        coveragePolicy: "role_family_recommended",
        tailoringStrength: "balanced",
        evidenceBoundaries: {
          allowExactClaims: true,
          allowParaphrasedClaims: false,
          maxEvidenceRefsPerBullet: 3,
          requireVerifierPass: true,
        },
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    resumeStrategySelections: [
      {
        id: "phase_two_strategy_selection",
        campaignId: campaign.id,
        jobId: jobs[0].id,
        strategyId: "phase_two_strategy",
        source: "campaign_default",
        reason: "Synthetic campaign default",
        selectedAt: now,
      },
    ],
    companies: [
      {
        id: "phase_two_company_northstar",
        canonicalName: "Northstar Systems",
        aliases: [
          {
            alias: "Northstar Systems, Inc.",
            normalized: "northstar systems inc",
            confidence: 0.96,
          },
        ],
        domains: [
          { domain: "northstar.example.test", primary: true, verifiedAt: null },
        ],
        preference: "review",
        preferenceReason: "Synthetic merge review",
        mergeReviewCandidates: [
          {
            candidateCompanyId: "phase_two_company_northstar_alias",
            reason: "Matching synthetic domain and alias",
            decision: "pending",
            decidedAt: null,
            requiresUserDecision: true,
          },
        ],
        contacts: [],
        notes: [
          {
            id: "phase_two_company_note",
            body: "Synthetic company note for phase-two CRM coverage.",
            createdAt: now,
            updatedAt: now,
          },
        ],
        salaryOfferEvidence: [
          {
            id: "phase_two_salary_evidence",
            kind: "listed_salary",
            summary: "Synthetic listed salary",
            currency: "USD",
            minimum: 120000,
            maximum: 150000,
            period: "year",
            offerStatus: "none",
            jobId: jobs[0].id,
            applicationRecordId: applicationRecords[0].id,
            source: "synthetic",
            recordedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        ],
        sourceHistory: [],
        jobIds: jobs.slice(0, 3).map((job) => job.id),
        applicationRecordIds: applicationRecords.map((record) => record.id),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "phase_two_company_northstar_alias",
        canonicalName: "Northstar Systems Europe",
        aliases: [],
        domains: [
          { domain: "northstar.example.org", primary: true, verifiedAt: null },
        ],
        preference: "neutral",
        preferenceReason: null,
        mergeReviewCandidates: [],
        contacts: [],
        notes: [],
        salaryOfferEvidence: [],
        sourceHistory: [],
        jobIds: [],
        applicationRecordIds: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    safeguards: {
      companyApplicationCaps: [
        {
          id: "phase_two_cap",
          companyId: "phase_two_company_northstar",
          maxApplicationsPerWindow: 2,
          windowDays: 30,
          currentWindowCount: 2,
          limitReached: true,
          windowStartedAt: "2026-08-01T00:00:00.000Z",
          explanation: "Synthetic company cap reached.",
          recoveryGuidance: "Review the cap evidence before continuing.",
        },
      ],
      simultaneousApplicationConflicts: [
        {
          id: "phase_two_conflict",
          applicationRecordId: applicationRecords[0].id,
          conflictingApplicationRecordId: applicationRecords[1].id,
          status: "detected",
          explanation: "Synthetic applications overlap in timing.",
          recoveryGuidance: "Resolve the duplicate review before preparation.",
        },
      ],
      listingSignals: [
        {
          id: "phase_two_listing_signal",
          jobId: jobs[2].id,
          signal: "stale",
          detail: "Synthetic listing has not changed recently.",
          detectedAt: now,
          confidence: 0.88,
          provenance: "system",
          explanation: "Synthetic stale signal.",
          recoveryGuidance:
            "Recheck the listing before preparing an application.",
        },
      ],
      abnormalFailurePauses: [],
      preparedBatchSampleReviews: [
        {
          id: "phase_two_batch_review",
          batchId: "phase_two_batch",
          preparedCount: 4,
          sampleCount: 1,
          reviewedCount: 0,
          requiredSampleRatio: 0.2,
          reviewCompleted: false,
          explanation: "Synthetic batch sample is awaiting review.",
          recoveryGuidance: "Review the required sample before continuing.",
        },
      ],
      contradictoryAnswerDetections: [],
      safeguardDismissals: [],
      updatedAt: now,
    },
    updatedAt: now,
  };
  state.settings = {
    ...state.settings,
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
    applicationCrm: {
      noResponseAutomation: { enabled: true, afterDays: 14 },
      customStages: [],
    },
  };
  state.profileSetupState = {
    ...state.profileSetupState,
    status: "completed",
    currentStep: "ready_check",
    completedAt: state.profileSetupState.completedAt ?? now,
    lastResumedAt: now,
  };
  state.activityControl = { paused: false, pausedAt: null, reason: null };
  return state;
}

async function run() {
  await mkdir(outputDir, { recursive: true });
  await cleanCaptureArtifacts();
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-phase-two-"),
  );
  const demoFilesCreatedByHarness = new Set();
  const demoFilesExistedBeforeHarness = new Set();
  const observedSafetyClicks = [];
  let app;

  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_BROWSER_AGENT: "0",
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_TEST_SYSTEM_THEME: "dark",
        NESTOR_AI_API_KEY: "",
        NESTOR_AI_VISION_API_KEY: "",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });
    const page = await app.firstWindow();
    await page.exposeFunction("__phaseTwoRecordSafetyClick", (record) => {
      observedSafetyClicks.push(record);
    });
    await page.addInitScript(installSafetyClickProbe);
    await page.evaluate(installSafetyClickProbe);
    page.on("pageerror", (error) => {
      report.runtimeErrors.push({ type: "pageerror", message: error.message });
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        report.runtimeErrors.push({ type: "console", message: message.text() });
      }
    });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 30_000 },
    );
    const browserWindow = await app.browserWindow(page);
    await page.evaluate(() =>
      window.nestor.jobFinder.test.setSystemThemeOverride("dark"),
    );
    await setViewport(page, browserWindow, viewports[0]);

    const preDemoWorkspace = await getWorkspace(page);
    for (const filePath of await existingFiles([
      ...workspaceDemoFilePaths(preDemoWorkspace),
      ...knownDemoFilePaths(),
    ])) {
      demoFilesExistedBeforeHarness.add(filePath);
    }
    const baseSnapshot = await page.evaluate(() =>
      window.nestor.jobFinder.test.loadApplyQueueDemo(),
    );
    for (const filePath of workspaceDemoFilePaths(baseSnapshot)) {
      if (!demoFilesExistedBeforeHarness.has(filePath)) {
        demoFilesCreatedByHarness.add(filePath);
      }
    }
    report.safety.demoFilesTracked = [...demoFilesCreatedByHarness];
    const seededState = createPhaseTwoState(baseSnapshot);
    await page.evaluate(
      (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
      seededState,
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.getWorkspace),
      undefined,
      { timeout: 30_000 },
    );
    report.scenarios.seed = {
      campaignId: seededState.activeCampaignId,
      jobCount: seededState.savedJobs.length,
      applicationCount: seededState.applicationRecords.length,
      groupedDecisionCount: seededState.intelligence.groupedDecisions.length,
    };

    const campaignId = seededState.activeCampaignId;
    const jobIds = seededState.savedJobs.map((job) => job.id);
    const applicationRecordId = seededState.applicationRecords[0].id;
    const companyId = "phase_two_company_northstar";
    const mergeCandidateId = "phase_two_company_northstar_alias";

    await navigate(page, "/job-finder/home", "Today");
    await page
      .getByRole("heading", { name: "Campaign notifications" })
      .waitFor();
    await capture(page, "home-notifications-before-read", {
      surface: "home-notifications",
    });
    const markAllRead = page.getByRole("button", { name: /Mark all read/i });
    await markAllRead.waitFor({ state: "visible", timeout: 10_000 });
    await markAllRead.click();
    await waitForCondition(
      async () =>
        (await getWorkspace(page)).campaignNotifications.every(
          (item) => !item.unread,
        ),
      "campaign notifications to persist as read",
    );
    await capture(page, "home-notifications-persisted", {
      surface: "home-notifications",
    });
    report.scenarios.home = {
      notificationsRead: (await getWorkspace(page)).campaignNotifications.every(
        (item) => !item.unread,
      ),
    };

    await navigate(page, "/job-finder/campaigns", "Campaigns");
    await page.getByText("Phase Two Campaign", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Rules", exact: true })
      .first()
      .click();
    await page
      .getByText(/Truthful funnel \(current retained jobs only\)/)
      .waitFor();
    await page.getByText(/Latest digest/).waitFor();
    const funnel = await page.evaluate(
      (id) => window.nestor.jobFinder.projectCampaignRuleFunnel(id),
      campaignId,
    );
    assert(
      funnel.funnel.sampleSize >= 0,
      "Campaign funnel did not return a persisted sample.",
    );
    await capture(page, "campaigns-rules-funnel-schedule-digest", {
      surface: "campaigns",
    });
    report.scenarios.campaigns = {
      ruleCount: funnel.rules.length,
      funnelSampleSize: funnel.funnel.sampleSize,
      scheduleEnabled: (await getWorkspace(page)).campaigns.find(
        (item) => item.id === campaignId,
      ).schedule.enabled,
      digestId: (await getWorkspace(page)).campaigns.find(
        (item) => item.id === campaignId,
      ).latestDigest?.id,
    };

    await navigate(page, "/job-finder/rapid-review", "Rapid review");
    const compareInputs = page.locator(
      'input[type="checkbox"][aria-label^="Select "]',
    );
    assert(
      (await compareInputs.count()) >= 2,
      "Rapid review did not expose comparison selections.",
    );
    await compareInputs.nth(0).check();
    await compareInputs.nth(1).check();
    await page
      .getByRole("heading", { name: "Compare selected jobs" })
      .waitFor();
    await page.evaluate(
      (input) => window.nestor.jobFinder.mutateRapidReview(input),
      {
        type: "decide",
        campaignId,
        jobIds: [jobIds[1]],
        decision: "shortlist",
        expectedRevisions: { [jobIds[1]]: null },
        reason: "Synthetic phase-two decision",
      },
    );
    await waitForCondition(
      async () =>
        (await getWorkspace(page)).intelligence.rapidReviewLogs[0].entries.some(
          (entry) => entry.jobId === jobIds[1] && entry.kind === "shortlist",
        ),
      "rapid review decision to persist",
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await navigate(page, "/job-finder/rapid-review", "Rapid review");
    const undo = page
      .getByRole("button", { name: "Undo last decision", exact: true })
      .first();
    await undo.waitFor({ state: "visible", timeout: 10_000 });
    await undo.click();
    await waitForCondition(
      async () =>
        (await getWorkspace(page)).intelligence.rapidReviewLogs[0].entries.some(
          (entry) => entry.undo !== null,
        ),
      "rapid review undo to persist",
    );
    await capture(page, "rapid-review-undo-comparison", {
      surface: "rapid-review",
    });
    report.scenarios.rapidReview = {
      selectedForComparison: 2,
      undoPersisted: (
        await getWorkspace(page)
      ).intelligence.rapidReviewLogs[0].entries.some(
        (entry) => entry.undo !== null,
      ),
    };

    await page.evaluate(
      (input) => window.nestor.jobFinder.mutateApplicationCrm(input),
      {
        applicationRecordId,
        expectedRevision: 0,
        mutation: {
          type: "set_stage",
          stage: "interview",
          customStageId: null,
          note: "Synthetic CRM stage update",
        },
      },
    );
    await page.evaluate(
      (input) => window.nestor.jobFinder.recordOutcome(input),
      {
        jobId: jobIds[0],
        campaignId,
        applicationRecordId,
        outcome: "interview",
        resumeStrategyId: "phase_two_strategy",
        note: "Synthetic phase-two outcome",
      },
    );
    await waitForCondition(
      async () =>
        (await getWorkspace(page)).intelligence.outcomeEvents.some(
          (event) =>
            event.applicationRecordId === applicationRecordId &&
            event.outcome === "interview",
        ),
      "application outcome to persist",
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await navigate(page, "/job-finder/applications", "Applications");
    const tracker = page.getByRole("button", { name: "Tracker", exact: true });
    await tracker.waitFor({ state: "visible", timeout: 10_000 });
    await tracker.click();
    await page.getByRole("heading", { name: "Application CRM" }).waitFor();
    await capture(page, "applications-crm-outcome", {
      surface: "applications",
    });
    const crmWorkspace = await getWorkspace(page);
    report.scenarios.applications = {
      crmStage: crmWorkspace.applicationRecords.find(
        (record) => record.id === applicationRecordId,
      ).crm?.stage,
      outcomeRecorded: crmWorkspace.intelligence.outcomeEvents.some(
        (event) =>
          event.applicationRecordId === applicationRecordId &&
          event.outcome === "interview",
      ),
    };

    await navigate(page, "/job-finder/analytics", "Outcomes");
    await page
      .getByText(/outcome events? in scope/i)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await capture(page, "analytics-outcomes", { surface: "analytics" });

    await page.evaluate(
      (input) =>
        window.nestor.jobFinder.setCampaignResumeStrategyDefault(input),
      { campaignId, strategyId: "phase_two_strategy" },
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await navigate(page, "/job-finder/resume-strategies", "Resume strategies");
    await page
      .getByRole("heading", { name: "Platform engineering focus", exact: true })
      .waitFor();
    await page.getByText("Campaign defaults", { exact: true }).waitFor();
    await capture(page, "resume-strategies-default", {
      surface: "resume-strategies",
    });
    report.scenarios.resumeStrategies = {
      defaultStrategyId: (await getWorkspace(page)).campaigns.find(
        (item) => item.id === campaignId,
      ).applicationPolicy.defaultResumeStrategyId,
    };

    await navigate(page, "/job-finder/companies", "Companies");
    await page
      .getByTestId("company-card-phase_two_company_northstar")
      .getByRole("heading", { name: "Northstar Systems", exact: true })
      .waitFor();
    await page.getByText("Duplicate employer review", { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await capture(page, "companies-merge-review", { surface: "companies" });
    await page.evaluate(
      (input) => window.nestor.jobFinder.setCompanyPreference(input),
      { companyId, preference: "prefer" },
    );
    await page.evaluate(
      (input) => window.nestor.jobFinder.reviewCompanyMerge(input),
      { companyId, candidateId: mergeCandidateId, decision: "rejected" },
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await navigate(
      page,
      `/job-finder/companies/${companyId}`,
      "Northstar Systems",
    );
    await page
      .getByText(/No ambiguous identities are waiting for this employer\./i)
      .waitFor({
        state: "visible",
        timeout: 10_000,
      });
    await capture(page, "company-detail-after-merge-review", {
      surface: "company-detail",
    });
    const companyWorkspace = await getWorkspace(page);
    const company = companyWorkspace.intelligence.companies.find(
      (item) => item.id === companyId,
    );
    report.scenarios.companies = {
      preference: company?.preference,
      mergeDecision: company?.mergeReviewCandidates.find(
        (item) => item.candidateCompanyId === mergeCandidateId,
      )?.decision,
    };

    await navigate(page, "/job-finder/safeguards", "Safeguards");
    await page.getByRole("tablist", { name: "Safeguard categories" }).waitFor();
    await capture(page, "safeguards-before-recovery", {
      surface: "safeguards",
    });
    const dismiss = page.getByRole("button", {
      name: "Dismiss cap",
      exact: true,
    });
    await dismiss.waitFor({ state: "visible", timeout: 10_000 });
    await dismiss.click();
    await waitForCondition(
      async () =>
        (await getWorkspace(page)).intelligence.safeguards.safeguardDismissals
          .length > 0,
      "safeguard dismissal to persist",
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await navigate(page, "/job-finder/safeguards", "Safeguards");
    const restore = page.getByRole("button", {
      name: "Restore cap (retry)",
      exact: true,
    });
    await restore.waitFor({ state: "visible", timeout: 10_000 });
    await restore.click();
    await waitForCondition(
      async () =>
        (await getWorkspace(page)).intelligence.safeguards.safeguardDismissals
          .length === 0,
      "safeguard restoration to persist",
    );
    await capture(page, "safeguards-after-recovery", { surface: "safeguards" });
    report.scenarios.safeguards = {
      dismissalsAfterRecovery: (await getWorkspace(page)).intelligence
        .safeguards.safeguardDismissals.length,
    };

    await navigate(page, "/job-finder/actions", "Action inbox");
    await page
      .getByRole("heading", { name: "Reusable answers", exact: true })
      .waitFor();
    const groupedAnswerCard = page.getByRole("article", {
      name: "Reusable answer phase_two_grouped_answer",
      exact: true,
    });
    await groupedAnswerCard.waitFor({ state: "visible", timeout: 10_000 });
    assert(
      await groupedAnswerCard
        .getByRole("heading", { name: "Reuse one answer across 2 jobs" })
        .isVisible(),
      "Needs you: the seeded grouped answer did not render its two-job scope.",
    );
    assert(
      await groupedAnswerCard
        .getByText("2 pending application questions across 2 jobs", {
          exact: true,
        })
        .isVisible(),
      "Needs you: the seeded grouped answer did not render both application questions.",
    );
    assert(
      (await page
        .getByRole("heading", { name: "Applications", exact: true })
        .count()) === 0,
      "Needs you: grouped application questions were duplicated in the ordinary Applications group.",
    );
    await capture(page, "needs-you-grouped-actions", { surface: "needs-you" });
    report.scenarios.needsYou = {
      groupedDecisionCount: (await getWorkspace(page)).intelligence
        .groupedDecisions.length,
      pendingManualAnswerCount: (
        await getWorkspace(page)
      ).userActionRequests.filter(
        (request) =>
          request.kind === "manual_answer" && request.state === "pending",
      ).length,
    };

    const representativeRoutes = routeDefinitions;
    for (const viewport of viewports) {
      await setViewport(page, browserWindow, viewport);
      if (viewport.slug === "zoom-200") {
        const moreButton = page.getByRole("button", {
          name: /^More/,
          exact: false,
        });
        await moreButton.waitFor({ state: "visible", timeout: 10_000 });
        await moreButton.click();
        const moreMenu = page.getByRole("navigation", {
          name: "More",
          exact: true,
        });
        await moreMenu.waitFor({ state: "visible", timeout: 10_000 });
        const moreMenuLayout = await moreMenu.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const items = Array.from(element.querySelectorAll("button")).map(
            (item) => {
              const itemRect = item.getBoundingClientRect();
              return {
                label: item.textContent?.replace(/\s+/g, " ").trim() ?? "",
                visible:
                  itemRect.left >= 0 &&
                  itemRect.right <= window.innerWidth + 1 &&
                  itemRect.top >= 0 &&
                  itemRect.bottom <= window.innerHeight + 1,
              };
            },
          );
          return {
            visible:
              rect.left >= 0 &&
              rect.right <= window.innerWidth + 1 &&
              rect.top >= 0 &&
              rect.bottom <= window.innerHeight + 1,
            items,
          };
        });
        assert(
          moreMenuLayout.visible &&
            moreMenuLayout.items.length > 0 &&
            moreMenuLayout.items.every((item) => item.visible),
          "200% More menu is clipped or has unreachable items.",
        );
        await capture(page, "zoom-200-more-menu", {
          surface: "shell-navigation",
          viewport,
          menuItemCount: moreMenuLayout.items.length,
        });
        await page.keyboard.press("Escape");
        await moreMenu.waitFor({ state: "hidden", timeout: 10_000 });
      }
      for (const definition of representativeRoutes) {
        await navigate(page, definition.route, definition.heading);
        await capture(page, `${viewport.slug}-${definition.label}`, {
          viewport,
          route: definition.route,
          representative: true,
        });
      }
    }

    const finalWorkspace = await getWorkspace(page);
    const submitAuthorityFlags = finalWorkspace.userActionRequests.map(
      (request) => request.submitAuthorized,
    );
    const accountCreationAuthorityFlags = finalWorkspace.userActionRequests.map(
      (request) => request.accountCreationAuthorized,
    );
    report.safety.observedSafetyClicks = observedSafetyClicks;
    report.safety.applicationActionsExecuted = observedSafetyClicks.some(
      (click) => click.kind === "application-action",
    );
    report.safety.finalSubmissionClicked = observedSafetyClicks.some(
      (click) => click.kind === "final-submit",
    );
    report.safety.submitAuthorized = submitAuthorityFlags.some(Boolean);
    report.safety.accountCreationAuthorized =
      accountCreationAuthorityFlags.some(Boolean);
    assert(
      !report.safety.applicationActionsExecuted,
      `Unexpected application-action click observed: ${JSON.stringify(observedSafetyClicks)}`,
    );
    assert(
      !report.safety.finalSubmissionClicked,
      `Unexpected final-submit click observed: ${JSON.stringify(observedSafetyClicks)}`,
    );
    assert(
      finalWorkspace.userActionRequests.every(
        (request) =>
          request.submitAuthorized === false &&
          request.accountCreationAuthorized === false,
      ),
      "A persisted user action unexpectedly carries submit or account-creation authority.",
    );
    assert(
      finalWorkspace.campaigns.every(
        (campaignEntry) =>
          campaignEntry.applicationPolicy.finalSubmitAuthorized === false &&
          campaignEntry.applicationPolicy.requireReviewBeforeExternalWrite ===
            true,
      ),
      "A persisted campaign unexpectedly carries final-submit authority.",
    );
    assert(
      report.runtimeErrors.length === 0,
      `Renderer errors detected: ${JSON.stringify(report.runtimeErrors)}`,
    );
    report.summary = {
      captureCount: report.captures.length,
      runtimeErrorCount: report.runtimeErrors.length,
      surfaces: [
        ...new Set(
          report.captures.map((entry) => entry.surface).filter(Boolean),
        ),
      ],
      viewports: viewports.map((viewport) => viewport.slug),
    };
    report.completedAt = new Date().toISOString();
    await writeReport();
    process.stdout.write(
      `Saved ${report.captures.length} phase-two captures to ${outputDir}\n`,
    );
  } finally {
    let electronTeardownVerified = !app;
    let electronTeardownFailure = null;
    if (app) {
      try {
        await stopOwnedElectronProcessTree(app);
        electronTeardownVerified = true;
      } catch (error) {
        electronTeardownVerified = false;
        electronTeardownFailure =
          error instanceof Error ? error.message : String(error);
      }
    }
    if (electronTeardownVerified) {
      for (const filePath of demoFilesCreatedByHarness) {
        await rm(filePath, { force: true });
        report.safety.demoFilesRemoved.push(filePath);
      }
      await rm(userDataDirectory, { recursive: true, force: true });
    }
    report.cleanup = {
      electronTeardownVerified,
      userDataDirectoryRemoved: electronTeardownVerified,
      ...(electronTeardownFailure ? { error: electronTeardownFailure } : {}),
    };
    try {
      await writeReport();
    } catch {
      // Preserve the original run failure if artifact reporting is unavailable.
    }
  }
}

run().catch(async (error) => {
  report.failedAt = new Date().toISOString();
  report.failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  await writeReport();
  process.stderr.write(`${report.failure}\n`);
  process.exitCode = 1;
});
