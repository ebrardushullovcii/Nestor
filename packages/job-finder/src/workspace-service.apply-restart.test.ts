import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplySubmitApprovalSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import { terminalizeApplicationAfterPreparedPageLost } from "./internal/workspace-application-user-action";
import {
  createAiClient,
  createBrowserRuntime,
  createSavedJob,
  createDocumentManager,
  createSeed,
} from "./workspace-service.test-support";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function createService(
  repository: ReturnType<typeof createInMemoryJobFinderRepository>,
  browserRuntime = createBrowserRuntime(),
) {
  return createJobFinderWorkspaceService({
    repository,
    browserRuntime,
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
  });
}

describe("apply restart recovery", () => {
  test("shutdown preserves a live Home queue after its first result commits while paused", async () => {
    // Exercise a deliberately parked queue with one unfinished job.
    vi.stubEnv("NESTOR_APPLICATION_PREPARATION_CONCURRENCY", "1");
    const seed = createSeed();
    const now = "2026-03-20T10:05:00.000Z";
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "/tmp/alex-vanguard.pdf";
    seed.savedJobs.push(
      createSavedJob({
        ...seed.savedJobs[0]!,
        id: "job_second",
        sourceJobId: "linkedin_pause_case",
        canonicalUrl: "https://www.linkedin.com/jobs/view/linkedin_pause_case",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_pause_case/apply",
        title: "Principal UX Engineer",
      }),
    );
    seed.activityControl = {
      paused: true,
      pausedAt: now,
      reason: "Paused by you.",
      pauseBehavior: "finish_current",
    };
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_live_park",
        mode: "queue_auto",
        state: "running",
        jobIds: ["job_ready", "job_second"],
        submitApprovalId: "approval_live_park",
        createdAt: now,
        updatedAt: now,
        totalJobs: 2,
        pendingJobs: 2,
        summary: "Automatic apply queue is running.",
        detail: "Two jobs are waiting.",
      }),
    ];
    seed.applySubmitApprovals = [
      ApplySubmitApprovalSchema.parse({
        id: "approval_live_park",
        runId: "apply_run_live_park",
        mode: "queue_auto",
        jobIds: ["job_ready", "job_second"],
        status: "approved",
        createdAt: now,
        approvedAt: now,
      }),
    ];
    seed.applyJobResults = ["job_ready", "job_second"].map((jobId, index) =>
      ApplyJobResultSchema.parse({
        id: `result_live_${index}`,
        runId: "apply_run_live_park",
        jobId,
        applicationRecordId: `application_${jobId}`,
        queuePosition: index,
        state: "planned",
        summary: "Not started.",
        detail: "Waiting for Resume.",
        startedAt: now,
        updatedAt: now,
      }),
    );
    seed.applicationRecords = ["job_ready", "job_second"].map((jobId) =>
      ApplicationRecordSchema.parse({
        id: `application_${jobId}`,
        jobId,
        title:
          jobId === "job_ready"
            ? "Senior Product Designer"
            : "Principal UX Engineer",
        company: "Signal Systems",
        status: "approved",
        lastActionLabel: "Waiting for Resume.",
        nextActionLabel: null,
        lastUpdatedAt: now,
      }),
    );
    const repository = createInMemoryJobFinderRepository(seed);
    const baseRuntime = createBrowserRuntime();
    let flowCount = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const service = createService(repository, {
      ...baseRuntime,
      async executeApplicationFlow(...args) {
        flowCount += 1;
        if (flowCount === 1) await firstGate;
        return baseRuntime.executeApplicationFlow(...args);
      },
    });
    await service.getWorkspaceSnapshot();
    await service.setActivityControl({ paused: false });
    await vi.waitFor(() => expect(flowCount).toBe(1));
    await service.setActivityControl({
      paused: true,
      pauseBehavior: "finish_current",
      reason: "Paused by you.",
    });
    releaseFirst?.();
    await vi.waitFor(async () =>
      expect(
        (await repository.listApplyJobResults()).find(
          (result) => result.id === "result_live_0",
        )?.state,
      ).toBe("awaiting_review"),
    );
    expect(
      (await repository.listApplyJobResults()).find(
        (result) => result.id === "result_live_1",
      )?.state,
    ).toBe("planned");
    expect(flowCount).toBe(1);
    await service.shutdown();
    expect((await repository.listApplyRuns())[0]).toMatchObject({
      id: "apply_run_live_park",
      state: "running",
    });
    expect(
      (await repository.listApplyJobResults()).map((result) => result.state),
    ).toEqual(["awaiting_review", "planned"]);
  });

  test("reopens a safely parked Home queue and resumes its same run only once", async () => {
    const seed = createSeed();
    const now = "2026-03-20T10:05:00.000Z";
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "/tmp/alex-vanguard.pdf";
    seed.activityControl = {
      paused: true,
      pausedAt: now,
      reason: "Paused by you.",
      pauseBehavior: "finish_current",
    };
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_parked",
        mode: "queue_auto",
        state: "running",
        jobIds: ["job_settled", "job_ready"],
        currentJobId: "job_settled",
        submitApprovalId: "approval_parked",
        createdAt: now,
        updatedAt: now,
        totalJobs: 2,
        pendingJobs: 1,
        failedJobs: 1,
        summary: "Paused before the next application.",
        detail: "The first result was committed before pausing.",
      }),
    ];
    seed.applySubmitApprovals = [
      ApplySubmitApprovalSchema.parse({
        id: "approval_parked",
        runId: "apply_run_parked",
        mode: "queue_auto",
        jobIds: ["job_settled", "job_ready"],
        status: "approved",
        createdAt: now,
        approvedAt: now,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "result_settled",
        runId: "apply_run_parked",
        jobId: "job_settled",
        applicationRecordId: "application_settled",
        queuePosition: 0,
        state: "failed",
        summary: "Could not prepare this application.",
        detail: "The first result was committed.",
        startedAt: now,
        updatedAt: now,
        completedAt: now,
      }),
      ApplyJobResultSchema.parse({
        id: "result_planned",
        runId: "apply_run_parked",
        jobId: "job_ready",
        applicationRecordId: "application_ready",
        queuePosition: 1,
        state: "planned",
        summary: "Not started.",
        detail: "Waiting for Resume.",
        startedAt: now,
        updatedAt: now,
      }),
    ];
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "approved",
        lastActionLabel: "Waiting for Resume.",
        nextActionLabel: null,
        lastUpdatedAt: now,
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);
    const beforeClose = createService(repository);
    expect(
      (await beforeClose.getWorkspaceSnapshot()).applyRuns.find(
        (run) => run.id === "apply_run_parked",
      )?.state,
    ).toBe("running");
    await beforeClose.shutdown();

    const baseRuntime = createBrowserRuntime();
    let flowCount = 0;
    let releaseFlow: (() => void) | undefined;
    const flowGate = new Promise<void>((resolve) => {
      releaseFlow = resolve;
    });
    const reopened = createService(repository, {
      ...baseRuntime,
      async executeApplicationFlow(...args) {
        flowCount += 1;
        await flowGate;
        return baseRuntime.executeApplicationFlow(...args);
      },
    });
    const reopenedSnapshot = await reopened.getWorkspaceSnapshot();
    expect(reopenedSnapshot.activityControl.paused).toBe(true);
    expect(
      reopenedSnapshot.applyRuns.find((run) => run.id === "apply_run_parked")
        ?.state,
    ).toBe("running");
    expect(
      reopenedSnapshot.applyJobResults.find(
        (result) => result.id === "result_settled",
      )?.state,
    ).toBe("failed");
    expect(
      reopenedSnapshot.applyJobResults.find(
        (result) => result.id === "result_planned",
      )?.state,
    ).toBe("planned");

    await Promise.all([
      reopened.setActivityControl({ paused: false }),
      reopened.setActivityControl({ paused: false }),
    ]);
    await vi.waitFor(() => expect(flowCount).toBe(1));
    expect((await repository.listApplyRuns())[0]?.id).toBe("apply_run_parked");
    releaseFlow?.();
    await vi.waitFor(async () =>
      expect((await repository.listApplyRuns())[0]?.state).not.toBe("running"),
    );
    expect(flowCount).toBe(1);
    expect(
      (await repository.listApplyJobResults()).find(
        (result) => result.id === "result_planned",
      )?.state,
    ).not.toBe("planned");
    expect(
      (await repository.listApplyJobResults()).find(
        (result) => result.id === "result_settled",
      )?.state,
    ).toBe("failed");
  });
  test("marks a hard-interrupted running apply as failed when the workspace reopens", async () => {
    const seed = createSeed();
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_before_restart",
        mode: "queue_auto",
        state: "running",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        submitApprovalId: "apply_approval_before_restart",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:01:00.000Z",
        completedAt: null,
        summary: "Automatic apply queue is running in safe review mode.",
        detail:
          "This safe execution can prepare applications but stops before final submit.",
        totalJobs: 1,
        pendingJobs: 1,
        submittedJobs: 0,
        skippedJobs: 0,
        blockedJobs: 0,
        failedJobs: 0,
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const reopenedService = createService(repository);
    const snapshot = await reopenedService.getWorkspaceSnapshot();
    const recoveredRun = snapshot.applyRuns.find(
      (run) => run.id === "apply_run_before_restart",
    );

    expect(recoveredRun).toMatchObject({
      state: "failed",
      summary: "Automatic apply stopped because the app closed.",
      detail:
        "The app closed before safe application preparation finished. No final submit action was taken, and any preparation saved before the interruption remains available for review.",
    });
    expect(recoveredRun?.completedAt).not.toBeNull();
    expect(snapshot.applyRuns.some((run) => run.state === "running")).toBe(
      false,
    );
    expect((await repository.listApplyRuns())[0]).toEqual(recoveredRun);

    const secondSnapshot = await reopenedService.getWorkspaceSnapshot();
    expect(
      secondSnapshot.applyRuns.find(
        (run) => run.id === "apply_run_before_restart",
      ),
    ).toEqual(recoveredRun);
  });

  test("terminalizes a begun planned result during restart recovery while preserving its capacity mark", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 20, 12));
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_marked_before_restart",
        mode: "queue_auto",
        state: "running",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        summary: "Automatic apply queue is running in safe review mode.",
        detail: "Preparation started before the process stopped.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_marked_before_restart",
        runId: "apply_run_marked_before_restart",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        queuePosition: 0,
        state: "planned",
        summary: "Application preparation is planned.",
        detail: "The durable start mark committed before browser completion.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        applicationPreparationStartedAt: startedAt,
        applicationPreparationStartedLocalDate: "2026-03-20",
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const snapshot = await createService(repository).getWorkspaceSnapshot();
    const recoveredRun = snapshot.applyRuns.find(
      (run) => run.id === "apply_run_marked_before_restart",
    );
    const recoveredResult = snapshot.applyJobResults.find(
      (result) => result.id === "apply_result_marked_before_restart",
    );

    expect(recoveredRun).toMatchObject({
      state: "failed",
      summary: "Automatic apply stopped because the app closed.",
    });
    expect(recoveredResult).toMatchObject({
      state: "failed",
      completedAt: expect.any(String) as string,
      summary: "Application preparation stopped before review.",
      applicationPreparationStartedAt: startedAt,
      applicationPreparationStartedLocalDate: "2026-03-20",
    });
    // The interrupted-but-begun slot keeps consuming today's daily capacity.
    expect(
      snapshot.dashboard.globalDailyApplicationPreparationCapacity,
    ).toMatchObject({ used: 1, remaining: 19 });
    expect((await repository.listApplyJobResults())[0]).toEqual(
      recoveredResult,
    );

    const secondSnapshot =
      await createService(repository).getWorkspaceSnapshot();
    expect(
      secondSnapshot.applyRuns.find(
        (run) => run.id === "apply_run_marked_before_restart",
      ),
    ).toEqual(recoveredRun);
    expect(
      secondSnapshot.applyJobResults.find(
        (result) => result.id === "apply_result_marked_before_restart",
      ),
    ).toEqual(recoveredResult);
  });

  test("terminalizes interrupted planned results during restart recovery while keeping begun capacity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 20, 12));
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_mixed_queue",
        mode: "queue_auto",
        state: "running",
        jobIds: ["job_ready", "job_generating"],
        currentJobId: "job_generating",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        summary: "Automatic apply queue is running in safe review mode.",
        detail: "The second queued job was staged when the process stopped.",
        totalJobs: 2,
        pendingJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_never_began",
        runId: "apply_run_mixed_queue",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        queuePosition: 0,
        state: "planned",
        summary: "Application preparation is starting.",
        detail:
          "The browser application flow has not reached a review checkpoint yet.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
      }),
      ApplyJobResultSchema.parse({
        id: "apply_result_began_before_restart",
        runId: "apply_run_mixed_queue",
        jobId: "job_generating",
        applicationRecordId: "application_job_generating",
        queuePosition: 1,
        state: "planned",
        summary: "Application preparation is starting.",
        detail: "The durable start mark committed before browser completion.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        applicationPreparationStartedAt: startedAt,
        applicationPreparationStartedLocalDate: "2026-03-20",
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const service = createService(repository);
    const snapshot = await service.getWorkspaceSnapshot();
    const recoveredRun = snapshot.applyRuns.find(
      (run) => run.id === "apply_run_mixed_queue",
    );
    const recoveredNeverBeganResult = snapshot.applyJobResults.find(
      (result) => result.id === "apply_result_never_began",
    );
    const recoveredBegunResult = snapshot.applyJobResults.find(
      (result) => result.id === "apply_result_began_before_restart",
    );

    expect(recoveredRun).toMatchObject({
      state: "failed",
      completedAt: expect.any(String) as string,
    });
    expect(recoveredNeverBeganResult).toMatchObject({
      state: "failed",
      completedAt: expect.any(String) as string,
      summary: "Application preparation stopped before it began.",
      detail: expect.stringContaining(
        "No final submit action occurred",
      ) as string,
    });
    // Legacy rows persist without preparation marks at all; recovery must
    // treat them as never-begun and rewrite explicit nulls so downstream
    // begun-capacity accounting never reads them as uncertain evidence.
    expect(
      recoveredNeverBeganResult?.applicationPreparationStartedAt,
    ).toBeNull();
    expect(
      recoveredNeverBeganResult?.applicationPreparationStartedLocalDate,
    ).toBeNull();
    expect(recoveredBegunResult).toMatchObject({
      state: "failed",
      completedAt: expect.any(String) as string,
      summary: "Application preparation stopped before review.",
      applicationPreparationStartedAt: startedAt,
      applicationPreparationStartedLocalDate: "2026-03-20",
    });
    expect(
      snapshot.dashboard.globalDailyApplicationPreparationCapacity,
    ).toMatchObject({ used: 1, legacyUncertain: 0, remaining: 19 });

    const persistedResults = await repository.listApplyJobResults();
    expect(
      persistedResults.find((r) => r.id === "apply_result_never_began"),
    ).toEqual(recoveredNeverBeganResult);
    expect(
      persistedResults.find(
        (r) => r.id === "apply_result_began_before_restart",
      ),
    ).toEqual(recoveredBegunResult);

    const secondSnapshot = await service.getWorkspaceSnapshot();
    expect(
      secondSnapshot.applyRuns.find(
        (run) => run.id === "apply_run_mixed_queue",
      ),
    ).toEqual(recoveredRun);
    expect(
      secondSnapshot.applyJobResults.find(
        (result) => result.id === "apply_result_never_began",
      ),
    ).toEqual(recoveredNeverBeganResult);
    expect(
      secondSnapshot.applyJobResults.find(
        (result) => result.id === "apply_result_began_before_restart",
      ),
    ).toEqual(recoveredBegunResult);
  });

  test("projects an interrupted in-flight result, attempt, and record onto truthful failed states on reopen", async () => {
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_inflight_before_restart",
        mode: "copilot",
        state: "running",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        summary: "Apply copilot is preparing safely.",
        detail: "Stops before final submit.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_filling_before_restart",
        runId: "apply_run_inflight_before_restart",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        queuePosition: 0,
        state: "filling",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        applicationPreparationStartedAt: startedAt,
        applicationPreparationStartedLocalDate: "2026-03-20",
      }),
    ];
    seed.applicationAttempts = [
      ApplicationAttemptSchema.parse({
        id: "attempt_inflight_before_restart",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "in_progress",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt,
        updatedAt: startedAt,
        completedAt: null,
        nextActionLabel: null,
        outcome: null,
      }),
    ];
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "approved",
        lastActionLabel: "Filling prepared answers safely.",
        nextActionLabel: null,
        lastUpdatedAt: startedAt,
        lastAttemptState: "in_progress",
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const snapshot = await createService(repository).getWorkspaceSnapshot();
    const recoveredRun = snapshot.applyRuns.find(
      (run) => run.id === "apply_run_inflight_before_restart",
    );
    const recoveredResult = snapshot.applyJobResults.find(
      (result) => result.id === "apply_result_filling_before_restart",
    );
    const recoveredAttempt = snapshot.applicationAttempts.find(
      (attempt) => attempt.id === "attempt_inflight_before_restart",
    );
    const recoveredRecord = snapshot.applicationRecords.find(
      (record) => record.id === "application_job_ready",
    );

    expect(recoveredRun).toMatchObject({ state: "failed" });
    expect(recoveredResult).toMatchObject({
      state: "failed",
      summary: "Application preparation stopped when the app closed.",
      detail: expect.stringContaining(
        "No final submit action occurred",
      ) as string,
      // Exact lineage survives recovery untouched.
      applicationRecordId: "application_job_ready",
      applicationPreparationStartedAt: startedAt,
      applicationPreparationStartedLocalDate: "2026-03-20",
    });
    expect(recoveredAttempt).toMatchObject({
      state: "failed",
      summary: "Preparation stopped when the app closed.",
      nextActionLabel: "Retry preparation when you are ready.",
      applicationRecordId: "application_job_ready",
    });
    expect(recoveredRecord).toMatchObject({
      status: "approved",
      lastAttemptState: "failed",
      lastActionLabel: "Preparation stopped when the app closed.",
      nextActionLabel: "Retry preparation when you are ready.",
    });
    expect(recoveredRecord?.events).toHaveLength(1);
    expect(recoveredRecord?.events[0]).toMatchObject({
      title: "Preparation stopped because the app closed",
      emphasis: "warning",
    });

    const persistedAttempts = await repository.listApplicationAttempts();
    expect(persistedAttempts[0]).toEqual(recoveredAttempt);
    const persistedRecords = await repository.listApplicationRecords();
    expect(persistedRecords[0]).toEqual(recoveredRecord);

    const secondSnapshot =
      await createService(repository).getWorkspaceSnapshot();
    expect(
      secondSnapshot.applicationAttempts.find(
        (attempt) => attempt.id === "attempt_inflight_before_restart",
      ),
    ).toEqual(recoveredAttempt);
    expect(
      secondSnapshot.applicationRecords.find(
        (record) => record.id === "application_job_ready",
      ),
    ).toEqual(recoveredRecord);
  });

  test("preserves awaiting-review checkpoints and paused attempts during restart recovery", async () => {
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_mixed_checkpoints",
        mode: "queue_auto",
        state: "running",
        jobIds: ["job_ready", "job_generating"],
        currentJobId: "job_generating",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        summary: "Automatic apply queue is running in safe review mode.",
        detail: "The first job reached its review checkpoint before the close.",
        totalJobs: 2,
        pendingJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_awaiting_review",
        runId: "apply_run_mixed_checkpoints",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        queuePosition: 0,
        state: "awaiting_review",
        summary: "Application preparation is ready for review.",
        detail: "Stopped at the user-owned review checkpoint.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:01:00.000Z",
        completedAt: "2026-03-20T10:01:00.000Z",
        applicationPreparationStartedAt: startedAt,
        applicationPreparationStartedLocalDate: "2026-03-20",
      }),
      ApplyJobResultSchema.parse({
        id: "apply_result_still_filling",
        runId: "apply_run_mixed_checkpoints",
        jobId: "job_generating",
        applicationRecordId: "application_job_generating",
        queuePosition: 1,
        state: "filling",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt: "2026-03-20T10:02:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
      }),
    ];
    seed.applicationAttempts = [
      ApplicationAttemptSchema.parse({
        id: "attempt_paused_checkpoint",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "paused",
        summary: "Paused for user review.",
        detail: "The user owns this checkpoint.",
        startedAt,
        updatedAt: "2026-03-20T10:01:00.000Z",
        completedAt: null,
        nextActionLabel: null,
        outcome: null,
      }),
      ApplicationAttemptSchema.parse({
        id: "attempt_in_progress_interrupted",
        jobId: "job_generating",
        applicationRecordId: "application_job_generating",
        state: "in_progress",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt: "2026-03-20T10:02:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        nextActionLabel: null,
        outcome: null,
      }),
    ];
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "approved",
        lastActionLabel: "Paused for user review.",
        nextActionLabel: "Review the prepared application.",
        lastUpdatedAt: "2026-03-20T10:01:00.000Z",
        lastAttemptState: "paused",
      }),
      ApplicationRecordSchema.parse({
        id: "application_job_generating",
        jobId: "job_generating",
        title: "Product Design Lead",
        company: "Northwind Labs",
        status: "approved",
        lastActionLabel: "Filling prepared answers safely.",
        nextActionLabel: null,
        lastUpdatedAt: startedAt,
        lastAttemptState: "in_progress",
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const snapshot = await createService(repository).getWorkspaceSnapshot();

    // The awaiting-review row sits at a truthful user-owned checkpoint and
    // must survive restart recovery byte-for-byte.
    expect(
      snapshot.applyJobResults.find(
        (r) => r.id === "apply_result_awaiting_review",
      ),
    ).toMatchObject({
      state: "awaiting_review",
      summary: "Application preparation is ready for review.",
    });
    expect(
      snapshot.applicationAttempts.find(
        (a) => a.id === "attempt_paused_checkpoint",
      ),
    ).toMatchObject({
      state: "paused",
      summary: "Paused for user review.",
    });
    expect(
      snapshot.applicationRecords.find((r) => r.id === "application_job_ready"),
    ).toMatchObject({
      lastAttemptState: "paused",
      lastActionLabel: "Paused for user review.",
      events: [],
    });

    // The interrupted in-flight row terminalizes everywhere.
    expect(
      snapshot.applyJobResults.find(
        (r) => r.id === "apply_result_still_filling",
      ),
    ).toMatchObject({
      state: "failed",
      summary: "Application preparation stopped when the app closed.",
    });
    expect(
      snapshot.applicationAttempts.find(
        (a) => a.id === "attempt_in_progress_interrupted",
      ),
    ).toMatchObject({
      state: "failed",
    });
    expect(
      snapshot.applicationRecords.find(
        (r) => r.id === "application_job_generating",
      ),
    ).toMatchObject({
      lastAttemptState: "failed",
      lastActionLabel: "Preparation stopped when the app closed.",
    });
  });

  test.each(["present", "missing"] as const)(
    "makes a blocker-free review retryable on reopen when its exact prepared page binding is gone (%s review card)",
    async (reviewCardState) => {
      const seed = createSeed();
      const startedAt = "2026-03-20T10:00:30.000Z";
      seed.applyRuns = [
        ApplyRunSchema.parse({
          id: "apply_run_review_page_lost",
          mode: "copilot",
          state: "paused_for_user_review",
          jobIds: ["job_ready"],
          currentJobId: null,
          visualCheckpointsEnabled: false,
          createdAt: startedAt,
          updatedAt: startedAt,
          completedAt: null,
          summary: "Application is ready for review.",
          detail: "The prepared form is waiting for the person.",
          totalJobs: 1,
          pendingJobs: 1,
        }),
      ];
      seed.applyJobResults = [
        ApplyJobResultSchema.parse({
          id: "apply_result_review_page_lost",
          runId: "apply_run_review_page_lost",
          jobId: "job_ready",
          applicationRecordId: "application_job_ready",
          state: "awaiting_review",
          summary: "Application preparation is ready for review.",
          detail: "Stopped at the user-owned review checkpoint.",
          startedAt,
          updatedAt: startedAt,
          completedAt: startedAt,
          reviewCard:
            reviewCardState === "missing"
              ? null
              : {
                  siteLabel: "Test careers",
                  pageUrl: "https://signalsystems.example.com/apply",
                  answers: [],
                  attachments: [],
                  letter: null,
                  waitingOnYou: [],
                  preparedAt: startedAt,
                },
        }),
      ];
      seed.applicationRecords = [
        ApplicationRecordSchema.parse({
          id: "application_job_ready",
          jobId: "job_ready",
          title: "Senior Product Designer",
          company: "Signal Systems",
          status: "approved",
          lastActionLabel: "Paused for user review.",
          nextActionLabel: "Review and send the prepared application.",
          lastUpdatedAt: startedAt,
          lastAttemptState: "paused",
          automationMode: "confirm_before_submit",
        }),
      ];
      const liveBindingSeed = structuredClone(seed);
      const repository = createInMemoryJobFinderRepository(seed);
      const baseRuntime = createBrowserRuntime();
      const hasApplicationPageBinding = vi.fn().mockResolvedValue(false);
      const service = createJobFinderWorkspaceService({
        repository,
        browserRuntime: {
          ...baseRuntime,
          hasApplicationPageBinding,
        },
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });

      const snapshot = await service.getWorkspaceSnapshot();

      expect(hasApplicationPageBinding).toHaveBeenCalledWith(
        "target_site",
        "apply_result_review_page_lost",
      );
      expect(
        snapshot.applyJobResults.find(
          (result) => result.id === "apply_result_review_page_lost",
        ),
      ).toMatchObject({
        state: "failed",
        summary: "The prepared application page is no longer open.",
        blockerReason: "unexpected_navigation",
      });
      expect(
        snapshot.applicationRecords.find(
          (record) => record.id === "application_job_ready",
        ),
      ).toMatchObject({
        lastAttemptState: "failed",
        // The form was waiting on the person, who may have sent it.
        nextActionLabel: "Prepare again",
      });
      expect(
        snapshot.applyRuns.find(
          (run) => run.id === "apply_run_review_page_lost",
        ),
      ).toMatchObject({
        state: "completed",
        pendingJobs: 0,
        failedJobs: 1,
      });

      const liveBindingRepository =
        createInMemoryJobFinderRepository(liveBindingSeed);
      const liveBindingCheck = vi.fn().mockResolvedValue(true);
      const liveBindingSnapshot = await createJobFinderWorkspaceService({
        repository: liveBindingRepository,
        browserRuntime: {
          ...createBrowserRuntime(),
          hasApplicationPageBinding: liveBindingCheck,
        },
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      }).getWorkspaceSnapshot();

      expect(liveBindingCheck).toHaveBeenCalledWith(
        "target_site",
        "apply_result_review_page_lost",
      );
      expect(
        liveBindingSnapshot.applyJobResults.find(
          (result) => result.id === "apply_result_review_page_lost",
        ),
      ).toMatchObject({
        state: "awaiting_review",
        summary: "Application preparation is ready for review.",
      });
      expect(
        liveBindingSnapshot.applicationRecords.find(
          (record) => record.id === "application_job_ready",
        ),
      ).toMatchObject({
        lastAttemptState: "paused",
        nextActionLabel: "Review and send the prepared application.",
      });
    },
  );

  test.each(["present", "missing"] as const)(
    "does not mark a blocker-free review lost while its exact continuation is verifying (%s review card)",
    async (reviewCardState) => {
      const seed = createSeed();
      const startedAt = "2026-03-20T10:00:30.000Z";
      seed.applyRuns = [
        ApplyRunSchema.parse({
          id: "apply_run_review_page_live",
          mode: "copilot",
          state: "paused_for_user_review",
          jobIds: ["job_ready"],
          currentJobId: null,
          visualCheckpointsEnabled: false,
          createdAt: startedAt,
          updatedAt: startedAt,
          completedAt: null,
          summary: "Application is ready for review.",
          detail: "The prepared form is waiting for the person.",
          totalJobs: 1,
          pendingJobs: 1,
        }),
      ];
      seed.applyJobResults = [
        ApplyJobResultSchema.parse({
          id: "apply_result_review_page_live",
          runId: "apply_run_review_page_live",
          jobId: "job_ready",
          applicationRecordId: "application_job_ready",
          state: "awaiting_review",
          summary: "Application preparation is ready for review.",
          detail: "Stopped at the user-owned review checkpoint.",
          startedAt,
          updatedAt: startedAt,
          completedAt: startedAt,
          reviewCard:
            reviewCardState === "missing"
              ? null
              : {
                  siteLabel: "Test careers",
                  pageUrl: "https://signalsystems.example.com/apply",
                  answers: [],
                  attachments: [],
                  letter: null,
                  waitingOnYou: [],
                  preparedAt: startedAt,
                },
        }),
      ];
      seed.applicationRecords = [
        ApplicationRecordSchema.parse({
          id: "application_job_ready",
          jobId: "job_ready",
          title: "Senior Product Designer",
          company: "Signal Systems",
          status: "approved",
          lastActionLabel: "Paused for user review.",
          nextActionLabel: "Review and send the prepared application.",
          lastUpdatedAt: startedAt,
          lastAttemptState: "paused",
          automationMode: "confirm_before_submit",
        }),
      ];
      seed.activityControl = {
        paused: true,
        pausedAt: startedAt,
        reason: "Keep the verifying continuation parked during this snapshot.",
      };
      seed.userActionRequests = [
        UserActionRequestSchema.parse({
          id: "request_review_page_live",
          dedupeKey: "request_review_page_live",
          revision: 2,
          kind: "manual_answer",
          state: "verifying",
          requirement: "required",
          scope: {
            type: "application",
            runId: "apply_run_review_page_live",
            jobId: "job_ready",
            applicationRecordId: "application_job_ready",
            resultId: "apply_result_review_page_live",
            replayCheckpointId: null,
            source: "target_site",
          },
          verification: {
            type: "page_blocker_absent",
            blockerFingerprint: "manual-answer:blocker",
            expectedPageFingerprint: null,
          },
          title: "Continue the prepared application",
          summary: "The exact continuation is still being verified.",
          createdAt: startedAt,
          updatedAt: startedAt,
        }),
      ];
      const repository = createInMemoryJobFinderRepository(seed);
      const baseRuntime = createBrowserRuntime();
      const hasApplicationPageBinding = vi.fn().mockResolvedValue(false);
      const service = createJobFinderWorkspaceService({
        repository,
        browserRuntime: {
          ...baseRuntime,
          hasApplicationPageBinding,
        },
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });

      const snapshot = await service.getWorkspaceSnapshot();

      expect(hasApplicationPageBinding).not.toHaveBeenCalled();
      expect(
        snapshot.applyJobResults.find(
          (result) => result.id === "apply_result_review_page_live",
        ),
      ).toMatchObject({
        state: "awaiting_review",
        summary: "Application preparation is ready for review.",
      });
      expect(
        snapshot.applicationRecords.find(
          (record) => record.id === "application_job_ready",
        ),
      ).toMatchObject({
        lastAttemptState: "paused",
        nextActionLabel: "Review and send the prepared application.",
      });
    },
  );

  test("does not overwrite a submitting result when a stale binding check finishes", async () => {
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_submit_race",
        mode: "copilot",
        state: "running",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        visualCheckpointsEnabled: false,
        createdAt: startedAt,
        updatedAt: startedAt,
        summary: "Submitting the prepared application.",
        detail: "The final action owns this result now.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_submit_race",
        runId: "apply_run_submit_race",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "submitting",
        summary: "Submitting the prepared application.",
        detail: "Waiting for a durable employer outcome.",
        startedAt,
        updatedAt: startedAt,
      }),
    ];
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "approved",
        lastActionLabel: "Submitting the prepared application.",
        nextActionLabel: null,
        lastUpdatedAt: startedAt,
        lastAttemptState: "ready",
        automationMode: "confirm_before_submit",
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    await terminalizeApplicationAfterPreparedPageLost({
      repository,
      runId: "apply_run_submit_race",
      jobId: "job_ready",
      applicationRecordId: "application_job_ready",
      resultId: "apply_result_submit_race",
      occurredAt: "2026-03-20T10:01:00.000Z",
      eventId: "event_stale_binding_check",
    });

    expect((await repository.listApplyJobResults())[0]).toMatchObject({
      state: "submitting",
      summary: "Submitting the prepared application.",
    });
    expect((await repository.listApplicationRecords())[0]).toMatchObject({
      lastAttemptState: "ready",
      lastActionLabel: "Submitting the prepared application.",
    });
  });

  test("keeps legacy null-lineage results fail-closed without attributing them to a record", async () => {
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_legacy_lineage",
        mode: "copilot",
        state: "running",
        jobIds: ["job_generating"],
        currentJobId: "job_generating",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        summary: "Apply copilot is preparing safely.",
        detail: "Stops before final submit.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_legacy_null_record",
        runId: "apply_run_legacy_lineage",
        jobId: "job_generating",
        applicationRecordId: null,
        queuePosition: 0,
        state: "question_capture",
        summary: "Capturing application questions safely.",
        detail: "The browser application flow was underway.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
      }),
    ];
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_unlinked_same_job",
        jobId: "job_generating",
        title: "Product Design Lead",
        company: "Northwind Labs",
        status: "approved",
        lastActionLabel: "Filling prepared answers safely.",
        nextActionLabel: null,
        lastUpdatedAt: startedAt,
        lastAttemptState: "in_progress",
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const snapshot = await createService(repository).getWorkspaceSnapshot();

    // The legacy null-lineage result itself terminalizes truthfully...
    expect(
      snapshot.applyJobResults.find(
        (r) => r.id === "apply_result_legacy_null_record",
      ),
    ).toMatchObject({
      state: "failed",
      applicationRecordId: null,
      summary: "Application preparation stopped when the app closed.",
    });
    // ...but the same-job record without exact lineage stays untouched:
    // recovery must not infer attribution from jobId alone.
    expect(
      snapshot.applicationRecords.find(
        (r) => r.id === "application_unlinked_same_job",
      ),
    ).toMatchObject({
      lastAttemptState: "in_progress",
      lastActionLabel: "Filling prepared answers safely.",
      events: [],
    });
  });

  test("sweeps non-terminal results stranded under an already-terminal run by a prior partial recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 20, 12));
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    // The partial pass ran the previous local day, so its already-swept row
    // carries no same-day capacity evidence of its own.
    const priorRecoveryAt = "2026-03-19T10:05:00.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_partially_recovered",
        mode: "queue_auto",
        // Already terminal because an earlier recovery pass crashed after
        // committing this run but before sweeping its results and counters.
        state: "failed",
        jobIds: ["job_ready", "job_generating"],
        currentJobId: "job_generating",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: priorRecoveryAt,
        completedAt: priorRecoveryAt,
        summary: "Automatic apply stopped because the app closed.",
        detail:
          "The app closed before safe application preparation finished. No final submit action was taken, and any preparation saved before the interruption remains available for review.",
        totalJobs: 2,
        pendingJobs: 2,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_orphan_filling",
        runId: "apply_run_partially_recovered",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        queuePosition: 0,
        state: "filling",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        applicationPreparationStartedAt: startedAt,
        applicationPreparationStartedLocalDate: "2026-03-20",
      }),
      // Already terminalized by the partial pass, but its attempt/record
      // projections never landed because the pass died in between.
      ApplyJobResultSchema.parse({
        id: "apply_result_sweep_failed_unprojected",
        runId: "apply_run_partially_recovered",
        jobId: "job_generating",
        applicationRecordId: "application_job_generating",
        queuePosition: 1,
        state: "failed",
        summary: "Application preparation stopped when the app closed.",
        detail:
          "The app closed while this job's application preparation was underway, so it never reached its review checkpoint. No final submit action occurred.",
        startedAt: priorRecoveryAt,
        updatedAt: priorRecoveryAt,
        completedAt: priorRecoveryAt,
      }),
    ];
    seed.applicationAttempts = [
      ApplicationAttemptSchema.parse({
        id: "attempt_orphan_inflight",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "in_progress",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt,
        updatedAt: startedAt,
        completedAt: null,
        nextActionLabel: null,
        outcome: null,
      }),
      ApplicationAttemptSchema.parse({
        id: "attempt_stranded_projection",
        jobId: "job_generating",
        applicationRecordId: "application_job_generating",
        state: "in_progress",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt,
        updatedAt: startedAt,
        completedAt: null,
        nextActionLabel: null,
        outcome: null,
      }),
    ];
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "approved",
        lastActionLabel: "Filling prepared answers safely.",
        nextActionLabel: null,
        lastUpdatedAt: startedAt,
        lastAttemptState: "in_progress",
      }),
      ApplicationRecordSchema.parse({
        id: "application_job_generating",
        jobId: "job_generating",
        title: "Principal UX Engineer",
        company: "Northwind Labs",
        status: "approved",
        lastActionLabel: "Filling prepared answers safely.",
        nextActionLabel: null,
        lastUpdatedAt: startedAt,
        lastAttemptState: "in_progress",
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const snapshot = await createService(repository).getWorkspaceSnapshot();

    // The orphaned filling row terminalizes even though its parent run is no
    // longer running, and keeps its capacity mark.
    expect(
      snapshot.applyJobResults.find(
        (r) => r.id === "apply_result_orphan_filling",
      ),
    ).toMatchObject({
      state: "failed",
      summary: "Application preparation stopped when the app closed.",
      applicationPreparationStartedAt: startedAt,
      applicationPreparationStartedLocalDate: "2026-03-20",
      applicationRecordId: "application_job_ready",
    });
    // The already-terminal row is not rewritten...
    expect(
      snapshot.applyJobResults.find(
        (r) => r.id === "apply_result_sweep_failed_unprojected",
      ),
    ).toMatchObject({ updatedAt: priorRecoveryAt });
    // ...but its stranded exact-lineage attempt and record still heal.
    expect(
      snapshot.applicationAttempts.find(
        (a) => a.id === "attempt_orphan_inflight",
      ),
    ).toMatchObject({
      state: "failed",
      summary: "Preparation stopped when the app closed.",
      applicationRecordId: "application_job_ready",
    });
    expect(
      snapshot.applicationAttempts.find(
        (a) => a.id === "attempt_stranded_projection",
      ),
    ).toMatchObject({ state: "failed" });
    expect(
      snapshot.applicationRecords.find((r) => r.id === "application_job_ready"),
    ).toMatchObject({
      lastAttemptState: "failed",
      lastActionLabel: "Preparation stopped when the app closed.",
      events: [
        {
          id: "event_apply_run_partially_recovered_app_closed_recovery_application_job_ready",
          title: "Preparation stopped because the app closed",
          emphasis: "warning",
        },
      ],
    });
    expect(
      snapshot.applicationRecords.find(
        (r) => r.id === "application_job_generating",
      ),
    ).toMatchObject({
      lastAttemptState: "failed",
      events: [
        {
          id: "event_apply_run_partially_recovered_app_closed_recovery_application_job_generating",
        },
      ],
    });

    const persistedRun = (await repository.listApplyRuns()).find(
      (r) => r.id === "apply_run_partially_recovered",
    );
    if (!persistedRun) throw new Error("Expected the partially recovered run.");
    // The stale running-time counters the partial pass left behind are
    // recomputed truthfully without touching state, copy, or completion.
    expect(persistedRun).toMatchObject({
      state: "failed",
      summary: "Automatic apply stopped because the app closed.",
      completedAt: priorRecoveryAt,
      totalJobs: 2,
      pendingJobs: 0,
      failedJobs: 2,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
    });
    // The begun slot keeps consuming today's daily capacity.
    expect(
      snapshot.dashboard.globalDailyApplicationPreparationCapacity,
    ).toMatchObject({ used: 1, remaining: 19 });

    // Reopening again is a no-op: every sweep write is idempotent.
    const secondSnapshot =
      await createService(repository).getWorkspaceSnapshot();
    expect(
      secondSnapshot.applyRuns.find((r) => r.id === persistedRun.id),
    ).toEqual(persistedRun);
    expect(
      secondSnapshot.applyJobResults.find(
        (r) => r.id === "apply_result_orphan_filling",
      ),
    ).toEqual(
      snapshot.applyJobResults.find(
        (r) => r.id === "apply_result_orphan_filling",
      ),
    );
    expect(
      secondSnapshot.applicationRecords.find(
        (r) => r.id === "application_job_generating",
      ),
    ).toEqual(
      snapshot.applicationRecords.find(
        (r) => r.id === "application_job_generating",
      ),
    );
  });

  test("stops filling and queued results under a run the person cancelled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 20, 12));
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    const cancelledAt = "2026-03-20T10:05:00.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_user_cancelled",
        mode: "queue_auto",
        state: "cancelled",
        jobIds: ["job_ready", "job_generating"],
        currentJobId: "job_ready",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: cancelledAt,
        completedAt: cancelledAt,
        summary: "Automatic apply run cancelled.",
        detail:
          "The queued run was cancelled before final submit. Any completed preparation artifacts remain available for review.",
        totalJobs: 2,
        pendingJobs: 2,
      }),
    ];
    seed.applyJobResults = [
      // The worker never got to write its own stop, so this row kept saying
      // "filling" for hours beside "run cancelled".
      ApplyJobResultSchema.parse({
        id: "apply_result_cancelled_but_filling",
        runId: "apply_run_user_cancelled",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        queuePosition: 0,
        state: "filling",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        applicationPreparationStartedAt: startedAt,
        applicationPreparationStartedLocalDate: "2026-03-20",
      }),
      ApplyJobResultSchema.parse({
        id: "apply_result_cancelled_planned",
        runId: "apply_run_user_cancelled",
        jobId: "job_generating",
        applicationRecordId: "application_job_generating",
        queuePosition: 1,
        state: "planned",
        summary: "Queued.",
        detail: "Waiting for its turn.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:00:00.000Z",
        completedAt: null,
      }),
    ];
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "approved",
        lastActionLabel: "Filling prepared answers safely.",
        nextActionLabel: null,
        lastUpdatedAt: startedAt,
        lastAttemptState: "in_progress",
      }),
      ApplicationRecordSchema.parse({
        id: "application_job_generating",
        jobId: "job_generating",
        title: "Staff Engineer",
        company: "Signal Systems",
        status: "approved",
        lastActionLabel: "Queued.",
        nextActionLabel: null,
        lastUpdatedAt: "2026-03-20T10:00:00.000Z",
        lastAttemptState: null,
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const reopenedService = createService(repository);
    await reopenedService.getWorkspaceSnapshot();

    const results = await repository.listApplyJobResults();
    expect(
      results.find(
        (result) => result.id === "apply_result_cancelled_but_filling",
      ),
    ).toMatchObject({
      state: "failed",
      summary: "Application preparation was cancelled.",
    });
    expect(
      results.find((result) => result.id === "apply_result_cancelled_planned"),
    ).toMatchObject({
      state: "failed",
      summary: "Application preparation was cancelled.",
      updatedAt: cancelledAt,
      completedAt: cancelledAt,
    });
    const run = (await repository.listApplyRuns()).find(
      (candidate) => candidate.id === "apply_run_user_cancelled",
    );
    expect(run?.state).toBe("cancelled");
  });

  test("cancelled queued history cannot overtake or overwrite a newer submitted retry", async () => {
    const seed = createSeed();
    const cancelledAt = "2026-03-20T10:05:00.000Z";
    const submittedAt = "2026-03-20T11:00:00.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_old_cancelled",
        mode: "queue_auto",
        state: "cancelled",
        jobIds: ["job_ready"],
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: cancelledAt,
        completedAt: cancelledAt,
        summary: "Automatic apply run cancelled.",
        detail: "Stopped before this job began.",
        totalJobs: 1,
      }),
      ApplyRunSchema.parse({
        id: "apply_run_new_submitted",
        mode: "queue_auto",
        state: "completed",
        jobIds: ["job_ready"],
        createdAt: "2026-03-20T10:30:00.000Z",
        updatedAt: submittedAt,
        completedAt: submittedAt,
        summary: "Application submitted.",
        detail: "Submission confirmed.",
        totalJobs: 1,
        submittedJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_old_planned",
        runId: "apply_run_old_cancelled",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "planned",
        summary: "Queued.",
        detail: "Waiting its turn.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:00:00.000Z",
      }),
      ApplyJobResultSchema.parse({
        id: "apply_result_new_submitted",
        runId: "apply_run_new_submitted",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "submitted",
        summary: "Application sent.",
        detail: "Submission confirmed.",
        startedAt: "2026-03-20T10:30:00.000Z",
        updatedAt: submittedAt,
        completedAt: submittedAt,
      }),
    ];
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_job_ready",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "submitted",
        lastActionLabel: "Application sent.",
        nextActionLabel: null,
        lastUpdatedAt: submittedAt,
        lastAttemptState: "submitted",
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);
    const service = createService(repository);

    await service.getWorkspaceSnapshot();

    const results = await repository.listApplyJobResults();
    expect(
      results.find((result) => result.id === "apply_result_old_planned"),
    ).toMatchObject({
      state: "failed",
      updatedAt: cancelledAt,
    });
    expect(
      results.find((result) => result.id === "apply_result_new_submitted"),
    ).toMatchObject({
      state: "submitted",
      updatedAt: submittedAt,
    });
    expect(
      (await repository.listApplicationRecords()).find(
        (record) => record.id === "application_job_ready",
      ),
    ).toMatchObject({
      status: "submitted",
      lastAttemptState: "submitted",
    });
  });

  test("terminalizes an interrupted submitting result without claiming submission and recomputes run counters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 20, 12));
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_submitting_before_restart",
        mode: "queue_auto",
        state: "running",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        submitApprovalId: "approval_submitting_before_restart",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        summary: "Automatic apply queue is running.",
        detail: "The flow reached its submit step before the process stopped.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_submitting_before_restart",
        runId: "apply_run_submitting_before_restart",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        queuePosition: 0,
        state: "submitting",
        summary: "Reviewing final submit step.",
        detail: "The browser application flow was at the submit checkpoint.",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        applicationPreparationStartedAt: startedAt,
        applicationPreparationStartedLocalDate: "2026-03-20",
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const snapshot = await createService(repository).getWorkspaceSnapshot();
    const recoveredRun = snapshot.applyRuns.find(
      (run) => run.id === "apply_run_submitting_before_restart",
    );
    const recoveredResult = snapshot.applyJobResults.find(
      (result) => result.id === "apply_result_submitting_before_restart",
    );

    // A submitting row is in-flight work, not a submission claim: recovery
    // terminalizes it as failed with explicit no-submit copy.
    expect(recoveredResult).toMatchObject({
      state: "failed",
      summary: "Application preparation stopped when the app closed.",
      detail: expect.stringContaining(
        "No final submit action occurred",
      ) as string,
      applicationPreparationStartedAt: startedAt,
      applicationPreparationStartedLocalDate: "2026-03-20",
      applicationRecordId: "application_job_ready",
    });
    // The interrupted run's counters describe its durable end state instead
    // of retaining the stale running-time queue count.
    expect(recoveredRun).toMatchObject({
      state: "failed",
      completedAt: expect.any(String) as string,
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 1,
    });
    expect(JSON.stringify(snapshot)).not.toContain('"submitted"');
    expect((await repository.listApplyRuns())[0]).toEqual(recoveredRun);
    expect((await repository.listApplyJobResults())[0]).toEqual(
      recoveredResult,
    );
  });

  test("derives dashboard queue truth from recomputed interrupted-run counters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 20, 12));
    const seed = createSeed();
    const startedAt = "2026-03-20T10:00:30.000Z";
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "apply_run_queue_truth_running",
        mode: "queue_auto",
        campaignId: "campaign_default",
        state: "running",
        jobIds: ["job_ready", "job_generating"],
        currentJobId: "job_generating",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: startedAt,
        completedAt: null,
        summary: "Automatic apply queue is running.",
        detail: "Interrupted mid-queue.",
        totalJobs: 2,
        // Stale running-time count that must not survive recovery.
        pendingJobs: 2,
      }),
      ApplyRunSchema.parse({
        id: "apply_run_queue_truth_partial",
        mode: "queue_auto",
        campaignId: "campaign_default",
        state: "failed",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        visualCheckpointsEnabled: false,
        createdAt: "2026-03-20T09:00:00.000Z",
        updatedAt: "2026-03-20T09:05:00.000Z",
        completedAt: "2026-03-20T09:05:00.000Z",
        summary: "Automatic apply stopped because the app closed.",
        detail: "Left behind by a prior partial recovery.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "apply_result_queue_truth_awaiting",
        runId: "apply_run_queue_truth_running",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        queuePosition: 0,
        state: "awaiting_review",
        summary: "Application preparation is ready for review.",
        detail: "Stopped at the user-owned review checkpoint.",
        startedAt,
        updatedAt: startedAt,
        completedAt: startedAt,
        applicationPreparationStartedAt: startedAt,
        applicationPreparationStartedLocalDate: "2026-03-20",
      }),
      ApplyJobResultSchema.parse({
        id: "apply_result_queue_truth_filling",
        runId: "apply_run_queue_truth_running",
        jobId: "job_generating",
        applicationRecordId: "application_job_generating",
        queuePosition: 1,
        state: "filling",
        summary: "Filling prepared answers safely.",
        detail: "The browser application flow was underway.",
        startedAt,
        updatedAt: startedAt,
        completedAt: null,
      }),
      ApplyJobResultSchema.parse({
        id: "apply_result_queue_truth_orphan",
        runId: "apply_run_queue_truth_partial",
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        queuePosition: 0,
        state: "planned",
        summary: "Application preparation is planned.",
        detail: "Stranded by the prior partial pass.",
        startedAt: "2026-03-20T09:00:00.000Z",
        updatedAt: "2026-03-20T09:00:00.000Z",
        completedAt: null,
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    const snapshot = await createService(repository).getWorkspaceSnapshot();
    const activeCampaign = snapshot.campaigns.find(
      (campaign) => campaign.id === "campaign_default",
    );
    if (!activeCampaign) throw new Error("Expected the default campaign.");

    // Queue truth after recovery: only the preserved awaiting_review
    // checkpoint remains outstanding. The stale counts (2 + 1) are gone.
    expect(activeCampaign.progress).toMatchObject({
      remainingQueueSize: 1,
      currentBatchCompleted: 0,
      currentBatchTotal: 0,
    });
    const persistedRuns = await repository.listApplyRuns();
    expect(
      persistedRuns.find((r) => r.id === "apply_run_queue_truth_running"),
    ).toMatchObject({
      state: "failed",
      pendingJobs: 1,
      failedJobs: 1,
    });
    expect(
      persistedRuns.find((r) => r.id === "apply_run_queue_truth_partial"),
    ).toMatchObject({
      state: "failed",
      summary: "Automatic apply stopped because the app closed.",
      pendingJobs: 0,
      failedJobs: 1,
    });
  });
});
