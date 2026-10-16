import { DatabaseSync } from "node:sqlite";
import { DiscoveryRunRecordSchema, SavedJobSchema } from "@nordri/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  createSavedJob,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

async function fixture(storage: "memory" | "file") {
  const temp =
    storage === "file"
      ? await createTempRepository("nordri-current-promotion-")
      : null;
  const repo: JobFinderRepository = temp
    ? await temp.createRepository()
    : createInMemoryJobFinderRepository(createSeed());
  return {
    repo,
    temp,
    close: async () => {
      await repo.close();
      await temp?.cleanup();
    },
  };
}

async function promote(
  repo: JobFinderRepository,
  selectedIds: readonly string[],
) {
  const selected = new Set(selectedIds);
  await repo.commitSavedJobDelta({
    upsertsFromDiscovery: (current) =>
      current.pendingDiscoveryJobs
        .filter((job) => selected.has(job.id))
        .map((job) => ({ ...job, status: "shortlisted" })),
    updateJobIds: selectedIds,
    update: (job) =>
      selected.has(job.id) ? { ...job, status: "shortlisted" } : job,
    updateDiscoveryState: (current) => ({
      ...current,
      pendingDiscoveryJobs: current.pendingDiscoveryJobs.filter(
        (job) => !selected.has(job.id),
      ),
    }),
  });
}

for (const storage of ["memory", "file"] as const) {
  describe(`${storage} transaction-current pending promotion`, () => {
    test("borrowed factories share frozen pre-change state and preserve owned-factory precedence", async () => {
      const { repo, close } = await fixture(storage);
      try {
        const pending = createSavedJob({ id: "borrowed_pending" });
        await repo.commitDiscoveryStateUpdate((current) => ({ ...current, pendingDiscoveryJobs: [pending] }));
        let borrowed: unknown;
        await repo.commitSavedJobDelta({
          upsertsFromDiscovery: (current) => {
            current.pendingDiscoveryJobs[0]!.title = "Owned factory value";
            return current.pendingDiscoveryJobs;
          },
          upsertsFromBorrowedDiscovery: (current) => {
            borrowed = current;
            expect(current.pendingDiscoveryJobs[0]!.title).toBe(pending.title);
            expect(() => { current.pendingDiscoveryJobs[0]!.title = "Illegal write"; }).toThrow();
            expect(() => current.pendingDiscoveryJobs.push(pending)).toThrow();
            return [{ ...current.pendingDiscoveryJobs[0]!, title: "Borrowed factory value" }];
          },
          updateDiscoveryState: (current) => {
            expect(current).toBe(borrowed);
            return { ...current, pendingDiscoveryJobs: [] };
          },
        });
        expect((await repo.listSavedJobsByIds([pending.id]))[0]?.title).toBe("Borrowed factory value");
        const before = await repo.readDiscoveryDisplayProjection();
        await expect(repo.commitSavedJobDelta({
          upserts: [createSavedJob({ id: "failed_borrowed_job" })],
          upsertsFromBorrowedDiscovery: () => { throw new Error("borrowed rollback"); },
        })).rejects.toThrow("borrowed rollback");
        expect(await repo.listSavedJobsByIds(["failed_borrowed_job"])).toEqual([]);
        expect(await repo.readDiscoveryDisplayProjection()).toBe(before);
      } finally { await close(); }
    });

    test("a newer pending enrichment survives promotion while existing saved rows keep precedence", async () => {
      const { repo, temp, close } = await fixture(storage);
      const other = temp ? await temp.createRepository() : repo;
      try {
        const pending = createSavedJob({
          id: "pending",
          status: "discovered",
          description: "Captured old listing",
        });
        const stored = createSavedJob({
          id: "stored",
          description: "Saved listing must win",
        });
        await repo.commitSavedJobDelta({ upserts: [stored] });
        await repo.commitDiscoveryStateUpdate((current) => ({
          ...current,
          pendingDiscoveryJobs: [
            pending,
            { ...stored, description: "Pending duplicate must yield" },
          ],
        }));
        const captured = (await repo.getDiscoveryState())
          .pendingDiscoveryJobs[0]!;
        const enriched = SavedJobSchema.parse({
          ...pending,
          title: "New employer listing",
          description: "New full listing and provenance",
          applicationUrl: "https://employer.example.com/jobs/pending/apply",
          provenance: [
            {
              source: "target_site",
              targetId: "new_source",
              discoveryMethod: "agent_discovery",
              adapterKind: "auto",
              startingUrl: "https://employer.example.com/jobs",
              discoveredAt: "2026-10-13T10:00:00.000Z",
              canonicalUrl: "https://employer.example.com/jobs/pending",
              applicationUrl: "https://employer.example.com/jobs/pending/apply",
            },
          ],
        });
        await Promise.all([
          other.commitDiscoveryStateUpdate((current) => ({
            ...current,
            pendingDiscoveryJobs: [enriched, current.pendingDiscoveryJobs[1]!],
          })),
          promote(repo, [pending.id, stored.id]),
        ]);
        expect(captured.description).toBe("Captured old listing");
        expect(await repo.listSavedJobsByIds([pending.id])).toEqual([
          { ...enriched, status: "shortlisted" },
        ]);
        expect((await repo.listSavedJobsByIds([stored.id]))[0]).toEqual({
          ...stored,
          status: "shortlisted",
        });
        expect((await repo.getDiscoveryState()).pendingDiscoveryJobs).toEqual(
          [],
        );
      } finally {
        if (other !== repo) await other.close();
        await close();
      }
    });

    test("a pending row removed after selection is not resurrected", async () => {
      const { repo, close } = await fixture(storage);
      try {
        const pending = createSavedJob({
          id: "removed_pending",
          status: "discovered",
        });
        await repo.commitDiscoveryStateUpdate((current) => ({
          ...current,
          pendingDiscoveryJobs: [pending],
        }));
        const capturedIds = (
          await repo.getDiscoveryState()
        ).pendingDiscoveryJobs.map((job) => job.id);
        await repo.commitDiscoveryStateUpdate((current) => ({
          ...current,
          pendingDiscoveryJobs: [],
        }));
        await promote(repo, capturedIds);
        expect(await repo.listSavedJobsByIds(capturedIds)).toEqual([]);
      } finally {
        await close();
      }
    });

    test("invalid derived rows and failed paired removals leave rows, settings and cached projections unchanged", async () => {
      const { repo, close } = await fixture(storage);
      try {
        const pending = createSavedJob({
          id: "rollback_pending",
          status: "discovered",
        });
        await repo.commitDiscoveryStateUpdate((current) => ({
          ...current,
          pendingDiscoveryJobs: [pending],
        }));
        const beforeJobs = await repo.readSavedJobsProjection();
        const beforeDiscovery = await repo.readDiscoveryDisplayProjection();
        const beforeSettings = await repo.getSettings();
        await expect(
          repo.commitSavedJobDelta({
            upsertsFromDiscovery: () => [{ ...pending, id: "" }],
            updateSettings: (current) => ({
              ...current,
              appearanceTheme: "dark",
            }),
          }),
        ).rejects.toThrow();
        await expect(
          repo.commitSavedJobDelta({
            upsertsFromDiscovery: (current) => current.pendingDiscoveryJobs,
            updateSettings: (current) => ({
              ...current,
              appearanceTheme: "dark",
            }),
            updateDiscoveryState: () => {
              throw new Error("failed removal");
            },
          }),
        ).rejects.toThrow("failed removal");
        expect(await repo.readSavedJobsProjection()).toBe(beforeJobs);
        expect(await repo.readDiscoveryDisplayProjection()).toBe(
          beforeDiscovery,
        );
        expect(await repo.getSettings()).toEqual(beforeSettings);
        expect((await repo.getDiscoveryState()).pendingDiscoveryJobs).toEqual([
          pending,
        ]);
      } finally {
        await close();
      }
    });

    test("both callbacks receive the same pre-change discovery state in independent owned values", async () => {
      const { repo, close } = await fixture(storage);
      try {
        const pending = createSavedJob({
          id: "owned_pending",
          status: "discovered",
        });
        await repo.commitDiscoveryStateUpdate((current) => ({
          ...current,
          pendingDiscoveryJobs: [pending],
        }));
        const derive = vi.fn(
          (
            current: Awaited<
              ReturnType<JobFinderRepository["getDiscoveryState"]>
            >,
          ) => {
            current.pendingDiscoveryJobs[0]!.title = "Factory-owned mutation";
            return current.pendingDiscoveryJobs;
          },
        );
        const remove = vi.fn(
          (
            current: Awaited<
              ReturnType<JobFinderRepository["getDiscoveryState"]>
            >,
          ) => {
            expect(current.pendingDiscoveryJobs).toEqual([pending]);
            return { ...current, pendingDiscoveryJobs: [] };
          },
        );
        await repo.commitSavedJobDelta({
          upsertsFromDiscovery: derive,
          updateDiscoveryState: remove,
        });
        expect(derive).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
        expect((await repo.listSavedJobsByIds([pending.id]))[0]?.title).toBe(
          "Factory-owned mutation",
        );
      } finally {
        await close();
      }
    });
  });
}

test("targeted SQLite promotion never parses unrelated saved rows, and a saved-only delta never reads discovery", async () => {
  const { repo, temp, close } = await fixture("file");
  const other = new DatabaseSync(temp!.filePath);
  try {
    const pending = createSavedJob({
      id: "bounded_pending",
      status: "discovered",
    });
    const target = createSavedJob({ id: "target_saved" });
    await repo.commitSavedJobDelta({
      upserts: [target, createSavedJob({ id: "unrelated_saved" })],
    });
    await repo.commitDiscoveryStateUpdate((current) => ({
      ...current,
      pendingDiscoveryJobs: [pending],
    }));
    other
      .prepare(
        "UPDATE saved_jobs SET value='unreadable unrelated row' WHERE id=?",
      )
      .run("unrelated_saved");
    await promote(repo, [pending.id, target.id]);
    expect(
      (await repo.listSavedJobsByIds([pending.id, target.id])).map(
        (job) => job.status,
      ),
    ).toEqual(["shortlisted", "shortlisted"]);
    other.exec(
      "UPDATE singleton_state SET value='unreadable discovery state' WHERE key='discovery_state'",
    );
    await repo.commitSavedJobDelta({
      updateJobIds: [target.id],
      update: (job) => ({ ...job, status: "drafting" }),
    });
    expect((await repo.listSavedJobsByIds([target.id]))[0]?.status).toBe(
      "drafting",
    );
  } finally {
    other.close();
    await close();
  }
});

test("borrowed pending promotion does not clone or parse 25 MiB of canonical checkpoint history", async () => {
  const { repo, close } = await fixture("file");
  try {
    const pending = createSavedJob({ id: "small_promotion" });
    const historical = DiscoveryRunRecordSchema.parse({
      id: "large_history", state: "completed", scope: "run_all",
      startedAt: "2026-10-13T10:00:00.000Z", targetIds: ["synthetic_target"],
      targetExecutions: [{
        targetId: "synthetic_target", adapterKind: "auto", state: "completed",
        agentCheckpoint: {
          revision: 1, savedAt: "2026-10-13T10:00:00.000Z", stepCount: 1,
          currentUrl: "https://example.test/history", lastStableUrl: "https://example.test/history",
          visitedUrls: [], phaseEvidence: {},
          collectedJobs: [createSavedJob({ id: "large_checkpoint_job", description: "h".repeat(25 * 1024 * 1024) })],
        },
      }], activity: [], summary: { targetsPlanned: 1, outcome: "completed" },
    });
    await repo.commitDiscoveryStateUpdate((current) => ({ ...current, recentRuns: [historical], pendingDiscoveryJobs: [pending] }));
    const clone = vi.spyOn(globalThis, "structuredClone");
    const parse = vi.spyOn(JSON, "parse");
    await repo.commitSavedJobDelta({
      upsertsFromBorrowedDiscovery: (current) => current.pendingDiscoveryJobs,
      updateDiscoveryState: (current) => ({ ...current, pendingDiscoveryJobs: [] }),
    });
    expect(clone.mock.calls.some(([value]) => value !== null && typeof value === "object" && "recentRuns" in value)).toBe(false);
    expect(parse.mock.calls.some(([value]) => String(value).length >= 25 * 1024 * 1024)).toBe(false);
    console.info("25 MiB history pending promotion: 0 whole-discovery clones, 0 checkpoint-body parses");
    clone.mockRestore();
    parse.mockRestore();
    expect((await repo.listSavedJobsByIds([pending.id]))[0]).toEqual(pending);
    expect((await repo.getDiscoveryState()).recentRuns[0]?.targetExecutions[0]?.agentCheckpoint?.collectedJobs[0]?.description.length).toBe(25 * 1024 * 1024);
  } finally { vi.restoreAllMocks(); await close(); }
}, 30000);
