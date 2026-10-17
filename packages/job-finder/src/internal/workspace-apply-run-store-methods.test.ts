import {
  ApplicationAnswerRecordSchema,
  ApplicationPrivacyReceiptSchema,
  ApplicationQuestionRecordSchema,
  ApplicationRecordSchema,
  ApplicationReplayCheckpointSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { describe, expect, it } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import { createWorkspaceApplyRunStoreMethods } from "./workspace-apply-run-store-methods";
import type { WorkspaceServiceContext } from "./workspace-service-context";

describe("workspace application packet", () => {
  it("rejects export for legacy null application lineage", async () => {
    const now = "2026-07-30T12:00:00.000Z";
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "run-legacy",
        mode: "copilot",
        state: "paused_for_user_review",
        jobIds: [job.id],
        currentJobId: job.id,
        summary: "Legacy preparation",
        detail: "No exact application record lineage was retained.",
        createdAt: now,
        updatedAt: now,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "result-legacy",
        runId: "run-legacy",
        jobId: job.id,
        applicationRecordId: null,
        state: "awaiting_review",
        summary: "Legacy prepared result",
        detail: "This result predates exact application lineage.",
        startedAt: now,
        updatedAt: now,
      }),
    ];
    const methods = createWorkspaceApplyRunStoreMethods({
      repository: createInMemoryJobFinderRepository(seed),
    } as WorkspaceServiceContext);

    await expect(
      methods.buildApplicationPacket("run-legacy", job.id),
    ).rejects.toThrow(/legacy application lineage.*non-actionable/iu);
  });

  it("orders same-timestamp answer chains by revision", async () => {
    const now = "2026-07-30T12:00:00.000Z";
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "run-answer-order",
        mode: "copilot",
        state: "paused_for_user_review",
        jobIds: [job.id],
        currentJobId: job.id,
        summary: "Prepared answers need review.",
        detail: "Final submit remains disabled.",
        createdAt: now,
        updatedAt: now,
      }),
    ];
    seed.applicationAnswerRecords = [
      ApplicationAnswerRecordSchema.parse({
        id: "answer-z-first",
        runId: "run-answer-order",
        jobId: job.id,
        resultId: "result-answer-order",
        questionId: "question-answer-order",
        status: "suggested",
        text: "First",
        revision: 1,
        sourceKind: "user",
        createdAt: now,
      }),
      ApplicationAnswerRecordSchema.parse({
        id: "answer-a-second",
        runId: "run-answer-order",
        jobId: job.id,
        resultId: "result-answer-order",
        questionId: "question-answer-order",
        status: "rejected",
        text: "Answer cleared by the user",
        value: null,
        revision: 2,
        supersedesAnswerId: "answer-z-first",
        sourceKind: "user",
        createdAt: now,
      }),
    ];

    const repository = createInMemoryJobFinderRepository(seed);
    const methods = createWorkspaceApplyRunStoreMethods({
      repository,
    } as WorkspaceServiceContext);

    const details = await methods.getApplyRunDetails(
      "run-answer-order",
      job.id,
    );
    expect(details.answerRecords.map((answer) => answer.revision)).toEqual([
      1, 2,
    ]);
    expect(details.answerRecords.at(-1)?.id).toBe("answer-a-second");
  });

  it("exports exact prepared evidence without paths, URL secrets, or false submission", async () => {
    const now = "2026-07-30T12:00:00.000Z";
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    const applicationRecordId = "application-record-1";
    seed.savedJobs[0] = {
      ...job,
      canonicalUrl: "https://jobs.example.com/jobs/123?tracking=secret#top",
      applicationUrl:
        "https://apply.example.com/applications/123?candidate_token=secret#apply",
    };
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: "run-1",
        mode: "copilot",
        state: "paused_for_user_review",
        jobIds: [job.id],
        currentJobId: job.id,
        summary: "Safe preparation paused for review.",
        detail: "Final submit remains disabled.",
        createdAt: now,
        updatedAt: now,
      }),
    ];
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: applicationRecordId,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: job.status,
        lastActionLabel: "Prepared",
        nextActionLabel: "Review",
        lastUpdatedAt: now,
      }),
    ];
    const privacyReceipt = ApplicationPrivacyReceiptSchema.parse({
      generatedAt: now,
      lineage: {
        runId: "run-1",
        jobId: job.id,
        resultId: "result-1",
        applicationRecordId,
      },
      destination: {
        origin: "https://apply.example.com",
        safePath: "/applications/123",
      },
      resume: {
        source: "original_upload",
        sourceDocumentId: "document-1",
        exportArtifactId: null,
        fileName: "Original CV.pdf",
        sha256: null,
      },
      stayedLocal: ["job_listing_data"],
      externalWrites: [
        {
          category: "profile_field",
          fieldLabel: "Full name",
          occurredAt: now,
          verified: true,
        },
      ],
      accountCreationAuthorized: false,
      finalSubmitAuthorized: false,
      finalSubmitOccurred: false,
    });
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: "result-1",
        runId: "run-1",
        jobId: job.id,
        applicationRecordId,
        state: "awaiting_review",
        summary: "Prepared",
        detail: "Stopped before final submit.",
        startedAt: now,
        updatedAt: now,
        privacyReceipt,
      }),
    ];
    seed.applicationQuestionRecords = [
      ApplicationQuestionRecordSchema.parse({
        id: "question-1",
        runId: "run-1",
        jobId: job.id,
        applicationRecordId,
        resultId: "result-1",
        prompt: "Full name",
        kind: "personal_info",
        isRequired: true,
        detectedAt: now,
        selectedAnswerId: "answer-1",
        submittedAnswer: "Alex Vanguard",
        status: "answered",
        pageUrl:
          "https://apply.example.com/applications/123?candidate_token=secret",
      }),
      ApplicationQuestionRecordSchema.parse({
        id: "question-2",
        runId: "run-1",
        jobId: job.id,
        applicationRecordId,
        resultId: "result-1",
        prompt: "Resume",
        kind: "resume",
        isRequired: true,
        detectedAt: now,
        selectedAnswerId: "answer-resume-selected",
        submittedAnswer: "C:/Users/private/Original CV.pdf",
        status: "answered",
        pageUrl: "https://apply.example.com/applications/123",
      }),
      ApplicationQuestionRecordSchema.parse({
        id: "question-3",
        runId: "run-1",
        jobId: job.id,
        applicationRecordId,
        resultId: "result-1",
        prompt: "Resume fallback",
        kind: "resume",
        isRequired: true,
        detectedAt: now,
        selectedAnswerId: null,
        submittedAnswer: "/tmp/private/original-cv.pdf",
        status: "answered",
        pageUrl: "https://apply.example.com/applications/123",
      }),
    ];
    seed.applicationAnswerRecords = [
      ApplicationAnswerRecordSchema.parse({
        id: "answer-1",
        runId: "run-1",
        jobId: job.id,
        applicationRecordId,
        resultId: "result-1",
        questionId: "question-1",
        status: "filled",
        text: "Alex Vanguard",
        sourceKind: "profile",
        createdAt: now,
      }),
      ApplicationAnswerRecordSchema.parse({
        id: "answer-unused-model",
        runId: "run-1",
        jobId: job.id,
        applicationRecordId,
        resultId: "result-1",
        questionId: "question-1",
        status: "suggested",
        text: "A different generated name",
        sourceKind: "proof_bank",
        createdAt: now,
      }),
      ApplicationAnswerRecordSchema.parse({
        id: "answer-resume-selected",
        runId: "run-1",
        jobId: job.id,
        applicationRecordId,
        resultId: "result-1",
        questionId: "question-2",
        status: "filled",
        text: "C:/Users/private/Original CV.pdf",
        sourceKind: "resume",
        createdAt: now,
      }),
      ApplicationAnswerRecordSchema.parse({
        id: "answer-resume-fallback",
        runId: "run-1",
        jobId: job.id,
        applicationRecordId,
        resultId: "result-1",
        questionId: "question-3",
        status: "filled",
        text: "/tmp/private/original-cv.pdf",
        sourceKind: "resume",
        createdAt: now,
      }),
    ];
    seed.applicationReplayCheckpoints = [
      ApplicationReplayCheckpointSchema.parse({
        id: "checkpoint-1",
        runId: "run-1",
        jobId: job.id,
        applicationRecordId,
        resultId: "result-1",
        createdAt: now,
        label: "Paused before final submit",
        detail: "Final control remained untouched.",
        url: "https://apply.example.com/applications/123?candidate_token=secret#apply",
        jobState: "awaiting_review",
      }),
    ];

    const repository = createInMemoryJobFinderRepository(seed);
    const methods = createWorkspaceApplyRunStoreMethods({
      repository,
    } as WorkspaceServiceContext);
    const packet = await methods.buildApplicationPacket(
      "run-1",
      job.id,
      applicationRecordId,
    );
    const serialized = JSON.stringify(packet);

    expect(packet.job.listingDestination).toEqual({
      origin: "https://jobs.example.com",
      safePath: "/jobs/123",
    });
    expect(packet.job.applicationDestination).toEqual({
      origin: "https://apply.example.com",
      safePath: "/applications/123",
    });
    expect(packet.resume?.fileName).toBe("Original CV.pdf");
    expect(packet.questions[0]).toEqual(
      expect.objectContaining({
        prompt: "Full name",
        preparedAnswer: "Alex Vanguard",
        sourceKinds: ["profile"],
      }),
    );
    expect(packet.questions[1]).toEqual(
      expect.objectContaining({
        preparedAnswer: "Original CV.pdf",
        sourceKinds: ["resume"],
      }),
    );
    expect(packet.questions[2]).toEqual(
      expect.objectContaining({
        preparedAnswer: "Original CV.pdf",
        sourceKinds: ["resume"],
      }),
    );
    expect(packet.submissionOccurred).toBe(false);
    expect(serialized).not.toContain("candidate_token");
    expect(serialized).not.toContain("tracking=secret");
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain("C:/Users/private");
    expect(serialized).not.toContain("/tmp/private");
    expect(serialized).not.toContain("A different generated name");
  });

  function createLineageSeed(options: {
    runId: string;
    resultId: string;
    recordIds: readonly string[];
    resultRecordId: string | null;
    rowRecordId: string | null;
  }) {
    const now = "2026-07-30T12:00:00.000Z";
    const seed = createSeed();
    const job = seed.savedJobs[0]!;
    seed.applicationRecords = options.recordIds.map((id) =>
      ApplicationRecordSchema.parse({
        id,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: job.status,
        lastActionLabel: "Prepared",
        nextActionLabel: "Review",
        lastUpdatedAt: now,
      }),
    );
    seed.applyRuns = [
      ApplyRunSchema.parse({
        id: options.runId,
        mode: "copilot",
        state: "paused_for_user_review",
        jobIds: [job.id],
        currentJobId: job.id,
        summary: "Preparation paused for review.",
        detail: "Exact application lineage retained where available.",
        createdAt: now,
        updatedAt: now,
      }),
    ];
    seed.applyJobResults = [
      ApplyJobResultSchema.parse({
        id: options.resultId,
        runId: options.runId,
        jobId: job.id,
        applicationRecordId: options.resultRecordId,
        state: "awaiting_review",
        summary: "Prepared",
        detail: "Stopped before final submit.",
        startedAt: now,
        updatedAt: now,
      }),
    ];
    seed.applicationQuestionRecords = [
      ApplicationQuestionRecordSchema.parse({
        id: `${options.resultId}-question`,
        runId: options.runId,
        jobId: job.id,
        applicationRecordId: options.rowRecordId,
        resultId: options.resultId,
        prompt: "Full name",
        kind: "personal_info",
        isRequired: true,
        detectedAt: now,
        status: "answered",
        pageUrl: "https://apply.example.com/applications/123",
      }),
    ];
    seed.applicationReplayCheckpoints = [
      ApplicationReplayCheckpointSchema.parse({
        id: `${options.resultId}-checkpoint`,
        runId: options.runId,
        jobId: job.id,
        applicationRecordId: options.rowRecordId,
        resultId: options.resultId,
        createdAt: now,
        label: "Paused before final submit",
        detail: "Final control remained untouched.",
        url: job.applicationUrl ?? job.canonicalUrl,
        jobState: "awaiting_review",
      }),
    ];
    return { seed, job };
  }

  it("resolves legacy null lineage against the unique scoped application record", async () => {
    const { seed, job } = createLineageSeed({
      runId: "run-legacy-unique",
      resultId: "result-legacy-unique",
      recordIds: ["application-unique"],
      resultRecordId: null,
      rowRecordId: null,
    });
    const methods = createWorkspaceApplyRunStoreMethods({
      repository: createInMemoryJobFinderRepository(seed),
    } as WorkspaceServiceContext);

    const details = await methods.getApplyRunDetails(
      "run-legacy-unique",
      job.id,
      "application-unique",
    );

    expect(details.run.id).toBe("run-legacy-unique");
    expect(details.result?.id).toBe("result-legacy-unique");
    expect(details.questionRecords.map((entry) => entry.id)).toEqual([
      "result-legacy-unique-question",
    ]);
    expect(details.checkpoints.map((entry) => entry.id)).toEqual([
      "result-legacy-unique-checkpoint",
    ]);
  });

  it("rejects an explicit record that mismatches non-null modern result lineage", async () => {
    const { seed, job } = createLineageSeed({
      runId: "run-mismatch",
      resultId: "result-mismatch",
      recordIds: ["application-a", "application-b"],
      resultRecordId: "application-a",
      rowRecordId: "application-a",
    });
    const methods = createWorkspaceApplyRunStoreMethods({
      repository: createInMemoryJobFinderRepository(seed),
    } as WorkspaceServiceContext);

    await expect(
      methods.getApplyRunDetails("run-mismatch", job.id, "application-b"),
    ).rejects.toThrow(/mismatched application record lineage/iu);
  });

  it("rejects legacy null lineage when multiple records exist for the job", async () => {
    const { seed, job } = createLineageSeed({
      runId: "run-legacy-ambiguous",
      resultId: "result-legacy-ambiguous",
      recordIds: ["application-a", "application-b"],
      resultRecordId: null,
      rowRecordId: null,
    });
    const methods = createWorkspaceApplyRunStoreMethods({
      repository: createInMemoryJobFinderRepository(seed),
    } as WorkspaceServiceContext);

    await expect(
      methods.getApplyRunDetails("run-legacy-ambiguous", job.id, "application-a"),
    ).rejects.toThrow(/mismatched application record lineage/iu);
  });

  it("rejects legacy null lineage when no application record exists for the job", async () => {
    const { seed, job } = createLineageSeed({
      runId: "run-legacy-orphaned",
      resultId: "result-legacy-orphaned",
      recordIds: [],
      resultRecordId: null,
      rowRecordId: null,
    });
    const methods = createWorkspaceApplyRunStoreMethods({
      repository: createInMemoryJobFinderRepository(seed),
    } as WorkspaceServiceContext);

    await expect(
      methods.getApplyRunDetails(
        "run-legacy-orphaned",
        job.id,
        "application-orphan",
      ),
    ).rejects.toThrow(/does not belong to job/iu);
  });

  it("returns exact lineage details for modern stamped rows with and without an explicit record", async () => {
    const { seed, job } = createLineageSeed({
      runId: "run-modern-exact",
      resultId: "result-modern-exact",
      recordIds: ["application-a"],
      resultRecordId: "application-a",
      rowRecordId: "application-a",
    });
    const methods = createWorkspaceApplyRunStoreMethods({
      repository: createInMemoryJobFinderRepository(seed),
    } as WorkspaceServiceContext);

    const explicitDetails = await methods.getApplyRunDetails(
      "run-modern-exact",
      job.id,
      "application-a",
    );
    expect(explicitDetails.result?.id).toBe("result-modern-exact");
    expect(explicitDetails.result?.applicationRecordId).toBe("application-a");
    expect(explicitDetails.questionRecords).toHaveLength(1);
    expect(explicitDetails.checkpoints).toHaveLength(1);

    const inferredDetails = await methods.getApplyRunDetails(
      "run-modern-exact",
      job.id,
    );
    expect(inferredDetails.result?.applicationRecordId).toBe("application-a");
    expect(inferredDetails.questionRecords).toHaveLength(1);
  });
});
