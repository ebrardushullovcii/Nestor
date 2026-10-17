import {
  ApplicationAnswerRecordSchema,
  compareApplicationAnswerRecency,
  ApplicationAttemptQuestionSchema,
  ApplyGroupedManualAnswerInputSchema,
  JobFinderIntelligenceStateSchema,
  ProjectGroupedManualAnswerCommandSchema,
  SnoozeGroupedDecisionInputSchema,
  UserActionRequestSchema,
  type ApplicationAnswerRecord,
  type ApplicationAttemptQuestion,
  type ApplicationQuestionRecord,
  type ApplyGroupedManualAnswerInput,
  type GroupedManualAnswerDecision,
  type JobFinderWorkspaceSnapshot,
  type ProjectGroupedManualAnswerCommand,
  type SnoozeGroupedDecisionInput,
  type UserActionRequest,
} from "@nestor/contracts";

import {
  approveGroupedManualAnswer,
  projectGroupedManualAnswerDecisions,
  snoozeGroupedDecision,
  type GroupedManualAnswerRequestContext,
} from "./grouped-manual-answer-operations";
import { recordContradictoryAnswerDetection } from "./safeguard-operations";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/**
 * Workspace integration for grouped reusable manual answers. The typed
 * create/project command is rooted in one pending application manual-answer
 * request plus user-entered text, projects only proven-compatible pending
 * requests, and persists a pending decision. A separate typed approval applies
 * exactly the full lineage through the atomic repository commit, which also
 * creates the first revision-1 suggested answer for every revision-0 member in
 * the same transaction. Snoozing is supported and the create flow never
 * silently overwrites an existing pending/approved decision. Every member
 * stays per-job prepare-only and resumes only through the existing verifying
 * user-action resumer.
 */

function latestAnswerForQuestion(
  answers: readonly ApplicationAnswerRecord[],
  questionId: string,
): ApplicationAnswerRecord | null {
  let latest: ApplicationAnswerRecord | null = null;
  for (const answer of answers) {
    if (answer.questionId !== questionId) continue;
    if (
      latest === null ||
      compareApplicationAnswerRecency(answer, latest) < 0
    ) {
      latest = answer;
    }
  }
  return latest;
}

function toAttemptQuestion(
  record: ApplicationQuestionRecord,
): ApplicationAttemptQuestion {
  return ApplicationAttemptQuestionSchema.parse({
    id: record.id,
    prompt: record.prompt,
    kind: record.kind,
    answerControlType: record.answerControlType,
    isRequired: record.isRequired,
    detectedAt: record.detectedAt,
    answerOptions: record.answerOptions,
    suggestedAnswers: record.suggestedAnswers,
    submittedAnswer: record.submittedAnswer,
    status: record.status,
  });
}

function isProjectableManualAnswerRequest(
  request: UserActionRequest,
): request is UserActionRequest & {
  scope: Extract<UserActionRequest["scope"], { type: "application" }>;
} {
  return (
    request.kind === "manual_answer" &&
    request.scope.type === "application" &&
    (request.state === "pending" || request.state === "page_opened") &&
    request.verification.type === "page_blocker_absent"
  );
}

/**
 * Structural equality of two pending decisions ignoring the caller-provided
 * timestamps. Only an identical pending duplicate is treated as an idempotent
 * re-project; any other collision is refused so the create flow never
 * silently overwrites a persisted decision.
 */
function areEquivalentPendingGroupedDecisions(
  left: GroupedManualAnswerDecision,
  right: GroupedManualAnswerDecision,
): boolean {
  return (
    left.id === right.id &&
    left.groupKey === right.groupKey &&
    left.approval === right.approval &&
    left.approval === "pending" &&
    left.requestId === right.requestId &&
    left.applicationRecordId === right.applicationRecordId &&
    left.jobId === right.jobId &&
    left.resultId === right.resultId &&
    left.questionId === right.questionId &&
    left.expectedRevision === right.expectedRevision &&
    left.expectedQuestionRevision === right.expectedQuestionRevision &&
    left.expectedAnswerRevision === right.expectedAnswerRevision &&
    JSON.stringify(left.fingerprints) === JSON.stringify(right.fingerprints) &&
    JSON.stringify(left.answer) === JSON.stringify(right.answer) &&
    JSON.stringify(left.lineage) === JSON.stringify(right.lineage) &&
    JSON.stringify(left.conflict) === JSON.stringify(right.conflict) &&
    JSON.stringify(left.snooze) === JSON.stringify(right.snooze)
  );
}

/** Deterministic answer-record id for one decision member. */
function groupedAnswerRecordId(decisionId: string, questionId: string): string {
  return `grouped_answer_${decisionId}_${questionId}`;
}

export function createWorkspaceGroupedAnswerMethods(input: {
  ctx: WorkspaceServiceContext;
  getWorkspaceSnapshot: () => Promise<JobFinderWorkspaceSnapshot>;
  resumeVerifyingUserActions: () => Promise<void>;
}) {
  const { ctx, getWorkspaceSnapshot, resumeVerifyingUserActions } = input;

  async function projectGroupedManualAnswerOnce(
    command: ProjectGroupedManualAnswerCommand,
  ): Promise<void> {
    await ctx.withIntelligenceTransition(async () => {
      const now = new Date().toISOString();
      const [requests, questionRecords, answerRecords, intelligence] =
        await Promise.all([
          ctx.repository.listUserActionRequests(),
          ctx.repository.listApplicationQuestionRecords(),
          ctx.repository.listApplicationAnswerRecords(),
          ctx.repository.getIntelligenceState(),
        ]);

      const root = requests.find((request) => request.id === command.requestId);
      if (!root) {
        throw new Error(
          `Manual-answer request '${command.requestId}' does not exist.`,
        );
      }
      if (!isProjectableManualAnswerRequest(root)) {
        throw new Error(
          `Request '${command.requestId}' is not a pending application manual-answer action.`,
        );
      }
      if (root.revision !== command.expectedRequestRevision) {
        throw new Error(
          `Request '${command.requestId}' moved to revision ${root.revision}; the group was not created so nothing was overwritten.`,
        );
      }

      const questionsByScope = new Map<string, ApplicationQuestionRecord[]>();
      for (const question of questionRecords) {
        if (!question.applicationRecordId) continue;
        const key = `${question.runId}|${question.jobId}|${question.applicationRecordId}|${question.resultId ?? ""}`;
        const entries = questionsByScope.get(key) ?? [];
        entries.push(question);
        questionsByScope.set(key, entries);
      }

      const candidateRequests: UserActionRequest[] = [];
      const contexts = new Map<string, GroupedManualAnswerRequestContext>();
      for (const rawRequest of requests) {
        const parsed = UserActionRequestSchema.safeParse(rawRequest);
        if (!parsed.success) continue;
        const request = parsed.data;
        if (!isProjectableManualAnswerRequest(request)) continue;
        const scope = request.scope;
        if (!scope.applicationRecordId || !scope.resultId) continue;
        const detectedQuestions = (
          questionsByScope.get(
            `${scope.runId}|${scope.jobId}|${scope.applicationRecordId}|${scope.resultId}`,
          ) ?? []
        ).filter((question) => question.status === "detected");
        // Only unambiguous question contexts are groupable; the apply copilot
        // uses the same exactly-one-detected-question convention.
        if (detectedQuestions.length !== 1) continue;
        const question = detectedQuestions[0]!;
        const latestAnswer = latestAnswerForQuestion(
          answerRecords,
          question.id,
        );
        if (
          latestAnswer !== null &&
          latestAnswer.applicationRecordId !== scope.applicationRecordId
        ) {
          continue;
        }
        contexts.set(request.id, {
          question: toAttemptQuestion(question),
          applicationRecordId: scope.applicationRecordId,
          questionRevision: 1,
          answerRevision: latestAnswer?.revision ?? 0,
        });
        candidateRequests.push(request);
      }

      const savedAnswers = answerRecords.filter(
        (answer) => answer.saveScope === "reusable_profile",
      );
      const savedAnswerQuestions = new Map<
        string,
        ApplicationAttemptQuestion
      >();
      for (const answer of savedAnswers) {
        const record = questionRecords.find(
          (question) => question.id === answer.questionId,
        );
        if (record) {
          savedAnswerQuestions.set(
            answer.questionId,
            toAttemptQuestion(record),
          );
        }
      }

      const projected = projectGroupedManualAnswerDecisions({
        groupKey: command.groupKey,
        requests: candidateRequests,
        contexts,
        savedAnswers,
        savedAnswerQuestions,
        answerText: command.answer.value,
        saveScope: command.saveScope,
        occurredAt: now,
      });

      // Persist advisory contradiction evidence independently of decision
      // projection. A conflicting saved answer intentionally produces no
      // grouped decision, but the evidence must survive that rejected
      // projection so the user can resolve or dismiss it later.
      let nextSafeguards = intelligence.safeguards;
      for (const evidence of projected.contradictionEvidence) {
        const result = recordContradictoryAnswerDetection({
          safeguards: nextSafeguards,
          detection: evidence,
          now,
        });
        if (result.ok) nextSafeguards = result.safeguards;
      }
      const safeguardsChanged =
        JSON.stringify(nextSafeguards) !==
        JSON.stringify(intelligence.safeguards);
      if (safeguardsChanged) {
        await ctx.repository.saveIntelligenceState(
          JobFinderIntelligenceStateSchema.parse({
            ...intelligence,
            safeguards: nextSafeguards,
            updatedAt: now,
          }),
        );
      }

      if (projected.decisions.length === 0) {
        throw new Error(
          "No compatible manual-answer group could be projected from the pending requests.",
        );
      }
      const rootedDecision = projected.decisions.find((decision) =>
        decision.lineage.some((entry) => entry.requestId === command.requestId),
      );
      if (!rootedDecision) {
        throw new Error(
          `Root request '${command.requestId}' is not part of any compatible manual-answer group.`,
        );
      }

      const existingById = new Map(
        intelligence.groupedDecisions.map((decision) => [
          decision.id,
          decision,
        ]),
      );
      const nextDecisions = [...intelligence.groupedDecisions];
      // The answer was supplied for one exact root question. Other clusters
      // can have a different meaning and must not inherit it implicitly.
      for (const decision of [rootedDecision]) {
        const existing = existingById.get(decision.id);
        if (existing === undefined) {
          nextDecisions.push(decision);
          continue;
        }
        if (areEquivalentPendingGroupedDecisions(existing, decision)) {
          // Idempotent re-project keeps the persisted pending decision.
          continue;
        }
        throw new Error(
          `Grouped decision '${decision.id}' already exists as ${existing.approval}; the create flow never silently overwrites it. Use that decision or a different group key.`,
        );
      }

      await ctx.repository.saveIntelligenceState(
        JobFinderIntelligenceStateSchema.parse({
          ...intelligence,
          groupedDecisions: nextDecisions,
          safeguards: nextSafeguards,
          updatedAt: now,
        }),
      );
    });
  }

  async function applyGroupedManualAnswerOnce(
    command: ApplyGroupedManualAnswerInput,
  ): Promise<void> {
    // commitGroupedManualAnswer replaces the full intelligence singleton, so
    // the whole apply (including the pending-decision read) runs inside the
    // intelligence transition. A concurrent project/snooze/rapid/outcome write
    // therefore can never read the pending decision before the approval and
    // then write the stale singleton back, which would revert an approved
    // decision. Verifying members resume only after leaving the transition in
    // the public wrapper below.
    await ctx.withIntelligenceTransition(async () => {
      const intelligence = await ctx.repository.getIntelligenceState();
      const pending =
        intelligence.groupedDecisions.find(
          (decision) => decision.id === command.decisionId,
        ) ?? null;
      if (!pending) {
        throw new Error(
          `Grouped decision '${command.decisionId}' does not exist.`,
        );
      }
      if (pending.approval === "approved" && pending.approvedAt !== null) {
        // Idempotent duplicate: the exact full lineage was already applied
        // atomically and every member resumes only through the verifying
        // user-action resumer.
        return;
      }
      if (pending.approval !== "pending") {
        throw new Error(
          `Grouped decision '${command.decisionId}' is ${pending.approval}; only pending decisions can be applied.`,
        );
      }

      const occurredAt = new Date().toISOString();
      const allRequests = await ctx.repository.listUserActionRequests();
      const requestsByRequestId = new Map(
        allRequests.map((request) => [request.id, request]),
      );
      const approved = approveGroupedManualAnswer({
        decision: pending,
        command,
        requests: requestsByRequestId,
        callerId: `grouped_apply:${pending.id}`,
        occurredAt,
      });
      if (!approved.ok) {
        throw new Error(approved.failure.message);
      }

      const [questionRecords, answerRecords] = await Promise.all([
        ctx.repository.listApplicationQuestionRecords(),
        ctx.repository.listApplicationAnswerRecords(),
      ]);

      const expectedQuestions: ApplicationQuestionRecord[] = [];
      const nextQuestions: ApplicationQuestionRecord[] = [];
      const expectedAnswers: ApplicationAnswerRecord[] = [];
      const nextAnswers: ApplicationAnswerRecord[] = [];
      const seenQuestionIds = new Set<string>();
      for (const entry of approved.lineage) {
        if (seenQuestionIds.has(entry.questionId)) continue;
        seenQuestionIds.add(entry.questionId);

        const request = requestsByRequestId.get(entry.requestId);
        if (
          request?.scope.type !== "application" ||
          request.scope.applicationRecordId !== entry.applicationRecordId
        ) {
          throw new Error(
            `Member request '${entry.requestId}' no longer has exact application lineage for decision '${pending.id}'; the whole group is aborted.`,
          );
        }

        const question = questionRecords.find(
          (candidate) => candidate.id === entry.questionId,
        );
        if (!question) {
          throw new Error(
            `Question '${entry.questionId}' is no longer available for decision '${pending.id}'.`,
          );
        }
        if (question.applicationRecordId !== entry.applicationRecordId) {
          throw new Error(
            `Question '${entry.questionId}' no longer has exact application lineage for decision '${pending.id}'; the whole group is aborted.`,
          );
        }
        // Questions carry no revision; compare the full record before the
        // atomic commit selects the approved answer.
        expectedQuestions.push(question);

        const latest = latestAnswerForQuestion(answerRecords, entry.questionId);
        if (
          latest !== null &&
          latest.applicationRecordId !== entry.applicationRecordId
        ) {
          throw new Error(
            `Answer for question '${entry.questionId}' no longer has exact application lineage for decision '${pending.id}'; the whole group is aborted.`,
          );
        }
        const baseAnswer = {
          id: groupedAnswerRecordId(pending.id, entry.questionId),
          runId: question.runId,
          jobId: question.jobId,
          applicationRecordId: entry.applicationRecordId,
          resultId: question.resultId,
          questionId: question.id,
          status: "suggested" as const,
          text: approved.decision.answer.value,
          value: {
            type: "text" as const,
            value: approved.decision.answer.value,
          },
          saveScope: "reusable_profile" as const,
          sourceKind: "user" as const,
          sourceId: `grouped_decision_${pending.id}`,
          confidenceLabel: "Approved by the user for reuse across applications",
          provenance: [
            {
              id: `grouped_answer_provenance_${pending.id}_${entry.questionId}`,
              sourceKind: "user" as const,
              sourceId: pending.id,
              label: "Approved grouped reusable answer",
              snippet: question.prompt,
            },
          ],
          createdAt: occurredAt,
          submittedAt: null,
        };

        if (entry.expectedAnswerRevision > 0) {
          if (!latest || latest.revision !== entry.expectedAnswerRevision) {
            throw new Error(
              `Answer for question '${entry.questionId}' is no longer at revision ${entry.expectedAnswerRevision}.`,
            );
          }
          expectedAnswers.push(latest);
          nextAnswers.push(
            ApplicationAnswerRecordSchema.parse({
              ...baseAnswer,
              revision: latest.revision + 1,
              supersedesAnswerId: latest.id,
              provenance: [...latest.provenance, ...baseAnswer.provenance],
            }),
          );
        } else {
          // Critical architecture decision: a revision-0 member gets its first
          // revision-1 suggested answer inside the same atomic commit as the
          // decision approval, request verifying transition, answered question,
          // and event. Nothing is deferred until resumption.
          nextAnswers.push(
            ApplicationAnswerRecordSchema.parse({
              ...baseAnswer,
              revision: 1,
              supersedesAnswerId: null,
            }),
          );
        }
        const answer = nextAnswers.at(-1)!;
        nextQuestions.push({
          ...question,
          selectedAnswerId: answer.id,
          submittedAnswer: answer.text,
          status: "answered",
        });
      }

      const result = await ctx.repository.commitGroupedManualAnswer({
        expectedDecision: pending,
        decision: approved.decision,
        lineage: approved.lineage,
        requests: approved.requests,
        expectedQuestions,
        questions: nextQuestions,
        expectedAnswers,
        answers: nextAnswers,
      });
      if (result.status === "stale") {
        throw new Error(result.failure.message);
      }
      // "applied" and "duplicate" both mean the exact full lineage is persisted.
    });
  }

  async function snoozeGroupedDecisionOnce(
    command: SnoozeGroupedDecisionInput,
  ): Promise<void> {
    await ctx.withIntelligenceTransition(async () => {
      const intelligence = await ctx.repository.getIntelligenceState();
      const decision =
        intelligence.groupedDecisions.find(
          (candidate) => candidate.id === command.decisionId,
        ) ?? null;
      if (!decision) {
        throw new Error(
          `Grouped decision '${command.decisionId}' does not exist.`,
        );
      }
      const result = snoozeGroupedDecision({
        decision,
        command,
        occurredAt: new Date().toISOString(),
      });
      if (!result.ok) {
        throw new Error(result.failure.message);
      }
      await ctx.repository.saveIntelligenceState(
        JobFinderIntelligenceStateSchema.parse({
          ...intelligence,
          groupedDecisions: intelligence.groupedDecisions.map((candidate) =>
            candidate.id === result.decision.id ? result.decision : candidate,
          ),
          updatedAt: result.decision.updatedAt,
        }),
      );
    });
  }

  return {
    async projectGroupedManualAnswer(
      rawCommand: ProjectGroupedManualAnswerCommand,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = ProjectGroupedManualAnswerCommandSchema.parse(rawCommand);
      await projectGroupedManualAnswerOnce(command);
      return getWorkspaceSnapshot();
    },
    async applyGroupedManualAnswer(
      rawCommand: ApplyGroupedManualAnswerInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = ApplyGroupedManualAnswerInputSchema.parse(rawCommand);
      await applyGroupedManualAnswerOnce(command);
      // Both "applied" and "duplicate" commits persist the verifying request
      // transitions; resume every member through the verifying user-action
      // resumer before returning the snapshot. The resumer stays
      // single-flight and a crash between the commit and this resume still
      // recovers on the next restart.
      await resumeVerifyingUserActions();
      return getWorkspaceSnapshot();
    },
    async snoozeGroupedDecision(
      rawCommand: SnoozeGroupedDecisionInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const command = SnoozeGroupedDecisionInputSchema.parse(rawCommand);
      await snoozeGroupedDecisionOnce(command);
      return getWorkspaceSnapshot();
    },
  };
}
