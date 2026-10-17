// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import {
  createProfileEditorValues,
  type ProfileEditorValues,
} from "../../lib/profile-editor";
import { ProfileCoreTab } from "./profile-core-tab";
import { ProfileSetupEssentialsStep } from "./setup/profile-setup-step-sections";

const profile = CandidateProfileSchema.parse({
  id: "candidate_shared_basics",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Platform engineer",
  summary: "Builds dependable systems.",
  currentLocation: "Cedar Park, TX 78613",
  currentCity: "Cedar Park",
  currentRegion: "TX",
  currentCountry: "United States",
  yearsExperience: 7,
  email: "alex@example.com",
  baseResume: {
    id: "resume_shared_basics",
    fileName: "alex.pdf",
    uploadedAt: "2026-09-01T09:00:00.000Z",
    extractionStatus: "ready",
  },
});

function SetupBasicsHarness() {
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });

  return (
    <ProfileSetupEssentialsStep
      nextStep="background"
      onSaveAndGoToStep={vi.fn()}
      profileForm={profileForm}
      renderFooter={() => null}
    />
  );
}

function ProfileBasicsHarness() {
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });

  return <ProfileCoreTab profileForm={profileForm} />;
}

const SHARED_BASICS_FIELD_LABELS = [
  "First name",
  "Last name",
  "Preferred full name",
  "Headline",
  "Years of experience",
  "Email",
  "Phone",
  "City",
  "State or region",
  "Country",
  "LinkedIn URL",
  "Website",
  "GitHub URL",
  "Professional summary",
];

function readLabelOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("label"))
    .map((label) => label.textContent?.trim() ?? "")
    .filter((label) => SHARED_BASICS_FIELD_LABELS.includes(label));
}

describe("shared profile Basics field list", () => {
  afterEach(cleanup);

  it("renders identical labels in identical order in setup and Profile", () => {
    const setup = render(<SetupBasicsHarness />);
    const setupLabels = readLabelOrder(setup.container);
    cleanup();

    const profileTab = render(<ProfileBasicsHarness />);
    const profileLabels = readLabelOrder(profileTab.container);

    expect(setupLabels).toEqual(SHARED_BASICS_FIELD_LABELS);
    expect(profileLabels).toEqual(SHARED_BASICS_FIELD_LABELS);
  });

  it("derives the displayed location instead of editing it as a fourth field", () => {
    const { container } = render(<SetupBasicsHarness />);

    expect(screen.queryByLabelText("Displayed location")).toBeNull();
    // The hint describes the record, and the record is the stored line until a
    // part it is built from is edited (`buildProfileUpdatePayload` keeps the
    // stored line authoritative until then). Announcing a recomposed
    // "Cedar Park, TX, United States" over a stored "Cedar Park, TX 78613"
    // contradicted the value that would actually be saved.
    expect(container.textContent).toContain("Cedar Park, TX 78613");
    expect(container.textContent).not.toContain(
      "Cedar Park, TX, United States",
    );

    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "Austin" },
    });
    // Editing a part rebuilds the line exactly as the payload builder does.
    expect(container.textContent).toContain("Austin, TX, United States");
    expect(container.textContent).not.toContain("Cedar Park, TX 78613");
  });

  it("keeps the legacy plain summary in step with the professional summary", () => {
    render(<SetupBasicsHarness />);

    const summary = screen.getByLabelText("Professional summary");
    fireEvent.change(summary, {
      target: { value: "Backend engineer focused on reliability." },
    });

    // One summary, one edit: the legacy stored field cannot go stale behind
    // the field the user actually typed into.
    expect((summary as HTMLTextAreaElement).value).toBe(
      "Backend engineer focused on reliability.",
    );
  });
});
