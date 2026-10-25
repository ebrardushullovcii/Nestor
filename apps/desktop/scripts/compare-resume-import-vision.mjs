import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");

const benchmarkCases = [
  {
    id: "resume_import_sample_txt",
    label: "Deterministic text canary",
    resumePath:
      "apps/desktop/test-fixtures/job-finder/resume-import-sample.txt",
    expected: {
      literalFields: {
        fullName: "Jamie Rivers",
        currentLocation: "Berlin, Germany",
        email: "jamie@example.com",
        phone: "+49 555 0000000",
      },
      experienceRecords: [
        { title: "Staff Frontend Engineer", companyName: "Signal Systems" },
      ],
      educationRecords: [],
    },
  },
  {
    id: "persona_priya_pdf",
    label: "Priya, product designer (pdf)",
    resumePath:
      "apps/desktop/test-fixtures/job-finder/resume-import-personas/priya-raman.pdf",
    expected: {
      literalFields: {
        fullName: "Priya Raman",
        currentLocation: "London, UK",
        email: "priya.raman@example.com",
        phone: "+44 20 7946 0958",
      },
      experienceRecords: [
        { title: "Freelance Product Designer", companyName: "Raman Studio" },
        { title: "Senior Product Designer", companyName: "Penny Bank" },
        { title: "Product Designer", companyName: "CareLoop Health" },
      ],
      educationRecords: [
        {
          schoolName: "Central Saint Martins",
          degree: "BA (Hons) Graphic Communication Design",
        },
      ],
    },
  },
  {
    id: "persona_dev_pdf",
    label: "Dev, backend engineer (pdf, wrapped lines)",
    resumePath:
      "apps/desktop/test-fixtures/job-finder/resume-import-personas/dev-castellano.pdf",
    expected: {
      literalFields: {
        fullName: "Dev Castellano",
        currentLocation: "Austin, TX",
        email: "dev.castellano@example.com",
        phone: "+1 512 555 0199",
      },
      experienceRecords: [
        {
          title: "Senior Software Engineer, Payments Platform",
          companyName: "Lattice Pay",
        },
        { title: "Software Engineer II", companyName: "Corvid Logistics" },
        { title: "Software Engineer", companyName: "Brightwater Labs" },
      ],
      educationRecords: [
        { schoolName: "Texas A&M University", degree: "B.S. Computer Science" },
      ],
    },
  },
];

function readCliOption(flag) {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return null;
  }

  return process.argv[index + 1] ?? null;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\s+/g, " ")
    : null;
}

function normalizeLoose(value) {
  return normalizeString(value)?.toLowerCase() ?? null;
}

function normalizeRecordValue(value) {
  return (
    normalizeLoose(value)
      ?.replace(/[–—]/g, "-")
      .replace(/\s+-\s*(?:\d{1,2}\/|\d{1,2}\/\d{4}|\d{4})\s*$/g, "")
      .replace(/\s+llc\b/g, " l.l.c")
      .replace(/\s+/g, " ")
      .trim() ?? null
  );
}

function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function recordIdentity(value, keys) {
  if (!value) {
    return null;
  }

  const parts = keys
    .map((key) => normalizeRecordValue(value[key]))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("|") : null;
}

function recordMatchesExpected(actual, expected, keys) {
  return keys.every((key) => {
    const expectedValue = normalizeRecordValue(expected[key]);
    const actualValue = normalizeRecordValue(actual[key]);

    if (!expectedValue) {
      return true;
    }

    return Boolean(
      actualValue &&
      (actualValue === expectedValue ||
        actualValue.includes(expectedValue) ||
        expectedValue.includes(actualValue)),
    );
  });
}

function collectRecordValues(candidates, section) {
  const candidateRecords = candidates
    .map((candidate) => toRecord(candidate.value))
    .filter(Boolean);
  const autoAppliedRecords = candidates
    .filter(
      (candidate) =>
        candidate.target.section === section &&
        candidate.resolution === "auto_applied" &&
        candidate.target.recordId,
    )
    .reduce((recordsById, candidate) => {
      const current = recordsById.get(candidate.target.recordId) ?? {};
      recordsById.set(candidate.target.recordId, {
        ...current,
        [candidate.target.key]: candidate.value,
      });
      return recordsById;
    }, new Map());

  return [...candidateRecords, ...autoAppliedRecords.values()];
}

function scoreRecordF1(expected, actual, keys) {
  if (expected.length === 0 && actual.length === 0) {
    return 1;
  }

  const expectedSet = new Set(
    expected.map((record) => recordIdentity(record, keys)).filter(Boolean),
  );
  const actualSet = new Set(
    actual.map((record) => recordIdentity(record, keys)).filter(Boolean),
  );

  if (expectedSet.size === 0 && actualSet.size === 0) {
    return 1;
  }

  const unmatchedExpected = new Set(expectedSet);
  const matchedActualIndexes = new Set();
  let truePositives = 0;

  for (const [index, actualValue] of actual.entries()) {
    const actualIdentity = recordIdentity(actualValue, keys);
    if (actualIdentity && unmatchedExpected.has(actualIdentity)) {
      truePositives += 1;
      unmatchedExpected.delete(actualIdentity);
      matchedActualIndexes.add(index);
      continue;
    }

    const actualParts = keys
      .map((key) => normalizeRecordValue(actualValue[key]))
      .filter(Boolean);
    const containedExpected = [...unmatchedExpected].find(
      (expectedIdentity) => {
        const expectedParts = expectedIdentity.split("|");
        return expectedParts.every((expectedPart) =>
          actualParts.some(
            (actualPart) =>
              actualPart === expectedPart ||
              actualPart.includes(expectedPart) ||
              expectedPart.includes(actualPart),
          ),
        );
      },
    );

    if (containedExpected) {
      truePositives += 1;
      unmatchedExpected.delete(containedExpected);
      matchedActualIndexes.add(index);
    }
  }

  for (const expectedValue of expected) {
    const expectedIdentity = recordIdentity(expectedValue, keys);
    if (!expectedIdentity || !unmatchedExpected.has(expectedIdentity)) {
      continue;
    }

    const matchingActualIndex = actual.findIndex(
      (actualValue, actualIndex) =>
        !matchedActualIndexes.has(actualIndex) &&
        recordMatchesExpected(actualValue, expectedValue, keys),
    );

    if (matchingActualIndex !== -1) {
      truePositives += 1;
      unmatchedExpected.delete(expectedIdentity);
      matchedActualIndexes.add(matchingActualIndex);
    }
  }

  const precision = actualSet.size > 0 ? truePositives / actualSet.size : 0;
  const recall = expectedSet.size > 0 ? truePositives / expectedSet.size : 0;

  return precision === 0 && recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
}

function scoreRun(expected, profile, candidates) {
  const actualByKey = {
    fullName: profile.fullName,
    currentLocation: profile.currentLocation,
    email: profile.email,
    phone: profile.phone,
  };
  const literalEntries = Object.entries(expected.literalFields);
  const literalMatches = literalEntries.filter(
    ([key, expectedValue]) =>
      normalizeLoose(actualByKey[key]) === normalizeLoose(expectedValue),
  ).length;
  const experienceCandidates = candidates.filter(
    (candidate) => candidate.target.section === "experience",
  );
  const educationCandidates = candidates.filter(
    (candidate) => candidate.target.section === "education",
  );
  const experienceRecords = [
    ...collectRecordValues(experienceCandidates, "experience"),
    ...(profile.experiences ?? []),
  ];
  const educationRecords = [
    ...collectRecordValues(educationCandidates, "education"),
    ...(profile.education ?? []),
  ];
  const autoApplied = candidates.filter(
    (candidate) => candidate.resolution === "auto_applied",
  );
  const autoCorrect = autoApplied.filter((candidate) => {
    const expectedValue = expected.literalFields[candidate.target.key];
    return (
      expectedValue === undefined ||
      normalizeLoose(candidate.value) === normalizeLoose(expectedValue)
    );
  }).length;

  return {
    literalFieldRecall: literalEntries.length
      ? literalMatches / literalEntries.length
      : 1,
    experienceRecordF1: scoreRecordF1(
      expected.experienceRecords,
      experienceRecords,
      ["title", "companyName"],
    ),
    educationRecordF1: scoreRecordF1(
      expected.educationRecords,
      educationRecords,
      ["schoolName", "degree"],
    ),
    autoApplyPrecision: autoApplied.length
      ? autoCorrect / autoApplied.length
      : 1,
    unresolvedRate: candidates.length
      ? candidates.filter(
          (candidate) =>
            candidate.resolution === "needs_review" ||
            candidate.resolution === "abstained",
        ).length / candidates.length
      : 0,
  };
}

function summarizeCandidates(candidates) {
  return candidates.map((candidate) => ({
    id: candidate.id,
    sourceKind: candidate.sourceKind,
    target: candidate.target,
    label: candidate.label,
    value: candidate.value,
    valuePreview: candidate.valuePreview,
    resolution: candidate.resolution,
    resolutionReason: candidate.resolutionReason,
    confidence: candidate.confidence,
    evidenceText: candidate.evidenceText,
    visualEvidence: candidate.visualEvidence,
    conflictChoices: candidate.conflictChoices,
    notes: candidate.notes,
  }));
}

function summarizeProfile(profile) {
  return {
    fullName: profile.fullName,
    headline: profile.headline,
    summary: profile.summary,
    currentLocation: profile.currentLocation,
    email: profile.email,
    phone: profile.phone,
    experiences: profile.experiences,
    education: profile.education,
    skills: profile.skills,
  };
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function parseCliNumber(flag, fallback) {
  const raw = readCliOption(flag);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findRunById(state, runId) {
  return state.resumeImportRuns.find((run) => run.id === runId) ?? null;
}

function isSettledBranchStatus(status) {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "skipped"
  );
}

function isRunReadyForScoring(run) {
  const visionStatus = run?.modelRoles?.vision?.status;

  if (visionStatus && !isSettledBranchStatus(visionStatus)) {
    return false;
  }

  return run.status !== "extracting" && run.status !== "reconciling";
}

async function getResumeImportState(window) {
  return window.evaluate(() =>
    window.nestor.jobFinder.test.getResumeImportState(),
  );
}

async function getWorkspaceSnapshot(window) {
  return window.evaluate(() => window.nestor.jobFinder.getWorkspace());
}

async function waitForResumeImportReadyForScoring(window, runId, timeoutMs) {
  const startedAt = Date.now();
  let lastRun = null;
  let lastState = null;

  while (Date.now() - startedAt <= timeoutMs) {
    lastState = await getResumeImportState(window);
    lastRun = findRunById(lastState, runId);

    if (!lastRun) {
      throw new Error(
        `Resume import run ${runId} disappeared while waiting for scoring readiness.`,
      );
    }

    if (isRunReadyForScoring(lastRun)) {
      return {
        state: lastState,
        run: lastRun,
        waitedMs: Date.now() - startedAt,
      };
    }

    await delay(2_000);
  }

  const status = lastRun?.modelRoles?.vision?.status ?? "unknown";
  throw new Error(
    `Resume import run ${runId} did not become ready for scoring within ${timeoutMs}ms; latest vision status was ${status}.`,
  );
}

function metricDelta(normal, omni, key) {
  if (!normal.metrics || !omni.metrics) {
    return null;
  }

  return omni.metrics[key] - normal.metrics[key];
}

function averageMetric(results, mode, key) {
  const values = results
    .map((entry) => entry[mode].metrics?.[key])
    .filter((value) => typeof value === "number");
  return values.length ? average(values) : null;
}

function averageOptional(values) {
  const numericValues = values.filter((value) => typeof value === "number");
  return numericValues.length ? average(numericValues) : null;
}

function replaceWorkspaceForFreshImport(snapshot) {
  return {
    ...snapshot,
    profile: {
      ...snapshot.profile,
      id: "candidate_fresh_start",
      firstName: "New",
      lastName: "Candidate",
      middleName: null,
      fullName: "New Candidate",
      preferredDisplayName: null,
      headline: "Import your resume to begin",
      summary:
        "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
      currentLocation: "Set your preferred location",
      currentCity: null,
      currentRegion: null,
      currentCountry: null,
      timeZone: null,
      yearsExperience: 0,
      email: null,
      secondaryEmail: null,
      phone: null,
      portfolioUrl: null,
      linkedinUrl: null,
      githubUrl: null,
      personalWebsiteUrl: null,
      skillGroups: {
        coreSkills: [],
        tools: [],
        languagesAndFrameworks: [],
        softSkills: [],
        highlightedSkills: [],
      },
      targetRoles: [],
      locations: [],
      skills: [],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
      baseResume: {
        id: "resume_fresh_start",
        fileName: "No resume imported yet",
        uploadedAt: new Date(0).toISOString(),
        storagePath: null,
        textContent: null,
        textUpdatedAt: null,
        extractionStatus: "needs_text",
        lastAnalyzedAt: null,
        analysisProviderKind: null,
        analysisProviderLabel: null,
        analysisWarnings: [],
      },
    },
    searchPreferences: {
      ...snapshot.searchPreferences,
      targetRoles: [],
      jobFamilies: [],
      locations: [],
      excludedLocations: [],
      workModes: [],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      companyBlacklist: [],
      companyWhitelist: [],
    },
  };
}

function formatMetric(value) {
  return typeof value === "number" ? value.toFixed(3) : "n/a";
}

function summarizeCandidateCounts(candidates) {
  return {
    total: candidates.length,
    vision: candidates.filter(
      (candidate) => candidate.sourceKind === "vision_omni",
    ).length,
    text: candidates.filter(
      (candidate) => candidate.sourceKind !== "vision_omni",
    ).length,
    autoApplied: candidates.filter(
      (candidate) => candidate.resolution === "auto_applied",
    ).length,
    needsReview: candidates.filter(
      (candidate) => candidate.resolution === "needs_review",
    ).length,
    abstained: candidates.filter(
      (candidate) => candidate.resolution === "abstained",
    ).length,
    rejected: candidates.filter(
      (candidate) => candidate.resolution === "rejected",
    ).length,
  };
}

async function waitForAppReady(window) {
  await window.waitForLoadState("domcontentloaded");
  await Promise.any([
    window
      .getByRole("heading", { level: 1, name: "Your profile" })
      .waitFor({ timeout: 15000 }),
    window
      .getByRole("heading", { level: 1, name: "Guided setup" })
      .waitFor({ timeout: 15000 }),
  ]);
}

async function runImport(benchmarkCase, useVision, importTimeoutMs) {
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-resume-vision-compare-"),
  );
  const mode = useVision ? "omni" : "normal";
  const sourcePath = path.join(repoRoot, benchmarkCase.resumePath);
  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_TEST_API_USE_LIVE_AI: "1",
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  });

  try {
    const window = await app.firstWindow();
    await waitForAppReady(window);
    const initialSnapshot = await getWorkspaceSnapshot(window);
    await window.evaluate((state) => {
      if (!window.nestor.jobFinder.test) {
        throw new Error(
          "Desktop test API is not available in the renderer context.",
        );
      }

      return window.nestor.jobFinder.test.resetWorkspaceState(state);
    }, replaceWorkspaceForFreshImport(initialSnapshot));

    const startedAt = new Date().toISOString();
    const snapshot = await withTimeout(
      window.evaluate(
        (input) => {
          if (!window.nestor.jobFinder.test) {
            throw new Error(
              "Desktop test API is not available in the renderer context.",
            );
          }

          return window.nestor.jobFinder.test.importResumeFromPath(input);
        },
        { sourcePath, useVision },
      ),
      importTimeoutMs,
      `${benchmarkCase.id} ${mode} import`,
    );
    let state = await getResumeImportState(window);
    let latestRun = snapshot.latestResumeImportRun;
    let branchWaitMs = 0;

    if (latestRun) {
      const settled = await waitForResumeImportReadyForScoring(
        window,
        latestRun.id,
        importTimeoutMs,
      );
      state = settled.state;
      latestRun = settled.run;
      branchWaitMs = settled.waitedMs;
    }

    const finalSnapshot = await getWorkspaceSnapshot(window);
    const completedAt = new Date().toISOString();
    latestRun = finalSnapshot.latestResumeImportRun ?? latestRun;
    const candidates = latestRun
      ? state.resumeImportFieldCandidates.filter(
          (candidate) => candidate.runId === latestRun.id,
        )
      : [];

    return {
      mode,
      useVision,
      status: "completed",
      startedAt,
      completedAt,
      branchWaitMs,
      sourcePath,
      providerStatus: {
        text: finalSnapshot.agentProvider,
        vision: finalSnapshot.visionProvider,
      },
      profile: summarizeProfile(finalSnapshot.profile),
      latestResumeImportRun: latestRun,
      candidateCounts: summarizeCandidateCounts(candidates),
      candidates: summarizeCandidates(candidates),
      metrics: scoreRun(
        benchmarkCase.expected,
        finalSnapshot.profile,
        candidates,
      ),
    };
  } catch (error) {
    return {
      mode,
      useVision,
      status: "failed",
      startedAt: null,
      completedAt: new Date().toISOString(),
      branchWaitMs: null,
      sourcePath,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Resume import comparison run failed.",
      providerStatus: null,
      profile: null,
      latestResumeImportRun: null,
      candidateCounts: summarizeCandidateCounts([]),
      candidates: [],
      metrics: null,
    };
  } finally {
    await app.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const runLabel =
    readCliOption("--label") ?? "resume-import-vision-comparison";
  const importTimeoutMs = parseCliNumber("--import-timeout-ms", 780000);
  const selectedCaseIds = (
    readCliOption("--case-id") ??
    readCliOption("--case") ??
    ""
  )
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const selectedCases =
    selectedCaseIds.length > 0
      ? benchmarkCases.filter((entry) => selectedCaseIds.includes(entry.id))
      : benchmarkCases;
  const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);

  if (
    selectedCaseIds.length > 0 &&
    selectedCases.length !== selectedCaseIds.length
  ) {
    throw new Error(
      `Unknown case id(s): ${selectedCaseIds.filter((id) => !selectedCases.some((entry) => entry.id === id)).join(", ")}`,
    );
  }

  await mkdir(outputDir, { recursive: true });
  const results = [];
  for (const benchmarkCase of selectedCases) {
    process.stdout.write(`Running ${benchmarkCase.id} normal text import...\n`);
    const normal = await runImport(benchmarkCase, false, importTimeoutMs);
    process.stdout.write(
      `Running ${benchmarkCase.id} configured Omni import...\n`,
    );
    const omni = await runImport(benchmarkCase, true, importTimeoutMs);
    results.push({
      caseId: benchmarkCase.id,
      label: benchmarkCase.label,
      resumePath: benchmarkCase.resumePath,
      expected: benchmarkCase.expected,
      normal,
      omni,
      delta: {
        literalFieldRecall: metricDelta(normal, omni, "literalFieldRecall"),
        experienceRecordF1: metricDelta(normal, omni, "experienceRecordF1"),
        educationRecordF1: metricDelta(normal, omni, "educationRecordF1"),
        autoApplyPrecision: metricDelta(normal, omni, "autoApplyPrecision"),
        unresolvedRate: metricDelta(normal, omni, "unresolvedRate"),
      },
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    importTimeoutMs,
    cases: results,
    aggregate: {
      normal: {
        literalFieldRecall: averageMetric(
          results,
          "normal",
          "literalFieldRecall",
        ),
        experienceRecordF1: averageMetric(
          results,
          "normal",
          "experienceRecordF1",
        ),
        educationRecordF1: averageMetric(
          results,
          "normal",
          "educationRecordF1",
        ),
        autoApplyPrecision: averageMetric(
          results,
          "normal",
          "autoApplyPrecision",
        ),
        unresolvedRate: averageMetric(results, "normal", "unresolvedRate"),
      },
      omni: {
        literalFieldRecall: averageMetric(
          results,
          "omni",
          "literalFieldRecall",
        ),
        experienceRecordF1: averageMetric(
          results,
          "omni",
          "experienceRecordF1",
        ),
        educationRecordF1: averageMetric(results, "omni", "educationRecordF1"),
        autoApplyPrecision: averageMetric(
          results,
          "omni",
          "autoApplyPrecision",
        ),
        unresolvedRate: averageMetric(results, "omni", "unresolvedRate"),
      },
      delta: {
        literalFieldRecall: averageOptional(
          results.map((entry) => entry.delta.literalFieldRecall),
        ),
        experienceRecordF1: averageOptional(
          results.map((entry) => entry.delta.experienceRecordF1),
        ),
        educationRecordF1: averageOptional(
          results.map((entry) => entry.delta.educationRecordF1),
        ),
        autoApplyPrecision: averageOptional(
          results.map((entry) => entry.delta.autoApplyPrecision),
        ),
        unresolvedRate: averageOptional(
          results.map((entry) => entry.delta.unresolvedRate),
        ),
      },
    },
  };

  const reportPath = path.join(
    outputDir,
    "resume-import-vision-comparison-report.json",
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Saved resume import vision comparison report to ${reportPath}\n`,
  );
  process.stdout.write(
    `Normal literal recall: ${formatMetric(report.aggregate.normal.literalFieldRecall)} | Omni literal recall: ${formatMetric(report.aggregate.omni.literalFieldRecall)} | delta: ${formatMetric(report.aggregate.delta.literalFieldRecall)}\n`,
  );
  process.stdout.write(
    `Normal experience F1: ${formatMetric(report.aggregate.normal.experienceRecordF1)} | Omni experience F1: ${formatMetric(report.aggregate.omni.experienceRecordF1)} | delta: ${formatMetric(report.aggregate.delta.experienceRecordF1)}\n`,
  );
}

void main();
