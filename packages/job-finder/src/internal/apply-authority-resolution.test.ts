import {
  ApplicationAuthorityEnvelopeSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
} from "@nestor/contracts";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  authorizeReviewedApplicationOrigin,
  PREPARE_ONLY_AUTHORITY,
  resolveApplyAuthority,
} from "./apply-authority-resolution";
import { withApplicationAuthorityGate } from "./application-authority-gate";

/**
 * What one application may do.
 *
 * Every case here is the same question asked differently: does the document
 * the person saved cover this exact application? Anything short of yes fills
 * the form in and stops, which is never a failure — it is the boundary they
 * set doing its job.
 */

const NOW = "2026-09-14T10:00:00.000Z";
const LATER = "2099-09-20T10:00:00.000Z";
const EARLIER = "2026-09-01T10:00:00.000Z";
const RESUME_DIGEST = "a".repeat(64);
const ORIGIN = "https://apply.example.test";

const answerPolicy = {
  approvedAnswerSnapshot: { revision: 1, digest: "b".repeat(64) },
  unknownRequiredQuestion: "pause_for_user" as const,
  unknownEligibility: "pause_for_user" as const,
  unknownLegalRequirement: "pause_for_user" as const,
  preApprovedAttestationKinds: ["truthfulness_certification" as const],
  salaryDisclosure: "answer_from_profile" as const,
};

const stopConditions = {
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

function envelope(overrides: Record<string, unknown> = {}) {
  const content = { version: 1 as const, answerPolicy, stopConditions };
  return ApplicationAuthorityEnvelopeSchema.parse({
    id: "authority_test",
    mode: "autonomous_submit",
    status: "active",
    revision: 1,
    scope: { campaignId: null, jobIds: ["job_test"] },
    maxApplicationsPerRun: 10,
    intermediateMutationsAuthorized: false,
    accountCreationAuthorized: false,
    allowedResumeSha256: [RESUME_DIGEST],
    allowedOrigins: [`${ORIGIN}/`],
    createdAt: EARLIER,
    expiresAt: LATER,
    revokedAt: null,
    decisionPolicy: {
      ...content,
      revision: 1,
      digest: createHash("sha256")
        .update(serializeApplicationAuthorityDecisionPolicyForDigest(content))
        .digest("hex"),
    },
    ...overrides,
  });
}

function resolve(
  overrides: Parameters<typeof resolveApplyAuthority>[0] | null = null,
) {
  return resolveApplyAuthority(
    overrides ?? {
      envelope: envelope(),

      job: { id: "job_test" },
      resumeSha256: RESUME_DIGEST,
      applicationUrl: `${ORIGIN}/jobs/1/apply`,
      now: NOW,
    },
  );
}

describe("what one application may do", () => {
  test("no saved permission means fill it in and stop", () => {
    const result = resolveApplyAuthority({
      envelope: null,
      job: { id: "job_test" },
      resumeSha256: RESUME_DIGEST,
      applicationUrl: `${ORIGIN}/jobs/1/apply`,
      now: NOW,
    });
    expect(result.authority).toEqual(PREPARE_ONLY_AUTHORITY);
    expect(result.narrowedBecause).toBeNull();
  });

  test("a permission that covers this application carries its exact choices", () => {
    const result = resolve();
    expect(result.narrowedBecause).toBeNull();
    expect(result.authority).toEqual({
      mode: "autonomous_submit",
      submitAuthorized: true,
      preApprovedAttestationKinds: ["truthfulness_certification"],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [ORIGIN],
    });
  });

  test("confirm-first never authorizes the run itself to send", () => {
    const result = resolve({
      envelope: envelope({ mode: "confirm_before_submit" }),
      job: { id: "job_test" },
      resumeSha256: RESUME_DIGEST,
      applicationUrl: `${ORIGIN}/jobs/1/apply`,
      now: NOW,
    });
    expect(result.authority.mode).toBe("confirm_before_submit");
    expect(result.authority.submitAuthorized).toBe(false);
  });

  test("a permission that has run out stops sending, and says so", () => {
    const result = resolve({
      envelope: envelope({ status: "expired" }),
      job: { id: "job_test" },
      resumeSha256: RESUME_DIGEST,
      applicationUrl: `${ORIGIN}/jobs/1/apply`,
      now: LATER,
    });
    expect(result.authority.submitAuthorized).toBe(false);
    expect(result.narrowedBecause).toContain("run out");
  });

  test("a permission the person turned off stops sending, and says so", () => {
    const result = resolve({
      envelope: envelope({ status: "revoked", revokedAt: NOW }),
      job: { id: "job_test" },
      resumeSha256: RESUME_DIGEST,
      applicationUrl: `${ORIGIN}/jobs/1/apply`,
      now: NOW,
    });
    expect(result.narrowedBecause).toContain("turned off");
  });

  test("a job the permission does not name is filled in and left", () => {
    const result = resolve({
      envelope: envelope(),

      job: { id: "job_elsewhere" },
      resumeSha256: RESUME_DIGEST,
      applicationUrl: `${ORIGIN}/jobs/1/apply`,
      now: NOW,
    });
    expect(result.authority).toEqual(PREPARE_ONLY_AUTHORITY);
    expect(result.narrowedBecause).toContain("outside what you allowed");
  });

  test("a whole campaign can be covered instead of one job at a time", () => {
    const result = resolve({
      envelope: envelope({
        scope: { campaignId: "campaign_1", jobIds: [] },
      }),
      job: { id: "job_test", campaignId: "campaign_1" },
      resumeSha256: RESUME_DIGEST,
      applicationUrl: `${ORIGIN}/jobs/1/apply`,
      now: NOW,
    });
    expect(result.authority.submitAuthorized).toBe(true);
  });

  test("a resume the person did not approve for sending is filled in and left", () => {
    const result = resolve({
      envelope: envelope(),

      job: { id: "job_test" },
      resumeSha256: "c".repeat(64),
      applicationUrl: `${ORIGIN}/jobs/1/apply`,
      now: NOW,
    });
    expect(result.authority).toEqual(PREPARE_ONLY_AUTHORITY);
    expect(result.narrowedBecause).toContain("not one you approved");
  });

  test("an application on another site is filled in and left", () => {
    const result = resolve({
      envelope: envelope(),

      job: { id: "job_test" },
      resumeSha256: RESUME_DIGEST,
      applicationUrl: "https://somewhere-else.example.test/apply",
      now: NOW,
    });
    expect(result.authority).toEqual(PREPARE_ONLY_AUTHORITY);
    expect(result.narrowedBecause).toContain("outside what you allowed");
  });

  test("a reviewed employer ATS handoff joins the same task permission", async () => {
    let current = envelope();
    const repository = {
      getApplicationAuthorityEnvelope: () => Promise.resolve(current),
      replaceApplicationAuthorityEnvelope: () =>
        Promise.reject(new Error("unused")),
      commitApplicationAuthorityEnvelope: (input: {
        envelope: typeof current;
        expectedRevision: number | null;
      }) => {
        expect(input.expectedRevision).toBe(1);
        current = input.envelope;
        return Promise.resolve({
          status: "applied" as const,
          envelope: current,
        });
      },
    };

    const widened = await authorizeReviewedApplicationOrigin({
      repository,
      envelope: current,
      jobId: "job_test",
      origin: "https://ats.example.test/application/1",
      now: NOW,
    });

    expect(widened).toMatchObject({
      revision: 2,
      allowedOrigins: [`${ORIGIN}/`, "https://ats.example.test"],
    });
  });

  test("concurrent reviewed origins retain every accepted origin", async () => {
    let current = envelope();
    const repository = {
      getApplicationAuthorityEnvelope: () => Promise.resolve(current),
      replaceApplicationAuthorityEnvelope: () =>
        Promise.reject(new Error("unused")),
      commitApplicationAuthorityEnvelope: async (input: {
        envelope: typeof current;
        expectedRevision: number | null;
      }) => {
        await Promise.resolve();
        if (input.expectedRevision !== current.revision) {
          return { status: "stale" as const, current };
        }
        current = input.envelope;
        return { status: "applied" as const, envelope: current };
      },
    };
    const origins = Array.from(
      { length: 5 },
      (_, index) => `https://ats-${index}.example.test`,
    );
    const grants = await Promise.all(
      origins.map((origin) =>
        authorizeReviewedApplicationOrigin({
          repository,
          envelope: envelope(),

          jobId: "job_test",
          origin,
          now: NOW,
        }),
      ),
    );
    expect(grants.every(Boolean)).toBe(true);
    expect(current.allowedOrigins).toEqual([`${ORIGIN}/`, ...origins]);
  });

  test("a used grant is atomically replaced after a send, preserving concurrent reviewed origins", async () => {
    const original = envelope({
      scope: { campaignId: null, jobIds: ["job_test", "job_other"] },
    });
    let active = original;
    const records = new Map([[original.id, original]]);
    let finishSend!: () => void;
    const sendHeld = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const repository = {
      getApplicationAuthorityEnvelope: (id: string) =>
        Promise.resolve(records.get(id) ?? null),
      commitApplicationAuthorityEnvelope: async (input: {
        envelope: typeof original;
        expectedRevision: number | null;
      }) => {
        await Promise.resolve();
        if (
          active.id !== input.envelope.id ||
          active.revision !== input.expectedRevision
        )
          return {
            status: "stale" as const,
            current: records.get(input.envelope.id) ?? null,
          };
        if (active.id === original.id)
          return { status: "stale" as const, current: active }; // Used by the first send.
        active = input.envelope;
        records.set(active.id, active);
        return { status: "applied" as const, envelope: active };
      },
      replaceApplicationAuthorityEnvelope: async (input: {
        currentId: string;
        expectedRevision: number;
        replacement: typeof original;
        revokedAt: string;
      }) => {
        await Promise.resolve();
        if (
          active.id !== input.currentId ||
          active.revision !== input.expectedRevision
        )
          return {
            status: "stale" as const,
            current: records.get(input.currentId) ?? null,
          };
        const previous = ApplicationAuthorityEnvelopeSchema.parse({
          ...active,
          status: "revoked",
          revision: active.revision + 1,
          revokedAt: input.revokedAt,
        });
        records.set(previous.id, previous);
        active = input.replacement;
        records.set(active.id, active);
        return { status: "applied" as const, previous, envelope: active };
      },
    };
    const inFlightSend = withApplicationAuthorityGate(
      repository,
      undefined,
      () => sendHeld,
    );
    const origins = [
      "https://ats-one.example.test",
      "https://ats-two.example.test",
    ];
    const reviewed = origins.map((origin, index) =>
      authorizeReviewedApplicationOrigin({
        repository: repository as never,
        envelope: original,
        jobId: index === 0 ? "job_test" : "job_other",
        origin,
        now: NOW,
      }),
    );
    await Promise.resolve();
    expect(active.id).toBe(original.id);
    finishSend();
    await inFlightSend;
    expect((await Promise.all(reviewed)).every(Boolean)).toBe(true);
    expect(active.id).not.toBe(original.id);
    expect(active.scope.jobIds).toEqual(original.scope.jobIds);
    expect(active.allowedResumeSha256).toEqual(original.allowedResumeSha256);
    expect(active.decisionPolicy).toEqual(original.decisionPolicy);
    expect(active.allowedOrigins).toEqual([`${ORIGIN}/`, ...origins]);

    // Revocation has no replacement edge. A stale prepared page cannot add
    // another origin to this grant or a later unrelated grant.
    records.set(
      active.id,
      ApplicationAuthorityEnvelopeSchema.parse({
        ...active,
        status: "revoked",
        revision: active.revision + 1,
        revokedAt: new Date().toISOString(),
      }),
    );
    expect(
      await authorizeReviewedApplicationOrigin({
        repository: repository as never,
        envelope: original,
        jobId: "job_test",
        origin: "https://ats-late.example.test",
        now: NOW,
      }),
    ).toBeNull();
  });
});

test("the saved pay choice applies when filling only, without granting submission", () => {
  const result = resolve({
    envelope: envelope({ mode: "prepare_only" }),
    salaryDisclosure: "answer_from_profile",
    job: { id: "job_test" },
    resumeSha256: RESUME_DIGEST,
    applicationUrl: `${ORIGIN}/jobs/1/apply`,
    now: NOW,
  });
  expect(result.authority.salaryDisclosure).toBe("answer_from_profile");
  expect(result.authority.mode).toBe("prepare_only");
  expect(result.authority.submitAuthorized).toBe(false);
  expect(result.authority.allowedOrigins).toEqual([]);
});

test.each([
  null,
  { mode: "prepare_only" },
  { status: "revoked", revokedAt: NOW },
  { expiresAt: "2026-09-10T10:00:00.000Z" },
  { scope: { jobIds: ["other"], campaignId: null } },
])("pay choice is independent of the sending boundary %j", (change) => {
  const result = resolveApplyAuthority({
    envelope: change ? envelope(change) : null,
    salaryDisclosure: "answer_from_profile",
    job: { id: "job_test" },
    resumeSha256: RESUME_DIGEST,
    applicationUrl: `${ORIGIN}/jobs/1/apply`,
    now: NOW,
  });
  expect(result.authority.salaryDisclosure).toBe("answer_from_profile");
  expect(result.authority.submitAuthorized).toBe(false);
});
