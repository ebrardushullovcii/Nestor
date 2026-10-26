import { describe, expect, test } from "vitest";
import {
  ApplicationRecordSchema,
  CampaignNotificationSchema,
  getDefaultCampaignConfiguration,
  GroupedManualAnswerDecisionSchema,
  JobFinderIntelligenceStateSchema,
  JobFinderRepositoryStateSchema,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  JobSearchCampaignSchema,
  ProfileCopilotMessageSchema,
  SourceDebugRunRecordSchema,
  SourceInstructionArtifactSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";

import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
  type JobFinderRepositorySeed,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createResumeImportArtifactsFixture,
  createSavedJob,
  createTempRepository,
  savedJobData,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

const BASE_AT = "2026-08-20T10:00:00.000Z";
const DIRTY_AT = "2026-08-20T11:00:00.000Z";
const RESET_AT = "2026-08-20T12:00:00.000Z";

type ResetConformancePhase = "dirty" | "reset";

function phaseTimestamp(phase: ResetConformancePhase): string {
  return phase === "dirty" ? DIRTY_AT : RESET_AT;
}

function createDecision(input: { answerValue: string; updatedAt: string }) {
  return GroupedManualAnswerDecisionSchema.parse({
    id: "decision_shared",
    groupKey: "group_shared",
    requestId: "request_shared",
    applicationRecordId: "application_shared",
    jobId: "job_shared",
    questionId: "question_shared",
    expectedRevision: 1,
    expectedQuestionRevision: 1,
    expectedAnswerRevision: 0,
    fingerprints: {
      questionMeaning: "a".repeat(64),
      answerPolicy: "b".repeat(64),
    },
    answer: { type: "text", value: input.answerValue },
    createdAt: BASE_AT,
    updatedAt: input.updatedAt,
    lineage: [],
  });
}

function createCampaign(id: string, name: string, updatedAt: string) {
  return JobSearchCampaignSchema.parse({
    id,
    name,
    description: `${name} for reset conformance.`,
    mode: "precision",
    status: "active",
    createdAt: BASE_AT,
    updatedAt,
    searchPreferences: createSeed().searchPreferences,
    jobIds: [],
    ...getDefaultCampaignConfiguration("precision"),
    progress: { lastUpdatedAt: updatedAt },
  });
}

function createNotification(input: {
  id: string;
  campaignId: string;
  title: string;
  readAt: string | null;
}) {
  return CampaignNotificationSchema.parse({
    id: input.id,
    campaignId: input.campaignId,
    kind: "strong_match",
    title: input.title,
    body: null,
    createdAt: BASE_AT,
    readAt: input.readAt,
    unread: input.readAt === null,
  });
}

function createStateSliceFixtures(phase: ResetConformancePhase) {
  const at = phaseTimestamp(phase);
  const jobId = `job_${phase}`;
  const draftId = `resume_draft_${phase}`;
  const applyRunId = `apply_run_${phase}`;
  const applyResultId = `apply_result_${phase}`;
  const questionId = `question_${phase}`;
  const sourceDebugRunId = `source_debug_run_${phase}`;

  const importedArtifacts = createResumeImportArtifactsFixture();
  const importRun = {
    ...importedArtifacts.run,
    id: `resume_import_run_${phase}`,
  };
  const importBundles = importedArtifacts.documentBundles.map((bundle) => ({
    ...bundle,
    id: `${bundle.id}_${phase}`,
    runId: importRun.id,
  }));
  const importCandidates = importedArtifacts.fieldCandidates.map(
    (candidate) => ({
      ...candidate,
      id: `${candidate.id}_${phase}`,
      runId: importRun.id,
    }),
  );

  return {
    savedJob: createSavedJob({
      id: jobId,
      sourceJobId: `target_${jobId}`,
      title: `${phase} role`,
    }),
    tailoredAsset: {
      id: `asset_${phase}`,
      jobId,
      kind: "resume" as const,
      status: "ready" as const,
      label: `Tailored Resume ${phase}`,
      version: `v1-${phase}`,
      templateName: "Chronology Classic",
      compatibilityScore: 90,
      progressPercent: 100,
      updatedAt: at,
      storagePath: null,
      contentText: `${phase} resume text`,
      previewSections: [],
      generationMethod: "deterministic" as const,
      notes: [],
      failureMessage: null,
      failedAt: null,
    },
    resumeDraft: {
      id: draftId,
      jobId,
      status: "needs_review" as const,
      templateId: "classic_ats" as const,
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "manual" as const,
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      createdAt: BASE_AT,
      updatedAt: at,
    },
    resumeDraftRevision: {
      id: `revision_${phase}`,
      draftId,
      parentRevisionId: null,
      actor: "user" as const,
      mutationKind: "manual_save" as const,
      snapshotDraft: null,
      snapshotIdentity: null,
      snapshotSections: [],
      beforeHash: null,
      afterHash: null,
      diff: null,
      restoredFromRevisionId: null,
      createdAt: at,
      reason: `${phase} revision`,
    },
    resumeExportArtifact: {
      id: `resume_export_${phase}`,
      draftId,
      jobId,
      format: "pdf" as const,
      filePath: `/tmp/resume-${phase}.pdf`,
      pageCount: 2,
      templateId: "classic_ats" as const,
      exportedAt: at,
      isApproved: false,
    },
    resumeResearchArtifact: {
      id: `resume_research_${phase}`,
      jobId,
      sourceUrl: `https://example.com/${phase}/about`,
      pageTitle: `${phase} about page`,
      fetchedAt: at,
      extractedText: `${phase} company research.`,
      companyNotes: null,
      domainVocabulary: ["workflow"],
      priorityThemes: ["systems"],
      fetchStatus: "success" as const,
    },
    resumeValidationResult: {
      id: `resume_validation_${phase}`,
      draftId,
      issues: [],
      draftContentHash: null,
      claimAssessments: [],
      coverageComparison: null,
      pageCount: 2,
      validatedAt: at,
    },
    resumeAssistantMessage: {
      id: `assistant_message_${phase}`,
      jobId,
      role: "assistant" as const,
      content: `${phase} summary tightening.`,
      patches: [],
      proposalStatus: "none" as const,
      baseDraftUpdatedAt: null,
      resolvedPatchIds: [],
      resolvedAt: null,
      proposalError: null,
      createdAt: at,
    },
    profileCopilotMessage: ProfileCopilotMessageSchema.parse({
      id: `profile_message_${phase}`,
      role: "assistant",
      content: `${phase} profile suggestion.`,
      context: { surface: "general" },
      patchGroups: [],
      createdAt: at,
    }),
    profileRevision: (() => {
      const base = createSeed();
      return {
        id: `profile_revision_${phase}`,
        createdAt: at,
        reason: `${phase} profile revision.`,
        sequence: 1,
        snapshotProfileAfter: null,
        snapshotSearchPreferencesAfter: null,
        snapshotResumeApplicationMode: null,
        snapshotResumeApplicationModeAfter: null,
        trigger: "assistant_patch" as const,
        messageId: `profile_message_${phase}`,
        patchGroupId: null,
        restoredFromRevisionId: null,
        snapshotProfile: base.profile,
        snapshotSearchPreferences: base.searchPreferences,
        snapshotProfileSetupState: base.profileSetupState,
      };
    })(),
    applyRun: {
      id: applyRunId,
      campaignId: null,
      mode: "copilot" as const,
      state: "paused_for_user_review" as const,
      jobIds: [jobId],
      currentJobId: jobId,
      submitApprovalId: null,
      visualCheckpointsEnabled: false,
      createdAt: BASE_AT,
      updatedAt: at,
      completedAt: null,
      summary: `${phase} apply run paused.`,
      detail: `${phase} run stopped before final submit.`,
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    },
    applyJobResult: {
      id: applyResultId,
      runId: applyRunId,
      jobId,
      queuePosition: 0,
      state: "awaiting_review" as const,
      summary: `${phase} questions captured.`,
      detail: `${phase} run paused for review.`,
      startedAt: BASE_AT,
      updatedAt: at,
      completedAt: null,
      blockerReason: null,
      blockerSummary: null,
      latestQuestionCount: 1,
      latestAnswerCount: 1,
      pendingConsentRequestCount: 0,
      artifactCount: 1,
      latestCheckpointId: `checkpoint_${phase}`,
    },
    applySubmitApproval: {
      id: `submit_approval_${phase}`,
      runId: applyRunId,
      mode: "copilot" as const,
      jobIds: [jobId],
      status: "approved" as const,
      createdAt: BASE_AT,
      approvedAt: at,
      revokedAt: null,
      expiresAt: null,
      batchId: null,
      batchCampaignId: null,
      reusedFromApprovalId: null,
      detail: `${phase} submit approval.`,
    },
    questionRecord: {
      id: questionId,
      runId: applyRunId,
      jobId,
      resultId: applyResultId,
      prompt: "Upload your resume",
      kind: "resume" as const,
      isRequired: true,
      detectedAt: BASE_AT,
      answerOptions: [],
      suggestedAnswers: [],
      selectedAnswerId: `answer_${phase}`,
      submittedAnswer: null,
      status: "answered" as const,
      pageUrl: "https://jobs.example.com/apply",
    },
    answerRecord: {
      id: `answer_${phase}`,
      runId: applyRunId,
      jobId,
      applicationRecordId: null,
      resultId: applyResultId,
      questionId,
      status: "filled" as const,
      text: `${phase} resume selected`,
      value: {
        type: "asset_ref" as const,
        assetId: `resume_export_${phase}`,
      },
      revision: 1,
      saveScope: "application_once" as const,
      supersedesAnswerId: null,
      sourceKind: "resume" as const,
      sourceId: `resume_export_${phase}`,
      confidenceLabel: "high" as const,
      provenance: [],
      createdAt: at,
      submittedAt: null,
    },
    artifactRef: {
      id: `artifact_${phase}`,
      runId: applyRunId,
      jobId,
      resultId: applyResultId,
      questionId,
      kind: "uploaded_asset" as const,
      label: `${phase} uploaded resume`,
      createdAt: at,
      storagePath: `/tmp/${phase}-resume.pdf`,
      url: null,
      textSnippet: null,
    },
    replayCheckpoint: {
      id: `checkpoint_${phase}`,
      runId: applyRunId,
      jobId,
      resultId: applyResultId,
      createdAt: at,
      label: `${phase} reached review screen`,
      detail: `${phase} application ready for review.`,
      url: "https://jobs.example.com/apply/review",
      jobState: "awaiting_review" as const,
      artifactRefIds: [`artifact_${phase}`],
    },
    consentRequest: {
      id: `consent_${phase}`,
      runId: applyRunId,
      jobId,
      applicationRecordId: null,
      resultId: applyResultId,
      kind: "resume_use" as const,
      linkedConsentKind: "resume_use" as const,
      label: `${phase} resume use consent`,
      detail: null,
      status: "approved" as const,
      requestedAt: BASE_AT,
      decidedAt: at,
      expiresAt: null,
    },
    applicationRecord: ApplicationRecordSchema.parse({
      id: `application_${phase}`,
      jobId,
      title: `${phase} engineer`,
      company: "Acme",
      status: "submitted",
      lastActionLabel: "Applied",
      nextActionLabel: null,
      lastUpdatedAt: at,
      crm: {
        revision: 3,
        stage: "applied",
        stageChangedAt: at,
      },
    }),
    applicationAttempt: {
      id: `attempt_${phase}`,
      jobId,
      state: "submitted" as const,
      summary: `${phase} easy apply submitted`,
      detail: "Submitted successfully.",
      startedAt: BASE_AT,
      updatedAt: at,
      completedAt: at,
      outcome: "submitted" as const,
      questions: [],
      blocker: null,
      consentDecisions: [],
      replay: {
        sourceInstructionArtifactId: null,
        sourceDebugEvidenceRefIds: [],
        lastUrl: `https://jobs.example.com/roles/${jobId}/apply`,
        checkpointUrls: [`https://jobs.example.com/roles/${jobId}/apply`],
      },
      nextActionLabel: "Monitor inbox",
      checkpoints: [],
    },
    userActionRequest: UserActionRequestSchema.parse({
      id: `action-${phase}`,
      dedupeKey: `source-login:target-${phase}`,
      revision: 1,
      kind: "login",
      state: "awaiting_user",
      scope: {
        type: "discovery_source",
        targetId: `target-${phase}`,
        source: "target_site",
      },
      verification: {
        type: "source_access",
        targetId: `target-${phase}`,
        blockerFingerprint: `login-form-${phase}`,
      },
      title: `${phase} sign-in needed`,
      summary: "Complete sign-in in the browser, then ask the app to verify.",
      createdAt: BASE_AT,
      updatedAt: at,
    }),
    sourceDebugRun: SourceDebugRunRecordSchema.parse({
      id: sourceDebugRunId,
      targetId: "target_primary",
      state: "completed" as const,
      startedAt: BASE_AT,
      updatedAt: at,
      completedAt: at,
      activePhase: null,
      phases: [
        "access_auth_probe",
        "site_structure_mapping",
        "search_filter_probe",
        "job_detail_validation",
        "apply_path_validation",
        "replay_verification",
      ],
      targetLabel: "Primary target",
      targetUrl: "https://jobs.example.com/search",
      targetHostname: "jobs.example.com",
      manualPrerequisiteSummary: null,
      finalSummary: `${phase} replay verification reached jobs again.`,
      attemptIds: [`source_debug_attempt_${phase}`],
      phaseSummaries: [],
      timing: null,
      instructionArtifactId: `source_instruction_${phase}`,
    }),
    sourceDebugAttempt: {
      id: `source_debug_attempt_${phase}`,
      runId: sourceDebugRunId,
      targetId: "target_primary",
      phase: "job_detail_validation" as const,
      startedAt: BASE_AT,
      completedAt: at,
      outcome: "succeeded" as const,
      completionMode: "structured_finish" as const,
      completionReason: null,
      strategyLabel: "Job Detail Validation",
      strategyFingerprint:
        "job_detail_validation:target_site:job detail validation",
      confirmedFacts: [
        "Observed canonical job detail URL https://jobs.example.com/roles/1.",
      ],
      attemptedActions: ["Opened the first job detail page."],
      blockerSummary: null,
      resultSummary: "Validated job detail routes.",
      confidenceScore: 88,
      nextRecommendedStrategies: ["Replay Verification"],
      avoidStrategyFingerprints: [
        "job_detail_validation:target_site:job detail validation",
      ],
      evidenceRefIds: [`source_debug_evidence_${phase}`],
      phaseEvidence: null,
      compactionState: null,
      timing: null,
    },
    sourceInstructionArtifact: SourceInstructionArtifactSchema.parse({
      id: `source_instruction_${phase}`,
      targetId: "target_primary",
      status: "validated" as const,
      createdAt: BASE_AT,
      updatedAt: at,
      acceptedAt: at,
      basedOnRunId: sourceDebugRunId,
      basedOnAttemptIds: [`source_debug_attempt_${phase}`],
      notes: `${phase} validated target-site source guidance.`,
      navigationGuidance: ["Start from https://jobs.example.com/search."],
      searchGuidance: ["Use the jobs search route."],
      detailGuidance: ["Prefer stable detail URLs."],
      applyGuidance: [
        "Prefer the inline apply entry when it appears on the detail page.",
      ],
      warnings: [],
      versionInfo: {
        promptProfileVersion: "source-debug-v1",
        toolsetVersion: "browser-tools-v1",
        adapterVersion: "target_site",
        appSchemaVersion: "job-finder-source-debug-v1",
      },
      verification: {
        id: `source_instruction_verification_${phase}`,
        replayRunId: sourceDebugRunId,
        verifiedAt: at,
        outcome: "passed" as const,
        proofSummary: `${phase} replay verification reached jobs again.`,
        reason: null,
        versionInfo: {
          promptProfileVersion: "source-debug-v1",
          toolsetVersion: "browser-tools-v1",
          adapterVersion: "target_site",
          appSchemaVersion: "job-finder-source-debug-v1",
        },
      },
    }),
    sourceDebugEvidenceRef: {
      id: `source_debug_evidence_${phase}`,
      runId: sourceDebugRunId,
      attemptId: `source_debug_attempt_${phase}`,
      targetId: "target_primary",
      phase: "job_detail_validation" as const,
      kind: "url" as const,
      label: `${phase} validated job detail`,
      capturedAt: at,
      url: "https://jobs.example.com/roles/1",
      storagePath: null,
      excerpt: "Stable target-site job detail URL.",
    },
    importRun,
    importBundles,
    importCandidates,
  };
}

async function applyDirtyMutations(
  repository: JobFinderRepository,
  fixtures: ReturnType<typeof createStateSliceFixtures>,
): Promise<void> {
  const base = createSeed();

  await repository.saveProfile({ ...base.profile, headline: "Dirty Headline" });
  await repository.saveSearchPreferences({
    ...base.searchPreferences,
    targetRoles: ["Dirty Role"],
    minimumSalaryUsd: 120000,
  });
  await repository.saveProfileSetupState({
    status: "in_progress",
    currentStep: "targeting",
    completedAt: null,
    reviewItems: [
      {
        id: "review_dirty",
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
        createdAt: BASE_AT,
        resolvedAt: null,
      },
    ],
    lastResumedAt: DIRTY_AT,
  });
  await repository.saveSettings({
    ...base.settings,
    humanReviewRequired: false,
    appearanceTheme: "dark",
  });

  const dirtyCampaign = createCampaign(
    "campaign_dirty",
    "Dirty plan",
    DIRTY_AT,
  );
  await repository.saveCampaignState({
    campaigns: [dirtyCampaign],
    activeCampaignId: dirtyCampaign.id,
    notifications: [
      createNotification({
        id: "campaign_notification_dirty",
        campaignId: dirtyCampaign.id,
        title: "Dirty strong match",
        readAt: null,
      }),
    ],
  });
  await repository.saveIntelligenceState(
    JobFinderIntelligenceStateSchema.parse({
      groupedDecisions: [
        createDecision({ answerValue: "5 years", updatedAt: DIRTY_AT }),
      ],
      updatedAt: DIRTY_AT,
    }),
  );
  await repository.saveActivityControl({
    paused: true,
    pausedAt: DIRTY_AT,
    reason: "Dirty pause",
  });

  await repository.commitSavedJobDelta({ upserts: [fixtures.savedJob] });
  await repository.upsertTailoredAsset(fixtures.tailoredAsset);
  await repository.upsertResumeDraft(fixtures.resumeDraft);
  await repository.upsertResumeDraftRevision(fixtures.resumeDraftRevision);
  await repository.upsertResumeExportArtifact(fixtures.resumeExportArtifact);
  await repository.upsertResumeResearchArtifact(
    fixtures.resumeResearchArtifact,
  );
  await repository.upsertResumeValidationResult(
    fixtures.resumeValidationResult,
  );
  await repository.upsertResumeAssistantMessage(
    fixtures.resumeAssistantMessage,
  );
  await repository.upsertProfileCopilotMessage(fixtures.profileCopilotMessage);
  await repository.upsertProfileRevision(fixtures.profileRevision);
  await repository.upsertApplyRun(fixtures.applyRun);
  await repository.upsertApplyJobResult(fixtures.applyJobResult);
  await repository.upsertApplySubmitApproval(fixtures.applySubmitApproval);
  await repository.upsertApplicationQuestionRecord(fixtures.questionRecord);
  await repository.upsertApplicationAnswerRecord(fixtures.answerRecord);
  await repository.upsertApplicationArtifactRef(fixtures.artifactRef);
  await repository.upsertApplicationReplayCheckpoint(fixtures.replayCheckpoint);
  await repository.upsertApplicationConsentRequest(fixtures.consentRequest);
  await repository.upsertApplicationRecord(fixtures.applicationRecord);
  await repository.upsertApplicationAttempt(fixtures.applicationAttempt);
  await repository.createUserActionRequest(fixtures.userActionRequest);
  await repository.upsertSourceDebugRun(fixtures.sourceDebugRun);
  await repository.upsertSourceDebugAttempt(fixtures.sourceDebugAttempt);
  await repository.upsertSourceInstructionArtifact(
    fixtures.sourceInstructionArtifact,
  );
  await repository.upsertSourceDebugEvidenceRefs([
    fixtures.sourceDebugEvidenceRef,
  ]);
  await repository.replaceResumeImportRunArtifacts({
    run: fixtures.importRun,
    documentBundles: fixtures.importBundles,
    fieldCandidates: fixtures.importCandidates,
  });
}

async function expectDirtyProbes(
  repository: JobFinderRepository,
  fixtures: ReturnType<typeof createStateSliceFixtures>,
): Promise<void> {
  const probes: ReadonlyArray<{
    label: string;
    read: () => Promise<unknown>;
    expected: unknown;
  }> = [
    {
      label: "dirty profile headline persisted",
      read: async () => (await repository.getProfile()).headline,
      expected: "Dirty Headline",
    },
    {
      label: "dirty saved jobs persisted",
      read: async () => (await repository.listSavedJobs()).map((job) => job.id),
      expected: [fixtures.savedJob.id],
    },
    {
      label: "dirty campaign singleton persisted",
      read: async () =>
        (await repository.getCampaignState())?.activeCampaignId ?? null,
      expected: "campaign_dirty",
    },
    {
      label: "dirty intelligence state persisted",
      read: () => repository.getIntelligenceState(),
      expected: JobFinderIntelligenceStateSchema.parse({
        groupedDecisions: [
          createDecision({ answerValue: "5 years", updatedAt: DIRTY_AT }),
        ],
        updatedAt: DIRTY_AT,
      }),
    },
    {
      label: "dirty activity control persisted",
      read: () => repository.getActivityControl(),
      expected: { paused: true, pausedAt: DIRTY_AT, reason: "Dirty pause" },
    },
    {
      label: "dirty user action created event persisted",
      read: async () =>
        (await repository.listUserActionEvents()).map((event) => event.id),
      expected: [`${fixtures.userActionRequest.id}:created`],
    },
    {
      label: "dirty resume import runs persisted",
      read: async () =>
        (await repository.listResumeImportRuns()).map((run) => run.id),
      expected: [fixtures.importRun.id],
    },
  ];

  for (const probe of probes) {
    await expect(probe.read(), probe.label).resolves.toEqual(probe.expected);
  }
}

function createResetSeed(): JobFinderRepositorySeed {
  const base = createSeed();
  const fixtures = createStateSliceFixtures("reset");
  const campaign = createCampaign("campaign_reset", "Reset plan", RESET_AT);

  return JobFinderRepositoryStateSchema.parse({
    ...base,
    profile: { ...base.profile, headline: "Reset Headline" },
    searchPreferences: {
      ...base.searchPreferences,
      targetRoles: ["Reset Role"],
      minimumSalaryUsd: 140000,
    },
    profileSetupState: {
      status: "in_progress",
      currentStep: "essentials",
      completedAt: null,
      reviewItems: [],
      lastResumedAt: RESET_AT,
    },
    settings: {
      ...base.settings,
      allowAutoSubmitOverride: true,
      keepSessionAlive: false,
    },
    discovery: base.discovery,
    campaigns: [campaign],
    activeCampaignId: campaign.id,
    campaignNotifications: [
      createNotification({
        id: "campaign_notification_reset",
        campaignId: campaign.id,
        title: "Reset strong match",
        readAt: RESET_AT,
      }),
    ],
    activityControl: {
      paused: true,
      pausedAt: RESET_AT,
      reason: "Reset pause",
    },
    intelligence: JobFinderIntelligenceStateSchema.parse({
      groupedDecisions: [
        createDecision({ answerValue: "10 years", updatedAt: RESET_AT }),
      ],
      updatedAt: RESET_AT,
    }),
    savedJobs: [fixtures.savedJob],
    tailoredAssets: [fixtures.tailoredAsset],
    resumeDrafts: [fixtures.resumeDraft],
    resumeDraftRevisions: [fixtures.resumeDraftRevision],
    resumeExportArtifacts: [fixtures.resumeExportArtifact],
    resumeResearchArtifacts: [fixtures.resumeResearchArtifact],
    resumeValidationResults: [fixtures.resumeValidationResult],
    resumeAssistantMessages: [fixtures.resumeAssistantMessage],
    profileCopilotMessages: [fixtures.profileCopilotMessage],
    profileRevisions: [fixtures.profileRevision],
    applyRuns: [fixtures.applyRun],
    applyJobResults: [fixtures.applyJobResult],
    applySubmitApprovals: [fixtures.applySubmitApproval],
    applicationQuestionRecords: [fixtures.questionRecord],
    applicationAnswerRecords: [fixtures.answerRecord],
    applicationArtifactRefs: [fixtures.artifactRef],
    applicationReplayCheckpoints: [fixtures.replayCheckpoint],
    applicationConsentRequests: [fixtures.consentRequest],
    applicationRecords: [fixtures.applicationRecord],
    applicationAttempts: [fixtures.applicationAttempt],
    userActionRequests: [fixtures.userActionRequest],
    userActionEvents: [],
    sourceDebugRuns: [fixtures.sourceDebugRun],
    sourceDebugAttempts: [fixtures.sourceDebugAttempt],
    sourceInstructionArtifacts: [fixtures.sourceInstructionArtifact],
    sourceDebugEvidenceRefs: [fixtures.sourceDebugEvidenceRef],
    resumeImportRuns: [fixtures.importRun],
    resumeImportDocumentBundles: fixtures.importBundles,
    resumeImportFieldCandidates: fixtures.importCandidates,
  });
}

async function expectPostResetState(
  repository: JobFinderRepository,
  resetSeed: JobFinderRepositorySeed,
): Promise<void> {
  const expectations: ReadonlyArray<{
    label: string;
    read: () => Promise<unknown>;
    expected: unknown;
  }> = [
    {
      label: "profile",
      read: () => repository.getProfile(),
      expected: resetSeed.profile,
    },
    {
      label: "search preferences",
      read: () => repository.getSearchPreferences(),
      expected: JobSearchPreferencesSchema.parse({
        ...resetSeed.searchPreferences,
        weeklyHours: { minimum: null, maximum: null },
        discovery: { ...resetSeed.searchPreferences.discovery, targets: [] },
      }),
    },
    {
      label: "profile setup state",
      read: () => repository.getProfileSetupState(),
      expected: resetSeed.profileSetupState,
    },
    {
      label: "settings",
      read: () => repository.getSettings(),
      expected: JobFinderSettingsSchema.parse(resetSeed.settings),
    },
    {
      label: "discovery state",
      read: () => repository.getDiscoveryState(),
      expected: resetSeed.discovery,
    },
    {
      label: "campaign collection, active id, and notifications",
      read: () => repository.getCampaignState(),
      expected: {
        campaigns: resetSeed.campaigns,
        activeCampaignId: resetSeed.activeCampaignId,
        notifications: resetSeed.campaignNotifications,
      },
    },
    {
      label: "intelligence state",
      read: () => repository.getIntelligenceState(),
      expected: resetSeed.intelligence,
    },
    {
      label: "activity control",
      read: () => repository.getActivityControl(),
      expected: resetSeed.activityControl,
    },
    {
      label: "saved jobs",
      read: async () => (await repository.listSavedJobs()).map(savedJobData),
      expected: resetSeed.savedJobs,
    },
    {
      label: "tailored assets",
      read: () => repository.listTailoredAssets(),
      expected: resetSeed.tailoredAssets,
    },
    {
      label: "resume drafts",
      read: () => repository.listResumeDrafts(),
      expected: resetSeed.resumeDrafts,
    },
    {
      label: "resume draft revisions",
      read: () => repository.listResumeDraftRevisions(),
      expected: resetSeed.resumeDraftRevisions,
    },
    {
      label: "resume export artifacts",
      read: () => repository.listResumeExportArtifacts(),
      expected: resetSeed.resumeExportArtifacts,
    },
    {
      label: "resume research artifacts",
      read: () => repository.listResumeResearchArtifacts(),
      expected: resetSeed.resumeResearchArtifacts,
    },
    {
      label: "resume validation results",
      read: () => repository.listResumeValidationResults(),
      expected: resetSeed.resumeValidationResults,
    },
    {
      label: "resume assistant messages",
      read: () => repository.listResumeAssistantMessages(),
      expected: resetSeed.resumeAssistantMessages,
    },
    {
      label: "profile copilot messages",
      read: () => repository.listProfileCopilotMessages(),
      expected: resetSeed.profileCopilotMessages,
    },
    {
      label: "profile revisions",
      read: () => repository.listProfileRevisions(),
      expected: resetSeed.profileRevisions,
    },
    {
      label: "apply runs",
      read: () => repository.listApplyRuns(),
      expected: resetSeed.applyRuns,
    },
    {
      label: "apply job results",
      read: () => repository.listApplyJobResults(),
      expected: resetSeed.applyJobResults,
    },
    {
      label: "apply submit approvals",
      read: () => repository.listApplySubmitApprovals(),
      expected: resetSeed.applySubmitApprovals,
    },
    {
      label: "application question records",
      read: () => repository.listApplicationQuestionRecords(),
      expected: resetSeed.applicationQuestionRecords,
    },
    {
      label: "application answer records",
      read: () => repository.listApplicationAnswerRecords(),
      expected: resetSeed.applicationAnswerRecords,
    },
    {
      label: "application artifact refs",
      read: () => repository.listApplicationArtifactRefs(),
      expected: resetSeed.applicationArtifactRefs,
    },
    {
      label: "application replay checkpoints",
      read: () => repository.listApplicationReplayCheckpoints(),
      expected: resetSeed.applicationReplayCheckpoints,
    },
    {
      label: "application consent requests",
      read: () => repository.listApplicationConsentRequests(),
      expected: resetSeed.applicationConsentRequests,
    },
    {
      label: "user action requests",
      read: () => repository.listUserActionRequests(),
      expected: resetSeed.userActionRequests,
    },
    {
      label: "user action events cleared",
      read: () => repository.listUserActionEvents(),
      expected: resetSeed.userActionEvents,
    },
    {
      label: "application records",
      read: () => repository.listApplicationRecords(),
      expected: resetSeed.applicationRecords,
    },
    {
      label: "application attempts",
      read: () => repository.listApplicationAttempts(),
      expected: resetSeed.applicationAttempts,
    },
    {
      label: "source debug runs",
      read: () => repository.listSourceDebugRuns(),
      expected: resetSeed.sourceDebugRuns,
    },
    {
      label: "source debug attempts",
      read: () => repository.listSourceDebugAttempts(),
      expected: resetSeed.sourceDebugAttempts,
    },
    {
      label: "source instruction artifacts",
      read: () => repository.listSourceInstructionArtifacts(),
      expected: resetSeed.sourceInstructionArtifacts,
    },
    {
      label: "source debug evidence refs",
      read: () => repository.listSourceDebugEvidenceRefs(),
      expected: resetSeed.sourceDebugEvidenceRefs,
    },
    {
      label: "resume import runs",
      read: () => repository.listResumeImportRuns(),
      expected: resetSeed.resumeImportRuns,
    },
    {
      label: "resume import document bundles",
      read: () => repository.listResumeImportDocumentBundles(),
      expected: resetSeed.resumeImportDocumentBundles,
    },
    {
      label: "resume import field candidates",
      read: () => repository.listResumeImportFieldCandidates(),
      expected: resetSeed.resumeImportFieldCandidates,
    },
  ];

  for (const { label, read, expected } of expectations) {
    await expect(read(), label).resolves.toEqual(expected);
  }
}

interface RepositoryRuntime {
  readonly name: string;
  open: () => Promise<{
    repository: JobFinderRepository;
    cleanup: () => Promise<void>;
  }>;
}

const repositoryRuntimes: readonly RepositoryRuntime[] = [
  {
    name: "in-memory",
    open: () => {
      const repository = createInMemoryJobFinderRepository(createSeed());
      return Promise.resolve({
        repository,
        cleanup: () => Promise.resolve(),
      });
    },
  },
  {
    name: "file-backed sqlite",
    open: async () => {
      const temp = await createTempRepository("nestor-db-reset-conformance-");
      const repository = await temp.createRepository();
      return {
        repository,
        cleanup: async () => {
          await repository.close().catch(() => undefined);
          await cleanupTempDirectoryWithRetry(temp.tempDirectory);
        },
      };
    },
  },
];

describe("job finder repository reset conformance", () => {
  for (const runtime of repositoryRuntimes) {
    test(`reset replaces every state slice on the ${runtime.name} repository`, async () => {
      const runtimeHandle = await runtime.open();
      const { repository, cleanup } = runtimeHandle;

      try {
        const dirtyFixtures = createStateSliceFixtures("dirty");
        await applyDirtyMutations(repository, dirtyFixtures);
        await expectDirtyProbes(repository, dirtyFixtures);

        const resetSeed = createResetSeed();
        await repository.reset(resetSeed);

        await expectPostResetState(repository, resetSeed);
      } finally {
        await cleanup();
      }
    });
  }

  test("both runtimes agree on reset semantics without private state access", async () => {
    const results: string[] = [];

    for (const runtime of repositoryRuntimes) {
      const { repository, cleanup } = await runtime.open();
      try {
        const dirtyFixtures = createStateSliceFixtures("dirty");
        await applyDirtyMutations(repository, dirtyFixtures);
        const resetSeed = createResetSeed();
        await repository.reset(resetSeed);

        const observations = [
          (await repository.getProfile()).headline,
          (await repository.getSearchPreferences()).minimumSalaryUsd,
          (await repository.getProfileSetupState()).currentStep,
          (await repository.getSettings()).allowAutoSubmitOverride,
          (await repository.getCampaignState())?.activeCampaignId ?? null,
          (await repository.getIntelligenceState()).updatedAt,
          (await repository.getActivityControl()).reason,
          (await repository.listSavedJobs()).map((job) => job.id),
          (await repository.listUserActionRequests()).map(
            (request) => request.id,
          ),
          (await repository.listUserActionEvents()).length,
          (await repository.listApplicationRecords()).map(
            (record) => record.id,
          ),
          (await repository.listResumeImportRuns()).map((run) => run.id),
        ];
        results.push(JSON.stringify(observations));
      } finally {
        await cleanup();
      }
    }

    const [inMemoryObservations, fileObservations] = results;
    expect(inMemoryObservations).toEqual(fileObservations);
  });
});
