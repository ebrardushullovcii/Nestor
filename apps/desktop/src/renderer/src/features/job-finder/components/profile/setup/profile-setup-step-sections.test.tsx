// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandidateProfileSchema,
  ResumeImportFieldCandidateSummarySchema,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import { ProfileSetupReviewQueueCard } from "./profile-setup-screen-sections";
import { ProfileSetupImportStep } from "./profile-setup-step-sections";

describe("ProfileSetupImportStep", () => {
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

  it("disables resume import when the current setup step has unsaved edits", () => {
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
        <ProfileSetupImportStep
          importDisabledReason="Save your current profile or setup draft before importing or refreshing from resume so those unsaved edits do not get overwritten."
          isImportResumePending={false}
          isProfileSetupPending={false}
          latestResumeImportReviewCandidates={[]}
          latestResumeImportRun={null}
          resumeImportProgress={null}
          onContinueToProfile={vi.fn()}
          onImportResume={vi.fn()}
          onSaveAndGoToStep={vi.fn()}
          profile={profile}
          renderFooter={() => null}
          reviewItemCount={0}
        />,
      );
    });

    const importButton = [
      ...(container?.querySelectorAll("button") ?? []),
    ].find((button) => button.textContent?.toLowerCase().includes("resume"));
    expect(importButton?.hasAttribute("disabled")).toBe(true);
    expect(container?.textContent).toContain(
      "Save your current profile or setup draft before importing or refreshing from resume so those unsaved edits do not get overwritten.",
    );
  });

  it("says on the import status when stages fell back, and states the note in ordinary sentences", () => {
    const stageFallbackNote =
      "Job Finder could not use the AI model for your work history because the model did not answer in time. It filled that part with its built-in text reader instead, so check those details before you rely on them, or import the file again to retry.";
    const profile = CandidateProfileSchema.parse({
      id: "candidate_fallback",
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
        extractionStatus: "ready",
        analysisWarnings: [stageFallbackNote],
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
    // The hint is derived from the run's own recorded stages: three stages had
    // a model call, one of them lost it. `shared_memory` is deterministic by
    // design and is not counted as an AI stage.
    const run = ResumeImportRunSchema.parse({
      id: "resume_import_run_1",
      sourceResumeId: "resume_1",
      sourceResumeFileName: "alex-vanguard.txt",
      status: "applied",
      startedAt: "2026-03-20T10:00:00.000Z",
      completedAt: "2026-03-20T10:00:30.000Z",
      timing: {
        textBranchMs: 30_000,
        literalExtractionMs: 100,
        reconciliationMs: 100,
        textStages: [
          {
            stage: "identity_summary",
            status: "completed",
            durationMs: 5_000,
          },
          {
            stage: "experience",
            status: "completed",
            durationMs: 25_000,
            fallbackKind: "timeout",
          },
          { stage: "background", status: "completed", durationMs: 4_000 },
          { stage: "shared_memory", status: "completed", durationMs: 10 },
        ],
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileSetupImportStep
          importDisabledReason={null}
          isImportResumePending={false}
          isProfileSetupPending={false}
          latestResumeImportReviewCandidates={[]}
          latestResumeImportRun={run}
          resumeImportProgress={null}
          onContinueToProfile={vi.fn()}
          onImportResume={vi.fn()}
          onSaveAndGoToStep={vi.fn()}
          profile={profile}
          renderFooter={() => null}
          reviewItemCount={0}
        />,
      );
    });

    // "Ready" alone described a degraded import as a clean one.
    const hint = container?.querySelector(
      "[data-profile-setup-import-quality-hint]",
    );
    expect(hint?.textContent).toBe(
      "The built-in reader handled 1 of 3 import steps instead of AI.",
    );

    const note = container?.querySelector(
      "[data-profile-setup-import-quality-note]",
    );
    expect(note?.textContent).toBe(stageFallbackNote);
    // Ordinary sentence case, not the 11px uppercase mono treatment.
    expect(note?.className).not.toContain("uppercase");
  });

  it("says nothing about stage quality when every AI stage kept its model call", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_clean",
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
    const run = ResumeImportRunSchema.parse({
      id: "resume_import_run_2",
      sourceResumeId: "resume_1",
      sourceResumeFileName: "alex-vanguard.txt",
      status: "applied",
      startedAt: "2026-03-20T10:00:00.000Z",
      timing: {
        textBranchMs: 9_000,
        literalExtractionMs: 100,
        reconciliationMs: 100,
        textStages: [
          { stage: "identity_summary", status: "completed", durationMs: 5_000 },
          { stage: "experience", status: "completed", durationMs: 4_000 },
        ],
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileSetupImportStep
          importDisabledReason={null}
          isImportResumePending={false}
          isProfileSetupPending={false}
          latestResumeImportReviewCandidates={[]}
          latestResumeImportRun={run}
          resumeImportProgress={null}
          onContinueToProfile={vi.fn()}
          onImportResume={vi.fn()}
          onSaveAndGoToStep={vi.fn()}
          profile={profile}
          renderFooter={() => null}
          reviewItemCount={0}
        />,
      );
    });

    expect(
      container?.querySelector("[data-profile-setup-import-quality-hint]"),
    ).toBeNull();
    expect(
      container?.querySelector("[data-profile-setup-import-quality-note]"),
    ).toBeNull();
  });

  it("surfaces truthful recovery when a persisted import has no readable text", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_needs_text",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      baseResume: {
        id: "resume_needs_text",
        fileName: "alex-scanned.pdf",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        extractionStatus: "needs_text",
        analysisWarnings: [
          "Paste plain-text resume content below if you want the agent to extract profile details from this file.",
          "Local resume image generation failed before the vision branch could start.",
        ],
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
        <ProfileSetupImportStep
          importDisabledReason={null}
          isImportResumePending={false}
          isProfileSetupPending={false}
          latestResumeImportReviewCandidates={[]}
          latestResumeImportRun={null}
          resumeImportProgress={null}
          onContinueToProfile={vi.fn()}
          onImportResume={vi.fn()}
          onSaveAndGoToStep={vi.fn()}
          profile={profile}
          renderFooter={() => null}
          reviewItemCount={0}
        />,
      );
    });

    // Truthful outcome: saved but nothing extracted — never "ready".
    expect(container?.textContent).toContain("Needs Text");
    expect(container?.textContent).toContain(
      "could not read text from it, so nothing was extracted into your profile yet.",
    );
    // Nearest usable recovery paths stay named, including manual/plain-text.
    expect(container?.textContent).toContain(
      "Choose Import resume to try again",
    );
    expect(container?.textContent).toContain("entering your details manually");
    expect(container?.textContent).toContain(
      "paste plain text into the resume",
    );
    // Persisted analysis warnings are shown as compact supporting detail.
    expect(container?.textContent).toContain(
      "Paste plain-text resume content below if you want the agent to extract profile details from this file.",
    );
    // The always-zero review-items tile is gone; the footer reports counts.
    expect(container?.textContent).not.toContain("Review items");
    expect(container?.textContent).not.toContain("in this step");
  });

  it("summarizes imported text-vs-vision conflict choices", () => {
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
        fileName: "alex-vanguard.pdf",
        uploadedAt: "2026-03-20T10:00:00.000Z",
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
        <ProfileSetupImportStep
          importDisabledReason={null}
          isImportResumePending={false}
          isProfileSetupPending={false}
          latestResumeImportReviewCandidates={[
            ResumeImportFieldCandidateSummarySchema.parse({
              id: "candidate_conflict_1",
              target: { section: "identity", key: "headline", recordId: null },
              label: "Headline",
              value: "Staff Platform Engineer",
              valuePreview: "Staff Platform Engineer",
              evidenceText: "Staff Platform Engineer",
              confidence: 0.8,
              resolution: "needs_review",
              resolutionReason: "text_vs_visual_conflict_requires_review",
              notes: [],
              conflictChoices: [
                {
                  id: "choice_text",
                  label: "Headline",
                  sourceLabel: "Document text",
                  value: "Senior Software Engineer",
                  valuePreview: "Senior Software Engineer",
                  confidence: 0.86,
                  recommended: true,
                },
                {
                  id: "choice_vision",
                  label: "Headline",
                  sourceLabel: "Visual scan",
                  value: "Staff Platform Engineer",
                  valuePreview: "Staff Platform Engineer",
                  confidence: 0.8,
                  recommended: false,
                },
              ],
            }),
          ]}
          latestResumeImportRun={null}
          resumeImportProgress={null}
          onContinueToProfile={vi.fn()}
          onImportResume={vi.fn()}
          onSaveAndGoToStep={vi.fn()}
          profile={profile}
          renderFooter={() => null}
          reviewItemCount={1}
        />,
      );
    });

    expect(container?.textContent).toContain("Staff Platform Engineer");
    expect(container?.textContent).toContain(
      "Compare Document text and Visual scan before confirming.",
    );
  });

  it("shows missing work eligibility as required with an edit action and no dismissal", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ProfileSetupReviewQueueCard
          actionsDisabledReason={null}
          isReviewItemPending={() => false}
          items={[
            {
              id: "missing_eligibility",
              step: "targeting",
              target: {
                domain: "work_eligibility",
                key: "authorizedWorkCountries",
                recordId: null,
              },
              label: "Work eligibility",
              reason: "Answer before finishing setup.",
              severity: "recommended",
              status: "pending",
              savedStatus: "pending",
              statusSource: "saved",
              proposedValue: null,
              sourceSnippet: null,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-11T10:00:00.000Z",
              resolvedAt: null,
            },
          ]}
          latestResumeImportReviewCandidates={[]}
          onApplyReviewAction={vi.fn()}
          onEditReviewItem={vi.fn()}
        />,
      );
    });
    expect(container?.textContent).toContain("Required");
    expect(container?.textContent).not.toContain("Recommended");
    expect(container?.textContent).toContain("Edit this");
    expect(container?.textContent).not.toContain("Dismiss for now");
  });

  it("shows the shared edit hint once per queue instead of above every item", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const targetingItem = (id: string, key: string, label: string) => ({
      id,
      step: "targeting" as const,
      target: {
        domain: "search_preferences" as const,
        key,
        recordId: null,
      },
      label,
      reason: `Confirm the imported ${label.toLowerCase()}.`,
      severity: "recommended" as const,
      status: "pending" as const,
      savedStatus: "pending" as const,
      statusSource: "saved" as const,
      proposedValue: "Austin, TX",
      sourceSnippet: null,
      sourceCandidateId: `candidate_${key}`,
      sourceRunId: "resume_import_run_1",
      createdAt: "2026-04-11T10:00:00.000Z",
      resolvedAt: null,
    });

    act(() => {
      root?.render(
        <ProfileSetupReviewQueueCard
          actionsDisabledReason={null}
          isReviewItemPending={() => false}
          items={[
            targetingItem(
              "review_locations",
              "locations",
              "Preferred locations",
            ),
            targetingItem(
              "review_work_modes",
              "workModes",
              "Preferred work modes",
            ),
          ]}
          latestResumeImportReviewCandidates={[]}
          onApplyReviewAction={vi.fn()}
          onEditReviewItem={vi.fn()}
        />,
      );
    });

    const hints = container?.querySelectorAll(
      "[data-profile-setup-review-queue-edit-hint] p",
    );
    expect(hints?.length).toBe(1);
    expect(hints?.[0]?.textContent).toBe(
      "Edit this in the Job targets step — preferences say what you want, work details say what you can accept.",
    );
    expect(container?.textContent).not.toContain("Job Finder will not guess");
  });

  it("renders the empty-state sentence only when the queue list is empty", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileSetupReviewQueueCard
          actionsDisabledReason={null}
          isReviewItemPending={() => false}
          items={[
            {
              id: "review_headline",
              step: "essentials",
              target: { domain: "identity", key: "headline", recordId: null },
              label: "Headline",
              reason: "Confirm the imported headline.",
              severity: "recommended",
              status: "confirmed",
              savedStatus: "pending",
              statusSource: "draft",
              proposedValue: "Senior Software Engineer",
              sourceSnippet: null,
              sourceCandidateId: "candidate_headline",
              sourceRunId: "resume_import_run_1",
              createdAt: "2026-04-11T10:00:00.000Z",
              resolvedAt: null,
            },
          ]}
          latestResumeImportReviewCandidates={[]}
          onApplyReviewAction={vi.fn()}
          onEditReviewItem={vi.fn()}
        />,
      );
    });

    // A resolved-in-draft item is still listed, so the "nothing to review"
    // sentence must not sit above it.
    expect(container?.textContent).toContain("Headline");
    expect(container?.textContent).toContain("confirmed · unsaved");
    expect(container?.textContent).not.toContain(
      "Nothing to confirm on this step.",
    );
    expect(
      container?.querySelector("[data-profile-setup-review-queue-summary]"),
    ).toBeNull();

    act(() => {
      root?.render(
        <ProfileSetupReviewQueueCard
          actionsDisabledReason={null}
          isReviewItemPending={() => false}
          items={[]}
          latestResumeImportReviewCandidates={[]}
          onApplyReviewAction={vi.fn()}
          onEditReviewItem={vi.fn()}
        />,
      );
    });

    // An empty queue renders nothing at all: a card that only says "nothing
    // to confirm" is a box that says nothing.
    expect(container?.textContent).toBe("");
  });

  it("lets users confirm a specific text-vs-vision conflict choice", () => {
    const onApplyReviewAction = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileSetupReviewQueueCard
          actionsDisabledReason={null}
          isReviewItemPending={() => false}
          items={[
            {
              id: "review_headline_conflict",
              step: "essentials",
              target: { domain: "identity", key: "headline", recordId: null },
              label: "Headline",
              reason: "Choose the imported headline to keep.",
              severity: "recommended",
              status: "pending",
              savedStatus: "pending",
              statusSource: "saved",
              proposedValue: "Senior Software Engineer",
              sourceSnippet: "Senior Software Engineer",
              sourceCandidateId: "candidate_conflict_1",
              sourceRunId: "resume_import_run_1",
              createdAt: "2026-04-11T10:00:00.000Z",
              resolvedAt: null,
            },
          ]}
          latestResumeImportReviewCandidates={[
            ResumeImportFieldCandidateSummarySchema.parse({
              id: "candidate_conflict_1",
              target: { section: "identity", key: "headline", recordId: null },
              label: "Headline",
              value: "Senior Software Engineer",
              valuePreview: "Senior Software Engineer",
              evidenceText: "Senior Software Engineer",
              confidence: 0.86,
              resolution: "needs_review",
              resolutionReason: "text_vs_visual_conflict_requires_review",
              notes: [],
              conflictChoices: [
                {
                  id: "choice_text",
                  label: "Headline",
                  sourceLabel: "Document text",
                  value: "Senior Software Engineer",
                  valuePreview: "Senior Software Engineer",
                  confidence: 0.86,
                  recommended: true,
                },
                {
                  id: "choice_vision",
                  label: "Headline",
                  sourceLabel: "Visual scan",
                  value: "Staff Platform Engineer",
                  valuePreview: "Staff Platform Engineer",
                  confidence: 0.8,
                  recommended: false,
                },
              ],
            }),
          ]}
          onApplyReviewAction={onApplyReviewAction}
          onEditReviewItem={vi.fn()}
        />,
      );
    });

    const genericConfirmButton = [
      ...(container?.querySelectorAll("button") ?? []),
    ].find((button) => button.textContent === "Confirm");
    expect(genericConfirmButton).toBeTruthy();
    expect(genericConfirmButton?.hasAttribute("disabled")).toBe(true);

    const visualChoiceButton = [
      ...(container?.querySelectorAll("button") ?? []),
    ].find((button) => button.textContent?.includes("Use Visual scan"));
    expect(visualChoiceButton).toBeTruthy();

    act(() => {
      visualChoiceButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(onApplyReviewAction).toHaveBeenCalledWith(
      "review_headline_conflict",
      "confirm",
      {
        selectedConflictChoiceId: "choice_vision",
      },
    );
  });

  it("labels pending optional suggestions as non-blocking", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileSetupReviewQueueCard
          actionsDisabledReason={null}
          isReviewItemPending={() => false}
          items={[
            {
              id: "review_optional_proof",
              step: "narrative",
              target: {
                domain: "proof_point",
                key: "record",
                recordId: "proof_1",
              },
              label: "Optional achievement proof",
              reason: "Review before reuse.",
              severity: "optional",
              status: "pending",
              savedStatus: "pending",
              statusSource: "saved",
              proposedValue: "A grounded achievement",
              sourceSnippet: "A grounded achievement",
              sourceCandidateId: "candidate_optional_proof",
              sourceRunId: "resume_import_run_1",
              createdAt: "2026-07-31T04:00:00.000Z",
              resolvedAt: null,
            },
          ]}
          latestResumeImportReviewCandidates={[]}
          onApplyReviewAction={vi.fn()}
          onEditReviewItem={vi.fn()}
        />,
      );
    });

    // R3-170: imported optional proof stays out of the required setup path.
    const optional = container?.querySelector("details");
    expect(optional).toBeTruthy();
    expect(optional?.open).toBe(false);
    expect(optional?.querySelector("summary")?.textContent).toContain(
      "1 optional suggestion",
    );
    // The item is listed with its own Optional severity badge; the card no
    // longer prints a second sentence counting the same suggestion.
    expect(container?.textContent).toContain("Optional");
    expect(container?.textContent).not.toContain(
      "1 optional suggestion is available",
    );
    expect(container?.textContent).not.toContain(
      "needs confirmation or an edit",
    );
  });
});
