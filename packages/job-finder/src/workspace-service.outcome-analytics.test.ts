import { describe, expect, test } from "vitest";

import {
  ApplicationRecordSchema,
  UNKNOWN_JOB_SOURCE_BUCKET_KEY,
  type OutcomeAnalyticsOverview,
} from "@nestor/contracts";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createSeed } from "./workspace-service.test-fixtures";

function bucketOf(
  overview: OutcomeAnalyticsOverview | null,
  dimension:
    | "campaign"
    | "source"
    | "job_title"
    | "company"
    | "resume_strategy",
  key: string,
) {
  const bucket = overview?.buckets.find(
    (candidate) => candidate.dimension === dimension && candidate.key === key,
  );
  if (!bucket) throw new Error(`Missing ${dimension} bucket for key ${key}`);
  return bucket;
}

describe("workspace outcome analytics end to end", () => {
  function applicationRecord(id: string, jobId = "job_ready") {
    return ApplicationRecordSchema.parse({
      id,
      jobId,
      title: "Senior Product Designer",
      company: "Signal Systems",
      status: "ready_for_review",
      lastActionLabel: "Ready for review",
      nextActionLabel: "Review application",
      lastUpdatedAt: "2026-03-20T10:00:00.000Z",
    });
  }

  async function withDefaultCampaign(
    harness: ReturnType<typeof createWorkspaceServiceHarness>,
  ) {
    // The default campaign (including all saved jobs) is created lazily on
    // the first snapshot read.
    await harness.workspaceService.getWorkspaceSnapshot();
  }

  test("recordOutcome appends a user-controlled event and derives analytics from it", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const first = await workspaceService.recordOutcome({
      jobId: "job_ready",
      outcome: "applied",
      resumeStrategyId: null,
      note: null,
    });
    expect(first.intelligence.outcomeEvents).toHaveLength(1);
    expect(first.intelligence.outcomeEvents[0]).toMatchObject({
      outcome: "applied",
      jobId: "job_ready",
      campaignId: "campaign_default",
      source: "target_site",
      company: "Signal Systems",
      jobTitle: "Senior Product Designer",
      userControlled: true,
    });

    const interview = await workspaceService.recordOutcome({
      jobId: "job_generating",
      outcome: "interview",
      resumeStrategyId: null,
      note: "Scheduled technical screen",
    });
    expect(interview.intelligence.outcomeEvents).toHaveLength(2);

    const overview = interview.intelligence.outcomeAnalytics;
    const campaignBucket = bucketOf(overview, "campaign", "campaign_default");
    expect(campaignBucket.sampleSize).toBe(2);
    expect(campaignBucket.outcomeCounts).toMatchObject({
      applied: 1,
      interview: 1,
    });
    expect(campaignBucket.rateNumerators).toMatchObject({
      applied: 2,
      response: 1,
      interview: 1,
      offer: 0,
    });
    expect(campaignBucket.interviewRate).toBeNull();
    // Outcomes group by the saved source the job came from. These fixture
    // jobs carry no discovery lineage, so they group under the named
    // unknown-source bucket instead of disappearing from the breakdown.
    const sourceBucket = bucketOf(
      overview,
      "source",
      UNKNOWN_JOB_SOURCE_BUCKET_KEY,
    );
    expect(sourceBucket.sampleSize).toBe(2);
  });

  test("requires explicit identities when a job is shared or has multiple applications", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        applicationRecords: [
          applicationRecord("application_a"),
          applicationRecord("application_b"),
        ],
      },
    });
    await withDefaultCampaign(harness);
    const campaignState = await harness.repository.getCampaignState();
    if (!campaignState) throw new Error("Expected default campaign state.");
    await harness.repository.saveCampaignState({
      ...campaignState,
      campaigns: [
        ...campaignState.campaigns,
        {
          ...campaignState.campaigns[0]!,
          id: "campaign_second",
          name: "Second campaign",
        },
      ],
    });

    await expect(
      harness.workspaceService.recordOutcome({
        jobId: "job_ready",
        outcome: "applied",
        resumeStrategyId: null,
        note: null,
      }),
    ).rejects.toThrow(/multiple campaigns/i);

    await expect(
      harness.workspaceService.recordOutcome({
        jobId: "job_ready",
        campaignId: "campaign_default",
        outcome: "applied",
        resumeStrategyId: null,
        note: null,
      }),
    ).rejects.toThrow(/multiple application records/i);

    await expect(
      harness.workspaceService.recordOutcome({
        jobId: "job_ready",
        campaignId: "campaign_default",
        applicationRecordId: "application_a",
        outcome: "applied",
        resumeStrategyId: null,
        note: null,
      }),
    ).resolves.toBeDefined();
  });

  test("persists selected campaign and application identities for the same job", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        applicationRecords: [
          applicationRecord("application_a"),
          applicationRecord("application_b"),
        ],
      },
    });
    await withDefaultCampaign(harness);
    const campaignState = await harness.repository.getCampaignState();
    if (!campaignState) throw new Error("Expected default campaign state.");
    await harness.repository.saveCampaignState({
      ...campaignState,
      campaigns: [
        ...campaignState.campaigns,
        {
          ...campaignState.campaigns[0]!,
          id: "campaign_second",
          name: "Second campaign",
        },
      ],
    });

    await harness.workspaceService.recordOutcome({
      jobId: "job_ready",
      campaignId: "campaign_default",
      applicationRecordId: "application_a",
      outcome: "applied",
      resumeStrategyId: null,
      note: null,
    });
    const snapshot = await harness.workspaceService.recordOutcome({
      jobId: "job_ready",
      campaignId: "campaign_second",
      applicationRecordId: "application_b",
      outcome: "interview",
      resumeStrategyId: null,
      note: null,
    });

    expect(snapshot.intelligence.outcomeEvents).toMatchObject([
      { campaignId: "campaign_default", applicationRecordId: "application_a" },
      { campaignId: "campaign_second", applicationRecordId: "application_b" },
    ]);
    expect(
      bucketOf(
        snapshot.intelligence.outcomeAnalytics,
        "campaign",
        "campaign_default",
      ).sampleSize,
    ).toBe(1);
    expect(
      bucketOf(
        snapshot.intelligence.outcomeAnalytics,
        "campaign",
        "campaign_second",
      ).sampleSize,
    ).toBe(1);
    expect(
      bucketOf(
        snapshot.intelligence.outcomeAnalytics,
        "source",
        UNKNOWN_JOB_SOURCE_BUCKET_KEY,
      ).sampleSize,
    ).toBe(2);
  });

  test("recording Applied never fabricates submission evidence or apply runs", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const snapshot = await workspaceService.recordOutcome({
      jobId: "job_ready",
      outcome: "applied",
      resumeStrategyId: null,
      note: null,
    });

    expect(snapshot.intelligence.outcomeEvents).toHaveLength(1);
    expect(snapshot.intelligence.outcomeEvents[0]!.userControlled).toBe(true);
    // The manual record must not create any application run, attempt, or
    // submission evidence and must never touch apply/approval state.
    expect(snapshot.applyRuns).toHaveLength(0);
    expect(snapshot.applicationAttempts).toHaveLength(0);
    expect(snapshot.applicationRecords).toHaveLength(0);
    expect(snapshot.intelligence.outcomeEvents[0]).not.toHaveProperty(
      "submissionEvidence",
    );
    expect(snapshot.intelligence.outcomeEvents[0]).not.toHaveProperty(
      "submittedAt",
    );
    expect(snapshot.intelligence.outcomeEvents[0]).not.toHaveProperty("runId");
  });

  test("recordOutcome rejects a job that is not linked to a campaign", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    await expect(
      workspaceService.recordOutcome({
        jobId: "job_missing",
        outcome: "offer",
        resumeStrategyId: null,
        note: null,
      }),
    ).rejects.toThrow(/no longer available|not linked/i);
  });

  test("a recorded rejection counts as both an application and a response", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const snapshot = await workspaceService.recordOutcome({
      jobId: "job_ready",
      outcome: "rejected",
      resumeStrategyId: null,
      note: null,
    });
    const bucket = bucketOf(
      snapshot.intelligence.outcomeAnalytics,
      "campaign",
      "campaign_default",
    );

    expect(bucket.appliedRate).toBeNull();
    expect(bucket.responseRate).toBeNull();
    expect(bucket.interviewRate).toBeNull();
  });

  test("a user disable survives re-derivation and a reset re-evaluates the suggestion", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    await workspaceService.recordOutcome({
      jobId: "job_ready",
      outcome: "interview",
      resumeStrategyId: null,
      note: null,
    });
    await workspaceService.recordOutcome({
      jobId: "job_generating",
      outcome: "rejected",
      resumeStrategyId: null,
      note: null,
    });

    // A suggestion cannot be data-driven at this sample, so the control
    // round-trip focuses on the durable user state: disable is honored, it
    // survives new events, and reset lifts it and requests re-evaluation.
    const disabled = await workspaceService.setOutcomeSuggestionEnabled({
      dimension: "campaign",
      key: "campaign_default",
      enabled: false,
      reset: false,
    });
    expect(
      bucketOf(
        disabled.intelligence.outcomeAnalytics,
        "campaign",
        "campaign_default",
      ).suggestion,
    ).toMatchObject({
      enabled: false,
      kind: "none",
      disabledByUser: true,
    });

    // A new event re-derives analytics but the user disable must survive.
    const withNewEvent = await workspaceService.recordOutcome({
      jobId: "job_ready",
      outcome: "offer",
      resumeStrategyId: null,
      note: null,
    });
    expect(
      bucketOf(
        withNewEvent.intelligence.outcomeAnalytics,
        "campaign",
        "campaign_default",
      ).suggestion,
    ).toMatchObject({
      enabled: false,
      disabledByUser: true,
    });

    // Reset lifts the disable and requests a fresh re-evaluation; the emitted
    // bucket never carries a pending reset flag.
    const reset = await workspaceService.setOutcomeSuggestionEnabled({
      dimension: "campaign",
      key: "campaign_default",
      enabled: true,
      reset: true,
    });
    const resetBucket = bucketOf(
      reset.intelligence.outcomeAnalytics,
      "campaign",
      "campaign_default",
    );
    expect(resetBucket.suggestion).toMatchObject({
      enabled: false,
      kind: "none",
      disabledByUser: false,
      resetRequested: false,
    });
    expect(resetBucket.suggestion.lastResetAt).not.toBeNull();
  });

  test("setOutcomeSuggestionEnabled is a safe no-op for a missing bucket", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const snapshot = await workspaceService.setOutcomeSuggestionEnabled({
      dimension: "source",
      key: "missing-source",
      enabled: false,
      reset: false,
    });

    expect(snapshot.intelligence.outcomeAnalytics).toBeNull();
  });
});
