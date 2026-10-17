// @vitest-environment jsdom

import type { JobFinderRendererWorkspaceSnapshot } from "@nordri/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireJobFinderOverlay,
  hasOpenJobFinderOverlays,
} from "../lib/job-finder-overlay-ownership";
import { JobFinderShell } from "./job-finder-shell";

const windowControlsState = {
  isClosable: true,
  isFullScreen: false,
  isMaximized: false,
  isMinimizable: true,
} as const;

function createWorkspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    activeCampaignId: "campaign-active",
    applicationRecords: [],
    campaigns: [
      {
        description: "Active plan",
        id: "campaign-active",
        jobIds: ["job_1", "job_2"],
        mode: "precision",
        name: "Active plan",
        status: "active",
      },
    ],
    discoveryJobs: [
      {
        id: "job_1",
        company: "Acme",
        title: "Platform Engineer",
        matchAssessment: { score: 70, reasons: [], gaps: [] },
      },
      {
        id: "job_2",
        company: "Globex",
        title: "Field Engineer",
        matchAssessment: { score: 60, reasons: [], gaps: [] },
      },
    ],
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

function taskCenterSummary(): HTMLElement {
  const summary = document.querySelector<HTMLElement>(
    "summary[aria-label^='Activity']",
  );
  if (!summary)
    throw new Error("Expected the Activity trigger to be rendered.");
  return summary;
}

async function openTaskCenter() {
  const before = isTaskCenterOpen();
  // The trigger is a <summary>; the open panel carries the same name, so the
  // element is selected rather than the accessible name alone.
  fireEvent.click(taskCenterSummary());
  await waitFor(() => expect(isTaskCenterOpen()).toBe(!before));
}

function getTaskCenterDetails(): HTMLDetailsElement {
  const details = document.querySelector("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Tasks details element is missing");
  }
  return details;
}

function isTaskCenterOpen(): boolean {
  return getTaskCenterDetails().open;
}

async function openSearchDialog() {
  fireEvent.keyDown(document.body, { ctrlKey: true, key: "k" });
  await screen.findByRole("dialog", {
    name: "Search your workspace",
  });
}

/** Only the compact top navigation's More trigger; the sidebar has its own. */
function getCompactMoreButton(): HTMLElement {
  const compactNavigation = document.querySelector(
    "[data-job-finder-compact-navigation]",
  );
  if (!compactNavigation) {
    throw new Error("Expected the compact navigation.");
  }
  return within(compactNavigation as HTMLElement).getByRole("button", {
    name: /^More/u,
  });
}

describe("JobFinderShell stacked overlay ownership", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderShell(options: { wide?: boolean } = {}) {
    vi.mocked(window.matchMedia).mockImplementation(
      (query) =>
        ({
          matches: Boolean(options.wide) && query === "(min-width: 1440px)",
        }) as MediaQueryList,
    );
    return render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );
  }

  const searchDialogQuery = () =>
    screen.queryByRole("dialog", {
      name: "Search your workspace",
    });

  it("closes a Planning popover opened above the Task Center one layer per Escape", async () => {
    renderShell();

    await openTaskCenter();
    expect(isTaskCenterOpen()).toBe(true);

    const moreButton = getCompactMoreButton();
    fireEvent.click(moreButton);
    expect(screen.getByRole("navigation", { name: "More" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
    // The lower layer survives the first Escape.
    expect(isTaskCenterOpen()).toBe(true);
    expect(document.activeElement).toBe(moreButton);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(isTaskCenterOpen()).toBe(false);
    expect(document.activeElement).toBe(taskCenterSummary());
  });

  it("closes the Task Center opened above the Planning menu one layer per Escape", async () => {
    renderShell();

    const moreButton = getCompactMoreButton();
    fireEvent.click(moreButton);
    expect(screen.getByRole("navigation", { name: "More" }));

    await openTaskCenter();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(isTaskCenterOpen()).toBe(false);
    // The menu opened first stays open until its own Escape.
    expect(screen.getByRole("navigation", { name: "More" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
    expect(document.activeElement).toBe(moreButton);
  });

  it("summons search above an open Task Center and unwinds the stack with Escape", async () => {
    renderShell();

    await openTaskCenter();
    await openSearchDialog();

    fireEvent.keyDown(
      screen.getByRole("combobox", {
        name: "Search your workspace",
      }),
      { key: "Escape" },
    );
    await waitFor(() => expect(searchDialogQuery()).toBeNull());
    // The Task Center outlives the search overlay.
    expect(isTaskCenterOpen()).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(isTaskCenterOpen()).toBe(false);
    expect(document.activeElement).toBe(taskCenterSummary());
  });

  it("gives the newest layer the first Escape when Task Center stacks above search", async () => {
    renderShell();

    const searchOpener = screen.getByRole("button", {
      name: "Search your workspace",
    });
    searchOpener.focus();
    fireEvent.click(searchOpener);
    await screen.findByRole("dialog", {
      name: "Search your workspace",
    });

    await openTaskCenter();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(isTaskCenterOpen()).toBe(false);
    expect(searchDialogQuery()).not.toBeNull();

    fireEvent.keyDown(
      screen.getByRole("combobox", {
        name: "Search your workspace",
      }),
      { key: "Escape" },
    );
    await waitFor(() => expect(searchDialogQuery()).toBeNull());
    expect(document.activeElement).toBe(searchOpener);
  });

  it("keeps the slash alias blocked while only the Task Center is open", async () => {
    renderShell();

    await openTaskCenter();
    fireEvent.keyDown(document.body, { key: "/" });

    expect(searchDialogQuery()).toBeNull();
  });

  it("keeps Cmd+B blocked while only the Task Center is open at the wide layout", async () => {
    renderShell({ wide: true });
    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );

    await openTaskCenter();
    fireEvent.keyDown(document, { ctrlKey: true, key: "b" });

    expect(shell?.dataset.sidebarCollapsed).toBe("false");
  });

  it("still summons search with Cmd+K while the Planning menu owns the surface", async () => {
    renderShell();

    fireEvent.click(getCompactMoreButton());
    expect(screen.getByRole("navigation", { name: "More" }));

    await openSearchDialog();

    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
    expect(searchDialogQuery()).not.toBeNull();
  });

  it("dismisses the search result popup before closing the dialog on repeated Escape", async () => {
    renderShell();

    await openSearchDialog();
    const input = screen.getByRole("combobox", {
      name: "Search your workspace",
    });
    fireEvent.change(input, { target: { value: "platform engineer" } });
    await screen.findByText(/1 result/);

    fireEvent.keyDown(input, { key: "Escape" });
    // Popup dismissed, dialog still open.
    expect(screen.queryByText(/1 result/)).toBeNull();
    expect(searchDialogQuery()).not.toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(searchDialogQuery()).toBeNull());
  });

  it("blocks slash and Cmd+B for any registry-registered surface while keeping the Cmd+K summon", async () => {
    renderShell();
    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );

    // Simulates any adopted screen modal/dialog (trap hook, Interview
    // delete dialog, activity dialog, copilot panels, rule builder) holding
    // the stack without mounting its screen.
    let screenModalLayer:
      | ReturnType<typeof acquireJobFinderOverlay>
      | undefined;
    act(() => {
      screenModalLayer = acquireJobFinderOverlay(vi.fn());
    });
    if (!screenModalLayer) {
      throw new Error("Screen modal layer was not acquired");
    }

    fireEvent.keyDown(document.body, { key: "/" });
    expect(searchDialogQuery()).toBeNull();

    fireEvent.keyDown(document, { ctrlKey: true, key: "b" });
    expect(shell?.dataset.sidebarCollapsed).toBe("false");

    // The summon policy is untouched: Cmd+K still opens search, and it
    // becomes topmost over the pre-existing layer.
    await openSearchDialog();

    fireEvent.keyDown(
      screen.getByRole("combobox", {
        name: "Search your workspace",
      }),
      { key: "Escape" },
    );
    await waitFor(() => expect(searchDialogQuery()).toBeNull());

    // The foreign layer outlived the search overlay because it never saw a
    // topmost Escape; its owner closes it through release().
    expect(screenModalLayer.isTopmost()).toBe(true);
    screenModalLayer.release();
    expect(hasOpenJobFinderOverlays()).toBe(false);
  });
});
