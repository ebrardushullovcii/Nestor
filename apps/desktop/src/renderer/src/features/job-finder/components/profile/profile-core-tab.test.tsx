// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import {
  createProfileEditorValues,
  type ProfileEditorValues,
} from "../../lib/profile-editor";
import { ProfileCoreTab } from "./profile-core-tab";

const profile = CandidateProfileSchema.parse({
  id: "candidate_accessibility",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Platform engineer",
  summary: "Builds dependable systems.",
  currentLocation: "Prishtina, Kosovo",
  yearsExperience: 7,
  email: "alex@example.com",
  baseResume: {
    id: "resume_accessibility",
    fileName: "alex.pdf",
    uploadedAt: "2026-08-23T09:00:00.000Z",
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

function ProfileCoreHarness() {
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });

  return <ProfileCoreTab profileForm={profileForm} />;
}

describe("ProfileCoreTab accessibility", () => {
  afterEach(cleanup);

  it("keeps formerly implicit identity and narrative fields explicitly named", () => {
    const { container } = render(<ProfileCoreHarness />);

    expect(screen.getByLabelText("First name").id).toBe(
      "profile-core-field-first-name",
    );
    // The location shown on resumes is derived from city/region/country and
    // printed back as text, not typed into a fourth field carrying a postal
    // code nobody asked for.
    expect(screen.queryByLabelText("Displayed location")).toBeNull();
    expect(screen.getByLabelText("City").id).toBe("profile-core-field-city");
    expect(screen.getByLabelText("Motivation themes").id).toBe(
      "profile-core-field-motivation-themes",
    );
    expect(container.querySelector("label label")).toBeNull();
  });

  it("keeps one canonical summary and one canonical skills list in the open form", () => {
    const { container } = render(<ProfileCoreHarness />);

    const professionalSummary = screen.getByLabelText("Professional summary");
    // The resume-facing summary stays in the open form and says so.
    expect(professionalSummary.closest("details")).toBeNull();
    const summaryHintId = professionalSummary.getAttribute("aria-describedby");
    expect(
      summaryHintId
        ? container.querySelector(`#${summaryHintId}`)?.textContent
        : "",
    ).toContain("generated resumes use");

    // One summary field. This profile carries no differing variants, so the
    // "Previous versions" disclosure does not exist at all.
    expect(screen.queryByLabelText("Short summary")).toBeNull();
    expect(screen.queryByLabelText("Professional story")).toBeNull();
    expect(container.textContent).not.toContain(
      "Other versions of your summary",
    );

    // Skills: one open list, the overlapping groupings behind a disclosure.
    const mainSkillsInput = screen.getByLabelText("Main skills");
    expect(mainSkillsInput.closest("details")).toBeNull();
    const groupingDetails = screen
      .getByLabelText("Core strengths")
      .closest("details");
    expect(groupingDetails).not.toBeNull();
    for (const label of [
      "Skills to emphasize for target roles",
      "Tools and platforms",
      "Languages and frameworks",
      "Soft skills",
    ]) {
      expect(screen.getByLabelText(label).closest("details")).toBe(
        groupingDetails,
      );
    }
  });

  it("marks an invalid email with an inline accessible error", () => {
    render(<ProfileCoreHarness />);

    const emailInput = screen.getByRole("textbox", { name: "Email" });
    fireEvent.change(emailInput, { target: { value: "not-an-email" } });

    const error = screen.getByRole("alert");
    expect(emailInput.getAttribute("type")).toBe("email");
    expect(emailInput.getAttribute("aria-invalid")).toBe("true");
    expect(emailInput.getAttribute("aria-describedby")).toBe(error.id);
    expect(error.textContent).toContain("Email must be a valid email address.");

    fireEvent.change(emailInput, { target: { value: "alex@example.com" } });

    expect(emailInput.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
