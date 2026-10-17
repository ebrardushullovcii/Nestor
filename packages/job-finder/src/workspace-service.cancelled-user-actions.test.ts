import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import { getApplicationCrmData } from "./internal/application-crm";
import {
  restoreWithdrawnApplicationPreparation,
  retireCancelledApplicationUserActions,
} from "./internal/workspace-application-user-action";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const now = "2026-08-23T10:00:00.000Z";
function harness(sameBatch = false) {
  const seed = createSeed();
  const job = seed.savedJobs.find((entry) => entry.id === "job_ready")!;
  seed.applicationRecords = ["a", "b"].map((id) =>
    ApplicationRecordSchema.parse({
      id: `application_${id}`,
      jobId: job.id,
      title: job.title,
      company: job.company,
      status: "ready_for_review",
      lastActionLabel: "Waiting for answers",
      nextActionLabel: "Answer the questions",
      lastUpdatedAt: now,
      lastAttemptState: "paused",
      questionSummary: {
        total: 1,
        required: 1,
        answered: 0,
        unansweredRequired: 1,
      },
    }),
  );
  seed.applicationAttempts = ["a", "b"].map((id) =>
    ApplicationAttemptSchema.parse({
      id: `attempt_${id}`,
      jobId: job.id,
      applicationRecordId: `application_${id}`,
      state: "paused",
      summary: "Prepared evidence",
      detail: "Prepared form waiting for one answer",
      outcome: null,
      nextActionLabel: null,
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      questions: [
        {
          id: `question_${id}`,
          prompt: "Will you require sponsorship?",
          kind: "visa_sponsorship",
          isRequired: true,
          detectedAt: now,
        },
      ],
    }),
  );
  seed.applyRuns = ["a", "b"].map((id) =>
    ApplyRunSchema.parse({
      id: `run_${id}`,
      mode: "copilot",
      state: "paused_for_user_review",
      jobIds: [job.id],
      currentJobId: job.id,
      createdAt: now,
      updatedAt: now,
      summary: "Waiting for answers",
      detail: "Waiting for the person to answer.",
      totalJobs: 1,
      pendingJobs: 1,
    }),
  );
  seed.applyJobResults = ["a", "b"].map((id) =>
    ApplyJobResultSchema.parse({
      id: `result_${id}`,
      runId: `run_${id}`,
      jobId: job.id,
      applicationRecordId: `application_${id}`,
      state: "awaiting_review",
      summary: "One question left",
      detail: "Waiting for the person to answer.",
      startedAt: now,
      updatedAt: now,
      latestCheckpointId: `checkpoint_${id}`,
      latestQuestionCount: 1,
      blockerReason: "required_human_input",
    }),
  );
  seed.userActionRequests = ["a", "b"].map((id) =>
    UserActionRequestSchema.parse({
      id: `request_${id}`,
      dedupeKey: `manual:${id}`,
      kind: "manual_answer",
      state: "pending",
      revision: 1,
      requirement: "required",
      scope: {
        type: "application",
        runId: `run_${id}`,
        jobId: job.id,
        applicationRecordId: `application_${id}`,
        resultId: `result_${id}`,
        replayCheckpointId: `checkpoint_${id}`,
        source: job.source,
      },
      verification: {
        type: "page_blocker_absent",
        blockerFingerprint: `missing:${id}`,
      },
      title: "Answer the question",
      summary: "One question left",
      instructions: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
  if (sameBatch) {
    const otherJobId = "job_other";
    seed.savedJobs.push({ ...job, id: otherJobId });
    seed.applicationRecords[1]!.jobId = otherJobId;
    seed.applicationAttempts[1]!.jobId = otherJobId;
    seed.applyRuns = [
      ApplyRunSchema.parse({
        ...seed.applyRuns[0],
        jobIds: [job.id, otherJobId],
        totalJobs: 2,
        pendingJobs: 2,
      }),
    ];
    seed.applyJobResults[1] = ApplyJobResultSchema.parse({
      ...seed.applyJobResults[1],
      runId: "run_a",
      jobId: otherJobId,
    });
    const request = seed.userActionRequests[1]!;
    seed.userActionRequests[1] = UserActionRequestSchema.parse({
      ...request,
      scope: { ...request.scope, runId: "run_a", jobId: otherJobId },
    });
  }
  return createWorkspaceServiceHarness({ seed });
}

describe("cancelled application hand-offs", () => {
  test("cancel closes only its exact step, keeps evidence, and leaves a fresh retry instead of a dead answer action", async () => {
    const { repository, workspaceService } = harness();
    const attempts = await repository.listApplicationAttempts();
    const sibling = (await repository.listApplicationRecords()).find(
      (r) => r.id === "application_b",
    );
    await workspaceService.cancelApplyRun("run_a");
    expect(await repository.getUserActionRequest("request_a")).toMatchObject({
      state: "cancelled",
    });
    expect(await repository.getUserActionRequest("request_b")).toMatchObject({
      state: "pending",
      revision: 1,
    });
    expect(
      (await repository.listApplicationRecords()).find(
        (r) => r.id === "application_a",
      ),
    ).toMatchObject({
      lastAttemptState: "failed",
      questionSummary: { unansweredRequired: 0 },
      nextActionLabel: "Try again, or finish it yourself on the job site.",
    });
    expect(
      (await repository.listApplicationRecords()).find(
        (r) => r.id === "application_b",
      ),
    ).toEqual(sibling);
    expect(await repository.listApplicationAttempts()).toEqual(attempts);
    const cancelled = (await repository.listApplyRuns()).find(
      (r) => r.id === "run_a",
    );
    expect(cancelled).toMatchObject({
      state: "cancelled",
      currentJobId: null,
      pendingJobs: 0,
      failedJobs: 1,
    });
    await expect(workspaceService.cancelApplyRun("run_a")).rejects.toThrow(
      "can no longer be cancelled",
    );
    await retireCancelledApplicationUserActions(repository);
    expect(
      (await repository.listApplyRuns()).find((r) => r.id === "run_a"),
    ).toEqual(cancelled);
  });

  test("legacy cleanup retires only proven cancelled lineage and never starts browser work", async () => {
    const { repository } = harness();
    const runs = await repository.listApplyRuns();
    await repository.upsertApplyRun({
      ...runs.find((r) => r.id === "run_a")!,
      state: "cancelled",
      completedAt: now,
    });
    await repository.upsertApplyRun({
      ...runs.find((r) => r.id === "run_b")!,
      state: "completed",
      completedAt: now,
    });
    const completed = (await repository.listApplyRuns()).find(
      (r) => r.id === "run_b",
    );
    await retireCancelledApplicationUserActions(repository);
    expect(await repository.getUserActionRequest("request_a")).toMatchObject({
      state: "cancelled",
    });
    expect(await repository.getUserActionRequest("request_b")).toMatchObject({
      state: "pending",
    });
    expect(
      (await repository.listApplyRuns()).find((r) => r.id === "run_b"),
    ).toEqual(completed);
    expect(await repository.listApplyRuns()).toHaveLength(2);
  });

  test("closing an old request does not change a newer attempt on the same record", async () => {
    const { repository } = harness();
    const run = (await repository.listApplyRuns()).find(
      (r) => r.id === "run_a",
    )!;
    await repository.upsertApplyRun({
      ...run,
      state: "cancelled",
      completedAt: now,
    });
    const result = (await repository.listApplyJobResults()).find(
      (r) => r.id === "result_a",
    )!;
    await repository.upsertApplyJobResult({
      ...result,
      id: "new_result",
      runId: "new_run",
      startedAt: "2026-08-24T10:00:00.000Z",
    });
    const record = (await repository.listApplicationRecords()).find(
      (r) => r.id === "application_a",
    );
    await retireCancelledApplicationUserActions(repository);
    expect(await repository.getUserActionRequest("request_a")).toMatchObject({
      state: "cancelled",
    });
    expect(
      (await repository.listApplicationRecords()).find(
        (r) => r.id === "application_a",
      ),
    ).toEqual(record);
  });
  test("legacy requests without exact result lineage are left alone", async () => {
    const { repository } = harness();
    const run = (await repository.listApplyRuns()).find(
      (r) => r.id === "run_a",
    )!;
    await repository.upsertApplyRun({
      ...run,
      state: "cancelled",
      completedAt: now,
    });
    const request = (await repository.getUserActionRequest("request_a"))!;
    // A mismatched result cannot prove this request belongs to the cancelled work.
    await repository.upsertApplyJobResult({
      ...(await repository.listApplyJobResults()).find(
        (r) => r.id === "result_a",
      )!,
      applicationRecordId: "application_b",
    });
    await retireCancelledApplicationUserActions(repository);
    expect(await repository.getUserActionRequest("request_a")).toEqual(request);
  });
});

test("cancelling one paused item records cancellation and leaves its batch sibling alone", async () => {
  const { repository, workspaceService } = harness(true);
  const sibling = (await repository.listApplyJobResults()).find(
    (result) => result.id === "result_b",
  );
  const siblingRecord = (await repository.listApplicationRecords()).find(
    (record) => record.id === "application_b",
  );
  const snapshot = await workspaceService.performUserAction({
    action: "cancel",
    requestId: "request_a",
    commandId: "cancel_item",
    expectedRevision: 1,
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
  });
  expect(
    snapshot.applyJobResults.find((result) => result.id === "result_a"),
  ).toMatchObject({
    state: "cancelled",
    summary: "Cancelled by you",
    blockerReason: null,
    blockerSummary: null,
  });
  expect(
    snapshot.applicationRecords.find((record) => record.id === "application_a"),
  ).toMatchObject({
    lastAttemptState: "cancelled",
    lastActionLabel: "Cancelled by you",
    latestBlocker: null,
  });
  expect(
    snapshot.applyJobResults.find((result) => result.id === "result_b"),
  ).toEqual(sibling);
  expect(
    snapshot.applicationRecords.find((record) => record.id === "application_b"),
  ).toEqual(siblingRecord);
  expect(await repository.getUserActionRequest("request_b")).toMatchObject({
    state: "pending",
    revision: 1,
  });
  expect(snapshot.applyRuns.find((run) => run.id === "run_a")).toMatchObject({
    state: "paused_for_user_review",
    pendingJobs: 1,
    failedJobs: 0,
    summary: "1 cancelled · 1 waiting on you",
  });
});

test("recording an application as sent in the tracker closes its open step and nothing else", async () => {
  const { repository, workspaceService } = harness();
  const siblingRecord = (await repository.listApplicationRecords()).find(
    (record) => record.id === "application_b",
  );
  const snapshot = await workspaceService.mutateApplicationCrm({
    applicationRecordId: "application_a",
    expectedRevision: 0,
    mutation: {
      type: "set_stage",
      stage: "interview",
      customStageId: null,
      note: null,
    },
    actor: "user",
  });
  expect(await repository.getUserActionRequest("request_a")).toMatchObject({
    state: "skipped",
  });
  expect(await repository.getUserActionRequest("request_b")).toMatchObject({
    state: "pending",
    revision: 1,
  });
  const result = snapshot.applyJobResults.find(
    (entry) => entry.id === "result_a",
  );
  // Their word, not a verified send: the result is closed, never "submitted".
  expect(result).toMatchObject({
    state: "skipped",
    summary: "You recorded this application as sent.",
  });
  expect(
    snapshot.applicationRecords.find((record) => record.id === "application_a"),
  ).toMatchObject({
    lastActionLabel: "You recorded this application as sent.",
    nextActionLabel: null,
    crm: { stage: "interview" },
  });
  expect(
    snapshot.applicationRecords.find((record) => record.id === "application_b"),
  ).toEqual(siblingRecord);
});

test("an earlier tracker stage leaves the open step alone", async () => {
  const { repository, workspaceService } = harness();
  await workspaceService.mutateApplicationCrm({
    applicationRecordId: "application_a",
    expectedRevision: 0,
    mutation: {
      type: "set_stage",
      stage: "preparing",
      customStageId: null,
      note: null,
    },
    actor: "user",
  });
  expect(await repository.getUserActionRequest("request_a")).toMatchObject({
    state: "pending",
  });
});

test("marking an application withdrawn closes its step without calling it sent", async () => {
  const { repository, workspaceService } = harness();
  const snapshot = await workspaceService.mutateApplicationCrm({
    applicationRecordId: "application_a",
    expectedRevision: 0,
    mutation: {
      type: "set_stage",
      stage: "withdrawn",
      customStageId: null,
      note: null,
    },
    actor: "user",
  });
  expect(await repository.getUserActionRequest("request_a")).toMatchObject({
    state: "skipped",
  });
  expect(
    snapshot.applyJobResults.find((entry) => entry.id === "result_a"),
  ).toMatchObject({
    state: "skipped",
    summary: "You marked this application withdrawn.",
  });
});

test("recording a send preserves a completed preparation run", async () => {
  const { repository, workspaceService } = harness();
  const original = (await repository.listApplyJobResults()).find(
    (result) => result.id === "result_a",
  )!;
  await repository.upsertApplyJobResult({
    ...original,
    completedAt: original.updatedAt,
  });
  await workspaceService.mutateApplicationCrm({
    applicationRecordId: "application_a",
    expectedRevision: 0,
    mutation: {
      type: "set_stage",
      stage: "applied",
      customStageId: null,
      note: null,
    },
  });
  const current = (await repository.listApplyJobResults()).find(
    (result) => result.id === "result_a",
  )!;
  expect(current.state).toBe("awaiting_review");
  expect(current.completedAt).toBe(original.updatedAt);
  expect(current.summary).toBe(original.summary);
  expect((await repository.getUserActionRequest("request_a"))?.state).toBe(
    "skipped",
  );
});

test("Undo of withdrawal replaces the preparation summary without reopening the closed step", async () => {
  const { repository, workspaceService } = harness();
  const before = getApplicationCrmData(
    (await workspaceService.getWorkspaceSnapshot()).applicationRecords.find(
      (record) => record.id === "application_a",
    )!,
  );
  const moved = await workspaceService.mutateApplicationCrmBulkStage({
    note: null,
    customStageId: null,
    stage: "withdrawn",
    items: [
      {
        applicationRecordId: "application_a",
        expectedRevision: before.revision,
      },
    ],
    actor: "user",
  });
  const record = moved.applicationRecords.find(
    (entry) => entry.id === "application_a",
  )!;
  const undone = await workspaceService.mutateApplicationCrmBulkStage({
    note: null,
    customStageId: null,
    action: "undo",
    stage: before.stage,
    items: [
      {
        applicationRecordId: record.id,
        expectedRevision: record.crm!.revision,
        previousStage: {
          stage: before.stage,
          customStageId: before.customStageId,
          stageChangedAt: before.stageChangedAt,
          appliedAt: before.appliedAt,
          lastEmployerActivityAt: before.lastEmployerActivityAt,
        },
      },
    ],
    actor: "user",
  });
  expect(
    undone.applyJobResults.find((entry) => entry.id === "result_a"),
  ).toMatchObject({ summary: "Withdrawal undone. Prepare again." });
  expect(
    undone.applicationRecords.find((entry) => entry.id === record.id)
      ?.nextActionLabel,
  ).toBe("Prepare again");
  expect(await repository.getUserActionRequest("request_a")).toMatchObject({
    state: "skipped",
  });
});

test("withdrawal recovery updates a sent tracker stage and preserves a later result", async () => {
  const { repository, workspaceService } = harness();
  await workspaceService.mutateApplicationCrm({
    applicationRecordId: "application_a",
    expectedRevision: 0,
    mutation: {
      type: "set_stage",
      stage: "withdrawn",
      customStageId: null,
      note: null,
    },
    actor: "user",
  });
  const record = (await repository.listApplicationRecords()).find(
    (entry) => entry.id === "application_a",
  )!;
  await repository.upsertApplicationRecord({
    ...record,
    crm: { ...record.crm!, stage: "applied" },
  });
  await restoreWithdrawnApplicationPreparation(repository, [record.id]);
  expect(
    (await repository.listApplyJobResults()).find(
      (entry) => entry.id === "result_a",
    )?.summary,
  ).toBe("Withdrawal undone. Tracked as sent.");
  expect(
    (await repository.listApplicationRecords()).find(
      (entry) => entry.id === record.id,
    )?.nextActionLabel,
  ).toBeNull();
  await repository.upsertApplicationRecord({
    ...record,
    crm: { ...record.crm!, stage: "reviewing" },
  });
  const old = (await repository.listApplyJobResults()).find(
    (entry) => entry.id === "result_a",
  )!;
  await repository.upsertApplyJobResult({
    ...old,
    id: "later_result",
    runId: "later_run",
    updatedAt: "2099-10-05T12:00:00Z",
    state: "awaiting_review",
    summary: "Prepared again",
  });
  await restoreWithdrawnApplicationPreparation(repository, [record.id]);
  expect(
    (await repository.listApplyJobResults()).find(
      (entry) => entry.id === "result_a",
    )?.summary,
  ).toBe("Withdrawal undone. Tracked as sent.");
  expect(
    (await repository.listApplyJobResults()).find(
      (entry) => entry.id === "later_result",
    )?.summary,
  ).toBe("Prepared again");
});
