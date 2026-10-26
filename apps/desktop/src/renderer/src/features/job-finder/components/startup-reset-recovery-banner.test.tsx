// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFinderStartupResetRecoveryFact } from "../../../../../shared/job-finder-startup-reset-recovery";
import { StartupResetRecoveryBanner } from "./startup-reset-recovery-banner";

const getStartupResetRecovery =
  vi.fn<() => Promise<JobFinderStartupResetRecoveryFact>>();

function installDesktopBridge() {
  Object.assign(window, {
    nestor: {
      jobFinder: {
        getStartupResetRecovery,
      },
    },
  });
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.hash}`}</p>;
}

function renderBanner() {
  return render(
    <MemoryRouter initialEntries={["/job-finder/home"]}>
      <StartupResetRecoveryBanner />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
  vi.clearAllMocks();
});

describe("StartupResetRecoveryBanner", () => {
  it("stays hidden when startup recovery reports nothing", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({ status: "idle" });

    renderBanner();

    await waitFor(() => {
      expect(getStartupResetRecovery).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByText(
        "An interrupted workspace reset was completed during startup.",
      ),
    ).toBeNull();
  });

  it("discloses a completed interrupted reset without claiming the user cancelled it", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({
      status: "completed",
      token: "token-1234",
      completedAt: "2026-08-23T10:00:00.000Z",
    });

    renderBanner();

    await screen.findByText(
      "An interrupted workspace reset was completed during startup.",
    );
    expect(
      screen.getByRole("button", {
        name: "Dismiss workspace recovery message",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/cancel/i)).toBeNull();
  });

  it("dismisses the completed notice persistently for the same recovery fact", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({
      status: "completed",
      token: "token-1234",
      completedAt: "2026-08-23T10:00:00.000Z",
    });
    const view = renderBanner();

    await screen.findByText(
      "An interrupted workspace reset was completed during startup.",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Dismiss workspace recovery message",
      }),
    );
    expect(
      screen.queryByText(
        "An interrupted workspace reset was completed during startup.",
      ),
    ).toBeNull();

    view.unmount();
    renderBanner();
    expect(
      screen.queryByText(
        "An interrupted workspace reset was completed during startup.",
      ),
    ).toBeNull();
  });

  it("surfaces the degraded quarantine fact for support with truthful wording", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({
      status: "degraded",
      reason: "marker_quarantined_malformed",
      quarantinedFileName: "job-finder-reset-intent.invalid-2026.json",
    });

    renderBanner();

    await screen.findByText("A reset didn't finish");
    expect(
      screen.getByText(/unreadable workspace reset marker was quarantined/i),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /marker file was kept for support diagnostics as job-finder-reset-intent\.invalid-2026\.json/,
      ),
    ).toBeTruthy();
  });

  it("never claims the marker was moved aside when no quarantine filename is reported", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({
      status: "degraded",
      reason: "marker_quarantined_oversized",
      quarantinedFileName: null,
    });

    renderBanner();

    await screen.findByText("A reset didn't finish");
    const detail = screen.getByText((_, element) => {
      return (
        element?.tagName === "P" &&
        element.textContent?.includes(
          "recovery paused without changing any files",
        ) === true
      );
    });
    expect(detail).toBeTruthy();
    expect(screen.queryByText(/kept for support/i)).toBeNull();
    expect(screen.queryByText(/quarantined during startup/i)).toBeNull();
  });

  it("reports retained files and support guidance when quarantine pauses recovery with pending trash", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({
      status: "degraded",
      reason: "marker_quarantined_with_pending_trash",
      quarantinedFileName: "job-finder-reset-intent.invalid-2026.json",
    });

    renderBanner();

    await screen.findByText("Workspace startup recovery needs attention");
    expect(screen.getByText(/files are retained/i)).toBeTruthy();
    expect(
      screen.getByText(/nothing will be deleted automatically/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/contact support before removing anything/i),
    ).toBeTruthy();
    expect(screen.queryByText(/no workspace files were deleted/i)).toBeNull();
  });

  it("maps a failed startup recovery to honest paused-recovery wording", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({
      status: "degraded",
      reason: "reset_recovery_failed",
      quarantinedFileName: null,
    });

    renderBanner();

    await screen.findByText("Workspace startup recovery needs attention");
    expect(
      screen.getByText(/could not be finished during startup/i),
    ).toBeTruthy();
    expect(screen.getByText(/workspace files are retained/i)).toBeTruthy();
    expect(screen.queryByText(/undo/i)).toBeNull();
  });

  it("announces the recovery banner politely for assistive tech", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({
      status: "completed",
      token: "token-1234",
      completedAt: "2026-08-23T10:00:00.000Z",
    });

    renderBanner();

    const banner = await screen.findByRole("status");
    expect(banner.getAttribute("aria-live")).toBe("polite");
    expect(
      banner.getAttribute("data-startup-reset-recovery-banner"),
    ).not.toBeNull();
    expect(
      banner.textContent?.includes(
        "An interrupted workspace reset was completed during startup.",
      ),
    ).toBe(true);
  });

  it("says a reset didn't finish without deleting anything and offers to reset again", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({
      status: "degraded",
      reason: "marker_unreadable",
      quarantinedFileName: null,
    });

    renderBanner();

    await screen.findByText("A reset didn't finish");
    expect(screen.getByText(/so it deleted nothing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset again" }));
    expect(screen.getByTestId("where").textContent).toBe(
      "/job-finder/settings#settings-danger-zone",
    );
  });

  it("offers no reset again while set-aside files wait for support", async () => {
    installDesktopBridge();
    getStartupResetRecovery.mockResolvedValue({
      status: "degraded",
      reason: "marker_quarantined_with_pending_trash",
      quarantinedFileName: "job-finder-reset-intent.invalid-x.json",
    });

    renderBanner();

    await screen.findByText("Workspace startup recovery needs attention");
    expect(screen.queryByRole("button", { name: "Reset again" })).toBeNull();
  });
});
