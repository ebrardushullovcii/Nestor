import {
  ApplicationAnswerRecordSchema,
  ApplicationQuestionRecordSchema,
  ApplicationRecordSchema,
  ApplicationReplayCheckpointSchema,
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
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const now = "2026-08-15T10:00:00.000Z";
const later = "2026-08-15T11:00:00.000Z";

function createManualAnswerRequest(input: {
  id: string;
  jobId: string;
  resultId: string;
  applicationRecordId?: string | null;
  replayCheckpointId?: string | null;
  revision?: number;
  state?: "pending" | "page_opened";
}): UserActionRequest {
  return UserActionRequestSchema.parse({
    id: input.id,
    dedupeKey: `dedupe_${input.id}`,
    revision: input.revision ?? 1,
    kind: "manual_answer",
    state: input.state ?? "pending",
    requirement: "required",
    scope: {
      type: "application",
      runId: "run_grouped",
      jobId: input.jobId,
      applicationRecordId:
        input.applicationRecordId === undefined
          ? `application_${input.jobId}`
          : input.applicationRecordId,
      resultId: input.resultId,
      replayCheckpointId: input.replayCheckpointId ?? null,
      source: "target_site",
    },
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

function createQuestion(input: {
  id: string;
  jobId: string;
  resultId: string;
  applicationRecordId?: string | null;
  prompt?: string;
  status?: "detected" | "answered";
  kind?: "experience" | "salary_expectation";
}): ApplicationQuestionRecord {
  return ApplicationQuestionRecordSchema.parse({
    id: input.id,
    runId: "run_grouped",
    jobId: input.jobId,
    applicationRecordId:
      input.applicationRecordId === undefined
        ? `application_${input.jobId}`
        : input.applicationRecordId,
    resultId: input.resultId,
    prompt: input.prompt ?? "Years of experience",
    kind: input.kind ?? "experience",
    answerControlType: "text",
    isRequired: true,
    detectedAt: now,
    answerOptions: [],
    suggestedAnswers: [],
    selectedAnswerId: null,
    submittedAnswer: null,
    status: input.status ?? "detected",
    pageUrl: null,
    visualContext: null,
  });
}

function createAnswer(input: {
  id: string;
  questionId: string;
  jobId: string;
  resultId: string;
  revision: number;
  supersedesAnswerId?: string | null;
}): ApplicationAnswerRecord {
  return ApplicationAnswerRecordSchema.parse({
    id: input.id,
    runId: "run_grouped",
    jobId: input.jobId,
    applicationRecordId: `application_${input.jobId}`,
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
  });
}

function seedGroupedRequests(options: {
  seed: ReturnType<typeof createSeed>;
  memberBHasAnswer?: boolean;
  replayCheckpointIdA?: string | null;
  replayCheckpointIdB?: string | null;
}): void {
  const {
    seed,
    memberBHasAnswer = false,
    replayCheckpointIdA = null,
    replayCheckpointIdB = null,
  } = options;
  seed.userActionRequests = [
    createManualAnswerRequest({
      id: "request_a",
      jobId: "job_ready",
      resultId: "result_a",
      replayCheckpointId: replayCheckpointIdA,
    }),
    createManualAnswerRequest({
      id: "request_b",
      jobId: "job_generating",
      resultId: "result_b",
      replayCheckpointId: replayCheckpointIdB,
    }),
  ];
  seed.applicationRecords = [
    ApplicationRecordSchema.parse({
      id: "application_job_ready",
      jobId: "job_ready",
      title: "Senior Product Designer",
      company: "Signal Systems",
      status: "ready_for_review",
      lastActionLabel: "Manual answer needed",
      nextActionLabel: "Review answer",
      lastUpdatedAt: now,
    }),
    ApplicationRecordSchema.parse({
      id: "application_job_generating",
      jobId: "job_generating",
      title: "Principal UX Engineer",
      company: "Northwind Labs",
      status: "ready_for_review",
      lastActionLabel: "Manual answer needed",
      nextActionLabel: "Review answer",
      lastUpdatedAt: now,
    }),
  ];
  seed.applyRuns = [
    ApplyRunSchema.parse({
      id: "run_grouped",
      campaignId: null,
      state: "completed",
      jobIds: ["job_ready", "job_generating"],
      currentJobId: null,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      summary: "Manual answers need review.",
      detail: "Both exact application records remain reviewable.",
      totalJobs: 2,
      pendingJobs: 0,
    }),
  ];
  seed.applyJobResults = [
    ApplyJobResultSchema.parse({
      id: "result_a",
      runId: "run_grouped",
      jobId: "job_ready",
      applicationRecordId: "application_job_ready",
      state: "blocked",
      summary: "Manual answer needed.",
      detail: "A required question needs review.",
      startedAt: now,
      updatedAt: now,
    }),
    ApplyJobResultSchema.parse({
      id: "result_b",
      runId: "run_grouped",
      jobId: "job_generating",
      applicationRecordId: "application_job_generating",
      state: "blocked",
      summary: "Manual answer needed.",
      detail: "A required question needs review.",
      startedAt: now,
      updatedAt: now,
    }),
  ];
  seed.applicationQuestionRecords = [
    createQuestion({
      id: "question_a",
      jobId: "job_ready",
      resultId: "result_a",
    }),
    createQuestion({
      id: "question_b",
      jobId: "job_generating",
      resultId: "result_b",
    }),
  ];
  seed.applicationAnswerRecords = memberBHasAnswer
    ? [
        createAnswer({
          id: "answer_question_b_v1",
          questionId: "question_b",
          jobId: "job_generating",
          resultId: "result_b",
          revision: 1,
        }),
      ]
    : [];
}

function projectCommand() {
  return {
    groupKey: "group_1",
    requestId: "request_a",
    expectedRequestRevision: 1,
    answer: { type: "text" as const, value: "5 years" },
    saveScope: "reusable_profile" as const,
  };
}

async function projectAndReadDecision(
  harness: ReturnType<typeof createWorkspaceServiceHarness>,
) {
  await harness.workspaceService.projectGroupedManualAnswer(projectCommand());
  const state = await harness.repository.getIntelligenceState();
  const decision = state.groupedDecisions[0];
  if (!decision) throw new Error("Expected a projected grouped decision.");
  return decision;
}

function applyCommand(decision: {
  id: string;
  lineage: readonly { requestId: string; expectedRequestRevision: number }[];
}) {
  return {
    decisionId: decision.id,
    requestIds: decision.lineage.map((entry) => entry.requestId),
    expectedRequestRevisions: Object.fromEntries(
      decision.lineage.map((entry) => [
        entry.requestId,
        entry.expectedRequestRevision,
      ]),
    ),
    answer: { type: "text" as const, value: "5 years" },
  };
}

describe("workspace grouped reusable manual answers", () => {
  test("projects a pending group rooted in the command request and refuses overwrites", async () => {
    const seed = createSeed();
    seedGroupedRequests({ seed });
    const harness = createWorkspaceServiceHarness({ seed });

    const snapshot =
      await harness.workspaceService.projectGroupedManualAnswer(
        projectCommand(),
      );

    const decisions = snapshot.intelligence.groupedDecisions;
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision).toEqual(
      expect.objectContaining({
        groupKey: "group_1",
        approval: "pending",
        expectedRevision: 1,
        answer: { type: "text", value: "5 years" },
      }),
    );
    expect(decision.id).toMatch(/^group_1:[a-f0-9]{16}$/);
    expect(decision.lineage.map((entry) => entry.requestId).sort()).toEqual([
      "request_a",
      "request_b",
    ]);
    expect(
      decision.lineage.map((entry) => [
        entry.requestId,
        entry.applicationRecordId,
      ]),
    ).toEqual([
      ["request_a", "application_job_ready"],
      ["request_b", "application_job_generating"],
    ]);
    for (const entry of decision.lineage) {
      expect(entry).toEqual(
        expect.objectContaining({
          expectedRequestRevision: 1,
          expectedQuestionRevision: 1,
          expectedAnswerRevision: 0,
          appliedAt: null,
        }),
      );
    }
    // Requests stay untouched pending actions.
    expect(
      snapshot.userActionRequests.map((request) => [request.id, request.state]),
    ).toEqual([
      ["request_a", "pending"],
      ["request_b", "pending"],
    ]);

    // An identical re-project is idempotent and keeps the same decision.
    const second =
      await harness.workspaceService.projectGroupedManualAnswer(
        projectCommand(),
      );
    expect(second.intelligence.groupedDecisions).toHaveLength(1);
    expect(second.intelligence.groupedDecisions[0]!.id).toBe(decision.id);

    // A conflicting re-project must never silently overwrite the pending one.
    await expect(
      harness.workspaceService.projectGroupedManualAnswer({
        ...projectCommand(),
        answer: { type: "text", value: "8 years" },
      }),
    ).rejects.toThrow(/never silently overwrites/i);

    // A stale root revision creates nothing.
    await expect(
      harness.workspaceService.projectGroupedManualAnswer({
        ...projectCommand(),
        groupKey: "group_2",
        expectedRequestRevision: 5,
      }),
    ).rejects.toThrow(/moved to revision 1/i);

    // The original pending decision is still the only one.
    const state = await harness.repository.getIntelligenceState();
    expect(state.groupedDecisions).toHaveLength(1);
    expect(state.groupedDecisions[0]!.id).toBe(decision.id);
  });

  test("projects only proven-compatible pending requests", async () => {
    const seed = createSeed();
    seedGroupedRequests({ seed });
    // request_b's question was already answered in the browser, so its
    // request is no longer a proven-compatible manual-answer blocker and the
    // group cannot be projected.
    seed.applicationQuestionRecords = seed.applicationQuestionRecords.map(
      (question) =>
        question.id === "question_b"
          ? {
              ...question,
              status: "answered" as const,
              submittedAnswer: "5 years",
              selectedAnswerId: "answer_question_b_v1",
            }
          : question,
    );
    const harness = createWorkspaceServiceHarness({ seed });

    await expect(
      harness.workspaceService.projectGroupedManualAnswer(projectCommand()),
    ).rejects.toThrow(/no compatible manual-answer group/i);
    const state = await harness.repository.getIntelligenceState();
    expect(state.groupedDecisions).toEqual([]);
  });

  test("persists advisory contradiction evidence when saved reuse conflicts", async () => {
    const seed = createSeed();
    seedGroupedRequests({ seed, memberBHasAnswer: true });
    seed.applicationAnswerRecords = seed.applicationAnswerRecords.map(
      (answer) => ({
        ...answer,
        text: "7 years",
        value: { type: "text" as const, value: "7 years" },
      }),
    );
    const harness = createWorkspaceServiceHarness({ seed });

    await expect(
      harness.workspaceService.projectGroupedManualAnswer(projectCommand()),
    ).rejects.toThrow(/no compatible manual-answer group/i);

    const first = await harness.repository.getIntelligenceState();
    expect(first.groupedDecisions).toEqual([]);
    expect(first.safeguards.contradictoryAnswerDetections).toHaveLength(1);
    expect(first.safeguards.contradictoryAnswerDetections[0]).toEqual(
      expect.objectContaining({
        answerA: "7 years",
        answerB: "5 years",
        status: "detected",
      }),
    );

    await expect(
      harness.workspaceService.projectGroupedManualAnswer(projectCommand()),
    ).rejects.toThrow(/no compatible manual-answer group/i);
    const second = await harness.repository.getIntelligenceState();
    expect(second.safeguards.contradictoryAnswerDetections).toHaveLength(1);
  });

  test("applies the exact lineage, creating revision-1 answers for revision-0 members", async () => {
    const seed = createSeed();
    seedGroupedRequests({ seed, memberBHasAnswer: true });
    const harness = createWorkspaceServiceHarness({ seed });

    const decision = await projectAndReadDecision(harness);
    expect(
      decision.lineage.map((entry) => [
        entry.requestId,
        entry.expectedAnswerRevision,
      ]),
    ).toEqual([
      ["request_a", 0],
      ["request_b", 1],
    ]);

    const applied = await harness.workspaceService.applyGroupedManualAnswer(
      applyCommand(decision),
    );

    // Every member advanced to verifying (never resolved by the grouped apply)
    // with the deterministic transition events.
    expect(
      applied.userActionRequests.map((request) => [
        request.id,
        request.state,
        request.revision,
        request.resolvedAt,
      ]),
    ).toEqual([
      ["request_a", "verifying", 2, null],
      ["request_b", "verifying", 2, null],
    ]);
    const transitionEvents = applied.userActionEvents.filter(
      (event) => event.operation === "submit_manual_answer",
    );
    expect(transitionEvents).toHaveLength(2);
    expect(transitionEvents.map((event) => event.id).sort()).toEqual([
      "request_a:grouped_manual_answer",
      "request_b:grouped_manual_answer",
    ]);
    for (const event of transitionEvents) {
      expect(event).toEqual(
        expect.objectContaining({
          previousRevision: 1,
          resultingRevision: 2,
          resultingState: "verifying",
          submitAuthorized: false,
          accountCreationAuthorized: false,
          credentialsPolicy: "browser_only",
        }),
      );
    }

    // The decision is approved at exactly the lineage applied time.
    const storedDecision = (await harness.repository.getIntelligenceState())
      .groupedDecisions[0]!;
    expect(storedDecision.approval).toBe("approved");
    expect(storedDecision.approvedAt).not.toBeNull();
    const appliedAt = storedDecision.approvedAt;
    expect(storedDecision.updatedAt).toBe(appliedAt);
    for (const entry of storedDecision.lineage) {
      expect(entry.appliedAt).toBe(appliedAt);
    }

    // Revision-0 member got its first suggested answer atomically; the
    // existing member got the next exact-CAS revision.
    const answers = await harness.repository.listApplicationAnswerRecords();
    const answerById = new Map(answers.map((answer) => [answer.id, answer]));
    expect(answerById.get("answer_question_b_v1")).toEqual(
      expect.objectContaining({ revision: 1 }),
    );
    const decisionId = storedDecision.id;
    expect(answerById.get(`grouped_answer_${decisionId}_question_a`)).toEqual(
      expect.objectContaining({
        applicationRecordId: "application_job_ready",
        questionId: "question_a",
        revision: 1,
        supersedesAnswerId: null,
        status: "suggested",
        submittedAt: null,
        text: "5 years",
      }),
    );
    expect(answerById.get(`grouped_answer_${decisionId}_question_b`)).toEqual(
      expect.objectContaining({
        applicationRecordId: "application_job_generating",
        questionId: "question_b",
        revision: 2,
        supersedesAnswerId: "answer_question_b_v1",
        status: "suggested",
        submittedAt: null,
      }),
    );

    // Each question selects the approved local answer; nothing was submitted.
    const questions = await harness.repository.listApplicationQuestionRecords();
    for (const question of questions) {
      const answer = answers.find(
        (answer) => answer.id === question.selectedAnswerId,
      )!;
      expect(question.status).toBe("answered");
      expect(question.submittedAnswer).toBe(answer.text);
      expect(answer.submittedAt).toBeNull();
    }

    // Re-applying the same command is an idempotent duplicate: nothing new is
    // written and no answer is re-created or re-advanced.
    const before = answers.length;
    const retried = await harness.workspaceService.applyGroupedManualAnswer(
      applyCommand(decision),
    );
    expect(retried.intelligence.groupedDecisions[0]!.approval).toBe("approved");
    expect(
      (await harness.repository.listApplicationAnswerRecords()).length,
    ).toBe(before);
    expect(
      (await harness.repository.listUserActionEvents()).filter(
        (event) => event.operation === "submit_manual_answer",
      ),
    ).toHaveLength(2);

    expect(
      await harness.repository.listApplicationAnswerRecords({
        applicationRecordId: "application_job_ready",
      }),
    ).toEqual([
      expect.objectContaining({
        applicationRecordId: "application_job_ready",
        questionId: "question_a",
      }),
    ]);
  });

  test("keeps same-job sibling answers isolated by exact application lineage", async () => {
    const seed = createSeed();
    seed.userActionRequests = [
      createManualAnswerRequest({
        id: "request_a",
        jobId: "job_ready",
        resultId: "result_a",
        applicationRecordId: "application_same_job_a",
      }),
      createManualAnswerRequest({
        id: "request_b",
        jobId: "job_ready",
        resultId: "result_b",
        applicationRecordId: "application_same_job_b",
      }),
    ];
    seed.applicationQuestionRecords = [
      createQuestion({
        id: "question_a",
        jobId: "job_ready",
        resultId: "result_a",
        applicationRecordId: "application_same_job_a",
      }),
      createQuestion({
        id: "question_b",
        jobId: "job_ready",
        resultId: "result_b",
        applicationRecordId: "application_same_job_b",
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });

    const decision = await projectAndReadDecision(harness);
    await harness.workspaceService.applyGroupedManualAnswer(
      applyCommand(decision),
    );

    const answers = await harness.repository.listApplicationAnswerRecords();
    expect(
      answers.map((answer) => [answer.questionId, answer.applicationRecordId]),
    ).toEqual([
      ["question_a", "application_same_job_a"],
      ["question_b", "application_same_job_b"],
    ]);
    expect(
      await harness.repository.listApplicationAnswerRecords({
        applicationRecordId: "application_same_job_a",
      }),
    ).toEqual([
      expect.objectContaining({
        questionId: "question_a",
        applicationRecordId: "application_same_job_a",
      }),
    ]);
  });

  test("rejects a mixed legacy-null group without partial writes", async () => {
    const seed = createSeed();
    seedGroupedRequests({ seed });
    seed.userActionRequests = seed.userActionRequests.map((request) =>
      request.id === "request_b"
        ? UserActionRequestSchema.parse({
            ...request,
            scope: { ...request.scope, applicationRecordId: null },
          })
        : request,
    );
    seed.applicationQuestionRecords = seed.applicationQuestionRecords.map(
      (question) =>
        question.id === "question_b"
          ? ApplicationQuestionRecordSchema.parse({
              ...question,
              applicationRecordId: null,
            })
          : question,
    );
    const harness = createWorkspaceServiceHarness({ seed });

    await expect(
      harness.workspaceService.projectGroupedManualAnswer(projectCommand()),
    ).rejects.toThrow(/no compatible manual-answer group/i);

    expect(
      (await harness.repository.getIntelligenceState()).groupedDecisions,
    ).toEqual([]);
    expect(await harness.repository.listApplicationAnswerRecords()).toEqual([]);
    expect(await harness.repository.listUserActionEvents()).toEqual([]);
    expect(
      (await harness.repository.listUserActionRequests()).map((request) => [
        request.id,
        request.state,
        request.revision,
      ]),
    ).toEqual([
      ["request_a", "pending", 1],
      ["request_b", "pending", 1],
    ]);
  });

  test("a stale member aborts the whole apply with no partial state", async () => {
    const seed = createSeed();
    seedGroupedRequests({ seed });
    const harness = createWorkspaceServiceHarness({ seed });

    const decision = await projectAndReadDecision(harness);

    // The user opens the page in the Job Finder browser, advancing the member
    // request past the captured revision.
    const requestA = seed.userActionRequests[0]!;
    const opened = UserActionRequestSchema.parse({
      ...requestA,
      revision: 2,
      state: "page_opened",
      openedAt: later,
      updatedAt: later,
    });
    await harness.repository.commitUserActionTransition({
      request: opened,
      event: UserActionEventSchema.parse({
        id: "open_request_a",
        requestId: requestA.id,
        operation: "open_page",
        previousRevision: 1,
        resultingRevision: 2,
        previousState: "pending",
        resultingState: "page_opened",
        occurredAt: later,
      }),
    });

    const beforeAnswers =
      await harness.repository.listApplicationAnswerRecords();
    const beforeDecision = (await harness.repository.getIntelligenceState())
      .groupedDecisions[0]!;

    await expect(
      harness.workspaceService.applyGroupedManualAnswer(applyCommand(decision)),
    ).rejects.toThrow(/whole group is aborted/i);

    expect(await harness.repository.listApplicationAnswerRecords()).toEqual(
      beforeAnswers,
    );
    const afterDecision = (await harness.repository.getIntelligenceState())
      .groupedDecisions[0]!;
    expect(afterDecision).toEqual(beforeDecision);
    expect(afterDecision.approval).toBe("pending");
    const requests = await harness.repository.listUserActionRequests();
    const byId = new Map(requests.map((request) => [request.id, request]));
    expect(byId.get("request_a")).toEqual(
      expect.objectContaining({ state: "page_opened", revision: 2 }),
    );
    expect(byId.get("request_b")).toEqual(
      expect.objectContaining({ state: "pending", revision: 1 }),
    );
  });

  test("snoozes a pending decision with a CAS revision and never overwrites it", async () => {
    const seed = createSeed();
    seedGroupedRequests({ seed });
    const harness = createWorkspaceServiceHarness({ seed });

    const decision = await projectAndReadDecision(harness);
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const snoozed = await harness.workspaceService.snoozeGroupedDecision({
      decisionId: decision.id,
      expectedRevision: decision.expectedRevision,
      until: future,
      reason: "Ask the recruiter",
    });

    const stored = snoozed.intelligence.groupedDecisions[0]!;
    expect(stored).toEqual(
      expect.objectContaining({
        approval: "pending",
        expectedRevision: decision.expectedRevision + 1,
        snooze: {
          until: future,
          reason: "Ask the recruiter",
        },
      }),
    );

    // A second snooze with the stale revision is refused.
    await expect(
      harness.workspaceService.snoozeGroupedDecision({
        decisionId: decision.id,
        expectedRevision: decision.expectedRevision,
        until: new Date(Date.now() + 96 * 60 * 60 * 1000).toISOString(),
        reason: null,
      }),
    ).rejects.toThrow(/revision/i);

    // Re-projecting the same group after snoozing must not silently overwrite
    // the snoozed pending decision either.
    await expect(
      harness.workspaceService.projectGroupedManualAnswer(projectCommand()),
    ).rejects.toThrow(/never silently overwrites/i);

    const state = await harness.repository.getIntelligenceState();
    expect(state.groupedDecisions).toHaveLength(1);
    expect(state.groupedDecisions[0]!.expectedRevision).toBe(
      decision.expectedRevision + 1,
    );
    const requests = await harness.repository.listUserActionRequests();
    expect(requests.every((request) => request.state === "pending")).toBe(true);
    expect(await harness.repository.listApplicationAnswerRecords()).toEqual([]);
  });

  test("approve then per-job resume boundary: members resume only through the verifying resumer", async () => {
    const seed = createSeed();
    seedGroupedRequests({
      seed,
      replayCheckpointIdA: "checkpoint_a",
      replayCheckpointIdB: "checkpoint_b",
    });
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "run_grouped",
        mode: "copilot",
        state: "paused_for_user_review",
        jobIds: ["job_ready", "job_generating"],
        currentJobId: "job_ready",
        createdAt: now,
        updatedAt: now,
        summary: "Prepared safely",
        detail: "Final submission remains disabled.",
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "result_a",
        runId: "run_grouped",
        jobId: "job_ready",
        state: "awaiting_review",
        summary: "Questions need review",
        detail: "No submission occurred.",
        startedAt: now,
        updatedAt: now,
        latestCheckpointId: "checkpoint_a",
      }),
      ApplyJobResultSchema.parse({
        id: "result_b",
        runId: "run_grouped",
        jobId: "job_generating",
        state: "awaiting_review",
        summary: "Questions need review",
        detail: "No submission occurred.",
        startedAt: now,
        updatedAt: now,
        latestCheckpointId: "checkpoint_b",
      }),
    ];
    seed.applicationReplayCheckpoints = [
      ApplicationReplayCheckpointSchema.parse({
        id: "checkpoint_a",
        runId: "run_grouped",
        jobId: "job_ready",
        resultId: "result_a",
        createdAt: now,
        label: "Review questions",
        detail: null,
        url: null,
      }),
      ApplicationReplayCheckpointSchema.parse({
        id: "checkpoint_b",
        runId: "run_grouped",
        jobId: "job_generating",
        resultId: "result_b",
        createdAt: now,
        label: "Review questions",
        detail: null,
        url: null,
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });

    const decision = await projectAndReadDecision(harness);
    const applied = await harness.workspaceService.applyGroupedManualAnswer(
      applyCommand(decision),
    );

    // The grouped apply persisted the exact lineage atomically: the decision
    // is approved and both revision-1 answers exist in the same commit.
    expect(applied.intelligence.groupedDecisions[0]!.approval).toBe("approved");
    const answers = await harness.repository.listApplicationAnswerRecords();
    expect(answers).toHaveLength(2);
    for (const answer of answers) {
      expect(answer).toEqual(
        expect.objectContaining({
          revision: 1,
          supersedesAnswerId: null,
          status: "suggested",
          submittedAt: null,
        }),
      );
    }

    // The snapshot resumed each member separately per job through the
    // existing verifying user-action resumer. Both prerequisites are missing
    // an approved resume, so each job stops safely with its own attempt.
    const attempts = await harness.repository.listApplicationAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.jobId).sort()).toEqual([
      "job_generating",
      "job_ready",
    ]);
    expect(attempts.map((attempt) => attempt.id).sort()).toEqual([
      "application_user_action_resume_request_a_r3",
      "application_user_action_resume_request_b_r3",
    ]);
    for (const attempt of attempts) {
      expect(attempt.state).toBe("unsupported");
      expect(attempt.completedAt).not.toBeNull();
      expect(attempt.userActionResumption?.requestId).toBeTruthy();
    }

    const requests = await harness.repository.listUserActionRequests();
    const byId = new Map(requests.map((request) => [request.id, request]));
    expect(byId.get("request_a")).toEqual(
      expect.objectContaining({ state: "still_blocked", revision: 3 }),
    );
    expect(byId.get("request_b")).toEqual(
      expect.objectContaining({ state: "still_blocked", revision: 3 }),
    );

    // No submission or resolution ever happens.
    for (const result of await harness.repository.listApplyJobResults()) {
      expect(result.state).not.toBe("submitted");
    }
    expect(
      (await harness.repository.listApplicationAttempts()).some(
        (attempt) => attempt.outcome !== null,
      ),
    ).toBe(false);
  });

  test("persists only the root-containing cluster; unrelated question meanings never inherit the answer", async () => {
    const seed = createSeed();
    seed.userActionRequests = [
      createManualAnswerRequest({
        id: "request_a",
        jobId: "job_ready",
        resultId: "result_a",
      }),
      createManualAnswerRequest({
        id: "request_b",
        jobId: "job_generating",
        resultId: "result_b",
      }),
      createManualAnswerRequest({
        id: "request_c",
        jobId: "job_c",
        resultId: "result_c",
      }),
      createManualAnswerRequest({
        id: "request_d",
        jobId: "job_d",
        resultId: "result_d",
      }),
    ];
    seed.applicationQuestionRecords = [
      createQuestion({
        id: "question_a",
        jobId: "job_ready",
        resultId: "result_a",
        prompt: "Years of experience",
      }),
      createQuestion({
        id: "question_b",
        jobId: "job_generating",
        resultId: "result_b",
        prompt: "Years of experience",
      }),
      createQuestion({
        id: "question_c",
        jobId: "job_c",
        resultId: "result_c",
        prompt: "Desired salary",
        kind: "salary_expectation",
      }),
      createQuestion({
        id: "question_d",
        jobId: "job_d",
        resultId: "result_d",
        prompt: "Desired salary",
        kind: "salary_expectation",
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });

    const snapshot =
      await harness.workspaceService.projectGroupedManualAnswer(
        projectCommand(),
      );

    // Two compatible clusters exist, but only the decision rooted in the
    // command request is persisted; the unrelated meaning is not projected.
    expect(snapshot.intelligence.groupedDecisions).toHaveLength(1);
    const decision = snapshot.intelligence.groupedDecisions[0]!;
    expect(decision.lineage.map((entry) => entry.requestId).sort()).toEqual([
      "request_a",
      "request_b",
    ]);
    expect(decision.questionId).toBe("question_a");
    expect(decision.answer).toEqual({ type: "text", value: "5 years" });

    const persisted = (await harness.repository.getIntelligenceState())
      .groupedDecisions;
    expect(persisted).toHaveLength(1);
    expect(
      persisted[0]!.lineage.some(
        (entry) =>
          entry.requestId === "request_c" || entry.requestId === "request_d",
      ),
    ).toBe(false);

    // Projection never creates answer records, so the unrelated meaning
    // cannot silently inherit the supplied answer either.
    expect(await harness.repository.listApplicationAnswerRecords()).toEqual([]);
    const requests = await harness.repository.listUserActionRequests();
    const byId = new Map(requests.map((request) => [request.id, request]));
    for (const id of ["request_a", "request_b", "request_c", "request_d"]) {
      expect(byId.get(id)).toEqual(
        expect.objectContaining({ state: "pending", revision: 1 }),
      );
    }

    // Applying the root decision still only touches the root cluster's
    // questions; the unrelated meaning is never answered.
    await harness.workspaceService.applyGroupedManualAnswer(
      applyCommand(decision),
    );
    const answers = await harness.repository.listApplicationAnswerRecords();
    expect(answers).toHaveLength(2);
    expect(new Set(answers.map((answer) => answer.questionId))).toEqual(
      new Set(["question_a", "question_b"]),
    );
    const afterById = new Map(
      (await harness.repository.listUserActionRequests()).map((request) => [
        request.id,
        request,
      ]),
    );
    expect(afterById.get("request_c")).toEqual(
      expect.objectContaining({ state: "pending", revision: 1 }),
    );
    expect(afterById.get("request_d")).toEqual(
      expect.objectContaining({ state: "pending", revision: 1 }),
    );
  });

  test("a grouped verifying transition is never mistaken for the caller's single manual-answer command", async () => {
    const seed = createSeed();
    seedGroupedRequests({ seed });
    const harness = createWorkspaceServiceHarness({ seed });

    const decision = await projectAndReadDecision(harness);
    await harness.workspaceService.applyGroupedManualAnswer(
      applyCommand(decision),
    );

    // The grouped apply moved request_a to verifying at revision 2 through its
    // deterministic grouped event id, never the caller's command id.
    const requests = await harness.repository.listUserActionRequests();
    const byId = new Map(requests.map((request) => [request.id, request]));
    expect(byId.get("request_a")).toEqual(
      expect.objectContaining({ state: "verifying", revision: 2 }),
    );
    const before = await harness.repository.listApplicationAnswerRecords();
    expect(before).toHaveLength(2);

    // The caller retries their single manual answer against the pre-grouped
    // revision. The reducer is stale and the verifying state matches the
    // expected resulting revision, but the only persisted submit event is the
    // grouped one, so no manual-answer record may be created.
    await harness.workspaceService.performUserAction({
      action: "submit_manual_answer",
      requestId: "request_a",
      commandId: "single_command_a",
      expectedRevision: 1,
      answer: "5 years",
      saveForFuture: false,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(await harness.repository.listApplicationAnswerRecords()).toEqual(
      before,
    );
    expect(
      (await harness.repository.listApplicationAnswerRecords()).filter(
        (answer) => answer.id.startsWith("manual_answer_"),
      ),
    ).toEqual([]);

    // Prepare-only safety is preserved: members stay verifying (never
    // resolved), questions select their approved answers, and nothing was
    // submitted.
    const afterById = new Map(
      (await harness.repository.listUserActionRequests()).map((request) => [
        request.id,
        request,
      ]),
    );
    expect(afterById.get("request_a")).toEqual(
      expect.objectContaining({ state: "verifying", revision: 2 }),
    );
    expect(afterById.get("request_b")).toEqual(
      expect.objectContaining({ state: "verifying", revision: 2 }),
    );
    for (const question of await harness.repository.listApplicationQuestionRecords()) {
      expect(question.status).toBe("answered");
      expect(question.selectedAnswerId).not.toBeNull();
      expect(question.submittedAnswer).toBe("5 years");
    }
    for (const answer of await harness.repository.listApplicationAnswerRecords()) {
      expect(answer.status).toBe("suggested");
      expect(answer.submittedAt).toBeNull();
    }
    expect(
      (await harness.repository.listApplicationAttempts()).some(
        (attempt) => attempt.outcome !== null,
      ),
    ).toBe(false);
  });
});
