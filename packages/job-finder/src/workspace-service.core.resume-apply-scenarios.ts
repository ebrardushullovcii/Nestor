import { createHash } from "node:crypto";

import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  ApplicationAuthorityDecisionPolicySchema,
  ApplicationAuthorityEnvelopeSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  deriveApprovedApplicationAnswerSnapshotContent,
  JobPostingSchema,
  ResumeDraftSchema,
  ResumeValidationResultSchema,
  type ResumeTemplateId,
  ResumeTemplateDefinitionSchema,
  SavedJobSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
  serializeApprovedApplicationAnswerSnapshotForDigest,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import type { JobFinderDocumentManager } from "./internal/workspace-service-contracts";
import { isApprovedTailoredResumeReadyForApply } from "./internal/matching-review-queue";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createAiClient } from "./workspace-service.test-runtimes";
import {
  createBrowserRuntime,
  createDocumentManager,
  createWorkspaceServiceHarness,
  createSeed,
} from "./workspace-service.test-support";

function buildRecordQuery(input: {
  jobId: string;
  runId?: string | undefined;
  resultId?: string | undefined;
}) {
  return {
    jobId: input.jobId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.resultId ? { resultId: input.resultId } : {}),
  };
}

async function installExactPrepareOnlyAutosaveAuthority(input: {
  jobId: string;
  origin: string;
  repository: JobFinderRepository;
  resumeSha256: string;
}) {
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1_000).toISOString();
  const profileState = await input.repository.getProfileWithRevision();
  const derived = deriveApprovedApplicationAnswerSnapshotContent(
    profileState.profile,
  );
  if (derived.content === null) {
    throw new Error("Expected reusable answer fixture content.");
  }
  const snapshotDigest = createHash("sha256")
    .update(
      serializeApprovedApplicationAnswerSnapshotForDigest(derived.content),
      "utf8",
    )
    .digest("hex");
  const snapshot = ApprovedApplicationAnswerSnapshotSchema.parse({
    ...derived.content,
    id: "answer_snapshot_autosave",
    revision: 1,
    digest: snapshotDigest,
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
  const envelope = ApplicationAuthorityEnvelopeSchema.parse({
    id: "authority_autosave",
    mode: "prepare_only",
    status: "active",
    revision: 1,
    scope: { campaignId: null, jobIds: [input.jobId] },
    maxApplicationsPerRun: 1,
    maxApplicationsPerLocalDay: 1,
    intermediateMutationsAuthorized: true,
    accountCreationAuthorized: false,
    allowedResumeSha256: [input.resumeSha256],
    allowedOrigins: [input.origin],
    createdAt,
    expiresAt,
    revokedAt: null,
    decisionPolicy,
  });
  await input.repository.commitApplicationAuthorityEnvelope({
    envelope,
    expectedRevision: null,
  });
  return envelope;
}

describe("createJobFinderWorkspaceService", () => {
  test("keeps current job choices when the default changes and updates only the selected job", async () => {
    const { workspaceService, repository } = createWorkspaceServiceHarness();
    const initialSnapshot = await workspaceService.getWorkspaceSnapshot();

    expect(
      initialSnapshot.reviewQueue.every(
        (item) => item.resumeApplicationMode === "tailored_per_job",
      ),
    ).toBe(true);

    const savedSnapshot = await workspaceService.saveSettings({
      ...initialSnapshot.settings,
      resumeApplicationMode: "original_resume",
    });

    expect(savedSnapshot.settings.resumeApplicationMode).toBe(
      "original_resume",
    );
    expect((await repository.getSettings()).resumeApplicationMode).toBe(
      "original_resume",
    );
    expect(savedSnapshot.reviewQueue).toHaveLength(
      initialSnapshot.reviewQueue.length,
    );
    const readyJob = savedSnapshot.reviewQueue.find(
      (item) => item.jobId === "job_ready",
    );
    const generatingJob = savedSnapshot.reviewQueue.find(
      (item) => item.jobId === "job_generating",
    );

    expect(readyJob?.resumeApplicationMode).toBe("tailored_per_job");
    expect(generatingJob?.resumeApplicationMode).toBe("tailored_per_job");

    const selectedSnapshot = await workspaceService.setJobResumeApplicationMode(
      "job_ready",
      "original_resume",
    );
    const selectedReadyJob = selectedSnapshot.reviewQueue.find(
      (item) => item.jobId === "job_ready",
    );
    const untouchedGeneratingJob = selectedSnapshot.reviewQueue.find(
      (item) => item.jobId === "job_generating",
    );

    expect(selectedReadyJob).toMatchObject({
      resumeApplicationMode: "original_resume",
      assetStatus: "ready",
      resumeReview: {
        status: "original_resume",
        fileName: "alex-vanguard.pdf",
      },
    });
    expect(untouchedGeneratingJob?.resumeApplicationMode).toBe(
      "tailored_per_job",
    );
  });

  test("captures the saved CV default when a job is newly shortlisted", async () => {
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? SavedJobSchema.parse({
            ...job,
            status: "discovered",
            resumeApplicationMode: null,
          })
        : job,
    );
    const { workspaceService } = createWorkspaceServiceHarness({ seed });

    const snapshot = await workspaceService.queueJobForReview("job_ready");

    expect(
      snapshot.reviewQueue.find((item) => item.jobId === "job_ready"),
    ).toMatchObject({
      resumeApplicationMode: "original_resume",
      resumeReview: { status: "original_resume" },
    });
  });

  test("uses the original imported CV unchanged without generating a tailored resume", async () => {
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    const catalogRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      catalogRuntime.executeApplicationFlow.bind(catalogRuntime),
    );
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...catalogRuntime, executeApplicationFlow },
    });

    const beforeApply = await workspaceService.getWorkspaceSnapshot();
    const queueItem = beforeApply.reviewQueue.find(
      (item) => item.jobId === "job_ready",
    );

    expect(queueItem).toMatchObject({
      resumeApplicationMode: "original_resume",
      assetStatus: "ready",
      resumeAssetId: "resume_1",
      resumeReview: {
        status: "original_resume",
        sourceDocumentId: "resume_1",
        fileName: "alex-vanguard.pdf",
        filePath: "/tmp/alex-vanguard.pdf",
      },
    });
    const existingTailoredAssets = beforeApply.tailoredAssets;

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");
    const executionInput = executeApplicationFlow.mock.calls[0]?.[1];

    expect(executionInput?.resumeArtifact).toMatchObject({
      jobId: "job_ready",
      source: "original_upload",
      sourceDocumentId: "resume_1",
      exportArtifactId: null,
      fileName: "alex-vanguard.pdf",
      filePath: "/tmp/alex-vanguard.pdf",
    });
    expect(executionInput).toMatchObject({
      mode: "prepare_only",
      intermediateMutationsAuthorized: true,
      accountCreationAuthorized: false,
      submitAuthorized: false,
    });
    expect(snapshot.resumeDrafts).toHaveLength(0);
    expect(snapshot.resumeExportArtifacts).toHaveLength(0);
    expect(snapshot.tailoredAssets).toEqual(existingTailoredAssets);
    expect(snapshot.applyRuns[0]?.state).toBe("paused_for_user_review");
  });

  test("activates bounded autosave only for an exact authority and rechecks revocation before each field", async () => {
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    const catalogRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      catalogRuntime.executeApplicationFlow.bind(catalogRuntime),
    );
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...catalogRuntime, executeApplicationFlow },
    });
    const job = seed.savedJobs.find((entry) => entry.id === "job_ready")!;
    const origin = new URL(job.applicationUrl!).origin;
    const envelope = await installExactPrepareOnlyAutosaveAuthority({
      jobId: job.id,
      origin,
      repository,
      resumeSha256: seed.profile.baseResume.sha256!,
    });

    await workspaceService.startApplyCopilotRun(job.id);
    const executionInput = executeApplicationFlow.mock.calls[0]?.[1];
    expect(executionInput).toMatchObject({
      intermediateMutationsAuthorized: true,
      intermediateMutationAllowedOrigins: [origin],
      accountCreationAuthorized: false,
      submitAuthorized: false,
    });
    await expect(
      executionInput?.recheckIntermediateMutationAuthority?.(origin),
    ).resolves.toBe(true);

    await repository.revokeApplicationAuthorityEnvelope({
      id: envelope.id,
      expectedRevision: envelope.revision,
      revokedAt: new Date().toISOString(),
    });
    await expect(
      executionInput?.recheckIntermediateMutationAuthority?.(origin),
    ).resolves.toBe(false);
  });

  test("blocks original-CV mode when the imported file is missing on disk", async () => {
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      exportFileVerifier: { exists: () => Promise.resolve(false) },
    });

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");

    expect(snapshot.applyJobResults[0]).toMatchObject({
      jobId: "job_ready",
      state: "blocked",
      blockerReason: "resume_missing",
    });
    expect(snapshot.applicationAttempts).toHaveLength(0);
  });

  test("generates a tailored resume and pauses a supported application at final review", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);
    const snapshot = await workspaceService.approveApply("job_ready");
    const tailoredAsset = snapshot.tailoredAssets.find(
      (asset) => asset.jobId === "job_ready",
    );

    expect(snapshot.discoveryJobs.some((job) => job.id === "job_ready")).toBe(
      true,
    );
    expect(
      snapshot.applicationRecords.some(
        (record) => record.jobId === "job_ready",
      ),
    ).toBe(true);
    expect(snapshot.applicationAttempts[0]?.state).toBe("paused");
    expect(snapshot.applicationAttempts[0]?.outcome).toBeNull();
    expect(snapshot.applicationAttempts[0]?.checkpoints.at(-1)?.state).toBe(
      "paused",
    );
    expect(snapshot.applicationAttempts[0]?.questions[0]?.kind).toBe("resume");
    expect(
      snapshot.applicationAttempts[0]?.consentDecisions.length,
    ).toBeGreaterThan(0);
    expect(snapshot.applicationAttempts[0]?.replay.lastUrl).toContain("/apply");
    expect(snapshot.applicationRecords[0]?.status).toBe("approved");
    expect(snapshot.applicationRecords[0]?.lastAttemptState).toBe("paused");
    expect(snapshot.applicationRecords[0]?.questionSummary.total).toBe(1);
    expect(snapshot.applicationRecords[0]?.replaySummary.lastUrl).toContain(
      "/apply",
    );
    expect(tailoredAsset?.storagePath).toBe("/tmp/generated-classic_ats.pdf");
    expect(tailoredAsset?.notes).toEqual(
      expect.arrayContaining([
        "Generated PDF resume artifact generated-classic_ats.pdf.",
        "Saved HTML debug render generated-classic_ats.html.",
        "Generated PDF page count: 1.",
      ]),
    );
  });

  test("creates a non-submitting apply copilot foundation run when resume approval is missing", async () => {
    const { workspaceService, repository } = createWorkspaceServiceHarness();

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");
    const runs = await repository.listApplyRuns();
    const results = await repository.listApplyJobResults();
    const questions = await repository.listApplicationQuestionRecords(
      buildRecordQuery({ jobId: "job_ready", runId: runs[0]?.id }),
    );
    const consentRequests = await repository.listApplicationConsentRequests(
      buildRecordQuery({ jobId: "job_ready", runId: runs[0]?.id }),
    );

    expect(snapshot.applyRuns).toHaveLength(1);
    expect(snapshot.selectedApplyRunId).toBe(snapshot.applyRuns[0]?.id ?? null);
    expect(snapshot.applyRuns[0]).toMatchObject({
      mode: "copilot",
      state: "paused_for_consent",
      currentJobId: "job_ready",
      blockedJobs: 1,
    });
    expect(snapshot.applyJobResults).toHaveLength(1);
    expect(snapshot.applyJobResults[0]).toMatchObject({
      jobId: "job_ready",
      state: "blocked",
      blockerReason: "resume_missing",
    });
    expect(runs[0]?.id).toBe(snapshot.applyRuns[0]?.id);
    expect(results[0]?.id).toBe(snapshot.applyJobResults[0]?.id);
    expect(questions[0]).toMatchObject({
      jobId: "job_ready",
      kind: "resume",
      status: "skipped",
    });
    expect(consentRequests[0]).toMatchObject({
      jobId: "job_ready",
      kind: "resume_use",
      status: "pending",
    });
    expect(snapshot.applicationAttempts).toHaveLength(0);
    expect(snapshot.applicationRecords).toHaveLength(1);
    expect(snapshot.applicationRecords[0]).toMatchObject({
      jobId: "job_ready",
      lastActionLabel: "Apply copilot blocked before launch.",
      nextActionLabel:
        "Export and approve a tailored resume before retrying apply copilot.",
      latestBlocker: {
        code: "missing_resume",
      },
      consentSummary: {
        status: "none",
        pendingCount: 0,
      },
    });
  });

  test("clears a stale missing-resume blocker after resume approval", async () => {
    const baseRuntime = createBrowserRuntime();
    if (!baseRuntime.executeApplicationFlow) {
      throw new Error(
        "Expected catalog browser runtime to support apply flows.",
      );
    }
    const executeApplicationFlow = vi.fn(
      baseRuntime.executeApplicationFlow.bind(baseRuntime),
    );
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    await workspaceService.startApplyCopilotRun("job_ready");
    expect(
      (await workspaceService.getWorkspaceSnapshot()).applicationRecords[0]
        ?.latestBlocker?.code,
    ).toBe("missing_resume");

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(approvedExport).toBeTruthy();

    const approvedSnapshot = await workspaceService.approveResume(
      "job_ready",
      approvedExport!.id,
    );
    const approvedDraft = approvedSnapshot.resumeDrafts.find(
      (entry) => entry.jobId === "job_ready",
    );
    const approvedAsset = approvedSnapshot.tailoredAssets.find(
      (entry) => entry.jobId === "job_ready",
    );
    const approvedExportsAfter = approvedSnapshot.resumeExportArtifacts.filter(
      (entry) => entry.jobId === "job_ready" && entry.isApproved,
    );
    expect(approvedDraft?.status).toBe("approved");
    expect(approvedExportsAfter.length).toBeGreaterThan(0);
    expect(approvedAsset?.storagePath).toBeTruthy();
    expect(approvedSnapshot.applicationRecords[0]?.latestBlocker).toBeNull();

    const [retryDraft, retryExports, retryAssets] = await Promise.all([
      repository.getResumeDraftByJobId("job_ready"),
      repository.listResumeExportArtifacts({ jobId: "job_ready" }),
      repository.listTailoredAssets(),
    ]);
    const retryAsset =
      retryAssets.find((entry) => entry.jobId === "job_ready") ?? null;
    expect(
      isApprovedTailoredResumeReadyForApply({
        draft: retryDraft,
        exports: retryExports,
        asset: retryAsset,
      }).ready,
    ).toBe(true);
    expect(approvedSnapshot.applicationRecords[0]?.nextActionLabel).toBe(
      "Retry preparation when you are ready.",
    );

    const retrySnapshot =
      await workspaceService.startApplyCopilotRun("job_ready");
    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);
    const latestJobResult = retrySnapshot.applyJobResults.find(
      (result) => result.jobId === "job_ready",
    );
    expect(latestJobResult?.blockerReason).not.toBe("resume_missing");
    expect(retrySnapshot.applicationRecords[0]?.latestBlocker?.code).not.toBe(
      "missing_resume",
    );
  });

  test("starts apply copilot after resume approval without resume_missing blocker", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      exportFileVerifier: { exists: () => Promise.resolve(true) },
    });

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(approvedExport).toBeTruthy();
    await workspaceService.approveResume("job_ready", approvedExport!.id);

    const retrySnapshot =
      await workspaceService.startApplyCopilotRun("job_ready");
    const latestJobResult = retrySnapshot.applyJobResults.find(
      (result) => result.jobId === "job_ready",
    );
    expect(latestJobResult?.blockerReason).not.toBe("resume_missing");
  });

  test("starts a non-submitting apply copilot run when the job has an approved resume", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");
    const applyRun = snapshot.applyRuns[0];
    const applyResult = snapshot.applyJobResults[0];
    const applicationAttempt = snapshot.applicationAttempts[0];
    const applicationRecord = snapshot.applicationRecords[0];

    expect(applyRun).toMatchObject({
      mode: "copilot",
      state: "paused_for_user_review",
      currentJobId: "job_ready",
    });
    expect(applyResult).toMatchObject({
      jobId: "job_ready",
      state: "awaiting_review",
      latestQuestionCount: 1,
      latestAnswerCount: 1,
    });
    expect(applicationAttempt).toMatchObject({
      state: "paused",
      outcome: null,
      nextActionLabel: expect.stringMatching(
        /submit manually when ready/i,
      ) as string,
    });
    expect(applicationAttempt?.visualEvidence).toEqual([]);
    expect(applicationAttempt?.visualObservationSets).toEqual([]);
    expect(applicationAttempt?.visualCheckpoints).toEqual([]);
    expect(applyResult?.visualObservationSets).toEqual([]);
    expect(applyResult?.visualCheckpoints).toEqual([]);
    expect(
      applicationAttempt?.questions.every(
        (question) => !("visualContext" in question),
      ),
    ).toBe(true);
    expect(
      applicationAttempt?.checkpoints.every(
        (checkpoint) => checkpoint.visualEvidence.length === 0,
      ),
    ).toBe(true);
    expect(applicationRecord).toMatchObject({
      lastAttemptState: "paused",
      questionSummary: expect.objectContaining({ total: 1, answered: 1 }) as {
        total: number;
        answered: number;
      },
    });
  });

  test("starts apply copilot when draft export binding is stale but the ready asset matches the latest approved export", async () => {
    const seed = createSeed();
    const jobId = "job_ready";
    const readyPath = "/tmp/generated-classic_ats.pdf";
    const stalePath = "/tmp/stale-export.pdf";
    seed.resumeDrafts = [
      {
        id: `resume_draft_${jobId}`,
        jobId,
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-03-20T10:05:00.000Z",
        approvedExportId: "resume_export_stale",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_stale",
        draftId: `resume_draft_${jobId}`,
        jobId,
        format: "pdf",
        filePath: stalePath,
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:03:00.000Z",
        isApproved: false,
      },
      {
        id: "resume_export_current",
        draftId: `resume_draft_${jobId}`,
        jobId,
        format: "pdf",
        filePath: readyPath,
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:05:00.000Z",
        isApproved: true,
      },
    ];
    seed.tailoredAssets = seed.tailoredAssets.map((asset) =>
      asset.jobId === jobId
        ? {
            ...asset,
            status: "ready",
            storagePath: readyPath,
          }
        : asset,
    );

    const { workspaceService } = createWorkspaceServiceHarness({ seed });
    const snapshot = await workspaceService.startApplyCopilotRun(jobId);

    expect(snapshot.applyJobResults[0]).toMatchObject({
      jobId,
      state: "awaiting_review",
    });
    expect(snapshot.applyJobResults[0]?.blockerReason).not.toBe(
      "resume_missing",
    );
  });

  test("records explicit Live Assistant follow-up actions on application records", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();

    const initialSnapshot =
      await workspaceService.startApplyCopilotRun("job_ready");
    const applicationRecord = initialSnapshot.applicationRecords.find(
      (record) => record.jobId === "job_ready",
    );

    expect(applicationRecord).toBeTruthy();

    const interviewedSnapshot =
      await workspaceService.recordLiveAssistantApplicationAction({
        applicationRecordId: applicationRecord!.id,
        sessionId: "interview_session_1",
        action: "mark_interviewed",
        note: "Send a follow-up about the platform reliability example.",
      });
    const interviewedRecord = interviewedSnapshot.applicationRecords.find(
      (record) => record.id === applicationRecord!.id,
    );
    const savedJobs = await repository.listSavedJobs();
    const interviewedJob = savedJobs.find((job) => job.id === "job_ready");

    expect(interviewedRecord).toMatchObject({
      status: "interview",
      lastActionLabel: "Interview completed",
      nextActionLabel: "Add a follow-up note or track the interview outcome.",
    });
    const interviewedEvent = interviewedRecord?.events.find(
      (event) => event.title === "Interview marked complete",
    );
    expect(interviewedEvent).toMatchObject({
      title: "Interview marked complete",
      emphasis: "positive",
    });
    expect(interviewedEvent?.detail).toContain("platform reliability example");
    expect(interviewedJob?.status).toBe("interview");

    const notedSnapshot =
      await workspaceService.recordLiveAssistantApplicationAction({
        applicationRecordId: applicationRecord!.id,
        sessionId: "interview_session_1",
        action: "add_follow_up_note",
        note: "Recruiter asked for availability next week.",
      });
    const notedRecord = notedSnapshot.applicationRecords.find(
      (record) => record.id === applicationRecord!.id,
    );

    expect(notedRecord?.status).toBe("interview");
    expect(
      notedRecord?.events.find(
        (event) => event.title === "Interview follow-up note added",
      ),
    ).toMatchObject({
      title: "Interview follow-up note added",
      detail:
        "Live Assistant session interview_session_1: Recruiter asked for availability next week.",
      emphasis: "neutral",
    });
  });

  test("captures apply visual checkpoints only when explicitly opted in", async () => {
    const baseRuntime = createBrowserRuntime();
    let visualCallbacksPassed = false;
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      async executeApplicationFlow(source, input) {
        visualCallbacksPassed =
          typeof input.captureVisualSnapshot === "function" &&
          typeof input.analyzeVisualSnapshot === "function";
        return baseRuntime.executeApplicationFlow(source, input);
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      browserRuntime,
    });

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);

    const snapshot = await workspaceService.startApplyCopilotRun("job_ready", {
      visualCheckpointsEnabled: true,
    });
    const applyRun = snapshot.applyRuns[0];
    const applyResult = snapshot.applyJobResults[0];
    const applicationAttempt = snapshot.applicationAttempts[0];
    const applicationRecord = snapshot.applicationRecords.find(
      (record) => record.jobId === "job_ready",
    );

    expect(applyRun?.visualCheckpointsEnabled).toBe(true);
    expect(applicationAttempt?.visualEvidence[0]?.summary).toMatch(
      /resume|upload|visual context/i,
    );
    expect(applicationAttempt?.visualObservationSets[0]?.purpose).toBe(
      "apply_checkpoint",
    );
    expect(applicationAttempt?.visualCheckpoints[0]?.purpose).toBe(
      "apply_checkpoint",
    );
    expect(applyResult?.visualObservationSets[0]?.purpose).toBe(
      "apply_checkpoint",
    );
    expect(applyResult?.visualCheckpoints[0]?.summary).toMatch(
      /resume|upload|visual context/i,
    );
    expect(applicationAttempt?.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resume",
          submittedAnswer: "generated-classic_ats.pdf",
        }),
      ]),
    );
    expect(JSON.stringify(applicationAttempt)).not.toContain("/tmp/");
    expect(JSON.stringify(applicationRecord)).not.toContain("/tmp/");
    expect(JSON.stringify(applicationRecord)).toContain(
      "generated-classic_ats.pdf",
    );
    expect(applicationAttempt?.checkpoints.at(-1)).toEqual(
      expect.objectContaining({
        label: "Prepared application for final review",
        state: "paused",
      }),
    );
    expect(visualCallbacksPassed).toBe(true);
  });

  test("captures apply copilot answer, artifact, checkpoint, and consent records for review-ready questions", async () => {
    const seed = createSeed();
    seed.savedJobs.push(
      SavedJobSchema.parse({
        source: "target_site",
        sourceJobId: "linkedin_pause_case",
        discoveryMethod: "catalog_seed",
        canonicalUrl: "https://www.linkedin.com/jobs/view/linkedin_pause_case",
        id: "job_pause_case",
        title: "Principal UX Engineer",
        company: "Void Industries",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:30:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T10:04:00.000Z",
        salaryText: "$185k - $210k",
        summary: "Lead UI platform work.",
        description:
          "Lead UI platform work. Additional work authorization details are required during apply.",
        keySkills: ["React", "Design Systems"],
        responsibilities: ["Lead UI platform architecture."],
        minimumQualifications: ["Deep React experience."],
        preferredQualifications: ["Accessibility leadership experience."],
        seniority: "Principal",
        employmentType: "Full-time",
        department: "Engineering",
        team: "UI Platform",
        employerWebsiteUrl: "https://void.example.com",
        employerDomain: "void.example.com",
        benefits: ["Remote-first collaboration"],
        status: "approved",
        matchAssessment: {
          score: 91,
          reasons: ["Strong UI platform overlap"],
          gaps: [],
        },
        provenance: [],
      }),
    );
    seed.tailoredAssets.push({
      id: "asset_pause_case",
      jobId: "job_pause_case",
      kind: "resume",
      status: "ready",
      label: "Tailored Resume",
      version: "v1",
      templateName: "Chronology Classic",
      compatibilityScore: 94,
      progressPercent: 100,
      updatedAt: "2026-03-20T10:04:00.000Z",
      storagePath: "/tmp/job-pause-case-resume.pdf",
      contentText: "Resume text",
      previewSections: [],
      generationMethod: "deterministic",
      notes: [],
      failureMessage: null,
      failedAt: null,
    });
    seed.resumeDrafts.push({
      id: "resume_draft_job_pause_case",
      jobId: "job_pause_case",
      status: "approved",
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "deterministic",
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      approvedAt: "2026-03-20T10:04:00.000Z",
      approvedExportId: "resume_export_pause_case",
      staleReason: null,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:04:00.000Z",
    });
    seed.resumeExportArtifacts.push({
      id: "resume_export_pause_case",
      draftId: "resume_draft_job_pause_case",
      jobId: "job_pause_case",
      format: "pdf",
      filePath: "/tmp/job-pause-case-resume.pdf",
      pageCount: 2,
      templateId: "classic_ats",
      exportedAt: "2026-03-20T10:04:00.000Z",
      isApproved: true,
    });

    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
    });

    const snapshot =
      await workspaceService.startApplyCopilotRun("job_pause_case");
    const runId = snapshot.applyRuns[0]?.id;
    const resultId = snapshot.applyJobResults[0]?.id;
    const recordQuery = buildRecordQuery({
      jobId: "job_pause_case",
      runId,
      resultId,
    });
    const questions =
      await repository.listApplicationQuestionRecords(recordQuery);
    const answers = await repository.listApplicationAnswerRecords(recordQuery);
    const artifacts = await repository.listApplicationArtifactRefs(recordQuery);
    const checkpoints =
      await repository.listApplicationReplayCheckpoints(recordQuery);
    const consentRequests =
      await repository.listApplicationConsentRequests(recordQuery);

    expect(snapshot.applyRuns[0]?.state).toBe("paused_for_user_review");
    expect(snapshot.applyJobResults[0]).toMatchObject({
      state: "awaiting_review",
      blockerReason: "required_human_input",
      latestQuestionCount: 2,
      // Only the selected answer was filled; the other two are suggestions.
      latestAnswerCount: 1,
    });
    expect(questions.map((question) => question.kind)).toEqual(
      expect.arrayContaining(["resume", "work_authorization"]),
    );
    expect(questions.every((question) => question.visualContext === null)).toBe(
      true,
    );
    expect(answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "filled",
          sourceKind: "resume",
        }),
      ]),
    );
    expect(artifacts.length).toBeGreaterThan(0);
    expect(
      artifacts.every((artifact) => artifact.visualEvidence === null),
    ).toBe(true);
    expect(
      checkpoints.some(
        (checkpoint) => checkpoint.jobState === "awaiting_review",
      ),
    ).toBe(true);
    expect(
      checkpoints.every((checkpoint) => checkpoint.visualEvidence.length === 0),
    ).toBe(true);
    expect(consentRequests).toEqual([]);
    expect(snapshot.applicationAttempts[0]?.state).toBe("paused");
    expect(snapshot.applicationAttempts[0]?.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "resume" }),
        expect.objectContaining({ kind: "work_authorization" }),
      ]),
    );
  });

  test("returns persisted apply run details for a completed copilot review run", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);
    const snapshot = await workspaceService.startApplyCopilotRun("job_ready", {
      visualCheckpointsEnabled: true,
    });
    const runId = snapshot.applyRuns[0]?.id;

    expect(runId).toBeTruthy();
    if (!runId) {
      return;
    }

    const details = await workspaceService.getApplyRunDetails(
      runId,
      "job_ready",
    );

    expect(details.run.id).toBe(runId);
    expect(details.run.mode).toBe("copilot");
    expect(details.result).toMatchObject({
      runId,
      jobId: "job_ready",
      state: "awaiting_review",
    });
    expect(details.questionRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "job_ready",
          kind: "resume",
        }),
      ]),
    );
    expect(details.answerRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "job_ready",
          status: "filled",
        }),
      ]),
    );
    expect(details.checkpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "job_ready",
          jobState: "awaiting_review",
        }),
      ]),
    );
    expect(details.result?.visualCheckpoints[0]?.purpose).toBe(
      "apply_checkpoint",
    );
    expect(
      details.checkpoints.some(
        (checkpoint) => checkpoint.visualEvidence.length > 0,
      ),
    ).toBe(true);
  });

  test("reuses retained checkpoint context when a job is retried through apply copilot", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);
    const initialSnapshot = await workspaceService.startApplyCopilotRun(
      "job_ready",
      {
        visualCheckpointsEnabled: true,
      },
    );
    const initialRunId = initialSnapshot.applyRuns[0]?.id;

    expect(initialRunId).toBeTruthy();
    if (!initialRunId) {
      return;
    }

    const stagedAutoSnapshot =
      await workspaceService.startAutoApplyRun("job_ready");
    expect(
      stagedAutoSnapshot.applyJobResults.some(
        (result) => result.jobId === "job_ready" && result.state === "planned",
      ),
    ).toBe(true);

    const retrySnapshot =
      await workspaceService.startApplyCopilotRun("job_ready");
    // Runs are listed by when they last changed, and retrying also touches
    // the first run, so the retry is found by id rather than by position.
    const latestRun = retrySnapshot.applyRuns.find(
      (run) => run.id !== initialRunId && run.jobIds.includes("job_ready"),
    );
    const details = await workspaceService.getApplyRunDetails(
      latestRun!.id,
      "job_ready",
    );

    expect(latestRun?.id).not.toBe(initialRunId);
    expect(
      details.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "Resumed from retained apply context",
      ),
    ).toBe(true);
    const resumedCheckpoint = details.checkpoints.find(
      (checkpoint) =>
        checkpoint.label === "Resumed from retained apply context",
    );

    expect(resumedCheckpoint).toMatchObject({
      label: "Resumed from retained apply context",
      jobState: "filling",
    });
    expect(resumedCheckpoint?.detail).toMatch(/retained context/i);
    expect(details.result?.latestCheckpointId).toBeTruthy();
    expect(
      details.checkpoints.some(
        (checkpoint) => checkpoint.id === details.result?.latestCheckpointId,
      ),
    ).toBe(true);
    expect(details.result?.runId).toBe(latestRun?.id);
  });

  test("rejects apply run details lookup when the run does not include the requested job", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);
    const snapshot = await workspaceService.startApplyCopilotRun("job_ready");
    const runId = snapshot.applyRuns[0]?.id;

    expect(runId).toBeTruthy();
    if (!runId) {
      return;
    }

    await expect(
      workspaceService.getApplyRunDetails(runId, "job_generating"),
    ).rejects.toThrow(
      `Apply run '${runId}' does not include job 'job_generating'.`,
    );
  });

  test("captures research artifacts and returns grounded assistant resume feedback", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const beforeWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const messages = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Shorten the summary and tighten one experience bullet for ATS readability.",
    );
    const afterWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const assistantPatchedMessage = messages.find(
      (message) => message.role === "assistant" && message.patches.length > 0,
    );

    expect(beforeWorkspace.research.length).toBeGreaterThan(0);
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
    if (assistantPatchedMessage) {
      expect(afterWorkspace.draft).toEqual(beforeWorkspace.draft);
      expect(assistantPatchedMessage).toMatchObject({
        proposalStatus: "pending",
        baseDraftUpdatedAt: beforeWorkspace.draft.updatedAt,
      });
    } else {
      expect(
        messages.some(
          (message) =>
            message.role === "assistant" &&
            /no changes were applied/i.test(message.content),
        ),
      ).toBe(true);
    }
    expect(
      afterWorkspace.draft.sections
        .find((section) => section.kind === "experience")
        ?.entries.some((entry) => entry.bullets.length > 0),
    ).toBe(true);
    expect(
      afterWorkspace.assistantMessages.some(
        (message) => message.role === "assistant",
      ),
    ).toBe(true);
  });

  test("sanitizes duplicate and copied job-description resume content before persistence", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const experienceSection = workspace.draft.sections.find(
      (section) => section.kind === "experience",
    );

    expect(experienceSection).toBeTruthy();

    await workspaceService.saveResumeDraft({
      ...workspace.draft,
      sections: workspace.draft.sections.map((section) => {
        if (section.id !== experienceSection?.id) {
          return section;
        }

        return {
          ...section,
          bullets: [
            ...section.bullets,
            {
              id: "duplicate_bullet_1",
              text: "Own the design system roadmap.",
              origin: "user_edited" as const,
              locked: false,
              included: true,
              sourceRefs: [],
              lastGeneratedContentHash: null,
              updatedAt: new Date().toISOString(),
            },
            {
              id: "duplicate_bullet_2",
              text: "Own the design system roadmap.",
              origin: "user_edited" as const,
              locked: false,
              included: true,
              sourceRefs: [],
              lastGeneratedContentHash: null,
              updatedAt: new Date().toISOString(),
            },
          ],
        };
      }),
    });

    const refreshedWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const refreshedExperienceSection = refreshedWorkspace.draft.sections.find(
      (section) => section.kind === "experience",
    );

    expect(
      refreshedExperienceSection?.bullets.filter(
        (bullet) => bullet.text === "Own the design system roadmap.",
      ).length,
    ).toBeLessThanOrEqual(1);
  });

  test("fails assistant edits as a batch when one patch targets missing content", async () => {
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft() {
          return Promise.resolve({
            content: "Attempted two edits.",
            patches: [
              {
                id: "assistant_patch_ok",
                draftId: "resume_draft_job_ready",
                operation: "replace_section_text" as const,
                targetSectionId: "section_summary",
                targetEntryId: null,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: "Shortened summary.",
                newIncluded: null,
                newLocked: null,
                newBullets: null,
                appliedAt: new Date().toISOString(),
                origin: "assistant" as const,
                conflictReason: null,
              },
              {
                id: "assistant_patch_bad",
                draftId: "resume_draft_job_ready",
                operation: "update_bullet" as const,
                targetSectionId: "section_experience",
                targetEntryId: "missing_entry",
                anchorEntryId: null,
                targetBulletId: "missing_bullet",
                anchorBulletId: null,
                position: null,
                newText: "Impossible update",
                newIncluded: null,
                newLocked: null,
                newBullets: null,
                appliedAt: new Date().toISOString(),
                origin: "assistant" as const,
                conflictReason: null,
              },
            ],
          });
        },
      },
    });

    await workspaceService.generateResume("job_ready");
    const beforeWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const messages = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Apply these edits.",
    );
    const afterWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");

    expect(afterWorkspace.draft.updatedAt).toBe(
      beforeWorkspace.draft.updatedAt,
    );
    const assistantMessages = messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages.at(-1)?.content).toMatch(
      /No assistant changes were applied/i,
    );
  });

  test("resume workspace exposes shared profile narrative and proof summaries", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    expect(workspace.sharedProfile.narrativeSummary).toMatch(/design systems/i);
    expect(workspace.sharedProfile.selfIntroduction).toMatch(
      /systems-focused product designer/i,
    );
    expect(workspace.sharedProfile.highlightedProofs[0]?.title).toBe(
      "Design-system rollout",
    );
  });

  test("previews an unsaved draft without persisting intermediate changes", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const previewDraft = {
      ...workspace.draft,
      sections: workspace.draft.sections.map((section, index) =>
        index === 0 && section.text
          ? {
              ...section,
              text: `${section.text} Preview-only edit.`,
            }
          : section,
      ),
    };

    const preview = await workspaceService.previewResumeDraft(previewDraft);
    const persistedDraft = await repository.getResumeDraftByJobId("job_ready");
    const revisionPrefix = `resume_preview_${workspace.draft.id}`;

    expect(preview.draftId).toBe(workspace.draft.id);
    expect(preview.html).toContain("Preview-only edit.");
    expect(preview.html).toContain("data-resume-section-id");
    expect(preview.revisionKey.startsWith(revisionPrefix)).toBe(true);
    expect(
      preview.revisionKey.slice(revisionPrefix.length).length,
    ).toBeGreaterThan(0);
    expect(persistedDraft?.sections[0]?.text).toBe(
      workspace.draft.sections[0]?.text ?? null,
    );
    expect(persistedDraft?.updatedAt).toBe(workspace.draft.updatedAt);
  });

  test("keeps unchanged approved resume previews clean instead of marking them stale", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const preview = await workspaceService.previewResumeDraft(workspace.draft);

    expect(
      preview.warnings.some((warning) =>
        /Unsaved changes differ from the last approved export/i.test(
          warning.message,
        ),
      ),
    ).toBe(false);
  });

  test("marks approved resume previews stale when unsaved edits differ from the approved draft", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const preview = await workspaceService.previewResumeDraft({
      ...workspace.draft,
      sections: workspace.draft.sections.map((section, index) =>
        index === 0 && section.text
          ? {
              ...section,
              text: `${section.text} Preview-only edit.`,
            }
          : section,
      ),
    });

    expect(
      preview.warnings.some((warning) =>
        /Unsaved changes differ from the last approved export/i.test(
          warning.message,
        ),
      ),
    ).toBe(true);
  });

  test("materializes effective identity values for legacy resume drafts that still store null identity", async () => {
    const seed = createSeed();
    seed.profile = {
      ...seed.profile,
      email: "alex@example.com",
      phone: "+44 7000 000111",
      linkedinUrl: "https://linkedin.com/in/alex",
      applicationIdentity: {
        ...seed.profile.applicationIdentity,
        preferredEmail: "alex@example.com",
        preferredPhone: "+44 7000 000111",
      },
    };
    seed.resumeDrafts.push({
      id: "resume_draft_job_ready",
      jobId: "job_ready",
      status: "needs_review",
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "deterministic",
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:00:00.000Z",
    });

    const { workspaceService } = createWorkspaceServiceHarness({ seed });
    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    expect(workspace.draft.identity).toMatchObject({
      fullName: seed.profile.fullName,
      email: "alex@example.com",
      phone: "+44 7000 000111",
      linkedinUrl: "https://linkedin.com/in/alex",
    });
  });

  test("approves a resume that runs over its page target", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      documentManager: {
        ...createDocumentManager(),
        renderResumePreview(input: { templateId: ResumeTemplateId }) {
          return Promise.resolve({
            html: `<!doctype html><html><body><article data-template-id="${input.templateId}">Preview</article></body></html>`,
            warnings: [],
          });
        },
        renderResumeArtifact(
          input: Parameters<
            JobFinderDocumentManager["renderResumeArtifact"]
          >[0],
        ) {
          return Promise.resolve({
            fileName: `generated-${input.templateId}.pdf`,
            storagePath: `/tmp/generated-${input.templateId}.pdf`,
            format: "pdf" as const,
            intermediateFileName: `generated-${input.templateId}.html`,
            intermediateStoragePath: `/tmp/generated-${input.templateId}.html`,
            pageCount: 3,
            warnings: [],
          });
        },
      },
    });

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const exportedArtifact = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    // Length is advice for the writer, never a reason to hold the person back.
    const approved = await workspaceService.approveResume(
      "job_ready",
      exportedArtifact!.id,
    );
    expect(
      approved.resumeDrafts.find((draft) => draft.jobId === "job_ready"),
    ).toMatchObject({ status: "approved" });
  });

  test("rejects resume approval when the export is older than the current draft state", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const exportedArtifact = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    await workspaceService.saveResumeDraft({
      ...workspace.draft,
      sections: workspace.draft.sections.map((section, index) =>
        index === 0 && section.text
          ? { ...section, text: `${section.text} Updated after export.` }
          : section,
      ),
    });

    await expect(
      workspaceService.approveResume("job_ready", exportedArtifact!.id),
    ).rejects.toThrow(/older than the current draft/i);
  });

  test("preserves work-history review guidance after user include and save actions", async () => {
    const seed = createSeed();
    const hiddenExperience = {
      id: "experience_sales_bridge",
      companyName: "Bright Market",
      companyUrl: null,
      title: "Sales Operations Associate",
      employmentType: "Full-time",
      location: "Remote",
      workMode: ["remote" as const],
      startDate: "2019-01",
      endDate: "2019-12",
      isCurrent: false,
      isDraft: false,
      summary: "Maintained customer operations reporting.",
      achievements: ["Prepared weekly pipeline reporting for account teams."],
      skills: [],
      domainTags: [],
      peopleManagementScope: null,
      ownershipScope: null,
    };
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          experiences: [...seed.profile.experiences, hiddenExperience],
        },
        searchPreferences: {
          ...seed.searchPreferences,
          tailoringMode: "balanced",
        },
      },
      aiClient: {
        ...baseAiClient,
        async createResumeDraft(input) {
          const base = await baseAiClient.createResumeDraft(input);
          return {
            ...base,
            coverageMetadata: [
              ...base.coverageMetadata.filter(
                (metadata) => metadata.profileRecordId !== hiddenExperience.id,
              ),
              {
                profileRecordId: hiddenExperience.id,
                classification: "suggested_hidden" as const,
                careerFamilyFit: "weak" as const,
                reasons: ["weak career-family fit"],
                reviewGuidance: [
                  "Hidden by default for review: this role has a weaker career-family fit for the target job.",
                ],
                coversMeaningfulGap: false,
              },
            ],
          };
        },
      },
    });

    await workspaceService.generateResume("job_ready");
    const generatedWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const suggestion = generatedWorkspace.workHistoryReviewSuggestions.find(
      (entry) => entry.profileRecordId === hiddenExperience.id,
    );

    expect(suggestion).toMatchObject({
      kind: "weak_fit",
      action: "consider_showing",
    });
    expect(suggestion?.message).toContain("weaker career-family fit");

    const suggestionSection = generatedWorkspace.draft.sections.find(
      (section) => section.id === suggestion?.sectionId,
    );
    const suggestedEntry = suggestionSection?.entries.find(
      (entry) => entry.profileRecordId === hiddenExperience.id,
    );

    if (!suggestion?.sectionId || !suggestedEntry) {
      throw new Error(
        "Expected hidden work-history suggestion to reference a draft entry in its section.",
      );
    }

    await workspaceService.applyResumePatch({
      id: "patch_show_sales_bridge",
      draftId: generatedWorkspace.draft.id,
      operation: "toggle_include",
      targetSectionId: suggestion.sectionId,
      targetEntryId: suggestedEntry.id,
      anchorEntryId: null,
      targetBulletId: null,
      anchorBulletId: null,
      position: null,
      newText: null,
      newIncluded: true,
      newLocked: null,
      newBullets: null,
      appliedAt: "2026-03-20T10:05:00.000Z",
      origin: "user",
      conflictReason: null,
    });

    const patchedWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const patchedSuggestion =
      patchedWorkspace.workHistoryReviewSuggestions.find(
        (entry) => entry.profileRecordId === hiddenExperience.id,
      );

    expect(patchedSuggestion?.message).toContain("weaker career-family fit");
    expect(patchedSuggestion?.action).toBe("keep_compact");

    await workspaceService.saveResumeDraft(patchedWorkspace.draft);
    const savedWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const savedSuggestion = savedWorkspace.workHistoryReviewSuggestions.find(
      (entry) => entry.profileRecordId === hiddenExperience.id,
    );

    expect(savedSuggestion?.message).toContain("weaker career-family fit");
    expect(savedSuggestion?.action).toBe("keep_compact");
  });

  test("preserves chronological and manual experience ordering through hide, show, save, assistant edits, and export", async () => {
    const seed = createSeed();
    seed.profile = {
      ...seed.profile,
      experiences: [
        {
          ...seed.profile.experiences[0]!,
          id: "older_role",
          title: ".NET Developer",
          startDate: "2016-01",
          endDate: "2018-08",
          isCurrent: false,
          achievements: ["Maintained legacy services."],
        },
        {
          ...seed.profile.experiences[0]!,
          id: "current_role",
          title: "Lead Engineer",
          startDate: "2023-07",
          endDate: null,
          isCurrent: true,
          achievements: ["Led platform modernization."],
        },
        {
          ...seed.profile.experiences[0]!,
          id: "middle_role",
          title: ".NET Developer",
          startDate: "2019-08",
          endDate: "2022-01",
          isCurrent: false,
          achievements: ["Built workflow applications."],
        },
      ],
    };
    const renderedEntryOrders: string[][] = [];
    const documentManager = createDocumentManager();
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          const experienceSection = input.draft.sections.find(
            (section) => section.kind === "experience",
          );
          const targetEntry = experienceSection?.entries.find(
            (entry) => entry.id === "experience_older_role",
          );
          const targetBullet = targetEntry?.bullets[0] ?? null;

          if (!experienceSection || !targetEntry || !targetBullet) {
            return baseAiClient.reviseResumeDraft(input);
          }

          return Promise.resolve({
            content:
              "Shortened one experience bullet without changing role order.",
            patches: [
              {
                id: "assistant_patch_shorten_older_role_bullet",
                draftId: input.draft.id,
                operation: "replace_section_bullets" as const,
                targetSectionId: experienceSection.id,
                targetEntryId: targetEntry.id,
                anchorEntryId: null,
                targetBulletId: null,
                anchorBulletId: null,
                position: null,
                newText: null,
                newIncluded: null,
                newLocked: null,
                newBullets: [
                  {
                    ...targetBullet,
                    // A real change: a proposal that sets the text the
                    // bullet already has is left out as a no-op.
                    text: "Kept legacy services running.",
                  },
                  ...targetEntry.bullets.slice(1),
                ],
                appliedAt: "2026-03-20T10:08:00.000Z",
                origin: "assistant" as const,
                conflictReason: null,
              },
            ],
          });
        },
      },
      documentManager: {
        ...documentManager,
        renderResumeArtifact(
          input: Parameters<
            JobFinderDocumentManager["renderResumeArtifact"]
          >[0],
        ) {
          renderedEntryOrders.push(
            input.renderDocument.sections
              .find((section) => section.kind === "experience")
              ?.entries.map((entry) => entry.id) ?? [],
          );
          return documentManager.renderResumeArtifact(input);
        },
      },
    });

    await workspaceService.generateResume("job_ready");
    const generatedWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const experienceSection = generatedWorkspace.draft.sections.find(
      (section) => section.kind === "experience",
    );
    const chronologicalIds =
      experienceSection?.entries.map((entry) => entry.id) ?? [];

    expect(chronologicalIds).toEqual([
      "experience_current_role",
      "experience_middle_role",
      "experience_older_role",
    ]);

    const middleEntryId = "experience_middle_role";
    await workspaceService.applyResumePatch({
      id: "patch_hide_middle_role",
      draftId: generatedWorkspace.draft.id,
      operation: "toggle_include",
      targetSectionId: "section_experience",
      targetEntryId: middleEntryId,
      anchorEntryId: null,
      targetBulletId: null,
      anchorBulletId: null,
      position: null,
      newText: null,
      newIncluded: false,
      newLocked: null,
      newBullets: null,
      appliedAt: "2026-03-20T10:05:00.000Z",
      origin: "user",
      conflictReason: null,
    });
    const hiddenWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    expect(
      hiddenWorkspace.draft.sections
        .find((section) => section.kind === "experience")
        ?.entries.map((entry) => entry.id),
    ).toEqual(chronologicalIds);

    await workspaceService.applyResumePatch({
      id: "patch_show_middle_role",
      draftId: hiddenWorkspace.draft.id,
      operation: "toggle_include",
      targetSectionId: "section_experience",
      targetEntryId: middleEntryId,
      anchorEntryId: null,
      targetBulletId: null,
      anchorBulletId: null,
      position: null,
      newText: null,
      newIncluded: true,
      newLocked: null,
      newBullets: null,
      appliedAt: "2026-03-20T10:06:00.000Z",
      origin: "user",
      conflictReason: null,
    });
    const shownWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    expect(
      shownWorkspace.draft.sections
        .find((section) => section.kind === "experience")
        ?.entries.map((entry) => entry.id),
    ).toEqual(chronologicalIds);

    await workspaceService.applyResumePatch({
      id: "patch_move_older_to_top",
      draftId: shownWorkspace.draft.id,
      operation: "move_entry",
      targetSectionId: "section_experience",
      targetEntryId: "experience_older_role",
      anchorEntryId: "experience_current_role",
      targetBulletId: null,
      anchorBulletId: null,
      position: "before",
      newText: null,
      newIncluded: null,
      newLocked: null,
      newBullets: null,
      appliedAt: "2026-03-20T10:07:00.000Z",
      origin: "user",
      conflictReason: null,
    });
    const manuallyOrderedWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const manualSection = manuallyOrderedWorkspace.draft.sections.find(
      (section) => section.kind === "experience",
    );

    expect(manualSection?.entryOrderMode).toBe("manual");
    expect(manualSection?.entries.map((entry) => entry.id)).toEqual([
      "experience_older_role",
      "experience_current_role",
      "experience_middle_role",
    ]);

    const assistantMessages = await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Shorten one experience bullet without reordering entries.",
    );
    expect(
      assistantMessages.some(
        (message) => message.role === "assistant" && message.patches.length > 0,
      ),
    ).toBe(true);
    const assistantWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const assistantExperienceSection = assistantWorkspace.draft.sections.find(
      (section) => section.kind === "experience",
    );
    expect(
      assistantWorkspace.draft.sections
        .find((section) => section.kind === "experience")
        ?.entries.map((entry) => entry.id),
    ).toEqual([
      "experience_older_role",
      "experience_current_role",
      "experience_middle_role",
    ]);
    expect(
      assistantExperienceSection?.entries.find(
        (entry) => entry.id === "experience_older_role",
      )?.bullets[0]?.text,
    ).toBe("Maintained legacy services.");

    await workspaceService.saveResumeDraft(assistantWorkspace.draft);
    const savedWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    expect(
      savedWorkspace.draft.sections
        .find((section) => section.kind === "experience")
        ?.entries.map((entry) => entry.id),
    ).toEqual([
      "experience_older_role",
      "experience_current_role",
      "experience_middle_role",
    ]);

    await workspaceService.exportResumePdf("job_ready");
    expect(renderedEntryOrders.at(-1)).toEqual([
      "experience_older_role",
      "experience_current_role",
      "experience_middle_role",
    ]);

    await workspaceService.applyResumePatch({
      id: "patch_reset_entry_order",
      draftId: savedWorkspace.draft.id,
      operation: "reset_entry_order",
      targetSectionId: "section_experience",
      targetEntryId: null,
      anchorEntryId: null,
      targetBulletId: null,
      anchorBulletId: null,
      position: null,
      newText: null,
      newIncluded: null,
      newLocked: null,
      newBullets: null,
      appliedAt: "2026-03-20T10:08:00.000Z",
      origin: "user",
      conflictReason: null,
    });
    const resetWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const resetSection = resetWorkspace.draft.sections.find(
      (section) => section.kind === "experience",
    );

    expect(resetSection?.entryOrderMode).toBe("chronology");
    expect(resetSection?.entries.map((entry) => entry.id)).toEqual(
      chronologicalIds,
    );
  });

  test("clears previous approved export flags after the approved draft changes", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);

    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    await workspaceService.saveResumeDraft({
      ...workspace.draft,
      sections: workspace.draft.sections.map((section, index) =>
        index === 0 && section.text
          ? { ...section, text: `${section.text} Edited after approval.` }
          : section,
      ),
    });

    const staleWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");

    expect(staleWorkspace.draft.status).toBe("stale");
    expect(staleWorkspace.draft.approvedExportId).toBeNull();
    expect(staleWorkspace.exports.some((artifact) => artifact.isApproved)).toBe(
      false,
    );
  });

  test("pauses unsupported Easy Apply branches instead of submitting blindly", async () => {
    const seed = createSeed();
    seed.savedJobs.push(
      SavedJobSchema.parse({
        source: "target_site",
        sourceJobId: "linkedin_pause_case",
        discoveryMethod: "catalog_seed",
        canonicalUrl: "https://www.linkedin.com/jobs/view/linkedin_pause_case",
        id: "job_pause_case",
        title: "Principal UX Engineer",
        company: "Void Industries",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:30:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T10:04:00.000Z",
        salaryText: "$185k - $210k",
        summary: "Lead UI platform work.",
        description:
          "Lead UI platform work. Additional work authorization details are required during apply.",
        keySkills: ["React", "Design Systems"],
        responsibilities: ["Lead UI platform architecture."],
        minimumQualifications: ["Deep React experience."],
        preferredQualifications: ["Accessibility leadership experience."],
        seniority: "Principal",
        employmentType: "Full-time",
        department: "Engineering",
        team: "UI Platform",
        employerWebsiteUrl: "https://void.example.com",
        employerDomain: "void.example.com",
        benefits: ["Remote-first collaboration"],
        status: "approved",
        matchAssessment: {
          score: 91,
          reasons: ["Strong UI platform overlap"],
          gaps: [],
        },
        provenance: [],
      }),
    );
    seed.tailoredAssets.push({
      id: "asset_pause_case",
      jobId: "job_pause_case",
      kind: "resume",
      status: "ready",
      label: "Tailored Resume",
      version: "v1",
      templateName: "Chronology Classic",
      compatibilityScore: 94,
      progressPercent: 100,
      updatedAt: "2026-03-20T10:04:00.000Z",
      storagePath: "/tmp/job-pause-case-resume.pdf",
      contentText: "Resume text",
      previewSections: [],
      generationMethod: "deterministic",
      notes: [],
      failureMessage: null,
      failedAt: null,
    });
    seed.resumeDrafts.push({
      id: "resume_draft_job_pause_case",
      jobId: "job_pause_case",
      status: "approved",
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "deterministic",
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      approvedAt: "2026-03-20T10:04:00.000Z",
      approvedExportId: "resume_export_pause_case",
      staleReason: null,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:04:00.000Z",
    });
    seed.resumeExportArtifacts.push({
      id: "resume_export_pause_case",
      draftId: "resume_draft_job_pause_case",
      jobId: "job_pause_case",
      format: "pdf",
      filePath: "/tmp/job-pause-case-resume.pdf",
      pageCount: 2,
      templateId: "classic_ats",
      exportedAt: "2026-03-20T10:04:00.000Z",
      isApproved: true,
    });

    const { workspaceService } = createWorkspaceServiceHarness({ seed });

    const snapshot = await workspaceService.approveApply("job_pause_case");
    const applicationRecord = snapshot.applicationRecords.find(
      (record) => record.jobId === "job_pause_case",
    );

    expect(applicationRecord?.lastAttemptState).toBe("paused");
    expect(applicationRecord?.status).toBe("approved");
    expect(
      snapshot.applicationAttempts.some(
        (attempt) => attempt.state === "paused",
      ),
    ).toBe(true);
    expect(
      snapshot.applicationAttempts.find((attempt) => attempt.state === "paused")
        ?.blocker?.code,
    ).toBe("requires_manual_review");
    expect(
      snapshot.applicationAttempts.find((attempt) => attempt.state === "paused")
        ?.questions.length,
    ).toBeGreaterThan(0);
    expect(applicationRecord?.latestBlocker?.code).toBe(
      "requires_manual_review",
    );
  });

  test("stales approved resume drafts when profile changes affect resume inputs", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    await workspaceService.approveResume("job_ready", approvedExport!.id);

    await workspaceService.saveProfile({
      ...(await workspaceService.getWorkspaceSnapshot()).profile,
      headline: "Senior systems designer and workflow platform lead",
    });

    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    expect(workspace.draft.status).toBe("stale");
    expect(workspace.draft.staleReason).toMatch(
      /profile details changed after approval/i,
    );
    expect(workspace.exports.some((artifact) => artifact.isApproved)).toBe(
      false,
    );
  });

  test("stages a single-job auto apply run with pending submit approval", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    await workspaceService.approveResume("job_ready", approvedExport!.id);

    const snapshot = await workspaceService.startAutoApplyRun("job_ready");
    const run = snapshot.applyRuns[0];
    const result = snapshot.applyJobResults[0];
    const approvals = await repository.listApplySubmitApprovals();

    expect(run).toMatchObject({
      mode: "single_job_auto",
      state: "awaiting_submit_approval",
      currentJobId: "job_ready",
      pendingJobs: 1,
    });
    expect(result).toMatchObject({
      jobId: "job_ready",
      state: "planned",
    });
    expect(approvals[0]).toMatchObject({
      runId: run?.id,
      mode: "single_job_auto",
      status: "pending",
      jobIds: ["job_ready"],
    });
    expect(snapshot.applicationAttempts).toHaveLength(0);
    expect(snapshot.applicationRecords[0]).toMatchObject({
      jobId: "job_ready",
      nextActionLabel: expect.stringMatching(
        /watch it in applications/i,
      ) as string,
    });
    const preparationEvent = snapshot.applicationRecords[0]?.events.find(
      (event) => event.title === "Application preparation approval requested",
    );
    expect(preparationEvent).toMatchObject({
      title: "Application preparation approval requested",
      detail:
        "Your review permits opening and filling this application only. It never permits submission.",
    });
    expect(
      snapshot.applicationRecords[0]?.events
        .map((event) => `${event.title} ${event.detail ?? ""}`)
        .join(" "),
    ).not.toMatch(/automatic submit|submit approval/i);
  });

  test("records submit approval and exposes it through apply run details", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    await workspaceService.approveResume("job_ready", approvedExport!.id);

    const startedSnapshot =
      await workspaceService.startAutoApplyRun("job_ready");
    const runId = startedSnapshot.applyRuns[0]?.id;
    expect(runId).toBeTruthy();

    const approvedSnapshot = await workspaceService.approveApplyRun(runId!);
    const approval = (await repository.listApplySubmitApprovals())[0];
    const details = await workspaceService.getApplyRunDetails(
      runId!,
      "job_ready",
    );

    expect(approvedSnapshot.applyRuns[0]).toMatchObject({
      id: runId,
      state: "paused_for_user_review",
    });
    expect(approval).toMatchObject({
      runId,
      status: "approved",
    });
    expect(details.submitApproval).toMatchObject({
      runId,
      status: "approved",
    });
  });

  test("keeps apply browser sessions warm across queue jobs when keepSessionAlive is enabled", async () => {
    const seed = createSeed();
    seed.settings.keepSessionAlive = true;
    seed.savedJobs = [
      {
        ...seed.savedJobs[0]!,
        id: "job_queue_first",
        sourceJobId: "linkedin_queue_first",
        canonicalUrl: "https://www.linkedin.com/jobs/view/linkedin_queue_first",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_queue_first/apply",
        title: "Staff Product Designer",
        company: "Queue Labs",
        status: "ready_for_review",
      },
      {
        ...seed.savedJobs[0]!,
        id: "job_queue_second",
        sourceJobId: "linkedin_queue_second",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_queue_second",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_queue_second/apply",
        title: "Senior Product Designer",
        company: "Queue Labs",
        status: "ready_for_review",
      },
    ];
    seed.tailoredAssets = [
      {
        ...seed.tailoredAssets[0]!,
        id: "asset_queue_first",
        jobId: "job_queue_first",
        storagePath: "/tmp/job-queue-first-resume.pdf",
      },
      {
        ...seed.tailoredAssets[0]!,
        id: "asset_queue_second",
        jobId: "job_queue_second",
        storagePath: "/tmp/job-queue-second-resume.pdf",
      },
    ];
    seed.resumeDrafts = [
      {
        id: "resume_draft_queue_first",
        jobId: "job_queue_first",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_queue_first",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
      {
        id: "resume_draft_queue_second",
        jobId: "job_queue_second",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_queue_second",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_queue_first",
        draftId: "resume_draft_queue_first",
        jobId: "job_queue_first",
        format: "pdf",
        filePath: "/tmp/job-queue-first-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
      {
        id: "resume_export_queue_second",
        draftId: "resume_draft_queue_second",
        jobId: "job_queue_second",
        format: "pdf",
        filePath: "/tmp/job-queue-second-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
    ];

    let openSessionCalls = 0;
    let closeSessionCalls = 0;
    const fallbackRuntime = createBrowserRuntime();
    const browserRuntime: BrowserSessionRuntime = {
      ...fallbackRuntime,
      async openSession(source, options) {
        openSessionCalls += 1;
        return fallbackRuntime.openSession(source, options);
      },
      async closeSession(source) {
        closeSessionCalls += 1;
        return fallbackRuntime.closeSession(source);
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAiClient(),
    });

    const startedSnapshot = await workspaceService.startAutoApplyQueueRun([
      "job_queue_first",
      "job_queue_second",
    ]);
    const runId = startedSnapshot.applyRuns[0]?.id;

    expect(runId).toBeTruthy();

    const approvedSnapshot = await workspaceService.approveApplyRun(runId!);

    // A job that reached its review checkpoint has finished this batch's
    // attempt, so only jobs the queue has not reached count as pending. A
    // prepare-only queue that reached the end of its list is therefore
    // complete with nothing pending; the per-job results below carry the
    // "awaiting review" truth.
    expect(approvedSnapshot.applyRuns[0]).toMatchObject({
      id: runId,
      state: "completed",
      submittedJobs: 0,
      pendingJobs: 0,
    });
    expect(approvedSnapshot.applyJobResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "job_queue_first",
          state: "awaiting_review",
        }),
        expect.objectContaining({
          jobId: "job_queue_second",
          state: "awaiting_review",
        }),
      ]),
    );
    expect(openSessionCalls).toBe(1);
    expect(closeSessionCalls).toBe(0);
  });

  test("replaces an approved single-job auto apply run with a fresh pending approval when revoked", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    await workspaceService.approveResume("job_ready", approvedExport!.id);

    const startedSnapshot =
      await workspaceService.startAutoApplyRun("job_ready");
    const runId = startedSnapshot.applyRuns[0]?.id;
    expect(runId).toBeTruthy();

    await workspaceService.approveApplyRun(runId!);
    const revokedSnapshot = await workspaceService.revokeApplyRunApproval(
      runId!,
    );

    const approvals = await repository.listApplySubmitApprovals();
    const pendingApproval = approvals.find(
      (approval) => approval.status === "pending",
    );
    const revokedApproval = approvals.find(
      (approval) => approval.status === "revoked",
    );

    expect(revokedSnapshot.applyRuns[0]).toMatchObject({
      id: runId,
      state: "awaiting_submit_approval",
    });
    expect(approvals).toHaveLength(2);
    expect(pendingApproval).toMatchObject({
      runId,
      status: "pending",
    });
    expect(revokedApproval).toMatchObject({
      runId,
      status: "revoked",
    });
    expect(revokedSnapshot.applicationRecords[0]).toMatchObject({
      jobId: "job_ready",
      lastActionLabel: "Submit approval revoked for this automatic apply run.",
      nextActionLabel:
        "Re-approve this run before any later submit-enabled execution.",
    });
    expect(revokedSnapshot.applyRuns[0]?.submitApprovalId).toBe(
      pendingApproval?.id,
    );
    expect(revokedApproval?.revokedAt).toBeTruthy();
  });

  test("stages a queue auto apply run with one approval record per run", async () => {
    const seed = createSeed();
    seed.savedJobs = [
      {
        ...seed.savedJobs[0]!,
        id: "job_consent_queue",
        sourceJobId: "linkedin_consent_queue",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue/apply",
        title: "Staff Product Designer",
        company: "Consent Labs",
        description:
          "Design the workflow system. This application asks whether you already have an account before continuing.",
        status: "ready_for_review",
      },
      seed.savedJobs[0]!,
    ];
    seed.tailoredAssets = [
      {
        ...seed.tailoredAssets[0]!,
        id: "asset_consent_queue",
        jobId: "job_consent_queue",
        storagePath: "/tmp/job-consent-queue-resume.pdf",
      },
      seed.tailoredAssets[0]!,
    ];
    seed.resumeDrafts = [
      {
        id: "resume_draft_consent_queue",
        jobId: "job_consent_queue",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_consent_queue",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
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
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_job_ready",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_consent_queue",
        draftId: "resume_draft_consent_queue",
        jobId: "job_consent_queue",
        format: "pdf",
        filePath: "/tmp/job-consent-queue-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
      {
        id: "resume_export_job_ready",
        draftId: "resume_draft_job_ready",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/job-ready-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
    ];

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    const snapshot = await workspaceService.startAutoApplyQueueRun([
      "job_consent_queue",
      "job_ready",
    ]);
    const approval = (await repository.listApplySubmitApprovals())[0];

    expect(snapshot.applyRuns[0]).toMatchObject({
      mode: "queue_auto",
      state: "awaiting_submit_approval",
      totalJobs: 2,
      pendingJobs: 2,
    });
    expect(snapshot.applyJobResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "job_consent_queue",
          state: "planned",
        }),
        expect.objectContaining({ jobId: "job_ready", state: "planned" }),
      ]),
    );
    expect(approval).toMatchObject({
      mode: "queue_auto",
      status: "pending",
      jobIds: ["job_consent_queue", "job_ready"],
    });
  });

  test.each([
    ["prepare_only", "leaves it open for you to send"],
    ["confirm_before_submit", "stops at the send button"],
    ["autonomous_submit", "sends it when the employer's form is complete"],
  ] as const)(
    "queue detail follows the selected %s mode",
    async (mode, expected) => {
      const seed = createSeed();
      seed.savedJobs = [
        { ...seed.savedJobs[0]!, resumeApplicationMode: "original_resume" },
      ];
      seed.settings = {
        ...seed.settings,
        resumeApplicationMode: "original_resume",
        applicationAutomationMode: "prepare_only",
      };
      const { workspaceService } = createWorkspaceServiceHarness({ seed });
      const snapshot = await workspaceService.startAutoApplyQueueRun(
        ["job_ready"],
        mode,
      );
      expect(snapshot.applyRuns[0]?.detail).toContain(expected);
    },
  );

  test("approved queue run isolates a consent blocker and prepares later jobs", async () => {
    const seed = createSeed();
    seed.savedJobs = [
      {
        ...seed.savedJobs[0]!,
        id: "job_consent_queue",
        sourceJobId: "linkedin_consent_queue",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue/apply",
        title: "Staff Product Designer",
        company: "Consent Labs",
        description:
          "Design the workflow system. This application asks whether you already have an account before continuing.",
        status: "ready_for_review",
      },
      seed.savedJobs[0]!,
    ];
    seed.tailoredAssets = [
      {
        ...seed.tailoredAssets[0]!,
        id: "asset_consent_queue",
        jobId: "job_consent_queue",
        storagePath: "/tmp/job-consent-queue-resume.pdf",
      },
      seed.tailoredAssets[0]!,
    ];
    seed.resumeDrafts = [
      {
        id: "resume_draft_consent_queue",
        jobId: "job_consent_queue",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_consent_queue",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
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
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_job_ready",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_consent_queue",
        draftId: "resume_draft_consent_queue",
        jobId: "job_consent_queue",
        format: "pdf",
        filePath: "/tmp/job-consent-queue-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
      {
        id: "resume_export_job_ready",
        draftId: "resume_draft_job_ready",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/job-ready-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
    ];

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    const startedSnapshot = await workspaceService.startAutoApplyQueueRun([
      "job_consent_queue",
      "job_ready",
    ]);
    const runId = startedSnapshot.applyRuns[0]?.id;
    expect(runId).toBeTruthy();

    const snapshot = await workspaceService.approveApplyRun(runId!);
    const consentRequests = await repository.listApplicationConsentRequests({
      runId: runId!,
      jobId: "job_consent_queue",
    });

    expect(snapshot.applyRuns[0]).toMatchObject({
      id: runId,
      mode: "queue_auto",
      state: "paused_for_consent",
    });
    expect(snapshot.applyJobResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "job_consent_queue",
          state: "blocked",
        }),
        expect.objectContaining({
          jobId: "job_ready",
          state: "awaiting_review",
        }),
      ]),
    );
    expect(consentRequests[0]).toMatchObject({
      status: "pending",
    });
  });

  test("declining queue consent skips the blocked job and continues safely", async () => {
    const seed = createSeed();
    seed.savedJobs = [
      {
        ...seed.savedJobs[0]!,
        id: "job_consent_queue",
        sourceJobId: "linkedin_consent_queue",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue/apply",
        title: "Staff Product Designer",
        company: "Consent Labs",
        description:
          "Design the workflow system. This application asks whether you already have an account before continuing.",
        status: "ready_for_review",
      },
      seed.savedJobs[0]!,
    ];
    seed.tailoredAssets = [
      {
        ...seed.tailoredAssets[0]!,
        id: "asset_consent_queue",
        jobId: "job_consent_queue",
        storagePath: "/tmp/job-consent-queue-resume.pdf",
      },
      seed.tailoredAssets[0]!,
    ];
    seed.resumeDrafts = [
      {
        id: "resume_draft_consent_queue",
        jobId: "job_consent_queue",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_consent_queue",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
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
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_job_ready",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_consent_queue",
        draftId: "resume_draft_consent_queue",
        jobId: "job_consent_queue",
        format: "pdf",
        filePath: "/tmp/job-consent-queue-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
      {
        id: "resume_export_job_ready",
        draftId: "resume_draft_job_ready",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/job-ready-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
    ];

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    const startedSnapshot = await workspaceService.startAutoApplyQueueRun([
      "job_consent_queue",
      "job_ready",
    ]);
    const runId = startedSnapshot.applyRuns[0]?.id;
    expect(runId).toBeTruthy();
    await workspaceService.approveApplyRun(runId!);

    const pendingConsentRequest = (
      await repository.listApplicationConsentRequests({
        runId: runId!,
        jobId: "job_consent_queue",
      })
    )[0];
    expect(pendingConsentRequest).toBeTruthy();

    const snapshot = await workspaceService.resolveApplyConsentRequest(
      pendingConsentRequest!.id,
      "decline",
    );
    const declinedConsentRequest = (
      await repository.listApplicationConsentRequests({
        runId: runId!,
        jobId: "job_consent_queue",
      })
    ).find((request) => request.id === pendingConsentRequest!.id);

    expect(snapshot.applyRuns[0]).toMatchObject({
      id: runId,
      mode: "queue_auto",
    });
    expect(snapshot.applyJobResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "job_consent_queue",
          state: "skipped",
        }),
        expect.objectContaining({
          jobId: "job_ready",
          state: "awaiting_review",
        }),
      ]),
    );
    expect(
      snapshot.applicationRecords.find(
        (record) => record.jobId === "job_consent_queue",
      ),
    ).toMatchObject({
      status: "ready_for_review",
      lastAttemptState: "paused",
      consentSummary: {
        status: "declined",
        pendingCount: 0,
      },
    });
    expect(declinedConsentRequest).toMatchObject({
      id: pendingConsentRequest!.id,
      status: "declined",
    });
  });

  test("approving queue consent aligns the application record with review-ready state", async () => {
    const seed = createSeed();
    seed.savedJobs = [
      {
        ...seed.savedJobs[0]!,
        id: "job_consent_queue",
        sourceJobId: "linkedin_consent_queue",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue/apply",
        title: "Staff Product Designer",
        company: "Consent Labs",
        description:
          "Design the workflow system. This application asks whether you already have an account before continuing.",
        status: "ready_for_review",
      },
      seed.savedJobs[0]!,
    ];
    seed.tailoredAssets = [
      {
        ...seed.tailoredAssets[0]!,
        id: "asset_consent_queue",
        jobId: "job_consent_queue",
        storagePath: "/tmp/job-consent-queue-resume.pdf",
      },
      seed.tailoredAssets[0]!,
    ];
    seed.resumeDrafts = [
      {
        id: "resume_draft_consent_queue",
        jobId: "job_consent_queue",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_consent_queue",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
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
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_job_ready",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_consent_queue",
        draftId: "resume_draft_consent_queue",
        jobId: "job_consent_queue",
        format: "pdf",
        filePath: "/tmp/job-consent-queue-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
      {
        id: "resume_export_job_ready",
        draftId: "resume_draft_job_ready",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/job-ready-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
    ];

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    const startedSnapshot = await workspaceService.startAutoApplyQueueRun([
      "job_consent_queue",
      "job_ready",
    ]);
    const runId = startedSnapshot.applyRuns[0]?.id;
    expect(runId).toBeTruthy();
    await workspaceService.approveApplyRun(runId!);

    const pendingConsentRequest = (
      await repository.listApplicationConsentRequests({
        runId: runId!,
        jobId: "job_consent_queue",
      })
    )[0];

    const snapshot = await workspaceService.resolveApplyConsentRequest(
      pendingConsentRequest!.id,
      "approve",
    );
    const approvedConsentRequest = (
      await repository.listApplicationConsentRequests({
        runId: runId!,
        jobId: "job_consent_queue",
      })
    ).find((request) => request.id === pendingConsentRequest!.id);

    expect(
      snapshot.applicationRecords.find(
        (record) => record.jobId === "job_consent_queue",
      ),
    ).toMatchObject({
      status: "ready_for_review",
      lastAttemptState: "paused",
      consentSummary: {
        status: "approved",
        pendingCount: 0,
      },
    });
    expect(approvedConsentRequest).toMatchObject({
      id: pendingConsentRequest!.id,
      status: "approved",
    });
  });

  test("can cancel a staged queue run", async () => {
    const seed = createSeed();
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
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_job_ready",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_job_ready",
        draftId: "resume_draft_job_ready",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/job-ready-resume.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
    ];

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    const startedSnapshot = await workspaceService.startAutoApplyQueueRun([
      "job_ready",
    ]);
    const runId = startedSnapshot.applyRuns[0]?.id;
    expect(runId).toBeTruthy();

    const snapshot = await workspaceService.cancelApplyRun(runId!);
    const run = (await repository.listApplyRuns())[0];

    expect(snapshot.applyRuns[0]).toMatchObject({
      id: runId,
      state: "cancelled",
    });
    expect(run).toMatchObject({
      id: runId,
      state: "cancelled",
    });
  });

  test("cancelling an active queue aborts every active preparation and never starts the next job", async () => {
    // With two preparations at once (ADR 0036; the default is wider now, the
    // rule is the same at any width), Stop must abort both active
    // preparations, not only the first, and the third job must never be
    // launched.
    vi.stubEnv("NESTOR_APPLICATION_PREPARATION_CONCURRENCY", "2");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const seed = createSeed();
    const readyJob = seed.savedJobs.find((job) => job.id === "job_ready")!;
    const extraJob = (suffix: string) =>
      SavedJobSchema.parse({
        ...readyJob,
        id: `job_${suffix}`,
        sourceJobId: `linkedin_signal_${suffix}`,
        canonicalUrl: `https://www.linkedin.com/jobs/view/linkedin_signal_${suffix}`,
        applicationUrl: `https://www.linkedin.com/jobs/view/linkedin_signal_${suffix}/apply`,
        resumeApplicationMode: "original_resume",
      });
    seed.savedJobs = [
      SavedJobSchema.parse({
        ...readyJob,
        resumeApplicationMode: "original_resume",
      }),
      extraJob("second"),
      extraJob("third"),
    ];

    const baseRuntime = createBrowserRuntime();
    let markBothStarted: (() => void) | null = null;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const executeApplicationFlow = vi.fn(
      async (
        _source: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[0],
        _input: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[1],
        options?: Parameters<
          BrowserSessionRuntime["executeApplicationFlow"]
        >[2],
      ): ReturnType<BrowserSessionRuntime["executeApplicationFlow"]> => {
        if (executeApplicationFlow.mock.calls.length === 2) markBothStarted?.();
        return new Promise((resolve, reject) => {
          const abort = () =>
            reject(new DOMException("Cancelled", "AbortError"));
          options?.signal?.addEventListener("abort", abort, { once: true });
          if (options?.signal?.aborted) abort();
        });
      },
    );
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });

    const staged = await workspaceService.startAutoApplyQueueRun([
      "job_ready",
      "job_second",
      "job_third",
    ]);
    const runId = staged.applyRuns[0]!.id;
    const execution = workspaceService.approveApplyRun(runId);
    await bothStarted;

    await workspaceService.cancelApplyRun(runId);
    await execution;

    expect(
      executeApplicationFlow.mock.calls.map((call) => call[1].job.id),
    ).toEqual(["job_ready", "job_second"]);
    for (const call of executeApplicationFlow.mock.calls) {
      expect(call[2]?.signal?.aborted).toBe(true);
    }
    expect((await repository.listApplyRuns())[0]).toMatchObject({
      id: runId,
      state: "cancelled",
    });
    const results = await repository.listApplyJobResults({ runId });
    expect(
      results.find((result) => result.jobId === "job_third"),
    ).toMatchObject({ state: "failed" });
    for (const result of results) {
      expect(result.completedAt).not.toBeNull();
    }
  });

  test("an immediate cancellation wins the startup race and remains durable", async () => {
    const seed = createSeed();
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? SavedJobSchema.parse({
            ...job,
            resumeApplicationMode: "original_resume",
          })
        : job,
    );
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      baseRuntime.executeApplicationFlow.bind(baseRuntime),
    );
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const staged = await workspaceService.startAutoApplyQueueRun(["job_ready"]);
    const runId = staged.applyRuns[0]!.id;

    const approval = workspaceService.approveApplyRun(runId);
    const cancellation = workspaceService.cancelApplyRun(runId);
    await Promise.all([approval, cancellation]);

    expect((await repository.listApplyRuns())[0]).toMatchObject({
      id: runId,
      state: "cancelled",
    });
    expect(executeApplicationFlow).toHaveBeenCalledTimes(0);
  });

  test("concurrent approval attempts start an apply run only once", async () => {
    const seed = createSeed();
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? SavedJobSchema.parse({
            ...job,
            resumeApplicationMode: "original_resume",
          })
        : job,
    );
    const baseRuntime = createBrowserRuntime();
    const executeApplicationFlow = vi.fn(
      baseRuntime.executeApplicationFlow.bind(baseRuntime),
    );
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const staged = await workspaceService.startAutoApplyQueueRun(["job_ready"]);
    const runId = staged.applyRuns[0]!.id;

    const outcomes = await Promise.allSettled([
      workspaceService.approveApplyRun(runId),
      workspaceService.approveApplyRun(runId),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(executeApplicationFlow).toHaveBeenCalledTimes(1);
  });

  test("shutdown aborts and waits for an active apply execution", async () => {
    const seed = createSeed();
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? SavedJobSchema.parse({
            ...job,
            resumeApplicationMode: "original_resume",
          })
        : job,
    );
    const baseRuntime = createBrowserRuntime();
    let signalObserved = false;
    let releaseStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const executeApplicationFlow = vi.fn(
      async (
        _source: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[0],
        _input: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[1],
        options?: Parameters<
          BrowserSessionRuntime["executeApplicationFlow"]
        >[2],
      ): ReturnType<BrowserSessionRuntime["executeApplicationFlow"]> => {
        releaseStarted?.();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                signalObserved = true;
                reject(new DOMException("Cancelled", "AbortError"));
              }, 10);
            },
            { once: true },
          );
        });
      },
    );
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, executeApplicationFlow },
    });
    const staged = await workspaceService.startAutoApplyQueueRun(["job_ready"]);
    const runId = staged.applyRuns[0]!.id;
    const approval = workspaceService.approveApplyRun(runId);
    await started;

    await workspaceService.shutdown();
    await approval;

    expect(signalObserved).toBe(true);
    expect((await repository.listApplyRuns())[0]).toMatchObject({
      id: runId,
      state: "failed",
      summary: "Automatic apply stopped because the app closed.",
    });
    expect((await repository.listApplyRuns())[0]?.completedAt).not.toBeNull();
  });

  test("stales approved resume drafts when settings change affect resume output", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    await workspaceService.approveResume("job_ready", approvedExport!.id);

    const snapshot = await workspaceService.getWorkspaceSnapshot();
    await workspaceService.saveSettings({
      ...snapshot.settings,
      fontPreset: "space_grotesk_display",
    });

    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    expect(workspace.draft.status).toBe("stale");
    expect(workspace.draft.staleReason).toMatch(
      /resume settings changed after approval/i,
    );
    expect(workspace.exports.some((artifact) => artifact.isApproved)).toBe(
      false,
    );
  });

  test("accepts Modern Editorial as a supported default theme", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    const snapshot = await workspaceService.saveSettings({
      ...(await workspaceService.getWorkspaceSnapshot()).settings,
      resumeTemplateId: "modern_split",
    });

    expect(snapshot.settings.resumeTemplateId).toBe("modern_split");
    expect(snapshot.availableResumeTemplates).toHaveLength(8);
    expect(snapshot.availableResumeTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "classic_ats",
          label: "Chronology Classic",
        }),
        expect.objectContaining({
          id: "compact_exec",
          label: "Senior Brief",
        }),
        expect.objectContaining({
          id: "modern_split",
          label: "Modern Editorial",
        }),
        expect.objectContaining({
          id: "technical_matrix",
          label: "Engineering Spec",
        }),
        expect.objectContaining({
          id: "project_showcase",
          label: "Proof Portfolio",
        }),
        expect.objectContaining({
          id: "credentials_focus",
          label: "Formal Proof",
        }),
        expect.objectContaining({
          id: "timeline_longform",
          label: "Longform Timeline",
        }),
        expect.objectContaining({
          id: "career_pivot",
          label: "Career Pivot Bridge",
        }),
      ]),
    );
  });

  test("keeps Senior Brief when it is part of the supported theme set", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    const snapshot = await workspaceService.saveSettings({
      ...(await workspaceService.getWorkspaceSnapshot()).settings,
      resumeTemplateId: "compact_exec",
    });

    expect(snapshot.settings.resumeTemplateId).toBe("compact_exec");
  });

  test("keeps existing Modern Editorial drafts because the theme is shipped", async () => {
    const seed = createSeed();
    seed.resumeDrafts = [
      {
        id: "resume_draft_job_ready",
        jobId: "job_ready",
        status: "approved",
        templateId: "modern_split",
        identity: null,
        sections: [
          {
            id: "section_summary",
            kind: "summary",
            label: "Summary",
            text: "Legacy template summary.",
            bullets: [],
            entries: [],
            origin: "user_edited",
            locked: false,
            included: true,
            sortOrder: 0,
            entryOrderMode: "chronology",
            profileRecordId: null,
            sourceRefs: [],
            updatedAt: "2026-04-18T12:00:00.000Z",
          },
        ],
        targetPageCount: 2,
        generationMethod: "manual",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-04-18T12:00:00.000Z",
        approvedExportId: "resume_export_legacy",
        staleReason: null,
        createdAt: "2026-04-18T12:00:00.000Z",
        updatedAt: "2026-04-18T12:00:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_legacy",
        draftId: "resume_draft_job_ready",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/legacy-modern-split.pdf",
        pageCount: 1,
        templateId: "modern_split",
        exportedAt: "2026-04-18T12:00:00.000Z",
        isApproved: true,
      },
    ];
    const { workspaceService } = createWorkspaceServiceHarness({ seed });

    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    expect(workspace.draft.templateId).toBe("modern_split");
    expect(workspace.draft.status).toBe("approved");
    expect(workspace.draft.approvedAt).toBe("2026-04-18T12:00:00.000Z");
    expect(workspace.draft.approvedExportId).toBe("resume_export_legacy");
    expect(workspace.draft.staleReason).toBeNull();
  });

  test("refuses approval when the selected template is not approval eligible", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      documentManager: {
        ...createDocumentManager(),
        listResumeTemplates() {
          return ResumeTemplateDefinitionSchema.array().parse([
            {
              id: "classic_ats",
              label: "Chronology Classic",
              familyId: "chronology_classic",
              familyLabel: "Chronology Classic",
              familyDescription: "Calm ATS-safe layouts.",
              variantLabel: "Recruiter Standard",
              description: "Low-risk ATS-safe default.",
              bestFor: ["General applications"],
              visualTags: ["Minimal"],
              density: "balanced",
              deliveryLane: "apply_safe",
              atsConfidence: "high",
              applyEligible: true,
              approvalEligible: true,
              benchmarkEligible: true,
              sortOrder: 10,
            },
            {
              id: "modern_split",
              label: "Modern Editorial",
              familyId: "modern_editorial",
              familyLabel: "Modern Editorial",
              familyDescription: "Calm ATS-safe layouts.",
              variantLabel: "Polished Default",
              description: "Expressive preview-forward variant.",
              bestFor: ["Share links"],
              visualTags: ["Accent header"],
              density: "balanced",
              deliveryLane: "share_ready",
              atsConfidence: "medium",
              applyEligible: false,
              approvalEligible: false,
              benchmarkEligible: false,
              sortOrder: 20,
            },
          ]);
        },
      },
    });

    await workspaceService.saveSettings({
      ...(await workspaceService.getWorkspaceSnapshot()).settings,
      resumeTemplateId: "classic_ats",
    });
    await workspaceService.generateResume("job_ready");
    let exportedSnapshot = await workspaceService.exportResumePdf("job_ready");
    let approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    expect(approvedExport).toBeTruthy();
    await workspaceService.approveResume("job_ready", approvedExport!.id);

    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    await workspaceService.saveResumeDraft({
      ...workspace.draft,
      templateId: "modern_split",
    });
    exportedSnapshot = await workspaceService.exportResumePdf("job_ready");
    approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) =>
        artifact.jobId === "job_ready" &&
        artifact.templateId === "modern_split",
    );

    await expect(
      workspaceService.approveResume("job_ready", approvedExport!.id),
    ).rejects.toThrow(/share-ready template/i);
  });

  test("refuses auto-apply staging when an approved draft uses a non-apply template", async () => {
    const seed = createSeed();
    seed.resumeDrafts = [
      {
        id: "resume_draft_job_ready",
        jobId: "job_ready",
        status: "approved",
        templateId: "modern_split",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "deterministic",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        approvedAt: "2026-04-18T12:00:00.000Z",
        approvedExportId: "resume_export_share_ready",
        staleReason: null,
        createdAt: "2026-04-18T12:00:00.000Z",
        updatedAt: "2026-04-18T12:00:00.000Z",
      },
    ];
    seed.resumeExportArtifacts = [
      {
        id: "resume_export_share_ready",
        draftId: "resume_draft_job_ready",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/generated-modern_split.pdf",
        pageCount: 1,
        templateId: "modern_split",
        exportedAt: "2026-04-18T12:00:00.000Z",
        isApproved: true,
      },
    ];
    seed.tailoredAssets = [
      {
        id: "resume_job_ready",
        jobId: "job_ready",
        kind: "resume",
        status: "ready",
        label: "Tailored Resume",
        version: "v1",
        templateName: "Modern Editorial",
        compatibilityScore: 95,
        progressPercent: 100,
        updatedAt: "2026-04-18T12:00:00.000Z",
        storagePath: "/tmp/generated-modern_split.pdf",
        contentText: "Resume text",
        previewSections: [],
        generationMethod: "deterministic",
        notes: [],
        failureMessage: null,
        failedAt: null,
      },
    ];

    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      documentManager: {
        ...createDocumentManager(),
        listResumeTemplates() {
          return ResumeTemplateDefinitionSchema.array().parse([
            {
              id: "classic_ats",
              label: "Chronology Classic",
              familyId: "chronology_classic",
              familyLabel: "Chronology Classic",
              familyDescription: "Calm ATS-safe layouts.",
              variantLabel: "Recruiter Standard",
              description: "Low-risk ATS-safe default.",
              bestFor: ["General applications"],
              visualTags: ["Minimal"],
              density: "balanced",
              deliveryLane: "apply_safe",
              atsConfidence: "high",
              applyEligible: true,
              approvalEligible: true,
              benchmarkEligible: true,
              sortOrder: 10,
            },
            {
              id: "modern_split",
              label: "Modern Editorial",
              familyId: "modern_editorial",
              familyLabel: "Modern Editorial",
              familyDescription: "Calm ATS-safe layouts.",
              variantLabel: "Polished Default",
              description: "Expressive preview-forward variant.",
              bestFor: ["Share links"],
              visualTags: ["Accent header"],
              density: "balanced",
              deliveryLane: "share_ready",
              atsConfidence: "medium",
              applyEligible: false,
              approvalEligible: false,
              benchmarkEligible: false,
              sortOrder: 20,
            },
          ]);
        },
      },
    });

    await expect(
      workspaceService.startAutoApplyRun("job_ready"),
    ).rejects.toThrow(/not eligible for automatic apply/i);
  });

  test("keeps approved resume drafts current when a recrawl has weaker job detail", async () => {
    const seed = createSeed();
    const richDescription =
      "Own product design from discovery through measured delivery. Partner with product managers and engineers to define customer problems, evaluate alternatives, and document interaction decisions before build. Test prototypes weekly with real users, synthesize qualitative and quantitative evidence into prioritized recommendations, and improve shipped workflows across onboarding, activation, and retention surfaces. Maintain the design system tokens, document accessibility expectations for every component, and coach teammates through structured design reviews so quality stays high as the platform grows.";
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? SavedJobSchema.parse({
            ...job,
            description: richDescription,
            detailQuality: "detail_enriched",
            atsProvider: "LinkedIn Jobs",
          })
        : job,
    );
    const baseRuntime = createBrowserRuntime();
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runDiscovery(source) {
        return Promise.resolve({
          source,
          startedAt: "2026-03-21T10:00:00.000Z",
          completedAt: "2026-03-21T10:01:00.000Z",
          querySummary: "Thin recrawl approval test",
          inventoryCompleteness: "complete",
          warning: null,
          agentMetadata: null,
          jobs: [
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: "linkedin_signal_ready",
              discoveryMethod: "catalog_seed",
              canonicalUrl:
                "https://www.linkedin.com/jobs/view/linkedin_signal_ready",
              title: "Senior Product Designer",
              company: "Signal Systems",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "easy_apply",
              easyApplyEligible: true,
              discoveredAt: "2026-03-21T10:00:00.000Z",
              lastSeenAt: "2026-03-21T10:00:00.000Z",
              lastVerifiedActiveAt: "2026-03-21T10:00:00.000Z",
              salaryText: null,
              description: "Senior Product Designer role at Signal Systems",
              detailQuality: "card_only",
            }),
          ],
        });
      },
    };
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
    });

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    await workspaceService.approveResume("job_ready", approvedExport!.id);

    await workspaceService.runDiscovery();
    const savedJob = (await repository.listSavedJobs()).find(
      (job) => job.id === "job_ready",
    );
    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    expect(savedJob?.description).toBe(richDescription);
    expect(savedJob?.lastSeenAt).toBe("2026-03-21T10:00:00.000Z");
    expect(workspace.draft.status).toBe("approved");
    expect(workspace.draft.approvedExportId).toBe(approvedExport!.id);
  });

  test("stales approved resume drafts when saved job details change materially", async () => {
    let useChangedDiscovery = false;
    const baseRuntime = createBrowserRuntime();
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runDiscovery(source, searchPreferences) {
        if (!useChangedDiscovery) {
          return baseRuntime.runDiscovery(source, searchPreferences);
        }

        return Promise.resolve({
          source,
          startedAt: "2026-03-20T10:00:00.000Z",
          completedAt: "2026-03-20T10:01:00.000Z",
          querySummary: "Changed discovery test run",
          inventoryCompleteness: "complete",
          warning: null,
          agentMetadata: null,
          jobs: [
            JobPostingSchema.parse({
              source: "target_site",
              sourceJobId: "linkedin_signal_ready",
              discoveryMethod: "catalog_seed",
              canonicalUrl:
                "https://www.linkedin.com/jobs/view/linkedin_signal_ready",
              title: "Senior Product Designer",
              company: "Signal Systems",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "easy_apply",
              easyApplyEligible: true,
              postedAt: "2026-03-20T09:00:00.000Z",
              postedAtText: null,
              discoveredAt: "2026-03-20T10:04:00.000Z",
              salaryText: "$180k - $220k",
              summary: "Own the design system for AI operations.",
              description:
                "Own the design system and workflow platform for AI operations.",
              keySkills: ["Figma", "Design Systems", "AI Operations"],
              responsibilities: [
                "Own the design system roadmap for AI operations.",
              ],
              minimumQualifications: [
                "Strong product design systems experience.",
              ],
              preferredQualifications: [
                "Workflow-platform and AI operations background.",
              ],
              seniority: "Senior",
              employmentType: "Full-time",
              department: "Design",
              team: "Design Systems",
              employerWebsiteUrl: "https://signalsystems.example.com",
              employerDomain: "signalsystems.example.com",
              benefits: ["Remote-first collaboration"],
            }),
          ],
        });
      },
    };

    const { workspaceService } = createWorkspaceServiceHarness({
      browserRuntime,
    });

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    await workspaceService.approveResume("job_ready", approvedExport!.id);

    useChangedDiscovery = true;
    const snapshot = await workspaceService.runDiscovery();
    const reviewItem = snapshot.reviewQueue.find(
      (item) => item.jobId === "job_ready",
    );

    expect(reviewItem?.resumeReview.status).toBe("stale");
  });

  test("blocks full-draft regeneration when locked resume content exists", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    await workspaceService.saveResumeDraft({
      ...workspace.draft,
      sections: workspace.draft.sections.map((section, index) =>
        index === 0 ? { ...section, locked: true } : section,
      ),
    });

    await expect(
      workspaceService.regenerateResumeDraft("job_ready"),
    ).rejects.toThrow(/unlock pinned resume sections or bullets/i);
  });

  test("full-draft regeneration rebuilds an existing stale draft from profile-backed dates and descriptions", async () => {
    const seed = createSeed();
    const staleDraft = ResumeDraftSchema.parse({
      id: "resume_draft_job_ready",
      jobId: "job_ready",
      status: "needs_review",
      templateId: "classic_ats",
      identity: null,
      sections: [
        {
          id: "section_experience",
          kind: "experience",
          label: "Experience",
          text: null,
          bullets: [],
          entries: [
            {
              id: "experience_experience_1",
              entryType: "experience",
              title: "Senior systems designer",
              subtitle: "Signal Systems",
              location: "London, UK",
              dateRange: "Present",
              startDate: null,
              endDate: null,
              isCurrent: false,
              summary:
                "Senior systems designer — Signal Systems | London, UK | Present",
              bullets: [],
              origin: "ai_generated",
              locked: false,
              included: true,
              sortOrder: 0,
              profileRecordId: "experience_1",
              sourceRefs: [],
              updatedAt: "2026-03-20T10:00:00.000Z",
            },
          ],
          origin: "ai_generated",
          locked: false,
          included: true,
          sortOrder: 0,
          entryOrderMode: "chronology",
          profileRecordId: null,
          sourceRefs: [],
          updatedAt: "2026-03-20T10:00:00.000Z",
        },
      ],
      targetPageCount: 2,
      generationMethod: "ai",
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:00:00.000Z",
    });
    const futureStaleDraft = ResumeDraftSchema.parse({
      ...staleDraft,
      updatedAt: "2099-01-01T00:00:00.000Z",
      sections: staleDraft.sections.map((section) => ({
        ...section,
        updatedAt: "2099-01-01T00:00:00.000Z",
        entries: section.entries.map((entry) => ({
          ...entry,
          updatedAt: "2099-01-01T00:00:00.000Z",
        })),
      })),
    });
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        resumeDrafts: [futureStaleDraft],
        resumeValidationResults: [
          ResumeValidationResultSchema.parse({
            id: `resume_validation_${futureStaleDraft.id}`,
            draftId: futureStaleDraft.id,
            issues: [],
            pageCount: null,
            validatedAt: futureStaleDraft.updatedAt,
          }),
        ],
      },
    });

    await workspaceService.regenerateResumeDraft("job_ready");
    const regeneratedDraft =
      await repository.getResumeDraftByJobId("job_ready");
    const regeneratedExperience = regeneratedDraft?.sections
      .find((section) => section.kind === "experience")
      ?.entries.find((entry) => entry.profileRecordId === "experience_1");

    expect(regeneratedDraft?.id).toBe(futureStaleDraft.id);
    expect(regeneratedDraft?.createdAt).toBe(futureStaleDraft.createdAt);
    expect(regeneratedDraft?.updatedAt).toBe("2099-01-01T00:00:00.001Z");
    expect(regeneratedExperience).toMatchObject({
      dateRange: "Jan 2020 – Present",
      startDate: "2020-01",
      endDate: null,
      isCurrent: true,
      summary: "Builds resilient workflow tools.",
    });
    expect(regeneratedExperience?.bullets.length).toBeGreaterThan(0);
  });

  test("blocks section regeneration when the target section has locked content", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const targetSection =
      workspace.draft.sections.find((section) => section.bullets.length > 0) ??
      workspace.draft.sections[0];

    expect(targetSection).toBeTruthy();

    await workspaceService.saveResumeDraft({
      ...workspace.draft,
      sections: workspace.draft.sections.map((section) =>
        section.id === targetSection!.id
          ? {
              ...section,
              bullets: section.bullets.map((bullet, index) =>
                index === 0 ? { ...bullet, locked: true } : bullet,
              ),
            }
          : section,
      ),
    });

    await expect(
      workspaceService.regenerateResumeSection("job_ready", targetSection!.id),
    ).rejects.toThrow(/unlock the .* section before regenerating it/i);
  });

  test("blocks original-CV apply when the saved file bytes changed", async () => {
    const expectedSha256 = "a".repeat(64);
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    seed.profile = {
      ...seed.profile,
      baseResume: { ...seed.profile.baseResume, sha256: expectedSha256 },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      exportFileVerifier: {
        exists: () => Promise.resolve(true),
        sha256: () => Promise.resolve("b".repeat(64)),
      },
    });

    await expect(
      workspaceService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow(/changed after it was saved/i);
    expect(
      (await workspaceService.getWorkspaceSnapshot()).applicationAttempts,
    ).toHaveLength(0);
  });

  test("requires re-import when a legacy original CV has no saved digest", async () => {
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    seed.profile = {
      ...seed.profile,
      baseResume: { ...seed.profile.baseResume, sha256: undefined },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      exportFileVerifier: {
        exists: () => Promise.resolve(true),
        sha256: () => Promise.resolve("a".repeat(64)),
      },
    });

    await expect(
      workspaceService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow(/no saved SHA-256 integrity record.*re-import/i);
  });

  test("rejects approval when rendered resume bytes changed after export", async () => {
    const expectedSha256 = "a".repeat(64);
    const baseDocumentManager = createDocumentManager();
    const documentManager = {
      ...baseDocumentManager,
      async renderResumeArtifact(
        input: Parameters<JobFinderDocumentManager["renderResumeArtifact"]>[0],
      ) {
        return {
          ...(await baseDocumentManager.renderResumeArtifact(input)),
          sha256: expectedSha256,
        };
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      documentManager,
      exportFileVerifier: {
        exists: () => Promise.resolve(true),
        sha256: () => Promise.resolve("b".repeat(64)),
      },
    });

    await workspaceService.generateResume("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const artifact = exported.resumeExportArtifacts.find(
      (entry) => entry.jobId === "job_ready",
    );

    await expect(
      workspaceService.approveResume("job_ready", artifact!.id),
    ).rejects.toThrow(/changed after it was saved/i);
    expect(
      (await workspaceService.getResumeWorkspace("job_ready")).draft.status,
    ).not.toBe("approved");
  });

  test("blocks tailored apply when approved resume bytes change later", async () => {
    const expectedSha256 = "a".repeat(64);
    let currentSha256 = expectedSha256;
    const baseDocumentManager = createDocumentManager();
    const documentManager = {
      ...baseDocumentManager,
      async renderResumeArtifact(
        input: Parameters<JobFinderDocumentManager["renderResumeArtifact"]>[0],
      ) {
        return {
          ...(await baseDocumentManager.renderResumeArtifact(input)),
          sha256: expectedSha256,
        };
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      documentManager,
      exportFileVerifier: {
        exists: () => Promise.resolve(true),
        sha256: () => Promise.resolve(currentSha256),
      },
    });

    await workspaceService.generateResume("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const artifact = exported.resumeExportArtifacts.find(
      (entry) => entry.jobId === "job_ready",
    );
    await workspaceService.approveResume("job_ready", artifact!.id);
    currentSha256 = "b".repeat(64);

    await expect(
      workspaceService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow(/changed after it was saved/i);
    expect(
      (await workspaceService.getWorkspaceSnapshot()).applicationAttempts,
    ).toHaveLength(0);
  });

  test("rejects apply approval when the approved export file is missing on disk", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      exportFileVerifier: {
        exists: () => Promise.resolve(false),
      },
    });

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    await expect(
      workspaceService.approveResume("job_ready", approvedExport!.id),
    ).rejects.toThrow(/missing on disk/i);
  });

  test("dismissing a job is durable while prepare-only apply does not record a false applied status", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        tailoredAssets: [],
        resumeDrafts: [],
        resumeDraftRevisions: [],
        resumeExportArtifacts: [],
        resumeResearchArtifacts: [],
        resumeValidationResults: [],
        resumeAssistantMessages: [],
        applicationRecords: [],
        applicationAttempts: [],
        discovery: {
          sessions: [],
          runState: "idle",
          activeRun: null,
          recentRuns: [],
          activeSourceDebugRun: null,
          recentSourceDebugRuns: [],
          discoveryLedger: [],
          pendingDiscoveryJobs: [
            SavedJobSchema.parse({
              id: "pending_job_1",
              source: "target_site",
              sourceJobId: "pending_job_1",
              discoveryMethod: "catalog_seed",
              collectionMethod: "careers_page",
              canonicalUrl: "https://example.com/jobs/pending-job-1",
              applicationUrl: "https://example.com/jobs/pending-job-1/apply",
              title: "Principal Designer",
              company: "Acme",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "easy_apply",
              easyApplyEligible: true,
              postedAt: null,
              postedAtText: null,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              salaryText: null,
              summary: "Pending job summary",
              description: "Pending job description",
              keySkills: ["React"],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
              status: "discovered",
              matchAssessment: {
                score: 90,
                reasons: ["Strong overlap"],
                gaps: [],
              },
              provenance: [
                {
                  targetId: "target_linkedin_default",
                  adapterKind: "auto",
                  resolvedAdapterKind: "target_site",
                  startingUrl: "https://www.linkedin.com/jobs/search/",
                  discoveredAt: "2026-03-20T10:00:00.000Z",
                  collectionMethod: "careers_page",
                  providerKey: null,
                  providerBoardToken: null,
                  titleTriageOutcome: "pass",
                },
              ],
            }),
          ],
        },
      },
    });

    await workspaceService.dismissDiscoveryJob({
      jobId: "pending_job_1",
      reasons: ["other"],
    });
    let discoveryState = await repository.getDiscoveryState();
    expect(discoveryState.discoveryLedger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalUrl: "https://example.com/jobs/pending-job-1",
          latestStatus: "skipped",
          skipReason: "Not interested: other.",
        }),
      ]),
    );

    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    await workspaceService.approveResume("job_ready", approvedExport!.id);
    const preparedSnapshot = await workspaceService.approveApply("job_ready");

    discoveryState = await repository.getDiscoveryState();
    expect(preparedSnapshot.applicationAttempts[0]?.state).toBe("paused");
    expect(
      discoveryState.discoveryLedger.find(
        (entry) =>
          entry.canonicalUrl ===
          "https://www.linkedin.com/jobs/view/linkedin_signal_ready",
      ),
    ).toBeUndefined();
    expect(
      discoveryState.discoveryLedger.some(
        (entry) => entry.latestStatus === "applied",
      ),
    ).toBe(false);
  });

  test("a generated line the AI has not checked yet does not hold back export", async () => {
    const documentManager = createDocumentManager();
    const renderResumeArtifact = vi.fn(
      (
        input: Parameters<JobFinderDocumentManager["renderResumeArtifact"]>[0],
      ) => documentManager.renderResumeArtifact(input),
    );
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      documentManager: {
        ...documentManager,
        renderResumeArtifact,
      },
    });

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    await workspaceService.saveResumeDraft({
      ...workspace.draft,
      sections: workspace.draft.sections.map((section) =>
        section.kind === "experience" && section.entries[0]
          ? {
              ...section,
              entries: section.entries.map((entry, index) =>
                index === 0
                  ? {
                      ...entry,
                      bullets: [
                        ...entry.bullets,
                        {
                          id: "unsupported_generated_claim",
                          text: "Architected a quantum operating model for global logistics teams.",
                          origin: "ai_generated" as const,
                          locked: false,
                          included: true,
                          sourceRefs: [],
                          lastGeneratedContentHash: null,
                          updatedAt: "2026-07-30T12:00:00.000Z",
                        },
                      ],
                    }
                  : entry,
              ),
            }
          : section,
      ),
    });

    const exportsBefore = await repository.listResumeExportArtifacts({
      jobId: "job_ready",
    });
    renderResumeArtifact.mockClear();
    await workspaceService.exportResumePdf("job_ready");
    expect(renderResumeArtifact).toHaveBeenCalled();
    expect(
      (await repository.listResumeExportArtifacts({ jobId: "job_ready" }))
        .length,
    ).toBeGreaterThan(exportsBefore.length);

    const validation = (
      await repository.listResumeValidationResults(workspace.draft.id)
    )[0];
    expect(validation?.issues.some((issue) => issue.severity === "error")).toBe(
      false,
    );
  });

  test("rejects approval when the persisted claim assessment hash is stale", async () => {
    const { workspaceService, repository } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const exportedSnapshot =
      await workspaceService.exportResumePdf("job_ready");
    const exportedArtifact = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const validation = (
      await repository.listResumeValidationResults(workspace.draft.id)
    )[0];
    if (!validation || !exportedArtifact) {
      throw new Error("Expected an exported resume and validation result.");
    }
    await repository.upsertResumeValidationResult(
      ResumeValidationResultSchema.parse({
        ...validation,
        draftContentHash: "fnv1a32:00000000",
        validatedAt: "2099-07-30T12:00:00.000Z",
      }),
    );

    await expect(
      workspaceService.approveResume("job_ready", exportedArtifact.id),
    ).rejects.toThrow(/current claim-grounding assessment/i);
  });
});
