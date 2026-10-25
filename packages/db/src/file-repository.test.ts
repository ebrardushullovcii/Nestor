import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
  ApplicationRecordSchema,
  ApplicationAnswerRecordSchema,
  ApplicationArtifactRefSchema,
  ApplicationConsentRequestSchema,
  ApplicationQuestionRecordSchema,
  ApplicationReplayCheckpointSchema,
  ApplyJobResultSchema,
  SourceDebugEvidenceRefSchema,
  ApplyRunSchema,
  getDefaultCampaignConfiguration,
  JobSearchCampaignSchema,
  type JobSearchCampaign,
  type JobSearchPreferences,
  ResumeDraftRevisionSchema,
  ResumeDraftSchema,
  ResumeExportArtifactSchema,
  ResumeValidationResultSchema,
  SourceInstructionArtifactSchema,
  TailoredAssetSchema,
} from "@nestor/contracts";

import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import { createSeed } from "./test-fixtures";
import { MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT } from "./resume-draft-revision-retention";
import {
  cleanupTempDirectoryWithRetry,
  createResumeImportArtifactsFixture,
  createSavedJob,
  createTempRepository,
  type FileRepository,
} from "./file-repository.test-support";

function createPersistedRetentionDraft(id: string, updatedAt: string) {
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

function createPersistedRetentionRevision(draftId: string, index: number) {
  const suffix = String(index).padStart(3, "0");
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
    createdAt: new Date(Date.UTC(2026, 6, 30, 10, 0, index)).toISOString(),
    reason: `Revision ${index}`,
  });
}
describe("createFileJobFinderRepository", () => {
  test("commits revision-guarded CRM batches atomically and survives reopen", async () => {
    const temp = await createTempRepository("nestor-db-crm-batch-");
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
    let repository: FileRepository | null = null;
    let reopened: FileRepository | null = null;
    try {
      repository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });
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

      await repository.close();
      repository = null;
      reopened = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });
      expect(
        (await reopened.listApplicationRecords()).map(
          (record) => record.crm?.stage,
        ),
      ).toEqual(["reviewing", "reviewing"]);
    } finally {
      await repository?.close();
      await reopened?.close();
      await temp.cleanup();
    }
  });

  test("merges CRM onto current records and validates unchanged selected rows in file storage", async () => {
    const temp = await createTempRepository("nestor-db-crm-merge-");
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
    let repository: FileRepository | null = null;
    try {
      repository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });
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
    } finally {
      await repository?.close();
      await temp.cleanup();
    }
  });

  test("deletes only source instruction artifacts for the requested target in file storage", async () => {
    const temp = await createTempRepository("nestor-db-artifacts-");
    let repository: FileRepository | null = null;

    try {
      repository = await temp.createRepository();

      const baseArtifact = {
        status: "draft" as const,
        createdAt: "2026-03-20T10:01:00.000Z",
        updatedAt: "2026-03-20T10:02:00.000Z",
        acceptedAt: null,
        basedOnRunId: "source_debug_run_1",
        basedOnAttemptIds: ["source_debug_attempt_1"],
        notes: null,
        navigationGuidance: ["Start from the jobs route."],
        searchGuidance: ["Use the visible search box."],
        detailGuidance: [],
        applyGuidance: [],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "source-debug-v1",
          toolsetVersion: "browser-tools-v1",
          adapterVersion: "target_site",
          appSchemaVersion: "job-finder-source-debug-v1",
        },
        verification: null,
      };

      await repository.upsertSourceInstructionArtifact(
        SourceInstructionArtifactSchema.parse({
          ...baseArtifact,
          id: "source_instruction_primary",
          targetId: "target_primary",
        }),
      );
      await repository.upsertSourceInstructionArtifact(
        SourceInstructionArtifactSchema.parse({
          ...baseArtifact,
          id: "source_instruction_secondary",
          targetId: "target_secondary",
        }),
      );

      await repository.deleteSourceInstructionArtifactsForTarget(
        "target_primary",
      );

      await expect(
        repository.listSourceInstructionArtifacts(),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "source_instruction_secondary",
          targetId: "target_secondary",
        }),
      ]);
    } finally {
      if (repository) {
        await repository.close();
      }
      await temp.cleanup();
    }
  });

  test("claims one resumption owner and CAS-protects apply results across sqlite repositories", async () => {
    const temp = await createTempRepository("nestor-db-resumption-cas-");
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;

    try {
      firstRepository = await temp.createRepository();
      secondRepository = await temp.createRepository();
      const attempt = {
        id: "application_user_action_resume_request_1_r3",
        jobId: "job_1",
        state: "in_progress" as const,
        summary: "Claimed exact verified resumption",
        detail: "One service owns this prepare-only retry.",
        startedAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
        completedAt: null,
        outcome: null,
        questions: [],
        blocker: null,
        consentDecisions: [],
        replay: {
          sourceInstructionArtifactId: null,
          sourceDebugEvidenceRefIds: [],
          lastUrl: null,
          checkpointUrls: [],
        },
        nextActionLabel: "Wait for the exact retry",
        checkpoints: [],
        userActionResumption: {
          requestId: "request_1",
          requestRevision: 3,
          verificationEventId: "verification:request_1:r2",
          runId: "run_1",
          jobId: "job_1",
          resultId: "result_1",
          replayCheckpointId: "checkpoint_1",
        },
      };

      const claims = await Promise.all([
        firstRepository.claimApplicationAttempt(attempt),
        secondRepository.claimApplicationAttempt(attempt),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);

      const baseline = ApplyJobResultSchema.parse({
        id: "result_1",
        runId: "run_1",
        jobId: "job_1",
        queuePosition: 0,
        state: "blocked",
        summary: "Authentication required",
        detail: "Waiting for verified browser access.",
        startedAt: "2026-07-30T09:59:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
        completedAt: null,
        blockerReason: "auth_required",
        latestCheckpointId: "checkpoint_1",
      });
      await firstRepository.upsertApplyJobResult(baseline);
      const firstUpdate = ApplyJobResultSchema.parse({
        ...baseline,
        summary: "First owner result",
        updatedAt: "2026-07-30T10:01:00.000Z",
      });
      const secondUpdate = ApplyJobResultSchema.parse({
        ...baseline,
        summary: "Second owner result",
        updatedAt: "2026-07-30T10:02:00.000Z",
      });
      const swaps = await Promise.all([
        firstRepository.compareAndSwapApplyJobResult({
          expected: baseline,
          result: firstUpdate,
        }),
        secondRepository.compareAndSwapApplyJobResult({
          expected: baseline,
          result: secondUpdate,
        }),
      ]);

      expect(swaps.filter(Boolean)).toHaveLength(1);
      const persisted = (await firstRepository.listApplyJobResults())[0];
      expect(["First owner result", "Second owner result"]).toContain(
        persisted?.summary,
      );
    } finally {
      if (secondRepository) await secondRepository.close();
      if (firstRepository) await firstRepository.close();
      await temp.cleanup();
    }
  });

  test("CAS-protects application answer revisions across sqlite repositories", async () => {
    const temp = await createTempRepository("nestor-db-answer-cas-");
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;

    try {
      firstRepository = await temp.createRepository();
      secondRepository = await temp.createRepository();

      const question = ApplicationQuestionRecordSchema.parse({
        id: "question_answer_cas",
        runId: "run_answer_cas",
        jobId: "job_1",
        resultId: "result_answer_cas",
        prompt: "Do you have work authorization?",
        kind: "work_authorization",
        answerControlType: "single_choice",
        isRequired: true,
        detectedAt: "2026-07-30T10:00:00.000Z",
        answerOptions: ["Yes", "No"],
        selectedAnswerId: null,
        submittedAnswer: null,
        status: "detected",
      });
      await firstRepository.upsertApplicationQuestionRecord(question);

      const answerA = ApplicationAnswerRecordSchema.parse({
        id: "application_answer_cas_a",
        runId: question.runId,
        jobId: question.jobId,
        resultId: question.resultId,
        questionId: question.id,
        text: "Yes",
        value: { type: "single_choice", value: "Yes" },
        revision: 1,
        sourceKind: "user",
        sourceId: "cas-a",
        createdAt: "2026-07-30T10:00:01.000Z",
      });
      const answerB = ApplicationAnswerRecordSchema.parse({
        ...answerA,
        id: "application_answer_cas_b",
        text: "No",
        value: { type: "single_choice", value: "No" },
        sourceId: "cas-b",
        createdAt: "2026-07-30T10:00:02.000Z",
      });
      const questionA = {
        ...question,
        selectedAnswerId: answerA.id,
        submittedAnswer: answerA.text,
        status: "answered" as const,
      };
      const questionB = {
        ...question,
        selectedAnswerId: answerB.id,
        submittedAnswer: answerB.text,
        status: "answered" as const,
      };

      const results = await Promise.all([
        firstRepository.commitApplicationAnswerMutation({
          expectedAnswer: null,
          expectedQuestion: question,
          answer: answerA,
          question: questionA,
        }),
        secondRepository.commitApplicationAnswerMutation({
          expectedAnswer: null,
          expectedQuestion: question,
          answer: answerB,
          question: questionB,
        }),
      ]);

      expect(results.filter((result) => result === "applied")).toHaveLength(1);
      expect(results.filter((result) => result === "stale")).toHaveLength(1);
      const persistedAnswers =
        await firstRepository.listApplicationAnswerRecords({
          questionId: question.id,
        });
      expect(persistedAnswers).toHaveLength(1);
      expect(persistedAnswers[0]?.revision).toBe(1);

      const persistedQuestion = (
        await firstRepository.listApplicationQuestionRecords()
      )[0];
      expect(persistedQuestion?.selectedAnswerId).toBe(persistedAnswers[0]?.id);
      expect(persistedQuestion?.submittedAnswer).toBe(
        persistedAnswers[0]?.text,
      );
    } finally {
      if (secondRepository) await secondRepository.close();
      if (firstRepository) await firstRepository.close();
      await temp.cleanup();
    }
  });

  test("persists repository state to a local sqlite file", async () => {
    const temp = await createTempRepository("nestor-db-");
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;

    try {
      firstRepository = await temp.createRepository();

      await firstRepository.replaceSavedJobs([createSavedJob()]);

      await firstRepository.upsertApplicationAttempt({
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

      await firstRepository.close();
      firstRepository = null;

      secondRepository = await temp.createRepository();
      const savedJobs = await secondRepository.listSavedJobs();
      const attempts = await secondRepository.listApplicationAttempts();

      expect(savedJobs).toHaveLength(1);
      expect(savedJobs[0]?.canonicalUrl).toContain("target_job_1");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.summary).toBe("Easy Apply submitted");
    } finally {
      if (secondRepository) {
        await secondRepository.close();
      }
      if (firstRepository) {
        await firstRepository.close();
      }
      await temp.cleanup();
    }
  });

  test("persists apply foundation records across sqlite reloads", async () => {
    const temp = await createTempRepository("nestor-db-apply-foundation-");
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;

    try {
      firstRepository = await temp.createRepository();

      await firstRepository.upsertApplyRun(
        ApplyRunSchema.parse({
          id: "apply_run_1",
          mode: "copilot",
          state: "paused_for_user_review",
          jobIds: ["job_1"],
          currentJobId: "job_1",
          submitApprovalId: null,
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
        }),
      );
      await firstRepository.upsertApplyJobResult(
        ApplyJobResultSchema.parse({
          id: "apply_result_1",
          runId: "apply_run_1",
          jobId: "job_1",
          queuePosition: 0,
          state: "awaiting_review",
          summary: "Application prepared for review.",
          detail: "Captured the staged application state without submitting.",
          startedAt: "2026-04-18T10:00:10.000Z",
          updatedAt: "2026-04-18T10:00:40.000Z",
          completedAt: null,
          blockerReason: null,
          blockerSummary: null,
          latestQuestionCount: 1,
          latestAnswerCount: 1,
          pendingConsentRequestCount: 1,
          artifactCount: 1,
          latestCheckpointId: "checkpoint_1",
        }),
      );
      await firstRepository.upsertApplicationQuestionRecord(
        ApplicationQuestionRecordSchema.parse({
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
          selectedAnswerId: null,
          submittedAnswer: null,
          status: "detected",
          pageUrl: "https://jobs.example.com/apply",
        }),
      );
      await firstRepository.upsertApplicationAnswerRecord(
        ApplicationAnswerRecordSchema.parse({
          id: "answer_1",
          runId: "apply_run_1",
          jobId: "job_1",
          resultId: "apply_result_1",
          questionId: "question_1",
          status: "suggested",
          text: "/tmp/tailored-resume.pdf",
          sourceKind: "resume",
          sourceId: "resume_export_1",
          confidenceLabel: "grounded",
          provenance: [
            {
              id: "answer_provenance_1",
              sourceKind: "resume",
              sourceId: "resume_export_1",
              label: "Approved tailored resume export",
              snippet: "/tmp/tailored-resume.pdf",
            },
          ],
          createdAt: "2026-04-18T10:00:31.000Z",
          submittedAt: null,
        }),
      );
      await firstRepository.upsertApplicationArtifactRef(
        ApplicationArtifactRefSchema.parse({
          id: "artifact_1",
          runId: "apply_run_1",
          jobId: "job_1",
          resultId: "apply_result_1",
          questionId: "question_1",
          kind: "field_snapshot",
          label: "Resume upload prompt",
          createdAt: "2026-04-18T10:00:32.000Z",
          storagePath: null,
          url: "https://jobs.example.com/apply",
          textSnippet: "Upload your resume",
        }),
      );
      await firstRepository.upsertApplicationReplayCheckpoint(
        ApplicationReplayCheckpointSchema.parse({
          id: "checkpoint_1",
          runId: "apply_run_1",
          jobId: "job_1",
          resultId: "apply_result_1",
          createdAt: "2026-04-18T10:00:33.000Z",
          label: "Prepared application for review",
          detail: "The flow paused before final submit.",
          url: "https://jobs.example.com/apply",
          jobState: "awaiting_review",
          artifactRefIds: ["artifact_1"],
        }),
      );
      await firstRepository.upsertApplicationConsentRequest(
        ApplicationConsentRequestSchema.parse({
          id: "consent_1",
          runId: "apply_run_1",
          jobId: "job_1",
          resultId: "apply_result_1",
          kind: "resume_use",
          linkedConsentKind: "resume_use",
          label: "Use the approved tailored resume for this apply run",
          detail: null,
          status: "approved",
          requestedAt: "2026-04-18T10:00:20.000Z",
          decidedAt: "2026-04-18T10:00:25.000Z",
          expiresAt: null,
        }),
      );

      await firstRepository.close();
      firstRepository = null;

      secondRepository = await temp.createRepository();

      await expect(secondRepository.listApplyRuns()).resolves.toEqual([
        expect.objectContaining({
          id: "apply_run_1",
          state: "paused_for_user_review",
        }),
      ]);
      await expect(secondRepository.listApplyJobResults()).resolves.toEqual([
        expect.objectContaining({
          id: "apply_result_1",
          runId: "apply_run_1",
          jobId: "job_1",
        }),
      ]);
      await expect(
        secondRepository.listApplicationQuestionRecords({
          runId: "apply_run_1",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "question_1",
          prompt: "Upload your resume",
        }),
      ]);
      await expect(
        secondRepository.listApplicationAnswerRecords({
          resultId: "apply_result_1",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "answer_1",
          runId: "apply_run_1",
          resultId: "apply_result_1",
          questionId: "question_1",
        }),
      ]);
      await expect(
        secondRepository.listApplicationArtifactRefs({
          resultId: "apply_result_1",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "artifact_1",
          runId: "apply_run_1",
          resultId: "apply_result_1",
          questionId: "question_1",
        }),
      ]);
      await expect(
        secondRepository.listApplicationReplayCheckpoints({
          resultId: "apply_result_1",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "checkpoint_1",
          runId: "apply_run_1",
          resultId: "apply_result_1",
          artifactRefIds: ["artifact_1"],
        }),
      ]);
      await expect(
        secondRepository.listApplicationConsentRequests({
          runId: "apply_run_1",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "consent_1",
          runId: "apply_run_1",
          resultId: "apply_result_1",
          status: "approved",
        }),
      ]);
    } finally {
      if (secondRepository) {
        await secondRepository.close();
      }
      if (firstRepository) {
        await firstRepository.close();
      }
      await temp.cleanup();
    }
  });

  test("atomically marks application preparation once and retains it after restart", async () => {
    const temp = await createTempRepository("nestor-db-preparation-start-");
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;

    try {
      firstRepository = await temp.createRepository();
      secondRepository = await temp.createRepository();
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
      await firstRepository.upsertApplyJobResult(baseline);

      expect(() =>
        firstRepository!.markApplicationPreparationStarted({
          resultId: "missing_result",
          runId: baseline.runId,
          jobId: baseline.jobId,
          startedAt: "2026-08-23T10:00:00.000Z",
          startedLocalDate: "2026-08-23",
        }),
      ).toThrow("does not exist");

      const outcomes = await Promise.all([
        firstRepository.markApplicationPreparationStarted({
          resultId: baseline.id,
          runId: baseline.runId,
          jobId: baseline.jobId,
          startedAt: "2026-08-23T10:00:00.000Z",
          startedLocalDate: "2026-08-23",
        }),
        secondRepository.markApplicationPreparationStarted({
          resultId: baseline.id,
          runId: baseline.runId,
          jobId: baseline.jobId,
          startedAt: "2026-08-24T10:00:00.000Z",
          startedLocalDate: "2026-08-24",
        }),
      ]);
      expect(outcomes.filter((outcome) => outcome.didStart)).toHaveLength(1);
      expect(outcomes[0]?.result).toEqual(outcomes[1]?.result);

      expect(() =>
        firstRepository!.markApplicationPreparationStarted({
          resultId: baseline.id,
          runId: "wrong_run",
          jobId: baseline.jobId,
          startedAt: "2026-08-25T10:00:00.000Z",
          startedLocalDate: "2026-08-25",
        }),
      ).toThrow("lineage");
      expect(() =>
        firstRepository!.upsertApplyJobResult({
          ...outcomes[0].result,
          applicationPreparationStartedAt: null,
          applicationPreparationStartedLocalDate: null,
        }),
      ).toThrow("immutable");
      expect(() =>
        firstRepository!.compareAndSwapApplyJobResult({
          expected: outcomes[0].result,
          result: {
            ...outcomes[0].result,
            applicationPreparationStartedAt: "2026-08-25T10:00:00.000Z",
            applicationPreparationStartedLocalDate: "2026-08-25",
          },
        }),
      ).toThrow("immutable");
      await expect(
        firstRepository.compareAndSwapApplyJobResult({
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
        firstRepository.compareAndSwapApplyJobResult({
          expected: outcomes[0].result,
          result: {
            ...outcomes[0].result,
            state: "failed",
            completedAt: "2026-08-23T10:05:00.000Z",
            updatedAt: "2026-08-23T10:05:00.000Z",
          },
        }),
      ).resolves.toBe(true);

      await secondRepository.close();
      secondRepository = null;
      await firstRepository.close();
      firstRepository = null;
      firstRepository = await temp.createRepository();
      const persisted = (await firstRepository.listApplyJobResults())[0]!;
      expect(persisted.applicationPreparationStartedAt).toBe(
        outcomes[0]?.result.applicationPreparationStartedAt,
      );
      expect(persisted.state).toBe("failed");
    } finally {
      if (secondRepository) await secondRepository.close();
      if (firstRepository) await firstRepository.close();
      await temp.cleanup();
    }
  });

  test("filters persisted results by exact application record lineage", async () => {
    const temp = await createTempRepository("nestor-db-lineage-filter-");
    let repository: FileRepository | null = null;
    try {
      repository = await temp.createRepository();
      const base = {
        jobId: "job_shared",
        queuePosition: 0,
        state: "planned" as const,
        summary: "Application planned.",
        detail: "Waiting to prepare.",
        startedAt: "2026-08-23T10:00:00.000Z",
        updatedAt: "2026-08-23T10:00:00.000Z",
      };
      await repository.upsertApplyJobResult({
        ...base,
        id: "result_a",
        runId: "run_a",
        applicationRecordId: "application_a",
      });
      await repository.upsertApplyJobResult({
        ...base,
        id: "result_b",
        runId: "run_b",
        applicationRecordId: "application_b",
      });

      await expect(
        repository.listApplyJobResults({
          applicationRecordId: "application_b",
        }),
      ).resolves.toEqual([expect.objectContaining({ id: "result_b" })]);
      const raw = new DatabaseSync(temp.filePath);
      expect(
        raw
          .prepare(
            "SELECT application_record_id FROM apply_job_results WHERE id = ?",
          )
          .get("result_b"),
      ).toEqual({ application_record_id: "application_b" });
      raw.close();
    } finally {
      if (repository) await repository.close();
      await temp.cleanup();
    }
  });

  test("persists profile setup state across sqlite reloads", async () => {
    const temp = await createTempRepository("nestor-db-setup-");
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;

    try {
      firstRepository = await temp.createRepository();

      await firstRepository.saveProfileSetupState({
        status: "in_progress",
        currentStep: "background",
        completedAt: null,
        reviewItems: [],
        lastResumedAt: "2026-04-11T10:10:00.000Z",
      });

      await firstRepository.close();
      firstRepository = null;

      secondRepository = await temp.createRepository();

      await expect(secondRepository.getProfileSetupState()).resolves.toEqual(
        expect.objectContaining({
          status: "in_progress",
          currentStep: "background",
          lastResumedAt: "2026-04-11T10:10:00.000Z",
        }),
      );
    } finally {
      if (secondRepository) {
        await secondRepository.close();
      }
      if (firstRepository) {
        await firstRepository.close();
      }
      await temp.cleanup();
    }
  });

  test("persists profile copilot messages and revisions across sqlite reloads", async () => {
    const temp = await createTempRepository("nestor-db-profile-copilot-");
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;
    const seed = createSeed();

    try {
      firstRepository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });

      await firstRepository.upsertProfileCopilotMessage({
        id: "profile_message_1",
        role: "assistant",
        content: "I can improve your profile headline.",
        context: { surface: "setup", step: "essentials" },
        patchGroups: [
          {
            id: "profile_patch_group_1",
            summary: "Refine the profile headline",
            applyMode: "needs_review",
            operations: [
              {
                operation: "replace_identity_fields",
                value: {
                  headline: "Principal Product Designer",
                },
              },
            ],
            createdAt: "2026-04-11T10:00:30.000Z",
          },
        ],
        createdAt: "2026-04-11T10:00:00.000Z",
      });
      await firstRepository.upsertProfileRevision({
        id: "profile_revision_1",
        createdAt: "2026-04-11T10:01:00.000Z",
        reason: "Applied assistant profile refinement.",
        sequence: 1,
        snapshotProfileAfter: null,
        snapshotSearchPreferencesAfter: null,
        snapshotResumeApplicationMode: null,
        snapshotResumeApplicationModeAfter: null,
        trigger: "assistant_patch",
        messageId: "profile_message_1",
        patchGroupId: "profile_patch_group_1",
        restoredFromRevisionId: null,
        snapshotProfile: seed.profile,
        snapshotSearchPreferences: seed.searchPreferences,
        snapshotProfileSetupState: seed.profileSetupState,
      });

      await firstRepository.close();
      firstRepository = null;

      secondRepository = await temp.createRepository();

      await expect(
        secondRepository.listProfileCopilotMessages(),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "profile_message_1",
          patchGroups: [
            expect.objectContaining({ id: "profile_patch_group_1" }),
          ],
        }),
      ]);
      await expect(secondRepository.listProfileRevisions()).resolves.toEqual([
        expect.objectContaining({
          id: "profile_revision_1",
          patchGroupId: "profile_patch_group_1",
          messageId: "profile_message_1",
        }),
      ]);
    } finally {
      if (secondRepository) {
        await secondRepository.close();
      }
      if (firstRepository) {
        await firstRepository.close();
      }
      await temp.cleanup();
    }
  });

  test("atomically commits profile copilot state across sqlite reloads", async () => {
    const temp = await createTempRepository(
      "nestor-db-profile-copilot-atomic-",
    );
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;
    const seed = createSeed();

    try {
      firstRepository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });

      await firstRepository.commitProfileCopilotState({
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
            sequence: 2,
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

      await firstRepository.close();
      firstRepository = null;

      secondRepository = await temp.createRepository();

      await expect(secondRepository.getProfile()).resolves.toEqual(
        expect.objectContaining({ headline: "Principal Product Designer" }),
      );
      await expect(secondRepository.getSearchPreferences()).resolves.toEqual(
        expect.objectContaining({ targetSalaryUsd: 220000 }),
      );
      await expect(secondRepository.getProfileSetupState()).resolves.toEqual(
        expect.objectContaining({
          status: "in_progress",
          currentStep: "essentials",
        }),
      );
      await expect(
        secondRepository.listProfileCopilotMessages(),
      ).resolves.toEqual([
        expect.objectContaining({ id: "profile_message_atomic" }),
      ]);
      await expect(secondRepository.listProfileRevisions()).resolves.toEqual([
        expect.objectContaining({ id: "profile_revision_atomic" }),
      ]);
    } finally {
      if (secondRepository) {
        await secondRepository.close();
      }
      if (firstRepository) {
        await firstRepository.close();
      }
      await temp.cleanup();
    }
  });

  test("persists source-debug artifacts outside the singleton discovery state blob", async () => {
    const temp = await createTempRepository("nestor-db-source-debug-");
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;

    try {
      firstRepository = await temp.createRepository();

      await firstRepository.upsertSourceDebugRun({
        id: "source_debug_run_1",
        targetId: "target_primary",
        state: "completed",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:02:00.000Z",
        completedAt: "2026-03-20T10:02:00.000Z",
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
        finalSummary: "Replay verification reached jobs again.",
        attemptIds: ["source_debug_attempt_1"],
        phaseSummaries: [],
        timing: null,
        instructionArtifactId: "source_instruction_1",
      });
      await firstRepository.upsertSourceDebugAttempt({
        id: "source_debug_attempt_1",
        runId: "source_debug_run_1",
        targetId: "target_primary",
        phase: "job_detail_validation",
        startedAt: "2026-03-20T10:01:00.000Z",
        completedAt: "2026-03-20T10:01:30.000Z",
        outcome: "succeeded",
        completionMode: "structured_finish",
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
        evidenceRefIds: ["source_debug_evidence_1"],
        phaseEvidence: null,
        compactionState: null,
        timing: null,
      });
      await firstRepository.upsertSourceInstructionArtifact(
        SourceInstructionArtifactSchema.parse({
          id: "source_instruction_1",
          targetId: "target_primary",
          status: "validated",
          createdAt: "2026-03-20T10:01:00.000Z",
          updatedAt: "2026-03-20T10:02:00.000Z",
          acceptedAt: "2026-03-20T10:02:00.000Z",
          basedOnRunId: "source_debug_run_1",
          basedOnAttemptIds: ["source_debug_attempt_1"],
          notes: "Validated target-site source guidance.",
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
            id: "source_instruction_verification_1",
            replayRunId: "source_debug_run_1",
            verifiedAt: "2026-03-20T10:02:00.000Z",
            outcome: "passed",
            proofSummary: "Replay verification reached jobs again.",
            reason: null,
            versionInfo: {
              promptProfileVersion: "source-debug-v1",
              toolsetVersion: "browser-tools-v1",
              adapterVersion: "target_site",
              appSchemaVersion: "job-finder-source-debug-v1",
            },
          },
        }),
      );
      await firstRepository.upsertSourceDebugEvidenceRefs([
        SourceDebugEvidenceRefSchema.parse({
          id: "source_debug_evidence_1",
          runId: "source_debug_run_1",
          attemptId: "source_debug_attempt_1",
          targetId: "target_primary",
          phase: "job_detail_validation",
          kind: "url",
          label: "Validated job detail",
          capturedAt: "2026-03-20T10:01:15.000Z",
          url: "https://jobs.example.com/roles/1",
          storagePath: null,
          excerpt: "Stable target-site job detail URL.",
        }),
        SourceDebugEvidenceRefSchema.parse({
          id: "source_debug_evidence_2",
          runId: "source_debug_run_1",
          attemptId: "source_debug_attempt_1",
          targetId: "target_primary",
          phase: "apply_path_validation",
          kind: "url",
          label: "Apply entry point",
          capturedAt: "2026-03-20T10:01:30.000Z",
          url: "https://jobs.example.com/roles/1/apply",
          storagePath: null,
          excerpt: "Inline apply button is visible on the detail page.",
        }),
      ]);

      await firstRepository.close();
      firstRepository = null;

      secondRepository = await temp.createRepository();
      const [runs, attempts, artifacts, evidenceRefs, discoveryState] =
        await Promise.all([
          secondRepository.listSourceDebugRuns(),
          secondRepository.listSourceDebugAttempts(),
          secondRepository.listSourceInstructionArtifacts(),
          secondRepository.listSourceDebugEvidenceRefs(),
          secondRepository.getDiscoveryState(),
        ]);

      expect(runs).toHaveLength(1);
      expect(attempts).toHaveLength(1);
      expect(artifacts).toHaveLength(1);
      expect(evidenceRefs).toHaveLength(2);
      expect(discoveryState.activeSourceDebugRun).toBeNull();
      expect(discoveryState.recentSourceDebugRuns).toEqual([]);
    } finally {
      if (secondRepository) {
        await secondRepository.close();
      }
      if (firstRepository) {
        await firstRepository.close();
      }
      await temp.cleanup();
    }
  });

  test("atomically persists saved-job updates with resume approval invalidation", async () => {
    const temp = await createTempRepository("nestor-db-resume-stale-");
    let repository: FileRepository | null = null;
    const seed = createSeed();
    seed.savedJobs = [
      createSavedJob({
        id: "job_ready",
        sourceJobId: "target_job_ready",
        canonicalUrl: "https://jobs.example.com/roles/target_job_ready",
        applicationUrl: "https://jobs.example.com/roles/target_job_ready/apply",
      }),
    ];

    try {
      repository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });

      await repository.upsertResumeDraft({
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
      });
      await repository.upsertResumeExportArtifact({
        id: "resume_export_old",
        draftId: "resume_draft_1",
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/old.pdf",
        pageCount: 2,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:06:00.000Z",
        isApproved: false,
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
      const refreshedDraft =
        await repository.getResumeDraftByJobId("job_ready");
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
    } finally {
      if (repository) {
        await repository.close();
      }
      await temp.cleanup();
    }
  });

  test("persists resume import runs, bundles, and candidates together", async () => {
    const temp = await createTempRepository("nestor-db-import-runs-");
    let repository: FileRepository | null = null;

    try {
      repository = await temp.createRepository();

      await repository.replaceResumeImportRunArtifacts(
        createResumeImportArtifactsFixture(),
      );

      await expect(
        repository.getLatestResumeImportRun("resume_1"),
      ).resolves.toEqual(
        expect.objectContaining({ id: "resume_import_run_1" }),
      );
      await expect(
        repository.listResumeImportDocumentBundles({
          runId: "resume_import_run_1",
        }),
      ).resolves.toEqual([expect.objectContaining({ id: "resume_bundle_1" })]);
      await expect(
        repository.listResumeImportFieldCandidates({
          runId: "resume_import_run_1",
          resolution: "needs_review",
        }),
      ).resolves.toEqual([expect.objectContaining({ id: "candidate_2" })]);

      const persistedRun =
        await repository.getLatestResumeImportRun("resume_1");
      if (!persistedRun) {
        throw new Error(
          "Expected the resume import run fixture to be persisted.",
        );
      }
      const bundlesBeforeTimingUpdate =
        await repository.listResumeImportDocumentBundles({
          runId: persistedRun.id,
        });
      const candidatesBeforeTimingUpdate =
        await repository.listResumeImportFieldCandidates({
          runId: persistedRun.id,
        });

      await repository.upsertResumeImportRun({
        ...persistedRun,
        timing: {
          totalMs: 1_500,
          textBranchMs: 900,
          literalExtractionMs: 25,
          reconciliationMs: 300,
          finalizationMs: 275,
          textStages: [],
        },
      });

      await expect(
        repository.listResumeImportDocumentBundles({ runId: persistedRun.id }),
      ).resolves.toEqual(bundlesBeforeTimingUpdate);
      await expect(
        repository.listResumeImportFieldCandidates({ runId: persistedRun.id }),
      ).resolves.toEqual(candidatesBeforeTimingUpdate);
      const runAfterTimingUpdate =
        await repository.getLatestResumeImportRun("resume_1");
      expect(runAfterTimingUpdate?.timing?.totalMs).toBe(1_500);
      expect(runAfterTimingUpdate?.timing?.finalizationMs).toBe(275);
    } finally {
      if (repository) {
        await repository.close();
      }
      await temp.cleanup();
    }
  });

  test("atomically finalizes resume import state across sqlite reloads", async () => {
    const temp = await createTempRepository("nestor-db-import-finalize-");
    let firstRepository: FileRepository | null = null;
    let secondRepository: FileRepository | null = null;
    const seed = createSeed();

    try {
      firstRepository = await createFileJobFinderRepository({
        filePath: temp.filePath,
        seed,
      });

      await firstRepository.finalizeResumeImportRun({
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

      await firstRepository.close();
      firstRepository = null;

      secondRepository = await temp.createRepository();

      await expect(secondRepository.getProfile()).resolves.toEqual(
        expect.objectContaining({ fullName: "Taylor Rivera" }),
      );
      await expect(secondRepository.getSearchPreferences()).resolves.toEqual(
        expect.objectContaining({ targetRoles: ["Staff Product Designer"] }),
      );
      await expect(
        secondRepository.getLatestResumeImportRun(seed.profile.baseResume.id),
      ).resolves.toEqual(
        expect.objectContaining({
          id: "resume_import_run_atomic",
          status: "applied",
        }),
      );
      await expect(
        secondRepository.listResumeImportDocumentBundles({
          runId: "resume_import_run_atomic",
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: "resume_bundle_atomic" }),
      ]);
      await expect(
        secondRepository.listResumeImportFieldCandidates({
          runId: "resume_import_run_atomic",
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: "resume_candidate_atomic" }),
      ]);
    } finally {
      if (secondRepository) {
        await secondRepository.close();
      }
      if (firstRepository) {
        await firstRepository.close();
      }
      await temp.cleanup();
    }
  });

  test("repairs profile copilot tables for existing version-4 sqlite files", async () => {
    const temp = await createTempRepository(
      "nestor-db-profile-copilot-migration-",
    );
    let repository: FileRepository | null = null;
    let initialRepository: FileRepository | null = null;

    try {
      initialRepository = await temp.createRepository();
      await initialRepository.close();
      initialRepository = null;

      const database = new DatabaseSync(temp.filePath);
      try {
        database.exec(`
          DROP TABLE IF EXISTS profile_copilot_messages;
          DROP TABLE IF EXISTS profile_revisions;
        `);
        database
          .prepare("DELETE FROM schema_migrations WHERE version = ?")
          .run(5);
      } finally {
        database.close();
      }

      repository = await temp.createRepository();

      await repository.upsertProfileCopilotMessage({
        id: "profile_message_migrated",
        role: "assistant",
        content: "Migration added copilot support.",
        context: { surface: "general" },
        patchGroups: [],
        createdAt: "2026-04-11T11:00:00.000Z",
      });

      await expect(repository.listProfileCopilotMessages()).resolves.toEqual([
        expect.objectContaining({ id: "profile_message_migrated" }),
      ]);
    } finally {
      if (repository) {
        await repository.close();
      }
      if (initialRepository) {
        await initialRepository.close();
      }
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 15000);

  test("dedupe migration rewrites result references without replacing unrelated JSON strings", async () => {
    const temp = await createTempRepository(
      "nestor-db-apply-dedupe-migration-",
    );
    let repository: FileRepository | null = null;
    let initialRepository: FileRepository | null = null;
    const duplicateResultId = "apply_result_duplicate";
    const survivorResult = ApplyJobResultSchema.parse({
      id: "apply_result_survivor",
      runId: "apply_run_dedupe",
      jobId: "job_dedupe",
      queuePosition: 0,
      state: "awaiting_review",
      summary: "Migration kept the newest job result.",
      detail:
        "A later replay checkpoint superseded the older duplicate result.",
      startedAt: "2026-04-18T10:01:00.000Z",
      updatedAt: "2026-04-18T10:01:30.000Z",
      completedAt: null,
      blockerReason: null,
      blockerSummary: null,
      latestQuestionCount: 0,
      latestAnswerCount: 0,
      pendingConsentRequestCount: 0,
      artifactCount: 1,
      latestCheckpointId: null,
    });

    try {
      initialRepository = await temp.createRepository();

      await initialRepository.upsertApplyRun(
        ApplyRunSchema.parse({
          id: "apply_run_dedupe",
          mode: "copilot",
          state: "paused_for_user_review",
          jobIds: ["job_dedupe"],
          currentJobId: "job_dedupe",
          submitApprovalId: null,
          createdAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:01:30.000Z",
          completedAt: null,
          summary: "Apply dedupe migration fixture.",
          detail: "Creates duplicate results to exercise the migration path.",
          totalJobs: 1,
          pendingJobs: 0,
          submittedJobs: 0,
          skippedJobs: 0,
          blockedJobs: 0,
          failedJobs: 0,
        }),
      );
      await initialRepository.upsertApplyJobResult(
        ApplyJobResultSchema.parse({
          id: duplicateResultId,
          runId: "apply_run_dedupe",
          jobId: "job_dedupe",
          queuePosition: 0,
          state: "awaiting_review",
          summary: "Older duplicate apply result.",
          detail: "This row should be deduped in favor of the newer one.",
          startedAt: "2026-04-18T10:00:10.000Z",
          updatedAt: "2026-04-18T10:00:40.000Z",
          completedAt: null,
          blockerReason: null,
          blockerSummary: null,
          latestQuestionCount: 0,
          latestAnswerCount: 0,
          pendingConsentRequestCount: 0,
          artifactCount: 1,
          latestCheckpointId: null,
        }),
      );
      await initialRepository.upsertApplicationArtifactRef(
        ApplicationArtifactRefSchema.parse({
          id: "artifact_dedupe_migration",
          runId: "apply_run_dedupe",
          jobId: "job_dedupe",
          resultId: duplicateResultId,
          questionId: null,
          kind: "field_snapshot",
          label: duplicateResultId,
          createdAt: "2026-04-18T10:00:20.000Z",
          storagePath: null,
          url: "https://jobs.example.com/apply",
          textSnippet: duplicateResultId,
        }),
      );

      await initialRepository.close();
      initialRepository = null;

      const database = new DatabaseSync(temp.filePath);
      try {
        database.exec(
          "DROP INDEX IF EXISTS apply_job_results_run_job_unique_idx",
        );
        database
          .prepare(
            `INSERT INTO apply_job_results (
              id,
              run_id,
              job_id,
              queue_position,
              updated_at,
              state,
              value
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            survivorResult.id,
            survivorResult.runId,
            survivorResult.jobId,
            survivorResult.queuePosition,
            survivorResult.updatedAt,
            survivorResult.state,
            JSON.stringify(survivorResult),
          );
        database
          .prepare("DELETE FROM schema_migrations WHERE version = ?")
          .run(7);
      } finally {
        database.close();
      }

      repository = await temp.createRepository();

      await expect(repository.listApplyJobResults()).resolves.toEqual([
        expect.objectContaining({
          id: survivorResult.id,
          runId: survivorResult.runId,
          jobId: survivorResult.jobId,
        }),
      ]);
      await expect(
        repository.listApplicationArtifactRefs({ resultId: survivorResult.id }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "artifact_dedupe_migration",
          resultId: survivorResult.id,
          label: duplicateResultId,
          textSnippet: duplicateResultId,
        }),
      ]);
      await expect(
        repository.listApplicationArtifactRefs({ resultId: duplicateResultId }),
      ).resolves.toEqual([]);
    } finally {
      if (repository) {
        await repository.close();
      }
      if (initialRepository) {
        await initialRepository.close();
      }
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 15000);

  test("dedupe migration runs before rebuilding apply indexes for legacy sqlite files", async () => {
    const temp = await createTempRepository(
      "nestor-db-apply-dedupe-legacy-migration-",
    );
    let repository: FileRepository | null = null;
    let initialRepository: FileRepository | null = null;
    const duplicateResultId = "apply_result_legacy_duplicate";
    const survivorResult = ApplyJobResultSchema.parse({
      id: "apply_result_legacy_survivor",
      runId: "apply_run_legacy_dedupe",
      jobId: "job_legacy_dedupe",
      queuePosition: 0,
      state: "awaiting_review",
      summary: "Migration kept the newest legacy job result.",
      detail: "A newer result superseded the older duplicate.",
      startedAt: "2026-04-18T10:01:00.000Z",
      updatedAt: "2026-04-18T10:01:30.000Z",
      completedAt: null,
      blockerReason: null,
      blockerSummary: null,
      latestQuestionCount: 0,
      latestAnswerCount: 0,
      pendingConsentRequestCount: 0,
      artifactCount: 0,
      latestCheckpointId: null,
    });

    try {
      initialRepository = await temp.createRepository();

      await initialRepository.upsertApplyRun(
        ApplyRunSchema.parse({
          id: "apply_run_legacy_dedupe",
          mode: "copilot",
          state: "paused_for_user_review",
          jobIds: ["job_legacy_dedupe"],
          currentJobId: "job_legacy_dedupe",
          submitApprovalId: null,
          createdAt: "2026-04-18T10:00:00.000Z",
          updatedAt: "2026-04-18T10:01:30.000Z",
          completedAt: null,
          summary: "Legacy apply dedupe migration fixture.",
          detail: "Creates duplicate results before replaying old migrations.",
          totalJobs: 1,
          pendingJobs: 0,
          submittedJobs: 0,
          skippedJobs: 0,
          blockedJobs: 0,
          failedJobs: 0,
        }),
      );
      await initialRepository.upsertApplyJobResult(
        ApplyJobResultSchema.parse({
          id: duplicateResultId,
          runId: "apply_run_legacy_dedupe",
          jobId: "job_legacy_dedupe",
          queuePosition: 0,
          state: "awaiting_review",
          summary: "Older duplicate apply result.",
          detail: "This row should be deduped in favor of the newer one.",
          startedAt: "2026-04-18T10:00:10.000Z",
          updatedAt: "2026-04-18T10:00:40.000Z",
          completedAt: null,
          blockerReason: null,
          blockerSummary: null,
          latestQuestionCount: 0,
          latestAnswerCount: 0,
          pendingConsentRequestCount: 0,
          artifactCount: 0,
          latestCheckpointId: null,
        }),
      );

      await initialRepository.close();
      initialRepository = null;

      const database = new DatabaseSync(temp.filePath);
      try {
        database.exec(
          "DROP INDEX IF EXISTS apply_job_results_run_job_unique_idx",
        );
        database
          .prepare(
            `INSERT INTO apply_job_results (
              id,
              run_id,
              job_id,
              queue_position,
              updated_at,
              state,
              value
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            survivorResult.id,
            survivorResult.runId,
            survivorResult.jobId,
            survivorResult.queuePosition,
            survivorResult.updatedAt,
            survivorResult.state,
            JSON.stringify(survivorResult),
          );
        // Replay the old migration chain from its old schema, not a current
        // observation table whose migration record has been removed.
        expect(
          database
            .prepare("SELECT COUNT(*) AS count FROM discovery_ledger")
            .get()?.count,
        ).toBe(0);
        database.exec(`
          DROP TRIGGER discovery_ledger_split_insert;
          DROP TRIGGER discovery_ledger_split_update;
          DROP TABLE discovery_ledger_observations;
          DELETE FROM schema_migrations WHERE version >= 4;
        `);
      } finally {
        database.close();
      }

      repository = await temp.createRepository();

      await expect(repository.listApplyJobResults()).resolves.toEqual([
        expect.objectContaining({
          id: survivorResult.id,
          runId: survivorResult.runId,
          jobId: survivorResult.jobId,
        }),
      ]);
    } finally {
      if (repository) {
        await repository.close();
      }
      if (initialRepository) {
        await initialRepository.close();
      }
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 15000);
  test("retains the newest 100 revisions per draft across direct and atomic writes after restart", async () => {
    const temp = await createTempRepository("nestor-db-revision-retention-");
    let repository: FileRepository | null = null;

    try {
      repository = await temp.createRepository();
      const draft = createPersistedRetentionDraft(
        "resume_draft_retained",
        "2026-07-30T10:00:00.000Z",
      );
      await repository.upsertResumeDraft(draft);
      await repository.upsertResumeDraftRevision(
        createPersistedRetentionRevision("resume_draft_other", 0),
      );

      for (
        let index = 0;
        index <= MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT;
        index += 1
      ) {
        await repository.upsertResumeDraftRevision(
          createPersistedRetentionRevision(draft.id, index),
        );
      }

      const directlyRetained = await repository.listResumeDraftRevisions(
        draft.id,
      );
      expect(directlyRetained).toHaveLength(
        MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT,
      );
      expect(directlyRetained[0]?.id).toBe(`${draft.id}_revision_100`);
      expect(directlyRetained.at(-1)?.id).toBe(`${draft.id}_revision_001`);

      const nextDraft = ResumeDraftSchema.parse({
        ...draft,
        updatedAt: "2026-07-30T10:02:00.000Z",
      });
      await repository.applyResumePatchWithRevision({
        expectedDraftUpdatedAt: draft.updatedAt,
        draft: nextDraft,
        revision: createPersistedRetentionRevision(draft.id, 101),
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

      await repository.close();
      repository = await temp.createRepository();

      const reopened = await repository.listResumeDraftRevisions(draft.id);
      expect(reopened).toHaveLength(MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT);
      expect(reopened[0]?.id).toBe(`${draft.id}_revision_101`);
      expect(reopened.at(-1)?.id).toBe(`${draft.id}_revision_002`);
      await expect(
        repository.listResumeDraftRevisions("resume_draft_other"),
      ).resolves.toHaveLength(1);
    } finally {
      await repository?.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 30000);

  test("persists an exact restored draft and cleared approval readiness after restart", async () => {
    const temp = await createTempRepository("nestor-db-revision-restore-");
    let repository: FileRepository | null = null;

    try {
      repository = await temp.createRepository();
      const approvedDraft = ResumeDraftSchema.parse({
        ...createPersistedRetentionDraft(
          "resume_draft_restore",
          "2026-07-30T10:05:00.000Z",
        ),
        status: "approved",
        templateId: "compact_exec",
        approvedAt: "2026-07-30T10:05:00.000Z",
        approvedExportId: "resume_export_restore",
      });
      const restoredDraft = ResumeDraftSchema.parse({
        ...approvedDraft,
        status: "needs_review",
        templateId: "classic_ats",
        approvedAt: null,
        approvedExportId: null,
        updatedAt: "2026-07-30T10:06:00.000Z",
      });
      const sourceRevision = ResumeDraftRevisionSchema.parse({
        ...createPersistedRetentionRevision(approvedDraft.id, 0),
        snapshotDraft: restoredDraft,
        snapshotIdentity: restoredDraft.identity,
        snapshotSections: restoredDraft.sections,
        reason: "Known-good earlier draft",
      });
      const restoreRevision = ResumeDraftRevisionSchema.parse({
        ...createPersistedRetentionRevision(approvedDraft.id, 1),
        parentRevisionId: sourceRevision.id,
        mutationKind: "restore",
        snapshotDraft: approvedDraft,
        snapshotIdentity: approvedDraft.identity,
        snapshotSections: approvedDraft.sections,
        restoredFromRevisionId: sourceRevision.id,
        reason: "Restored known-good earlier draft",
      });

      await repository.approveResumeExport({
        draft: approvedDraft,
        exportArtifact: {
          id: "resume_export_restore",
          draftId: approvedDraft.id,
          jobId: approvedDraft.jobId,
          format: "pdf",
          filePath: "/tmp/approved-restore.pdf",
          pageCount: 2,
          templateId: approvedDraft.templateId,
          exportedAt: approvedDraft.updatedAt,
          isApproved: true,
        },
      });
      await repository.upsertResumeDraftRevision(sourceRevision);
      await repository.applyResumePatchWithRevision({
        expectedDraftUpdatedAt: approvedDraft.updatedAt,
        draft: restoredDraft,
        revision: restoreRevision,
        validation: ResumeValidationResultSchema.parse({
          id: "validation_restore",
          draftId: approvedDraft.id,
          issues: [],
          draftContentHash: null,
          claimAssessments: [],
          pageCount: 2,
          validatedAt: restoredDraft.updatedAt,
        }),
      });

      await repository.close();
      repository = await temp.createRepository();

      await expect(
        repository.getResumeDraftByJobId(approvedDraft.jobId),
      ).resolves.toEqual(restoredDraft);
      const revisions = await repository.listResumeDraftRevisions(
        approvedDraft.id,
      );
      expect(revisions[0]).toEqual(
        expect.objectContaining({
          id: restoreRevision.id,
          parentRevisionId: sourceRevision.id,
          restoredFromRevisionId: sourceRevision.id,
          mutationKind: "restore",
        }),
      );
      await expect(
        repository.listResumeExportArtifacts({ jobId: approvedDraft.jobId }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "resume_export_restore",
          isApproved: false,
        }),
      ]);
    } finally {
      await repository?.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  }, 15000);
  test("persists resume revision chains across restart and rejects stale atomic commits", async () => {
    const temp = await createTempRepository("nestor-db-resume-revisions-");
    let repository: FileRepository | null = null;

    try {
      repository = await temp.createRepository();
      const initialDraft = ResumeDraftSchema.parse({
        id: "resume_draft_versioned",
        jobId: "job_versioned",
        status: "needs_review",
        templateId: "classic_ats",
        identity: null,
        sections: [],
        targetPageCount: 2,
        generationMethod: "ai",
        approvedAt: null,
        approvedExportId: null,
        staleReason: null,
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
      });
      const nextDraft = ResumeDraftSchema.parse({
        ...initialDraft,
        templateId: "compact_exec",
        updatedAt: "2026-07-30T10:01:00.000Z",
      });
      const revision = ResumeDraftRevisionSchema.parse({
        id: "resume_revision_versioned_1",
        draftId: initialDraft.id,
        parentRevisionId: null,
        actor: "user",
        mutationKind: "manual_save",
        snapshotDraft: initialDraft,
        snapshotIdentity: initialDraft.identity,
        snapshotSections: initialDraft.sections,
        beforeHash: "before_hash",
        afterHash: "after_hash",
        diff: {
          templateChanged: true,
          identityChanged: false,
          sectionOrderChanged: false,
          addedSectionIds: [],
          removedSectionIds: [],
          changedSectionIds: [],
        },
        restoredFromRevisionId: null,
        createdAt: nextDraft.updatedAt,
        reason: "Changed resume template",
      });
      const validation = ResumeValidationResultSchema.parse({
        id: "resume_validation_versioned_1",
        draftId: initialDraft.id,
        issues: [],
        draftContentHash: "claim_hash",
        claimAssessments: [],
        pageCount: null,
        validatedAt: nextDraft.updatedAt,
      });

      await repository.upsertResumeDraft(initialDraft);
      await repository.applyResumePatchWithRevision({
        expectedDraftUpdatedAt: initialDraft.updatedAt,
        draft: nextDraft,
        revision,
        validation,
      });
      await repository.close();
      repository = await temp.createRepository();

      expect(await repository.getResumeDraftByJobId(nextDraft.jobId)).toEqual(
        nextDraft,
      );
      expect(
        await repository.listResumeDraftRevisions(initialDraft.id),
      ).toEqual([revision]);

      await expect(
        Promise.resolve().then(() =>
          repository!.applyResumePatchWithRevision({
            expectedDraftUpdatedAt: initialDraft.updatedAt,
            draft: {
              ...nextDraft,
              templateId: "modern_split",
              updatedAt: "2026-07-30T10:02:00.000Z",
            },
            revision: {
              ...revision,
              id: "resume_revision_stale",
              parentRevisionId: revision.id,
              createdAt: "2026-07-30T10:02:00.000Z",
            },
            validation: {
              ...validation,
              id: "resume_validation_stale",
              validatedAt: "2026-07-30T10:02:00.000Z",
            },
          }),
        ),
      ).rejects.toThrow(/changed before this edit could be saved/i);
      expect(
        await repository.listResumeDraftRevisions(initialDraft.id),
      ).toEqual([revision]);
    } finally {
      await repository?.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

describe("persisted row corruption handling", () => {
  test("rejects malformed JSON before a saved-job write can corrupt the row", async () => {
    const temp = await createTempRepository("nestor-db-corrupt-job-row-");
    const repository = await temp.createRepository();
    try {
      await repository.replaceSavedJobs([
        createSavedJob({ id: "job_guarded" }),
      ]);
      const other = new DatabaseSync(temp.filePath);
      try {
        expect(() =>
          other
            .prepare("UPDATE saved_jobs SET value = ? WHERE id = ?")
            .run('{"id":"broken"', "job_guarded"),
        ).toThrow("malformed JSON");
      } finally {
        other.close();
      }
      expect((await repository.listSavedJobs()).map((job) => job.id)).toEqual([
        "job_guarded",
      ]);
    } finally {
      await repository.close();
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
  test("fails loudly instead of falling back to the seed when a settings singleton is corrupted", async () => {
    const sensitiveMarker = "SECRET-TOKEN-4c2e";
    const temp = await createTempRepository("nestor-db-corrupt-settings-");
    let repository: FileRepository | null = null;
    try {
      repository = await temp.createRepository();
      await repository.close();
      repository = null;

      const corruptedDatabase = new DatabaseSync(temp.filePath);
      try {
        corruptedDatabase
          .prepare("UPDATE singleton_state SET value = ? WHERE key = ?")
          .run(`{"resumeFormat":"pdf","note":"${sensitiveMarker}`, "settings");
      } finally {
        corruptedDatabase.close();
      }

      {
        const failure = await temp
          .createRepository()
          .catch((error) => error as unknown);

        expect(failure).toBeInstanceOf(Error);
        const failureMessage = failure instanceof Error ? failure.message : "";
        expect(failureMessage).toContain('table "singleton_state"');
        expect(failureMessage).toContain('row "settings"');
        expect(failureMessage).not.toContain(sensitiveMarker);

        const verificationDatabase = new DatabaseSync(temp.filePath);
        try {
          const survivingRow = verificationDatabase
            .prepare(
              "SELECT COUNT(*) AS count FROM singleton_state WHERE key = ?",
            )
            .get("settings") as { count: number };
          expect(Number(survivingRow.count)).toBe(1);
        } finally {
          verificationDatabase.close();
        }
      }
    } finally {
      await repository?.close().catch(() => undefined);
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

describe("repository backend parity", () => {
  const cleanupDirectories: string[] = [];
  const repositories: JobFinderRepository[] = [];

  afterEach(async () => {
    await Promise.all(
      repositories
        .splice(0)
        .map((repository) => repository.close().catch(() => undefined)),
    );
    await Promise.all(
      cleanupDirectories.splice(0).map(cleanupTempDirectoryWithRetry),
    );
  });

  const backends = [
    {
      label: "in memory",
      create: (): Promise<JobFinderRepository> =>
        Promise.resolve(createInMemoryJobFinderRepository(createSeed())),
    },
    {
      label: "in SQLite",
      create: async (): Promise<JobFinderRepository> => {
        const temp = await createTempRepository("nestor-backend-parity-");
        cleanupDirectories.push(temp.tempDirectory);
        return temp.createRepository();
      },
    },
  ];

  async function createBackend(
    create: () => Promise<JobFinderRepository>,
  ): Promise<JobFinderRepository> {
    const repository = await create();
    repositories.push(repository);
    return repository;
  }

  function createParityDraft(input: {
    id: string;
    jobId: string;
    updatedAt: string;
    status: "needs_review" | "approved";
    approvedExportId?: string | null;
    approvedAt?: string | null;
  }) {
    return ResumeDraftSchema.parse({
      id: input.id,
      jobId: input.jobId,
      status: input.status,
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "manual",
      approvedAt: input.approvedAt ?? null,
      approvedExportId: input.approvedExportId ?? null,
      staleReason: null,
      createdAt: "2026-07-30T10:00:00.000Z",
      updatedAt: input.updatedAt,
    });
  }

  function createParityExport(input: {
    id: string;
    draftId: string;
    jobId: string;
    exportedAt: string;
    isApproved?: boolean;
  }) {
    return ResumeExportArtifactSchema.parse({
      id: input.id,
      draftId: input.draftId,
      jobId: input.jobId,
      format: "pdf",
      filePath: `/tmp/${input.id}.pdf`,
      pageCount: 1,
      templateId: "classic_ats",
      exportedAt: input.exportedAt,
      isApproved: input.isApproved ?? false,
    });
  }

  function createParityTailoredAsset(input: {
    id: string;
    jobId: string;
    updatedAt: string;
  }) {
    return TailoredAssetSchema.parse({
      id: input.id,
      jobId: input.jobId,
      kind: "resume",
      status: "ready",
      label: "Tailored resume",
      version: "v1",
      templateName: "Classic ATS",
      compatibilityScore: 90,
      progressPercent: 100,
      updatedAt: input.updatedAt,
      storagePath: `/tmp/${input.id}.pdf`,
    });
  }

  test.each(backends)(
    "refuses an approved resume export outside approveResumeExport ($label)",
    async ({ create }) => {
      const repository = await createBackend(create);
      const draft = createParityDraft({
        id: "draft_parity_export",
        jobId: "job_parity_export",
        updatedAt: "2026-07-30T11:00:00.000Z",
        status: "needs_review",
      });
      await repository.upsertResumeDraft(draft);

      await expect(
        Promise.resolve().then(() =>
          repository.upsertResumeExportArtifact(
            createParityExport({
              id: "export_parity_approved",
              draftId: draft.id,
              jobId: draft.jobId,
              exportedAt: "2026-07-30T11:05:00.000Z",
              isApproved: true,
            }),
          ),
        ),
      ).rejects.toThrow(
        "Approved resume exports must be written through approveResumeExport().",
      );
      expect(await repository.listResumeExportArtifacts()).toEqual([]);

      await repository.upsertResumeExportArtifact(
        createParityExport({
          id: "export_parity_unapproved",
          draftId: draft.id,
          jobId: draft.jobId,
          exportedAt: "2026-07-30T11:05:00.000Z",
        }),
      );
      expect(await repository.listResumeExportArtifacts()).toEqual([
        expect.objectContaining({
          id: "export_parity_unapproved",
          isApproved: false,
        }),
      ]);
    },
  );

  test.each(backends)(
    "clears the newest draft's approval when the job text changes ($label)",
    async ({ create }) => {
      const repository = await createBackend(create);
      const job = createSavedJob({
        id: "job_parity_clear",
        description: "Original description.",
      });
      await repository.commitSavedJobDelta({ upserts: [job] });

      const olderDraft = createParityDraft({
        id: "draft_parity_older",
        jobId: job.id,
        updatedAt: "2026-07-30T10:00:00.000Z",
        status: "needs_review",
      });
      const newerDraft = createParityDraft({
        id: "draft_parity_newer",
        jobId: job.id,
        updatedAt: "2026-07-30T12:00:00.000Z",
        status: "approved",
        approvedAt: "2026-07-30T12:00:00.000Z",
        approvedExportId: "export_parity_newer",
      });
      // Insert the abandoned draft first so a first-inserted lookup would
      // choose it over the newer approved draft.
      await repository.upsertResumeDraft(olderDraft);
      await repository.upsertResumeDraft(newerDraft);
      await repository.approveResumeExport({
        draft: newerDraft,
        exportArtifact: createParityExport({
          id: "export_parity_newer",
          draftId: newerDraft.id,
          jobId: job.id,
          exportedAt: "2026-07-30T12:00:00.000Z",
          isApproved: true,
        }),
      });
      await repository.upsertTailoredAsset(
        createParityTailoredAsset({
          id: "asset_parity_older",
          jobId: job.id,
          updatedAt: "2026-07-30T10:00:00.000Z",
        }),
      );
      await repository.upsertTailoredAsset(
        createParityTailoredAsset({
          id: "asset_parity_newer",
          jobId: job.id,
          updatedAt: "2026-07-30T12:00:00.000Z",
        }),
      );

      await repository.commitSavedJobDelta({
        update: (current) =>
          current.id === job.id
            ? { ...current, description: "Rewritten description." }
            : current,
        clearResumeApproval: {
          jobId: job.id,
          staleReason: "The job description changed.",
          shouldClear: (previousJob, nextJob) =>
            previousJob.description !== nextJob.description,
        },
      });

      const drafts = await repository.listResumeDrafts();
      expect(drafts.find((entry) => entry.id === newerDraft.id)).toMatchObject({
        status: "stale",
        staleReason: "The job description changed.",
        approvedAt: null,
        approvedExportId: null,
      });
      expect(drafts.find((entry) => entry.id === olderDraft.id)).toMatchObject({
        status: "needs_review",
        staleReason: null,
      });
      expect(
        (await repository.listResumeExportArtifacts()).every(
          (artifact) => artifact.isApproved === false,
        ),
      ).toBe(true);
      const assets = await repository.listTailoredAssets();
      expect(
        assets.find((asset) => asset.id === "asset_parity_newer"),
      ).toMatchObject({ storagePath: null });
      expect(
        assets.find((asset) => asset.id === "asset_parity_older"),
      ).toMatchObject({ storagePath: "/tmp/asset_parity_older.pdf" });
    },
  );

  test.each(backends)(
    "marks drafts stale in place and leaves the rest of each draft as stored ($label)",
    async ({ create }) => {
      const repository = await createBackend(create);
      const job = createSavedJob({ id: "job_parity_restale" });
      const other = createSavedJob({ id: "job_parity_untouched" });
      await repository.commitSavedJobDelta({ upserts: [job, other] });
      const approved = createParityDraft({
        id: "draft_parity_restale",
        jobId: job.id,
        updatedAt: "2026-07-30T12:00:00.000Z",
        status: "approved",
        approvedAt: "2026-07-30T12:00:00.000Z",
        approvedExportId: "export_parity_restale",
      });
      const untouched = createParityDraft({
        id: "draft_parity_untouched",
        jobId: other.id,
        updatedAt: "2026-07-30T11:00:00.000Z",
        status: "needs_review",
      });
      await repository.upsertResumeDraft(approved);
      await repository.upsertResumeDraft(untouched);
      await repository.approveResumeExport({
        draft: approved,
        exportArtifact: createParityExport({
          id: "export_parity_restale",
          draftId: approved.id,
          jobId: job.id,
          exportedAt: "2026-07-30T12:00:00.000Z",
          isApproved: true,
        }),
      });
      await repository.upsertTailoredAsset(
        createParityTailoredAsset({
          id: "asset_parity_restale",
          jobId: job.id,
          updatedAt: "2026-07-30T12:00:00.000Z",
        }),
      );
      const [before] = (await repository.listResumeDrafts()).filter(
        (entry) => entry.id === approved.id,
      );

      await repository.staleResumeDrafts!({
        draftIds: [approved.id, "draft_missing"],
        staleReason: "Profile details changed.",
        updatedAt: "2026-07-31T09:00:00.000Z",
      });

      const drafts = await repository.listResumeDrafts();
      expect(drafts.find((entry) => entry.id === approved.id)).toEqual({
        ...before,
        status: "stale",
        staleReason: "Profile details changed.",
        approvedAt: null,
        approvedExportId: null,
        updatedAt: "2026-07-31T09:00:00.000Z",
      });
      expect(drafts.find((entry) => entry.id === untouched.id)).toMatchObject({
        status: "needs_review",
        updatedAt: "2026-07-30T11:00:00.000Z",
      });
      expect(
        (await repository.listResumeExportArtifacts()).every(
          (artifact) => artifact.isApproved === false,
        ),
      ).toBe(true);
      expect(
        (await repository.listTailoredAssets()).find(
          (asset) => asset.id === "asset_parity_restale",
        ),
      ).toMatchObject({
        storagePath: null,
        updatedAt: "2026-07-31T09:00:00.000Z",
      });
    },
  );

  test.each(backends)(
    "advances the profile epoch when discovery feedback writes preferences ($label)",
    async ({ create }) => {
      const repository = await createBackend(create);
      const job = createSavedJob({ id: "job_parity_epoch" });
      await repository.commitSavedJobDelta({ upserts: [job] });
      const before = await repository.getProfileWithRevision();

      // An ordinary dismissal rewrites the same preferences. It must not
      // invalidate an in-flight profile operation that captured this epoch.
      await repository.commitDiscoveryFeedbackUpdate(job.id, (current) => ({
        result: null,
        searchPreferences: current.searchPreferences,
        campaignState: current.campaignState,
        discoveryState: current.discoveryState,
      }));
      expect((await repository.getProfileWithRevision()).revision).toBe(
        before.revision,
      );

      await repository.commitDiscoveryFeedbackUpdate(job.id, (current) => ({
        result: null,
        searchPreferences: {
          ...current.searchPreferences,
          companyBlacklist: [
            ...current.searchPreferences.companyBlacklist,
            "Excluded Employer",
          ],
        },
        campaignState: current.campaignState,
        discoveryState: current.discoveryState,
      }));

      const after = await repository.getProfileWithRevision();
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(
        (await repository.getSearchPreferences()).companyBlacklist,
      ).toContain("Excluded Employer");

      // A copilot commit that captured the pre-feedback epoch must fail
      // closed instead of reverting the exclusion the user just made.
      const staleCommit = await repository.commitProfileCopilotState({
        profile: before.profile,
        searchPreferences: {
          ...(await repository.getSearchPreferences()),
          companyBlacklist: [],
        },
        profileSetupState: await repository.getProfileSetupState(),
        expectedProfileRevision: before.revision,
      });
      expect(staleCommit).toMatchObject({ status: "stale" });
      expect(
        (await repository.getSearchPreferences()).companyBlacklist,
      ).toContain("Excluded Employer");
    },
  );

  test.each(backends)(
    "advances the profile epoch when campaign preferences are committed ($label)",
    async ({ create }) => {
      const repository = await createBackend(create);
      const before = await repository.getProfileWithRevision();
      const now = "2026-08-01T10:00:00.000Z";
      const buildCampaign = (
        searchPreferences: JobSearchPreferences,
      ): JobSearchCampaign =>
        JobSearchCampaignSchema.parse({
          id: "campaign_parity",
          name: "Parity campaign",
          mode: "precision",
          status: "active",
          createdAt: now,
          updatedAt: now,
          searchPreferences,
          sourceTargetIds: [],
          ...getDefaultCampaignConfiguration("precision"),
          schedule: {},
          progress: { lastUpdatedAt: now },
        });

      // A campaign-only edit leaves the shared preferences untouched and must
      // not invalidate an in-flight profile operation.
      await repository.commitCampaignPreferencesUpdate((current) => ({
        result: null,
        campaignState: {
          campaigns: [buildCampaign(current.searchPreferences)],
          activeCampaignId: "campaign_parity",
          notifications: [],
        },
        searchPreferences: current.searchPreferences,
      }));
      expect((await repository.getProfileWithRevision()).revision).toBe(
        before.revision,
      );

      await repository.commitCampaignPreferencesUpdate((current) => {
        const campaign = buildCampaign(current.searchPreferences);
        return {
          result: null,
          campaignState: {
            campaigns: [campaign],
            activeCampaignId: campaign.id,
            notifications: [],
          },
          searchPreferences: {
            ...current.searchPreferences,
            companyBlacklist: [
              ...current.searchPreferences.companyBlacklist,
              "Campaign Excluded Employer",
            ],
          },
        };
      });

      const after = await repository.getProfileWithRevision();
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(
        (await repository.getSearchPreferences()).companyBlacklist,
      ).toContain("Campaign Excluded Employer");
    },
  );
});
