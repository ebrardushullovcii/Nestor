import {
  ApplicationReplayCheckpointSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  DiscoveryLedgerEntrySchema,
  DiscoveryRunRecordSchema,
  JobFinderDiscoveryStateSchema,
  SourceDebugRunRecordSchema,
  UserActionEventSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";
import type { JobFinderRepositorySeed } from "@nestor/db";
import type {
  BrowserSessionRuntime,
  ExecuteApplicationFlowInput,
} from "@nestor/browser-runtime";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createBrowserRuntime,
  createSavedJob,
  createSavedJobDiscoveryProvenance,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

type Harness = ReturnType<typeof createWorkspaceServiceHarness>;
type ExecuteFlow = BrowserSessionRuntime["executeApplicationFlow"];

const inputRepositoryRef: { repository: Harness["repository"] | null } = {
  repository: null,
};
const inputServiceRef: {
  workspaceService: Harness["workspaceService"] | null;
} = { workspaceService: null };

async function approveTailoredResume(
  workspaceService: Harness["workspaceService"],
  jobId: string,
): Promise<void> {
  await workspaceService.generateResume(jobId);
  const exported = await workspaceService.exportResumePdf(jobId);
  const approvedExport = exported.resumeExportArtifacts.find(
    (artifact) => artifact.jobId === jobId,
  );
  if (!approvedExport) throw new Error("Expected an exported resume artifact.");
  await workspaceService.approveResume(jobId, approvedExport.id);
}

function createOriginalResumeHarness(options?: { cancelDuringFlow?: boolean }) {
  const seed = createSeed();
  seed.settings.resumeApplicationMode = "original_resume";
  seed.profile.baseResume.storagePath = "/tmp/alex-vanguard.pdf";
  const baseRuntime = createBrowserRuntime();
  const cancelDuringFlow: ExecuteFlow = async (source, flowInput, options) => {
    const repository = inputRepositoryRef.repository;
    const workspaceService = inputServiceRef.workspaceService;
    if (repository && workspaceService) {
      const running = (await repository.listApplyRuns()).find(
        (run) => run.state === "running",
      );
      if (running) {
        await workspaceService
          .cancelApplyRun(running.id)
          .catch(() => undefined);
      }
    }
    return baseRuntime.executeApplicationFlow(source, flowInput, options);
  };
  const harness = createWorkspaceServiceHarness({
    seed,
    ...(options?.cancelDuringFlow
      ? {
          browserRuntime: {
            ...baseRuntime,
            executeApplicationFlow: cancelDuringFlow,
          },
        }
      : {}),
  });
  inputRepositoryRef.repository = harness.repository;
  inputServiceRef.workspaceService = harness.workspaceService;
  return harness;
}

function stageReadyTailoredJob(
  seed: JobFinderRepositorySeed,
  jobId: string,
  sourceJobId: string,
  options?: {
    savedJob?: Partial<Parameters<typeof createSavedJob>[0]>;
    filePath?: string;
  },
): void {
  const filePath = options?.filePath ?? `/tmp/${jobId}-resume.pdf`;
  seed.savedJobs = [
    ...seed.savedJobs,
    createSavedJob({
      ...seed.savedJobs[0]!,
      id: jobId,
      sourceJobId,
      canonicalUrl: `https://www.linkedin.com/jobs/view/${sourceJobId}`,
      applicationUrl: `https://www.linkedin.com/jobs/view/${sourceJobId}/apply`,
      title: `Role ${jobId}`,
      status: "ready_for_review",
      ...options?.savedJob,
    }),
  ];
  seed.tailoredAssets = [
    ...seed.tailoredAssets,
    {
      ...seed.tailoredAssets[0]!,
      id: `asset_${jobId}`,
      jobId,
      storagePath: filePath,
    },
  ];
  seed.resumeDrafts = [
    ...seed.resumeDrafts,
    {
      id: `resume_draft_${jobId}`,
      jobId,
      status: "approved",
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "deterministic",
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      approvedAt: "2026-03-20T10:04:00.000Z",
      approvedExportId: `resume_export_${jobId}`,
      staleReason: null,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:04:00.000Z",
    },
  ];
  seed.resumeExportArtifacts = [
    ...seed.resumeExportArtifacts,
    {
      id: `resume_export_${jobId}`,
      draftId: `resume_draft_${jobId}`,
      jobId,
      format: "pdf",
      filePath,
      pageCount: 2,
      templateId: "classic_ats",
      exportedAt: "2026-03-20T10:04:00.000Z",
      isApproved: true,
    },
  ];
}

function createConsentQueueHarness(options?: {
  resumeConsentOnApproval?: boolean;
}) {
  const seed = createSeed();
  stageReadyTailoredJob(seed, "job_ready", "linkedin_signal_ready", {
    filePath: "/tmp/job-ready-resume.pdf",
  });
  stageReadyTailoredJob(seed, "job_consent_queue", "linkedin_consent_queue", {
    savedJob: {
      title: "Staff Product Designer",
      company: "Consent Labs",
      description:
        "Design the workflow system. This application asks whether you already have an account before continuing.",
    },
  });
  const baseRuntime = createBrowserRuntime();
  const flowedJobIds: string[] = [];
  let consentJobFlowCount = 0;
  const executeApplicationFlow: ExecuteFlow = async (
    source,
    input,
    flowOptions,
  ) => {
    flowedJobIds.push(input.job.id);
    if (input.job.id === "job_consent_queue") {
      consentJobFlowCount += 1;
    }
    return baseRuntime.executeApplicationFlow(
      source,
      options?.resumeConsentOnApproval && consentJobFlowCount > 1
        ? {
            ...input,
            job: {
              ...input.job,
              description: "Design the workflow system.",
            },
          }
        : input,
      flowOptions,
    );
  };
  const harness = createWorkspaceServiceHarness({
    seed,
    browserRuntime: { ...baseRuntime, executeApplicationFlow },
  });
  return { ...harness, flowedJobIds };
}

afterEach(() => vi.unstubAllEnvs());

describe("apply run cancellation and application record concurrency", () => {
  test("job-only preparation rejects ambiguous sibling application records", async () => {
    const seed = createSeed();
    const job = seed.savedJobs.find(
      (candidate) => candidate.id === "job_ready",
    )!;
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_a",
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: job.status,
        lastActionLabel: "First application",
        nextActionLabel: "Review",
        lastUpdatedAt: "2026-08-23T10:00:00.000Z",
      }),
      ApplicationRecordSchema.parse({
        id: "application_b",
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: job.status,
        lastActionLabel: "Second application",
        nextActionLabel: "Review",
        lastUpdatedAt: "2026-08-23T11:00:00.000Z",
      }),
    ];
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
    });

    await expect(workspaceService.startApplyCopilotRun(job.id)).rejects.toThrow(
      /explicit application selection is required/iu,
    );
    expect(await repository.listApplyRuns()).toHaveLength(0);
    expect(await repository.listApplicationRecords()).toEqual(
      seed.applicationRecords,
    );
  });

  test("a cancel that wins before staged auto writes leaves no worker artifacts", async () => {
    const { workspaceService, repository } = createOriginalResumeHarness({
      cancelDuringFlow: true,
    });

    const staged = await workspaceService.startAutoApplyRun("job_ready");
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged single-job auto run.");

    await expect(workspaceService.approveApplyRun(runId)).resolves.toBeTruthy();

    const [run] = await repository.listApplyRuns();
    expect(run?.state).toBe("cancelled");
    expect(run?.completedAt).not.toBeNull();

    const results = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === runId,
    );
    expect(results.every((result) => result.state === "failed")).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]?.applicationPreparationStartedAt).toBeTruthy();
    expect(results[0]?.applicationPreparationStartedLocalDate).toMatch(
      /^\d{4}-\d{2}-\d{2}$/u,
    );
    expect(
      (await workspaceService.getWorkspaceSnapshot()).dashboard
        .globalDailyApplicationPreparationCapacity,
    ).toMatchObject({ used: 1, remaining: 19 });
    expect(await repository.listApplicationAttempts()).toHaveLength(0);
    expect(
      (await repository.listUserActionRequests()).filter(
        (request) => request.scope.type === "application",
      ),
    ).toHaveLength(0);

    const record = (await repository.listApplicationRecords()).find(
      (entry) => entry.jobId === "job_ready",
    );
    expect(record?.lastAttemptState ?? null).toBeNull();
    expect(
      record?.events.some((event) => event.title.includes("cancelled")),
    ).toBe(true);
  });

  test("a cancel queued behind a committing staged run retains committed events", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "/tmp/alex-vanguard.pdf";
    const baseRuntime = createBrowserRuntime();
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: baseRuntime,
    });
    const { workspaceService, repository } = harness;

    const staged = await workspaceService.startAutoApplyRun("job_ready");
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged single-job auto run.");

    const originalUpsertAttempt =
      repository.upsertApplicationAttempt.bind(repository);
    const cancelPromises: Promise<void>[] = [];
    repository.upsertApplicationAttempt = async (attempt) => {
      await originalUpsertAttempt(attempt);
      // Queued, never awaited inside the held run transition.
      cancelPromises.push(
        workspaceService.cancelApplyRun(runId).then(
          () => undefined,
          () => undefined,
        ),
      );
    };

    await workspaceService.approveApplyRun(runId);
    if (cancelPromises.length === 0) {
      throw new Error("Expected the attempt upsert hook.");
    }
    await Promise.all(cancelPromises);

    const [run] = await repository.listApplyRuns();
    expect(run?.state).toBe("cancelled");

    const attempts = await repository.listApplicationAttempts();
    expect(attempts.length).toBe(1);

    const record = (await repository.listApplicationRecords()).find(
      (entry) => entry.jobId === "job_ready",
    );
    // Both the committed worker sync and the cancellation event survive; the
    // late cancel never resurrects or clobbers committed state.
    expect(record?.lastAttemptState).toBe("paused");
    expect(
      record?.events.some((event) => event.title.includes("cancelled")),
    ).toBe(true);
  });

  test("cross-run same-job cancel keeps the active run's committed sync and appends its own cancellation", async () => {
    const { workspaceService, repository } = createOriginalResumeHarness();

    const first = await workspaceService.startAutoApplyRun("job_ready");
    const second = await workspaceService.startAutoApplyRun("job_ready");
    const activeRunId = first.applyRuns[0]?.id;
    const cancelledRunId = second.applyRuns[0]?.id;
    if (!activeRunId || !cancelledRunId) {
      throw new Error("Expected two staged runs.");
    }

    const originalUpsertAttempt =
      repository.upsertApplicationAttempt.bind(repository);
    repository.upsertApplicationAttempt = async (attempt) => {
      await originalUpsertAttempt(attempt);
      // R2's cancel takes R2's run transition plus the job record tail while
      // the active worker only holds R1's run transition here.
      await workspaceService.cancelApplyRun(cancelledRunId);
    };

    await workspaceService.approveApplyRun(activeRunId);

    const runs = await repository.listApplyRuns();
    const activeRun = runs.find((run) => run.id === activeRunId);
    const cancelledRun = runs.find((run) => run.id === cancelledRunId);
    expect(cancelledRun?.state).toBe("cancelled");
    expect(activeRun?.state).toBe("paused_for_user_review");

    const attempts = await repository.listApplicationAttempts();
    expect(attempts.length).toBe(1);

    const record = (await repository.listApplicationRecords()).find(
      (entry) => entry.jobId === "job_ready",
    );
    expect(record?.lastAttemptState).toBe("paused");
    expect(
      record?.events.some((event) => event.title.includes("cancelled")),
    ).toBe(true);
  });

  test("an explicit null start target creates a new exact application record", async () => {
    const { workspaceService, repository } = createOriginalResumeHarness();

    const first = await workspaceService.startAutoApplyRun("job_ready");
    const firstResult = first.applyJobResults[0];
    if (!firstResult?.applicationRecordId) {
      throw new Error("Expected the initial exact application lineage.");
    }

    const second = await workspaceService.startAutoApplyRun("job_ready", null);
    const secondResult = second.applyJobResults.find(
      (result) => result.runId === second.selectedApplyRunId,
    );

    expect(secondResult?.applicationRecordId).toMatch(/^application_/u);
    expect(secondResult?.applicationRecordId).not.toBe(
      firstResult.applicationRecordId,
    );
    expect(
      (await repository.listApplicationRecords()).filter(
        (record) => record.jobId === "job_ready",
      ),
    ).toHaveLength(2);
  });

  test("copilot cancellation writes nothing after the cancelled run transition", async () => {
    const { workspaceService, repository } = createOriginalResumeHarness({
      cancelDuringFlow: true,
    });

    await expect(
      workspaceService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow();

    const runs = await repository.listApplyRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("cancelled");

    const results = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === runs[0]?.id,
    );
    expect(results.every((result) => result.state === "planned")).toBe(true);
    expect(await repository.listApplicationAttempts()).toHaveLength(0);
    expect(await repository.listApplicationConsentRequests()).toHaveLength(0);
    expect(await repository.listApplicationReplayCheckpoints()).toHaveLength(0);
    expect(await repository.listApplicationArtifactRefs()).toHaveLength(0);
    expect(
      (await repository.listUserActionRequests()).filter(
        (request) => request.scope.type === "application",
      ),
    ).toHaveLength(0);
  });

  test("missing-resume copilot cancellation reuses one cancellable run row and orphans no terminal artifacts", async () => {
    const seed = createSeed();
    const baseRuntime = createBrowserRuntime();
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: baseRuntime,
    });
    const { workspaceService, repository } = harness;

    const originalUpsertRun = repository.upsertApplyRun.bind(repository);
    let triggeredCancel = false;
    repository.upsertApplyRun = async (run) => {
      await originalUpsertRun(run);
      if (!triggeredCancel && run.state === "running") {
        triggeredCancel = true;
        await workspaceService.cancelApplyRun(run.id).catch(() => undefined);
      }
    };

    await expect(
      workspaceService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow();

    const runs = await repository.listApplyRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("cancelled");
    expect(runs[0]?.mode).toBe("copilot");

    const results = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === runs[0]?.id,
    );
    expect(results.every((result) => result.state === "planned")).toBe(true);
    expect(results).toEqual([
      expect.objectContaining({
        applicationPreparationStartedAt: null,
        applicationPreparationStartedLocalDate: null,
      }),
    ]);
    expect(
      (await workspaceService.getWorkspaceSnapshot()).dashboard
        .globalDailyApplicationPreparationCapacity,
    ).toMatchObject({ used: 0, remaining: 20 });
    expect(await repository.listApplicationConsentRequests()).toHaveLength(0);
    expect(await repository.listApplicationQuestionRecords({})).toHaveLength(0);
    expect(await repository.listApplicationReplayCheckpoints()).toHaveLength(0);
    expect(await repository.listApplicationArtifactRefs()).toHaveLength(0);
    expect(
      (await repository.listApplicationRecords()).find(
        (record) => record.jobId === "job_ready",
      ),
    ).toMatchObject({
      id: "application_job_ready",
      lastActionLabel: "Automatic apply run cancelled.",
    });
  });

  test("copilot resume approval closes the prerequisite run without manufacturing a review-ready result", async () => {
    const seed = createSeed();
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      (...args: Parameters<typeof baseRuntime.executeApplicationFlow>) =>
        baseRuntime.executeApplicationFlow(...args),
    );
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...baseRuntime,
        executeApplicationFlow,
      },
    });

    const blocked = await workspaceService.startApplyCopilotRun("job_ready");
    const runId = blocked.selectedApplyRunId;
    if (!runId) throw new Error("Expected the blocked copilot run.");
    const request = (
      await repository.listApplicationConsentRequests({
        runId,
        jobId: "job_ready",
      })
    )[0];
    if (!request) throw new Error("Expected the resume-use request.");

    const resolved = await workspaceService.resolveApplyConsentRequest(
      request.id,
      "approve",
    );

    expect(executeApplicationFlow).not.toHaveBeenCalled();
    expect(
      resolved.applyJobResults.find((result) => result.runId === runId),
    ).toMatchObject({
      state: "failed",
      blockerReason: null,
      summary: "Resume approval recorded. Retrying application preparation.",
    });
    expect(resolved.applyRuns.find((run) => run.id === runId)).toMatchObject({
      state: "completed",
      pendingJobs: 0,
      failedJobs: 1,
    });
    expect(
      resolved.applyRuns.find((run) => run.id === runId)?.completedAt,
    ).not.toBeNull();
    expect(
      resolved.applicationRecords.find(
        (record) => record.id === "application_job_ready",
      )?.lastAttemptState,
    ).toBe("failed");
  });

  test("direct approve cancellation writes no late result, job status, or user action", async () => {
    const { workspaceService, repository } = createOriginalResumeHarness({
      cancelDuringFlow: true,
    });

    await expect(workspaceService.approveApply("job_ready")).rejects.toThrow();

    const runs = await repository.listApplyRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("cancelled");

    const results = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === runs[0]?.id,
    );
    expect(results.every((result) => result.state === "planned")).toBe(true);
    expect(await repository.listApplicationAttempts()).toHaveLength(0);
    expect(
      (await repository.listUserActionRequests()).filter(
        (request) => request.scope.type === "application",
      ),
    ).toHaveLength(0);
    expect(
      (await repository.listSavedJobs()).find(
        (entry) => entry.id === "job_ready",
      )?.status,
    ).not.toBe("submitted");
  });

  test("CRM set-stage survives a later apply sync and stays revision-continuous", async () => {
    const { workspaceService, repository } = createOriginalResumeHarness();
    await approveTailoredResume(workspaceService, "job_ready");

    await workspaceService.startApplyCopilotRun("job_ready");
    const afterFirstSync = (await repository.listApplicationRecords()).find(
      (record) => record.jobId === "job_ready",
    );
    if (!afterFirstSync) throw new Error("Expected an application record.");

    await workspaceService.mutateApplicationCrm({
      applicationRecordId: afterFirstSync.id,
      expectedRevision: 0,
      mutation: {
        type: "set_stage",
        stage: "recruiter_contact",
        customStageId: null,
        note: "Recruiter replied.",
      },
    });

    // A second apply sync over the same job must merge on top of the fresh
    // CRM instead of resetting it to the schema default.
    await workspaceService.startApplyCopilotRun("job_ready");

    const afterSecondSync = (await repository.listApplicationRecords()).find(
      (record) => record.jobId === "job_ready",
    );
    expect(afterSecondSync?.crm).toMatchObject({
      revision: 1,
      stage: "recruiter_contact",
    });
    expect(
      afterSecondSync?.crm?.events.some(
        (event) => event.kind === "stage_changed",
      ),
    ).toBe(true);
    expect(afterSecondSync?.status).toBe("approved");
    expect(afterSecondSync?.lastAttemptState).toBe("paused");

    await workspaceService.mutateApplicationCrm({
      applicationRecordId: afterFirstSync.id,
      expectedRevision: 1,
      mutation: {
        type: "set_stage",
        stage: "assessment",
        customStageId: null,
        note: null,
      },
    });

    const settled = (await repository.listApplicationRecords()).find(
      (record) => record.jobId === "job_ready",
    );
    expect(settled?.crm).toMatchObject({ revision: 2, stage: "assessment" });
  });

  test("live-assistant writes and CRM mutations serialize per job without deadlock", async () => {
    const { workspaceService, repository } = createOriginalResumeHarness();
    await approveTailoredResume(workspaceService, "job_ready");
    await workspaceService.startApplyCopilotRun("job_ready");
    const record = (await repository.listApplicationRecords()).find(
      (entry) => entry.jobId === "job_ready",
    );
    if (!record) throw new Error("Expected an application record.");
    const priorEventIds = record.events.map((event) => event.id);

    await Promise.all([
      workspaceService.recordLiveAssistantApplicationAction({
        applicationRecordId: record.id,
        sessionId: "session_1",
        action: "mark_interviewed",
      }),
      workspaceService.mutateApplicationCrm({
        applicationRecordId: record.id,
        expectedRevision: 0,
        mutation: {
          type: "set_stage",
          stage: "recruiter_contact",
          customStageId: null,
          note: null,
        },
      }),
    ]);

    const merged = (await repository.listApplicationRecords()).find(
      (entry) => entry.id === record.id,
    );
    expect(merged?.status).toBe("interview");
    expect(merged?.crm).toMatchObject({
      revision: 1,
      stage: "recruiter_contact",
    });
    for (const priorEventId of priorEventIds) {
      expect(merged?.events.some((event) => event.id === priorEventId)).toBe(
        true,
      );
    }
  });

  test("every production apply invocation allows field saves and denies sending, including resumption", async () => {
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "/tmp/alex-vanguard.pdf";
    const sourceJob = seed.savedJobs.find((job) => job.id === "job_ready");
    if (!sourceJob) throw new Error("Expected the job_ready fixture.");
    const baseRuntime = createBrowserRuntime();
    const flowInputs: ExecuteApplicationFlowInput[] = [];
    let flowCallCount = 0;
    const executeApplicationFlow: ExecuteFlow = async (
      source,
      input,
      options,
    ) => {
      flowCallCount += 1;
      flowInputs.push(input);
      return baseRuntime.executeApplicationFlow(source, input, options);
    };
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const { workspaceService, repository } = harness;
    const job = (await repository.listSavedJobs()).find(
      (entry) => entry.id === "job_ready",
    );
    if (!job) throw new Error("Expected a saved job.");

    await workspaceService.approveApply("job_ready");
    await workspaceService.startApplyCopilotRun("job_ready");
    const staged = await workspaceService.startAutoApplyRun("job_ready");
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged run.");
    await workspaceService.approveApplyRun(runId);

    const lineageRunId = "apply_run_resumption_lineage";
    const lineageResultId = "apply_result_resumption_lineage";
    const checkpointId = "apply_checkpoint_resumption_lineage";
    const now = new Date().toISOString();
    await repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: lineageRunId,
        mode: "copilot",
        state: "paused_for_user_review",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        submitApprovalId: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        summary: "Lineage run.",
        detail: "Seeded resumption lineage.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    );
    await repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: lineageResultId,
        runId: lineageRunId,
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        state: "blocked",
        summary: "Sign-in blocked.",
        detail: "The site requires a browser-owned sign-in.",
        startedAt: now,
        updatedAt: now,
        blockerReason: "auth_required",
        latestCheckpointId: checkpointId,
      }),
    );
    await repository.upsertApplicationReplayCheckpoint(
      ApplicationReplayCheckpointSchema.parse({
        id: checkpointId,
        runId: lineageRunId,
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        resultId: lineageResultId,
        createdAt: now,
        label: "Sign-in checkpoint",
        detail: "Retained sign-in checkpoint.",
        url: job.applicationUrl ?? job.canonicalUrl,
        jobState: "filling",
        artifactRefIds: [],
      }),
    );

    const requestId = "ua_login_resumption_test";
    const requestBase = {
      id: requestId,
      dedupeKey: `application_login:${requestId}`,
      kind: "login",
      requirement: "required",
      scope: {
        type: "application",
        runId: lineageRunId,
        jobId: "job_ready",
        applicationRecordId: "application_job_ready",
        resultId: lineageResultId,
        replayCheckpointId: checkpointId,
        source: job.source,
      },
      verification: {
        type: "source_access",
        blockerFingerprint: "fingerprint_login",
        expectedOrigin: new URL(
          job.applicationUrl ?? job.canonicalUrl,
        ).origin.concat("/"),
      },
      title: "Sign in to continue",
      summary: "Complete sign-in in the Job Finder browser.",
      instructions: ["Complete sign-in in the Job Finder browser."],
      createdAt: now,
    } as const;
    await repository.createUserActionRequest(
      UserActionRequestSchema.parse({
        ...requestBase,
        revision: 1,
        state: "verifying",
        updatedAt: now,
      }),
    );
    const resolvedAt = new Date().toISOString();
    await repository.commitUserActionTransition({
      request: UserActionRequestSchema.parse({
        ...requestBase,
        revision: 2,
        state: "resolved",
        updatedAt: resolvedAt,
        resolvedAt,
      }),
      event: UserActionEventSchema.parse({
        id: `verification:${requestId}:r1`,
        requestId,
        operation: "verification_succeeded",
        previousRevision: 1,
        resultingRevision: 2,
        previousState: "verifying",
        resultingState: "resolved",
        occurredAt: resolvedAt,
      }),
    });
    const resolvedRequest = await repository.getUserActionRequest(requestId);
    if (!resolvedRequest) throw new Error("Expected the resolved request.");

    const callsBeforeResume = flowCallCount;
    // The application resumer is wired as internal context plumbing; tests
    // reach it through its exact method shape.
    const resumerHost = workspaceService as unknown as {
      resumeApplicationUserAction(
        request: typeof resolvedRequest,
      ): Promise<void>;
    };
    await resumerHost.resumeApplicationUserAction(resolvedRequest);
    expect(flowCallCount).toBeGreaterThan(callsBeforeResume);

    const authorizations = flowInputs.map((input) => ({
      intermediateMutationsAuthorized: input.intermediateMutationsAuthorized,
      submitAuthorized: input.submitAuthorized,
      accountCreationAuthorized: input.accountCreationAuthorized,
      mode: input.mode,
    }));
    expect(authorizations.length).toBeGreaterThanOrEqual(4);
    // Field saves are allowed by default (ADR 0024): a form that saves as
    // you type must carry on. Sending and account creation stay off.
    for (const authorization of authorizations) {
      expect(authorization).toEqual({
        intermediateMutationsAuthorized: true,
        submitAuthorized: false,
        accountCreationAuthorized: false,
        mode: "prepare_only",
      });
    }
  });

  test("a winning cancel blocks later consent resolution and relaunch", async () => {
    const { workspaceService, repository, flowedJobIds } =
      createConsentQueueHarness();
    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_consent_queue",
      "job_ready",
    ]);
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged queue run.");

    await workspaceService.approveApplyRun(runId);
    const consentRequest = (
      await repository.listApplicationConsentRequests({
        runId,
        jobId: "job_consent_queue",
      })
    )[0];
    if (!consentRequest) throw new Error("Expected a pending consent request.");
    expect(flowedJobIds).toHaveLength(2);

    await workspaceService.cancelApplyRun(runId);
    const cancelledRun = (await repository.listApplyRuns()).find(
      (run) => run.id === runId,
    );
    const cancelledAt = cancelledRun?.completedAt ?? null;

    await expect(
      workspaceService.resolveApplyConsentRequest(consentRequest.id, "approve"),
    ).rejects.toThrow(/cannot be resolved because run .* is cancelled/);

    const run = (await repository.listApplyRuns()).find(
      (entry) => entry.id === runId,
    );
    expect(run?.state).toBe("cancelled");
    expect(run?.completedAt).toBe(cancelledAt);
    expect(flowedJobIds).toHaveLength(2);
    expect(
      (await repository.listApplicationConsentRequests()).find(
        (entry) => entry.id === consentRequest.id,
      )?.status,
    ).toBe("pending");
  });

  test("a consent decision that wins keeps its writes and a later cancel stays terminal", async () => {
    const { workspaceService, repository } = createConsentQueueHarness();
    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_consent_queue",
      "job_ready",
    ]);
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged queue run.");

    await workspaceService.approveApplyRun(runId);
    const consentRequest = (
      await repository.listApplicationConsentRequests({
        runId,
        jobId: "job_consent_queue",
      })
    )[0];
    if (!consentRequest) throw new Error("Expected a pending consent request.");

    await workspaceService.resolveApplyConsentRequest(
      consentRequest.id,
      "approve",
    );
    const resolvedRun = (await repository.listApplyRuns()).find(
      (run) => run.id === runId,
    );
    expect(resolvedRun).toMatchObject({
      state: "paused_for_user_review",
      blockedJobs: 0,
      submittedJobs: 0,
    });
    expect(resolvedRun?.completedAt).toBeNull();

    await workspaceService.cancelApplyRun(runId);
    const run = (await repository.listApplyRuns()).find(
      (entry) => entry.id === runId,
    );
    expect(run).toMatchObject({
      state: "cancelled",
      blockedJobs: 0,
      submittedJobs: 0,
      // The ready form is retained; the cancelled missing-answer step is closed.
      pendingJobs: 1,
      failedJobs: 1,
    });
    expect(run?.completedAt).not.toBeNull();

    const record = (await repository.listApplicationRecords()).find(
      (entry) => entry.jobId === "job_consent_queue",
    );
    expect(
      record?.events.some((event) => event.title === "Consent approved"),
    ).toBe(true);
    expect(
      record?.events.some((event) =>
        event.title.includes("Automatic apply run cancelled"),
      ),
    ).toBe(true);
  });

  test("resume-use approval continues the exact blocked job instead of manufacturing review-ready state", async () => {
    const { workspaceService, repository, flowedJobIds } =
      createConsentQueueHarness({ resumeConsentOnApproval: true });
    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_consent_queue",
    ]);
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged queue run.");

    await workspaceService.approveApplyRun(runId);
    const consentRequest = (
      await repository.listApplicationConsentRequests({
        runId,
        jobId: "job_consent_queue",
      })
    )[0];
    if (!consentRequest) throw new Error("Expected a pending consent request.");
    await repository.upsertApplicationConsentRequest({
      ...consentRequest,
      kind: "resume_use",
      linkedConsentKind: "resume_use",
    });
    const callsBeforeApproval = flowedJobIds.filter(
      (jobId) => jobId === "job_consent_queue",
    ).length;

    const snapshot = await workspaceService.resolveApplyConsentRequest(
      consentRequest.id,
      "approve",
    );

    expect(
      flowedJobIds.filter((jobId) => jobId === "job_consent_queue"),
    ).toHaveLength(callsBeforeApproval + 1);
    expect(
      snapshot.applyJobResults.find(
        (result) =>
          result.applicationRecordId === "application_job_consent_queue",
      ),
    ).toMatchObject({
      state: "awaiting_review",
      blockerReason: null,
    });
    expect(
      snapshot.applyJobResults.some((result) =>
        result.summary.includes("stayed prepared for review"),
      ),
    ).toBe(false);
  });

  test("cancelling a partially finished run keeps finished labels and truthful counters", async () => {
    const seed = createSeed();
    stageReadyTailoredJob(seed, "job_ready", "linkedin_signal_ready", {
      filePath: "/tmp/job-ready-resume.pdf",
    });
    stageReadyTailoredJob(seed, "job_second", "linkedin_signal_second");
    const baseRuntime = createBrowserRuntime();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: baseRuntime,
    });

    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_second",
    ]);
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged queue run.");

    const cancelPromises: Promise<void>[] = [];
    let cancelTriggered = false;
    const originalUpsertAttempt =
      repository.upsertApplicationAttempt.bind(repository);
    repository.upsertApplicationAttempt = async (attempt) => {
      await originalUpsertAttempt(attempt);
      if (!cancelTriggered) {
        cancelTriggered = true;
        // Queued behind the held run transition; the cancel aborts the
        // worker before it can start the second queued job.
        cancelPromises.push(
          workspaceService.cancelApplyRun(runId).then(
            () => undefined,
            () => undefined,
          ),
        );
      }
    };

    await workspaceService.approveApplyRun(runId);
    if (cancelPromises.length === 0) {
      throw new Error("Expected the attempt upsert hook.");
    }
    await Promise.all(cancelPromises);

    const run = (await repository.listApplyRuns()).find(
      (entry) => entry.id === runId,
    );
    // Canonical recovery counters: the preserved awaiting_review checkpoint
    // stays the only outstanding user-owned work, while the abandoned queued
    // job stops counting as pending queue size forever.
    expect(run).toMatchObject({
      state: "cancelled",
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      pendingJobs: 1,
      failedJobs: 1,
    });
    expect(run?.completedAt).not.toBeNull();

    const results = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === runId,
    );
    expect(results.find((result) => result.jobId === "job_ready")?.state).toBe(
      "awaiting_review",
    );
    expect(results.find((result) => result.jobId === "job_second")?.state).toBe(
      "failed",
    );

    const finishedRecord = (await repository.listApplicationRecords()).find(
      (entry) => entry.jobId === "job_ready",
    );
    // The finished outcome keeps the labels its own outcome wrote; only the
    // audit event is appended.
    expect(finishedRecord?.nextActionLabel).not.toBe(
      "Restart the run if you want to continue later.",
    );
    expect(finishedRecord?.lastActionLabel).not.toBe(
      "Automatic apply run cancelled.",
    );
    expect(
      finishedRecord?.events.some((event) =>
        event.title.includes("Automatic apply run cancelled"),
      ),
    ).toBe(true);
    const queuedRecord = (await repository.listApplicationRecords()).find(
      (entry) => entry.jobId === "job_second",
    );
    // The outcome the run still owns receives truthful cancellation copy.
    expect(queuedRecord?.lastActionLabel).toBe(
      "Automatic apply run cancelled.",
    );
    expect(queuedRecord?.nextActionLabel).toBe(
      "Press Try again to pick this up later.",
    );
  });

  test("a failed consent relaunch parks the run instead of leaving it falsely running", async () => {
    // Keep the second job queued to exercise the relaunch failure itself.
    vi.stubEnv("NESTOR_APPLICATION_PREPARATION_CONCURRENCY", "1");
    const seed = createSeed();
    stageReadyTailoredJob(seed, "job_ready", "linkedin_signal_ready", {
      filePath: "/tmp/job-ready-resume.pdf",
    });
    stageReadyTailoredJob(seed, "job_consent_queue", "linkedin_consent_queue", {
      savedJob: {
        title: "Staff Product Designer",
        company: "Consent Labs",
        description:
          "Design the workflow system. This application asks whether you already have an account before continuing.",
      },
    });
    const baseRuntime = createBrowserRuntime();
    const workspaceServiceRef: {
      workspaceService: Harness["workspaceService"] | null;
    } = { workspaceService: null };
    const flowedJobIds: string[] = [];
    const executeApplicationFlow: ExecuteFlow = async (
      source,
      input,
      flowOptions,
    ) => {
      flowedJobIds.push(input.job.id);
      if (input.job.id === "job_consent_queue") {
        const hookedWorkspaceService = workspaceServiceRef.workspaceService;
        if (!hookedWorkspaceService) {
          throw new Error("Expected the workspace service.");
        }
        await hookedWorkspaceService.mutateSafeguards({
          type: "record_listing_signal",
          signalId: "signal_pause_job_ready",
          jobId: "job_ready",
          signal: "stale",
          detail: null,
          detectedAt: "2026-08-20T10:00:00.000Z",
          confidence: 0.9,
          provenance: "provider",
          explanation:
            "Provider reported that the listing needs re-verification.",
          recoveryGuidance: "Re-verify the listing before applying.",
        });
      }
      return baseRuntime.executeApplicationFlow(source, input, flowOptions);
    };
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const { workspaceService, repository } = harness;
    workspaceServiceRef.workspaceService = workspaceService;

    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_consent_queue",
      "job_ready",
    ]);
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged queue run.");
    await workspaceService.approveApplyRun(runId);
    expect(flowedJobIds).toEqual(["job_consent_queue"]);

    // The safeguard parks the run without making it look process-owned. Clear
    // that blocker, then break staged relaunch support so consent resolution
    // reaches the post-transition relaunch catch rather than pausing normally.
    await workspaceService.mutateSafeguards({
      type: "dismiss_safeguard_entry",
      kind: "listing_signal",
      referenceId: "signal_pause_job_ready",
      reason: "rechecked",
      note: "Re-verified the listing before consent resolution.",
    });
    delete (harness.browserRuntime as { executeApplicationFlow?: ExecuteFlow })
      .executeApplicationFlow;

    const consentRequest = (
      await repository.listApplicationConsentRequests({
        runId,
        jobId: "job_consent_queue",
      })
    ).find((entry) => entry.status === "pending");
    if (!consentRequest) throw new Error("Expected a pending consent request.");

    await expect(
      workspaceService.resolveApplyConsentRequest(consentRequest.id, "approve"),
    ).rejects.toThrow(/does not support staged apply execution/u);

    const run = (await repository.listApplyRuns()).find(
      (entry) => entry.id === runId,
    );
    // The unowned ghost running state is parked truthfully instead of being
    // misreported as an app-closed run by startup recovery.
    expect(run?.state).toBe("paused_for_user_review");
    expect(run?.completedAt).toBeNull();
    expect(run?.summary).toBe(
      "Consent resolved, but the queue paused before continuing.",
    );
    expect(run?.detail).toMatch(/does not support staged apply execution/u);
    expect(run?.summary).not.toBe(
      "Automatic apply stopped because the app closed.",
    );
  });

  test("a consent decision racing the active worker derives counters from committed run state", async () => {
    const { workspaceService, repository, flowedJobIds } =
      createConsentQueueHarness();
    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_consent_queue",
      "job_ready",
    ]);
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged queue run.");

    const resolutions: Promise<unknown>[] = [];
    let triggered = false;
    const originalUpsertResult =
      repository.upsertApplyJobResult.bind(repository);
    repository.upsertApplyJobResult = async (result) => {
      await originalUpsertResult(result);
      if (
        !triggered &&
        result.jobId === "job_ready" &&
        result.state === "awaiting_review"
      ) {
        triggered = true;
        const request = (
          await repository.listApplicationConsentRequests({
            runId,
            jobId: "job_consent_queue",
          })
        ).find((entry) => entry.status === "pending");
        if (!request) throw new Error("Expected a pending consent request.");
        // Queued while the worker still holds the run transition; the
        // resolution must re-read committed counters inside its own turn.
        resolutions.push(
          workspaceService.resolveApplyConsentRequest(request.id, "approve"),
        );
      }
    };

    await workspaceService.approveApplyRun(runId);
    expect(resolutions).toHaveLength(1);
    await Promise.all(resolutions);

    const run = (await repository.listApplyRuns()).find(
      (entry) => entry.id === runId,
    );
    expect(run).toMatchObject({
      state: "paused_for_user_review",
      blockedJobs: 0,
      submittedJobs: 0,
      skippedJobs: 0,
      pendingJobs: 2,
    });
    expect(
      (await repository.listApplicationConsentRequests()).find(
        (entry) => entry.runId === runId,
      )?.status,
    ).toBe("approved");
    const results = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === runId,
    );
    expect(results.every((result) => result.state === "awaiting_review")).toBe(
      true,
    );
    expect(flowedJobIds.sort()).toEqual(["job_consent_queue", "job_ready"]);
  });

  test("overlapping staged approvals launch exactly one runtime flow per shared job", async () => {
    const seed = createSeed();
    stageReadyTailoredJob(seed, "job_ready", "linkedin_signal_ready", {
      filePath: "/tmp/job-ready-resume.pdf",
    });
    stageReadyTailoredJob(seed, "job_second", "linkedin_signal_second");
    stageReadyTailoredJob(seed, "job_third", "linkedin_signal_third");
    const { runtime, flowedJobIds, releaseFlows } = (() => {
      const baseRuntime = createBrowserRuntime();
      const trackedJobIds: string[] = [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        runtime: {
          ...baseRuntime,
          executeApplicationFlow: async (
            source: Parameters<ExecuteFlow>[0],
            input: Parameters<ExecuteFlow>[1],
            options: Parameters<ExecuteFlow>[2],
          ) => {
            trackedJobIds.push(input.job.id);
            await gate;
            return baseRuntime.executeApplicationFlow(source, input, options);
          },
        } satisfies BrowserSessionRuntime,
        flowedJobIds: trackedJobIds,
        releaseFlows: () => {
          release();
        },
      };
    })();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: runtime,
    });

    const first = await workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_second",
    ]);
    const second = await workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_third",
    ]);
    const firstRunId = first.applyRuns[0]?.id;
    const secondRunId = second.applyRuns[0]?.id;
    if (!firstRunId || !secondRunId) {
      throw new Error("Expected two staged queue runs.");
    }

    const outcomes: string[] = [];
    const approvals = Promise.all([
      workspaceService.approveApplyRun(firstRunId).then(
        () => outcomes.push("fulfilled"),
        () => outcomes.push("rejected"),
      ),
      workspaceService.approveApplyRun(secondRunId).then(
        () => outcomes.push("fulfilled"),
        () => outcomes.push("rejected"),
      ),
    ]);

    await vi.waitFor(() => {
      expect(outcomes).toContain("rejected");
    });
    // The winner is parked inside its gated browser flow holding the job
    // claims, so exactly the conflicting approval can have rejected.
    expect(outcomes).toEqual(["rejected"]);
    expect(flowedJobIds).toContain("job_ready");

    releaseFlows();
    await approvals;

    expect(outcomes.sort()).toEqual(["fulfilled", "rejected"]);
    expect(flowedJobIds.filter((jobId) => jobId === "job_ready")).toHaveLength(
      1,
    );
    expect(flowedJobIds).toHaveLength(2);

    const loserRunId = outcomes[0] === "rejected" ? firstRunId : secondRunId;
    const loserResults = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === loserRunId,
    );
    expect(loserResults.every((result) => result.state === "planned")).toBe(
      true,
    );
  });

  test("disjoint staged approvals stay live concurrently without duplicate flows", async () => {
    const seed = createSeed();
    stageReadyTailoredJob(seed, "job_ready", "linkedin_signal_ready", {
      filePath: "/tmp/job-ready-resume.pdf",
    });
    stageReadyTailoredJob(seed, "job_second", "linkedin_signal_second");
    const baseRuntime = createBrowserRuntime();
    const flowedJobIds: string[] = [];
    const executeApplicationFlow: ExecuteFlow = async (
      source,
      input,
      flowOptions,
    ) => {
      flowedJobIds.push(input.job.id);
      return baseRuntime.executeApplicationFlow(source, input, flowOptions);
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const first = await workspaceService.startAutoApplyQueueRun(["job_ready"]);
    const second = await workspaceService.startAutoApplyQueueRun([
      "job_second",
    ]);
    const firstRunId = first.applyRuns[0]?.id;
    const secondRunId = second.applyRuns[0]?.id;
    if (!firstRunId || !secondRunId) {
      throw new Error("Expected two staged queue runs.");
    }

    const [firstOutcome, secondOutcome] = await Promise.all([
      workspaceService.approveApplyRun(firstRunId).then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      ),
      workspaceService.approveApplyRun(secondRunId).then(
        () => "fulfilled" as const,
        () => "rejected" as const,
      ),
    ]);

    expect(firstOutcome).toBe("fulfilled");
    expect(secondOutcome).toBe("fulfilled");
    expect(flowedJobIds.sort()).toEqual(["job_ready", "job_second"]);
  });

  test("queue staging reads shared prerequisites once regardless of batch size", async () => {
    const countSharedPrerequisiteReads = async (jobIds: string[]) => {
      const seed = createSeed();
      for (const jobId of jobIds) {
        stageReadyTailoredJob(seed, jobId, `linkedin_${jobId}`);
      }
      const { workspaceService, repository } = createWorkspaceServiceHarness({
        seed,
      });
      const counters = { assets: 0, profile: 0, settings: 0 };
      const originalListTailoredAssets =
        repository.listTailoredAssets.bind(repository);
      repository.listTailoredAssets = async () => {
        counters.assets += 1;
        return originalListTailoredAssets();
      };
      const originalGetProfile = repository.getProfile.bind(repository);
      repository.getProfile = async () => {
        counters.profile += 1;
        return originalGetProfile();
      };
      const originalGetSettings = repository.getSettings.bind(repository);
      repository.getSettings = async () => {
        counters.settings += 1;
        return originalGetSettings();
      };

      const staged = await workspaceService.startAutoApplyQueueRun(jobIds);
      expect(staged.applyJobResults).toHaveLength(jobIds.length);
      expect(
        staged.applyRuns.find((run) => run.state === "awaiting_submit_approval")
          ?.jobIds,
      ).toEqual(jobIds);
      return counters;
    };

    const single = await countSharedPrerequisiteReads(["job_batch_a"]);
    const batch = await countSharedPrerequisiteReads([
      "job_batch_a",
      "job_batch_b",
      "job_batch_c",
    ]);

    // Shared lookups are read once per staging call plus any fixed snapshot
    // projection reads — never once per queued job.
    expect(batch.assets).toBe(single.assets);
    expect(batch.profile).toBe(single.profile);
    expect(batch.settings).toBe(single.settings);
  });

  test("the running staged guard fires before the copilot missing-resume branch", async () => {
    const seed = createSeed();
    const now = new Date().toISOString();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
    });
    await repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: "apply_run_staged_active",
        mode: "single_job_auto",
        state: "running",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        submitApprovalId: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        summary: "Active staged run.",
        detail: "Seeded active staged run.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    );

    await expect(
      workspaceService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow(/already being prepared/i);

    expect(await repository.listApplyRuns()).toHaveLength(1);
    expect(await repository.listApplicationQuestionRecords({})).toHaveLength(0);
    expect(await repository.listApplicationArtifactRefs()).toHaveLength(0);
    expect(await repository.listApplicationReplayCheckpoints()).toHaveLength(0);
    expect(await repository.listApplicationConsentRequests()).toHaveLength(0);
    expect(await repository.listApplicationRecords()).toEqual([
      expect.objectContaining({
        id: "application_job_ready",
        jobId: "job_ready",
        lastActionLabel: "Application record created for safe preparation.",
      }),
    ]);
  });

  test("a copilot run left marked running is closed so Prepare works again", async () => {
    // What the person met live: the first attempt died without recording a
    // result, and every press after it was refused by a run nothing was
    // working on.
    const seed = createSeed();
    const now = new Date().toISOString();
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
    });
    await repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: "apply_run_orphaned_copilot",
        mode: "copilot",
        state: "running",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        submitApprovalId: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        summary: "Job Finder is preparing this application for you to review.",
        detail: "Seeded run nothing is working on.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    );

    await workspaceService.startApplyCopilotRun("job_ready");

    const runs = await repository.listApplyRuns();
    const orphan = runs.find((run) => run.id === "apply_run_orphaned_copilot");
    expect(orphan?.state).toBe("failed");
    expect(orphan?.detail).toContain("You can start this application again");
    // The new run actually started rather than being refused by the ghost.
    expect(runs.length).toBeGreaterThan(1);
  });

  test("a dismissal during the apply flow keeps ledger pairing and preserves discovery history", async () => {
    const sessionCheckedAt = "2026-03-20T10:04:00.000Z";
    const seed = createSeed();
    seed.settings.resumeApplicationMode = "original_resume";
    seed.profile.baseResume.storagePath = "/tmp/alex-vanguard.pdf";
    const pendingJob = createSavedJob({
      ...seed.savedJobs[0]!,
      id: "job_pending_hidden",
      sourceJobId: "linkedin_pending_hidden",
      canonicalUrl:
        "https://www.linkedin.com/jobs/view/linkedin_pending_hidden",
      applicationUrl:
        "https://www.linkedin.com/jobs/view/linkedin_pending_hidden/apply",
      status: "discovered",
      provenance: [
        createSavedJobDiscoveryProvenance({
          targetId: "target_linkedin_default",
          adapterKind: "auto",
          startingUrl: "https://www.linkedin.com/jobs/search/",
          discoveredAt: "2026-03-20T09:06:00.000Z",
        }),
      ],
    });
    const discoveryHistoryRun = DiscoveryRunRecordSchema.parse({
      id: "discovery_history_1",
      campaignId: null,
      state: "completed",
      startedAt: "2026-08-19T09:00:00.000Z",
      completedAt: "2026-08-19T09:02:00.000Z",
      targetIds: ["target_linkedin_default"],
    });
    const sourceDebugHistoryRun = SourceDebugRunRecordSchema.parse({
      id: "source_debug_history_1",
      targetId: "target_linkedin_default",
      state: "completed",
      startedAt: "2026-08-19T09:05:00.000Z",
      updatedAt: "2026-08-19T09:10:00.000Z",
      completedAt: "2026-08-19T09:10:00.000Z",
      targetLabel: "Primary target",
      targetUrl: "https://www.linkedin.com/jobs/search/",
      targetHostname: "www.linkedin.com",
      finalSummary: "The source was verified for the saved search.",
      phases: [],
      attemptIds: [],
      phaseSummaries: [],
      instructionArtifactId: null,
    });
    seed.discovery = JobFinderDiscoveryStateSchema.parse({
      ...seed.discovery,
      sessions: [
        {
          adapterKind: "target_site",
          status: "ready",
          driver: "catalog_seed",
          label: "Browser session ready",
          detail: "Validated recently.",
          lastCheckedAt: sessionCheckedAt,
        },
      ],
      recentRuns: [discoveryHistoryRun],
      recentSourceDebugRuns: [sourceDebugHistoryRun],
      pendingDiscoveryJobs: [pendingJob],
    });

    const midFlowRef: { dismiss: (() => Promise<void>) | null } = {
      dismiss: null,
    };
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow: ExecuteFlow = async (
      source,
      input,
      flowOptions,
    ) => {
      if (!midFlowRef.dismiss) {
        throw new Error("Expected the mid-flow dismissal hook.");
      }
      await midFlowRef.dismiss();
      return baseRuntime.executeApplicationFlow(source, input, flowOptions);
    };
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const { workspaceService, repository } = harness;
    midFlowRef.dismiss = () =>
      workspaceService
        .dismissDiscoveryJob({
          jobId: "job_pending_hidden",
          reasons: ["role"],
        })
        .then(() => undefined);

    const staged = await workspaceService.startAutoApplyRun("job_ready");
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged single-job auto run.");
    await workspaceService.approveApplyRun(runId);

    const state = await repository.getDiscoveryState();
    expect(state.pendingDiscoveryJobs.map((job) => job.id)).not.toContain(
      "job_pending_hidden",
    );
    const dismissedEntry = state.discoveryLedger.find(
      (entry) => entry.sourceJobId === "linkedin_pending_hidden",
    );
    expect(dismissedEntry?.latestStatus).toBe("skipped");
    expect(dismissedEntry?.skipReason).toMatch(/^Not interested:/);
    expect(state.sessions).toHaveLength(1);
    expect(state.recentRuns.map((run) => run.id)).toEqual([
      "discovery_history_1",
    ]);
    expect(state.recentSourceDebugRuns.map((run) => run.id)).toEqual([
      "source_debug_history_1",
    ]);
    const dismissedSavedJob = (await repository.listSavedJobs()).find(
      (job) => job.id === "job_pending_hidden",
    );
    expect(dismissedSavedJob).toMatchObject({
      status: "archived",
      discoveryFeedback: { reasons: ["role"] },
    });

    const results = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === runId,
    );
    expect(results.every((result) => result.state === "awaiting_review")).toBe(
      true,
    );
  });

  test("restoring a dismissed job preserves discovery history and flips the ledger back to seen", async () => {
    const seed = createSeed();
    const pendingJob = createSavedJob({
      ...seed.savedJobs[0]!,
      id: "job_pending_hidden",
      sourceJobId: "linkedin_pending_hidden",
      canonicalUrl:
        "https://www.linkedin.com/jobs/view/linkedin_pending_hidden",
      applicationUrl:
        "https://www.linkedin.com/jobs/view/linkedin_pending_hidden/apply",
      status: "discovered",
      provenance: [
        createSavedJobDiscoveryProvenance({
          targetId: "target_linkedin_default",
          adapterKind: "auto",
          startingUrl: "https://www.linkedin.com/jobs/search/",
          discoveredAt: "2026-03-20T09:06:00.000Z",
        }),
      ],
    });
    seed.discovery = JobFinderDiscoveryStateSchema.parse({
      ...seed.discovery,
      sessions: [
        {
          adapterKind: "target_site",
          status: "ready",
          driver: "catalog_seed",
          label: "Browser session ready",
          detail: "Validated recently.",
          lastCheckedAt: "2026-03-20T10:04:00.000Z",
        },
      ],
      recentRuns: [
        DiscoveryRunRecordSchema.parse({
          id: "discovery_history_1",
          campaignId: null,
          state: "completed",
          startedAt: "2026-08-19T09:00:00.000Z",
          completedAt: "2026-08-19T09:02:00.000Z",
          targetIds: ["target_linkedin_default"],
        }),
      ],
      pendingDiscoveryJobs: [pendingJob],
    });
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
    });

    await workspaceService.dismissDiscoveryJob({
      jobId: "job_pending_hidden",
      reasons: ["compensation"],
    });
    await workspaceService.restoreDismissedDiscoveryJob("job_pending_hidden");

    const state = await repository.getDiscoveryState();
    const restoredEntry = state.discoveryLedger.find(
      (entry) => entry.sourceJobId === "linkedin_pending_hidden",
    );
    expect(restoredEntry?.latestStatus).toBe("seen");
    expect(restoredEntry?.skipReason).toBeNull();
    expect(state.sessions).toHaveLength(1);
    expect(state.recentRuns.map((run) => run.id)).toEqual([
      "discovery_history_1",
    ]);
    const restoredJob = (await repository.listSavedJobs()).find(
      (job) => job.id === "job_pending_hidden",
    );
    expect(restoredJob).toMatchObject({
      status: "discovered",
      discoveryFeedback: null,
    });
  });

  test("application paired saved-job and ledger commits roll back together from transaction-current state", async () => {
    const seed = createSeed();
    const pendingJob = createSavedJob({
      ...seed.savedJobs[0]!,
      id: "job_pending_hidden",
      sourceJobId: "linkedin_pending_hidden",
      canonicalUrl:
        "https://www.linkedin.com/jobs/view/linkedin_pending_hidden",
      applicationUrl:
        "https://www.linkedin.com/jobs/view/linkedin_pending_hidden/apply",
      status: "discovered",
      provenance: [
        createSavedJobDiscoveryProvenance({
          targetId: "target_linkedin_default",
          adapterKind: "auto",
          startingUrl: "https://www.linkedin.com/jobs/search/",
          discoveredAt: "2026-03-20T09:06:00.000Z",
        }),
      ],
    });
    seed.discovery = JobFinderDiscoveryStateSchema.parse({
      ...seed.discovery,
      discoveryLedger: [
        DiscoveryLedgerEntrySchema.parse({
          id: "ledger_seed_entry",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_signal_ready",
          source: "target_site",
          sourceJobId: "linkedin_signal_ready",
          title: "Senior Product Designer",
          company: "Signal Systems",
          targetId: "target_linkedin_default",
          firstSeenAt: "2026-03-20T09:05:00.000Z",
          lastSeenAt: "2026-03-20T09:05:00.000Z",
        }),
      ],
      pendingDiscoveryJobs: [pendingJob],
    });
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
    });

    type FeedbackUpdate = Parameters<
      typeof repository.commitDiscoveryFeedbackUpdate
    >[1];
    const originalCommit =
      repository.commitDiscoveryFeedbackUpdate.bind(repository);
    let observedLedgerLengthBeforeTransform: number | null = null;
    repository.commitDiscoveryFeedbackUpdate = async <TResult>(
      jobId: string,
      update: FeedbackUpdate,
    ): Promise<TResult> => {
      const state = await repository.getDiscoveryState();
      await repository.replaceSavedJobsAndDiscoveryState({
        savedJobs: await repository.listSavedJobs(),
        discoveryState: {
          ...state,
          discoveryLedger: [
            ...state.discoveryLedger,
            DiscoveryLedgerEntrySchema.parse({
              id: "ledger_concurrent_writer",
              canonicalUrl:
                "https://www.linkedin.com/jobs/view/linkedin_concurrent_writer",
              source: "target_site",
              sourceJobId: "linkedin_concurrent_writer",
              title: "Concurrent Writer Role",
              company: null,
              targetId: "target_linkedin_default",
              firstSeenAt: "2026-03-20T09:07:00.000Z",
              lastSeenAt: "2026-03-20T09:07:00.000Z",
            }),
          ],
        },
      });
      return originalCommit(jobId, (current) => {
        observedLedgerLengthBeforeTransform =
          current.discoveryState.discoveryLedger.length;
        update(current);
        throw new Error("Simulated discovery ledger failure.");
      });
    };

    await expect(
      workspaceService.dismissDiscoveryJob({
        jobId: "job_pending_hidden",
        reasons: ["role"],
      }),
    ).rejects.toThrow("Simulated discovery ledger failure.");

    expect(observedLedgerLengthBeforeTransform).toBe(2);
    const stateAfter = await repository.getDiscoveryState();
    expect(stateAfter.pendingDiscoveryJobs.map((job) => job.id)).toContain(
      "job_pending_hidden",
    );
    expect(stateAfter.discoveryLedger.map((entry) => entry.id).sort()).toEqual([
      "ledger_concurrent_writer",
      "ledger_seed_entry",
    ]);
    expect(
      (await repository.listSavedJobs()).find(
        (job) => job.id === "job_pending_hidden",
      ),
    ).toBeUndefined();
  });
});

describe("one queued job's error does not end the batch", () => {
  function createThreeJobHarness(failure: Error) {
    const seed = createSeed();
    stageReadyTailoredJob(seed, "job_ready", "linkedin_signal_ready", {
      filePath: "/tmp/job-ready-resume.pdf",
    });
    stageReadyTailoredJob(seed, "job_second", "linkedin_signal_second");
    stageReadyTailoredJob(seed, "job_third", "linkedin_signal_third");
    const baseRuntime = createBrowserRuntime();
    const flowedJobIds: string[] = [];
    const executeApplicationFlow: ExecuteFlow = async (
      source,
      input,
      options,
    ) => {
      flowedJobIds.push(input.job.id);
      if (input.job.id === "job_second") throw failure;
      return baseRuntime.executeApplicationFlow(source, input, options);
    };
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    return { ...harness, flowedJobIds };
  }

  test("a failure on one job is written on that job and the next job still runs", async () => {
    const { workspaceService, repository, flowedJobIds } =
      createThreeJobHarness(new Error("The employer page did not load."));
    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_second",
      "job_third",
    ]);
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged queue run.");

    await workspaceService.approveApplyRun(runId);

    expect(flowedJobIds).toEqual(["job_ready", "job_second", "job_third"]);
    const results = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === runId,
    );
    const second = results.find((result) => result.jobId === "job_second");
    expect(second).toMatchObject({
      state: "failed",
      summary: "Could not apply.",
    });
    expect(second?.detail).toContain("The employer page did not load.");
    expect(results.find((result) => result.jobId === "job_third")?.state).toBe(
      "awaiting_review",
    );
    const run = (await repository.listApplyRuns()).find(
      (entry) => entry.id === runId,
    );
    expect(run?.state).not.toBe("failed");
    expect(run).toMatchObject({ pendingJobs: 0, failedJobs: 1 });
  });

  test("stepping into one job's tab stops only that job; the batch carries on", async () => {
    const { workspaceService, repository, flowedJobIds } =
      createThreeJobHarness(
        new DOMException(
          "Stopped because you stepped into the browser. Hand it back with Resume agent and Job Finder carries on, or press Try again.",
          "AbortError",
        ),
      );
    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_second",
      "job_third",
    ]);
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged queue run.");
    await workspaceService.approveApplyRun(runId);

    expect(flowedJobIds).toEqual(["job_ready", "job_second", "job_third"]);
    const second = (await repository.listApplyJobResults()).find(
      (result) => result.runId === runId && result.jobId === "job_second",
    );
    // Recorded as the person's takeover, which carries on at hand-back and
    // is not a failed attempt for the failure-rate safeguard.
    expect(second).toMatchObject({
      state: "failed",
      summary: "You took over this application.",
    });
    expect(
      (await repository.listApplyRuns()).find((entry) => entry.id === runId)
        ?.state,
    ).not.toBe("failed");
  });

  test("a browser the person took over stops the batch and leaves no job filling in", async () => {
    // Two preparations at once, so the third job is still waiting when the
    // takeover stops the batch (the rule holds at the wider default too).
    vi.stubEnv("NESTOR_APPLICATION_PREPARATION_CONCURRENCY", "2");
    const { workspaceService, repository, flowedJobIds } =
      createThreeJobHarness(
        new Error(
          "Browser activity is paused. Resume it from the browser toolbar.",
        ),
      );
    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_second",
      "job_third",
    ]);
    const runId = staged.applyRuns[0]?.id;
    if (!runId) throw new Error("Expected a staged queue run.");

    await expect(workspaceService.approveApplyRun(runId)).rejects.toThrow(
      /Browser activity is paused/,
    );

    expect(flowedJobIds).toEqual(["job_ready", "job_second"]);
    const results = (await repository.listApplyJobResults()).filter(
      (result) => result.runId === runId,
    );
    expect(
      results.filter((result) =>
        ["planned", "filling", "question_capture", "submitting"].includes(
          result.state,
        ),
      ),
    ).toEqual([]);
    expect(
      results.find((result) => result.jobId === "job_third"),
    ).toMatchObject({ state: "skipped", summary: "Not started." });
    expect(
      (await repository.listApplyRuns()).find((entry) => entry.id === runId),
    ).toMatchObject({
      state: "failed",
      summary: "Stopped because you took over the browser.",
    });
  });
});

describe("a new attempt for a job", () => {
  test("closes that job's older one-job run that was only waiting on the person", async () => {
    const seed = createSeed();
    stageReadyTailoredJob(seed, "job_ready", "linkedin_signal_ready", {
      filePath: "/tmp/job-ready-resume.pdf",
    });
    const pausedAt = "2026-09-23T22:42:31.000Z";
    seed.applyRuns = [
      ...(seed.applyRuns ?? []),
      ApplyRunSchema.parse({
        id: "run_waiting_on_sign_in",
        mode: "copilot",
        campaignId: null,
        state: "paused_for_user_review",
        jobIds: ["job_ready"],
        currentJobId: "job_ready",
        createdAt: pausedAt,
        updatedAt: pausedAt,
        completedAt: null,
        summary: "The site wants you signed in first.",
        detail: "The site wants you signed in first.",
        totalJobs: 1,
        pendingJobs: 1,
      }),
    ];
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: createBrowserRuntime(),
    });

    await workspaceService.startApplyCopilotRun("job_ready");

    const runs = await repository.listApplyRuns();
    expect(
      runs.find((run) => run.id === "run_waiting_on_sign_in"),
    ).toMatchObject({
      state: "cancelled",
      summary: "Replaced by a newer attempt for this job.",
    });
    expect(
      runs.filter(
        (run) =>
          run.id !== "run_waiting_on_sign_in" && run.jobIds[0] === "job_ready",
      ),
    ).toHaveLength(1);
  });
});

test.each([
  "failed",
  "cancelled",
  "submitted",
  "skipped",
  "blocked",
  "awaiting_review",
  "filling",
] as const)(
  "a running batch's %s result blocks retry only while active",
  async (state) => {
    const { workspaceService, repository } = createOriginalResumeHarness();
    const initial = await workspaceService.startAutoApplyRun("job_ready");
    const run = (await repository.listApplyRuns()).find(
      (entry) => entry.id === initial.selectedApplyRunId,
    )!;
    const result = (await repository.listApplyJobResults()).find(
      (entry) => entry.runId === run.id,
    )!;
    await repository.upsertApplyRun({
      ...run,
      mode: "queue_auto",
      state: "running",
      completedAt: null,
      jobIds: ["job_ready", "job_other"],
      totalJobs: 2,
      pendingJobs: 1,
    });
    await repository.upsertApplyJobResult({ ...result, state });
    await repository.upsertApplyJobResult({
      ...result,
      id: "result_other",
      jobId: "job_other",
      applicationRecordId: "application_other",
      state: "filling",
      completedAt: null,
    });
    if (state === "filling") {
      await expect(
        workspaceService.startApplyCopilotRun("job_ready"),
      ).rejects.toThrow("already being prepared");
    } else {
      await expect(
        workspaceService.startApplyCopilotRun("job_ready"),
      ).resolves.toBeDefined();
      expect(
        (await repository.listApplyJobResults()).some(
          (entry) => entry.jobId === "job_ready" && entry.runId !== run.id,
        ),
      ).toBe(true);
    }
    expect(
      (await repository.listApplyJobResults()).find(
        (entry) => entry.id === "result_other",
      )?.state,
    ).toBe("filling");
  },
);
