// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileSetupStepFooter } from "./profile-setup-step-footer";

function renderFooter(input: {
  hasUnsavedChanges: boolean;
  hasUserEdits: boolean;
}) {
  return render(
    <ProfileSetupStepFooter
      canFinishSetup={false}
      currentStep="targeting"
      hasUnsavedChanges={input.hasUnsavedChanges}
      hasUserEdits={input.hasUserEdits}
      isProfileSetupPending={false}
      onSaveAndFinish={vi.fn()}
      onSaveAndGoToStep={vi.fn()}
      onSaveCurrentStep={vi.fn()}
      remainingBlockerLabels={["Add a job source"]}
      validationMessage={null}
    />,
  );
}

describe("ProfileSetupStepFooter save state", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not place imported details on the step the import landed on", () => {
    // The import lands on Job targets while the summary it filled in waits
    // on Basics, so "on this step" sent the person looking for nothing.
    renderFooter({ hasUnsavedChanges: true, hasUserEdits: false });

    expect(
      screen.getByText("Filled in from your resume. Saved when you continue."),
    ).toBeTruthy();
    expect(screen.queryByText(/on this step/)).toBeNull();
    // The step's own button saves; no separate Save button for an import.
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("still names the person's own edits as unsaved changes", () => {
    renderFooter({ hasUnsavedChanges: true, hasUserEdits: true });

    expect(screen.getByText("Unsaved setup changes.")).toBeTruthy();
  });
});
