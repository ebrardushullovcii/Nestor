// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileSetupSummaryCards } from "./profile-setup-screen-sections";

function renderCards(overrides: { isImportResumePending?: boolean } = {}) {
  const onDropResume = vi.fn();
  const onImportResume = vi.fn();
  render(
    <ProfileSetupSummaryCards
      actionMessage={null}
      hasImportedResume={false}
      isImportResumePending={overrides.isImportResumePending ?? false}
      isProfileSetupPending={false}
      onDropResume={onDropResume}
      onImportResume={onImportResume}
      onStartManually={vi.fn()}
      profileSetupState={{
        status: "not_started",
        currentStep: "import",
        completedAt: null,
        lastResumedAt: null,
        reviewItems: [],
      }}
      resumeImportProgress={null}
    />,
  );
  return { onDropResume, onImportResume };
}

function fileDrag(file: File) {
  return { dataTransfer: { files: [file], types: ["Files"], dropEffect: "" } };
}

afterEach(cleanup);

describe("the resume drop zone", () => {
  it("imports a dropped file and keeps the button for the picker", () => {
    const { onDropResume, onImportResume } = renderCards();
    const zone = screen
      .getByText("Drop your resume here")
      .closest("[data-profile-setup-drop-zone]")!;
    const file = new File(["Jamie Rivers"], "resume.txt");

    fireEvent.dragEnter(zone, fileDrag(file));
    expect(zone.getAttribute("data-profile-setup-drop-zone")).toBe("active");
    expect(screen.getByText("Drop it to import")).toBeTruthy();
    fireEvent.drop(zone, fileDrag(file));

    expect(onDropResume).toHaveBeenCalledWith(file);
    expect(zone.getAttribute("data-profile-setup-drop-zone")).toBe("idle");

    fireEvent.click(
      screen.getByRole("button", { name: /Choose my resume file/ }),
    );
    expect(onImportResume).toHaveBeenCalledTimes(1);
  });

  it("ignores a drop while an import is already running", () => {
    const { onDropResume } = renderCards({ isImportResumePending: true });
    const zone = document.querySelector("[data-profile-setup-drop-zone]")!;
    fireEvent.drop(zone, fileDrag(new File(["x"], "resume.pdf")));
    expect(onDropResume).not.toHaveBeenCalled();
  });
});
