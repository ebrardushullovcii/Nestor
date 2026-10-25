// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobSearchPreferencesSchema } from "@nestor/contracts";
import {
  createSearchPreferencesEditorValues,
  type SearchPreferencesEditorValues,
} from "../../lib/profile-editor";
import { ProfileResumeLevelSection } from "./profile-resume-level-section";

const preferences = JobSearchPreferencesSchema.parse({
  targetRoles: [],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  discovery: { targets: [] },
});

let formRef: UseFormReturn<SearchPreferencesEditorValues> | null = null;

function Harness(props: {
  onResumeApproachChange: (approach: string) => Promise<boolean>;
  resumeApplicationMode?: "original_resume" | "tailored_per_job";
}) {
  const preferencesForm = useForm<SearchPreferencesEditorValues>({
    defaultValues: createSearchPreferencesEditorValues(preferences),
  });
  formRef = preferencesForm;

  return (
    <ProfileResumeLevelSection
      onResumeApproachChange={props.onResumeApproachChange}
      preferencesForm={preferencesForm}
      resumeApplicationMode={props.resumeApplicationMode ?? "tailored_per_job"}
    />
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  formRef = null;
});

afterEach(() => {
  cleanup();
});

const checked = (name: RegExp) =>
  screen.getByRole("radio", { name }).getAttribute("aria-checked");

describe("Profile resume level", () => {
  it("offers Original, Light, Tailored and Aggressive with the saved strength picked", () => {
    render(
      <Harness onResumeApproachChange={vi.fn(() => Promise.resolve(true))} />,
    );

    expect(
      screen.getByRole("radiogroup", { name: "Resume level" }),
    ).toBeTruthy();
    expect(checked(/^Original/)).toBe("false");
    expect(checked(/^Light/)).toBe("false");
    expect(checked(/^Tailored/)).toBe("true");
    expect(checked(/^Aggressive/)).toBe("false");
  });

  it("shows Original picked when the saved mode keeps the imported file", () => {
    render(
      <Harness
        onResumeApproachChange={vi.fn(() => Promise.resolve(true))}
        resumeApplicationMode="original_resume"
      />,
    );

    expect(checked(/^Original/)).toBe("true");
    expect(checked(/^Tailored/)).toBe("false");
  });

  it("saves Aggressive at once, syncs the preferences form, and warns", async () => {
    const onResumeApproachChange = vi.fn(() => Promise.resolve(true));
    render(<Harness onResumeApproachChange={onResumeApproachChange} />);

    fireEvent.click(screen.getByRole("radio", { name: /^Aggressive/ }));

    expect(onResumeApproachChange).toHaveBeenCalledWith("aggressive");
    expect(checked(/^Aggressive/)).toBe("true");
    expect(formRef?.getValues("tailoringMode")).toBe("aggressive");
    expect(screen.getByRole("status").textContent).toContain(
      "Aggressive resumes still need your approval; sending follows your Applying choice.",
    );
    await waitFor(() => expect(onResumeApproachChange).toHaveBeenCalledTimes(1));
  });

  it("goes back to the saved level when the save fails", async () => {
    const onResumeApproachChange = vi.fn(() => Promise.resolve(false));
    render(<Harness onResumeApproachChange={onResumeApproachChange} />);

    fireEvent.click(screen.getByRole("radio", { name: /^Light/ }));

    await waitFor(() =>
      expect(screen.getByText(/This was not saved/)).toBeTruthy(),
    );
    expect(checked(/^Tailored/)).toBe("true");
    expect(formRef?.getValues("tailoringMode")).toBe("balanced");
  });
});
