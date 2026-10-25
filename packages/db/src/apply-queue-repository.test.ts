import type { ApplyQueue } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { createInMemoryJobFinderRepository } from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

const queue: ApplyQueue = {
  id: "queue_1",
  mode: "autonomous_submit",
  state: "paused",
  jobIds: ["job_1", "job_2", "job_3"],
  startedJobIds: ["job_1"],
  skipped: [{ jobId: "job_2", reason: "Its resume waits for your review." }],
  activeRunId: null,
  pausedReason: null,
  createdAt: "2026-10-23T12:00:00.000Z",
  updatedAt: "2026-10-23T12:30:00.000Z",
};

describe("apply queue persistence", () => {
  test("the file repository keeps the queue across a reopen and drops it on reset", async () => {
    const temp = await createTempRepository("nestor-apply-queue-");
    try {
      const first = await temp.createRepository();
      expect(await first.getApplyQueue()).toBeNull();
      await first.saveApplyQueue(queue);
      await first.close?.();

      const reopened = await temp.createRepository();
      expect(await reopened.getApplyQueue()).toEqual(queue);
      await reopened.reset(createSeed());
      expect(await reopened.getApplyQueue()).toBeNull();
      await reopened.saveApplyQueue(queue);
      await reopened.saveApplyQueue(null);
      expect(await reopened.getApplyQueue()).toBeNull();
      await reopened.close?.();
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("the in-memory repository matches", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    await repository.saveApplyQueue(queue);
    expect(await repository.getApplyQueue()).toEqual(queue);
    await repository.reset(createSeed());
    expect(await repository.getApplyQueue()).toBeNull();
  });
});
