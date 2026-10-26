import { describe, expect, test } from "vitest";
import {
  ApplyJobStateSchema,
  ApplicationAttemptStateSchema,
  ApplyRunModeSchema,
  ApplyRunStateSchema,
  ApplySubmitApprovalStatusSchema,
  ApplicationResumeArtifactSchema,
  ApplicationStatusSchema,
  BrowserRunWaitReasonSchema,
  CandidateExperienceSchema,
  CandidateProfileSchema,
  DesktopWindowControlsStateSchema,
  JobSearchPreferencesSchema,
  JobFinderSettingsSchema,
  ResumeApplicationModeSchema,
  SourceAccessPromptStateSchema,
  WorkModeListSchema,
  WriteClipboardTextInputSchema,
  WriteClipboardTextResultSchema,
  annualizeCompensationAmount,
  applicationStatusValues,
  isPreparedApplicationStatus,
  resolveEffectiveResumeTailoringStrength,
  sourceAccessPromptStateValues,
} from "./index";

describe("contracts base schemas", () => {
  test("bounds clipboard text and its success result", () => {
    expect(
      WriteClipboardTextInputSchema.parse({ text: "https://example.test" }),
    ).toEqual({
      text: "https://example.test",
    });
    expect(() =>
      WriteClipboardTextInputSchema.parse({ text: "x".repeat(100_001) }),
    ).toThrow();
    expect(WriteClipboardTextResultSchema.parse({ written: true })).toEqual({
      written: true,
    });
    expect(() =>
      WriteClipboardTextResultSchema.parse({ written: false }),
    ).toThrow();
  });

  test("supports the full application status list", () => {
    expect(applicationStatusValues).toContain("submitted");
    expect(ApplicationStatusSchema.parse("interview")).toBe("interview");
  });

  test("requires successful application-preparation evidence", () => {
    expect(
      isPreparedApplicationStatus({
        status: "approved",
        lastAttemptState: "failed",
      }),
    ).toBe(false);
    expect(
      isPreparedApplicationStatus({
        status: "approved",
        lastAttemptState: "paused",
      }),
    ).toBe(false);
    expect(isPreparedApplicationStatus({ status: "approved" })).toBe(false);
    expect(isPreparedApplicationStatus({ status: "ready_for_review" })).toBe(
      true,
    );
    expect(
      isPreparedApplicationStatus({
        status: "approved",
        lastAttemptState: "ready",
      }),
    ).toBe(true);
  });

  test("parses staged apply foundation enums", () => {
    expect(ApplyRunModeSchema.parse("copilot")).toBe("copilot");
    expect(ApplyRunStateSchema.parse("paused_for_user_review")).toBe(
      "paused_for_user_review",
    );
    expect(ApplyJobStateSchema.parse("awaiting_review")).toBe(
      "awaiting_review",
    );
    expect(ApplySubmitApprovalStatusSchema.parse("approved")).toBe("approved");
    expect(SourceAccessPromptStateSchema.parse("prompt_login_required")).toBe(
      "prompt_login_required",
    );
    expect(BrowserRunWaitReasonSchema.parse("analyzing_visual_snapshot")).toBe(
      "analyzing_visual_snapshot",
    );
  });

  test("supports the full source access prompt state list", () => {
    expect(sourceAccessPromptStateValues).toEqual([
      "prompt_login_required",
      "prompt_login_recommended",
    ]);
    expect(
      SourceAccessPromptStateSchema.parse("prompt_login_recommended"),
    ).toBe("prompt_login_recommended");
  });

  test("parses original-CV application settings and typed resume artifacts", () => {
    expect(ResumeApplicationModeSchema.parse("original_resume")).toBe(
      "original_resume",
    );
    expect(
      JobFinderSettingsSchema.parse({
        resumeFormat: "pdf",
        resumeTemplateId: "classic_ats",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
        keepSessionAlive: false,
        discoveryOnly: false,
        resumeApplicationMode: "original_resume",
      }).resumeApplicationMode,
    ).toBe("original_resume");
    expect(
      ApplicationResumeArtifactSchema.parse({
        id: "application_resume_1",
        jobId: "job_1",
        source: "original_upload",
        sourceDocumentId: "resume_1",
        exportArtifactId: null,
        fileName: "alex-original.pdf",
        filePath: "/tmp/alex-original.pdf",
        approvedAt: "2026-07-14T10:00:00.000Z",
      }).source,
    ).toBe("original_upload");
  });

  test("rejects invalid apply foundation enum values", () => {
    expect(() => ApplyRunModeSchema.parse("invalid_mode")).toThrow();
    expect(() => ApplyRunStateSchema.parse("bad_state")).toThrow();
    expect(() => ApplyJobStateSchema.parse("unknown")).toThrow();
    expect(() => ApplySubmitApprovalStatusSchema.parse("maybe")).toThrow();
  });

  test("parses an expanded candidate profile", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_1",
      firstName: "Alex",
      lastName: "Vanguard",
      middleName: null,
      fullName: "Alex Vanguard",
      headline: "Full-stack engineer",
      summary: "Builds reliable user-facing systems.",
      currentLocation: "London, UK",
      yearsExperience: 8,
      baseResume: {
        id: "resume_1",
        fileName: "alex-vanguard.pdf",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        storagePath: "/tmp/alex-vanguard.pdf",
      },
      targetRoles: ["Frontend Engineer"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    expect(profile.baseResume.storagePath).toBe("/tmp/alex-vanguard.pdf");
    expect(profile.baseResume.extractionStatus).toBe("not_started");
    expect(profile.email).toBeNull();
    expect(profile.locations).toEqual([]);
    expect(profile.skills).toEqual([]);
    expect(profile.experiences).toEqual([]);
    expect(profile.education).toEqual([]);
  });

  test("applies defaults for job search preferences", () => {
    const preferences = JobSearchPreferencesSchema.parse({
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      minimumSalaryUsd: null,
    });

    expect(preferences.companyBlacklist).toEqual([]);
    expect(preferences.workModes).toEqual([]);
    expect(preferences).not.toHaveProperty("discovery");
  });

  test("migrates legacy annual USD preferences and preserves typed monthly ranges", () => {
    const legacy = JobSearchPreferencesSchema.parse({
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      minimumSalaryUsd: 36_000,
      targetSalaryUsd: 48_000,
      salaryCurrency: "USD",
    });

    expect(legacy.compensation).toEqual({
      minimum: 36_000,
      maximum: 48_000,
      interval: "year",
      currency: "USD",
      currencyStatus: "inherited",
    });

    const monthly = JobSearchPreferencesSchema.parse({
      ...legacy,
      compensation: {
        minimum: 3_000,
        maximum: 4_000,
        interval: "month",
        currency: "USD",
        currencyStatus: "explicit",
      },
    });

    expect(monthly.compensation.minimum).toBe(3_000);
    expect(monthly.compensation.maximum).toBe(4_000);
    expect(monthly.minimumSalaryUsd).toBe(36_000);
    expect(monthly.targetSalaryUsd).toBe(48_000);
    expect(annualizeCompensationAmount(2_000, "month")).toBe(24_000);
    expect(annualizeCompensationAmount(50, "hour")).toBe(104_000);
  });

  test("keeps an ambiguous compensation currency unset instead of assuming USD", () => {
    const preferences = JobSearchPreferencesSchema.parse({
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      minimumSalaryUsd: null,
      compensation: {
        minimum: 3_000,
        maximum: 4_000,
        interval: "month",
        currency: null,
        currencyStatus: "needs_clarification",
      },
    });

    expect(preferences.compensation.currency).toBeNull();
    expect(preferences.compensation.currencyStatus).toBe("needs_clarification");
    expect(preferences.minimumSalaryUsd).toBeNull();
    expect(preferences.targetSalaryUsd).toBeNull();
    expect(preferences.salaryCurrency).toBeNull();
  });

  test("preserves user-authored achievement list boundaries", () => {
    const experience = CandidateExperienceSchema.parse({
      id: "experience_short_achievements",
      companyName: "Signal Systems",
      title: "Site Reliability Engineer",
      workMode: [],
      achievements: [
        "Led QA",
        "Maintained CI pipelines",
        "Cross-functional leadership",
      ],
    });

    expect(experience.achievements).toEqual([
      "Led QA",
      "Maintained CI pipelines",
      "Cross-functional leadership",
    ]);
  });

  test("rejects malformed link metadata and url fields", () => {
    expect(() =>
      CandidateProfileSchema.parse({
        id: "candidate_1",
        firstName: "Alex",
        lastName: "Vanguard",
        middleName: null,
        fullName: "Alex Vanguard",
        headline: "Full-stack engineer",
        summary: "Builds reliable user-facing systems.",
        currentLocation: "London, UK",
        yearsExperience: 8,
        baseResume: {
          id: "resume_1",
          fileName: "alex-vanguard.pdf",
          uploadedAt: "2026-03-20T10:00:00.000Z",
          storagePath: "/tmp/alex-vanguard.pdf",
        },
        links: [
          {
            id: "link_1",
            label: "Portfolio",
            url: "not-a-url",
            kind: "custom",
          },
        ],
      }),
    ).toThrow();
  });

  test("parses desktop window controls state", () => {
    const controlsState = DesktopWindowControlsStateSchema.parse({
      isFullScreen: false,
      isMaximized: false,
      isMinimizable: true,
      isClosable: true,
    });

    expect(controlsState.isClosable).toBe(true);
    expect(controlsState.isFullScreen).toBe(false);
  });

  test("normalizes legacy onsite work mode spellings", () => {
    expect(
      WorkModeListSchema.parse(["on-site", "in office", "remote"]),
    ).toEqual(["onsite", "onsite", "remote"]);
  });

  test("resolves effective resume tailoring strength from strategy then preferences", () => {
    expect(
      resolveEffectiveResumeTailoringStrength({
        strategyTailoringStrength: "conservative",
        searchPreferencesTailoringMode: "aggressive",
      }),
    ).toBe("conservative");
    expect(
      resolveEffectiveResumeTailoringStrength({
        strategyTailoringStrength: null,
        searchPreferencesTailoringMode: "aggressive",
      }),
    ).toBe("aggressive");
    expect(
      resolveEffectiveResumeTailoringStrength({
        strategyTailoringStrength: null,
        searchPreferencesTailoringMode: null,
      }),
    ).toBeNull();
  });
});

test("keeps a person's cancellation distinct from an application failure", () => {
  expect(ApplyJobStateSchema.parse("cancelled")).toBe("cancelled");
  expect(ApplicationAttemptStateSchema.parse("cancelled")).toBe("cancelled");
});
