import {
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const now = "2026-09-23T23:00:00.000Z";

function tabLimitHandoff(id: string, jobId: string) {
  return UserActionRequestSchema.parse({
    id,
    dedupeKey: `dedupe_${id}`,
    revision: 1,
    kind: "other",
    state: "pending",
    requirement: "required",
    scope: {
      type: "application",
      runId: "run_batch",
      jobId,
      applicationRecordId: `application_${jobId}`,
      resultId: `result_${jobId}`,
      replayCheckpointId: null,
      source: "target_site",
    },
    verification: {
      type: "page_blocker_absent",
      blockerFingerprint: `blocker_${id}`,
      expectedPageFingerprint: null,
    },
    title:
      "Complete the browser step to continue the Marble Finch Systems application",
    summary:
      "The live application page needs manual review. The runtime stopped without submitting after browser preparation failed: browserContext.newPage: Protocol error (Target.createTarget): Close a browser tab before opening another one. Complete this manual step in the Job Finder browser, then come back here and confirm so Job Finder can check the page again.",
    instructions: [],
    actionUrl: null,
    displayOrigin: null,
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    openedAt: null,
    resolvedAt: null,
    expiresAt: null,
  });
}

describe("hand-offs older builds made from the browser's tab limit", () => {
  test("leave Needs you on their own and read as never opened, with Try again", async () => {
    const seed = createSeed();
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "ready_for_review",
        lastActionLabel: "Complete the browser step",
        nextActionLabel: "Open the Job Finder browser",
        lastAttemptState: "paused",
        lastUpdatedAt: now,
      }),
    ];
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "run_batch",
        campaignId: null,
        state: "paused_for_user_review",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        summary: "Waiting on you.",
        detail: "A browser step needs you.",
        totalJobs: 1,
        pendingJobs: 0,
        blockedJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "result_job_ready",
        runId: "run_batch",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "blocked",
        summary: "Complete the browser step",
        detail: "Protocol error (Target.createTarget)",
        startedAt: now,
        updatedAt: now,
      }),
    ];
    seed.userActionRequests = [tabLimitHandoff("request_tabs", "job_ready")];
    const harness = createWorkspaceServiceHarness({ seed });

    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();

    expect(
      snapshot.userActionRequests.find(
        (request) => request.id === "request_tabs",
      ),
    ).toEqual(expect.objectContaining({ state: "cancelled" }));
    const record = (await harness.repository.listApplicationRecords()).find(
      (entry) => entry.id === "application_job_ready",
    );
    expect(record).toEqual(
      expect.objectContaining({
        lastAttemptState: "failed",
      }),
    );
    expect(record?.lastActionLabel).toMatch(/too many tabs/);
    const [result] = await harness.repository.listApplyJobResults({
      runId: "run_batch",
    });
    expect(result).toEqual(
      expect.objectContaining({
        state: "failed",
        summary: "The Job Finder browser had too many tabs open",
      }),
    );
  });
});
