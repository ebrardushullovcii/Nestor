import { afterEach, describe, expect, test } from "vitest";

import {
  ApplicationAnswerRecordSchema,
  ApplicationQuestionRecordSchema,
  GroupedDecisionJobLineageSchema,
  GroupedManualAnswerDecisionSchema,
  UserActionEventSchema,
  UserActionRequestSchema,
  type ApplicationAnswerRecord,
  type ApplicationQuestionRecord,
  type GroupedDecisionJobLineage,
  type GroupedManualAnswerDecision,
  type UserActionEvent,
  type UserActionRequest,
} from "@nestor/contracts";

import {
  createInMemoryJobFinderRepository,
  type CommitGroupedManualAnswerInput,
  type CommitGroupedManualAnswerResult,
  type GroupedManualAnswerCommitFailure,
  type JobFinderRepository,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

const now = "2026-08-15T10:00:00.000Z";
const appliedAt = "2026-08-15T11:00:00.000Z";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(cleanupTempDirectoryWithRetry),
  );
});

function createApplicationScope(input: {
  runId: string;
  jobId: string;
  resultId: string | null;
}): UserActionRequest["scope"] {
  return {
    type: "application",
    runId: input.runId,
    jobId: input.jobId,
    applicationRecordId: null,
    resultId: input.resultId,
    replayCheckpointId: null,
    source: "target_site",
  };
}

function createManualAnswerRequest(input: {
  id: string;
  runId: string;
  jobId: string;
  resultId: string | null;
}): UserActionRequest {
  return UserActionRequestSchema.parse({
    id: input.id,
    dedupeKey: `dedupe_${input.id}`,
    revision: 1,
    kind: "manual_answer",
    state: "pending",
    requirement: "required",
    scope: createApplicationScope(input),
    verification: {
      type: "page_blocker_absent",
      blockerFingerprint: `blocker_${input.id}`,
      expectedPageFingerprint: null,
    },
    title: "Answer the required question",
    summary: "A safe manual answer is required.",
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

function createUnrelatedLoginRequest(): UserActionRequest {
  return UserActionRequestSchema.parse({
    id: "action-login-unrelated",
    dedupeKey: "source-login:target-1",
    revision: 1,
    kind: "login",
    state: "awaiting_user",
    requirement: "required",
    scope: {
      type: "discovery_source",
      targetId: "target-1",
      source: "target_site",
      sourceDebugRunId: null,
      sourceDebugAttemptId: null,
    },
    verification: {
      type: "source_access",
      targetId: "target-1",
      blockerFingerprint: "login-form-v1",
      expectedOrigin: null,
    },
    title: "Sign in to continue",
    summary: "Complete sign-in in the browser.",
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

function createVerifyingRequest(
  request: UserActionRequest,
  occurredAt: string,
): UserActionRequest {
  return UserActionRequestSchema.parse({
    ...request,
    revision: request.revision + 1,
    state: "verifying",
    updatedAt: occurredAt,
  });
}

function createQuestionRecord(input: {
  id: string;
  runId: string;
  jobId: string;
  resultId: string | null;
  overrides?: Partial<ApplicationQuestionRecord>;
}): ApplicationQuestionRecord {
  return ApplicationQuestionRecordSchema.parse({
    id: input.id,
    runId: input.runId,
    jobId: input.jobId,
    resultId: input.resultId,
    prompt: "Years of experience",
    kind: "experience",
    answerControlType: "text",
    isRequired: true,
    detectedAt: now,
    answerOptions: [],
    suggestedAnswers: [],
    selectedAnswerId: null,
    submittedAnswer: null,
    status: "detected",
    pageUrl: null,
    visualContext: null,
    ...input.overrides,
  });
}

function createAnswerRecord(input: {
  id: string;
  runId: string;
  jobId: string;
  resultId: string | null;
  questionId: string;
  revision: number;
  supersedesAnswerId?: string | null;
  overrides?: Partial<ApplicationAnswerRecord>;
}): ApplicationAnswerRecord {
  return ApplicationAnswerRecordSchema.parse({
    id: input.id,
    runId: input.runId,
    jobId: input.jobId,
    resultId: input.resultId,
    questionId: input.questionId,
    status: "suggested",
    text: "5 years",
    value: { type: "text", value: "5 years" },
    revision: input.revision,
    saveScope: "reusable_profile",
    supersedesAnswerId: input.supersedesAnswerId ?? null,
    sourceKind: "user",
    sourceId: null,
    confidenceLabel: null,
    provenance: [],
    createdAt: now,
    submittedAt: null,
    ...input.overrides,
  });
}

function createLineageEntry(input: {
  requestId: string;
  jobId: string;
  questionId: string;
  resultId: string | null;
  applicationRecordId: string;
  expectedAnswerRevision?: number;
  appliedAt?: string | null;
}): GroupedDecisionJobLineage {
  return GroupedDecisionJobLineageSchema.parse({
    requestId: input.requestId,
    jobId: input.jobId,
    applicationRecordId: input.applicationRecordId,
    resultId: input.resultId,
    questionId: input.questionId,
    answerRecordId: null,
    expectedRequestRevision: 1,
    expectedQuestionRevision: 1,
    expectedAnswerRevision: input.expectedAnswerRevision ?? 0,
    appliedAt: input.appliedAt ?? null,
  });
}

function createPendingDecision(input: {
  id: string;
  lineage: readonly GroupedDecisionJobLineage[];
  requestId: string;
  jobId: string;
  questionId: string;
}): GroupedManualAnswerDecision {
  return GroupedManualAnswerDecisionSchema.parse({
    id: input.id,
    groupKey: "group_1",
    requestId: input.requestId,
    applicationRecordId: input.lineage[0]!.applicationRecordId,
    jobId: input.jobId,
    resultId: input.lineage[0]!.resultId,
    questionId: input.questionId,
    expectedRevision: 1,
    expectedQuestionRevision: input.lineage[0]!.expectedQuestionRevision,
    expectedAnswerRevision: input.lineage[0]!.expectedAnswerRevision,
    fingerprints: {
      questionMeaning: "a".repeat(64),
      answerPolicy: "b".repeat(64),
    },
    answer: { type: "text", value: "5 years" },
    createdAt: now,
    updatedAt: now,
    lineage: input.lineage,
  });
}

function createApprovedDecision(
  pending: GroupedManualAnswerDecision,
  occurredAt: string,
): GroupedManualAnswerDecision {
  return GroupedManualAnswerDecisionSchema.parse({
    ...pending,
    approval: "approved",
    approvedAt: occurredAt,
    expectedRevision: pending.expectedRevision + 1,
    updatedAt: occurredAt,
    lineage: pending.lineage.map((entry) => ({
      ...entry,
      appliedAt: occurredAt,
    })),
  });
}

interface GroupedCommitFixture {
  pending: GroupedManualAnswerDecision;
  decision: GroupedManualAnswerDecision;
  persistedRequests: UserActionRequest[];
  questions: ApplicationQuestionRecord[];
  expectedAnswers: ApplicationAnswerRecord[];
  input: CommitGroupedManualAnswerInput;
}

function buildGroupedCommit(
  input: {
    id?: string;
    memberBHasAnswer?: boolean;
  } = {},
): GroupedCommitFixture {
  const runId = "run_1";
  const members = [
    {
      requestId: "request_a",
      jobId: "job_a",
      resultId: "result_a",
      questionId: "question_a",
      applicationRecordId: "application_a",
      expectedAnswerRevision: 0,
    },
    {
      requestId: "request_b",
      jobId: "job_b",
      resultId: "result_b",
      questionId: "question_b",
      applicationRecordId: "application_b",
      expectedAnswerRevision: input.memberBHasAnswer ? 1 : 0,
    },
  ] as const;

  const persistedRequests = members.map((member) =>
    createManualAnswerRequest({
      id: member.requestId,
      runId,
      jobId: member.jobId,
      resultId: member.resultId,
    }),
  );
  const questions = members.map((member) =>
    createQuestionRecord({
      id: member.questionId,
      runId,
      jobId: member.jobId,
      resultId: member.resultId,
    }),
  );
  const expectedAnswers = members
    .filter((member) => member.expectedAnswerRevision > 0)
    .map((member) =>
      createAnswerRecord({
        id: `answer_${member.questionId}_v1`,
        runId,
        jobId: member.jobId,
        resultId: member.resultId,
        questionId: member.questionId,
        revision: 1,
      }),
    );
  const answers = members.map((member) =>
    member.expectedAnswerRevision > 0
      ? createAnswerRecord({
          id: `answer_${member.questionId}_v2`,
          runId,
          jobId: member.jobId,
          resultId: member.resultId,
          questionId: member.questionId,
          revision: 2,
          supersedesAnswerId: `answer_${member.questionId}_v1`,
        })
      : // Critical architecture decision: revision-0 members get their first
        // revision-1 suggested answer inside the same atomic commit.
        createAnswerRecord({
          id: `answer_${member.questionId}_v1`,
          runId,
          jobId: member.jobId,
          resultId: member.resultId,
          questionId: member.questionId,
          revision: 1,
          supersedesAnswerId: null,
        }),
  );

  const lineage = members.map((member) =>
    createLineageEntry({
      requestId: member.requestId,
      jobId: member.jobId,
      questionId: member.questionId,
      resultId: member.resultId,
      applicationRecordId: member.applicationRecordId,
      expectedAnswerRevision: member.expectedAnswerRevision,
    }),
  );
  const pending = createPendingDecision({
    id: input.id ?? "decision_1",
    lineage,
    requestId: members[0].requestId,
    jobId: members[0].jobId,
    questionId: members[0].questionId,
  });
  const decision = createApprovedDecision(pending, appliedAt);
  const requests = persistedRequests.map((request) =>
    createVerifyingRequest(request, appliedAt),
  );
  const nextQuestions = questions.map((question, index) =>
    createQuestionRecord({
      id: question.id,
      runId: question.runId,
      jobId: question.jobId,
      resultId: question.resultId,
      overrides: {
        answerOptions: index === 0 ? ["Option A", "Option B"] : [],
        selectedAnswerId: answers[index]!.id,
        submittedAnswer: answers[index]!.text,
        status: "answered",
      },
    }),
  );

  return {
    pending,
    decision,
    persistedRequests,
    questions,
    expectedAnswers,
    input: {
      expectedDecision: pending,
      decision,
      lineage: decision.lineage,
      requests,
      expectedQuestions: questions,
      questions: nextQuestions,
      expectedAnswers,
      answers,
    },
  };
}

async function seedRepository(
  repository: JobFinderRepository,
  fixture: GroupedCommitFixture,
): Promise<void> {
  for (const request of fixture.persistedRequests) {
    await repository.createUserActionRequest(request);
  }
  await repository.createUserActionRequest(createUnrelatedLoginRequest());
  for (const question of fixture.questions) {
    await repository.upsertApplicationQuestionRecord(question);
  }
  await repository.upsertApplicationQuestionRecord(
    createQuestionRecord({
      id: "question_unrelated",
      runId: "run_1",
      jobId: "job_c",
      resultId: "result_c",
    }),
  );
  for (const answer of fixture.expectedAnswers) {
    await repository.upsertApplicationAnswerRecord(answer);
  }
  await repository.upsertApplicationAnswerRecord(
    createAnswerRecord({
      id: "answer_unrelated",
      runId: "run_1",
      jobId: "job_c",
      resultId: "result_c",
      questionId: "question_unrelated",
      revision: 1,
    }),
  );

  const intelligence = await repository.getIntelligenceState();
  await repository.saveIntelligenceState({
    ...intelligence,
    groupedDecisions: [fixture.pending],
    updatedAt: null,
  });
}

async function snapshotRepository(repository: JobFinderRepository): Promise<{
  requests: readonly UserActionRequest[];
  events: readonly UserActionEvent[];
  answers: readonly ApplicationAnswerRecord[];
  questions: readonly ApplicationQuestionRecord[];
  intelligence: unknown;
}> {
  return {
    requests: await repository.listUserActionRequests(),
    events: await repository.listUserActionEvents(),
    answers: await repository.listApplicationAnswerRecords(),
    questions: await repository.listApplicationQuestionRecords(),
    intelligence: await repository.getIntelligenceState(),
  };
}

async function runOnBoth(
  run: (repository: JobFinderRepository) => Promise<void>,
): Promise<void> {
  const inMemory = createInMemoryJobFinderRepository(createSeed());
  await run(inMemory);
  await inMemory.close();

  const fixture = await createTempRepository("nestor-grouped-manual-answer-");
  temporaryDirectories.push(fixture.tempDirectory);
  const fileRepository = await fixture.createRepository();
  await run(fileRepository);
  await fileRepository.close();
}

function expectStaleResult(
  result: CommitGroupedManualAnswerResult,
  code: GroupedManualAnswerCommitFailure["code"],
): void {
  expect(result.status).toBe("stale");
  if (result.status !== "stale") return;
  expect(result.failure.code).toBe(code);
}

describe("commitGroupedManualAnswer", () => {
  test("atomically commits one approved group across two jobs and preserves unrelated stores", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit({ memberBHasAnswer: true });
      await seedRepository(repository, fixture);

      const result = await repository.commitGroupedManualAnswer(fixture.input);
      expect(result.status).toBe("applied");
      if (result.status !== "applied") return;

      expect(result.decision).toEqual(fixture.decision);
      expect(result.lineage).toEqual(fixture.decision.lineage);
      expect(result.requests.map((request) => request.id)).toEqual([
        "request_a",
        "request_b",
      ]);

      const requests = await repository.listUserActionRequests();
      const byId = new Map(requests.map((request) => [request.id, request]));
      expect(byId.get("request_a")).toEqual(
        expect.objectContaining({
          revision: 2,
          state: "verifying",
          updatedAt: appliedAt,
          resolvedAt: null,
        }),
      );
      expect(byId.get("request_b")).toEqual(
        expect.objectContaining({
          revision: 2,
          state: "verifying",
          updatedAt: appliedAt,
        }),
      );

      const events = await repository.listUserActionEvents();
      const groupedEvents = events.filter(
        (event) => event.operation === "submit_manual_answer",
      );
      expect(groupedEvents).toHaveLength(2);
      for (const event of groupedEvents) {
        expect(event).toEqual(
          expect.objectContaining({
            operation: "submit_manual_answer",
            previousRevision: 1,
            resultingRevision: 2,
            resultingState: "verifying",
            occurredAt: appliedAt,
          }),
        );
      }

      const answers = await repository.listApplicationAnswerRecords();
      const answerById = new Map(answers.map((answer) => [answer.id, answer]));
      expect(answerById.get("answer_question_b_v2")).toEqual(
        expect.objectContaining({
          questionId: "question_b",
          revision: 2,
          supersedesAnswerId: "answer_question_b_v1",
          status: "suggested",
          submittedAt: null,
        }),
      );
      expect(answerById.get("answer_question_b_v1")).toEqual(
        expect.objectContaining({ questionId: "question_b", revision: 1 }),
      );
      // The revision-0 member received its first suggested answer inside the
      // same atomic commit, never deferred until resumption.
      expect(answerById.get("answer_question_a_v1")).toEqual(
        expect.objectContaining({
          questionId: "question_a",
          revision: 1,
          supersedesAnswerId: null,
          status: "suggested",
          submittedAt: null,
        }),
      );

      const questions = await repository.listApplicationQuestionRecords();
      const questionById = new Map(
        questions.map((question) => [question.id, question]),
      );
      expect(questionById.get("question_a")).toEqual(
        expect.objectContaining({
          answerOptions: ["Option A", "Option B"],
          status: "answered",
          selectedAnswerId: "answer_question_a_v1",
          submittedAnswer: "5 years",
        }),
      );

      const intelligence = await repository.getIntelligenceState();
      expect(intelligence.groupedDecisions).toHaveLength(1);
      expect(intelligence.groupedDecisions[0]).toEqual(fixture.decision);
      expect(intelligence.updatedAt).toBe(appliedAt);

      expect(byId.get("action-login-unrelated")).toEqual(
        expect.objectContaining({ kind: "login", revision: 1 }),
      );
      expect(questionById.get("question_unrelated")).toEqual(
        expect.objectContaining({ prompt: "Years of experience" }),
      );
      expect(answerById.get("answer_unrelated")).toEqual(
        expect.objectContaining({ revision: 1 }),
      );
    });
  });

  test("creates a revision-1 suggested answer for every revision-0 member atomically", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);

      const result = await repository.commitGroupedManualAnswer(fixture.input);
      expect(result.status).toBe("applied");

      const answers = await repository.listApplicationAnswerRecords();
      const answerById = new Map(answers.map((answer) => [answer.id, answer]));
      expect(answerById.get("answer_question_a_v1")).toEqual(
        expect.objectContaining({
          questionId: "question_a",
          revision: 1,
          supersedesAnswerId: null,
          status: "suggested",
          submittedAt: null,
        }),
      );
      expect(answerById.get("answer_question_b_v1")).toEqual(
        expect.objectContaining({
          questionId: "question_b",
          revision: 1,
          supersedesAnswerId: null,
          status: "suggested",
          submittedAt: null,
        }),
      );
      expect(answerById.get("answer_unrelated")).toEqual(
        expect.objectContaining({ revision: 1 }),
      );
    });
  });

  test("mixes revision-0 creation and exact-CAS revision advances in one commit", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit({ memberBHasAnswer: true });
      await seedRepository(repository, fixture);

      const result = await repository.commitGroupedManualAnswer(fixture.input);
      expect(result.status).toBe("applied");

      const answers = await repository.listApplicationAnswerRecords();
      const answerById = new Map(answers.map((answer) => [answer.id, answer]));
      expect(answerById.get("answer_question_a_v1")).toEqual(
        expect.objectContaining({ revision: 1, supersedesAnswerId: null }),
      );
      expect(answerById.get("answer_question_b_v2")).toEqual(
        expect.objectContaining({
          revision: 2,
          supersedesAnswerId: "answer_question_b_v1",
        }),
      );
      expect(answerById.get("answer_question_b_v1")).toEqual(
        expect.objectContaining({ revision: 1 }),
      );
    });
  });

  test("a retried duplicate never re-creates or re-advances answers", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);

      await expect(
        repository.commitGroupedManualAnswer(fixture.input),
      ).resolves.toMatchObject({ status: "applied" });
      await expect(
        repository.commitGroupedManualAnswer(fixture.input),
      ).resolves.toMatchObject({ status: "duplicate" });

      const answers = await repository.listApplicationAnswerRecords();
      const answerById = new Map(answers.map((answer) => [answer.id, answer]));
      expect(answers).toHaveLength(3); // two created answers plus the unrelated one
      expect(answerById.get("answer_question_a_v1")).toEqual(
        expect.objectContaining({ questionId: "question_a", revision: 1 }),
      );
      expect(answerById.get("answer_question_b_v1")).toEqual(
        expect.objectContaining({ questionId: "question_b", revision: 1 }),
      );
      expect(answerById.get("answer_unrelated")).toEqual(
        expect.objectContaining({ revision: 1 }),
      );
    });
  });

  test("survives SQLite restart with the exact approved state", async () => {
    const temp = await createTempRepository(
      "nestor-grouped-manual-answer-restart-",
    );
    temporaryDirectories.push(temp.tempDirectory);

    const firstRepository = await temp.createRepository();
    const fixture = buildGroupedCommit();
    await seedRepository(firstRepository, fixture);
    await expect(
      firstRepository.commitGroupedManualAnswer(fixture.input),
    ).resolves.toMatchObject({ status: "applied" });
    await firstRepository.close();

    const restartedRepository = await temp.createRepository();
    await expect(
      restartedRepository.getUserActionRequest("request_a"),
    ).resolves.toMatchObject({ revision: 2, state: "verifying" });
    await expect(
      restartedRepository.getUserActionRequest("request_b"),
    ).resolves.toMatchObject({ revision: 2, state: "verifying" });
    const intelligence = await restartedRepository.getIntelligenceState();
    expect(intelligence.groupedDecisions[0]).toEqual(fixture.decision);
    await restartedRepository.close();
  });

  test("returns duplicate on an idempotent retry and never re-applies", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);

      await expect(
        repository.commitGroupedManualAnswer(fixture.input),
      ).resolves.toMatchObject({ status: "applied" });
      const afterFirst = await snapshotRepository(repository);

      await expect(
        repository.commitGroupedManualAnswer(fixture.input),
      ).resolves.toMatchObject({
        status: "duplicate",
        decision: fixture.decision,
      });
      const afterRetry = await snapshotRepository(repository);
      expect(afterRetry).toEqual(afterFirst);

      const events = await repository.listUserActionEvents();
      expect(
        events.filter((event) => event.operation === "submit_manual_answer"),
      ).toHaveLength(2);
    });
  });

  test("a stale member request aborts the whole group and leaves every store unchanged", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);

      const request = fixture.persistedRequests[0]!;
      const openedAt = "2026-08-15T10:30:00.000Z";
      const openedRequest = UserActionRequestSchema.parse({
        ...request,
        revision: 2,
        state: "page_opened",
        updatedAt: openedAt,
        openedAt,
      });
      const openedEvent = UserActionEventSchema.parse({
        id: "open-page-a",
        requestId: request.id,
        operation: "open_page",
        previousRevision: 1,
        resultingRevision: 2,
        previousState: "pending",
        resultingState: "page_opened",
        occurredAt: openedAt,
      });
      await repository.commitUserActionTransition({
        request: openedRequest,
        event: openedEvent,
      });

      const before = await snapshotRepository(repository);
      const result = await repository.commitGroupedManualAnswer(fixture.input);
      expectStaleResult(result, "stale_request");
      if (result.status === "stale") {
        expect(result.failure).toEqual(
          expect.objectContaining({
            requestId: "request_a",
            expectedRevision: 1,
            currentRevision: 2,
          }),
        );
      }
      expect(await snapshotRepository(repository)).toEqual(before);
    });
  });

  test("a stale answer aborts the whole group and leaves every store unchanged", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit({ memberBHasAnswer: true });
      await seedRepository(repository, fixture);

      await repository.upsertApplicationAnswerRecord(
        createAnswerRecord({
          id: "answer_question_b_v1",
          runId: "run_1",
          jobId: "job_b",
          resultId: "result_b",
          questionId: "question_b",
          revision: 1,
          overrides: { text: "8 years" },
        }),
      );

      const before = await snapshotRepository(repository);
      const result = await repository.commitGroupedManualAnswer(fixture.input);
      expectStaleResult(result, "stale_answer");
      if (result.status === "stale") {
        expect(result.failure).toEqual(
          expect.objectContaining({
            questionId: "question_b",
            expectedRevision: 1,
            currentRevision: 1,
          }),
        );
      }
      expect(await snapshotRepository(repository)).toEqual(before);
    });
  });

  test("a stale question aborts the whole group and leaves every store unchanged", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);

      await repository.upsertApplicationQuestionRecord(
        createQuestionRecord({
          id: "question_a",
          runId: "run_1",
          jobId: "job_a",
          resultId: "result_a",
          overrides: { prompt: "Notice period" },
        }),
      );

      const before = await snapshotRepository(repository);
      const result = await repository.commitGroupedManualAnswer(fixture.input);
      expectStaleResult(result, "stale_question");
      if (result.status === "stale") {
        expect(result.failure).toEqual(
          expect.objectContaining({ questionId: "question_a" }),
        );
      }
      expect(await snapshotRepository(repository)).toEqual(before);
    });
  });

  test("a stale decision aborts the whole group and leaves every store unchanged", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);

      const changedPending = GroupedManualAnswerDecisionSchema.parse({
        ...fixture.pending,
        updatedAt: "2026-08-15T09:00:00.000Z",
      });
      const intelligence = await repository.getIntelligenceState();
      await repository.saveIntelligenceState({
        ...intelligence,
        groupedDecisions: [changedPending],
        updatedAt: null,
      });

      const before = await snapshotRepository(repository);
      const result = await repository.commitGroupedManualAnswer(fixture.input);
      expectStaleResult(result, "stale_decision");
      if (result.status === "stale") {
        expect(result.failure).toEqual(
          expect.objectContaining({
            decisionId: "decision_1",
            expectedRevision: 1,
            currentRevision: 1,
          }),
        );
      }
      expect(await snapshotRepository(repository)).toEqual(before);
    });
  });

  test("an already-filled answer for a group member with no expected answer aborts", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);

      // A conflicting outside write for the same question must abort the whole
      // group instead of being silently treated as the commit's own answer.
      await repository.upsertApplicationAnswerRecord(
        createAnswerRecord({
          id: "answer_question_a_v1",
          runId: "run_1",
          jobId: "job_a",
          resultId: "result_a",
          questionId: "question_a",
          revision: 1,
          overrides: {
            text: "8 years",
            value: { type: "text", value: "8 years" },
          },
        }),
      );

      const before = await snapshotRepository(repository);
      const result = await repository.commitGroupedManualAnswer(fixture.input);
      expectStaleResult(result, "stale_answer");
      if (result.status === "stale") {
        expect(result.failure).toEqual(
          expect.objectContaining({
            questionId: "question_a",
            expectedRevision: 0,
            currentRevision: 1,
          }),
        );
      }
      expect(await snapshotRepository(repository)).toEqual(before);
    });
  });

  test.each([
    {
      name: "a dropped lineage member",
      mutate: (fixture: GroupedCommitFixture) => ({
        ...fixture.input,
        decision: {
          ...fixture.decision,
          lineage: fixture.decision.lineage.slice(0, 1),
        },
        lineage: fixture.decision.lineage.slice(0, 1),
        requests: fixture.input.requests.slice(0, 1),
        expectedQuestions: fixture.input.expectedQuestions.slice(0, 1),
        questions: fixture.input.questions.slice(0, 1),
      }),
    },
    {
      name: "a resolved verifying request",
      mutate: (fixture: GroupedCommitFixture) => ({
        ...fixture.input,
        requests: fixture.input.requests.map((request, index) =>
          index === 0 ? { ...request, resolvedAt: appliedAt } : request,
        ),
      }),
    },
    {
      name: "a question without its answer selection",
      mutate: (fixture: GroupedCommitFixture) => ({
        ...fixture.input,
        questions: fixture.input.questions.map((question, index) =>
          index === 0 ? { ...question, selectedAnswerId: null } : question,
        ),
      }),
    },
    {
      name: "a question with mismatched answer text",
      mutate: (fixture: GroupedCommitFixture) => ({
        ...fixture.input,
        questions: fixture.input.questions.map((question, index) =>
          index === 0
            ? { ...question, submittedAnswer: "Another answer" }
            : question,
        ),
      }),
    },
    {
      name: "a question that is still detected",
      mutate: (fixture: GroupedCommitFixture) => ({
        ...fixture.input,
        questions: fixture.input.questions.map((question, index) =>
          index === 0 ? { ...question, status: "detected" as const } : question,
        ),
      }),
    },
    {
      name: "a mismatched approved timestamp",
      mutate: (fixture: GroupedCommitFixture) => ({
        ...fixture.input,
        decision: {
          ...fixture.decision,
          approvedAt: "2026-08-15T11:31:00.000Z",
        },
      }),
    },
  ])("rejects $name before mutating either repository", async ({ mutate }) => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);
      const before = await snapshotRepository(repository);

      await expect(async () =>
        repository.commitGroupedManualAnswer(
          mutate(fixture) as CommitGroupedManualAnswerInput,
        ),
      ).rejects.toThrow();
      expect(await snapshotRepository(repository)).toEqual(before);
    });
  });

  test.each([
    {
      name: "a submitted next answer",
      mutateAnswer: (answer: ApplicationAnswerRecord) => ({
        ...answer,
        status: "submitted" as const,
        submittedAt: appliedAt,
      }),
    },
    {
      name: "answer text that differs from the approved decision",
      mutateAnswer: (answer: ApplicationAnswerRecord) => ({
        ...answer,
        text: "Different answer",
        value: { type: "text" as const, value: "Different answer" },
      }),
    },
    {
      name: "an answer with a different job identity",
      mutateAnswer: (answer: ApplicationAnswerRecord) => ({
        ...answer,
        jobId: "job_a",
      }),
    },
  ])(
    "rejects $name before mutating either repository",
    async ({ mutateAnswer }) => {
      await runOnBoth(async (repository) => {
        const fixture = buildGroupedCommit({ memberBHasAnswer: true });
        await seedRepository(repository, fixture);
        const before = await snapshotRepository(repository);
        const invalid = {
          ...fixture.input,
          answers: fixture.input.answers.map(mutateAnswer),
        } as CommitGroupedManualAnswerInput;

        await expect(async () =>
          repository.commitGroupedManualAnswer(invalid),
        ).rejects.toThrow();
        expect(await snapshotRepository(repository)).toEqual(before);
      });
    },
  );

  test("rejects an extra expected answer outside the group", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);
      const before = await snapshotRepository(repository);
      const invalid: CommitGroupedManualAnswerInput = {
        ...fixture.input,
        expectedAnswers: [
          ...fixture.input.expectedAnswers,
          createAnswerRecord({
            id: "answer_extra",
            runId: "run_1",
            jobId: "job_c",
            resultId: "result_c",
            questionId: "question_unrelated",
            revision: 1,
          }),
        ],
      };

      await expect(async () =>
        repository.commitGroupedManualAnswer(invalid),
      ).rejects.toThrow();
      expect(await snapshotRepository(repository)).toEqual(before);
    });
  });

  test("returns a typed stale result for a colliding grouped event id", async () => {
    await runOnBoth(async (repository) => {
      const fixture = buildGroupedCommit();
      await seedRepository(repository, fixture);
      const unrelated = await repository.getUserActionRequest(
        "action-login-unrelated",
      );
      expect(unrelated).not.toBeNull();
      if (!unrelated) return;
      const changed = UserActionRequestSchema.parse({
        ...unrelated,
        revision: unrelated.revision + 1,
        state: "page_opened",
        openedAt: appliedAt,
        updatedAt: appliedAt,
      });
      await repository.commitUserActionTransition({
        request: changed,
        event: UserActionEventSchema.parse({
          id: "request_a:grouped_manual_answer",
          requestId: unrelated.id,
          operation: "open_page",
          previousRevision: unrelated.revision,
          resultingRevision: changed.revision,
          previousState: unrelated.state,
          resultingState: changed.state,
          occurredAt: appliedAt,
        }),
      });
      const before = await snapshotRepository(repository);

      const result = await repository.commitGroupedManualAnswer(fixture.input);
      expectStaleResult(result, "stale_request");
      expect(await snapshotRepository(repository)).toEqual(before);
    });
  });
});
