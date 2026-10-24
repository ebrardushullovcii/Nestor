import type { JobFinderDiscoveryState, SavedJob } from "@nestor/contracts";
import { createInMemoryJobFinderRepository, type JobFinderRepository } from "@nestor/db";
import { copyView } from "@nestor/core";
import { describe, expect, test, vi } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  createDiscoverySavedJobWriter,
  markSupersedingDiscoveryUpdate,
} from "./discovery-saved-job-writer";

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
  test("plan and sighting patches preserve concurrent user and other-plan edits without reading a listing", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const original = (await repository.listSavedJobs())[0]!;
    const baseline = { ...original };
    const read = vi.fn(() => { throw new Error("Metadata persistence opened a listing"); });
    Object.defineProperty(baseline, "description", { enumerable: true, configurable: true, get: read });
    const commit = vi.fn<JobFinderRepository["commitSavedJobDelta"]>((input) => repository.commitSavedJobDelta(input));
    const merge = vi.fn((current: SavedJob) => current);
    const writer = createDiscoverySavedJobWriter({
      persistedJobs: [baseline], toStoredJob: (job) => job, merge, commit,
      persistDiscovery: (update) => repository.commitDiscoveryStateUpdate(update),
    });
    await repository.commitSavedJobDelta({ updateJobIds: [original.id], update: (job) => ({
      ...job, status: "shortlisted", planAssessments: { ...job.planAssessments, concurrent_plan: job.matchAssessment },
    }) });
    const intended = copyView(baseline, {
      lastSeenAt: "2026-10-24T00:00:00.000Z",
      firstSeenAt: null,
      planAssessments: { ...baseline.planAssessments, search_plan: baseline.matchAssessment },
    });
    writer.stage(intended);
    await writer.persist();
    const [input] = commit.mock.calls[0]!;
    expect(input.updateJobIds).toEqual([]);
    expect(input.update).toBeUndefined();
    expect(input.upserts).toEqual([]);
    expect(input.sightings).toEqual([{ id: original.id, firstSeenAt: null, lastSeenAt: intended.lastSeenAt }]);
    expect(input.planAssessments).toEqual([{ jobId: original.id, planId: "search_plan", assessment: original.matchAssessment }]);
    expect(merge).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const current = (await repository.listSavedJobsByIds([original.id]))[0]!;
    expect(current.status).toBe("shortlisted");
    expect(current.planAssessments?.search_plan).toEqual(original.matchAssessment);
    expect(current.planAssessments?.concurrent_plan).toEqual(original.matchAssessment);
    expect(current.firstSeenAt).toBeNull();
    expect(current.lastSeenAt).toBe(intended.lastSeenAt);
    expect(current.description).toBe(original.description);
    await writer.persist();
    expect(commit).toHaveBeenCalledTimes(1);
    await repository.close();
  });

  test("a failed metadata commit keeps its patch pending until the atomic retry succeeds", async () => {
    const baseline = createSeed().savedJobs[0]!;
    const commit = vi.fn<JobFinderRepository["commitSavedJobDelta"]>(async () => {});
    commit.mockRejectedValueOnce(new Error("metadata transaction failed"));
    const writer = createDiscoverySavedJobWriter({ persistedJobs: [baseline], toStoredJob: (job) => job, merge: (current) => current, commit, persistDiscovery: async () => {} });
    writer.stage(copyView(baseline, { planAssessments: { ...baseline.planAssessments, retry_plan: baseline.matchAssessment } }));
    await expect(writer.persist()).rejects.toThrow("metadata transaction failed");
    await writer.persist();
    expect(commit.mock.calls[1]?.[0].planAssessments).toEqual(commit.mock.calls[0]?.[0].planAssessments);
    expect(commit.mock.calls[1]?.[0].update).toBeUndefined();
    await writer.persist();
    expect(commit).toHaveBeenCalledTimes(2);
  });

  test("material fields and creating an empty plan map use the complete typed write", async () => {
    for (const change of [{ description: "Changed listing body" }, { planAssessments: {} }]) {
      const baseline = { ...createSeed().savedJobs[0]!, planAssessments: undefined };
      const commit = vi.fn<JobFinderRepository["commitSavedJobDelta"]>(async () => {});
      const writer = createDiscoverySavedJobWriter({ persistedJobs: [baseline], toStoredJob: (job) => job, merge: (current) => current, commit, persistDiscovery: async () => {} });
      writer.stage(copyView(baseline, change));
      await writer.persist();
      expect(commit.mock.calls[0]?.[0].updateJobIds).toEqual([baseline.id]);
      expect(commit.mock.calls[0]?.[0].planAssessments).toEqual([]);
      expect(commit.mock.calls[0]?.[0].sightings).toEqual([]);
    }
  });

  test("unchanged lazy detail versions are never opened to compare a checkpoint", async () => {
    const baseline = createSeed().savedJobs[0]!;
    const read = vi.fn(() => {
      throw new Error("Untouched body was opened");
    });
    Object.defineProperty(baseline, "description", {
      enumerable: true,
      configurable: true,
      get: read,
    });
    const intended = copyView(baseline, {});
    const commit = vi.fn<JobFinderRepository["commitSavedJobDelta"]>(
      async () => {},
    );
    const writer = createDiscoverySavedJobWriter({
      persistedJobs: [baseline],
      toStoredJob: (job) => job,
      merge: (current) => current,
      commit,
      persistDiscovery: async () => {},
    });
    writer.stage(intended);
    await writer.persist();
    expect(read).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
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

  test("saves asked for together share one write, applying the last whole-state update and what follows it", async () => {
    const template = createSeed().savedJobs[0]!;
    const written: SavedJob[][] = [];
    const applied: string[] = [];
    const commit = vi.fn<JobFinderRepository["commitSavedJobDelta"]>(
      (input) => {
        written.push([...(input.upserts ?? [])]);
        input.updateDiscoveryState?.({} as JobFinderDiscoveryState);
        return Promise.resolve();
      },
    );
    const writer = createDiscoverySavedJobWriter({
      persistedJobs: [],
      toStoredJob: (job) => job,
      merge: (current) => current,
      commit,
      persistDiscovery: () => Promise.resolve(),
      coalesce: true,
    });
    const step = (name: string) => (state: JobFinderDiscoveryState) => {
      applied.push(name);
      return state;
    };
    writer.stage({ ...template, id: "first_source_job" });
    const first = writer.persist(markSupersedingDiscoveryUpdate(step("first")));
    writer.stage({ ...template, id: "second_source_job" });
    const second = writer.persist(
      markSupersedingDiscoveryUpdate(step("second")),
    );
    const runOnly = writer.persist(step("run state"));
    await Promise.all([first, second, runOnly]);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(written[0]?.map((job) => job.id).sort()).toEqual([
      "first_source_job",
      "second_source_job",
    ]);
    expect(applied).toEqual(["second", "run state"]);
  });
});
