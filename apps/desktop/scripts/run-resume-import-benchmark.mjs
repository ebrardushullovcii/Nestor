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

  return process.argv[index + 1] ?? null;
}

const canaryOnly = process.argv.includes("--canary-only");
const useConfiguredAi = process.argv.includes("--use-configured-ai");
const useVision = process.argv.includes("--use-vision");
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
const benchmarkVersion =
  readCliOption("--benchmark-version") ??
  process.env.UI_RESUME_IMPORT_BENCHMARK_VERSION ??
  "019-local-benchmark-v1";
const runLabel =
  readCliOption("--label") ??
  process.env.UI_CAPTURE_LABEL ??
  "resume-import-benchmark";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);

async function main() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-resume-benchmark-"),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_USER_DATA_DIR: userDataDirectory,
      ...(useConfiguredAi ? {} : { NESTOR_AI_API_KEY: "" }),
    },
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test?.runResumeImportBenchmark),
      undefined,
      { timeout: 15000 },
    );

    const report = await window.evaluate(
      async ({
        benchmarkVersion,
        canaryOnly,
        useConfiguredAi,
        useVision,
        caseIds,
      }) => {
        if (!window.nestor.jobFinder.test) {
          throw new Error(
            "Desktop test API is not available in the renderer context.",
          );
        }

        const defaultCases =
          await window.nestor.jobFinder.test.getResumeImportBenchmarkCases();
        const selectedCases =
          caseIds.length > 0
            ? defaultCases.filter((entry) => caseIds.includes(entry.id))
            : [];

        const validIds = new Set(defaultCases.map((entry) => entry.id));
        const missingIds = caseIds.filter((id) => !validIds.has(id));
        if (missingIds.length > 0) {
          throw new Error(
            `Unknown resume import benchmark case id(s): ${missingIds.join(", ")}`,
          );
        }

        return window.nestor.jobFinder.test.runResumeImportBenchmark({
          benchmarkVersion,
          canaryOnly,
          useConfiguredAi,
          useVision,
          ...(selectedCases.length > 0 ? { cases: selectedCases } : {}),
        });
      },
      { benchmarkVersion, canaryOnly, useConfiguredAi, useVision, caseIds },
    );

    const reportPath = path.join(
      outputDir,
      "resume-import-benchmark-report.json",
    );
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const parserManifestVersions = Array.isArray(report.parserManifestVersions)
      ? report.parserManifestVersions
      : [];

    process.stdout.write(
      `Saved resume import benchmark report to ${reportPath}\n`,
    );
    process.stdout.write(
      `Aggregate literal recall: ${report.aggregate.literalFieldRecall.toFixed(3)} | auto-apply precision: ${report.aggregate.autoApplyPrecision.toFixed(3)}\n`,
    );
    process.stdout.write(
      `Parser manifest summary: ${report.parserManifestVersion ?? "none"}${parserManifestVersions.length > 0 ? ` | manifests: ${parserManifestVersions.join(", ")}` : ""}\n`,
    );
  } finally {
    await app.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

void main();
