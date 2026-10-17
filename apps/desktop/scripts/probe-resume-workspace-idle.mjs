#!/usr/bin/env node
/**
 * Production probe: resume workspace idle stability.
 *
 * Launches the built production Electron app with an isolated user-data dir and
 * the demo resume workspace, opens the workspace URL, and then records the URL
 * plus the workspace snapshot state for ~40 seconds WITHOUT user input while a
 * background workspace refresh (fit-score recompute) arrives.
 *
 * Purpose: distinguish "benign background refresh must not close the route"
 * from "job truly missing must show an explicit reason".
 */

import { mkdir, mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const runLabel = "resume-workspace-idle-stability";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);

async function writeJson(fileName, value) {
  await writeFile(
    path.join(outputDir, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function waitForCondition(
  check,
  description,
  timeoutMs = 15000,
  intervalMs = 150,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-resume-idle-"),
  );

  let app;
  const timeline = [];

  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_BROWSER_AGENT: "0",
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 15000 },
    );

    // Seed the demo workspace, then force the app to open on the resume URL.
    await window.evaluate(async () => {
      await window.nestor.jobFinder.test.loadResumeWorkspaceDemo();
    });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 15000 },
    );

    const startedAt = Date.now();
    const poll = async (label) =>
      window
        .evaluate(() => ({
          hash: window.location.hash,
          bodyHasUnavailable: document.body.innerText.includes(
            "Resume no longer available",
          ),
          bodyHasWorkspace: document.body.innerText
            .toLowerCase()
            .includes("resume preview"),
        }))
        .then((state) => ({
          atMs: Date.now() - startedAt,
          label,
          ...state,
        }));

    // Open the workspace directly.
    await window.evaluate(() => {
      window.location.hash = "#/job-finder/review-queue/job_ready/resume";
      window.location.reload();
    });
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 15000 },
    );
    await waitForCondition(
      async () =>
        (await window.evaluate(() => document.body.innerText))
          .toLowerCase()
          .includes("resume preview"),
      "resume workspace to render",
      25000,
    ).catch(async (error) => {
      const pageState = await window.evaluate(() => ({
        hash: window.location.hash,
        headings: Array.from(document.querySelectorAll("h1")).map(
          (heading) => heading.textContent,
        ),
        bodyText: document.body.innerText.slice(0, 900),
      }));
      throw new Error(
        `Resume workspace did not become ready: ${JSON.stringify(pageState)}`,
        { cause: error },
      );
    });
    timeline.push(await poll("workspace-open"));
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-workspace-open.png"),
    });

    // Simulate the benign background recompute: refresh the snapshot while the
    // workspace is open. This is what happens after a failed discovery run
    // returns updated fit scores.
    await window.evaluate(async () => {
      await window.nestor.jobFinder.syncWorkspace(null);
    });
    timeline.push(await poll("after-background-sync"));

    // Give the renderer time to absorb the snapshot (any deltas), then wait
    // out the original ~25s window in idle silence.
    await new Promise((resolve) => setTimeout(resolve, 30000));
    timeline.push(await poll("after-idle-30s"));
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-after-idle.png"),
    });

    // Prove the explicit missing-job case: truly remove the job from the review
    // queue (move it out), then reload so the route re-evaluates the hydrated
    // snapshot exactly like a restart with a stale workspace URL. The route
    // must stay and explain instead of silently bouncing to Shortlisted.
    await window.evaluate(async () => {
      await window.nestor.jobFinder.removeJobFromReview("job_ready");
    });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 15000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 2500));
    timeline.push(await poll("after-job-left-queue-reload"));
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03-job-missing.png"),
    });

    await writeJson("timeline.json", timeline);
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // Preserve the original failure while still cleaning up.
      }
    }
    try {
      await rm(userDataDirectory, { recursive: true, force: true });
    } catch {
      // Preserve the original failure while still cleaning up.
    }
  }

  process.stdout.write(
    `Wrote resume workspace idle-stability artifacts to ${outputDir}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
