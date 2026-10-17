/* eslint-env node, browser */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const baselinePath = path.join(
  desktopDir,
  "test-fixtures/job-finder/profile-baseline-workspace.json",
);
const outputRootArg = process.argv.indexOf("--output-root");
const outputRoot = path.resolve(
  process.cwd(),
  outputRootArg >= 0 && process.argv[outputRootArg + 1]
    ? process.argv[outputRootArg + 1]
    : "apps/desktop/test-artifacts/persona-wave-20260828/authority-readiness-wave",
);

function createSeed(baseline) {
  return {
    ...baseline,
    profile: {
      ...baseline.profile,
      answerBank: {
        workAuthorization:
          "Authorized to work in the countries saved in my profile.",
        visaSponsorship: "I do not currently require sponsorship.",
        relocation: null,
        travel: null,
        noticePeriod: null,
        availability: "Available after my saved notice period.",
        salaryExpectations: null,
        selfIntroduction: null,
        careerTransition: null,
        customAnswers: [
          {
            id: "answer_remote_collaboration",
            kind: "other",
            label: "Remote collaboration",
            question: "How do you collaborate across time zones?",
            answer: "I use written handoffs and shared overlap hours.",
            roleFamilies: ["product"],
            proofEntryIds: [],
          },
        ],
      },
    },
    applicationAnswerSnapshots: [],
  };
}

async function launch(userDataDirectory, viewport) {
  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_BROWSER_AGENT: "0",
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_TEST_API_USE_LIVE_AI: "0",
      NESTOR_TEST_SYSTEM_THEME: "dark",
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize(viewport);
  await page.waitForFunction(
    () => Boolean(window.nestor?.jobFinder?.test),
    undefined,
    { timeout: 30_000 },
  );
  return { app, page };
}

async function resetWorkspaceState(page, seed) {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await page.evaluate(
        (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
        seed,
      );
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(600);
    }
  }
  throw lastError;
}

async function openAuthoritySettings(page) {
  const settingsButton = page
    .getByRole("button", { name: /^Settings/ })
    .first();
  if ((await settingsButton.count()) === 0) {
    await page.getByRole("button", { name: /^More/ }).first().click();
  }
  await page
    .getByRole("button", { name: /^Settings/ })
    .first()
    .click();
  await page.getByRole("heading", { level: 1, name: "Settings" }).waitFor();
  await page
    .getByRole("link", { name: "What Job Finder may do on application sites" })
    .click();
  await page
    .getByRole("article", { name: "Future authority prerequisites" })
    .waitFor();
}

async function assertNoExecutionControls(page) {
  await page
    .getByText(
      "Current build is prepare-only. Final submission is unavailable",
      {
        exact: false,
      },
    )
    .waitFor();
  for (const pattern of [
    /^(submit|submit application|apply now)$/i,
    /grant submission/i,
    /arm submission/i,
  ]) {
    if (await page.getByRole("button", { name: pattern }).count()) {
      throw new Error(
        `Authority readiness exposed forbidden control ${pattern}.`,
      );
    }
  }
}

async function approveCurrentAnswers(page) {
  await page.getByRole("button", { name: "Approve current answers" }).click();
  await page
    .getByText("Confirm that you reviewed the current reusable answers", {
      exact: false,
    })
    .waitFor();
  await page.getByRole("button", { name: "Confirm and approve" }).click();
  await page
    .getByText(
      "Current reusable answers approved as a new immutable snapshot",
      {
        exact: false,
      },
    )
    .waitFor({ timeout: 20_000 });
  await page.getByText("Current", { exact: true }).waitFor();
}

async function run() {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-authority-readiness-"),
  );
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const seed = createSeed(baseline);
  const report = { startedAt: new Date().toISOString(), checks: [] };
  let launched = await launch(userDataDirectory, { width: 1440, height: 920 });

  try {
    await resetWorkspaceState(launched.page, seed);
    await launched.page.reload({ waitUntil: "domcontentloaded" });
    await openAuthoritySettings(launched.page);
    await assertNoExecutionControls(launched.page);
    await launched.page.getByText("Not approved", { exact: true }).waitFor();
    await launched.page.getByText("4 saved", { exact: false }).waitFor();
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "01-not-approved-1440x920.png"),
    });
    report.checks.push("content-free-not-approved-readiness");

    await approveCurrentAnswers(launched.page);
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "02-approved-current-1440x920.png"),
    });
    report.checks.push("two-step-main-owned-approval");

    await launched.app.close();
    launched = await launch(userDataDirectory, { width: 1029, height: 860 });
    await openAuthoritySettings(launched.page);
    await assertNoExecutionControls(launched.page);
    await launched.page.getByText("Current", { exact: true }).waitFor();
    await launched.page.getByText("Revision 1", { exact: true }).waitFor();
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "03-current-after-restart-1029x860.png"),
    });
    report.checks.push("snapshot-persists-after-restart-compact");

    await launched.page.evaluate(async (profile) => {
      await window.nestor.jobFinder.saveProfile({
        ...profile,
        answerBank: {
          ...profile.answerBank,
          availability: "Available four weeks after accepting an offer.",
        },
      });
    }, seed.profile);
    await launched.page
      .getByRole("button", { name: "Reload authority" })
      .click();
    await launched.page.getByText("Needs review", { exact: true }).waitFor();
    await launched.page
      .getByText("The profile changed since approval", { exact: false })
      .waitFor();
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "04-stale-after-answer-edit-1029x860.png"),
    });
    report.checks.push("answer-content-edit-invalidates-approval");

    await approveCurrentAnswers(launched.page);
    await launched.page.getByText("Revision 2", { exact: true }).waitFor();
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "05-reapproved-current-1029x860.png"),
    });
    report.checks.push("changed-answers-append-new-immutable-revision");

    await launched.app.close();
    launched = await launch(userDataDirectory, { width: 1440, height: 920 });
    await openAuthoritySettings(launched.page);
    await launched.page.getByText("Current", { exact: true }).waitFor();
    await launched.page.getByText("Revision 2", { exact: true }).waitFor();
    await assertNoExecutionControls(launched.page);
    report.checks.push("second-revision-persists-no-execution-controls");
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.error = error instanceof Error ? error.stack : String(error);
    report.bodyText = (await launched.page.locator("body").innerText()).slice(
      0,
      12_000,
    );
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "failure-debug.png"),
    });
    throw error;
  } finally {
    await launched.app.close().catch(() => undefined);
    report.completedAt = new Date().toISOString();
    await writeFile(
      path.join(outputRoot, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

await run();
