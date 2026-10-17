import {
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplySubmitApprovalSchema,
  ApplicationAnswerRecordSchema,
  ApplicationArtifactRefSchema,
  ApplicationConsentRequestSchema,
  ApplicationQuestionRecordSchema,
  ApplicationReplayCheckpointSchema,
  ApplicationAttemptSchema,
  type ApplyJobResult,
} from "@nestor/contracts";
import type { SQLInputValue } from "node:sqlite";

export const APPLY_INDEXED_COLLECTION_CONFIGS = {
  apply_runs: {
    columnNames: ["created_at", "updated_at", "mode", "state"],
    getColumns: (value: unknown) => {
      const run = ApplyRunSchema.parse(value);
      return [run.createdAt, run.updatedAt, run.mode, run.state];
    },
  },
  apply_job_results: {
    columnNames: [
      "run_id",
      "job_id",
      "application_record_id",
      "application_preparation_started_at",
      "application_preparation_started_local_date",
      "queue_position",
      "updated_at",
      "state",
    ],
    getColumns: (value: unknown) => {
      const result = ApplyJobResultSchema.parse(value);
      return [
        result.runId,
        result.jobId,
        result.applicationRecordId,
        result.applicationPreparationStartedAt ?? null,
        result.applicationPreparationStartedLocalDate ?? null,
        result.queuePosition,
        result.updatedAt,
        result.state,
      ];
    },
  },
  apply_submit_approvals: {
    columnNames: ["run_id", "created_at", "status"],
    getColumns: (value: unknown) => {
      const approval = ApplySubmitApprovalSchema.parse(value);
      return [approval.runId, approval.createdAt, approval.status];
    },
  },
  application_question_records: {
    columnNames: [
      "run_id",
      "job_id",
      "application_record_id",
      "result_id",
      "detected_at",
    ],
    getColumns: (value: unknown) => {
      const record = ApplicationQuestionRecordSchema.parse(value);
      return [
        record.runId,
        record.jobId,
        record.applicationRecordId,
        record.resultId,
        record.detectedAt,
      ];
    },
  },
  application_answer_records: {
    columnNames: [
      "run_id",
      "job_id",
      "application_record_id",
      "result_id",
      "question_id",
      "created_at",
    ],
    getColumns: (value: unknown) => {
      const record = ApplicationAnswerRecordSchema.parse(value);
      return [
        record.runId,
        record.jobId,
        record.applicationRecordId,
        record.resultId,
        record.questionId,
        record.createdAt,
      ];
    },
  },
  application_artifact_refs: {
    columnNames: [
      "run_id",
      "job_id",
      "application_record_id",
      "result_id",
      "created_at",
      "kind",
    ],
    getColumns: (value: unknown) => {
      const ref = ApplicationArtifactRefSchema.parse(value);
      return [
        ref.runId,
        ref.jobId,
        ref.applicationRecordId,
        ref.resultId,
        ref.createdAt,
        ref.kind,
      ];
    },
  },
  application_replay_checkpoints: {
    columnNames: [
      "run_id",
      "job_id",
      "application_record_id",
      "result_id",
      "created_at",
    ],
    getColumns: (value: unknown) => {
      const checkpoint = ApplicationReplayCheckpointSchema.parse(value);
      return [
        checkpoint.runId,
        checkpoint.jobId,
        checkpoint.applicationRecordId,
        checkpoint.resultId,
        checkpoint.createdAt,
      ];
    },
  },
  application_consent_requests: {
    columnNames: [
      "run_id",
      "job_id",
      "application_record_id",
      "result_id",
      "requested_at",
      "status",
    ],
    getColumns: (value: unknown) => {
      const request = ApplicationConsentRequestSchema.parse(value);
      return [
        request.runId,
        request.jobId,
        request.applicationRecordId,
        request.resultId,
        request.requestedAt,
        request.status,
      ];
    },
  },
} as const;

export function assertApplicationPreparationStartPreserved(
  current: ApplyJobResult,
  proposed: ApplyJobResult,
): void {
  if (
    current.applicationPreparationStartedAt === null ||
    current.applicationPreparationStartedAt === undefined
  ) {
    return;
  }

  if (
    proposed.applicationPreparationStartedAt !==
      current.applicationPreparationStartedAt ||
    proposed.applicationPreparationStartedLocalDate !==
      current.applicationPreparationStartedLocalDate
  ) {
    throw new Error(
      "Application preparation start is immutable once committed.",
    );
  }
}

export const APPLICATION_ATTEMPT_INDEXED_COLLECTION_CONFIG = {
  columnNames: ["job_id", "application_record_id", "updated_at"],
  getColumns: (value: unknown) => {
    const attempt = ApplicationAttemptSchema.parse(value);
    return [attempt.jobId, attempt.applicationRecordId, attempt.updatedAt];
  },
} as const;

export const APPLY_COLLECTION_ORDER_BY_SQL = {
  apply_runs: "updated_at DESC, id ASC",
  apply_job_results: "updated_at DESC, queue_position ASC, id ASC",
  apply_submit_approvals: "created_at DESC, id ASC",
  application_question_records: "detected_at ASC, id ASC",
  application_answer_records: "created_at ASC, id ASC",
  application_artifact_refs: "created_at DESC, id ASC",
  application_replay_checkpoints: "created_at DESC, id ASC",
  application_consent_requests: "requested_at DESC, id ASC",
} as const;

const APPLY_FILTER_COLUMN_NAMES: ReadonlySet<string> = new Set([
  "id",
  ...Object.values(APPLY_INDEXED_COLLECTION_CONFIGS).flatMap(
    (config) => config.columnNames,
  ),
]);

export function buildOptionalSqlFilters(
  filters: ReadonlyArray<
    readonly [columnName: string, value: string | undefined]
  >,
): {
  whereSql?: string;
  params?: SQLInputValue[];
} {
  const params: SQLInputValue[] = [];
  const clauses: string[] = [];

  for (const [columnName, value] of filters) {
    if (value === undefined) {
      continue;
    }

    if (!APPLY_FILTER_COLUMN_NAMES.has(columnName)) {
      throw new Error(
        `Unsupported apply collection filter column '${columnName}'.`,
      );
    }

    // SAFETY: columnName is validated against APPLY_FILTER_COLUMN_NAMES above.
    // Values stay parameterized through params.push(value), so only whitelisted identifiers are interpolated.
    clauses.push(`${columnName} = ?`);
    params.push(value);
  }

  return {
    ...(clauses.length > 0 ? { whereSql: clauses.join(" AND ") } : {}),
    ...(params.length > 0 ? { params } : {}),
  };
}

export function matchesOptionalStringFilters<
  TValue extends Record<string, unknown>,
>(
  value: TValue,
  filters: ReadonlyArray<
    readonly [fieldName: keyof TValue, expected: string | undefined]
  >,
): boolean {
  return filters.every(
    ([fieldName, expected]) =>
      expected === undefined || value[fieldName] === expected,
  );
}

function sortByDateDesc<TValue extends { id: string }>(
  values: readonly TValue[],
  getDate: (value: TValue) => string,
): TValue[] {
  return [...values].sort((left, right) => {
    const difference =
      new Date(getDate(right)).getTime() - new Date(getDate(left)).getTime();
    return difference !== 0 ? difference : left.id.localeCompare(right.id);
  });
}

function sortByDateAsc<TValue extends { id: string }>(
  values: readonly TValue[],
  getDate: (value: TValue) => string,
): TValue[] {
  return [...values].sort((left, right) => {
    const difference =
      new Date(getDate(left)).getTime() - new Date(getDate(right)).getTime();
    return difference !== 0 ? difference : left.id.localeCompare(right.id);
  });
}

export function sortApplyRuns<TValue extends { id: string; updatedAt: string }>(
  values: readonly TValue[],
): TValue[] {
  return sortByDateDesc(values, (value) => value.updatedAt);
}

export function sortApplyJobResults<
  TValue extends { id: string; updatedAt: string; queuePosition: number },
>(values: readonly TValue[]): TValue[] {
  return [...values].sort((left, right) => {
    const difference =
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    return difference !== 0
      ? difference
      : left.queuePosition - right.queuePosition ||
          left.id.localeCompare(right.id);
  });
}

export function sortApplySubmitApprovals<
  TValue extends { id: string; createdAt: string },
>(values: readonly TValue[]): TValue[] {
  return sortByDateDesc(values, (value) => value.createdAt);
}

export function sortApplicationQuestionRecords<
  TValue extends { id: string; detectedAt: string },
>(values: readonly TValue[]): TValue[] {
  return sortByDateAsc(values, (value) => value.detectedAt);
}

export function sortApplicationAnswerRecords<
  TValue extends { id: string; createdAt: string },
>(values: readonly TValue[]): TValue[] {
  return sortByDateAsc(values, (value) => value.createdAt);
}

export function sortApplicationArtifactRefs<
  TValue extends { id: string; createdAt: string },
>(values: readonly TValue[]): TValue[] {
  return sortByDateDesc(values, (value) => value.createdAt);
}

export function sortApplicationReplayCheckpoints<
  TValue extends { id: string; createdAt: string },
>(values: readonly TValue[]): TValue[] {
  return sortByDateDesc(values, (value) => value.createdAt);
}

export function sortApplicationConsentRequests<
  TValue extends { id: string; requestedAt: string },
>(values: readonly TValue[]): TValue[] {
  return sortByDateDesc(values, (value) => value.requestedAt);
}
