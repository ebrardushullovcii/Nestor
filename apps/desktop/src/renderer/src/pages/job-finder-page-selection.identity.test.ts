import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  DiscoveryJobViewSchema,
  ReviewQueueItemSchema,
} from "@nestor/contracts";
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

const ROW_COUNT = 3;

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

describe("Job Finder selection identity", () => {
  it("invalidates only the changed collection and keeps exact row references", () => {
    const fixture = createCollections();
    const reviewIndex = getReviewSelectionIndex(fixture.review.collection);
    const previousIndex = getDiscoverySelectionIndex(fixture.jobs.collection);
    const replacement = {
      ...fixture.jobs.collection[2]!,
      title: "Updated role",
    };
    const jobs = [...fixture.jobs.collection];
    jobs[2] = replacement;
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
    expect(getDiscoverySelectionIndex(remaining).validIds.has("job_2")).toBe(
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
});
