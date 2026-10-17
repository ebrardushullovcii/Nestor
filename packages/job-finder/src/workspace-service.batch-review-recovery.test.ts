import {
  ApplyJobResultSchema,
  ApplyRunSchema,
  JobFinderIntelligenceStateSchema,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createSeed } from "./workspace-service.test-fixtures";

const at = "2026-09-22T16:00:00.000Z";
const runId = "apply_run_expired_sample";
const reviewId = `automatic_batch_sample_review:${runId}`;

function createReviewSeed() {
  const seed = createSeed();
  const jobIds = Array.from({ length: 5 }, (_, index) => `sample_job_${index}`);
  seed.applyRuns = [
    ApplyRunSchema.parse({
      id: runId,
      mode: "queue_auto",
      state: "completed",
      jobIds,
      createdAt: at,
      updatedAt: at,
      completedAt: at,
      totalJobs: 5,
      failedJobs: 5,
      summary: "The prepared pages were lost.",
      detail: "Try again to prepare the applications.",
    }),
  ];
  seed.applyJobResults = jobIds.map((jobId, index) =>
    ApplyJobResultSchema.parse({
      id: `sample_result_${index}`,
      jobId,
      runId,
      state: "failed",
      summary: "The prepared page is no longer open.",
      detail: "Try again to prepare the application.",
      startedAt: at,
      updatedAt: at,
      completedAt: at,
    }),
  );
  seed.intelligence = JobFinderIntelligenceStateSchema.parse({
    safeguards: {
      preparedBatchSampleReviews: [
        {
          id: reviewId,
          batchId: runId,
          preparedCount: 5,
          sampleCount: 1,
          sampledItemIds: ["sample_result_0"],
          reviewedCount: 0,
          requiredSampleRatio: 0.2,
          reviewCompleted: false,
          explanation: "Review the prepared sample.",
          recoveryGuidance: "Review one prepared application.",
        },
      ],
    },
  });
  return seed;
}

describe("obsolete automatic batch sample recovery", () => {
  test.each(["snapshot", "overview", "apply", "search"] as const)(
    "%s retires the review of lost forms without requiring a dismissal",
    async (entry) => {
      const { workspaceService, repository } = createWorkspaceServiceHarness({
        seed: createReviewSeed(),
      });
      if (entry === "snapshot") await workspaceService.getWorkspaceSnapshot();
      if (entry === "overview") await workspaceService.getSafeguardsOverview();
      if (entry === "apply") {
        expect(
          await workspaceService.evaluateApplicationSafeguardBlockers([
            "job_ready",
          ]),
        ).toEqual([]);
      }
      if (entry === "search") {
        expect(
          await workspaceService.evaluateDiscoverySafeguardBlockers(),
        ).toEqual([]);
      }
      const { safeguards } = await repository.getIntelligenceState();
      expect(safeguards.preparedBatchSampleReviews).toEqual([]);
      expect(safeguards.safeguardDismissals).toEqual([]);
      expect(await repository.listApplyJobResults()).toHaveLength(5);
    },
  );

  test("keeps a person-created review and its progress on every read", async () => {
    const seed = createReviewSeed();
    const review = seed.intelligence.safeguards.preparedBatchSampleReviews[0]!;
    review.id = "person_requested_review";
    review.reviewedCount = 1;
    review.sampleCount = 2;
    review.sampledItemIds = ["sample_result_0", "sample_result_1"];
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
    });
    await workspaceService.getWorkspaceSnapshot();
    await workspaceService.getSafeguardsOverview();
    expect(
      (await repository.getIntelligenceState()).safeguards
        .preparedBatchSampleReviews,
    ).toEqual([review]);
  });

  test("keeps progress from prepare_batch_sample_review alongside retired automatic reviews", async () => {
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed: createReviewSeed(),
    });
    await workspaceService.mutateSafeguards({
      type: "prepare_batch_sample_review",
      reviewId: "person_requested",
      batchId: "person_batch",
      prepared: Array.from({ length: 10 }, (_, index) => ({
        id: `person_item_${index}`,
      })),
      requiredSampleRatio: 0.2,
      explanation: "Review this sample.",
      recoveryGuidance: "Finish the sample.",
    });
    await workspaceService.mutateSafeguards({
      type: "update_batch_sample_review",
      reviewId: "person_requested",
      reviewedCount: 1,
      reviewCompleted: false,
    });
    await workspaceService.getWorkspaceSnapshot();
    await workspaceService.getSafeguardsOverview();
    expect(
      (await repository.getIntelligenceState()).safeguards
        .preparedBatchSampleReviews,
    ).toEqual([
      expect.objectContaining({
        id: "person_requested",
        reviewedCount: 1,
        reviewCompleted: false,
      }),
    ]);
  });

  test.each(["snapshot", "overview", "apply", "search"] as const)(
    "%s keeps a completed automatic review and its history",
    async (entry) => {
      const seed = createReviewSeed();
      const review =
        seed.intelligence.safeguards.preparedBatchSampleReviews[0]!;
      review.reviewCompleted = true;
      review.reviewedCount = 1;
      seed.intelligence.safeguards.preparedBatchSampleReviews.push({
        ...review,
        id: `${reviewId}:pending`,
        reviewCompleted: false,
        reviewedCount: 0,
      });
      const { workspaceService, repository } = createWorkspaceServiceHarness({
        seed,
      });
      if (entry === "snapshot") await workspaceService.getWorkspaceSnapshot();
      if (entry === "overview") await workspaceService.getSafeguardsOverview();
      if (entry === "apply")
        expect(
          await workspaceService.evaluateApplicationSafeguardBlockers([
            "job_ready",
          ]),
        ).toEqual([]);
      if (entry === "search")
        expect(
          await workspaceService.evaluateDiscoverySafeguardBlockers(),
        ).toEqual([]);
      expect(
        (await repository.getIntelligenceState()).safeguards
          .preparedBatchSampleReviews,
      ).toEqual([review]);
    },
  );

  test.each([
    "pending",
    "dismissed",
    "missing-result",
    "prepared",
    "running",
  ] as const)("retires a %s automatic review", async (condition) => {
    const seed = createReviewSeed();
    const review = seed.intelligence.safeguards.preparedBatchSampleReviews[0]!;
    if (condition === "dismissed")
      seed.intelligence.safeguards.safeguardDismissals.push({
        id: "person_dismissal",
        kind: "batch_sample_review_pending",
        referenceId: review.id,
        reason: "not_applicable",
        note: null,
        dismissedAt: at,
      });
    if (condition === "missing-result") seed.applyJobResults.pop();
    if (condition === "prepared")
      seed.applyJobResults[0]!.state = "awaiting_review";
    if (condition === "running") seed.applyRuns[0]!.state = "running";
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
    });
    await workspaceService.getSafeguardsOverview();
    expect(
      (await repository.getIntelligenceState()).safeguards
        .preparedBatchSampleReviews,
    ).toEqual([]);
  });

  test("retires an automatic sample that only names a question handoff", async () => {
    const seed = createReviewSeed();
    seed.applyJobResults[0]!.state = "awaiting_review";
    seed.applyJobResults[0]!.blockerReason = "required_human_input";
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
    });
    await workspaceService.getSafeguardsOverview();
    expect(
      (await repository.getIntelligenceState()).safeguards
        .preparedBatchSampleReviews,
    ).toEqual([]);
  });
});
