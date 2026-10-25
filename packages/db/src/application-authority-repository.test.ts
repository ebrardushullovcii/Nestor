import type { ApplicationAttestationKind } from "@nestor/contracts";
import {
  ApplyJobResultSchema,
  ApplicationAuthorityEnvelopeSchema,
  ApplicationRecordSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  SubmissionArmedMarkerSchema,
  SubmissionExecutionGrantSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionPreflightRecordSchema,
} from "@nestor/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

const at = "2026-08-27T10:00:00.000Z";
const later = "2026-08-27T10:05:00.000Z";
const verifiedAt = "2026-08-27T10:10:00.000Z";
const expiry = "2026-08-27T11:00:00.000Z";
const digest = "a".repeat(64);
const decisionPolicyRules = {
  version: 1 as const,
  answerPolicy: {
    approvedAnswerSnapshot: { revision: 1, digest },
    unknownRequiredQuestion: "pause_for_user" as const,
    unknownEligibility: "pause_for_user" as const,
    unknownLegalRequirement: "pause_for_user" as const,
    preApprovedAttestationKinds: [] as ApplicationAttestationKind[],
    salaryDisclosure: "pause_for_user" as const,
  },
  stopConditions: {
    unavailableCredentials: "pause_for_user" as const,
    loginRequired: "pause_for_user" as const,
    mfaRequired: "pause_for_user" as const,
    captcha: "pause_for_user" as const,
    antiBot: "pause_for_user" as const,
    accountCreation: "pause_for_user" as const,
    staleObservation: "pause_for_user" as const,
    ambiguousFinalControl: "pause_for_user" as const,
    originDrift: "pause_for_user" as const,
    outcomeUncertain: "stop_no_retry" as const,
  },
} as const;
const decisionPolicy = {
  ...decisionPolicyRules,
  revision: 1,
  digest: createHash("sha256")
    .update(
      serializeApplicationAuthorityDecisionPolicyForDigest(decisionPolicyRules),
      "utf8",
    )
    .digest("hex"),
} as const;

function createEnvelope() {
  return ApplicationAuthorityEnvelopeSchema.parse({
    id: "authority_1",
    mode: "confirm_before_submit",
    status: "active",
    revision: 1,
    scope: { campaignId: null, jobIds: ["job_1"] },
    maxApplicationsPerRun: 1,
    intermediateMutationsAuthorized: false,
    accountCreationAuthorized: false,
    allowedResumeSha256: [digest],
    allowedOrigins: ["https://jobs.example.com"],
    createdAt: at,
    expiresAt: expiry,
    revokedAt: null,
    decisionPolicy,
  });
}

function createPreflight() {
  return SubmissionPreflightRecordSchema.parse({
    id: "preflight_1",
    idempotencyKey: "submit_once_1",
    runId: "run_1",
    jobId: "job_1",
    resultId: "result_1",
    applicationRecordId: "application_1",
    campaignId: null,
    origin: "https://jobs.example.com",
    authorityEnvelopeId: "authority_1",
    authorityRevision: 1,
    decisionPolicy: {
      version: decisionPolicy.version,
      revision: decisionPolicy.revision,
      digest: decisionPolicy.digest,
    },
    formObservation: { id: "observation_1", revision: 1, digest },
    resumeSha256: digest,
    answers: { revision: 1, digest },
    finalControl: { signature: digest, ref: "final_control_1" },
    remainingRunCapacityBefore: 1,
    createdAt: at,
  });
}

function createGrant() {
  return SubmissionExecutionGrantSchema.parse({
    id: "grant_1",
    preflightId: "preflight_1",
    idempotencyKey: "submit_once_1",
    runId: "run_1",
    jobId: "job_1",
    resultId: "result_1",
    applicationRecordId: "application_1",
    authorityEnvelopeId: "authority_1",
    authorityRevision: 1,
    mode: "confirm_before_submit",
    status: "active",
    grantedBy: "user",
    grantedAt: at,
    expiresAt: expiry,
    revokedAt: null,
    consumedAt: null,
  });
}

function createApplyJobResult(input: {
  resultId: string;
  runId: string;
  jobId: string;
  applicationRecordId: string;
}) {
  return ApplyJobResultSchema.parse({
    id: input.resultId,
    runId: input.runId,
    jobId: input.jobId,
    applicationRecordId: input.applicationRecordId,
    state: "submitting",
    summary: "Application is ready for final action.",
    detail: "The final action is awaiting a durable outcome.",
    startedAt: at,
    updatedAt: later,
    privacyReceipt: {
      generatedAt: later,
      lineage: {
        runId: input.runId,
        jobId: input.jobId,
        resultId: input.resultId,
        applicationRecordId: input.applicationRecordId,
      },
      destination: {
        origin: "https://jobs.example.com",
        safePath: "/apply",
      },
      resume: {
        source: "original_upload",
        sourceDocumentId: "resume_1",
        exportArtifactId: null,
        fileName: "alex-vanguard.pdf",
        sha256: digest,
      },
      finalSubmitOccurred: false,
      submissionOutcome: null,
    },
  });
}

function createApplicationRecord(input: {
  applicationRecordId: string;
  jobId: string;
}) {
  return ApplicationRecordSchema.parse({
    id: input.applicationRecordId,
    jobId: input.jobId,
    title: "Software Engineer",
    company: "Example Inc",
    status: "approved",
    lastActionLabel: "Application prepared.",
    nextActionLabel: "Review the prepared application.",
    lastUpdatedAt: at,
    lastAttemptState: "ready",
    crm: {
      revision: 2,
      stage: "preparing",
      stageChangedAt: at,
    },
    events: [
      {
        id: `event_${input.applicationRecordId}_existing`,
        at,
        title: "Application prepared",
        detail: "The application is ready for review.",
        emphasis: "neutral",
      },
    ],
  });
}

function createOutcome(
  preflight: ReturnType<typeof createPreflight>,
  outcome: "not_submitted" | "outcome_uncertain" = "not_submitted",
) {
  return SubmissionOutcomeRecordSchema.parse({
    id: `${outcome}_${preflight.id}`,
    preflightId: preflight.id,
    idempotencyKey: preflight.idempotencyKey,
    authorityEnvelopeId: preflight.authorityEnvelopeId,
    authorityRevision: preflight.authorityRevision,
    runId: preflight.runId,
    jobId: preflight.jobId,
    resultId: preflight.resultId,
    applicationRecordId: preflight.applicationRecordId,
    outcome,
    attemptedAt: later,
    verifiedAt: outcome === "not_submitted" ? later : null,
    evidence: [],
    retry:
      outcome === "not_submitted"
        ? { eligible: true, blockReason: null }
        : { eligible: false, blockReason: "outcome_uncertain" },
  });
}

function createOperatorResolution(
  preflight: ReturnType<typeof createPreflight>,
  outcome: "submitted" | "not_submitted",
) {
  return SubmissionOutcomeRecordSchema.parse({
    id: `operator_${outcome}_${preflight.id}`,
    preflightId: preflight.id,
    idempotencyKey: preflight.idempotencyKey,
    authorityEnvelopeId: preflight.authorityEnvelopeId,
    authorityRevision: preflight.authorityRevision,
    runId: preflight.runId,
    jobId: preflight.jobId,
    resultId: preflight.resultId,
    applicationRecordId: preflight.applicationRecordId,
    outcome,
    attemptedAt: later,
    verifiedAt,
    evidence: [
      {
        id: `evidence_${outcome}_${preflight.id}`,
        kind: "operator_confirmation",
        observedAt: verifiedAt,
        destination: {
          origin: "https://jobs.example.com",
          safePath: "/apply",
        },
        artifactRefId: null,
        summary:
          outcome === "submitted"
            ? "Operator confirmed the employer-site confirmation state."
            : "Operator confirmed the employer site showed no completed submission.",
      },
    ],
    retry:
      outcome === "submitted"
        ? { eligible: false, blockReason: "submission_confirmed" }
        : { eligible: false, blockReason: "policy_decision" },
  });
}

function createMarker(
  preflight: ReturnType<typeof createPreflight>,
  id: string,
  armedAt = later,
) {
  return SubmissionArmedMarkerSchema.parse({
    id,
    idempotencyKey: preflight.idempotencyKey,
    preflightId: preflight.id,
    authorityEnvelopeId: preflight.authorityEnvelopeId,
    authorityRevision: preflight.authorityRevision,
    runId: preflight.runId,
    jobId: preflight.jobId,
    resultId: preflight.resultId,
    applicationRecordId: preflight.applicationRecordId,
    armedAt,
  });
}

function createAuthorityFixture(
  suffix: string,
  mode: "confirm_before_submit" | "autonomous_submit",
  options: {
    envelope?: Partial<ReturnType<typeof createEnvelope>>;
    preflight?: Partial<ReturnType<typeof createPreflight>>;
  } = {},
) {
  const envelope = ApplicationAuthorityEnvelopeSchema.parse({
    ...createEnvelope(),
    id: `authority_${suffix}`,
    mode,
    scope: { campaignId: null, jobIds: [`job_${suffix}`] },
    ...options.envelope,
  });
  const preflight = SubmissionPreflightRecordSchema.parse({
    ...createPreflight(),
    id: `preflight_${suffix}`,
    idempotencyKey: `submit_once_${suffix}`,
    runId: `run_${suffix}`,
    jobId: `job_${suffix}`,
    resultId: `result_${suffix}`,
    applicationRecordId: `application_${suffix}`,
    authorityEnvelopeId: envelope.id,
    ...options.preflight,
  });
  const grant =
    mode === "confirm_before_submit"
      ? SubmissionExecutionGrantSchema.parse({
          ...createGrant(),
          id: `grant_${suffix}`,
          preflightId: preflight.id,
          idempotencyKey: preflight.idempotencyKey,
          runId: preflight.runId,
          jobId: preflight.jobId,
          resultId: preflight.resultId,
          applicationRecordId: preflight.applicationRecordId,
          authorityEnvelopeId: envelope.id,
        })
      : null;
  return {
    envelope,
    preflight,
    grant,
    marker: createMarker(preflight, `armed_${suffix}`),
  };
}

function createReplacementEnvelope(id: string, jobId: string) {
  return ApplicationAuthorityEnvelopeSchema.parse({
    ...createEnvelope(),
    id,
    mode: "prepare_only",
    scope: { campaignId: null, jobIds: [jobId] },
  });
}

async function persistAuthorityFixture(
  repository: JobFinderRepository,
  fixture: ReturnType<typeof createAuthorityFixture>,
  options: {
    applicationRecord?: ReturnType<typeof createApplicationRecord> | null;
  } = {},
) {
  const applicationRecord =
    options.applicationRecord === undefined
      ? createApplicationRecord({
          applicationRecordId: fixture.preflight.applicationRecordId,
          jobId: fixture.preflight.jobId,
        })
      : options.applicationRecord;
  if (applicationRecord) {
    await repository.upsertApplicationRecord(applicationRecord);
  }
  await repository.upsertApplyJobResult(
    createApplyJobResult({
      resultId: fixture.preflight.resultId,
      runId: fixture.preflight.runId,
      jobId: fixture.preflight.jobId,
      applicationRecordId: fixture.preflight.applicationRecordId,
    }),
  );
  expect(
    await repository.commitApplicationAuthorityEnvelope({
      envelope: fixture.envelope,
      expectedRevision: null,
    }),
  ).toMatchObject({ status: "applied" });
  expect(
    await repository.commitSubmissionPreflight(fixture.preflight),
  ).toMatchObject({ status: "created" });
  if (fixture.grant) {
    expect(
      await repository.commitSubmissionExecutionGrant(fixture.grant),
    ).toMatchObject({ status: "created" });
  }
}

async function exerciseAuthorityLifecycle(repository: JobFinderRepository) {
  const envelope = createEnvelope();
  await repository.upsertApplicationRecord(
    createApplicationRecord({
      applicationRecordId: "application_1",
      jobId: "job_1",
    }),
  );
  await repository.upsertApplyJobResult(
    createApplyJobResult({
      resultId: "result_1",
      runId: "run_1",
      jobId: "job_1",
      applicationRecordId: "application_1",
    }),
  );
  expect(
    await repository.commitApplicationAuthorityEnvelope({
      envelope,
      expectedRevision: null,
    }),
  ).toMatchObject({ status: "applied", envelope });
  expect(
    await repository.commitApplicationAuthorityEnvelope({
      envelope,
      expectedRevision: null,
    }),
  ).toMatchObject({ status: "stale" });

  const preflight = createPreflight();
  const preflightCommit = await repository.commitSubmissionPreflight(preflight);
  expect(preflightCommit).toMatchObject({
    status: "created",
    preflight,
    idempotency: { status: "available", revision: 1 },
  });
  expect(await repository.commitSubmissionPreflight(preflight)).toMatchObject({
    status: "duplicate",
  });

  const grant = createGrant();
  expect(await repository.commitSubmissionExecutionGrant(grant)).toMatchObject({
    status: "created",
  });
  const marker = SubmissionArmedMarkerSchema.parse({
    id: "armed_1",
    idempotencyKey: preflight.idempotencyKey,
    preflightId: preflight.id,
    authorityEnvelopeId: preflight.authorityEnvelopeId,
    authorityRevision: preflight.authorityRevision,
    runId: preflight.runId,
    jobId: preflight.jobId,
    resultId: preflight.resultId,
    applicationRecordId: preflight.applicationRecordId,
    armedAt: later,
  });
  expect(
    await repository.authorizeAndArmSubmissionAttempt({
      preflight,
      expectedIdempotencyRevision: 1,
      mode: "confirm_before_submit",
      marker,
      executionGrantId: grant.id,
      now: later,
    }),
  ).toMatchObject({
    status: "armed",
    idempotency: { revision: 2 },
    executionGrant: { status: "consumed" },
  });

  const recovered = await repository.recoverArmedSubmissionAttempts({
    now: "2026-08-27T10:06:00.000Z",
  });
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({
    outcome: "outcome_uncertain",
    retry: { eligible: false, blockReason: "outcome_uncertain" },
  });
  expect(
    await repository.recoverArmedSubmissionAttempts({
      now: "2026-08-27T10:07:00.000Z",
    }),
  ).toEqual([]);
  expect(
    await repository.getSubmissionIdempotencyRecord(preflight.idempotencyKey),
  ).toMatchObject({
    status: "outcome_uncertain",
    revision: 3,
    outcome: "outcome_uncertain",
  });

  // Authority is workspace-global. Rotate the first envelope out before
  // creating the second fixture used to exercise child revocation.
  expect(
    await repository.revokeApplicationAuthorityEnvelope({
      id: envelope.id,
      expectedRevision: envelope.revision,
      revokedAt: later,
    }),
  ).toMatchObject({ status: "applied", envelope: { status: "revoked" } });

  const revocableEnvelope = ApplicationAuthorityEnvelopeSchema.parse({
    ...envelope,
    id: "authority_2",
    scope: { campaignId: null, jobIds: ["job_2"] },
  });
  const revocablePreflight = SubmissionPreflightRecordSchema.parse({
    ...preflight,
    id: "preflight_2",
    idempotencyKey: "submit_once_2",
    jobId: "job_2",
    resultId: "result_2",
    applicationRecordId: "application_2",
    authorityEnvelopeId: revocableEnvelope.id,
  });
  const revocableGrant = SubmissionExecutionGrantSchema.parse({
    ...grant,
    id: "grant_2",
    preflightId: revocablePreflight.id,
    idempotencyKey: revocablePreflight.idempotencyKey,
    jobId: revocablePreflight.jobId,
    resultId: revocablePreflight.resultId,
    applicationRecordId: revocablePreflight.applicationRecordId,
    authorityEnvelopeId: revocableEnvelope.id,
  });
  await repository.commitApplicationAuthorityEnvelope({
    envelope: revocableEnvelope,
    expectedRevision: null,
  });
  await repository.commitSubmissionPreflight(revocablePreflight);
  await repository.commitSubmissionExecutionGrant(revocableGrant);

  expect(
    await repository.revokeApplicationAuthorityEnvelope({
      id: revocableEnvelope.id,
      expectedRevision: 1,
      revokedAt: later,
    }),
  ).toMatchObject({
    status: "applied",
    envelope: { status: "revoked", revision: 2 },
  });
  expect(
    await repository.getSubmissionExecutionGrant(revocableGrant.id),
  ).toMatchObject({ status: "revoked", revokedAt: later });
  expect(
    await repository.getSubmissionIdempotencyRecord(
      revocablePreflight.idempotencyKey,
    ),
  ).toMatchObject({ status: "revoked", revision: 2, revokedAt: later });
}

async function exerciseCompoundAuthorityTransition(
  repository: JobFinderRepository,
) {
  const confirm = createAuthorityFixture(
    "compound_confirm",
    "confirm_before_submit",
  );
  await persistAuthorityFixture(repository, confirm);

  const confirmInput = {
    preflight: confirm.preflight,
    expectedIdempotencyRevision: 1,
    mode: "confirm_before_submit" as const,
    marker: confirm.marker,
    executionGrantId: confirm.grant?.id ?? null,
    now: later,
  };
  const firstConfirmArm =
    await repository.authorizeAndArmSubmissionAttempt(confirmInput);
  expect(firstConfirmArm).toMatchObject({
    status: "armed",
    idempotency: { status: "armed", revision: 2 },
    marker: confirm.marker,
    executionGrant: { id: confirm.grant?.id, status: "consumed" },
  });
  expect(
    await repository.getSubmissionExecutionGrant(confirm.grant?.id ?? ""),
  ).toMatchObject({ status: "consumed", consumedAt: later });

  expect(
    await repository.authorizeAndArmSubmissionAttempt(confirmInput),
  ).toMatchObject({
    status: "duplicate",
    idempotency: { status: "armed", revision: 2 },
    marker: confirm.marker,
    executionGrant: { id: confirm.grant?.id, status: "consumed" },
  });

  expect(
    await repository.revokeApplicationAuthorityEnvelope({
      id: confirm.envelope.id,
      expectedRevision: confirm.envelope.revision,
      revokedAt: later,
    }),
  ).toMatchObject({ status: "applied", envelope: { status: "revoked" } });

  const concurrent = createAuthorityFixture(
    "compound_concurrent",
    "confirm_before_submit",
  );
  await persistAuthorityFixture(repository, concurrent);
  const concurrentInput = {
    preflight: concurrent.preflight,
    expectedIdempotencyRevision: 1,
    mode: "confirm_before_submit" as const,
    marker: concurrent.marker,
    executionGrantId: concurrent.grant?.id ?? null,
    now: later,
  };
  const concurrentResults = await Promise.all([
    repository.authorizeAndArmSubmissionAttempt(concurrentInput),
    repository.authorizeAndArmSubmissionAttempt(concurrentInput),
  ]);
  expect(concurrentResults.map((result) => result.status).sort()).toEqual([
    "armed",
    "duplicate",
  ]);
  expect(
    await repository.listSubmissionArmedMarkers({
      idempotencyKey: concurrent.preflight.idempotencyKey,
    }),
  ).toHaveLength(1);
  expect(
    await repository.getSubmissionExecutionGrant(concurrent.grant?.id ?? ""),
  ).toMatchObject({ status: "consumed" });

  expect(
    await repository.revokeApplicationAuthorityEnvelope({
      id: concurrent.envelope.id,
      expectedRevision: concurrent.envelope.revision,
      revokedAt: later,
    }),
  ).toMatchObject({ status: "applied", envelope: { status: "revoked" } });

  const autonomous = createAuthorityFixture(
    "compound_autonomous",
    "autonomous_submit",
  );
  await persistAuthorityFixture(repository, autonomous);
  expect(
    await repository.authorizeAndArmSubmissionAttempt({
      preflight: autonomous.preflight,
      expectedIdempotencyRevision: 1,
      mode: "autonomous_submit",
      marker: autonomous.marker,
      executionGrantId: null,
      now: later,
    }),
  ).toMatchObject({
    status: "armed",
    idempotency: { status: "armed", revision: 2 },
    executionGrant: null,
  });

  expect(
    await repository.revokeApplicationAuthorityEnvelope({
      id: autonomous.envelope.id,
      expectedRevision: autonomous.envelope.revision,
      revokedAt: later,
    }),
  ).toMatchObject({ status: "applied", envelope: { status: "revoked" } });

  const failure = createAuthorityFixture(
    "compound_failure",
    "confirm_before_submit",
  );
  await persistAuthorityFixture(repository, failure);
  const mismatchedMarker = SubmissionArmedMarkerSchema.parse({
    ...failure.marker,
    id: "armed_compound_failure_mismatch",
    authorityRevision: 2,
  });
  expect(
    await repository.authorizeAndArmSubmissionAttempt({
      preflight: failure.preflight,
      expectedIdempotencyRevision: 1,
      mode: "confirm_before_submit",
      marker: mismatchedMarker,
      executionGrantId: failure.grant?.id ?? null,
      now: later,
    }),
  ).toMatchObject({ status: "blocked", reason: "marker_mismatch" });
  expect(
    await repository.getSubmissionIdempotencyRecord(
      failure.preflight.idempotencyKey,
    ),
  ).toMatchObject({ status: "available", revision: 1 });
  expect(
    await repository.getSubmissionExecutionGrant(failure.grant?.id ?? ""),
  ).toMatchObject({ status: "active", consumedAt: null });
  expect(
    await repository.listSubmissionArmedMarkers({
      idempotencyKey: failure.preflight.idempotencyKey,
    }),
  ).toEqual([]);

  const genericActiveRevision = ApplicationAuthorityEnvelopeSchema.parse({
    ...confirm.envelope,
    revision: 2,
  });
  expect(
    await repository.commitApplicationAuthorityEnvelope({
      envelope: genericActiveRevision,
      expectedRevision: 1,
    }),
  ).toMatchObject({ status: "stale" });
  const genericRevocation = ApplicationAuthorityEnvelopeSchema.parse({
    ...confirm.envelope,
    status: "revoked",
    revision: 2,
    revokedAt: later,
  });
  expect(
    await repository.commitApplicationAuthorityEnvelope({
      envelope: genericRevocation,
      expectedRevision: 1,
    }),
  ).toMatchObject({ status: "stale" });
  const terminalCreate = ApplicationAuthorityEnvelopeSchema.parse({
    ...confirm.envelope,
    id: "authority_terminal_create",
    status: "revoked",
    revokedAt: later,
  });
  expect(
    await repository.commitApplicationAuthorityEnvelope({
      envelope: terminalCreate,
      expectedRevision: null,
    }),
  ).toMatchObject({ status: "stale" });
}

describe("transaction-current authority decision-policy gate", () => {
  test.each([
    {
      label: "submitted",
      outcome: "submitted" as const,
      expectedRecord: {
        status: "submitted",
        lastAttemptState: "submitted",
        latestBlocker: null,
      },
      expectedResult: {
        state: "submitted",
        blockerReason: null,
        blockerSummary: null,
      },
    },
    {
      label: "not_submitted",
      outcome: "not_submitted" as const,
      expectedRecord: {
        status: "approved",
        lastAttemptState: "paused",
        latestBlocker: {
          code: "requires_manual_review",
        },
      },
      expectedResult: {
        state: "blocked",
        blockerReason: null,
        blockerSummary: null,
      },
    },
  ])(
    "atomically resolves an uncertain outcome through explicit operator verification ($label)",
    async ({ outcome }) => {
      const repository = createInMemoryJobFinderRepository(createSeed());
      const fixture = createAuthorityFixture(
        `operator_${outcome}`,
        "confirm_before_submit",
      );
      await persistAuthorityFixture(repository, fixture);
      await repository.authorizeAndArmSubmissionAttempt({
        preflight: fixture.preflight,
        expectedIdempotencyRevision: 1,
        mode: "confirm_before_submit",
        marker: fixture.marker,
        executionGrantId: fixture.grant?.id ?? null,
        now: later,
      });
      const uncertain = createOutcome(fixture.preflight, "outcome_uncertain");
      expect(
        await repository.commitSubmissionOutcome({
          outcome: uncertain,
          expectedIdempotencyRevision: 2,
        }),
      ).toMatchObject({ status: "recorded", idempotency: { revision: 3 } });

      const operatorOutcome = createOperatorResolution(
        fixture.preflight,
        outcome,
      );
      const resolved = await repository.resolveSubmissionOutcome({
        expectedOutcomeId: uncertain.id,
        expectedIdempotencyRevision: 3,
        outcome: operatorOutcome,
      });
      expect(resolved).toMatchObject({
        status: "recorded",
        previousOutcome: uncertain,
        outcome: operatorOutcome,
        idempotency: {
          status: "resolved",
          revision: 4,
          outcomeId: operatorOutcome.id,
          outcome,
        },
      });

      const outcomes = await repository.listSubmissionOutcomeRecords({
        idempotencyKey: fixture.preflight.idempotencyKey,
      });
      expect(outcomes).toHaveLength(2);
      expect(outcomes).toEqual(
        expect.arrayContaining([uncertain, operatorOutcome]),
      );

      expect(
        await repository.resolveSubmissionOutcome({
          expectedOutcomeId: uncertain.id,
          expectedIdempotencyRevision: 3,
          outcome: operatorOutcome,
        }),
      ).toMatchObject({
        status: "duplicate",
        previousOutcome: uncertain,
        outcome: operatorOutcome,
        idempotency: { revision: 4 },
      });
      await repository.close();
    },
  );

  test("does not project final-submit authorization before an exact attempt is armed", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const fixture = createAuthorityFixture(
      "receipt_without_arm",
      "confirm_before_submit",
    );
    await persistAuthorityFixture(repository, fixture);
    const outcome = createOutcome(fixture.preflight, "not_submitted");

    expect(
      await repository.commitSubmissionOutcome({
        outcome,
        expectedIdempotencyRevision: 1,
      }),
    ).toMatchObject({ status: "blocked" });

    await repository.close();
  });

  test("blocks stale or cross-lineage operator resolution without mutation", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const fixture = createAuthorityFixture(
      "operator_rejected",
      "confirm_before_submit",
    );
    await persistAuthorityFixture(repository, fixture);
    await repository.authorizeAndArmSubmissionAttempt({
      preflight: fixture.preflight,
      expectedIdempotencyRevision: 1,
      mode: "confirm_before_submit",
      marker: fixture.marker,
      executionGrantId: fixture.grant?.id ?? null,
      now: later,
    });
    const uncertain = createOutcome(fixture.preflight, "outcome_uncertain");
    await repository.commitSubmissionOutcome({
      outcome: uncertain,
      expectedIdempotencyRevision: 2,
    });
    const operatorOutcome = createOperatorResolution(
      fixture.preflight,
      "submitted",
    );
    expect(
      await repository.resolveSubmissionOutcome({
        expectedOutcomeId: uncertain.id,
        expectedIdempotencyRevision: 2,
        outcome: operatorOutcome,
      }),
    ).toMatchObject({ status: "stale", idempotency: { revision: 3 } });
    expect(
      await repository.resolveSubmissionOutcome({
        expectedOutcomeId: uncertain.id,
        expectedIdempotencyRevision: 3,
        outcome: { ...operatorOutcome, resultId: "result_other" },
      }),
    ).toMatchObject({ status: "blocked", idempotency: { revision: 3 } });
    expect(await repository.listSubmissionOutcomeRecords()).toEqual([
      uncertain,
    ]);
    expect(
      await repository.getSubmissionIdempotencyRecord(
        fixture.preflight.idempotencyKey,
      ),
    ).toMatchObject({ status: "outcome_uncertain", revision: 3 });
    await repository.close();
  });

  test.each([
    {
      label: "rejects an incoherent authority policy digest",
      reason: "authority_policy_digest_invalid" as const,
      options: {
        envelope: {
          decisionPolicy: { ...decisionPolicy, digest: "c".repeat(64) },
        },
      },
    },
    {
      label: "rejects a preflight policy identity drift",
      reason: "decision_policy_mismatch" as const,
      options: {
        preflight: {
          decisionPolicy: {
            version: decisionPolicy.version,
            revision: 2,
            digest: decisionPolicy.digest,
          },
        },
      },
    },
    {
      label: "rejects an answer snapshot outside the approved policy",
      reason: "answer_snapshot_mismatch" as const,
      options: {
        preflight: {
          answers: { revision: 2, digest: "b".repeat(64) },
        },
      },
    },
    {
      label: "rejects a job outside the authority scope",
      reason: "scope_excluded" as const,
      options: {
        preflight: { jobId: "job_outside_scope" },
      },
    },
    {
      label: "rejects an origin outside the canonical allowlist",
      reason: "origin_not_allowed" as const,
      options: {
        preflight: { origin: "https://evil.example.com" },
      },
    },
    {
      label: "rejects a resume digest outside the allowlist",
      reason: "resume_not_allowed" as const,
      options: {
        preflight: { resumeSha256: "b".repeat(64) },
      },
    },
    {
      label: "rejects capacity above the authority ceiling",
      reason: "capacity_invalid" as const,
      options: {
        preflight: { remainingRunCapacityBefore: 2 },
      },
    },
  ])("$label before mutating children", async ({ reason, options }) => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const fixture = createAuthorityFixture(
      `validation_${reason}`,
      "confirm_before_submit",
      options,
    );
    await persistAuthorityFixture(repository, fixture);

    const result = await repository.authorizeAndArmSubmissionAttempt({
      preflight: fixture.preflight,
      expectedIdempotencyRevision: 1,
      mode: "confirm_before_submit",
      marker: fixture.marker,
      executionGrantId: fixture.grant?.id ?? null,
      now: later,
    });
    expect(result).toMatchObject({
      status: "blocked",
      reason,
      idempotency: null,
      marker: null,
      executionGrant: null,
    });
    expect(
      await repository.getSubmissionIdempotencyRecord(
        fixture.preflight.idempotencyKey,
      ),
    ).toMatchObject({ status: "available", revision: 1 });
    expect(
      await repository.getSubmissionExecutionGrant(fixture.grant?.id ?? ""),
    ).toMatchObject({ status: "active", consumedAt: null });
    expect(
      await repository.listSubmissionArmedMarkers({
        idempotencyKey: fixture.preflight.idempotencyKey,
      }),
    ).toEqual([]);
  });

  test("treats newly added preflight bindings as exact input identity", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const fixture = createAuthorityFixture(
      "validation_exact_preflight",
      "confirm_before_submit",
    );
    await persistAuthorityFixture(repository, fixture);

    const changedPreflight = SubmissionPreflightRecordSchema.parse({
      ...fixture.preflight,
      campaignId: "campaign_changed",
    });
    const result = await repository.authorizeAndArmSubmissionAttempt({
      preflight: changedPreflight,
      expectedIdempotencyRevision: 1,
      mode: "confirm_before_submit",
      marker: fixture.marker,
      executionGrantId: fixture.grant?.id ?? null,
      now: later,
    });
    expect(result).toMatchObject({
      status: "blocked",
      reason: "preflight_mismatch",
    });
    expect(
      await repository.getSubmissionIdempotencyRecord(
        fixture.preflight.idempotencyKey,
      ),
    ).toMatchObject({ status: "available", revision: 1 });
    expect(
      await repository.getSubmissionExecutionGrant(fixture.grant?.id ?? ""),
    ).toMatchObject({ status: "active", consumedAt: null });
  });
});

async function exerciseAuthorityReplacement(
  repository: JobFinderRepository,
): Promise<string> {
  const initial = createAuthorityFixture("replace", "confirm_before_submit");
  await persistAuthorityFixture(repository, initial);

  expect(
    await repository.getSubmissionExecutionGrant(initial.grant?.id ?? ""),
  ).toMatchObject({ status: "active" });
  expect(
    await repository.getSubmissionIdempotencyRecord(
      initial.preflight.idempotencyKey,
    ),
  ).toMatchObject({ status: "available", revision: 1 });

  const replacement = createReplacementEnvelope(
    "authority_replace_new",
    "job_replace_new",
  );
  expect(
    await repository.replaceApplicationAuthorityEnvelope({
      currentId: initial.envelope.id,
      expectedRevision: initial.envelope.revision,
      replacement,
      revokedAt: later,
    }),
  ).toMatchObject({
    status: "applied",
    previous: {
      id: initial.envelope.id,
      status: "revoked",
      revision: 2,
      revokedAt: later,
    },
    envelope: replacement,
  });
  expect(
    await repository.listApplicationAuthorityEnvelopes({ status: "active" }),
  ).toEqual([replacement]);
  expect(
    await repository.getApplicationAuthorityEnvelope(initial.envelope.id),
  ).toMatchObject({ status: "revoked", revision: 2, revokedAt: later });
  expect(
    await repository.getSubmissionExecutionGrant(initial.grant?.id ?? ""),
  ).toMatchObject({ status: "revoked", revokedAt: later });
  expect(
    await repository.getSubmissionIdempotencyRecord(
      initial.preflight.idempotencyKey,
    ),
  ).toMatchObject({
    status: "revoked",
    revision: 2,
    revokedAt: later,
  });

  // Leave the replacement active only long enough to verify the atomic
  // result; the next fixture must obey the same workspace-global invariant.
  expect(
    await repository.revokeApplicationAuthorityEnvelope({
      id: replacement.id,
      expectedRevision: replacement.revision,
      revokedAt: later,
    }),
  ).toMatchObject({ status: "applied", envelope: { status: "revoked" } });

  const staleReplacement = createReplacementEnvelope(
    "authority_replace_stale",
    "job_replace_stale",
  );
  const staleResult = await repository.replaceApplicationAuthorityEnvelope({
    currentId: initial.envelope.id,
    expectedRevision: initial.envelope.revision,
    replacement: staleReplacement,
    revokedAt: later,
  });
  expect(staleResult).toMatchObject({
    status: "stale",
    current: { id: initial.envelope.id, status: "revoked", revision: 2 },
  });
  expect(
    await repository.getApplicationAuthorityEnvelope(staleReplacement.id),
  ).toBeNull();

  const missingReplacement = createReplacementEnvelope(
    "authority_replace_missing",
    "job_replace_missing",
  );
  expect(
    await repository.replaceApplicationAuthorityEnvelope({
      currentId: "authority_does_not_exist",
      expectedRevision: 1,
      replacement: missingReplacement,
      revokedAt: later,
    }),
  ).toEqual({ status: "missing", current: null });
  expect(
    await repository.getApplicationAuthorityEnvelope(missingReplacement.id),
  ).toBeNull();

  const concurrentInitial = createAuthorityFixture(
    "replace_concurrent",
    "confirm_before_submit",
  );
  await persistAuthorityFixture(repository, concurrentInitial);
  const concurrentReplacements = [
    createReplacementEnvelope(
      "authority_replace_concurrent_a",
      "job_replace_concurrent_a",
    ),
    createReplacementEnvelope(
      "authority_replace_concurrent_b",
      "job_replace_concurrent_b",
    ),
  ];
  const concurrentResults = await Promise.all(
    concurrentReplacements.map((replacementValue) =>
      repository.replaceApplicationAuthorityEnvelope({
        currentId: concurrentInitial.envelope.id,
        expectedRevision: concurrentInitial.envelope.revision,
        replacement: replacementValue,
        revokedAt: later,
      }),
    ),
  );
  expect(concurrentResults.map((result) => result.status).sort()).toEqual([
    "applied",
    "stale",
  ]);
  const activeAfterConcurrent =
    await repository.listApplicationAuthorityEnvelopes({ status: "active" });
  expect(activeAfterConcurrent).toHaveLength(1);
  expect(
    await repository.getApplicationAuthorityEnvelope(
      concurrentInitial.envelope.id,
    ),
  ).toMatchObject({ status: "revoked", revision: 2, revokedAt: later });
  expect(
    await repository.getSubmissionExecutionGrant(
      concurrentInitial.grant?.id ?? "",
    ),
  ).toMatchObject({ status: "revoked", revokedAt: later });
  expect(
    await repository.getSubmissionIdempotencyRecord(
      concurrentInitial.preflight.idempotencyKey,
    ),
  ).toMatchObject({ status: "revoked", revision: 2, revokedAt: later });
  return activeAfterConcurrent[0]?.id ?? "";
}

describe("application authority repository", () => {
  const cleanupDirectories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      cleanupDirectories.splice(0).map(cleanupTempDirectoryWithRetry),
    );
  });

  test("enforces one-shot lifecycle and crash recovery in memory", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    await exerciseAuthorityLifecycle(repository);
  });

  test("rewrites only the authority rows a mutation changed", async () => {
    const temp = await createTempRepository("nestor-authority-row-diff-");
    cleanupDirectories.push(temp.tempDirectory);
    const repository = await temp.createRepository();
    const fixture = createAuthorityFixture("row_diff", "confirm_before_submit");
    await persistAuthorityFixture(repository, fixture);
    await repository.close();

    // Index columns are written only when their row is written, and they are
    // derived from the row's JSON value. Poisoning them on rows the mutation
    // must not touch makes any full-collection rewrite observable: the old
    // delete-all-and-reinsert path restored every value from JSON.
    const sentinelCreatedAt = "1999-01-01T00:00:00.000Z";
    const sentinelRevision = 42;
    const withDatabase = <TValue>(
      operation: (database: DatabaseSync) => TValue,
    ): TValue => {
      const database = new DatabaseSync(temp.filePath);
      try {
        return operation(database);
      } finally {
        database.close();
      }
    };
    withDatabase((database) => {
      database
        .prepare("UPDATE submission_preflights SET created_at = ? WHERE id = ?")
        .run(sentinelCreatedAt, fixture.preflight.id);
      database
        .prepare(
          "UPDATE application_authority_envelopes SET revision = ? WHERE id = ?",
        )
        .run(sentinelRevision, fixture.envelope.id);
    });

    const reopened = await createFileJobFinderRepository({
      filePath: temp.filePath,
      seed: createSeed(),
    });
    expect(await reopened.expireSubmissionExecutionGrants(verifiedAt)).toBe(0);
    expect(await reopened.expireSubmissionExecutionGrants(expiry)).toBe(1);
    await reopened.close();

    const indexColumns = withDatabase((database) => ({
      preflightCreatedAt: (
        database
          .prepare("SELECT created_at FROM submission_preflights WHERE id = ?")
          .get(fixture.preflight.id) as { created_at?: unknown }
      ).created_at,
      envelopeRevision: (
        database
          .prepare(
            "SELECT revision FROM application_authority_envelopes WHERE id = ?",
          )
          .get(fixture.envelope.id) as { revision?: unknown }
      ).revision,
      grantStatus: (
        database
          .prepare(
            "SELECT status FROM submission_execution_grants WHERE id = ?",
          )
          .get(fixture.grant?.id ?? "") as { status?: unknown }
      ).status,
    }));

    // Untouched rows keep their poisoned index columns; the one grant the
    // mutation changed is rewritten from its new value.
    expect(indexColumns.preflightCreatedAt).toBe(sentinelCreatedAt);
    expect(indexColumns.envelopeRevision).toBe(sentinelRevision);
    expect(indexColumns.grantStatus).toBe("expired");

    const verification = await createFileJobFinderRepository({
      filePath: temp.filePath,
      seed: createSeed(),
    });
    expect(await verification.listSubmissionExecutionGrants()).toEqual([
      expect.objectContaining({ id: fixture.grant?.id, status: "expired" }),
    ]);
    expect(await verification.listSubmissionPreflightRecords()).toEqual([
      expect.objectContaining({ id: fixture.preflight.id, createdAt: at }),
    ]);
    await verification.close();
  });

  test("enforces one-shot lifecycle atomically and survives SQLite reopen", async () => {
    const temp = await createTempRepository("nestor-authority-");
    cleanupDirectories.push(temp.tempDirectory);
    let repository = await temp.createRepository();
    await exerciseAuthorityLifecycle(repository);
    await repository.close();

    repository = await createFileJobFinderRepository({
      filePath: temp.filePath,
      seed: createSeed(),
    });
    expect(await repository.listApplicationAuthorityEnvelopes()).toHaveLength(
      2,
    );
    expect(await repository.listSubmissionPreflightRecords()).toHaveLength(2);
    expect(await repository.listSubmissionExecutionGrants()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "grant_1", status: "consumed" }),
        expect.objectContaining({ id: "grant_2", status: "revoked" }),
      ]),
    );
    expect(await repository.listSubmissionOutcomeRecords()).toEqual([
      expect.objectContaining({ outcome: "outcome_uncertain" }),
    ]);

    await repository.close();
  });

  test("resets SQLite authority parents and children without violating foreign keys", async () => {
    const temp = await createTempRepository("nestor-authority-reset-");
    cleanupDirectories.push(temp.tempDirectory);
    let repository = await temp.createRepository();
    const fixture = createAuthorityFixture(
      "reset_lifecycle",
      "confirm_before_submit",
    );
    await persistAuthorityFixture(repository, fixture);

    await repository.reset(createSeed());
    expect(await repository.listApplicationAuthorityEnvelopes()).toEqual([]);
    expect(await repository.listSubmissionPreflightRecords()).toEqual([]);
    expect(await repository.listSubmissionExecutionGrants()).toEqual([]);
    expect(await repository.listSubmissionIdempotencyRecords()).toEqual([]);
    await repository.close();

    repository = await createFileJobFinderRepository({
      filePath: temp.filePath,
      seed: createSeed(),
    });
    expect(await repository.listApplicationAuthorityEnvelopes()).toEqual([]);
    expect(await repository.listSubmissionPreflightRecords()).toEqual([]);
    await repository.close();
  });

  test("atomically gates and arms confirm/autonomous attempts in memory", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    await exerciseCompoundAuthorityTransition(repository);
  });

  test("atomically gates attempts, rolls back rejected transitions, and survives SQLite reopen", async () => {
    const temp = await createTempRepository("nestor-authority-compound-");
    cleanupDirectories.push(temp.tempDirectory);
    let repository = await temp.createRepository();
    await exerciseCompoundAuthorityTransition(repository);
    await repository.close();

    repository = await createFileJobFinderRepository({
      filePath: temp.filePath,
      seed: createSeed(),
    });
    expect(
      await repository.getSubmissionIdempotencyRecord(
        "submit_once_compound_confirm",
      ),
    ).toMatchObject({ status: "armed", revision: 2 });
    expect(
      await repository.getSubmissionExecutionGrant("grant_compound_confirm"),
    ).toMatchObject({ status: "consumed" });
    expect(
      await repository.getSubmissionIdempotencyRecord(
        "submit_once_compound_concurrent",
      ),
    ).toMatchObject({ status: "armed", revision: 2 });
    expect(
      await repository.listSubmissionArmedMarkers({
        idempotencyKey: "submit_once_compound_concurrent",
      }),
    ).toHaveLength(1);
    expect(
      await repository.getSubmissionIdempotencyRecord(
        "submit_once_compound_failure",
      ),
    ).toMatchObject({ status: "available", revision: 1 });
    expect(
      await repository.getSubmissionExecutionGrant("grant_compound_failure"),
    ).toMatchObject({ status: "active", consumedAt: null });
    await repository.close();
  });

  test("atomically rotates authority and revokes available children in memory", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    await exerciseAuthorityReplacement(repository);
  });

  test("atomically rotates authority, guarantees one active envelope, and survives SQLite reopen", async () => {
    const temp = await createTempRepository("nestor-authority-replace-");
    cleanupDirectories.push(temp.tempDirectory);
    let repository = await temp.createRepository();
    const activeId = await exerciseAuthorityReplacement(repository);
    await repository.close();

    repository = await createFileJobFinderRepository({
      filePath: temp.filePath,
      seed: createSeed(),
    });
    const active = await repository.listApplicationAuthorityEnvelopes({
      status: "active",
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(activeId);
    expect(
      await repository.getApplicationAuthorityEnvelope("authority_replace"),
    ).toMatchObject({ status: "revoked", revision: 2, revokedAt: later });
    expect(
      await repository.getSubmissionExecutionGrant("grant_replace"),
    ).toMatchObject({ status: "revoked", revokedAt: later });
    expect(
      await repository.getSubmissionIdempotencyRecord("submit_once_replace"),
    ).toMatchObject({ status: "revoked", revision: 2, revokedAt: later });
    expect(
      await repository.getApplicationAuthorityEnvelope(
        "authority_replace_concurrent_b",
      ),
    ).toBeNull();
    await repository.close();
  });

  test("closes an armed attempt as uncertain on its own when its result receipt is missing", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const fixture = createAuthorityFixture(
      "recovery_missing_result",
      "confirm_before_submit",
    );
    // Persist the authority lifecycle without its ApplyJobResult parent.
    expect(
      await repository.commitApplicationAuthorityEnvelope({
        envelope: fixture.envelope,
        expectedRevision: null,
      }),
    ).toMatchObject({ status: "applied" });
    await repository.commitSubmissionPreflight(fixture.preflight);
    await repository.commitSubmissionExecutionGrant(fixture.grant!);
    await repository.authorizeAndArmSubmissionAttempt({
      preflight: fixture.preflight,
      expectedIdempotencyRevision: 1,
      mode: "confirm_before_submit",
      marker: fixture.marker,
      executionGrantId: fixture.grant?.id ?? null,
      now: later,
    });

    // One attempt without its result never stops the workspace opening.
    await expect(
      repository.recoverArmedSubmissionAttempts({ now: later }),
    ).resolves.toHaveLength(1);
    expect(
      await repository.getSubmissionIdempotencyRecord(
        fixture.preflight.idempotencyKey,
      ),
    ).toMatchObject({ status: "outcome_uncertain", revision: 3 });
    expect(await repository.listSubmissionOutcomeRecords()).toMatchObject([
      { outcome: "outcome_uncertain" },
    ]);
  });
});

test.each(["memory", "sqlite"] as const)(
  "commits a guarded outcome without legacy application rows (%s)",
  async (storage) => {
    const temp =
      storage === "sqlite"
        ? await createTempRepository("nestor-store-outcome-")
        : null;
    const repository = temp
      ? await temp.createRepository()
      : createInMemoryJobFinderRepository(createSeed());
    try {
      const fixture = createAuthorityFixture(
        "store_owned",
        "confirm_before_submit",
      );
      await repository.commitApplicationAuthorityEnvelope({
        envelope: fixture.envelope,
        expectedRevision: null,
      });
      await repository.commitSubmissionPreflight(fixture.preflight);
      await repository.commitSubmissionExecutionGrant(fixture.grant!);
      await repository.authorizeAndArmSubmissionAttempt({
        preflight: fixture.preflight,
        expectedIdempotencyRevision: 1,
        mode: "confirm_before_submit",
        marker: fixture.marker,
        executionGrantId: fixture.grant!.id,
        now: later,
      });
      const outcome = createOperatorResolution(fixture.preflight, "submitted");
      expect(
        await repository.commitSubmissionOutcome({
          outcome: { ...outcome, resultId: "another_attempt" },
          expectedIdempotencyRevision: 2,
        }),
      ).toMatchObject({ status: "blocked" });
      expect(
        await repository.commitSubmissionOutcome({
          outcome,
          expectedIdempotencyRevision: 1,
        }),
      ).toMatchObject({ status: "stale" });
      expect(
        await repository.commitSubmissionOutcome({
          outcome,
          expectedIdempotencyRevision: 2,
        }),
      ).toMatchObject({
        status: "recorded",
        idempotency: { status: "resolved", outcome: "submitted" },
      });
      expect(
        await repository.commitSubmissionOutcome({
          outcome,
          expectedIdempotencyRevision: 2,
        }),
      ).toMatchObject({ status: "duplicate" });
      expect(await repository.getSubmissionOutcomeRecord(outcome.id)).toEqual(
        outcome,
      );
    } finally {
      await repository.close();
      if (temp) await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  },
);
