// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useForm, useFieldArray } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProfileEditorValues,
  type ProfileEditorValues,
} from "../../lib/profile-editor";
import { CandidateProfileSchema } from "@nestor/contracts";
import { ProfileExperienceTab } from "./profile-experience-tab";
const profile = CandidateProfileSchema.parse({
  id: "candidate_experience_remove",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Platform engineer",
  summary: "Builds dependable systems.",
  currentLocation: "Prishtina, Kosovo",
  yearsExperience: 0,
  email: "alex@example.com",
  baseResume: {
    id: "resume_experience_remove",
    fileName: "alex.pdf",
    uploadedAt: "2026-08-25T09:00:00.000Z",
    extractionStatus: "ready",
  },
  workEligibility: {},
  professionalSummary: {},
  narrative: {},
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

function Harness() {
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });
  const experienceArray = useFieldArray({
    control: profileForm.control,
    keyName: "fieldKey",
    name: "records.experiences",
  });

  return (
    <ProfileExperienceTab
      experienceArray={experienceArray}
      profileForm={profileForm}
    />
  );
}

afterEach(cleanup);

describe("ProfileExperienceTab remove control naming", () => {
  it("names each Remove button after its role so screen readers can tell cards apart", () => {
    if (typeof crypto.randomUUID !== "function") {
      Object.defineProperty(crypto, "randomUUID", {
        value: () => "experience_remove_test",
      });
    }

    render(<Harness />);

    // Two untitled records get stable positional names.
    fireEvent.click(screen.getByRole("button", { name: "Add experience" }));
    fireEvent.click(screen.getByRole("button", { name: "Add experience" }));

    const removeButtons = screen.getAllByRole("button", { name: /Remove / });
    expect(
      removeButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Remove Role 1", "Remove Role 2"]);
    // Visible label stays compact; only the accessible name identifies the role.
    expect(removeButtons[0]?.textContent).toContain("Remove");

    // Typing a title moves the role identity into the accessible name.
    const titleField = document.querySelector<HTMLInputElement>(
      'input[id$="-title"]',
    );
    if (!titleField) {
      throw new Error("Experience title field missing");
    }
    fireEvent.change(titleField, { target: { value: "Barista" } });

    expect(
      screen
        .getByRole("button", { name: "Remove Barista" })
        .getAttribute("aria-label"),
    ).toBe("Remove Barista");
    expect(screen.queryByRole("button", { name: "Remove Role 1" })).toBeNull();
    // The other card keeps its own distinct name.
    expect(screen.getByRole("button", { name: "Remove Role 2" })).toBeTruthy();
  });
});

it("R3-222 offers Freelance and Self-employed employment types", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add experience" }));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const trigger = screen.getByRole("combobox", { name: "Employment type" });
  fireEvent.click(trigger);
  expect(screen.getByRole("option", { name: "Freelance" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Self-employed" })).toBeTruthy();
});
