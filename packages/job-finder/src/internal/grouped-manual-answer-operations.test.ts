import { describe, expect, test } from "vitest";
import {
  ApplicationAnswerRecordSchema,
  ApplicationAttemptQuestionSchema,
  ApplyGroupedManualAnswerInputSchema,
  GroupedManualAnswerDecisionSchema,
  UserActionRequestSchema,
  type ApplicationAnswerRecord,
  type ApplicationAnswerValue,
  type ApplicationAttemptQuestion,
  type ApplicationQuestionControlType,
  type ApplicationQuestionKind,
  type ApplyGroupedManualAnswerInput,
  type GroupedManualAnswerDecision,
  type SnoozeGroupedDecisionInput,
  type UserActionRequest,
  type UserActionRequestKind,
  type UserActionScope,
  type UserActionVerificationStrategy,
} from "@nestor/contracts";

import {
  approveGroupedManualAnswer,
  buildAnswerPolicyFingerprint,
  buildQuestionMeaningFingerprint,
  deriveVisibleGroupedManualAnswerDecisions,
  projectGroupedManualAnswerDecisions,
  snoozeGroupedDecision,
  type GroupedManualAnswerRequestContext,
  type ProjectGroupedManualAnswerDecisionsInput,
} from "./grouped-manual-answer-operations";

const now = "2026-08-15T10:00:00.000Z";
const later = "2026-08-15T11:00:00.000Z";

function createQuestion(input: {
  id: string;
  prompt: string;
  kind?: ApplicationQuestionKind;
  controlType?: ApplicationQuestionControlType;
}): ApplicationAttemptQuestion {
  return ApplicationAttemptQuestionSchema.parse({
    id: input.id,
    prompt: input.prompt,
    kind: input.kind ?? "other",
    answerControlType: input.controlType ?? "text",
    isRequired: true,
    detectedAt: now,
    answerOptions: [],
    suggestedAnswers: [],
    submittedAnswer: null,
    status: "detected",
  });
}

function createRequest(input: {
  id: string;
  jobId: string;
  revision?: number;
  state?: "pending" | "page_opened" | "verifying";
  kind?: UserActionRequestKind;
  scope?: UserActionScope;
  verification?: UserActionVerificationStrategy;
}): UserActionRequest {
  return UserActionRequestSchema.parse({
    id: input.id,
    dedupeKey: `dedupe_${input.id}`,
    revision: input.revision ?? 1,
    kind: input.kind ?? "manual_answer",
    state: input.state ?? "pending",
    requirement: "required",
    scope: input.scope ?? {
      type: "application",
      runId: "run_1",
      jobId: input.jobId,
      resultId: `result_${input.jobId}`,
      replayCheckpointId: null,
      source: "target_site",
    },
    verification: input.verification ?? {
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

function createContext(input: {
  question: ApplicationAttemptQuestion;
  applicationRecordId?: string;
  questionRevision?: number;
  answerRevision?: number;
}): GroupedManualAnswerRequestContext {
  return {
    question: input.question,
    applicationRecordId: input.applicationRecordId ?? "application_1",
    questionRevision: input.questionRevision ?? 1,
    answerRevision: input.answerRevision ?? 0,
  };
}

function createSavedAnswer(input: {
  id: string;
  questionId: string;
  text: string;
  value?: ApplicationAnswerValue | null;
  status?: ApplicationAnswerRecord["status"];
}): ApplicationAnswerRecord {
  return ApplicationAnswerRecordSchema.parse({
    id: input.id,
    runId: "run_1",
    jobId: "job_a",
    resultId: null,
    questionId: input.questionId,
    status: input.status ?? "filled",
    text: input.text,
    value: input.value ?? null,
    revision: 1,
    saveScope: "reusable_profile",
    supersedesAnswerId: null,
    sourceKind: "user",
    sourceId: null,
    confidenceLabel: null,
    provenance: [],
    createdAt: now,
    submittedAt: null,
  });
}

function createPair(
  overrides: {
    prompt?: string;
    kind?: ApplicationQuestionKind;
    controlType?: ApplicationQuestionControlType;
  } = {},
): {
  requestA: UserActionRequest;
  requestB: UserActionRequest;
  question: ApplicationAttemptQuestion;
  contexts: Map<string, GroupedManualAnswerRequestContext>;
} {
  const prompt = overrides.prompt ?? "Years of experience";
  const requestA = createRequest({ id: "request_a", jobId: "job_a" });
  const requestB = createRequest({ id: "request_b", jobId: "job_b" });
  const question = createQuestion({
    id: "question_years",
    prompt,
    kind: overrides.kind ?? "experience",
    controlType: overrides.controlType ?? "text",
  });
  return {
    requestA,
    requestB,
    question,
    contexts: new Map([
      [
        "request_a",
        createContext({ question, applicationRecordId: "application_a" }),
      ],
      [
        "request_b",
        createContext({ question, applicationRecordId: "application_b" }),
      ],
    ]),
  };
}

function project(
  input: Partial<ProjectGroupedManualAnswerDecisionsInput> & {
    requests: readonly UserActionRequest[];
    contexts?: ReadonlyMap<string, GroupedManualAnswerRequestContext>;
  },
) {
  return projectGroupedManualAnswerDecisions({
    groupKey: input.groupKey ?? "group_1",
    requests: input.requests,
    contexts:
      input.contexts ??
      new Map(
        input.requests.map((request) => [
          request.id,
          createContext({
            question: createQuestion({
              id: `question_${request.id}`,
              prompt: "Years of experience",
            }),
            applicationRecordId: `application_${
              request.scope.type === "application"
                ? request.scope.jobId
                : request.id
            }`,
          }),
        ]),
      ),
    savedAnswers: input.savedAnswers ?? [],
    savedAnswerQuestions: input.savedAnswerQuestions ?? new Map(),
    answerText: input.answerText ?? "5 years",
    saveScope: input.saveScope ?? "reusable_profile",
    occurredAt: input.occurredAt ?? now,
  });
}

function buildAppliedDecision(): {
  decision: GroupedManualAnswerDecision;
  requestA: UserActionRequest;
  requestB: UserActionRequest;
} {
  const { requestA, requestB, contexts } = createPair();
  const result = project({ requests: [requestA, requestB], contexts });
  const decision = result.decisions[0]!;
  return { decision, requestA, requestB };
}

function approveCommand(
  decision: GroupedManualAnswerDecision,
  overrides: Partial<ApplyGroupedManualAnswerInput> = {},
): ApplyGroupedManualAnswerInput {
  return {
    decisionId: decision.id,
    requestIds: decision.lineage.map((entry) => entry.requestId),
    expectedRequestRevisions: Object.fromEntries(
      decision.lineage.map((entry) => [
        entry.requestId,
        entry.expectedRequestRevision,
      ]),
    ),
    answer: { type: "text", value: "5 years" },
    ...overrides,
  };
}

function approve(
  decision: GroupedManualAnswerDecision,
  overrides: {
    command?: Partial<ApplyGroupedManualAnswerInput>;
    requests?: ReadonlyMap<string, UserActionRequest>;
    callerId?: string;
    occurredAt?: string;
  } = {},
) {
  const requests =
    overrides.requests ??
    new Map(
      decision.lineage.map((entry) => [
        entry.requestId,
        createRequest({
          id: entry.requestId,
          jobId: entry.jobId,
          revision: entry.expectedRequestRevision,
        }),
      ]),
    );
  return approveGroupedManualAnswer({
    decision,
    command: approveCommand(decision, overrides.command),
    requests,
    callerId: overrides.callerId ?? "caller_alex",
    occurredAt: overrides.occurredAt ?? later,
  });
}

function snoozeCommand(
  decision: GroupedManualAnswerDecision,
  overrides: Partial<SnoozeGroupedDecisionInput> = {},
): SnoozeGroupedDecisionInput {
  return {
    decisionId: decision.id,
    expectedRevision: decision.expectedRevision,
    until: later,
    reason: null,
    ...overrides,
  };
}

function createDecision(overrides: Record<string, unknown> = {}) {
  return GroupedManualAnswerDecisionSchema.parse({
    id: "decision_1",
    groupKey: "group_1",
    requestId: "request_a",
    applicationRecordId: "application_a",
    jobId: "job_a",
    questionId: "question_years",
    expectedRevision: 1,
    expectedQuestionRevision: 1,
    expectedAnswerRevision: 0,
    fingerprints: {
      questionMeaning: "a".repeat(64),
      answerPolicy: "b".repeat(64),
    },
    answer: { type: "text", value: "5 years" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe("buildQuestionMeaningFingerprint", () => {
  test("is a deterministic SHA-256 fingerprint", () => {
    const fingerprint = buildQuestionMeaningFingerprint("years of experience");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(buildQuestionMeaningFingerprint("years of experience")).toBe(
      fingerprint,
    );
    expect(buildQuestionMeaningFingerprint("years of experience 2")).not.toBe(
      fingerprint,
    );
  });
});

describe("buildAnswerPolicyFingerprint", () => {
  test("fingerprints meaning, kind, control type, and save policy", () => {
    const base = {
      meaning: "years of experience",
      kind: "experience" as const,
      controlType: "text" as const,
      saveScope: "reusable_profile" as const,
    };
    const fingerprint = buildAnswerPolicyFingerprint(base);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(buildAnswerPolicyFingerprint(base)).toBe(fingerprint);
    expect(
      buildAnswerPolicyFingerprint({ ...base, meaning: "other meaning" }),
    ).not.toBe(fingerprint);
    expect(
      buildAnswerPolicyFingerprint({ ...base, kind: "salary_expectation" }),
    ).not.toBe(fingerprint);
    expect(
      buildAnswerPolicyFingerprint({ ...base, controlType: "single_choice" }),
    ).not.toBe(fingerprint);
    expect(
      buildAnswerPolicyFingerprint({ ...base, saveScope: "application_once" }),
    ).not.toBe(fingerprint);
  });
});

describe("projectGroupedManualAnswerDecisions", () => {
  test("projects compatible pending manual answers into one durable decision", () => {
    const { requestA, requestB, contexts } = createPair();
    const result = project({ requests: [requestA, requestB], contexts });

    expect(result.skippedRequestCount).toBe(0);
    expect(result.decisions).toHaveLength(1);
    const decision = result.decisions[0]!;
    expect(GroupedManualAnswerDecisionSchema.safeParse(decision).success).toBe(
      true,
    );
    expect(decision.id).toMatch(/^group_1:/);
    expect(decision.groupKey).toBe("group_1");
    expect(decision.kind).toBe("manual_answer");
    expect(decision.blockerKind).toBe("manual_answer");
    expect(decision.authority).toBe("manual_answer");
    expect(decision.reuseScope).toBe("reusable");
    expect(decision.requestId).toBe("request_a");
    expect(decision.applicationRecordId).toBe("application_a");
    expect(decision.jobId).toBe("job_a");
    expect(decision.questionId).toBe("question_years");
    expect(decision.expectedRevision).toBe(1);
    expect(decision.expectedQuestionRevision).toBe(1);
    expect(decision.expectedAnswerRevision).toBe(0);
    expect(decision.fingerprints.questionMeaning).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.fingerprints.answerPolicy).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.answer).toEqual({ type: "text", value: "5 years" });
    expect(decision.approval).toBe("pending");
    expect(decision.approvedAt).toBeNull();
    expect(decision.conflict.status).toBe("none");
    expect(decision.snooze).toBeNull();
    expect(decision.createdAt).toBe(now);
    expect(decision.updatedAt).toBe(now);

    expect(decision.lineage).toHaveLength(2);
    const byRequestId = new Map(
      decision.lineage.map((entry) => [entry.requestId, entry]),
    );
    expect(byRequestId.get("request_a")).toEqual(
      expect.objectContaining({
        jobId: "job_a",
        applicationRecordId: "application_a",
        questionId: "question_years",
        expectedRequestRevision: 1,
        expectedQuestionRevision: 1,
        expectedAnswerRevision: 0,
        appliedAt: null,
      }),
    );
    expect(byRequestId.get("request_b")).toEqual(
      expect.objectContaining({
        jobId: "job_b",
        applicationRecordId: "application_b",
        expectedRequestRevision: 1,
      }),
    );
    expect(result.groupedRequestCount).toBe(2);
    expect(result.groupedJobCount).toBe(2);
  });

  test("captures exact request, question, and answer revisions per member", () => {
    const { requestA, question } = createPair();
    const requestBAtRevision = createRequest({
      id: "request_b",
      jobId: "job_b",
      revision: 3,
    });
    const result = project({
      requests: [requestA, requestBAtRevision],
      contexts: new Map([
        [
          "request_a",
          createContext({ question, applicationRecordId: "application_a" }),
        ],
        [
          "request_b",
          createContext({
            question,
            applicationRecordId: "application_b",
            questionRevision: 5,
            answerRevision: 2,
          }),
        ],
      ]),
    });

    const decision = result.decisions[0]!;
    const entryB = decision.lineage.find(
      (entry) => entry.requestId === "request_b",
    )!;
    expect(entryB.expectedRequestRevision).toBe(3);
    expect(entryB.expectedQuestionRevision).toBe(5);
    expect(entryB.expectedAnswerRevision).toBe(2);
    expect(decision.expectedQuestionRevision).toBe(1);
    expect(decision.expectedAnswerRevision).toBe(0);
  });

  test("normalizes case and punctuation before fingerprinting", () => {
    const { requestA, requestB } = createPair();
    const questionA = createQuestion({
      id: "q_a",
      prompt: "Years of Experience?",
      kind: "experience",
    });
    const questionB = createQuestion({
      id: "q_b",
      prompt: "years  of   experience",
      kind: "experience",
    });
    const result = project({
      requests: [requestA, requestB],
      contexts: new Map([
        [
          "request_a",
          createContext({ question: questionA, applicationRecordId: "a" }),
        ],
        [
          "request_b",
          createContext({ question: questionB, applicationRecordId: "b" }),
        ],
      ]),
    });
    expect(result.decisions).toHaveLength(1);
  });

  test("does not pretend incompatible singleton meanings form a group", () => {
    const { requestA, requestB } = createPair();
    const questionA = createQuestion({
      id: "q_a",
      prompt: "Years of experience",
      kind: "experience",
    });
    const questionB = createQuestion({
      id: "q_b",
      prompt: "Notice period",
      kind: "notice_period",
    });
    const result = project({
      requests: [requestA, requestB],
      contexts: new Map([
        [
          "request_a",
          createContext({ question: questionA, applicationRecordId: "a" }),
        ],
        [
          "request_b",
          createContext({ question: questionB, applicationRecordId: "b" }),
        ],
      ]),
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.groupedRequestCount).toBe(0);
    expect(result.skippedRequestCount).toBe(2);
  });

  test("does not group incompatible kinds or control types", () => {
    const { requestA, requestB, question } = createPair();
    const otherQuestion = createQuestion({
      id: "question_salary",
      prompt: "Years of experience",
      kind: "salary_expectation",
      controlType: "single_choice",
    });
    const result = project({
      requests: [requestA, requestB],
      contexts: new Map([
        ["request_a", createContext({ question, applicationRecordId: "a" })],
        [
          "request_b",
          createContext({ question: otherQuestion, applicationRecordId: "b" }),
        ],
      ]),
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.skippedRequestCount).toBe(2);
  });

  test("groups compatible questions across runs while preserving lineage", () => {
    const { requestA, contexts } = createPair();
    const otherRunRequest = createRequest({
      id: "request_b",
      jobId: "job_b",
      scope: {
        type: "application",
        runId: "run_2",
        jobId: "job_b",
        applicationRecordId: "application_b",
        resultId: "result_job_b",
        replayCheckpointId: null,
        source: "target_site",
      },
    });
    const result = project({
      requests: [requestA, otherRunRequest],
      contexts,
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.lineage.map((entry) => entry.jobId)).toEqual([
      "job_a",
      "job_b",
    ]);
  });

  const forbiddenKinds: UserActionRequestKind[] = [
    "login",
    "signup",
    "mfa",
    "email_verification",
    "captcha",
    "existing_account_choice",
    "legal_consent",
    "external_redirect",
    "manual_upload",
    "other",
  ];
  test.each(forbiddenKinds)("never groups %s user actions", (kind) => {
    const request = createRequest({ id: "request_x", jobId: "job_x", kind });
    const result = project({ requests: [request] });
    expect(result.decisions).toEqual([]);
    expect(result.skippedRequestCount).toBe(1);
  });

  test("never groups non-application scopes", () => {
    const request = createRequest({
      id: "request_scope",
      jobId: "job_x",
      scope: {
        type: "discovery_source",
        targetId: "source_1",
        source: "target_site",
        sourceDebugRunId: null,
        sourceDebugAttemptId: null,
      },
    });
    const result = project({ requests: [request] });
    expect(result.decisions).toEqual([]);
    expect(result.skippedRequestCount).toBe(1);
  });

  test("never groups requests that already moved past the action", () => {
    const request = createRequest({
      id: "request_stale",
      jobId: "job_x",
      state: "verifying",
    });
    const result = project({ requests: [request] });
    expect(result.decisions).toEqual([]);
    expect(result.skippedRequestCount).toBe(1);
  });

  test("never groups non-page-blocker-absent verification", () => {
    const request = createRequest({
      id: "request_verify",
      jobId: "job_x",
      verification: {
        type: "source_access",
        targetId: null,
        blockerFingerprint: "blocker",
        expectedOrigin: null,
      },
    });
    const result = project({ requests: [request] });
    expect(result.decisions).toEqual([]);
    expect(result.skippedRequestCount).toBe(1);
  });

  test("never groups file-upload controls", () => {
    const { requestA, requestB } = createPair();
    const uploadQuestion = createQuestion({
      id: "q_upload",
      prompt: "Upload your CV",
      kind: "resume",
      controlType: "file",
    });
    const result = project({
      requests: [requestA, requestB],
      contexts: new Map([
        [
          "request_a",
          createContext({ question: uploadQuestion, applicationRecordId: "a" }),
        ],
        [
          "request_b",
          createContext({ question: uploadQuestion, applicationRecordId: "b" }),
        ],
      ]),
    });
    expect(result.decisions).toEqual([]);
    expect(result.skippedRequestCount).toBe(2);
  });

  test("skips clusters with fewer than two members", () => {
    const request = createRequest({ id: "request_solo", jobId: "job_solo" });
    const result = project({ requests: [request] });
    expect(result.decisions).toEqual([]);
    expect(result.skippedRequestCount).toBe(1);
    expect(result.skippedJobCount).toBe(1);
  });

  test("conflicting saved answers block grouping", () => {
    const { requestA, requestB, question, contexts } = createPair();
    const savedA = createSavedAnswer({
      id: "saved_1",
      questionId: "question_years",
      text: "5 years",
    });
    const savedB = createSavedAnswer({
      id: "saved_2",
      questionId: "question_years",
      text: "7 years",
    });
    const result = project({
      requests: [requestA, requestB],
      contexts,
      savedAnswers: [savedA, savedB],
      savedAnswerQuestions: new Map([["question_years", question]]),
      answerText: "5 years",
    });
    expect(result.decisions).toEqual([]);
    expect(result.contradictionEvidence).toHaveLength(1);
    const contradiction = result.contradictionEvidence[0]!;
    expect(contradiction.detectionId).toMatch(
      /^grouped_answer_contradiction_[a-f0-9]{32}$/,
    );
    expect(contradiction).toEqual(
      expect.objectContaining({
        answerA: "7 years",
        answerB: "5 years",
        contradictionScore: 1,
        detectedAt: now,
      }),
    );
    expect(contradiction.questionA).not.toBe(contradiction.questionB);
    expect(result.skippedRequestCount).toBe(2);
    expect(result.groupedRequestCount).toBe(0);
  });

  test("non-text saved answers conflict with text reuse", () => {
    const { requestA, requestB, question, contexts } = createPair();
    const saved = createSavedAnswer({
      id: "saved_asset",
      questionId: "question_years",
      text: "portfolio.pdf",
      value: { type: "asset_ref", assetId: "asset_portfolio" },
    });
    const result = project({
      requests: [requestA, requestB],
      contexts,
      savedAnswers: [saved],
      savedAnswerQuestions: new Map([["question_years", question]]),
    });
    expect(result.decisions).toEqual([]);
    expect(result.skippedRequestCount).toBe(2);
  });

  test("matching saved answers do not block grouping", () => {
    const { requestA, requestB, question, contexts } = createPair();
    const saved = createSavedAnswer({
      id: "saved_1",
      questionId: "question_years",
      text: "5 years",
    });
    const result = project({
      requests: [requestA, requestB],
      contexts,
      savedAnswers: [saved],
      savedAnswerQuestions: new Map([["question_years", question]]),
      answerText: "5 years",
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.skippedRequestCount).toBe(0);
  });

  test("throws on invalid caller input", () => {
    const { requestA, requestB, contexts } = createPair();
    expect(() =>
      project({
        requests: [requestA, requestB],
        contexts,
        occurredAt: "not-a-date",
      }),
    ).toThrow();
    expect(() =>
      project({ requests: [requestA, requestB], contexts, answerText: "  " }),
    ).toThrow();
  });
});

describe("approveGroupedManualAnswer", () => {
  test("approves atomically and stamps decision, lineage, and requests", () => {
    const { decision, requestA, requestB } = buildAppliedDecision();
    const result = approve(decision);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      GroupedManualAnswerDecisionSchema.safeParse(result.decision).success,
    ).toBe(true);
    expect(result.decision.approval).toBe("approved");
    expect(result.decision.approvedAt).toBe(later);
    expect(result.decision.updatedAt).toBe(later);
    expect(result.decision.answer).toEqual({ type: "text", value: "5 years" });
    expect(result.decision.expectedRevision).toBe(2);
    expect(result.decision.snooze).toBeNull();

    expect(result.lineage).toHaveLength(2);
    for (const entry of result.lineage) {
      expect(entry.appliedAt).toBe(later);
      expect(entry.answerRecordId).toBeNull();
      expect(entry.expectedRequestRevision).toBe(1);
    }

    expect(result.requests).toHaveLength(2);
    const updatedById = new Map(
      result.requests.map((request) => [request.id, request]),
    );
    expect(updatedById.get(requestA.id)).toEqual(
      expect.objectContaining({
        state: "verifying",
        revision: 2,
        updatedAt: later,
      }),
    );
    expect(updatedById.get(requestB.id)).toEqual(
      expect.objectContaining({ state: "verifying", revision: 2 }),
    );
    expect(result.requestCount).toBe(2);
    expect(result.jobCount).toBe(2);
  });

  test("validates every request id before changing anything", () => {
    const { decision } = buildAppliedDecision();
    const missingMember = approve(decision, {
      command: { requestIds: ["request_a", "request_extra"] },
    });
    expect(missingMember.ok).toBe(false);
    if (missingMember.ok) return;
    expect(missingMember.failure.code).toBe("invalid_input");

    const extraMember = approve(decision, {
      command: {
        requestIds: ["request_a", "request_b", "request_extra"],
      },
    });
    expect(extraMember.ok).toBe(false);
    if (extraMember.ok) return;
    expect(extraMember.failure.code).toBe("invalid_input");
  });

  test("validates every expected request revision before applying", () => {
    const { decision } = buildAppliedDecision();
    const result = approve(decision, {
      command: {
        expectedRequestRevisions: { request_a: 1, request_b: 99 },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("request_revision_mismatch");
    if (result.failure.code !== "request_revision_mismatch") return;
    expect(result.failure.requestId).toBe("request_b");
    expect(result.failure.expectedRevision).toBe(1);
    expect(result.failure.currentRevision).toBe(99);
  });

  test("a stale member request aborts the whole group", () => {
    const { decision, requestA, requestB } = buildAppliedDecision();
    const staleA = createRequest({
      id: requestA.id,
      jobId: "job_a",
      revision: requestA.revision + 1,
    });
    const result = approve(decision, {
      requests: new Map([
        [requestA.id, staleA],
        [requestB.id, requestB],
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("stale_request");
    if (result.failure.code !== "stale_request") return;
    expect(result.failure.requestId).toBe("request_a");
    expect(result.failure.expectedRevision).toBe(1);
    expect(result.failure.currentRevision).toBe(2);
  });

  test("a missing member request aborts the whole group", () => {
    const { decision, requestB } = buildAppliedDecision();
    const result = approve(decision, {
      requests: new Map([[requestB.id, requestB]]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("stale_request");
    if (result.failure.code !== "stale_request") return;
    expect(result.failure.requestId).toBe("request_a");
    expect(result.failure.currentRevision).toBeNull();
  });

  test("a member that changed kind or scope aborts the whole group", () => {
    const { decision, requestA, requestB } = buildAppliedDecision();
    const changed = createRequest({
      id: requestA.id,
      jobId: "job_a",
      kind: "login",
    });
    const result = approve(decision, {
      requests: new Map([
        [requestA.id, changed],
        [requestB.id, requestB],
      ]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("stale_request");
  });

  test("only pending decisions can be approved", () => {
    const { decision } = buildAppliedDecision();
    const approved = createDecision({
      ...decision,
      approval: "approved",
      approvedAt: now,
    });
    const result = approve(approved);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("decision_not_pending");
  });

  test("rejects invalid decisions and invalid commands", () => {
    const { decision } = buildAppliedDecision();
    const invalidDecision = approveGroupedManualAnswer({
      decision: {
        ...decision,
        approval: "snoozed",
      } as unknown as GroupedManualAnswerDecision,
      command: approveCommand(decision),
      requests: new Map(),
      callerId: "caller_alex",
      occurredAt: later,
    });
    expect(invalidDecision.ok).toBe(false);
    if (invalidDecision.ok) return;
    expect(invalidDecision.failure.code).toBe("invalid_decision");

    const invalidCommand = approve(decision, {
      command: {
        expectedRequestRevisions: { request_a: "nope" as unknown as number },
      },
    });
    expect(invalidCommand.ok).toBe(false);
    if (invalidCommand.ok) return;
    expect(invalidCommand.failure.code).toBe("invalid_input");
  });

  test("only accepts text answers (asset references are rejected)", () => {
    const { decision } = buildAppliedDecision();
    expect(
      ApplyGroupedManualAnswerInputSchema.safeParse({
        decisionId: decision.id,
        requestIds: ["request_a", "request_b"],
        expectedRequestRevisions: { request_a: 1, request_b: 1 },
        answer: { type: "asset_ref", assetId: "asset_portfolio" },
      }).success,
    ).toBe(false);

    const result = approve(decision, {
      command: {
        answer: {
          type: "asset_ref",
          assetId: "asset_portfolio",
        } as unknown as ApplyGroupedManualAnswerInput["answer"],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_input");
  });

  test("requires a caller id and timestamp", () => {
    const { decision } = buildAppliedDecision();
    const noCaller = approve(decision, { callerId: "  " });
    expect(noCaller.ok).toBe(false);
    if (noCaller.ok) return;
    expect(noCaller.failure.code).toBe("invalid_input");

    const noTime = approve(decision, { occurredAt: "not-a-date" });
    expect(noTime.ok).toBe(false);
    if (noTime.ok) return;
    expect(noTime.failure.code).toBe("invalid_input");
  });
});

describe("snoozeGroupedDecision", () => {
  test("snoozes a pending decision with a future time and CAS revision", () => {
    const { decision } = buildAppliedDecision();
    const result = snoozeGroupedDecision({
      decision,
      command: snoozeCommand(decision, { reason: "Ask the recruiter" }),
      occurredAt: now,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      GroupedManualAnswerDecisionSchema.safeParse(result.decision).success,
    ).toBe(true);
    expect(result.decision.approval).toBe("pending");
    expect(result.decision.snooze).toEqual({
      until: later,
      reason: "Ask the recruiter",
    });
    expect(result.decision.expectedRevision).toBe(2);
    expect(result.decision.updatedAt).toBe(now);
  });

  test("rejects snooze times that are not strictly in the future", () => {
    const { decision } = buildAppliedDecision();
    const notFuture = snoozeGroupedDecision({
      decision,
      command: snoozeCommand(decision, { until: now }),
      occurredAt: now,
    });
    expect(notFuture.ok).toBe(false);
    if (notFuture.ok) return;
    expect(notFuture.failure.code).toBe("not_future");
  });

  test("requires the decision revision CAS", () => {
    const { decision } = buildAppliedDecision();
    const result = snoozeGroupedDecision({
      decision,
      command: snoozeCommand(decision, {
        expectedRevision: decision.expectedRevision + 1,
      }),
      occurredAt: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("revision_mismatch");
    if (result.failure.code !== "revision_mismatch") return;
    expect(result.failure.currentRevision).toBe(decision.expectedRevision);
  });

  test("only pending decisions can be snoozed", () => {
    const { decision } = buildAppliedDecision();
    const approved = createDecision({
      ...decision,
      approval: "approved",
      approvedAt: now,
    });
    const result = snoozeGroupedDecision({
      decision: approved,
      command: snoozeCommand(approved),
      occurredAt: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("decision_not_pending");
  });

  test("requires a matching decision id", () => {
    const { decision } = buildAppliedDecision();
    const result = snoozeGroupedDecision({
      decision,
      command: snoozeCommand(decision, { decisionId: "other_decision" }),
      occurredAt: now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("decision_not_found");
  });
});

describe("deriveVisibleGroupedManualAnswerDecisions", () => {
  test("excludes active snoozes, conflicts, declined, and approved decisions", () => {
    const pending = createDecision();
    const approved = createDecision({
      id: "decision_approved",
      approval: "approved",
      approvedAt: now,
    });
    const declined = createDecision({
      id: "decision_declined",
      approval: "declined",
    });
    const snoozed = createDecision({
      id: "decision_snoozed",
      snooze: { until: later },
      updatedAt: now,
    });
    const expired = createDecision({
      id: "decision_expired",
      snooze: { until: "2026-08-15T09:00:00.000Z" },
      updatedAt: now,
    });
    const conflicted = createDecision({
      id: "decision_conflicted",
      conflict: { status: "detected", detectedAt: now },
    });
    const resolved = createDecision({
      id: "decision_resolved",
      conflict: {
        status: "resolved",
        detectedAt: now,
        resolvedAt: later,
        conflictingDecisionId: "other",
        summary: "User answered in another application",
      },
    });

    const visible = deriveVisibleGroupedManualAnswerDecisions({
      decisions: [
        pending,
        approved,
        declined,
        snoozed,
        expired,
        conflicted,
        resolved,
      ],
      now,
    });

    expect(visible.map((decision) => decision.id).sort()).toEqual(
      [pending.id, expired.id, resolved.id].sort(),
    );
  });
});
