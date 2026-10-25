import { describe, expect, it } from "vitest";
import {
  JobSearchCampaignSchema,
  getDefaultCampaignConfiguration,
} from "./job-search-campaigns";
import {
  JobFinderWorkspaceDeltaSchema,
  JobFinderWorkspaceEntityMutationInputSchema,
} from "./workspace";

function emptySlice() {
  return { upserts: [], removedIds: [] };
}

describe("workspace delta contracts", () => {
  it("accepts a listing assessment for an exact job and rejects unknown payload fields", () => {
    const input = {
      baseRevision: 4,
      mutation: { type: "assess_job_listing", jobId: "job-1" },
    };
    expect(JobFinderWorkspaceEntityMutationInputSchema.parse(input)).toEqual(
      input,
    );
    expect(
      JobFinderWorkspaceEntityMutationInputSchema.safeParse({
        ...input,
        mutation: { ...input.mutation, url: "https://unrelated.example" },
      }).success,
    ).toBe(false);
  });
  it("parses the bounded entity mutation commands with their base revision", () => {
  });

  it("carries current selection IDs in every schema-validated delta", () => {
    const generatedAt = "2026-08-09T10:00:00.000Z";
    const campaign = JobSearchCampaignSchema.parse({
      id: "campaign-1",
      name: "Default search",
      mode: "precision",
      status: "active",
      createdAt: generatedAt,
      updatedAt: generatedAt,
      searchPreferences: {
        minimumSalaryUsd: null,
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
      },
      sourceTargetIds: [],
      ...getDefaultCampaignConfiguration("precision"),
      progress: { lastUpdatedAt: generatedAt },
    });
    const result = JobFinderWorkspaceDeltaSchema.parse({
      baseRevision: 4,
      currentRevision: 5,
      generatedAt,
      discoveryRunState: "idle",
      activeDiscoveryRun: null,
      discoverySessions: [],
      sourceAccessPrompts: [],
      latestResumeImportRun: null,
      campaigns: [campaign],
      activeCampaignId: campaign.id,
      dashboard: {
        generatedAt,
        activeCampaignId: campaign.id,
        activeCampaignCount: 1,
        jobsFoundToday: 0,
        jobsAwaitingReview: 0,
        applicationsReadyForApproval: 0,
        applicationsAppliedToday: 0,
        applicationsAppliedThisWeek: 0,
        needsYouCount: 0,
        upcomingInterviews: 0,
        upcomingFollowUps: 0,
        responseRate: null,
        interviewRate: null,
        sourceHealth: {
          healthy: 0,
          needsAttention: 0,
          running: 0,
          total: 0,
        },
        backgroundOperationCount: 0,
        recommendedNextAction: {
          label: "Search for jobs",
          detail: "Start the active campaign when you are ready.",
          route: "/job-finder/find-jobs",
        },
      },
      activityControl: { paused: false, pausedAt: null, reason: null },
      intelligence: { groupedDecisions: [] },
      selectedDiscoveryJobId: "job-2",
      selectedReviewJobId: null,
      selectedApplyRunId: null,
      selectedApplicationRecordId: null,
      discoveryJobs: emptySlice(),
      dismissedDiscoveryJobs: emptySlice(),
      recentDiscoveryRuns: emptySlice(),
      reviewQueue: emptySlice(),
      applyRuns: emptySlice(),
      applyJobResults: emptySlice(),
      applicationRecords: emptySlice(),
      applicationAttempts: emptySlice(),
      userActionRequests: emptySlice(),
      userActionEvents: emptySlice(),
    });

    expect(result.selectedDiscoveryJobId).toBe("job-2");
    expect(result.companyJobs).toEqual(emptySlice());
    expect(result.currentRevision).toBe(result.baseRevision + 1);
    expect(
      JobFinderWorkspaceDeltaSchema.parse({
        ...result,
        baseRevision: 1,
        currentRevision: 3,
      }).currentRevision,
    ).toBe(3);
    for (const currentRevision of [0, 1]) {
      const parsed = JobFinderWorkspaceDeltaSchema.safeParse({
        ...result,
        baseRevision: 1,
        currentRevision,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({ path: ["currentRevision"] }),
        );
      }
    }
  });
});
