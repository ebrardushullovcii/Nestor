import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type CandidateReusableAnswer,
  ApplicationAuthorityDecisionPolicySchema,
  ApplicationAuthorityEnvelopeSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  deriveApprovedApplicationAnswerSnapshotContent,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  serializeApprovedApplicationAnswerSnapshotForDigest,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";

import { createSeed } from "../workspace-service.test-fixtures";
import { resolvePrepareOnlyIntermediateMutationAuthority } from "./prepare-only-intermediate-mutation-authority";

const NOW = "2026-08-28T08:00:00.000Z";
const EXPIRES_AT = "2026-08-28T09:00:00.000Z";
const RESUME_SHA = "a".repeat(64);

async function createAuthorizedFixture() {
  const seed = createSeed();
  const repository = createInMemoryJobFinderRepository(seed);
  const answers: CandidateReusableAnswer[] = [
    "work_authorization",
    "visa_sponsorship",
  ].map((kind) => ({
    id: kind,
    kind: kind as CandidateReusableAnswer["kind"],
    label: kind,
    question: kind,
    answer: "Confirmed",
    roleFamilies: [],
    proofEntryIds: [],
  }));
  const readSavedAnswers = () => answers;
  const profileState = await repository.getProfileWithRevision();
  const derived = deriveApprovedApplicationAnswerSnapshotContent(
    profileState.profile,
    answers,
  );
  if (derived.content === null) {
    throw new Error("Expected reusable answers in the test profile.");
  }
  const answerDigest = createHash("sha256")
    .update(
      serializeApprovedApplicationAnswerSnapshotForDigest(derived.content),
      "utf8",
    )
    .digest("hex");
  const snapshot = ApprovedApplicationAnswerSnapshotSchema.parse({
    ...derived.content,
    id: "answer_snapshot_1",
    revision: 1,
    digest: answerDigest,
    sourceProfileRevision: profileState.revision,
    approvedAt: NOW,
  });
  await repository.commitApplicationAnswerSnapshot({
    expectedLatestRevision: null,
    snapshot,
  });
  const policyContent = {
    version: 1 as const,
    answerPolicy: {
      approvedAnswerSnapshot: {
        revision: snapshot.revision,
        digest: snapshot.digest,
      },
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
  const decisionPolicy = ApplicationAuthorityDecisionPolicySchema.parse({
    ...policyContent,
    revision: 1,
    digest: createHash("sha256")
      .update(
        serializeApplicationAuthorityDecisionPolicyForDigest(policyContent),
        "utf8",
      )
      .digest("hex"),
  });
  const job = seed.savedJobs[0]!;
  const envelope = ApplicationAuthorityEnvelopeSchema.parse({
    id: "authority_1",
    mode: "prepare_only",
    status: "active",
    revision: 1,
    scope: { campaignId: null, jobIds: [job.id] },
    maxApplicationsPerRun: 1,
    intermediateMutationsAuthorized: true,
    accountCreationAuthorized: false,
    allowedResumeSha256: [RESUME_SHA],
    allowedOrigins: [new URL(job.applicationUrl!).origin],
    createdAt: NOW,
    expiresAt: EXPIRES_AT,
    revokedAt: null,
    decisionPolicy,
  });
  await repository.commitApplicationAuthorityEnvelope({
    envelope,
    expectedRevision: null,
  });
  return { envelope, job, repository, answers, readSavedAnswers };
}

describe("prepare-only intermediate mutation authority", () => {
  it("authorizes only the exact current job, origin, resume, and approved answers", async () => {
    const { envelope, job, repository, readSavedAnswers } =
      await createAuthorizedFixture();
    await expect(
      resolvePrepareOnlyIntermediateMutationAuthority({
        job,
        now: NOW,
        observedOrigin: envelope.allowedOrigins[0]!,
        repository,
        readSavedAnswers,
        resumeSha256: RESUME_SHA,
      }),
    ).resolves.toMatchObject({
      authorized: true,
      authorityEnvelopeId: envelope.id,
      authorityRevision: envelope.revision,
      allowedOrigins: envelope.allowedOrigins,
    });

    await expect(
      resolvePrepareOnlyIntermediateMutationAuthority({
        job,
        now: NOW,
        observedOrigin: "https://outside.example.com",
        repository,
        readSavedAnswers,
        resumeSha256: RESUME_SHA,
      }),
    ).resolves.toEqual({
      authorized: false,
      allowedOrigins: [],
      reason: "destination_origin_mismatch",
    });
    await expect(
      resolvePrepareOnlyIntermediateMutationAuthority({
        job,
        now: NOW,
        repository,
        readSavedAnswers,
        resumeSha256: "b".repeat(64),
      }),
    ).resolves.toMatchObject({ authorized: false, reason: "resume_mismatch" });
  });

  it("fails closed after answer drift or expiry", async () => {
    const { job, repository, answers, readSavedAnswers } =
      await createAuthorizedFixture();
    answers[0]!.answer = "Changed after approval";
    await expect(
      resolvePrepareOnlyIntermediateMutationAuthority({
        job,
        now: NOW,
        repository,
        readSavedAnswers,
        resumeSha256: RESUME_SHA,
      }),
    ).resolves.toMatchObject({
      authorized: false,
      reason: "answer_policy_stale",
    });

    const fresh = await createAuthorizedFixture();
    await expect(
      resolvePrepareOnlyIntermediateMutationAuthority({
        job: fresh.job,
        now: EXPIRES_AT,
        repository: fresh.repository,
        readSavedAnswers: fresh.readSavedAnswers,
        resumeSha256: RESUME_SHA,
      }),
    ).resolves.toMatchObject({
      authorized: false,
      reason: "authority_inactive",
    });
  });
});
