import { describe, expect, test } from "vitest";

import { createInMemoryJobFinderRepository } from "./index";
import type { JobFinderRepository } from "./repository-types";
import {
  cleanupTempDirectoryWithRetry,
  createSavedJob,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

async function expectCuratedIds(repository: JobFinderRepository) {
  const statuses = [
    "discovered",
    "archived",
    "drafting",
    "ready_for_review",
    "approved",
    "submitted",
  ] as const;
  await repository.commitSavedJobDelta({
    upserts: statuses.map((status) =>
      createSavedJob({
        id: `job_${status}`,
        sourceJobId: `source_${status}`,
        canonicalUrl: `https://jobs.example.com/roles/${status}`,
        status,
      }),
    ),
  });
  const ids = await repository.listCuratedSavedJobIds?.();
  expect(ids?.filter((id) => id.startsWith("job_"))).toEqual([
    "job_approved",
    "job_drafting",
    "job_ready_for_review",
    "job_submitted",
  ]);
}

describe("listCuratedSavedJobIds", () => {
  test("lists the jobs past Find jobs from the read index", async () => {
    const temp = await createTempRepository("nestor-db-curated-ids-");
    const repository = await temp.createRepository();
    try {
      await expectCuratedIds(repository);
    } finally {
      await repository.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 30_000);

  test("lists the same jobs in memory", async () => {
    await expectCuratedIds(
      createInMemoryJobFinderRepository({ ...createSeed(), savedJobs: [] }),
    );
  });
});
