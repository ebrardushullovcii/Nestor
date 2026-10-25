import { describe, expect, test } from "vitest";

import {
  defaultBenchmarkCases,
  runDesktopResumeImportBenchmark,
} from "./resume-import-benchmark";

describe("desktop resume import benchmark", () => {
  test(
    "scores dates, role-linked details, projects, certifications, languages, and contradictions",
    async () => {
      const benchmarkCase = defaultBenchmarkCases.find(
        (entry) => entry.id === "resume_import_comprehensive_txt",
      );
      expect(benchmarkCase).toBeDefined();

      const report = await runDesktopResumeImportBenchmark({
        benchmarkVersion: "034-comprehensive-import-v1",
        cases: [benchmarkCase!],
        useConfiguredAi: false,
        useVision: false,
      });

      expect(report.cases).toHaveLength(1);
      expect(report.cases[0]?.metrics).toMatchObject({
        experienceRecordF1: 1,
        experienceDetailAccuracy: 1,
        projectRecordF1: 1,
        certificationRecordF1: 1,
        languageRecordF1: 1,
        contradictionFreeRate: 1,
      });
      expect(report.cases[0]?.passed).toBe(true);
    },
    20_000,
  );
});
