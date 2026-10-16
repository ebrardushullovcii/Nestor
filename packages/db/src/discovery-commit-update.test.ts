import { DatabaseSync } from "node:sqlite";
import {
  DiscoveryLedgerEntrySchema,
  DiscoveryRunRecordSchema,
  SavedJobSchema,
} from "@nordri/contracts";
import type { JobFinderDiscoveryState } from "@nordri/contracts";
import { describe, expect, test } from "vitest";

import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createSavedJob,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

function createLedgerEntry(id: string) {
  return DiscoveryLedgerEntrySchema.parse({
    id,
    canonicalUrl: `https://jobs.example.com/roles/${id}`,
    source: "target_site",
    title: "Lead Designer",
    targetId: "target_primary",
    firstSeenAt: "2026-03-20T10:01:00.000Z",
    lastSeenAt: "2026-03-20T10:01:00.000Z",
  });
}

async function expectCommitDiscoveryStateUpdateParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    const observedStates: JobFinderDiscoveryState[] = [];
    const firstCommit = await repository.commitDiscoveryStateUpdate(
      (current) => {
        observedStates.push(current);
        return { ...current, runState: "running" };
      },
    );
    const secondCommit = await repository.commitDiscoveryStateUpdate(
      (current) => {
        observedStates.push(current);
        return { ...current, runState: "completed" };
      },
    );

    expect(observedStates).toHaveLength(2);
    expect(observedStates[0]).toEqual(createSeed().discovery);
    expect(observedStates[1]).toEqual(firstCommit);

    expect(secondCommit.runState).toBe("completed");
    expect(await repository.getDiscoveryState()).toEqual(secondCommit);

    await expect(
      repository.commitDiscoveryStateUpdate(() => {
        throw new Error("updater failed");
      }),
    ).rejects.toThrow("updater failed");
    expect(await repository.getDiscoveryState()).toEqual(secondCommit);

    await expect(
      repository.commitDiscoveryStateUpdate(
        (current) =>
          ({
            ...current,
            runState: "not-a-run-state",
          }) as unknown as JobFinderDiscoveryState,
      ),
    ).rejects.toThrow();
    expect(await repository.getDiscoveryState()).toEqual(secondCommit);

    await expect(
      repository.commitDiscoveryStateUpdate((current) => {
        // @ts-expect-error Exercise a caller that ignores the borrowed-state contract.
        current.runState = "cancelled";
        return {
          sessions: [],
          runState: "not-a-run-state",
        } as unknown as JobFinderDiscoveryState;
      }),
    ).rejects.toThrow();
    const afterMutationAttempt = await repository.getDiscoveryState();
    expect(afterMutationAttempt).toEqual(secondCommit);

    secondCommit.runState = "idle";
    expect((await repository.getDiscoveryState()).runState).toBe("completed");

    const resetSeed = createSeed();
    await repository.reset(resetSeed);
    expect(await repository.getDiscoveryState()).toEqual(resetSeed.discovery);
  } finally {
    await repository.close();
  }
}

async function expectPairedSavedJobDiscoveryDeltaParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    await repository.commitSavedJobDelta({
      upserts: [
        createSavedJob({ id: "job_paired", sourceJobId: "target_paired" }),
      ],
      updateDiscoveryState: (current) => ({
        ...current,
        runState: "running",
        discoveryLedger: [
          ...current.discoveryLedger,
          createLedgerEntry("entry_paired"),
        ],
      }),
    });

    expect((await repository.listSavedJobs()).map((job) => job.id)).toEqual([
      "job_paired",
    ]);
    const pairedDiscovery = await repository.getDiscoveryState();
    expect(pairedDiscovery.runState).toBe("running");
    expect(pairedDiscovery.discoveryLedger.map((entry) => entry.id)).toEqual([
      "entry_paired",
    ]);

    await repository.commitSavedJobDelta({
      update: (job) =>
        job.id === "job_paired" ? { ...job, status: "shortlisted" } : job,
    });
    await repository.commitDiscoveryStateUpdate((current) => ({
      ...current,
      pendingDiscoveryJobs: [
        createSavedJob({ id: "job_pending", sourceJobId: "target_pending" }),
      ],
    }));

    const orthogonals = await repository.listSavedJobs();
    expect(orthogonals).toHaveLength(1);
    expect(orthogonals[0]?.status).toBe("shortlisted");
    const afterOrthogonal = await repository.getDiscoveryState();
    expect(afterOrthogonal.discoveryLedger).toHaveLength(1);
    expect(afterOrthogonal.pendingDiscoveryJobs).toHaveLength(1);

    await repository.commitSavedJobDelta({
      update: (job) =>
        job.id === "job_paired" ? { ...job, status: "drafting" } : job,
      updateDiscoveryState: (current) => ({
        ...current,
        discoveryLedger: [
          ...current.discoveryLedger,
          createLedgerEntry("entry_paired_2"),
        ],
      }),
    });

    expect((await repository.listSavedJobs())[0]?.status).toBe("drafting");
    expect(
      (await repository.getDiscoveryState()).discoveryLedger.map(
        (entry) => entry.id,
      ),
    ).toEqual(["entry_paired", "entry_paired_2"]);

    await expect(
      repository.commitSavedJobDelta({
        upserts: [
          createSavedJob({
            id: "job_rollback",
            sourceJobId: "target_rollback",
          }),
        ],
        updateDiscoveryState: () => {
          throw new Error("paired updater failed");
        },
      }),
    ).rejects.toThrow("paired updater failed");

    await expect(
      repository.commitSavedJobDelta({
        upserts: [
          createSavedJob({ id: "job_invalid", sourceJobId: "target_invalid" }),
        ],
        updateDiscoveryState: (current) =>
          ({
            ...current,
            runState: "not-a-run-state",
          }) as unknown as JobFinderDiscoveryState,
      }),
    ).rejects.toThrow();

    expect((await repository.listSavedJobs()).map((job) => job.id)).toEqual([
      "job_paired",
    ]);
    const afterFailures = await repository.getDiscoveryState();
    expect(afterFailures.discoveryLedger.map((entry) => entry.id)).toEqual([
      "entry_paired",
      "entry_paired_2",
    ]);
  } finally {
    await repository.close();
  }
}

describe("commitDiscoveryStateUpdate", () => {
  test("in-memory repository applies updater output atomically", async () => {
    await expectCommitDiscoveryStateUpdateParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );
  });

  test("file repository applies updater output atomically", async () => {
    const temp = await createTempRepository("nordri-db-discovery-update-");
    try {
      await expectCommitDiscoveryStateUpdateParity(() =>
        temp.createRepository(),
      );
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

async function expectDiscoveryFeedbackAtomicity(
  repository: JobFinderRepository,
): Promise<void> {
  const job = createSavedJob();
  await repository.commitSavedJobDelta({ upserts: [job] });
  await repository.saveSearchPreferences({
    ...(await repository.getSearchPreferences()),
    excludedLocations: ["Concurrent preference"],
  });
  await repository.commitDiscoveryFeedbackUpdate(job.id, (current) => ({
    result: "committed",
    savedJob: SavedJobSchema.parse({
      ...current.job!,
      status: "archived",
      discoveryFeedback: {
        version: 1,
        revision: 1,
        reasons: ["company"],
        recordedAt: "2026-08-23T12:00:00.000Z",
        priorStatus: current.job!.status,
        employerExclusion: {
          normalizedCompanyName: "exact employer",
          displayCompanyName: "Exact Employer",
          addedByThisFeedback: true,
          campaignId: null,
        },
      },
    }),
    searchPreferences: {
      ...current.searchPreferences,
      companyBlacklist: [
        ...current.searchPreferences.companyBlacklist,
        "Exact Employer",
      ],
    },
    campaignState: current.campaignState,
    discoveryState: current.discoveryState,
  }));
  expect(await repository.getSearchPreferences()).toMatchObject({
    companyBlacklist: ["Exact Employer"],
    excludedLocations: ["Concurrent preference"],
  });
  expect(
    (await repository.listSavedJobs()).find((entry) => entry.id === job.id),
  ).toMatchObject({ status: "archived" });

  const beforePreferences = await repository.getSearchPreferences();
  const beforeJob = (await repository.listSavedJobs()).find(
    (entry) => entry.id === job.id,
  );
  await expect(
    repository.commitDiscoveryFeedbackUpdate(job.id, () => {
      throw new Error("stale identity");
    }),
  ).rejects.toThrow("stale identity");
  expect(await repository.getSearchPreferences()).toEqual(beforePreferences);
  expect(
    (await repository.listSavedJobs()).find((entry) => entry.id === job.id),
  ).toEqual(beforeJob);
}

describe("commitDiscoveryFeedbackUpdate", () => {
  test("in-memory repository commits feedback and current preferences atomically", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    try {
      await expectDiscoveryFeedbackAtomicity(repository);
    } finally {
      await repository.close();
    }
  });

  test("file repository commits feedback atomically and survives restart", async () => {
    const temp = await createTempRepository("nordri-db-feedback-atomic-");
    try {
      const first = await temp.createRepository();
      await expectDiscoveryFeedbackAtomicity(first);
      await first.close();
      const restarted = await temp.createRepository();
      try {
        expect(
          (await restarted.getSearchPreferences()).companyBlacklist,
        ).toEqual(["Exact Employer"]);
        expect(
          (await restarted.listSavedJobs()).some(
            (job) => job.status === "archived",
          ),
        ).toBe(true);
      } finally {
        await restarted.close();
      }
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

describe("commitSavedJobDelta paired discovery updates", () => {
  test("in-memory repository pairs saved-job and discovery mutations atomically", async () => {
    await expectPairedSavedJobDiscoveryDeltaParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );
  });

  test("file repository pairs saved-job and discovery mutations atomically", async () => {
    const temp = await createTempRepository("nordri-db-discovery-paired-");
    try {
      await expectPairedSavedJobDiscoveryDeltaParity(() =>
        temp.createRepository(),
      );
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

async function expectScopedSavedJobDeltaParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    await repository.commitSavedJobDelta({
      upserts: ["job_c", "job_a", "job_b"].map((id) =>
        createSavedJob({ id, sourceJobId: `target_${id}` }),
      ),
    });
    expect(await repository.listSavedJobIds()).toEqual([
      "job_a",
      "job_b",
      "job_c",
    ]);

    const updatedIds: string[] = [];
    await repository.commitSavedJobDelta({
      upserts: [
        createSavedJob({ id: "job_c", sourceJobId: "target_c_replaced" }),
        createSavedJob({ id: "job_d", sourceJobId: "target_d" }),
      ],
      updateJobIds: ["job_a"],
      update: (job) => {
        updatedIds.push(job.id);
        return job.id === "job_a" ? { ...job, status: "shortlisted" } : job;
      },
    });

    // Only the named row and the stored row an upsert names are read.
    expect(updatedIds.sort()).toEqual(["job_a", "job_c"]);
    const jobs = await repository.listSavedJobs();
    expect(jobs.map((job) => [job.id, job.status, job.sourceJobId])).toEqual([
      ["job_a", "shortlisted", "target_job_a"],
      ["job_b", "ready_for_review", "target_job_b"],
      // An upsert of a stored row still yields to the stored row.
      ["job_c", "ready_for_review", "target_job_c"],
      ["job_d", "ready_for_review", "target_d"],
    ]);
  } finally {
    await repository.close();
  }
}

describe("commitSavedJobDelta scoped updates", () => {
  test("in-memory repository updates only the named rows", async () => {
    await expectScopedSavedJobDeltaParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );
  });

  test("file repository updates only the named rows", async () => {
    const temp = await createTempRepository("nordri-db-scoped-delta-");
    try {
      await expectScopedSavedJobDeltaParity(() => temp.createRepository());
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

describe("file repository whole saved-job reads", () => {
  test("return every job in id order across parse chunks", async () => {
    const temp = await createTempRepository("nordri-db-chunked-read-");
    try {
      const repository = await temp.createRepository();
      try {
        const ids = Array.from(
          { length: 250 },
          (_, index) => `job_${String(index).padStart(3, "0")}`,
        );
        await repository.commitSavedJobDelta({
          upserts: [...ids]
            .reverse()
            .map((id) => createSavedJob({ id, sourceJobId: `target_${id}` })),
        });

        const jobs = await repository.listSavedJobs();
        expect(jobs.map((job) => job.id)).toEqual(ids);
        expect(await repository.listSavedJobIds()).toEqual(ids);
        expect(
          (await repository.listSavedJobsByIds(["job_200", "job_007"])).map(
            (job) => job.id,
          ),
        ).toEqual(["job_007", "job_200"]);
      } finally {
        await repository.close();
      }
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

describe("file repository cross-handle discovery concurrency", () => {
  test("two file handles preserve paired discovery and saved-job writes", async () => {
    const temp = await createTempRepository("nordri-db-discovery-handles-");
    try {
      const first = await temp.createRepository();
      const second = await temp.createRepository();
      try {
        for (let index = 0; index < 25; index += 1) {
          await first.commitDiscoveryStateUpdate((current) => ({
            ...current,
            runState: "running",
            discoveryLedger: [
              ...current.discoveryLedger,
              createLedgerEntry(`entry_first_${index}`),
            ],
          }));
          await second.commitSavedJobDelta({
            upserts: [
              createSavedJob({
                id: `job_second_${index}`,
                sourceJobId: `target_second_${index}`,
              }),
            ],
          });
        }

        expect((await first.getDiscoveryState()).discoveryLedger).toHaveLength(
          25,
        );
        expect(await first.listSavedJobs()).toHaveLength(25);
        expect((await second.getDiscoveryState()).discoveryLedger).toHaveLength(
          25,
        );
        expect(await second.listSavedJobs()).toHaveLength(25);

        await first.commitDiscoveryStateUpdate((current) => ({
          ...current,
          runState: "completed",
        }));
        await second.commitSavedJobDelta({
          update: (job) =>
            job.id === "job_second_24"
              ? { ...job, status: "shortlisted" }
              : job,
        });

        const finalFromFirst = await first.getDiscoveryState();
        expect(finalFromFirst.runState).toBe("completed");
        expect(finalFromFirst.discoveryLedger).toHaveLength(25);
        const jobsFromSecond = await second.listSavedJobs();
        expect(jobsFromSecond).toHaveLength(25);
        expect(
          jobsFromSecond.find((job) => job.id === "job_second_24")?.status,
        ).toBe("shortlisted");

        await first.commitSavedJobDelta({
          upserts: [
            createSavedJob({ id: "job_from_first", sourceJobId: "target_ff" }),
          ],
          updateDiscoveryState: (current) => ({
            ...current,
            discoveryLedger: [
              ...current.discoveryLedger,
              createLedgerEntry("entry_from_first"),
            ],
          }),
        });
        await second.commitDiscoveryStateUpdate((current) => ({
          ...current,
          recentRuns: [],
        }));

        const convergedDiscovery = await second.getDiscoveryState();
        expect(convergedDiscovery.runState).toBe("completed");
        expect(
          convergedDiscovery.discoveryLedger.map((entry) => entry.id),
        ).toContain("entry_from_first");
        expect((await first.listSavedJobs()).map((job) => job.id)).toContain(
          "job_from_first",
        );
      } finally {
        await first.close();
        await second.close();
      }
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("singleton revision increments only for applied discovery commits", async () => {
    const temp = await createTempRepository(
      "nordri-db-discovery-revision-",
    );
    try {
      const repository = await temp.createRepository();
      try {
        await repository.commitDiscoveryStateUpdate((current) => ({
          ...current,
          runState: "running",
        }));
        await repository.commitSavedJobDelta({
          upserts: [
            createSavedJob({
              id: "job_revision",
              sourceJobId: "target_revision",
            }),
          ],
          updateDiscoveryState: (current) => ({
            ...current,
            runState: "completed",
          }),
        });

        await expect(
          repository.commitDiscoveryStateUpdate(() => {
            throw new Error("updater failed");
          }),
        ).rejects.toThrow("updater failed");
        await expect(
          repository.commitSavedJobDelta({
            upserts: [
              createSavedJob({
                id: "job_revision_rollback",
                sourceJobId: "target_revision_rollback",
              }),
            ],
            updateDiscoveryState: (current) =>
              ({
                ...current,
                runState: "not-a-run-state",
              }) as unknown as JobFinderDiscoveryState,
          }),
        ).rejects.toThrow();

        expect((await repository.listSavedJobs()).map((job) => job.id)).toEqual(
          ["job_revision"],
        );
      } finally {
        await repository.close();
      }

      const database = new DatabaseSync(temp.filePath);
      try {
        const row = database
          .prepare(
            "SELECT revision FROM singleton_state WHERE key = 'discovery_state'",
          )
          .get() as { revision?: unknown };
        expect(Number(row.revision)).toBe(3);
      } finally {
        database.close();
      }
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

describe("incremental per-run discovery appends", () => {
  test("keeps each scored result the moment it lands and stays idempotent per run", async () => {
    // A quit mid-search used to discard everything a run had scored, because
    // results were only committed at the terminal commit. Appends are keyed
    // by the ledger identity, so replaying the same result changes nothing.
    const repository = createInMemoryJobFinderRepository(createSeed());
    const runId = "run_incremental";

    for (const index of [1, 2, 3]) {
      await repository.commitSavedJobDelta({
        upserts: [
          createSavedJob({
            id: `job_${index}`,
            sourceJobId: `target_${index}`,
          }),
        ],
        updateDiscoveryState: (current) => ({
          ...current,
          runState: "running",
          activeRun:
            current.activeRun && current.activeRun.id === runId
              ? current.activeRun
              : DiscoveryRunRecordSchema.parse({
                  id: runId,
                  campaignId: null,
                  state: "running",
                  runPhase: "in_progress",
                  scope: "run_all",
                  startedAt: "2026-03-20T10:00:00.000Z",
                  completedAt: null,
                  targetIds: [],
                  targetExecutions: [],
                  activity: [],
                  summary: {},
                }),
          discoveryLedger: [
            ...current.discoveryLedger.filter(
              (entry) => entry.id !== `ledger_${index}`,
            ),
            createLedgerEntry(`ledger_${index}`),
          ],
        }),
      });
    }

    const afterFirstPass = await repository.listSavedJobs();
    const seededIds = createSeed().savedJobs.map((job) => job.id);
    expect(
      afterFirstPass
        .map((job) => job.id)
        .filter((id) => !seededIds.includes(id)),
    ).toEqual(["job_1", "job_2", "job_3"]);
    expect((await repository.getDiscoveryState()).activeRun?.runPhase).toBe(
      "in_progress",
    );

    // Replaying the same appends after a restart adds nothing.
    await repository.commitSavedJobDelta({
      upserts: [createSavedJob({ id: "job_2", sourceJobId: "target_2" })],
      updateDiscoveryState: (current) => ({
        ...current,
        discoveryLedger: [
          ...current.discoveryLedger.filter(
            (entry) => entry.id !== "ledger_2",
          ),
          createLedgerEntry("ledger_2"),
        ],
      }),
    });

    expect((await repository.listSavedJobs()).length).toBe(
      afterFirstPass.length,
    );
    expect(
      (await repository.getDiscoveryState()).discoveryLedger.filter(
        (entry) => entry.id === "ledger_2",
      ).length,
    ).toBe(1);
  });
});
