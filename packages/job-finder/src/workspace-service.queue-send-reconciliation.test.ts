import { createHash } from "node:crypto";

import {
  ApplicationAuthorityDecisionPolicySchema,
  ApplicationAuthorityEnvelopeSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  deriveApprovedApplicationAnswerSnapshotContent,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  serializeApprovedApplicationAnswerSnapshotForDigest,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createSeed } from "./workspace-service.test-fixtures";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";

type SendStepInput = {
  ctx: {
    repository: Pick<
      JobFinderRepository,
      "listApplyJobResults" | "upsertApplyJobResult"
    >;
  };
  lineage: {
    runId: string;
    resultId: string;
  };
};

const { sendPreparedApplicationIfAllowed } = vi.hoisted(() => ({
  sendPreparedApplicationIfAllowed: vi.fn(async (input: SendStepInput) => {
    const current = (
      await input.ctx.repository.listApplyJobResults({
        runId: input.lineage.runId,
      })
    ).find((result) => result.id === input.lineage.resultId);
    if (!current) throw new Error("Expected the prepared result to exist.");
    if (!current.privacyReceipt)
      throw new Error("Expected the prepared privacy receipt to exist.");
    const submittedAt = "2026-09-22T16:53:04.561Z";
    await input.ctx.repository.upsertApplyJobResult({
      ...current,
      state: "submitted",
      summary: "Application submitted",
      detail: "The employer site confirmed receipt.",
      updatedAt: submittedAt,
      completedAt: submittedAt,
      automaticSendPending: false,
      // Sending updates the receipt as well as the workflow state. An unsent
      // preparation receipt must never count as a confirmed submission.
      privacyReceipt: {
        ...current.privacyReceipt,
        generatedAt: submittedAt,
        finalSubmitOccurred: true,
        submissionOutcome: {
          id: "outcome_queue_send",
          preflightId: "preflight_queue_send",
          idempotencyKey: "idempotency_queue_send",
          authorityEnvelopeId: "authority_queue_send",
          authorityRevision: 1,
          ...current.privacyReceipt.lineage,
          applicationRecordId: current.applicationRecordId!,
          outcome: "submitted",
          attemptedAt: submittedAt,
          verifiedAt: submittedAt,
          evidence: [
            {
              id: "evidence_queue_send",
              kind: "employer_site_state",
              observedAt: submittedAt,
              destination: current.privacyReceipt.destination,
              artifactRefId: null,
              summary: "The employer site confirmed receipt.",
            },
          ],
          retry: { eligible: false, blockReason: "submission_confirmed" },
        },
      },
    });
    return {
      sent: true,
      confirmedSubmitted: true,
      pageClosed: false,
      summary: "Application submitted",
      detail: "The employer site confirmed receipt.",
      nextActionLabel: "View application",
    };
  }),
}));

vi.mock("./internal/apply-submission-run-step", () => ({
  sendPreparedApplicationIfAllowed,
}));

async function installAutonomousAuthority(input: {
  repository: JobFinderRepository;
  resumeSha256: string;
}) {
  const createdAt = "2026-09-22T16:00:00.000Z";
  const profileState = await input.repository.getProfileWithRevision();
  const derived = deriveApprovedApplicationAnswerSnapshotContent(
    profileState.profile,
  );
  if (!derived.content) throw new Error("Expected reusable profile answers.");
  const snapshotContent = derived.content;
  const snapshot = ApprovedApplicationAnswerSnapshotSchema.parse({
    ...snapshotContent,
    id: "answer_snapshot_queue_send",
    revision: 1,
    digest: createHash("sha256")
      .update(
        serializeApprovedApplicationAnswerSnapshotForDigest(snapshotContent),
        "utf8",
      )
      .digest("hex"),
    sourceProfileRevision: profileState.revision,
    approvedAt: createdAt,
  });
  await input.repository.commitApplicationAnswerSnapshot({
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
  await input.repository.commitApplicationAuthorityEnvelope({
    expectedRevision: null,
    envelope: ApplicationAuthorityEnvelopeSchema.parse({
      id: "authority_queue_send",
      mode: "autonomous_submit",
      status: "active",
      revision: 1,
      scope: { campaignId: null, jobIds: ["job_ready"] },
      maxApplicationsPerRun: 1,
      maxApplicationsPerLocalDay: 50,
      intermediateMutationsAuthorized: true,
      accountCreationAuthorized: false,
      allowedResumeSha256: [input.resumeSha256],
      allowedOrigins: ["https://www.linkedin.com"],
      createdAt,
      expiresAt: "2026-10-22T16:00:00.000Z",
      revokedAt: null,
      decisionPolicy,
    }),
  });
}

describe("autonomous queue send reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T16:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("records the post-send result in run counters and skips stale review safeguards", async () => {
    const resumeSha256 = "b".repeat(64);
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      applicationAutomationMode: "autonomous_submit",
    };
    seed.resumeDrafts = [
      {
        id: "resume_draft_job_ready",
        jobId: "job_ready",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-09-22T15:00:00.000Z",
        approvedExportId: "resume_export_job_ready",
        staleReason: null,
        createdAt: "2026-09-22T15:00:00.000Z",
        updatedAt: "2026-09-22T15:00:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_job_ready",
        draftId: "resume_draft_job_ready",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/job-ready-resume.pdf",
        sha256: resumeSha256,
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-09-22T15:00:00.000Z",
        isApproved: true,
      },
    ];
    const harness = createWorkspaceServiceHarness({ seed });
    await installAutonomousAuthority({
      repository: harness.repository,
      resumeSha256,
    });

    const staged = await harness.workspaceService.startAutoApplyQueueRun([
      "job_ready",
    ]);
    const runId = staged.applyRuns.at(-1)?.id;
    if (!runId) throw new Error("Expected a staged queue run.");
    const finished = await harness.workspaceService.approveApplyRun(runId);
    const run = finished.applyRuns.find((candidate) => candidate.id === runId);

    expect(sendPreparedApplicationIfAllowed).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({
      state: "completed",
      pendingJobs: 0,
      submittedJobs: 1,
      failedJobs: 0,
      blockedJobs: 0,
      summary:
        "Automatic apply queue processed 1 of 1 jobs using the chosen application mode.",
    });
    expect(
      finished.applyJobResults.find((result) => result.runId === runId),
    ).toMatchObject({
      state: "submitted",
      automaticSendPending: false,
      privacyReceipt: {
        finalSubmitOccurred: true,
        submissionOutcome: { outcome: "submitted" },
      },
    });
    expect(
      (await harness.repository.getIntelligenceState()).safeguards
        .preparedBatchSampleReviews,
    ).toEqual([]);
  });
});
