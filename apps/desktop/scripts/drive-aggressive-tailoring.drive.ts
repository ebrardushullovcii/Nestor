import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import { test } from "vitest";

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(desktopDir, "../..");
const resumePath = path.join(
  repoRoot,
  "apps/desktop/test-fixtures/job-finder/resume-import-personas/dev-castellano.pdf",
);
const outputDir = path.join(
  desktopDir,
  "test-artifacts",
  "ui",
  "aggressive-tailoring-drive",
);
const FORBIDDEN_COPY = /\b(lie|lies|lying|liar|dishonest|unethical|fraud)\b/i;
const FORBIDDEN_SKILLS = [
  "Proficiency",
  "Build",
  "Services",
  "Certified",
  "Solutions",
  "Architect",
];
const JOB_ID = "job_aggressive_probe";
const JOB_TITLE = "Senior Full-Stack Software Engineer";

function loadRepoLocalEnv(): void {
  const envPath = path.join(repoRoot, ".env.local");
  if (!existsSync(envPath)) {
    return;
  }
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForCondition(
  check: () => Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function writeReport(value: unknown): Promise<void> {
  await writeFile(
    path.join(outputDir, "report.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

function createProbeJob(now: string) {
  return {
    id: JOB_ID,
    source: "target_site",
    sourceJobId: "harbor_ledger_fullstack",
    discoveryMethod: "catalog_seed",
    collectionMethod: "fallback_search",
    canonicalUrl: "https://jobs.harborledger.example.com/senior-full-stack",
    applicationUrl:
      "https://jobs.harborledger.example.com/senior-full-stack/apply",
    title: JOB_TITLE,
    company: "Harbor Ledger",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: now,
    postedAtText: null,
    discoveredAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
    lastVerifiedActiveAt: now,
    salaryText: "$160k - $190k",
    normalizedCompensation: {
      currency: "USD",
      interval: "year",
      minAmount: 160000,
      maxAmount: 190000,
      minAnnualUsd: 160000,
      maxAnnualUsd: 190000,
    },
    detailQuality: "detail_enriched",
    summary:
      "Senior full-stack engineer on the restaurant operations platform, owning TypeScript services, React storefronts, and the Terraform-backed delivery pipeline.",
    description: [
      "Harbor Ledger is hiring a Senior Full-Stack Software Engineer for the restaurant operations platform.",
      "You will own React and Next.js storefronts, TypeScript and Node.js services, and Postgres-backed order ledgers.",
      "You'll work with Terraform daily to provision the kitchen-display environments.",
      "Services written in Go handle settlement reconciliation beside the existing Node.js APIs.",
      "Build pipelines in TypeScript and Postgres so ticket flow stays under one second at peak.",
      "The team already runs Docker and Amazon Web Services; Kubernetes is the next isolation layer.",
      "This role asks for 8 years of professional software experience and someone who can sit with kitchen staff on 10-inch tablets.",
    ].join(" "),
    keySkills: [
      "TypeScript",
      "React",
      "Next.js",
      "Node.js",
      "Postgres",
      "Terraform",
    ],
    responsibilities: [
      "Own React and Next.js storefronts used by kitchen and floor staff.",
      "Keep TypeScript and Node.js order services under a one-second ticket path.",
      "Build pipelines in TypeScript and Postgres for settlement and kitchen display.",
      "You'll work with Terraform daily and keep Kubernetes manifests reviewable.",
      "Services written in Go cover reconciliation next to the Node.js APIs.",
    ],
    minimumQualifications: [
      "8 years of professional software engineering experience.",
      "Hands-on experience with Terraform and Kubernetes.",
      "Proficiency in C++.",
      "Experience with Go.",
      "Strong TypeScript, React, Next.js, Node.js, and Postgres background.",
    ],
    preferredQualifications: [
      "AWS Certified Solutions Architect or equivalent cloud certification.",
      "C# and Docker are a plus.",
    ],
    seniority: "Senior",
    employmentType: "Full-time",
    department: "Engineering",
    team: "Restaurant Platform",
    employerWebsiteUrl: "https://harborledger.example.com",
    employerDomain: "harborledger.example.com",
    atsProvider: null,
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: ["Europe"],
    },
    keywordSignals: [
      { id: "probe_terraform", label: "Terraform", kind: "tool", weight: 5 },
      { id: "probe_kubernetes", label: "Kubernetes", kind: "tool", weight: 5 },
      { id: "probe_typescript", label: "TypeScript", kind: "skill", weight: 5 },
    ],
    benefits: ["Remote-first collaboration", "Home-office stipend"],
    status: "ready_for_review",
    matchAssessment: {
      score: 84,
      reasons: ["Strong TypeScript and React overlap"],
      gaps: ["Terraform is not named in the saved resume"],
    },
    provenance: [
      {
        targetId: "target_linkedin_default",
        adapterKind: "auto",
        resolvedAdapterKind: "target_site",
        startingUrl: "https://www.linkedin.com/jobs/search/",
        collectionMethod: "fallback_search",
        discoveredAt: now,
      },
    ],
  };
}

function summarizeWorkspace(workspace: {
  effectiveTailoringStrength?: string | null;
  draft?: {
    status?: string;
    claimConfirmations?: readonly unknown[];
    sections?: readonly {
      kind?: string;
      bullets?: readonly { text?: string }[];
      entries?: readonly { bullets?: readonly { text?: string }[] }[];
    }[];
  };
  validation?: {
    claimAssessments?: readonly {
      claimText?: string;
      status?: string;
      field?: string;
      sectionId?: string;
    }[];
  } | null;
  tailoredAsset?: {
    generationMethod?: string | null;
    generationReason?: string | null;
    notes?: readonly string[] | null;
  } | null;
}) {
  const skillBullets =
    workspace.draft?.sections
      ?.filter(
        (section) => section.kind === "skills" || section.kind === "keywords",
      )
      .flatMap((section) =>
        (section.bullets ?? []).map((bullet) => ({
          text: bullet.text ?? "",
          origin: "origin" in bullet ? bullet.origin : null,
        })),
      ) ?? [];
  const skillTexts = skillBullets.map((bullet) => bullet.text);
  const experienceTexts =
    workspace.draft?.sections
      ?.filter((section) => section.kind === "experience")
      .flatMap(
        (section) =>
          section.entries?.flatMap(
            (entry) => entry.bullets?.map((bullet) => bullet.text ?? "") ?? [],
          ) ?? [],
      ) ?? [];
  const assessments = workspace.validation?.claimAssessments ?? [];

  return {
    effectiveTailoringStrength: workspace.effectiveTailoringStrength ?? null,
    draftStatus: workspace.draft?.status ?? null,
    confirmationCount: workspace.draft?.claimConfirmations?.length ?? 0,
    generationMethod: workspace.tailoredAsset?.generationMethod ?? null,
    generationReason: workspace.tailoredAsset?.generationReason ?? null,
    notes: workspace.tailoredAsset?.notes ?? [],
    skillTexts,
    skillBullets,
    experienceSample: experienceTexts.slice(0, 8),
    assessmentStatuses: Object.fromEntries(
      ["confirm_needed", "unsupported", "exact", "paraphrase", "review"].map(
        (status) => [
          status,
          assessments.filter((assessment) => assessment.status === status)
            .length,
        ],
      ),
    ),
    confirmNeeded: assessments
      .filter((assessment) => assessment.status === "confirm_needed")
      .map((assessment) => ({
        text: assessment.claimText,
        field: assessment.field,
        sectionId: assessment.sectionId,
      })),
    unsupported: assessments
      .filter((assessment) => assessment.status === "unsupported")
      .map((assessment) => assessment.claimText),
  };
}

async function openResumeStudio(window: Page): Promise<void> {
  await window.evaluate((jobId) => {
    window.location.hash = `#/job-finder/review-queue/${jobId}/resume`;
  }, JOB_ID);
  await window
    .getByRole("heading", { level: 1, name: new RegExp(JOB_TITLE, "i") })
    .waitFor({ timeout: 20_000 });
}

async function visibleStudioText(window: Page): Promise<string> {
  return (await window.locator("body").innerText()).replace(/\s+/g, " ");
}

async function captureStudio(window: Page, name: string): Promise<void> {
  await window.screenshot({
    animations: "disabled",
    path: path.join(outputDir, name),
    fullPage: true,
  });
}

async function main(): Promise<void> {
  loadRepoLocalEnv();
  const builtMain = path.join(desktopDir, "out", "main", "index.cjs");
  assert(
    existsSync(builtMain),
    "Desktop build is missing. Run pnpm --filter @nestor/desktop build first.",
  );
  assert(existsSync(resumePath), `Resume is missing at ${resumePath}`);
  assert(
    Boolean(process.env.NESTOR_AI_API_KEY),
    "NESTOR_AI_API_KEY is required so this drive can generate a real aggressive draft.",
  );

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-aggressive-tailoring-"),
  );

  let app: ElectronApplication | undefined;
  const report: Record<string, unknown> = {
    userDataDirectory,
    resumeFile: path.basename(resumePath),
    hasLiveApiKey: Boolean(process.env.NESTOR_AI_API_KEY),
  };

  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_BROWSER_AGENT: "0",
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_TEST_API_USE_LIVE_AI: "1",
        NESTOR_TEST_SYSTEM_THEME: "dark",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });

    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1440, height: 920 });
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test?.importResumeFromPath),
      undefined,
      { timeout: 20_000 },
    );

    const imported = await window.evaluate(async (sourcePath) => {
      const snapshot = await window.nestor.jobFinder.test!.importResumeFromPath(
        {
          sourcePath,
          useVision: false,
        },
      );
      return {
        fullName: snapshot.profile.fullName,
        headline: snapshot.profile.headline,
        extractionStatus: snapshot.profile.baseResume.extractionStatus,
        hasResumeText: Boolean(snapshot.profile.baseResume.textContent?.trim()),
      };
    }, resumePath);
    report.imported = imported;
    assert(imported.hasResumeText, "Imported resume has no extracted text.");
    await captureStudio(window, "01-imported-profile.png");

    const now = new Date().toISOString();
    const probeJob = createProbeJob(now);
    await window.evaluate(async (job) => {
      const snapshot = await window.nestor.jobFinder.getWorkspace();
      await window.nestor.jobFinder.test!.resetWorkspaceState({
        profile: snapshot.profile,
        searchPreferences: {
          ...snapshot.searchPreferences,
          tailoringMode: "aggressive",
        },
        profileSetupState: snapshot.profileSetupState,
        savedJobs: [job],
        settings: snapshot.settings,
        campaigns: snapshot.campaigns,
        activeCampaignId: snapshot.activeCampaignId,
      });
    }, probeJob);

    window.setDefaultTimeout(360_000);
    const generatedSnapshot = await window.evaluate(async (jobId) => {
      await window.nestor.jobFinder.generateResume(jobId);
      return window.nestor.jobFinder.getResumeWorkspace(jobId);
    }, JOB_ID);
    const generated = summarizeWorkspace(generatedSnapshot);
    report.generated = generated;
    assert(
      generated.effectiveTailoringStrength === "aggressive",
      `Expected aggressive strength, got ${generated.effectiveTailoringStrength}`,
    );
    assert(
      generated.skillTexts.some((text) => /terraform/i.test(text)),
      `Terraform should land in skills after aggressive generation. Skills: ${generated.skillTexts.join(", ")}`,
    );
    assert(
      generated.skillTexts.some((text) => /kubernetes/i.test(text)),
      `Kubernetes should land in skills after aggressive generation. Skills: ${generated.skillTexts.join(", ")}`,
    );
    for (const forbidden of FORBIDDEN_SKILLS) {
      assert(
        !generated.skillTexts.includes(forbidden),
        `Skills section must not include leftover listing fluff "${forbidden}".`,
      );
    }
    assert(
      !FORBIDDEN_COPY.test((generated.notes ?? []).join(" ")),
      "Draft notes must not moralize.",
    );
    assert(
      generated.confirmNeeded.length > 0,
      "Aggressive generation should leave at least one confirm_needed listing stretch.",
    );
    const noteText = (generated.notes ?? []).join(" ");
    assert(
      !/kitchen display|manifests reviewable|delivery pipeline|restaurant operations|storefronts used by/i.test(
        noteText,
      ),
      `Draft notes should not treat listing sentences as skills: ${noteText}`,
    );
    assert(
      !/typescript services/i.test(noteText),
      `Draft notes should not name listing prose as skills: ${noteText}`,
    );
    assert(
      !generated.skillTexts.some((text) =>
        /storefronts used by kitchen|manifests reviewable|delivery pipeline|typescript services|mother tongue|a1 and a2|basic user|independent user|proficient user/i.test(
          text,
        ),
      ),
      `Skills and language lines should not include listing sentences or Europass chrome: ${generated.skillTexts.join(" | ")}`,
    );
    const hasPostgresAlias = generated.skillTexts.some((text) =>
      /postgres/i.test(text),
    );
    if (hasPostgresAlias) {
      assert(
        !generated.confirmNeeded.some((assessment) =>
          /^postgres$/i.test(assessment.text ?? ""),
        ),
        "Postgres should not need confirmation when the profile already has PostgreSQL.",
      );
    }

    await openResumeStudio(window);
    await captureStudio(window, "02-generated-studio.png");

    const confirmPanel = window.locator("[data-resume-claim-confirmations]");
    const tools = window.locator(
      "[data-resume-workspace-scroll-region]:visible",
    );
    if (await tools.count()) {
      await tools.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
    }
    await confirmPanel.waitFor({ state: "visible", timeout: 20_000 });
    await confirmPanel.scrollIntoViewIfNeeded();

    const studioText = await visibleStudioText(window);
    assert(
      /first interview/i.test(studioText),
      "Studio copy should name the first-interview purpose.",
    );
    assert(
      !FORBIDDEN_COPY.test(studioText),
      `Studio copy must not moralize: ${studioText.match(FORBIDDEN_COPY)?.[0]}`,
    );
    assert(
      await window
        .getByRole("heading", { name: /Skills the job asked for/i })
        .isVisible(),
      "Listing-asked skills should be grouped together.",
    );
    assert(
      await window.getByText("Terraform", { exact: true }).first().isVisible(),
      "Terraform should be visible as a listing-asked skill.",
    );
    assert(
      !/kept-omitted|Keep omitted/i.test(studioText),
      "Hidden-role copy should say leave-off, not kept-omitted.",
    );
    if (await window.getByText(/hidden role/i).count()) {
      assert(
        /Leave this role off|Review hidden roles|still export a PDF/i.test(
          studioText,
        ),
        "Hidden-role messaging should say what to do and that PDF export is still allowed.",
      );
    }

    await captureStudio(window, "03-confirmations-open.png");

    const reviewBlockedExport = window.getByRole("button", {
      name: /Review \d+ lines?|Review blocked claims|Review lines/i,
    });
    assert(
      await reviewBlockedExport.first().isVisible(),
      "Export should stay blocked behind confirmations or unsupported claims.",
    );
    await expectExportBlocked(window);

    const bulkConfirm = window.getByRole("button", {
      name: /Confirm all \d+ skills/i,
    });
    if (await bulkConfirm.count()) {
      await bulkConfirm.click();
    } else {
      const firstSkill = window.getByRole("button", {
        name: /Confirm this skill/i,
      });
      assert(
        await firstSkill.count(),
        "Expected at least one skill confirmation control.",
      );
      await firstSkill.first().click();
    }

    await waitForCondition(async () => {
      const after = await window.evaluate(
        (jobId) => window.nestor.jobFinder.getResumeWorkspace(jobId),
        JOB_ID,
      );
      return after.draft.claimConfirmations.length >= 1;
    }, "skill confirmations to persist");

    await captureStudio(window, "04-after-skill-confirm.png");

    const afterSkills = summarizeWorkspace(
      await window.evaluate(
        (jobId) => window.nestor.jobFinder.getResumeWorkspace(jobId),
        JOB_ID,
      ),
    );
    report.afterSkillConfirm = afterSkills;

    const wordingHeading = window.getByRole("heading", {
      name: /Wording that stretches saved evidence/i,
    });
    if (await wordingHeading.count()) {
      assert(
        await wordingHeading.first().isVisible(),
        "Experience stretches should stay in their own confirmation group.",
      );
      const confirmWording = window.getByRole("button", {
        name: /Confirm this wording/i,
      });
      while ((await confirmWording.count()) > 0) {
        const beforeCount = (
          await window.evaluate(
            (jobId) => window.nestor.jobFinder.getResumeWorkspace(jobId),
            JOB_ID,
          )
        ).draft.claimConfirmations.length;
        await confirmWording.first().click();
        await waitForCondition(async () => {
          const after = await window.evaluate(
            (jobId) => window.nestor.jobFinder.getResumeWorkspace(jobId),
            JOB_ID,
          );
          return after.draft.claimConfirmations.length > beforeCount;
        }, "wording confirmation to persist");
      }
    }

    const outstandingAfterConfirm = await countOutstandingClaims(window);
    report.outstandingAfterConfirm = outstandingAfterConfirm;
    if (outstandingAfterConfirm.unsupported > 0) {
      await expectExportBlocked(window);
      report.exportAfterSkillConfirm =
        "blocked by unsupported claims after confirmations";
    } else if (outstandingAfterConfirm.unconfirmed > 0) {
      await expectExportBlocked(window);
      report.exportAfterSkillConfirm =
        "blocked by remaining unconfirmed stretches";
    } else {
      report.exportAfterSkillConfirm =
        "unblocked after confirming every outstanding stretch";
    }

    await writeReport({ ok: true, ...report });
    process.stdout.write(
      `Aggressive tailoring drive passed. Report: ${path.join(outputDir, "report.json")}\n`,
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    await writeReport({ ok: false, ...report }).catch(() => undefined);
    throw error;
  } finally {
    if (app) {
      await app.close();
    }
    await rm(userDataDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function countOutstandingClaims(window: Page): Promise<{
  unconfirmed: number;
  unsupported: number;
}> {
  return window.evaluate(async (jobId) => {
    const workspace = await window.nestor.jobFinder.getResumeWorkspace(jobId);
    const assessments = workspace.validation?.claimAssessments ?? [];
    return {
      unconfirmed: assessments.filter((assessment) => {
        if (assessment.status !== "confirm_needed") {
          return false;
        }
        return !workspace.draft.claimConfirmations.some(
          (confirmation) =>
            confirmation.confirmedClaimContentHash === assessment.contentHash,
        );
      }).length,
      unsupported: assessments.filter(
        (assessment) => assessment.status === "unsupported",
      ).length,
    };
  }, JOB_ID);
}

async function expectExportBlocked(window: Page): Promise<void> {
  const failed = await window.evaluate(async (jobId) => {
    try {
      await window.nestor.jobFinder.exportResumePdf(jobId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, JOB_ID);
  assert(failed, "Export must stay blocked while stretches are unconfirmed.");
  assert(
    /still need your decision|confirmation/i.test(failed),
    `Unexpected export error: ${failed}`,
  );
}

test("imports the real resume and drives aggressive generation in an isolated desktop app", async () => {
  await main();
}, 600_000);
