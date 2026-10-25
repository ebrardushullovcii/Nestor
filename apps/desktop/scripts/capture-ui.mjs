import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? "920", 10);
const runLabel = process.env.UI_CAPTURE_LABEL ?? `${width}x${height}`;
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);

const screens = [
  {
    buttonName: /^Profile$/,
    fileName: "profile.png",
    heading: "Your profile",
  },
  {
    buttonName: /^Find jobs$/,
    fileName: "discovery.png",
    heading: "Find jobs",
  },
  {
    buttonName: /^Shortlisted$/,
    fileName: "review-queue.png",
    heading: "Shortlisted jobs",
  },
  {
    buttonName: /^Applications$/,
    fileName: "applications.png",
    heading: "Applications",
  },
  {
    buttonName: /^Settings$/,
    fileName: "settings.png",
    heading: "Settings",
  },
];

async function clickNavigationControl(window, name) {
  const roleControl = window.getByRole("button", { name }).first();
  if (await roleControl.count()) {
    await roleControl.click({ force: true });
    return;
  }

  const control = window
    .locator('button:visible, [role="tab"]:visible')
    .filter({ hasText: name })
    .first();

  if (await control.count()) {
    await control.click();
    return;
  }

  await window.getByRole("tab", { name }).click({ force: true });
}

async function waitForHeading(window, headings, options) {
  const allowedHeadings = Array.isArray(headings) ? headings : [headings];

  await window.waitForFunction(
    (allowedHeadings) => {
      const heading = document.querySelector("h1");
      const text = heading?.textContent ?? "";
      return allowedHeadings.some((allowedHeading) =>
        text.includes(allowedHeading),
      );
    },
    allowedHeadings,
    { timeout: 10000, ...options },
  );
}

async function waitForProfileOrSetupHeading(window) {
  await waitForPrimaryNavigation(window);
  await clickNavigationControl(window, /^Profile$/);
  await waitForHeading(window, ["Your profile", "Guided setup"], {
    timeout: 15000,
  });
}

async function waitForPrimaryNavigation(window) {
  const buttonLocator = window.getByRole("button", { name: /^Profile$/ });
  const tabLocator = window.getByRole("tab", { name: /^Profile$/ });

  await Promise.any([
    buttonLocator.waitFor({ timeout: 15000 }),
    tabLocator.waitFor({ timeout: 15000 }),
  ]);
}

async function loadDemoDataForScreen(window, screen) {
  if (!window || !screen) {
    return;
  }

  if (
    screen.fileName === "settings.png" ||
    screen.fileName === "discovery.png" ||
    screen.fileName === "review-queue.png"
  ) {
    await window.evaluate(async () => {
      if (!window.nestor?.jobFinder?.test) {
        throw new Error("Desktop test API is unavailable in the renderer.");
      }

      await window.nestor.jobFinder.test.loadResumeWorkspaceDemo();
    });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await waitForPrimaryNavigation(window);
    await window.setViewportSize({ width, height });
  }
}

async function captureScreens() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-ui-capture-"),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_TEST_SYSTEM_THEME: process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark",
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  });

  try {
    const window = await app.firstWindow();
    window.on("console", (message) => {
      if (message.type() === "error") {
        process.stderr.write(`[renderer] ${message.text()}\n`);
      }
    });
    window.on("pageerror", (error) => {
      process.stderr.write(`[renderer page error] ${error.message}\n`);
    });

    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(async (theme) => {
      await window.nestor.jobFinder.test?.setSystemThemeOverride(theme);
    }, process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark");
    try {
      await waitForProfileOrSetupHeading(window);
    } catch (error) {
      await window.screenshot({
        animations: "disabled",
        path: path.join(outputDir, "startup-failure.png"),
      });
      throw error;
    }
    await window.setViewportSize({ width, height });
    if (process.env.UI_CAPTURE_COLLAPSE_SIDEBAR === "1") {
      await window
        .getByRole("button", { name: "Collapse sidebar" })
        .evaluate((button) => button.click());
    }

    for (const screen of screens) {
      await loadDemoDataForScreen(window, screen);
      await clickNavigationControl(window, screen.buttonName);
      if (screen.heading === "Your profile") {
        await waitForProfileOrSetupHeading(window);
      } else {
        await waitForHeading(window, screen.heading);
      }
      await window.screenshot({
        animations: "disabled",
        path: path.join(outputDir, screen.fileName),
      });
    }

    await window.getByRole("button", { name: "Open Live Assistant" }).click();
    await window
      .locator("[data-live-assistant-shell]")
      .waitFor({ state: "visible", timeout: 15000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "live-assistant.png"),
    });
  } finally {
    await app.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }

  process.stdout.write(`Saved UI captures to ${outputDir}\n`);
}

void captureScreens();
