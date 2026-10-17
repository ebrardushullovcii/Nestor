/* eslint-env node, browser */

/**
 * Native-zoom shell sweep: reproduces the Job Finder compact-header layout with
 * real Electron webContents zoom (the same setZoomFactor path the app's own
 * zoom shortcuts use), not CSS root zoom. Captures 1024x768 and 1440x920 at
 * 100/125/150/200% and records header geometry, overlap candidates, horizontal
 * overflow, and More-menu reachability at compact widths.
 *
 * Usage (after `pnpm --filter @nestor/desktop build`):
 *   node ./scripts/capture-shell-zoom-sweep.mjs
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const runLabel =
  process.env.UI_CAPTURE_LABEL ?? "shell-native-zoom-sweep-20260823";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);
const baselineWorkspacePath = path.join(
  desktopDir,
  "test-fixtures",
  "job-finder",
  "profile-baseline-workspace.json",
);

const viewports = [
  { slug: "1024x768", width: 1024, height: 768, zoomFactor: 1 },
  { slug: "1024x768", width: 1024, height: 768, zoomFactor: 1.25 },
  { slug: "1024x768", width: 1024, height: 768, zoomFactor: 1.5 },
  { slug: "1024x768", width: 1024, height: 768, zoomFactor: 2 },
  { slug: "1440x920", width: 1440, height: 920, zoomFactor: 1 },
  { slug: "1440x920", width: 1440, height: 920, zoomFactor: 1.25 },
  { slug: "1440x920", width: 1440, height: 920, zoomFactor: 1.5 },
  { slug: "1440x920", width: 1440, height: 920, zoomFactor: 2 },
];

function summarizeRect(rect) {
  if (!rect) return null;
  return {
    x: Math.round(rect.x * 10) / 10,
    y: Math.round(rect.y * 10) / 10,
    width: Math.round(rect.width * 10) / 10,
    height: Math.round(rect.height * 10) / 10,
    right: Math.round(rect.right * 10) / 10,
    bottom: Math.round(rect.bottom * 10) / 10,
  };
}

async function probeLayout(page) {
  return page.evaluate(() => {
    const rect = (element) => element?.getBoundingClientRect() ?? null;
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 0 &&
        box.height > 0
      );
    };
    const header = document.querySelector("[data-job-finder-shell-header]");
    const headerGrid = header?.firstElementChild ?? null;
    const brand = document.querySelector("[data-desktop-brand]");
    const moduleNav = document.querySelector(
      "nav[data-desktop-module-navigation]",
    );
    const moduleStrip = moduleNav?.firstElementChild ?? null;
    const compactNav = document.querySelector(
      'nav[aria-label="Job Finder sections"]:not([data-desktop-module-navigation])',
    );
    const compactStrip = compactNav?.firstElementChild ?? null;
    const moreButton = compactNav?.querySelector('button[aria-label^="More"]');
    const notificationGroup = document.querySelector(
      'div[aria-label="Notifications and actions"]',
    );
    const taskCenter = notificationGroup?.querySelector("summary") ?? null;
    const needsYou = notificationGroup?.querySelector(
      'button[aria-label^="Needs you"]',
    );
    const windowControls = document.querySelector(
      'div[role="group"][aria-label="Window controls"]',
    );
    const sidebar = document.querySelector("[data-job-finder-sidebar]");
    const content = document.querySelector("[data-job-finder-shell-content]");
    const main = document.querySelector("[data-job-finder-shell-content] main");
    const html = document.documentElement;

    const key = (name, element) => ({
      name,
      present: Boolean(element),
      visible: visible(element),
      rect: summarize(element, rect(element)),
      display: element ? getComputedStyle(element).display : null,
    });

    function summarize(name, box) {
      if (!box) return null;
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    }

    const elements = [
      key("header", header),
      key("header-grid", headerGrid),
      key("brand", brand),
      key("module-nav", moduleNav),
      key("module-strip", moduleStrip),
      key("compact-nav", compactNav),
      key("compact-strip", compactStrip),
      key("more-button", moreButton),
      key("notification-group", notificationGroup),
      key("task-center-summary", taskCenter),
      key("needs-you-button", needsYou),
      key("window-controls", windowControls),
      key("sidebar", sidebar),
      key("content", content),
      key("main", main),
    ];

    const hitTest = (name, element) => {
      if (!element) return { name, hit: null };
      if (!visible(element)) return { name, hit: null };
      const box = element.getBoundingClientRect();
      const probe = document.elementFromPoint(
        box.x + Math.min(box.width / 2, 8),
        box.y + Math.min(box.height / 2, 8),
      );
      return {
        name,
        hit: probe?.getAttribute("aria-label") ?? probe?.tagName ?? null,
        hitIsSelf: Boolean(probe && element.contains(probe)),
      };
    };

    // Overlap candidates between sibling header regions that must not
    // visually stack. Absolute overlays (window controls over the drag
    // region, centered module nav) are intentional, so the report records
    // geometry and the human/analyst decides from both rects and capture.
    const overlaps = [];
    const track = [
      { label: "brand-text", element: brand?.querySelector("div") ?? brand },
      { label: "module-strip", element: moduleStrip },
      {
        label: "live-assistant-button",
        element: Array.from(moduleStrip?.querySelectorAll("button") ?? []).find(
          (button) => button.textContent?.includes("Live Assistant"),
        ),
      },
      { label: "compact-strip", element: compactStrip },
      { label: "more-button", element: moreButton },
      { label: "notification-group", element: notificationGroup },
      { label: "window-controls", element: windowControls },
    ].filter((entry) => entry.element && visible(entry.element));
    const containsPair = (a, b) => {
      const outer = track.find((entry) => entry.label === a)?.element;
      const inner = track.find((entry) => entry.label === b)?.element;
      return Boolean(outer && inner && outer.contains(inner));
    };
    for (let i = 0; i < track.length; i += 1) {
      for (let j = i + 1; j < track.length; j += 1) {
        const a = rect(track[i].element);
        const b = rect(track[j].element);
        if (!a || !b) continue;
        if (
          track[i].element.contains(track[j].element) ||
          track[j].element.contains(track[i].element)
        ) {
          continue;
        }
        const overlapWidth = Math.min(a.right, b.right) - Math.max(a.x, b.x);
        const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
        if (overlapWidth > 1 && overlapHeight > 1) {
          overlaps.push({
            a: track[i].label,
            b: track[j].label,
            overlapWidth: Math.round(overlapWidth * 10) / 10,
            overlapHeight: Math.round(overlapHeight * 10) / 10,
          });
        }
      }
    }

    const media = {};
    for (const width of [640, 900, 1024, 1440]) {
      media[`min-width:${width}`] = window.matchMedia(
        `(min-width: ${width}px)`,
      ).matches;
    }

    return {
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        clientWidth: html.clientWidth,
        devicePixelRatio: window.devicePixelRatio,
        visualViewportScale: window.visualViewport?.scale ?? null,
        rootZoom: getComputedStyle(html).zoom,
      },
      media,
      horizontalOverflow:
        html.scrollWidth > html.clientWidth + 1
          ? {
              scrollWidth: html.scrollWidth,
              clientWidth: html.clientWidth,
            }
          : null,
      elements,
      overlaps,
      hitTests: [
        hitTest("more-button", moreButton),
        hitTest(
          "module-live-assistant",
          Array.from(moduleStrip?.querySelectorAll("button") ?? []).find(
            (button) => button.textContent?.includes("Live Assistant"),
          ),
        ),
        hitTest("needs-you-button", needsYou),
        hitTest("window-controls", windowControls),
      ],
      sidebarMode: visible(sidebar) ? "expanded-sidebar" : "compact-top-nav",
    };
  });
}

async function captureState(page, browserWindow, viewport, imageName) {
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  await browserWindow.evaluate((window, zoomFactor) => {
    window.webContents.setZoomFactor(zoomFactor);
  }, viewport.zoomFactor);
  await page.waitForTimeout(280);
  const zoomPercent = Math.round(viewport.zoomFactor * 100);
  await page.screenshot({
    animations: "disabled",
    path: path.join(outputDir, `${imageName}-${zoomPercent}.png`),
  });
  return probeLayout(page);
}

async function seedWorkspace(page) {
  // The current tree's fresh-start profile seed is rejected by the stricter
  // candidate schema (yearsExperience is required and the fresh seed omits
  // it), so a brand-new user data dir boots into the workspace error screen.
  // The validated baseline fixture carries a complete candidate profile, so
  // resetting through the typed test API writes a repository state the
  // bootstrap can load; retry briefly because the startup workspace read is
  // still in flight.
  const baseline = JSON.parse(await readFile(baselineWorkspacePath, "utf8"));
  const createdAt = "2026-08-20T00:00:00.000Z";
  const seededState = {
    ...baseline,
    profileSetupState: {
      ...baseline.profileSetupState,
      status: "completed",
      currentStep: "ready_check",
      completedAt: createdAt,
      lastResumedAt: createdAt,
    },
  };
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await page.evaluate(
        async (state) =>
          window.nestor.jobFinder.test.resetWorkspaceState(state),
        seededState,
      );
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(600);
    }
  }
  if (lastError) {
    throw lastError;
  }
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  // Recover through the error screen's retry action if a bootstrap race still
  // shows it, then wait for the shell to mount.
  const retryButton = page.getByRole("button", {
    name: /Retry opening Job Finder/i,
  });
  if (await retryButton.count().catch(() => 0)) {
    await retryButton.click().catch(() => undefined);
  }
  await page
    .locator("[data-job-finder-shell-header]")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function run() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-shell-zoom-"),
  );
  const report = {
    startedAt: new Date().toISOString(),
    outputDir,
    initialRoute: null,
    methodology:
      "Real Electron webContents.setZoomFactor (the same primitive the app zoom shortcuts call), isolated user-data dir, built app, deterministic demo workspace. CSS root zoom is NOT used; it is compared inside the page probe as document zoom evidence.",
    states: [],
    settingsReachability: [],
  };
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

    // Deterministic populated workspace so header badges/counts are real.
    // (The apply-queue demo fixture fails current schema validation, so use
    // the validated baseline + completed setup state instead.)
    await seedWorkspace(page);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 30_000 },
    );
    await page
      .locator("[data-job-finder-shell]")
      .waitFor({ state: "visible", timeout: 20_000 });
    const initial = await page.evaluate(() => ({
      hash: window.location.hash,
      h1: document.querySelector("h1")?.textContent ?? null,
    }));
    report.initialRoute = initial;
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/home";
    });
    await page
      .getByRole("heading", { level: 1, name: /Today/ })
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(240);

    for (const viewport of viewports) {
      const label = `${viewport.slug}-zoom-${Math.round(viewport.zoomFactor * 100)}`;
      const layout = await captureState(
        page,
        browserWindow,
        viewport,
        `shell-${viewport.slug}`,
      );
      report.states.push({
        label,
        ...viewport,
        cssWidth: Math.round(layout.viewport.innerWidth),
        cssHeight: Math.round(layout.viewport.innerHeight),
        sidebarMode: layout.sidebarMode,
        horizontalOverflow: layout.horizontalOverflow,
        overlaps: layout.overlaps,
        media: layout.media,
        hitTests: layout.hitTests,
        elements: layout.elements,
      });

      const isCompact = layout.sidebarMode === "compact-top-nav";
      if (isCompact) {
        // More-menu reachability at compact width.
        const moreButton = page.locator(
          'nav[aria-label="Job Finder sections"]:not([data-desktop-module-navigation]) button[aria-label^="More"]',
        );
        try {
          if ((await moreButton.count()) > 0) {
            await moreButton.click({ timeout: 5_000 });
            await page
              .getByRole("navigation", { name: "More" })
              .waitFor({ state: "visible", timeout: 8_000 });
            await page.screenshot({
              animations: "disabled",
              path: path.join(
                outputDir,
                `more-menu-${viewport.slug}-${Math.round(viewport.zoomFactor * 100)}.png`,
              ),
            });
            await page
              .getByRole("navigation", { name: "More" })
              .getByRole("button", { name: /^Settings/ })
              .click();
            await page
              .getByRole("heading", { level: 1, name: /Settings/ })
              .waitFor({ state: "visible", timeout: 8_000 });
            await page.waitForTimeout(160);
            await page.screenshot({
              animations: "disabled",
              path: path.join(
                outputDir,
                `settings-${viewport.slug}-${Math.round(viewport.zoomFactor * 100)}.png`,
              ),
            });
            report.settingsReachability.push({
              label,
              reached: true,
              hash: await page.evaluate(() => window.location.hash),
              title: await page.title(),
            });
            await page.evaluate(() => {
              window.location.hash = "#/job-finder/home";
            });
            await page
              .getByRole("heading", { level: 1, name: /Today/ })
              .waitFor({ state: "visible", timeout: 8_000 });
            await page.waitForTimeout(160);
          } else {
            report.settingsReachability.push({
              label,
              reached: false,
              reason: "compact nav more button not found",
            });
          }
        } catch (error) {
          report.settingsReachability.push({
            label,
            reached: false,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  } finally {
    if (app) {
      await app.close().catch(() => undefined);
    }
    await rm(userDataDirectory, { recursive: true, force: true });
  }

  await writeFile(
    path.join(outputDir, "capture-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
