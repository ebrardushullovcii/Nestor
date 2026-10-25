import {
  ApplicationRecordSchema,
  ProfileCopilotMessageSchema,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { createFileJobFinderRepository } from "./file-repository";
import {
  cleanupTempDirectoryWithRetry,
  createSavedJob,
  createTempRepository,
} from "./file-repository.test-support";
import { createInMemoryJobFinderRepository } from "./in-memory-repository";
import { createSeed } from "./test-fixtures";

const COLLECTION_SIZE = 5;

function createSavedJobs(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index.toString().padStart(5, "0");
    return createSavedJob({
      id: `scale_job_${ordinal}`,
      sourceJobId: `scale_source_job_${ordinal}`,
      canonicalUrl: `https://jobs.example.com/roles/scale-${ordinal}`,
      applicationUrl: `https://jobs.example.com/roles/scale-${ordinal}/apply`,
      title: `Senior Product Designer ${ordinal}`,
      company: `Scale Company ${index % 50}`,
    });
  });
}

function createProfileCopilotMessages(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index.toString().padStart(5, "0");
    return ProfileCopilotMessageSchema.parse({
      id: `profile_message_${ordinal}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Profile history entry ${ordinal}`,
      context: { surface: "general" },
      patchGroups: [],
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    });
  });
}

function createApplicationRecords(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index.toString().padStart(4, "0");
    return ApplicationRecordSchema.parse({
      id: `application_${ordinal}`,
      jobId: `job_${ordinal}`,
      title: `Role ${ordinal}`,
      company: `Company ${ordinal}`,
      status: "drafting",
      lastActionLabel: "Application prepared without submission",
      nextActionLabel: "Review final application",
      lastUpdatedAt: "2026-07-30T08:00:00.000Z",
      lastAttemptState: "paused",
    });
  });
}

type SavedJobListRepository = {
  listSavedJobs: (options?: {
    limit?: number;
    offset?: number;
  }) => Promise<readonly { id: string }[]>;
};

async function collectPagedSavedJobIds(
  repository: SavedJobListRepository,
  pageSize: number,
): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;

  while (true) {
    const page = await repository.listSavedJobs({
      limit: pageSize,
      offset,
    });
    if (page.length === 0) {
      break;
    }

    ids.push(...page.map((job) => job.id));
    offset += page.length;
    if (page.length < pageSize) {
      break;
    }
  }

  return ids;
}

describe("repository collection pagination and persistence", () => {
  test("keeps saved jobs and ordered history across singleton writes and restart", async () => {
    const temp = await createTempRepository("nestor-db-collection-scale-");
    const savedJobs = createSavedJobs(COLLECTION_SIZE);
    const profileCopilotMessages =
      createProfileCopilotMessages(COLLECTION_SIZE);
    const seed = {
      ...createSeed(),
      savedJobs,
      profileCopilotMessages,
    };
    const inMemoryRepository = createInMemoryJobFinderRepository(seed);
    let fileRepository = await createFileJobFinderRepository({
      filePath: temp.filePath,
      seed,
    });

    try {
      const expectedIds = savedJobs.map((job) => job.id);
      const fileIds = (await fileRepository.listSavedJobs()).map(
        (job) => job.id,
      );
      const memoryIds = (await inMemoryRepository.listSavedJobs()).map(
        (job) => job.id,
      );
      expect(fileIds).toEqual(expectedIds);
      expect(memoryIds).toEqual(expectedIds);

      expect(
        (await fileRepository.listSavedJobs({ limit: 2, offset: 2 })).map(
          (job) => job.id,
        ),
      ).toEqual(expectedIds.slice(2, 4));
      expect(
        (await fileRepository.listSavedJobs({ offset: 4 })).map(
          (job) => job.id,
        ),
      ).toEqual(expectedIds.slice(4));
      expect(
        (await inMemoryRepository.listSavedJobs({ limit: 2, offset: 2 })).map(
          (job) => job.id,
        ),
      ).toEqual(expectedIds.slice(2, 4));
      expect(
        (await inMemoryRepository.listSavedJobs({ offset: 4 })).map(
          (job) => job.id,
        ),
      ).toEqual(expectedIds.slice(4));

      for (const pageSize of [2, 5]) {
        const [filePagedIds, memoryPagedIds] = await Promise.all([
          collectPagedSavedJobIds(fileRepository, pageSize),
          collectPagedSavedJobIds(inMemoryRepository, pageSize),
        ]);
        expect(filePagedIds).toHaveLength(COLLECTION_SIZE);
        expect(memoryPagedIds).toHaveLength(COLLECTION_SIZE);
        expect(new Set(filePagedIds).size).toBe(COLLECTION_SIZE);
        expect(new Set(memoryPagedIds).size).toBe(COLLECTION_SIZE);
        expect(filePagedIds).toEqual(expectedIds);
        expect(memoryPagedIds).toEqual(expectedIds);
        expect(memoryPagedIds).toEqual(filePagedIds);
      }
      expect(
        await fileRepository.listSavedJobs({ limit: COLLECTION_SIZE }),
      ).toHaveLength(COLLECTION_SIZE);
      expect(
        await inMemoryRepository.listSavedJobs({
          limit: COLLECTION_SIZE,
        }),
      ).toHaveLength(COLLECTION_SIZE);

      const fileHistory = await fileRepository.listProfileCopilotMessages();
      const memoryHistory =
        await inMemoryRepository.listProfileCopilotMessages();
      expect(fileHistory).toHaveLength(COLLECTION_SIZE);
      expect(fileHistory[0]?.id).toBe("profile_message_00000");
      expect(fileHistory.at(-1)?.id).toBe("profile_message_00004");
      expect(memoryHistory).toEqual(fileHistory);

      await fileRepository.saveSettings({
        ...seed.settings,
        discoveryOnly: true,
      });
      await fileRepository.saveProfile({
        ...seed.profile,
        headline: "Updated without rewriting collections",
      });
      await fileRepository.saveSearchPreferences({
        ...seed.searchPreferences,
        targetRoles: ["Updated without rewriting collections"],
      });
      await fileRepository.saveProfileSetupState({
        ...seed.profileSetupState,
        lastResumedAt: "2026-08-20T12:00:00.000Z",
      });
      expect(await fileRepository.listSavedJobs()).toHaveLength(
        COLLECTION_SIZE,
      );

      await fileRepository.close();
      fileRepository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });
      expect(
        (await fileRepository.listSavedJobs()).map((job) => job.id),
      ).toEqual(expectedIds);
      expect(
        (await fileRepository.listProfileCopilotMessages()).at(-1)?.id,
      ).toBe("profile_message_00004");
    } finally {
      await fileRepository.close();
      await inMemoryRepository.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 30_000);

  test("application record batches preserve rows beyond the first 1,000", async () => {
    const temp = await createTempRepository("nestor-db-application-scale-");
    const applicationRecords = createApplicationRecords(1_001);
    const seed = { ...createSeed(), applicationRecords };
    let fileRepository = await createFileJobFinderRepository({
      filePath: temp.filePath,
      seed,
    });
    const inMemoryRepository = createInMemoryJobFinderRepository(seed);

    try {
      const first = applicationRecords[0];
      const last = applicationRecords[applicationRecords.length - 1];
      if (!first || !last) {
        throw new Error("Expected an application record fixture.");
      }
      const nextFirst = ApplicationRecordSchema.parse({
        ...first,
        lastUpdatedAt: "2026-07-30T08:05:00.000Z",
      });
      const nextLast = ApplicationRecordSchema.parse({
        ...last,
        lastUpdatedAt: "2026-07-30T08:10:00.000Z",
      });
      const expectedRevisions = [
        { applicationRecordId: first.id, expectedRevision: 0 },
        { applicationRecordId: last.id, expectedRevision: 0 },
      ];
      const unrelatedRecords = applicationRecords.filter(
        (record) => record.id !== first.id && record.id !== last.id,
      );

      await expect(
        fileRepository.commitApplicationRecordBatch({
          expectedRevisions,
          records: [nextFirst, nextLast],
        }),
      ).resolves.toEqual({
        status: "applied",
        // Only tracker fields merge: the newer Updated date comes along.
        committedRecords: [nextFirst, nextLast],
      });
      await expect(
        inMemoryRepository.commitApplicationRecordBatch({
          expectedRevisions,
          records: [nextFirst, nextLast],
        }),
      ).resolves.toEqual({
        status: "applied",
        // Only tracker fields merge: the newer Updated date comes along.
        committedRecords: [nextFirst, nextLast],
      });

      const fileRecords = await fileRepository.listApplicationRecords();
      const memoryRecords = await inMemoryRepository.listApplicationRecords();
      expect(fileRecords).toHaveLength(1_001);
      expect(memoryRecords).toEqual(fileRecords);
      expect(fileRecords.find((record) => record.id === first.id)).toEqual(
        nextFirst,
      );
      expect(fileRecords.find((record) => record.id === last.id)).toEqual(
        nextLast,
      );
      expect(
        fileRecords.filter(
          (record) => record.id !== first.id && record.id !== last.id,
        ),
      ).toEqual(unrelatedRecords);

      await fileRepository.close();
      fileRepository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });
      const reopenedRecords = await fileRepository.listApplicationRecords();
      expect(reopenedRecords).toHaveLength(1_001);
      expect(reopenedRecords.find((record) => record.id === first.id)).toEqual(
        nextFirst,
      );
      expect(reopenedRecords.find((record) => record.id === last.id)).toEqual(
        nextLast,
      );
      expect(
        reopenedRecords.filter(
          (record) => record.id !== first.id && record.id !== last.id,
        ),
      ).toEqual(unrelatedRecords);
    } finally {
      await fileRepository.close();
      await inMemoryRepository.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 30_000);

  test("row-local saved-job commits preserve concurrent changes instead of replaying stale collections", async () => {
    const temp = await createTempRepository("nestor-db-saved-job-delta-");
    const savedJobs = createSavedJobs(1_001);
    const seed = { ...createSeed(), savedJobs };
    let fileRepository = await createFileJobFinderRepository({
      filePath: temp.filePath,
      seed,
    });
    const inMemoryRepository = createInMemoryJobFinderRepository(seed);

    const exerciseConcurrentDeltas = async (
      repository: Pick<
        typeof fileRepository,
        "commitSavedJobDelta" | "listSavedJobs"
      >,
    ) => {
      await Promise.all([
        repository.commitSavedJobDelta({
          update: (job) =>
            job.id === "scale_job_00000"
              ? { ...job, title: "Title from the first writer" }
              : job,
        }),
        repository.commitSavedJobDelta({
          update: (job) =>
            job.id === "scale_job_00000"
              ? { ...job, company: "Company from the second writer" }
              : job,
        }),
        repository.commitSavedJobDelta({
          update: (job) =>
            job.id === "scale_job_01000"
              ? { ...job, status: "shortlisted" }
              : job,
        }),
      ]);

      const persistedJobs = await repository.listSavedJobs();
      const first = persistedJobs.find((job) => job.id === "scale_job_00000");
      const last = persistedJobs.find((job) => job.id === "scale_job_01000");
      expect(persistedJobs).toHaveLength(1_001);
      expect(first).toMatchObject({
        title: "Title from the first writer",
        company: "Company from the second writer",
      });
      expect(last?.status).toBe("shortlisted");
    };

    try {
      await exerciseConcurrentDeltas(fileRepository);
      await exerciseConcurrentDeltas(inMemoryRepository);

      await fileRepository.close();
      fileRepository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });
      const reopenedJobs = await fileRepository.listSavedJobs();
      expect(reopenedJobs).toHaveLength(1_001);
      expect(
        reopenedJobs.find((job) => job.id === "scale_job_00000"),
      ).toMatchObject({
        title: "Title from the first writer",
        company: "Company from the second writer",
      });
      expect(
        reopenedJobs.find((job) => job.id === "scale_job_01000")?.status,
      ).toBe("shortlisted");
    } finally {
      await fileRepository.close();
      await inMemoryRepository.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 30_000);
});
