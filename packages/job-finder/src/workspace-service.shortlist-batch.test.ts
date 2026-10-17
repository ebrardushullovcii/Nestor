import { expect, test, vi } from "vitest";
import { SavedJobSchema } from "@nestor/contracts";
import type { ListingHtmlFetchResult } from "./internal/listing-detail-enrichment";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function batchSeed(count = 60) {
  const seed = createSeed();
  const base = seed.savedJobs[0]!;
  seed.savedJobs = Array.from({ length: count }, (_, index) =>
    SavedJobSchema.parse({
      ...base,
      id: `batch_${index}`,
      canonicalUrl: `https://jobs.example.test/${index}`,
      sourceJobId: String(index),
      status: "discovered",
      detailQuality: "card_only",
      listingDetailFetch: null,
    }),
  );
  return seed;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test("legacy single-job shortlisting blocks reset until its pending read finishes", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: batchSeed(2),
  });
  const selected = await repository.listSavedJobsByIds(["batch_0"]);
  const read = deferred<typeof selected>();
  vi.spyOn(repository, "listSavedJobsByIds").mockImplementationOnce(
    () => read.promise,
  );
  const pending = workspaceService.queueJobForReview("batch_0");
  await expect(workspaceService.resetWorkspace(batchSeed(1))).rejects.toThrow(
    "shortlisting jobs",
  );
  read.resolve(selected);
  await pending;
  expect((await repository.listSavedJobsByIds(["batch_0"]))[0]?.status).toBe(
    "drafting",
  );
});

test("shutdown during a shortlist read prevents its commit and later requests", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: batchSeed(2),
  });
  const selected = await repository.listSavedJobsByIds(["batch_0"]);
  const read = deferred<typeof selected>();
  vi.spyOn(repository, "listSavedJobsByIds").mockImplementationOnce(
    () => read.promise,
  );
  const commit = vi.spyOn(repository, "commitSavedJobDelta");
  const pending = workspaceService.queueJobsForReview!(["batch_0"]);
  const refused = expect(pending).rejects.toThrow("changed or closed");
  await workspaceService.shutdown();
  read.resolve(selected);
  await refused;
  expect(commit).not.toHaveBeenCalled();
  await expect(workspaceService.queueJobForReview("batch_0")).rejects.toThrow(
    "closing",
  );
});

test("saved-only listing reads update the selected row without rewriting discovery", async () => {
  const fetchListingHtml = vi.fn((url: string) =>
    Promise.resolve({
      status: 404,
      html: "",
      finalUrl: url,
    }),
  );
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: batchSeed(2),
    fetchListingHtml,
  });
  const commit = vi.spyOn(repository, "commitSavedJobDelta");
  await workspaceService.queueJobsForReview!(["batch_0"]);
  await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
  expect(
    commit.mock.calls.every(
      ([input]) => input.updateDiscoveryState === undefined,
    ),
  ).toBe(true);
  expect(commit.mock.calls[1]?.[0].updateJobIds).toEqual(["batch_0"]);
});

test("reset aborts listing reads and old successful responses cannot change reused job IDs", async () => {
  const response = deferred<ListingHtmlFetchResult>();
  let signal: AbortSignal | undefined;
  const fetchListingHtml = vi.fn(
    (_url: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return response.promise;
    },
  );
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: batchSeed(2),
    fetchListingHtml,
  });
  await workspaceService.queueJobsForReview!(["batch_0"]);
  await vi.waitFor(() => expect(fetchListingHtml).toHaveBeenCalledOnce());
  const resetSeed = batchSeed(1);
  resetSeed.savedJobs[0]!.description = "The replacement job after reset.";
  await workspaceService.resetWorkspace(resetSeed);
  expect(signal?.aborted).toBe(true);
  const commit = vi.spyOn(repository, "commitSavedJobDelta");
  response.resolve({
    status: 200,
    html: "<html><body>Old successful listing page</body></html>",
    finalUrl: "https://jobs.example.test/0",
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(commit).not.toHaveBeenCalled();
  expect(
    (await repository.listSavedJobsByIds(["batch_0"]))[0]?.description,
  ).toBe("The replacement job after reset.");
});

test("automatic and explicit reads share two slots without fetching the same job concurrently", async () => {
  const finishes: Array<() => void> = [];
  const activeIds = new Set<string>();
  let peak = 0;
  const fetchListingHtml = vi.fn(
    (url: string) =>
      new Promise<ListingHtmlFetchResult>((resolve) => {
        expect(activeIds.has(url)).toBe(false);
        activeIds.add(url);
        peak = Math.max(peak, activeIds.size);
        finishes.push(() => {
          activeIds.delete(url);
          resolve({ status: 404, html: "", finalUrl: url });
        });
      }),
  );
  const { workspaceService } = createWorkspaceServiceHarness({
    seed: batchSeed(3),
    fetchListingHtml,
  });
  await workspaceService.queueJobsForReview!(["batch_0", "batch_1"]);
  await vi.waitFor(() => expect(fetchListingHtml).toHaveBeenCalledTimes(2));
  const explicit = workspaceService
    .assessJobListing("batch_0")
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(fetchListingHtml).toHaveBeenCalledTimes(2);
  finishes[0]!();
  await vi.waitFor(() => expect(fetchListingHtml).toHaveBeenCalledTimes(3));
  expect(peak).toBe(2);
  finishes[1]!();
  finishes[2]!();
  await explicit;
  await workspaceService.shutdown();
});

test("shortlists fifty rows in one commit without reading the whole collection or building fifty snapshots", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: batchSeed(),
  });
  const list = vi.spyOn(repository, "listSavedJobs");
  const commit = vi.spyOn(repository, "commitSavedJobDelta");
  const ids = Array.from({ length: 50 }, (_, i) => `batch_${i}`);
  await workspaceService.queueJobsForReview!(ids);
  expect(list).not.toHaveBeenCalled();
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0]?.[0].updateJobIds).toEqual(ids);
  const jobs = await repository.listSavedJobsByIds([...ids, "batch_59"]);
  expect(jobs.filter((job) => job.status === "drafting")).toHaveLength(50);
  expect(jobs.find((job) => job.id === "batch_59")?.status).toBe("discovered");
});

test("unknown rows refuse the batch before changing any valid row", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: batchSeed(2),
  });
  await expect(
    workspaceService.queueJobsForReview!(["batch_0", "missing"]),
  ).rejects.toThrow("unknown job");
  expect((await repository.listSavedJobsByIds(["batch_0"]))[0]?.status).toBe(
    "discovered",
  );
});

test("changing one job's resume mode limits the transaction to that job", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: batchSeed(),
  });
  const commit = vi.spyOn(repository, "commitSavedJobDelta");
  await workspaceService.setJobResumeApplicationMode(
    "batch_0",
    "original_resume",
  );
  expect(commit.mock.calls[0]?.[0].updateJobIds).toEqual(["batch_0"]);
  expect(
    (await repository.listSavedJobsByIds(["batch_0"]))[0]
      ?.resumeApplicationMode,
  ).toBe("original_resume");
});

test("deduplicates requests, promotes pending rows atomically, and preserves other pending rows", async () => {
  const seed = batchSeed(3);
  seed.discovery.pendingDiscoveryJobs = seed.savedJobs.slice(1);
  seed.savedJobs = seed.savedJobs.slice(0, 1);
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
  });
  await workspaceService.queueJobsForReview!(["batch_0", "batch_1", "batch_1"]);
  expect((await repository.listSavedJobsByIds(["batch_1"]))[0]?.status).toBe(
    "drafting",
  );
  expect(
    (await repository.getDiscoveryState()).pendingDiscoveryJobs.map(
      (job) => job.id,
    ),
  ).toEqual(["batch_2"]);
});

test("runs at most two automatic listing reads and fences them across shutdown", async () => {
  const pending: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const fetchListingHtml = vi.fn(
    (url: string) =>
      new Promise<ListingHtmlFetchResult>((resolve) => {
        peak = Math.max(peak, ++active);
        pending.push(() => {
          active--;
          resolve({ status: 404, html: "", finalUrl: url });
        });
      }),
  );
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: batchSeed(),
    fetchListingHtml,
  });
  await workspaceService.queueJobsForReview!(
    Array.from({ length: 50 }, (_, i) => `batch_${i}`),
  );
  await vi.waitFor(() => expect(fetchListingHtml).toHaveBeenCalledTimes(2));
  expect(peak).toBe(2);
  await workspaceService.shutdown();
  const commit = vi.spyOn(repository, "commitSavedJobDelta");
  for (const finish of pending) finish();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fetchListingHtml).toHaveBeenCalledTimes(2);
  expect(commit).not.toHaveBeenCalled();
});
