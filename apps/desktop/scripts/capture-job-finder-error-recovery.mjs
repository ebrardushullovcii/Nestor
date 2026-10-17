import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import {
  ACCEPTANCE_VERSION,
  acceptanceEnvironment,
  assertFileRenderer,
  assertPrepareOnly,
  assertViewportEvidence,
  attachProcessOutput,
  cleanupDirectory,
  createOwnedProcessLedger,
  ensureFreshOutputDir,
  finalizeProcessOutput,
  loadAcceptanceContext,
  makeIsolatedUserDataDirectory,
  installPrepareOnlySafetyProbe,
  PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
  resolvePrimaryRunError,
  resolveStartupBrowserWindow,
  screenshotMetadata,
  stopAndVerifyOwnedElectron,
  verifyAcceptanceArtifacts,
} from "./release-acceptance-harness.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const acceptance = loadAcceptanceContext("error-recovery");
const outputDir = acceptance.outputDir;
const REQUIRED_SCENARIO_COMPLETION_IDS = Object.freeze([
  "error-preview-1440",
  "error-preview-recovered-native125",
  "error-preview-recovered-minimum",
]);
const LIVE_PREVIEW_IFRAME_SELECTOR = 'iframe[title="Live resume preview"]';
const MINIMUM_VISIBLE_PREVIEW_CSS_PX = 96;
const PREVIEW_LAYOUT_SETTLE_TIMEOUT_MS = 5_000;
const PREVIEW_LAYOUT_SETTLE_RETRY_MS = 100;
const PREVIEW_SAMPLE_TIMEOUT_MS = 2_000;
const report = {
  startedAt: new Date().toISOString(),
  outputDir,
  acceptance: {
    version: ACCEPTANCE_VERSION,
    manifestPath: acceptance.manifestPath,
    runDir: acceptance.runDir,
    sourceFingerprint: acceptance.manifest.source?.afterBuild?.digest ?? null,
    buildArtifactFingerprint: acceptance.manifest.artifacts?.digest ?? null,
    seedDigest: acceptance.seedDigest,
  },
  pass: false,
  captures: [],
  scenarios: {},
  requiredScenarioCompletionIds: [...REQUIRED_SCENARIO_COMPLETION_IDS],
  scenarioCompletionIds: [],
  runtimeErrors: [],
  mainProcess: { pid: null, stdout: "", stderr: "" },
  processOwnership: {
    trackedProcesses: [],
    verifications: [],
    leftoverPids: [],
    verified: false,
  },
  safety: {
    syntheticTestDataOnly: true,
    browserAgentEnabled: false,
    applicationActionsExecuted: null,
    finalSubmissionClicked: null,
    submitAuthorized: null,
    accountCreationAuthorized: null,
    prepareOnlyVerified: false,
    observedSafetyEvents: [],
    isolatedUserDataDir: null,
    cleanedUp: false,
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function describeTeardownFailure(error) {
  return error instanceof Error ? error.message : String(error);
}

async function writeReport() {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

function completeScenario(scenarioId) {
  assert(
    REQUIRED_SCENARIO_COMPLETION_IDS.includes(scenarioId),
    `Unknown error/recovery scenario completion ID: ${scenarioId}`,
  );
  if (!report.scenarioCompletionIds.includes(scenarioId))
    report.scenarioCompletionIds.push(scenarioId);
}

async function inspectCaptureViewport(page) {
  const layout = await page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const documentOverflow = Math.max(
      0,
      document.documentElement.scrollWidth - viewport.width,
    );
    const visibleInteractive = Array.from(
      document.querySelectorAll(
        'button,a,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],iframe,[data-resume-workspace-scroll-region]',
      ),
    ).filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    const clipped = visibleInteractive.flatMap((element) => {
      const rect = element.getBoundingClientRect();
      const intersects =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < viewport.height &&
        rect.left < viewport.width;
      if (
        !intersects ||
        (rect.left >= -1 &&
          rect.right <= viewport.width + 1 &&
          rect.top >= -1 &&
          rect.bottom <= viewport.height + 1)
      ) {
        return [];
      }
      let scrollableAncestor = element.parentElement;
      while (scrollableAncestor) {
        const style = getComputedStyle(scrollableAncestor);
        if (
          /(auto|scroll)/.test(style.overflowY) &&
          scrollableAncestor.scrollHeight > scrollableAncestor.clientHeight + 2
        ) {
          break;
        }
        scrollableAncestor = scrollableAncestor.parentElement;
      }
      const verticallyClipped =
        rect.top < -1 || rect.bottom > viewport.height + 1;
      const horizontallyClipped =
        rect.left < -1 || rect.right > viewport.width + 1;
      if (verticallyClipped && !horizontallyClipped && scrollableAncestor) {
        return [];
      }
      return [
        {
          tag: element.tagName.toLowerCase(),
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ??
            null,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        },
      ];
    });
    return {
      viewport,
      documentOverflow,
      clipped,
    };
  });
  const failures = [];
  if (layout.documentOverflow > 0)
    failures.push(`document horizontal overflow ${layout.documentOverflow}`);
  if (layout.clipped.length > 0)
    failures.push(
      `clipped interactive surfaces ${JSON.stringify(layout.clipped)}`,
    );
  return {
    insideViewport: failures.length === 0,
    noClip: failures.length === 0,
    failures,
  };
}

function evaluatePreviewContentEvidence(facts, minimumVisibleCssPx) {
  const rect = facts?.rect ?? null;
  const viewport = facts?.viewport ?? null;
  const visibleBounds = (() => {
    const finiteRect =
      rect !== null &&
      [rect.left, rect.top, rect.right, rect.bottom].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      );
    const finiteViewport =
      viewport !== null &&
      [viewport.width, viewport.height].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      );
    if (!finiteRect || !finiteViewport) return null;
    return {
      visibleHeight: Math.max(
        0,
        Math.min(viewport.height, rect.bottom) - Math.max(0, rect.top),
      ),
      visibleWidth: Math.max(
        0,
        Math.min(viewport.width, rect.right) - Math.max(0, rect.left),
      ),
    };
  })();
  const horizontallyContained =
    visibleBounds !== null &&
    rect.left >= -1 &&
    rect.right <= viewport.width + 1;
  const renderedContentHeight =
    typeof facts?.renderedContentHeight === "number" &&
    Number.isFinite(facts.renderedContentHeight)
      ? facts.renderedContentHeight
      : null;
  const contentElementCount = Number.isInteger(facts?.contentElementCount)
    ? facts.contentElementCount
    : 0;
  const layoutStableAcrossAnimationFrames =
    facts?.layoutStableAcrossAnimationFrames === true;
  const failures = [];
  if (facts?.found !== true) {
    failures.push("recovered live preview iframe was not found");
  } else {
    if (!layoutStableAcrossAnimationFrames)
      failures.push(
        "preview geometry did not settle across two animation frames",
      );
    if (facts.displayVisible !== true)
      failures.push("recovered live preview iframe is hidden");
    if (facts.boxRendered !== true)
      failures.push("recovered live preview iframe has no rendered box");
    if (visibleBounds === null)
      failures.push("preview rect/viewport were not measurable");
    else {
      if (visibleBounds.visibleHeight < minimumVisibleCssPx)
        failures.push(
          `only ${visibleBounds.visibleHeight}px of the recovered preview intersects the CSS viewport; required >= ${minimumVisibleCssPx}px`,
        );
      if (!horizontallyContained)
        failures.push(
          `preview rect ${JSON.stringify(rect)} is not horizontally contained in viewport ${JSON.stringify(viewport)}`,
        );
    }
    if (renderedContentHeight === null || renderedContentHeight <= 0)
      failures.push(
        "same-origin preview document exposes no positive rendered content height",
      );
    if (contentElementCount <= 0)
      failures.push("preview document body has no rendered elements");
  }
  return {
    found: facts?.found === true,
    rect,
    viewport,
    visibleWidth: visibleBounds?.visibleWidth ?? 0,
    visibleHeight: visibleBounds?.visibleHeight ?? 0,
    horizontallyContained,
    renderedContentHeight,
    contentElementCount,
    minimumVisibleCssPx,
    layoutStableAcrossAnimationFrames,
    failures,
    pass: failures.length === 0,
  };
}

function withinPreviewSampleBudget(samplePromise, timeoutMs) {
  let sampleTimer = undefined;
  return Promise.race([
    samplePromise,
    new Promise((_, reject) => {
      sampleTimer = setTimeout(() => {
        reject(
          new Error(
            `recovered preview two-animation-frame sample did not settle within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(sampleTimer);
  });
}

function sampleRecoveredPreviewFacts(page) {
  return page.evaluate(
    (selector) =>
      new Promise((resolve) => {
        const readFacts = () => {
          const iframe = document.querySelector(selector);
          if (!(iframe instanceof HTMLIFrameElement)) return { found: false };
          const style = getComputedStyle(iframe);
          const rect = iframe.getBoundingClientRect();
          const frameDocument = iframe.contentDocument;
          return {
            found: true,
            displayVisible:
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number.parseFloat(style.opacity || "1") !== 0,
            boxRendered: rect.width > 0 && rect.height > 0,
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
            },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            renderedContentHeight:
              frameDocument?.documentElement?.scrollHeight ?? null,
            contentElementCount: frameDocument?.body?.childElementCount ?? 0,
          };
        };
        requestAnimationFrame(() => {
          const firstFrame = readFacts();
          requestAnimationFrame(() => {
            const secondFrame = readFacts();
            resolve({
              ...secondFrame,
              layoutStableAcrossAnimationFrames:
                JSON.stringify(firstFrame) === JSON.stringify(secondFrame),
            });
          });
        });
      }),
    LIVE_PREVIEW_IFRAME_SELECTOR,
  );
}

async function collectPreviewContentEvidence(page) {
  await page
    .locator(LIVE_PREVIEW_IFRAME_SELECTOR)
    .first()
    .scrollIntoViewIfNeeded();
  const settleDeadline = Date.now() + PREVIEW_LAYOUT_SETTLE_TIMEOUT_MS;
  let facts = null;
  let lastSampleError = null;
  for (;;) {
    try {
      facts = await withinPreviewSampleBudget(
        sampleRecoveredPreviewFacts(page),
        PREVIEW_SAMPLE_TIMEOUT_MS,
      );
      if (facts.layoutStableAcrossAnimationFrames === true) break;
      lastSampleError = null;
    } catch (error) {
      facts = null;
      lastSampleError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= settleDeadline) break;
    await page.waitForTimeout(PREVIEW_LAYOUT_SETTLE_RETRY_MS);
  }
  const evidence = evaluatePreviewContentEvidence(
    facts ?? { found: false },
    MINIMUM_VISIBLE_PREVIEW_CSS_PX,
  );
  const failures =
    lastSampleError === null
      ? evidence.failures
      : [
          ...evidence.failures,
          `bounded recovered-preview sample failed: ${lastSampleError}`,
        ];
  return {
    selector: LIVE_PREVIEW_IFRAME_SELECTOR,
    scrolledIntoView: true,
    ...evidence,
    failures,
    pass: failures.length === 0,
  };
}

async function capture(
  page,
  browserWindow,
  { label, scenario, scenarioId, viewport },
) {
  const fileName = `${String(report.captures.length + 1).padStart(2, "0")}-${label}.png`;
  const fullPath = path.join(outputDir, fileName);
  const previewContentEvidence =
    scenario === "recovery" ? await collectPreviewContentEvidence(page) : null;
  await page.screenshot({ path: fullPath, animations: "disabled" });
  const evidence = await screenshotMetadata(page, browserWindow, fullPath, {
    viewport,
    seedDigest: acceptance.seedDigest,
  });
  assertViewportEvidence(evidence.viewport, viewport);
  const inspection = await inspectCaptureViewport(page);
  if (evidence.clickablePointEvidence.pass !== true) {
    inspection.failures.push(
      `interactive controls have no unobscured clickable point: ${JSON.stringify(evidence.clickablePointEvidence.failures)}`,
    );
    inspection.insideViewport = false;
    inspection.noClip = false;
  }
  if (previewContentEvidence && previewContentEvidence.pass !== true) {
    inspection.failures.push(
      `recovered live preview content evidence failed: ${JSON.stringify(previewContentEvidence.failures)}`,
    );
    inspection.insideViewport = false;
    inspection.noClip = false;
  }
  const entry = {
    label,
    scenario,
    path: fullPath,
    route: evidence.route,
    seedDigest: evidence.seedDigest,
    viewportMetadata: evidence.viewport,
    screenshot: evidence.screenshot,
    clickablePointEvidence: evidence.clickablePointEvidence,
    previewContentEvidence,
    ...inspection,
    pass: inspection.failures.length === 0,
    scenarioId,
    capturedAt: new Date().toISOString(),
  };
  report.captures.push(entry);
  await writeReport();
  assert(
    entry.pass === true,
    `Error/recovery capture failed: ${JSON.stringify(entry)}`,
  );
  completeScenario(scenarioId);
  await writeReport();
  return entry;
}

async function run() {
  await ensureFreshOutputDir(outputDir);
  await verifyAcceptanceArtifacts(acceptance);
  const userDataDirectory = await makeIsolatedUserDataDirectory(
    "nestor-job-finder-error-recovery-",
  );
  report.safety.isolatedUserDataDir = userDataDirectory;
  let app = null;
  let processOutputState = null;
  let scenarioSucceeded = false;
  let primaryScenarioError = null;
  let postTeardownFailure = null;
  const ownedProcesses = createOwnedProcessLedger();
  const observedSafetyEvents = [];
  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: acceptanceEnvironment({
        NESTOR_USER_DATA_DIR: userDataDirectory,
      }),
    });
    processOutputState = attachProcessOutput(app, report);
    const page = await app.firstWindow();
    await page.exposeFunction("__jobFinderAcceptanceSafetyEvents", (record) => {
      observedSafetyEvents.push(record);
    });
    await page.addInitScript(installPrepareOnlySafetyProbe);
    await page.evaluate(installPrepareOnlySafetyProbe);
    page.on("pageerror", (error) =>
      report.runtimeErrors.push({ type: "pageerror", message: error.message }),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        report.runtimeErrors.push({ type: "console", message: message.text() });
    });
    await page.waitForLoadState("domcontentloaded");
    await assertFileRenderer(page);
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 15_000 },
    );
    await page.evaluate(() =>
      window.nestor.jobFinder.test.setSystemThemeOverride("dark"),
    );
    const browserWindow = await resolveStartupBrowserWindow(app, page);
    const baseSnapshot = await page.evaluate(async () => {
      await window.nestor.jobFinder.test.setResumePreviewMode("fail_once");
      return window.nestor.jobFinder.test.loadResumeWorkspaceDemo();
    });
    const jobId = baseSnapshot.reviewQueue?.[0]?.jobId;
    assert(
      typeof jobId === "string" && jobId.length > 0,
      "Error/recovery scenario has no synthetic shortlisted job.",
    );
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await assertFileRenderer(page);
    await page.waitForSelector("[data-job-finder-shell]", { timeout: 20_000 });
    await page.evaluate(() =>
      window.nestor.jobFinder.test.setResumePreviewMode("fail_once"),
    );
    await page.setViewportSize({ width: 1440, height: 920 });
    await browserWindow.evaluate((win) => win.webContents.setZoomFactor(1));
    await page.evaluate((nextRoute) => {
      window.location.hash = `#${nextRoute}`;
    }, `/job-finder/review-queue/${jobId}/resume`);
    await page
      .locator("p:visible")
      .filter({ hasText: /^Resume preview$/ })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await page
      .locator(":is(h1,h2,h3,h4,h5,h6):visible")
      .filter({ hasText: "Preview unavailable" })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    const previewEditor = page
      .locator("[data-resume-workspace-scroll-region]:visible")
      .first();
    assert(
      (await previewEditor.count()) > 0,
      "Preview failure removed the resume editing surface.",
    );
    const errorCapture = await capture(page, browserWindow, {
      label: "preview-error-1440",
      scenario: "error",
      scenarioId: "error-preview-1440",
      viewport: {
        slug: "desktop",
        width: 1440,
        height: 920,
        zoomFactor: 1,
      },
    });
    report.scenarios.previewError = {
      scenarioId: errorCapture.scenarioId,
      pass: errorCapture.pass,
      editorRemainsAvailable: true,
      viewport: "desktop",
    };
    await page
      .locator("button:visible")
      .filter({ hasText: "Refresh preview" })
      .first()
      .click();
    await page
      .locator('iframe[title="Live resume preview"]:visible')
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.setViewportSize({ width: 1440, height: 920 });
    await browserWindow.evaluate((win) => win.webContents.setZoomFactor(1.25));
    await page.waitForTimeout(250);
    await capture(page, browserWindow, {
      label: "preview-recovered-native125",
      scenario: "recovery",
      scenarioId: "error-preview-recovered-native125",
      viewport: {
        slug: "native-125",
        width: 1440,
        height: 920,
        zoomFactor: 1.25,
      },
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await browserWindow.evaluate((win) => win.webContents.setZoomFactor(1));
    await page.waitForTimeout(250);
    const recoveryCapture = await capture(page, browserWindow, {
      label: "preview-recovered-minimum-width",
      scenario: "recovery",
      scenarioId: "error-preview-recovered-minimum",
      viewport: { slug: "minimum", width: 1024, height: 768, zoomFactor: 1 },
    });
    report.scenarios.previewRecovery = {
      scenarioId: recoveryCapture.scenarioId,
      pass: recoveryCapture.pass,
      refreshAction: "Refresh preview",
      viewport: "minimum",
    };
    const finalWorkspace = await page.evaluate(() =>
      window.nestor.jobFinder.getWorkspace(),
    );
    report.safety.observedSafetyEvents = observedSafetyEvents;
    const requests = finalWorkspace.userActionRequests;
    report.safety.submitAuthorized = requests.some(
      (request) => request.submitAuthorized === true,
    );
    report.safety.accountCreationAuthorized = requests.some(
      (request) => request.accountCreationAuthorized === true,
    );
    report.safety.applicationActionsExecuted = observedSafetyEvents.length > 0;
    report.safety.finalSubmissionClicked = observedSafetyEvents.some((event) =>
      /submit|application|apply|account|sign[ -]?in/i.test(event.label ?? ""),
    );
    report.safety.authoritativePersistedFacts = assertPrepareOnly(
      finalWorkspace,
      observedSafetyEvents,
    );
    report.safety.prepareOnlyVerified = true;
    assert(
      report.safety.applicationActionsExecuted === false &&
        report.safety.finalSubmissionClicked === false &&
        report.safety.submitAuthorized === false &&
        report.safety.accountCreationAuthorized === false &&
        observedSafetyEvents.length === 0,
      `Error/recovery safety completion was not prepare-only: ${JSON.stringify(report.safety)}`,
    );
    assert(
      report.requiredScenarioCompletionIds.length > 0 &&
        report.scenarioCompletionIds.length > 0 &&
        report.requiredScenarioCompletionIds.every((scenarioId) =>
          report.scenarioCompletionIds.includes(scenarioId),
        ),
      `Error/recovery acceptance did not complete required scenarios: ${JSON.stringify({ required: report.requiredScenarioCompletionIds, completed: report.scenarioCompletionIds })}`,
    );
    assert(
      report.runtimeErrors.length === 0,
      `Runtime errors detected: ${JSON.stringify(report.runtimeErrors)}`,
    );
    report.summary = {
      pass: false,
      errorStateCaptured:
        report.scenarioCompletionIds.includes("error-preview-1440"),
      recoveryStateCaptured: [
        "error-preview-recovered-native125",
        "error-preview-recovered-minimum",
      ].every((scenarioId) =>
        report.scenarioCompletionIds.includes(scenarioId),
      ),
      screenshotCount: report.captures.length,
      runtimeErrorCount: report.runtimeErrors.length,
    };
    scenarioSucceeded = true;
    await writeReport();
  } catch (error) {
    primaryScenarioError = error;
  } finally {
    let finalizationError = null;
    let ownershipError = null;
    if (app) {
      try {
        const verification = await stopAndVerifyOwnedElectron(
          app,
          ownedProcesses,
          "error-recovery",
        );
        report.processOwnership.verifications.push(verification);
      } catch (error) {
        ownershipError = error;
      }
    }
    report.processOwnership.trackedProcesses = ownedProcesses.entries();
    report.processOwnership.leftoverPids =
      report.processOwnership.verifications.flatMap(
        (verification) => verification.leftoverPids,
      );
    report.processOwnership.verified =
      !ownershipError &&
      report.processOwnership.trackedProcesses.length > 0 &&
      report.processOwnership.leftoverPids.length === 0;
    if (processOutputState) {
      try {
        finalizeProcessOutput(processOutputState, report, {
          acceptedStderrPatterns: [
            PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
            {
              name: "expected-preview-render-failure",
              pattern:
                /Error occurred in handler for 'job-finder:preview-resume-draft': Error: Preview rendering failed in desktop test mode\.\r?\n(?: {4}at .+\r?\n)+/g,
            },
          ],
        });
      } catch (error) {
        finalizationError = error;
      }
    }
    let cleanupError = null;
    try {
      cleanupError = await cleanupDirectory(userDataDirectory);
    } catch (error) {
      cleanupError = error;
    }
    report.safety.cleanedUp = !cleanupError;
    if (cleanupError) report.safety.cleanupError = String(cleanupError);
    const secondaryTeardownFailures = [
      ...(ownershipError
        ? [`owned-process teardown: ${describeTeardownFailure(ownershipError)}`]
        : []),
      ...(cleanupError
        ? [
            `isolated user-data cleanup: ${describeTeardownFailure(cleanupError)}`,
          ]
        : []),
    ];
    report.teardownSecondaryFailures = secondaryTeardownFailures;
    if (
      scenarioSucceeded &&
      !finalizationError &&
      !ownershipError &&
      !cleanupError
    ) {
      report.pass = true;
      report.summary.pass = true;
      report.completedAt = new Date().toISOString();
    }
    await writeReport();
    const teardownFailure = resolvePrimaryRunError(
      primaryScenarioError,
      finalizationError,
    );
    if (teardownFailure && secondaryTeardownFailures.length > 0)
      teardownFailure.secondaryTeardownFailures = [
        ...secondaryTeardownFailures,
      ];
    postTeardownFailure =
      teardownFailure ??
      ownershipError ??
      (cleanupError
        ? new Error(
            `Unable to clean isolated user data directory: ${cleanupError}`,
          )
        : null);
  }
  if (postTeardownFailure) throw postTeardownFailure;
}

run().catch(async (error) => {
  report.failedAt = new Date().toISOString();
  report.failure =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  report.pass = false;
  delete report.completedAt;
  report.summary = { ...(report.summary ?? {}), pass: false };
  try {
    await writeReport();
  } catch (writeError) {
    process.stderr.write(
      `Unable to persist the failed error/recovery report: ${describeTeardownFailure(writeError)}\n`,
    );
  }
  process.stderr.write(`${report.failure}\n`);
  process.exitCode = 1;
});
