// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import {
  buildProfilePayload,
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
  "Date of birth",
  "Citizenship",
  "Street address",
  "Postal code",
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

  it("holds date of birth, citizenship and the postal address, and saves them", () => {
    let form: ReturnType<typeof useForm<ProfileEditorValues>> | null = null;
    function Harness() {
      const profileForm = useForm<ProfileEditorValues>({
        defaultValues: createProfileEditorValues(profile),
      });
      form = profileForm;
      return (
        <ProfileSetupEssentialsStep
          nextStep="background"
          onSaveAndGoToStep={vi.fn()}
          profileForm={profileForm}
          renderFooter={() => null}
        />
      );
    }
    const { container } = render(<Harness />);

    const birth = screen.getByLabelText<HTMLInputElement>("Date of birth");
    expect(birth.type).toBe("date");
    fireEvent.change(birth, { target: { value: "1990-01-31" } });
    fireEvent.change(screen.getByLabelText("Citizenship"), {
      target: { value: "Examplestan, Samplia, Examplestan" },
    });
    fireEvent.change(screen.getByLabelText("Street address"), {
      target: { value: "1 Synthetic Way" },
    });
    fireEvent.change(screen.getByLabelText("Postal code"), {
      target: { value: "00000" },
    });
    // Street and postal code stay off resumes: the shown line is unchanged.
    expect(container.textContent).toContain("Cedar Park, TX 78613");

    const payload = buildProfilePayload(profile, form!.getValues()).payload;
    expect(payload).toMatchObject({
      dateOfBirth: "1990-01-31",
      citizenshipCountries: ["Examplestan", "Samplia"],
      streetAddress: "1 Synthetic Way",
      postalCode: "00000",
      currentLocation: "Cedar Park, TX 78613",
    });
  });

  it("shows a date of birth the resume wrote in words as editable text", () => {
    function Harness() {
      const form = useForm<ProfileEditorValues>({
        defaultValues: createProfileEditorValues({
          ...profile,
          dateOfBirth: "31 January 1990",
          citizenshipCountries: ["Examplestan", "Samplia"],
        }),
      });
      return <ProfileCoreTab profileForm={form} />;
    }
    render(<Harness />);
    const birth = screen.getByLabelText<HTMLInputElement>("Date of birth");
    expect(birth.type).toBe("text");
    expect(birth.value).toBe("31 January 1990");
    expect(screen.getByLabelText<HTMLInputElement>("Citizenship").value).toBe(
      "Examplestan, Samplia",
    );
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
