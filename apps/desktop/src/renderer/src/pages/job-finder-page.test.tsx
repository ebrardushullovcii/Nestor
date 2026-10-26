// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPlatformPing } from "@nestor/contracts";
import type { JobFinderStartupDatabaseRecoveryFact } from "../../../shared/job-finder-startup-db-recovery";
import { JobFinderPage } from "./job-finder-page";

function configureWindowNestor(input: {
  getWorkspaceBootstrapError: Error;
  recoveryFact: JobFinderStartupDatabaseRecoveryFact;
}) {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      ping: vi.fn<() => Promise<DesktopPlatformPing>>(() =>
        Promise.resolve({ ok: true, platform: "win32" as const }),
      ),
      jobs: {
        run: vi.fn(() => new Promise(() => undefined)),
        onChange: () => () => undefined,
      },
      home: { summary: () => new Promise(() => undefined) },
      needsYou: { run: () => new Promise(() => undefined) },
      window: {
        getControlsState: () => new Promise(() => undefined),
        onControlsStateChange: () => () => undefined,
      },
      jobFinder: {
        getWorkspaceBootstrap: vi.fn(() =>
          Promise.reject(input.getWorkspaceBootstrapError),
        ),
        getWorkspace: vi.fn(() =>
          Promise.reject(input.getWorkspaceBootstrapError),
        ),
        getStartupDatabaseRecovery: vi.fn(() =>
          Promise.resolve(input.recoveryFact),
        ),
      },
    },
  });
}

// Profile still reads the old workspace, so a failed load shows there.
function renderJobFinderPage(path = "/job-finder/profile") {
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  // The page controller mounts a React Router blocker, so the harness must use
  // a data router (declarative routers cannot host blockers).
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: <JobFinderPage />,
      },
    ],
    { initialEntries: [path] },
  );

  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { nestor?: unknown }).nestor;
});

// First: the other tests open Profile, which asks for the old workspace for
// the rest of the window's life.
describe("JobFinderPage launch", () => {
  it.each(["/job-finder/home", "/job-finder/settings"])(
    "opens %s without loading the old workspace",
    async (path) => {
      configureWindowNestor({
        getWorkspaceBootstrapError: new Error("not expected"),
        recoveryFact: { status: "idle" },
      });

      renderJobFinderPage(path);

      expect(
        await screen.findByRole("navigation", { name: "Job Finder sections" }),
      ).toBeTruthy();
      const bridge = (
        window as unknown as {
          nestor: { jobFinder: Record<string, ReturnType<typeof vi.fn>> };
        }
      ).nestor.jobFinder;
      expect(bridge.getWorkspaceBootstrap).not.toHaveBeenCalled();
      expect(bridge.getWorkspace).not.toHaveBeenCalled();
    },
  );
});

describe("JobFinderPage startup database recovery blocking", () => {
  it("blocks on the typed incident without offering a file-mutating retry", async () => {
    configureWindowNestor({
      getWorkspaceBootstrapError: new Error(
        "Workspace database recovery required (salvage-required). Automatic recovery could not restore the previous workspace safely.",
      ),
      recoveryFact: {
        status: "blocked",
        incidentId: "incident-block-42",
        outcome: "salvage-required",
        candidates: [],
        quarantineBasenames: ["job-finder-workspace.sqlite.quarantine-a"],
      },
    });

    renderJobFinderPage();

    // The old controller loads lazily; on a busy machine that passes 1 s.
    const alert = await screen.findByRole("alert", {}, { timeout: 5_000 });
    expect(alert.textContent).toContain("Couldn't open Job Finder");
    expect(alert.textContent).toContain("Incident ID: incident-block-42");
    expect(alert.textContent).toContain("retained");
    expect(alert.textContent).toContain("contact support");
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("keeps the generic retryable error for failures without a typed incident", async () => {
    configureWindowNestor({
      getWorkspaceBootstrapError: new Error("Unable to load the workspace."),
      recoveryFact: { status: "idle" },
    });

    renderJobFinderPage();

    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: "Retry opening Job Finder" }),
        ).toBeTruthy();
      },
      { timeout: 5_000 },
    );
    expect(screen.queryByText(/Incident ID:/)).toBeNull();
  });
});
