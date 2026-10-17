// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFinderStartupDatabaseRecoveryFact } from "../../../../../shared/job-finder-startup-db-recovery";
import { StartupDatabaseRecoveryNotice } from "./startup-database-recovery-notice";

function configureBridge(overrides: {
  getStartupDatabaseRecovery?: () => Promise<unknown>;
  dismissStartupDatabaseRecoveryNotice?: () => Promise<unknown>;
}) {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      jobFinder: {
        ...(overrides.getStartupDatabaseRecovery
          ? {
              getStartupDatabaseRecovery: overrides.getStartupDatabaseRecovery,
            }
          : {}),
        ...(overrides.dismissStartupDatabaseRecoveryNotice
          ? {
              dismissStartupDatabaseRecoveryNotice:
                overrides.dismissStartupDatabaseRecoveryNotice,
            }
          : {}),
      },
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { nestor?: unknown }).nestor;
});

describe("StartupDatabaseRecoveryNotice", () => {
  it("stays hidden for idle and blocked facts", async () => {
    configureBridge({
      getStartupDatabaseRecovery: vi.fn(() =>
        Promise.resolve({
          status: "idle",
        } satisfies JobFinderStartupDatabaseRecoveryFact),
      ),
    });
    const { container } = render(<StartupDatabaseRecoveryNotice />);

    await waitFor(() => {
      expect(
        (container.querySelector("[data-startup-database-recovery-notice]") ??
          null) === null,
      ).toBe(true);
    });
    expect(container.textContent).not.toContain("recovered from");
  });

  it("shows the database-only recovery disclosure for an undismissed restore", async () => {
    configureBridge({
      getStartupDatabaseRecovery: vi.fn(() =>
        Promise.resolve({
          status: "restored",
          incidentId: "incident-7",
          restoredFrom: "backup",
          lossWindow: {
            detectedAtIso: "2026-08-20T10:00:00.000Z",
            quarantinedDatabaseModifiedAtIso: null,
            restoredSnapshotModifiedAtIso: "2026-08-19T10:00:00.000Z",
          },
          quarantinedArtifactBasenames: [],
          restoredAtIso: "2026-08-20T10:05:00.000Z",
          dismissedAtIso: null,
        } satisfies JobFinderStartupDatabaseRecoveryFact),
      ),
    });
    render(<StartupDatabaseRecoveryNotice />);

    await screen.findByRole("status");
    expect(
      screen.getByText(/recovered from an automatic snapshot/),
    ).toBeTruthy();
    expect(screen.getByText(/Only the saved workspace database/)).toBeTruthy();
    expect(screen.queryByText("incident-7")).toBeNull();
  });

  it("stays hidden when the restore was already dismissed", async () => {
    configureBridge({
      getStartupDatabaseRecovery: vi.fn(() =>
        Promise.resolve({
          status: "restored",
          incidentId: "incident-8",
          restoredFrom: "backup-prev",
          lossWindow: {
            detectedAtIso: "2026-08-20T10:00:00.000Z",
            quarantinedDatabaseModifiedAtIso: null,
            restoredSnapshotModifiedAtIso: null,
          },
          quarantinedArtifactBasenames: [],
          restoredAtIso: "2026-08-20T10:05:00.000Z",
          dismissedAtIso: "2026-08-20T11:00:00.000Z",
        } satisfies JobFinderStartupDatabaseRecoveryFact),
      ),
    });
    const { container } = render(<StartupDatabaseRecoveryNotice />);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      container.querySelector("[data-startup-database-recovery-notice]"),
    ).toBeNull();
  });

  it("dismisses through the desktop bridge and hides immediately", async () => {
    const dismissStartupDatabaseRecoveryNotice = vi.fn(() =>
      Promise.resolve({ status: "idle" }),
    );
    configureBridge({
      getStartupDatabaseRecovery: vi.fn(() =>
        Promise.resolve({
          status: "restored",
          incidentId: "incident-9",
          restoredFrom: "backup",
          lossWindow: {
            detectedAtIso: "2026-08-20T10:00:00.000Z",
            quarantinedDatabaseModifiedAtIso: null,
            restoredSnapshotModifiedAtIso: null,
          },
          quarantinedArtifactBasenames: [],
          restoredAtIso: "2026-08-20T10:05:00.000Z",
          dismissedAtIso: null,
        } satisfies JobFinderStartupDatabaseRecoveryFact),
      ),
      dismissStartupDatabaseRecoveryNotice,
    });
    render(<StartupDatabaseRecoveryNotice />);

    await screen.findByRole("status");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Dismiss workspace recovery message",
      }),
    );

    await waitFor(() => {
      expect(dismissStartupDatabaseRecoveryNotice).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays hidden when the bridge returns a malformed fact", async () => {
    configureBridge({
      getStartupDatabaseRecovery: vi.fn(() =>
        Promise.resolve({ status: "restored" }),
      ),
    });
    const { container } = render(<StartupDatabaseRecoveryNotice />);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      container.querySelector("[data-startup-database-recovery-notice]"),
    ).toBeNull();
  });

  it("stays hidden without a desktop bridge", async () => {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {},
    });
    const { container } = render(<StartupDatabaseRecoveryNotice />);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      container.querySelector("[data-startup-database-recovery-notice]"),
    ).toBeNull();
  });
  it("takes a bottom-right dock slot instead of pinning itself over the launcher", async () => {
    // It was `fixed bottom-4 right-4` — exactly where the Assistant/Copilot
    // launcher parks — and simply painted on top of it.
    configureBridge({
      getStartupDatabaseRecovery: vi.fn(() =>
        Promise.resolve({
          status: "restored",
          incidentId: "incident-9",
          restoredFrom: "backup",
          lossWindow: {
            detectedAtIso: "2026-08-20T10:00:00.000Z",
            quarantinedDatabaseModifiedAtIso: null,
            restoredSnapshotModifiedAtIso: "2026-08-19T10:00:00.000Z",
          },
          quarantinedArtifactBasenames: [],
          restoredAtIso: "2026-08-20T10:05:00.000Z",
          dismissedAtIso: null,
        } satisfies JobFinderStartupDatabaseRecoveryFact),
      ),
    });
    render(<StartupDatabaseRecoveryNotice />);

    const notice = await screen.findByRole("status");

    expect(notice.className).not.toContain("bottom-4");
    expect(notice.className).not.toContain("right-4");
    // The slot is applied as a resolved rect, not a static utility class.
    expect(notice.style.bottom).toMatch(/^\d+px$/);
    expect(notice.style.right).toMatch(/^\d+px$/);
  });

  it.each([["data-profile-section-tabs"], ["data-resume-draft-provenance"]])(
    "lifts clear of a %s row rather than covering it",
    async (attribute) => {
      // Regression: these two rows were emptied out of the dock's no-cover set
      // along with the retired launcher's own entries. They were never
      // launcher-specific — the recovery notice is still a dock occupant, and
      // below xl the section tabs are the only route between Profile sections.
      const NOTICE_HEIGHT = 140;
      const ROW_TOP = 600;

      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1280,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 800,
      });

      const row = document.createElement("div");
      row.setAttribute(attribute, "");
      document.body.appendChild(row);

      // jsdom lays nothing out, so both the notice and the row are fed the
      // geometry they would really paint with.
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function getBoundingClientRect(this: HTMLElement) {
        if (this.hasAttribute(attribute)) {
          return {
            bottom: ROW_TOP + 40,
            height: 40,
            left: 880,
            right: 1264,
            top: ROW_TOP,
            width: 384,
            x: 880,
            y: ROW_TOP,
            toJSON: () => ({}),
          } as DOMRect;
        }
        if (this.hasAttribute("data-startup-database-recovery-notice")) {
          return {
            bottom: 784,
            height: NOTICE_HEIGHT,
            left: 880,
            right: 1264,
            top: 784 - NOTICE_HEIGHT,
            width: 384,
            x: 880,
            y: 784 - NOTICE_HEIGHT,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          bottom: 0,
          height: 0,
          left: 0,
          right: 0,
          top: 0,
          width: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });

      configureBridge({
        getStartupDatabaseRecovery: vi.fn(() =>
          Promise.resolve({
            status: "restored",
            incidentId: "incident-11",
            restoredFrom: "backup",
            lossWindow: {
              detectedAtIso: "2026-08-20T10:00:00.000Z",
              quarantinedDatabaseModifiedAtIso: null,
              restoredSnapshotModifiedAtIso: "2026-08-19T10:00:00.000Z",
            },
            quarantinedArtifactBasenames: [],
            restoredAtIso: "2026-08-20T10:05:00.000Z",
            dismissedAtIso: null,
          } satisfies JobFinderStartupDatabaseRecoveryFact),
        ),
      });
      render(<StartupDatabaseRecoveryNotice />);

      const notice = await screen.findByRole("status");

      await waitFor(() => {
        const clearance = Number.parseFloat(notice.style.bottom);
        expect(Number.isNaN(clearance)).toBe(false);
        // The notice's own top edge clears the row's top edge.
        expect(800 - clearance - NOTICE_HEIGHT).toBeLessThanOrEqual(ROW_TOP);
        // And it is genuinely lifted, not merely resting at the shared inset.
        expect(clearance).toBeGreaterThan(16);
      });

      row.remove();
    },
  );
});
