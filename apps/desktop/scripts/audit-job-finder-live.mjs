/* eslint-env node, browser */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const repoDir = path.resolve(desktopDir, "../..");
const resumePath = path.join(
  repoDir,
  "apps/desktop/test-fixtures/job-finder/resume-import-personas/dev-castellano.pdf",
);
const outputDir = path.join(
  desktopDir,
  "test-artifacts",
  "job-finder",
  "live-discovery-audit",
);
const reportPath = path.join(outputDir, "live-discovery-audit-report.json");

const targetRoles = [
  "Senior Backend Engineer",
  "Staff Backend Engineer",
  "Senior Software Engineer",
  "Software Engineer",
  "Backend Engineer",
  "Platform Engineer",
  "Payments Engineer",
];

const targets = [
  {
    id: "live_greenhouse_remote",
    label: "Remote Greenhouse",
    startingUrl: "https://job-boards.greenhouse.io/remotecom",
    provider: "greenhouse",
    inventoryUrl:
      "https://boards-api.greenhouse.io/v1/boards/remotecom/jobs?content=true",
  },
  {
    id: "live_lever_aircall",
    label: "Aircall Lever",
    startingUrl: "https://jobs.lever.co/aircall",
    provider: "lever",
    inventoryUrl: "https://api.lever.co/v0/postings/aircall?mode=json",
  },
];

function normalizeUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch {
    return String(value ?? "");
  }
}

function isRelevantEngineeringTitle(title) {
  return /\b(?:software|developer|engineer|frontend|front end|backend|back end|full[ -]?stack|electron|\.net)\b/iu.test(
    title,
  );
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeGreenhouseJob(job) {
  return {
    provider: "greenhouse",
    sourceJobId: String(job.id),
    title: String(job.title ?? ""),
    location: String(job.location?.name ?? "Unknown"),
    canonicalUrl: String(job.absolute_url ?? ""),
    description: stripHtml(job.content),
    updatedAt: job.updated_at ?? null,
  };
}

function normalizeLeverJob(job) {
  return {
    provider: "lever",
    sourceJobId: String(job.id),
    title: String(job.text ?? ""),
    location: String(job.categories?.location ?? "Unknown"),
    canonicalUrl: String(job.hostedUrl ?? job.applyUrl ?? ""),
    description: stripHtml(job.descriptionPlain ?? job.description),
    updatedAt: job.createdAt ?? null,
  };
}

async function fetchProviderInventory(target) {
  const response = await fetch(target.inventoryUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `${target.label} inventory returned HTTP ${response.status}.`,
    );
  }

  const payload = await response.json();
  const rawJobs = target.provider === "greenhouse" ? payload.jobs : payload;
  if (!Array.isArray(rawJobs)) {
    throw new Error(`${target.label} inventory payload was not a job list.`);
  }

  const normalize =
    target.provider === "greenhouse"
      ? normalizeGreenhouseJob
      : normalizeLeverJob;
  const jobs = rawJobs.map(normalize);
  return {
    targetId: target.id,
    provider: target.provider,
    totalJobs: jobs.length,
    relevantEngineeringJobs: jobs.filter((job) =>
      isRelevantEngineeringTitle(job.title),
    ),
  };
}

async function waitForBridge(page) {
  await page.waitForFunction(
    () => Boolean(window.nestor?.jobFinder?.test?.importResumeFromPath),
    undefined,
    { timeout: 20_000 },
  );
}

function toTargetInput(target) {
  return {
    id: target.id,
    label: target.label,
    startingUrl: target.startingUrl,
    enabled: true,
    adapterKind: "auto",
    customInstructions: null,
    instructionStatus: "missing",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
  };
}

function summarizeAppJob(job) {
  return {
    id: job.id,
    sourceJobId: job.sourceJobId,
    title: job.title,
    company: job.company,
    location: job.location,
    canonicalUrl: job.canonicalUrl,
    applicationUrl: job.applicationUrl,
    source: job.source,
    providerKey: job.providerKey,
    collectionMethod: job.collectionMethod,
    discoveryMethod: job.discoveryMethod,
    detailQuality: job.detailQuality,
    descriptionLength: job.description?.length ?? 0,
    keySkills: job.keySkills,
    score: job.matchAssessment.score,
    reasons: job.matchAssessment.reasons,
    gaps: job.matchAssessment.gaps,
    recommendation: job.matchAssessment.recommendation,
    recommendationRationale: job.matchAssessment.recommendationRationale,
    requirements: job.matchAssessment.requirements,
  };
}

function compareInventories(inventories, appJobs) {
  const appJobsByUrl = new Map(
    appJobs.map((job) => [normalizeUrl(job.canonicalUrl), job]),
  );

  return inventories.map((inventory) => {
    const relevantJobs = inventory.relevantEngineeringJobs;
    const found = relevantJobs
      .map((providerJob) => ({
        providerJob,
        appJob:
          appJobsByUrl.get(normalizeUrl(providerJob.canonicalUrl)) ?? null,
      }))
      .filter((entry) => entry.appJob);
    const missed = relevantJobs
      .filter(
        (providerJob) =>
          !appJobsByUrl.has(normalizeUrl(providerJob.canonicalUrl)),
      )
      .map((job) => ({
        title: job.title,
        location: job.location,
        canonicalUrl: job.canonicalUrl,
      }));

    return {
      targetId: inventory.targetId,
      provider: inventory.provider,
      totalProviderJobs: inventory.totalJobs,
      relevantEngineeringJobCount: relevantJobs.length,
      appFoundRelevantCount: found.length,
      relevantCoveragePercent:
        relevantJobs.length === 0
          ? 100
          : Math.round((found.length / relevantJobs.length) * 100),
      found: found.map(({ providerJob, appJob }) => ({
        title: providerJob.title,
        location: providerJob.location,
        canonicalUrl: providerJob.canonicalUrl,
        appScore: appJob.matchAssessment.score,
        appReasons: appJob.matchAssessment.reasons,
        appGaps: appJob.matchAssessment.gaps,
        appRecommendation: appJob.matchAssessment.recommendation,
        appRecommendationRationale:
          appJob.matchAssessment.recommendationRationale,
        appRequirements: appJob.matchAssessment.requirements,
      })),
      missed,
    };
  });
}

async function run() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-live-discovery-audit-"),
  );
  const inventories = await Promise.all(targets.map(fetchProviderInventory));
  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_BROWSER_AGENT: "1",
      NESTOR_BROWSER_HEADLESS: "1",
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await waitForBridge(page);

    const imported = await page.evaluate(
      (sourcePath) =>
        window.nestor.jobFinder.test.importResumeFromPath({
          sourcePath,
          useVision: false,
        }),
      resumePath,
    );

    const configured = await page.evaluate(
      async ({ profile, targetRoles: roles, targets: discoveryTargets }) => {
        const workspace = await window.nestor.jobFinder.getWorkspace();
        await window.nestor.jobFinder.saveWorkspaceInputs({
          profile,
          searchPreferences: {
            ...workspace.searchPreferences,
            targetRoles: roles,
            jobFamilies: ["Software Engineering"],
            locations: [],
            excludedLocations: [],
            workModes: [],
            seniorityLevels: [],
            minimumSalaryUsd: null,
            targetSalaryUsd: null,
            companyBlacklist: [],
            companyWhitelist: [],
            approvalMode: "review_before_submit",
            discovery: {
              historyLimit: 5,
              targets: discoveryTargets,
            },
          },
        });
        await window.nestor.jobFinder.saveSettings({
          ...workspace.settings,
          humanReviewRequired: true,
          allowAutoSubmitOverride: false,
          discoveryOnly: true,
          resumeApplicationMode: "original_resume",
        });
        return window.nestor.jobFinder.getWorkspace();
      },
      {
        profile: imported.profile,
        targetRoles,
        targets: targets.map(toTargetInput),
      },
    );

    const discovered = await page.evaluate(() =>
      window.nestor.jobFinder.runDiscovery(),
    );
    const appJobs = discovered.discoveryJobs ?? [];
    const latestRun = discovered.recentDiscoveryRuns?.[0] ?? null;
    const evidenceScreenshotPath = path.join(outputDir, "evidence-ledger.png");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/discovery";
    });
    await page.reload();
    await page.getByRole("heading", { name: "Find jobs", level: 1 }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    const firstAppJob = appJobs[0];
    if (!firstAppJob) {
      throw new Error(
        "Live discovery returned no jobs, so the customer-visible evidence ledger could not be audited.",
      );
    }
    const firstResult = page.locator(
      `[data-job-result-id="${firstAppJob.id}"]`,
    );
    await firstResult.waitFor({ state: "visible", timeout: 10_000 });
    await firstResult.click();
    const evidenceLedger = page.getByRole("region", {
      name: "Requirement evidence",
    });
    await evidenceLedger.waitFor({ state: "visible", timeout: 10_000 });
    await evidenceLedger.scrollIntoViewIfNeeded();
    const evidenceLedgerText = await evidenceLedger.innerText();
    await page.screenshot({
      animations: "disabled",
      path: evidenceScreenshotPath,
    });

    const report = {
      auditedAt: new Date().toISOString(),
      safety: {
        isolatedUserData: true,
        discoveryOnly: configured.settings.discoveryOnly,
        approvalMode: configured.searchPreferences.approvalMode,
        originalResumeMode:
          configured.settings.resumeApplicationMode === "original_resume",
        applicationActionsExecuted: false,
      },
      resumeImport: {
        fileName: imported.profile.baseResume?.fileName ?? null,
        extractionStatus: imported.profile.baseResume?.extractionStatus ?? null,
        fullName: imported.profile.fullName,
        headline: imported.profile.headline,
        currentLocation: imported.profile.currentLocation,
        experienceCount: imported.profile.experiences.length,
        experienceTitles: imported.profile.experiences.map(
          (experience) => experience.title,
        ),
        skillCount: imported.profile.skills.length,
        skills: imported.profile.skills,
        warnings: imported.profile.baseResume?.analysisWarnings ?? [],
      },
      targetRoles,
      effectiveSearchPreferences: {
        locations: configured.searchPreferences.locations,
        workModes: configured.searchPreferences.workModes,
        seniorityLevels: configured.searchPreferences.seniorityLevels,
      },
      sourceRuns:
        latestRun?.targetExecutions?.map((execution) => ({
          targetId: execution.targetId,
          state: execution.state,
          resolvedAdapterKind: execution.resolvedAdapterKind,
          collectionMethod: execution.collectionMethod,
          jobsFound: execution.jobsFound,
          jobsPersisted: execution.jobsPersisted,
          jobsStaged: execution.jobsStaged,
          warning: execution.warning,
          timing: execution.timing ?? null,
        })) ?? [],
      uiEvidence: {
        screenshotPath: evidenceScreenshotPath,
        selectedJobTitle: appJobs[0]?.title ?? null,
        evidenceLedgerText,
      },
      appJobs: appJobs.map(summarizeAppJob),
      providerInventories: inventories.map((inventory) => ({
        targetId: inventory.targetId,
        provider: inventory.provider,
        totalJobs: inventory.totalJobs,
        relevantEngineeringJobs: inventory.relevantEngineeringJobs.map(
          (job) => ({
            title: job.title,
            location: job.location,
            canonicalUrl: job.canonicalUrl,
          }),
        ),
      })),
      comparison: compareInventories(inventories, appJobs),
    };

    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(
      `Live discovery audit found ${appJobs.length} app jobs.\n`,
    );
    process.stdout.write(`Saved live audit report to ${reportPath}\n`);
  } finally {
    await app.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

await run();
