import type {
  ApplicationAnswerRecord,
  ApplicationQuestionRecord,
  GroupedDecisionJobLineage,
  GroupedManualAnswerDecision,
  UserActionRequest,
} from "@nestor/contracts";

/**
 * Input to the atomic grouped manual-answer repository commit. The caller
 * supplies the already-approved pure operation output (approved decision,
 * stamped lineage, verifying requests) plus the exact next answer/question
 * records to persist and the exact persisted values each record must match
 * right now. Questions have no persisted revision, so their compare-and-swap
 * is the full expected value; answers CAS on the expected record (revision
 * included); the decision CASes on the pending expected decision.
 */
export interface CommitGroupedManualAnswerInput {
  /** The pending decision exactly as persisted; the decision CAS baseline. */
  expectedDecision: GroupedManualAnswerDecision;
  /** The decision as approved. */
  decision: GroupedManualAnswerDecision;
  /** The decision's job lineage, stamped with when it applied. */
  lineage: readonly GroupedDecisionJobLineage[];
  /** The user action requests the approval moved to verifying. */
  requests: readonly UserActionRequest[];
  /** Persisted question records as of projection (full-value CAS baseline). */
  expectedQuestions: readonly ApplicationQuestionRecord[];
  /** Question records to persist exactly as supplied (never re-stamped). */
  questions: readonly ApplicationQuestionRecord[];
  /** Persisted latest answer records as of projection; empty when none exist. */
  expectedAnswers: readonly ApplicationAnswerRecord[];
  /** Answer records to persist exactly as supplied (never re-stamped). */
  answers: readonly ApplicationAnswerRecord[];
}

export type GroupedManualAnswerCommitFailure =
  | {
      code: "stale_request";
      message: string;
      requestId: string;
      expectedRevision: number;
      currentRevision: number | null;
    }
  | {
      code: "stale_answer";
      message: string;
      questionId: string;
      expectedRevision: number;
      currentRevision: number | null;
    }
  | {
      code: "stale_question";
      message: string;
      questionId: string;
    }
  | {
      code: "stale_decision";
      message: string;
      decisionId: string;
      expectedRevision: number;
      currentRevision: number | null;
    }
  | {
      code: "stale_event";
      message: string;
      requestId: string;
      eventId: string;
      expectedRevision: number;
      currentRevision: number | null;
    };

export type CommitGroupedManualAnswerResult =
  | {
      status: "applied";
      decision: GroupedManualAnswerDecision;
      lineage: readonly GroupedDecisionJobLineage[];
      requests: readonly UserActionRequest[];
    }
  | {
      status: "duplicate";
      decision: GroupedManualAnswerDecision;
      lineage: readonly GroupedDecisionJobLineage[];
      requests: readonly UserActionRequest[];
    }
  | {
      status: "stale";
      failure: GroupedManualAnswerCommitFailure;
    };
