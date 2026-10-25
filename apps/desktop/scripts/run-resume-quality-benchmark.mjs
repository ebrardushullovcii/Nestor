import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");

function readCliOption(flag) {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return null;
  }

  const value = process.argv[index + 1];

  if (!value || value.startsWith("--")) {
    return null;
  }

  return value;
}

const canaryOnly = process.argv.includes("--canary-only");
const useConfiguredAi = process.argv.includes("--use-configured-ai");
const caseIds = process.argv
  .flatMap((entry, index, argv) => {
    if (entry === "--case-id" || entry === "--case") {
      return argv[index + 1] ? [argv[index + 1]] : [];
    }

    if (entry.startsWith("--case-id=")) {
      return [entry.slice("--case-id=".length)];
    }

    if (entry.startsWith("--case=")) {
      return [entry.slice("--case=".length)];
    }

    return [];
  })
  .flatMap((entry) => entry.split(","))
  .map((entry) => entry.trim())
  .filter(Boolean);
const templateIds = process.argv
  .flatMap((entry, index, argv) => {
    if (entry === "--template-id" || entry === "--template") {
      return argv[index + 1] ? [argv[index + 1]] : [];
    }

    if (entry.startsWith("--template-id=")) {
      return [entry.slice("--template-id=".length)];
    }

    if (entry.startsWith("--template=")) {
      return [entry.slice("--template=".length)];
    }

    return [];
  })
  .flatMap((entry) => entry.split(","))
  .map((entry) => entry.trim())
  .filter(Boolean);
const benchmarkVersion =
  readCliOption("--benchmark-version") ??
  process.env.UI_RESUME_QUALITY_BENCHMARK_VERSION ??
  "023-local-benchmark-v1";
const runLabel =
  readCliOption("--label") ??
  process.env.UI_CAPTURE_LABEL ??
  "resume-quality-benchmark";
const outputDir = path.join(
  desktopDir,
  "test-artifacts",
  "ui",
  runLabel,
  benchmarkVersion,
);

async function main() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  let userDataDirectory = null;
  let app = null;

  try {
    userDataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-resume-quality-"),
    );
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_USER_DATA_DIR: userDataDirectory,
        ...(useConfiguredAi ? {} : { NESTOR_AI_API_KEY: "" }),
      },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder.test),
      undefined,
      { timeout: 15000 },
    );

    const report = await window.evaluate(
      async ({
        benchmarkVersion,
        canaryOnly,
        caseIds,
        templateIds,
        outputDir,
        useConfiguredAi,
      }) => {
        if (!window.nestor.jobFinder.test) {
          throw new Error(
            "Desktop test API is not available in the renderer context.",
          );
        }

        return window.nestor.jobFinder.test.runResumeQualityBenchmark({
          benchmarkVersion,
          canaryOnly,
          caseIds,
          templateIds,
          useConfiguredAi,
          persistArtifactsDirectory: outputDir,
        });
      },
      {
        benchmarkVersion,
        canaryOnly,
        caseIds,
        templateIds,
        outputDir,
        useConfiguredAi,
      },
    );

    const reportPath = path.join(
      outputDir,
      "resume-quality-benchmark-report.json",
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    process.stdout.write(
      `Saved resume quality benchmark report to ${reportPath}\n`,
    );
    process.stdout.write(
      `Aggregate grounded visible skill rate: ${report.aggregate.groundedVisibleSkillRate.toFixed(3)} | ATS render pass rate: ${report.aggregate.atsRenderPassRate.toFixed(3)}\n`,
    );
    process.stdout.write(
      `Aggregate keyword coverage: ${report.aggregate.keywordCoverageRate.toFixed(3)} | issue-free case rate: ${report.aggregate.issueFreeCaseRate.toFixed(3)}\n`,
    );
    process.stdout.write(
      `Aggregate work-history representation: ${report.aggregate.workHistoryRepresentationRate.toFixed(3)} | fragment-free experience bullets: ${report.aggregate.fragmentFreeExperienceBulletRate.toFixed(3)} | professional experience summaries: ${report.aggregate.professionalExperienceSummaryRate.toFixed(3)}\n`,
    );
    const generatedCases = report.cases.filter(
      (entry) => entry.generationDiagnostics !== null,
    );
    const averageGenerationMs =
      report.cases.reduce(
        (total, entry) => total + entry.generationDurationMs,
        0,
      ) / Math.max(report.cases.length, 1);
    const acceptedRewrites = generatedCases.reduce(
      (total, entry) =>
        total + (entry.generationDiagnostics?.acceptedRewriteCount ?? 0),
      0,
    );
    const rejectedRewrites = generatedCases.reduce(
      (total, entry) =>
        total + (entry.generationDiagnostics?.rejectedRewriteCount ?? 0),
      0,
    );
    process.stdout.write(
      `Provider mode: ${report.providerMode} | average generation: ${Math.round(averageGenerationMs)} ms | accepted/rejected evidence-linked rewrites: ${acceptedRewrites}/${rejectedRewrites}\n`,
    );

    const failedCases = report.cases.filter((entry) => !entry.passed);
    if (failedCases.length > 0) {
      const failedLabels = failedCases
        .slice(0, 12)
        .map((entry) => `${entry.caseId}/${entry.templateId}`)
        .join(", ");
      const omittedCount =
        failedCases.length - Math.min(failedCases.length, 12);
      const omittedSuffix =
        omittedCount > 0 ? `, and ${omittedCount} more` : "";

      throw new Error(
        `Resume quality benchmark failed ${failedCases.length} required case/template result(s): ${failedLabels}${omittedSuffix}.`,
      );
    }
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // Preserve the original failure and continue cleanup.
      }
    }

    if (userDataDirectory) {
      await rm(userDataDirectory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
