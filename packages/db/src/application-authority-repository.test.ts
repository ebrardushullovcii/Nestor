import type { ApplicationAttestationKind } from "@nestor/contracts";
import {
  ApplicationAuthorityEnvelopeSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  SubmissionArmedMarkerSchema,
  SubmissionExecutionGrantSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionPreflightRecordSchema,
} from "@nestor/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  openJobStore,
  resetJobStore,
  type JobStore,
} from "./job-store/job-store";
import { createSendGuards, type SendGuards } from "./job-store/send-guards";

/** The guards over a store that lives for one test. */
function memoryGuards(): SendGuards {
  return createSendGuards(openJobStore(":memory:"));
}

/** A store file that can be closed and opened again, as across a restart. */
function storeFile(directories: string[], prefix: string) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  const filePath = path.join(directory, "job-finder.sqlite");
  let store: JobStore | null = null;
  return {
    filePath,
    open(): SendGuards {
      store?.close();
      store = openJobStore(filePath);
      return createSendGuards(store);
    },
    get store(): JobStore {
      if (!store) throw new Error("The store is not open.");
      return store;
    },
    close() {
      store?.close();
      store = null;
    },
  };
}

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
  repository: SendGuards,
  fixture: ReturnType<typeof createAuthorityFixture>,
) {
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

async function exerciseAuthorityLifecycle(repository: SendGuards) {
  const envelope = createEnvelope();
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
  repository: SendGuards,
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
    },
    {
      label: "not_submitted",
      outcome: "not_submitted" as const,
    },
  ])(
    "atomically resolves an uncertain outcome through explicit operator verification ($label)",
    async ({ outcome }) => {
      const repository = memoryGuards();
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
    },
  );

  test("does not project final-submit authorization before an exact attempt is armed", async () => {
    const repository = memoryGuards();
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

  });

  test("blocks stale or cross-lineage operator resolution without mutation", async () => {
    const repository = memoryGuards();
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
    const repository = memoryGuards();
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
    const repository = memoryGuards();
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
  repository: SendGuards,
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

describe("send guards in the job store", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test("enforces one-shot lifecycle and crash recovery", async () => {
    await exerciseAuthorityLifecycle(memoryGuards());
  });

  test("keeps the lifecycle across a restart", async () => {
    const file = storeFile(directories, "nestor-authority-");
    await exerciseAuthorityLifecycle(file.open());
    const repository = file.open();
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
    file.close();
  });

  test("rewrites only the rows a change touched", async () => {
    const file = storeFile(directories, "nestor-authority-row-diff-");
    const fixture = createAuthorityFixture("row_diff", "confirm_before_submit");
    await persistAuthorityFixture(file.open(), fixture);

    // The key columns are written only with their row, from its value.
    // Poisoning them on rows the change must not touch shows any rewrite.
    file.store.db
      .prepare("UPDATE send_preflights SET idempotency_key = ? WHERE id = ?")
      .run("poisoned", fixture.preflight.id);
    file.store.db
      .prepare("UPDATE send_authorities SET status = ? WHERE id = ?")
      .run("poisoned", fixture.envelope.id);

    const repository = file.open();
    expect(await repository.expireSubmissionExecutionGrants(verifiedAt)).toBe(0);
    expect(await repository.expireSubmissionExecutionGrants(expiry)).toBe(1);
    const column = (sql: string, id: string) =>
      Object.values(file.store.db.prepare(sql).get(id) ?? {})[0];
    expect(
      column(
        "SELECT idempotency_key FROM send_preflights WHERE id = ?",
        fixture.preflight.id,
      ),
    ).toBe("poisoned");
    expect(
      column(
        "SELECT status FROM send_authorities WHERE id = ?",
        fixture.envelope.id,
      ),
    ).toBe("poisoned");
    expect(await repository.listSubmissionExecutionGrants()).toEqual([
      expect.objectContaining({ id: fixture.grant?.id, status: "expired" }),
    ]);
    file.close();
  });

  test("stops on a damaged record instead of reading past it", async () => {
    const file = storeFile(directories, "nestor-authority-damaged-");
    const fixture = createAuthorityFixture("damaged", "confirm_before_submit");
    await persistAuthorityFixture(file.open(), fixture);
    file.store.db
      .prepare("UPDATE send_authorities SET value = ? WHERE id = ?")
      .run(
        JSON.stringify({ ...fixture.envelope, allowedOrigins: "everywhere" }),
        fixture.envelope.id,
      );
    await expect(
      file.open().listApplicationAuthorityEnvelopes(),
    ).rejects.toThrow();
    file.close();
  });

  test("a reset clears every send record", async () => {
    const file = storeFile(directories, "nestor-authority-reset-");
    const repository = file.open();
    await persistAuthorityFixture(
      repository,
      createAuthorityFixture("reset_lifecycle", "confirm_before_submit"),
    );
    resetJobStore(file.store);
    expect(await repository.listApplicationAuthorityEnvelopes()).toEqual([]);
    expect(await repository.listSubmissionPreflightRecords()).toEqual([]);
    expect(await repository.listSubmissionExecutionGrants()).toEqual([]);
    expect(await repository.listSubmissionIdempotencyRecords()).toEqual([]);
    file.close();
  });

  test("atomically gates and arms confirm and autonomous attempts", async () => {
    await exerciseCompoundAuthorityTransition(memoryGuards());
  });

  test("keeps gated attempts and rolled-back refusals across a restart", async () => {
    const file = storeFile(directories, "nestor-authority-compound-");
    await exerciseCompoundAuthorityTransition(file.open());
    const repository = file.open();
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
    file.close();
  });

  test("atomically rotates authority and revokes available children", async () => {
    await exerciseAuthorityReplacement(memoryGuards());
  });

  test("keeps one active authority after a rotation across a restart", async () => {
    const file = storeFile(directories, "nestor-authority-replace-");
    const activeId = await exerciseAuthorityReplacement(file.open());
    const repository = file.open();
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
    file.close();
  });

  test("closes an armed attempt as uncertain on the next start", async () => {
    const file = storeFile(directories, "nestor-authority-recovery-");
    const fixture = createAuthorityFixture(
      "recovery_missing_result",
      "confirm_before_submit",
    );
    await persistAuthorityFixture(file.open(), fixture);
    await file.open().authorizeAndArmSubmissionAttempt({
      preflight: fixture.preflight,
      expectedIdempotencyRevision: 1,
      mode: "confirm_before_submit",
      marker: fixture.marker,
      executionGrantId: fixture.grant?.id ?? null,
      now: later,
    });

    // The app closed mid-send: the next start can't know what the site got.
    const repository = file.open();
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
    await expect(
      repository.recoverArmedSubmissionAttempts({ now: verifiedAt }),
    ).resolves.toEqual([]);
    file.close();
  });

  test("commits a guarded outcome once", async () => {
    const repository = memoryGuards();
    const fixture = createAuthorityFixture(
      "store_owned",
      "confirm_before_submit",
    );
    await persistAuthorityFixture(repository, fixture);
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
  });
});
