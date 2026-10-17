import { describe, expect, test } from "vitest";
import {
  ApplyJobResultSchema,
  ApplicationRecordSchema,
  CampaignNotificationSchema,
  getDefaultCampaignConfiguration,
  GroupedManualAnswerDecisionSchema,
  JobFinderIntelligenceStateSchema,
  JobSearchCampaignSchema,
  ResumeDraftRevisionSchema,
  ResumeDraftSchema,
  ResumeValidationResultSchema,
  SavedJobSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "./index";
import { createSeed } from "./test-fixtures";
import { MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT } from "./resume-draft-revision-retention";

function createRetentionDraft(id: string, updatedAt: string) {
  return ResumeDraftSchema.parse({
    id,
    jobId: `job_${id}`,
    status: "needs_review",
    templateId: "classic_ats",
    identity: null,
    sections: [],
    targetPageCount: 2,
    generationMethod: "manual",
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt,
  });
}

function createRetentionRevision(draftId: string, index: number) {
  const suffix = String(index).padStart(3, "0");
  const createdAt = new Date(Date.UTC(2026, 6, 30, 10, 0, index)).toISOString();
  return ResumeDraftRevisionSchema.parse({
    id: `${draftId}_revision_${suffix}`,
    draftId,
    parentRevisionId:
      index === 0
        ? null
        : `${draftId}_revision_${String(index - 1).padStart(3, "0")}`,
    actor: "user",
    mutationKind: "manual_save",
    snapshotDraft: null,
    snapshotIdentity: null,
    snapshotSections: [],
    beforeHash: null,
    afterHash: null,
    diff: null,
    restoredFromRevisionId: null,
    createdAt,
    reason: `Revision ${index}`,
  });
}
describe("createInMemoryJobFinderRepository", () => {
  test("commits application records as one revision-guarded batch", async () => {
    const seed = createSeed();
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_1",
        jobId: "job_1",
        title: "Frontend Engineer",
        company: "Acme",
        status: "submitted",
        lastActionLabel: "Applied",
        nextActionLabel: null,
        lastUpdatedAt: "2026-08-15T10:00:00.000Z",
        crm: {
          revision: 2,
          stage: "applied",
          stageChangedAt: "2026-08-15T10:00:00.000Z",
        },
      }),
      ApplicationRecordSchema.parse({
        id: "application_2",
        jobId: "job_2",
        title: "Backend Engineer",
        company: "Beta",
        status: "submitted",
        lastActionLabel: "Applied",
        nextActionLabel: null,
        lastUpdatedAt: "2026-08-15T10:00:00.000Z",
        crm: {
          revision: 1,
          stage: "applied",
          stageChangedAt: "2026-08-15T10:00:00.000Z",
        },
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);
    const current = await repository.listApplicationRecords();
    const next = current.map((record) =>
      ApplicationRecordSchema.parse({
        ...record,
        lastUpdatedAt: "2026-08-15T10:05:00.000Z",
        crm: {
          ...record.crm,
          revision: (record.crm?.revision ?? 0) + 1,
          stage: "reviewing",
          stageChangedAt: "2026-08-15T10:05:00.000Z",
        },
      }),
    );
    // The stage change and its newer Updated date land together.
    const committed = current.map((record, index) =>
      ApplicationRecordSchema.parse({
        ...record,
        crm: next[index]?.crm,
        lastUpdatedAt: next[index]?.lastUpdatedAt,
      }),
    );

    await expect(
      repository.commitApplicationRecordBatch({
        expectedRevisions: [
          { applicationRecordId: "application_1", expectedRevision: 999 },
          { applicationRecordId: "application_2", expectedRevision: 1 },
        ],
        records: next,
      }),
    ).resolves.toEqual({
      status: "stale",
      recordIds: ["application_1"],
    });
    expect((await repository.listApplicationRecords())[0]?.crm?.stage).toBe(
      "applied",
    );

    await expect(
      repository.commitApplicationRecordBatch({
        expectedRevisions: [
          { applicationRecordId: "application_1", expectedRevision: 2 },
          { applicationRecordId: "application_2", expectedRevision: 1 },
        ],
        records: next,
      }),
    ).resolves.toEqual({
      status: "applied",
      committedRecords: committed,
    });
    expect(
      (await repository.listApplicationRecords()).map(
        (record) => record.crm?.stage,
      ),
    ).toEqual(["reviewing", "reviewing"]);
  });

  test("merges CRM onto current records and validates unchanged selected rows", async () => {
    const seed = createSeed();
    const first = ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: "job_1",
      title: "Frontend Engineer",
      company: "Acme",
      status: "submitted",
      lastActionLabel: "Applied",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-15T10:00:00.000Z",
      crm: {
        revision: 2,
        stage: "applied",
        stageChangedAt: "2026-08-15T10:00:00.000Z",
      },
    });
    const second = ApplicationRecordSchema.parse({
      ...first,
      id: "application_2",
      jobId: "job_2",
      title: "Backend Engineer",
      company: "Beta",
      crm: { ...first.crm, revision: 1 },
    });
    seed.applicationRecords = [first, second];
    const repository = createInMemoryJobFinderRepository(seed);
    const proposedFirst = ApplicationRecordSchema.parse({
      ...first,
      crm: {
        ...first.crm,
        revision: 3,
        stage: "reviewing",
        stageChangedAt: "2026-08-15T10:05:00.000Z",
      },
    });
    const concurrentFirst = ApplicationRecordSchema.parse({
      ...first,
      lastActionLabel: "Application flow resumed",
      nextActionLabel: "Answer employer question",
      lastUpdatedAt: "2026-08-15T10:04:00.000Z",
    });
    await repository.upsertApplicationRecord(concurrentFirst);

    const applied = await repository.commitApplicationRecordBatch({
      expectedRevisions: [
        { applicationRecordId: first.id, expectedRevision: 2 },
        { applicationRecordId: second.id, expectedRevision: 1 },
      ],
      records: [proposedFirst],
    });
    const committedFirst = ApplicationRecordSchema.parse({
      ...concurrentFirst,
      crm: proposedFirst.crm,
    });
    expect(applied).toEqual({
      status: "applied",
      committedRecords: [committedFirst],
    });
    expect((await repository.listApplicationRecords())[0]).toEqual(
      committedFirst,
    );

    const nextFirst = ApplicationRecordSchema.parse({
      ...committedFirst,
      crm: { ...committedFirst.crm, revision: 4, stage: "interview" },
    });
    await repository.upsertApplicationRecord(
      ApplicationRecordSchema.parse({
        ...second,
        crm: { ...second.crm, revision: 2, stage: "recruiter_contact" },
      }),
    );
    await expect(
      repository.commitApplicationRecordBatch({
        expectedRevisions: [
          { applicationRecordId: first.id, expectedRevision: 3 },
          { applicationRecordId: second.id, expectedRevision: 1 },
        ],
        records: [nextFirst],
      }),
    ).resolves.toEqual({ status: "stale", recordIds: [second.id] });
    expect((await repository.listApplicationRecords())[0]).toEqual(
      committedFirst,
    );
  });

  test("returns cloned values and supports asset and attempt upserts", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const profile = await repository.getProfile();

    profile.fullName = "Changed locally";

    const freshProfile = await repository.getProfile();

    expect(freshProfile.fullName).toBe("Alex Vanguard");

    await repository.upsertTailoredAsset({
      id: "asset_1",
      jobId: "job_1",
      kind: "resume",
      status: "ready",
      label: "Tailored Resume",
      version: "v1",
      templateName: "Chronology Classic",
      compatibilityScore: 98,
      progressPercent: 100,
      updatedAt: "2026-03-20T10:05:00.000Z",
      storagePath: null,
      contentText: "Resume text",
      previewSections: [],
      generationMethod: "deterministic",
      notes: [],
      failureMessage: null,
      failedAt: null,
    });

    await repository.upsertApplicationAttempt({
      id: "attempt_1",
      jobId: "job_1",
      state: "submitted",
      summary: "Easy Apply submitted",
      detail: "Submitted successfully.",
      startedAt: "2026-03-20T10:04:00.000Z",
      updatedAt: "2026-03-20T10:05:00.000Z",
      completedAt: "2026-03-20T10:05:00.000Z",
      outcome: "submitted",
      questions: [],
      blocker: null,
      consentDecisions: [],
      replay: {
        sourceInstructionArtifactId: null,
        sourceDebugEvidenceRefIds: [],
        lastUrl: "https://jobs.example.com/roles/job_1/apply",
        checkpointUrls: ["https://jobs.example.com/roles/job_1/apply"],
      },
      nextActionLabel: "Monitor inbox",
      checkpoints: [],
    });

    const assets = await repository.listTailoredAssets();
    const attempts = await repository.listApplicationAttempts();

    expect(assets).toHaveLength(1);
    expect(assets[0]?.contentText).toBe("Resume text");
    expect(attempts[0]?.state).toBe("submitted");

    await repository.reset(createSeed());

    const resetAssets = await repository.listTailoredAssets();
    const resetAttempts = await repository.listApplicationAttempts();

    expect(resetAssets).toHaveLength(0);
    expect(resetAttempts).toHaveLength(0);
  });

  test("stores and resets profile setup state", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());

    await repository.saveProfileSetupState({
      status: "in_progress",
      currentStep: "targeting",
      completedAt: null,
      reviewItems: [
        {
          id: "review_1",
          step: "essentials",
          target: { domain: "identity", key: "headline", recordId: null },
          label: "Headline",
          reason: "Headline still needs a quick confirmation.",
          severity: "recommended",
          status: "pending",
          proposedValue: "Senior Product Designer",
          sourceSnippet: "Senior Product Designer",
          sourceCandidateId: null,
          sourceRunId: null,
          createdAt: "2026-04-11T10:00:00.000Z",
          resolvedAt: null,
        },
      ],
      lastResumedAt: "2026-04-11T10:05:00.000Z",
    });

    await expect(repository.getProfileSetupState()).resolves.toEqual(
      expect.objectContaining({
        status: "in_progress",
        currentStep: "targeting",
      }),
    );

    // Guided setup is five steps now, so the retired `ready_check` step
    // migrates to the step that owns the finish action at parse time.
    await repository.saveProfileSetupState({
      status: "completed",
      currentStep: "ready_check",
      completedAt: "2026-04-11T10:06:00.000Z",
      reviewItems: [],
      lastResumedAt: null,
    });

    await expect(repository.getProfileSetupState()).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        currentStep: "targeting",
      }),
    );

    await repository.reset(createSeed());

    // The seed still carries the legacy step, so reset proves the same
    // migration applies to seeded workspaces.
    await expect(repository.getProfileSetupState()).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
        currentStep: "targeting",
      }),
    );
  });

  test("stores resume workspace collections with the expected ordering", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());

    await repository.upsertResumeDraft({
      id: "resume_draft_old",
      jobId: "job_1",
      status: "draft",
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "manual",
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:00:00.000Z",
    });
    await repository.upsertResumeDraft({
      id: "resume_draft_new",
      jobId: "job_1",
      status: "needs_review",
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "ai",
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      createdAt: "2026-03-20T10:05:00.000Z",
      updatedAt: "2026-03-20T10:06:00.000Z",
    });
    await repository.upsertResumeDraftRevision({
      id: "revision_1",
      draftId: "resume_draft_new",
      parentRevisionId: null,
      actor: "user",
      mutationKind: "manual_save",
      snapshotDraft: null,
      beforeHash: null,
      afterHash: null,
      diff: null,
      restoredFromRevisionId: null,
      snapshotIdentity: null,
      snapshotSections: [],
      createdAt: "2026-03-20T10:06:30.000Z",
      reason: "Initial save",
    });
    await repository.upsertResumeExportArtifact({
      id: "resume_export_1",
      draftId: "resume_draft_new",
      jobId: "job_1",
      format: "pdf",
      filePath: "/tmp/resume-1.pdf",
      pageCount: 2,
      templateId: "classic_ats",
      exportedAt: "2026-03-20T10:07:00.000Z",
      isApproved: false,
    });
    await repository.upsertResumeResearchArtifact({
      id: "resume_research_1",
      jobId: "job_1",
      sourceUrl: "https://example.com/about",
      pageTitle: "About",
      fetchedAt: "2026-03-20T10:04:00.000Z",
      extractedText: "Example about page.",
      companyNotes: null,
      domainVocabulary: ["workflow"],
      priorityThemes: ["systems"],
      fetchStatus: "success",
    });
    await repository.upsertResumeValidationResult({
      id: "resume_validation_1",
      draftId: "resume_draft_new",
      issues: [],
      draftContentHash: null,
      claimAssessments: [],
      coverageComparison: null,
      pageCount: 2,
      validatedAt: "2026-03-20T10:06:45.000Z",
    });
    await repository.upsertResumeAssistantMessage({
      id: "assistant_message_1",
      jobId: "job_1",
      role: "assistant",
      content: "Tightened the summary.",
      patches: [],
      proposalStatus: "none",
      baseDraftUpdatedAt: null,
      resolvedPatchIds: [],
      resolvedAt: null,
      proposalError: null,
      createdAt: "2026-03-20T10:06:40.000Z",
    });

    await expect(repository.getResumeDraftByJobId("job_1")).resolves.toEqual(
      expect.objectContaining({ id: "resume_draft_new" }),
    );
    await expect(repository.listResumeDrafts()).resolves.toEqual([
      expect.objectContaining({ id: "resume_draft_new" }),
      expect.objectContaining({ id: "resume_draft_old" }),
    ]);
    await expect(
      repository.listResumeDraftRevisions("resume_draft_new"),
    ).resolves.toEqual([expect.objectContaining({ id: "revision_1" })]);
    await expect(
      repository.listResumeExportArtifacts({ jobId: "job_1" }),
    ).resolves.toEqual([expect.objectContaining({ id: "resume_export_1" })]);
    await expect(
      repository.listResumeResearchArtifacts("job_1"),
    ).resolves.toEqual([expect.objectContaining({ id: "resume_research_1" })]);
    await expect(
      repository.listResumeValidationResults("resume_draft_new"),
    ).resolves.toEqual([
      expect.objectContaining({ id: "resume_validation_1" }),
    ]);
    await expect(
      repository.listResumeAssistantMessages("job_1"),
    ).resolves.toEqual([
      expect.objectContaining({ id: "assistant_message_1" }),
    ]);
  });

  test("retains only the newest 100 revisions per draft for direct and atomic writes", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const draft = createRetentionDraft(
      "resume_draft_retained",
      "2026-07-30T10:00:00.000Z",
    );
    await repository.upsertResumeDraft(draft);
    await repository.upsertResumeDraftRevision(
      createRetentionRevision("resume_draft_other", 0),
    );

    for (
      let index = 0;
      index <= MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT;
      index += 1
    ) {
      await repository.upsertResumeDraftRevision(
        createRetentionRevision(draft.id, index),
      );
    }

    const directlyRetained = await repository.listResumeDraftRevisions(
      draft.id,
    );
    expect(directlyRetained).toHaveLength(MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT);
    expect(directlyRetained[0]?.id).toBe(`${draft.id}_revision_100`);
    expect(directlyRetained.at(-1)?.id).toBe(`${draft.id}_revision_001`);
    await expect(
      repository.listResumeDraftRevisions("resume_draft_other"),
    ).resolves.toHaveLength(1);

    const nextDraft = ResumeDraftSchema.parse({
      ...draft,
      updatedAt: "2026-07-30T10:02:00.000Z",
    });
    await repository.applyResumePatchWithRevision({
      expectedDraftUpdatedAt: draft.updatedAt,
      draft: nextDraft,
      revision: createRetentionRevision(draft.id, 101),
      validation: ResumeValidationResultSchema.parse({
        id: "validation_retained_101",
        draftId: draft.id,
        issues: [],
        draftContentHash: null,
        claimAssessments: [],
        pageCount: null,
        validatedAt: nextDraft.updatedAt,
      }),
    });

    const atomicallyRetained = await repository.listResumeDraftRevisions(
      draft.id,
    );
    expect(atomicallyRetained).toHaveLength(
      MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT,
    );
    expect(atomicallyRetained[0]?.id).toBe(`${draft.id}_revision_101`);
    expect(atomicallyRetained.at(-1)?.id).toBe(`${draft.id}_revision_002`);
    await expect(
      repository.listResumeDraftRevisions("resume_draft_other"),
    ).resolves.toHaveLength(1);
  });
  test("stores apply foundation records with filtering support", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());

    await repository.upsertApplyRun({
      id: "apply_run_1",
      campaignId: null,
      mode: "copilot",
      state: "paused_for_user_review",
      jobIds: ["job_1"],
      currentJobId: "job_1",
      submitApprovalId: null,
      visualCheckpointsEnabled: false,
      createdAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:03:00.000Z",
      completedAt: null,
      summary: "Apply copilot captured the current application state.",
      detail: "Stopped before final submit.",
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    });
    await repository.upsertApplyJobResult({
      id: "apply_result_1",
      runId: "apply_run_1",
      jobId: "job_1",
      queuePosition: 0,
      state: "awaiting_review",
      summary: "Questions captured and answers proposed.",
      detail: "The run paused for user review before submit.",
      startedAt: "2026-04-18T10:00:00.000Z",
      updatedAt: "2026-04-18T10:02:00.000Z",
      completedAt: null,
      blockerReason: null,
      blockerSummary: null,
      latestQuestionCount: 1,
      latestAnswerCount: 1,
      pendingConsentRequestCount: 0,
      artifactCount: 1,
      latestCheckpointId: "checkpoint_1",
    });
    await repository.upsertApplicationQuestionRecord({
      id: "question_1",
      runId: "apply_run_1",
      jobId: "job_1",
      resultId: "apply_result_1",
      prompt: "Upload your resume",
      kind: "resume",
      isRequired: true,
      detectedAt: "2026-04-18T10:00:30.000Z",
      answerOptions: [],
      suggestedAnswers: [],
      selectedAnswerId: "answer_1",
      submittedAnswer: null,
      status: "answered",
      pageUrl: "https://jobs.example.com/apply",
    });
    await repository.upsertApplicationAnswerRecord({
      id: "answer_1",
      runId: "apply_run_1",
      jobId: "job_1",
      applicationRecordId: null,
      resultId: "apply_result_1",
      questionId: "question_1",
      status: "filled",
      text: "Approved tailored resume selected",
      value: {
        type: "asset_ref",
        assetId: "resume_export_1",
      },
      revision: 1,
      saveScope: "application_once",
      supersedesAnswerId: null,
      sourceKind: "resume",
      sourceId: "resume_export_1",
      confidenceLabel: "high",
      provenance: [],
      createdAt: "2026-04-18T10:00:35.000Z",
      submittedAt: null,
    });
    await repository.upsertApplicationArtifactRef({
      id: "artifact_1",
      runId: "apply_run_1",
      jobId: "job_1",
      resultId: "apply_result_1",
      questionId: "question_1",
      kind: "uploaded_asset",
      label: "Approved tailored resume export",
      createdAt: "2026-04-18T10:00:40.000Z",
      storagePath: "/tmp/job-ready-resume.pdf",
      url: null,
      textSnippet: null,
    });
    await repository.upsertApplicationReplayCheckpoint({
      id: "checkpoint_1",
      runId: "apply_run_1",
      jobId: "job_1",
      resultId: "apply_result_1",
      createdAt: "2026-04-18T10:00:45.000Z",
      label: "Reached review screen",
      detail: "The application is ready for user review.",
      url: "https://jobs.example.com/apply/review",
      jobState: "awaiting_review",
      artifactRefIds: ["artifact_1"],
    });
    await repository.upsertApplicationConsentRequest({
      id: "consent_1",
      runId: "apply_run_1",
      jobId: "job_1",
      applicationRecordId: null,
      resultId: "apply_result_1",
      kind: "resume_use",
      linkedConsentKind: "resume_use",
      label: "Use the approved tailored resume for this apply run",
      detail: null,
      status: "approved",
      requestedAt: "2026-04-18T10:00:20.000Z",
      decidedAt: "2026-04-18T10:00:25.000Z",
      expiresAt: null,
    });

    await expect(repository.listApplyRuns()).resolves.toEqual([
      expect.objectContaining({ id: "apply_run_1" }),
    ]);
    await expect(repository.listApplyJobResults()).resolves.toEqual([
      expect.objectContaining({ id: "apply_result_1" }),
    ]);
    await expect(
      repository.listApplicationQuestionRecords({
        runId: "apply_run_1",
        jobId: "job_1",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "question_1" })]);
    await expect(
      repository.listApplicationAnswerRecords({ questionId: "question_1" }),
    ).resolves.toEqual([expect.objectContaining({ id: "answer_1" })]);
    await expect(
      repository.listApplicationArtifactRefs({ resultId: "apply_result_1" }),
    ).resolves.toEqual([expect.objectContaining({ id: "artifact_1" })]);
    await expect(
      repository.listApplicationReplayCheckpoints({ jobId: "job_1" }),
    ).resolves.toEqual([expect.objectContaining({ id: "checkpoint_1" })]);
    await expect(
      repository.listApplicationConsentRequests({ runId: "apply_run_1" }),
    ).resolves.toEqual([expect.objectContaining({ id: "consent_1" })]);
  });

  test("marks application preparation once and preserves it across result writes", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const baseline = ApplyJobResultSchema.parse({
      id: "result_preparation",
      runId: "run_preparation",
      jobId: "job_1",
      state: "planned",
      summary: "Application planned.",
      detail: "Waiting to prepare.",
      startedAt: "2026-08-23T09:00:00.000Z",
      updatedAt: "2026-08-23T09:00:00.000Z",
      applicationPreparationStartedAt: null,
      applicationPreparationStartedLocalDate: null,
    });
    await repository.upsertApplyJobResult(baseline);

    await expect(
      repository.markApplicationPreparationStarted({
        resultId: "missing_result",
        runId: baseline.runId,
        jobId: baseline.jobId,
        startedAt: "2026-08-23T10:00:00.000Z",
        startedLocalDate: "2026-08-23",
      }),
    ).rejects.toThrow("does not exist");

    const first = await repository.markApplicationPreparationStarted({
      resultId: baseline.id,
      runId: baseline.runId,
      jobId: baseline.jobId,
      startedAt: "2026-08-23T10:00:00.000Z",
      startedLocalDate: "2026-08-23",
    });
    const repeat = await repository.markApplicationPreparationStarted({
      resultId: baseline.id,
      runId: baseline.runId,
      jobId: baseline.jobId,
      startedAt: "2026-08-24T10:00:00.000Z",
      startedLocalDate: "2026-08-24",
    });
    expect(first.didStart).toBe(true);
    expect(repeat).toEqual({ result: first.result, didStart: false });

    const concurrentBaseline = ApplyJobResultSchema.parse({
      ...baseline,
      id: "result_preparation_concurrent",
      jobId: "job_concurrent",
    });
    await repository.upsertApplyJobResult(concurrentBaseline);
    const concurrent = await Promise.all([
      repository.markApplicationPreparationStarted({
        resultId: concurrentBaseline.id,
        runId: concurrentBaseline.runId,
        jobId: concurrentBaseline.jobId,
        startedAt: "2026-08-23T11:00:00.000Z",
        startedLocalDate: "2026-08-23",
      }),
      repository.markApplicationPreparationStarted({
        resultId: concurrentBaseline.id,
        runId: concurrentBaseline.runId,
        jobId: concurrentBaseline.jobId,
        startedAt: "2026-08-24T11:00:00.000Z",
        startedLocalDate: "2026-08-24",
      }),
    ]);
    expect(concurrent.filter((outcome) => outcome.didStart)).toHaveLength(1);
    expect(concurrent[0]?.result).toEqual(concurrent[1]?.result);

    await expect(
      repository.markApplicationPreparationStarted({
        resultId: baseline.id,
        runId: "wrong_run",
        jobId: baseline.jobId,
        startedAt: "2026-08-25T10:00:00.000Z",
        startedLocalDate: "2026-08-25",
      }),
    ).rejects.toThrow("lineage");
    expect(() =>
      repository.upsertApplyJobResult({
        ...first.result,
        applicationPreparationStartedAt: null,
        applicationPreparationStartedLocalDate: null,
      }),
    ).toThrow("immutable");
    expect(() =>
      repository.compareAndSwapApplyJobResult({
        expected: first.result,
        result: {
          ...first.result,
          applicationPreparationStartedAt: "2026-08-25T10:00:00.000Z",
          applicationPreparationStartedLocalDate: "2026-08-25",
        },
      }),
    ).toThrow("immutable");

    await expect(
      repository.compareAndSwapApplyJobResult({
        expected: baseline,
        result: {
          ...baseline,
          state: "failed",
          completedAt: "2026-08-23T10:04:00.000Z",
          updatedAt: "2026-08-23T10:04:00.000Z",
        },
      }),
    ).resolves.toBe(false);

    await expect(
      repository.compareAndSwapApplyJobResult({
        expected: first.result,
        result: {
          ...first.result,
          state: "failed",
          completedAt: "2026-08-23T10:05:00.000Z",
          updatedAt: "2026-08-23T10:05:00.000Z",
        },
      }),
    ).resolves.toBe(true);
  });

  test("filters application persistence by exact application record lineage", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const resultBase = {
      jobId: "job_shared",
      queuePosition: 0,
      state: "planned" as const,
      summary: "Application planned.",
      detail: "Waiting to prepare.",
      startedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:00.000Z",
    };
    await repository.upsertApplyJobResult({
      ...resultBase,
      id: "result_a",
      runId: "run_a",
      applicationRecordId: "application_a",
    });
    await repository.upsertApplyJobResult({
      ...resultBase,
      id: "result_b",
      runId: "run_b",
      applicationRecordId: "application_b",
    });
    await repository.upsertApplicationQuestionRecord({
      id: "question_a",
      runId: "run_a",
      jobId: "job_shared",
      applicationRecordId: "application_a",
      resultId: "result_a",
      prompt: "Question A",
      detectedAt: "2026-08-23T10:01:00.000Z",
    });
    await repository.upsertApplicationQuestionRecord({
      id: "question_b",
      runId: "run_b",
      jobId: "job_shared",
      applicationRecordId: "application_b",
      resultId: "result_b",
      prompt: "Question B",
      detectedAt: "2026-08-23T10:01:01.000Z",
    });
    await repository.upsertApplicationAttempt({
      id: "attempt_a",
      jobId: "job_shared",
      applicationRecordId: "application_a",
      state: "in_progress",
      summary: "Preparing A",
      detail: "Preparing A",
      startedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:01:00.000Z",
      completedAt: null,
      outcome: null,
      nextActionLabel: null,
    });

    await expect(
      repository.listApplyJobResults({ applicationRecordId: "application_a" }),
    ).resolves.toEqual([expect.objectContaining({ id: "result_a" })]);
    await expect(
      repository.listApplicationQuestionRecords({
        applicationRecordId: "application_b",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "question_b" })]);
    await expect(
      repository.listApplicationAttempts({
        applicationRecordId: "application_a",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "attempt_a" })]);
  });

  test("stores profile copilot messages and revisions with the expected ordering", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const seed = createSeed();

    await repository.upsertProfileCopilotMessage({
      id: "profile_message_older",
      role: "assistant",
      content: "I found a few profile improvements.",
      context: { surface: "general" },
      patchGroups: [],
      createdAt: "2026-04-11T10:05:00.000Z",
    });
    await repository.upsertProfileCopilotMessage({
      id: "profile_message_newer",
      role: "assistant",
      content: "I can tighten your headline for product roles.",
      context: { surface: "setup", step: "essentials" },
      patchGroups: [
        {
          id: "profile_patch_group_1",
          summary: "Refine your headline",
          applyMode: "needs_review",
          operations: [
            {
              operation: "replace_identity_fields",
              value: {
                headline: "Principal Product Designer",
              },
            },
          ],
          createdAt: "2026-04-11T10:06:00.000Z",
        },
      ],
      createdAt: "2026-04-11T10:06:00.000Z",
    });

    await repository.upsertProfileRevision({
      id: "profile_revision_older",
      createdAt: "2026-04-11T10:06:30.000Z",
      reason: "Applied a safe headline refinement.",
      sequence: 1,
      snapshotProfileAfter: null,
      snapshotSearchPreferencesAfter: null,
      snapshotResumeApplicationMode: null,
      snapshotResumeApplicationModeAfter: null,
      trigger: "assistant_patch",
      messageId: "profile_message_newer",
      patchGroupId: "profile_patch_group_1",
      restoredFromRevisionId: null,
      snapshotProfile: seed.profile,
      snapshotSearchPreferences: seed.searchPreferences,
      snapshotProfileSetupState: seed.profileSetupState,
    });
    await repository.upsertProfileRevision({
      id: "profile_revision_newer",
      createdAt: "2026-04-11T10:07:00.000Z",
      reason: "Undid the last assistant suggestion.",
      sequence: 2,
      snapshotProfileAfter: null,
      snapshotSearchPreferencesAfter: null,
      snapshotResumeApplicationMode: null,
      snapshotResumeApplicationModeAfter: null,
      trigger: "undo",
      messageId: null,
      patchGroupId: "profile_patch_group_1",
      restoredFromRevisionId: "profile_revision_older",
      snapshotProfile: {
        ...seed.profile,
        headline: "Principal Product Designer",
      },
      snapshotSearchPreferences: seed.searchPreferences,
      snapshotProfileSetupState: {
        ...seed.profileSetupState,
        status: "in_progress",
        currentStep: "essentials",
        completedAt: null,
      },
    });

    await expect(repository.listProfileCopilotMessages()).resolves.toEqual([
      expect.objectContaining({ id: "profile_message_older" }),
      expect.objectContaining({
        id: "profile_message_newer",
        patchGroups: [expect.objectContaining({ id: "profile_patch_group_1" })],
      }),
    ]);
    await expect(repository.listProfileRevisions()).resolves.toEqual([
      expect.objectContaining({ id: "profile_revision_newer" }),
      expect.objectContaining({ id: "profile_revision_older" }),
    ]);

    await repository.reset(createSeed());

    await expect(repository.listProfileCopilotMessages()).resolves.toEqual([]);
    await expect(repository.listProfileRevisions()).resolves.toEqual([]);
  });

  test("commits profile copilot state atomically", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);

    await repository.commitProfileCopilotState({
      profile: {
        ...seed.profile,
        headline: "Principal Product Designer",
      },
      searchPreferences: {
        ...seed.searchPreferences,
        targetSalaryUsd: 220000,
        compensation: {
          ...seed.searchPreferences.compensation,
          maximum: 220000,
        },
      },
      profileSetupState: {
        ...seed.profileSetupState,
        status: "in_progress",
        currentStep: "essentials",
        completedAt: null,
      },
      messages: [
        {
          id: "profile_message_atomic",
          role: "assistant",
          content: "Applied a safe profile update.",
          context: { surface: "setup", step: "essentials" },
          patchGroups: [],
          createdAt: "2026-04-15T10:00:00.000Z",
        },
      ],
      revisions: [
        {
          id: "profile_revision_atomic",
          createdAt: "2026-04-15T10:00:01.000Z",
          reason: "Atomic assistant patch.",
          sequence: 3,
          snapshotProfileAfter: null,
          snapshotSearchPreferencesAfter: null,
          snapshotResumeApplicationMode: null,
          snapshotResumeApplicationModeAfter: null,
          trigger: "assistant_patch",
          messageId: "profile_message_atomic",
          patchGroupId: null,
          restoredFromRevisionId: null,
          snapshotProfile: seed.profile,
          snapshotSearchPreferences: seed.searchPreferences,
          snapshotProfileSetupState: seed.profileSetupState,
        },
      ],
    });

    await expect(repository.getProfile()).resolves.toEqual(
      expect.objectContaining({ headline: "Principal Product Designer" }),
    );
    await expect(repository.getSearchPreferences()).resolves.toEqual(
      expect.objectContaining({ targetSalaryUsd: 220000 }),
    );
    await expect(repository.getProfileSetupState()).resolves.toEqual(
      expect.objectContaining({
        status: "in_progress",
        currentStep: "essentials",
      }),
    );
    await expect(repository.listProfileCopilotMessages()).resolves.toEqual([
      expect.objectContaining({ id: "profile_message_atomic" }),
    ]);
    await expect(repository.listProfileRevisions()).resolves.toEqual([
      expect.objectContaining({ id: "profile_revision_atomic" }),
    ]);
  });

  test("applies aggregate resume approval updates atomically", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());

    // Seed the already-approved export through the only supported approval
    // path. Neither repository accepts an approved artifact through
    // upsertResumeExportArtifact, because only approveResumeExport demotes
    // the job's sibling exports.
    await repository.approveResumeExport({
      draft: {
        id: "resume_draft_1",
        jobId: "job_1",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "ai",
        approvedAt: "2026-03-20T10:00:00.000Z",
        approvedExportId: "resume_export_old",
        staleReason: null,
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:00:00.000Z",
      },
      exportArtifact: {
        id: "resume_export_old",
        draftId: "resume_draft_1",
        jobId: "job_1",
        format: "pdf",
        filePath: "/tmp/old.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:00:00.000Z",
        isApproved: true,
      },
    });

    await repository.approveResumeExport({
      draft: {
        id: "resume_draft_1",
        jobId: "job_1",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "ai",
        approvedAt: "2026-03-20T10:07:00.000Z",
        approvedExportId: "resume_export_new",
        staleReason: null,
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:07:00.000Z",
      },
      exportArtifact: {
        id: "resume_export_new",
        draftId: "resume_draft_1",
        jobId: "job_1",
        format: "pdf",
        filePath: "/tmp/new.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:07:00.000Z",
        isApproved: true,
      },
      validation: {
        id: "resume_validation_1",
        draftId: "resume_draft_1",
        issues: [],
        draftContentHash: null,
        claimAssessments: [],
        coverageComparison: null,
        pageCount: 2,
        validatedAt: "2026-03-20T10:06:50.000Z",
      },
      tailoredAsset: {
        id: "asset_1",
        jobId: "job_1",
        kind: "resume",
        status: "ready",
        label: "Tailored Resume",
        version: "v2",
        templateName: "Chronology Classic",
        compatibilityScore: 97,
        progressPercent: 100,
        updatedAt: "2026-03-20T10:07:00.000Z",
        storagePath: "/tmp/new.pdf",
        contentText: "Resume text",
        previewSections: [],
        generationMethod: "ai_assisted",
        notes: [],
        failureMessage: null,
        failedAt: null,
      },
    });

    const exports = await repository.listResumeExportArtifacts({
      jobId: "job_1",
    });
    const draft = await repository.getResumeDraftByJobId("job_1");
    const tailoredAssets = await repository.listTailoredAssets();

    expect(
      exports.find((entry) => entry.id === "resume_export_new")?.isApproved,
    ).toBe(true);
    expect(
      exports.find((entry) => entry.id === "resume_export_old")?.isApproved,
    ).toBe(false);
    expect(draft?.approvedExportId).toBe("resume_export_new");
    expect(tailoredAssets[0]?.storagePath).toBe("/tmp/new.pdf");
  });

  test("clears approved export flags when a draft becomes stale", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());

    // Seed the already-approved export through the only supported approval
    // path. Neither repository accepts an approved artifact through
    // upsertResumeExportArtifact, because only approveResumeExport demotes
    // the job's sibling exports.
    await repository.approveResumeExport({
      draft: {
        id: "resume_draft_1",
        jobId: "job_1",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "ai",
        approvedAt: "2026-03-20T10:00:00.000Z",
        approvedExportId: "resume_export_old",
        staleReason: null,
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:00:00.000Z",
      },
      exportArtifact: {
        id: "resume_export_old",
        draftId: "resume_draft_1",
        jobId: "job_1",
        format: "pdf",
        filePath: "/tmp/old.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:00:00.000Z",
        isApproved: true,
      },
    });

    await repository.saveResumeDraftWithValidation({
      draft: {
        id: "resume_draft_1",
        jobId: "job_1",
        status: "stale",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "ai",
        approvedAt: null,
        approvedExportId: null,
        staleReason: "Draft changed after approval and needs a fresh review.",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:08:00.000Z",
      },
      validation: {
        id: "resume_validation_1",
        draftId: "resume_draft_1",
        issues: [],
        draftContentHash: null,
        claimAssessments: [],
        coverageComparison: null,
        pageCount: 2,
        validatedAt: "2026-03-20T10:08:00.000Z",
      },
      tailoredAsset: {
        id: "asset_1",
        jobId: "job_1",
        kind: "resume",
        status: "ready",
        label: "Tailored Resume",
        version: "v2",
        templateName: "Chronology Classic",
        compatibilityScore: 97,
        progressPercent: 100,
        updatedAt: "2026-03-20T10:08:00.000Z",
        storagePath: null,
        contentText: "Resume text",
        previewSections: [],
        generationMethod: "ai_assisted",
        notes: [],
        failureMessage: null,
        failedAt: null,
      },
    });

    const exports = await repository.listResumeExportArtifacts({
      jobId: "job_1",
    });

    expect(
      exports.find((entry) => entry.id === "resume_export_old")?.isApproved,
    ).toBe(false);
  });

  test("finalizes resume import state atomically", async () => {
    const seed = createSeed();
    const repository = createInMemoryJobFinderRepository(seed);

    await repository.finalizeResumeImportRun({
      profile: {
        ...seed.profile,
        fullName: "Taylor Rivera",
      },
      searchPreferences: {
        ...seed.searchPreferences,
        targetRoles: ["Staff Product Designer"],
      },
      run: {
        id: "resume_import_run_atomic",
        sourceResumeId: seed.profile.baseResume.id,
        sourceResumeFileName: seed.profile.baseResume.fileName,
        trigger: "import",
        status: "applied",
        startedAt: "2026-04-15T10:10:00.000Z",
        completedAt: "2026-04-15T10:10:10.000Z",
        primaryParserKind: "plain_text",
        parserKinds: ["plain_text"],
        analysisProviderKind: null,
        analysisProviderLabel: null,
        warnings: [],
        errorMessage: null,
        candidateCounts: {
          total: 1,
          autoApplied: 1,
          needsReview: 0,
          rejected: 0,
          abstained: 0,
        },
      },
      documentBundles: [
        {
          id: "resume_bundle_atomic",
          runId: "resume_import_run_atomic",
          sourceResumeId: seed.profile.baseResume.id,
          sourceFileKind: "plain_text",
          primaryParserKind: "plain_text",
          parserKinds: ["plain_text"],
          createdAt: "2026-04-15T10:10:00.000Z",
          languageHints: [],
          warnings: [],
          pages: [],
          blocks: [],
          fullText: "Taylor Rivera",
        },
      ],
      fieldCandidates: [
        {
          id: "resume_candidate_atomic",
          runId: "resume_import_run_atomic",
          target: { section: "identity", key: "fullName", recordId: null },
          sourceKind: "parser_literal",
          resolution: "auto_applied",
          label: "Full name",
          value: "Taylor Rivera",
          normalizedValue: "Taylor Rivera",
          valuePreview: "Taylor Rivera",
          sourceBlockIds: [],
          evidenceText: "Taylor Rivera",
          confidence: 0.99,
          confidenceBreakdown: null,
          notes: [],
          alternatives: [],
          createdAt: "2026-04-15T10:10:05.000Z",
          resolvedAt: "2026-04-15T10:10:10.000Z",
          resolutionReason: "grounded_literal_match",
        },
      ],
    });

    await expect(repository.getProfile()).resolves.toEqual(
      expect.objectContaining({ fullName: "Taylor Rivera" }),
    );
    await expect(repository.getSearchPreferences()).resolves.toEqual(
      expect.objectContaining({ targetRoles: ["Staff Product Designer"] }),
    );
    await expect(
      repository.getLatestResumeImportRun(seed.profile.baseResume.id),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "resume_import_run_atomic",
        status: "applied",
      }),
    );
    await expect(
      repository.listResumeImportDocumentBundles({
        runId: "resume_import_run_atomic",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "resume_bundle_atomic" }),
    ]);
    await expect(
      repository.listResumeImportFieldCandidates({
        runId: "resume_import_run_atomic",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "resume_candidate_atomic" }),
    ]);
  });

  test("atomically replaces saved jobs while clearing resume approval", async () => {
    const seed = createSeed();
    seed.savedJobs = [
      SavedJobSchema.parse({
        id: "job_ready",
        source: "target_site",
        sourceJobId: "target_job_ready",
        discoveryMethod: "catalog_seed",
        canonicalUrl: "https://jobs.example.com/roles/target_job_ready",
        applicationUrl: "https://jobs.example.com/roles/target_job_ready/apply",
        title: "Lead Designer",
        company: "Signal Systems",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T10:00:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T10:01:00.000Z",
        firstSeenAt: "2026-03-20T10:01:00.000Z",
        lastSeenAt: "2026-03-20T10:01:00.000Z",
        lastVerifiedActiveAt: "2026-03-20T10:01:00.000Z",
        salaryText: "$180k",
        normalizedCompensation: {
          currency: "USD",
          interval: "year",
          minAmount: 180000,
          maxAmount: 180000,
          minAnnualUsd: 180000,
          maxAnnualUsd: 180000,
        },
        summary: "Lead product design.",
        description: "Lead product design for operational software.",
        keySkills: ["Figma"],
        responsibilities: [],
        minimumQualifications: [],
        preferredQualifications: [],
        seniority: null,
        employmentType: null,
        department: null,
        team: null,
        employerWebsiteUrl: null,
        employerDomain: null,
        atsProvider: null,
        screeningHints: {
          sponsorshipText: null,
          requiresSecurityClearance: null,
          relocationText: null,
          travelText: null,
          remoteGeographies: [],
        },
        keywordSignals: [],
        benefits: [],
        status: "ready_for_review",
        matchAssessment: {
          score: 94,
          reasons: ["Strong overlap"],
          gaps: [],
        },
        provenance: [],
      }),
    ];
    const repository = createInMemoryJobFinderRepository(seed);

    // Seed the approved draft and its approved export through the only
    // supported approval path; upsertResumeExportArtifact refuses an approved
    // artifact in both repositories.
    await repository.approveResumeExport({
      draft: {
        id: "resume_draft_1",
        jobId: "job_ready",
        status: "approved",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "ai",
        approvedAt: "2026-03-20T10:07:00.000Z",
        approvedExportId: "resume_export_old",
        staleReason: null,
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:07:00.000Z",
      },
      exportArtifact: {
        id: "resume_export_old",
        draftId: "resume_draft_1",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/old.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:06:00.000Z",
        isApproved: true,
      },
    });

    const savedJobs = await repository.listSavedJobs();
    const nextJobs = savedJobs.map((job) =>
      job.id === "job_ready"
        ? { ...job, description: `${job.description} Updated.` }
        : job,
    );

    await repository.replaceSavedJobsAndClearResumeApproval({
      savedJobs: nextJobs,
      draft: {
        id: "resume_draft_1",
        jobId: "job_ready",
        status: "stale",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "ai",
        approvedAt: null,
        approvedExportId: null,
        staleReason:
          "Saved job details changed after approval and the resume needs a fresh review.",
        workHistoryReviewAcknowledgments: [],
        claimConfirmations: [],
        issueApprovals: [],
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:08:00.000Z",
      },
      staleReason:
        "Saved job details changed after approval and the resume needs a fresh review.",
      tailoredAsset: {
        id: "asset_ready",
        jobId: "job_ready",
        kind: "resume",
        status: "ready",
        label: "Tailored Resume",
        version: "v2",
        templateName: "Chronology Classic",
        compatibilityScore: 97,
        progressPercent: 100,
        updatedAt: "2026-03-20T10:08:00.000Z",
        storagePath: null,
        contentText: "Resume text",
        previewSections: [],
        generationMethod: "deterministic",
        notes: [],
        failureMessage: null,
        failedAt: null,
      },
    });

    const refreshedJobs = await repository.listSavedJobs();
    const refreshedDraft = await repository.getResumeDraftByJobId("job_ready");
    const exports = await repository.listResumeExportArtifacts({
      jobId: "job_ready",
    });
    const assets = await repository.listTailoredAssets();

    expect(
      refreshedJobs.find((job) => job.id === "job_ready")?.description,
    ).toMatch(/Updated\./);
    expect(refreshedDraft?.status).toBe("stale");
    expect(refreshedDraft?.approvedExportId).toBeNull();
    expect(
      exports.find((entry) => entry.id === "resume_export_old")?.isApproved,
    ).toBe(false);
    expect(
      assets.find((asset) => asset.jobId === "job_ready")?.storagePath,
    ).toBeNull();
  });

  test("reset restores intelligence and campaign notifications exactly from the provided seed", async () => {
    const now = "2026-08-15T10:00:00.000Z";
    const later = "2026-08-15T11:00:00.000Z";
    const baseSeed = createSeed();
    const campaign = JobSearchCampaignSchema.parse({
      id: "campaign_seed",
      name: "Seed campaign",
      mode: "precision",
      status: "active",
      createdAt: now,
      updatedAt: now,
      searchPreferences: baseSeed.searchPreferences,
      sourceTargetIds: [],
      ...getDefaultCampaignConfiguration("precision"),
      schedule: {},
      progress: { lastUpdatedAt: now },
    });
    const createDecision = (input: {
      answerValue: string;
      updatedAt: string;
    }) =>
      GroupedManualAnswerDecisionSchema.parse({
        id: "decision_shared",
        groupKey: "group_shared",
        requestId: "request_1",
        applicationRecordId: "application_1",
        jobId: "job_1",
        questionId: "question_1",
        expectedRevision: 1,
        expectedQuestionRevision: 1,
        expectedAnswerRevision: 0,
        fingerprints: {
          questionMeaning: "a".repeat(64),
          answerPolicy: "b".repeat(64),
        },
        answer: { type: "text", value: input.answerValue },
        createdAt: now,
        updatedAt: input.updatedAt,
        lineage: [],
      });
    const createNotification = (input: {
      title: string;
      readAt: string | null;
    }) =>
      CampaignNotificationSchema.parse({
        id: "notification_shared",
        campaignId: campaign.id,
        kind: "strong_match",
        title: input.title,
        body: null,
        createdAt: now,
        readAt: input.readAt,
        unread: input.readAt === null,
      });

    const mutatedSeed = createSeed();
    mutatedSeed.campaigns = [campaign];
    mutatedSeed.activeCampaignId = campaign.id;
    mutatedSeed.campaignNotifications = [
      createNotification({ title: "Seeded strong match", readAt: null }),
    ];
    mutatedSeed.intelligence = JobFinderIntelligenceStateSchema.parse({
      groupedDecisions: [
        createDecision({ answerValue: "5 years", updatedAt: now }),
      ],
      updatedAt: now,
    });
    const repository = createInMemoryJobFinderRepository(mutatedSeed);

    await repository.saveIntelligenceState(
      JobFinderIntelligenceStateSchema.parse({
        groupedDecisions: [
          createDecision({ answerValue: "7 years", updatedAt: later }),
        ],
        updatedAt: later,
      }),
    );
    await repository.saveCampaignState({
      activeCampaignId: campaign.id,
      campaigns: [campaign],
      notifications: [
        createNotification({ title: "Mutated strong match", readAt: later }),
      ],
    });

    const resetSeed = createSeed();
    resetSeed.campaigns = [campaign];
    resetSeed.activeCampaignId = campaign.id;
    resetSeed.campaignNotifications = [
      createNotification({ title: "Reset strong match", readAt: null }),
    ];
    resetSeed.intelligence = JobFinderIntelligenceStateSchema.parse({
      groupedDecisions: [
        createDecision({ answerValue: "10 years", updatedAt: now }),
      ],
      updatedAt: now,
    });

    await repository.reset(resetSeed);

    await expect(repository.getIntelligenceState()).resolves.toEqual(
      resetSeed.intelligence,
    );
    await expect(repository.getCampaignState()).resolves.toEqual({
      campaigns: resetSeed.campaigns,
      activeCampaignId: resetSeed.activeCampaignId,
      notifications: resetSeed.campaignNotifications,
    });
  });
});
