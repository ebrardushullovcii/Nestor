/* eslint-env node, browser */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const baselineWorkspacePath = path.join(
  desktopDir,
  "test-fixtures",
  "job-finder",
  "profile-baseline-workspace.json",
);
const outputDir = path.join(
  desktopDir,
  "test-artifacts",
  "ui",
  "job-finder-route-zoom-diagnostic-20260810",
);

const createdAt = "2026-08-10T00:00:00.000Z";

function createActionRequest() {
  return {
    schemaVersion: 1,
    id: "zoom_diagnostic_login",
    dedupeKey: "zoom-diagnostic:login",
    revision: 1,
    kind: "login",
    state: "pending",
    requirement: "required",
    scope: {
      type: "discovery_source",
      targetId: "target_linkedin_default",
      source: "target_site",
      sourceDebugRunId: "zoom_diagnostic_run",
      sourceDebugAttemptId: "zoom_diagnostic_attempt",
    },
    verification: {
      type: "source_access",
      targetId: "target_linkedin_default",
      blockerFingerprint: "zoom-diagnostic-login-v1",
      expectedOrigin: "https://www.linkedin.com/",
    },
    title: "Sign in to the synthetic source",
    summary: "Synthetic login request used only for route zoom diagnostics.",
    instructions: [
      "Do not enter credentials or perform any external action.",
      "Do not submit an application or create an account.",
    ],
    actionUrl: "https://www.linkedin.com/jobs/search/",
    displayOrigin: "https://www.linkedin.com/",
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

async function snapshot(label, page, browserWindow) {
  const [main, renderer] = await Promise.all([
    browserWindow.evaluate((window) => ({
      zoomFactor: window.webContents.getZoomFactor(),
      zoomLevel: window.webContents.getZoomLevel(),
      url: window.webContents.getURL(),
      navigationEvents: globalThis.__nestorRouteZoomEvents ?? [],
    })),
    page.evaluate(() => ({
      hash: window.location.hash,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      visualViewportScale: window.visualViewport?.scale ?? null,
      documentZoom: getComputedStyle(document.documentElement).zoom,
      bodyZoom: getComputedStyle(document.body).zoom,
    })),
  ]);
  return { label, main, renderer };
}

async function run() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-route-zoom-"),
  );
  let app;
  const trace = [];

  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_BROWSER_AGENT: "0",
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_TEST_SYSTEM_THEME: "dark",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 30_000 },
    );
    const browserWindow = await app.browserWindow(page);
    await browserWindow.evaluate((window) => {
      globalThis.__nestorRouteZoomEvents = [];
      window.webContents.on("did-start-navigation", (details) => {
        globalThis.__nestorRouteZoomEvents.push({
          type: "did-start-navigation",
          targetUrl: details.url,
          isMainFrame: details.isMainFrame,
          isSameDocument: details.isSameDocument,
          zoomFactor: window.webContents.getZoomFactor(),
        });
      });
      window.webContents.on(
        "did-navigate-in-page",
        (_event, targetUrl, isMainFrame) => {
          globalThis.__nestorRouteZoomEvents.push({
            type: "did-navigate-in-page",
            targetUrl,
            isMainFrame,
            zoomFactor: window.webContents.getZoomFactor(),
          });
        },
      );
      window.webContents.setZoomFactor(1);
    });
    trace.push(await snapshot("fresh-at-one", page, browserWindow));

    const baseline = JSON.parse(await readFile(baselineWorkspacePath, "utf8"));
    const request = createActionRequest();
    await page.evaluate(
      async (state) =>
        window.nestor.jobFinder.test.resetWorkspaceState(state),
      {
        ...baseline,
        profileSetupState: {
          ...baseline.profileSetupState,
          status: "completed",
          currentStep: "ready_check",
          completedAt: createdAt,
          lastResumedAt: createdAt,
        },
        userActionRequests: [request],
        userActionEvents: [
          {
            id: `${request.id}:created`,
            requestId: request.id,
            operation: "created",
            previousRevision: 0,
            resultingRevision: 1,
            previousState: "pending",
            resultingState: "pending",
            occurredAt: createdAt,
            credentialsPolicy: "browser_only",
            submitAuthorized: false,
            accountCreationAuthorized: false,
          },
        ],
      },
    );
    trace.push(await snapshot("after-reset", page, browserWindow));

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page
      .getByRole("heading", { level: 1, name: "Your profile" })
      .waitFor({ state: "visible", timeout: 20_000 });
    trace.push(await snapshot("after-reload", page, browserWindow));

    const needsYou = page.getByRole("button", { name: /Needs you/i });
    await needsYou.click();
    trace.push(
      await snapshot("immediate-after-needs-you-click", page, browserWindow),
    );
    await page
      .getByRole("heading", { level: 1, name: "Action inbox" })
      .waitFor({ state: "visible", timeout: 20_000 });
    trace.push(await snapshot("after-action-heading", page, browserWindow));
    await page.waitForTimeout(500);
    trace.push(await snapshot("after-action-settle", page, browserWindow));

    const profile = page.getByRole("button", { name: /^Profile$/i });
    let profilePointerBlocked = false;
    try {
      await profile.click({ timeout: 3_000 });
    } catch {
      profilePointerBlocked = true;
      await page.screenshot({
        animations: "disabled",
        path: path.join(outputDir, "profile-navigation-pointer-blocked.png"),
      });
      await profile.evaluate((element) => element.click());
    }
    await page
      .getByRole("heading", { level: 1, name: "Your profile" })
      .waitFor({ state: "visible", timeout: 20_000 });
    trace.push({
      ...(await snapshot("after-profile-click", page, browserWindow)),
      profilePointerBlocked,
    });

    await browserWindow.evaluate((window) => {
      window.webContents.setZoomFactor(1.5);
    });
    trace.push(await snapshot("profile-at-150", page, browserWindow));
    await needsYou.click();
    await page
      .getByRole("heading", { level: 1, name: "Action inbox" })
      .waitFor({ state: "visible", timeout: 20_000 });
    trace.push(
      await snapshot("actions-from-profile-at-150", page, browserWindow),
    );

    process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
  } finally {
    if (trace.length > 0) {
      process.stdout.write(`TRACE_ON_EXIT=${JSON.stringify(trace)}\n`);
    }
    if (app) {
      await app.close().catch(() => undefined);
    }
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
