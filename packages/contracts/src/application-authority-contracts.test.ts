import { describe, expect, it, test } from "vitest";

import type { ApplicationAttestationKind } from "./application-authority";

import {
  ApplicationAutomationModeSchema,
  ApplicationAuthorityAnswerPolicySchema,
  ApplicationAuthorityDecisionPolicySchema,
  ApplicationAuthorityEnvelopeSchema,
  ApplicationAuthorityStopConditionsSchema,
  ApplicationPacketSchema,
  ApplicationPrivacyReceiptSchema,
  ApplyRunModeSchema,
  SubmissionExecutionGrantSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionOutcomeResolutionInputSchema,
  SubmissionPreflightRecordSchema,
  isApprovedApplicationAnswerSnapshot,
  isActiveApplicationAuthorityEnvelope,
  isActiveSubmissionExecutionGrant,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  applicationAuthorityMaxOrigins,
  applicationAuthorityMaxResumeDigests,
} from "./index";

const VALID_SHA = "a".repeat(64);
const ORIGIN = "https://boards.example.com";
const CREATED_AT = "2026-08-26T10:00:00.000Z";

const validAnswerPolicy = {
  approvedAnswerSnapshot: {
    revision: 2,
    digest: VALID_SHA,
  },
  unknownRequiredQuestion: "pause_for_user" as const,
  unknownEligibility: "pause_for_user" as const,
  unknownLegalRequirement: "pause_for_user" as const,
  preApprovedAttestationKinds: [] as ApplicationAttestationKind[],
  salaryDisclosure: "pause_for_user" as const,
};

const validStopConditions = {
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
};

const validDecisionPolicy = {
  version: 1 as const,
  revision: 4,
  digest: "b".repeat(64),
  answerPolicy: validAnswerPolicy,
  stopConditions: validStopConditions,
};

const validEnvelopeInput = {
  id: "authority_1",
  mode: "prepare_only",
  status: "active",
  revision: 3,
  scope: {
    campaignId: null,
    jobIds: [],
  },
  maxApplicationsPerRun: 10,
  intermediateMutationsAuthorized: false,
  accountCreationAuthorized: false,
  allowedResumeSha256: [VALID_SHA],
  allowedOrigins: [ORIGIN],
  createdAt: CREATED_AT,
  expiresAt: null,
  revokedAt: null,
  decisionPolicy: validDecisionPolicy,
};

const elevatedScope = {
  campaignId: "campaign_1",
  jobIds: ["job_1"],
};

const validPreflightInput = {
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
    version: validDecisionPolicy.version,
    revision: validDecisionPolicy.revision,
    digest: validDecisionPolicy.digest,
  },
  formObservation: {
    id: "observation_1",
    revision: 7,
    digest: VALID_SHA,
  },
  resumeSha256: VALID_SHA,
  answers: {
    revision: 2,
    digest: VALID_SHA,
  },
  finalControl: {
    signature: VALID_SHA,
    ref: "final-control-submit-button",
  },
  remainingRunCapacityBefore: 9,
  createdAt: CREATED_AT,
};

const evidenceEntry = {
  id: "evidence_1",
  kind: "employer_site_state",
  observedAt: "2026-08-26T10:00:05.000Z",
  destination: {
    origin: ORIGIN,
    safePath: "/applications/123",
  },
  artifactRefId: "artifact_1",
  summary: "Employer site lists the application as received.",
};

const validGrantInput = {
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
  grantedAt: CREATED_AT,
  expiresAt: "2026-08-26T11:00:00.000Z",
  revokedAt: null,
  consumedAt: null,
};

const validSubmittedOutcomeInput = {
  id: "outcome_1",
  preflightId: "preflight_1",
  idempotencyKey: "submit_run_1_job_1_attempt_1",
  authorityEnvelopeId: "authority_1",
  authorityRevision: 3,
  runId: "run_1",
  jobId: "job_1",
  resultId: "result_1",
  applicationRecordId: "application_record_1",
  outcome: "submitted",
  attemptedAt: "2026-08-26T10:00:02.000Z",
  verifiedAt: "2026-08-26T10:00:06.000Z",
  evidence: [evidenceEntry],
  retry: {
    eligible: false,
    blockReason: "submission_confirmed",
  },
};

const legacyReceiptInput = {
  generatedAt: CREATED_AT,
  lineage: {
    runId: "run_1",
    jobId: "job_1",
    resultId: "result_1",
    applicationRecordId: "application_record_1",
  },
  destination: {
    origin: ORIGIN,
    safePath: "/applications/123",
  },
  resume: {
    source: "original_upload",
    sourceDocumentId: "document_1",
    exportArtifactId: null,
    fileName: "candidate-resume.pdf",
    sha256: VALID_SHA,
  },
  stayedLocal: [],
  modelUse: [],
  externalWrites: [],
};

const basePacketInput = {
  generatedAt: CREATED_AT,
  job: {
    id: "job_1",
    source: "target_site",
    title: "Senior Engineer",
    company: "Example",
    location: "Remote",
    listingDestination: {
      origin: "https://jobs.example.com",
      safePath: "/jobs/123",
    },
    applicationDestination: {
      origin: ORIGIN,
      safePath: "/applications/123",
    },
    summary: "Build reliable systems.",
  },
  run: {
    id: "run_1",
    mode: "copilot",
    state: "running",
  },
  result: {
    id: "result_1",
    applicationRecordId: "application_record_1",
    state: "blocked",
    summary: "Stopped.",
    detail: "Submission outcome could not be proven.",
    blockerReason: "submission_outcome_uncertain",
    blockerSummary: null,
    updatedAt: CREATED_AT,
  },
  resume: null,
  questions: [],
  consent: [],
  checkpoints: [],
  privacyReceipt: null,
  submissionOccurred: false,
};

function firstIssuePaths(error: unknown): string[] {
  expect(error).toBeInstanceOf(Error);
  const issues = (error as { issues?: Array<{ path: Array<string | number> }> })
    .issues;
  expect(Array.isArray(issues)).toBe(true);
  return (issues ?? []).map((issue) => issue.path.join("."));
}

describe("application automation mode contracts", () => {
  test.each(["prepare_only", "confirm_before_submit", "autonomous_submit"])(
    "parses automation mode %s",
    (mode) => {
      expect(ApplicationAutomationModeSchema.parse(mode)).toBe(mode);
    },
  );

  test("automation mode and run strategy are separate axes", () => {
    // A run strategy never doubles as an automation authorization and vice
    // versa; the enums share no member and reject each other's values.
    expect(ApplicationAutomationModeSchema.safeParse("copilot").success).toBe(
      false,
    );
    expect(
      ApplicationAutomationModeSchema.safeParse("single_job_auto").success,
    ).toBe(false);
    expect(
      ApplicationAutomationModeSchema.safeParse("queue_auto").success,
    ).toBe(false);
    expect(ApplyRunModeSchema.safeParse("prepare_only").success).toBe(false);
    expect(ApplyRunModeSchema.safeParse("confirm_before_submit").success).toBe(
      false,
    );
    expect(ApplyRunModeSchema.safeParse("autonomous_submit").success).toBe(
      false,
    );
  });
});

describe("application authority envelope contracts", () => {
  it("parses a fully explicit prepare-only envelope", () => {
    const envelope =
      ApplicationAuthorityEnvelopeSchema.parse(validEnvelopeInput);
    expect(envelope.mode).toBe("prepare_only");
    expect(envelope.accountCreationAuthorized).toBe(false);
  });

  it("keeps omitted decision policy null for legacy prepare-only envelopes", () => {
    const envelope = ApplicationAuthorityEnvelopeSchema.parse({
      ...validEnvelopeInput,
      decisionPolicy: undefined,
    });
    expect(envelope.decisionPolicy).toBeNull();
  });

  it("binds an approved answer snapshot and fixed fail-closed stops", () => {
    const envelope = ApplicationAuthorityEnvelopeSchema.parse({
      ...validEnvelopeInput,
      mode: "autonomous_submit",
      scope: elevatedScope,
      expiresAt: "2026-08-27T10:00:00.000Z",
    });
    expect(
      envelope.decisionPolicy?.answerPolicy.approvedAnswerSnapshot,
    ).toEqual({
      revision: 2,
      digest: VALID_SHA,
    });
    expect(envelope.decisionPolicy).toEqual(
      ApplicationAuthorityDecisionPolicySchema.parse(validDecisionPolicy),
    );
    const policy = envelope.decisionPolicy;
    expect(policy).not.toBeNull();
    if (policy === null) {
      throw new Error("Expected elevated authority decision policy.");
    }
    expect(policy.answerPolicy).toEqual(
      ApplicationAuthorityAnswerPolicySchema.parse(validAnswerPolicy),
    );
    expect(policy.stopConditions).toEqual(
      ApplicationAuthorityStopConditionsSchema.parse(validStopConditions),
    );
    expect(
      isApprovedApplicationAnswerSnapshot(envelope, {
        revision: 2,
        digest: VALID_SHA,
      }),
    ).toBe(true);
    expect(
      isApprovedApplicationAnswerSnapshot(envelope, {
        revision: 3,
        digest: VALID_SHA,
      }),
    ).toBe(false);
  });

  it("serializes only canonical policy rules for trusted SHA-256 generation", () => {
    const serialized = serializeApplicationAuthorityDecisionPolicyForDigest({
      stopConditions: validStopConditions,
      answerPolicy: validAnswerPolicy,
      version: 1,
    });
    expect(serialized).toBe(
      JSON.stringify({
        version: 1,
        answerPolicy: validAnswerPolicy,
        stopConditions: validStopConditions,
      }),
    );
    const payload = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.hasOwn(payload, "revision")).toBe(false);
    expect(Object.hasOwn(payload, "digest")).toBe(false);
  });

  it("rejects partial or unsafe decision policies", () => {
    for (const decisionPolicy of [
      { ...validDecisionPolicy, digest: "not-a-digest" },
      { ...validDecisionPolicy, version: 2 },
      {
        ...validDecisionPolicy,
        answerPolicy: {
          ...validAnswerPolicy,
          unknownRequiredQuestion: "guess",
        },
      },
      {
        ...validDecisionPolicy,
        answerPolicy: validAnswerPolicy,
        stopConditions: {
          ...validStopConditions,
          outcomeUncertain: "pause_for_user",
        },
      },
    ]) {
      expect(
        ApplicationAuthorityEnvelopeSchema.safeParse({
          ...validEnvelopeInput,
          mode: "autonomous_submit",
          scope: elevatedScope,
          expiresAt: "2026-08-27T10:00:00.000Z",
          decisionPolicy,
        }).success,
      ).toBe(false);
    }
  });

  it("requires policy and expiry for intermediate external mutation capability", () => {
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        decisionPolicy: null,
        intermediateMutationsAuthorized: true,
        expiresAt: null,
      }).success,
    ).toBe(false);
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        intermediateMutationsAuthorized: true,
        expiresAt: "2026-08-27T11:00:00.000Z",
        scope: { campaignId: null, jobIds: ["job_1"] },
      }).success,
    ).toBe(true);
  });

  it("lets one intermediate mutation grant cover many jobs, resumes and origins", () => {
    // Field saves are on by default (ADR 0024): the grant grows with every
    // application of the session instead of being pinned to one of each.
    const result = ApplicationAuthorityEnvelopeSchema.safeParse({
      ...validEnvelopeInput,
      allowedResumeSha256: [],
      allowedOrigins: ["https://jobs.example.com", "https://apply.example.org"],
      decisionPolicy: validDecisionPolicy,
      expiresAt: "2026-08-27T11:00:00.000Z",
      intermediateMutationsAuthorized: true,
      scope: { campaignId: null, jobIds: ["job_a", "job_b"] },
    });
    expect(result.success).toBe(true);
  });

  test.each([
    ["prepare_only", { campaignId: null, jobIds: [] }, []],
    ["prepare_only", elevatedScope, []],
    ["prepare_only", elevatedScope, [VALID_SHA]],
    ["autonomous_submit", elevatedScope, [VALID_SHA]],
    ["confirm_before_submit", elevatedScope, [VALID_SHA]],
  ])("accepts scoped combination %#", (mode, scope, resumes) => {
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        mode,
        scope,
        allowedResumeSha256: resumes,
        expiresAt: mode === "prepare_only" ? null : "2026-08-27T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test.each(["autonomous_submit", "confirm_before_submit"])(
    "%s requires an explicit campaign or job scope",
    (mode) => {
      const result = ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        mode,
        scope: { campaignId: null, jobIds: [] },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(firstIssuePaths(result.error)).toContain("scope");
      }
    },
  );

  test.each(["autonomous_submit", "confirm_before_submit"])(
    "%s requires a resume allowlist",
    (mode) => {
      const result = ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        mode,
        scope: elevatedScope,
        allowedResumeSha256: [],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(firstIssuePaths(result.error)).toContain("allowedResumeSha256");
      }
    },
  );

  test.each(["autonomous_submit", "confirm_before_submit"])(
    "%s requires an explicit expiry",
    (mode) => {
      const result = ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        mode,
        scope: elevatedScope,
        allowedResumeSha256: [VALID_SHA],
        expiresAt: null,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(firstIssuePaths(result.error)).toContain("expiresAt");
      }
    },
  );

  it("enforces the revoked/revokedAt pairing in both directions", () => {
    const revokedMissingTimestamp =
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        status: "revoked",
        revokedAt: null,
      });
    expect(revokedMissingTimestamp.success).toBe(false);
    if (!revokedMissingTimestamp.success) {
      expect(firstIssuePaths(revokedMissingTimestamp.error)).toContain(
        "revokedAt",
      );
    }

    const timestampWithoutRevoked =
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        status: "active",
        revokedAt: "2026-08-27T10:00:00.000Z",
      });
    expect(timestampWithoutRevoked.success).toBe(false);

    const expiredWithRevocation = ApplicationAuthorityEnvelopeSchema.safeParse({
      ...validEnvelopeInput,
      status: "expired",
      expiresAt: "2026-08-27T10:00:00.000Z",
      revokedAt: "2026-08-27T11:00:00.000Z",
    });
    expect(expiredWithRevocation.success).toBe(false);

    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        status: "revoked",
        revokedAt: "2026-08-27T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("enforces expiry chronology and expired-status consistency", () => {
    const sameInstant = ApplicationAuthorityEnvelopeSchema.safeParse({
      ...validEnvelopeInput,
      expiresAt: CREATED_AT,
    });
    expect(sameInstant.success).toBe(false);

    const beforeCreation = ApplicationAuthorityEnvelopeSchema.safeParse({
      ...validEnvelopeInput,
      expiresAt: "2026-08-25T10:00:00.000Z",
    });
    expect(beforeCreation.success).toBe(false);

    const expiredWithoutExpiry = ApplicationAuthorityEnvelopeSchema.safeParse({
      ...validEnvelopeInput,
      status: "expired",
      expiresAt: null,
    });
    expect(expiredWithoutExpiry.success).toBe(false);

    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        status: "expired",
        expiresAt: "2026-08-25T09:59:59.000Z" /* before creation is rejected */,
      }).success,
    ).toBe(false);

    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        status: "expired",
        expiresAt: "2026-08-27T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects revocation timestamps before creation", () => {
    const result = ApplicationAuthorityEnvelopeSchema.safeParse({
      ...validEnvelopeInput,
      status: "revoked",
      revokedAt: "2026-08-25T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(firstIssuePaths(result.error)).toContain("revokedAt");
    }
  });

  it("rejects malformed resume digests and accepts canonical hex", () => {
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        allowedResumeSha256: ["not-a-sha256"],
      }).success,
    ).toBe(false);
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        allowedResumeSha256: [VALID_SHA.toUpperCase()],
      }).success,
    ).toBe(false);
  });

  test.each([
    { origin: "https://boards.example.com/apply" },
    { origin: "https://boards.example.com?token=secret" },
    { origin: "https://boards.example.com#candidate" },
    { origin: "https://user:secret@boards.example.com" },
    { origin: "ftp://boards.example.com" },
    { origin: "javascript:void(0)" },
    { origin: "not a url" },
  ])("rejects unsafely shaped origin $origin", ({ origin }) => {
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        allowedOrigins: [origin],
      }).success,
    ).toBe(false);
  });

  test.each([
    { field: "maxApplicationsPerRun", value: 0 },
    { field: "maxApplicationsPerRun", value: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects out-of-bounds limit $field=$value", ({ field, value }) => {
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it("represents high-volume authority without turning migration defaults into contract ceilings", () => {
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        maxApplicationsPerRun: 250,
      }).success,
    ).toBe(true);
  });

  it("bounds collection sizes", () => {
    const manyJobIds = Array.from(
      { length: 1000 },
      (_, index) => `job_${index}`,
    );
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        scope: { campaignId: null, jobIds: manyJobIds },
      }).success,
    ).toBe(true);
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        scope: {
          campaignId: null,
          jobIds: [...manyJobIds, "job_overflow"],
        },
      }).success,
    ).toBe(false);

    const manyResumes = Array.from(
      { length: applicationAuthorityMaxResumeDigests },
      (_, index) => index.toString(16).padStart(64, "0"),
    );
    expect(manyResumes).toHaveLength(applicationAuthorityMaxResumeDigests);
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        allowedResumeSha256: manyResumes,
      }).success,
    ).toBe(true);
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        allowedResumeSha256: [...manyResumes, VALID_SHA],
      }).success,
    ).toBe(false);

    const manyOrigins = Array.from(
      { length: applicationAuthorityMaxOrigins },
      (_, index) => `https://host-${index}.example.com`,
    );
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        allowedOrigins: manyOrigins,
      }).success,
    ).toBe(true);
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        allowedOrigins: [...manyOrigins, ORIGIN],
      }).success,
    ).toBe(false);
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        allowedOrigins: [],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate scope, resume, and origin entries", () => {
    const duplicateJobs = ApplicationAuthorityEnvelopeSchema.safeParse({
      ...validEnvelopeInput,
      scope: { campaignId: null, jobIds: ["job_1", "job_1"] },
    });
    expect(duplicateJobs.success).toBe(false);
    if (!duplicateJobs.success) {
      expect(firstIssuePaths(duplicateJobs.error)).toContain("scope.jobIds");
    }

    const duplicateResumes = ApplicationAuthorityEnvelopeSchema.safeParse({
      ...validEnvelopeInput,
      allowedResumeSha256: [VALID_SHA, VALID_SHA],
    });
    expect(duplicateResumes.success).toBe(false);

    const duplicateOrigins = ApplicationAuthorityEnvelopeSchema.safeParse({
      ...validEnvelopeInput,
      allowedOrigins: [ORIGIN, `${ORIGIN}/`],
    });
    expect(duplicateOrigins.success).toBe(false);
  });

  it("fails closed on unknown keys anywhere in the envelope", () => {
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        submitAuthorized: true,
      }).success,
    ).toBe(false);
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        scope: { campaignId: null, jobIds: [], wildcard: "*" },
      }).success,
    ).toBe(false);
    expect(
      ApplicationAuthorityEnvelopeSchema.safeParse({
        ...validEnvelopeInput,
        accountCreationAuthorized: true,
      }).success,
    ).toBe(false);
  });

  it("treats only active envelopes as usable", () => {
    const active = ApplicationAuthorityEnvelopeSchema.parse(validEnvelopeInput);
    const revoked = ApplicationAuthorityEnvelopeSchema.parse({
      ...validEnvelopeInput,
      status: "revoked",
      revokedAt: "2026-08-27T10:00:00.000Z",
    });
    const expired = ApplicationAuthorityEnvelopeSchema.parse({
      ...validEnvelopeInput,
      status: "expired",
      expiresAt: "2026-08-27T10:00:00.000Z",
    });
    const now = "2026-08-26T12:00:00.000Z";
    expect(isActiveApplicationAuthorityEnvelope(active, now)).toBe(true);
    expect(isActiveApplicationAuthorityEnvelope(revoked, now)).toBe(false);
    expect(isActiveApplicationAuthorityEnvelope(expired, now)).toBe(false);
    expect(
      isActiveApplicationAuthorityEnvelope(
        ApplicationAuthorityEnvelopeSchema.parse({
          ...validEnvelopeInput,
          expiresAt: "2026-08-27T10:00:00.000Z",
        }),
        "2026-08-28T10:00:00.000Z",
      ),
    ).toBe(false);
    expect(isActiveApplicationAuthorityEnvelope(active, "not-a-time")).toBe(
      false,
    );
  });
});

describe("submission preflight contracts", () => {
  it("parses a complete preflight record", () => {
    const record = SubmissionPreflightRecordSchema.parse(validPreflightInput);
    expect(record.authorityRevision).toBe(3);
    expect(record.formObservation.revision).toBe(7);
    expect(record.campaignId).toBe("campaign_1");
    expect(record.origin).toBe(ORIGIN);
    expect(record.decisionPolicy).toEqual({
      version: 1,
      revision: 4,
      digest: "b".repeat(64),
    });
  });

  it("rejects non-canonical preflight origins and partial policy identity", () => {
    expect(
      SubmissionPreflightRecordSchema.safeParse({
        ...validPreflightInput,
        origin: `${ORIGIN}/jobs/123?token=secret`,
      }).success,
    ).toBe(false);
    expect(
      SubmissionPreflightRecordSchema.safeParse({
        ...validPreflightInput,
        decisionPolicy: { version: 1, revision: 4 },
      }).success,
    ).toBe(false);
  });

  test.each([
    "id",
    "idempotencyKey",
    "runId",
    "jobId",
    "resultId",
    "applicationRecordId",
    "authorityEnvelopeId",
    "authorityRevision",
    "formObservation",
    "resumeSha256",
    "answers",
    "finalControl",
    "remainingRunCapacityBefore",
    "createdAt",
  ])("cannot omit %s from the exact recheck binding", (key) => {
    const input: Record<string, unknown> = { ...validPreflightInput };
    delete input[key];
    expect(SubmissionPreflightRecordSchema.safeParse(input).success).toBe(
      false,
    );
  });

  test.each([
    {
      label: "observation digest",
      mutate: (input: Record<string, unknown>) => {
        const { formObservation, ...rest } = input;
        void formObservation;
        return {
          ...rest,
          formObservation: { id: "observation_1", revision: 7 },
        };
      },
    },
    {
      label: "answer digest",
      mutate: (input: Record<string, unknown>) => {
        const { answers, ...rest } = input;
        void answers;
        return { ...rest, answers: { revision: 2 } };
      },
    },
    {
      label: "control signature",
      mutate: (input: Record<string, unknown>) => {
        const { finalControl, ...rest } = input;
        void finalControl;
        return {
          ...rest,
          finalControl: { ref: "final-control-submit-button" },
        };
      },
    },
  ])("preflight cannot omit the $label", ({ mutate }) => {
    const input = mutate(validPreflightInput as Record<string, unknown>);
    expect(SubmissionPreflightRecordSchema.safeParse(input).success).toBe(
      false,
    );
  });

  it("carries no raw answers, DOM, credentials, or secrets", () => {
    const serialized = JSON.stringify(
      SubmissionPreflightRecordSchema.parse(validPreflightInput),
    );
    expect(serialized).not.toContain("<input");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("querySelector");
    expect(serialized).not.toContain("Bearer ");
  });

  it("fails closed on unknown keys", () => {
    expect(
      SubmissionPreflightRecordSchema.safeParse({
        ...validPreflightInput,
        rawAnswers: {},
      }).success,
    ).toBe(false);
    expect(
      SubmissionPreflightRecordSchema.safeParse({
        ...validPreflightInput,
        formObservation: { ...validPreflightInput.formObservation, dom: {} },
      }).success,
    ).toBe(false);
  });
});

describe("submission execution grant contracts", () => {
  test.each([
    {
      label: "an active grant carrying revokedAt",
      patch: { status: "active", revokedAt: "2026-08-26T10:30:00.000Z" },
      expectedPath: "revokedAt",
    },
    {
      label: "an active grant carrying consumedAt",
      patch: { status: "active", consumedAt: "2026-08-26T10:30:00.000Z" },
      expectedPath: "consumedAt",
    },
    {
      label: "a revoked grant without revokedAt",
      patch: { status: "revoked", revokedAt: null },
      expectedPath: "revokedAt",
    },
    {
      label: "a revoked grant that is also consumed",
      patch: {
        status: "revoked",
        revokedAt: "2026-08-26T10:30:00.000Z",
        consumedAt: "2026-08-26T10:45:00.000Z",
      },
      expectedPath: "consumedAt",
    },
    {
      label: "a consumed grant without consumedAt",
      patch: { status: "consumed", consumedAt: null },
      expectedPath: "consumedAt",
    },
    {
      label: "a consumed grant that is also revoked",
      patch: {
        status: "consumed",
        consumedAt: "2026-08-26T10:20:00.000Z",
        revokedAt: "2026-08-26T10:45:00.000Z",
      },
      expectedPath: "revokedAt",
    },
    {
      label: "a grant without expiresAt",
      patch: { status: "expired", expiresAt: null },
      expectedPath: "expiresAt",
    },
    {
      label: "an expired grant that is also revoked",
      patch: {
        status: "expired",
        expiresAt: "2026-08-26T10:30:00.000Z",
        revokedAt: "2026-08-26T10:45:00.000Z",
      },
      expectedPath: "revokedAt",
    },
    {
      label: "an expiry equal to the grant instant",
      patch: { expiresAt: CREATED_AT },
      expectedPath: "expiresAt",
    },
    {
      label: "an expiry before the grant instant",
      patch: { expiresAt: "2026-08-26T09:59:59.000Z" },
      expectedPath: "expiresAt",
    },
    {
      label: "a revocation before the grant instant",
      patch: { status: "revoked", revokedAt: "2026-08-26T09:59:59.000Z" },
      expectedPath: "revokedAt",
    },
    {
      label: "a consumption before the grant instant",
      patch: { status: "consumed", consumedAt: "2026-08-26T09:59:59.000Z" },
      expectedPath: "consumedAt",
    },
  ])("rejects $label", ({ patch, expectedPath }) => {
    const result = SubmissionExecutionGrantSchema.safeParse({
      ...validGrantInput,
      ...patch,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(firstIssuePaths(result.error)).toContain(expectedPath);
    }
  });

  test.each([
    {
      label: "an active clean grant",
      patch: {},
    },
    {
      label: "a revoked grant keeping its earlier expiry",
      patch: {
        status: "revoked",
        revokedAt: "2026-08-26T10:30:00.000Z",
        expiresAt: "2026-08-26T11:00:00.000Z",
      },
    },
    {
      label: "a consumed one-time grant",
      patch: {
        status: "consumed",
        consumedAt: "2026-08-26T10:15:00.000Z",
      },
    },
    {
      label: "an expired unspent grant",
      patch: {
        status: "expired",
        expiresAt: "2026-08-26T10:30:00.000Z",
        revokedAt: null,
        consumedAt: null,
      },
    },
  ])("parses $label", ({ patch }) => {
    const grant = SubmissionExecutionGrantSchema.parse({
      ...validGrantInput,
      ...patch,
    });
    expect(grant.grantedBy).toBe("user");
    expect(grant.mode).toBe("confirm_before_submit");
  });

  it("pins mode and grantedBy so nothing else can stand in for the user", () => {
    for (const patch of [
      { mode: "autonomous_submit" },
      { mode: "prepare_only" },
      { grantedBy: "model" },
      { grantedBy: "system" },
      { grantedBy: "envelope" },
    ]) {
      expect(
        SubmissionExecutionGrantSchema.safeParse({
          ...validGrantInput,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });

  it("fails closed on unknown keys", () => {
    expect(
      SubmissionExecutionGrantSchema.safeParse({
        ...validGrantInput,
        submitAuthorized: true,
      }).success,
    ).toBe(false);
  });
});

describe("submission execution grant use gate", () => {
  const NOW = "2026-08-26T10:05:00.000Z";
  const parseGrant = (patch: Record<string, unknown> = {}) =>
    SubmissionExecutionGrantSchema.parse({ ...validGrantInput, ...patch });
  const preflight = SubmissionPreflightRecordSchema.parse(validPreflightInput);

  it("activates only for an exact match at the caller clock", () => {
    expect(isActiveSubmissionExecutionGrant(parseGrant(), NOW, preflight)).toBe(
      true,
    );
  });

  it.each([
    ["preflight id mismatch", { id: "preflight_other" }],
    ["idempotency key mismatch", { idempotencyKey: "other_key" }],
    ["run mismatch", { runId: "other_run" }],
    ["job mismatch", { jobId: "other_job" }],
    ["result mismatch", { resultId: "other_result" }],
    ["application record mismatch", { applicationRecordId: "other_record" }],
    ["authority envelope mismatch", { authorityEnvelopeId: "other_envelope" }],
    ["authority revision mismatch", { authorityRevision: 4 }],
  ])("rejects %s", (_label, preflightPatch) => {
    expect(
      isActiveSubmissionExecutionGrant(parseGrant(), NOW, {
        ...preflight,
        ...preflightPatch,
      }),
    ).toBe(false);
  });

  test.each([
    ["revoked", { status: "revoked", revokedAt: "2026-08-26T10:01:00.000Z" }],
    [
      "consumed",
      { status: "consumed", consumedAt: "2026-08-26T10:01:00.000Z" },
    ],
    ["expired", { status: "expired", expiresAt: "2026-08-26T10:30:00.000Z" }],
  ])("never activates a %s grant", (_label, patch) => {
    expect(
      isActiveSubmissionExecutionGrant(parseGrant(patch), NOW, preflight),
    ).toBe(false);
  });

  it("treats the exact expiry instant as already expired", () => {
    expect(
      isActiveSubmissionExecutionGrant(
        parseGrant(),
        "2026-08-26T11:00:00.000Z",
        preflight,
      ),
    ).toBe(false);
    expect(
      isActiveSubmissionExecutionGrant(
        parseGrant(),
        "2026-08-26T10:59:59.999Z",
        preflight,
      ),
    ).toBe(true);
    expect(
      isActiveSubmissionExecutionGrant(parseGrant(), "not-a-time", preflight),
    ).toBe(false);
    expect(
      isActiveSubmissionExecutionGrant(
        { ...parseGrant(), expiresAt: "not-a-time" },
        NOW,
        preflight,
      ),
    ).toBe(false);
  });

  it("stays closed while only the envelope is active", () => {
    // The confirm-mode envelope alone authorizes nothing: even with an active
    // envelope and a matching clock, a spent grant or any revision drift
    // blocks the final action.
    const envelope = ApplicationAuthorityEnvelopeSchema.parse({
      ...validEnvelopeInput,
      mode: "confirm_before_submit",
      scope: elevatedScope,
      expiresAt: "2026-08-27T10:00:00.000Z",
    });
    expect(isActiveApplicationAuthorityEnvelope(envelope, NOW)).toBe(true);
    expect(
      isActiveSubmissionExecutionGrant(
        parseGrant({
          status: "consumed",
          consumedAt: "2026-08-26T10:01:00.000Z",
        }),
        NOW,
        preflight,
      ),
    ).toBe(false);
    expect(
      isActiveSubmissionExecutionGrant(parseGrant(), NOW, {
        ...preflight,
        authorityRevision: 4,
      }),
    ).toBe(false);
  });
});

describe("submission outcome contracts", () => {
  test("retains browser diagnostics without counting them as submission evidence", () => {
    const browserAction = {
      reason: "action_error",
      actionAttempted: true,
      actionIssued: false,
      requestsObservedDuringAction: 0,
    };
    expect(
      SubmissionOutcomeRecordSchema.parse({
        ...validSubmittedOutcomeInput,
        browserAction,
      }).browserAction,
    ).toEqual(browserAction);
    expect(
      SubmissionOutcomeRecordSchema.safeParse({
        ...validSubmittedOutcomeInput,
        browserAction,
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      SubmissionOutcomeRecordSchema.safeParse({
        ...validSubmittedOutcomeInput,
        browserAction: { ...browserAction, requestsObservedDuringAction: -1 },
      }).success,
    ).toBe(false);
  });
  const uncertainBase = {
    ...validSubmittedOutcomeInput,
    outcome: "outcome_uncertain" as const,
    verifiedAt: null,
    evidence: [],
    retry: { eligible: false, blockReason: "outcome_uncertain" as const },
  };
  const notSubmittedRetryable = {
    ...validSubmittedOutcomeInput,
    outcome: "not_submitted" as const,
    verifiedAt: null,
    evidence: [],
    retry: { eligible: true, blockReason: null },
  };

  it("represents exactly the three documented outcome values", () => {
    expect(
      SubmissionOutcomeRecordSchema.parse(validSubmittedOutcomeInput).outcome,
    ).toBe("submitted");
    expect(SubmissionOutcomeRecordSchema.parse(uncertainBase).outcome).toBe(
      "outcome_uncertain",
    );
    expect(
      SubmissionOutcomeRecordSchema.parse(notSubmittedRetryable).outcome,
    ).toBe("not_submitted");
    expect(
      SubmissionOutcomeRecordSchema.safeParse({
        ...validSubmittedOutcomeInput,
        outcome: "delivered_maybe",
      }).success,
    ).toBe(false);
  });

  it("parses a fully evidenced submitted outcome", () => {
    const record = SubmissionOutcomeRecordSchema.parse(
      validSubmittedOutcomeInput,
    );
    expect(record.outcome).toBe("submitted");
    expect(record.retry.eligible).toBe(false);
  });

  it("requires an explicit, evidenced operator resolution without enabling retry", () => {
    const resolution = SubmissionOutcomeResolutionInputSchema.parse({
      expectedOutcomeId: "outcome_uncertain_1",
      expectedIdempotencyRevision: 3,
      outcome: {
        ...validSubmittedOutcomeInput,
        id: "outcome_operator_1",
        outcome: "not_submitted",
        verifiedAt: "2026-08-26T10:00:06.000Z",
        retry: { eligible: false, blockReason: "policy_decision" },
      },
    });
    expect(resolution.outcome.outcome).toBe("not_submitted");
    expect(resolution.outcome.retry).toEqual({
      eligible: false,
      blockReason: "policy_decision",
    });

    expect(
      SubmissionOutcomeResolutionInputSchema.safeParse({
        ...resolution,
        outcome: {
          ...resolution.outcome,
          retry: { eligible: true, blockReason: null },
        },
      }).success,
    ).toBe(false);
    expect(
      SubmissionOutcomeResolutionInputSchema.safeParse({
        ...resolution,
        outcome: {
          ...resolution.outcome,
          id: resolution.expectedOutcomeId,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects verification or evidence that predates the submission attempt", () => {
    expect(
      SubmissionOutcomeRecordSchema.safeParse({
        ...validSubmittedOutcomeInput,
        verifiedAt: "2026-08-26T10:00:01.000Z",
      }).success,
    ).toBe(false);
    expect(
      SubmissionOutcomeRecordSchema.safeParse({
        ...validSubmittedOutcomeInput,
        evidence: [
          {
            ...evidenceEntry,
            observedAt: "2026-08-26T10:00:01.000Z",
          },
        ],
      }).success,
    ).toBe(false);
  });

  test.each([
    {
      label: "retry eligible true",
      patch: { retry: { eligible: true, blockReason: null } },
      expectedPath: "retry",
    },
    {
      label: "wrong block reason",
      patch: { retry: { eligible: false, blockReason: "outcome_uncertain" } },
      expectedPath: "retry",
    },
    {
      label: "missing verification time",
      patch: { verifiedAt: null },
      expectedPath: "verifiedAt",
    },
    {
      label: "no external evidence",
      patch: { evidence: [] },
      expectedPath: "evidence",
    },
  ])("rejects submitted outcome with $label", ({ patch }) => {
    const result = SubmissionOutcomeRecordSchema.safeParse({
      ...validSubmittedOutcomeInput,
      ...patch,
    });
    expect(result.success).toBe(false);
  });

  it("requires evidence entries to be externally observed kinds", () => {
    expect(
      SubmissionOutcomeRecordSchema.safeParse({
        ...validSubmittedOutcomeInput,
        evidence: [
          {
            ...evidenceEntry,
            kind: "internal_click_intent",
          },
        ],
      }).success,
    ).toBe(false);
  });

  describe("outcome_uncertain", () => {
    it("is representable and permanently non-retryable", () => {
      const record = SubmissionOutcomeRecordSchema.parse(uncertainBase);
      expect(record.outcome).toBe("outcome_uncertain");
      expect(record.retry).toEqual({
        eligible: false,
        blockReason: "outcome_uncertain",
      });
    });

    test.each([
      {
        label: "retryable",
        patch: { retry: { eligible: true, blockReason: null } },
      },
      {
        label: "blocked under another reason",
        patch: {
          retry: { eligible: false, blockReason: "policy_decision" },
        },
      },
      {
        label: "claiming a verification time",
        patch: { verifiedAt: "2026-08-26T10:00:06.000Z" },
      },
    ])("rejects uncertainty with $label", ({ patch }) => {
      expect(
        SubmissionOutcomeRecordSchema.safeParse({
          ...uncertainBase,
          ...patch,
        }).success,
      ).toBe(false);
    });
  });

  describe("not_submitted", () => {
    test.each([
      {
        label: "explicitly retryable",
        patch: { retry: { eligible: true, blockReason: null } },
        success: true,
      },
      {
        label: "explicitly blocked by policy",
        patch: {
          retry: { eligible: false, blockReason: "policy_decision" },
        },
        success: true,
      },
      {
        label: "blocked by spent authority",
        patch: {
          retry: { eligible: false, blockReason: "authority_no_longer_valid" },
        },
        success: true,
      },
      {
        label: "blocked without a stated reason",
        patch: { retry: { eligible: false, blockReason: null } },
        success: false,
      },
      {
        label: "retryable while carrying a block reason",
        patch: {
          retry: { eligible: true, blockReason: "policy_decision" },
        },
        success: false,
      },
    ])("handles not_submitted with $label", ({ patch, success }) => {
      const result = SubmissionOutcomeRecordSchema.safeParse({
        ...notSubmittedRetryable,
        ...patch,
      });
      expect(result.success).toBe(success);
    });
  });

  it("fails closed on unknown keys and unbound lineage", () => {
    expect(
      SubmissionOutcomeRecordSchema.safeParse({
        ...validSubmittedOutcomeInput,
        clickOccurred: true,
      }).success,
    ).toBe(false);
    expect(
      SubmissionOutcomeRecordSchema.safeParse({
        ...validSubmittedOutcomeInput,
        preflightId: null,
      }).success,
    ).toBe(false);
  });
});

describe("privacy receipt compatibility", () => {
  it("parses legacy receipts unchanged with a null outcome", () => {
    const receipt = ApplicationPrivacyReceiptSchema.parse(legacyReceiptInput);
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.submissionOutcome).toBeNull();
    expect(receipt.finalSubmitAuthorized).toBe(false);
    expect(receipt.finalSubmitOccurred).toBe(false);
  });

  it("attaches a consistent submitted outcome", () => {
    const receipt = ApplicationPrivacyReceiptSchema.parse({
      ...legacyReceiptInput,
      finalSubmitOccurred: true,
      submissionOutcome: validSubmittedOutcomeInput,
    });
    expect(receipt.submissionOutcome?.outcome).toBe("submitted");
  });

  test.each([
    {
      label: "mismatched lineage",
      patch: {
        submissionOutcome: {
          ...validSubmittedOutcomeInput,
          jobId: "other_job",
        },
      },
      expectedMessage: /exactly match the receipt lineage/i,
    },
    {
      label: "submitted outcome without the legacy claim",
      patch: {
        finalSubmitOccurred: false,
        submissionOutcome: validSubmittedOutcomeInput,
      },
      expectedMessage: /matching finalSubmitOccurred attestation/i,
    },
    {
      label: "uncertain outcome claiming final submit",
      patch: {
        finalSubmitOccurred: true,
        submissionOutcome: {
          ...validSubmittedOutcomeInput,
          outcome: "outcome_uncertain",
          verifiedAt: null,
          evidence: [],
          retry: { eligible: false, blockReason: "outcome_uncertain" },
        },
      },
      expectedMessage: /uncertain submission outcome forbids/i,
    },
  ])("rejects receipts with $label", ({ patch, expectedMessage }) => {
    expect(() =>
      ApplicationPrivacyReceiptSchema.parse({
        ...legacyReceiptInput,
        ...patch,
      }),
    ).toThrow(expectedMessage);
  });

  it("accepts an uncertain outcome beside honest legacy booleans", () => {
    const receipt = ApplicationPrivacyReceiptSchema.parse({
      ...legacyReceiptInput,
      submissionOutcome: {
        ...validSubmittedOutcomeInput,
        outcome: "outcome_uncertain",
        verifiedAt: null,
        evidence: [],
        retry: { eligible: false, blockReason: "outcome_uncertain" },
      },
    });
    expect(receipt.finalSubmitOccurred).toBe(false);
    expect(receipt.submissionOutcome?.retry.eligible).toBe(false);
  });
});

describe("application packet compatibility", () => {
  it("parses a legacy packet without any outcome record", () => {
    const packet = ApplicationPacketSchema.parse(basePacketInput);
    expect(packet.privacyReceipt).toBeNull();
    expect(packet.submissionOccurred).toBe(false);
  });

  it("represents an uncertain terminal outcome honestly", () => {
    const packet = ApplicationPacketSchema.parse({
      ...basePacketInput,
      privacyReceipt: {
        ...legacyReceiptInput,
        submissionOutcome: {
          ...validSubmittedOutcomeInput,
          outcome: "outcome_uncertain",
          verifiedAt: null,
          evidence: [],
          retry: { eligible: false, blockReason: "outcome_uncertain" },
        },
      },
    });
    expect(packet.result.blockerReason).toBe("submission_outcome_uncertain");
    expect(packet.privacyReceipt?.submissionOutcome?.outcome).toBe(
      "outcome_uncertain",
    );
  });

  test.each([
    {
      label: "uncertainty plus a submission claim",
      patch: { submissionOccurred: true },
      expectedMessage:
        /exactly match both result and receipt proof|forbids claiming submissionOccurred/i,
    },
    {
      label: "a submitted outcome hidden behind a false claim",
      patch: {
        run: { ...basePacketInput.run, state: "completed" },
        result: {
          ...basePacketInput.result,
          state: "submitted",
          blockerReason: null,
        },
        privacyReceipt: {
          ...legacyReceiptInput,
          finalSubmitOccurred: true,
          submissionOutcome: validSubmittedOutcomeInput,
        },
        submissionOccurred: false,
      },
      expectedMessage:
        /must keep the packet submission claim|exactly match both result and receipt proof/i,
    },
    {
      label: "a submitted result state without external proof",
      patch: {
        result: {
          ...basePacketInput.result,
          state: "submitted",
          blockerReason: null,
        },
        privacyReceipt: {
          ...legacyReceiptInput,
          submissionOutcome: {
            ...validSubmittedOutcomeInput,
            outcome: "outcome_uncertain",
            verifiedAt: null,
            evidence: [],
            retry: { eligible: false, blockReason: "outcome_uncertain" },
          },
        },
        submissionOccurred: false,
      },
      expectedMessage: /may accompany a submitted result state/i,
    },
  ])("rejects packets with $label", ({ patch, expectedMessage }) => {
    expect(() =>
      ApplicationPacketSchema.parse({ ...basePacketInput, ...patch }),
    ).toThrow(expectedMessage);
  });

  it("accepts an externally proven submitted packet end to end", () => {
    const packet = ApplicationPacketSchema.parse({
      ...basePacketInput,
      run: { ...basePacketInput.run, state: "completed" },
      result: {
        ...basePacketInput.result,
        state: "submitted",
        blockerReason: null,
      },
      privacyReceipt: {
        ...legacyReceiptInput,
        finalSubmitOccurred: true,
        submissionOutcome: validSubmittedOutcomeInput,
      },
      submissionOccurred: true,
    });
    expect(packet.submissionOccurred).toBe(true);
    expect(packet.privacyReceipt?.submissionOutcome?.verifiedAt).not.toBeNull();
  });
});
