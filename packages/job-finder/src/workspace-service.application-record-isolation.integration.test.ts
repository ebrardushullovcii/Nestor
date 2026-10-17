import {
  ApplicationAnswerRecordSchema,
  ApplicationAttemptSchema,
  ApplicationConsentRequestSchema,
  ApplicationQuestionRecordSchema,
  ApplicationRecordSchema,
  ApplicationReplayCheckpointSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const now = "2026-08-23T10:00:00.000Z";
const jobId = "job_ready";

function createSiblingSeed() {
  const seed = createSeed();
  const job = seed.savedJobs.find((entry) => entry.id === jobId)!;

  seed.applicationRecords = ["a", "b"].map((suffix) =>
    ApplicationRecordSchema.parse({
      id: `application_${suffix}`,
      jobId,
      title: job.title,
      company: job.company,
      status: "ready_for_review",
      lastActionLabel: `Prepared ${suffix.toUpperCase()}`,
      nextActionLabel: `Review ${suffix.toUpperCase()}`,
      lastUpdatedAt: now,
      lastAttemptId: `attempt_${suffix}`,
      lastAttemptState: "paused",
    }),
  );
  seed.applicationAttempts = ["a", "b"].map((suffix) =>
    ApplicationAttemptSchema.parse({
      id: `attempt_${suffix}`,
      jobId,
      applicationRecordId: `application_${suffix}`,
      runId: `run_${suffix}`,
      resultId: `result_${suffix}`,
      state: "paused",
      summary: `Attempt ${suffix.toUpperCase()}`,
      detail: `Exact attempt ${suffix.toUpperCase()}`,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      outcome: "ready_for_review",
      nextActionLabel: `Review ${suffix.toUpperCase()}`,
    }),
  );
  seed.applyRuns = ["a", "b"].map((suffix) =>
    ApplyRunSchema.parse({
      id: `run_${suffix}`,
      mode: "copilot",
      state: "paused_for_user_review",
      jobIds: [jobId],
      currentJobId: jobId,
      createdAt: now,
      updatedAt: now,
      summary: `Run ${suffix.toUpperCase()}`,
      detail: `Exact run ${suffix.toUpperCase()}`,
      totalJobs: 1,
      pendingJobs: 0,
    }),
  );
  seed.applyJobResults = ["a", "b"].map((suffix) =>
    ApplyJobResultSchema.parse({
      id: `result_${suffix}`,
      runId: `run_${suffix}`,
      jobId,
      applicationRecordId: `application_${suffix}`,
      state: "awaiting_review",
      summary: `Result ${suffix.toUpperCase()}`,
      detail: `Exact result ${suffix.toUpperCase()}`,
      startedAt: now,
      updatedAt: now,
      latestCheckpointId: `checkpoint_${suffix}`,
      pendingConsentRequestCount: 1,
    }),
  );
  seed.applicationQuestionRecords = ["a", "b"].map((suffix) =>
    ApplicationQuestionRecordSchema.parse({
      id: `question_${suffix}`,
      runId: `run_${suffix}`,
      jobId,
      applicationRecordId: `application_${suffix}`,
      resultId: `result_${suffix}`,
      prompt: `Evidence marker ${suffix.toUpperCase()}`,
      kind: "experience",
      answerControlType: "text",
      isRequired: true,
      detectedAt: now,
    }),
  );
  seed.applicationAnswerRecords = ["a", "b"].map((suffix) =>
    ApplicationAnswerRecordSchema.parse({
      id: `answer_${suffix}`,
      runId: `run_${suffix}`,
      jobId,
      applicationRecordId: `application_${suffix}`,
      resultId: `result_${suffix}`,
      questionId: `question_${suffix}`,
      status: "suggested",
      text: `Answer marker ${suffix.toUpperCase()}`,
      value: { type: "text", value: `Answer marker ${suffix.toUpperCase()}` },
      revision: 1,
      sourceKind: "user",
      createdAt: now,
    }),
  );
  seed.applicationReplayCheckpoints = ["a", "b"].map((suffix) =>
    ApplicationReplayCheckpointSchema.parse({
      id: `checkpoint_${suffix}`,
      runId: `run_${suffix}`,
      jobId,
      applicationRecordId: `application_${suffix}`,
      resultId: `result_${suffix}`,
      createdAt: now,
      label: `Checkpoint ${suffix.toUpperCase()}`,
      detail: `Exact checkpoint ${suffix.toUpperCase()}`,
      url: job.applicationUrl ?? job.canonicalUrl,
      jobState: "awaiting_review",
    }),
  );
  seed.applicationConsentRequests = ["a", "b"].map((suffix) =>
    ApplicationConsentRequestSchema.parse({
      id: `consent_${suffix}`,
      runId: `run_${suffix}`,
      jobId,
      applicationRecordId: `application_${suffix}`,
      resultId: `result_${suffix}`,
      kind: "manual_verification",
      label: `Consent ${suffix.toUpperCase()}`,
      detail: `Exact consent ${suffix.toUpperCase()}`,
      status: "pending",
      requestedAt: now,
    }),
  );
  return seed;
}

describe("workspace service exact sibling application-record isolation", () => {
  test("keeps details, answer retry, packet evidence, attempts, and cancellation on exact A/B lineages", async () => {
    const harness = createWorkspaceServiceHarness({
      seed: createSiblingSeed(),
    });
    const { repository, workspaceService } = harness;

    const detailsA = await workspaceService.getApplyRunDetails(
      "run_a",
      jobId,
      "application_a",
    );
    const detailsB = await workspaceService.getApplyRunDetails(
      "run_b",
      jobId,
      "application_b",
    );
    expect(detailsA.result?.id).toBe("result_a");
    expect(detailsA.questionRecords.map((entry) => entry.id)).toEqual([
      "question_a",
    ]);
    expect(detailsA.consentRequests.map((entry) => entry.id)).toEqual([
      "consent_a",
    ]);
    expect(detailsB.result?.id).toBe("result_b");
    expect(JSON.stringify(detailsA)).not.toContain("marker B");
    expect(JSON.stringify(detailsB)).not.toContain("marker A");
    await expect(
      workspaceService.getApplyRunDetails("run_a", jobId, "application_b"),
    ).rejects.toThrow(/mismatched application record lineage/i);

    const command = {
      commandId: "save_a_revision_2",
      runId: "run_a",
      jobId,
      resultId: "result_a",
      questionId: "question_a",
      expectedAnswerRevision: 1,
      value: { type: "text" as const, value: "Replacement marker A" },
      saveScope: "application_once" as const,
      submitAuthorized: false as const,
      accountCreationAuthorized: false as const,
    };
    const savedA = await workspaceService.saveApplicationAnswer(command);
    const retriedA = await workspaceService.saveApplicationAnswer(command);
    expect(savedA.answerRecords.at(-1)).toMatchObject({
      id: "application_answer_save_a_revision_2",
      applicationRecordId: "application_a",
      revision: 2,
      supersedesAnswerId: "answer_a",
    });
    expect(retriedA.answerRecords).toEqual(savedA.answerRecords);

    const siblingAnswers = await repository.listApplicationAnswerRecords({
      runId: "run_b",
      jobId,
    });
    expect(siblingAnswers).toHaveLength(1);
    expect(siblingAnswers[0]).toMatchObject({
      id: "answer_b",
      applicationRecordId: "application_b",
      revision: 1,
      text: "Answer marker B",
    });

    const packetA = await workspaceService.buildApplicationPacket(
      "run_a",
      jobId,
      "application_a",
    );
    const packetB = await workspaceService.buildApplicationPacket(
      "run_b",
      jobId,
      "application_b",
    );
    expect(packetA.result.applicationRecordId).toBe("application_a");
    expect(packetB.result.applicationRecordId).toBe("application_b");
    expect(JSON.stringify(packetA)).not.toContain("marker B");
    expect(JSON.stringify(packetB)).not.toContain("marker A");
    expect(packetA.submissionOccurred).toBe(false);
    expect(packetB.submissionOccurred).toBe(false);

    const siblingBeforeCancel = {
      run: (await repository.listApplyRuns({ id: "run_b" }))[0],
      result: (
        await repository.listApplyJobResults({ runId: "run_b", jobId })
      )[0],
      attempt: (await repository.listApplicationAttempts()).find(
        (entry) => entry.id === "attempt_b",
      ),
      record: (await repository.listApplicationRecords()).find(
        (entry) => entry.id === "application_b",
      ),
    };
    await workspaceService.cancelApplyRun("run_a");
    expect((await repository.listApplyRuns({ id: "run_a" }))[0]?.state).toBe(
      "cancelled",
    );
    expect({
      run: (await repository.listApplyRuns({ id: "run_b" }))[0],
      result: (
        await repository.listApplyJobResults({ runId: "run_b", jobId })
      )[0],
      attempt: (await repository.listApplicationAttempts()).find(
        (entry) => entry.id === "attempt_b",
      ),
      record: (await repository.listApplicationRecords()).find(
        (entry) => entry.id === "application_b",
      ),
    }).toEqual(siblingBeforeCancel);
  });

  test("fails closed for legacy null lineage instead of selecting a sibling record", async () => {
    const seed = createSiblingSeed();
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        ...seed.applyJobResults[0],
        applicationRecordId: null,
      }),
    ];
    seed.applicationQuestionRecords = [];
    seed.applicationAnswerRecords = [];
    seed.applicationReplayCheckpoints = [];
    seed.applicationConsentRequests = [];
    const { workspaceService } = createWorkspaceServiceHarness({ seed });

    await expect(
      workspaceService.getApplyRunDetails("run_a", jobId),
    ).rejects.toThrow(/legacy application lineage.*non-actionable/iu);
    await expect(
      workspaceService.buildApplicationPacket("run_a", jobId),
    ).rejects.toThrow(/legacy application lineage.*non-actionable/iu);
  });
});
