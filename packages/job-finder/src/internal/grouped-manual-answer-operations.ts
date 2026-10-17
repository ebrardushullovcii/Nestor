import { createHash } from "node:crypto";

import {
  ApplicationAnswerRecordSchema,
  ApplicationAnswerSaveScopeSchema,
  ApplicationAttemptQuestionSchema,
  ApplyGroupedManualAnswerInputSchema,
  ContradictoryAnswerDetectionSchema,
  GroupedDecisionJobLineageSchema,
  GroupedManualAnswerDecisionSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  SnoozeGroupedDecisionInputSchema,
  UserActionRequestSchema,
  type ApplicationAnswerRecord,
  type ApplicationAnswerSaveScope,
  type ApplicationAttemptQuestion,
  type ApplicationQuestionControlType,
  type ApplicationQuestionKind,
  type ApplyGroupedManualAnswerInput,
  type GroupedDecisionJobLineage,
  type GroupedManualAnswerDecision,
  type ContradictoryAnswerDetection,
  type SnoozeGroupedDecisionInput,
  type UserActionRequest,
} from "@nestor/contracts";
import { normalizeAnswerQuestion } from "./workspace-answer-memory";

/**
 * Pure, immutable operations over the durable grouped manual-answer decision
 * contract. A group reuses one caller-approved text answer across several
 * application-scoped manual-answer requests; every output decision is parsed
 * through `GroupedManualAnswerDecisionSchema` and every returned object is a
 * fresh validated copy. Inputs are never mutated and callers always supply
 * ids and timestamps.
 *
 * The durable contract is strict with hard literals (`kind`, `blockerKind`,
 * `authority`, `reuseScope`) and a text-only answer, so credentials, logins,
 * CAPTCHAs, MFA, legal consent, account creation, uploads, redirects, final
 * submission, and asset references are structurally impossible to represent.
 */

const GROUPED_ANSWER_TEXT_MAX = 4_000;

function sha256(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.entries(record)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function firstIssueMessage(error: {
  issues: readonly { message?: string }[];
}): string {
  return error.issues[0]?.message ?? "Invalid value.";
}

function isIsoDateTime(value: string): boolean {
  return IsoDateTimeSchema.safeParse(value).success;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** SHA-256 fingerprint of a question's normalized meaning. */
export function buildQuestionMeaningFingerprint(meaning: string): string {
  return sha256({ version: 1, meaning });
}

/**
 * SHA-256 fingerprint of the answer policy a group must share: normalized
 * meaning, question kind, control type, and save policy.
 */
export function buildAnswerPolicyFingerprint(input: {
  meaning: string;
  kind: ApplicationQuestionKind;
  controlType: ApplicationQuestionControlType;
  saveScope: ApplicationAnswerSaveScope;
}): string {
  return sha256({
    version: 1,
    meaning: input.meaning,
    kind: input.kind,
    controlType: input.controlType,
    saveScope: input.saveScope,
  });
}

/**
 * Exact application-scoped state behind one manual-answer request. The
 * revisions are captured verbatim into the decision lineage for the apply
 * CAS; the caller owns their current values.
 */
export interface GroupedManualAnswerRequestContext {
  question: ApplicationAttemptQuestion;
  /** The application record this request belongs to. */
  applicationRecordId: string;
  /** The question's exact current revision. */
  questionRevision: number;
  /** The answer record's exact current revision; 0 when no answer exists. */
  answerRevision: number;
}

export interface ProjectGroupedManualAnswerDecisionsInput {
  /** Caller-rooted group key; every decision id is derived from it. */
  groupKey: string;
  /** Application-scoped manual-answer requests to project from. */
  requests: readonly UserActionRequest[];
  /** requestId -> exact question/answer state for that request. */
  contexts: ReadonlyMap<string, GroupedManualAnswerRequestContext>;
  /** Saved answers used only to detect conflicting reuse. */
  savedAnswers: readonly ApplicationAnswerRecord[];
  /** questionId -> question for each saved answer, for meaning matching. */
  savedAnswerQuestions: ReadonlyMap<string, ApplicationAttemptQuestion>;
  /** The reusable text answer the group will reuse. */
  answerText: string;
  saveScope: ApplicationAnswerSaveScope;
  /** Caller-provided timestamp. */
  occurredAt: string;
}

export interface ProjectGroupedManualAnswerDecisionsResult {
  decisions: readonly GroupedManualAnswerDecision[];
  /** Advisory contradiction evidence; it never broadens or changes authority. */
  contradictionEvidence: readonly GroupedAnswerContradictionEvidence[];
  groupedRequestCount: number;
  groupedJobCount: number;
  skippedRequestCount: number;
  skippedJobCount: number;
}

/** Durable contradiction evidence emitted when saved reusable answers disagree. */
export type GroupedAnswerContradictionEvidence = Pick<
  ContradictoryAnswerDetection,
  | "questionA"
  | "questionB"
  | "answerA"
  | "answerB"
  | "contradictionScore"
  | "detectedAt"
  | "explanation"
  | "recoveryGuidance"
> & { detectionId: string };

interface ProjectedMember {
  request: UserActionRequest;
  context: GroupedManualAnswerRequestContext;
  controlType: ApplicationQuestionControlType;
  jobId: string;
  resultId: string | null;
}

interface ProjectedCluster {
  questionMeaning: string;
  questionMeaningFingerprint: string;
  answerPolicyFingerprint: string;
  members: ProjectedMember[];
}

function savedAnswerConflicts(
  input: ProjectGroupedManualAnswerDecisionsInput,
  meaning: string,
  answerText: string,
): Array<{
  saved: ApplicationAnswerRecord;
  question: ApplicationAttemptQuestion;
}> {
  const conflicts: Array<{
    saved: ApplicationAnswerRecord;
    question: ApplicationAttemptQuestion;
  }> = [];
  for (const rawSaved of input.savedAnswers) {
    const savedResult = ApplicationAnswerRecordSchema.safeParse(rawSaved);
    if (!savedResult.success) continue;
    const saved = savedResult.data;
    if (saved.status === "rejected" || saved.status === "skipped") continue;

    const question = input.savedAnswerQuestions.get(saved.questionId);
    if (question === undefined) continue;
    if (normalizeAnswerQuestion(question.prompt) !== meaning) continue;

    const conflictsWithText =
      saved.value === null
        ? saved.text !== answerText
        : saved.value.type === "text"
          ? saved.value.value !== answerText
          : // Choices, dates, and asset references can never be reused as text.
            true;
    if (conflictsWithText) conflicts.push({ saved, question });
  }

  return conflicts;
}

function savedAnswerDisplayValue(saved: ApplicationAnswerRecord): string {
  if (saved.value === null) return saved.text;
  if (saved.value.type === "text") return saved.value.value;
  return `${saved.value.type} answer`;
}

function buildContradictionEvidence(input: {
  clusterKey: string;
  groupKey: string;
  questionMeaning: string;
  saved: ApplicationAnswerRecord;
  savedQuestion: ApplicationAttemptQuestion;
  answerText: string;
  detectedAt: string;
}): GroupedAnswerContradictionEvidence {
  const questionA = `${input.savedQuestion.prompt.trim()} (saved answer ${input.saved.id})`;
  const questionB = `${input.savedQuestion.prompt.trim()} (group answer ${input.groupKey}:${input.clusterKey.slice(0, 16)})`;
  const answerA = savedAnswerDisplayValue(input.saved);
  const answerB = input.answerText;
  const detectionId = `grouped_answer_contradiction_${sha256({
    version: 1,
    groupKey: input.groupKey,
    clusterKey: input.clusterKey,
    questionMeaning: input.questionMeaning,
    savedAnswerId: input.saved.id,
    answerA,
    answerB,
  }).slice(0, 32)}`;

  const detection = ContradictoryAnswerDetectionSchema.parse({
    id: detectionId,
    questionA,
    questionB,
    answerA,
    answerB,
    contradictionScore: 1,
    status: "detected",
    detectedAt: input.detectedAt,
    resolvedAt: null,
    explanation: `Reusable answer '${input.saved.id}' conflicts with the grouped answer for '${input.questionMeaning}'.`,
    recoveryGuidance:
      "Review the saved answer and grouped answer separately; resolve or dismiss the advisory contradiction before reusing either value.",
  });
  return {
    detectionId: detection.id,
    questionA: detection.questionA,
    questionB: detection.questionB,
    answerA: detection.answerA,
    answerB: detection.answerB,
    contradictionScore: detection.contradictionScore,
    detectedAt: detection.detectedAt,
    explanation: detection.explanation,
    recoveryGuidance: detection.recoveryGuidance,
  };
}

function buildLineageEntry(member: ProjectedMember): GroupedDecisionJobLineage {
  return GroupedDecisionJobLineageSchema.parse({
    requestId: member.request.id,
    jobId: member.jobId,
    applicationRecordId: member.context.applicationRecordId,
    resultId: member.resultId,
    questionId: member.context.question.id,
    answerRecordId: null,
    expectedRequestRevision: member.request.revision,
    expectedQuestionRevision: member.context.questionRevision,
    expectedAnswerRevision: member.context.answerRevision,
    appliedAt: null,
  });
}

/**
 * Projects compatible pending manual-answer groups from application-scoped
 * requests and their exact questions. A request is groupable only when it is
 * a pending/page-opened `manual_answer` action with `page_blocker_absent`
 * verification whose question shares the normalized meaning, kind, text-safe
 * control type, and save policy with its cluster. Each member retains its own
 * exact application scope in lineage, so compatible questions can be grouped
 * across runs and sources without broadening any browser authority.
 * Clusters with fewer than two members, or whose saved answers conflict with
 * the reusable text answer, are skipped. Every emitted decision is validated
 * by `GroupedManualAnswerDecisionSchema` and carries one per-job lineage
 * entry per member with the exact captured revisions.
 */
export function projectGroupedManualAnswerDecisions(
  input: ProjectGroupedManualAnswerDecisionsInput,
): ProjectGroupedManualAnswerDecisionsResult {
  const groupKey = NonEmptyStringSchema.parse(input.groupKey);
  const occurredAt = IsoDateTimeSchema.parse(input.occurredAt);
  const saveScope = ApplicationAnswerSaveScopeSchema.parse(input.saveScope);
  const answerText = input.answerText.trim();

  if (answerText.length === 0 || answerText.length > GROUPED_ANSWER_TEXT_MAX) {
    throw new Error(
      `answerText must be a text answer of at most ${GROUPED_ANSWER_TEXT_MAX} characters.`,
    );
  }

  const clusters = new Map<string, ProjectedCluster>();
  const seenRequestIds = new Set<string>();
  const skippedJobIds = new Set<string>();
  let skippedRequestCount = 0;

  const skipRequest = (request: UserActionRequest): void => {
    skippedRequestCount += 1;
    if (request.scope.type === "application") {
      skippedJobIds.add(request.scope.jobId);
    }
  };

  for (const rawRequest of input.requests) {
    if (seenRequestIds.has(rawRequest.id)) continue;
    seenRequestIds.add(rawRequest.id);

    const requestResult = UserActionRequestSchema.safeParse(rawRequest);
    if (!requestResult.success) {
      skipRequest(rawRequest);
      continue;
    }
    const request = requestResult.data;

    if (request.kind !== "manual_answer") {
      skipRequest(request);
      continue;
    }
    if (request.scope.type !== "application") {
      skipRequest(request);
      continue;
    }
    if (request.state !== "pending" && request.state !== "page_opened") {
      skipRequest(request);
      continue;
    }
    if (request.verification.type !== "page_blocker_absent") {
      skipRequest(request);
      continue;
    }

    const context = input.contexts.get(request.id);
    if (context === undefined) {
      skipRequest(request);
      continue;
    }

    const questionResult = ApplicationAttemptQuestionSchema.safeParse(
      context.question,
    );
    if (!questionResult.success) {
      skipRequest(request);
      continue;
    }
    const question = questionResult.data;
    const controlType = question.answerControlType ?? "text";
    if (controlType === "file") {
      skipRequest(request);
      continue;
    }
    if (!isPositiveInteger(context.questionRevision)) {
      skipRequest(request);
      continue;
    }
    if (!isNonNegativeInteger(context.answerRevision)) {
      skipRequest(request);
      continue;
    }
    if (context.applicationRecordId.trim().length === 0) {
      skipRequest(request);
      continue;
    }

    const scope = request.scope;
    const meaning = normalizeAnswerQuestion(question.prompt);
    const questionMeaningFingerprint = buildQuestionMeaningFingerprint(meaning);
    const answerPolicyFingerprint = buildAnswerPolicyFingerprint({
      meaning,
      kind: question.kind,
      controlType,
      saveScope,
    });
    const clusterKey = sha256({
      questionMeaningFingerprint,
      answerPolicyFingerprint,
    });

    let cluster = clusters.get(clusterKey);
    if (cluster === undefined) {
      cluster = {
        questionMeaning: meaning,
        questionMeaningFingerprint,
        answerPolicyFingerprint,
        members: [],
      };
      clusters.set(clusterKey, cluster);
    }
    cluster.members.push({
      request,
      context,
      controlType,
      jobId: scope.jobId,
      resultId: scope.resultId,
    });
  }

  const decisions: GroupedManualAnswerDecision[] = [];
  const contradictionEvidence: GroupedAnswerContradictionEvidence[] = [];
  for (const [clusterKey, cluster] of clusters.entries()) {
    if (cluster.members.length < 2) {
      for (const member of cluster.members) {
        skippedRequestCount += 1;
        skippedJobIds.add(member.jobId);
      }
      continue;
    }

    const conflicts = savedAnswerConflicts(
      input,
      cluster.questionMeaning,
      answerText,
    );
    if (conflicts.length > 0) {
      for (const conflict of conflicts) {
        contradictionEvidence.push(
          buildContradictionEvidence({
            clusterKey,
            groupKey,
            questionMeaning: cluster.questionMeaning,
            saved: conflict.saved,
            savedQuestion: conflict.question,
            answerText,
            detectedAt: occurredAt,
          }),
        );
      }
      for (const member of cluster.members) {
        skippedRequestCount += 1;
        skippedJobIds.add(member.jobId);
      }
      continue;
    }

    const sortedMembers = [...cluster.members].sort((left, right) =>
      left.request.id.localeCompare(right.request.id),
    );
    const lead = sortedMembers[0]!;
    const lineage = sortedMembers.map((member) => buildLineageEntry(member));

    decisions.push(
      GroupedManualAnswerDecisionSchema.parse({
        id: `${groupKey}:${clusterKey.slice(0, 16)}`,
        groupKey,
        requestId: lead.request.id,
        applicationRecordId: lead.context.applicationRecordId,
        jobId: lead.jobId,
        resultId: lead.resultId,
        questionId: lead.context.question.id,
        expectedRevision: 1,
        expectedQuestionRevision: lead.context.questionRevision,
        expectedAnswerRevision: lead.context.answerRevision,
        fingerprints: {
          questionMeaning: cluster.questionMeaningFingerprint,
          answerPolicy: cluster.answerPolicyFingerprint,
        },
        answer: { type: "text", value: answerText },
        approval: "pending",
        conflict: { status: "none" },
        snooze: null,
        lineage,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }),
    );
  }

  const groupedRequestIds = new Set<string>();
  const groupedJobIds = new Set<string>();
  for (const decision of decisions) {
    for (const entry of decision.lineage) {
      groupedRequestIds.add(entry.requestId);
      groupedJobIds.add(entry.jobId);
    }
  }

  return {
    decisions,
    contradictionEvidence,
    groupedRequestCount: groupedRequestIds.size,
    groupedJobCount: groupedJobIds.size,
    skippedRequestCount,
    skippedJobCount: skippedJobIds.size,
  };
}

export type ApproveGroupedManualAnswerFailure =
  | { code: "invalid_decision"; message: string }
  | { code: "invalid_input"; message: string }
  | { code: "decision_not_pending"; message: string }
  | { code: "request_mismatch"; message: string }
  | {
      code: "request_revision_mismatch";
      message: string;
      requestId: string;
      expectedRevision: number;
      currentRevision: number;
    }
  | {
      code: "stale_request";
      message: string;
      requestId: string;
      expectedRevision: number;
      currentRevision: number | null;
    };

export type ApproveGroupedManualAnswerResult =
  | {
      ok: true;
      decision: GroupedManualAnswerDecision;
      lineage: readonly GroupedDecisionJobLineage[];
      requests: readonly UserActionRequest[];
      requestCount: number;
      jobCount: number;
    }
  | { ok: false; failure: ApproveGroupedManualAnswerFailure };

/**
 * Approves and applies a pending grouped manual-answer decision with the
 * caller-approved text answer. Every request id in the command must exactly
 * match the decision lineage, every expected request revision must match the
 * captured lineage revision, and every current request must CAS against that
 * revision before anything changes; any mismatch aborts the whole group with
 * no partial lineage. On success the decision is marked approved, the lineage
 * is stamped with the apply time, and every member request advances to
 * "verifying" at revision + 1.
 */
export function approveGroupedManualAnswer(input: {
  decision: GroupedManualAnswerDecision;
  command: ApplyGroupedManualAnswerInput;
  /** Current request snapshot keyed by request id, for the CAS. */
  requests: ReadonlyMap<string, UserActionRequest>;
  callerId: string;
  occurredAt: string;
}): ApproveGroupedManualAnswerResult {
  const decisionResult = GroupedManualAnswerDecisionSchema.safeParse(
    input.decision,
  );
  if (!decisionResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_decision",
        message: firstIssueMessage(decisionResult.error),
      },
    };
  }
  const decision = decisionResult.data;

  const commandResult = ApplyGroupedManualAnswerInputSchema.safeParse(
    input.command,
  );
  if (!commandResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: firstIssueMessage(commandResult.error),
      },
    };
  }
  const command = commandResult.data;

  if (input.callerId.trim().length === 0) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: "callerId must be a non-empty string.",
      },
    };
  }
  if (!isIsoDateTime(input.occurredAt)) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: "occurredAt must be an ISO date-time.",
      },
    };
  }

  if (decision.approval !== "pending") {
    return {
      ok: false,
      failure: {
        code: "decision_not_pending",
        message: `Decision "${decision.id}" is ${decision.approval}; only pending decisions can be applied.`,
      },
    };
  }

  if (command.decisionId !== decision.id) {
    return {
      ok: false,
      failure: {
        code: "request_mismatch",
        message: `Command targets decision "${command.decisionId}" but the supplied decision is "${decision.id}".`,
      },
    };
  }

  const lineageByRequestId = new Map(
    decision.lineage.map((entry) => [entry.requestId, entry]),
  );
  if (command.requestIds.length !== decision.lineage.length) {
    return {
      ok: false,
      failure: {
        code: "request_mismatch",
        message: "requestIds must cover exactly the decision lineage members.",
      },
    };
  }
  for (const requestId of command.requestIds) {
    const entry = lineageByRequestId.get(requestId);
    if (entry === undefined) {
      return {
        ok: false,
        failure: {
          code: "request_mismatch",
          message: `Request "${requestId}" is not a member of decision "${decision.id}".`,
        },
      };
    }
    const expected = command.expectedRequestRevisions[requestId];
    if (expected !== entry.expectedRequestRevision) {
      return {
        ok: false,
        failure: {
          code: "request_revision_mismatch",
          message: `Request "${requestId}" must be applied at revision ${entry.expectedRequestRevision}.`,
          requestId,
          expectedRevision: entry.expectedRequestRevision,
          currentRevision: expected ?? -1,
        },
      };
    }
  }

  const updatedRequests: UserActionRequest[] = [];
  for (const entry of decision.lineage) {
    const current = input.requests.get(entry.requestId);
    if (current === undefined) {
      return {
        ok: false,
        failure: {
          code: "stale_request",
          message: `Member request "${entry.requestId}" is missing from the snapshot; the whole group is aborted.`,
          requestId: entry.requestId,
          expectedRevision: entry.expectedRequestRevision,
          currentRevision: null,
        },
      };
    }

    const currentResult = UserActionRequestSchema.safeParse(current);
    if (!currentResult.success) {
      return {
        ok: false,
        failure: {
          code: "stale_request",
          message: `Member request "${entry.requestId}" is no longer a valid user action; the whole group is aborted.`,
          requestId: entry.requestId,
          expectedRevision: entry.expectedRequestRevision,
          currentRevision: null,
        },
      };
    }
    const parsedCurrent = currentResult.data;

    if (
      parsedCurrent.kind !== "manual_answer" ||
      parsedCurrent.scope.type !== "application"
    ) {
      return {
        ok: false,
        failure: {
          code: "stale_request",
          message: `Member request "${entry.requestId}" is no longer a manual-answer application action; the whole group is aborted.`,
          requestId: entry.requestId,
          expectedRevision: entry.expectedRequestRevision,
          currentRevision: parsedCurrent.revision,
        },
      };
    }
    if (parsedCurrent.revision !== entry.expectedRequestRevision) {
      return {
        ok: false,
        failure: {
          code: "stale_request",
          message: `Member request "${entry.requestId}" is at revision ${parsedCurrent.revision} but the group captured revision ${entry.expectedRequestRevision}; the whole group is aborted.`,
          requestId: entry.requestId,
          expectedRevision: entry.expectedRequestRevision,
          currentRevision: parsedCurrent.revision,
        },
      };
    }

    updatedRequests.push(
      UserActionRequestSchema.parse({
        ...parsedCurrent,
        revision: parsedCurrent.revision + 1,
        state: "verifying",
        updatedAt: input.occurredAt,
      }),
    );
  }

  const lineage = decision.lineage.map((entry) =>
    GroupedDecisionJobLineageSchema.parse({
      ...entry,
      appliedAt: input.occurredAt,
    }),
  );

  const updatedDecision = GroupedManualAnswerDecisionSchema.parse({
    ...decision,
    answer: command.answer,
    approval: "approved",
    approvedAt: input.occurredAt,
    snooze: null,
    expectedRevision: decision.expectedRevision + 1,
    updatedAt: input.occurredAt,
    lineage,
  });

  return {
    ok: true,
    decision: updatedDecision,
    lineage,
    requests: updatedRequests,
    requestCount: updatedRequests.length,
    jobCount: new Set(updatedDecision.lineage.map((entry) => entry.jobId)).size,
  };
}

export type SnoozeGroupedDecisionFailure =
  | { code: "invalid_decision"; message: string }
  | { code: "invalid_input"; message: string }
  | { code: "decision_not_found"; message: string }
  | {
      code: "revision_mismatch";
      message: string;
      expectedRevision: number;
      currentRevision: number;
    }
  | { code: "decision_not_pending"; message: string }
  | { code: "not_future"; message: string };

export type SnoozeGroupedDecisionResult =
  | { ok: true; decision: GroupedManualAnswerDecision }
  | { ok: false; failure: SnoozeGroupedDecisionFailure };

/**
 * Snoozes a pending durable decision. The command must target the decision
 * id, its expectedRevision must CAS against the decision revision, and the
 * snooze time must be strictly after the caller-provided occurredAt. The
 * decision stays pending and its revision advances so a later apply or
 * snooze must use the new revision.
 */
export function snoozeGroupedDecision(input: {
  decision: GroupedManualAnswerDecision;
  command: SnoozeGroupedDecisionInput;
  occurredAt: string;
}): SnoozeGroupedDecisionResult {
  const decisionResult = GroupedManualAnswerDecisionSchema.safeParse(
    input.decision,
  );
  if (!decisionResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_decision",
        message: firstIssueMessage(decisionResult.error),
      },
    };
  }
  const decision = decisionResult.data;

  const commandResult = SnoozeGroupedDecisionInputSchema.safeParse(
    input.command,
  );
  if (!commandResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: firstIssueMessage(commandResult.error),
      },
    };
  }
  const command = commandResult.data;

  if (!isIsoDateTime(input.occurredAt)) {
    return {
      ok: false,
      failure: {
        code: "invalid_input",
        message: "occurredAt must be an ISO date-time.",
      },
    };
  }

  if (command.decisionId !== decision.id) {
    return {
      ok: false,
      failure: {
        code: "decision_not_found",
        message: `Command targets decision "${command.decisionId}" but the supplied decision is "${decision.id}".`,
      },
    };
  }
  if (command.expectedRevision !== decision.expectedRevision) {
    return {
      ok: false,
      failure: {
        code: "revision_mismatch",
        message: `Expected revision ${command.expectedRevision} but decision "${decision.id}" is at revision ${decision.expectedRevision}.`,
        expectedRevision: command.expectedRevision,
        currentRevision: decision.expectedRevision,
      },
    };
  }
  if (decision.approval !== "pending") {
    return {
      ok: false,
      failure: {
        code: "decision_not_pending",
        message: `Decision "${decision.id}" is ${decision.approval}; only pending decisions can be snoozed.`,
      },
    };
  }
  if (Date.parse(command.until) <= Date.parse(input.occurredAt)) {
    return {
      ok: false,
      failure: {
        code: "not_future",
        message: `Snooze until "${command.until}" must be strictly after "${input.occurredAt}".`,
      },
    };
  }

  const updatedDecision = GroupedManualAnswerDecisionSchema.parse({
    ...decision,
    snooze: { until: command.until, reason: command.reason ?? null },
    expectedRevision: decision.expectedRevision + 1,
    updatedAt: input.occurredAt,
  });

  return { ok: true, decision: updatedDecision };
}

/**
 * Derives the visible grouped manual-answer decisions at a caller-provided
 * time. Approved and declined decisions, decisions with a detected conflict,
 * and decisions with an active (future) snooze are excluded; a snoozed
 * decision becomes visible again once its snooze window has passed.
 */
export function deriveVisibleGroupedManualAnswerDecisions(input: {
  decisions: readonly GroupedManualAnswerDecision[];
  now: string;
}): GroupedManualAnswerDecision[] {
  const now = IsoDateTimeSchema.parse(input.now);
  const nowTime = Date.parse(now);

  const visible: GroupedManualAnswerDecision[] = [];
  for (const rawDecision of input.decisions) {
    const decision = GroupedManualAnswerDecisionSchema.parse(rawDecision);
    if (decision.approval !== "pending") continue;
    if (decision.conflict.status === "detected") continue;
    if (
      decision.snooze !== null &&
      Date.parse(decision.snooze.until) > nowTime
    ) {
      continue;
    }
    visible.push(decision);
  }

  return visible;
}
