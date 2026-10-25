import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  "diverse-live-audit",
);

const sourceCatalog = {
  remoteGreenhouse: {
    id: "fictional_remote_greenhouse",
    label: "Remote careers",
    startingUrl: "https://job-boards.greenhouse.io/remotecom",
  },
  aircallLever: {
    id: "fictional_aircall_lever",
    label: "Aircall careers",
    startingUrl: "https://jobs.lever.co/aircall",
  },
  umbrelAshby: {
    id: "fictional_umbrel_ashby",
    label: "Umbrel careers",
    startingUrl: "https://jobs.ashbyhq.com/umbrel",
  },
  ethenaLever: {
    id: "fictional_ethena_lever",
    label: "Ethena careers",
    startingUrl: "https://jobs.lever.co/ethena",
  },
  bellotaLever: {
    id: "fictional_bellota_lever",
    label: "Bellota Labs careers",
    startingUrl: "https://jobs.lever.co/bellotalabs",
  },
};

const profiles = [
  {
    slug: "casey-engineer",
    resumePath: path.join(
      desktopDir,
      "test-fixtures",
      "job-finder",
      "fictional-audit",
      "casey-engineer.txt",
    ),
    targetRoles: [
      "Senior Frontend Engineer",
      "Frontend Engineer",
      "Software Engineer",
    ],
    jobFamilies: ["Software Engineering"],
    locations: ["Remote", "United States"],
    workModes: ["remote"],
    sources: [sourceCatalog.remoteGreenhouse, sourceCatalog.aircallLever],
  },
  {
    slug: "mina-support",
    resumePath: path.join(
      desktopDir,
      "test-fixtures",
      "job-finder",
      "fictional-audit",
      "mina-support.txt",
    ),
    targetRoles: [
      "Customer Support Specialist",
      "Customer Support Representative",
      "Customer Service Specialist",
    ],
    jobFamilies: ["Customer Support"],
    locations: ["Remote", "United States"],
    workModes: ["remote"],
    sources: [sourceCatalog.umbrelAshby, sourceCatalog.remoteGreenhouse],
  },
  {
    slug: "jules-career-change",
    resumePath: path.join(
      desktopDir,
      "test-fixtures",
      "job-finder",
      "fictional-audit",
      "jules-career-change.txt",
    ),
    targetRoles: [
      "Marketing Coordinator",
      "Marketing Assistant",
      "Project Coordinator",
    ],
    jobFamilies: ["Marketing", "Project Coordination"],
    locations: ["Remote", "United States"],
    workModes: ["remote"],
    sources: [sourceCatalog.ethenaLever, sourceCatalog.bellotaLever],
  },
];

function toTargetInput(target) {
  return {
    ...target,
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

async function waitForBridge(page) {
  await page.waitForFunction(
    () => Boolean(window.nestor?.jobFinder?.test?.importResumeFromPath),
    undefined,
    { timeout: 20_000 },
  );
}

function draftText(workspace) {
  return workspace.draft.sections
    .filter((section) => section.included)
    .flatMap((section) => [
      section.label,
      section.text ?? "",
      ...(section.bullets ?? [])
        .filter((bullet) => bullet.included)
        .map((bullet) => bullet.text),
      ...(section.entries ?? []).flatMap((entry) => [
        entry.title ?? "",
        entry.subtitle ?? "",
        entry.summary ?? "",
        ...(entry.bullets ?? [])
          .filter((bullet) => bullet.included)
          .map((bullet) => bullet.text),
      ]),
    ])
    .filter(Boolean)
    .join("\n");
}

function numericClaims(value) {
  return [
    ...new Set(
      String(value)
        .match(/\b\d+(?:[.,]\d+)?%?\b/gu)
        ?.map((token) => token.toLowerCase()) ?? [],
    ),
  ];
}

function summarizeJob(job) {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    canonicalUrl: job.canonicalUrl,
    applicationUrl: job.applicationUrl,
    score: job.matchAssessment.score,
    recommendation: job.matchAssessment.recommendation,
    recommendationRationale: job.matchAssessment.recommendationRationale,
    reasons: job.matchAssessment.reasons,
    gaps: job.matchAssessment.gaps,
    requirements: job.matchAssessment.requirements,
    detailQuality: job.detailQuality,
    descriptionLength: job.description?.length ?? 0,
  };
}

async function auditProfile(profile) {
  const profileOutputDir = path.join(outputDir, profile.slug);
  await mkdir(profileOutputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), `nestor-${profile.slug}-`),
  );
  const originalResumeText = await readFile(profile.resumePath, "utf8");
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
      profile.resumePath,
    );
    const configured = await page.evaluate(
      async ({ importedProfile, profileConfig }) => {
        const workspace = await window.nestor.jobFinder.getWorkspace();
        return window.nestor.jobFinder.saveWorkspaceInputs({
          profile: importedProfile,
          searchPreferences: {
            ...workspace.searchPreferences,
            targetRoles: profileConfig.targetRoles,
            jobFamilies: profileConfig.jobFamilies,
            locations: profileConfig.locations,
            excludedLocations: [],
            workModes: profileConfig.workModes,
            seniorityLevels: [],
            companyBlacklist: [],
            companyWhitelist: [],
            approvalMode: "review_before_submit",
            discovery: {
              ...workspace.searchPreferences.discovery,
              collectOnlyHardCriteriaMatches: false,
              historyLimit: 5,
              targets: profileConfig.sources.map((target) => ({
                ...target,
                enabled: true,
                adapterKind: "auto",
                customInstructions: null,
                instructionStatus: "missing",
                validatedInstructionId: null,
                draftInstructionId: null,
                lastDebugRunId: null,
                lastVerifiedAt: null,
                staleReason: null,
              })),
            },
          },
        });
      },
      {
        importedProfile: imported.profile,
        profileConfig: {
          ...profile,
          sources: profile.sources.map(toTargetInput),
        },
      },
    );
    await page.evaluate(async () => {
      const workspace = await window.nestor.jobFinder.getWorkspace();
      await window.nestor.jobFinder.saveSettings({
        ...workspace.settings,
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
        discoveryOnly: true,
        resumeApplicationMode: "tailored_per_job",
      });
      const now = new Date().toISOString();
      await window.nestor.jobFinder.saveProfileSetupState({
        ...workspace.profileSetupState,
        status: "completed",
        currentStep: "ready_check",
        startedAt: workspace.profileSetupState.startedAt ?? now,
        completedAt: now,
        lastResumedAt: now,
      });
    });
    const discovered = await page.evaluate(() =>
      window.nestor.jobFinder.runDiscovery(),
    );
    const jobs = discovered.discoveryJobs ?? [];
    const topJob = jobs[0] ?? null;

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      window.location.hash = "#/job-finder/discovery";
    });
    await page.reload();
    await page
      .getByRole("heading", { name: "Find jobs", level: 1 })
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.screenshot({
      animations: "disabled",
      path: path.join(profileOutputDir, "01-discovery-results.png"),
    });

    let resumeAudit = null;
    if (topJob) {
      const firstResult = page.locator(
        `[data-job-result-id="${topJob.id}"]`,
      );
      await firstResult.waitFor({ state: "visible", timeout: 10_000 });
      await firstResult.click();
      const evidenceLedger = page.getByRole("region", {
        name: "Fit breakdown",
      });
      await evidenceLedger.waitFor({ state: "visible", timeout: 10_000 });
      await evidenceLedger.scrollIntoViewIfNeeded();
      await page.screenshot({
        animations: "disabled",
        path: path.join(profileOutputDir, "02-job-evidence.png"),
      });

      await page.evaluate(async (jobId) => {
        await window.nestor.jobFinder.queueJobForReview(jobId);
        await window.nestor.jobFinder.generateResume(jobId);
      }, topJob.id);
      const resumeWorkspace = await page.evaluate(
        (jobId) => window.nestor.jobFinder.getResumeWorkspace(jobId),
        topJob.id,
      );
      const generatedText = draftText(resumeWorkspace);
      const originalNumbers = numericClaims(originalResumeText);
      const generatedNumbers = numericClaims(generatedText);
      resumeAudit = {
        jobId: topJob.id,
        jobTitle: topJob.title,
        jobCompany: topJob.company,
        draftStatus: resumeWorkspace.draft.status,
        generatedText,
        originalNumbers,
        generatedNumbers,
        unsupportedNumericClaims: generatedNumbers.filter(
          (token) => !originalNumbers.includes(token),
        ),
        validationIssues: resumeWorkspace.validation?.issues ?? [],
        researchCount: resumeWorkspace.research.length,
        sourceRefCount: resumeWorkspace.draft.sections.reduce(
          (count, section) =>
            count +
            section.sourceRefs.length +
            section.entries.reduce(
              (entryCount, entry) =>
                entryCount +
                entry.sourceRefs.length +
                entry.bullets.reduce(
                  (bulletCount, bullet) =>
                    bulletCount + bullet.sourceRefs.length,
                  0,
                ),
              0,
            ),
          0,
        ),
      };

      // The queue/generation calls above intentionally cross IPC directly.
      // Reload once so the renderer consumes their durable result before the
      // visible Shortlisted -> Resume Studio journey.
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await waitForBridge(page);
      await page.evaluate(() => {
        window.location.hash = "#/job-finder/review-queue";
      });
      await page
        .getByRole("heading", { name: "Shortlisted jobs", level: 1 })
        .waitFor({ state: "visible", timeout: 15_000 });
      await page
        .getByRole("button", { name: /Edit resume|Open the resume|Review the resume/i })
        .first()
        .click();
      await page
        .locator("h1")
        .filter({ hasText: topJob.title })
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
      await page.screenshot({
        animations: "disabled",
        path: path.join(profileOutputDir, "03-tailored-resume.png"),
      });
    }

    const latestWorkspace = await page.evaluate(() =>
      window.nestor.jobFinder.getWorkspace(),
    );
    const report = {
      auditedAt: new Date().toISOString(),
      profile: profile.slug,
      userDataDirectory,
      safety: {
        fictionalDataOnly: true,
        discoveryOnly: latestWorkspace.settings.discoveryOnly,
        externalAccountsCreated: false,
        applicationActionsExecuted: false,
        finalSubmissionsExecuted: false,
      },
      import: {
        fullName: imported.profile.fullName,
        headline: imported.profile.headline,
        currentLocation: imported.profile.currentLocation,
        experienceCount: imported.profile.experiences.length,
        educationCount: imported.profile.education.length,
        education: imported.profile.education,
        skillCount: imported.profile.skills.length,
        skills: imported.profile.skills,
        extractionStatus: imported.profile.baseResume.extractionStatus,
        warnings: imported.profile.baseResume.analysisWarnings,
      },
      preferences: {
        targetRoles: configured.searchPreferences.targetRoles,
        locations: configured.searchPreferences.locations,
        workModes: configured.searchPreferences.workModes,
        collectOnlyHardCriteriaMatches:
          configured.searchPreferences.discovery
            .collectOnlyHardCriteriaMatches,
      },
      sourceRuns:
        latestWorkspace.recentDiscoveryRuns[0]?.targetExecutions ?? [],
      jobs: jobs.map(summarizeJob),
      resumeAudit,
    };
    await writeFile(
      path.join(profileOutputDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    return report;
  } finally {
    await app.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const reports = [];
for (const profile of profiles) {
  reports.push(await auditProfile(profile));
}
await writeFile(
  path.join(outputDir, "summary.json"),
  `${JSON.stringify(reports, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `Completed ${reports.length} fictional live audits in ${outputDir}\n`,
);
