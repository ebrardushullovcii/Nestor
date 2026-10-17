import type { SavedJob } from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import { describe, expect, test, vi } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import { createDiscoverySavedJobWriter } from "./discovery-saved-job-writer";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(size: number) {
  const template = createSeed().savedJobs[0]!;
  const jobs = Array.from(
    { length: size },
    (_, index): SavedJob => ({
      ...template,
      id: `scale_${index}`,
      description: `Synthetic listing ${index}: ${"job facts ".repeat(100)}`,
    }),
  );
  const rows = new Map(jobs.map((job) => [job.id, job]));
  const readIds: string[] = [];
  const upsertIds: string[] = [];
  const commit = vi.fn<JobFinderRepository["commitSavedJobDelta"]>((input) => {
    expect(input.updateJobIds).toBeDefined();
    for (const id of input.updateJobIds ?? []) {
      readIds.push(id);
      const current = rows.get(id);
      if (current && input.update) rows.set(id, input.update(current));
    }
    for (const job of input.upserts ?? []) {
      upsertIds.push(job.id);
      rows.set(job.id, job);
    }
    return Promise.resolve();
  });
  const toStoredJob = vi.fn((job: SavedJob) => ({ ...job }));
  const persistDiscovery = vi.fn(async () => {});
  // Field-delta merge makes loss of a concurrent unrelated edit observable.
  const merge = vi.fn(
    (current: SavedJob, baseline: SavedJob, intended: SavedJob) => ({
      ...current,
      ...(baseline.description !== intended.description
        ? { description: intended.description }
        : {}),
      ...(baseline.summary !== intended.summary
        ? { summary: intended.summary }
        : {}),
    }),
  );
  const writer = createDiscoverySavedJobWriter({
    persistedJobs: jobs,
    toStoredJob,
    merge,
    commit,
    persistDiscovery,
  });
  return {
    jobs,
    rows,
    readIds,
    upsertIds,
    commit,
    toStoredJob,
    persistDiscovery,
    writer,
    merge,
  };
}

describe("discovery saved-job checkpoint writer", () => {
  test.each([3_000, 10_000])(
    "only reads and copies touched rows with %i saved jobs",
    async (size) => {
      const h = harness(size);
      // Known persisted references are seeded once and incur no conversion.
      for (const job of h.jobs) h.writer.stage(job);
      await h.writer.persist();
      expect(h.toStoredJob).not.toHaveBeenCalled();
      expect(h.commit).not.toHaveBeenCalled();

      for (let checkpoint = 0; checkpoint < 12; checkpoint += 1) {
        const job = {
          ...h.jobs[checkpoint]!,
          description: `Checkpoint ${checkpoint}`,
        };
        h.writer.stage(job);
        await h.writer.persist((current) => current);
        // An unchanged repeat and the final pass neither copy nor reread it.
        h.writer.stage(job);
        await h.writer.persist();
      }
      const added = { ...h.jobs[0]!, id: "newly_kept" };
      h.writer.stage(added);
      await h.writer.persist();
      await h.writer.persist();

      expect(h.toStoredJob).toHaveBeenCalledTimes(13);
      expect(h.readIds).toEqual(h.jobs.slice(0, 12).map((job) => job.id));
      expect(h.upsertIds).toEqual([added.id]);
      expect(h.rows.size).toBe(size + 1);
      expect(h.persistDiscovery).not.toHaveBeenCalled();
      for (let index = 12; index < size; index += 1) {
        expect(h.rows.get(h.jobs[index]!.id)).toBe(h.jobs[index]);
      }
    },
  );

  test("equal reconstructed rows are considered once and do not cause an empty row commit", async () => {
    const h = harness(3_000);
    const equal = { ...h.jobs[0]! };
    h.writer.stage(equal);
    await h.writer.persist((current) => current);
    h.writer.stage(equal);
    await h.writer.persist();
    expect(h.toStoredJob).toHaveBeenCalledTimes(1);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.persistDiscovery).toHaveBeenCalledTimes(1);
  });

  test("a concurrent working edit remains pending and the next delta preserves a user edit", async () => {
    const h = harness(3_000);
    const started = deferred();
    const release = deferred();
    const commit = h.commit.getMockImplementation()!;
    h.commit.mockImplementationOnce(async (input) => {
      started.resolve();
      await release.promise;
      return commit(input);
    });
    const first = { ...h.jobs[0]!, description: "first checkpoint" };
    h.writer.stage(first);
    const firstCommit = h.writer.persist();
    await started.promise;
    const second = { ...first, summary: "later fit batch" };
    h.writer.stage(second);
    // A person changes another field while persistence is delayed.
    h.rows.set(first.id, { ...h.jobs[0]!, title: "Person corrected title" });
    const secondCommit = h.writer.persist();
    expect(h.commit).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([firstCommit, secondCommit]);
    expect(h.rows.get(first.id)).toMatchObject({
      description: "first checkpoint",
      summary: "later fit batch",
      title: "Person corrected title",
    });
    expect(h.merge.mock.calls[1]?.[1].description).toBe("first checkpoint");
    await h.writer.persist();
    expect(h.commit).toHaveBeenCalledTimes(2);
    expect(h.toStoredJob).toHaveBeenCalledTimes(2);
  });

  test("a failed atomic write retains its baseline and retries once", async () => {
    const h = harness(3_000);
    h.commit.mockRejectedValueOnce(new Error("failed atomic checkpoint"));
    const changed = { ...h.jobs[0]!, description: "retry checkpoint" };
    h.writer.stage(changed);
    await expect(h.writer.persist()).rejects.toThrow(
      "failed atomic checkpoint",
    );
    expect(h.rows.get(changed.id)).toBe(h.jobs[0]);
    await h.writer.persist();
    expect(h.rows.get(changed.id)?.description).toBe("retry checkpoint");
    await h.writer.persist();
    expect(h.commit).toHaveBeenCalledTimes(2);
  });

  test("rollback drops speculative new rows and restores only real working changes", async () => {
    const h = harness(3_000);
    const restored = { ...h.jobs[0]!, description: "earlier unsaved change" };
    const speculative = { ...restored, id: "failed_new_job" };
    h.writer.stage(restored);
    h.writer.stage(speculative);
    h.writer.restoreWorkingRows([restored, ...h.jobs.slice(1)]);
    await h.writer.persist();
    expect(h.upsertIds).toEqual([]);
    expect(h.readIds).toEqual([restored.id]);
    expect(h.toStoredJob).toHaveBeenCalledTimes(1);
  });
});
