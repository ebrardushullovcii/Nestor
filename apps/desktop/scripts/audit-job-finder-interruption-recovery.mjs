/* eslint-env node, browser */

import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const outputDir = path.join(
  desktopDir,
  "test-artifacts",
  "job-finder",
  "interruption-recovery-audit",
);
const sourceUserDataDirectory =
  process.argv[2] ??
  (() => {
    throw new Error("Pass a fictional audit user-data directory.");
  })();
const recoveryUserDataDirectory = await mkdtemp(
  path.join(os.tmpdir(), "nestor-interruption-recovery-"),
);

await mkdir(outputDir, { recursive: true });
await cp(sourceUserDataDirectory, recoveryUserDataDirectory, {
  recursive: true,
});

function launch() {
  return electron.launch({
    args: ["out/main/index.cjs"],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_USER_DATA_DIR: recoveryUserDataDirectory,
    },
  });
}

let app = await launch();
let page = await app.firstWindow();
await page.waitForFunction(
  () => Boolean(window.nestor?.jobFinder?.runDiscovery),
  undefined,
  { timeout: 20_000 },
);
await page.evaluate(() => {
  void window.nestor.jobFinder.runDiscovery();
});
await page.waitForTimeout(75);
await app.close();

app = await launch();
page = await app.firstWindow();
await page.waitForFunction(
  () => Boolean(window.nestor?.jobFinder?.getWorkspace),
  undefined,
  { timeout: 20_000 },
);
const workspace = await page.evaluate(() =>
  window.nestor.jobFinder.getWorkspace(),
);
await page.evaluate(() => {
  window.location.hash = "#/job-finder/discovery";
});
await page.reload();
await page
  .getByRole("heading", { name: "Find jobs", level: 1 })
  .waitFor({ state: "visible", timeout: 15_000 });
await page.screenshot({
  animations: "disabled",
  path: path.join(outputDir, "01-reopened-after-interruption.png"),
});

const report = {
  auditedAt: new Date().toISOString(),
  recoveryUserDataDirectory,
  safety: {
    fictionalDataOnly: true,
    applicationActionsExecuted: false,
    finalSubmissionsExecuted: false,
  },
  activeDiscoveryRun: workspace.activeDiscoveryRun,
  latestRun: workspace.recentDiscoveryRuns[0] ?? null,
  discoveryJobCount: workspace.discoveryJobs.length,
  browserSession: workspace.browserSession,
};
await writeFile(
  path.join(outputDir, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
await app.close();

console.log(`Recovery audit saved in ${outputDir}`);
