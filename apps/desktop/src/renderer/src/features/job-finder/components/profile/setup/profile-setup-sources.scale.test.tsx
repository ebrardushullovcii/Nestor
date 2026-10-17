// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import {
  createProfileEditorValues,
  createSearchPreferencesEditorValues,
  type ProfileEditorValues,
  type SearchPreferencesEditorValues,
} from "../../../lib/profile-editor";
import type { DiscoveryTargetEditorValue } from "../../../lib/job-finder-types";
import {
  isValidProfileSetupSourceUrl,
  PROFILE_SETUP_SOURCE_PAGE_SIZE,
} from "./profile-setup-screen-helpers";
import { ProfileSetupTargetingStep } from "./profile-setup-step-sections";

const profile = CandidateProfileSchema.parse({
  id: "candidate_setup_sources_scale",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Platform engineer",
  summary: "Builds dependable systems.",
  currentLocation: "Prishtina, Kosovo",
  yearsExperience: 7,
  email: "alex@example.com",
  baseResume: {
    id: "resume_setup_sources_scale",
    fileName: "alex.pdf",
    uploadedAt: "2026-07-16T09:00:00.000Z",
    extractionStatus: "ready",
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

function createTarget(index: number): DiscoveryTargetEditorValue {
  const sourceNumber = index.toString().padStart(3, "0");

  return {
    id: `setup_target_${sourceNumber}`,
    label: `Source ${sourceNumber}`,
    startingUrl: `https://jobs-${index}.example.com/openings`,
    enabled: false,
    adapterKind: "auto",
    customInstructions: "",
    instructionStatus: "missing",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
  };
}

function SetupSourcesHarness(props: {
  targets?: DiscoveryTargetEditorValue[];
}) {
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });
  const preferences = JobSearchPreferencesSchema.parse({
    targetRoles: [],
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    discovery: { targets: [] },
  });
  const preferencesForm = useForm<SearchPreferencesEditorValues>({
    defaultValues: {
      ...createSearchPreferencesEditorValues(preferences),
      discoveryTargets:
        props.targets ??
        Array.from({ length: 511 }, (_, index) => createTarget(index + 1)),
    },
  });

  return (
    <ProfileSetupTargetingStep
      nextStep="narrative"
      onSaveAndGoToStep={() => undefined}
      preferencesForm={preferencesForm}
      profileForm={profileForm}
      renderFooter={() => null}
    />
  );
}

describe("ProfileSetupTargetingStep source scale", () => {
  beforeAll(() => {
    // Deterministic pagination: the component's rAF-driven focus jump runs
    // synchronously instead of depending on jsdom frame timing.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("keeps a 511-entry catalog bounded to one searchable 25-row page", () => {
    const { container } = render(<SetupSourcesHarness />);

    expect(
      container.querySelectorAll("[data-profile-setup-source-card]"),
    ).toHaveLength(PROFILE_SETUP_SOURCE_PAGE_SIZE);
    expect(screen.getByText("1–25 of 511")).toBeTruthy();
    expect(screen.getByText("Source 001")).toBeTruthy();
    expect(screen.queryByText("Source 026")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("26–50 of 511")).toBeTruthy();
    expect(screen.getByText("Source 026")).toBeTruthy();
    expect(screen.queryByText("Source 001")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a source" }), {
      target: { value: "source 511" },
    });
    expect(screen.getByText("1 of 511 sources")).toBeTruthy();
    expect(screen.getByText("Source 511")).toBeTruthy();
    expect(screen.queryByText("Source 001")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a source" }), {
      target: { value: "" },
    });
    expect(screen.getByText("511 sources")).toBeTruthy();
    expect(screen.getByText("1–25 of 511")).toBeTruthy();
  });

  it("keeps catalog editing validation-aware with one editor at a time", () => {
    const { container } = render(
      <SetupSourcesHarness
        targets={[createTarget(1), createTarget(2), createTarget(511)]}
      />,
    );

    expect(isValidProfileSetupSourceUrl("not-a-url")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Edit Source 001" }));
    expect(
      container.querySelector("#profile-setup-source-url-setup_target_001"),
    ).toBeTruthy();

    const sourceUrlInput = screen.getByLabelText("Careers or job-board URL");
    fireEvent.change(sourceUrlInput, { target: { value: "not-a-url" } });
    expect(sourceUrlInput.getAttribute("aria-invalid")).toBe("true");
    expect(sourceUrlInput.getAttribute("aria-describedby")).toBe(
      "profile-setup-source-url-error-setup_target_001",
    );
    expect(
      screen.getByText(
        "Enter a complete http or https URL before this source can be used.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit Source 511" }));
    expect(
      container.querySelector("#profile-setup-source-url-setup_target_001"),
    ).toBeNull();
    expect(
      container.querySelector("#profile-setup-source-url-setup_target_511"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "This source needs a complete http or https URL. Choose Edit to fix it before enabling it.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("checkbox", {
          name: "Include Source 001 in searches",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
