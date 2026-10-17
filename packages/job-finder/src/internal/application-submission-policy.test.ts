import {
  ApplicationAuthorityEnvelopeSchema,
  SubmissionExecutionGrantSchema,
  SubmissionPreflightRecordSchema,
  type ApplicationAuthorityEnvelopeInput,
  type SubmissionExecutionGrantInput,
  type SubmissionPreflightRecordInput,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  evaluateApplicationSubmissionPolicy,
  type ApplicationSubmissionDecision,
  type AuthorizableSubmissionMode,
  type EvaluateApplicationSubmissionPolicyInput,
  type SubmissionPolicyBlockReason,
} from "./application-submission-policy";

// Distinct digests per bound field so mutating exactly one field in a test
// can never accidentally satisfy a different check.
const SHA_RESUME = "a".repeat(64);
const SHA_ANSWERS = "b".repeat(64);
const SHA_FINAL_CONTROL = "c".repeat(64);
const SHA_UNBOUND = "d".repeat(64);
const SHA_POLICY = "e".repeat(64);

const ORIGIN = "https://boards.example.com";
const NOW = "2026-08-26T12:00:00.000Z";
const CREATED_AT = "2026-08-26T10:00:00.000Z";
const GRANTED_AT = "2026-08-26T11:45:00.000Z";

const DECISION_POLICY = {
  version: 1 as const,
  revision: 4,
  digest: SHA_POLICY,
  answerPolicy: {
    approvedAnswerSnapshot: { revision: 2, digest: SHA_ANSWERS },
    unknownRequiredQuestion: "pause_for_user" as const,
    unknownEligibility: "pause_for_user" as const,
    unknownLegalRequirement: "pause_for_user" as const,
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
};

function envelope(
  patch: Partial<ApplicationAuthorityEnvelopeInput> = {},
): ApplicationAuthorityEnvelopeInput {
  return {
    id: "authority_1",
    mode: "autonomous_submit",
    status: "active",
    revision: 3,
    scope: { campaignId: "campaign_1", jobIds: ["job_1"] },
    maxApplicationsPerRun: 10,
    maxApplicationsPerLocalDay: 20,
    // Final-submission policy tests do not grant the separate bounded ATS
    // autosave capability. Keeping it off avoids coupling these fixtures to
    // autosave's intentionally narrower single-job/no-campaign scope.
    intermediateMutationsAuthorized: false,
    accountCreationAuthorized: false,
    allowedResumeSha256: [SHA_RESUME],
    allowedOrigins: [ORIGIN],
    createdAt: CREATED_AT,
    expiresAt: "2026-08-26T18:00:00.000Z",
    revokedAt: null,
    decisionPolicy: DECISION_POLICY,
    ...patch,
  };
}

function preflight(
  patch: Partial<SubmissionPreflightRecordInput> = {},
): SubmissionPreflightRecordInput {
  return {
    id: "preflight_1",
    idempotencyKey: "submit_run_1_job_1_attempt_1",
    runId: "run_1",
    jobId: "job_1",
    resultId: "result_1",
    applicationRecordId: "application_record_1",
    campaignId: "campaign_1",
    origin: ORIGIN,
    authorityEnvelopeId: "authority_1",
    authorityRevision: 3,
    decisionPolicy: {
      version: DECISION_POLICY.version,
      revision: DECISION_POLICY.revision,
      digest: DECISION_POLICY.digest,
    },
    formObservation: { id: "observation_1", revision: 7, digest: SHA_RESUME },
    resumeSha256: SHA_RESUME,
    answers: { revision: 2, digest: SHA_ANSWERS },
    finalControl: { signature: SHA_FINAL_CONTROL, ref: "submit-final-0" },
    remainingRunCapacityBefore: 9,
    remainingDailyCapacityBefore: 18,
    createdAt: "2026-08-26T11:30:00.000Z",
    ...patch,
  };
}

function grant(
  patch: Partial<SubmissionExecutionGrantInput> = {},
): SubmissionExecutionGrantInput {
  return {
    id: "grant_1",
    preflightId: "preflight_1",
    idempotencyKey: "submit_run_1_job_1_attempt_1",
    runId: "run_1",
    jobId: "job_1",
    resultId: "result_1",
    applicationRecordId: "application_record_1",
    authorityEnvelopeId: "authority_1",
    authorityRevision: 3,
    mode: "confirm_before_submit",
    status: "active",
    grantedBy: "user",
    grantedAt: GRANTED_AT,
    expiresAt: "2026-08-26T12:30:00.000Z",
    revokedAt: null,
    consumedAt: null,
    ...patch,
  };
}

function autonomousInput(
  patch: Partial<EvaluateApplicationSubmissionPolicyInput> = {},
): EvaluateApplicationSubmissionPolicyInput {
  return {
    now: NOW,
    savedMode: "autonomous_submit",
    envelope: ApplicationAuthorityEnvelopeSchema.parse(envelope()),
    preflight: SubmissionPreflightRecordSchema.parse(preflight()),
    jobId: "job_1",
    campaignId: "campaign_1",
    origin: ORIGIN,
    formObservation: { id: "observation_1", revision: 7, digest: SHA_RESUME },
    resumeSha256: SHA_RESUME,
    answers: { revision: 2, digest: SHA_ANSWERS },
    finalControl: { signature: SHA_FINAL_CONTROL, ref: "submit-final-0" },
    remainingRunCapacity: 9,
    remainingDailyCapacity: 18,
    idempotency: "unused",
    executionGrant: null,
    currentPolicyFacts: {
      policy: {
        version: DECISION_POLICY.version,
        revision: DECISION_POLICY.revision,
        digest: DECISION_POLICY.digest,
      },
      answers: { revision: 2, digest: SHA_ANSWERS },
      mandatoryStops: [],
    },
    ...patch,
  };
}

function confirmInput(
  patch: Partial<EvaluateApplicationSubmissionPolicyInput> = {},
): EvaluateApplicationSubmissionPolicyInput {
  return autonomousInput({
    savedMode: "confirm_before_submit",
    envelope: ApplicationAuthorityEnvelopeSchema.parse(
      envelope({ mode: "confirm_before_submit" }),
    ),
    executionGrant: SubmissionExecutionGrantSchema.parse(grant()),
    ...patch,
  });
}

const AUTHORIZED_BINDING_KEYS = [
  "applicationRecordId",
  "authorityEnvelopeId",
  "authorityRevision",
  "idempotencyKey",
  "jobId",
  "mode",
  "preflightId",
  "resultId",
  "runId",
  "status",
] as const;

const AUTHORIZED_FIXTURE = {
  status: "authorized",
  mode: "autonomous_submit",
  preflightId: "preflight_1",
  idempotencyKey: "submit_run_1_job_1_attempt_1",
  runId: "run_1",
  jobId: "job_1",
  resultId: "result_1",
  applicationRecordId: "application_record_1",
  authorityEnvelopeId: "authority_1",
  authorityRevision: 3,
} as const;

function expectAuthorized(
  decision: ApplicationSubmissionDecision,
  mode: AuthorizableSubmissionMode,
): void {
  expect(decision.status).toBe("authorized");
  if (decision.status !== "authorized") {
    throw new Error(`Expected authorization, got ${decision.reason}.`);
  }
  expect(decision.mode).toBe(mode);
  // The executor handoff carries exactly the immutable binding scalars and
  // nothing else — no envelope, no preflight, no mutable proposal data.
  expect([...Object.keys(decision)].sort()).toEqual([
    ...AUTHORIZED_BINDING_KEYS,
  ]);
  expect(decision).toEqual({ ...AUTHORIZED_FIXTURE, mode });
}

function expectBlocked(
  decision: ApplicationSubmissionDecision,
  reason: SubmissionPolicyBlockReason,
): void {
  expect(decision.status).toBe("blocked");
  if (decision.status !== "blocked") {
    throw new Error(
      `Expected block ${reason}, got authorized ${decision.mode}.`,
    );
  }
  expect(decision.reason).toBe(reason);
  expect(typeof decision.detail).toBe("string");
  expect(decision.detail.length).toBeGreaterThan(0);
}

describe("application submission policy", () => {
  describe("valid authorizations", () => {
    test("authorizes one fully valid autonomous submission without any grant", () => {
      expectAuthorized(
        evaluateApplicationSubmissionPolicy(autonomousInput()),
        "autonomous_submit",
      );
    });

    test("authorizes one fully valid confirm-before-submit submission with its grant", () => {
      expectAuthorized(
        evaluateApplicationSubmissionPolicy(confirmInput()),
        "confirm_before_submit",
      );
    });

    test("satisfies scope through the exact campaign alone", () => {
      const decision = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          envelope: ApplicationAuthorityEnvelopeSchema.parse(
            envelope({ scope: { campaignId: "campaign_1", jobIds: [] } }),
          ),
        }),
      );
      expectAuthorized(decision, "autonomous_submit");
    });

    test("satisfies scope through the exact job list alone with no campaign", () => {
      const decision = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          envelope: ApplicationAuthorityEnvelopeSchema.parse(
            envelope({ scope: { campaignId: null, jobIds: ["job_1"] } }),
          ),
          campaignId: null,
          preflight: SubmissionPreflightRecordSchema.parse(
            preflight({ campaignId: null }),
          ),
        }),
      );
      expectAuthorized(decision, "autonomous_submit");
    });
  });

  describe("deterministic fail-closed blockers", () => {
    interface CoreBlockerRow {
      name: string;
      reason: SubmissionPolicyBlockReason;
      patch?: Partial<EvaluateApplicationSubmissionPolicyInput>;
      envelopePatch?: Partial<ApplicationAuthorityEnvelopeInput>;
      preflightPatch?: Partial<SubmissionPreflightRecordInput>;
    }

    // Every row is evaluated against both valid bases so only the mutated
    // dimension can be the cause of the block.
    const coreBlockers: CoreBlockerRow[] = [
      {
        name: "saved mode mismatches the envelope mode",
        reason: "mode_mismatch",
        patch: { savedMode: "prepare_only" },
      },
      {
        name: "the matched mode is prepare_only",
        reason: "prepare_only",
        patch: { savedMode: "prepare_only" },
        envelopePatch: { mode: "prepare_only" },
      },
      {
        name: "the envelope is revoked",
        reason: "authority_inactive",
        envelopePatch: {
          status: "revoked",
          revokedAt: "2026-08-26T11:00:00.000Z",
        },
      },
      {
        name: "the envelope status is expired",
        reason: "authority_inactive",
        envelopePatch: {
          status: "expired",
          expiresAt: "2026-08-26T11:00:00.000Z",
        },
      },
      {
        name: "the preflight binds another authority revision",
        reason: "preflight_authority_mismatch",
        preflightPatch: { authorityRevision: 4 },
      },
      {
        name: "the preflight binds another authority envelope id",
        reason: "preflight_authority_mismatch",
        preflightPatch: { authorityEnvelopeId: "authority_other" },
      },
      {
        name: "the current job differs from the preflight lineage",
        reason: "preflight_lineage_mismatch",
        patch: { jobId: "job_other" },
        envelopePatch: {
          scope: { campaignId: "campaign_1", jobIds: ["job_1", "job_other"] },
        },
      },
      {
        name: "neither the job nor the campaign is in scope",
        reason: "scope_excluded",
        patch: { campaignId: "campaign_other" },
        preflightPatch: { campaignId: "campaign_other" },
        envelopePatch: {
          scope: { campaignId: "campaign_1", jobIds: [] },
        },
      },
      {
        name: "the job is out of scope and there is no current campaign",
        reason: "scope_excluded",
        patch: { campaignId: null },
        preflightPatch: { campaignId: null },
        envelopePatch: {
          scope: { campaignId: "campaign_1", jobIds: [] },
        },
      },
      {
        name: "the resume digest is absent from the allowlist",
        reason: "resume_not_allowed",
        patch: { resumeSha256: SHA_UNBOUND },
      },
      {
        name: "the resume digest is allowlisted but differs from preflight",
        reason: "resume_not_allowed",
        envelopePatch: { allowedResumeSha256: [SHA_RESUME, SHA_ANSWERS] },
        preflightPatch: { resumeSha256: SHA_ANSWERS },
      },
      {
        name: "the form observation id went stale",
        reason: "observation_stale",
        patch: {
          formObservation: {
            id: "observation_2",
            revision: 7,
            digest: SHA_RESUME,
          },
        },
      },
      {
        name: "the form observation revision went stale",
        reason: "observation_stale",
        patch: {
          formObservation: {
            id: "observation_1",
            revision: 8,
            digest: SHA_RESUME,
          },
        },
      },
      {
        name: "the form observation digest went stale",
        reason: "observation_stale",
        patch: {
          formObservation: {
            id: "observation_1",
            revision: 7,
            digest: SHA_UNBOUND,
          },
        },
      },
      {
        name: "the answer revision went stale",
        reason: "answer_policy_mismatch",
        patch: { answers: { revision: 3, digest: SHA_ANSWERS } },
      },
      {
        name: "the answer digest went stale",
        reason: "answer_policy_mismatch",
        patch: { answers: { revision: 2, digest: SHA_UNBOUND } },
      },
      {
        name: "the final control signature went stale",
        reason: "observation_stale",
        patch: {
          finalControl: { signature: SHA_UNBOUND, ref: "submit-final-0" },
        },
      },
      {
        name: "the final control ref went stale",
        reason: "observation_stale",
        patch: {
          finalControl: { signature: SHA_FINAL_CONTROL, ref: "submit-final-1" },
        },
      },
      {
        name: "remaining run capacity drifted from preflight",
        reason: "capacity_invalid",
        patch: { remainingRunCapacity: 8 },
      },
      {
        name: "remaining daily capacity drifted from preflight",
        reason: "capacity_invalid",
        patch: { remainingDailyCapacity: 17 },
      },
      {
        name: "remaining run capacity is exhausted",
        reason: "capacity_invalid",
        patch: { remainingRunCapacity: 0 },
      },
      {
        name: "remaining daily capacity is exhausted",
        reason: "capacity_invalid",
        patch: { remainingDailyCapacity: 0 },
      },
      {
        name: "remaining run capacity is fractional",
        reason: "capacity_invalid",
        patch: { remainingRunCapacity: 1.5 },
      },
      {
        name: "remaining daily capacity exceeds the authority ceiling",
        reason: "capacity_invalid",
        patch: { remainingDailyCapacity: 21 },
        preflightPatch: { remainingDailyCapacityBefore: 21 },
      },
      {
        name: "the idempotency key already executed",
        reason: "idempotency_already_executed",
        patch: { idempotency: "executed" },
      },
      {
        name: "the idempotency key is outcome uncertain",
        reason: "idempotency_outcome_uncertain",
        patch: { idempotency: "outcome_uncertain" },
      },
    ];

    const bases: Array<{
      label: AuthorizableSubmissionMode;
      make: typeof autonomousInput;
    }> = [
      { label: "autonomous_submit", make: autonomousInput },
      { label: "confirm_before_submit", make: confirmInput },
    ];

    for (const base of bases) {
      for (const row of coreBlockers) {
        test(`${base.label}: blocks when ${row.name}`, () => {
          const decision = evaluateApplicationSubmissionPolicy(
            base.make({
              ...(row.patch ?? {}),
              ...(row.envelopePatch !== undefined
                ? {
                    // Rebuild from the base's own mode so the patched
                    // dimension is the only thing that changes.
                    envelope: ApplicationAuthorityEnvelopeSchema.parse(
                      envelope({ mode: base.label, ...row.envelopePatch }),
                    ),
                  }
                : {}),
              ...(row.preflightPatch !== undefined
                ? {
                    preflight: SubmissionPreflightRecordSchema.parse(
                      preflight(row.preflightPatch),
                    ),
                  }
                : {}),
            }),
          );
          expectBlocked(decision, row.reason);
        });
      }
    }

    test("reports the earliest failing check when several checks fail", () => {
      // Order: prepare_only (2) beats inactive envelope (3), scope (5),
      // and idempotency (10).
      const prepareDecision = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          savedMode: "prepare_only",
          envelope: ApplicationAuthorityEnvelopeSchema.parse(
            envelope({
              mode: "prepare_only",
              status: "revoked",
              revokedAt: "2026-08-26T11:00:00.000Z",
            }),
          ),
          jobId: "job_other",
          idempotency: "executed",
        }),
      );
      expectBlocked(prepareDecision, "prepare_only");

      // Order: preflight authority mismatch (4) beats disallowed origin (6)
      // and executed idempotency (10).
      const orderDecision = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          preflight: SubmissionPreflightRecordSchema.parse(
            preflight({ authorityRevision: 9 }),
          ),
          origin: "https://evil.example.com",
          idempotency: "executed",
        }),
      );
      expectBlocked(orderDecision, "preflight_authority_mismatch");

      // Order: mode mismatch (1) beats everything, including prepare_only.
      const modeFirst = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          savedMode: "confirm_before_submit",
          envelope: ApplicationAuthorityEnvelopeSchema.parse(
            envelope({ mode: "prepare_only" }),
          ),
        }),
      );
      expectBlocked(modeFirst, "mode_mismatch");
    });
  });

  describe("semantic origin equivalence", () => {
    const equivalentForms = [
      "https://boards.example.com",
      "https://boards.example.com/",
      "https://boards.example.com:443",
      "https://BOARDS.Example.COM/apply?id=7#step",
    ];

    for (const candidate of equivalentForms) {
      test(`authorizes ${candidate} as semantically equal to the allowed origin`, () => {
        const decision = evaluateApplicationSubmissionPolicy(
          autonomousInput({ origin: candidate }),
        );
        expectAuthorized(decision, "autonomous_submit");
      });
    }

    const inequivalentForms: Array<[string, string]> = [
      ["https://evil.example.com", "another host"],
      ["http://boards.example.com", "a downgraded scheme"],
      ["https://boards.example.com:8443", "an explicit non-default port"],
      ["ftp://boards.example.com", "a non-HTTP(S) scheme"],
      ["not a url", "an unparseable value"],
    ];

    for (const [candidate, why] of inequivalentForms) {
      test(`blocks ${why} (${candidate})`, () => {
        const decision = evaluateApplicationSubmissionPolicy(
          autonomousInput({ origin: candidate }),
        );
        expectBlocked(decision, "origin_not_allowed");
      });
    }
  });

  describe("expiry boundaries", () => {
    test("blocks when the envelope expires exactly at the caller clock", () => {
      const decision = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          envelope: ApplicationAuthorityEnvelopeSchema.parse(
            envelope({ expiresAt: NOW }),
          ),
        }),
      );
      expectBlocked(decision, "authority_inactive");
    });

    test("authorizes while the envelope is still live one tick past the boundary", () => {
      const decision = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          envelope: ApplicationAuthorityEnvelopeSchema.parse(
            envelope({ expiresAt: "2026-08-26T12:00:01.000Z" }),
          ),
        }),
      );
      expectAuthorized(decision, "autonomous_submit");
    });

    test("blocks the confirm grant expiring exactly at the caller clock", () => {
      const decision = evaluateApplicationSubmissionPolicy(
        confirmInput({
          executionGrant: SubmissionExecutionGrantSchema.parse(
            grant({ expiresAt: NOW }),
          ),
        }),
      );
      expectBlocked(decision, "execution_grant_invalid");
    });

    test("authorizes the confirm grant still live one tick past the boundary", () => {
      const decision = evaluateApplicationSubmissionPolicy(
        confirmInput({
          executionGrant: SubmissionExecutionGrantSchema.parse(
            grant({ expiresAt: "2026-08-26T12:00:01.000Z" }),
          ),
        }),
      );
      expectAuthorized(decision, "confirm_before_submit");
    });
  });

  describe("confirm-mode execution grant", () => {
    interface GrantBlockerRow {
      name: string;
      grantPatch: Partial<SubmissionExecutionGrantInput> | null;
    }

    const grantBlockers: GrantBlockerRow[] = [
      { name: "the grant is missing", grantPatch: null },
      {
        name: "the grant binds another preflight",
        grantPatch: { preflightId: "preflight_other" },
      },
      {
        name: "the grant binds another idempotency key",
        grantPatch: { idempotencyKey: "key_other" },
      },
      {
        name: "the grant binds another run",
        grantPatch: { runId: "run_other" },
      },
      {
        name: "the grant binds another job",
        grantPatch: { jobId: "job_other" },
      },
      {
        name: "the grant binds another result",
        grantPatch: { resultId: "result_other" },
      },
      {
        name: "the grant binds another application record",
        grantPatch: { applicationRecordId: "application_record_other" },
      },
      {
        name: "the grant binds another authority envelope",
        grantPatch: { authorityEnvelopeId: "authority_other" },
      },
      {
        name: "the grant binds another authority revision",
        grantPatch: { authorityRevision: 4 },
      },
      {
        name: "the grant is consumed",
        grantPatch: {
          status: "consumed",
          consumedAt: "2026-08-26T11:50:00.000Z",
        },
      },
      {
        name: "the grant is revoked",
        grantPatch: {
          status: "revoked",
          revokedAt: "2026-08-26T11:50:00.000Z",
        },
      },
      {
        name: "the grant status is expired",
        grantPatch: {
          status: "expired",
          expiresAt: "2026-08-26T11:55:00.000Z",
        },
      },
      {
        name: "the grant lapsed before the caller clock",
        grantPatch: { expiresAt: "2026-08-26T11:55:00.000Z" },
      },
    ];

    for (const row of grantBlockers) {
      test(`blocks when ${row.name}`, () => {
        const decision = evaluateApplicationSubmissionPolicy(
          confirmInput({
            executionGrant:
              row.grantPatch === null
                ? null
                : SubmissionExecutionGrantSchema.parse(grant(row.grantPatch)),
          }),
        );
        expectBlocked(decision, "execution_grant_invalid");
      });
    }

    test("never authorizes from the confirm envelope alone", () => {
      // confirmInput attaches its grant by default; strip it to prove the
      // bare confirm envelope cannot authorize this mode.
      expectBlocked(
        evaluateApplicationSubmissionPolicy({
          ...confirmInput(),
          executionGrant: null,
        }),
        "execution_grant_invalid",
      );
    });
  });

  describe("autonomous mode ignores execution grants", () => {
    test("rejects any unexpected execution grant", () => {
      const withoutGrant =
        evaluateApplicationSubmissionPolicy(autonomousInput());
      const withGrant = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          executionGrant: SubmissionExecutionGrantSchema.parse(grant()),
        }),
      );

      expectAuthorized(withoutGrant, "autonomous_submit");
      expectBlocked(withGrant, "unexpected_execution_grant");
    });
  });

  describe("finite mandatory stop facts", () => {
    const stopCases = [
      ["unavailable_credentials", "unavailable_credentials"],
      ["login_required", "login_required"],
      ["mfa_required", "mfa_required"],
      ["captcha", "captcha"],
      ["anti_bot", "anti_bot"],
      ["account_creation", "account_creation"],
      ["unknown_required_question", "unknown_required_question"],
      ["unknown_eligibility", "unknown_eligibility"],
      ["unknown_legal_requirement", "unknown_legal_requirement"],
      ["stale_observation", "observation_stale"],
      ["ambiguous_final_control", "ambiguous_final_control"],
      ["origin_drift", "origin_drift"],
      ["outcome_uncertain", "idempotency_outcome_uncertain"],
    ] as const;

    test.each(stopCases)("blocks on %s", (code, reason) => {
      const decision = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          currentPolicyFacts: {
            policy: {
              version: DECISION_POLICY.version,
              revision: DECISION_POLICY.revision,
              digest: DECISION_POLICY.digest,
            },
            answers: { revision: 2, digest: SHA_ANSWERS },
            mandatoryStops: [{ code }],
          },
        }),
      );
      expectBlocked(decision, reason);
    });

    test("accepts only finite code facts at the type boundary", () => {
      const decision = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          currentPolicyFacts: {
            mandatoryStops: [],
            answers: { revision: 2, digest: SHA_ANSWERS },
            policy: {
              version: 1,
              revision: 4,
              digest: SHA_POLICY,
            },
          },
        }),
      );
      expectAuthorized(decision, "autonomous_submit");
    });
  });

  describe("policy and preflight bindings", () => {
    test("blocks a decision-policy identity drift", () => {
      expectBlocked(
        evaluateApplicationSubmissionPolicy(
          autonomousInput({
            preflight: SubmissionPreflightRecordSchema.parse(
              preflight({
                decisionPolicy: {
                  version: 1,
                  revision: 5,
                  digest: SHA_POLICY,
                },
              }),
            ),
          }),
        ),
        "decision_policy_mismatch",
      );
    });

    test("blocks answers that are not approved by the current policy", () => {
      expectBlocked(
        evaluateApplicationSubmissionPolicy(
          autonomousInput({
            answers: { revision: 3, digest: SHA_UNBOUND },
            preflight: SubmissionPreflightRecordSchema.parse(
              preflight({
                answers: { revision: 3, digest: SHA_UNBOUND },
              }),
            ),
          }),
        ),
        "answer_policy_mismatch",
      );
    });

    test("blocks campaign and origin drift from the immutable preflight", () => {
      expectBlocked(
        evaluateApplicationSubmissionPolicy(
          autonomousInput({ campaignId: "campaign_other" }),
        ),
        "preflight_scope_mismatch",
      );
      expectBlocked(
        evaluateApplicationSubmissionPolicy(
          autonomousInput({
            preflight: SubmissionPreflightRecordSchema.parse(
              preflight({ origin: "https://other.example.com" }),
            ),
          }),
        ),
        "preflight_origin_mismatch",
      );
    });
  });

  describe("prepare_only containment", () => {
    test("can never authorize, even with a perfectly bound active grant", () => {
      const decision = evaluateApplicationSubmissionPolicy(
        autonomousInput({
          savedMode: "prepare_only",
          envelope: ApplicationAuthorityEnvelopeSchema.parse(
            envelope({ mode: "prepare_only" }),
          ),
          executionGrant: SubmissionExecutionGrantSchema.parse(grant()),
        }),
      );
      expectBlocked(decision, "prepare_only");
    });
  });
});
