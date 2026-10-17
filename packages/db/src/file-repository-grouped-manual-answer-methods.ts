import {
  ApplicationAnswerRecordSchema,
  ApplicationQuestionRecordSchema,
  JobFinderIntelligenceStateSchema,
  UserActionEventSchema,
  UserActionRequestSchema,
  type ApplicationAnswerRecord,
  type ApplicationQuestionRecord,
  type JobFinderIntelligenceState,
  type UserActionEvent,
  type UserActionRequest,
} from "@nestor/contracts";

import { APPLY_INDEXED_COLLECTION_CONFIGS } from "./apply-collection-support";
import {
  runImmediateTransaction,
  type FileRepositoryContext,
} from "./file-repository-support";
import {
  cloneValue,
  getSingletonValue,
  listCollectionValues,
  saveSingletonValue,
} from "./internal/state";
import { secureDatabaseFile } from "./internal/migrations";
import {
  latestApplicationAnswerRecord,
  normalizeGroupedManualAnswerCommit,
  resolveGroupedManualAnswerCommit,
  type GroupedManualAnswerCurrentSnapshot,
} from "./grouped-manual-answer-support";
import type { CommitGroupedManualAnswerResult } from "./grouped-manual-answer-types";
import { USER_ACTION_INDEXED_COLLECTION_CONFIGS } from "./user-action-repository-support";
import type { JobFinderRepository } from "./repository-types";

function listRequestsById(
  context: FileRepositoryContext,
  id: string,
): UserActionRequest | null {
  return (
    listCollectionValues(
      context.database,
      "user_action_requests",
      UserActionRequestSchema,
      {
        whereSql: "id = ?",
        params: [id],
        orderBySql: "updated_at DESC, id ASC",
      },
    )[0] ?? null
  );
}

function listAllUserActionEvents(
  context: FileRepositoryContext,
): UserActionEvent[] {
  return listCollectionValues(
    context.database,
    "user_action_events",
    UserActionEventSchema,
    { orderBySql: "occurred_at ASC, id ASC" },
  );
}

function listAnswersByQuestionId(
  context: FileRepositoryContext,
  questionId: string,
): ApplicationAnswerRecord[] {
  return listCollectionValues(
    context.database,
    "application_answer_records",
    ApplicationAnswerRecordSchema,
    {
      whereSql: "question_id = ?",
      params: [questionId],
      orderBySql: "created_at ASC, id ASC",
    },
  );
}

function getQuestionRecordById(
  context: FileRepositoryContext,
  id: string,
): ApplicationQuestionRecord | null {
  return (
    listCollectionValues(
      context.database,
      "application_question_records",
      ApplicationQuestionRecordSchema,
      {
        whereSql: "id = ?",
        params: [id],
        orderBySql: "detected_at ASC, id ASC",
      },
    )[0] ?? null
  );
}

function readIntelligenceState(
  context: FileRepositoryContext,
): JobFinderIntelligenceState {
  return (
    getSingletonValue(
      context.database,
      "intelligence_state",
      JobFinderIntelligenceStateSchema,
    ) ?? JobFinderIntelligenceStateSchema.parse({})
  );
}

function upsertUserActionRequest(
  context: FileRepositoryContext,
  request: UserActionRequest,
): void {
  const columns = USER_ACTION_INDEXED_COLLECTION_CONFIGS.user_action_requests;
  context.database
    .prepare(
      `
      INSERT INTO user_action_requests (
        id, dedupe_key, revision, kind, state, scope_type,
        application_record_id, updated_at, value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dedupe_key = excluded.dedupe_key,
        revision = excluded.revision,
        kind = excluded.kind,
        state = excluded.state,
        scope_type = excluded.scope_type,
        application_record_id = excluded.application_record_id,
        updated_at = excluded.updated_at,
        value = excluded.value
    `,
    )
    .run(request.id, ...columns.getColumns(request), JSON.stringify(request));
}

function insertUserActionEvent(
  context: FileRepositoryContext,
  event: UserActionEvent,
): void {
  const columns = USER_ACTION_INDEXED_COLLECTION_CONFIGS.user_action_events;
  context.database
    .prepare(
      `
      INSERT INTO user_action_events (
        id, request_id, operation, previous_revision, resulting_revision,
        occurred_at, value
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(event.id, ...columns.getColumns(event), JSON.stringify(event));
}

function upsertApplicationAnswerRecord(
  context: FileRepositoryContext,
  record: ApplicationAnswerRecord,
): void {
  const columns = APPLY_INDEXED_COLLECTION_CONFIGS.application_answer_records;
  context.database
    .prepare(
      `
      INSERT OR REPLACE INTO application_answer_records (
        id, run_id, job_id, application_record_id, result_id, question_id,
        created_at, value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(record.id, ...columns.getColumns(record), JSON.stringify(record));
}

function upsertApplicationQuestionRecord(
  context: FileRepositoryContext,
  record: ApplicationQuestionRecord,
): void {
  const columns = APPLY_INDEXED_COLLECTION_CONFIGS.application_question_records;
  context.database
    .prepare(
      `
      INSERT OR REPLACE INTO application_question_records (
        id, run_id, job_id, application_record_id, result_id, detected_at, value
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(record.id, ...columns.getColumns(record), JSON.stringify(record));
}

/**
 * SQLite implementation of the atomic grouped manual-answer commit. The whole
 * commit (request transitions, transition events, answer records, question
 * records, and the intelligence decision) runs inside one immediate
 * transaction, so any stale member or write error rolls everything back.
 * Deterministic per-request event ids make a retried commit recognizable as a
 * duplicate instead of being re-applied.
 */
export function createFileRepositoryGroupedManualAnswerMethods(
  context: FileRepositoryContext,
): Pick<JobFinderRepository, "commitGroupedManualAnswer"> {
  return {
    commitGroupedManualAnswer(input) {
      const plan = normalizeGroupedManualAnswerCommit(input);
      let result: CommitGroupedManualAnswerResult | null = null;

      runImmediateTransaction(context.database, () => {
        const requests = new Map<string, UserActionRequest>();
        for (const entry of plan.lineage) {
          const request = listRequestsById(context, entry.requestId);
          if (request) {
            requests.set(entry.requestId, request);
          }
        }

        const answersByQuestionId = new Map<
          string,
          ApplicationAnswerRecord | null
        >();
        const questionIds = [...plan.expectedAnswerRevisionByQuestionId.keys()];
        for (const questionId of questionIds) {
          answersByQuestionId.set(
            questionId,
            latestApplicationAnswerRecord(
              listAnswersByQuestionId(context, questionId),
              questionId,
            ),
          );
        }

        const questions = new Map<string, ApplicationQuestionRecord>();
        for (const change of plan.questionChanges) {
          const question = getQuestionRecordById(context, change.next.id);
          if (question) {
            questions.set(change.next.id, question);
          }
        }

        const intelligence = readIntelligenceState(context);
        const decision =
          intelligence.groupedDecisions.find(
            (candidate) => candidate.id === plan.decision.id,
          ) ?? null;

        const snapshot: GroupedManualAnswerCurrentSnapshot = {
          requests,
          answersByQuestionId,
          questions,
          decision,
          events: listAllUserActionEvents(context),
        };
        const outcome = resolveGroupedManualAnswerCommit(plan, snapshot);
        if (outcome.status === "stale" || outcome.status === "duplicate") {
          result = outcome;
          return;
        }

        for (const entry of plan.lineage) {
          upsertUserActionRequest(
            context,
            plan.requestsByRequestId.get(entry.requestId)!,
          );
        }
        for (const event of outcome.events) {
          insertUserActionEvent(context, event);
        }
        for (const change of plan.answerChanges) {
          upsertApplicationAnswerRecord(context, change.next);
        }
        for (const change of plan.questionChanges) {
          upsertApplicationQuestionRecord(context, change.next);
        }
        saveSingletonValue(context.database, "intelligence_state", {
          ...intelligence,
          groupedDecisions: intelligence.groupedDecisions.map((candidate) =>
            candidate.id === plan.decision.id ? plan.decision : candidate,
          ),
          updatedAt: plan.appliedAt,
        });

        result = {
          status: "applied",
          decision: plan.decision,
          lineage: plan.lineage,
          requests: plan.lineage.map(
            (entry) => plan.requestsByRequestId.get(entry.requestId)!,
          ),
        };
      });

      if (!result) {
        throw new Error(
          "Grouped manual-answer commit did not produce a result.",
        );
      }
      const committedResult: CommitGroupedManualAnswerResult = result;
      return secureDatabaseFile(context.filePath).then(() =>
        cloneValue(committedResult),
      );
    },
  };
}
