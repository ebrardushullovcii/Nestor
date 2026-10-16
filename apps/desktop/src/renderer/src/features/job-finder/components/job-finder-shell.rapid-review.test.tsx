// @vitest-environment jsdom

import type { JobFinderRendererWorkspaceSnapshot } from "@nordri/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobFinderShell } from "./job-finder-shell";

const windowControlsState = {
  isClosable: true,
  isFullScreen: false,
  isMaximized: false,
  isMinimizable: true,
} as const;

function createWorkspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    applicationRecords: [],
    discoveryJobs: [],
    profileSetupState: {
      completedAt: null,
      currentStep: "import",
      lastResumedAt: null,
      reviewItems: [],
      status: "not_started",
    },
    reviewQueue: [],
    userActionRequests: [],
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("JobFinderShell rapid review route", () => {
  beforeEach(() => {
    Object.defineProperty(window, "nordri", {
      configurable: true,
      value: {
        window: {
          close: vi.fn().mockResolvedValue(undefined),
          getControlsState: vi.fn().mockResolvedValue(windowControlsState),
          minimize: vi.fn().mockResolvedValue(windowControlsState),
          onControlsStateChange: vi.fn(() => vi.fn()),
          toggleMaximize: vi.fn().mockResolvedValue(windowControlsState),
        },
      },
    });

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("labels the rapid review route without adding it to the top navigation", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/rapid-review"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Rapid review content</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    expect(document.title).toBe("Quick review | Job Finder | Nordri");
    expect(screen.getByRole("main", { name: "Quick review" })).toBeTruthy();

    const navigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
    const destinations = within(navigation)
      .getAllByRole("button")
      .map((button) => button.textContent?.replace(/\d+/g, "").trim());

    // The module switch is the brand subtitle now, not a destination in this
    // module's own section navigation, so only Job Finder's routes are here.
    expect(destinations).toEqual([
      "Home",
      "Profile",
      "Find jobs",
      "Shortlisted",
      "Applications",
      "More",
    ]);
  });
});
