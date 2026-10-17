import { describe, expect, test } from "vitest";
import {
  CandidateProfileSchema,
  ResumeImportRunSchema,
  isInterruptedResumeImportRun,
  type ResumeImportRun,
} from "@nestor/contracts";
import {
  clearSettledVisionDeferredWarnings,
  interruptedTextImportMessage,
  interruptedVisionMessage,
  recoverInterruptedDeferredVisionRun,
  recoverInterruptedTextImportRun,
} from "./resume-import-recovery";

function makeRun(visionStatus: "running" | "completed"): ResumeImportRun {
  return ResumeImportRunSchema.parse({
    id: "resume_import_restart_test",
    sourceResumeId: "resume_restart_test",
    sourceResumeFileName: "candidate.pdf",
    trigger: "import",
    status: "review_ready",
    startedAt: "2026-07-31T10:00:00.000Z",
    completedAt: "2026-07-31T10:00:05.000Z",
    warnings:
      visionStatus === "running"
        ? [
            "Visual scan is still running. Your text import is ready, and visual reconciliation will continue in the background for up to 10 minutes.",
          ]
        : [],
    modelRoles: {
      vision: {
        status: visionStatus,
        startedAt: "2026-07-31T10:00:01.000Z",
        completedAt:
          visionStatus === "completed" ? "2026-07-31T10:00:04.000Z" : null,
      },
    },
  });
}

describe("recoverInterruptedDeferredVisionRun", () => {
  test("replaces an orphaned running branch with truthful restart guidance", () => {
    const recovered = recoverInterruptedDeferredVisionRun({
      run: makeRun("running"),
      isActiveInCurrentProcess: false,
      now: "2026-07-31T10:10:00.000Z",
    });

    expect(recovered.status).toBe("review_ready");
    expect(recovered.modelRoles?.vision).toMatchObject({
      status: "failed",
      completedAt: "2026-07-31T10:10:00.000Z",
      warning: interruptedVisionMessage,
      errorMessage: interruptedVisionMessage,
    });
    expect(recovered.warnings).toEqual([interruptedVisionMessage]);
  });

  test("does not interrupt a branch owned by the current process", () => {
    const run = makeRun("running");
    expect(
      recoverInterruptedDeferredVisionRun({
        run,
        isActiveInCurrentProcess: true,
      }),
    ).toEqual(run);
  });

  test("leaves a completed branch unchanged", () => {
    const run = makeRun("completed");
    expect(
      recoverInterruptedDeferredVisionRun({
        run,
        isActiveInCurrentProcess: false,
      }),
    ).toEqual(run);
  });

  test("removes a stale deferred note from the profile after vision settles", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_restart_test",
      firstName: "Casey",
      lastName: "Rowan",
      fullName: "Casey Rowan",
      headline: "Frontend engineer",
      summary: "Frontend engineer.",
      currentLocation: "Portland, Oregon",
      yearsExperience: 8,
      baseResume: {
        id: "resume_restart_test",
        fileName: "candidate.pdf",
        uploadedAt: "2026-07-31T10:00:00.000Z",
        storagePath: "C:/safe/candidate.pdf",
        sha256:
          "68b74daf9967149a7e36a972c676c085d3d31c4f0b06307a5a4cf90c9f6b94d2",
        extractionStatus: "ready",
        analysisWarnings: [
          "Visual scan is still running after text import completed; text import is ready and visual reconciliation will continue in the background until the 600000ms vision provider deadline.",
          "Preferred locations",
        ],
      },
    });

    expect(
      clearSettledVisionDeferredWarnings({
        profile,
        run: makeRun("completed"),
      }).baseResume.analysisWarnings,
    ).toEqual(["Preferred locations"]);
  });
});

describe("recoverInterruptedTextImportRun", () => {
  function makeInProgressRun(status: ResumeImportRun["status"]) {
    return ResumeImportRunSchema.parse({
      id: "resume_import_cut_off",
      sourceResumeId: "resume_1758621600000",
      sourceResumeFileName: "resume.txt",
      trigger: "import",
      status,
      startedAt: "2026-09-23T10:00:00.000Z",
      completedAt: null,
    });
  }

  test.each(["queued", "parsing", "extracting", "reconciling"] as const)(
    "turns a %s run nobody is running into a stopped import that can be redone",
    (status) => {
      // Left alone it read "Importing" forever on Profile, and guided setup
      // showed a fresh start as if nothing had happened.
      const recovered = recoverInterruptedTextImportRun({
        run: makeInProgressRun(status),
        isImportActiveInCurrentProcess: false,
        now: "2026-09-23T10:05:00.000Z",
      });

      expect(recovered.status).toBe("failed");
      expect(recovered.failureKind).toBe("interrupted");
      expect(isInterruptedResumeImportRun(recovered)).toBe(true);
      expect(recovered.completedAt).toBe("2026-09-23T10:05:00.000Z");
      expect(recovered.errorMessage).toBe(interruptedTextImportMessage);
      expect(recovered.warnings).toEqual([interruptedTextImportMessage]);
    },
  );

  test("leaves an import that is running in this process alone", () => {
    const run = makeInProgressRun("extracting");
    expect(
      recoverInterruptedTextImportRun({
        run,
        isImportActiveInCurrentProcess: true,
      }),
    ).toEqual(run);
  });

  test("leaves a run whose visual scan is still running here alone", () => {
    // The text stage finalized, then the deferred visual scan took over. A
    // snapshot read meanwhile used to report "This import stopped before it
    // finished" for a live import.
    const run = ResumeImportRunSchema.parse({
      ...makeRun("running"),
      status: "extracting",
    });
    expect(
      recoverInterruptedTextImportRun({
        run,
        isImportActiveInCurrentProcess: false,
        isVisionActiveInCurrentProcess: true,
      }),
    ).toEqual(run);
  });

  test("settles a finalized run an older build left in progress instead of calling it stopped", () => {
    const run = ResumeImportRunSchema.parse({
      ...makeRun("running"),
      status: "reconciling",
      candidateCounts: { total: 4, autoApplied: 3, needsReview: 1 },
    });
    const recovered = recoverInterruptedTextImportRun({
      run,
      isImportActiveInCurrentProcess: false,
      isVisionActiveInCurrentProcess: false,
    });

    expect(recovered.status).toBe("review_ready");
    expect(recovered.errorMessage).toBeNull();
    expect(recovered.warnings).not.toContain(interruptedTextImportMessage);
    expect(recovered.completedAt).toBe(run.completedAt);
    expect(
      recoverInterruptedTextImportRun({
        run: ResumeImportRunSchema.parse({
          ...run,
          candidateCounts: { total: 3, autoApplied: 3, needsReview: 0 },
        }),
        isImportActiveInCurrentProcess: false,
      }).status,
    ).toBe("applied");
  });

  test("leaves a finished import alone", () => {
    const run = ResumeImportRunSchema.parse({
      ...makeInProgressRun("parsing"),
      status: "applied",
      completedAt: "2026-09-23T10:01:00.000Z",
    });
    expect(
      recoverInterruptedTextImportRun({
        run,
        isImportActiveInCurrentProcess: false,
      }),
    ).toEqual(run);
  });
});

describe("isInterruptedResumeImportRun", () => {
  test("reads the typed failure kind, whatever the message says", () => {
    expect(
      isInterruptedResumeImportRun({
        status: "failed",
        errorMessage: "Reworded copy about a stopped import.",
        failureKind: "interrupted",
      }),
    ).toBe(true);
  });

  test("still recognises a run saved before the failure kind existed", () => {
    expect(
      isInterruptedResumeImportRun({
        status: "failed",
        errorMessage: interruptedTextImportMessage,
      }),
    ).toBe(true);
  });

  test("is false for an import that failed for another reason or did not fail", () => {
    expect(
      isInterruptedResumeImportRun({
        status: "failed",
        errorMessage: "The file could not be read.",
        failureKind: null,
      }),
    ).toBe(false);
    expect(
      isInterruptedResumeImportRun({
        status: "applied",
        errorMessage: null,
        failureKind: "interrupted",
      }),
    ).toBe(false);
    expect(isInterruptedResumeImportRun(null)).toBe(false);
  });
});
