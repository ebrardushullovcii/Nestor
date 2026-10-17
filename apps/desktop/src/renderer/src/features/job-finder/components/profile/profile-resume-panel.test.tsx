// @vitest-environment jsdom

import { act, useEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandidateProfileSchema,
  ResumeImportFieldCandidateSummarySchema,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import {
  createProfileEditorValues,
  type ProfileEditorValues,
} from "../../lib/profile-editor";
import {
  ProfileResumePanel,
  isPersonFacingImportNote,
  resolveResumeStripStatus,
} from "./profile-resume-panel";

type ProfileResumePanelProps = ComponentProps<typeof ProfileResumePanel>;
type ProfileResumePanelHarnessProps = Omit<
  ProfileResumePanelProps,
  "profileForm"
> & {
  onFormReady?: (form: UseFormReturn<ProfileEditorValues>) => void;
};

function ProfileResumePanelHarness({
  onFormReady,
  ...props
}: ProfileResumePanelHarnessProps) {
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(props.profile),
  });

  useEffect(() => {
    onFormReady?.(profileForm);
  }, [onFormReady, profileForm]);

  return <ProfileResumePanel {...props} profileForm={profileForm} />;
}

describe("ProfileResumePanel", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("keeps the untouched workspace in a truthful not-imported state", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_fresh_start",
      firstName: "New",
      lastName: "Candidate",
      fullName: "New Candidate",
      headline: "Import your resume to begin",
      summary:
        "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
      currentLocation: "Set your preferred location",
      yearsExperience: 0,
      baseResume: {
        id: "resume_fresh_start",
        fileName: "No resume imported yet",
        uploadedAt: new Date(0).toISOString(),
        textContent: null,
        extractionStatus: "needs_text",
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: [],
      locations: [],
      skills: [],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    expect(container?.textContent).toContain(
      "Import your resume to fill in your profile faster",
    );
    expect(container?.textContent).toContain("Not imported");
    expect(container?.textContent).toContain("Profile details");
    expect(container?.textContent).not.toContain("Imported 01 Jan 1970");
    expect(container?.textContent).not.toContain(
      "Job Finder could not read text from this file",
    );
  });

  it("offers plain-text recovery for an unreadable import through the profile form", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_resume_recovery",
      firstName: "Casey",
      lastName: "Rowan",
      fullName: "Casey Rowan",
      headline: "Import your resume to begin",
      summary:
        "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
      currentLocation: "Portland, Oregon",
      yearsExperience: 0,
      baseResume: {
        id: "resume_resume_recovery",
        fileName: "casey-scanned.pdf",
        uploadedAt: "2026-08-28T10:00:00.000Z",
        textContent: null,
        extractionStatus: "needs_text",
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: [],
      locations: [],
      skills: [],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });
    const profileFormRef: {
      current: UseFormReturn<ProfileEditorValues> | null;
    } = { current: null };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          onFormReady={(form) => {
            profileFormRef.current = form;
          }}
          resumeImportProgress={null}
          profile={profile}
        />,
      );
    });

    const resumeTextField = container?.querySelector<HTMLTextAreaElement>(
      "#profile-resume-recovery-text",
    );
    expect(resumeTextField).not.toBeNull();
    expect(resumeTextField?.getAttribute("aria-describedby")).toBe(
      "profile-resume-recovery-text-description",
    );
    expect(container?.textContent).toContain(
      "Save your profile first, then choose Refresh from resume",
    );

    act(() => {
      fireEvent.change(resumeTextField as HTMLTextAreaElement, {
        target: {
          value: "Casey Rowan\nSenior frontend engineer\ncasey@example.com",
        },
      });
    });

    expect(profileFormRef.current?.getValues("identity.resumeText")).toBe(
      "Casey Rowan\nSenior frontend engineer\ncasey@example.com",
    );
    expect(
      profileFormRef.current?.getFieldState("identity.resumeText").isDirty,
    ).toBe(true);
  });

  it("enables refresh after persisted resume text is available", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_resume_recovery_saved",
      firstName: "Casey",
      lastName: "Rowan",
      fullName: "Casey Rowan",
      headline: "Senior frontend engineer",
      summary: "Builds reliable web products.",
      currentLocation: "Portland, Oregon",
      yearsExperience: 8,
      baseResume: {
        id: "resume_resume_recovery_saved",
        fileName: "casey-scanned.pdf",
        uploadedAt: "2026-08-28T10:00:00.000Z",
        textContent: "Casey Rowan\nSenior frontend engineer",
        extractionStatus: "not_started",
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: [],
      locations: [],
      skills: [],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          resumeImportProgress={null}
          profile={profile}
        />,
      );
    });

    const refreshButton = [
      ...(container?.querySelectorAll("button") ?? []),
    ].find((button) => button.textContent?.trim() === "Read my resume again");
    expect(refreshButton).toBeDefined();
    expect(refreshButton?.hasAttribute("disabled")).toBe(false);
    expect(container?.textContent).toContain("Ready to refresh");
    expect(
      container?.querySelector("#profile-resume-recovery-text"),
    ).toBeNull();
  });

  it("disables resume import and refresh while a draft would be overwritten", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_1",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_1",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      skills: ["Figma"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason="Save your current profile or setup draft before importing or refreshing from resume so those unsaved edits do not get overwritten."
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    const buttons = [...(container?.querySelectorAll("button") ?? [])];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(
      expect.arrayContaining(["Replace resume", "Read my resume again"]),
    );
    expect(buttons.every((button) => button.hasAttribute("disabled"))).toBe(
      true,
    );
    expect(container?.textContent).toContain(
      "Save your current profile or setup draft before importing or refreshing from resume so those unsaved edits do not get overwritten.",
    );
  });

  it("keeps a visible fallback import quality note even when raw low-level warnings are hidden", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_2",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_2",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        analysisWarnings: [
          "Python resume parser sidecar fallback: Python sidecar unavailable",
          "pdfplumber is unavailable, so PDF import stayed on the lightweight sidecar fallback.",
        ],
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      skills: ["Figma"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    expect(container?.textContent).toContain(
      "This import used a fallback parsing path, so review the imported details more closely before saving them.",
    );
    expect(container?.textContent).not.toContain(
      "Python resume parser sidecar fallback: Python sidecar unavailable",
    );
  });

  it("names which part of the resume lost its AI stage instead of a generic fallback note", () => {
    // Written by `describeResumeImportStageFallback` in the import workflow.
    const stageFallbackNote =
      "Job Finder could not use the AI model for your work history because the model did not answer in time. It filled that part with its built-in text reader instead, so check those details before you rely on them, or import the file again to retry.";
    const profile = CandidateProfileSchema.parse({
      id: "candidate_stage_fallback",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_stage_fallback",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        analysisWarnings: [
          stageFallbackNote,
          "Fell back to the deterministic staged resume importer after the model call failed.",
          "Primary AI import stage failed: Model request timed out after 25s",
        ],
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      skills: ["Figma"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    // The note qualifies the import status, so it sits with the file and its
    // status in ordinary sentences, not in the uppercase mono review list far
    // below the fold that read as machine log output.
    const qualityNote = container?.querySelector(
      "[data-profile-resume-quality-note]",
    );
    expect(qualityNote?.textContent).toContain(stageFallbackNote);
    expect(container?.textContent).not.toContain("Import quality note");
    expect(container?.textContent).toContain(stageFallbackNote);
    // The specific note replaces the vague one rather than joining it, and the
    // raw provider detail stays out of the user's way.
    expect(container?.textContent).not.toContain(
      "This import used a fallback parsing path",
    );
    expect(container?.textContent).not.toContain(
      "Primary AI import stage failed:",
    );
    // The note must appear once, not once as a quality note and again in the
    // general notes list.
    expect(container?.textContent?.split(stageFallbackNote)).toHaveLength(2);
  });

  it("shows the quality note from the recorded stage fallback even when the run emitted no matching prose", () => {
    // The structured `fallbackKind` is the authority. A run whose AI text
    // stages all degraded but whose warnings were reworded (or absent) must
    // still tell the user, instead of the app holding the fact silently.
    const profile = CandidateProfileSchema.parse({
      id: "candidate_structured_fallback",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_structured_fallback",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        // Deliberately no prose the substring matcher recognises.
        analysisWarnings: [],
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      skills: ["Figma"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={ResumeImportRunSchema.parse({
            id: "resume_import_run_structured",
            sourceResumeId: "resume_structured_fallback",
            sourceResumeFileName: "alex-vanguard.txt",
            trigger: "import",
            status: "applied",
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:30.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "openai_compatible",
            analysisProviderLabel: "Test AI",
            warnings: [],
            errorMessage: null,
            candidateCounts: {
              total: 3,
              autoApplied: 0,
              needsReview: 3,
              rejected: 0,
              abstained: 0,
            },
            timing: {
              textBranchMs: 25_000,
              literalExtractionMs: 12,
              reconciliationMs: 4,
              textStages: [
                {
                  stage: "identity_summary",
                  status: "completed",
                  durationMs: 25_000,
                  fallbackKind: "timeout",
                  fallbackReason: "Model request timed out after 25s",
                },
                {
                  stage: "experience",
                  status: "completed",
                  durationMs: 25_000,
                  fallbackKind: "timeout",
                  fallbackReason: "Model request timed out after 25s",
                },
                {
                  stage: "background",
                  status: "completed",
                  durationMs: 900,
                },
                {
                  stage: "shared_memory",
                  status: "completed",
                  durationMs: 3,
                },
              ],
            },
          })}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    const qualityNote = container?.querySelector(
      "[data-profile-resume-quality-note]",
    );
    expect(qualityNote).not.toBeNull();
    // `shared_memory` is deterministic by design and is not counted.
    expect(qualityNote?.textContent).toContain(
      "The built-in reader handled 2 of 3 import steps instead of AI",
    );
  });

  it("keeps the quality note hidden when no stage fell back and no prose warns", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_clean_import",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_clean_import",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        analysisWarnings: [],
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      skills: ["Figma"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={ResumeImportRunSchema.parse({
            id: "resume_import_run_clean",
            sourceResumeId: "resume_clean_import",
            sourceResumeFileName: "alex-vanguard.txt",
            trigger: "import",
            status: "applied",
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:03.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "openai_compatible",
            analysisProviderLabel: "Test AI",
            warnings: [],
            errorMessage: null,
            candidateCounts: {
              total: 1,
              autoApplied: 1,
              needsReview: 0,
              rejected: 0,
              abstained: 0,
            },
            timing: {
              textBranchMs: 900,
              literalExtractionMs: 12,
              reconciliationMs: 4,
              textStages: [
                {
                  stage: "identity_summary",
                  status: "completed",
                  durationMs: 900,
                },
                {
                  stage: "shared_memory",
                  status: "completed",
                  durationMs: 3,
                },
              ],
            },
          })}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    expect(
      container?.querySelector("[data-profile-resume-quality-note]"),
    ).toBeNull();
  });

  it("puts the built-in-reader hint inside the compact strip when stages fell back", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_compact_fallback",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_compact_fallback",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        analysisWarnings: [],
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      skills: ["Figma"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          compact
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={ResumeImportRunSchema.parse({
            id: "resume_import_run_compact_fallback",
            sourceResumeId: "resume_compact_fallback",
            sourceResumeFileName: "alex-vanguard.txt",
            trigger: "import",
            status: "applied",
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:45.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "openai_compatible",
            analysisProviderLabel: "Test AI",
            warnings: [],
            errorMessage: null,
            candidateCounts: {
              total: 3,
              autoApplied: 0,
              needsReview: 3,
              rejected: 0,
              abstained: 0,
            },
            timing: {
              textBranchMs: 25_000,
              literalExtractionMs: 12,
              reconciliationMs: 4,
              textStages: [
                {
                  stage: "identity_summary",
                  status: "completed",
                  durationMs: 25_032,
                  fallbackKind: "timeout",
                  fallbackReason: "Model request timed out after 25s",
                },
                {
                  stage: "experience",
                  status: "completed",
                  durationMs: 25_054,
                  fallbackKind: "timeout",
                  fallbackReason: "Model request timed out after 25s",
                },
                {
                  stage: "background",
                  status: "completed",
                  durationMs: 20_073,
                  fallbackKind: "timeout",
                  fallbackReason: "Model request timed out after 20s",
                },
                {
                  stage: "shared_memory",
                  status: "completed",
                  durationMs: 3,
                },
              ],
            },
          })}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    // The painted-viewport check looks inside the strip, so the hint has to be
    // in the strip's own subtree, not merely somewhere in the document.
    const strip = container?.querySelector("[data-profile-resume-summary]");
    expect(strip).not.toBeNull();

    const hint = strip?.querySelector("[data-profile-resume-fallback-hint]");
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toBe(
      "The built-in reader handled this import instead of AI, so check the imported details closely.",
    );
    // The hint qualifies the status badge, so it shares that band with it.
    const statusBand = strip?.querySelector("div");
    expect(statusBand?.textContent).toContain("Imported");
    expect(
      statusBand?.querySelector("[data-profile-resume-fallback-hint]"),
    ).not.toBeNull();
  });

  it("omits the compact built-in-reader hint when no stage fell back", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_compact_clean",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_compact_clean",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        analysisWarnings: [],
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      skills: ["Figma"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          compact
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={ResumeImportRunSchema.parse({
            id: "resume_import_run_compact_clean",
            sourceResumeId: "resume_compact_clean",
            sourceResumeFileName: "alex-vanguard.txt",
            trigger: "import",
            status: "applied",
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:03.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "openai_compatible",
            analysisProviderLabel: "Test AI",
            warnings: [],
            errorMessage: null,
            candidateCounts: {
              total: 1,
              autoApplied: 1,
              needsReview: 0,
              rejected: 0,
              abstained: 0,
            },
            timing: {
              textBranchMs: 900,
              literalExtractionMs: 12,
              reconciliationMs: 4,
              textStages: [
                {
                  stage: "identity_summary",
                  status: "completed",
                  durationMs: 900,
                },
                {
                  stage: "shared_memory",
                  status: "completed",
                  durationMs: 3,
                },
              ],
            },
          })}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    expect(
      container?.querySelector("[data-profile-resume-fallback-hint]"),
    ).toBeNull();
  });

  it("shows import ready to use when only optional resume suggestions remain", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_3",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_3",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        analysisWarnings: [
          "1 optional proof suggestion is available to review before using them in tailored resume narratives.",
        ],
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      skills: ["Figma"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={ResumeImportRunSchema.parse({
            id: "resume_import_run_1",
            sourceResumeId: "resume_3",
            sourceResumeFileName: "alex-vanguard.txt",
            trigger: "import",
            status: "applied",
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:03.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            warnings: [],
            errorMessage: null,
            candidateCounts: {
              total: 1,
              autoApplied: 0,
              needsReview: 1,
              rejected: 0,
              abstained: 0,
            },
          })}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    expect(container?.textContent).toContain("Imported");
    expect(container?.textContent).toContain(
      "0 imported automatically; the resume is ready to use.",
    );
    expect(container?.textContent).not.toContain("APPLIED");
  });

  it("replaces placeholder headline copy with an explicit review-needed state after import", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_4",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Import your resume to begin",
      summary:
        "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_4",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        analysisWarnings: [
          "17 imported suggestions still need review before the app should rely on it everywhere.",
          "Target headline suggestion",
        ],
      },
      workEligibility: {},
      professionalSummary: {},
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      skills: ["Figma"],
      experiences: [],
      education: [],
      certifications: [],
      links: [],
      projects: [],
      spokenLanguages: [],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[
            ResumeImportFieldCandidateSummarySchema.parse({
              id: "candidate_headline",
              target: { section: "identity", key: "headline", recordId: null },
              label: "Target headline suggestion",
              value: "Principal systems designer",
              valuePreview: "Principal systems designer",
              evidenceText: "Principal systems designer",
              confidence: 0.88,
              resolution: "needs_review",
              resolutionReason: null,
              notes: [],
            }),
          ]}
          resumeImportProgress={null}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    expect(container?.textContent).toContain("Review imported suggestions");
    expect(container?.textContent).toContain("Needs review");
    expect(container?.textContent).toContain("still needs review");
    expect(container?.textContent).toContain("What to confirm next");
    expect(container?.textContent).not.toContain("Headline not set yet");
    expect(container?.textContent).toContain("Target headline suggestion");
    expect(container?.textContent).toContain("Principal systems designer");
    expect(container?.textContent).not.toContain("17 imported suggestions");
    const reviewCard = [...(container?.querySelectorAll("article") ?? [])].find(
      (article) => article.textContent?.includes("Review before saving"),
    );
    expect(reviewCard).toBeDefined();
    expect(
      reviewCard?.textContent?.match(/Target headline suggestion/g),
    ).toHaveLength(1);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          isProfileReady
          latestResumeImportReviewCandidates={[
            ResumeImportFieldCandidateSummarySchema.parse({
              id: "candidate_headline",
              target: { section: "identity", key: "headline", recordId: null },
              label: "Target headline suggestion",
              value: "Principal systems designer",
              valuePreview: "Principal systems designer",
              evidenceText: "Principal systems designer",
              confidence: 0.88,
              resolution: "needs_review",
              resolutionReason: null,
              notes: [],
            }),
          ]}
          resumeImportProgress={null}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    expect(container?.textContent).toContain(
      "Resume ready — optional suggestions available",
    );
    expect(container?.textContent).toContain(
      "does not block job search or safe application preparation",
    );
    expect(container?.textContent).toContain("Optional review");
    expect(container?.textContent).toContain("Optional imported suggestions");
    expect(container?.textContent).not.toContain("Needs review");
  });
  it("directs legacy or missing original files to replacement while preserving extracted details", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_missing_source",
      firstName: "Casey",
      lastName: "Rowan",
      fullName: "Casey Rowan",
      headline: "Senior frontend engineer",
      summary: "Builds reliable web products.",
      currentLocation: "Portland, Oregon",
      yearsExperience: 8,
      baseResume: {
        id: "resume_missing_source",
        fileName: "casey.pdf",
        uploadedAt: "2026-07-01T10:00:00.000Z",
        storagePath: null,
        sha256: null,
        textContent: "Casey Rowan\\nSenior frontend engineer",
        extractionStatus: "ready",
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "saved original resume cannot be verified",
    );
    expect(container?.textContent).toContain("Replace resume");
    expect(container?.textContent).toContain("Casey Rowan");
  });

  it("keeps an extracted resume labelled Imported even when a later import stage recorded a failure", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_ready_with_failed_run",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      baseResume: {
        id: "resume_ready_with_failed_run",
        fileName: "alex-vanguard.pdf",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        storagePath: "/tmp/alex-vanguard.pdf",
        sha256: "a".repeat(64),
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          compact
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={ResumeImportRunSchema.parse({
            id: "resume_import_run_failed_late",
            sourceResumeId: "resume_ready_with_failed_run",
            sourceResumeFileName: "alex-vanguard.pdf",
            trigger: "import",
            status: "failed",
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:39.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            warnings: [],
            errorMessage:
              "Resume import was superseded by a newer profile edit.",
            candidateCounts: {
              total: 0,
              autoApplied: 0,
              needsReview: 0,
              rejected: 0,
              abstained: 0,
            },
          })}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    const badge = [
      ...(container?.querySelectorAll("[data-slot='badge']") ?? []),
    ].find((element) => element.textContent?.trim() === "Imported");
    expect(badge).toBeDefined();
    expect(container?.textContent).not.toMatch(/\bFailed\b/);
  });

  it("derives the strip label and tone from one source and surfaces run warnings as a secondary sentence", () => {
    expect(
      resolveResumeStripStatus({
        extractionStatus: "ready",
        hasImportedResume: true,
        isProfileReady: true,
        latestRun: { status: "failed" },
        pendingReviewCount: 0,
      }),
    ).toEqual({ label: "Imported", tone: "ready" });
    expect(
      resolveResumeStripStatus({
        extractionStatus: "failed",
        hasImportedResume: true,
        isProfileReady: false,
        latestRun: { status: "failed" },
        pendingReviewCount: 0,
      }),
    ).toEqual({ label: "Import failed", tone: "failed" });
    expect(
      resolveResumeStripStatus({
        extractionStatus: "ready",
        hasImportedResume: true,
        isProfileReady: false,
        latestRun: { status: "review_ready" },
        pendingReviewCount: 2,
      }),
    ).toEqual({ label: "Needs review", tone: "queued" });
    expect(
      resolveResumeStripStatus({
        extractionStatus: "not_started",
        hasImportedResume: true,
        isProfileReady: false,
        latestRun: { status: "extracting" },
        pendingReviewCount: 0,
      }),
    ).toEqual({ label: "Importing", tone: "queued" });

    const profile = CandidateProfileSchema.parse({
      id: "candidate_warned",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      baseResume: {
        id: "resume_warned",
        fileName: "alex-vanguard.pdf",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
        storagePath: "/tmp/alex-vanguard.pdf",
        sha256: "a".repeat(64),
      },
    });
    const warning =
      "Your profile changed while the visual resume scan was finishing. The imported text details stayed applied; visual-scan refinements were not applied automatically.";

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={ResumeImportRunSchema.parse({
            id: "resume_import_run_warned",
            sourceResumeId: "resume_warned",
            sourceResumeFileName: "alex-vanguard.pdf",
            trigger: "import",
            status: "applied",
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:39.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            warnings: [warning],
            errorMessage: null,
            candidateCounts: {
              total: 4,
              autoApplied: 4,
              needsReview: 0,
              rejected: 0,
              abstained: 0,
            },
          })}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    const badge = [
      ...(container?.querySelectorAll("[data-slot='badge']") ?? []),
    ].find((element) => element.textContent?.trim() === "Imported");
    expect(badge).toBeDefined();
    expect(
      container?.querySelector("[data-profile-resume-run-warning]")
        ?.textContent,
    ).toBe(warning);
  });

  it("pins the extraction status badge beside the headline without wrap-induced dead space", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_ready_layout",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      baseResume: {
        id: "resume_ready_layout",
        fileName: "alex-vanguard.txt",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        textContent: "Alex Vanguard",
        extractionStatus: "ready",
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileResumePanelHarness
          importDisabledReason={null}
          isAnalyzeProfilePending={false}
          isImportResumePending={false}
          latestResumeImportReviewCandidates={[]}
          resumeImportProgress={null}
          latestResumeImportRun={null}
          onAnalyzeProfileFromResume={vi.fn()}
          onApplyTimelineRepairAction={vi.fn()}
          onImportResume={vi.fn()}
          profile={profile}
        />,
      );
    });

    const statusBadge = [
      ...(container?.querySelectorAll("[data-slot='badge']") ?? []),
    ].find((badge) => badge.textContent?.includes("Imported"));
    expect(statusBadge).toBeDefined();
    expect(
      container?.querySelector("#profile-resume-recovery-text"),
    ).toBeNull();

    const badgeRow = statusBadge?.parentElement;
    expect(badgeRow?.className).toContain("grid");
    expect(badgeRow?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(badgeRow?.className).toContain("items-start");
    expect(badgeRow?.className).not.toContain("flex-wrap");

    const columnsGrid = badgeRow?.parentElement?.parentElement;
    expect(columnsGrid?.className).toContain("xl:items-start");

    const panelSection = statusBadge?.closest("section");
    expect(panelSection?.className).toContain("py-4 sm:py-5");
    expect(panelSection?.className).not.toContain("px-");
  });
});

describe("isPersonFacingImportNote", () => {
  it("keeps Job Finder's own notes and drops the import model's working notes", () => {
    expect(
      isPersonFacingImportNote(
        "1 optional proof suggestion is available to review before using it in tailored resume narratives.",
      ),
    ).toBe(true);
    expect(
      isPersonFacingImportNote(
        "Paste plain-text resume content below if you want the agent to extract profile details from this file.",
      ),
    ).toBe(true);
    for (const modelNote of [
      "No target roles or salary statements; search_preferences omitted.",
      "No experience record created: resume Experience section names Signal Systems. Per instructions, do not create an experience record without an explicit date range.",
      "Existing profile is empty; all candidates are new imports from literal resume blocks.",
    ]) {
      expect(isPersonFacingImportNote(modelNote)).toBe(false);
    }
  });
});

it("R3-028 names unresolved project details in the import notes", () => {
  expect(
    isPersonFacingImportNote(
      "Could not import Pantry app testing details. Review the source description.",
    ),
  ).toBe(true);
  expect(
    isPersonFacingImportNote(
      "Job Finder could not read your projects because the AI was unavailable.",
    ),
  ).toBe(true);
});
