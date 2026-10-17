import {
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createSeed } from "./workspace-service.test-fixtures";

const sharedJobId = "job_ready";
const uniqueJobId = "job_generating";

function record(id: string, jobId: string) {
  return ApplicationRecordSchema.parse({
    id,
    jobId,
    title: `Role ${id}`,
    company: "Example",
    status: "ready_for_review",
    lastActionLabel: "Ready for review",
    nextActionLabel: "Review application",
    lastUpdatedAt: "2026-08-23T10:00:00.000Z",
  });
}

function run(id: string, campaignId: string | null, jobId: string) {
  return ApplyRunSchema.parse({
    id,
    campaignId,
    state: "running",
    jobIds: [jobId],
    currentJobId: jobId,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:01:00.000Z",
    summary: `Run ${id}`,
    detail: "Preparing one application.",
    totalJobs: 1,
    pendingJobs: 1,
  });
}

function result(
  id: string,
  runId: string,
  applicationRecordId: string,
  jobId: string,
) {
  return ApplyJobResultSchema.parse({
    id,
    runId,
    jobId,
    applicationRecordId,
    state: "awaiting_review",
    summary: `Result ${id}`,
    detail: "Prepared for review.",
    startedAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:01:00.000Z",
  });
}

function task(
  id: string,
  runId: string,
  resultId: string,
  applicationRecordId: string,
  jobId: string,
) {
  return UserActionRequestSchema.parse({
    id,
    dedupeKey: `task:${id}`,
    revision: 1,
    kind: "login",
    state: "pending",
    scope: {
      type: "application",
      runId,
      jobId,
      applicationRecordId,
      resultId,
      replayCheckpointId: null,
      source: "target_site",
    },
    verification: {
      type: "page_blocker_absent",
      blockerFingerprint: `blocker_${id}`,
      expectedPageFingerprint: null,
    },
    title: `Task ${id}`,
    summary: "Sign in to continue.",
    createdAt: "2026-08-23T10:01:00.000Z",
    updatedAt: "2026-08-23T10:01:00.000Z",
  });
}

describe("campaign snapshot application attribution", () => {
  test("keeps shared-job records, runs, tasks, and counts on exact campaign lineage", async () => {
    const campaignOneId = "campaign_default";
    const campaignTwoId = "campaign_two";
    const seed = createSeed();
    const applicationRecords = [
      record("application_a", sharedJobId),
      record("application_b", sharedJobId),
      record("application_legacy_unique", uniqueJobId),
      record("application_legacy_ambiguous", sharedJobId),
    ];
    const applyRuns = [
      run("run_one", campaignOneId, sharedJobId),
      run("run_two", campaignTwoId, sharedJobId),
      run("run_legacy_unique", null, uniqueJobId),
      run("run_legacy_ambiguous", null, sharedJobId),
    ];
    const applyJobResults = [
      result("result_one", "run_one", "application_a", sharedJobId),
      result("result_two", "run_two", "application_b", sharedJobId),
      result(
        "result_legacy_unique",
        "run_legacy_unique",
        "application_legacy_unique",
        uniqueJobId,
      ),
      result(
        "result_legacy_ambiguous",
        "run_legacy_ambiguous",
        "application_legacy_ambiguous",
        sharedJobId,
      ),
    ];
    const harness = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        applicationRecords,
        applyRuns,
        applyJobResults,
        userActionRequests: [
          task("task_a", "run_one", "result_one", "application_a", sharedJobId),
          task("task_b", "run_two", "result_two", "application_b", sharedJobId),
          task(
            "task_legacy_unique",
            "run_legacy_unique",
            "result_legacy_unique",
            "application_legacy_unique",
            uniqueJobId,
          ),
          task(
            "task_legacy_ambiguous",
            "run_legacy_ambiguous",
            "result_legacy_ambiguous",
            "application_legacy_ambiguous",
            sharedJobId,
          ),
        ],
      },
    });

    const initial = await harness.workspaceService.getWorkspaceSnapshot();
    const campaignOne = initial.campaigns[0];
    if (!campaignOne) throw new Error("Expected the adopted campaign.");
    await harness.repository.saveCampaignState({
      activeCampaignId: campaignOneId,
      notifications: [],
      campaigns: [
        campaignOne,
        {
          ...campaignOne,
          id: campaignTwoId,
          name: "Campaign Two",
          jobIds: [sharedJobId],
          history: [],
        },
      ],
    });

    const campaignOneSnapshot =
      await harness.workspaceService.getWorkspaceSnapshot();
    expect(campaignOneSnapshot.applicationRecords).toHaveLength(4);
    expect(
      campaignOneSnapshot.userActionRequests.map((request) => request.id),
    ).toEqual(["task_a", "task_legacy_unique"]);
    expect(campaignOneSnapshot.dashboard).toMatchObject({
      activeCampaignId: campaignOneId,
      applicationsReadyForApproval: 2,
      needsYouCount: 2,
      backgroundOperationCount: 0,
    });
    expect(
      campaignOneSnapshot.campaigns.find(
        (campaign) => campaign.id === campaignOneId,
      )?.progress,
    ).toMatchObject({ applicationsPrepared: 2, blockedCount: 2 });

    const campaignTwoSnapshot =
      await harness.workspaceService.selectCampaign(campaignTwoId);
    expect(campaignTwoSnapshot.dashboard).toMatchObject({
      activeCampaignId: campaignTwoId,
      applicationsReadyForApproval: 1,
      needsYouCount: 1,
      backgroundOperationCount: 0,
    });
    expect(
      campaignTwoSnapshot.userActionRequests.map((request) => request.id),
    ).toEqual(["task_b"]);
    expect(
      campaignTwoSnapshot.campaigns.find(
        (campaign) => campaign.id === campaignTwoId,
      )?.progress,
    ).toMatchObject({ applicationsPrepared: 1, blockedCount: 1 });

    const switchedBack =
      await harness.workspaceService.selectCampaign(campaignOneId);
    expect(switchedBack.dashboard.applicationsReadyForApproval).toBe(2);
    expect(switchedBack.dashboard.needsYouCount).toBe(2);
  });
});
