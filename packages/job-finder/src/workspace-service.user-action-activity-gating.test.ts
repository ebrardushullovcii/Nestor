import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "@nestor/db";
import {
  ApplicationAttemptBlockerSchema,
  ApplyExecutionResultSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
} from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { persistApplicationUserAction } from "./internal/workspace-application-user-action";
import { USER_ACTION_RESUMPTION_CONCURRENCY } from "./internal/workspace-user-action-methods";
import { createJobFinderWorkspaceService } from "./index";
import { reduceUserActionCommand } from "./user-action-domain";
import { createWorkspaceServiceHarness } from "./workspace-service.test-support";
import { createSeed } from "./workspace-service.test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "./workspace-service.test-runtimes";

const PAUSED_CONTROL = {
  paused: true,
  pausedAt: "2026-07-30T09:00:00.000Z",
  reason: "Paused for user-action activity gating tests.",
} as const;

afterEach(() => {
  vi.useRealTimers();
});

function authenticatedSourceAccess() {
  return vi.fn(() =>
    Promise.resolve({
      state: "authenticated" as const,
      currentOrigin: "https://www.linkedin.com/",
      checkedAt: "2026-07-30T10:30:00.000Z",
      signals: ["account_menu_control" as const],
    }),
  );
}

/** One login-blocked pending action per synthesized job. */
async function persistLoginBlockedActions(
  repository: JobFinderRepository,
  count: number,
): Promise<void> {
  const sourceJob = (await repository.listSavedJobs())[0];
  if (!sourceJob) throw new Error("Expected a saved job fixture.");
  const jobs = Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return {
      ...sourceJob,
      id: `job_gate_${suffix}`,
      sourceJobId: `gate_${suffix}`,
      canonicalUrl: `https://www.linkedin.com/jobs/view/gate_${suffix}`,
      applicationUrl: `https://www.linkedin.com/jobs/view/gate_${suffix}/apply`,
      title: `${sourceJob.title} ${suffix}`,
    };
  });
  await repository.commitSavedJobDelta({ upserts: jobs });

  for (const [index, job] of jobs.entries()) {
    await persistApplicationUserAction({
      repository,
      applicationRecordId: `application_${job.id}`,
      job,
      runId: `apply_run_gate_${index}`,
      resultId: `apply_result_gate_${index}`,
      replayCheckpointId: `apply_checkpoint_gate_${index}`,
      blocker: ApplicationAttemptBlockerSchema.parse({
        code: "site_login_required",
        summary: "Sign in before continuing.",
        detail: "The application page requires a browser-owned session.",
        questionIds: [],
        sourceDebugEvidenceRefIds: [],
        url: job.applicationUrl,
      }),
      occurredAt: `2026-07-30T10:${String(index).padStart(2, "0")}:00.000Z`,
    });
  }
}

/** Moves every pending request to verifying with its own exact command event. */
async function confirmAllPendingActions(
  repository: JobFinderRepository,
): Promise<void> {
  const requests = await repository.listUserActionRequests();
  for (const [index, request] of requests.entries()) {
    const reduction = reduceUserActionCommand(
      request,
      {
        action: "confirm_done",
        requestId: request.id,
        commandId: `confirm_gate_${index}`,
        expectedRevision: request.revision,
      },
      "2026-07-30T10:40:00.000Z",
    );
    if (reduction.status !== "applied") {
      throw new Error(`Expected request ${request.id} to confirm.`);
    }
    await repository.commitUserActionTransition({
      request: reduction.request,
      event: reduction.event,
    });
  }
}

async function addBegunPreparationLineages(
  repository: JobFinderRepository,
  count: number,
  startedAt: string,
): Promise<void> {
  const started = new Date(startedAt);
  const localDate = [
    started.getFullYear(),
    String(started.getMonth() + 1).padStart(2, "0"),
    String(started.getDate()).padStart(2, "0"),
  ].join("-");
  for (let index = 0; index < count; index += 1) {
    const runId = `apply_run_capacity_resume_${index}`;
    await repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: runId,
        mode: "copilot",
        state: "completed",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        createdAt: startedAt,
        updatedAt: startedAt,
        completedAt: startedAt,
        summary: "Seeded completed preparation.",
        detail: "Capacity fixture for user-action resumption.",
        totalJobs: 1,
        pendingJobs: 0,
      }),
    );
    await repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: `apply_result_capacity_resume_${index}`,
        runId,
        jobId: "job_ready",
        state: "awaiting_review",
        summary: "Preparation completed.",
        detail: "Capacity fixture for user-action resumption.",
        startedAt,
        updatedAt: startedAt,
        completedAt: startedAt,
        applicationPreparationStartedAt: startedAt,
        applicationPreparationStartedLocalDate: localDate,
      }),
    );
  }
}

async function startLoginBlockedResumptionHarness() {
  const seed = createSeed();
  seed.settings.resumeApplicationMode = "original_resume";
  seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
  const baseRuntime = createBrowserRuntime();
  const executeApplicationFlow = vi.fn(
    async (
      source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
      input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
    ) => {
      const baseResult = await baseRuntime.executeApplicationFlow(
        source,
        input,
      );
      if (input.recoveryContext) return baseResult;
      return ApplyExecutionResultSchema.parse({
        ...baseResult,
        state: "paused",
        summary: "Sign in to continue",
        detail: "The application page requires a browser-owned session.",
        blocker: {
          code: "site_login_required" as const,
          summary: "Sign in to continue",
          detail: "The application page requires a browser-owned session.",
          questionIds: [],
          sourceDebugEvidenceRefIds: [],
          url: input.job.applicationUrl ?? input.job.canonicalUrl,
        },
      });
    },
  );
  const harness = createWorkspaceServiceHarness({
    seed,
    browserRuntime: {
      ...baseRuntime,
      executeApplicationFlow,
      inspectSourceAccess: authenticatedSourceAccess(),
    },
  });
  const blocked =
    await harness.workspaceService.startApplyCopilotRun("job_ready");
  const request = blocked.userActionRequests[0];
  if (!request || request.scope.type !== "application") {
    throw new Error("Expected an application login request.");
  }
  return { ...harness, executeApplicationFlow, request };
}

describe("resolved user action resumption activity gating", () => {
  test("launches no flows while paused and resumes the prepare-only retry after unpause", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        if (input.recoveryContext) return baseResult;
        return ApplyExecutionResultSchema.parse({
          ...baseResult,
          state: "paused",
          summary: "Sign in to continue",
          detail: "The application page requires a browser-owned session.",
          blocker: {
            code: "site_login_required" as const,
            summary: "Sign in to continue",
            detail: "The application page requires a browser-owned session.",
            questionIds: [],
            sourceDebugEvidenceRefIds: [],
            url: input.job.applicationUrl ?? input.job.canonicalUrl,
          },
        });
      },
    );
    const inspectSourceAccess = authenticatedSourceAccess();
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess,
      },
    });
    const service = harness.workspaceService;
    const serviceRepository = harness.repository;

    const blocked = await service.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    if (!request || request.scope.type !== "application") {
      throw new Error("Expected an application login request.");
    }
    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);

    await service.setActivityControl(PAUSED_CONTROL);

    // Snapshot reads while paused must not launch any flow work.
    const pausedSnapshot = await service.getWorkspaceSnapshot();
    expect(pausedSnapshot.activityControl).toMatchObject({ paused: true });
    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);
    expect(inspectSourceAccess).not.toHaveBeenCalled();

    // Confirming the action while paused applies the transition but must not
    // launch the automatic prepare-only retry.
    const confirmed = await service.performUserAction({
      commandId: "confirm_while_paused",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });
    expect(confirmed.userActionRequests[0]).toMatchObject({
      id: request.id,
      state: "verifying",
    });
    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);
    expect(inspectSourceAccess).not.toHaveBeenCalled();

    // The paused action was not claimed or completed by a background flight:
    // only the original copilot run's own attempt exists, with no resumption
    // receipt for this request.
    expect(
      (await serviceRepository.listApplicationAttempts()).some(
        (entry) => entry.userActionResumption?.requestId === request.id,
      ),
    ).toBe(false);

    const stillPausedSnapshot = await service.getWorkspaceSnapshot();
    expect(
      stillPausedSnapshot.userActionRequests.find(
        (entry) => entry.id === request.id,
      ),
    ).toMatchObject({ state: "verifying" });
    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);

    await serviceRepository.saveActivityControl({
      paused: false,
      pausedAt: null,
      reason: null,
    });

    // The next snapshot on this same service retries an unclaimed verifying
    // action. A completed startup pass is only an in-flight dedupe boundary;
    // it must not strand later user answers until the app restarts.
    const resumed = await service.getWorkspaceSnapshot();

    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    const retryInput = executeApplicationFlow.mock.calls[1]?.[1];
    expect(retryInput).toMatchObject({
      mode: "prepare_only",
      accountCreationAuthorized: false,
      submitAuthorized: false,
      recoveryContext: {
        previousRunId: request.scope.runId,
        previousResultId: request.scope.resultId,
      },
    });
    expect(retryInput?.idempotencyKey).toContain(request.id);
    expect(
      executeApplicationFlow.mock.calls.every(
        ([, input]) =>
          input.mode === "prepare_only" && input.submitAuthorized === false,
      ),
    ).toBe(true);
    expect(resumed.userActionRequests[0]?.state).toBe("resolved");
    expect(resumed.applyJobResults[0]?.lastUserActionResumptionId).toContain(
      request.id,
    );
    const attempt = resumed.applicationAttempts.find(
      (entry) => entry.userActionResumption?.requestId === request.id,
    );
    expect(attempt?.completedAt).toBeTruthy();
    expect(attempt?.userActionResumption).toEqual(
      expect.objectContaining({
        requestId: request.id,
        runId: request.scope.runId,
        jobId: request.scope.jobId,
        resultId: request.scope.resultId,
        replayCheckpointId: request.scope.replayCheckpointId,
      }),
    );
  });

  test("an explicit unpause resumes verifying actions skipped during paused startup", async () => {
    const { repository, executeApplicationFlow, request } =
      await startLoginBlockedResumptionHarness();

    await repository.saveActivityControl(PAUSED_CONTROL);
    const reduction = reduceUserActionCommand(
      request,
      {
        action: "confirm_done",
        requestId: request.id,
        commandId: "confirm_before_paused_restart",
        expectedRevision: request.revision,
      },
      "2026-07-30T10:40:00.000Z",
    );
    if (reduction.status !== "applied") {
      throw new Error("Expected the pending action to enter verification.");
    }
    await repository.commitUserActionTransition({
      request: reduction.request,
      event: reduction.event,
    });

    const restartedService = createJobFinderWorkspaceService({
      repository,
      browserRuntime: {
        ...createBrowserRuntime(),
        executeApplicationFlow,
        inspectSourceAccess: authenticatedSourceAccess(),
      },
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    const pausedStartup = await restartedService.getWorkspaceSnapshot();
    expect(pausedStartup.activityControl.paused).toBe(true);
    expect(
      pausedStartup.userActionRequests.find((entry) => entry.id === request.id),
    ).toMatchObject({ state: "verifying" });
    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);

    const resumed = await restartedService.setActivityControl({
      paused: false,
    });
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(
      resumed.userActionRequests.find((entry) => entry.id === request.id),
    ).toMatchObject({ state: "resolved" });
  });

  test("rechecks deferred sign-in before resuming and lets an unsuccessful check be retried once", async () => {
    const { repository, executeApplicationFlow, request } =
      await startLoginBlockedResumptionHarness();
    await repository.saveActivityControl(PAUSED_CONTROL);
    await confirmAllPendingActions(repository);
    const inspectSourceAccess = authenticatedSourceAccess();
    inspectSourceAccess.mockRejectedValueOnce(
      new Error("Sign-in is not available yet."),
    );
    const restartedService = createJobFinderWorkspaceService({
      repository,
      browserRuntime: {
        ...createBrowserRuntime(),
        executeApplicationFlow,
        inspectSourceAccess,
      },
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    await restartedService.getWorkspaceSnapshot();
    expect(inspectSourceAccess).not.toHaveBeenCalled();
    const checked = await restartedService.setActivityControl({
      paused: false,
    });
    const blockedRequest = checked.userActionRequests.find(
      (entry) => entry.id === request.id,
    );
    expect(blockedRequest?.state).toBe("still_blocked");
    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);
    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);
    if (!blockedRequest)
      throw new Error("Expected a retryable sign-in request.");

    const resumed = await restartedService.performUserAction({
      action: "confirm_done",
      commandId: "confirm_deferred_login_after_failed_check",
      requestId: blockedRequest.id,
      expectedRevision: blockedRequest.revision,
    });
    expect(
      resumed.userActionRequests.find((entry) => entry.id === request.id)
        ?.state,
    ).toBe("resolved");
    await restartedService.getWorkspaceSnapshot();
    expect(inspectSourceAccess).toHaveBeenCalledTimes(2);
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
  });

  test("resumes an already-marked exact lineage at full capacity without charging another slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 23, 12));
    const { workspaceService, repository, executeApplicationFlow, request } =
      await startLoginBlockedResumptionHarness();
    const scope = request.scope;
    if (scope.type !== "application") {
      throw new Error("Expected application scope.");
    }
    await addBegunPreparationLineages(repository, 19, new Date().toISOString());

    const resumed = await workspaceService.performUserAction({
      commandId: "confirm_marked_at_capacity",
      requestId: request.id,
      expectedRevision: request.revision,
      action: "confirm_done",
    });

    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    expect(resumed.userActionRequests[0]?.state).toBe("resolved");
    expect(
      resumed.applyJobResults.find((result) => result.id === scope.resultId)
        ?.applicationPreparationStartedAt,
    ).toBeTruthy();
    expect(
      resumed.applyJobResults.find((result) => result.id === scope.resultId)
        ?.applicationPreparationStartedLocalDate,
    ).toBe("2026-08-23");
  });


  test("processes twenty resumed actions without exceeding the defined concurrency", async () => {
    const ACTION_COUNT = 20;
    const seed = createSeed();
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => baseRuntime.executeApplicationFlow(source, input),
    );
    const inspectSourceAccess = authenticatedSourceAccess();
    const plainRepository = createInMemoryJobFinderRepository(seed);
    await persistLoginBlockedActions(plainRepository, ACTION_COUNT);
    await confirmAllPendingActions(plainRepository);

    const gateReads = { inFlight: 0, maxObserved: 0 };
    const instrumentedRepository: JobFinderRepository = {
      ...plainRepository,
      getActivityControl() {
        gateReads.inFlight += 1;
        gateReads.maxObserved = Math.max(
          gateReads.maxObserved,
          gateReads.inFlight,
        );
        return (async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return plainRepository.getActivityControl();
        })().finally(() => {
          gateReads.inFlight -= 1;
        });
      },
    };
    const service = createJobFinderWorkspaceService({
      repository: instrumentedRepository,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess,
      },
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    const snapshot = await service.getWorkspaceSnapshot();

    // Every flight enters through the fail-closed activity gate, so the
    // observed overlap of gate reads is exactly the resumption concurrency.
    expect(gateReads.maxObserved).toBeGreaterThan(1);
    expect(gateReads.maxObserved).toBeLessThanOrEqual(
      USER_ACTION_RESUMPTION_CONCURRENCY,
    );
    expect(inspectSourceAccess).toHaveBeenCalledTimes(ACTION_COUNT);
    // The synthetic lineages are stale, so retries are skipped before any
    // browser flow; nothing may launch regardless.
    expect(executeApplicationFlow).not.toHaveBeenCalled();
    // Exact-lineage campaign projection hides these deliberately stale
    // synthetic actions even though the bounded resumer processed them.
    expect(snapshot.userActionRequests).toEqual([]);

    // A duplicate read stays idempotent: nothing is reprocessed.
    await service.getWorkspaceSnapshot();
    expect(inspectSourceAccess).toHaveBeenCalledTimes(ACTION_COUNT);
    expect(gateReads.maxObserved).toBeLessThanOrEqual(
      USER_ACTION_RESUMPTION_CONCURRENCY,
    );
  });

  test("keeps concurrent duplicate snapshot reads single-flight", async () => {
    const ACTION_COUNT = 4;
    const seed = createSeed();
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => baseRuntime.executeApplicationFlow(source, input),
    );
    const inspectSourceAccess = authenticatedSourceAccess();
    const repository = createInMemoryJobFinderRepository(seed);
    await persistLoginBlockedActions(repository, ACTION_COUNT);
    await confirmAllPendingActions(repository);
    const service = createJobFinderWorkspaceService({
      repository,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess,
      },
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    const [first, second] = await Promise.all([
      service.getWorkspaceSnapshot(),
      service.getWorkspaceSnapshot(),
    ]);

    expect(inspectSourceAccess).toHaveBeenCalledTimes(ACTION_COUNT);
    expect(first.userActionRequests.map((entry) => entry.state)).toEqual(
      second.userActionRequests.map((entry) => entry.state),
    );
    expect(
      first.userActionRequests.every((entry) => entry.state === "resolved"),
    ).toBe(true);

    await service.getWorkspaceSnapshot();
    expect(inspectSourceAccess).toHaveBeenCalledTimes(ACTION_COUNT);
    expect(executeApplicationFlow).not.toHaveBeenCalled();
  });

  test("does not replay a claimed application retry while snapshots poll", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "C:/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    let executionCount = 0;
    let releaseRecovery = (): void => {};
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const executeApplicationFlow = vi.fn(
      async (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => {
        executionCount += 1;
        const baseResult = await baseRuntime.executeApplicationFlow(
          source,
          input,
        );
        if (executionCount === 1) {
          return ApplyExecutionResultSchema.parse({
            ...baseResult,
            state: "paused",
            summary: "A required answer needs you",
            detail: "Answer this question in the browser.",
            blocker: {
              code: "missing_candidate_answer",
              userActionKind: "manual_answer",
              summary: "Answer the required question.",
              questionIds: ["question_required"],
              url: input.job.applicationUrl ?? input.job.canonicalUrl,
            },
          });
        }
        await recoveryGate;
        return baseResult;
      },
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const blocked =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const request = blocked.userActionRequests[0];
    if (!request) throw new Error("Expected a manual application action.");

    const command = harness.workspaceService.performUserAction({
      action: "confirm_done",
      commandId: "confirm_claimed_retry",
      expectedRevision: request.revision,
      requestId: request.id,
    });
    await vi.waitFor(() => {
      expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    });
    expect(
      (await harness.repository.listApplicationAttempts()).find(
        (attempt) => attempt.userActionResumption?.requestId === request.id,
      ),
    ).toMatchObject({ state: "in_progress", completedAt: null });

    const pollingSnapshots = [
      harness.workspaceService.getWorkspaceSnapshot(),
      harness.workspaceService.getWorkspaceSnapshot(),
    ];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
    releaseRecovery();
    await Promise.all([command, ...pollingSnapshots]);
    expect(executeApplicationFlow).toHaveBeenCalledTimes(2);
  });

  test("fails closed when activity control cannot be read and stays resumable afterwards", async () => {
    const seed = createSeed();
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (
        source: Parameters<typeof baseRuntime.executeApplicationFlow>[0],
        input: Parameters<typeof baseRuntime.executeApplicationFlow>[1],
      ) => baseRuntime.executeApplicationFlow(source, input),
    );
    const inspectSourceAccess = authenticatedSourceAccess();
    const repository = createInMemoryJobFinderRepository(seed);
    await persistLoginBlockedActions(repository, 1);
    await confirmAllPendingActions(repository);
    const brokenActivityControl = new Error(
      "Activity control storage unavailable.",
    );
    const brokenRepository: JobFinderRepository = {
      ...repository,
      getActivityControl: () => Promise.reject(brokenActivityControl),
    };
    const service = createJobFinderWorkspaceService({
      repository: brokenRepository,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
        inspectSourceAccess,
      },
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    await expect(service.getWorkspaceSnapshot()).rejects.toThrow(
      /activity control storage/iu,
    );

    // Fail closed: no browser work launched and the action was not claimed,
    // completed, or failed while control could not be read.
    expect(executeApplicationFlow).not.toHaveBeenCalled();
    expect(inspectSourceAccess).not.toHaveBeenCalled();
    expect((await repository.listUserActionRequests())[0]).toMatchObject({
      state: "verifying",
    });
    expect(await repository.listApplicationAttempts()).toEqual([]);

    // Healing the control surface lets the same service retry the unclaimed
    // action on its next snapshot; recovery does not require an app restart.
    brokenRepository.getActivityControl = () => repository.getActivityControl();
    const healed = await service.getWorkspaceSnapshot();

    expect(inspectSourceAccess).toHaveBeenCalledTimes(1);
    expect((await repository.listUserActionRequests())[0]?.state).toBe(
      "resolved",
    );
    expect(
      healed.applicationAttempts.find(
        (entry) => entry.userActionResumption != null,
      ),
    ).toBeTruthy();
    expect(executeApplicationFlow).not.toHaveBeenCalled();
  });
});
