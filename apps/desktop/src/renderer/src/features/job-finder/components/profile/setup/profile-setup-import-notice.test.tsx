// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandidateProfileSchema,
  RESUME_IMPORT_INTERRUPTED_MESSAGE,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import {
  ProfileSetupImportNotice,
  buildProfileSetupImportNotice,
} from "./profile-setup-import-notice";
import { ProfileSetupSummaryCards } from "./profile-setup-screen-sections";

const readWithoutAiWarning =
  "Job Finder could not use the AI model for this import because no AI model is available right now. It filled in your profile with its built-in text reader instead, so check the details before you rely on them, or import the file again later to retry.";

const profile = CandidateProfileSchema.parse({
  id: "candidate_import_notice",
  fullName: "Jamie Rivers",
  yearsExperience: 12,
  baseResume: {
    id: "resume_1758621600000",
    fileName: "resume-import-sample.txt",
    uploadedAt: "2026-09-23T10:00:00.000Z",
    extractionStatus: "ready",
    analysisWarnings: [readWithoutAiWarning],
  },
});

const interruptedRun = ResumeImportRunSchema.parse({
  id: "resume_import_cut_off",
  sourceResumeId: "resume_1758621600000",
  sourceResumeFileName: "resume-import-sample.txt",
  trigger: "import",
  status: "failed",
  startedAt: "2026-09-23T10:00:00.000Z",
  completedAt: "2026-09-23T10:05:00.000Z",
  errorMessage: RESUME_IMPORT_INTERRUPTED_MESSAGE,
});

const readWithoutAiRun = ResumeImportRunSchema.parse({
  id: "resume_import_without_ai",
  sourceResumeId: "resume_1758621600000",
  sourceResumeFileName: "resume-import-sample.txt",
  trigger: "import",
  status: "applied",
  startedAt: "2026-09-23T10:00:00.000Z",
  completedAt: "2026-09-23T10:00:30.000Z",
  timing: {
    totalMs: 30_000,
    textBranchMs: 30,
    literalExtractionMs: 1,
    reconciliationMs: 1,
    textStages: [
      {
        stage: "identity_summary",
        status: "completed",
        durationMs: 10,
        fallbackKind: "provider_error",
        fallbackReason: "No AI model is available right now.",
      },
      {
        stage: "experience",
        status: "completed",
        durationMs: 10,
        fallbackKind: "provider_error",
        fallbackReason: "No AI model is available right now.",
      },
      {
        stage: "shared_memory",
        status: "completed",
        durationMs: 10,
        fallbackKind: null,
        fallbackReason: null,
      },
    ],
  },
});

describe("what the last import left behind, on whichever step setup opens", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("offers to import a stopped import's file again", () => {
    expect(
      buildProfileSetupImportNotice({
        latestResumeImportRun: interruptedRun,
        profile,
      }),
    ).toMatchObject({
      kind: "interrupted",
      actionLabel: "Import resume-import-sample.txt again",
    });
  });

  it("recognises an older stopped import by its failure kind after the sentence changed", () => {
    const olderRun = ResumeImportRunSchema.parse({
      ...interruptedRun,
      errorMessage:
        "This import stopped early because the app closed. Import the file again.",
      failureKind: "interrupted",
    });
    expect(
      buildProfileSetupImportNotice({
        latestResumeImportRun: olderRun,
        profile,
      }),
    ).toMatchObject({
      kind: "interrupted",
      // Today's sentence, not the one the old run saved.
      message: RESUME_IMPORT_INTERRUPTED_MESSAGE,
      actionLabel: "Import resume-import-sample.txt again",
    });
    expect(
      buildProfileSetupImportNotice({
        latestResumeImportRun: ResumeImportRunSchema.parse({
          ...olderRun,
          failureKind: null,
        }),
        profile,
      }),
    ).toMatchObject({ kind: "failed" });
  });

  it("says plainly when the AI never read the resume, with one press to read it again", () => {
    const onAnalyzeProfileFromResume = vi.fn();
    render(
      <ProfileSetupImportNotice
        importDisabledReason={null}
        isAnalyzeProfilePending={false}
        isImportResumePending={false}
        latestResumeImportRun={readWithoutAiRun}
        onAnalyzeProfileFromResume={onAnalyzeProfileFromResume}
        profile={profile}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "no AI model is available right now",
    );
    fireEvent.click(screen.getByRole("button", { name: "Read it again" }));
    expect(onAnalyzeProfileFromResume).toHaveBeenCalledOnce();
  });

  it("can be dismissed", () => {
    render(
      <ProfileSetupImportNotice
        importDisabledReason={null}
        isAnalyzeProfilePending={false}
        isImportResumePending={false}
        latestResumeImportRun={readWithoutAiRun}
        profile={profile}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss this notice" }),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays quiet after a clean import", () => {
    expect(
      buildProfileSetupImportNotice({
        latestResumeImportRun: ResumeImportRunSchema.parse({
          ...readWithoutAiRun,
          timing: {
            totalMs: 30_000,
            textBranchMs: 30,
            literalExtractionMs: 1,
            reconciliationMs: 1,
            textStages: [
              {
                stage: "experience",
                status: "completed",
                durationMs: 10,
                fallbackKind: null,
                fallbackReason: null,
              },
            ],
          },
        }),
        profile,
      }),
    ).toBeNull();
  });

  it("puts Import again beside the stopped-import message on the first screen", () => {
    const onRetryInterruptedImport = vi.fn();
    render(
      <ProfileSetupSummaryCards
        actionMessage={null}
        hasImportedResume={false}
        interruptedImportFileName="resume-import-sample.txt"
        interruptedImportMessage={RESUME_IMPORT_INTERRUPTED_MESSAGE}
        isImportResumePending={false}
        isProfileSetupPending={false}
        onImportResume={vi.fn()}
        onRetryInterruptedImport={onRetryInterruptedImport}
        onStartManually={vi.fn()}
        profileSetupState={{
          status: "not_started",
          currentStep: "import",
          completedAt: null,
          lastResumedAt: null,
          reviewItems: [],
        }}
        resumeImportProgress={null}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Import resume-import-sample.txt again",
      }),
    );
    expect(onRetryInterruptedImport).toHaveBeenCalledOnce();
    // The first screen says what setup needs, including the two answers.
    expect(document.body.textContent).toContain(
      "whether you would need visa sponsorship",
    );
  });
  // R3-041: a selected file remains retryable after a service failure.
  it("shows the AI failure with a saved-file retry", () => {
    const run = ResumeImportRunSchema.parse({
      ...interruptedRun,
      failureKind: "ai_unavailable",
      errorMessage: "The AI connection failed. Your file is saved.",
    });
    expect(
      buildProfileSetupImportNotice({ latestResumeImportRun: run, profile }),
    ).toMatchObject({
      kind: "failed",
      message: run.errorMessage,
      actionLabel: "Try resume-import-sample.txt again",
    });
  });

  it("offers a new picker for a file with no resume details", () => {
    const onImportResume = vi.fn();
    const onRetryInterruptedImport = vi.fn();
    const run = ResumeImportRunSchema.parse({
      ...interruptedRun,
      failureKind: "invalid_document",
      errorMessage:
        "No resume details were found in this file. Choose another file.",
    });
    render(
      <ProfileSetupImportNotice
        latestResumeImportRun={run}
        profile={profile}
        isImportResumePending={false}
        isAnalyzeProfilePending={false}
        importDisabledReason={null}
        onImportResume={onImportResume}
        onRetryInterruptedImport={onRetryInterruptedImport}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose another file" }),
    );
    expect(onImportResume).toHaveBeenCalledOnce();
    expect(onRetryInterruptedImport).not.toHaveBeenCalled();
  });
  it("replaces a retry notice with progress while reading on another setup step", () => {
    render(
      <ProfileSetupImportNotice
        latestResumeImportRun={interruptedRun}
        profile={profile}
        isImportResumePending={true}
        resumeImportProgress={{
          stage: "building_profile",
          message: "Reading resume-import-sample.txt",
          occurredAt: "2026-10-04T00:00:00.000Z",
        }}
        isAnalyzeProfilePending={false}
        importDisabledReason={null}
      />,
    );
    expect(screen.getByText("Building profile suggestions")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /again/ })).toBeNull();
  });
});
