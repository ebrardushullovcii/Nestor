import {
  AppendRapidReviewDecisionInputSchema,
  type AppendRapidReviewDecisionInput,
  type AppendRapidReviewDecisionInputData,
  NonEmptyStringSchema,
  type RapidReviewDecision,
  RapidReviewDecisionLogSchema,
  type RapidReviewDecisionLog,
  type RapidReviewUndo,
  RapidReviewUndoSchema,
  type SavedJob,
} from "@nestor/contracts";

/**
 * Pure, append-only operations over `RapidReviewDecisionLog` entries.
 *
 * Every mutating operation returns a fresh log (parsed through
 * `RapidReviewDecisionLogSchema`) and never mutates its inputs. Invalid
 * operations fail with a structured failure instead of throwing, so bulk
 * appends can stay atomic.
 */

export type RapidReviewAppendFailure =
  | { code: "invalid_decision_id"; message: string }
  | { code: "invalid_decision_input"; message: string }
  | { code: "duplicate_decision_id"; message: string }
  | { code: "campaign_mismatch"; message: string }
  | { code: "created_at_regression"; message: string };

export type AppendRapidReviewDecisionResult =
  | { ok: true; log: RapidReviewDecisionLog; entry: RapidReviewDecision }
  | { ok: false; failure: RapidReviewAppendFailure };

export interface RapidReviewDecisionAppendCandidate {
  /** Caller-generated id; the operations never mint ids themselves. */
  decisionId: string;
  decision: AppendRapidReviewDecisionInputData;
}

export type AppendRapidReviewDecisionsResult =
  | { ok: true; log: RapidReviewDecisionLog; entries: RapidReviewDecision[] }
  | { ok: false; failure: RapidReviewAppendFailure };

export type RapidReviewUndoFailure =
  | { code: "invalid_undo_metadata"; message: string }
  | { code: "no_active_decision"; message: string }
  | {
      code: "revision_mismatch";
      message: string;
      expectedRevision: number;
      currentRevision: number;
    };

export type UndoRapidReviewDecisionResult =
  | { ok: true; log: RapidReviewDecisionLog; entry: RapidReviewDecision }
  | { ok: false; failure: RapidReviewUndoFailure };

interface ZodIssueLike {
  message?: string;
}

interface ZodErrorLike {
  issues: readonly ZodIssueLike[];
}

function firstIssueMessage(error: ZodErrorLike): string {
  return error.issues[0]?.message ?? "Invalid value.";
}

function normalizeLog(log: RapidReviewDecisionLog): RapidReviewDecisionLog {
  return RapidReviewDecisionLogSchema.parse(log);
}

type ParsedId = { ok: true; id: string } | { ok: false; message: string };

function parseDecisionId(decisionId: string): ParsedId {
  const parsed = NonEmptyStringSchema.safeParse(decisionId);

  if (!parsed.success) {
    return { ok: false, message: "Decision id must be a non-empty string." };
  }

  return { ok: true, id: parsed.data };
}

type ParsedDecisionInput =
  | { ok: true; input: AppendRapidReviewDecisionInput }
  | { ok: false; message: string };

function parseDecisionInput(
  decision: AppendRapidReviewDecisionInputData,
): ParsedDecisionInput {
  const parsed = AppendRapidReviewDecisionInputSchema.safeParse(decision);

  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }

  return { ok: true, input: parsed.data };
}

function findLatestActiveIndex(
  log: RapidReviewDecisionLog,
  jobId: string,
): number {
  for (let index = log.entries.length - 1; index >= 0; index -= 1) {
    const entry = log.entries[index]!;

    if (entry.jobId === jobId && entry.undo === null) {
      return index;
    }
  }

  return -1;
}

/**
 * Appends a single decision, using the caller-provided `decisionId`, and
 * returns a parsed copy of the extended log. The append fails when the id
 * already exists, the campaign mismatches, or the entry would regress the
 * append-only createdAt ordering.
 */
export function appendRapidReviewDecision(input: {
  log: RapidReviewDecisionLog;
  decisionId: string;
  decision: AppendRapidReviewDecisionInputData;
}): AppendRapidReviewDecisionResult {
  const log = normalizeLog(input.log);
  const idResult = parseDecisionId(input.decisionId);

  if (!idResult.ok) {
    return {
      ok: false,
      failure: { code: "invalid_decision_id", message: idResult.message },
    };
  }

  const decisionResult = parseDecisionInput(input.decision);

  if (!decisionResult.ok) {
    return {
      ok: false,
      failure: {
        code: "invalid_decision_input",
        message: decisionResult.message,
      },
    };
  }

  const entryInput = decisionResult.input;

  if (entryInput.campaignId !== log.campaignId) {
    return {
      ok: false,
      failure: {
        code: "campaign_mismatch",
        message: `Decision campaign "${entryInput.campaignId}" does not match log campaign "${log.campaignId}".`,
      },
    };
  }

  if (log.entries.some((entry) => entry.id === idResult.id)) {
    return {
      ok: false,
      failure: {
        code: "duplicate_decision_id",
        message: `Decision id "${idResult.id}" already exists in the log.`,
      },
    };
  }

  const lastCreatedAt = log.entries.at(-1)?.createdAt ?? null;

  if (
    lastCreatedAt !== null &&
    Date.parse(entryInput.createdAt) < Date.parse(lastCreatedAt)
  ) {
    return {
      ok: false,
      failure: {
        code: "created_at_regression",
        message:
          "Decisions must be appended in non-decreasing createdAt order.",
      },
    };
  }

  const nextLog = RapidReviewDecisionLogSchema.parse({
    campaignId: log.campaignId,
    entries: [
      ...log.entries,
      {
        ...entryInput,
        id: idResult.id,
        updatedAt: entryInput.createdAt,
      },
    ],
  });

  return { ok: true, log: nextLog, entry: nextLog.entries.at(-1)! };
}

/**
 * Appends a batch of caller-provided decisions atomically: the whole batch is
 * validated (ids unique across the log and the batch, campaign match,
 * non-decreasing createdAt) before any entry is applied, so a failing batch
 * leaves the log untouched.
 */
export function appendRapidReviewDecisions(input: {
  log: RapidReviewDecisionLog;
  decisions: readonly RapidReviewDecisionAppendCandidate[];
}): AppendRapidReviewDecisionsResult {
  const log = normalizeLog(input.log);
  const seenIds = new Set(log.entries.map((entry) => entry.id));
  const nextEntries: RapidReviewDecision[] = [...log.entries];
  let lastCreatedAt = log.entries.at(-1)?.createdAt ?? null;

  for (const candidate of input.decisions) {
    const idResult = parseDecisionId(candidate.decisionId);

    if (!idResult.ok) {
      return {
        ok: false,
        failure: { code: "invalid_decision_id", message: idResult.message },
      };
    }

    const decisionResult = parseDecisionInput(candidate.decision);

    if (!decisionResult.ok) {
      return {
        ok: false,
        failure: {
          code: "invalid_decision_input",
          message: decisionResult.message,
        },
      };
    }

    const entryInput = decisionResult.input;

    if (entryInput.campaignId !== log.campaignId) {
      return {
        ok: false,
        failure: {
          code: "campaign_mismatch",
          message: `Decision campaign "${entryInput.campaignId}" does not match log campaign "${log.campaignId}".`,
        },
      };
    }

    if (seenIds.has(idResult.id)) {
      return {
        ok: false,
        failure: {
          code: "duplicate_decision_id",
          message: `Decision id "${idResult.id}" already exists in the log or the batch.`,
        },
      };
    }

    if (
      lastCreatedAt !== null &&
      Date.parse(entryInput.createdAt) < Date.parse(lastCreatedAt)
    ) {
      return {
        ok: false,
        failure: {
          code: "created_at_regression",
          message:
            "Decisions must be appended in non-decreasing createdAt order.",
        },
      };
    }

    seenIds.add(idResult.id);
    lastCreatedAt = entryInput.createdAt;
    nextEntries.push({
      ...entryInput,
      id: idResult.id,
      updatedAt: entryInput.createdAt,
      undo: null,
    });
  }

  const nextLog = RapidReviewDecisionLogSchema.parse({
    campaignId: log.campaignId,
    entries: nextEntries,
  });

  return {
    ok: true,
    log: nextLog,
    entries: nextLog.entries.slice(log.entries.length),
  };
}

/**
 * Undoes the latest active (non-undone) decision for a job, but only when its
 * revision matches `expectedRevision`. The caller supplies the full undo
 * metadata (undoneAt, reason, restoringDecisionId); the target entry is
 * stamped with it and its `updatedAt` is advanced to `undoneAt`.
 */
export function undoLatestActiveRapidReviewDecision(input: {
  log: RapidReviewDecisionLog;
  jobId: string;
  expectedRevision: number;
  undo: RapidReviewUndo;
}): UndoRapidReviewDecisionResult {
  const log = normalizeLog(input.log);
  const undoResult = RapidReviewUndoSchema.safeParse(input.undo);

  if (!undoResult.success) {
    return {
      ok: false,
      failure: {
        code: "invalid_undo_metadata",
        message: firstIssueMessage(undoResult.error),
      },
    };
  }

  const targetIndex = findLatestActiveIndex(log, input.jobId);

  if (targetIndex < 0) {
    return {
      ok: false,
      failure: {
        code: "no_active_decision",
        message: `No active decision exists for job "${input.jobId}".`,
      },
    };
  }

  const target = log.entries[targetIndex]!;

  if (target.revision !== input.expectedRevision) {
    return {
      ok: false,
      failure: {
        code: "revision_mismatch",
        message: `Expected revision ${input.expectedRevision} but latest active decision for job "${input.jobId}" has revision ${target.revision}.`,
        expectedRevision: input.expectedRevision,
        currentRevision: target.revision,
      },
    };
  }

  const nextLog = RapidReviewDecisionLogSchema.parse({
    campaignId: log.campaignId,
    entries: log.entries.map((entry, index) =>
      index === targetIndex
        ? {
            ...entry,
            undo: undoResult.data,
            updatedAt: undoResult.data.undoneAt,
          }
        : entry,
    ),
  });

  return { ok: true, log: nextLog, entry: nextLog.entries[targetIndex]! };
}

/**
 * Derives the current decision for a job: the latest entry in append order
 * that has not been undone, or null when the job has no active decision.
 */
export function deriveCurrentRapidReviewDecision(input: {
  log: RapidReviewDecisionLog;
  jobId: string;
}): RapidReviewDecision | null {
  const log = normalizeLog(input.log);
  const index = findLatestActiveIndex(log, input.jobId);

  return index < 0 ? null : (log.entries[index] ?? null);
}

/**
 * Returns the first job in the caller-supplied (stable) order that has no
 * current decision, or null when every job is decided. A job whose latest
 * decision was undone counts as undecided.
 */
export function deriveNextUndecidedJob(input: {
  log: RapidReviewDecisionLog;
  jobs: readonly SavedJob[];
}): SavedJob | null {
  const log = normalizeLog(input.log);
  const decidedJobIds = new Set<string>();

  for (const entry of log.entries) {
    if (entry.undo === null) {
      decidedJobIds.add(entry.jobId);
    }
  }

  for (const job of input.jobs) {
    if (!decidedJobIds.has(job.id)) {
      return job;
    }
  }

  return null;
}
