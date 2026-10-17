import type { CandidateProfile } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

async function expectCommitProfileUpdateParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    const observedProfiles: CandidateProfile[] = [];
    await repository.commitProfileUpdate((current) => {
      observedProfiles.push(current);
      return {
        ...current,
        answerBank: {
          ...current.answerBank,
          salaryExpectations: "$180k",
        },
      };
    });

    expect(observedProfiles).toHaveLength(1);
    expect(observedProfiles[0]?.headline).toBe(createSeed().profile.headline);

    const updated = await repository.getProfile();
    expect(updated.answerBank.salaryExpectations).toBe("$180k");
    expect(updated.fullName).toBe("Alex Vanguard");
    expect(updated.yearsExperience).toBe(10);
    expect(updated.answerBank.customAnswers).toEqual([]);

    await expect(
      repository.commitProfileUpdate(() => {
        throw new Error("updater failed");
      }),
    ).rejects.toThrow("updater failed");
    expect(await repository.getProfile()).toEqual(updated);

    await expect(
      repository.commitProfileUpdate(
        (current) =>
          ({ ...current, yearsExperience: -1 }) as unknown as CandidateProfile,
      ),
    ).rejects.toThrow();
    expect(await repository.getProfile()).toEqual(updated);
  } finally {
    await repository.close();
  }
}

describe("commitProfileUpdate", () => {
  test("in-memory repository applies updater output atomically", async () => {
    await expectCommitProfileUpdateParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );
  });

  test("file repository applies updater output atomically", async () => {
    const temp = await createTempRepository("nestor-db-profile-update-");
    try {
      await expectCommitProfileUpdateParity(() => temp.createRepository());
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});
