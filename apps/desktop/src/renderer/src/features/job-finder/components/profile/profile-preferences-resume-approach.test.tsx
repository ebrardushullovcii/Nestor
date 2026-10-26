// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobSearchPreferencesSchema } from "@nestor/contracts";
import {
  createSearchPreferencesEditorValues,
  type SearchPreferencesEditorValues,
} from "../../lib/profile-editor";
import { ProfilePreferencesTargetingSection } from "./profile-preferences-sections";

const preferences = JobSearchPreferencesSchema.parse({
  targetRoles: [],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  discovery: { targets: [] },
});

function Harness() {
  const preferencesForm = useForm<SearchPreferencesEditorValues>({
    defaultValues: createSearchPreferencesEditorValues(preferences),
  });

  return (
    <>
      <ProfilePreferencesTargetingSection preferencesForm={preferencesForm} />
      <output aria-label="Selected hours">
        {preferencesForm.watch("employmentTypes")}
      </output>
    </>
  );
}

beforeEach(() => {
  // jsdom has no layout, and the popup scrolls its active item into view.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("Preferences resume approach", () => {
  it("keeps the resume level out of the targeting section; it has its own section in this tab, and strict collection lives under Settings, AI behavior", () => {
    render(<Harness />);

    expect(
      screen.queryByLabelText("Default resume tailoring style"),
    ).toBeNull();
    expect(
      screen.queryByText(/How broadly should Job Finder collect/),
    ).toBeNull();
    expect(
      screen.queryByLabelText(/Collect only jobs that meet my hard/),
    ).toBeNull();
  });
});

// "Part-time is the single most important thing about my search", and
// "Two things with the same name meaning different things" about work mode.
describe("Preferences hours and where you work", () => {
  it("gives hours their own labelled control, separate from where you work", () => {
    render(<Harness />);

    expect(screen.queryByText("Employment types")).toBeNull();
    expect(screen.getByRole("group", { name: "Hours" })).toBeTruthy();
    // The where-you-work preference no longer shares the name "work mode"
    // with a work-history card's own field.
    expect(screen.queryByText("Preferred work modes")).toBeNull();
    expect(screen.getByText("Where you want to work")).toBeTruthy();
    expect(screen.queryByText("Job families")).toBeNull();
  });
});

it("changes hours with the shared setup checkboxes and can return to all kinds of work", () => {
  render(<Harness />);
  const hours = within(screen.getByRole("group", { name: "Hours" }));
  fireEvent.click(hours.getByRole("checkbox", { name: "Part-time" }));
  expect(screen.getByLabelText("Selected hours").textContent).toBe("Part-time");
  fireEvent.click(hours.getByRole("checkbox", { name: "Contract" }));
  expect(screen.getByLabelText("Selected hours").textContent).toContain(
    "Contract",
  );
  fireEvent.click(hours.getByRole("checkbox", { name: "Part-time" }));
  fireEvent.click(hours.getByRole("checkbox", { name: "Contract" }));
  expect(screen.getByLabelText("Selected hours").textContent).toBe("");
});
