import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const baseSnapshotPath = path.resolve(
  desktopDir,
  "test-fixtures",
  "job-finder",
  "profile-baseline-workspace.json",
);
const runLabel = process.env.UI_CAPTURE_LABEL ?? "action-inbox";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);
const createdAt = "2026-07-30T08:00:00.000Z";

const captures = [
  { slug: "desktop", width: 1440, height: 920, zoomFactor: 1 },
  { slug: "narrow", width: 900, height: 920, zoomFactor: 1 },
  { slug: "zoom-200", width: 1440, height: 1800, zoomFactor: 2 },
];

function createRequest(input) {
  return {
    schemaVersion: 1,
    id: input.id,
    dedupeKey: `capture:${input.id}`,
    revision: 1,
    kind: "login",
    state: "pending",
    requirement: "required",
    scope: input.scope,
    verification: input.verification,
    title: input.title,
    summary: input.summary,
    instructions: input.instructions,
    actionUrl: input.actionUrl,
    displayOrigin: new URL(input.actionUrl).origin + "/",
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

function createEvent(request) {
  return {
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
  };
}

async function writeJson(fileName, value) {
  await writeFile(
    path.join(outputDir, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function captureGroup(page, capture, groupName, fileName) {
  const heading = page.getByRole("heading", { level: 2, name: groupName });
  await heading.evaluate((element) => {
    element.scrollIntoView({ block: "start" });
    window.scrollTo({ top: 0 });
  });
  await heading.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(180);
  await page.screenshot({
    animations: "disabled",
    path: path.join(outputDir, fileName),
  });

  return page.evaluate((headingText) => {
    const groupHeading = Array.from(document.querySelectorAll("h2")).find(
      (entry) => entry.textContent?.trim() === headingText,
    );
    const group = groupHeading?.closest("section");
    const main = document.querySelector("main");
    const buttons = group
      ? Array.from(group.querySelectorAll("button")).map((button) => ({
          label: button.textContent?.replace(/\s+/g, " ").trim() ?? "",
          visible: (() => {
            const bounds = button.getBoundingClientRect();
            return Boolean(
              button.offsetWidth > 0 &&
              button.offsetHeight > 0 &&
              getComputedStyle(button).visibility !== "hidden" &&
              bounds.left >= 0 &&
              bounds.right <= window.innerWidth &&
              bounds.top >= 0 &&
              bounds.bottom <= window.innerHeight,
            );
          })(),
        }))
      : [];
    const shellNavigation = document.querySelector(
      'nav[aria-label="Job Finder sections"]',
    );
    const actionControls = document.querySelector(
      '[aria-label="Notifications and actions"]',
    );
    const shellControls = [
      ...(shellNavigation
        ? Array.from(shellNavigation.querySelectorAll("button"))
        : []),
      ...(actionControls
        ? Array.from(actionControls.querySelectorAll("button, summary"))
        : []),
    ];
    const shellDestinations = shellControls.map((control) => {
      const bounds = control.getBoundingClientRect();
      return {
        label: control.textContent?.replace(/\s+/g, " ").trim() ?? "",
        visible: Boolean(
          control instanceof HTMLElement &&
          control.offsetWidth > 0 &&
          control.offsetHeight > 0 &&
          getComputedStyle(control).visibility !== "hidden" &&
          bounds.left >= 0 &&
          bounds.right <= window.innerWidth &&
          bounds.top >= 0 &&
          bounds.bottom <= window.innerHeight,
        ),
      };
    });

    return {
      headingVisible: Boolean(groupHeading),
      actionButtons: buttons,
      shellDestinations,
      shellNavigationHorizontalOverflow:
        shellNavigation instanceof HTMLElement
          ? Math.max(
              0,
              shellNavigation.scrollWidth - shellNavigation.clientWidth,
            )
          : null,
      mainHorizontalOverflow:
        main instanceof HTMLElement
          ? Math.max(0, main.scrollWidth - main.clientWidth)
          : null,
      documentHorizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    };
  }, groupName);
}

async function runCapture() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-action-inbox-"),
  );
  let app;

  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_BROWSER_AGENT: "0",
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_TEST_SYSTEM_THEME:
          process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const browserWindow = await app.browserWindow(page);
    const baseState = JSON.parse(await readFile(baseSnapshotPath, "utf8"));
    const discoveryRequest = createRequest({
      id: "capture_source_login",
      scope: {
        type: "discovery_source",
        targetId: "target_linkedin_default",
        source: "target_site",
        sourceDebugRunId: "capture_source_debug_run",
        sourceDebugAttemptId: "capture_source_debug_attempt",
      },
      verification: {
        type: "source_access",
        targetId: "target_linkedin_default",
        blockerFingerprint: "capture-source-login-v1",
        expectedOrigin: "https://www.linkedin.com/",
      },
      title: "Sign in to Primary target",
      summary:
        "Sign in to the saved job source before its next search can continue.",
      instructions: [
        "Complete sign-in in the managed browser without sharing credentials with Job Finder.",
        "Return here and choose Done only after the browser step is complete.",
      ],
      actionUrl: "https://www.linkedin.com/jobs/search/",
    });
    const applicationRequest = createRequest({
      id: "capture_application_login",
      scope: {
        type: "application",
        runId: "capture_apply_run",
        jobId: "capture_product_designer_job",
        resultId: "capture_apply_result",
        replayCheckpointId: "capture_replay_checkpoint",
        source: "target_site",
      },
      verification: {
        type: "page_blocker_absent",
        blockerFingerprint: "capture-application-login-v1",
        expectedPageFingerprint: "capture-application-page-v1",
      },
      title: "Finish sign-in for Senior Product Designer application",
      summary:
        "The application is parked at an account gate. Sign in in the managed browser, then ask Job Finder to verify the same application checkpoint.",
      instructions: [
        "Use an existing account in the managed browser. Do not enter credentials in Job Finder.",
        "Do not submit the application. Return here once the account gate is complete.",
      ],
      actionUrl: "https://jobs.example.com/application/sign-in",
    });
    const state = {
      ...baseState,
      userActionRequests: [applicationRequest, discoveryRequest],
      userActionEvents: [
        createEvent(applicationRequest),
        createEvent(discoveryRequest),
      ],
    };

    await page.evaluate(
      async ({ theme, workspaceState }) => {
        if (!window.nestor.jobFinder.test) {
          throw new Error("Desktop test API is unavailable in the renderer.");
        }
        await window.nestor.jobFinder.test.setSystemThemeOverride(theme);
        await window.nestor.jobFinder.test.resetWorkspaceState(workspaceState);
      },
      {
        theme: process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark",
        workspaceState: state,
      },
    );

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const actionNavigation = page
      .getByRole("button", { name: /^Needs you/ })
      .first();
    await actionNavigation.waitFor({ state: "visible", timeout: 15000 });
    await actionNavigation.evaluate((element) => element.click());
    await page
      .getByRole("heading", { level: 1, name: "Action inbox" })
      .waitFor({ timeout: 15000 });

    const report = {
      capturedAt: new Date().toISOString(),
      baseSnapshotPath,
      outputDir,
      requestCount: 2,
      safety: {
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      },
      captures: {},
    };

    for (const capture of captures) {
      await browserWindow.evaluate((window, factor) => {
        window.webContents.setZoomFactor(factor);
      }, capture.zoomFactor);
      await page.setViewportSize({
        width: capture.width,
        height: capture.height,
      });
      await page.waitForTimeout(250);

      const applicationFile = `${capture.slug}-applications.png`;
      const sourceFile = `${capture.slug}-job-sources.png`;
      const application = await captureGroup(
        page,
        capture,
        "Applications",
        applicationFile,
      );
      const source = await captureGroup(
        page,
        capture,
        "Job sources",
        sourceFile,
      );

      const allButtonsPresent = [application, source].every((group) => {
        const labels = group.actionButtons.map((button) =>
          button.label.toLowerCase(),
        );
        return ["open", "signed in", "skip", "cancel"].every((label) =>
          labels.some((candidate) => candidate.includes(label)),
        );
      });
      const expectedShellDestinations = [
        "Profile",
        "Find jobs",
        "Shortlisted",
        "Applications",
        "Settings",
        "Task center",
        "Needs you",
      ];
      const allShellDestinationsVisible = [application, source].every((group) =>
        expectedShellDestinations.every((label) =>
          group.shellDestinations.some(
            (destination) =>
              destination.visible && destination.label.includes(label),
          ),
        ),
      );
      const noHorizontalOverflow = [application, source].every(
        (group) =>
          group.mainHorizontalOverflow === 0 &&
          group.documentHorizontalOverflow === 0 &&
          group.shellNavigationHorizontalOverflow === 0,
      );

      report.captures[capture.slug] = {
        ...capture,
        files: { application: applicationFile, source: sourceFile },
        application,
        source,
        allButtonsPresent,
        allShellDestinationsVisible,
        noHorizontalOverflow,
      };
      await writeJson("capture-report.json", report);

      if (
        !allButtonsPresent ||
        !allShellDestinationsVisible ||
        !noHorizontalOverflow
      ) {
        throw new Error(
          `Action Inbox visual acceptance failed for ${capture.slug}.`,
        );
      }
    }

    await writeJson("capture-report.json", report);
    process.stdout.write(`Saved Action Inbox captures to ${outputDir}\n`);
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // Preserve the original failure.
      }
    }
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

runCapture().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
