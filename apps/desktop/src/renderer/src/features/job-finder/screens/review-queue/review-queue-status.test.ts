import type {
  BrowserSessionState,
  ReviewQueueItem,
  TailoredAsset,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  collectInProgressApplicationJobIds,
  findPossibleDuplicateJobIds,
  collectPreparedApplicationJobIds,
  countQueueStageReady,
  describeTailoredDraftPreparationBlocker,
  describeResumeRunStage,
  getApplyReadinessStatus,
  getResumeRunState,
  getReviewQueueResumePolicyCaption,
  getReviewQueueWorkflowStatus,
  getShortlistStatusFilter,
  getTailoredDraftPreparationCandidates,
  getTailoredDraftPreparationResultMessage,
  hasResumeGenerationFailure,
  isQueueStageReady,
  isTailoredDraftPreparationEligible,
  needsPersonResumeReview,
  needsTailoredResume,
  prepareTailoredDraftBatch,
  type TailoredDraftPreparationViewState,
} from "./review-queue-status";

it("lets a ready tailored draft join an application preparation batch", () => {
  const draft = createItem("draft-ready", {
    assetStatus: "ready",
    resumeAssetId: "resume_draft_ready",
    resumeReview: { status: "needs_review" },
  });

  expect(isQueueStageReady(draft)).toBe(true);
  expect(getReviewQueueResumePolicyCaption(draft)).toBe(
    "Resume ready — Apply approves it",
  );
});

it("holds an Aggressive draft back for the person's review before Apply", () => {
  const draft = createItem("aggressive", {
    assetStatus: "ready",
    resumeAssetId: "resume_aggressive",
    resumeTailoringMode: "aggressive",
    resumeReview: { status: "needs_review" },
  });

  expect(isQueueStageReady(draft)).toBe(false);
  expect(getReviewQueueWorkflowStatus(draft)).toEqual({
    label: "Review resume",
    tone: "active",
  });
  expect(getReviewQueueResumePolicyCaption(draft)).toBe(
    "Resume ready — review it before applying",
  );
});

it("holds a Tailored draft with a line still to decide back from Apply, whatever its level", () => {
  const draft = createItem("tailored_undecided", {
    assetStatus: "ready",
    resumeAssetId: "resume_tailored",
    resumeTailoringMode: "balanced",
    resumeLinesToDecide: 1,
    resumeReview: { status: "needs_review" },
  });
  const asset = {
    id: "resume_tailored",
    generationMethod: "deterministic",
    generationReason: "listing_text_missing",
  } as const;

  expect(needsPersonResumeReview(draft)).toBe(true);
  // Even a resume that kept the person's wording is blocked by the line.
  expect(needsPersonResumeReview(draft, asset)).toBe(true);
  expect(isQueueStageReady(draft)).toBe(false);
  expect(getReviewQueueWorkflowStatus(draft)).toEqual({
    label: "Review resume",
    tone: "active",
  });
  expect(getReviewQueueResumePolicyCaption(draft)).toBe(
    "A line in this resume needs your decision",
  );
  expect(
    getReviewQueueResumePolicyCaption({ ...draft, resumeLinesToDecide: 3 }),
  ).toBe("3 lines in this resume need your decision");
});

it("asks for no flagged-line review when the listing text was never read", () => {
  const draft = createItem("aggressive_untailored", {
    assetStatus: "ready",
    resumeAssetId: "resume_untailored",
    resumeTailoringMode: "aggressive",
    resumeReview: { status: "needs_review" },
  });
  const asset = {
    id: "resume_untailored",
    generationMethod: "deterministic",
    generationReason: "listing_text_missing",
  } as const;

  expect(needsPersonResumeReview(draft)).toBe(true);
  expect(needsPersonResumeReview(draft, asset)).toBe(false);
});

it("says a resume written without the listing needs a resume, as its status tab does", () => {
  const draft = createItem("aggressive_untailored", {
    assetStatus: "ready",
    resumeAssetId: "resume_untailored",
    resumeTailoringMode: "aggressive",
    resumeReview: { status: "needs_review" },
    resumeWrittenWithoutListing: true,
  });
  const asset = {
    id: "resume_untailored",
    jobId: "aggressive_untailored",
    status: "ready",
    generationMethod: "deterministic",
    generationReason: "listing_text_missing",
    failureMessage: null,
    failedAt: null,
  } as unknown as TailoredAsset;

  expect(needsTailoredResume(draft)).toBe(true);
  const status = getReviewQueueWorkflowStatus(draft, asset);
  expect(status).toEqual({ label: "Needs a resume", tone: "muted" });
  expect(
    getShortlistStatusFilter(
      status.label,
      isTailoredDraftPreparationEligible(draft),
    ),
  ).toBe("needs_resume");
  // Not counted by "Apply to all ready jobs" while its tab says it needs one.
  expect(isQueueStageReady(draft)).toBe(false);
  expect(getReviewQueueResumePolicyCaption(draft, asset)).toBe(
    "Original wording — the listing text was not captured",
  );

  // Approving it as it is is the person's choice to keep their wording.
  const approved = {
    ...draft,
    resumeReview: { status: "approved" },
  } as ReviewQueueItem;
  expect(needsTailoredResume(approved)).toBe(false);
  expect(getReviewQueueWorkflowStatus(approved, asset).label).not.toBe(
    "Needs a resume",
  );
});

it("puts a rewrite in progress ahead of the last attempt's failure", () => {
  const failed = createItem("failed", {
    assetStatus: "failed",
    resumeAssetId: "resume_failed",
    resumeReview: { status: "not_started" },
  });
  const asset = {
    id: "resume_failed",
    jobId: "failed",
    status: "failed",
    failureMessage: "The AI could not write this resume, so nothing was changed.",
    failedAt: "2026-10-20T10:00:00.000Z",
  } as unknown as TailoredAsset;

  expect(getResumeRunState(failed, asset, false)).toEqual({
    hasFailure: true,
    isWriting: false,
  });
  expect(getResumeRunState(failed, asset, true)).toEqual({
    hasFailure: false,
    isWriting: true,
  });
  expect(describeResumeRunStage(null)).toBe("Writing the resume…");
  expect(describeResumeRunStage("writing")).toBe("Writing the resume…");
  expect(describeResumeRunStage("processing")).toBe(
    "Checking it against your profile…",
  );
});

it("does not describe an Aggressive resume as ready before a draft exists", () => {
  const draft = createItem("aggressive_missing", {
    assetStatus: "not_started",
    resumeAssetId: null,
    resumeTailoringMode: "aggressive",
    resumeReview: { status: "not_started" },
  });

  expect(needsPersonResumeReview(draft)).toBe(false);
  expect(getReviewQueueWorkflowStatus(draft)).toEqual({
    label: "Needs a resume",
    tone: "muted",
  });
  expect(getReviewQueueResumePolicyCaption(draft)).toBe("No resume yet");
});

it("names an AI outage in the row instead of calling the built-in resume ready", () => {
  const draft = createItem("outage", {
    assetStatus: "ready",
    resumeAssetId: "resume_outage",
    resumeReview: { status: "needs_review" },
  });

  expect(
    getReviewQueueResumePolicyCaption(draft, {
      generationMethod: "deterministic",
      generationReason: "provider_failed",
    } as TailoredAsset),
  ).toBe("Your saved wording — AI was unavailable");
  expect(
    getReviewQueueResumePolicyCaption(draft, {
      generationMethod: "ai_assisted",
      generationReason: null,
    } as TailoredAsset),
  ).toBe("Resume ready — Apply approves it");
});

function createItem(
  jobId: string,
  overrides: Partial<ReviewQueueItem> = {},
): ReviewQueueItem {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    matchScore: 80,
    applicationStatus: "shortlisted",
    assetStatus: "not_started",
    progressPercent: null,
    resumeAssetId: null,
    resumeApplicationMode: "tailored_per_job",
    resumeReview: { status: "not_started" },
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("tailored draft preparation", () => {
  it("only includes tailored jobs with no existing review, including failed attempts", () => {
    expect(isTailoredDraftPreparationEligible(createItem("not-started"))).toBe(
      true,
    );
    expect(
      isTailoredDraftPreparationEligible(
        createItem("failed", { assetStatus: "failed" }),
      ),
    ).toBe(true);

    for (const item of [
      createItem("original", { resumeApplicationMode: "original_resume" }),
      createItem("queued", { assetStatus: "queued" }),
      createItem("generating", { assetStatus: "generating" }),
      createItem("ready", { assetStatus: "ready" }),
      createItem("draft", { resumeReview: { status: "draft" } }),
      createItem("needs-review", { resumeReview: { status: "needs_review" } }),
      createItem("stale", {
        resumeReview: { status: "stale", staleReason: null },
      }),
      createItem("approved", {
        assetStatus: "ready",
        resumeReview: {
          status: "approved",
          approvedAt: "2026-08-20T00:00:00.000Z",
          approvedExportId: "export-approved",
          approvedFormat: "pdf",
          approvedFilePath: "C:/resume.pdf",
        },
      }),
    ]) {
      expect(isTailoredDraftPreparationEligible(item)).toBe(false);
    }
  });

  it("counts a resume written without the listing as missing until it is approved", () => {
    const untailored = createItem("untailored", {
      assetStatus: "ready",
      resumeAssetId: "resume_untailored",
      resumeReview: { status: "needs_review" },
      resumeWrittenWithoutListing: true,
    });
    expect(isTailoredDraftPreparationEligible(untailored)).toBe(true);
    expect(
      isTailoredDraftPreparationEligible({
        ...untailored,
        resumeReview: {
          status: "approved",
          approvedAt: "2026-08-20T00:00:00.000Z",
          approvedExportId: "export-approved",
          approvedFormat: "pdf",
          approvedFilePath: "C:/resume.pdf",
        },
      }),
    ).toBe(false);
    expect(
      isTailoredDraftPreparationEligible({
        ...untailored,
        resumeApplicationMode: "original_resume",
      }),
    ).toBe(false);
  });

  it("deduplicates in stable order and queues every missing resume", () => {
    const queue = [
      ...Array.from({ length: 33 }, (_, index) => createItem(`job-${index}`)),
      createItem("job-0"),
    ];

    expect(
      getTailoredDraftPreparationCandidates(queue).map((item) => item.jobId),
    ).toEqual(Array.from({ length: 33 }, (_, index) => `job-${index}`));
    expect(getTailoredDraftPreparationCandidates(queue, 50)).toHaveLength(33);
  });

  it("bounds admitted jobs and accounts for out-of-order failures when Stop is pressed", async () => {
    const settle = new Map<string, (success: boolean) => void>();
    const generate = vi.fn(
      (id: string) =>
        new Promise<boolean>((resolve) => settle.set(id, resolve)),
    );
    const progress = vi.fn();
    let stop = false;
    const promise = prepareTailoredDraftBatch(
      Array.from({ length: 150 }, (_, i) => createItem(String(i + 1))),
      generate,
      { onProgress: progress, shouldStop: () => stop },
    );
    expect(generate).toHaveBeenCalledTimes(100);
    stop = true;
    settle.get("2")!(false);
    await vi.waitFor(() =>
      expect(progress).toHaveBeenLastCalledWith({
        completedCount: 0,
        currentIndex: 100,
        failedCount: 1,
        totalCount: 150,
      }),
    );
    for (const [id, resolve] of settle) if (id !== "2") resolve(true);
    expect(await promise).toMatchObject({
      attemptedCount: 100,
      completedCount: 99,
      failedCount: 1,
      failedJobIds: ["2"],
      stopped: true,
      totalCount: 150,
    });
    expect(generate).toHaveBeenCalledTimes(100);
  });

  it("stops scheduling after the current draft finishes", async () => {
    let stopRequested = false;
    const onGenerateResume = vi.fn((jobId: string) => {
      if (jobId === "job-1") {
        stopRequested = true;
      }
      return Promise.resolve(true);
    });

    await expect(
      prepareTailoredDraftBatch(
        [createItem("job-1"), createItem("job-2")],
        onGenerateResume,
        { shouldStop: () => stopRequested },
      ),
    ).resolves.toMatchObject({
      attemptedCount: 1,
      completedCount: 1,
      failedCount: 0,
      failedJobIds: [],
      stopped: true,
      totalCount: 2,
    });
    expect(onGenerateResume).toHaveBeenCalledTimes(1);
  });

  it("records a middle failure and continues with later eligible jobs", async () => {
    const onGenerateResume = vi.fn((jobId: string) =>
      Promise.resolve(jobId !== "job-2"),
    );
    const result = await prepareTailoredDraftBatch(
      [createItem("job-1"), createItem("job-2"), createItem("job-3")],
      onGenerateResume,
    );

    expect(result).toEqual({
      attemptedCount: 3,
      completedCount: 2,
      failedCount: 1,
      failedJobIds: ["job-2"],
      stopped: false,
      totalCount: 3,
    });
    expect(onGenerateResume.mock.calls.map(([jobId]) => jobId)).toEqual([
      "job-1",
      "job-2",
      "job-3",
    ]);
  });

  it("reports an all-failed run and records false returns and throws", async () => {
    const onGenerateResume = vi.fn((jobId: string) => {
      if (jobId === "job-2") {
        throw new Error("generation failed");
      }

      return Promise.resolve(false);
    });

    await expect(
      prepareTailoredDraftBatch(
        [createItem("job-1"), createItem("job-2"), createItem("job-3")],
        onGenerateResume,
      ),
    ).resolves.toEqual({
      attemptedCount: 3,
      completedCount: 0,
      failedCount: 3,
      failedJobIds: ["job-1", "job-2", "job-3"],
      stopped: false,
      totalCount: 3,
    });
    expect(onGenerateResume).toHaveBeenCalledTimes(3);
  });

  it("does not mark a fully attempted run stopped when the stop flag rises during the last candidate", async () => {
    let stopRequested = false;
    const onGenerateResume = vi.fn((jobId: string) => {
      if (jobId === "job-2") {
        stopRequested = true;
      }
      return Promise.resolve(true);
    });

    await expect(
      prepareTailoredDraftBatch(
        [createItem("job-1"), createItem("job-2")],
        onGenerateResume,
        { shouldStop: () => stopRequested },
      ),
    ).resolves.toEqual({
      attemptedCount: 2,
      completedCount: 2,
      failedCount: 0,
      failedJobIds: [],
      stopped: false,
      totalCount: 2,
    });
  });

  it("treats an empty candidate list as a finished, unstopped run", async () => {
    await expect(
      prepareTailoredDraftBatch([], vi.fn(), {
        shouldStop: () => true,
      }),
    ).resolves.toEqual({
      attemptedCount: 0,
      completedCount: 0,
      failedCount: 0,
      failedJobIds: [],
      stopped: false,
      totalCount: 0,
    });
  });
});

describe("restored resume states stay distinct from generation failures", () => {
  const restoredItem = createItem("restored", {
    assetStatus: "failed",
    resumeAssetId: "resume_restored",
    resumeReview: { status: "needs_review" },
  });
  const restoredAsset: TailoredAsset = {
    id: "resume_restored",
    jobId: "restored",
    kind: "resume",
    status: "failed",
    label: "Tailored Resume",
    version: "v1",
    templateName: "Chronology Classic",
    compatibilityScore: 80,
    progressPercent: 100,
    updatedAt: "2026-08-20T00:00:00.000Z",
    storagePath: null,
    contentText: "Restored tailored content",
    previewSections: [],
    generationMethod: "deterministic",
    notes: [],
    failureMessage: null,
    failedAt: null,
  };

  it("treats a failed marker without failure detail as review-pending, never a generation failure", () => {
    expect(hasResumeGenerationFailure(restoredItem, restoredAsset)).toBe(false);
    expect(hasResumeGenerationFailure(restoredItem)).toBe(true);
  });

  it("keeps a real generation failure with sanitized detail reporting retry", () => {
    expect(
      hasResumeGenerationFailure(restoredItem, {
        ...restoredAsset,
        failureMessage: "Provider request timed out.",
        failedAt: "2026-08-21T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("routes restored assets to approval recovery copy instead of resume-issue copy", () => {
    // Without asset evidence the workflow status stays conservatively on
    // failure copy; surfaces holding the tailored asset resolve the restored
    // state precisely.
    expect(getReviewQueueWorkflowStatus(restoredItem)).toEqual({
      label: "Resume failed",
      tone: "critical",
    });
    expect(getReviewQueueWorkflowStatus(restoredItem, restoredAsset)).toEqual({
      label: "Review resume",
      tone: "active",
    });
    expect(
      getReviewQueueWorkflowStatus(restoredItem, {
        ...restoredAsset,
        failureMessage: "Provider request timed out.",
        failedAt: "2026-08-21T00:00:00.000Z",
      }),
    ).toEqual({
      label: "Resume failed",
      tone: "critical",
    });
  });

  it("keeps readiness labels distinct once the failure boolean is resolved by the caller", () => {
    const readinessInput = {
      applySupportState: "supported" as const,
      browserSession: { status: "ready" } as BrowserSessionState,
      hasReadyApprovedAsset: false,
      isGenerating: false,
      needsGeneration: false,
      resumeReviewStatus: "needs_review" as const,
      selectedItem: restoredItem,
    };
    expect(
      getApplyReadinessStatus({
        ...readinessInput,
        hasGenerationFailure: false,
      }).label,
    ).toBe("Review resume");
    expect(
      getApplyReadinessStatus({
        ...readinessInput,
        hasGenerationFailure: true,
      }).label,
    ).toBe("Resume failed");
  });
});

describe("safe application presentation labels", () => {
  const BANNED_OPERATION_COPY = /apply copilot|restage|submit approval/i;

  function createReadyApprovedItem(): ReviewQueueItem {
    return createItem("ready-approved", {
      assetStatus: "ready",
      resumeAssetId: "resume_approved",
      resumeReview: {
        status: "approved",
        approvedAt: "2026-08-20T00:00:00.000Z",
        approvedExportId: "export-approved",
        approvedFormat: "pdf",
        approvedFilePath: "/tmp/approved.pdf",
      },
    });
  }

  it("presents a fully prepared job as Ready to apply", () => {
    const status = getReviewQueueWorkflowStatus(createReadyApprovedItem());

    expect(status).toEqual({ label: "Ready to apply", tone: "positive" });
  });

  it("captions an approved resume as approved, never future-tense creation", () => {
    expect(getReviewQueueResumePolicyCaption(createReadyApprovedItem())).toBe(
      "Resume approved",
    );
    expect(
      getReviewQueueResumePolicyCaption(
        createItem("needs-draft", {
          resumeApplicationMode: "tailored_per_job",
          assetStatus: "not_started",
          resumeReview: { status: "not_started" },
        }),
      ),
    ).toBe("No resume yet");
  });

  it("never captions a draft as tailored when the listing text was not captured", () => {
    const item = createItem("no-listing-text", {
      resumeApplicationMode: "tailored_per_job",
      assetStatus: "ready",
      resumeAssetId: "resume_no_listing_text",
      resumeReview: { status: "needs_review" },
    });
    const asset: TailoredAsset = {
      id: "resume_no_listing_text",
      jobId: "no-listing-text",
      kind: "resume",
      status: "ready",
      label: "Tailored Resume",
      version: "v1",
      templateName: "Chronology Classic",
      compatibilityScore: 80,
      progressPercent: 100,
      updatedAt: "2026-08-20T00:00:00.000Z",
      storagePath: null,
      contentText: "Original wording",
      previewSections: [],
      generationMethod: "deterministic",
      generationReason: "listing_text_missing",
      notes: [],
      failureMessage: null,
      failedAt: null,
    };

    expect(getReviewQueueResumePolicyCaption(item, asset)).toBe(
      "Original wording — the listing text was not captured",
    );
    expect(getReviewQueueResumePolicyCaption(item)).toBe(
      "Resume ready — Apply approves it",
    );
  });

  it("asks for an import when Original is chosen but nothing is imported", () => {
    const status = getReviewQueueWorkflowStatus(
      createItem("original-missing", {
        resumeApplicationMode: "original_resume",
        assetStatus: "not_started",
        resumeAssetId: null,
        resumeReview: { status: "not_started" },
      }),
    );

    expect(status).toEqual({ label: "Import your resume", tone: "warning" });
  });

  it("presents an unchanged original resume job without submission claims", () => {
    const status = getReviewQueueWorkflowStatus(
      createItem("original", {
        resumeApplicationMode: "original_resume",
        assetStatus: "ready",
        resumeAssetId: "resume_original",
        resumeReview: {
          status: "original_resume",
          sourceDocumentId: "resume_original",
          fileName: "Elian.pdf",
          filePath: "/tmp/Elian.pdf",
        },
      }),
    );

    expect(status.label).toBe("Ready to apply");
    expect(status.label).not.toMatch(BANNED_OPERATION_COPY);
    expect(status.label).not.toMatch(/submit/i);
  });

  it("keeps every readiness badge free of legacy operation names and submission claims", () => {
    const items = [
      null,
      createItem("needs-resume"),
      createItem("generating", { assetStatus: "generating" }),
      createReadyApprovedItem(),
      createItem("failed", { assetStatus: "failed" }),
      createItem("stale", {
        assetStatus: "ready",
        resumeAssetId: "resume_stale",
        resumeReview: { status: "stale", staleReason: null },
      }),
    ] as const;

    for (const item of items) {
      const workflow = getReviewQueueWorkflowStatus(item);
      expect(workflow.label).not.toMatch(BANNED_OPERATION_COPY);
      expect(workflow.label).not.toMatch(/submitted|sends? your application/i);
    }
  });

  it("reports the all-clear mission state as Ready to apply", () => {
    const status = getApplyReadinessStatus({
      applySupportState: "supported",
      browserSession: { status: "ready" } as BrowserSessionState,
      hasGenerationFailure: false,
      hasReadyApprovedAsset: true,
      isGenerating: false,
      needsGeneration: false,
      resumeReviewStatus: "approved",
      selectedItem: createReadyApprovedItem(),
    });

    expect(status).toEqual({ label: "Ready to apply", tone: "positive" });
  });
});

describe("getTailoredDraftPreparationResultMessage", () => {
  function createState(
    overrides: Partial<TailoredDraftPreparationViewState> = {},
  ): TailoredDraftPreparationViewState {
    return {
      attemptedCount: 0,
      completedCount: 0,
      currentIndex: null,
      eligibleRemainingCount: 0,
      failedCount: 0,
      status: "idle",
      totalCount: 0,
      ...overrides,
    };
  }

  it("returns no message while idle or running", () => {
    expect(getTailoredDraftPreparationResultMessage(createState())).toBeNull();
    expect(
      getTailoredDraftPreparationResultMessage(
        createState({ status: "running" }),
      ),
    ).toBeNull();
  });

  it("uses singular copy for one prepared draft with nothing remaining", () => {
    expect(
      getTailoredDraftPreparationResultMessage(
        createState({
          attemptedCount: 1,
          completedCount: 1,
          status: "completed",
          totalCount: 1,
        }),
      ),
    ).toBe("Wrote 1 resume.");
  });

  it("leaves remaining work out of a one-job completion notice", () => {
    expect(
      getTailoredDraftPreparationResultMessage(
        createState({
          attemptedCount: 10,
          completedCount: 10,
          eligibleRemainingCount: 1,
          status: "completed",
          totalCount: 10,
        }),
      ),
    ).toBe("Wrote 10 resumes.");
  });

  it("leaves remaining work out of a twenty-job completion notice", () => {
    expect(
      getTailoredDraftPreparationResultMessage(
        createState({
          attemptedCount: 10,
          completedCount: 10,
          eligibleRemainingCount: 20,
          status: "completed",
          totalCount: 10,
        }),
      ),
    ).toBe("Wrote 10 resumes.");
  });

  it("never says stopped when every candidate was attempted and some failed", () => {
    const message = getTailoredDraftPreparationResultMessage(
      createState({
        attemptedCount: 10,
        completedCount: 7,
        eligibleRemainingCount: 4,
        failedCount: 3,
        status: "failed",
        totalCount: 10,
      }),
    );

    expect(message).toBe(
      "Wrote 7 resumes; 3 failed. Run it again to retry the failed jobs.",
    );
    expect(message).not.toMatch(/stopped/i);
  });

  it("reports exact singular counts for a fully attempted single-job failure", () => {
    const message = getTailoredDraftPreparationResultMessage(
      createState({
        attemptedCount: 1,
        completedCount: 0,
        eligibleRemainingCount: 1,
        failedCount: 1,
        status: "failed",
        totalCount: 1,
      }),
    );

    expect(message).toBe(
      "Wrote 0 resumes; 1 failed. Run it again to retry the failed job.",
    );
  });

  it("keeps a genuinely user-stopped run with failures distinct and truthful", () => {
    expect(
      getTailoredDraftPreparationResultMessage(
        createState({
          attemptedCount: 3,
          completedCount: 2,
          currentIndex: null,
          eligibleRemainingCount: 8,
          failedCount: 1,
          status: "failed",
          totalCount: 10,
        }),
      ),
    ).toBe(
      "Stopped after 2 resumes; 1 failed. Run it again to retry the failed job.",
    );
    expect(
      getTailoredDraftPreparationResultMessage(
        createState({
          attemptedCount: 2,
          completedCount: 1,
          eligibleRemainingCount: 9,
          failedCount: 1,
          status: "failed",
          totalCount: 10,
        }),
      ),
    ).toMatch(/^Stopped after 1 resume; 1 failed\./);
  });

  it("keeps a user-stopped run without failures on its own truthful copy", () => {
    expect(
      getTailoredDraftPreparationResultMessage(
        createState({
          attemptedCount: 1,
          completedCount: 1,
          status: "stopped",
          totalCount: 2,
        }),
      ),
    ).toBe("Stopped after 1 resume.");
    expect(
      getTailoredDraftPreparationResultMessage(
        createState({
          attemptedCount: 3,
          completedCount: 3,
          status: "stopped",
          totalCount: 5,
        }),
      ),
    ).toBe("Stopped after 3 resumes.");
  });
});

describe("already prepared applications", () => {
  const readyItem = (jobId: string): ReviewQueueItem =>
    createItem(jobId, {
      assetStatus: "ready",
      resumeAssetId: `asset_${jobId}`,
      resumeReview: {
        status: "approved",
        approvedAt: "2026-08-20T00:00:00.000Z",
        approvedExportId: `export_${jobId}`,
        approvedFormat: "pdf",
        approvedFilePath: `C:/exports/${jobId}.pdf`,
      },
    });

  it("stops counting a job as ready once its application is prepared", () => {
    const queue = [readyItem("a"), readyItem("b"), readyItem("c")];
    const prepared = collectPreparedApplicationJobIds([
      { jobId: "a", status: "ready_for_review" },
      { jobId: "b", status: "submitted" },
    ]);

    expect(countQueueStageReady(queue)).toBe(3);
    expect(countQueueStageReady(queue, prepared)).toBe(1);
    expect(
      getReviewQueueWorkflowStatus(queue[0]!, null, false, prepared).label,
    ).toBe("In Applications");
    expect(
      getReviewQueueWorkflowStatus(queue[2]!, null, false, prepared).label,
    ).toBe("Ready to apply");
  });

  it("keeps staged applications out of the Shortlisted apply batch", () => {
    const queue = [readyItem("a"), readyItem("b"), readyItem("c")];
    // A staged record already has a destination and recovery in Applications.
    const prepared = collectPreparedApplicationJobIds([
      { jobId: "a", status: "shortlisted" },
      { jobId: "b", status: "drafting" },
      { jobId: "c", status: "discovered" },
    ]);

    expect(prepared.size).toBe(3);
    expect(countQueueStageReady(queue, prepared)).toBe(0);
    expect(
      getReviewQueueWorkflowStatus(queue[0]!, null, false, prepared).label,
    ).toBe("In Applications");
  });

  it("shows an Original resume job in Applications even though no generated asset exists", () => {
    const item = createItem("original-prepared", {
      assetStatus: "not_started",
      resumeAssetId: null,
      resumeApplicationMode: "original_resume",
    });
    const prepared = collectPreparedApplicationJobIds([
      {
        jobId: item.jobId,
        status: "ready_for_review",
        lastAttemptState: "ready",
      },
    ]);
    expect(getReviewQueueWorkflowStatus(item, null, false, prepared)).toEqual({
      label: "In Applications",
      tone: "positive",
    });
    expect(countQueueStageReady([item], prepared)).toBe(0);
  });

  it("routes failed, paused, and staged applications to their existing records", () => {
    const prepared = collectPreparedApplicationJobIds([
      { jobId: "failed", status: "approved", lastAttemptState: "failed" },
      { jobId: "paused", status: "approved", lastAttemptState: "paused" },
      { jobId: "staged", status: "approved", lastAttemptState: null },
      { jobId: "ready", status: "ready_for_review", lastAttemptState: null },
    ]);

    expect([...prepared]).toEqual(["failed", "paused", "staged", "ready"]);
  });

  it("counts only new jobs when failed and paused applications remain shortlisted", () => {
    const queue = [readyItem("failed"), readyItem("paused"), readyItem("new")];
    const prepared = collectPreparedApplicationJobIds([
      { jobId: "failed", status: "approved", lastAttemptState: "failed" },
      { jobId: "paused", status: "approved", lastAttemptState: "paused" },
    ]);

    expect(countQueueStageReady(queue, prepared)).toBe(1);
    expect(
      getReviewQueueWorkflowStatus(queue[0]!, null, false, prepared).label,
    ).toBe("In Applications");
    expect(
      getReviewQueueWorkflowStatus(queue[2]!, null, false, prepared).label,
    ).toBe("Ready to apply");
  });

  it("shows an active application run instead of the older prepared label", () => {
    const queue = [readyItem("running")];
    const records = [
      {
        jobId: "running",
        status: "ready_for_review" as const,
        lastAttemptState: "in_progress" as const,
      },
    ];
    const prepared = collectPreparedApplicationJobIds(records);
    const inProgress = collectInProgressApplicationJobIds(records);

    expect(
      getReviewQueueWorkflowStatus(
        queue[0]!,
        null,
        false,
        prepared,
        inProgress,
      ),
    ).toEqual({ label: "Applying", tone: "active" });
  });
});

describe("a shortlist that is all on the original resume", () => {
  const originalResumeQueue = [1, 2, 3, 4, 5, 6].map((index) =>
    createItem(`original-${index}`, {
      resumeApplicationMode: "original_resume",
    }),
  );

  it("counts every original-resume job as ready to prepare", () => {
    for (const item of originalResumeQueue) {
      expect(isQueueStageReady(item)).toBe(true);
    }
    expect(countQueueStageReady(originalResumeQueue)).toBe(6);
  });

  it("still excludes a job whose application is already prepared", () => {
    expect(
      isQueueStageReady(
        originalResumeQueue[0]!,
        new Set([originalResumeQueue[0]!.jobId]),
      ),
    ).toBe(false);
  });

  it("keeps the tailored-draft batch honest about having no draft to write", () => {
    expect(describeTailoredDraftPreparationBlocker(originalResumeQueue)).toBe(
      "Every job here uses your original resume, so there is nothing to write.",
    );
  });
});

it("counts written, fallback and Original choices separately", async () => {
  const result = await prepareTailoredDraftBatch(
    [createItem("written"), createItem("fallback"), createItem("original")],
    (id) => Promise.resolve(id as "written" | "fallback" | "original"),
  );
  expect(result).toMatchObject({
    completedCount: 3,
    fallbackCount: 1,
    originalChoiceCount: 1,
    failedCount: 0,
  });
  expect(
    getTailoredDraftPreparationResultMessage({
      ...result,
      currentIndex: null,
      eligibleRemainingCount: 0,
      status: "completed",
    }),
  ).toBe(
    "Wrote 1 resume · 1 kept your original wording · 1 Original by choice.",
  );
});

it("describes pending Original assessment without claiming it rewrites the file", () => {
  expect(
    getReviewQueueWorkflowStatus(
      createItem("original", { resumeApplicationMode: "original_resume" }),
      null,
      true,
    ).label,
  ).toBe("Reading the listing");
});

it("reports a removed active draft separately from written resumes", async () => {
  const result = await prepareTailoredDraftBatch([createItem("removed")], () =>
    Promise.resolve("cancelled" as const),
  );
  expect(result).toMatchObject({
    completedCount: 1,
    cancelledCount: 1,
    failedCount: 0,
  });
  expect(
    getTailoredDraftPreparationResultMessage({
      ...result,
      currentIndex: null,
      eligibleRemainingCount: 0,
      status: "completed",
    }),
  ).toBe("Wrote 0 resumes · 1 removed from the shortlist.");
});

it("finishes all 33 missing resumes from one admitted queue", async () => {
  const candidates = getTailoredDraftPreparationCandidates(
    Array.from({ length: 33 }, (_, i) => createItem(`batch_${i}`)),
  );
  let active = 0;
  let maxActive = 0;
  const generate = vi.fn(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active--;
    return true;
  });
  const result = await prepareTailoredDraftBatch(candidates, generate);
  expect(result).toMatchObject({
    totalCount: 33,
    completedCount: 33,
    stopped: false,
    failedCount: 0,
  });
  expect(generate).toHaveBeenCalledTimes(33);
  expect(maxActive).toBe(33);
});

it("a blocked service pauses new admissions without counting the unstarted queue as failures", async () => {
  const candidates = Array.from({ length: 200 }, (_, index) =>
    createItem(`blocked_${index}`),
  );
  const generate = vi.fn(() => Promise.resolve("blocked" as const));
  const result = await prepareTailoredDraftBatch(candidates, generate);
  expect(generate).toHaveBeenCalledTimes(100);
  expect(result).toMatchObject({
    stopped: true,
    completedCount: 0,
    failedCount: 0,
    failedJobIds: [],
    totalCount: 200,
  });
  expect(
    getTailoredDraftPreparationResultMessage({
      ...result,
      status: "stopped",
      currentIndex: null,
      eligibleRemainingCount: 200,
      providerBlock: {
        reason: "funding",
        message:
          "The AI service is unavailable because its provider rejected the request for insufficient funds.",
      },
    }),
  ).toContain("200 unfinished resumes remain");
});

describe("possible duplicate shortlisted jobs", () => {
  it("flags one posting saved under two addresses but not the same role in another place", () => {
    const item = (jobId: string, title: string, location: string) => ({
      jobId,
      title,
      company: "Example Co",
      location,
    });
    expect([
      ...findPossibleDuplicateJobIds([
        item("a", "Senior Backend Engineer – Mobile App (f/m/x)", "Remote"),
        item("b", "Senior Backend Engineer - Mobile App (f/m/x)", "remote"),
        item("c", "Senior SRE", "Toronto"),
        item("d", "Senior SRE", "Paris"),
      ]),
    ]).toEqual(["a", "b"]);
  });
});
