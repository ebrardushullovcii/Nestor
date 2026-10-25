// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetJobFinderOverlaysForTests } from "../features/job-finder/lib/job-finder-overlay-ownership";
import { ApplyCopilotVisualCheckpointDialog } from "./job-finder-page";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  resetJobFinderOverlaysForTests();
});

function renderConsentDialog() {
  const onClose = vi.fn();
  const onResolve = vi.fn();
  // Controller-held callbacks: only the page-level onClose/onResolve bridge
  // may ever reach them, so these double as contract-boundary tripwires.
  const requestOnCancel = vi.fn();
  const requestOnResolve = vi.fn();

  const appRoot = document.createElement("div");
  appRoot.id = "root";
  const trigger = document.createElement("button");
  trigger.textContent = "Apply";
  appRoot.append(trigger);
  document.body.append(appRoot);
  trigger.focus();

  const rendered = render(
    <ApplyCopilotVisualCheckpointDialog
      onClose={onClose}
      onResolve={onResolve}
      request={{
        jobId: "job_consent_dialog",
        subject: "Senior Frontend Engineer at Umbrel",
        description:
          "Job Finder will open Senior Frontend Engineer at Umbrel in the Job Finder browser and fill in the application with your approved resume. It stops before the employer's submit control — reviewing and sending the application stays yours.",
        onCancel: requestOnCancel,
        onResolve: requestOnResolve,
      }}
    />,
  );

  return {
    onClose,
    onResolve,
    rendered,
    requestOnCancel,
    requestOnResolve,
    trigger,
  };
}

describe("ApplyCopilotVisualCheckpointDialog consent hierarchy", () => {
  it("names the application it is gating and offers a real Cancel", () => {
    renderConsentDialog();

    // The dialog used to be titled "Use visual checkpoints?" — a sub-option —
    // and both of its visible buttons proceeded, so the only exit was an
    // unlabelled header X.
    const dialog = screen.getByRole("dialog", {
      name: "Senior Frontend Engineer at Umbrel",
    });
    expect(
      dialog.querySelector("[data-apply-checkpoint-dialog-job]")?.textContent,
    ).toBe("Senior Frontend Engineer at Umbrel");
    expect(dialog.textContent).toContain(
      "Job Finder will open Senior Frontend Engineer at Umbrel in the Job Finder browser",
    );
    // The never-submits boundary is always on screen, whether it arrives in
    // the caller's description or from the dialog's own backstop.
    expect(dialog.textContent).toMatch(/submit|sending the application/i);
    expect(dialog.textContent).toContain(
      "Screenshots of the application page help Job Finder notice a stuck or misfilled form",
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Apply" });
    expect(cancel.getAttribute("data-variant")).toBe("secondary");
    expect(confirm.getAttribute("data-variant")).toBe("primary");

    // Checkpoints are an option on the commitment, not a second way to
    // confirm it, and they start off.
    const checkpoints = screen.getByRole("checkbox", {
      name: /Take temporary screenshots while it works/,
    });
    expect((checkpoints as HTMLInputElement).checked).toBe(false);
  });

  it("resolves with checkpoints off unless the box is ticked", () => {
    const { onClose, onResolve } = renderConsentDialog();

    const confirm = screen.getByRole("button", { name: "Apply" });
    // Initial focus sits on the confirm action, which resolves with sharing
    // off, so a stray Enter can never enable screenshots.
    expect(document.activeElement).toBe(confirm);

    fireEvent.click(confirm);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cancels without resolving through the explicit Cancel action", () => {
    const { onClose, onResolve, requestOnCancel, requestOnResolve } =
      renderConsentDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
    expect(requestOnCancel).not.toHaveBeenCalled();
    expect(requestOnResolve).not.toHaveBeenCalled();
  });

  it("cancels on Escape without resolving and restores focus when closed", () => {
    const {
      onClose,
      onResolve,
      rendered,
      requestOnCancel,
      requestOnResolve,
      trigger,
    } = renderConsentDialog();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
    // Dismissal routes exclusively through the page-level onClose contract.
    expect(requestOnCancel).not.toHaveBeenCalled();
    expect(requestOnResolve).not.toHaveBeenCalled();

    rendered.rerender(
      <ApplyCopilotVisualCheckpointDialog
        onClose={onClose}
        onResolve={onResolve}
        request={null}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("cancels on the header close button and scrim without resolving", () => {
    const { onClose, onResolve, rendered, requestOnCancel } =
      renderConsentDialog();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
    expect(requestOnCancel).not.toHaveBeenCalled();

    rendered.rerender(
      <ApplyCopilotVisualCheckpointDialog
        onClose={onClose}
        onResolve={onResolve}
        request={null}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    rendered.rerender(
      <ApplyCopilotVisualCheckpointDialog
        onClose={onClose}
        onResolve={onResolve}
        request={{
          jobId: "job_consent_dialog",
          subject: "Senior Frontend Engineer at Umbrel",
          description:
            "Job Finder will open Senior Frontend Engineer at Umbrel in the Job Finder browser and fill in the application with your approved resume. It stops before the employer's submit control — reviewing and sending the application stays yours.",
          onCancel: requestOnCancel,
          onResolve: vi.fn(),
        }}
      />,
    );
    expect(
      screen.getByRole("dialog", {
        name: "Senior Frontend Engineer at Umbrel",
      }),
    ).toBeTruthy();

    const scrim = screen.getByRole("dialog").parentElement;
    if (!scrim) throw new Error("scrim container missing");
    fireEvent.click(scrim);

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("resolves true only after the screenshots box is explicitly ticked", () => {
    const { onClose, onResolve } = renderConsentDialog();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Take temporary screenshots while it works/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Apply" }),
    );

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
