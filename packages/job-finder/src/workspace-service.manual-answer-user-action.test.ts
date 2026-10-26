import { buildApplyCopilotArtifacts } from "./internal/workspace-apply-run-support";
import {
  ApplicationAnswerRecordSchema,
  ApplyExecutionResultSchema,
  ApplicationResumeArtifactSchema,
  ApplicationAttemptSchema,
  ApplicationQuestionRecordSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  UserActionEventSchema,
  UserActionRequestSchema,
  type ApplicationAnswerRecord,
  type ApplicationQuestionRecord,
  type UserActionRequest,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createDocumentManager,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const now = "2026-08-15T10:00:00.000Z";
const later = "2026-08-15T11:00:00.000Z";

function createManualAnswerRequest(
  overrides: Partial<UserActionRequest> = {},
): UserActionRequest {
  return UserActionRequestSchema.parse({
    id: "request_a",
    dedupeKey: "dedupe_request_a",
    revision: 1,
    kind: "manual_answer",
    state: "pending",
    requirement: "required",
    scope: {
      type: "application",
      runId: "run_manual",
      jobId: "job_ready",
      applicationRecordId: "application_a",
      resultId: "result_a",
      replayCheckpointId: null,
      source: "target_site",
    },
    verification: {
      type: "page_blocker_absent",
      blockerFingerprint: "blocker_request_a",
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
    ...overrides,
  });
}

function createQuestion(): ApplicationQuestionRecord {
  return ApplicationQuestionRecordSchema.parse({
    id: "question_a",
    runId: "run_manual",
    jobId: "job_ready",
    applicationRecordId: "application_a",
    resultId: "result_a",
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
  });
}

function createAnswer(input: {
  id: string;
  questionId?: string;
  revision?: number;
  supersedesAnswerId?: string | null;
  text?: string;
  createdAt?: string;
  applicationRecordId?: string | null;
}): ApplicationAnswerRecord {
  return ApplicationAnswerRecordSchema.parse({
    id: input.id,
    runId: "run_manual",
    jobId: "job_ready",
    applicationRecordId: input.applicationRecordId ?? "application_a",
    resultId: "result_a",
    questionId: input.questionId ?? "question_a",
    status: "suggested",
    text: input.text ?? "5 years",
    value: { type: "text", value: input.text ?? "5 years" },
    revision: input.revision ?? 1,
    saveScope: "application_once",
    supersedesAnswerId: input.supersedesAnswerId ?? null,
    sourceKind: "user",
    sourceId: null,
    confidenceLabel: null,
    provenance: [],
    createdAt: input.createdAt ?? now,
    submittedAt: null,
  });
}

function submitManualAnswerCommand(commandId = "command_submit") {
  return {
    action: "submit_manual_answer" as const,
    requestId: "request_a",
    commandId,
    expectedRevision: 1,
    answer: "5 years",
    saveForFuture: false,
    credentialsPolicy: "browser_only" as const,
    submitAuthorized: false as const,
    accountCreationAuthorized: false as const,
  };
}

describe("workspace manual-answer persistence races", () => {
  test("creates a monotonic revision-1 manual answer with no superseded record", async () => {
    const seed = createSeed();
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_a",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "ready_for_review",
        lastActionLabel: "Manual answer needed",
        nextActionLabel: "Review answer",
        lastUpdatedAt: now,
      }),
    ];
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "run_manual",
        campaignId: null,
        state: "completed",
        jobIds: ["job_ready"],
        currentJobId: null,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        summary: "Manual answer needed.",
        detail: "The exact application remains reviewable.",
        totalJobs: 1,
        pendingJobs: 0,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "result_a",
        runId: "run_manual",
        jobId: "job_ready",
        applicationRecordId: "application_a",
        state: "blocked",
        summary: "Manual answer needed.",
        detail: "A required question needs review.",
        startedAt: now,
        updatedAt: now,
      }),
    ];
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [createQuestion()];
    const harness = createWorkspaceServiceHarness({ seed });

    const snapshot = await harness.workspaceService.performUserAction(
      submitManualAnswerCommand(),
    );

    expect(snapshot.userActionRequests[0]).toEqual(
      expect.objectContaining({ state: "verifying", revision: 2 }),
    );
    const answers = await harness.repository.listApplicationAnswerRecords();
    expect(answers).toHaveLength(1);
    expect(answers[0]).toEqual(
      expect.objectContaining({
        id: "manual_answer_request_a_2",
        applicationRecordId: "application_a",
        questionId: "question_a",
        revision: 1,
        supersedesAnswerId: null,
        status: "suggested",
        submittedAt: null,
        text: "5 years",
      }),
    );
    // Locally answered and selected, without any employer submission.
    const questions = await harness.repository.listApplicationQuestionRecords();
    expect(questions[0]).toEqual(
      expect.objectContaining({
        status: "answered",
        selectedAnswerId: answers[0]!.id,
        submittedAnswer: "5 years",
      }),
    );
  });

  test("a bare answer goes to the one question still waiting when earlier ones were already answered", async () => {
    const seed = createSeed();
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_a",
        jobId: "job_ready",
        title: "Senior Product Designer",
        company: "Signal Systems",
        status: "ready_for_review",
        lastActionLabel: "Manual answer needed",
        nextActionLabel: "Review answer",
        lastUpdatedAt: now,
      }),
    ];
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "run_manual",
        campaignId: null,
        state: "completed",
        jobIds: ["job_ready"],
        currentJobId: null,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        summary: "Manual answer needed.",
        detail: "The exact application remains reviewable.",
        totalJobs: 1,
        pendingJobs: 0,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "result_a",
        runId: "run_manual",
        jobId: "job_ready",
        applicationRecordId: "application_a",
        state: "blocked",
        summary: "Manual answer needed.",
        detail: "A required question needs review.",
        startedAt: now,
        updatedAt: now,
      }),
    ];
    seed.userActionRequests = [createManualAnswerRequest()];
    // The postal code was answered on an earlier step of this same
    // application; its question record stays detected.
    seed.applicationQuestionRecords = [
      createQuestion(),
      ApplicationQuestionRecordSchema.parse({
        ...createQuestion(),
        id: "question_notice",
        prompt: "What is your notice period?",
        kind: "other",
      }),
    ];
    seed.applicationAnswerRecords = [
      createAnswer({ id: "earlier_answer", questionId: "question_a" }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });

    await harness.workspaceService.performUserAction({
      ...submitManualAnswerCommand(),
      answer: "Two weeks",
    });

    const answers = await harness.repository.listApplicationAnswerRecords();
    expect(
      answers.find((answer) => answer.questionId === "question_notice"),
    ).toEqual(expect.objectContaining({ text: "Two weeks" }));
  });

  test("advances the revision and supersedes the actual latest record for the question", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [createQuestion()];
    seed.applicationAnswerRecords = [
      createAnswer({
        id: "answer_existing",
        revision: 1,
        supersedesAnswerId: null,
        text: "3 years",
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });

    await harness.workspaceService.performUserAction(
      submitManualAnswerCommand(),
    );

    const answers = await harness.repository.listApplicationAnswerRecords();
    const byId = new Map(answers.map((answer) => [answer.id, answer]));
    expect(answers).toHaveLength(2);
    expect(byId.get("manual_answer_request_a_2")).toEqual(
      expect.objectContaining({
        revision: 2,
        supersedesAnswerId: "answer_existing",
        status: "suggested",
        submittedAt: null,
      }),
    );
    expect(byId.get("answer_existing")).toEqual(
      expect.objectContaining({ revision: 1, supersedesAnswerId: null }),
    );
  });

  test("does not read or supersede an answer from a sibling application record", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [
      createQuestion(),
      ApplicationQuestionRecordSchema.parse({
        ...createQuestion(),
        id: "question_b",
        applicationRecordId: "application_b",
      }),
    ];
    seed.applicationAnswerRecords = [
      createAnswer({
        id: "grouped_answer_sibling_question_b",
        questionId: "question_b",
        revision: 7,
        applicationRecordId: "application_b",
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });

    await harness.workspaceService.performUserAction(
      submitManualAnswerCommand(),
    );

    const answers = await harness.repository.listApplicationAnswerRecords();
    expect(answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "manual_answer_request_a_2",
          applicationRecordId: "application_a",
          questionId: "question_a",
          revision: 1,
          supersedesAnswerId: null,
        }),
        expect.objectContaining({
          id: "grouped_answer_sibling_question_b",
          applicationRecordId: "application_b",
          questionId: "question_b",
          revision: 7,
        }),
      ]),
    );
  });

  test("an exact retry of the deterministic record id is idempotent and preserves createdAt", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [createQuestion()];
    const harness = createWorkspaceServiceHarness({ seed });

    const command = submitManualAnswerCommand("command_retry");
    await harness.workspaceService.performUserAction(command);
    const first = await harness.repository.listApplicationAnswerRecords();
    expect(first).toHaveLength(1);
    const createdAt = first[0]!.createdAt;

    // Re-issuing the exact same command is the reducer-stale retry path; the
    // exact commandId event exists, so the answer is re-persisted idempotently
    // (no new revision, no rewritten createdAt).
    await harness.workspaceService.performUserAction(command);
    const second = await harness.repository.listApplicationAnswerRecords();
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual(
      expect.objectContaining({
        id: "manual_answer_request_a_2",
        revision: 1,
        supersedesAnswerId: null,
        createdAt,
      }),
    );
  });

  test("a same-id conflict throws instead of overwriting", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [createQuestion()];
    seed.applicationAnswerRecords = [
      createAnswer({
        id: "manual_answer_request_a_2",
        revision: 1,
        supersedesAnswerId: null,
        text: "conflicting answer",
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });

    await expect(
      harness.workspaceService.performUserAction(submitManualAnswerCommand()),
    ).rejects.toThrow(/already exists with different data/i);

    // The conflicting record is untouched.
    const answers = await harness.repository.listApplicationAnswerRecords();
    expect(answers).toHaveLength(1);
    expect(answers[0]).toEqual(
      expect.objectContaining({
        id: "manual_answer_request_a_2",
        text: "conflicting answer",
      }),
    );
  });

  test("a snapshot taken while the answer is being stored leaves the step alone", async () => {
    const seed = createSeed();
    seed.userActionRequests = [
      createManualAnswerRequest({
        scope: {
          type: "application",
          runId: "run_manual",
          jobId: "job_ready",
          applicationRecordId: "application_a",
          resultId: "result_a",
          replayCheckpointId: "checkpoint_a",
          source: "target_site",
        },
      }),
    ];
    seed.applicationQuestionRecords = [createQuestion()];
    const harness = createWorkspaceServiceHarness({ seed });
    const originalCommit =
      harness.repository.commitApplicationAnswerMutation.bind(
        harness.repository,
      );
    let releaseStore!: () => void;
    const storeGate = new Promise<void>((resolve) => {
      releaseStore = resolve;
    });
    let storeStarted!: () => void;
    const storing = new Promise<void>((resolve) => {
      storeStarted = resolve;
    });
    harness.repository.commitApplicationAnswerMutation = async (mutation) => {
      storeStarted();
      await storeGate;
      return originalCommit(mutation);
    };

    const answering = harness.workspaceService
      .performUserAction(submitManualAnswerCommand())
      .catch(() => undefined);
    await storing;
    // The step is verifying and its answer is not stored yet.
    await harness.workspaceService.getWorkspaceSnapshot();
    // Read as a lost write, the snapshot used to hand the question back
    // here, before the answer ever landed.
    expect(await harness.repository.getUserActionRequest("request_a")).toEqual(
      expect.objectContaining({ state: "verifying", revision: 2 }),
    );
    expect(
      (
        await harness.repository.listUserActionEvents({
          requestId: "request_a",
        })
      ).map((event) => event.operation),
    ).toEqual(["submit_manual_answer"]);
    releaseStore();
    await answering;

    expect(
      await harness.repository.listApplicationAnswerRecords({
        runId: "run_manual",
        jobId: "job_ready",
        resultId: "result_a",
        applicationRecordId: "application_a",
      }),
    ).toHaveLength(1);
  });

  test("a commit race returning stale never persists the answer", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [createQuestion()];
    const harness = createWorkspaceServiceHarness({ seed });

    // Simulate a concurrent writer advancing the request between the reducer
    // and the caller's commit: the caller's transition then returns stale.
    const originalCommit = harness.repository.commitUserActionTransition.bind(
      harness.repository,
    );
    let advanced = false;
    harness.repository.commitUserActionTransition = async (input) => {
      if (!advanced) {
        advanced = true;
        const current = await harness.repository.getUserActionRequest(
          input.request.id,
        );
        if (current) {
          const advancedRequest = UserActionRequestSchema.parse({
            ...current,
            revision: current.revision + 1,
            state: "page_opened",
            openedAt: current.openedAt ?? later,
            updatedAt: later,
          });
          await originalCommit({
            request: advancedRequest,
            event: UserActionEventSchema.parse({
              id: "race_advance",
              requestId: advancedRequest.id,
              operation: "open_page",
              previousRevision: current.revision,
              resultingRevision: advancedRequest.revision,
              previousState: current.state,
              resultingState: "page_opened",
              occurredAt: later,
            }),
          });
        }
      }
      return originalCommit(input);
    };

    await harness.workspaceService.performUserAction(
      submitManualAnswerCommand(),
    );

    // The reducer saw the current revision, but the commit returned stale, so
    // the answer must not be persisted for this command.
    expect(await harness.repository.listApplicationAnswerRecords()).toEqual([]);
    const request = await harness.repository.getUserActionRequest("request_a");
    expect(request).toEqual(
      expect.objectContaining({ state: "page_opened", revision: 2 }),
    );
    const events = await harness.repository.listUserActionEvents({
      requestId: "request_a",
    });
    expect(events.some((event) => event.id === "command_submit")).toBe(false);
  });

  test("legacy null application lineage fails closed before answer or profile mutation", async () => {
    const seed = createSeed();
    seed.userActionRequests = [
      createManualAnswerRequest({
        scope: {
          type: "application",
          runId: "run_manual",
          jobId: "job_ready",
          applicationRecordId: null,
          resultId: "result_a",
          replayCheckpointId: null,
          source: "target_site",
        },
      }),
    ];
    seed.applicationQuestionRecords = [
      ApplicationQuestionRecordSchema.parse({
        ...createQuestion(),
        applicationRecordId: null,
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });
    const profileBefore = await harness.repository.getProfile();

    await expect(
      harness.workspaceService.performUserAction({
        ...submitManualAnswerCommand(),
        saveForFuture: true,
      }),
    ).rejects.toThrow(/missing its exact application record scope/i);

    expect(await harness.repository.listApplicationAnswerRecords()).toEqual([]);
    expect(await harness.repository.getProfile()).toEqual(profileBefore);
  });
  test("a concurrent question edit aborts both the manual answer and selection", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [createQuestion()];
    const harness = createWorkspaceServiceHarness({ seed });
    const commit = harness.repository.commitApplicationAnswerMutation.bind(
      harness.repository,
    );
    harness.repository.commitApplicationAnswerMutation = async (mutation) => {
      await harness.repository.upsertApplicationQuestionRecord({
        ...mutation.expectedQuestion,
        note: "Changed in another view",
      });
      return commit(mutation);
    };
    await expect(
      harness.workspaceService.performUserAction(submitManualAnswerCommand()),
    ).rejects.toThrow("changed in another view");
    expect(await harness.repository.listApplicationAnswerRecords()).toEqual([]);
    expect(
      (await harness.repository.listApplicationQuestionRecords())[0],
    ).toMatchObject({
      status: "detected",
      selectedAnswerId: null,
      note: "Changed in another view",
    });
  });

  test("retrying a multi-question command preserves all atomic selections", async () => {
    const seed = createSeed();
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [
      createQuestion(),
      {
        ...createQuestion(),
        id: "question_notice",
        prompt: "Notice period",
        kind: "notice_period",
      },
    ];
    const harness = createWorkspaceServiceHarness({ seed });
    const command = {
      ...submitManualAnswerCommand("command_retry_multiple"),
      answers: [
        { questionId: "question_a", answer: "5 years" },
        { questionId: "question_notice", answer: "Two weeks" },
      ],
    };
    await harness.workspaceService.performUserAction(command);
    const firstAnswers =
      await harness.repository.listApplicationAnswerRecords();
    const firstQuestions =
      await harness.repository.listApplicationQuestionRecords();
    await harness.workspaceService.performUserAction(command);
    expect(await harness.repository.listApplicationAnswerRecords()).toEqual(
      firstAnswers,
    );
    expect(await harness.repository.listApplicationQuestionRecords()).toEqual(
      firstQuestions,
    );
    for (const question of firstQuestions) {
      const answer = firstAnswers.find(
        (answer) => answer.id === question.selectedAnswerId,
      )!;
      expect(question.status).toBe("answered");
      expect(question.submittedAnswer).toBe(answer.text);
      expect(answer.submittedAt).toBeNull();
    }
  });
});

test("a one-question retry ignores historical detected questions from an older handoff", async () => {
  const seed = createSeed();
  seed.userActionRequests = [createManualAnswerRequest()];
  seed.applicationQuestionRecords = [
    createQuestion(),
    {
      ...createQuestion(),
      id: "question_old",
      prompt: "Old removed work-history date",
    },
  ];
  seed.applicationAttempts = [
    ApplicationAttemptSchema.parse({
      id: "attempt_current",
      startedAt: now,
      completedAt: null,
      outcome: "ready_for_review",
      nextActionLabel: "Answer and continue",
      jobId: "job_ready",
      applicationRecordId: "application_a",
      state: "paused",
      summary: "One answer needed",
      detail: "Current experience question",
      createdAt: now,
      updatedAt: later,
      questions: [
        {
          id: "question_a",
          prompt: "Years of experience",
          kind: "experience",
          status: "detected",
          detectedAt: now,
        },
      ],
    }),
  ];
  const harness = createWorkspaceServiceHarness({ seed });
  await harness.workspaceService.performUserAction(submitManualAnswerCommand());
  const records = await harness.repository.listApplicationAnswerRecords();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    questionId: "question_a",
    text: "5 years",
    saveScope: "application_once",
  });
  expect(
    (await harness.repository.getProfile()).answerBank.customAnswers,
  ).toEqual(seed.profile.answerBank.customAnswers);
});

test.each(["Years of experience", "I consent to a background check"])(
  "can answer %s again after a closed-page check and a new preparation result",
  async (prompt) => {
    const seed = createSeed();
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [{ ...createQuestion(), prompt }];
    const harness = createWorkspaceServiceHarness({ seed });
    await harness.workspaceService.performUserAction(
      submitManualAnswerCommand(),
    );
    const previous = (
      await harness.repository.listApplicationAnswerRecords()
    )[0]!;
    // Try again produces a new result with the same stable question ID.
    // The earlier answer remains attached to the closed-page result.
    const currentQuestion = {
      ...createQuestion(),
      prompt,
      resultId: "result_retry",
      runId: "run_retry",
      detectedAt: later,
    };
    await harness.repository.upsertApplicationQuestionRecord(currentQuestion);
    await harness.repository.createUserActionRequest(
      createManualAnswerRequest({
        id: "request_retry",
        dedupeKey: "dedupe_retry",
        scope: {
          type: "application",
          jobId: "job_ready",
          applicationRecordId: "application_a",
          runId: "run_retry",
          resultId: "result_retry",
          replayCheckpointId: null,
          source: "target_site",
        },
      }),
    );
    await harness.workspaceService.performUserAction({
      ...submitManualAnswerCommand("retry_answer"),
      requestId: "request_retry",
      answers: [
        {
          questionId: "question_a",
          answer: prompt === "Years of experience" ? "5 years" : "Yes",
        },
      ],
    });
    const answers = await harness.repository.listApplicationAnswerRecords({
      questionId: "question_a",
    });
    expect(answers).toHaveLength(2);
    expect(
      answers.find((answer) => answer.resultId === "result_retry"),
    ).toMatchObject({
      revision: 2,
      supersedesAnswerId: previous.id,
      saveScope: "application_once",
    });
    expect(
      (await harness.repository.getProfile()).answerBank.customAnswers,
    ).toEqual([]);
  },
);
test("a current attempt can re-answer a record marked answered by an earlier check", async () => {
  const seed = createSeed();
  seed.userActionRequests = [createManualAnswerRequest()];
  const previous = createAnswer({ id: "old_check_answer" });
  seed.applicationAnswerRecords = [previous];
  seed.applicationQuestionRecords = [
    {
      ...createQuestion(),
      status: "answered",
      selectedAnswerId: previous.id,
      submittedAnswer: previous.text,
    },
  ];
  seed.applicationAttempts = [
    ApplicationAttemptSchema.parse({
      id: "current_retry",
      applicationRecordId: "application_a",
      jobId: "job_ready",
      outcome: "ready_for_review",
      state: "paused",
      startedAt: later,
      completedAt: null,
      summary: "The field remains empty",
      detail: "The page check failed",
      nextActionLabel: "Answer and continue",
      createdAt: later,
      updatedAt: later,
      questions: [{ ...createQuestion(), status: "detected" }],
    }),
  ];
  const harness = createWorkspaceServiceHarness({ seed });
  await harness.workspaceService.performUserAction(submitManualAnswerCommand());
  expect(await harness.repository.listApplicationAnswerRecords()).toHaveLength(
    2,
  );
});

test.each([false, true])(
  "saves the person's pay answer to the library only when chosen (%s)",
  async (saveForFuture) => {
    const seed = createSeed();
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [
      {
        ...createQuestion(),
        prompt: "Expected salary",
        kind: "salary_expectation",
      },
    ];
    const harness = createWorkspaceServiceHarness({ seed });
    await harness.workspaceService.performUserAction({
      ...submitManualAnswerCommand(),
      answer: "90000 EUR",
      saveForFuture,
    });
    expect(
      (await harness.repository.listApplicationAnswerRecords())[0],
    ).toMatchObject({
      text: "90000 EUR",
      sourceKind: "user",
      saveScope: saveForFuture ? "reusable_profile" : "application_once",
    });
    const answers = (await harness.repository.getProfile()).answerBank
      .customAnswers;
    if (saveForFuture)
      expect(answers).toContainEqual(
        expect.objectContaining({
          question: "Expected salary",
          answer: "90000 EUR",
        }),
      );
    else expect(answers).toEqual(seed.profile.answerBank.customAnswers);
  },
);

test.each([false, true])(
  "saved pay can be answered after Prepare again (legacy tied revisions: %s)",
  async (legacyTie) => {
    const seed = createSeed();
    const question = {
      ...createQuestion(),
      id: "apply_question_application_a_salary",
      prompt: "Expected salary",
      kind: "salary_expectation" as const,
    };
    seed.userActionRequests = [createManualAnswerRequest()];
    seed.applicationQuestionRecords = [question];
    const harness = createWorkspaceServiceHarness({ seed });
    await harness.workspaceService.performUserAction({
      ...submitManualAnswerCommand(),
      answers: [{ questionId: question.id, answer: "42000 EUR" }],
      saveForFuture: true,
    });
    const previous = (
      await harness.repository.listApplicationAnswerRecords()
    )[0]!;
    const artifacts = buildApplyCopilotArtifacts({
      applicationRecordId: "application_a",
      job: seed.savedJobs.find((job) => job.id === "job_ready")!,
      runId: "run_retry",
      resultId: "result_retry",
      detectedAt: new Date(Date.parse(previous.createdAt) + 1000).toISOString(),
      existingAnswerRecords: [previous],
      resumeArtifact: ApplicationResumeArtifactSchema.parse({
        id: "resume_retry",
        jobId: "job_ready",
        source: "original_upload",
        sourceDocumentId: "synthetic_resume",
        fileName: "Synthetic.pdf",
        filePath: "/tmp/Synthetic.pdf",
        sha256: "a".repeat(64),
        approvedAt: now,
      }),
      executionResult: ApplyExecutionResultSchema.parse({
        state: "paused",
        submittedAt: null,
        outcome: "ready_for_review",
        summary: "Pay needs you",
        detail: "Answer this application's pay question",
        nextActionLabel: "Answer and continue",
        questions: [
          {
            ...question,
            id: "salary",
            status: "detected",
            suggestedAnswers: [
              {
                id: "library_salary",
                text: "42000 EUR",
                sourceKind: "user",
                sourceId: "answerLibrary.saved_pay",
                provenance: [],
              },
            ],
          },
        ],
      }),
    });
    expect(artifacts.answerRecords[0]).toMatchObject({
      revision: 2,
      supersedesAnswerId: previous.id,
    });
    for (const record of artifacts.questionRecords)
      await harness.repository.upsertApplicationQuestionRecord(record);
    for (const record of artifacts.answerRecords)
      await harness.repository.upsertApplicationAnswerRecord(
        legacyTie ? { ...record, revision: 1 } : record,
      );
    await harness.repository.createUserActionRequest(
      createManualAnswerRequest({
        id: "request_retry",
        dedupeKey: "dedupe_retry",
        scope: {
          type: "application",
          jobId: "job_ready",
          applicationRecordId: "application_a",
          runId: "run_retry",
          resultId: "result_retry",
          replayCheckpointId: null,
          source: "target_site",
        },
      }),
    );
    await harness.workspaceService.performUserAction({
      ...submitManualAnswerCommand("retry_salary"),
      requestId: "request_retry",
      answers: [{ questionId: question.id, answer: "42000 EUR" }],
      saveForFuture: true,
    });
    const records = await harness.repository.listApplicationAnswerRecords({
      questionId: question.id,
    });
    expect(records).toHaveLength(3);
    expect(
      records.find((record) => record.sourceId === "request_retry"),
    ).toMatchObject({
      revision: legacyTie ? 2 : 3,
      supersedesAnswerId: artifacts.answerRecords[0]!.id,
      text: "42000 EUR",
    });
    expect(
      (await harness.repository.listUserActionRequests()).find(
        (request) => request.id === "request_retry",
      )?.state,
    ).toBe("verifying");
  },
);

test("answering and saving pay leaves another waiting application in Needs you", async () => {
  const seed = createSeed();
  seed.applicationQuestionRecords = [
    {
      ...createQuestion(),
      prompt: "Expected salary",
      kind: "salary_expectation",
    },
    {
      ...createQuestion(),
      id: "other_pay",
      jobId: "job_other",
      applicationRecordId: "application_b",
      resultId: "result_b",
      prompt: "Expected salary",
      kind: "salary_expectation",
    },
  ];
  seed.userActionRequests = [
    createManualAnswerRequest(),
    createManualAnswerRequest({
      id: "request_b",
      dedupeKey: "dedupe_b",
      scope: {
        type: "application",
        runId: "run_manual",
        jobId: "job_other",
        applicationRecordId: "application_b",
        resultId: "result_b",
        replayCheckpointId: null,
        source: "target_site",
      },
    }),
  ];
  const harness = createWorkspaceServiceHarness({ seed });
  await harness.workspaceService.performUserAction({
    ...submitManualAnswerCommand(),
    answer: "42000 EUR",
    saveForFuture: true,
  });
  await harness.workspaceService.getWorkspaceSnapshot();
  expect(
    (await harness.repository.listUserActionRequests()).find(
      (request) => request.id === "request_b",
    )?.state,
  ).toBe("pending");
  expect(
    await harness.repository.listApplicationAnswerRecords({
      applicationRecordId: "application_b",
    }),
  ).toEqual([]);
  expect(
    (
      await harness.repository.listApplicationQuestionRecords({
        applicationRecordId: "application_b",
      })
    )[0]?.status,
  ).toBe("detected");
});

test("saving a different pay for a second application replaces the saved answer and continues", async () => {
  const seed = createSeed();
  seed.applicationQuestionRecords = [
    {
      ...createQuestion(),
      prompt: "Expected salary",
      kind: "salary_expectation",
    },
    {
      ...createQuestion(),
      id: "other_pay",
      jobId: "job_other",
      applicationRecordId: "application_b",
      resultId: "result_b",
      prompt: "Expected salary",
      kind: "salary_expectation",
    },
  ];
  seed.userActionRequests = [
    createManualAnswerRequest(),
    createManualAnswerRequest({
      id: "request_b",
      dedupeKey: "dedupe_b",
      scope: {
        type: "application",
        runId: "run_manual",
        jobId: "job_other",
        applicationRecordId: "application_b",
        resultId: "result_b",
        replayCheckpointId: null,
        source: "target_site",
      },
    }),
  ];
  const harness = createWorkspaceServiceHarness({ seed });
  await harness.workspaceService.performUserAction({
    ...submitManualAnswerCommand(),
    answer: "42000 EUR",
    saveForFuture: true,
  });
  await harness.workspaceService.performUserAction({
    ...submitManualAnswerCommand("command_submit_b"),
    requestId: "request_b",
    answer: "50000 USD",
    saveForFuture: true,
  });

  const saved = (await harness.repository.getProfile()).answerBank
    .customAnswers;
  expect(saved).toHaveLength(1);
  expect(saved[0]?.answer).toBe("50000 USD");
  expect(
    (
      await harness.repository.listApplicationAnswerRecords({
        applicationRecordId: "application_b",
      })
    ).map((record) => record.text),
  ).toEqual(["50000 USD"]);
  expect(
    (await harness.repository.listUserActionRequests()).find(
      (request) => request.id === "request_b",
    )?.state,
  ).toBe("verifying");
});

test("a cover letter answered here becomes this application's approved letter", async () => {
  const seed = createSeed();
  seed.applicationRecords = [
    ApplicationRecordSchema.parse({
      id: "application_a",
      jobId: "job_ready",
      title: "Senior Product Designer",
      company: "Signal Systems",
      status: "ready_for_review",
      lastActionLabel: "Manual answer needed",
      nextActionLabel: "Review answer",
      lastUpdatedAt: now,
    }),
  ];
  seed.applyRuns = [
    ApplyRunSchema.parse({
      id: "run_manual",
      campaignId: null,
      state: "completed",
      jobIds: ["job_ready"],
      currentJobId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      summary: "Manual answer needed.",
      detail: "The exact application remains reviewable.",
      totalJobs: 1,
      pendingJobs: 0,
    }),
  ];
  seed.applyJobResults = [
    ApplyJobResultSchema.parse({
      id: "result_a",
      runId: "run_manual",
      jobId: "job_ready",
      applicationRecordId: "application_a",
      state: "blocked",
      summary: "The letter needs your review.",
      detail: "A required question needs review.",
      startedAt: now,
      updatedAt: now,
    }),
  ];
  seed.userActionRequests = [createManualAnswerRequest()];
  seed.applicationQuestionRecords = [
    ApplicationQuestionRecordSchema.parse({
      ...createQuestion(),
      prompt: "Cover letter",
      kind: "cover_letter",
    }),
  ];
  const kept: Array<{ text: string; applicationRecordId: string }> = [];
  const documentManager = Object.assign(createDocumentManager(), {
    saveApprovedApplicationLetter: (input: {
      text: string;
      applicationRecord: { id: string };
    }) => {
      kept.push({
        text: input.text,
        applicationRecordId: input.applicationRecord.id,
      });
      return Promise.resolve();
    },
  });
  const harness = createWorkspaceServiceHarness({ seed, documentManager });
  const letter =
    "I enjoy building dependable products. I am looking for 20 hours a week.";

  await harness.workspaceService.performUserAction({
    ...submitManualAnswerCommand(),
    answer: letter,
  });

  // The next preparation attaches these exact words instead of drafting again.
  expect(kept).toEqual([
    { text: letter, applicationRecordId: "application_a" },
  ]);
});
