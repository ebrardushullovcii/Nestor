// @vitest-environment jsdom

import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFieldArray, useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandidateProfileSchema,
  createFreshStartCandidateProfile,
  evaluateProfileSetupReadiness,
  JobSearchPreferencesSchema,
  type ResumeApplicationMode,
} from "@nestor/contracts";
import {
  createProfileEditorValues,
  createSearchPreferencesEditorValues,
  type ProfileEditorValues,
  type SearchPreferencesEditorValues,
} from "../../../lib/profile-editor";
import { ProfileSetupPathCard } from "./profile-setup-screen-sections";
import { ProfileSetupExtrasStep } from "./profile-setup-step-sections-extra";
import { ProfileSetupTargetingStep } from "./profile-setup-step-sections";

vi.mock("@renderer/features/job-lists/setup-sites", () => ({
  SetupSites: () => null,
}));

const profile = CandidateProfileSchema.parse({
  id: "candidate_quality",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Platform engineer",
  summary: "Builds dependable systems.",
  currentLocation: "Prishtina, Kosovo",
  yearsExperience: 7,
  email: "alex@example.com",
  baseResume: {
    id: "resume_quality",
    fileName: "alex.pdf",
    uploadedAt: "2026-07-16T09:00:00.000Z",
    extractionStatus: "ready",
  },
  workEligibility: {},
  professionalSummary: {},
  narrative: {
    professionalStory:
      "I build dependable products with cross-functional teams.",
    careerTransitionSummary:
      "I am moving from platform delivery into applied AI products.",
  },
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
const preferences = JobSearchPreferencesSchema.parse({
  targetRoles: ["Senior Software Engineer"],
  jobFamilies: [],
  locations: [],
  excludedLocations: [],
  workModes: [],
  seniorityLevels: [],
  targetIndustries: [],
  targetCompanyStages: [],
  employmentTypes: [],
  minimumSalaryUsd: null,
  targetSalaryUsd: null,
  salaryCurrency: "USD",
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  companyBlacklist: [],
  companyWhitelist: [],
  discovery: { historyLimit: 5, targets: [] },
});
const untouchedPreferences = JobSearchPreferencesSchema.parse({
  targetRoles: [],
  jobFamilies: [],
  locations: [],
  excludedLocations: [],
  workModes: [],
  seniorityLevels: [],
  targetIndustries: [],
  targetCompanyStages: [],
  employmentTypes: [],
  minimumSalaryUsd: null,
  targetSalaryUsd: null,
  salaryCurrency: "USD",
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  companyBlacklist: [],
  companyWhitelist: [],
  discovery: { historyLimit: 5, targets: [] },
});

function FormHarness(props: {
  onResumeApplicationModeChange?: (mode: ResumeApplicationMode) => void;
  resumeApplicationMode?: ResumeApplicationMode;
  screen: "extras" | "targeting";
}) {
  const [selectedResumeApplicationMode, setSelectedResumeApplicationMode] =
    useState<ResumeApplicationMode>(
      props.resumeApplicationMode ?? "tailored_per_job",
    );
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });
  const preferencesForm = useForm<SearchPreferencesEditorValues>({
    defaultValues: createSearchPreferencesEditorValues(preferences),
  });
  const proofBankArray = useFieldArray({
    control: profileForm.control,
    keyName: "fieldKey",
    name: "proofBank",
  });

  if (props.screen === "targeting") {
    return (
      <>
        <ProfileSetupTargetingStep
          nextStep="extras"
          onSaveAndGoToStep={vi.fn()}
          onResumeApplicationModeChange={(mode) => {
            setSelectedResumeApplicationMode(mode);
            props.onResumeApplicationModeChange?.(mode);
          }}
          preferencesForm={preferencesForm}
          profileForm={profileForm}
          resumeApplicationMode={selectedResumeApplicationMode}
          renderFooter={() => null}
        />
        <output data-tailoring-mode={preferencesForm.watch("tailoringMode")}>
          {preferencesForm.watch("tailoringMode")}
        </output>
        <output data-resume-application-mode>
          {selectedResumeApplicationMode}
        </output>
      </>
    );
  }

  return (
    <ProfileSetupExtrasStep
      backgroundArrays={{ proofBankArray } as never}
      isProfileSetupPending={false}
      profileForm={profileForm}
      renderFooter={() => null}
    />
  );
}

describe("profile setup customer-quality guidance", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  function render(node: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(node));
  }

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("marks an edited earlier step as unsaved instead of Complete", () => {
    render(
      <ProfileSetupPathCard
        currentStep="targeting"
        hasImportedResume
        unsavedSteps={["essentials", "background"]}
        profileSetupState={{
          status: "in_progress",
          currentStep: "targeting",
          completedAt: null,
          reviewItems: [],
          lastResumedAt: null,
        }}
        onGoToStep={() => undefined}
      />,
    );
    const getSetupPathRowText = (label: string) =>
      Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
        button.textContent?.includes(label),
      )?.textContent ?? "";
    expect(getSetupPathRowText("Basics")).toContain("Unsaved changes");
    expect(getSetupPathRowText("Basics")).not.toContain("Complete");
    expect(getSetupPathRowText("Work history")).toContain("Unsaved changes");
  });

  it("keeps pending review counts visible instead of presenting a contradictory completed step", () => {
    render(
      <ProfileSetupPathCard
        currentStep="targeting"
        onGoToStep={vi.fn()}
        profileSetupState={{
          status: "in_progress",
          currentStep: "targeting",
          completedAt: null,
          lastResumedAt: null,
          reviewItems: [
            {
              id: "review_location",
              step: "essentials",
              target: {
                domain: "identity",
                key: "currentLocation",
                recordId: null,
              },
              label: "Current location",
              reason: "Confirm the imported value.",
              severity: "recommended",
              status: "pending",
              proposedValue: "Prishtina, Kosovo",
              sourceSnippet: null,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-07-16T10:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }}
      />,
    );

    // A recommended imported suggestion does not gate finishing setup, so the
    // stepper reports it as a suggestion rather than as blocking review work
    // the finish footer simultaneously says is not outstanding (F30).
    expect(container?.textContent).toContain("1 suggested");
    expect(container?.textContent).not.toContain("Needs review");
    // The stepper stays one compact row of real buttons, each step reachable.
    expect(
      container?.querySelector("[data-profile-setup-stepper]"),
    ).toBeTruthy();
    expect(
      container?.querySelector('[aria-current="step"]')?.textContent,
    ).toContain("Job targets");
  });

  it("hides path review badges when the draft already resolved the saved item", () => {
    render(
      <ProfileSetupPathCard
        currentStep="essentials"
        onGoToStep={vi.fn()}
        profileSetupState={{
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          lastResumedAt: null,
          reviewItems: [
            {
              id: "review_location",
              step: "essentials",
              target: {
                domain: "identity",
                key: "currentLocation",
                recordId: null,
              },
              label: "Current location",
              reason: "Confirm the imported value.",
              severity: "recommended",
              status: "pending",
              proposedValue: "Prishtina, Kosovo",
              sourceSnippet: null,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-07-16T10:00:00.000Z",
              resolvedAt: null,
            },
          ],
        }}
        reviewItems={[]}
      />,
    );

    expect(container?.textContent).not.toContain("1 to review");
    expect(container?.textContent).toContain("Basics");
  });

  it("only badges setup path rows whose own domain content exists after jumping to the last step", () => {
    function getSetupPathRowText(label: string): string {
      const row = Array.from(container?.querySelectorAll("button") ?? []).find(
        (entry) => entry.textContent?.includes(label),
      );
      return row?.textContent ?? "";
    }

    // Blitz-click chronology: landing on ready check with the untouched
    // first-run profile must not mint a single Complete badge.
    render(
      <ProfileSetupPathCard
        currentStep="extras"
        hasImportedResume={false}
        onGoToStep={vi.fn()}
        profileSetupState={{
          status: "in_progress",
          currentStep: "extras",
          completedAt: null,
          lastResumedAt: null,
          reviewItems: [],
        }}
        readiness={evaluateProfileSetupReadiness(
          createFreshStartCandidateProfile(),
          untouchedPreferences,
        )}
      />,
    );

    expect(container?.textContent).not.toContain("Complete");

    // Genuinely satisfied rows stay complete while untouched ones stay open.
    render(
      <ProfileSetupPathCard
        currentStep="extras"
        hasImportedResume={true}
        onGoToStep={vi.fn()}
        profileSetupState={{
          status: "in_progress",
          currentStep: "extras",
          completedAt: null,
          lastResumedAt: null,
          reviewItems: [],
        }}
        readiness={evaluateProfileSetupReadiness(profile, preferences)}
      />,
    );

    expect(getSetupPathRowText("Import")).toContain("Complete");
    expect(getSetupPathRowText("Basics")).toContain("Ready to review");
    expect(getSetupPathRowText("Basics")).not.toContain("Complete");
    // The current step is never "Complete" by chronology alone, and the
    // optional last step still says it is optional.
    expect(getSetupPathRowText("Extras")).toContain("Optional");
    expect(getSetupPathRowText("Extras")).not.toContain("Complete");
    expect(getSetupPathRowText("Work history")).not.toContain("Complete");
    expect(getSetupPathRowText("Job targets")).not.toContain("Complete");
  });

  it("explains that preferred work mode and remote eligibility are separate", () => {
    render(<FormHarness screen="targeting" />);

    expect(container?.textContent).toContain(
      "Choose at least one so searches know what to look for.",
    );
    expect(
      container?.querySelector<HTMLInputElement>(
        "#profile-setup-field-search-preferences-locations",
      )?.placeholder,
    ).toBe("Example: Hamburg; Remote");
    const workModes = container?.querySelector(
      "#profile-setup-field-search-preferences-work-modes",
    );
    const guidanceId = workModes?.getAttribute("aria-describedby");
    expect(guidanceId).toBe(
      "profile-setup-field-search-preferences-work-modes-guidance",
    );
    expect(
      container?.querySelector(
        "#profile-setup-field-search-preferences-work-modes-guidance",
      ),
    ).toBeTruthy();
  });

  it("splits job targets into four short blocks, the optional facts folded away", () => {
    render(<FormHarness screen="targeting" />);

    const headings = [...(container?.querySelectorAll("h3") ?? [])].map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual([
      "What to look for",
      "Two answers every application asksRequired",
    ]);
    // Where to look is its own block (mocked out here), between the two.
    const blocks = [
      ...(container?.querySelectorAll("[data-profile-setup-block]") ?? []),
    ].map((block) => block.getAttribute("data-profile-setup-block"));
    expect(blocks).toEqual(["look-for", "more-about-you"]);
    expect(container?.textContent).toContain(
      "Jobs outside these countries will score low.",
    );
    const more = container?.querySelector<HTMLDetailsElement>(
      "[data-profile-setup-block='more-about-you']",
    );
    expect(more?.tagName).toBe("DETAILS");
    expect(more?.open).toBe(false);
    expect(more?.querySelector("summary")?.textContent).toContain(
      "More about you (optional)",
    );
    expect(
      more?.querySelector(
        "#profile-setup-field-eligibility-willing-to-relocate",
      ),
    ).toBeTruthy();
    // Each block carries one line of help, not a paragraph per field.
    expect(container?.textContent).not.toContain("Enter one place at a time");
  });

  it("presents Extras as one optional, skippable step", () => {
    render(<FormHarness screen="extras" />);

    const text = container?.textContent ?? "";
    expect(text).toContain("Extras — all optional");
    expect(text).toContain("Skip this step and nothing breaks");
    // Both former steps live here now, under one card.
    expect(text).toContain("Your story, in your own words");
    expect(text).toContain("Application links");
    // R3-170: optional sections do not expand into a large setup task.
    const groups = Array.from(container?.querySelectorAll("details") ?? []);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => !group.open)).toBe(true);
    // R3-073: guidance spans professions and includes early-career work.
    const placeholders = Array.from(
      container?.querySelectorAll("textarea") ?? [],
    )
      .map((field) => field.placeholder)
      .join(" ");
    expect(placeholders).toContain("use my experience and keep learning");
    expect(placeholders).toContain("communicate clearly");
    expect(placeholders).not.toMatch(/pupils|marketing|illustration|patients/);
    expect(placeholders).not.toMatch(/backend|ten years/i);
  });

  it("keeps form answer editors out of Profile setup", () => {
    render(<FormHarness screen="extras" />);
    expect(container?.querySelector('[name^="answerBank."]')).toBeNull();
    expect(container?.textContent).not.toContain("Add answer");
  });
});
