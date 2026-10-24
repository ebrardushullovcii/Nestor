import { describe, expect, test, vi } from "vitest";
import { createSavedJob, createSeed } from "../workspace-service.test-fixtures";
import { createSearchListingReadAhead } from "./search-listing-read-ahead";
import {
  enrichSavedJobListingDetails,
  createListingReadRateLimitState,
  type PreparedListingRead,
} from "./listing-detail-enrichment";

const card = (id: string) =>
  createSavedJob({
    ...createSeed().savedJobs[0]!,
    id,
    canonicalUrl: `https://example.test/${id}`,
    title: "Engineer",
    description: "Engineer",
    detailQuality: "card_only",
    listingDetailFetch: null,
  });

describe("listing reads ahead of final enrichment", () => {
  test("prepares facts without assessing or changing jobs, then applies in the selected order", async () => {
    const jobs = [card("a"), card("b")];
    const before = structuredClone(jobs);
    const queue = createSearchListingReadAhead({
      maxJobs: 2,
      getJob: (id) => jobs.find((job) => job.id === id),
      canRead: () => true,
    });
    const assess = vi.fn(() => jobs[0]!.matchAssessment);
    const fetchHtml = vi.fn((url: string) =>
      Promise.resolve({
        status: 200,
        finalUrl: url,
        html: '<script type="application/ld+json">{"@type":"JobPosting","title":"Engineer","description":"Build and operate distributed services. Own production systems and delivery."}</script>',
      }),
    );
    const pass = enrichSavedJobListingDetails({
      jobs: [],
      maxJobs: 2,
      nextJob: () => queue.next(),
      onReadPrepared: (job, read) => queue.record(job, read),
      fetchHtml,
      assess,
    });
    queue.enqueue(["a", "a", "b"]);
    queue.close();
    await pass;
    expect(assess).not.toHaveBeenCalled();
    expect(jobs).toEqual(before);
    expect(fetchHtml).toHaveBeenCalledTimes(2);
    const result = await enrichSavedJobListingDetails({
      jobs: [jobs[1]!, jobs[0]!],
      readAhead: (job) => queue.read(job),
      fetchHtml,
      assess,
    });
    expect(result.jobs.map((job) => job.id)).toEqual(["b", "a"]);
    expect(
      result.jobs.every((job) =>
        job.description.includes("distributed services"),
      ),
    ).toBe(true);
    expect(result.summary.attempted).toBe(2);
    expect(assess).toHaveBeenCalledTimes(2);
    expect(fetchHtml).toHaveBeenCalledTimes(2);
  });

  test("does not reuse page facts for a changed title or canonical listing", () => {
    let job = card("a");
    const queue = createSearchListingReadAhead({
      maxJobs: 2,
      getJob: () => job,
      canRead: () => true,
    });
    const read: PreparedListingRead = {
      attemptedAt: "2026-10-23T01:00:00.000Z",
      detail: null,
    };
    queue.record(job, read);
    job = { ...job, title: "Different role" };
    expect(queue.read(job)).toBeUndefined();
    job = { ...card("a"), canonicalUrl: "https://example.test/another" };
    expect(queue.read(job)).toBeUndefined();
  });

  test("retains a failed read without retrying it in the final pass", async () => {
    const job = card("a");
    const prepared = new Map<string, PreparedListingRead>();
    const fetchHtml = vi.fn(() => Promise.reject(new Error("Offline")));
    const assess = vi.fn(() => job.matchAssessment);
    await enrichSavedJobListingDetails({
      jobs: [job],
      fetchHtml,
      assess,
      onReadPrepared: (job, read) => prepared.set(job.id, read),
    });
    const result = await enrichSavedJobListingDetails({
      jobs: [job],
      fetchHtml,
      assess,
      readAhead: (job) => prepared.get(job.id),
    });
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(assess).not.toHaveBeenCalled();
    expect(result.summary.failed).toBe(1);
    expect(result.jobs[0]!.listingDetailFetch?.outcome).toBe("fetch_failed");
  });

  test("stop releases idle readers and does not read queued jobs", async () => {
    const job = card("a");
    const queue = createSearchListingReadAhead({
      maxJobs: 1,
      getJob: () => job,
      canRead: () => true,
    });
    const waiting = queue.next();
    queue.stop();
    await expect(waiting).resolves.toBeUndefined();
    queue.enqueue([job.id]);
    await expect(queue.next()).resolves.toBeUndefined();
  });

  test("a long rate limit stays deferred when prepared reads are applied", async () => {
    const jobs = [card("a"), card("b")];
    const prepared = new Map<string, PreparedListingRead>();
    const rateLimitState = createListingReadRateLimitState();
    const fetchHtml = vi.fn((url: string) =>
      Promise.resolve({
        status: 429,
        html: "",
        finalUrl: url,
        retryAfterMs: 60000,
      }),
    );
    const assess = vi.fn(() => jobs[0]!.matchAssessment);
    await enrichSavedJobListingDetails({
      jobs: [jobs[0]!],
      fetchHtml,
      assess,
      rateLimitState,
      onReadPrepared: (job, read) => prepared.set(job.id, read),
    });
    const result = await enrichSavedJobListingDetails({
      jobs,
      fetchHtml,
      assess,
      rateLimitState,
      readAhead: (job) => prepared.get(job.id),
    });
    expect(fetchHtml).toHaveBeenCalledOnce();
    expect(result.summary.blocked).toBe(1);
    expect(result.summary.skipped).toBe(1);
    expect(result.jobs[0]!.listingDetailFetch?.outcome).toBe("blocked");
    expect(result.jobs[1]!.listingDetailFetch).toBeNull();
    expect(assess).not.toHaveBeenCalled();
  });

  test("caps admissions, drops changed queued identities, and counts actual reads", async () => {
    const jobs = new Map(
      [card("a"), card("b"), card("c")].map((job) => [job.id, job]),
    );
    const queue = createSearchListingReadAhead({
      maxJobs: 2,
      getJob: (id) => jobs.get(id),
      canRead: () => true,
    });
    queue.enqueue(["a", "a", "b", "c"]);
    jobs.set("a", { ...jobs.get("a")!, title: "Changed while queued" });
    queue.close();
    expect((await queue.next())?.id).toBe("b");
    await expect(queue.next()).resolves.toBeUndefined();
    expect(queue.readsStarted).toBe(1);
    queue.record(jobs.get("b")!, {
      attemptedAt: "2026-10-23T01:00:00.000Z",
      detail: null,
    });
    queue.stop();
    queue.record(jobs.get("b")!, {
      attemptedAt: "2026-10-23T01:00:00.000Z",
      detail: null,
    });
    expect(queue.read(jobs.get("b")!)).toBeUndefined();
  });
});
