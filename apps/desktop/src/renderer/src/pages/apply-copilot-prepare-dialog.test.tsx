// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyCopilotVisualCheckpointDialog } from "./job-finder-page";

afterEach(cleanup);

const request = {
  jobId: "job_1",
  subject: "Staff Engineer at Northwind",
  description:
    "Job Finder will open this application and fill it in. It never submits — reviewing and sending the application stays yours.",
  onResolve: () => undefined,
};

describe("ApplyCopilotVisualCheckpointDialog", () => {
  it("stays open and says why when the start is refused", async () => {
    const onClose = vi.fn();
    const onResolve = vi.fn(() =>
      Promise.resolve(
        "Safeguards are blocking this step. Too many searches failed in a row.",
      ),
    );

    render(
      <ApplyCopilotVisualCheckpointDialog
        onClose={onClose}
        onOpenSafeguards={vi.fn()}
        onResolve={onResolve}
        request={request}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Apply" }),
    );

    // Never a silent close: the reason lands in the dialog the person is
    // looking at, with the one action that can change it.
    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toMatch(/Safeguards are blocking this step/);
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Open Safeguards" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).toBeNull();
  });

  it("says so plainly when the start throws rather than claiming nothing", async () => {
    render(
      <ApplyCopilotVisualCheckpointDialog
        onClose={vi.fn()}
        onResolve={() => Promise.reject(new Error("boom"))}
        request={request}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Apply" }),
    );
    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toMatch(/could not start this preparation/i);
    expect(refusal.textContent).toMatch(/nothing was sent/i);
  });

  it("leaves the confirm path alone when the start begins", async () => {
    const onResolve = vi.fn(() => undefined);
    render(
      <ApplyCopilotVisualCheckpointDialog
        onClose={vi.fn()}
        onResolve={onResolve}
        request={request}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Apply" }),
    );
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith(false);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
