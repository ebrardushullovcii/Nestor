// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SourceDebugRunDetails } from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileSourceDebugReviewModal } from "./profile-source-debug-review-modal";

// jsdom reports offsetParent === null everywhere, which would make the trap's
// legacy first-control mode fall back to the container too. Stubbing layout
// pins this test to real behaviour: without initialFocus="dialog" the
// "Check again" button would receive the initial focus.
function stubElementLayout() {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return document.body;
    },
  });
}

function restoreElementLayout() {
  delete (HTMLElement.prototype as unknown as { offsetParent?: unknown })
    .offsetParent;
}

afterEach(() => {
  cleanup();
  restoreElementLayout();
});

describe("ProfileSourceDebugReviewModal", () => {
  it("shows a plain page-open failure and keeps navigation text behind Technical details", () => {
    const run = {
      id: "debug_1",
      targetId: "source_1",
      targetLabel: "Example careers",
      state: "failed",
      startedAt: "2026-09-12T10:00:00.000Z",
      updatedAt: "2026-09-12T10:00:08.000Z",
      completedAt: "2026-09-12T10:00:08.000Z",
      finalSummary:
        "Job Finder could not open Example careers (the page did not load in time).",
    };
    const details = {
      run,
      attempts: [],
      instructionArtifact: null,
      evidenceRefs: [
        {
          id: "evidence_1",
          runId: run.id,
          attemptId: "attempt_1",
          targetId: run.targetId,
          phase: "access_auth_probe",
          kind: "note",
          label: "Technical details",
          capturedAt: run.completedAt,
          url: "https://jobs.example.test",
          storagePath: null,
          excerpt: "page.goto: Timeout 8000ms exceeded",
        },
      ],
    } as unknown as SourceDebugRunDetails;

    render(
      <ProfileSourceDebugReviewModal
        details={details}
        errorMessage={null}
        isSourceDebugPending={false}
        isVerifyPending={() => false}
        loading={false}
        onClose={vi.fn()}
        onLoadRun={vi.fn()}
        onRerun={vi.fn()}
        onVerify={vi.fn()}
        open
        recentRuns={[details.run]}
        selectedRunId={run.id}
        targetLabel="Example careers"
      />,
    );

    expect(
      screen.getAllByText(
        "Job Finder could not open Example careers (the page did not load in time).",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(screen.getByText("page.goto: Timeout 8000ms exceeded")).toBeTruthy();
  });

  it("associates the visible review description with the dialog", () => {
    render(
      <ProfileSourceDebugReviewModal
        details={null}
        errorMessage={null}
        isSourceDebugPending={false}
        isVerifyPending={() => false}
        loading={false}
        onClose={vi.fn()}
        onLoadRun={vi.fn()}
        onRerun={vi.fn()}
        onVerify={vi.fn()}
        open
        recentRuns={[]}
        selectedRunId={null}
        targetLabel="Greenhouse roles"
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Greenhouse roles" });
    const descriptionId = dialog.getAttribute("aria-describedby");

    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      "Review what the latest source check found",
    );
  });

  it("opens with focus on the dialog so heading and description are announced first", () => {
    stubElementLayout();
    const onClose = vi.fn();

    const opener = document.createElement("button");
    opener.textContent = "Open source debug";
    document.body.append(opener);
    opener.focus();

    const view = render(
      <ProfileSourceDebugReviewModal
        details={null}
        errorMessage={null}
        isSourceDebugPending={false}
        isVerifyPending={() => false}
        loading={false}
        onClose={onClose}
        onLoadRun={vi.fn()}
        onRerun={vi.fn()}
        onVerify={vi.fn()}
        open
        recentRuns={[]}
        selectedRunId={null}
        targetLabel="Greenhouse roles"
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Greenhouse roles" });
    // The rerun action must not steal the initial announcement.
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Check again" }),
    );

    // Escape still closes the dialog through the same trap.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    view.unmount();
    // Focus returns to the trigger after close.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
