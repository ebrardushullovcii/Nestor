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
import {
  ProfileSetupTargetingStep,
  parseWorkCountriesDraft,
} from "./profile-setup-step-sections";

vi.mock("@renderer/features/job-lists/setup-sites", () => ({
  SetupSites: () => null,
}));

const profile = CandidateProfileSchema.parse({
  id: "candidate_setup_eligibility",
  firstName: "Jamie",
  lastName: "Rivers",
  fullName: "Jamie Rivers",
  headline: "Staff Frontend Engineer",
  currentLocation: "Berlin, Germany",
  currentCountry: "Germany",
  yearsExperience: 12,
  email: "jamie@example.com",
  baseResume: {
    id: "resume_setup_eligibility",
    fileName: "resume-import-sample.txt",
    uploadedAt: "2026-09-23T09:00:00.000Z",
    extractionStatus: "ready",
  },
});

const preferences = JobSearchPreferencesSchema.parse({
  targetRoles: ["Staff Frontend Engineer"],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  discovery: { targets: [] },
});

let latestProfileValues: ProfileEditorValues | null = null;

function Harness() {
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });
  const preferencesForm = useForm<SearchPreferencesEditorValues>({
    defaultValues: createSearchPreferencesEditorValues(preferences),
  });
  latestProfileValues = profileForm.watch();

  return (
    <ProfileSetupTargetingStep
      nextStep="extras"
      onSaveAndGoToStep={() => undefined}
      preferencesForm={preferencesForm}
      profileForm={profileForm}
      renderFooter={() => null}
      suggestedWorkCountry="Germany"
    />
  );
}

describe("Job targets asks the two questions every application form asks", () => {
  beforeAll(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    latestProfileValues = null;
  });

  it("answers both with one press each", () => {
    render(<Harness />);

    // Where the person lives is offered, never assumed.
    expect(latestProfileValues?.eligibility.authorizedWorkCountries).toBe("");
    fireEvent.click(
      screen.getByRole("button", { name: "I can work in Germany" }),
    );
    expect(latestProfileValues?.eligibility.authorizedWorkCountries).toBe(
      "Germany",
    );
    expect(
      screen.queryByRole("button", { name: "I can work in Germany" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(latestProfileValues?.eligibility.requiresVisaSponsorship).toBe("no");
    expect(
      screen.getByRole("button", { name: "No" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("reads several countries from one entry", () => {
    expect(parseWorkCountriesDraft("United States, Germany; Canada")).toEqual([
      "United States",
      "Germany",
      "Canada",
    ]);
  });
});
