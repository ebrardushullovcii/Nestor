/**
 * Pure, immutable operations over `JobFinderIntelligenceSafeguards`.
 *
 * Every function validates its inputs with the existing safeguard schemas from
 * `@nestor/contracts` and returns freshly schema-parsed values. Inputs are
 * never mutated and ids/timestamps/evidence are always supplied by the caller;
 * the operations never mint ids, clocks, or evidence themselves.
 *
 * Conservativeness guarantees:
 * - Company caps count only caller-supplied qualifying application evidence for
 *   the cap's own company. Nothing is inferred from job titles, and evidence
 *   for another company is ignored rather than counted.
 * - Listing signals are recorded verbatim from the caller; `provenance` is a
 *   required field and `suspicious` is never inferred from weak title
 *   heuristics.
 * - Contradiction detections are advisory. The deterministic gate returns them
 *   last with `severity: "advisory"` and never blocks on them while a real
 *   blocker exists.
 * - No operation holds authority over credentials, login, CAPTCHA, MFA,
 *   consent, account creation, uploads, redirects, or final submission.
 */

import { createHash } from "node:crypto";

import {
  AbnormalFailurePauseSchema,
  CompanyApplicationCapSchema,
  ContradictoryAnswerDetectionSchema,
  IsoDateTimeSchema,
  JobFinderIntelligenceSafeguardsSchema,
  ListingSignalRecordSchema,
  NonEmptyStringSchema,
  PreparedBatchSampleReviewSchema,
  SafeguardDismissalSchema,
  SimultaneousApplicationConflictSchema,
  type AbnormalFailurePause,
  type CompanyApplicationCap,
  type ContradictoryAnswerDetection,
  type JobFinderIntelligenceSafeguards,
  type ListingSignal,
  type ListingSignalRecord,
  type PreparedBatchSampleReview,
  type SafeguardDismissal,
  type SafeguardDismissalReason,
  type SafeguardEntryKind,
  type SimultaneousApplicationConflict,
} from "@nestor/contracts";

import {
  AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID,
  AUTOMATIC_DISCOVERY_FAILURE_PAUSE_ID,
  AUTOMATIC_SOURCE_DEBUG_FAILURE_PAUSE_ID,
} from "../plan-safeguard-pauses";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export type SafeguardOperationFailure =
  | { code: "invalid_input"; message: string }
  | { code: "duplicate"; message: string }
  | { code: "not_found"; message: string };

interface ZodIssueLike {
  message?: string;
}

interface ZodErrorLike {
  issues: readonly ZodIssueLike[];
}

function firstIssueMessage(error: ZodErrorLike): string {
  return error.issues[0]?.message ?? "Invalid value.";
}

function invalidInput(message: string): SafeguardOperationFailure {
  return { code: "invalid_input", message };
}

function duplicate(message: string): SafeguardOperationFailure {
  return { code: "duplicate", message };
}

function notFound(message: string): SafeguardOperationFailure {
  return { code: "not_found", message };
}

function parseSafeguards(
  value: JobFinderIntelligenceSafeguards,
):
  | { ok: true; safeguards: JobFinderIntelligenceSafeguards }
  | { ok: false; failure: SafeguardOperationFailure } {
  const parsed = JobFinderIntelligenceSafeguardsSchema.safeParse(value);

  if (!parsed.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(parsed.error)),
    };
  }

  return { ok: true, safeguards: parsed.data };
}

type ParsedTimestamp = { ok: true; value: string } | { ok: false };

function parseTimestamp(value: string): ParsedTimestamp {
  const parsed = IsoDateTimeSchema.safeParse(value);

  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

function isNonEmpty(value: string): boolean {
  return NonEmptyStringSchema.safeParse(value).success;
}

const MS_PER_DAY = 86_400_000;

function isWithinWindow(
  millis: number,
  windowStartMillis: number,
  windowDays: number,
): boolean {
  return (
    millis >= windowStartMillis &&
    millis < windowStartMillis + windowDays * MS_PER_DAY
  );
}

function pairKey(first: string, second: string): string {
  return first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
}

// ---------------------------------------------------------------------------
// Company application caps (per company, per time window)
//
// The caller supplies the complete qualifying application evidence set; the
// count is derived from it, so re-applying the same evidence is idempotent.
// Windows are half-open `[start, start + windowDays)` and roll forward: an
// application at or beyond the window end starts a fresh window at the
// earliest such application.
// ---------------------------------------------------------------------------

export type CompanyApplicationEvidence = {
  applicationRecordId: string;
  companyId: string;
  appliedAt: string;
};

export type CompanyCapConfig = {
  companyId: string;
  maxApplicationsPerWindow: number;
  windowDays: number;
  windowStartedAt: string;
  explanation: string;
  recoveryGuidance: string;
};

export type ApplyCompanyApplicationEvidenceSummary = {
  counted: number;
  ignoredCount: number;
  rolledOver: boolean;
};

export type ApplyCompanyApplicationEvidenceResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      cap: CompanyApplicationCap;
      summary: ApplyCompanyApplicationEvidenceSummary;
    }
  | { ok: false; failure: SafeguardOperationFailure };

type CompanyCapMeasurement = {
  windowStartedAt: string;
  currentWindowCount: number;
  ignoredCount: number;
  rolledOver: boolean;
};

function deriveCompanyCapMeasurement(input: {
  evidence: readonly CompanyApplicationEvidence[];
  companyId: string;
  windowDays: number;
  windowStartedAt: string;
}): CompanyCapMeasurement | { failure: string } {
  const parsed: Array<{
    applicationRecordId: string;
    appliedAt: string;
    appliedAtMillis: number;
  }> = [];
  for (const entry of input.evidence) {
    if (!isNonEmpty(entry.applicationRecordId)) {
      return {
        failure: "Application evidence record id must be a non-empty string.",
      };
    }
    const timestamp = parseTimestamp(entry.appliedAt);
    if (!timestamp.ok) {
      return {
        failure: `Application evidence timestamp "${entry.appliedAt}" must be a valid ISO datetime.`,
      };
    }
    // Conservative: only evidence for the cap's own company qualifies.
    if (entry.companyId !== input.companyId) continue;
    parsed.push({
      applicationRecordId: entry.applicationRecordId,
      appliedAt: timestamp.value,
      appliedAtMillis: Date.parse(timestamp.value),
    });
  }

  parsed.sort(
    (first, second) =>
      first.appliedAtMillis - second.appliedAtMillis ||
      first.appliedAt.localeCompare(second.appliedAt) ||
      first.applicationRecordId.localeCompare(second.applicationRecordId),
  );

  const seenRecordIds = new Set<string>();
  const qualifying: typeof parsed = [];
  for (const entry of parsed) {
    if (seenRecordIds.has(entry.applicationRecordId)) continue;
    seenRecordIds.add(entry.applicationRecordId);
    qualifying.push(entry);
  }

  const currentWindowStartMillis = Date.parse(input.windowStartedAt);
  const currentWindowEndMillis =
    currentWindowStartMillis + input.windowDays * MS_PER_DAY;

  let windowStartedAt = input.windowStartedAt;
  let windowStartMillis = currentWindowStartMillis;
  let rolledOver = false;
  const earliestBeyondWindow = qualifying.find(
    (entry) => entry.appliedAtMillis >= currentWindowEndMillis,
  );
  if (earliestBeyondWindow !== undefined) {
    windowStartedAt = earliestBeyondWindow.appliedAt;
    windowStartMillis = earliestBeyondWindow.appliedAtMillis;
    rolledOver = true;
  }

  let counted = 0;
  for (const entry of qualifying) {
    if (
      isWithinWindow(entry.appliedAtMillis, windowStartMillis, input.windowDays)
    ) {
      counted += 1;
    }
  }

  return {
    windowStartedAt,
    currentWindowCount: counted,
    ignoredCount: input.evidence.length - counted,
    rolledOver,
  };
}

/**
 * Measures caller-supplied qualifying application evidence against the
 * company's application cap. The cap's window rolls forward when evidence
 * falls at or beyond the window end; duplicate record ids and evidence for
 * other companies are never counted.
 */
export function applyCompanyApplicationEvidence(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  evidence: readonly CompanyApplicationEvidence[];
  now: string;
  createCapId: () => string;
  config: CompanyCapConfig;
}): ApplyCompanyApplicationEvidenceResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  if (!isNonEmpty(input.config.companyId)) {
    return {
      ok: false,
      failure: invalidInput("Cap company id must be a non-empty string."),
    };
  }
  if (
    !Number.isInteger(input.config.maxApplicationsPerWindow) ||
    input.config.maxApplicationsPerWindow < 1 ||
    input.config.maxApplicationsPerWindow > 200
  ) {
    return {
      ok: false,
      failure: invalidInput(
        "maxApplicationsPerWindow must be an integer between 1 and 200.",
      ),
    };
  }
  if (
    !Number.isInteger(input.config.windowDays) ||
    input.config.windowDays < 1 ||
    input.config.windowDays > 365
  ) {
    return {
      ok: false,
      failure: invalidInput("windowDays must be an integer between 1 and 365."),
    };
  }
  const configWindowResult = parseTimestamp(input.config.windowStartedAt);
  if (!configWindowResult.ok) {
    return {
      ok: false,
      failure: invalidInput(
        "config.windowStartedAt must be a valid ISO datetime.",
      ),
    };
  }
  if (
    !isNonEmpty(input.config.explanation) ||
    !isNonEmpty(input.config.recoveryGuidance)
  ) {
    return {
      ok: false,
      failure: invalidInput(
        "Cap explanation and recovery guidance must be non-empty strings.",
      ),
    };
  }

  const existingCaps = parsedInput.safeguards.companyApplicationCaps;
  const existingIndex = existingCaps.findIndex(
    (cap) => cap.companyId === input.config.companyId,
  );
  const currentWindowStartedAt =
    existingIndex >= 0
      ? existingCaps[existingIndex]!.windowStartedAt
      : configWindowResult.value;

  const measurement = deriveCompanyCapMeasurement({
    evidence: input.evidence,
    companyId: input.config.companyId,
    windowDays: input.config.windowDays,
    windowStartedAt: currentWindowStartedAt,
  });
  if ("failure" in measurement) {
    return { ok: false, failure: invalidInput(measurement.failure) };
  }

  let capId: string;
  if (existingIndex >= 0) {
    capId = existingCaps[existingIndex]!.id;
  } else {
    capId = input.createCapId();
    if (!isNonEmpty(capId)) {
      return {
        ok: false,
        failure: invalidInput("createCapId must return a non-empty string id."),
      };
    }
    if (existingCaps.some((cap) => cap.id === capId)) {
      return {
        ok: false,
        failure: invalidInput(`Cap id "${capId}" already exists.`),
      };
    }
  }

  const capResult = CompanyApplicationCapSchema.safeParse({
    id: capId,
    companyId: input.config.companyId,
    maxApplicationsPerWindow: input.config.maxApplicationsPerWindow,
    windowDays: input.config.windowDays,
    currentWindowCount: measurement.currentWindowCount,
    limitReached:
      measurement.currentWindowCount >= input.config.maxApplicationsPerWindow,
    windowStartedAt: measurement.windowStartedAt,
    explanation: input.config.explanation,
    recoveryGuidance: input.config.recoveryGuidance,
  });
  if (!capResult.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(capResult.error)),
    };
  }
  const cap = capResult.data;

  const caps =
    existingIndex >= 0
      ? existingCaps.map((entry, index) =>
          index === existingIndex ? cap : entry,
        )
      : [...existingCaps, cap];
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    ...parsedInput.safeguards,
    companyApplicationCaps: caps,
    updatedAt: now,
  });

  return {
    ok: true,
    safeguards,
    cap,
    summary: {
      counted: measurement.currentWindowCount,
      ignoredCount: measurement.ignoredCount,
      rolledOver: measurement.rolledOver,
    },
  };
}

// ---------------------------------------------------------------------------
// Simultaneous application conflicts
//
// A conflict requires two distinct application records. Recording the same
// unordered application pair while a conflict is already `detected` is an
// idempotent no-op; after a conflict is resolved, a fresh detection may be
// recorded again.
// ---------------------------------------------------------------------------

export type SimultaneousApplicationConflictInput = {
  conflictId: string;
  applicationRecordId: string;
  conflictingApplicationRecordId: string;
  explanation: string;
  recoveryGuidance: string;
};

export type RecordSimultaneousApplicationConflictResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      conflict: SimultaneousApplicationConflict;
      added: boolean;
    }
  | { ok: false; failure: SafeguardOperationFailure };

function sameConflictContent(
  first: SimultaneousApplicationConflict,
  second: SimultaneousApplicationConflict,
): boolean {
  return (
    first.id === second.id &&
    first.applicationRecordId === second.applicationRecordId &&
    first.conflictingApplicationRecordId ===
      second.conflictingApplicationRecordId &&
    first.status === second.status &&
    first.explanation === second.explanation &&
    first.recoveryGuidance === second.recoveryGuidance
  );
}

/**
 * Records a caller-supplied simultaneous-application conflict. Re-recording
 * the same id with identical content, or the same unordered application pair
 * while a conflict is already detected, is an idempotent no-op.
 */
export function recordSimultaneousApplicationConflict(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  conflict: SimultaneousApplicationConflictInput;
  now: string;
}): RecordSimultaneousApplicationConflictResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  const conflictResult = SimultaneousApplicationConflictSchema.safeParse({
    id: input.conflict.conflictId,
    applicationRecordId: input.conflict.applicationRecordId,
    conflictingApplicationRecordId:
      input.conflict.conflictingApplicationRecordId,
    status: "detected",
    explanation: input.conflict.explanation,
    recoveryGuidance: input.conflict.recoveryGuidance,
  });
  if (!conflictResult.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(conflictResult.error)),
    };
  }
  const conflict = conflictResult.data;

  const conflicts = parsedInput.safeguards.simultaneousApplicationConflicts;
  const existingById = conflicts.find((entry) => entry.id === conflict.id);
  if (existingById !== undefined) {
    if (sameConflictContent(existingById, conflict)) {
      return {
        ok: true,
        safeguards: parsedInput.safeguards,
        conflict: existingById,
        added: false,
      };
    }
    return {
      ok: false,
      failure: duplicate(
        `Conflict id "${conflict.id}" already exists with different content.`,
      ),
    };
  }

  const pair = pairKey(
    conflict.applicationRecordId,
    conflict.conflictingApplicationRecordId,
  );
  const existingPair = conflicts.find(
    (entry) =>
      entry.status === "detected" &&
      pairKey(
        entry.applicationRecordId,
        entry.conflictingApplicationRecordId,
      ) === pair,
  );
  if (existingPair !== undefined) {
    return {
      ok: true,
      safeguards: parsedInput.safeguards,
      conflict: existingPair,
      added: false,
    };
  }

  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    ...parsedInput.safeguards,
    simultaneousApplicationConflicts: [...conflicts, conflict],
    updatedAt: now,
  });

  return { ok: true, safeguards, conflict, added: true };
}

export type ResolveSimultaneousApplicationConflictResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      conflict: SimultaneousApplicationConflict;
      changed: boolean;
    }
  | { ok: false; failure: SafeguardOperationFailure };

/**
 * Marks a detected conflict as resolved. Resolving an already-resolved
 * conflict is an idempotent no-op.
 */
export function resolveSimultaneousApplicationConflict(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  conflictId: string;
  now: string;
}): ResolveSimultaneousApplicationConflictResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  const conflicts = parsedInput.safeguards.simultaneousApplicationConflicts;
  const index = conflicts.findIndex((entry) => entry.id === input.conflictId);
  if (index < 0) {
    return {
      ok: false,
      failure: notFound(`Conflict "${input.conflictId}" does not exist.`),
    };
  }
  const existing = conflicts[index]!;
  if (existing.status === "resolved") {
    return {
      ok: true,
      safeguards: parsedInput.safeguards,
      conflict: existing,
      changed: false,
    };
  }

  const conflict = SimultaneousApplicationConflictSchema.parse({
    ...existing,
    status: "resolved",
  });
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    ...parsedInput.safeguards,
    simultaneousApplicationConflicts: conflicts.map((entry, entryIndex) =>
      entryIndex === index ? conflict : entry,
    ),
    updatedAt: now,
  });

  return { ok: true, safeguards, conflict, changed: true };
}

// ---------------------------------------------------------------------------
// Listing signals (stale / closed / suspicious)
//
// Signals are recorded verbatim from the caller together with a required
// `provenance`; nothing is inferred from titles. Re-recording the same id
// with identical content is an idempotent no-op.
// ---------------------------------------------------------------------------

export type ListingSignalInput = {
  id: string;
  jobId: string;
  signal: ListingSignal;
  detail: string | null;
  detectedAt: string;
  confidence: number;
  provenance: ListingSignalRecord["provenance"];
  explanation: string;
  recoveryGuidance: string;
};

export type RecordListingSignalResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      signal: ListingSignalRecord;
      added: boolean;
    }
  | { ok: false; failure: SafeguardOperationFailure };

function sameSignalContent(
  first: ListingSignalRecord,
  second: ListingSignalRecord,
): boolean {
  return (
    first.id === second.id &&
    first.jobId === second.jobId &&
    first.signal === second.signal &&
    first.detail === second.detail &&
    first.detectedAt === second.detectedAt &&
    first.confidence === second.confidence &&
    first.provenance === second.provenance &&
    first.explanation === second.explanation &&
    first.recoveryGuidance === second.recoveryGuidance
  );
}

/**
 * Records a caller-supplied listing signal (`stale`, `closed`, or
 * `suspicious`) exactly as provided. The `suspicious` signal is never
 * inferred from title heuristics; only the caller may supply it.
 */
export function recordListingSignal(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  signal: ListingSignalInput;
  now: string;
}): RecordListingSignalResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  const signalResult = ListingSignalRecordSchema.safeParse({
    id: input.signal.id,
    jobId: input.signal.jobId,
    signal: input.signal.signal,
    detail: input.signal.detail,
    detectedAt: input.signal.detectedAt,
    confidence: input.signal.confidence,
    provenance: input.signal.provenance,
    explanation: input.signal.explanation,
    recoveryGuidance: input.signal.recoveryGuidance,
  });
  if (!signalResult.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(signalResult.error)),
    };
  }
  const signal = signalResult.data;

  const signals = parsedInput.safeguards.listingSignals;
  const existing = signals.find((entry) => entry.id === signal.id);
  if (existing !== undefined) {
    if (sameSignalContent(existing, signal)) {
      return {
        ok: true,
        safeguards: parsedInput.safeguards,
        signal: existing,
        added: false,
      };
    }
    return {
      ok: false,
      failure: duplicate(
        `Listing signal id "${signal.id}" already exists with different content.`,
      ),
    };
  }

  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    ...parsedInput.safeguards,
    listingSignals: [...signals, signal],
    updatedAt: now,
  });

  return { ok: true, safeguards, signal, added: true };
}

function compareSignalsNewer(
  first: ListingSignalRecord,
  second: ListingSignalRecord,
): number {
  const timeComparison =
    Date.parse(second.detectedAt) - Date.parse(first.detectedAt);

  if (timeComparison !== 0) return timeComparison;

  return second.id.localeCompare(first.id);
}

/**
 * Returns the most recent signal for a job (latest `detectedAt`, then the
 * lexicographically largest id as a deterministic tie-break), or null when the
 * job has no signal. A projection: invalid safeguards throw, matching the
 * other projection helpers in this package.
 */
export function deriveLatestListingSignal(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  jobId: string;
}): ListingSignalRecord | null {
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse(
    input.safeguards,
  );
  let latest: ListingSignalRecord | null = null;

  for (const signal of safeguards.listingSignals) {
    if (signal.jobId !== input.jobId) continue;
    if (latest === null || compareSignalsNewer(signal, latest) < 0) {
      latest = signal;
    }
  }

  return latest;
}

// ---------------------------------------------------------------------------
// Abnormal failure pause
//
// The caller supplies the complete attempt evidence set; the window's sample
// size, failure count, rate, and paused flag are all derived from it, so
// re-applying the same evidence is idempotent. Windows roll forward exactly
// like the company caps. A pause requires both the minimum sample and the
// configured failure rate, matching `AbnormalFailurePauseSchema`.
// ---------------------------------------------------------------------------

export type FailureAttemptEvidence = {
  attemptId: string;
  failed: boolean;
  occurredAt: string;
};

export type FailurePauseConfig = {
  windowDays: number;
  failureRateThresholdPercent: number;
  minimumSample: number;
  explanation: string;
  recoveryGuidance: string;
};

export type RecordAbnormalFailureEvidenceSummary = {
  failuresInWindow: number;
  sampleSize: number;
  failureRatePercent: number;
  paused: boolean;
  rolledOver: boolean;
  ignoredCount: number;
};

export type RecordAbnormalFailureEvidenceResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      pause: AbnormalFailurePause;
      summary: RecordAbnormalFailureEvidenceSummary;
    }
  | { ok: false; failure: SafeguardOperationFailure };

type FailurePauseMeasurement = {
  windowStartedAt: string;
  failuresInWindow: number;
  sampleSize: number;
  rolledOver: boolean;
  ignoredCount: number;
};

function deriveFailurePauseMeasurement(input: {
  evidence: readonly FailureAttemptEvidence[];
  windowDays: number;
  windowStartedAt: string;
}): FailurePauseMeasurement | { failure: string } {
  const parsed: Array<{
    attemptId: string;
    failed: boolean;
    occurredAt: string;
    occurredAtMillis: number;
  }> = [];
  for (const entry of input.evidence) {
    if (!isNonEmpty(entry.attemptId)) {
      return {
        failure: "Failure attempt id must be a non-empty string.",
      };
    }
    const timestamp = parseTimestamp(entry.occurredAt);
    if (!timestamp.ok) {
      return {
        failure: `Failure attempt timestamp "${entry.occurredAt}" must be a valid ISO datetime.`,
      };
    }
    parsed.push({
      attemptId: entry.attemptId,
      failed: entry.failed,
      occurredAt: timestamp.value,
      occurredAtMillis: Date.parse(timestamp.value),
    });
  }

  parsed.sort(
    (first, second) =>
      first.occurredAtMillis - second.occurredAtMillis ||
      first.occurredAt.localeCompare(second.occurredAt) ||
      first.attemptId.localeCompare(second.attemptId),
  );

  const seenAttemptIds = new Set<string>();
  const qualifying: typeof parsed = [];
  for (const entry of parsed) {
    if (seenAttemptIds.has(entry.attemptId)) continue;
    seenAttemptIds.add(entry.attemptId);
    qualifying.push(entry);
  }

  const currentWindowStartMillis = Date.parse(input.windowStartedAt);
  const currentWindowEndMillis =
    currentWindowStartMillis + input.windowDays * MS_PER_DAY;

  let windowStartedAt = input.windowStartedAt;
  let windowStartMillis = currentWindowStartMillis;
  let rolledOver = false;
  const earliestBeyondWindow = qualifying.find(
    (entry) => entry.occurredAtMillis >= currentWindowEndMillis,
  );
  if (earliestBeyondWindow !== undefined) {
    windowStartedAt = earliestBeyondWindow.occurredAt;
    windowStartMillis = earliestBeyondWindow.occurredAtMillis;
    rolledOver = true;
  }

  let sampleSize = 0;
  let failuresInWindow = 0;
  for (const entry of qualifying) {
    if (
      isWithinWindow(
        entry.occurredAtMillis,
        windowStartMillis,
        input.windowDays,
      )
    ) {
      sampleSize += 1;
      if (entry.failed) failuresInWindow += 1;
    }
  }

  return {
    windowStartedAt,
    failuresInWindow,
    sampleSize,
    rolledOver,
    ignoredCount: input.evidence.length - sampleSize,
  };
}

/**
 * Derives the abnormal-failure pause from caller-supplied attempt evidence:
 * the failure rate is exactly `failures / sample * 100` and `paused` is true
 * only when the sample meets `minimumSample` and the rate meets the threshold.
 * The window rolls forward when attempts fall at or beyond the window end.
 */
export function recordAbnormalFailureEvidence(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  pauseId: string;
  windowStartedAt: string;
  evidence: readonly FailureAttemptEvidence[];
  now: string;
  config: FailurePauseConfig;
}): RecordAbnormalFailureEvidenceResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  if (!isNonEmpty(input.pauseId)) {
    return {
      ok: false,
      failure: invalidInput("Pause id must be a non-empty string."),
    };
  }
  const windowResult = parseTimestamp(input.windowStartedAt);
  if (!windowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("windowStartedAt must be a valid ISO datetime."),
    };
  }
  if (
    !Number.isInteger(input.config.windowDays) ||
    input.config.windowDays < 1 ||
    input.config.windowDays > 365
  ) {
    return {
      ok: false,
      failure: invalidInput("windowDays must be an integer between 1 and 365."),
    };
  }
  if (
    !Number.isInteger(input.config.failureRateThresholdPercent) ||
    input.config.failureRateThresholdPercent < 1 ||
    input.config.failureRateThresholdPercent > 100
  ) {
    return {
      ok: false,
      failure: invalidInput(
        "failureRateThresholdPercent must be an integer between 1 and 100.",
      ),
    };
  }
  if (
    !Number.isInteger(input.config.minimumSample) ||
    input.config.minimumSample < 1 ||
    input.config.minimumSample > 1_000
  ) {
    return {
      ok: false,
      failure: invalidInput(
        "minimumSample must be an integer between 1 and 1000.",
      ),
    };
  }
  if (
    !isNonEmpty(input.config.explanation) ||
    !isNonEmpty(input.config.recoveryGuidance)
  ) {
    return {
      ok: false,
      failure: invalidInput(
        "Pause explanation and recovery guidance must be non-empty strings.",
      ),
    };
  }

  const pauses = parsedInput.safeguards.abnormalFailurePauses;
  const existingIndex = pauses.findIndex((pause) => pause.id === input.pauseId);
  const currentWindowStartedAt =
    existingIndex >= 0
      ? pauses[existingIndex]!.windowStartedAt
      : windowResult.value;

  const measurement = deriveFailurePauseMeasurement({
    evidence: input.evidence,
    windowDays: input.config.windowDays,
    windowStartedAt: currentWindowStartedAt,
  });
  if ("failure" in measurement) {
    return { ok: false, failure: invalidInput(measurement.failure) };
  }

  const failureRatePercent =
    measurement.sampleSize === 0
      ? 0
      : (measurement.failuresInWindow / measurement.sampleSize) * 100;
  const paused =
    measurement.sampleSize >= input.config.minimumSample &&
    failureRatePercent >= input.config.failureRateThresholdPercent;

  const pauseResult = AbnormalFailurePauseSchema.safeParse({
    id: input.pauseId,
    windowStartedAt: measurement.windowStartedAt,
    failuresInWindow: measurement.failuresInWindow,
    sampleSize: measurement.sampleSize,
    failureRatePercent,
    failureRateThresholdPercent: input.config.failureRateThresholdPercent,
    minimumSample: input.config.minimumSample,
    paused,
    explanation: input.config.explanation,
    recoveryGuidance: input.config.recoveryGuidance,
  });
  if (!pauseResult.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(pauseResult.error)),
    };
  }
  const pause = pauseResult.data;

  const nextPauses =
    existingIndex >= 0
      ? pauses.map((entry, index) => (index === existingIndex ? pause : entry))
      : [...pauses, pause];
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    ...parsedInput.safeguards,
    abnormalFailurePauses: nextPauses,
    updatedAt: now,
  });

  return {
    ok: true,
    safeguards,
    pause,
    summary: {
      failuresInWindow: measurement.failuresInWindow,
      sampleSize: measurement.sampleSize,
      failureRatePercent,
      paused,
      rolledOver: measurement.rolledOver,
      ignoredCount: measurement.ignoredCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Prepared-batch sample review
//
// Sampling is deterministic: the sample is the caller-supplied batch's unique
// item ids ranked by the SHA-256 of `batchId + itemId` (then item id), so the
// same batch always yields the same sample regardless of input order.
// Re-preparing an unchanged batch (same prepared count and required ratio) is
// an idempotent no-op that preserves review progress; a changed batch resets
// progress. Review progress is caller-supplied and schema-checked.
// ---------------------------------------------------------------------------

export type PreparedBatchItem = {
  id: string;
};

export type PrepareBatchSampleReviewResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      review: PreparedBatchSampleReview;
      sampledIds: string[];
      requiredSample: number;
      sampleCount: number;
      reset: boolean;
    }
  | { ok: false; failure: SafeguardOperationFailure };

export type UpdateBatchSampleReviewResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      review: PreparedBatchSampleReview;
      changed: boolean;
    }
  | { ok: false; failure: SafeguardOperationFailure };

function sampleKey(batchId: string, itemId: string): string {
  return createHash("sha256").update(`${batchId}\u0000${itemId}`).digest("hex");
}

/**
 * Deterministically selects `sampleCount` item ids from the prepared batch.
 * Unique ids are ranked by `SHA-256(batchId + itemId)` and then by id, so the
 * selection is stable for a given batch regardless of input order.
 */
export function deriveBatchSampleIds(input: {
  batchId: string;
  prepared: readonly PreparedBatchItem[];
  sampleCount: number;
}): string[] {
  const seen = new Set<string>();
  const uniqueIds: string[] = [];
  for (const item of input.prepared) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    uniqueIds.push(item.id);
  }

  const ranked = [...uniqueIds].sort((first, second) => {
    const keyComparison = sampleKey(input.batchId, first).localeCompare(
      sampleKey(input.batchId, second),
    );

    return keyComparison !== 0 ? keyComparison : first.localeCompare(second);
  });

  return ranked.slice(
    0,
    Math.max(0, Math.min(input.sampleCount, ranked.length)),
  );
}

/**
 * Prepares (or re-prepares) a deterministic sample-review for a batch. The
 * required sample is `ceil(preparedCount * requiredSampleRatio)` and the
 * actual sample is at least one, never exceeding the batch size. One review
 * exists per batch; re-preparing an unchanged batch preserves progress.
 */
export function prepareBatchSampleReview(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  reviewId: string;
  batchId: string;
  prepared: readonly PreparedBatchItem[];
  requiredSampleRatio: number;
  explanation: string;
  recoveryGuidance: string;
  now: string;
}): PrepareBatchSampleReviewResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  if (!isNonEmpty(input.reviewId)) {
    return {
      ok: false,
      failure: invalidInput("reviewId must be a non-empty string."),
    };
  }
  if (!isNonEmpty(input.batchId)) {
    return {
      ok: false,
      failure: invalidInput("batchId must be a non-empty string."),
    };
  }
  if (!isNonEmpty(input.explanation) || !isNonEmpty(input.recoveryGuidance)) {
    return {
      ok: false,
      failure: invalidInput(
        "Review explanation and recovery guidance must be non-empty strings.",
      ),
    };
  }

  const seen = new Set<string>();
  const uniqueIds: string[] = [];
  for (const item of input.prepared) {
    if (!isNonEmpty(item.id)) {
      return {
        ok: false,
        failure: invalidInput(
          "Prepared batch item id must be a non-empty string.",
        ),
      };
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    uniqueIds.push(item.id);
  }
  if (uniqueIds.length === 0) {
    return {
      ok: false,
      failure: invalidInput("A prepared batch cannot be empty."),
    };
  }

  const preparedCount = uniqueIds.length;
  const requiredSample = Math.ceil(preparedCount * input.requiredSampleRatio);
  const sampleCount = Math.max(requiredSample, 1);

  const reviews = parsedInput.safeguards.preparedBatchSampleReviews;
  const byBatchIndex = reviews.findIndex(
    (review) => review.batchId === input.batchId,
  );
  const byIdIndex = reviews.findIndex((review) => review.id === input.reviewId);
  if (byBatchIndex >= 0 && reviews[byBatchIndex]!.id !== input.reviewId) {
    return {
      ok: false,
      failure: duplicate(
        `Batch "${input.batchId}" already has review "${reviews[byBatchIndex]!.id}".`,
      ),
    };
  }
  if (byBatchIndex < 0 && byIdIndex >= 0) {
    return {
      ok: false,
      failure: duplicate(
        `Review id "${input.reviewId}" already exists for batch "${reviews[byIdIndex]!.batchId}".`,
      ),
    };
  }

  if (byBatchIndex >= 0) {
    const existing = reviews[byBatchIndex]!;
    const sampledIds = deriveBatchSampleIds({
      batchId: input.batchId,
      prepared: input.prepared,
      sampleCount,
    });
    const sameSampleIds =
      existing.sampledItemIds.length === sampledIds.length &&
      existing.sampledItemIds.every(
        (itemId, index) => itemId === sampledIds[index],
      );
    const sameBatchShape =
      existing.preparedCount === preparedCount &&
      existing.requiredSampleRatio === input.requiredSampleRatio;
    if (sameBatchShape && sameSampleIds) {
      return {
        ok: true,
        safeguards: parsedInput.safeguards,
        review: existing,
        sampledIds,
        requiredSample,
        sampleCount,
        reset: false,
      };
    }

    // A legacy review may have the same shape but no persisted sample ids.
    // Backfill the deterministic ids without discarding existing progress.
    if (sameBatchShape && existing.sampledItemIds.length === 0) {
      const review = PreparedBatchSampleReviewSchema.parse({
        ...existing,
        sampledItemIds: sampledIds,
      });
      const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
        ...parsedInput.safeguards,
        preparedBatchSampleReviews: reviews.map((entry, index) =>
          index === byBatchIndex ? review : entry,
        ),
        updatedAt: now,
      });
      return {
        ok: true,
        safeguards,
        review,
        sampledIds,
        requiredSample,
        sampleCount,
        reset: false,
      };
    }

    const built = PreparedBatchSampleReviewSchema.safeParse({
      id: input.reviewId,
      batchId: input.batchId,
      preparedCount,
      sampleCount,
      sampledItemIds: sampledIds,
      reviewedCount: 0,
      requiredSampleRatio: input.requiredSampleRatio,
      reviewCompleted: false,
      explanation: input.explanation,
      recoveryGuidance: input.recoveryGuidance,
    });
    if (!built.success) {
      return {
        ok: false,
        failure: invalidInput(firstIssueMessage(built.error)),
      };
    }
    const review = built.data;
    const nextReviews = reviews.map((entry, index) =>
      index === byBatchIndex ? review : entry,
    );
    const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
      ...parsedInput.safeguards,
      preparedBatchSampleReviews: nextReviews,
      updatedAt: now,
    });
    return {
      ok: true,
      safeguards,
      review,
      sampledIds,
      requiredSample,
      sampleCount,
      reset: true,
    };
  }

  const built = PreparedBatchSampleReviewSchema.safeParse({
    id: input.reviewId,
    batchId: input.batchId,
    preparedCount,
    sampleCount,
    sampledItemIds: deriveBatchSampleIds({
      batchId: input.batchId,
      prepared: input.prepared,
      sampleCount,
    }),
    reviewedCount: 0,
    requiredSampleRatio: input.requiredSampleRatio,
    reviewCompleted: false,
    explanation: input.explanation,
    recoveryGuidance: input.recoveryGuidance,
  });
  if (!built.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(built.error)),
    };
  }
  const review = built.data;
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    ...parsedInput.safeguards,
    preparedBatchSampleReviews: [...reviews, review],
    updatedAt: now,
  });
  const sampledIds = deriveBatchSampleIds({
    batchId: input.batchId,
    prepared: input.prepared,
    sampleCount,
  });

  return {
    ok: true,
    safeguards,
    review,
    sampledIds,
    requiredSample,
    sampleCount,
    reset: false,
  };
}

/**
 * Advances caller-supplied review progress on a sample review. Setting the
 * same progress again is an idempotent no-op; completing a review requires the
 * full sample to be reviewed, matching `PreparedBatchSampleReviewSchema`.
 */
export function updateBatchSampleReview(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  reviewId: string;
  reviewedCount: number;
  reviewCompleted: boolean;
  now: string;
}): UpdateBatchSampleReviewResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  const reviews = parsedInput.safeguards.preparedBatchSampleReviews;
  const index = reviews.findIndex((review) => review.id === input.reviewId);
  if (index < 0) {
    return {
      ok: false,
      failure: notFound(`Sample review "${input.reviewId}" does not exist.`),
    };
  }
  const existing = reviews[index]!;
  if (
    existing.reviewedCount === input.reviewedCount &&
    existing.reviewCompleted === input.reviewCompleted
  ) {
    return {
      ok: true,
      safeguards: parsedInput.safeguards,
      review: existing,
      changed: false,
    };
  }

  const built = PreparedBatchSampleReviewSchema.safeParse({
    ...existing,
    reviewedCount: input.reviewedCount,
    reviewCompleted: input.reviewCompleted,
  });
  if (!built.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(built.error)),
    };
  }
  const review = built.data;
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    ...parsedInput.safeguards,
    preparedBatchSampleReviews: reviews.map((entry, entryIndex) =>
      entryIndex === index ? review : entry,
    ),
    updatedAt: now,
  });

  return { ok: true, safeguards, review, changed: true };
}

// ---------------------------------------------------------------------------
// Contradictory answer detections
//
// Detections are advisory: they are recorded from caller-supplied evidence and
// never block the pipeline while a real blocker exists. Re-recording the same
// id with identical content, or the same unordered question pair while a
// detection is still active, is an idempotent no-op.
// ---------------------------------------------------------------------------

export type ContradictoryAnswerDetectionInput = {
  detectionId: string;
  questionA: string;
  questionB: string;
  answerA: string;
  answerB: string;
  contradictionScore: number;
  detectedAt: string;
  explanation: string;
  recoveryGuidance: string;
};

export type RecordContradictoryAnswerDetectionResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      detection: ContradictoryAnswerDetection;
      added: boolean;
    }
  | { ok: false; failure: SafeguardOperationFailure };

function sameDetectionContent(
  first: ContradictoryAnswerDetection,
  second: ContradictoryAnswerDetection,
): boolean {
  return (
    first.id === second.id &&
    first.questionA === second.questionA &&
    first.questionB === second.questionB &&
    first.answerA === second.answerA &&
    first.answerB === second.answerB &&
    first.contradictionScore === second.contradictionScore &&
    first.status === second.status &&
    first.detectedAt === second.detectedAt &&
    first.resolvedAt === second.resolvedAt &&
    first.explanation === second.explanation &&
    first.recoveryGuidance === second.recoveryGuidance
  );
}

/**
 * Records a caller-supplied contradictory answer detection with its score and
 * guidance. The detection is advisory; it requires two distinct questions and
 * a score in `[0, 1]`, matching `ContradictoryAnswerDetectionSchema`.
 */
export function recordContradictoryAnswerDetection(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  detection: ContradictoryAnswerDetectionInput;
  now: string;
}): RecordContradictoryAnswerDetectionResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  const detectionResult = ContradictoryAnswerDetectionSchema.safeParse({
    id: input.detection.detectionId,
    questionA: input.detection.questionA,
    questionB: input.detection.questionB,
    answerA: input.detection.answerA,
    answerB: input.detection.answerB,
    contradictionScore: input.detection.contradictionScore,
    status: "detected",
    detectedAt: input.detection.detectedAt,
    resolvedAt: null,
    explanation: input.detection.explanation,
    recoveryGuidance: input.detection.recoveryGuidance,
  });
  if (!detectionResult.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(detectionResult.error)),
    };
  }
  const detection = detectionResult.data;

  const detections = parsedInput.safeguards.contradictoryAnswerDetections;
  const existingById = detections.find((entry) => entry.id === detection.id);
  if (existingById !== undefined) {
    if (sameDetectionContent(existingById, detection)) {
      return {
        ok: true,
        safeguards: parsedInput.safeguards,
        detection: existingById,
        added: false,
      };
    }
    return {
      ok: false,
      failure: duplicate(
        `Detection id "${detection.id}" already exists with different content.`,
      ),
    };
  }

  const pair = pairKey(detection.questionA, detection.questionB);
  const existingPair = detections.find(
    (entry) =>
      entry.status === "detected" &&
      pairKey(entry.questionA, entry.questionB) === pair,
  );
  if (existingPair !== undefined) {
    return {
      ok: true,
      safeguards: parsedInput.safeguards,
      detection: existingPair,
      added: false,
    };
  }

  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    ...parsedInput.safeguards,
    contradictoryAnswerDetections: [...detections, detection],
    updatedAt: now,
  });

  return { ok: true, safeguards, detection, added: true };
}

export type UpdateContradictoryAnswerDetectionResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      detection: ContradictoryAnswerDetection;
      changed: boolean;
    }
  | { ok: false; failure: SafeguardOperationFailure };

function updateContradictoryAnswerStatus(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  detectionId: string;
  now: string;
  nextStatus: "resolved" | "dismissed";
}): UpdateContradictoryAnswerDetectionResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  const detections = parsedInput.safeguards.contradictoryAnswerDetections;
  const index = detections.findIndex((entry) => entry.id === input.detectionId);
  if (index < 0) {
    return {
      ok: false,
      failure: notFound(
        `Contradiction detection "${input.detectionId}" does not exist.`,
      ),
    };
  }
  const existing = detections[index]!;
  if (existing.status === input.nextStatus) {
    return {
      ok: true,
      safeguards: parsedInput.safeguards,
      detection: existing,
      changed: false,
    };
  }

  const built = ContradictoryAnswerDetectionSchema.safeParse({
    ...existing,
    status: input.nextStatus,
    resolvedAt: input.nextStatus === "resolved" ? now : null,
  });
  if (!built.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(built.error)),
    };
  }
  const detection = built.data;
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({
    ...parsedInput.safeguards,
    contradictoryAnswerDetections: detections.map((entry, entryIndex) =>
      entryIndex === index ? detection : entry,
    ),
    updatedAt: now,
  });

  return { ok: true, safeguards, detection, changed: true };
}

/**
 * Marks a detection as resolved, stamping the caller-provided `now` as
 * `resolvedAt` (the schema requires it). Resolving an already-resolved
 * detection is an idempotent no-op.
 */
export function resolveContradictoryAnswerDetection(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  detectionId: string;
  now: string;
}): UpdateContradictoryAnswerDetectionResult {
  return updateContradictoryAnswerStatus({
    safeguards: input.safeguards,
    detectionId: input.detectionId,
    now: input.now,
    nextStatus: "resolved",
  });
}

/**
 * Dismisses a detection (advisory only; `resolvedAt` stays null). Dismissing
 * an already-dismissed detection is an idempotent no-op.
 */
export function dismissContradictoryAnswerDetection(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  detectionId: string;
  now: string;
}): UpdateContradictoryAnswerDetectionResult {
  return updateContradictoryAnswerStatus({
    safeguards: input.safeguards,
    detectionId: input.detectionId,
    now: input.now,
    nextStatus: "dismissed",
  });
}

// ---------------------------------------------------------------------------
// Deterministic gate
//
// A single gate returns the highest-priority active blocker (or null). The
// priority order follows the safeguards contract enumeration: company cap
// limit, simultaneous application conflict, listing signal, abnormal failure
// pause, batch sample review pending, and contradictory answer (advisory).
// Ties are broken deterministically by timestamp (when the kind carries one)
// and then by id; only the latest signal per job is considered. Dismissed
// entries (recorded through `dismissSafeguardEntry`) are skipped.
// ---------------------------------------------------------------------------

export const safeguardBlockerKindValues = [
  "company_cap_limit",
  "simultaneous_application_conflict",
  "listing_signal",
  "abnormal_failure_pause",
  "batch_sample_review_pending",
  "contradictory_answer",
] as const;
export type SafeguardBlockerKind = (typeof safeguardBlockerKindValues)[number];

export type SafeguardBlockerSeverity = "blocker" | "advisory";

/**
 * Which kind of work a safeguard actually stands in the way of.
 *
 * A search plan that paused itself after failed searches has nothing to say
 * about an application the person is preparing by hand, and a daily
 * application cap has nothing to say about running a search. Saying so here
 * keeps one kind of trouble from standing in front of the other.
 */
export type SafeguardBlockerScope = "discovery" | "apply" | "all";

export type SafeguardBlocker = {
  priority: number;
  kind: SafeguardBlockerKind;
  id: string;
  severity: SafeguardBlockerSeverity;
  /** What this blocker stops. */
  scope: SafeguardBlockerScope;
  /**
   * The internal reference, for logs and for a renderer that wants to show it
   * behind a details control. It never belongs in a sentence a person reads.
   */
  code: string;
  explanation: string;
  recoveryGuidance: string;
};

/** Which work an automatic pause belongs to, read from its own stable id. */
export function abnormalFailurePauseScope(
  pauseId: string,
): SafeguardBlockerScope {
  if (
    pauseId.startsWith(AUTOMATIC_DISCOVERY_FAILURE_PAUSE_ID) ||
    pauseId.startsWith(AUTOMATIC_SOURCE_DEBUG_FAILURE_PAUSE_ID)
  ) {
    return "discovery";
  }
  if (pauseId.startsWith(AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID)) {
    return "apply";
  }
  // A pause the person set themselves stops everything until they lift it.
  return "all";
}

/** True when this blocker stands in the way of the work being attempted. */
export function blockerAppliesTo(
  blocker: SafeguardBlocker,
  operation: "discovery" | "apply",
): boolean {
  return blocker.scope === "all" || blocker.scope === operation;
}

const BLOCKER_PRIORITY: Record<SafeguardBlockerKind, number> = {
  company_cap_limit: 1,
  simultaneous_application_conflict: 2,
  listing_signal: 3,
  abnormal_failure_pause: 4,
  batch_sample_review_pending: 5,
  contradictory_answer: 6,
};

const LISTING_SIGNAL_SUB_PRIORITY: Record<ListingSignal, number> = {
  suspicious: 0,
  closed: 1,
  stale: 2,
};

type GateCandidate = {
  sortKey: [number, number | "", number | "", string];
  blocker: SafeguardBlocker;
};

function makeBlocker(input: {
  kind: SafeguardBlockerKind;
  id: string;
  severity: SafeguardBlockerSeverity;
  scope: SafeguardBlockerScope;
  explanation: string;
  recoveryGuidance: string;
}): SafeguardBlocker {
  return {
    priority: BLOCKER_PRIORITY[input.kind],
    kind: input.kind,
    id: input.id,
    severity: input.severity,
    scope: input.scope,
    code: `${input.kind}: ${input.id}`,
    explanation: input.explanation,
    recoveryGuidance: input.recoveryGuidance,
  };
}

function compareGateCandidates(
  first: GateCandidate,
  second: GateCandidate,
): number {
  for (let index = 0; index < 4; index += 1) {
    const left = first.sortKey[index];
    const right = second.sortKey[index];
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  }

  return 0;
}

function dismissalPairKey(kind: string, referenceId: string): string {
  return `${kind}\u0000${referenceId}`;
}

function buildDismissalSet(
  safeguards: JobFinderIntelligenceSafeguards,
): ReadonlySet<string> {
  return new Set(
    safeguards.safeguardDismissals.map((dismissal) =>
      dismissalPairKey(dismissal.kind, dismissal.referenceId),
    ),
  );
}

function isDismissed(
  dismissals: ReadonlySet<string>,
  kind: SafeguardBlockerKind,
  id: string,
): boolean {
  return dismissals.has(dismissalPairKey(kind, id));
}

function collectGateCandidates(
  safeguards: JobFinderIntelligenceSafeguards,
): GateCandidate[] {
  const dismissals = buildDismissalSet(safeguards);
  const candidates: GateCandidate[] = [];

  for (const cap of safeguards.companyApplicationCaps) {
    if (!cap.limitReached) continue;
    if (isDismissed(dismissals, "company_cap_limit", cap.id)) continue;
    candidates.push({
      sortKey: [
        BLOCKER_PRIORITY.company_cap_limit,
        "",
        Date.parse(cap.windowStartedAt),
        cap.id,
      ],
      blocker: makeBlocker({
        kind: "company_cap_limit",
        id: cap.id,
        severity: "blocker",
        scope: "apply",
        explanation: cap.explanation,
        recoveryGuidance: cap.recoveryGuidance,
      }),
    });
  }

  for (const conflict of safeguards.simultaneousApplicationConflicts) {
    if (conflict.companyKey) continue;
    if (conflict.status !== "detected") continue;
    if (
      isDismissed(dismissals, "simultaneous_application_conflict", conflict.id)
    ) {
      continue;
    }
    candidates.push({
      sortKey: [
        BLOCKER_PRIORITY.simultaneous_application_conflict,
        "",
        "",
        conflict.id,
      ],
      blocker: makeBlocker({
        kind: "simultaneous_application_conflict",
        id: conflict.id,
        severity: "blocker",
        scope: "apply",
        explanation: conflict.explanation,
        recoveryGuidance: conflict.recoveryGuidance,
      }),
    });
  }

  const latestSignalByJob = new Map<string, ListingSignalRecord>();
  for (const signal of safeguards.listingSignals) {
    const latest = latestSignalByJob.get(signal.jobId);
    if (latest === undefined || compareSignalsNewer(signal, latest) < 0) {
      latestSignalByJob.set(signal.jobId, signal);
    }
  }
  for (const signal of latestSignalByJob.values()) {
    if (isDismissed(dismissals, "listing_signal", signal.id)) continue;
    candidates.push({
      sortKey: [
        BLOCKER_PRIORITY.listing_signal,
        LISTING_SIGNAL_SUB_PRIORITY[signal.signal],
        Date.parse(signal.detectedAt),
        signal.id,
      ],
      blocker: makeBlocker({
        kind: "listing_signal",
        id: signal.id,
        severity: "blocker",
        scope: "apply",
        explanation: signal.explanation,
        recoveryGuidance: signal.recoveryGuidance,
      }),
    });
  }

  for (const pause of safeguards.abnormalFailurePauses) {
    if (!pause.paused) continue;
    if (isDismissed(dismissals, "abnormal_failure_pause", pause.id)) continue;
    candidates.push({
      sortKey: [
        BLOCKER_PRIORITY.abnormal_failure_pause,
        "",
        Date.parse(pause.windowStartedAt),
        pause.id,
      ],
      blocker: makeBlocker({
        kind: "abnormal_failure_pause",
        id: pause.id,
        severity: "blocker",
        scope: abnormalFailurePauseScope(pause.id),
        explanation: pause.explanation,
        recoveryGuidance: pause.recoveryGuidance,
      }),
    });
  }

  for (const detection of safeguards.contradictoryAnswerDetections) {
    if (detection.status !== "detected") continue;
    if (isDismissed(dismissals, "contradictory_answer", detection.id)) {
      continue;
    }
    candidates.push({
      sortKey: [
        BLOCKER_PRIORITY.contradictory_answer,
        "",
        Date.parse(detection.detectedAt),
        detection.id,
      ],
      blocker: makeBlocker({
        kind: "contradictory_answer",
        id: detection.id,
        severity: "advisory",
        scope: "apply",
        explanation: detection.explanation,
        recoveryGuidance: detection.recoveryGuidance,
      }),
    });
  }

  return candidates;
}

/**
 * Returns every active blocker ordered deterministically (priority, then
 * timestamp, then id). Contradiction detections are advisory and never outrank
 * a real blocker. Dismissed entries are excluded. A projection: invalid
 * safeguards throw, matching the other projection helpers in this package.
 */
export function deriveActiveSafeguardBlockers(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  /**
   * The work being attempted. Given, only the safeguards that stand in the
   * way of that work are returned; omitted, everything active comes back for
   * the Safeguards screen to show.
   */
  operation?: "discovery" | "apply";
}): SafeguardBlocker[] {
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse(
    input.safeguards,
  );
  const candidates = collectGateCandidates(safeguards).sort(
    compareGateCandidates,
  );

  const operation = input.operation;
  return candidates
    .map((candidate) => candidate.blocker)
    .filter((blocker) => !operation || blockerAppliesTo(blocker, operation));
}

/**
 * Returns the single highest-priority active blocker, or null when nothing
 * blocks. The gate is fully deterministic: priority, then timestamp, then id.
 * Contradiction detections are returned only when nothing else is active and
 * are marked `severity: "advisory"` with the caller-supplied recovery
 * guidance. Dismissed entries are excluded.
 */
export function deriveHighestPriorityBlocker(input: {
  safeguards: JobFinderIntelligenceSafeguards;
}): SafeguardBlocker | null {
  return deriveActiveSafeguardBlockers(input)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Scoped gate (application preparation / discovery)
//
// Application preparation is gated per affected job: a cap counts only when
// the job belongs to the capped company, a conflict only when one of its
// application records belongs to the prepared jobs, and a listing signal only
// when it targets the prepared job. Abnormal failure pauses and pending sample
// reviews are global pipeline gates. Contradictions stay advisory and never
// block. Dismissals are honored everywhere.
// ---------------------------------------------------------------------------

export type SafeguardScopeBlockersInput = {
  safeguards: JobFinderIntelligenceSafeguards;
  /** Job ids being prepared or discovered; empty means "any job". */
  jobIds?: readonly string[];
  /** Company entity ids of the affected jobs (resolved by the caller). */
  companyIds?: readonly string[];
  /** Maps application record ids to the job that owns them. */
  applicationRecordJobIds?: ReadonlyMap<string, string>;
  /** The work being attempted; omitted means "every active safeguard". */
  operation?: "discovery" | "apply";
};

/**
 * Derives the blockers that apply to a specific scope. An empty `jobIds`
 * array means the scope is unbounded and every job-scoped blocker counts.
 * Global gates (abnormal failure pause, pending sample review) always count.
 */
export function deriveScopeBlockers(
  input: SafeguardScopeBlockersInput,
): SafeguardBlocker[] {
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse(
    input.safeguards,
  );
  const dismissals = buildDismissalSet(safeguards);
  const jobIdSet = new Set(input.jobIds ?? []);
  const unbounded = jobIdSet.size === 0;
  const companyIdSet = new Set(input.companyIds ?? []);
  const recordJobIds = input.applicationRecordJobIds;

  const candidates: GateCandidate[] = [];
  const push = (sortKey: GateCandidate["sortKey"], blocker: SafeguardBlocker) =>
    candidates.push({ sortKey, blocker });

  for (const cap of safeguards.companyApplicationCaps) {
    if (!cap.limitReached) continue;
    if (isDismissed(dismissals, "company_cap_limit", cap.id)) continue;
    if (!unbounded && !companyIdSet.has(cap.companyId)) continue;
    push(
      [
        BLOCKER_PRIORITY.company_cap_limit,
        "",
        Date.parse(cap.windowStartedAt),
        cap.id,
      ],
      makeBlocker({
        kind: "company_cap_limit",
        id: cap.id,
        severity: "blocker",
        scope: "apply",
        explanation: cap.explanation,
        recoveryGuidance: cap.recoveryGuidance,
      }),
    );
  }

  for (const conflict of safeguards.simultaneousApplicationConflicts) {
    if (conflict.companyKey) continue;
    if (conflict.status !== "detected") continue;
    if (
      isDismissed(dismissals, "simultaneous_application_conflict", conflict.id)
    ) {
      continue;
    }
    const involvedJobIds = [
      recordJobIds?.get(conflict.applicationRecordId),
      recordJobIds?.get(conflict.conflictingApplicationRecordId),
    ].filter((jobId): jobId is string => jobId !== undefined);
    if (!unbounded && !involvedJobIds.some((jobId) => jobIdSet.has(jobId))) {
      continue;
    }
    push(
      [BLOCKER_PRIORITY.simultaneous_application_conflict, "", "", conflict.id],
      makeBlocker({
        kind: "simultaneous_application_conflict",
        id: conflict.id,
        severity: "blocker",
        scope: "apply",
        explanation: conflict.explanation,
        recoveryGuidance: conflict.recoveryGuidance,
      }),
    );
  }

  const latestSignalByJob = new Map<string, ListingSignalRecord>();
  for (const signal of safeguards.listingSignals) {
    const latest = latestSignalByJob.get(signal.jobId);
    if (latest === undefined || compareSignalsNewer(signal, latest) < 0) {
      latestSignalByJob.set(signal.jobId, signal);
    }
  }
  for (const signal of latestSignalByJob.values()) {
    if (isDismissed(dismissals, "listing_signal", signal.id)) continue;
    if (!unbounded && !jobIdSet.has(signal.jobId)) continue;
    push(
      [
        BLOCKER_PRIORITY.listing_signal,
        LISTING_SIGNAL_SUB_PRIORITY[signal.signal],
        Date.parse(signal.detectedAt),
        signal.id,
      ],
      makeBlocker({
        kind: "listing_signal",
        id: signal.id,
        severity: "blocker",
        scope: "apply",
        explanation: signal.explanation,
        recoveryGuidance: signal.recoveryGuidance,
      }),
    );
  }

  for (const pause of safeguards.abnormalFailurePauses) {
    if (!pause.paused) continue;
    if (isDismissed(dismissals, "abnormal_failure_pause", pause.id)) continue;
    push(
      [
        BLOCKER_PRIORITY.abnormal_failure_pause,
        "",
        Date.parse(pause.windowStartedAt),
        pause.id,
      ],
      makeBlocker({
        kind: "abnormal_failure_pause",
        id: pause.id,
        severity: "blocker",
        scope: abnormalFailurePauseScope(pause.id),
        explanation: pause.explanation,
        recoveryGuidance: pause.recoveryGuidance,
      }),
    );
  }

  for (const detection of safeguards.contradictoryAnswerDetections) {
    if (detection.status !== "detected") continue;
    if (isDismissed(dismissals, "contradictory_answer", detection.id)) {
      continue;
    }
    push(
      [
        BLOCKER_PRIORITY.contradictory_answer,
        "",
        Date.parse(detection.detectedAt),
        detection.id,
      ],
      makeBlocker({
        kind: "contradictory_answer",
        id: detection.id,
        severity: "advisory",
        scope: "apply",
        explanation: detection.explanation,
        recoveryGuidance: detection.recoveryGuidance,
      }),
    );
  }

  const operation = input.operation;
  return candidates
    .sort(compareGateCandidates)
    .map((candidate) => candidate.blocker)
    .filter((blocker) => !operation || blockerAppliesTo(blocker, operation));
}

// ---------------------------------------------------------------------------
// Reversible dismissals
// ---------------------------------------------------------------------------

export type DismissSafeguardEntryResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      dismissal: SafeguardDismissal;
      added: boolean;
    }
  | { ok: false; failure: SafeguardOperationFailure };

/**
 * Records a caller-supplied dismissal for one safeguard entry (by kind +
 * reference id). Re-dismissing the same entry is an idempotent no-op; the
 * referenced entry must exist so dismissals cannot target ghosts.
 */
export function dismissSafeguardEntry(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  dismissalId: string;
  kind: SafeguardEntryKind;
  referenceId: string;
  reason: SafeguardDismissalReason;
  note?: string | null;
  now: string;
}): DismissSafeguardEntryResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  if (!isNonEmpty(input.dismissalId)) {
    return {
      ok: false,
      failure: invalidInput("Dismissal id must be a non-empty string."),
    };
  }
  if (!isNonEmpty(input.referenceId)) {
    return {
      ok: false,
      failure: invalidInput(
        "Dismissal reference id must be a non-empty string.",
      ),
    };
  }

  const safeguards = parsedInput.safeguards;
  const dismissals = safeguards.safeguardDismissals;
  const pair = dismissalPairKey(input.kind, input.referenceId);
  const existingPair = dismissals.find(
    (dismissal) =>
      dismissalPairKey(dismissal.kind, dismissal.referenceId) === pair,
  );
  if (existingPair !== undefined) {
    return {
      ok: true,
      safeguards,
      dismissal: existingPair,
      added: false,
    };
  }

  const entryExists =
    input.kind === "company_cap_limit"
      ? safeguards.companyApplicationCaps.some(
          (entry) => entry.id === input.referenceId,
        )
      : input.kind === "simultaneous_application_conflict"
        ? safeguards.simultaneousApplicationConflicts.some(
            (entry) => entry.id === input.referenceId,
          )
        : input.kind === "listing_signal"
          ? safeguards.listingSignals.some(
              (entry) => entry.id === input.referenceId,
            )
          : input.kind === "abnormal_failure_pause"
            ? safeguards.abnormalFailurePauses.some(
                (entry) => entry.id === input.referenceId,
              )
            : input.kind === "batch_sample_review_pending"
              ? safeguards.preparedBatchSampleReviews.some(
                  (entry) => entry.id === input.referenceId,
                )
              : safeguards.contradictoryAnswerDetections.some(
                  (entry) => entry.id === input.referenceId,
                );
  if (!entryExists) {
    return {
      ok: false,
      failure: notFound(
        `Safeguard entry ${input.kind} "${input.referenceId}" does not exist.`,
      ),
    };
  }

  const built = SafeguardDismissalSchema.safeParse({
    id: input.dismissalId,
    kind: input.kind,
    referenceId: input.referenceId,
    reason: input.reason,
    note: input.note ?? null,
    dismissedAt: now,
  });
  if (!built.success) {
    return {
      ok: false,
      failure: invalidInput(firstIssueMessage(built.error)),
    };
  }
  const dismissal = built.data;

  return {
    ok: true,
    safeguards: JobFinderIntelligenceSafeguardsSchema.parse({
      ...safeguards,
      safeguardDismissals: [...dismissals, dismissal],
      updatedAt: now,
    }),
    dismissal,
    added: true,
  };
}

export type RestoreSafeguardEntryResult =
  | {
      ok: true;
      safeguards: JobFinderIntelligenceSafeguards;
      removed: boolean;
    }
  | { ok: false; failure: SafeguardOperationFailure };

/**
 * Removes a recorded dismissal (the "retry" control). Unknown dismissal ids
 * fail so the UI cannot silently restore a stale dismissal.
 */
export function restoreSafeguardEntry(input: {
  safeguards: JobFinderIntelligenceSafeguards;
  dismissalId: string;
  now: string;
}): RestoreSafeguardEntryResult {
  const parsedInput = parseSafeguards(input.safeguards);
  if (!parsedInput.ok) return { ok: false, failure: parsedInput.failure };

  const nowResult = parseTimestamp(input.now);
  if (!nowResult.ok) {
    return {
      ok: false,
      failure: invalidInput("now must be a valid ISO datetime."),
    };
  }
  const now = nowResult.value;

  const safeguards = parsedInput.safeguards;
  const dismissals = safeguards.safeguardDismissals;
  const index = dismissals.findIndex(
    (dismissal) => dismissal.id === input.dismissalId,
  );
  if (index < 0) {
    return {
      ok: false,
      failure: notFound(
        `Safeguard dismissal "${input.dismissalId}" does not exist.`,
      ),
    };
  }

  const nextDismissals = dismissals.filter(
    (dismissal) => dismissal.id !== input.dismissalId,
  );

  return {
    ok: true,
    safeguards: JobFinderIntelligenceSafeguardsSchema.parse({
      ...safeguards,
      safeguardDismissals: nextDismissals,
      updatedAt: now,
    }),
    removed: true,
  };
}
