import {
  ApplicationAuthorityEnvelopeSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  SubmissionExecutionGrantSchema,
  SubmissionPreflightRecordSchema,
  type ApplicationAutomationMode,
} from "@nestor/contracts";
import {
  createSendGuards,
  openJobStore,
  type SendGuards,
} from "@nestor/db/job-store";
import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import {
  runSyntheticApplicationSubmission,
  type RunSyntheticApplicationSubmissionInput,
  type SyntheticSubmissionAuthorityRepository,
  type SyntheticSubmissionExecutor,
  type SyntheticSubmissionExecutorResult,
} from "./application-submission-orchestrator";

const NOW = "2026-08-27T10:00:00.000Z";
const EXPIRES_AT = "2026-08-27T11:00:00.000Z";
const SHA_RESUME = "a".repeat(64);
const SHA_ANSWERS = "b".repeat(64);
const SHA_FINAL_CONTROL = "c".repeat(64);
const ORIGIN = "https://boards.example.com";

const DECISION_POLICY_RULES = {
  version: 1 as const,
  revision: 1,
  answerPolicy: {
    approvedAnswerSnapshot: { revision: 1, digest: SHA_ANSWERS },
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
const SHA_POLICY = createHash("sha256")
  .update(
    serializeApplicationAuthorityDecisionPolicyForDigest({
      version: DECISION_POLICY_RULES.version,
      answerPolicy: DECISION_POLICY_RULES.answerPolicy,
      stopConditions: DECISION_POLICY_RULES.stopConditions,
    }),
    "utf8",
  )
  .digest("hex");
const DECISION_POLICY = { ...DECISION_POLICY_RULES, digest: SHA_POLICY };

function createEnvelope(mode: ApplicationAutomationMode = "autonomous_submit") {
  return ApplicationAuthorityEnvelopeSchema.parse({
    id: "authority_1",
    mode,
    status: "active",
    revision: 1,
    scope: { campaignId: "campaign_1", jobIds: ["job_1"] },
    maxApplicationsPerRun: 1,
    // The orchestrator exercises final-action authority, not the independent
    // bounded ATS autosave capability.
    intermediateMutationsAuthorized: false,
    accountCreationAuthorized: false,
    allowedResumeSha256: mode === "prepare_only" ? [] : [SHA_RESUME],
    allowedOrigins: [ORIGIN],
    createdAt: NOW,
    expiresAt: mode === "prepare_only" ? null : EXPIRES_AT,
    revokedAt: null,
    decisionPolicy: DECISION_POLICY,
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
    campaignId: "campaign_1",
    origin: ORIGIN,
    authorityEnvelopeId: "authority_1",
    authorityRevision: 1,
    decisionPolicy: {
      version: DECISION_POLICY.version,
      revision: DECISION_POLICY.revision,
      digest: DECISION_POLICY.digest,
    },
    formObservation: { id: "observation_1", revision: 1, digest: SHA_RESUME },
    resumeSha256: SHA_RESUME,
    answers: { revision: 1, digest: SHA_ANSWERS },
    finalControl: { signature: SHA_FINAL_CONTROL, ref: "final_control_1" },
    remainingRunCapacityBefore: 1,
    createdAt: NOW,
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
    grantedAt: NOW,
    expiresAt: EXPIRES_AT,
    revokedAt: null,
    consumedAt: null,
  });
}

function createNotSubmittedExecutor() {
  return {
    execute: vi.fn(() =>
      Promise.resolve({
        outcome: "not_submitted" as const,
        evidence: [],
        retry: { eligible: false, blockReason: "policy_decision" as const },
      }),
    ),
  } satisfies SyntheticSubmissionExecutor;
}

function createInput(
  repository: SyntheticSubmissionAuthorityRepository,
  options: {
    mode?: ApplicationAutomationMode;
    executor?: SyntheticSubmissionExecutor;
    observation?: Partial<
      RunSyntheticApplicationSubmissionInput["observation"]
    >;
    executionGrantId?: string | null;
    personConfirmation?: { grantedAt: string; expiresAt: string } | null;
  } = {},
): RunSyntheticApplicationSubmissionInput {
  const mode = options.mode ?? "autonomous_submit";
  const input = {
    repository,
    preflight: createPreflight(),
    savedMode: mode,
    jobId: "job_1",
    campaignId: "campaign_1",
    observation: {
      origin: ORIGIN,
      formObservation: { id: "observation_1", revision: 1, digest: SHA_RESUME },
      resumeSha256: SHA_RESUME,
      answers: { revision: 1, digest: SHA_ANSWERS },
      finalControl: { signature: SHA_FINAL_CONTROL, ref: "final_control_1" },
      remainingRunCapacity: 1,
      currentPolicyFacts: {
        policy: {
          version: DECISION_POLICY.version,
          revision: DECISION_POLICY.revision,
          digest: DECISION_POLICY.digest,
        },
        answers: { revision: 1, digest: SHA_ANSWERS },
        mandatoryStops: [],
      },
      ...options.observation,
    },
    now: NOW,
    executor: options.executor ?? createNotSubmittedExecutor(),
  };

  return {
    ...input,
    ...(options.executionGrantId === undefined
      ? {}
      : { executionGrantId: options.executionGrantId }),
    ...(options.personConfirmation
      ? { personConfirmation: options.personConfirmation }
      : {}),
  };
}

async function commitEnvelope(
  repository: SendGuards,
  mode: ApplicationAutomationMode = "autonomous_submit",
) {
  const envelope = createEnvelope(mode);
  expect(
    await repository.commitApplicationAuthorityEnvelope({
      envelope,
      expectedRevision: null,
    }),
  ).toMatchObject({ status: "applied" });
  return envelope;
}

async function commitPreflightAndGrant(
  repository: SendGuards,
  includeGrant = true,
) {
  const preflight = createPreflight();
  expect(await repository.commitSubmissionPreflight(preflight)).toMatchObject({
    status: "created",
  });
  if (includeGrant) {
    expect(
      await repository.commitSubmissionExecutionGrant(createGrant()),
    ).toMatchObject({ status: "created" });
  }
  return preflight;
}

describe("synthetic application submission orchestrator", () => {
  test("a person's retry after a not-sent attempt sends under the next key and records its outcome", async () => {
    const repository = createSendGuards(openJobStore(":memory:"));
    const envelope = ApplicationAuthorityEnvelopeSchema.parse({
      ...createEnvelope(),
      maxApplicationsPerRun: 5,
    });
    await commitEnvelope(repository);
    expect(
      await repository.commitApplicationAuthorityEnvelope({
        envelope: { ...envelope, revision: 2 },
        expectedRevision: 1,
      }),
    ).toMatchObject({ status: "applied" });
    const first = await runSyntheticApplicationSubmission({
      ...createInput(repository, {
        observation: { remainingRunCapacity: 5 },
      }),
      preflight: SubmissionPreflightRecordSchema.parse({
        ...createPreflight(),
        authorityRevision: 2,
        remainingRunCapacityBefore: 5,
      }),
    });
    expect(first.status).toBe("recorded_not_submitted");

    const confirmed = {
      outcome: "submitted",
      verifiedAt: NOW,
      evidence: [
        {
          id: "retry_evidence",
          kind: "employer_site_state",
          observedAt: NOW,
          destination: { origin: ORIGIN, safePath: "/confirmation" },
          artifactRefId: null,
          summary: "The employer site confirmed receipt.",
        },
      ],
    } as unknown as SyntheticSubmissionExecutorResult;
    const submitted = {
      execute: vi.fn(() => Promise.resolve(confirmed)),
    } satisfies SyntheticSubmissionExecutor;
    const retry = await runSyntheticApplicationSubmission({
      ...createInput(repository, {
        executor: submitted,
        observation: { remainingRunCapacity: 4 },
      }),
      preflight: SubmissionPreflightRecordSchema.parse({
        ...createPreflight(),
        id: "preflight_1_retry1",
        idempotencyKey: "submit_once_1_retry1",
        authorityRevision: 2,
        remainingRunCapacityBefore: 4,
      }),
    });
    expect(retry).toMatchObject({ status: "submitted" });
    expect(submitted.execute).toHaveBeenCalledTimes(1);
    expect(
      await repository.getSubmissionIdempotencyRecord("submit_once_1_retry1"),
    ).toMatchObject({ status: "resolved", outcome: "submitted" });
  });

  test("runs an autonomous attempt once, arms before execution, and records not-submitted", async () => {
    const repository = createSendGuards(openJobStore(":memory:"));
    await commitEnvelope(repository);
    const executor = createNotSubmittedExecutor();
    const result = await runSyntheticApplicationSubmission(
      createInput(repository, { executor }),
    );

    expect(result.status).toBe("recorded_not_submitted");
    if (result.status !== "recorded_not_submitted") {
      throw new Error("Expected a recorded not-submitted outcome.");
    }
    expect(result.outcome).toMatchObject({
      outcome: "not_submitted",
      retry: { eligible: false, blockReason: "policy_decision" },
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(
      await repository.getSubmissionIdempotencyRecord("submit_once_1"),
    ).toMatchObject({ status: "resolved", outcome: "not_submitted" });
    expect(await repository.listSubmissionArmedMarkers()).toHaveLength(1);
  });

  test("returns recovery-needed on ambiguous compound failure with no synthetic action", async () => {
    const baseRepository = createSendGuards(openJobStore(":memory:"));
    await commitEnvelope(baseRepository, "confirm_before_submit");
    await commitPreflightAndGrant(baseRepository);
    const compoundFailureRepository: SyntheticSubmissionAuthorityRepository = {
      ...baseRepository,
      authorizeAndArmSubmissionAttempt: vi.fn(() =>
        Promise.reject(new Error("synthetic compound transition failed")),
      ),
    };
    const executor = createNotSubmittedExecutor();

    const result = await runSyntheticApplicationSubmission(
      createInput(compoundFailureRepository, {
        mode: "confirm_before_submit",
        executionGrantId: "grant_1",
        executor,
      }),
    );

    expect(result).toMatchObject({
      status: "recovery_needed",
      cause: "recovery_rejected",
    });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(
      await baseRepository.getSubmissionExecutionGrant("grant_1"),
    ).toMatchObject({
      status: "active",
    });
    expect(
      await baseRepository.getSubmissionIdempotencyRecord("submit_once_1"),
    ).toMatchObject({ status: "available" });
  });

  test("turns executor exceptions into durable uncertainty and permanently blocks retry", async () => {
    const repository = createSendGuards(openJobStore(":memory:"));
    await commitEnvelope(repository);
    const executor = {
      execute: vi.fn(() =>
        Promise.reject(new Error("synthetic executor crashed")),
      ),
    } satisfies SyntheticSubmissionExecutor;

    const first = await runSyntheticApplicationSubmission(
      createInput(repository, { executor }),
    );
    expect(first).toMatchObject({
      status: "outcome_uncertain",
      cause: "executor_error",
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(
      await repository.getSubmissionIdempotencyRecord("submit_once_1"),
    ).toMatchObject({
      status: "outcome_uncertain",
      outcome: "outcome_uncertain",
    });

    const retryExecutor = createNotSubmittedExecutor();
    const retry = await runSyntheticApplicationSubmission(
      createInput(repository, { executor: retryExecutor }),
    );
    expect(retry).toMatchObject({
      status: "outcome_uncertain",
    });
    expect(retryExecutor.execute).not.toHaveBeenCalled();
  });

  test("records submitted when the executor provides employer-site evidence", async () => {
    const repository = createSendGuards(openJobStore(":memory:"));
    await commitEnvelope(repository);
    const fabricatedSubmittedResult = {
      outcome: "submitted",
      verifiedAt: NOW,
      evidence: [
        {
          id: "fabricated_evidence",
          kind: "employer_site_state",
          observedAt: NOW,
          destination: { origin: ORIGIN, safePath: "/confirmation" },
          artifactRefId: null,
          summary: "The employer site confirmed receipt.",
        },
      ],
    } as unknown as SyntheticSubmissionExecutorResult;
    const executor = {
      execute: vi.fn(() => Promise.resolve(fabricatedSubmittedResult)),
    } satisfies SyntheticSubmissionExecutor;

    const result = await runSyntheticApplicationSubmission(
      createInput(repository, { executor }),
    );

    expect(result.status).toBe("submitted");
    if (result.status !== "submitted") {
      throw new Error("Expected employer confirmation to count as submitted");
    }
    expect(result.outcome).toMatchObject({
      outcome: "submitted",
      retry: { eligible: false, blockReason: "submission_confirmed" },
    });
  });

  test("serializes same-key calls and prevents a second executor after the first resolves", async () => {
    const repository = createSendGuards(openJobStore(":memory:"));
    await commitEnvelope(repository);
    let release!: () => void;
    const firstExecution = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = {
      execute: vi.fn(async () => {
        await firstExecution;
        return createNotSubmittedExecutor().execute();
      }),
    } satisfies SyntheticSubmissionExecutor;

    const first = runSyntheticApplicationSubmission(
      createInput(repository, { executor }),
    );
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(1));
    const second = runSyntheticApplicationSubmission(
      createInput(repository, { executor }),
    );
    await Promise.resolve();
    expect(executor.execute).toHaveBeenCalledTimes(1);
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe("recorded_not_submitted");
    expect(secondResult).toMatchObject({
      status: "recorded_not_submitted",
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
