import type { JobFinderIntelligenceState } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

const expected = {
  companyId: "company_1",
  expectedCompanyUpdatedAt: "2026-08-20T10:00:00.000Z",
  jobId: null,
  applicationRecordId: null,
};

async function verifyCommitSemantics(repository: JobFinderRepository) {
  const before = await repository.getIntelligenceState();
  let calls = 0;
  let callbackValue: JobFinderIntelligenceState | null = null;
  const committed = await repository.commitCompanyIntelligenceUpdate(
    expected,
    (current) => {
      calls += 1;
      expect(current.savedJob).toBeNull();
      expect(current.applicationRecord).toBeNull();
      callbackValue = current.intelligenceState;
      return {
        ...current.intelligenceState,
        updatedAt: "2026-08-20T10:01:00.000Z",
      };
    },
  );

  expect(calls).toBe(1);
  expect(committed.updatedAt).toBe("2026-08-20T10:01:00.000Z");
  callbackValue!.updatedAt = "2026-08-20T10:02:00.000Z";
  committed.updatedAt = "2026-08-20T10:03:00.000Z";
  expect((await repository.getIntelligenceState()).updatedAt).toBe(
    "2026-08-20T10:01:00.000Z",
  );

  await expect(
    repository.commitCompanyIntelligenceUpdate(expected, () => {
      throw new Error("stop");
    }),
  ).rejects.toThrow("stop");
  expect((await repository.getIntelligenceState()).updatedAt).toBe(
    "2026-08-20T10:01:00.000Z",
  );

  await expect(
    repository.commitCompanyIntelligenceUpdate(
      expected,
      () => ({ companies: "invalid" }) as unknown as JobFinderIntelligenceState,
    ),
  ).rejects.toThrow();
  expect((await repository.getIntelligenceState()).updatedAt).toBe(
    "2026-08-20T10:01:00.000Z",
  );
  expect(before).not.toBe(callbackValue);
}

describe("commitCompanyIntelligenceUpdate", () => {
  test("has atomic clone and rollback semantics in memory", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    await verifyCommitSemantics(repository);
  });

  test("reads transaction-current intelligence after acquiring the SQLite write lock", async () => {
    const temp = await createTempRepository("nestor-company-intelligence-");
    let first: JobFinderRepository | null = null;
    let second: JobFinderRepository | null = null;
    try {
      first = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed: createSeed(),
      });
      second = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed: createSeed(),
      });
      const staleFirstRead = await first.getIntelligenceState();
      await second.saveIntelligenceState({
        ...(await second.getIntelligenceState()),
        rapidReviewLogs: [{ campaignId: "concurrent_campaign", entries: [] }],
        updatedAt: "2026-08-20T09:59:00.000Z",
      });
      let seenUpdatedAt: string | null = null;
      let seenConcurrentLog = false;
      await first.commitCompanyIntelligenceUpdate(expected, (current) => {
        seenUpdatedAt = current.intelligenceState.updatedAt;
        seenConcurrentLog = current.intelligenceState.rapidReviewLogs.some(
          (log) => log.campaignId === "concurrent_campaign",
        );
        return {
          ...current.intelligenceState,
          updatedAt: "2026-08-20T10:00:00.000Z",
        };
      });
      expect(staleFirstRead.updatedAt).not.toBe("2026-08-20T09:59:00.000Z");
      expect(seenUpdatedAt).toBe("2026-08-20T09:59:00.000Z");
      expect(seenConcurrentLog).toBe(true);
      expect(
        (await second.getIntelligenceState()).rapidReviewLogs.some(
          (log) => log.campaignId === "concurrent_campaign",
        ),
      ).toBe(true);
      await verifyCommitSemantics(first);
    } finally {
      await first?.close();
      await second?.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});
