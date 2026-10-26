import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryJobFinderRepository } from "@nestor/db";
import {
  createSavedAnswersStore,
  readSavedApplicationAnswers,
} from "@nestor/db/applications";
import { openJobStore } from "@nestor/db/job-store";
import {
  SubmissionIdempotencyRecordSchema,
  SubmissionOutcomeRecordSchema,
  type CandidateAnswerKind,
  type ApplicationAuthorityEnvelopeMutationResult,
  type ApprovedApplicationAnswerSnapshot,
  type CreateApplicationAuthorityEnvelopeInput,
} from "@nestor/contracts";

import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import { createJobFinderApplicationAuthorityService } from "./application-authority-service";

const memories: ReturnType<typeof openJobStore>[] = [];
afterEach(() => {
  for (const store of memories.splice(0)) store.close();
});
function makeService(
  options: Parameters<typeof createJobFinderApplicationAuthorityService>[0],
) {
  const store = openJobStore(":memory:");
  memories.push(store);
  const answers = createSavedAnswersStore(store);
  return Object.assign(
    createJobFinderApplicationAuthorityService({
      ...options,
      readSavedAnswers: () => readSavedApplicationAnswers(store),
    }),
    {
      saveAnswers(values: Partial<Record<CandidateAnswerKind, string>>) {
        for (const [kind, answer] of Object.entries(values))
          answers.upsert({
            key: kind,
            kind: kind as CandidateAnswerKind,
            prompt: kind,
            label: kind,
            answer,
          });
      },
    },
  );
}
const NOW = "2026-08-27T10:00:00.000Z";
const LATER = "2026-08-28T10:00:00.000Z";
const SHA = "a".repeat(64);

function createPolicy(
  overrides: Partial<CreateApplicationAuthorityEnvelopeInput> = {},
): CreateApplicationAuthorityEnvelopeInput {
  return {
    mode: "prepare_only",
    scope: { campaignId: null, jobIds: [] },
    maxApplicationsPerRun: 1,
    intermediateMutationsAuthorized: false,
    allowedResumeSha256: [SHA],
    allowedOrigins: ["https://boards.example.com"],
    expiresAt: null,
    ...overrides,
  };
}

function expectApplied(result: ApplicationAuthorityEnvelopeMutationResult) {
  expect(result.status).toBe("applied");
  if (result.status !== "applied") {
    throw new Error("Expected an applied authority mutation.");
  }
  return result.envelope;
}

describe("Job Finder application authority service", () => {
  it("atomically replaces one grant after it has been used", async () => {
    const repository = createInMemoryJobFinderRepository(
      createEmptyJobFinderRepositoryState(),
    );
    let nextId = 0;
    const service = makeService({
      repository,
      now: () => NOW,
      idFactory: () => String(++nextId),
    });
    const first = expectApplied(
      await service.create(
        createPolicy({
          scope: { campaignId: null, jobIds: ["job_first"] },
        }),
      ),
    );
    const replacement = expectApplied(
      await service.replaceUsed({
        ...createPolicy({
          scope: { campaignId: null, jobIds: ["job_first", "job_second"] },
          allowedOrigins: [
            "https://boards.example.com",
            "https://ats.example.com",
          ],
        }),
        id: first.id,
        expectedRevision: first.revision,
      }),
    );
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.scope.jobIds).toEqual(["job_first", "job_second"]);
    expect(replacement.allowedOrigins).toEqual([
      "https://boards.example.com",
      "https://ats.example.com",
    ]);
    expect(
      await repository.listApplicationAuthorityEnvelopes({ status: "active" }),
    ).toEqual([replacement]);
    expect(
      await repository.getApplicationAuthorityEnvelope(first.id),
    ).toMatchObject({ status: "revoked" });
  });
  it.each(["confirm_before_submit", "autonomous_submit"] as const)(
    "approves an empty answer bank and creates the first %s permission",
    async (mode) => {
      const repository = createInMemoryJobFinderRepository(
        createEmptyJobFinderRepositoryState(),
      );
      const service = makeService({
        repository,
        now: () => NOW,
        idFactory: () => "empty",
      });
      const profileState = await repository.getProfileWithRevision();
      const approval = await service.approveCurrentAnswers({
        expectedProfileRevision: profileState.revision,
        confirmedCurrentAnswers: true,
      });
      expect(approval).toMatchObject({
        status: "created",
        snapshot: { entryCount: 0, kinds: [] },
        readiness: { approvedSnapshot: { entryCount: 0 } },
      });
      await expect(service.getReadiness()).resolves.toMatchObject({
        approvedSnapshot: { entryCount: 0 },
      });
      const created = expectApplied(
        await service.create(
          createPolicy({
            mode,
            scope: { campaignId: null, jobIds: ["job_first"] },
            expiresAt: LATER,
            intermediateMutationsAuthorized: true,
          }),
        ),
      );
      expect(created).toMatchObject({
        mode,
        allowedResumeSha256: [SHA],
        accountCreationAuthorized: false,
        decisionPolicy: {
          answerPolicy: {
            approvedAnswerSnapshot: {
              revision: approval.snapshot?.revision,
              digest: approval.snapshot?.digest,
            },
            unknownRequiredQuestion: "pause_for_user",
            unknownEligibility: "pause_for_user",
          },
        },
      });
    },
  );

  it("creates, reads, revision-updates, and revokes one prepare-only envelope", async () => {
    const repository = createInMemoryJobFinderRepository(
      createEmptyJobFinderRepositoryState(),
    );
    const service = makeService({
      repository,
      now: () => NOW,
      idFactory: () => "test",
    });

    const created = expectApplied(await service.create(createPolicy()));
    expect(created).toMatchObject({
      id: "authority_test",
      mode: "prepare_only",
      status: "active",
      revision: 1,
      accountCreationAuthorized: false,
      createdAt: NOW,
      revokedAt: null,
    });

    await expect(service.get({ id: created.id })).resolves.toMatchObject({
      id: created.id,
      revision: 1,
    });
    await expect(service.list({ status: "active" })).resolves.toHaveLength(1);

    const updated = expectApplied(
      await service.update({
        ...createPolicy({
          maxApplicationsPerRun: 2,
          expiresAt: LATER,
        }),
        id: created.id,
        expectedRevision: 1,
      }),
    );
    expect(updated.revision).toBe(2);
    expect(updated.maxApplicationsPerRun).toBe(2);
    expect(updated.createdAt).toBe(NOW);

    await expect(
      service.update({
        ...createPolicy(),
        id: created.id,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "stale", current: { revision: 2 } });

    const revoked = expectApplied(
      await service.revoke({ id: created.id, expectedRevision: 2 }),
    );
    expect(revoked.status).toBe("revoked");
    expect(revoked.revokedAt).toBe(NOW);
    await expect(service.list({ status: "active" })).resolves.toHaveLength(0);
    await expect(service.list({ status: "revoked" })).resolves.toHaveLength(1);
  });

  it("fails closed without approved answers, on duplicate active authority, and on legacy fields", async () => {
    const repository = createInMemoryJobFinderRepository(
      createEmptyJobFinderRepositoryState(),
    );
    const service = makeService({
      repository,
      now: () => NOW,
      idFactory: () => "test",
    });

    // Sending applications is reachable, but only once the person's saved
    // answers are approved and current; the authority binds to that snapshot.
    await expect(
      service.create(
        createPolicy({
          mode: "autonomous_submit",
        }),
      ),
    ).rejects.toMatchObject({
      code: "approved_answers_required",
    });
    await service.create(createPolicy());
    await expect(
      service.create(createPolicy({ expiresAt: LATER })),
    ).rejects.toMatchObject({
      code: "active_authority_exists",
    });

    await expect(
      service.create({
        ...createPolicy(),
        allowAutoSubmitOverride: true,
      } as unknown as CreateApplicationAuthorityEnvelopeInput),
    ).rejects.toThrow();
  });

  it("stamps bounded autosave policy from fresh approved answers and rejects answer drift", async () => {
    const repository = createInMemoryJobFinderRepository(
      createEmptyJobFinderRepositoryState(),
    );
    const service = makeService({
      repository,
      now: () => NOW,
      idFactory: () => "autosave",
    });
    const autosavePolicy = createPolicy({
      expiresAt: LATER,
      intermediateMutationsAuthorized: true,
      scope: { campaignId: null, jobIds: ["job_1"] },
    });

    await expect(service.create(autosavePolicy)).rejects.toMatchObject({
      code: "approved_answers_required",
    });

    service.saveAnswers({
      visa_sponsorship: "No sponsorship required",
      work_authorization: "Authorized to work in the EU",
    });
    const readiness = await service.getReadiness();
    const approval = await service.approveCurrentAnswers({
      confirmedCurrentAnswers: true,
      expectedProfileRevision: readiness.currentAnswers.sourceProfileRevision,
    });
    expect(approval.status).toBe("created");

    const created = expectApplied(await service.create(autosavePolicy));
    expect(created).toMatchObject({
      intermediateMutationsAuthorized: true,
      decisionPolicy: {
        version: 1,
        revision: 1,
        answerPolicy: {
          approvedAnswerSnapshot: {
            revision: approval.snapshot?.revision,
            digest: approval.snapshot?.digest,
          },
          unknownRequiredQuestion: "pause_for_user",
          unknownEligibility: "pause_for_user",
          unknownLegalRequirement: "pause_for_user",
        },
        stopConditions: {
          captcha: "pause_for_user",
          accountCreation: "pause_for_user",
          outcomeUncertain: "stop_no_retry",
        },
      },
    });
    expect(created.decisionPolicy?.digest).toMatch(/^[a-f0-9]{64}$/u);

    const updated = expectApplied(
      await service.update({
        ...autosavePolicy,
        expectedRevision: created.revision,
        id: created.id,
        maxApplicationsPerRun: 2,
      }),
    );
    expect(updated.decisionPolicy?.revision).toBe(2);

    service.saveAnswers({
      work_authorization: "Authorization changed after approval",
    });
    await expect(
      service.update({
        ...autosavePolicy,
        expectedRevision: updated.revision,
        id: updated.id,
      }),
    ).rejects.toMatchObject({ code: "approved_answers_required" });
  });

  it("lets a person choose to send applications, and records exactly what they approved", async () => {
    const repository = createInMemoryJobFinderRepository(
      createEmptyJobFinderRepositoryState(),
    );
    const service = makeService({
      repository,
      now: () => NOW,
      idFactory: () => "sending",
    });

    service.saveAnswers({
      visa_sponsorship: "No sponsorship required",
      work_authorization: "Authorized to work in the EU",
    });
    const readiness = await service.getReadiness();
    const approval = await service.approveCurrentAnswers({
      confirmedCurrentAnswers: true,
      expectedProfileRevision: readiness.currentAnswers.sourceProfileRevision,
    });
    expect(approval.status).toBe("created");

    const created = expectApplied(
      await service.create(
        createPolicy({
          mode: "confirm_before_submit",
          expiresAt: LATER,
          scope: { campaignId: null, jobIds: ["job_1"] },
          preApprovedAttestationKinds: ["truthfulness_certification"],
          salaryDisclosure: "answer_from_profile",
        }),
      ),
    );

    expect(created.mode).toBe("confirm_before_submit");
    // Only the exact declaration they ticked, and their pay choice, are in the
    // policy. Everything else still stops for them.
    expect(created.decisionPolicy?.answerPolicy).toMatchObject({
      preApprovedAttestationKinds: ["truthfulness_certification"],
      salaryDisclosure: "answer_from_profile",
      unknownRequiredQuestion: "pause_for_user",
      unknownEligibility: "pause_for_user",
      unknownLegalRequirement: "pause_for_user",
    });
    expect(created.decisionPolicy?.stopConditions).toMatchObject({
      captcha: "pause_for_user",
      accountCreation: "pause_for_user",
      loginRequired: "pause_for_user",
      outcomeUncertain: "stop_no_retry",
    });
    // Creating an employer account is never part of it.
    expect(created.accountCreationAuthorized).toBe(false);
    expect(created.decisionPolicy?.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps repository CAS results typed at the service boundary", async () => {
    const repository = createInMemoryJobFinderRepository(
      createEmptyJobFinderRepositoryState(),
    );
    const service = makeService({
      repository,
      now: () => NOW,
      idFactory: () => "test",
    });
    const created = expectApplied(await service.create(createPolicy()));
    const stale = await service.revoke({
      id: created.id,
      expectedRevision: 99,
    });
    expect(stale).toEqual({ status: "stale", current: created });
  });

  it("derives a redacted readiness summary and approves only the main-derived snapshot", async () => {
    const repository = createInMemoryJobFinderRepository(
      createEmptyJobFinderRepositoryState(),
    );
    let approvedSnapshot: ApprovedApplicationAnswerSnapshot | null = null;
    Object.assign(repository, {
      getLatestApplicationAnswerSnapshot: () =>
        Promise.resolve(approvedSnapshot),
      commitApplicationAnswerSnapshot: ({
        snapshot,
      }: {
        expectedLatestRevision: number | null;
        snapshot: ApprovedApplicationAnswerSnapshot;
      }) => {
        approvedSnapshot = snapshot;
        return Promise.resolve({ status: "created" as const, snapshot });
      },
    });

    const service = makeService({
      repository,
      now: () => NOW,
      idFactory: () => "answer",
    });

    service.saveAnswers({ work_authorization: "Authorized to work in the EU" });
    const before = await service.getReadiness();
    expect(before.answerApprovalStatus).toBe("not_approved");
    expect(before.currentAnswers.entryCount).toBe(1);
    expect(before.currentAnswers.kinds).toEqual(["work_authorization"]);
    expect(before.blockers).toContainEqual({
      code: "no_approved_answer_snapshot",
      remediation: "settings",
    });

    const approved = await service.approveCurrentAnswers({
      expectedProfileRevision: before.currentAnswers.sourceProfileRevision,
      confirmedCurrentAnswers: true,
    });
    expect(approved.status).toBe("created");
    expect(approved.readiness.answerApprovalStatus).toBe("current");
    expect(JSON.stringify(approved.readiness)).not.toContain(
      "Authorized to work",
    );
    const changedProfile = await repository.getProfile();
    await repository.saveProfile({
      ...changedProfile,
      summary: "Unrelated profile presentation change",
    });
    await expect(service.getReadiness()).resolves.toMatchObject({
      answerApprovalStatus: "current",
    });
  });

  it("reports an empty answer bank without throwing, while optional kinds stay optional", async () => {
    const repository = createInMemoryJobFinderRepository(
      createEmptyJobFinderRepositoryState(),
    );
    Object.assign(repository, {
      getLatestApplicationAnswerSnapshot: () => Promise.resolve(null),
    });
    const service = makeService({
      repository,
      now: () => NOW,
    });
    const empty = await service.getReadiness();
    expect(empty.answerApprovalStatus).toBe("missing_answers");
    // An empty bank still hashes: approving "nothing on file" is what lets
    // sending start on a fresh profile (ADR 0027).
    expect(empty.currentAnswers.digest).not.toBeNull();
    expect(empty.currentAnswers.entryCount).toBe(0);
    expect(empty.blockers).toContainEqual({
      code: "no_reusable_answers",
      remediation: "profile",
    });

    service.saveAnswers({
      work_authorization: "Authorized to work in the EU",
      visa_sponsorship: "No sponsorship required",
    });
    const optional = await service.getReadiness();
    expect(optional.currentAnswers.kinds).toEqual([
      "work_authorization",
      "visa_sponsorship",
    ]);
    expect(optional.currentAnswers.missingRequiredKinds).toEqual([]);
    expect(optional.blockers).toEqual([
      { code: "no_approved_answer_snapshot", remediation: "settings" },
      { code: "elevated_execution_unavailable", remediation: "unavailable" },
    ]);
  });

  it("main derives external evidence and CAS revision for operator verification", async () => {
    const repository = createInMemoryJobFinderRepository(
      createEmptyJobFinderRepositoryState(),
    );
    const uncertainOutcome = SubmissionOutcomeRecordSchema.parse({
      id: "outcome_uncertain",
      preflightId: "preflight_1",
      idempotencyKey: "submit_once_1",
      authorityEnvelopeId: "authority_1",
      authorityRevision: 1,
      runId: "run_1",
      jobId: "job_1",
      resultId: "result_1",
      applicationRecordId: "application_1",
      outcome: "outcome_uncertain",
      attemptedAt: NOW,
      verifiedAt: null,
      evidence: [],
      retry: { eligible: false, blockReason: "outcome_uncertain" },
    });
    const idempotency = SubmissionIdempotencyRecordSchema.parse({
      id: "idempotency_1",
      idempotencyKey: uncertainOutcome.idempotencyKey,
      preflightId: uncertainOutcome.preflightId,
      authorityEnvelopeId: uncertainOutcome.authorityEnvelopeId,
      authorityRevision: uncertainOutcome.authorityRevision,
      runId: uncertainOutcome.runId,
      jobId: uncertainOutcome.jobId,
      resultId: uncertainOutcome.resultId,
      applicationRecordId: uncertainOutcome.applicationRecordId,
      status: "outcome_uncertain",
      revision: 4,
      createdAt: NOW,
      updatedAt: NOW,
      armedAt: NOW,
      outcomeId: uncertainOutcome.id,
      outcome: "outcome_uncertain",
      revokedAt: null,
    });
    const applicationSends = {
      read: vi.fn<
        (applicationRecordId: string) => {
          receipt: typeof uncertainOutcome;
          pageUrl: string;
        }
      >(() => ({
        receipt: uncertainOutcome,
        pageUrl: "https://jobs.example.com/apply?step=2",
      })),
      canResolve: vi.fn(() => true),
      resolve: vi.fn(),
    };
    vi.spyOn(repository, "getSubmissionOutcomeRecord").mockResolvedValue(
      uncertainOutcome,
    );
    vi.spyOn(repository, "getSubmissionIdempotencyRecord").mockResolvedValue(
      idempotency,
    );
    const resolve = vi
      .spyOn(repository, "resolveSubmissionOutcome")
      .mockImplementation((input) =>
        Promise.resolve({
          status: "recorded",
          previousOutcome: uncertainOutcome,
          outcome: input.outcome,
          idempotency: {
            ...idempotency,
            status: "resolved",
            revision: idempotency.revision + 1,
            outcomeId: input.outcome.id,
            outcome: input.outcome.outcome,
            updatedAt: LATER,
          },
        }),
      );
    const ids = ["resolution", "evidence"];
    const releaseApplicationPage = vi.fn();
    const service = makeService({
      repository,
      now: () => LATER,
      idFactory: () => ids.shift() ?? "unexpected",
      releaseApplicationPage,
      applicationSends,
    });

    const resolution = await service.resolveSubmissionOutcome({
      uncertainOutcomeId: uncertainOutcome.id,
      resolution: "submitted",
      confirmedOnEmployerSite: true,
    });

    expect(resolution.status).toBe("recorded");
    expect(releaseApplicationPage).toHaveBeenCalledExactlyOnceWith(
      uncertainOutcome.resultId,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    const [resolvedInput] = resolve.mock.calls[0]!;
    expect(resolvedInput.expectedOutcomeId).toBe(uncertainOutcome.id);
    expect(resolvedInput.expectedIdempotencyRevision).toBe(4);
    expect(resolvedInput.outcome).toMatchObject({
      id: "outcome_resolution",
      outcome: "submitted",
      verifiedAt: LATER,
      evidence: [
        {
          id: "evidence_evidence",
          kind: "operator_confirmation",
          destination: {
            origin: "https://jobs.example.com",
            safePath: "/apply",
          },
          artifactRefId: null,
          observedAt: LATER,
          summary:
            "User verified on the employer site that this application was submitted.",
        },
      ],
      retry: { eligible: false, blockReason: "submission_confirmed" },
    });
    expect(applicationSends.read).toHaveBeenCalledWith("application_1");
    expect(applicationSends.resolve).toHaveBeenCalledWith(
      "application_1",
      expect.objectContaining({ outcome: "submitted" }),
    );

    // A row whose saved receipt is not this exact uncertain send stays blocked.
    applicationSends.read.mockReturnValue({
      receipt: { ...uncertainOutcome, id: "outcome_other" },
      pageUrl: "https://jobs.example.com/apply",
    });
    resolve.mockClear();
    const blocked = await service.resolveSubmissionOutcome({
      uncertainOutcomeId: uncertainOutcome.id,
      resolution: "submitted",
      confirmedOnEmployerSite: true,
    });
    expect(blocked.status).toBe("blocked");
    expect(resolve).not.toHaveBeenCalled();

    // An outcome the store row would refuse (another attempt) is refused
    // before the authority record commits, so nothing is left half-done.
    applicationSends.read.mockReturnValue({
      receipt: uncertainOutcome,
      pageUrl: "https://jobs.example.com/apply",
    });
    applicationSends.canResolve.mockReturnValue(false);
    applicationSends.resolve.mockClear();
    releaseApplicationPage.mockClear();
    const mismatched = await service.resolveSubmissionOutcome({
      uncertainOutcomeId: uncertainOutcome.id,
      resolution: "submitted",
      confirmedOnEmployerSite: true,
    });
    expect(mismatched.status).toBe("blocked");
    expect(resolve).not.toHaveBeenCalled();
    expect(applicationSends.resolve).not.toHaveBeenCalled();
    expect(releaseApplicationPage).not.toHaveBeenCalled();
  });
});
