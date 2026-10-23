import {
  JobPostingSchema,
  SavedJobSchema,
  type SavedJob,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import { mergeDiscoveredPostings } from "./matching";

test.each([3_000, 10_000])(
  "a one-posting checkpoint preserves %i untouched row references",
  (size) => {
    const seed = createSeed();
    const template = seed.savedJobs[0]!;
    const jobs = Array.from(
      { length: size },
      (_, index): SavedJob => ({
        ...template,
        id: `merge_scale_${index}`,
        sourceJobId: `merge_scale_${index}`,
        canonicalUrl: `https://example.com/scale/${index}`,
        applicationUrl: null,
        company: `Synthetic employer ${index}`,
        provenance: [],
      }),
    );
    const existing = jobs[0]!;
    const posting = JobPostingSchema.parse({
      ...existing,
      summary: "Updated checkpoint summary",
    });
    const parseSpy = vi.spyOn(SavedJobSchema, "parse");
    try {
      const result = mergeDiscoveredPostings(
        seed.profile,
        seed.searchPreferences,
        jobs,
        [posting],
        (job) => ({
          targetId: "scale_target",
          adapterKind: "auto",
          resolvedAdapterKind: "target_site",
          startingUrl: "https://example.com/scale",
          discoveredAt: job.discoveredAt,
          collectionMethod: job.collectionMethod,
          providerKey: job.providerKey,
          providerBoardToken: job.providerBoardToken,
          titleTriageOutcome: job.titleTriageOutcome,
        }),
        undefined,
        () => existing.matchAssessment,
        new Set([existing.id]),
      );
      expect(result.duplicatesMerged).toBe(1);
      expect(result.newJobs).toHaveLength(0);
      expect(result.mergedJobs[0]).not.toBe(existing);
      expect(result.mergedJobs[0]?.provenance).toHaveLength(1);
      // The merged row and its audit are checked where they are made; the
      // repository checks the row again when it is written.
      expect(parseSpy).toHaveBeenCalledTimes(2);
      for (let index = 1; index < size; index += 1) {
        expect(result.mergedJobs[index]).toBe(jobs[index]);
      }
    } finally {
      parseSpy.mockRestore();
    }
  },
);
