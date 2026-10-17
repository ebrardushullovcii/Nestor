import { performance } from "node:perf_hooks";
import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  DiscoveryJobViewSchema,
  ReviewQueueItemSchema,
} from "@nordri/contracts";
import { describe, expect, it } from "vitest";
import {
  getDiscoverySelectionIndex,
  getLatestApplicationAttemptIndex,
  getReviewSelectionIndex,
} from "./job-finder-page-selection";
import {
  getJobFinderWorkspaceSelection,
  getLatestApplicationAttempt,
} from "./use-job-finder-page-controller-helpers";

const ROW_COUNT = 3_000;

function countRowReads<T>(rows: readonly T[]) {
  let reads = 0;
  const collection = new Proxy(rows, {
    get(target, property, receiver): unknown {
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    collection,
    get reads() {
      return reads;
    },
  };
}

function createCollections() {
  const job = DiscoveryJobViewSchema.parse({
    id: "job_0",
    source: "target_site",
    sourceJobId: "source_0",
    canonicalUrl: "https://example.test/jobs/0",
    applicationUrl: "https://example.test/jobs/0/apply",
    title: "Synthetic role",
    company: "Synthetic employer",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    salaryText: null,
    description: "Synthetic listing content. ".repeat(900),
    discoveredAt: "2026-10-13T00:00:00.000Z",
    status: "discovered",
    matchAssessment: { score: 80, reasons: [], gaps: [] },
  });
  const item = ReviewQueueItemSchema.parse({
    jobId: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    matchScore: 80,
    applicationStatus: "shortlisted",
    assetStatus: "not_started",
    progressPercent: null,
    resumeAssetId: null,
    updatedAt: job.discoveredAt,
  });
  const record = ApplicationRecordSchema.parse({
    id: "record_0",
    jobId: job.id,
    title: job.title,
    company: job.company,
    status: "drafting",
    lastActionLabel: "Prepared",
    nextActionLabel: null,
    lastUpdatedAt: job.discoveredAt,
  });
  const attempt = ApplicationAttemptSchema.parse({
    id: "attempt_0",
    jobId: job.id,
    applicationRecordId: record.id,
    state: "ready",
    summary: "Synthetic preparation",
    detail: "No submission",
    startedAt: job.discoveredAt,
    updatedAt: job.discoveredAt,
    completedAt: null,
    outcome: "drafting",
    nextActionLabel: null,
  });
  const jobs = countRowReads(
    Array.from({ length: ROW_COUNT }, (_, i) => ({ ...job, id: `job_${i}` })),
  );
  const review = countRowReads(
    Array.from({ length: ROW_COUNT }, (_, i) => ({
      ...item,
      jobId: `job_${i}`,
    })),
  );
  const records = countRowReads(
    Array.from({ length: ROW_COUNT }, (_, i) => ({
      ...record,
      id: `record_${i}`,
      jobId: `job_${i}`,
    })),
  );
  const attempts = countRowReads(
    Array.from({ length: ROW_COUNT }, (_, i) => ({
      ...attempt,
      id: `attempt_${i}`,
      applicationRecordId: `record_${i}`,
      jobId: `job_${i}`,
    })),
  );
  const workspace = {
    discoveryJobs: jobs.collection,
    reviewQueue: review.collection,
    applicationRecords: records.collection,
    applicationAttempts: attempts.collection,
  };
  return { jobs, review, records, attempts, workspace };
}

function legacySelection(
  workspace: ReturnType<typeof createCollections>["workspace"],
  index: number,
) {
  const discoveryIds = workspace.discoveryJobs.map((job) => job.id);
  const reviewIds = workspace.reviewQueue.map((item) => item.jobId);
  const jobsById = new Map(workspace.discoveryJobs.map((job) => [job.id, job]));
  const selectedDiscoveryJob = jobsById.get(discoveryIds[index]!);
  const selectedReviewItem = workspace.reviewQueue.find(
    (item) => item.jobId === reviewIds[index],
  );
  const selectedApplicationRecord = workspace.applicationRecords.find(
    (record) => record.id === `record_${index}`,
  );
  let selectedApplicationAttempt = null;
  let latestUpdatedAt = Number.NEGATIVE_INFINITY;
  for (const attempt of workspace.applicationAttempts) {
    if (attempt.applicationRecordId !== selectedApplicationRecord?.id) continue;
    const updatedAt = Date.parse(attempt.updatedAt);
    if (updatedAt > latestUpdatedAt) {
      latestUpdatedAt = updatedAt;
      selectedApplicationAttempt = attempt;
    }
  }
  return {
    selectedDiscoveryJob,
    selectedReviewItem,
    selectedApplicationRecord,
    selectedApplicationAttempt,
  };
}

describe("Job Finder selection at 3,000 rows", () => {
  it("reuses indexes across selections, snapshot wrappers, and route remounts without scanning collections", () => {
    const fixture = createCollections();
    const discoveryIndex = getDiscoverySelectionIndex(fixture.jobs.collection);
    const reviewIndex = getReviewSelectionIndex(fixture.review.collection);
    getLatestApplicationAttempt(fixture.workspace, "record_2999");
    const reads = [
      fixture.jobs.reads,
      fixture.review.reads,
      fixture.records.reads,
      fixture.attempts.reads,
    ];

    for (let i = 0; i < 500; i += 1) {
      const index = (i * 37) % ROW_COUNT;
      // A route remount or unrelated delta has a new snapshot wrapper but
      // retains these collections; module-owned caches survive both.
      const snapshot = { ...fixture.workspace };
      const selection = getJobFinderWorkspaceSelection(
        snapshot,
        `job_${index}`,
        `job_${index}`,
      );
      const application = getLatestApplicationAttempt(
        snapshot,
        `record_${index}`,
      );
      expect(selection.selectedDiscoveryJob?.id).toBe(`job_${index}`);
      expect(selection.selectedReviewItem?.jobId).toBe(`job_${index}`);
      expect(application.selectedApplicationAttempt?.id).toBe(
        `attempt_${index}`,
      );
      expect(getDiscoverySelectionIndex(snapshot.discoveryJobs)).toBe(
        discoveryIndex,
      );
      expect(getReviewSelectionIndex(snapshot.reviewQueue)).toBe(reviewIndex);
    }
    expect([
      fixture.jobs.reads,
      fixture.review.reads,
      fixture.records.reads,
      fixture.attempts.reads,
    ]).toEqual(reads);
  });

  it("invalidates only the changed collection and keeps exact row references", () => {
    const fixture = createCollections();
    const reviewIndex = getReviewSelectionIndex(fixture.review.collection);
    const previousIndex = getDiscoverySelectionIndex(fixture.jobs.collection);
    const replacement = {
      ...fixture.jobs.collection[2999]!,
      title: "Updated role",
    };
    const jobs = [...fixture.jobs.collection];
    jobs[2999] = replacement;
    const workspace = { ...fixture.workspace, discoveryJobs: jobs };
    const selection = getJobFinderWorkspaceSelection(
      workspace,
      replacement.id,
      replacement.id,
    );
    expect(selection.selectedDiscoveryJob).toBe(replacement);
    expect(selection.selectedReviewJob).toBe(replacement);
    expect(getDiscoverySelectionIndex(jobs)).not.toBe(previousIndex);
    expect(getDiscoverySelectionIndex(jobs).jobsById.get("job_0")).toBe(
      fixture.jobs.collection[0],
    );
    expect(getReviewSelectionIndex(workspace.reviewQueue)).toBe(reviewIndex);
    const remaining = jobs.slice(0, -1);
    expect(getDiscoverySelectionIndex(remaining).validIds.has("job_2999")).toBe(
      false,
    );
    expect(
      getJobFinderWorkspaceSelection(
        { discoveryJobs: remaining, reviewQueue: [] },
        replacement.id,
        null,
      ).selectedDiscoveryJob,
    ).toBe(remaining[0]);
  });

  it("preserves attempt isolation, timestamp ties, invalid timestamps, and immutable updates", () => {
    const fixture = createCollections();
    const attempt = fixture.attempts.collection[0]!;
    const attempts = [
      { ...attempt, id: "invalid", updatedAt: "invalid" },
      { ...attempt, id: "first" },
      { ...attempt, id: "tie" },
      {
        ...attempt,
        id: "sibling",
        applicationRecordId: "record_1",
        updatedAt: "2026-10-14T00:00:00.000Z",
      },
    ];
    expect(getLatestApplicationAttemptIndex(attempts).get("record_0")?.id).toBe(
      "first",
    );
    const next = [
      ...attempts,
      { ...attempt, id: "updated", updatedAt: "2026-10-15T00:00:00.000Z" },
    ];
    expect(getLatestApplicationAttemptIndex(next).get("record_0")?.id).toBe(
      "updated",
    );
    expect(getLatestApplicationAttemptIndex(attempts).get("record_0")?.id).toBe(
      "first",
    );
    expect(
      getLatestApplicationAttempt(
        { ...fixture.workspace, applicationAttempts: next },
        "missing",
      ),
    ).toEqual({
      selectedApplicationAttempt: null,
      selectedApplicationRecord: null,
    });
  });

  it("measures the old collection rebuilds against retained-index selection", () => {
    const fixture = createCollections();
    // Proxies count traversal above; use ordinary arrays for timing so their
    // instrumentation cannot inflate the old path's cost.
    const workspace = {
      discoveryJobs: [...fixture.workspace.discoveryJobs],
      reviewQueue: [...fixture.workspace.reviewQueue],
      applicationRecords: [...fixture.workspace.applicationRecords],
      applicationAttempts: [...fixture.workspace.applicationAttempts],
    };
    const passes = 500;
    const baselineStarted = performance.now();
    let baseline = legacySelection(workspace, 0);
    for (let i = 1; i < passes; i += 1)
      baseline = legacySelection(workspace, (i * 37) % ROW_COUNT);
    const baselineMs = performance.now() - baselineStarted;
    getJobFinderWorkspaceSelection(workspace, "job_0", "job_0");
    getLatestApplicationAttempt(workspace, "record_0");
    const started = performance.now();
    let selection = getJobFinderWorkspaceSelection(workspace, "job_0", "job_0");
    let application = getLatestApplicationAttempt(workspace, "record_0");
    for (let i = 1; i < passes; i += 1) {
      const index = (i * 37) % ROW_COUNT;
      selection = getJobFinderWorkspaceSelection(
        workspace,
        `job_${index}`,
        `job_${index}`,
      );
      application = getLatestApplicationAttempt(workspace, `record_${index}`);
    }
    const retainedMs = performance.now() - started;
    expect(selection.selectedDiscoveryJob).toBe(baseline.selectedDiscoveryJob);
    expect(application.selectedApplicationAttempt).toBe(
      baseline.selectedApplicationAttempt,
    );
    console.info("job-finder-selection-scale", {
      rows: ROW_COUNT,
      passes,
      baselineMs,
      retainedMs,
    });
  });
});
