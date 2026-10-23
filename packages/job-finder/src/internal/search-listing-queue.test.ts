import { expect, test } from "vitest";
import { SavedJobDiscoveryProvenanceSchema } from "@nestor/contracts";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  createSearchListingQueue,
  rebaseSearchListingRead,
} from "./search-listing-queue";

test("waiting readers take each listing once, within the shared budget, and close drains", async () => {
  const sample = createSeed().savedJobs[0]!;
  const jobs = new Map(["a", "b", "c"].map((id) => [id, { ...sample, id }]));
  const queue = createSearchListingQueue({
    maxJobs: 2,
    getJob: (id) => jobs.get(id),
    canRead: () => true,
  });
  const first = queue.next();
  queue.enqueue(["a", "a", "b", "c"]);
  expect((await first)?.id).toBe("a");
  expect(queue.isPending("a")).toBe(true);
  queue.complete("a");
  expect(queue.isPending("a")).toBe(false);
  queue.enqueue(["a"]);
  queue.close();
  expect((await queue.next())?.id).toBe("b");
  expect(await queue.next()).toBeUndefined();
  expect(queue.size).toBe(2);
});

test("a blocked or completed job is checked again at dequeue; stop wakes idle workers", async () => {
  const sample = createSeed().savedJobs[0]!;
  let readable = true;
  const queue = createSearchListingQueue({
    maxJobs: 8,
    getJob: () => sample,
    canRead: () => readable,
  });
  queue.enqueue([sample.id]);
  readable = false;
  const next = queue.next();
  expect(queue.isPending(sample.id)).toBe(false);
  queue.stop();
  expect(await next).toBeUndefined();
});

test("a read rebases listing facts over current status, plan verdicts and new sightings", () => {
  const original = createSeed().savedJobs[0]!;
  const read = {
    ...original,
    description: "Full requirements from the listing.",
  };
  const current = {
    ...original,
    status: "shortlisted" as const,
    resumeTailoringMode: "aggressive" as const,
    campaignIds: ["new-plan"],
    provenance: [
      ...original.provenance,
      SavedJobDiscoveryProvenanceSchema.parse({
        targetId: "new-source",
        adapterKind: "auto",
        startingUrl: "https://example.org/jobs",
        discoveredAt: original.discoveredAt,
      }),
    ],
  };
  const rebased = rebaseSearchListingRead(original, read, current);
  expect(rebased.status).toBe("shortlisted");
  expect(rebased.resumeTailoringMode).toBe("aggressive");
  expect(rebased.campaignIds).toEqual(["new-plan"]);
  expect(rebased.description).toBe(read.description);
  expect(rebased.planAssessments).toEqual(current.planAssessments);
  expect(rebased.provenance).toEqual(current.provenance);
});

test("a read cannot overwrite a changed listing and that version can enter the queue", async () => {
  const original = createSeed().savedJobs[0]!;
  const read = { ...original, description: "Earlier page" };
  const current = { ...original, description: "Updated requirements" };
  expect(rebaseSearchListingRead(original, read, current)).toBe(current);
  let job = original;
  const queue = createSearchListingQueue({
    maxJobs: 2,
    getJob: () => job,
    canRead: () => true,
  });
  queue.enqueue([job.id]);
  expect(await queue.next()).toBe(original);
  queue.complete(job.id);
  job = current;
  queue.enqueue([job.id]);
  expect(await queue.next()).toBe(current);
  queue.stop();
});
