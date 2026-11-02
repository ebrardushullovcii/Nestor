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
      remainingBlockerLabels={["Add a job site"]}
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

  it.each([
    ["essentials", false, ["Save and continue to Work history"]],
    // Once setup can finish, finishing is the forward (filled) action, last
    // in the row; continuing to the optional next step steps down.
    [
      "essentials",
      true,
      ["Save and continue to Work history", "Finish setup and find jobs"],
    ],
    [
      "targeting",
      false,
      ["Finish setup and find jobs", "Save and continue to Extras"],
    ],
    ["extras", true, ["Finish setup and find jobs"]],
  ] as const)(
    "on %s (can finish: %s) shows at most two buttons with one filled primary",
    (currentStep, canFinishSetup, labels) => {
      render(
        <ProfileSetupStepFooter
          canFinishSetup={canFinishSetup}
          currentStep={currentStep}
          hasUnsavedChanges
          hasUserEdits
          isProfileSetupPending={false}
          onSaveAndFinish={vi.fn()}
          onSaveAndGoToStep={vi.fn()}
          onSaveCurrentStep={vi.fn()}
          remainingBlockerLabels={canFinishSetup ? [] : ["Add a job site"]}
          validationMessage={null}
        />,
      );
      const buttons = screen.getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(labels);
      // One filled button, the last one, and it can run.
      const filled = buttons.filter(
        (button) => button.getAttribute("data-variant") === "primary",
      );
      expect(filled.map((button) => button.textContent)).toEqual([
        labels.at(-1),
      ]);
      expect(filled[0]?.hasAttribute("disabled")).toBe(false);
      const finish = screen
        .queryAllByRole("button", { name: "Finish setup and find jobs" })
        .at(0);
      if (finish && !canFinishSetup) {
        // Disabled Finish says why, through the readiness line.
        expect(finish.hasAttribute("disabled")).toBe(true);
        expect(finish.getAttribute("aria-describedby")).toBe(
          "profile-setup-finish-blocker-summary",
        );
      }
    },
  );

  it("offers Save changes only where neither Continue nor Finish can save", () => {
    render(
      <ProfileSetupStepFooter
        canFinishSetup={false}
        currentStep="extras"
        hasUnsavedChanges
        hasUserEdits
        isProfileSetupPending={false}
        onSaveAndFinish={vi.fn()}
        onSaveAndGoToStep={vi.fn()}
        onSaveCurrentStep={vi.fn()}
        remainingBlockerLabels={["Add a job site"]}
        validationMessage={null}
      />,
    );
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Save changes", "Finish setup and find jobs"]);
    expect(
      screen.getByText("Still needed to finish: Add a job site."),
    ).toBeTruthy();
  });

  it("says Saving while a save runs instead of Unsaved setup changes", () => {
    render(
      <ProfileSetupStepFooter
        canFinishSetup={false}
        currentStep="essentials"
        hasUnsavedChanges
        hasUserEdits
        isProfileSetupPending
        onSaveAndFinish={vi.fn()}
        onSaveAndGoToStep={vi.fn()}
        onSaveCurrentStep={vi.fn()}
        validationMessage={null}
      />,
    );
    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(screen.queryByText("Unsaved setup changes.")).toBeNull();
  });
});
