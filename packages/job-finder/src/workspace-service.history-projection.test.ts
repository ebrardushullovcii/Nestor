import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, test, vi } from "vitest";
import { createFileJobFinderRepository } from "@nestor/db";
import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
} from "./workspace-service.test-support";
import { createHistoryScaleSeed } from "./workspace-service.history-projection.test-support";

afterEach(() => vi.restoreAllMocks());
test("synthetic scale employers do not inherit another company's domain evidence", async () => {
  const seed = createHistoryScaleSeed(3000);
  expect(new Set(seed.savedJobs.map((job) => job.company)).size).toBe(3000);
  expect(
    seed.savedJobs.every(
      (job, index) =>
        job.company === `Synthetic scale company ${index}` &&
        job.employerDomain === null &&
        job.employerWebsiteUrl === null &&
        new URL(job.canonicalUrl).hostname === "example.test",
    ),
  ).toBe(true);
  const jobsById = new Map(seed.savedJobs.map((job) => [job.id, job]));
  expect(
    seed.applicationRecords.every(
      (record) => record.company === jobsById.get(record.jobId)?.company,
    ),
  ).toBe(true);
  if (process.env.NESTOR_HISTORY_SEED_PATH) {
    const output = path.resolve(process.env.NESTOR_HISTORY_SEED_PATH);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(seed));
  }
});
for (const jobCount of [3000, 10000]) {
  test(`${jobCount} jobs and 1000 full documents/applications: 100 warm display refreshes never parse/clone unchanged history`, async () => {
    const seed = createHistoryScaleSeed(jobCount);
    const temp = await mkdtemp(path.join(os.tmpdir(), "nestor-history-scale-"));
    const repo = await createFileJobFinderRepository({
      filePath: path.join(temp, "workspace.sqlite"),
      seed,
    });
    try {
      const service = createJobFinderWorkspaceService({
        repository: repo,
        aiClient: createAiClient(),
        browserRuntime: createBrowserRuntime(),
        documentManager: createDocumentManager(),
      });
      if (!service.getWorkspaceProjection)
        throw new Error("Display projection missing.");
      const coldStart = performance.now();
      const first = await service.getWorkspaceProjection();
      const coldMs = performance.now() - coldStart;
      const parse = JSON.parse;
      const clone = globalThis.structuredClone;
      let bodyParses = 0;
      let bodyClones = 0;
      const bodyParseSites = new Map<string, string>();
      JSON.parse = (
        raw: string,
        ...args: Parameters<typeof JSON.parse> extends [string, ...infer Rest]
          ? Rest
          : never
      ) => {
        if (/NESTOR_SCALE_(DOCUMENT|APPLICATION|VISUAL)/.test(raw)) {
          bodyParses += 1;
          const kind = raw.includes('"sections"')
            ? "draft"
            : raw.includes('"events"')
              ? "record"
              : raw.includes('"contentText"')
                ? "asset"
                : raw.includes('"extractedText"')
                  ? "research"
                  : "evidence";
          if (!bodyParseSites.has(kind))
            bodyParseSites.set(kind, new Error().stack ?? "");
        }
        return parse(raw, ...args) as unknown;
      };
      globalThis.structuredClone = <T>(
        value: T,
        options?: StructuredSerializeOptions,
      ): T => {
        if (
          /NESTOR_SCALE_(DOCUMENT|APPLICATION|VISUAL)/.test(
            JSON.stringify(value),
          )
        )
          bodyClones += 1;
        return clone(value, options);
      };
      const fullReads = [
        "listTailoredAssets",
        "listResumeDrafts",
        "listResumeExportArtifacts",
        "listResumeResearchArtifacts",
        "listApplicationRecords",
        "listApplicationAttempts",
        "listApplyRuns",
        "listApplyJobResults",
      ] as const;
      const canonicalReads = fullReads.map((method) => vi.spyOn(repo, method));
      const warmStart = performance.now();
      try {
        for (let i = 0; i < 100; i++) {
          const current = await service.getWorkspaceProjection();
          for (const key of [
            "tailoredAssets",
            "resumeDrafts",
            "resumeExportArtifacts",
            "resumeResearchArtifacts",
            "applyRuns",
            "applyJobResults",
            "applicationRecords",
            "applicationAttempts",
          ] as const)
            expect(current[key]).toBe(first[key]);
          if (bodyParses > 0)
            console.info(
              "history-body-parse-sites",
              Object.fromEntries(bodyParseSites),
            );
          expect(bodyParses).toBe(0);
          expect(bodyClones).toBe(0);
          if (i % 20 === 0)
            console.info("history-warm-progress", {
              jobs: jobCount,
              refresh: i + 1,
              heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            });
        }
      } finally {
        JSON.parse = parse;
        globalThis.structuredClone = clone;
      }
      const warm100Ms = performance.now() - warmStart;
      expect(bodyParses).toBe(0);
      expect(bodyClones).toBe(0);
      for (const read of canonicalReads) {
        expect(read).not.toHaveBeenCalled();
        read.mockRestore();
      }
      await repo.upsertTailoredAsset({
        ...seed.tailoredAssets[25]!,
        contentText: "NESTOR_SCALE_DOCUMENT_BODY Changed row",
        updatedAt: "2026-10-13T11:00:00.000Z",
      });
      const changedParses = vi.spyOn(JSON, "parse");
      const changed = await service.getWorkspaceProjection();
      const changedBodyParses = changedParses.mock.calls.filter(
        ([raw]) =>
          typeof raw === "string" &&
          /NESTOR_SCALE_(DOCUMENT|APPLICATION|VISUAL)/.test(raw),
      ).length;
      changedParses.mockRestore();
      expect(changedBodyParses).toBe(1);
      expect(
        changed.tailoredAssets.filter(
          (row, i) => row !== first.tailoredAssets[i],
        ),
      ).toHaveLength(1);
      expect(changed.resumeDrafts).toBe(first.resumeDrafts);
      const canonical = await service.getWorkspaceSnapshot();
      expect(
        canonical.tailoredAssets.find((row) => row.id === "scale_asset_25")
          ?.contentText,
      ).toContain("Changed row");
      canonical.tailoredAssets[0]!.previewSections[0]!.lines.push(
        "Caller-owned canonical edit",
      );
      expect(
        (await repo.getTailoredAssetById(canonical.tailoredAssets[0]!.id))
          ?.previewSections[0]?.lines,
      ).not.toContain("Caller-owned canonical edit");
      console.info("workspace-history-projection-scale", {
        jobs: jobCount,
        fullDocuments: 1000,
        fullApplications: 1000,
        refreshes: 100,
        bodyParses,
        bodyClones,
        changedBodyParses,
        coldMs: +coldMs.toFixed(2),
        warm100Ms: +warm100Ms.toFixed(2),
        meanWarmMs: +(warm100Ms / 100).toFixed(2),
      });
    } finally {
      await repo.close();
      await rm(temp, { recursive: true, force: true });
    }
  }, 90000);
}
