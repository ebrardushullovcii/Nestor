import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import {
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






