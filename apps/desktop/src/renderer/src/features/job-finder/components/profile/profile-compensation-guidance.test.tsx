// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useFieldArray, useForm } from "react-hook-form";
import { it, expect, describe, afterEach } from "vitest";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import {
  createProfileEditorValues,
  createSearchPreferencesEditorValues,
} from "../../lib/profile-editor";
import { ProfilePreferencesEligibilitySection } from "./profile-preferences-eligibility-section";
import { ProfilePreferencesTargetingSection } from "./profile-preferences-sections";
const profile = CandidateProfileSchema.parse({
  id: "candidate_compensation_guidance",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Software engineer",
  summary: "Builds dependable products.",
  currentLocation: "Prishtina, Kosovo",
  yearsExperience: 7,
  workEligibility: {},
  professionalSummary: {},
  narrative: {},
  baseResume: {
    id: "resume_compensation_guidance",
    fileName: "alex.pdf",
    uploadedAt: "2026-08-11T10:00:00.000Z",
    extractionStatus: "ready",
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
  targetRoles: [],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  discovery: { targets: [] },
});

function Harness() {
  const profileForm = useForm({
    defaultValues: createProfileEditorValues(profile),
  });
  const preferencesForm = useForm({
    defaultValues: createSearchPreferencesEditorValues(preferences),
  });
  const limitedPermissionArray = useFieldArray({
    control: profileForm.control,
    name: "eligibility.limitedWorkPermissions",
    keyName: "fieldKey",
  });
  return (
    <>
      <ProfilePreferencesEligibilitySection
        busy={false}
        limitedPermissionArray={limitedPermissionArray}
        profileForm={profileForm}
      />
      <ProfilePreferencesTargetingSection preferencesForm={preferencesForm} />
    </>
  );
}
it("keeps search pay preferences separate from form answers in Needs you", () => {
  const { container } = render(<Harness />);
  expect(screen.getByText("Minimum worth considering")).toBeTruthy();
  expect(container.textContent).toContain(
    "in Needs you when a form asks for it",
  );
  expect(container.querySelector('[name^="answerBank."]')).toBeNull();
  expect(screen.queryByText("Reusable screener answers")).toBeNull();
});

function TargetingHarness() {
  const preferencesForm = useForm({
    defaultValues: createSearchPreferencesEditorValues(preferences),
  });
  return (
    <ProfilePreferencesTargetingSection preferencesForm={preferencesForm} />
  );
}
function EligibilityHarness() {
  const profileForm = useForm({
    defaultValues: createProfileEditorValues(profile),
  });
  const limitedPermissionArray = useFieldArray({
    control: profileForm.control,
    name: "eligibility.limitedWorkPermissions",
    keyName: "fieldKey",
  });
  return (
    <ProfilePreferencesEligibilitySection
      busy={false}
      limitedPermissionArray={limitedPermissionArray}
      profileForm={profileForm}
    />
  );
}
afterEach(cleanup);
describe("preference usability controls", () => {
  afterEach(cleanup);

  it("R3-065 lets a person add and remove a limited permit beside unrestricted countries", () => {
    render(<EligibilityHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add limited permission" }),
    );
    fireEvent.change(screen.getByLabelText("Permit country"), {
      target: { value: "Germany" },
    });
    fireEvent.change(screen.getByLabelText("Permit limits"), {
      target: { value: "Student work only, 20 hours during term" },
    });
    fireEvent.change(
      screen.getByLabelText(
        "Will you need sponsorship for future work in this country?",
      ),
      { target: { value: "yes" } },
    );
    expect(screen.getByLabelText("Permit country")).toHaveProperty(
      "value",
      "Germany",
    );
    expect(
      screen.getByText(/Reusable answers do not override these limits/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove permit" }));
    expect(screen.queryByLabelText("Permit country")).toBeNull();
  });

  it("R3-105 and R3-138 expose shift, weekly hours and base/OTE choices", () => {
    render(<TargetingHarness />);
    fireEvent.change(screen.getByLabelText("Shifts"), {
      target: { value: "day" },
    });
    fireEvent.change(screen.getByLabelText("Minimum weekly hours"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Maximum weekly hours"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Minimum pay counts as"), {
      target: { value: "total_ote" },
    });
    expect(screen.getByLabelText("Shifts")).toHaveProperty("value", "day");
    expect(screen.getByLabelText("Minimum weekly hours")).toHaveProperty(
      "value",
      "20",
    );
    expect(screen.getByLabelText("Maximum weekly hours")).toHaveProperty(
      "value",
      "30",
    );
    expect(screen.getByLabelText("Minimum pay counts as")).toHaveProperty(
      "value",
      "total_ote",
    );
  });
});
