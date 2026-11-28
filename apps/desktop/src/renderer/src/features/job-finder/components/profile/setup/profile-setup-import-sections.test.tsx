// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ProfileSetupStateSchema,
  ResumeImportRunSchema,
  type ResumeImportRun,
} from "@nestor/contracts";
import { ProfileSetupPathCard } from "./profile-setup-screen-sections";
import {
  formatUnreadImportStepLabel,
  getUnreadImportSetupSteps,
} from "./profile-setup-import-sections";

afterEach(cleanup);

function runWithStages(
  statuses: Record<
    "identity_summary" | "experience" | "background" | "shared_memory",
    "completed" | "failed" | "timed_out"
  >,
): ResumeImportRun {
  return ResumeImportRunSchema.parse({
    id: "resume_import_run_w133",
    sourceResumeId: "resume_w133",
    sourceResumeFileName: "resume.pdf",
    trigger: "import",
    status: "review_ready",
    startedAt: "2026-11-28T16:50:00.000Z",
    completedAt: "2026-11-28T16:50:40.000Z",
    timing: {
      textBranchMs: 1,
      literalExtractionMs: 1,
      reconciliationMs: 1,
      textStages: Object.entries(statuses).map(([stage, status]) => ({
        stage,
        status,
        durationMs: 1,
      })),
    },
  });
}

const stepperProps = {
  currentStep: "essentials" as const,
  hasImportedResume: true,
  onGoToStep: vi.fn(),
  profileSetupState: ProfileSetupStateSchema.parse({
    status: "in_progress",
    currentStep: "essentials",
  }),
};

function stepText(name: RegExp) {
  return screen.getByRole("button", { name }).textContent ?? "";
}

describe("a section the resume read never reached (W131)", () => {
  test("maps each unread stage to the step that shows it", () => {
    expect(
      getUnreadImportSetupSteps(
        runWithStages({
          identity_summary: "failed",
          experience: "failed",
          background: "timed_out",
          shared_memory: "failed",
        }),
      ),
    ).toEqual(["essentials", "background", "extras"]);
    expect(
      getUnreadImportSetupSteps(
        runWithStages({
          identity_summary: "completed",
          experience: "completed",
          background: "failed",
          shared_memory: "completed",
        }),
      ),
    ).toEqual(["background"]);
    expect(
      getUnreadImportSetupSteps(
        runWithStages({
          identity_summary: "completed",
          experience: "completed",
          background: "completed",
          shared_memory: "completed",
        }),
      ),
    ).toEqual([]);
    expect(getUnreadImportSetupSteps(null)).toEqual([]);
  });

  test("says what the read waits on, in the import notice's terms", () => {
    expect(formatUnreadImportStepLabel(null)).toBe("Not read yet");
    expect(formatUnreadImportStepLabel({ owner: "person" })).toBe(
      "Waiting on your AI account",
    );
    expect(formatUnreadImportStepLabel({ owner: "nestor" })).toBe(
      "Waiting on Nestor's AI",
    );
  });

  test("Work history no longer says Ready to review when it was never read", () => {
    const { rerender } = render(
      <ProfileSetupPathCard
        {...stepperProps}
        unreadImportSteps={["essentials", "background", "extras"]}
      />,
    );
    expect(stepText(/Work history/)).toContain("Not read yet");
    expect(screen.queryByText("Ready to review")).toBeNull();
    expect(stepText(/Extras/)).toContain("Not read yet");
    expect(stepText(/Extras/)).not.toContain("Optional");

    rerender(
      <ProfileSetupPathCard
        {...stepperProps}
        unreadImportLabel="Waiting on your AI account"
        unreadImportSteps={["essentials", "background", "extras"]}
      />,
    );
    expect(stepText(/Work history/)).toContain("Waiting on your AI account");
    expect(
      screen
        .getByRole("button", { name: /Work history/ })
        .getAttribute("data-step-state"),
    ).toBe("todo");
  });

  test("a read section keeps Ready to review beside an unread one", () => {
    render(
      <ProfileSetupPathCard
        {...stepperProps}
        unreadImportSteps={["background"]}
      />,
    );
    expect(stepText(/Basics/)).toContain("Ready to review");
    expect(stepText(/Work history/)).toContain("Not read yet");
  });

  test("a step the person saved or is editing is theirs again", () => {
    const { rerender } = render(
      <ProfileSetupPathCard
        {...stepperProps}
        profileSetupState={{
          ...stepperProps.profileSetupState,
          reviewedSteps: ["background"],
        }}
        unreadImportSteps={["background"]}
      />,
    );
    expect(stepText(/Work history/)).not.toContain("Not read yet");
    expect(stepText(/Work history/)).toContain("Complete");

    rerender(
      <ProfileSetupPathCard
        {...stepperProps}
        unsavedSteps={["background"]}
        unreadImportSteps={["background"]}
      />,
    );
    expect(stepText(/Work history/)).toContain("Unsaved changes");
  });
});
