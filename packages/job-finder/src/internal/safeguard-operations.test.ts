import { describe, expect, test } from "vitest";

import {
  AbnormalFailurePauseSchema,
  CompanyApplicationCapSchema,
  ContradictoryAnswerDetectionSchema,
  JobFinderIntelligenceSafeguardsSchema,
  ListingSignalRecordSchema,
  PreparedBatchSampleReviewSchema,
  SimultaneousApplicationConflictSchema,
  type AbnormalFailurePause,
  type CompanyApplicationCap,
  type ContradictoryAnswerDetection,
  type JobFinderIntelligenceSafeguards,
  type ListingSignalRecord,
  type PreparedBatchSampleReview,
  type SimultaneousApplicationConflict,
} from "@nestor/contracts";

import {
  applyCompanyApplicationEvidence,
  deriveActiveSafeguardBlockers,
  deriveBatchSampleIds,
  deriveHighestPriorityBlocker,
  deriveLatestListingSignal,
  deriveScopeBlockers,
  dismissContradictoryAnswerDetection,
  prepareBatchSampleReview,
  recordAbnormalFailureEvidence,
  recordContradictoryAnswerDetection,
  recordListingSignal,
  recordSimultaneousApplicationConflict,
  resolveContradictoryAnswerDetection,
  resolveSimultaneousApplicationConflict,
  updateBatchSampleReview,
  type CompanyApplicationEvidence,
  type FailureAttemptEvidence,
  type ListingSignalInput,
} from "./safeguard-operations";

const now = "2026-08-15T10:00:00.000Z";
const day0 = "2026-08-01T00:00:00.000Z";
const day1 = "2026-08-02T00:00:00.000Z";
const day2 = "2026-08-03T00:00:00.000Z";
const day3 = "2026-08-04T00:00:00.000Z";
const day4 = "2026-08-05T00:00:00.000Z";
const day6 = "2026-08-07T00:00:00.000Z";
const day7 = "2026-08-08T00:00:00.000Z";
const day8 = "2026-08-09T00:00:00.000Z";
const day9 = "2026-08-10T00:00:00.000Z";

function emptySafeguards(): JobFinderIntelligenceSafeguards {
  return JobFinderIntelligenceSafeguardsSchema.parse({});
}

function capConfig(
  overrides: Partial<{
    companyId: string;
    maxApplicationsPerWindow: number;
    windowDays: number;
    windowStartedAt: string;
    explanation: string;
    recoveryGuidance: string;
  }> = {},
) {
  return {
    companyId: "company_acme",
    maxApplicationsPerWindow: 3,
    windowDays: 7,
    windowStartedAt: day0,
    explanation: "Per-company weekly application cap.",
    recoveryGuidance:
      "Wait for the window to roll over or pick another company.",
    ...overrides,
  };
}

function capEvidence(
  entries: Array<{
    recordId: string;
    companyId?: string;
    appliedAt: string;
  }>,
): CompanyApplicationEvidence[] {
  return entries.map((entry) => ({
    applicationRecordId: entry.recordId,
    companyId: entry.companyId ?? "company_acme",
    appliedAt: entry.appliedAt,
  }));
}

function pauseConfig(
  overrides: Partial<{
    windowDays: number;
    failureRateThresholdPercent: number;
    minimumSample: number;
    explanation: string;
    recoveryGuidance: string;
  }> = {},
) {
  return {
    windowDays: 7,
    failureRateThresholdPercent: 40,
    minimumSample: 5,
    explanation: "Elevated application failure rate.",
    recoveryGuidance: "Inspect the latest failure evidence before resuming.",
    ...overrides,
  };
}

function attemptEvidence(
  entries: Array<{ attemptId: string; failed: boolean; occurredAt: string }>,
): FailureAttemptEvidence[] {
  return entries.map((entry) => ({
    attemptId: entry.attemptId,
    failed: entry.failed,
    occurredAt: entry.occurredAt,
  }));
}

// ---------------------------------------------------------------------------
// Fixture builders for the gate
// ---------------------------------------------------------------------------

function capAtLimit(
  id: string,
  windowStartedAt: string,
  max = 3,
): CompanyApplicationCap {
  return CompanyApplicationCapSchema.parse({
    id,
    companyId: "company_acme",
    maxApplicationsPerWindow: max,
    windowDays: 7,
    currentWindowCount: max,
    limitReached: true,
    windowStartedAt,
    explanation: "Cap reached.",
    recoveryGuidance: "Wait for rollover.",
  });
}

function detectedConflict(id: string): SimultaneousApplicationConflict {
  return SimultaneousApplicationConflictSchema.parse({
    id,
    applicationRecordId: "application_a",
    conflictingApplicationRecordId: "application_b",
    status: "detected",
    explanation: "Two applications overlapped in time.",
    recoveryGuidance: "Review both applications and keep one.",
  });
}

function signalRecord(
  id: string,
  jobId: string,
  signal: ListingSignalRecord["signal"],
  detectedAt: string,
): ListingSignalRecord {
  return ListingSignalRecordSchema.parse({
    id,
    jobId,
    signal,
    detail: null,
    detectedAt,
    confidence: 0.9,
    provenance: "provider",
    explanation: "Provider reported the listing state.",
    recoveryGuidance: "Re-verify the listing before applying.",
  });
}

function pausedPause(
  id: string,
  windowStartedAt: string,
): AbnormalFailurePause {
  return AbnormalFailurePauseSchema.parse({
    id,
    windowStartedAt,
    failuresInWindow: 4,
    sampleSize: 5,
    failureRatePercent: 80,
    failureRateThresholdPercent: 40,
    minimumSample: 5,
    paused: true,
    explanation: "Failure rate is above the threshold.",
    recoveryGuidance: "Inspect failure evidence before resuming.",
  });
}

function pendingReview(id: string): PreparedBatchSampleReview {
  return PreparedBatchSampleReviewSchema.parse({
    id,
    batchId: `batch_${id}`,
    preparedCount: 10,
    sampleCount: 2,
    reviewedCount: 0,
    requiredSampleRatio: 0.2,
    reviewCompleted: false,
    explanation: "Sample review before proceeding.",
    recoveryGuidance: "Review the required sample.",
  });
}

function detectedContradiction(id: string): ContradictoryAnswerDetection {
  return ContradictoryAnswerDetectionSchema.parse({
    id,
    questionA: "question_1",
    questionB: "question_2",
    answerA: "Yes",
    answerB: "No",
    contradictionScore: 0.9,
    status: "detected",
    detectedAt: day1,
    resolvedAt: null,
    explanation: "Answers conflict.",
    recoveryGuidance: "Ask the user to resolve the answers.",
  });
}

function buildSafeguards(input: {
  caps?: CompanyApplicationCap[];
  conflicts?: SimultaneousApplicationConflict[];
  signals?: ListingSignalRecord[];
  pauses?: AbnormalFailurePause[];
  reviews?: PreparedBatchSampleReview[];
  contradictions?: ContradictoryAnswerDetection[];
}): JobFinderIntelligenceSafeguards {
  return JobFinderIntelligenceSafeguardsSchema.parse({
    companyApplicationCaps: input.caps ?? [],
    simultaneousApplicationConflicts: input.conflicts ?? [],
    listingSignals: input.signals ?? [],
    abnormalFailurePauses: input.pauses ?? [],
    preparedBatchSampleReviews: input.reviews ?? [],
    contradictoryAnswerDetections: input.contradictions ?? [],
  });
}

// ---------------------------------------------------------------------------
// Company application caps
// ---------------------------------------------------------------------------

describe("applyCompanyApplicationEvidence", () => {
  test("counts only caller-supplied qualifying evidence within the window and flips limitReached at the boundary", () => {
    const result = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: capEvidence([
        { recordId: "a1", appliedAt: day0 },
        { recordId: "a2", appliedAt: day1 },
        { recordId: "a3", appliedAt: day2 },
      ]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig({ maxApplicationsPerWindow: 3 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.cap.currentWindowCount).toBe(3);
    expect(result.cap.limitReached).toBe(true);
    expect(result.cap.windowStartedAt).toBe(day0);
    expect(result.summary.counted).toBe(3);
    expect(result.summary.ignoredCount).toBe(0);
    expect(result.summary.rolledOver).toBe(false);
    expect(CompanyApplicationCapSchema.safeParse(result.cap).success).toBe(
      true,
    );
    expect(result.safeguards.companyApplicationCaps).toHaveLength(1);
    expect(result.safeguards.updatedAt).toBe(now);

    const under = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: capEvidence([
        { recordId: "a1", appliedAt: day0 },
        { recordId: "a2", appliedAt: day1 },
      ]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig({ maxApplicationsPerWindow: 3 }),
    });
    expect(under.ok).toBe(true);
    if (!under.ok) return;
    expect(under.cap.limitReached).toBe(false);
  });

  test("ignores evidence for other companies (conservative companyId filter)", () => {
    const result = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: capEvidence([
        { recordId: "a1", appliedAt: day0 },
        { recordId: "other_1", companyId: "company_other", appliedAt: day1 },
      ]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cap.currentWindowCount).toBe(1);
    expect(result.summary.counted).toBe(1);
    expect(result.summary.ignoredCount).toBe(1);
  });

  test("dedupes duplicate application record ids", () => {
    const result = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: capEvidence([
        { recordId: "a1", appliedAt: day0 },
        { recordId: "a1", appliedAt: day1 },
        { recordId: "a2", appliedAt: day2 },
      ]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cap.currentWindowCount).toBe(2);
    expect(result.summary.counted).toBe(2);
    expect(result.summary.ignoredCount).toBe(1);
  });

  test("rolls the window forward when evidence falls at or beyond the window end", () => {
    const result = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: capEvidence([
        { recordId: "a1", appliedAt: day0 },
        { recordId: "a2", appliedAt: day2 },
        { recordId: "a3", appliedAt: day8 },
        { recordId: "a4", appliedAt: day9 },
      ]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.rolledOver).toBe(true);
    expect(result.cap.windowStartedAt).toBe(day8);
    expect(result.cap.currentWindowCount).toBe(2); // a3, a4 in [day8, day15)
    expect(result.summary.ignoredCount).toBe(2); // a1, a2 belong to the previous window
  });

  test("treats the window as half-open: evidence exactly at start counts, exactly at end rolls", () => {
    const atStart = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: capEvidence([{ recordId: "a1", appliedAt: day0 }]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig(),
    });
    expect(atStart.ok).toBe(true);
    if (!atStart.ok) return;
    expect(atStart.cap.windowStartedAt).toBe(day0);
    expect(atStart.cap.currentWindowCount).toBe(1);
    expect(atStart.summary.rolledOver).toBe(false);

    const atEnd = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: capEvidence([{ recordId: "a1", appliedAt: day7 }]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig(),
    });
    expect(atEnd.ok).toBe(true);
    if (!atEnd.ok) return;
    expect(atEnd.summary.rolledOver).toBe(true);
    expect(atEnd.cap.windowStartedAt).toBe(day7);
    expect(atEnd.cap.currentWindowCount).toBe(1);
  });

  test("re-applying the same evidence is idempotent", () => {
    const input = {
      safeguards: emptySafeguards(),
      evidence: capEvidence([
        { recordId: "a1", appliedAt: day0 },
        { recordId: "a2", appliedAt: day6 },
      ]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig(),
    };

    const first = applyCompanyApplicationEvidence(input);
    const second = applyCompanyApplicationEvidence(input);

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.safeguards).toEqual(first.safeguards);
    expect(second.cap).toEqual(first.cap);
  });

  test("an empty evidence set derives a zero count and no limit", () => {
    const result = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: [],
      now,
      createCapId: () => "cap_acme",
      config: capConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cap.currentWindowCount).toBe(0);
    expect(result.cap.limitReached).toBe(false);
    expect(result.cap.windowStartedAt).toBe(day0);
    expect(result.summary.ignoredCount).toBe(0);
  });

  test("rejects malformed evidence timestamps and invalid config", () => {
    const badTimestamp = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: capEvidence([{ recordId: "a1", appliedAt: "yesterday" }]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig(),
    });
    expect(badTimestamp.ok).toBe(false);
    if (badTimestamp.ok) return;
    expect(badTimestamp.failure.code).toBe("invalid_input");

    const badMax = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: [],
      now,
      createCapId: () => "cap_acme",
      config: capConfig({ maxApplicationsPerWindow: 0 }),
    });
    expect(badMax.ok).toBe(false);

    const badWindow = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: [],
      now,
      createCapId: () => "cap_acme",
      config: capConfig({ windowDays: 0 }),
    });
    expect(badWindow.ok).toBe(false);

    const badNow = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: [],
      now: "not-a-date",
      createCapId: () => "cap_acme",
      config: capConfig(),
    });
    expect(badNow.ok).toBe(false);

    const badCapId = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: [],
      now,
      createCapId: () => "",
      config: capConfig(),
    });
    expect(badCapId.ok).toBe(false);
    if (badCapId.ok) return;
    expect(badCapId.failure.message).toContain("createCapId");
  });

  test("updates an existing cap in place and preserves its id", () => {
    const first = applyCompanyApplicationEvidence({
      safeguards: emptySafeguards(),
      evidence: capEvidence([{ recordId: "a1", appliedAt: day0 }]),
      now,
      createCapId: () => "cap_acme",
      config: capConfig(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = applyCompanyApplicationEvidence({
      safeguards: first.safeguards,
      evidence: capEvidence([
        { recordId: "a1", appliedAt: day0 },
        { recordId: "a2", appliedAt: day1 },
        { recordId: "a3", appliedAt: day2 },
      ]),
      now,
      createCapId: () => "cap_should_not_be_used",
      config: capConfig({ maxApplicationsPerWindow: 3 }),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cap.id).toBe("cap_acme");
    expect(second.cap.currentWindowCount).toBe(3);
    expect(second.cap.limitReached).toBe(true);
    expect(second.safeguards.companyApplicationCaps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Simultaneous application conflicts
// ---------------------------------------------------------------------------

describe("simultaneous application conflicts", () => {
  test("records a detected conflict and dedupes the unordered application pair", () => {
    const first = recordSimultaneousApplicationConflict({
      safeguards: emptySafeguards(),
      conflict: {
        conflictId: "conflict_1",
        applicationRecordId: "application_a",
        conflictingApplicationRecordId: "application_b",
        explanation: "Overlapping applications.",
        recoveryGuidance: "Review and keep one.",
      },
      now,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.added).toBe(true);
    expect(first.conflict.status).toBe("detected");

    const reversed = recordSimultaneousApplicationConflict({
      safeguards: first.safeguards,
      conflict: {
        conflictId: "conflict_2",
        applicationRecordId: "application_b",
        conflictingApplicationRecordId: "application_a",
        explanation: "Overlapping applications.",
        recoveryGuidance: "Review and keep one.",
      },
      now,
    });
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    expect(reversed.added).toBe(false);
    expect(reversed.conflict.id).toBe("conflict_1");
    expect(reversed.safeguards.simultaneousApplicationConflicts).toHaveLength(
      1,
    );
  });

  test("allows a fresh detection for the same pair after resolution", () => {
    const recorded = recordSimultaneousApplicationConflict({
      safeguards: emptySafeguards(),
      conflict: {
        conflictId: "conflict_1",
        applicationRecordId: "application_a",
        conflictingApplicationRecordId: "application_b",
        explanation: "Overlapping applications.",
        recoveryGuidance: "Review and keep one.",
      },
      now,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const resolved = resolveSimultaneousApplicationConflict({
      safeguards: recorded.safeguards,
      conflictId: "conflict_1",
      now,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.conflict.status).toBe("resolved");
    expect(resolved.changed).toBe(true);

    const redetected = recordSimultaneousApplicationConflict({
      safeguards: resolved.safeguards,
      conflict: {
        conflictId: "conflict_2",
        applicationRecordId: "application_b",
        conflictingApplicationRecordId: "application_a",
        explanation: "Overlapping applications again.",
        recoveryGuidance: "Review and keep one.",
      },
      now,
    });
    expect(redetected.ok).toBe(true);
    if (!redetected.ok) return;
    expect(redetected.added).toBe(true);
    expect(redetected.safeguards.simultaneousApplicationConflicts).toHaveLength(
      2,
    );
  });

  test("resolving is idempotent and unknown ids fail", () => {
    const recorded = recordSimultaneousApplicationConflict({
      safeguards: emptySafeguards(),
      conflict: {
        conflictId: "conflict_1",
        applicationRecordId: "application_a",
        conflictingApplicationRecordId: "application_b",
        explanation: "Overlapping applications.",
        recoveryGuidance: "Review and keep one.",
      },
      now,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const first = resolveSimultaneousApplicationConflict({
      safeguards: recorded.safeguards,
      conflictId: "conflict_1",
      now,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = resolveSimultaneousApplicationConflict({
      safeguards: first.safeguards,
      conflictId: "conflict_1",
      now,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.changed).toBe(false);
    expect(again.safeguards).toEqual(first.safeguards);

    const missing = resolveSimultaneousApplicationConflict({
      safeguards: first.safeguards,
      conflictId: "conflict_nope",
      now,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.failure.code).toBe("not_found");
  });

  test("rejects a conflict between an application and itself", () => {
    const result = recordSimultaneousApplicationConflict({
      safeguards: emptySafeguards(),
      conflict: {
        conflictId: "conflict_1",
        applicationRecordId: "application_a",
        conflictingApplicationRecordId: "application_a",
        explanation: "Overlapping applications.",
        recoveryGuidance: "Review and keep one.",
      },
      now,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("invalid_input");
  });

  test("rejects a duplicate id with different content and no-ops on identical content", () => {
    const base = {
      safeguards: emptySafeguards(),
      now,
      conflict: {
        conflictId: "conflict_1",
        applicationRecordId: "application_a",
        conflictingApplicationRecordId: "application_b",
        explanation: "Overlapping applications.",
        recoveryGuidance: "Review and keep one.",
      },
    };
    const recorded = recordSimultaneousApplicationConflict(base);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const identical = recordSimultaneousApplicationConflict({
      ...base,
      safeguards: recorded.safeguards,
    });
    expect(identical.ok).toBe(true);
    if (!identical.ok) return;
    expect(identical.added).toBe(false);

    const different = recordSimultaneousApplicationConflict({
      safeguards: recorded.safeguards,
      now,
      conflict: {
        conflictId: "conflict_1",
        applicationRecordId: "application_a",
        conflictingApplicationRecordId: "application_c",
        explanation: "Overlapping applications.",
        recoveryGuidance: "Review and keep one.",
      },
    });
    expect(different.ok).toBe(false);
    if (different.ok) return;
    expect(different.failure.code).toBe("duplicate");
  });
});

// ---------------------------------------------------------------------------
// Listing signals
// ---------------------------------------------------------------------------

describe("listing signals", () => {
  test("records stale, closed, and suspicious signals verbatim with provenance", () => {
    let safeguards = emptySafeguards();
    for (const [index, signal] of ["stale", "closed", "suspicious"].entries()) {
      const result = recordListingSignal({
        safeguards,
        signal: {
          id: `signal_${index}`,
          jobId: "job_1",
          signal: signal as ListingSignalRecord["signal"],
          detail: null,
          detectedAt: day1,
          confidence: 0.9,
          provenance: "provider",
          explanation: "Provider reported the listing state.",
          recoveryGuidance: "Re-verify the listing.",
        },
        now,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.signal.signal).toBe(signal);
      expect(result.added).toBe(true);
      safeguards = result.safeguards;
    }
    expect(safeguards.listingSignals).toHaveLength(3);
  });

  test("rejects unknown signal kinds", () => {
    const result = recordListingSignal({
      safeguards: emptySafeguards(),
      signal: {
        id: "signal_bad",
        jobId: "job_1",
        signal: "open" as ListingSignalRecord["signal"],
        detail: null,
        detectedAt: day1,
        confidence: 0.9,
        provenance: "provider",
        explanation: "Provider reported the listing state.",
        recoveryGuidance: "Re-verify the listing.",
      },
      now,
    });
    expect(result.ok).toBe(false);
  });

  test("dedupes by id and rejects same-id different content", () => {
    const base = {
      safeguards: emptySafeguards(),
      now,
      signal: {
        id: "signal_1",
        jobId: "job_1",
        signal: "stale" as ListingSignalRecord["signal"],
        detail: null,
        detectedAt: day1,
        confidence: 0.9,
        provenance: "provider",
        explanation: "Provider reported the listing state.",
        recoveryGuidance: "Re-verify the listing.",
      } satisfies ListingSignalInput,
    };
    const recorded = recordListingSignal(base);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const identical = recordListingSignal({
      ...base,
      safeguards: recorded.safeguards,
    });
    expect(identical.ok).toBe(true);
    if (!identical.ok) return;
    expect(identical.added).toBe(false);

    const different = recordListingSignal({
      safeguards: recorded.safeguards,
      now,
      signal: { ...base.signal, jobId: "job_2" },
    });
    expect(different.ok).toBe(false);
    if (different.ok) return;
    expect(different.failure.code).toBe("duplicate");
  });

  test("deriveLatestListingSignal returns the newest signal with a deterministic tie-break", () => {
    const safeguards = buildSafeguards({
      signals: [
        signalRecord("signal_stale", "job_1", "stale", day1),
        signalRecord("signal_closed", "job_1", "closed", day2),
      ],
    });

    const latest = deriveLatestListingSignal({ safeguards, jobId: "job_1" });
    expect(latest?.id).toBe("signal_closed");

    const tie = deriveLatestListingSignal({
      safeguards: buildSafeguards({
        signals: [
          signalRecord("signal_a", "job_1", "stale", day1),
          signalRecord("signal_b", "job_1", "stale", day1),
        ],
      }),
      jobId: "job_1",
    });
    expect(tie?.id).toBe("signal_b");

    const missing = deriveLatestListingSignal({
      safeguards: buildSafeguards({}),
      jobId: "job_1",
    });
    expect(missing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Abnormal failure pause
// ---------------------------------------------------------------------------

describe("recordAbnormalFailureEvidence", () => {
  test("derives the exact failure rate and pauses at the threshold with a full sample", () => {
    const result = recordAbnormalFailureEvidence({
      safeguards: emptySafeguards(),
      pauseId: "pause_1",
      windowStartedAt: day0,
      evidence: attemptEvidence([
        { attemptId: "t1", failed: true, occurredAt: day0 },
        { attemptId: "t2", failed: true, occurredAt: day1 },
        { attemptId: "t3", failed: false, occurredAt: day2 },
        { attemptId: "t4", failed: true, occurredAt: day3 },
        { attemptId: "t5", failed: false, occurredAt: day4 },
        { attemptId: "t6", failed: true, occurredAt: day6 },
      ]),
      now,
      config: pauseConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.sampleSize).toBe(6);
    expect(result.summary.failuresInWindow).toBe(4);
    expect(result.summary.failureRatePercent).toBe((4 / 6) * 100);
    expect(result.pause.failureRatePercent).toBe((4 / 6) * 100);
    expect(result.summary.paused).toBe(true);
    expect(AbnormalFailurePauseSchema.safeParse(result.pause).success).toBe(
      true,
    );
  });

  test("never pauses below the minimum sample even at a 100% failure rate", () => {
    const result = recordAbnormalFailureEvidence({
      safeguards: emptySafeguards(),
      pauseId: "pause_1",
      windowStartedAt: day0,
      evidence: attemptEvidence([
        { attemptId: "t1", failed: true, occurredAt: day0 },
        { attemptId: "t2", failed: true, occurredAt: day1 },
      ]),
      now,
      config: pauseConfig({ minimumSample: 5 }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.failureRatePercent).toBe(100);
    expect(result.summary.paused).toBe(false);
    expect(result.pause.paused).toBe(false);
  });

  test("pauses exactly at the threshold rate boundary", () => {
    const result = recordAbnormalFailureEvidence({
      safeguards: emptySafeguards(),
      pauseId: "pause_1",
      windowStartedAt: day0,
      evidence: attemptEvidence([
        { attemptId: "t1", failed: true, occurredAt: day0 },
        { attemptId: "t2", failed: true, occurredAt: day1 },
        { attemptId: "t3", failed: false, occurredAt: day2 },
        { attemptId: "t4", failed: false, occurredAt: day3 },
        { attemptId: "t5", failed: false, occurredAt: day4 },
      ]),
      now,
      config: pauseConfig({
        failureRateThresholdPercent: 40,
        minimumSample: 5,
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.failureRatePercent).toBe(40);
    expect(result.summary.paused).toBe(true);
  });

  test("rolls the window forward when attempts fall at or beyond the window end", () => {
    const result = recordAbnormalFailureEvidence({
      safeguards: emptySafeguards(),
      pauseId: "pause_1",
      windowStartedAt: day0,
      evidence: attemptEvidence([
        { attemptId: "t1", failed: true, occurredAt: day0 },
        { attemptId: "t2", failed: true, occurredAt: day8 },
        { attemptId: "t3", failed: false, occurredAt: day9 },
      ]),
      now,
      config: pauseConfig(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.rolledOver).toBe(true);
    expect(result.pause.windowStartedAt).toBe(day8);
    expect(result.summary.sampleSize).toBe(2);
    expect(result.summary.failuresInWindow).toBe(1);
    expect(result.summary.ignoredCount).toBe(1);
    expect(result.summary.paused).toBe(false); // sample below the minimum
  });

  test("dedupes attempt ids and re-applying the same evidence is idempotent", () => {
    const input = {
      safeguards: emptySafeguards(),
      pauseId: "pause_1",
      windowStartedAt: day0,
      evidence: attemptEvidence([
        { attemptId: "t1", failed: true, occurredAt: day0 },
        { attemptId: "t1", failed: false, occurredAt: day1 },
        { attemptId: "t2", failed: true, occurredAt: day2 },
        { attemptId: "t3", failed: true, occurredAt: day3 },
        { attemptId: "t4", failed: true, occurredAt: day4 },
        { attemptId: "t5", failed: false, occurredAt: day6 },
      ]),
      now,
      config: pauseConfig(),
    };

    const first = recordAbnormalFailureEvidence(input);
    const second = recordAbnormalFailureEvidence(input);

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.summary.sampleSize).toBe(5);
    expect(first.summary.failuresInWindow).toBe(4);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.safeguards).toEqual(first.safeguards);
    expect(second.pause).toEqual(first.pause);
  });

  test("rejects invalid evidence timestamps and invalid config", () => {
    const badTimestamp = recordAbnormalFailureEvidence({
      safeguards: emptySafeguards(),
      pauseId: "pause_1",
      windowStartedAt: day0,
      evidence: attemptEvidence([
        { attemptId: "t1", failed: true, occurredAt: "nope" },
      ]),
      now,
      config: pauseConfig(),
    });
    expect(badTimestamp.ok).toBe(false);

    const badThreshold = recordAbnormalFailureEvidence({
      safeguards: emptySafeguards(),
      pauseId: "pause_1",
      windowStartedAt: day0,
      evidence: [],
      now,
      config: pauseConfig({ failureRateThresholdPercent: 101 }),
    });
    expect(badThreshold.ok).toBe(false);

    const badWindowDays = recordAbnormalFailureEvidence({
      safeguards: emptySafeguards(),
      pauseId: "pause_1",
      windowStartedAt: day0,
      evidence: [],
      now,
      config: pauseConfig({ windowDays: 0 }),
    });
    expect(badWindowDays.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prepared-batch sample review
// ---------------------------------------------------------------------------

describe("prepared-batch sample review", () => {
  test("samples deterministically regardless of input order", () => {
    const preparedA = [{ id: "item_b" }, { id: "item_a" }, { id: "item_c" }];
    const preparedB = [{ id: "item_c" }, { id: "item_a" }, { id: "item_b" }];

    const first = deriveBatchSampleIds({
      batchId: "batch_1",
      prepared: preparedA,
      sampleCount: 2,
    });
    const second = deriveBatchSampleIds({
      batchId: "batch_1",
      prepared: preparedB,
      sampleCount: 2,
    });

    expect(first).toEqual(second);

    const prepareA = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_1",
      batchId: "batch_1",
      prepared: preparedA,
      requiredSampleRatio: 0.2,
      explanation: "Sample review before proceeding.",
      recoveryGuidance: "Review the required sample.",
      now,
    });
    const prepareB = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_1",
      batchId: "batch_1",
      prepared: preparedB,
      requiredSampleRatio: 0.2,
      explanation: "Sample review before proceeding.",
      recoveryGuidance: "Review the required sample.",
      now,
    });
    expect(prepareA.ok).toBe(true);
    if (!prepareA.ok) return;
    expect(prepareB.ok).toBe(true);
    if (!prepareB.ok) return;
    expect(prepareB.sampledIds).toEqual(prepareA.sampledIds);
    expect(prepareB.review).toEqual(prepareA.review);
  });

  test("computes the required sample as ceil(preparedCount * ratio) with a minimum of one", () => {
    const hundred = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_100",
      batchId: "batch_100",
      prepared: Array.from({ length: 100 }, (_, index) => ({
        id: `item_${index}`,
      })),
      requiredSampleRatio: 0.2,
      explanation: "Sample review.",
      recoveryGuidance: "Review the sample.",
      now,
    });
    expect(hundred.ok).toBe(true);
    if (!hundred.ok) return;
    expect(hundred.requiredSample).toBe(20);
    expect(hundred.sampleCount).toBe(20);
    expect(hundred.review.sampleCount).toBe(20);

    const five = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_5",
      batchId: "batch_5",
      prepared: [
        { id: "a" },
        { id: "b" },
        { id: "c" },
        { id: "d" },
        { id: "e" },
      ],
      requiredSampleRatio: 0.5,
      explanation: "Sample review.",
      recoveryGuidance: "Review the sample.",
      now,
    });
    expect(five.ok).toBe(true);
    if (!five.ok) return;
    expect(five.requiredSample).toBe(Math.ceil(5 * 0.5));
    expect(five.sampleCount).toBe(3);
    expect(five.sampleCount).toBeLessThanOrEqual(5);

    const zeroRatio = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_zero",
      batchId: "batch_zero",
      prepared: [{ id: "a" }, { id: "b" }],
      requiredSampleRatio: 0,
      explanation: "Sample review.",
      recoveryGuidance: "Review the sample.",
      now,
    });
    expect(zeroRatio.ok).toBe(true);
    if (!zeroRatio.ok) return;
    expect(zeroRatio.sampleCount).toBe(1);
  });

  test("rejects an empty prepared batch and dedupes prepared ids", () => {
    const empty = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_empty",
      batchId: "batch_empty",
      prepared: [],
      requiredSampleRatio: 0.2,
      explanation: "Sample review.",
      recoveryGuidance: "Review the sample.",
      now,
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.failure.code).toBe("invalid_input");
    expect(empty.failure.message).toContain("empty");

    const duplicates = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_dup",
      batchId: "batch_dup",
      prepared: [{ id: "a" }, { id: "a" }, { id: "b" }],
      requiredSampleRatio: 0.5,
      explanation: "Sample review.",
      recoveryGuidance: "Review the sample.",
      now,
    });
    expect(duplicates.ok).toBe(true);
    if (!duplicates.ok) return;
    expect(duplicates.review.preparedCount).toBe(2);
  });

  test("tracks review progress and enforces completion requires the full sample", () => {
    const prepared = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_1",
      batchId: "batch_1",
      prepared: Array.from({ length: 10 }, (_, index) => ({
        id: `item_${index}`,
      })),
      requiredSampleRatio: 0.2,
      explanation: "Sample review before proceeding.",
      recoveryGuidance: "Review the required sample.",
      now,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const partial = updateBatchSampleReview({
      safeguards: prepared.safeguards,
      reviewId: "review_1",
      reviewedCount: 1,
      reviewCompleted: false,
      now,
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.review.reviewedCount).toBe(1);
    expect(partial.review.reviewCompleted).toBe(false);

    const completed = updateBatchSampleReview({
      safeguards: partial.safeguards,
      reviewId: "review_1",
      reviewedCount: 2,
      reviewCompleted: true,
      now,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.review.reviewCompleted).toBe(true);

    const again = updateBatchSampleReview({
      safeguards: completed.safeguards,
      reviewId: "review_1",
      reviewedCount: 2,
      reviewCompleted: true,
      now,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.changed).toBe(false);
    expect(again.safeguards).toEqual(completed.safeguards);

    const overSample = updateBatchSampleReview({
      safeguards: prepared.safeguards,
      reviewId: "review_1",
      reviewedCount: 3,
      reviewCompleted: false,
      now,
    });
    expect(overSample.ok).toBe(false);

    const prematureComplete = updateBatchSampleReview({
      safeguards: partial.safeguards,
      reviewId: "review_1",
      reviewedCount: 1,
      reviewCompleted: true,
      now,
    });
    expect(prematureComplete.ok).toBe(false);
  });

  test("re-preparing an unchanged batch preserves progress; a changed batch resets it", () => {
    const prepared = Array.from({ length: 10 }, (_, index) => ({
      id: `item_${index}`,
    }));
    const first = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_1",
      batchId: "batch_1",
      prepared,
      requiredSampleRatio: 0.2,
      explanation: "Sample review before proceeding.",
      recoveryGuidance: "Review the required sample.",
      now,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const progressed = updateBatchSampleReview({
      safeguards: first.safeguards,
      reviewId: "review_1",
      reviewedCount: 1,
      reviewCompleted: false,
      now,
    });
    expect(progressed.ok).toBe(true);
    if (!progressed.ok) return;

    const reprepare = prepareBatchSampleReview({
      safeguards: progressed.safeguards,
      reviewId: "review_1",
      batchId: "batch_1",
      prepared,
      requiredSampleRatio: 0.2,
      explanation: "Sample review before proceeding.",
      recoveryGuidance: "Review the required sample.",
      now,
    });
    expect(reprepare.ok).toBe(true);
    if (!reprepare.ok) return;
    expect(reprepare.reset).toBe(false);
    expect(reprepare.review.reviewedCount).toBe(1);

    const changed = prepareBatchSampleReview({
      safeguards: progressed.safeguards,
      reviewId: "review_1",
      batchId: "batch_1",
      prepared: Array.from({ length: 20 }, (_, index) => ({
        id: `item_${index}`,
      })),
      requiredSampleRatio: 0.2,
      explanation: "Sample review before proceeding.",
      recoveryGuidance: "Review the required sample.",
      now,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.reset).toBe(true);
    expect(changed.review.reviewedCount).toBe(0);
    expect(changed.review.reviewCompleted).toBe(false);
    expect(changed.review.preparedCount).toBe(20);
  });

  test("rejects a review id already bound to a different batch", () => {
    const first = prepareBatchSampleReview({
      safeguards: emptySafeguards(),
      reviewId: "review_1",
      batchId: "batch_1",
      prepared: [{ id: "a" }, { id: "b" }],
      requiredSampleRatio: 0.5,
      explanation: "Sample review.",
      recoveryGuidance: "Review the sample.",
      now,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const conflict = prepareBatchSampleReview({
      safeguards: first.safeguards,
      reviewId: "review_2",
      batchId: "batch_1",
      prepared: [{ id: "a" }, { id: "b" }],
      requiredSampleRatio: 0.5,
      explanation: "Sample review.",
      recoveryGuidance: "Review the sample.",
      now,
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.failure.code).toBe("duplicate");
  });
});

// ---------------------------------------------------------------------------
// Contradictory answer detections
// ---------------------------------------------------------------------------

describe("contradictory answer detections", () => {
  test("records a detection with score bounds and distinct questions", () => {
    const result = recordContradictoryAnswerDetection({
      safeguards: emptySafeguards(),
      detection: {
        detectionId: "detection_1",
        questionA: "question_1",
        questionB: "question_2",
        answerA: "Yes",
        answerB: "No",
        contradictionScore: 0.9,
        detectedAt: day1,
        explanation: "Answers conflict.",
        recoveryGuidance: "Ask the user to resolve the answers.",
      },
      now,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.added).toBe(true);
    expect(result.detection.status).toBe("detected");
    expect(result.detection.resolvedAt).toBeNull();

    const highScore = recordContradictoryAnswerDetection({
      safeguards: emptySafeguards(),
      detection: {
        detectionId: "detection_bad",
        questionA: "question_1",
        questionB: "question_2",
        answerA: "Yes",
        answerB: "No",
        contradictionScore: 1.5,
        detectedAt: day1,
        explanation: "Answers conflict.",
        recoveryGuidance: "Ask the user to resolve the answers.",
      },
      now,
    });
    expect(highScore.ok).toBe(false);

    const sameQuestion = recordContradictoryAnswerDetection({
      safeguards: emptySafeguards(),
      detection: {
        detectionId: "detection_bad",
        questionA: "question_1",
        questionB: "question_1",
        answerA: "Yes",
        answerB: "No",
        contradictionScore: 0.9,
        detectedAt: day1,
        explanation: "Answers conflict.",
        recoveryGuidance: "Ask the user to resolve the answers.",
      },
      now,
    });
    expect(sameQuestion.ok).toBe(false);
  });

  test("dedupes the unordered question pair while a detection is active", () => {
    const first = recordContradictoryAnswerDetection({
      safeguards: emptySafeguards(),
      detection: {
        detectionId: "detection_1",
        questionA: "question_1",
        questionB: "question_2",
        answerA: "Yes",
        answerB: "No",
        contradictionScore: 0.9,
        detectedAt: day1,
        explanation: "Answers conflict.",
        recoveryGuidance: "Ask the user to resolve the answers.",
      },
      now,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const reversed = recordContradictoryAnswerDetection({
      safeguards: first.safeguards,
      detection: {
        detectionId: "detection_2",
        questionA: "question_2",
        questionB: "question_1",
        answerA: "No",
        answerB: "Yes",
        contradictionScore: 0.8,
        detectedAt: day2,
        explanation: "Answers conflict.",
        recoveryGuidance: "Ask the user to resolve the answers.",
      },
      now,
    });
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    expect(reversed.added).toBe(false);
    expect(reversed.safeguards.contradictoryAnswerDetections).toHaveLength(1);

    const resolved = resolveContradictoryAnswerDetection({
      safeguards: first.safeguards,
      detectionId: "detection_1",
      now,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const redetected = recordContradictoryAnswerDetection({
      safeguards: resolved.safeguards,
      detection: {
        detectionId: "detection_3",
        questionA: "question_2",
        questionB: "question_1",
        answerA: "No",
        answerB: "Yes",
        contradictionScore: 0.8,
        detectedAt: day2,
        explanation: "Answers conflict again.",
        recoveryGuidance: "Ask the user to resolve the answers.",
      },
      now,
    });
    expect(redetected.ok).toBe(true);
    if (!redetected.ok) return;
    expect(redetected.added).toBe(true);
  });

  test("resolving stamps resolvedAt; dismissing keeps it null; both are idempotent", () => {
    const recorded = recordContradictoryAnswerDetection({
      safeguards: emptySafeguards(),
      detection: {
        detectionId: "detection_1",
        questionA: "question_1",
        questionB: "question_2",
        answerA: "Yes",
        answerB: "No",
        contradictionScore: 0.9,
        detectedAt: day1,
        explanation: "Answers conflict.",
        recoveryGuidance: "Ask the user to resolve the answers.",
      },
      now,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const resolved = resolveContradictoryAnswerDetection({
      safeguards: recorded.safeguards,
      detectionId: "detection_1",
      now,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.detection.status).toBe("resolved");
    expect(resolved.detection.resolvedAt).toBe(now);
    expect(
      ContradictoryAnswerDetectionSchema.safeParse(resolved.detection).success,
    ).toBe(true);

    const again = resolveContradictoryAnswerDetection({
      safeguards: resolved.safeguards,
      detectionId: "detection_1",
      now,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.changed).toBe(false);

    const dismissed = dismissContradictoryAnswerDetection({
      safeguards: resolved.safeguards,
      detectionId: "detection_1",
      now,
    });
    expect(dismissed.ok).toBe(true);
    if (!dismissed.ok) return;
    expect(dismissed.detection.status).toBe("dismissed");
    expect(dismissed.detection.resolvedAt).toBeNull();

    const missing = resolveContradictoryAnswerDetection({
      safeguards: recorded.safeguards,
      detectionId: "detection_nope",
      now,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.failure.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Deterministic gate
// ---------------------------------------------------------------------------

describe("deriveHighestPriorityBlocker", () => {
  test("returns null when nothing is active", () => {
    expect(
      deriveHighestPriorityBlocker({ safeguards: emptySafeguards() }),
    ).toBeNull();
  });

  test("returns the highest-priority active blocker in contract order", () => {
    const all = buildSafeguards({
      caps: [capAtLimit("cap_1", day0)],
      conflicts: [detectedConflict("conflict_1")],
      signals: [signalRecord("signal_1", "job_1", "suspicious", day1)],
      pauses: [pausedPause("pause_1", day0)],
      reviews: [pendingReview("review_1")],
      contradictions: [detectedContradiction("detection_1")],
    });

    const capBlocker = deriveHighestPriorityBlocker({ safeguards: all });
    expect(capBlocker?.kind).toBe("company_cap_limit");
    expect(capBlocker?.severity).toBe("blocker");
    expect(capBlocker?.priority).toBe(1);
    expect(capBlocker?.recoveryGuidance).toBe("Wait for rollover.");

    const withoutCaps = deriveHighestPriorityBlocker({
      safeguards: buildSafeguards({
        conflicts: [detectedConflict("conflict_1")],
        signals: [signalRecord("signal_1", "job_1", "suspicious", day1)],
        pauses: [pausedPause("pause_1", day0)],
        reviews: [pendingReview("review_1")],
        contradictions: [detectedContradiction("detection_1")],
      }),
    });
    expect(withoutCaps?.kind).toBe("simultaneous_application_conflict");

    const withoutConflicts = deriveHighestPriorityBlocker({
      safeguards: buildSafeguards({
        signals: [signalRecord("signal_1", "job_1", "suspicious", day1)],
        pauses: [pausedPause("pause_1", day0)],
        reviews: [pendingReview("review_1")],
        contradictions: [detectedContradiction("detection_1")],
      }),
    });
    expect(withoutConflicts?.kind).toBe("listing_signal");

    const withoutSignals = deriveHighestPriorityBlocker({
      safeguards: buildSafeguards({
        pauses: [pausedPause("pause_1", day0)],
        reviews: [pendingReview("review_1")],
        contradictions: [detectedContradiction("detection_1")],
      }),
    });
    expect(withoutSignals?.kind).toBe("abnormal_failure_pause");

    const withoutPauses = deriveHighestPriorityBlocker({
      safeguards: buildSafeguards({
        reviews: [pendingReview("review_1")],
        contradictions: [detectedContradiction("detection_1")],
      }),
    });
    // A pending sample review no longer holds anything back.
    expect(withoutPauses?.kind).toBe("contradictory_answer");

    const advisoryOnly = deriveHighestPriorityBlocker({
      safeguards: buildSafeguards({
        contradictions: [detectedContradiction("detection_1")],
      }),
    });
    expect(advisoryOnly?.kind).toBe("contradictory_answer");
    expect(advisoryOnly?.severity).toBe("advisory");
    expect(advisoryOnly?.priority).toBe(6);
  });

  test("breaks ties deterministically by timestamp then id", () => {
    const conflicts = deriveHighestPriorityBlocker({
      safeguards: buildSafeguards({
        conflicts: [
          detectedConflict("conflict_b"),
          detectedConflict("conflict_a"),
        ],
      }),
    });
    expect(conflicts?.id).toBe("conflict_a");

    const caps = deriveHighestPriorityBlocker({
      safeguards: buildSafeguards({
        caps: [capAtLimit("cap_later", day7), capAtLimit("cap_earlier", day0)],
      }),
    });
    expect(caps?.id).toBe("cap_earlier");
  });

  test("considers only the latest signal per job and ranks suspicious above stale", () => {
    const gate = deriveHighestPriorityBlocker({
      safeguards: buildSafeguards({
        signals: [
          signalRecord("signal_stale", "job_1", "stale", day2),
          signalRecord("signal_closed", "job_1", "closed", day1),
          signalRecord("signal_suspicious", "job_2", "suspicious", day0),
        ],
      }),
    });
    expect(gate?.id).toBe("signal_suspicious");

    const latestWinsWithinJob = deriveHighestPriorityBlocker({
      safeguards: buildSafeguards({
        signals: [
          signalRecord("signal_stale_late", "job_1", "stale", day2),
          signalRecord("signal_closed_early", "job_1", "closed", day1),
        ],
      }),
    });
    expect(latestWinsWithinJob?.id).toBe("signal_stale_late");
  });

  test("ignores resolved, dismissed, completed, and under-threshold states", () => {
    const resolvedConflict = detectedConflict("conflict_1");
    resolvedConflict.status = "resolved";
    const resolvedContradiction = detectedContradiction("detection_1");
    resolvedContradiction.status = "dismissed";
    const completedReview = pendingReview("review_1");
    completedReview.reviewedCount = 2;
    completedReview.reviewCompleted = true;

    const safeguards = buildSafeguards({
      caps: [],
      conflicts: [resolvedConflict],
      signals: [],
      pauses: [],
      reviews: [completedReview],
      contradictions: [resolvedContradiction],
    });

    expect(deriveHighestPriorityBlocker({ safeguards })).toBeNull();
  });
});

/**
 * Which trouble stands in the way of which work.
 *
 * A search plan that paused its own runs after failed searches has nothing to
 * say about an application the person is preparing, and the sentence a person
 * reads never carries an internal reference.
 */
describe("safeguard blocker scope", () => {
  const discoveryPause = () =>
    AbnormalFailurePauseSchema.parse({
      id: "automatic_discovery_failures:campaign_default",
      windowStartedAt: day0,
      failuresInWindow: 4,
      sampleSize: 5,
      failureRatePercent: 80,
      failureRateThresholdPercent: 40,
      minimumSample: 5,
      paused: true,
      explanation:
        "Too many searches or source checks failed in a row, so this search plan paused itself.",
      recoveryGuidance:
        "Open Search history to see which source failed and why.",
    });

  test("a discovery pause never blocks preparing an application", () => {
    const safeguards = buildSafeguards({ pauses: [discoveryPause()] });

    expect(
      deriveActiveSafeguardBlockers({ safeguards, operation: "apply" }),
    ).toEqual([]);
    expect(deriveScopeBlockers({ safeguards, operation: "apply" })).toEqual([]);
    expect(
      deriveActiveSafeguardBlockers({ safeguards, operation: "discovery" }),
    ).toHaveLength(1);
  });

  test("a pause the person set themselves still stops everything", () => {
    const safeguards = buildSafeguards({
      pauses: [pausedPause("pause_1", day0)],
    });

    expect(
      deriveActiveSafeguardBlockers({ safeguards, operation: "apply" }),
    ).toHaveLength(1);
    expect(
      deriveActiveSafeguardBlockers({ safeguards, operation: "discovery" }),
    ).toHaveLength(1);
  });

  test("the code travels beside the sentence, never inside it", () => {
    const blocker = deriveActiveSafeguardBlockers({
      safeguards: buildSafeguards({ pauses: [discoveryPause()] }),
    })[0];

    expect(blocker?.scope).toBe("discovery");
    expect(blocker?.code).toBe(
      "abnormal_failure_pause: automatic_discovery_failures:campaign_default",
    );
    expect(blocker?.explanation).not.toContain("abnormal_failure_pause");
    expect(blocker?.explanation).not.toContain("campaign_default");
  });

  test("the Safeguards screen still sees everything active", () => {
    expect(
      deriveActiveSafeguardBlockers({
        safeguards: buildSafeguards({ pauses: [discoveryPause()] }),
      }),
    ).toHaveLength(1);
  });
});
