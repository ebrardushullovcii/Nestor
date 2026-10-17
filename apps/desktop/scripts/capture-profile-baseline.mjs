import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");

function readCliOption(flag) {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return null;
  }

  return process.argv[index + 1] ?? null;
}

function toDateLabel(value) {
  return value.toISOString().slice(0, 10);
}

function toSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function requireSnapshotPath() {
  const cliSnapshotPath = readCliOption("--snapshot");

  if (cliSnapshotPath) {
    return cliSnapshotPath;
  }

  if (process.env.UI_PROFILE_BASELINE_SNAPSHOT) {
    return process.env.UI_PROFILE_BASELINE_SNAPSHOT;
  }

  throw new Error(
    "Profile-baseline capture now requires an explicit snapshot path. Pass --snapshot <path> or set UI_PROFILE_BASELINE_SNAPSHOT to a committed workspace snapshot fixture.",
  );
}

function parseProfileBaselineSnapshot(rawSnapshot) {
  const snapshot = JSON.parse(rawSnapshot);

  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Profile baseline snapshot must be a JSON object.");
  }

  if (!snapshot.profile || typeof snapshot.profile !== "object") {
    throw new Error("Profile baseline snapshot must include a profile object.");
  }

  if (
    !snapshot.searchPreferences ||
    typeof snapshot.searchPreferences !== "object"
  ) {
    throw new Error(
      "Profile baseline snapshot must include a searchPreferences object.",
    );
  }

  if (!snapshot.settings || typeof snapshot.settings !== "object") {
    throw new Error(
      "Profile baseline snapshot must include a settings object.",
    );
  }

  if (
    typeof snapshot.profile.fullName !== "string" ||
    snapshot.profile.fullName.trim().length === 0
  ) {
    throw new Error("Profile baseline snapshot must include profile.fullName.");
  }

  return snapshot;
}

function getGitMetadata() {
  try {
    const branch = execSync("git branch --show-current", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const commit = execSync("git rev-parse --short HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    return { branch, commit };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

async function ensureLocatorText(page, text) {
  await page
    .getByText(text, { exact: true })
    .first()
    .waitFor({ timeout: 10000 });
}

async function waitForProfileOrSetupHeading(page, timeout = 15000) {
  await page.evaluate(() => {
    window.location.hash = "#/job-finder/profile";
  });
  await page.waitForFunction(
    () => {
      const heading = document.querySelector("h1");
      return (
        heading?.textContent?.includes("Your profile") ||
        heading?.textContent?.includes("Guided setup")
      );
    },
    undefined,
    { timeout },
  );
}

async function clickNavigationControl(page, name) {
  const control = page
    .locator('button, [role="tab"]')
    .filter({ hasText: name })
    .first();

  if (await control.count()) {
    await control.click();
    return;
  }

  await page.getByRole("button", { name }).click();
}

const scrollAreaSelector = ".screen-scroll-area";

async function getScrollAreaMetrics(page) {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector);

    if (!(element instanceof HTMLElement)) {
      throw new Error(
        `Unable to find scroll container for selector: ${selector}`,
      );
    }

    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  }, scrollAreaSelector);
}

async function setScrollAreaOffset(page, offset) {
  await page.evaluate(
    ({ selector, nextOffset }) => {
      const element = document.querySelector(selector);

      if (!(element instanceof HTMLElement)) {
        throw new Error(
          `Unable to find scroll container for selector: ${selector}`,
        );
      }

      element.scrollTop = nextOffset;
    },
    { selector: scrollAreaSelector, nextOffset: offset },
  );
}

async function captureExpandedViewport(
  page,
  outputPath,
  viewportWidth,
  viewportHeight,
) {
  const metrics = await getScrollAreaMetrics(page);
  const expandedHeight = Math.max(
    viewportHeight,
    Math.min(5000, metrics.scrollHeight + 140),
  );

  await page.setViewportSize({ width: viewportWidth, height: expandedHeight });
  await page.waitForTimeout(160);
  await setScrollAreaOffset(page, 0);
  await page.waitForTimeout(120);

  await page.screenshot({
    animations: "disabled",
    path: outputPath,
  });

  await page.setViewportSize({ width: viewportWidth, height: viewportHeight });
  await page.waitForTimeout(160);
}

async function captureViewportSegments(page, outputDirectory, filePrefix) {
  await setScrollAreaOffset(page, 0);

  const metrics = await getScrollAreaMetrics(page);
  const totalHeight = metrics.scrollHeight;
  const viewportHeight = metrics.clientHeight;

  const stride = Math.max(200, viewportHeight - 180);
  const positions = [];

  for (let offset = 0; offset < totalHeight; offset += stride) {
    positions.push(offset);
  }

  const finalOffset = Math.max(0, totalHeight - viewportHeight);

  if (
    positions.length === 0 ||
    positions[positions.length - 1] !== finalOffset
  ) {
    positions.push(finalOffset);
  }

  const uniquePositions = [...new Set(positions)];
  const files = [];

  for (const [index, offset] of uniquePositions.entries()) {
    await setScrollAreaOffset(page, offset);
    await page.waitForTimeout(120);

    const fileName = `${filePrefix}-scroll-${String(index + 1).padStart(2, "0")}.png`;
    const filePath = path.join(outputDirectory, fileName);

    await page.screenshot({
      animations: "disabled",
      path: filePath,
    });

    files.push(fileName);
  }

  await setScrollAreaOffset(page, 0);
  return files;
}

const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? "920", 10);
const snapshotPath = requireSnapshotPath();
const runLabel =
  readCliOption("--label") ??
  process.env.UI_CAPTURE_LABEL ??
  `profile-visual-baseline-${toDateLabel(new Date())}`;
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);
const topTabsDir = path.join(outputDir, "top-tabs");
const profileTabsDir = path.join(outputDir, "profile-tabs");

const topLevelScreens = [
  {
    buttonName: /^Profile$/,
    slug: "profile",
    heading: "Your profile",
    beforeCapture: async (page) => {
      await clickNavigationControl(page, "Basics");
      await ensureLocatorText(page, "Imported details");
    },
  },
  {
    buttonName: /^Find jobs\s+\d+$/,
    slug: "discovery",
    heading: "Find jobs",
  },
  {
    buttonName: /^Shortlisted\s+\d+$/,
    slug: "review-queue",
    heading: "Shortlisted jobs",
  },
  {
    buttonName: /^Applications\s+\d+$/,
    slug: "applications",
    heading: "Applications",
  },
  {
    buttonName: /^Settings$/,
    slug: "settings",
    heading: "Settings",
  },
];

const profileTabs = [
  {
    label: "Basics",
    slug: "basics",
    readyText: "Personal details",
  },
  {
    label: "Work history",
    slug: "experience",
    readyText: "Work history",
  },
  {
    label: "Background",
    slug: "background",
    readyText: "Education and credentials",
  },
  {
    label: "Preferences",
    slug: "preferences",
    readyText: "Work eligibility",
  },
];

async function captureProfileBaseline() {
  const snapshot = parseProfileBaselineSnapshot(
    await readFile(snapshotPath, "utf8"),
  );
  const gitMetadata = getGitMetadata();

  await mkdir(topTabsDir, { recursive: true });
  await mkdir(profileTabsDir, { recursive: true });

  let userDataDirectory = null;
  let app = null;

  const report = {
    capturedAt: new Date().toISOString(),
    branch: gitMetadata.branch,
    commit: gitMetadata.commit,
    viewport: { width, height },
    runLabel,
    snapshotPath,
    outputDir,
    hydratedProfile: {
      fullName: snapshot.profile.fullName,
      headline: snapshot.profile.headline,
      location: snapshot.profile.currentLocation,
      salaryCurrency: snapshot.searchPreferences.salaryCurrency,
      timeZone: snapshot.profile.timeZone,
    },
    topTabs: {},
    profileTabs: {},
  };

  try {
    userDataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-profile-baseline-"),
    );
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_TEST_SYSTEM_THEME:
          process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });

    const page = await app.firstWindow();

    await page.evaluate(async (theme) => {
      await window.nestor.jobFinder.test?.setSystemThemeOverride(theme);
    }, process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark");

    await page.waitForLoadState("domcontentloaded");
    await waitForProfileOrSetupHeading(page);
    await page.setViewportSize({ width, height });

    await page.evaluate(
      async ({ profile, searchPreferences, settings }) => {
        await window.nestor.jobFinder.saveWorkspaceInputs({
          profile,
          searchPreferences,
          settings,
        });
        return window.nestor.jobFinder.getWorkspace();
      },
      {
        profile: snapshot.profile,
        searchPreferences: snapshot.searchPreferences,
        settings: snapshot.settings,
      },
    );

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitForProfileOrSetupHeading(page, 10000);

    await clickNavigationControl(page, /^Profile$/);
    await page
      .getByRole("heading", { level: 1, name: "Your profile" })
      .waitFor({ timeout: 10000 });
    await clickNavigationControl(page, "Basics");
    await ensureLocatorText(page, "Imported details");
    await ensureLocatorText(page, snapshot.profile.fullName);

    for (const screen of topLevelScreens) {
      await clickNavigationControl(page, screen.buttonName);
      await page
        .getByRole("heading", { level: 1, name: screen.heading })
        .waitFor({ timeout: 10000 });

      if (screen.beforeCapture) {
        await screen.beforeCapture(page);
      }

      await setScrollAreaOffset(page, 0);
      await page.waitForTimeout(120);

      const topFile = `${screen.slug}-top.png`;
      const fullFile = `${screen.slug}-full.png`;

      await page.screenshot({
        animations: "disabled",
        path: path.join(topTabsDir, topFile),
      });

      await captureExpandedViewport(
        page,
        path.join(topTabsDir, fullFile),
        width,
        height,
      );

      const scrollFiles = await captureViewportSegments(
        page,
        topTabsDir,
        screen.slug,
      );

      report.topTabs[screen.slug] = {
        top: path.join("top-tabs", topFile),
        full: path.join("top-tabs", fullFile),
        scroll: scrollFiles.map((fileName) => path.join("top-tabs", fileName)),
      };
    }

    await clickNavigationControl(page, /^Profile$/);
    await page
      .getByRole("heading", { level: 1, name: "Your profile" })
      .waitFor({ timeout: 10000 });

    for (const profileTab of profileTabs) {
      await clickNavigationControl(page, profileTab.label);
      await ensureLocatorText(page, profileTab.readyText);
      await setScrollAreaOffset(page, 0);
      await page.waitForTimeout(120);

      const slug = toSlug(profileTab.slug);
      const topFile = `${slug}-top.png`;
      const fullFile = `${slug}-full.png`;

      await page.screenshot({
        animations: "disabled",
        path: path.join(profileTabsDir, topFile),
      });

      await captureExpandedViewport(
        page,
        path.join(profileTabsDir, fullFile),
        width,
        height,
      );

      const scrollFiles = await captureViewportSegments(
        page,
        profileTabsDir,
        slug,
      );

      report.profileTabs[slug] = {
        top: path.join("profile-tabs", topFile),
        full: path.join("profile-tabs", fullFile),
        scroll: scrollFiles.map((fileName) =>
          path.join("profile-tabs", fileName),
        ),
      };
    }

    await writeFile(
      path.join(outputDir, "capture-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`Saved profile baseline captures to ${outputDir}\n`);
  } finally {
    if (app) {
      await app.close();
    }

    if (userDataDirectory) {
      await rm(userDataDirectory, { recursive: true, force: true });
    }
  }
}

void captureProfileBaseline();
