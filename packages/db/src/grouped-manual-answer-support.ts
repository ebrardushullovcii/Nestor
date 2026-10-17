import {
  ApplicationAnswerRecordSchema,
  compareApplicationAnswerRecency,
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

import type {
  CommitGroupedManualAnswerInput,
  GroupedManualAnswerCommitFailure,
} from "./grouped-manual-answer-types";

/** Deterministic event id for the single verifying transition of a grouped member. */
export function buildGroupedManualAnswerEventId(requestId: string): string {
  return `${requestId}:grouped_manual_answer`;
}

export function areSameApplicationAnswerRecords(
  left: ApplicationAnswerRecord,
  right: ApplicationAnswerRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function areSameApplicationQuestionRecords(
  left: ApplicationQuestionRecord,
  right: ApplicationQuestionRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function areSameGroupedManualAnswerDecisions(
  left: GroupedManualAnswerDecision,
  right: GroupedManualAnswerDecision,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Latest persisted answer record, including legacy revision ties.
 */
export function latestApplicationAnswerRecord(
  records: readonly ApplicationAnswerRecord[],
  questionId: string,
): ApplicationAnswerRecord | null {
  let latest: ApplicationAnswerRecord | null = null;
  for (const record of records) {
    if (record.questionId !== questionId) continue;
    if (
      latest === null ||
      compareApplicationAnswerRecency(record, latest) < 0
    ) {
      latest = record;
    }
  }
  return latest;
}

export interface GroupedManualAnswerQuestionChange {
  expected: ApplicationQuestionRecord;
  next: ApplicationQuestionRecord;
}

export interface GroupedManualAnswerAnswerChange {
  expected: ApplicationAnswerRecord | null;
  next: ApplicationAnswerRecord;
}

export interface NormalizedGroupedManualAnswerCommit {
  expectedDecision: GroupedManualAnswerDecision;
  decision: GroupedManualAnswerDecision;
  lineage: readonly GroupedDecisionJobLineage[];
  appliedAt: string;
  requestsByRequestId: ReadonlyMap<string, UserActionRequest>;
  questionChanges: readonly GroupedManualAnswerQuestionChange[];
  answerChanges: readonly GroupedManualAnswerAnswerChange[];
  expectedAnswerRevisionByQuestionId: ReadonlyMap<string, number>;
}

/**
 * Normalizes and cross-validates a grouped manual-answer commit. Everything
 * is parsed through the strict contract schemas and every cross-reference
 * (decision/lineage/requests/questions/answers) is checked before any store
 * is touched. Throws on structurally invalid input; only the repository CAS
 * can later produce a typed stale result.
 */
export function normalizeGroupedManualAnswerCommit(
  input: CommitGroupedManualAnswerInput,
): NormalizedGroupedManualAnswerCommit {
  const expectedDecision = GroupedManualAnswerDecisionSchema.parse(
    structuredClone(input.expectedDecision),
  );
  const decision = GroupedManualAnswerDecisionSchema.parse(
    structuredClone(input.decision),
  );
  const rawLineage = GroupedDecisionJobLineageSchema.array().parse(
    structuredClone([...input.lineage]),
  );
  const requests = UserActionRequestSchema.array().parse(
    structuredClone([...input.requests]),
  );
  const expectedQuestions = ApplicationQuestionRecordSchema.array().parse(
    structuredClone([...input.expectedQuestions]),
  );
  const questions = ApplicationQuestionRecordSchema.array().parse(
    structuredClone([...input.questions]),
  );
  const expectedAnswers = ApplicationAnswerRecordSchema.array().parse(
    structuredClone([...input.expectedAnswers]),
  );
  const answers = ApplicationAnswerRecordSchema.array().parse(
    structuredClone([...input.answers]),
  );

  if (decision.id !== expectedDecision.id) {
    throw new Error(
      "A grouped manual-answer commit cannot change the decision identity.",
    );
  }
  if (expectedDecision.approval !== "pending") {
    throw new Error(
      "The expected grouped decision must be the pending decision.",
    );
  }
  if (decision.approval !== "approved") {
    throw new Error(
      "A grouped manual-answer commit requires an already approved decision.",
    );
  }
  if (decision.expectedRevision !== expectedDecision.expectedRevision + 1) {
    throw new Error(
      "The approved decision must advance the expected decision revision by one.",
    );
  }
  if (JSON.stringify(decision.lineage) !== JSON.stringify(rawLineage)) {
    throw new Error(
      "The commit lineage must exactly match the approved decision lineage.",
    );
  }
  if (rawLineage.length === 0) {
    throw new Error(
      "A grouped manual-answer commit requires at least one lineage member.",
    );
  }

  const expectedLineageByRequestId = new Map(
    expectedDecision.lineage.map((entry) => [entry.requestId, entry]),
  );
  if (expectedLineageByRequestId.size !== expectedDecision.lineage.length) {
    throw new Error(
      "The pending decision lineage must have unique request ids.",
    );
  }
  if (rawLineage.length !== expectedDecision.lineage.length) {
    throw new Error(
      "The commit lineage must exactly match the pending decision lineage.",
    );
  }
  for (const entry of rawLineage) {
    const expected = expectedLineageByRequestId.get(entry.requestId);
    if (
      expected === undefined ||
      entry.jobId !== expected.jobId ||
      entry.applicationRecordId !== expected.applicationRecordId ||
      entry.resultId !== expected.resultId ||
      entry.questionId !== expected.questionId ||
      entry.answerRecordId !== expected.answerRecordId ||
      entry.expectedRequestRevision !== expected.expectedRequestRevision ||
      entry.expectedQuestionRevision !== expected.expectedQuestionRevision ||
      entry.expectedAnswerRevision !== expected.expectedAnswerRevision
    ) {
      throw new Error(
        `Lineage member "${entry.requestId}" must match the pending decision.`,
      );
    }
  }
  if (
    decision.groupKey !== expectedDecision.groupKey ||
    decision.requestId !== expectedDecision.requestId ||
    decision.applicationRecordId !== expectedDecision.applicationRecordId ||
    decision.jobId !== expectedDecision.jobId ||
    decision.resultId !== expectedDecision.resultId ||
    decision.questionId !== expectedDecision.questionId ||
    decision.expectedQuestionRevision !==
      expectedDecision.expectedQuestionRevision ||
    decision.expectedAnswerRevision !== expectedDecision.expectedAnswerRevision
  ) {
    throw new Error(
      "The approved decision cannot change the pending decision identity or captured revisions.",
    );
  }

  const appliedAt = rawLineage[0]!.appliedAt;
  if (appliedAt === null) {
    throw new Error("The commit lineage must be stamped with an applied time.");
  }
  for (const entry of rawLineage) {
    if (entry.appliedAt !== appliedAt) {
      throw new Error("All lineage members must share one applied time.");
    }
  }
  if (decision.updatedAt !== appliedAt) {
    throw new Error(
      "The approved decision and its lineage must share the applied time.",
    );
  }
  if (decision.approvedAt !== appliedAt) {
    throw new Error(
      "The approved decision and its lineage must share the approved time.",
    );
  }

  const lineageRequestIds = new Set(rawLineage.map((entry) => entry.requestId));
  if (lineageRequestIds.size !== rawLineage.length) {
    throw new Error("Lineage member request ids must be unique.");
  }
  if (requests.length !== rawLineage.length) {
    throw new Error(
      "The commit must carry exactly one verifying request per lineage member.",
    );
  }
  const requestsByRequestId = new Map<string, UserActionRequest>();
  for (const request of requests) {
    if (requestsByRequestId.has(request.id)) {
      throw new Error("Verifying request ids must be unique.");
    }
    const entry = rawLineage.find(
      (candidate) => candidate.requestId === request.id,
    );
    if (entry === undefined) {
      throw new Error(`Request "${request.id}" is not a lineage member.`);
    }
    if (request.revision !== entry.expectedRequestRevision + 1) {
      throw new Error(
        `Request "${request.id}" must advance its expected revision by one.`,
      );
    }
    if (request.state !== "verifying") {
      throw new Error(
        `Request "${request.id}" must move to verifying, never resolved.`,
      );
    }
    if (request.resolvedAt !== null) {
      throw new Error(
        `Request "${request.id}" cannot be resolved by a grouped answer commit.`,
      );
    }
    if (request.updatedAt !== appliedAt) {
      throw new Error(`Request "${request.id}" must share the applied time.`);
    }
    requestsByRequestId.set(request.id, request);
  }

  const lineageQuestionIds = [
    ...new Set(rawLineage.map((entry) => entry.questionId)),
  ];
  if (
    expectedQuestions.length !== lineageQuestionIds.length ||
    questions.length !== lineageQuestionIds.length
  ) {
    throw new Error(
      "The commit must carry one expected and one next question per affected question.",
    );
  }
  const expectedQuestionById = new Map(
    expectedQuestions.map((question) => [question.id, question]),
  );
  const questionById = new Map(
    questions.map((question) => [question.id, question]),
  );
  for (const questionId of lineageQuestionIds) {
    const expected = expectedQuestionById.get(questionId);
    const next = questionById.get(questionId);
    if (expected === undefined || next === undefined) {
      throw new Error(`The commit must carry question "${questionId}".`);
    }
    if (
      next.id !== expected.id ||
      next.runId !== expected.runId ||
      next.jobId !== expected.jobId ||
      next.resultId !== expected.resultId
    ) {
      throw new Error(
        `Question "${questionId}" cannot change its identity in a grouped commit.`,
      );
    }
    const lineageEntries = rawLineage.filter(
      (entry) => entry.questionId === questionId,
    );
    if (
      lineageEntries.some(
        (entry) =>
          entry.jobId !== expected.jobId ||
          entry.resultId !== expected.resultId,
      )
    ) {
      throw new Error(
        `Question "${questionId}" does not match its lineage identity.`,
      );
    }
  }
  const questionChanges: GroupedManualAnswerQuestionChange[] =
    lineageQuestionIds.map((questionId) => ({
      expected: expectedQuestionById.get(questionId)!,
      next: questionById.get(questionId)!,
    }));

  const expectedAnswerRevisionByQuestionId = new Map<string, number>();
  for (const entry of rawLineage) {
    const previous = expectedAnswerRevisionByQuestionId.get(entry.questionId);
    if (previous !== undefined && previous !== entry.expectedAnswerRevision) {
      throw new Error(
        `Lineage members share question "${entry.questionId}" with conflicting expected answer revisions.`,
      );
    }
    expectedAnswerRevisionByQuestionId.set(
      entry.questionId,
      entry.expectedAnswerRevision,
    );
  }
  const expectedAnswerByQuestionId = new Map<string, ApplicationAnswerRecord>();
  for (const answer of expectedAnswers) {
    if (!expectedAnswerRevisionByQuestionId.has(answer.questionId)) {
      throw new Error(
        `Expected answer for question "${answer.questionId}" is not part of the group.`,
      );
    }
    if (expectedAnswerByQuestionId.has(answer.questionId)) {
      throw new Error("Expected answers must be unique per question.");
    }
    expectedAnswerByQuestionId.set(answer.questionId, answer);
  }
  const nextAnswerByQuestionId = new Map<string, ApplicationAnswerRecord>();
  for (const answer of answers) {
    if (nextAnswerByQuestionId.has(answer.questionId)) {
      throw new Error(
        "The commit cannot carry more than one answer per question.",
      );
    }
    nextAnswerByQuestionId.set(answer.questionId, answer);
  }

  for (const [questionId, question] of questionById) {
    const answer = nextAnswerByQuestionId.get(questionId);
    if (
      !answer ||
      question.status !== "answered" ||
      question.selectedAnswerId !== answer.id ||
      question.submittedAnswer !== answer.text
    ) {
      throw new Error(
        `Question "${questionId}" must select its approved answer and be marked answered.`,
      );
    }
  }

  const answerChanges: GroupedManualAnswerAnswerChange[] = [];
  for (const [
    questionId,
    expectedAnswerRevision,
  ] of expectedAnswerRevisionByQuestionId) {
    const expected = expectedAnswerByQuestionId.get(questionId) ?? null;
    const next = nextAnswerByQuestionId.get(questionId);
    if (expectedAnswerRevision === 0) {
      // Critical architecture decision: a question with no persisted answer
      // gets its first revision-1 suggested answer inside the same atomic
      // commit as the decision approval, request verifying transition, and
      // unchanged detected question. Nothing is deferred until resumption.
      if (expected !== null) {
        throw new Error(
          `Question "${questionId}" has no persisted answer; the commit must not carry an expected one.`,
        );
      }
      if (next === undefined) {
        throw new Error(
          `Question "${questionId}" has no persisted answer; the commit must create its revision-1 answer.`,
        );
      }
      if (next.revision !== 1) {
        throw new Error(
          `The first answer for question "${questionId}" must be revision 1.`,
        );
      }
      if (next.supersedesAnswerId !== null) {
        throw new Error(
          `The first answer for question "${questionId}" must not supersede an earlier answer.`,
        );
      }
      const lineageEntries = rawLineage.filter(
        (entry) => entry.questionId === questionId,
      );
      if (
        lineageEntries.some(
          (entry) =>
            entry.jobId !== next.jobId || entry.resultId !== next.resultId,
        )
      ) {
        throw new Error(
          `Answer for question "${questionId}" does not match its lineage identity.`,
        );
      }
      if (
        next.status !== "suggested" ||
        next.submittedAt !== null ||
        next.text !== decision.answer.value ||
        JSON.stringify(next.value) !== JSON.stringify(decision.answer)
      ) {
        throw new Error(
          `Answer for question "${questionId}" must carry the approved, unsubmitted suggestion.`,
        );
      }
      answerChanges.push({ expected: null, next });
      continue;
    }
    if (expected === null || next === undefined) {
      throw new Error(
        `Question "${questionId}" requires an expected and next answer at revision ${expectedAnswerRevision}.`,
      );
    }
    if (expected.revision !== expectedAnswerRevision) {
      throw new Error(
        `Expected answer for question "${questionId}" must be at revision ${expectedAnswerRevision}.`,
      );
    }
    if (next.revision !== expected.revision + 1) {
      throw new Error(
        `Next answer for question "${questionId}" must advance the expected revision by one.`,
      );
    }
    if (next.supersedesAnswerId !== expected.id) {
      throw new Error(
        `Next answer for question "${questionId}" must supersede the expected answer.`,
      );
    }
    if (
      next.questionId !== expected.questionId ||
      next.runId !== expected.runId ||
      next.jobId !== expected.jobId ||
      next.resultId !== expected.resultId
    ) {
      throw new Error(
        `Answer for question "${questionId}" cannot change its identity in a grouped commit.`,
      );
    }
    const lineageEntries = rawLineage.filter(
      (entry) => entry.questionId === questionId,
    );
    if (
      lineageEntries.some(
        (entry) =>
          entry.jobId !== expected.jobId ||
          entry.resultId !== expected.resultId,
      )
    ) {
      throw new Error(
        `Answer for question "${questionId}" does not match its lineage identity.`,
      );
    }
    if (
      next.status !== "suggested" ||
      next.submittedAt !== null ||
      next.text !== decision.answer.value ||
      JSON.stringify(next.value) !== JSON.stringify(decision.answer)
    ) {
      throw new Error(
        `Answer for question "${questionId}" must preserve the approved, unsubmitted suggestion.`,
      );
    }
    answerChanges.push({ expected, next });
  }
  for (const answer of answers) {
    if (!expectedAnswerRevisionByQuestionId.has(answer.questionId)) {
      throw new Error(
        `Answer for question "${answer.questionId}" is not part of the group.`,
      );
    }
  }

  const lineage = rawLineage.map((entry) => ({ ...entry, appliedAt }));

  return {
    expectedDecision,
    decision,
    lineage,
    appliedAt,
    requestsByRequestId,
    questionChanges,
    answerChanges,
    expectedAnswerRevisionByQuestionId,
  };
}

/**
 * Builds the deterministic verifying transition event for one grouped member.
 * The event id is derived only from the request id, so a retried commit reuses
 * the exact same id; the previous state is taken from the persisted request
 * the repository already compare-and-swapped against.
 */
export function buildGroupedManualAnswerTransitionEvent(input: {
  current: UserActionRequest;
  next: UserActionRequest;
}): UserActionEvent {
  const current = UserActionRequestSchema.parse(structuredClone(input.current));
  const next = UserActionRequestSchema.parse(structuredClone(input.next));
  if (next.revision !== current.revision + 1) {
    throw new Error(
      "Grouped manual-answer transitions must advance exactly one revision.",
    );
  }
  if (next.state !== "verifying") {
    throw new Error(
      "Grouped manual-answer transitions must move requests to verifying.",
    );
  }

  return UserActionEventSchema.parse({
    id: buildGroupedManualAnswerEventId(next.id),
    requestId: next.id,
    operation: "submit_manual_answer",
    previousRevision: current.revision,
    resultingRevision: next.revision,
    previousState: current.state,
    resultingState: next.state,
    occurredAt: next.updatedAt,
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
  });
}

/**
 * Partial match used to recognize an already-applied grouped commit. The
 * previous state is the only field not derivable from the lineage and next
 * request, and both pending and page_opened are legitimate for a grouped
 * manual-answer member.
 */
export function matchesGroupedManualAnswerCommitEvent(
  event: UserActionEvent,
  next: UserActionRequest,
  entry: GroupedDecisionJobLineage,
): boolean {
  return (
    event.id === buildGroupedManualAnswerEventId(next.id) &&
    event.requestId === next.id &&
    event.operation === "submit_manual_answer" &&
    event.previousRevision === entry.expectedRequestRevision &&
    event.resultingRevision === next.revision &&
    event.resultingState === "verifying" &&
    event.previousState !== "verifying" &&
    event.occurredAt === next.updatedAt
  );
}

/**
 * Persisted snapshot the repository must present to the CAS resolver. Both
 * the in-memory and the SQLite implementations build this from their store
 * before any mutation; the resolver never writes.
 */
export interface GroupedManualAnswerCurrentSnapshot {
  requests: ReadonlyMap<string, UserActionRequest>;
  answersByQuestionId: ReadonlyMap<string, ApplicationAnswerRecord | null>;
  questions: ReadonlyMap<string, ApplicationQuestionRecord>;
  decision: GroupedManualAnswerDecision | null;
  events: readonly UserActionEvent[];
}

export type GroupedManualAnswerCommitOutcome =
  | {
      status: "duplicate";
      decision: GroupedManualAnswerDecision;
      lineage: readonly GroupedDecisionJobLineage[];
      requests: readonly UserActionRequest[];
    }
  | { status: "stale"; failure: GroupedManualAnswerCommitFailure }
  | { status: "ready"; events: readonly UserActionEvent[] };

function staleRequest(
  entry: GroupedDecisionJobLineage,
  currentRevision: number | null,
): GroupedManualAnswerCommitOutcome {
  return {
    status: "stale",
    failure: {
      code: "stale_request",
      message: `Member request "${entry.requestId}" no longer matches revision ${entry.expectedRequestRevision}; the whole group is aborted.`,
      requestId: entry.requestId,
      expectedRevision: entry.expectedRequestRevision,
      currentRevision,
    },
  };
}

/**
 * Pure compare-and-swap resolution. Returns "duplicate" when the exact same
 * commit is already fully persisted (deterministic event ids make the retry
 * recognizable), "stale" when any single member no longer matches its
 * expectation, and "ready" with the events to insert only when every member
 * passed its exact CAS. No mutation happens here.
 */
export function resolveGroupedManualAnswerCommit(
  plan: NormalizedGroupedManualAnswerCommit,
  current: GroupedManualAnswerCurrentSnapshot,
): GroupedManualAnswerCommitOutcome {
  const {
    decision,
    expectedDecision,
    lineage,
    requestsByRequestId,
    questionChanges,
    answerChanges,
    expectedAnswerRevisionByQuestionId,
  } = plan;

  const eventsByRequestId = new Map<string, UserActionEvent>();
  for (const entry of lineage) {
    const event = current.events.find(
      (candidate) =>
        candidate.id === buildGroupedManualAnswerEventId(entry.requestId),
    );
    if (event !== undefined) {
      eventsByRequestId.set(entry.requestId, event);
    }
  }

  const eventsApplied = eventsByRequestId.size === lineage.length;
  for (const entry of lineage) {
    const event = eventsByRequestId.get(entry.requestId);
    if (event !== undefined) {
      const next = requestsByRequestId.get(entry.requestId)!;
      if (!matchesGroupedManualAnswerCommitEvent(event, next, entry)) {
        return staleRequest(
          entry,
          current.requests.get(entry.requestId)?.revision ?? null,
        );
      }
    }
  }

  const answersApplied = answerChanges.every((change) => {
    const currentAnswer = current.answersByQuestionId.get(
      change.next.questionId,
    );
    return (
      currentAnswer !== undefined &&
      currentAnswer !== null &&
      areSameApplicationAnswerRecords(currentAnswer, change.next)
    );
  });
  const questionsApplied = questionChanges.every((change) => {
    const currentQuestion = current.questions.get(change.next.id);
    return (
      currentQuestion !== undefined &&
      areSameApplicationQuestionRecords(currentQuestion, change.next)
    );
  });
  const decisionApplied =
    current.decision !== null &&
    areSameGroupedManualAnswerDecisions(current.decision, decision);

  if (eventsApplied && answersApplied && questionsApplied && decisionApplied) {
    return {
      status: "duplicate",
      decision,
      lineage,
      requests: lineage.map(
        (entry) => requestsByRequestId.get(entry.requestId)!,
      ),
    };
  }

  for (const entry of lineage) {
    const currentRequest = current.requests.get(entry.requestId);
    if (currentRequest === undefined) {
      return staleRequest(entry, null);
    }
    if (currentRequest.revision !== entry.expectedRequestRevision) {
      return staleRequest(entry, currentRequest.revision);
    }
    if (
      currentRequest.kind !== "manual_answer" ||
      currentRequest.scope.type !== "application"
    ) {
      return staleRequest(entry, currentRequest.revision);
    }
    if (
      currentRequest.state !== "pending" &&
      currentRequest.state !== "page_opened"
    ) {
      return staleRequest(entry, currentRequest.revision);
    }
    const next = requestsByRequestId.get(entry.requestId)!;
    if (
      currentRequest.dedupeKey !== next.dedupeKey ||
      currentRequest.kind !== next.kind ||
      currentRequest.createdAt !== next.createdAt ||
      JSON.stringify(currentRequest.scope) !== JSON.stringify(next.scope) ||
      JSON.stringify(currentRequest.verification) !==
        JSON.stringify(next.verification)
    ) {
      return staleRequest(entry, currentRequest.revision);
    }
  }

  for (const [
    questionId,
    expectedAnswerRevision,
  ] of expectedAnswerRevisionByQuestionId) {
    const currentAnswer = current.answersByQuestionId.get(questionId) ?? null;
    if (expectedAnswerRevision === 0) {
      if (currentAnswer !== null) {
        const change = answerChanges.find(
          (candidate) => candidate.next.questionId === questionId,
        );
        if (
          change !== undefined &&
          areSameApplicationAnswerRecords(currentAnswer, change.next)
        ) {
          // The exact revision-1 answer this commit creates is already
          // present; an idempotent retry after a successful commit must not
          // be misread as a stale outside write.
          continue;
        }
        return {
          status: "stale",
          failure: {
            code: "stale_answer",
            message: `Question "${questionId}" already has an answer; the whole group is aborted.`,
            questionId,
            expectedRevision: 0,
            currentRevision: currentAnswer.revision,
          },
        };
      }
      continue;
    }
    const change = answerChanges.find(
      (candidate) => candidate.next.questionId === questionId,
    );
    if (change === undefined || change.expected === null) {
      throw new Error(
        `Expected answer for question "${questionId}" was not planned.`,
      );
    }
    if (
      currentAnswer === null ||
      !areSameApplicationAnswerRecords(currentAnswer, change.expected)
    ) {
      return {
        status: "stale",
        failure: {
          code: "stale_answer",
          message: `Answer for question "${questionId}" changed since the group was approved; the whole group is aborted.`,
          questionId,
          expectedRevision: change.expected.revision,
          currentRevision: currentAnswer?.revision ?? null,
        },
      };
    }
  }

  for (const change of questionChanges) {
    const currentQuestion = current.questions.get(change.next.id);
    if (
      currentQuestion === undefined ||
      !areSameApplicationQuestionRecords(currentQuestion, change.expected)
    ) {
      return {
        status: "stale",
        failure: {
          code: "stale_question",
          message: `Question "${change.next.id}" changed since the group was approved; the whole group is aborted.`,
          questionId: change.next.id,
        },
      };
    }
  }

  if (
    current.decision === null ||
    !areSameGroupedManualAnswerDecisions(current.decision, expectedDecision)
  ) {
    return {
      status: "stale",
      failure: {
        code: "stale_decision",
        message: `Decision "${decision.id}" changed since it was approved; the whole group is aborted.`,
        decisionId: decision.id,
        expectedRevision: expectedDecision.expectedRevision,
        currentRevision: current.decision?.expectedRevision ?? null,
      },
    };
  }

  const events: UserActionEvent[] = [];
  for (const entry of lineage) {
    const currentRequest = current.requests.get(entry.requestId)!;
    const next = requestsByRequestId.get(entry.requestId)!;
    events.push(
      buildGroupedManualAnswerTransitionEvent({
        current: currentRequest,
        next,
      }),
    );
  }

  return { status: "ready", events };
}
