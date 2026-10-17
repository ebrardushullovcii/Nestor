import {
  ApplyExecutionResultSchema,
  ApplicationAttemptBlockerSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplicationReviewCardSchema,
  ApplicationResumeArtifactSchema,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  buildApplicationPrivacyReceipt,
  describeApplicationPreparation,
  hasVerifiedApplicationSubmission,
  buildApplyCopilotArtifacts,
  enforcePrepareOnlyExecutionResult,
  mapExecutionResultToApplyBlockerReason,
  reconcileApplyRunAfterConfirmedSubmission,
  summarizeApplyJobResultStates,
} from "./workspace-apply-run-support";

it("preserves a CAPTCHA handoff as site protection instead of an unanswered question", () => {
  const blocker = ApplicationAttemptBlockerSchema.parse({
    code: "requires_manual_review",
    userActionKind: "captcha",
    summary: "The site asks you to complete a CAPTCHA.",
  });
  expect(mapExecutionResultToApplyBlockerReason(blocker)).toBe(
    "site_protection",
  );
  expect(
    mapExecutionResultToApplyBlockerReason({
      ...blocker,
      userActionKind: null,
    }),
  ).toBe("required_human_input");
});

describe("reconcileApplyRunAfterConfirmedSubmission", () => {
  it("keeps a paused batch's exact limit and does not invent a confirmed send", () => {
    const run = ApplyRunSchema.parse({
      id: "run_limit",
      state: "paused_for_user_review",
      jobIds: ["a", "b"],
      createdAt: "2026-10-02T09:00:00.000Z",
      updatedAt: "2026-10-02T09:00:00.000Z",
      summary: "Daily limit reached",
      detail: "The daily limit of 8 applications was reached.",
      totalJobs: 2,
      pendingJobs: 2,
    });
    const results = ["a", "b"].map((jobId) =>
      ApplyJobResultSchema.parse({
        id: jobId,
        runId: run.id,
        jobId,
        state: jobId === "a" ? "failed" : "planned",
        summary: "Not sent",
        detail: "Not sent",
        startedAt: run.createdAt,
        updatedAt: run.updatedAt,
      }),
    );
    const next = reconcileApplyRunAfterConfirmedSubmission({
      run,
      results,
      submittedAt: run.updatedAt,
      submittedSummary: "Could not apply",
      submittedDetail: "Nothing sent",
    });
    expect(next.detail).toBe(run.detail);
    expect(next.submittedJobs).toBe(0);
    const review = reconcileApplyRunAfterConfirmedSubmission({
      run: { ...run, state: "running" },
      results: results.map((result) => ({
        ...result,
        state: "awaiting_review",
      })),
      submittedAt: run.updatedAt,
      submittedSummary: "Prepared",
      submittedDetail: "Review",
    });
    expect(review.detail).toContain("Nothing was confirmed sent");
  });
  const at = "2026-07-30T10:00:00.000Z";
  const later = "2026-07-30T10:05:00.000Z";
  const result = (jobId: string, state: "awaiting_review" | "submitted") =>
    ApplyJobResultSchema.parse({
      id: `result_${jobId}`,
      runId: "run_two_ask",
      jobId,
      applicationRecordId: `application_${jobId}`,
      state,
      summary: state === "submitted" ? "Application submitted" : "Ready",
      detail: state === "submitted" ? "Confirmed." : "Review it.",
      startedAt: at,
      updatedAt: state === "submitted" ? later : at,
      completedAt: state === "submitted" ? later : null,
    });

  it("keeps the second Ask application pending after the first is sent", () => {
    const run = ApplyRunSchema.parse({
      id: "run_two_ask",
      state: "paused_for_user_review",
      jobIds: ["job_a", "job_b"],
      currentJobId: "job_a",
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      summary: "Two applications are ready",
      detail: "Review each one.",
      totalJobs: 2,
      pendingJobs: 2,
    });
    const afterFirst = reconcileApplyRunAfterConfirmedSubmission({
      run,
      results: [
        result("job_a", "submitted"),
        result("job_b", "awaiting_review"),
      ],
      submittedAt: later,
      submittedSummary: "Application submitted",
      submittedDetail: "Confirmed.",
    });
    expect(afterFirst).toMatchObject({
      state: "paused_for_user_review",
      currentJobId: "job_b",
      completedAt: null,
      pendingJobs: 1,
      submittedJobs: 1,
      totalJobs: 2,
    });

    const afterSecond = reconcileApplyRunAfterConfirmedSubmission({
      run: afterFirst,
      results: [result("job_a", "submitted"), result("job_b", "submitted")],
      submittedAt: later,
      submittedSummary: "Application submitted",
      submittedDetail: "Confirmed.",
    });
    expect(afterSecond).toMatchObject({
      state: "completed",
      currentJobId: null,
      completedAt: later,
      pendingJobs: 0,
      submittedJobs: 2,
      totalJobs: 2,
    });
  });
});

describe("summarizeApplyJobResultStates", () => {
  it("uses the durable post-send result instead of an earlier prepared row", () => {
    const base = {
      runId: "run_send_queue",
      applicationRecordId: "application_job_a",
      summary: "Ready",
      detail: "Prepared for review.",
      startedAt: "2026-07-30T10:00:00.000Z",
      completedAt: null,
    };
    const prepared = ApplyJobResultSchema.parse({
      ...base,
      id: "result_job_a_prepared",
      jobId: "job_a",
      state: "awaiting_review",
      updatedAt: "2026-07-30T10:01:00.000Z",
    });
    const submitted = ApplyJobResultSchema.parse({
      ...base,
      id: "result_job_a_submitted",
      jobId: "job_a",
      state: "submitted",
      summary: "Application submitted",
      detail: "Confirmed.",
      updatedAt: "2026-07-30T10:02:00.000Z",
      completedAt: "2026-07-30T10:02:00.000Z",
    });
    const blocked = ApplyJobResultSchema.parse({
      ...base,
      id: "result_job_b",
      jobId: "job_b",
      applicationRecordId: "application_job_b",
      state: "blocked",
      updatedAt: "2026-07-30T10:03:00.000Z",
    });

    expect(
      summarizeApplyJobResultStates([prepared, submitted, blocked]),
    ).toEqual({
      submittedJobs: 1,
      awaitingReviewJobs: 0,
      blockedJobs: 1,
      failedJobs: 0,
      skippedJobs: 0,
    });
  });
});

describe("buildApplicationPrivacyReceipt", () => {
  it("records the actual form upload without claiming a different approved file's identity", () => {
    const job = createSeed().savedJobs[0]!;
    const at = "2026-07-30T10:00:00.000Z";
    const receipt = buildApplicationPrivacyReceipt({
      applicationRecordId: "application-mismatch",
      job,
      generatedAt: at,
      runId: "run-mismatch",
      resultId: "result-mismatch",
      resumeArtifact: ApplicationResumeArtifactSchema.parse({
        id: "approved-resume",
        jobId: job.id,
        source: "tailored_export",
        sourceDocumentId: null,
        exportArtifactId: "approved-export",
        fileName: "approved.pdf",
        filePath: "/tmp/approved.pdf",
        sha256: "a".repeat(64),
        approvedAt: at,
      }),
      reviewCard: ApplicationReviewCardSchema.parse({
        siteLabel: "Replica",
        pageUrl: job.applicationUrl,
        attachments: [
          { label: "Resume", field: "Resume / CV", fileName: "original.docx" },
        ],
        preparedAt: at,
      }),
      executionResult: ApplyExecutionResultSchema.parse({
        state: "paused",
        summary: "Needs a document",
        detail: "Nothing was sent.",
        submittedAt: null,
        outcome: null,
        nextActionLabel: null,
      }),
    });
    expect(receipt.resume).toMatchObject({
      fileName: "original.docx",
      sourceDocumentId: null,
      exportArtifactId: null,
      sha256: null,
    });
  });

  it("redacts destination secrets and records verified preparation writes", () => {
    const job = {
      ...createSeed().savedJobs[0]!,
      applicationUrl:
        "https://boards.greenhouse.io/example/jobs/123?candidate_token=secret#apply",
    };
    const generatedAt = "2026-07-30T10:00:00.000Z";
    const receipt = buildApplicationPrivacyReceipt({
      applicationRecordId: "application-record-1",
      job,
      generatedAt,
      runId: "run-1",
      resultId: "result-1",
      resumeArtifact: ApplicationResumeArtifactSchema.parse({
        id: "resume-1",
        jobId: job.id,
        source: "original_upload",
        sourceDocumentId: "document-1",
        exportArtifactId: null,
        fileName: "Original CV.pdf",
        filePath: "C:/private/Original CV.pdf",
        sha256: "a".repeat(64),
        approvedAt: generatedAt,
      }),
      executionResult: ApplyExecutionResultSchema.parse({
        state: "paused",
        summary: "Prepared",
        detail: "Stopped before final submit.",
        submittedAt: null,
        outcome: null,
        nextActionLabel: "Review the prepared application",
        questions: [
          {
            id: "resume-question",
            prompt: "Resume",
            kind: "resume",
            detectedAt: generatedAt,
            submittedAnswer: "C:/private/Original CV.pdf",
            status: "answered",
          },
          {
            id: "name-question",
            prompt: "Full name",
            kind: "personal_info",
            detectedAt: generatedAt,
            submittedAnswer: "Alex Vanguard",
            status: "answered",
          },
        ],
        checkpoints: [],
        externalWrites: [
          {
            category: "resume_attachment",
            fieldLabel: "Resume",
            occurredAt: generatedAt,
            verified: true,
          },
          {
            category: "profile_field",
            fieldLabel: "Full name",
            occurredAt: generatedAt,
            verified: true,
          },
        ],
      }),
    });

    expect(receipt.resume.sha256).toBe("a".repeat(64));
    expect(receipt.destination).toEqual({
      origin: "https://boards.greenhouse.io",
      safePath: "/example/jobs/123",
    });
    expect(JSON.stringify(receipt)).not.toContain("candidate_token");
    expect(JSON.stringify(receipt)).not.toContain("C:/private");
    expect(receipt.resume.fileName).toBe("Original CV.pdf");
    expect(receipt.externalWrites).toEqual([
      expect.objectContaining({
        category: "resume_attachment",
        fieldLabel: "Resume",
        verified: true,
      }),
      expect.objectContaining({
        category: "profile_field",
        fieldLabel: "Full name",
        verified: true,
      }),
    ]);
    expect(receipt.modelUse).toEqual([]);
    expect(receipt.accountCreationAuthorized).toBe(false);
    expect(receipt.finalSubmitAuthorized).toBe(false);
    expect(receipt.finalSubmitOccurred).toBe(false);
  });

  it.each([
    { state: "submitted" as const, submittedAt: null, outcome: null },
    {
      state: "paused" as const,
      submittedAt: "2026-07-30T10:01:00.000Z",
      outcome: null,
    },
    {
      state: "paused" as const,
      submittedAt: null,
      outcome: "submitted" as const,
    },
  ])(
    "rejects an impossible prepare-only submission signal %#",
    (unsafeSignal) => {
      expect(() =>
        enforcePrepareOnlyExecutionResult(
          ApplyExecutionResultSchema.parse({
            ...unsafeSignal,
            summary: "Unsafe runtime response",
            detail: "A prepare-only adapter reported submission.",
            checkpoints: [],
            questions: [],
            blocker: null,
            consentDecisions: [],
            replay: {},
            visualEvidence: [],
            visualObservationSets: [],
            visualCheckpoints: [],
            nextActionLabel: null,
            executionTimings: [],
          }),
        ),
      ).toThrow(/without final-submit authorization/iu);
    },
  );

  it("creates a scoped fallback checkpoint when a blocker has no runtime checkpoint", () => {
    const job = createSeed().savedJobs[0]!;
    const detectedAt = "2026-07-30T10:00:00.000Z";
    const artifacts = buildApplyCopilotArtifacts({
      applicationRecordId: "application-record-fallback",
      job,
      detectedAt,
      runId: "run-fallback-checkpoint",
      resultId: "result-fallback-checkpoint",
      resumeArtifact: ApplicationResumeArtifactSchema.parse({
        id: "resume-fallback-checkpoint",
        jobId: job.id,
        source: "original_upload",
        sourceDocumentId: "document-fallback-checkpoint",
        exportArtifactId: null,
        fileName: "Original CV.pdf",
        filePath: "C:/private/Original CV.pdf",
        sha256: "b".repeat(64),
        approvedAt: detectedAt,
      }),
      executionResult: ApplyExecutionResultSchema.parse({
        state: "paused",
        summary: "A browser step needs you",
        detail: "Stopped without submitting.",
        submittedAt: null,
        outcome: null,
        checkpoints: [],
        questions: [],
        blocker: {
          code: "requires_manual_review",
          userActionKind: "captcha",
          summary: "Complete the CAPTCHA yourself.",
          url: job.applicationUrl,
        },
        consentDecisions: [],
        replay: {},
        visualEvidence: [],
        visualObservationSets: [],
        visualCheckpoints: [],
        nextActionLabel: "Complete the browser step",
        executionTimings: [],
      }),
    });

    expect(artifacts.checkpoints).toEqual([
      expect.objectContaining({
        runId: "run-fallback-checkpoint",
        jobId: job.id,
        resultId: "result-fallback-checkpoint",
        label: "Browser action required",
        jobState: "awaiting_review",
      }),
    ]);
    expect(artifacts.result.latestCheckpointId).toBe(
      artifacts.checkpoints[0]?.id,
    );
    expect(artifacts.result.privacyReceipt).toMatchObject({
      accountCreationAuthorized: false,
      finalSubmitAuthorized: false,
      finalSubmitOccurred: false,
    });
  });
});

describe("buildApplyCopilotArtifacts", () => {
  it("keeps the exact one-off application review card on the result", () => {
    const job = createSeed().savedJobs[0]!;
    const detectedAt = "2026-07-30T10:00:00.000Z";
    const reviewCard = ApplicationReviewCardSchema.parse({
      siteLabel: "Replica board",
      pageUrl: job.applicationUrl,
      answers: [
        {
          question: "Full name",
          answer: "Alex Vanguard",
          source: "Saved profile",
          written: false,
          groundedIn: [],
        },
      ],
      attachments: [
        {
          label: "Your CV",
          fileName: "Original CV.pdf",
          field: "Resume",
        },
      ],
      letter: null,
      waitingOnYou: [],
      preparedAt: detectedAt,
    });
    const artifacts = buildApplyCopilotArtifacts({
      applicationRecordId: "application-review-card",
      job,
      detectedAt,
      reviewCard,
      runId: "run-review-card",
      resultId: "result-review-card",
      resumeArtifact: ApplicationResumeArtifactSchema.parse({
        id: "resume-review-card",
        jobId: job.id,
        source: "original_upload",
        sourceDocumentId: "document-review-card",
        exportArtifactId: null,
        fileName: "Original CV.pdf",
        filePath: "/tmp/Original CV.pdf",
        sha256: "a".repeat(64),
        approvedAt: detectedAt,
      }),
      executionResult: ApplyExecutionResultSchema.parse({
        state: "ready",
        summary: "Prepared",
        detail: "Ready for review.",
        submittedAt: null,
        outcome: null,
        checkpoints: [],
        questions: [],
        blocker: null,
        consentDecisions: [],
        replay: {},
        visualEvidence: [],
        visualObservationSets: [],
        visualCheckpoints: [],
        nextActionLabel: "Review it and send it",
        executionTimings: [],
      }),
    });

    expect(artifacts.result.reviewCard).toEqual(reviewCard);
    expect(artifacts.result.latestQuestionCount).toBe(1);
    expect(artifacts.result.latestAnswerCount).toBe(1);
  });
});

/**
 * The questions from a real form, all the way into the records that are kept.
 *
 * Every shape the live Greenhouse form had is here: a placeholder choice, a
 * country list far longer than the cap, a label carrying the site's required
 * star, a duplicate label on two controls, and a note about an answer that did
 * not fit. If any of them is refused, the run ends with nothing recorded and
 * the person is left with a button that does nothing.
 */
describe("questions from a real form become records", () => {
  it("keeps every question, its choices, and the note beside it", () => {
    const job = createSeed().savedJobs[0]!;
    const detectedAt = "2026-07-30T10:00:00.000Z";
    const question = (
      index: number,
      overrides: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id: `question_${job.id}_${index}`,
      prompt: `Question ${index}`,
      kind: "other",
      answerControlType: "text",
      isRequired: true,
      detectedAt,
      answerOptions: [],
      suggestedAnswers: [],
      submittedAnswer: null,
      status: "detected",
      ...overrides,
    });

    const artifacts = buildApplyCopilotArtifacts({
      applicationRecordId: "application-record-real-form",
      job,
      detectedAt,
      runId: "run-real-form",
      resultId: "result-real-form",
      resumeArtifact: ApplicationResumeArtifactSchema.parse({
        id: "resume-real-form",
        jobId: job.id,
        source: "original_upload",
        sourceDocumentId: "document-real-form",
        exportArtifactId: null,
        fileName: "Original CV.pdf",
        filePath: "C:/private/Original CV.pdf",
        sha256: "c".repeat(64),
        approvedAt: detectedAt,
      }),
      executionResult: ApplyExecutionResultSchema.parse({
        state: "paused",
        summary: "This application needs you",
        detail: "Job Finder needs your answers to 4 questions.",
        submittedAt: null,
        outcome: null,
        checkpoints: [],
        questions: [
          question(0, {
            prompt: "Have you previously worked at or consulted for us?*",
            answerControlType: "single_choice",
            answerOptions: ["Yes", "No"],
            note: 'Your answer "Maybe" did not match one of the choices: Yes, No',
          }),
          question(1, {
            prompt: "Phone",
            description: "Phone country",
            answerControlType: "single_choice",
            answerOptions: Array.from(
              { length: 40 },
              (_, index) => `Country ${index + 1}`,
            ),
          }),
          question(2, {
            prompt: "Gender",
            description: "U.S. Equal Employment Opportunity information",
            answerControlType: "single_choice",
            answerOptions: ["Male", "Female", "Decline To Self Identify"],
          }),
          question(3, {
            prompt: "Coordination experience",
            inputConstraints: {
              type: "number",
              min: "0",
              max: "50",
              step: "1",
            },
            isRequired: false,
          }),
        ],
        blocker: {
          code: "missing_candidate_answer",
          summary: "This application needs an answer from you.",
          detail: "Four questions are waiting.",
          questionIds: [
            `question_${job.id}_0`,
            `question_${job.id}_1`,
            `question_${job.id}_2`,
            `question_${job.id}_3`,
          ],
        },
        consentDecisions: [],
        replay: {},
        visualEvidence: [],
        visualObservationSets: [],
        visualCheckpoints: [],
        nextActionLabel: "Answer the question in Needs you",
        executionTimings: [],
      }),
      visualCheckpointsEnabled: false,
    });

    expect(artifacts.questionRecords).toHaveLength(4);
    expect(
      new Set(artifacts.questionRecords.map((record) => record.id)).size,
    ).toBe(4);
    expect(artifacts.questionRecords[0]?.note).toContain(
      "did not match one of the choices",
    );
    expect(artifacts.questionRecords[1]?.description).toBe("Phone country");
    expect(artifacts.questionRecords[1]?.answerOptions).toHaveLength(40);
    expect(artifacts.questionRecords[3]?.inputConstraints).toEqual({
      type: "number",
      min: "0",
      max: "50",
      step: "1",
    });
    for (const record of artifacts.questionRecords) {
      expect(record.prompt.trim().length).toBeGreaterThan(0);
      for (const option of record.answerOptions) {
        expect(option.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

it("does not save a model's send claim as the summary of an unsent preparation", () => {
  const result = ApplyExecutionResultSchema.parse({
    state: "ready",
    outcome: "ready_for_review",
    summary: "Submitted via Submit button",
    detail: "Applied successfully",
    checkpoints: [],
    questions: [],
    consentDecisions: [],
    replay: {},
    nextActionLabel: "Review",
    submittedAt: null,
  });
  expect(describeApplicationPreparation(result)).toMatchObject({
    summary: "Ready to send.",
    detail: "The form is filled in. Review it and send when you are ready.",
  });
  expect(
    hasVerifiedApplicationSubmission(
      ApplyJobResultSchema.parse({
        id: "r",
        runId: "run",
        jobId: "j",
        state: "submitted",
        summary: "SENT",
        detail: "SENT",
        startedAt: "2026-10-03T10:00:00.000Z",
        updatedAt: "2026-10-03T10:00:00.000Z",
      }),
    ),
  ).toBe(false);
});

it("does not call a sign-in pause a prepared form", () => {
  const result = describeApplicationPreparation(
    ApplyExecutionResultSchema.parse({
      state: "paused",
      nextActionLabel: "Sign in",
      summary: "Submitted",
      detail: "Submitted",
      outcome: null,
      submittedAt: null,
      questions: [],
      checkpoints: [],
      blocker: {
        code: "requires_manual_review",
        summary: "Sign in",
        userActionKind: "login",
      },
      consentDecisions: [],
      replay: {},
      visualEvidence: [],
      visualObservationSets: [],
      visualCheckpoints: [],
      executionTimings: [],
    }),
  );
  expect(result.summary).toBe("Preparation paused.");
  expect(result.detail).toBe("Sign in");
});

it("keeps the original fingerprint for the byte-identical TXT copy", () => {
  const job = createSeed().savedJobs[0]!;
  const at = "2026-07-30T10:00:00.000Z";
  const receipt = buildApplicationPrivacyReceipt({
    applicationRecordId: "application_txt",
    job,
    generatedAt: at,
    runId: "run_txt",
    resultId: "result_txt",
    resumeArtifact: ApplicationResumeArtifactSchema.parse({
      id: "original",
      jobId: job.id,
      source: "original_upload",
      sourceDocumentId: "original",
      fileName: "resume.md",
      filePath: "/tmp/synthetic/resume.md",
      sha256: "b".repeat(64),
      approvedAt: at,
    }),
    reviewCard: ApplicationReviewCardSchema.parse({
      siteLabel: "Replica",
      pageUrl: job.applicationUrl,
      preparedAt: at,
      attachments: [
        { label: "Resume", field: "Resume", fileName: "resume.txt" },
      ],
    }),
    executionResult: ApplyExecutionResultSchema.parse({
      state: "paused",
      summary: "Prepared",
      detail: "Nothing sent",
      submittedAt: null,
      outcome: null,
      nextActionLabel: null,
    }),
  });
  expect(receipt.resume).toMatchObject({
    fileName: "resume.txt",
    sourceDocumentId: "original",
    sha256: "b".repeat(64),
  });
});

it("keeps agent timing on the persisted apply job result", () => {
  const job = createSeed().savedJobs[0]!;
  const at = "2026-07-30T10:00:00.000Z";
  const agentTiming = {
    totalMs: 2000,
    modelMs: 1200,
    modelTurns: 2,
    auxiliaryModelMs: 100,
    auxiliaryModelCalls: 1,
    toolMs: 600,
    pageReadMs: 200,
    pageReads: 7,
    writeMs: 100,
    uploadMs: 50,
    longestSteps: [],
    requests: [],
  };
  const artifacts = buildApplyCopilotArtifacts({
    applicationRecordId: "application_timing",
    job,
    detectedAt: at,
    runId: "run_timing",
    resultId: "result_timing",
    resumeArtifact: ApplicationResumeArtifactSchema.parse({
      id: "resume_timing",
      jobId: job.id,
      source: "original_upload",
      sourceDocumentId: "document_timing",
      exportArtifactId: null,
      fileName: "synthetic.pdf",
      filePath: "/tmp/synthetic.pdf",
      sha256: "a".repeat(64),
      approvedAt: at,
    }),
    executionResult: ApplyExecutionResultSchema.parse({
      state: "ready",
      summary: "Prepared.",
      detail: "Nothing sent.",
      submittedAt: null,
      outcome: null,
      nextActionLabel: null,
      agentTiming,
    }),
  });
  expect(artifacts.result.agentTiming).toEqual(agentTiming);
});
