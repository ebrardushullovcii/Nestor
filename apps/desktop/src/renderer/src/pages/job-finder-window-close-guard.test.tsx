// @vitest-environment jsdom

import { StrictMode, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import {
  JobFinderWindowCloseGuard,
  applyJobFinderWindowCloseGuard,
  getJobFinderWindowCloseConfirmation,
  setPendingCloseSave,
} from "./job-finder-window-close-guard";
import { JobFinderUnsavedChangesDialog } from "./job-finder-unsaved-changes-dialog";
import { JobFinderPage } from "./job-finder-page";
import { useJobFinderPageController } from "./use-job-finder-page-controller";
import { resetJobFinderOverlaysForTests } from "../features/job-finder/lib/job-finder-overlay-ownership";

type CloseResolution = {
  requestId: string;
  decision: "proceed" | "cancel";
};

interface CloseBridgeMock {
  resolutions: CloseResolution[];
  guardStates: Array<{ blocked: boolean }>;
  emitCloseRequest(requestId: string): void;
  subscriberCount(): number;
}

function installCloseBridgeMock(): CloseBridgeMock {
  const listeners = new Set<(request: { requestId: string }) => void>();
  const resolutions: CloseResolution[] = [];
  const guardStates: Array<{ blocked: boolean }> = [];

  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      ping: vi.fn(() => Promise.reject(new Error("unused in these tests"))),
      jobs: {
        run: vi.fn(() => new Promise(() => undefined)),
        onChange: () => () => undefined,
      },
      home: { summary: () => new Promise(() => undefined) },
      jobFinder: {},
      window: {
        setCloseGuardState: (input: { blocked: boolean }) => {
          guardStates.push(input);
          return Promise.resolve({ ok: true as const });
        },
        resolveCloseRequest: (input: CloseResolution) => {
          resolutions.push(input);
          return Promise.resolve({ ok: true as const });
        },
        onCloseRequest: (
          listener: (request: { requestId: string }) => void,
        ) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  });

  return {
    resolutions,
    guardStates,
    emitCloseRequest(requestId: string) {
      // Main keeps one close request outstanding over this channel.
      for (const listener of [...listeners]) {
        listener({ requestId });
      }
    },
    subscriberCount: () => listeners.size,
  };
}

// The data router constructs a real fetch Request for navigation; jsdom's
// AbortSignal fails Node's brand check inside Request, so hand React Router
// the tiny stubbed surface it reads (same approach as the navigation-guard
// suite).
class NavigationRequestStub {
  method: string;
  signal: unknown;
  url: string;

  constructor(
    input: string | URL,
    init?: { method?: string; signal?: unknown },
  ) {
    this.url = String(input);
    this.method = (init?.method ?? "GET").toUpperCase();
    this.signal = init?.signal ?? null;
  }
}

beforeAll(() => {
  vi.stubGlobal("Request", NavigationRequestStub);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // The module-level mirror persists across tests; drop it without a bridge
  // present so every test starts from an unprotected session.
  Reflect.deleteProperty(window, "nestor");
  applyJobFinderWindowCloseGuard(null);
  resetJobFinderOverlaysForTests();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "nestor");
  resetJobFinderOverlaysForTests();
});

describe("JobFinderWindowCloseGuard subscription lifecycle", () => {
  it("subscribes once on mount and unsubscribes on unmount", () => {
    const bridge = installCloseBridgeMock();

    const view = render(<JobFinderWindowCloseGuard />);
    expect(bridge.subscriberCount()).toBe(1);

    view.unmount();
    expect(bridge.subscriberCount()).toBe(0);
  });

  it("keeps exactly one answering subscription under StrictMode", () => {
    const bridge = installCloseBridgeMock();

    render(
      <StrictMode>
        <JobFinderWindowCloseGuard />
      </StrictMode>,
    );

    act(() => {
      bridge.emitCloseRequest("req_strict");
    });

    // Two live listeners would each answer the same request.
    expect(bridge.resolutions).toEqual([
      { requestId: "req_strict", decision: "proceed" },
    ]);
  });
});

describe("JobFinderWindowCloseGuard decisions", () => {
  it("saves an edit typed a moment ago, then closes without asking", async () => {
    const bridge = installCloseBridgeMock();
    const key = Symbol("pending");
    let finishSave: (saved: boolean) => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );
    setPendingCloseSave(key, save);
    expect(bridge.guardStates.at(-1)).toEqual({ blocked: true });

    render(<JobFinderWindowCloseGuard />);
    act(() => {
      bridge.emitCloseRequest("req_pending");
    });

    expect(save).toHaveBeenCalledTimes(1);
    // The close waits for the save; protection is not dropped meanwhile.
    act(() => setPendingCloseSave(key, null));
    expect(bridge.resolutions).toEqual([]);
    expect(bridge.guardStates.at(-1)).toEqual({ blocked: true });

    await act(async () => {
      finishSave(true);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(bridge.resolutions).toEqual([
        { requestId: "req_pending", decision: "proceed" },
      ]);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks only when the pending edit could not be saved", async () => {
    const bridge = installCloseBridgeMock();
    const key = Symbol("pending");
    setPendingCloseSave(key, () => Promise.resolve(false));

    render(<JobFinderWindowCloseGuard />);
    act(() => {
      bridge.emitCloseRequest("req_failed_save");
    });

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(
      screen.getByText("Your latest resume edits could not be saved"),
    ).toBeTruthy();
    expect(bridge.resolutions).toEqual([]);
    setPendingCloseSave(key, null);
  });

  it("auto-proceeds a clean close without showing any dialog", async () => {
    const bridge = installCloseBridgeMock();
    expect(getJobFinderWindowCloseConfirmation()).toBeNull();

    render(<JobFinderWindowCloseGuard />);

    act(() => {
      bridge.emitCloseRequest("req_clean");
    });

    await waitFor(() => {
      expect(bridge.resolutions).toEqual([
        { requestId: "req_clean", decision: "proceed" },
      ]);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("parks a dirty close behind the branded dialog and cancels exactly once", async () => {
    const bridge = installCloseBridgeMock();
    applyJobFinderWindowCloseGuard({
      title: "Leave this page?",
      description: "Your unsaved changes will be lost.",
      reasons: ["Unsaved resume edits"],
    });

    render(<JobFinderWindowCloseGuard />);
    act(() => {
      bridge.emitCloseRequest("req_dirty");
    });

    const dialog = await screen.findByRole("dialog", {
      name: /close nestor\?/i,
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Unsaved resume edits").textContent).toBe(
      "Unsaved resume edits",
    );
    expect(bridge.resolutions).toEqual([]);

    // A double click on the same control must not resolve the request twice.
    const stayButton = screen.getByRole("button", {
      name: "Stay on this page",
    });
    fireEvent.click(stayButton);
    fireEvent.click(stayButton);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(bridge.resolutions).toEqual([
      { requestId: "req_dirty", decision: "cancel" },
    ]);
  });

  it("proceeds exactly once when the user discards drafts", async () => {
    const bridge = installCloseBridgeMock();
    applyJobFinderWindowCloseGuard({
      title: "Leave this page?",
      description: "Your unsaved changes will be lost.",
      reasons: ["Unsaved resume edits"],
    });

    render(<JobFinderWindowCloseGuard />);
    act(() => {
      bridge.emitCloseRequest("req_leave");
    });
    await screen.findByRole("dialog", { name: /close nestor\?/i });

    const leaveButton = screen.getByRole("button", {
      name: "Leave without saving",
    });
    fireEvent.click(leaveButton);
    fireEvent.click(leaveButton);

    await waitFor(() => {
      expect(bridge.resolutions).toEqual([
        { requestId: "req_leave", decision: "proceed" },
      ]);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores a duplicate request while one decision is held", async () => {
    const bridge = installCloseBridgeMock();
    applyJobFinderWindowCloseGuard({
      title: "Leave this page?",
      description: "Your unsaved changes will be lost.",
      reasons: ["Unsaved resume edits"],
    });

    render(<JobFinderWindowCloseGuard />);
    act(() => {
      bridge.emitCloseRequest("req_first");
    });
    await screen.findByRole("dialog", { name: /close nestor\?/i });

    act(() => {
      bridge.emitCloseRequest("req_second");
    });

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));

    await waitFor(() => {
      expect(bridge.resolutions).toEqual([
        { requestId: "req_first", decision: "cancel" },
      ]);
    });
  });

  it("releases a held request as cancelled when the responder unmounts", async () => {
    const bridge = installCloseBridgeMock();
    applyJobFinderWindowCloseGuard({
      title: "Leave this page?",
      description: "Your unsaved changes will be lost.",
      reasons: ["Unsaved resume edits"],
    });

    const view = render(<JobFinderWindowCloseGuard />);
    act(() => {
      bridge.emitCloseRequest("req_unmount");
    });
    await screen.findByRole("dialog", { name: /close nestor\?/i });

    view.unmount();

    expect(bridge.resolutions).toEqual([
      { requestId: "req_unmount", decision: "cancel" },
    ]);
  });
});

describe("JobFinderWindowCloseGuard under an active overlay", () => {
  let lowerResolveCount = 0;

  // Simulates the parked resume-studio action dialog: a real branded dialog
  // that owns one LIFO overlay entry until it is resolved. The dialog sits in
  // a stable slot (present/null) so closing it never remounts the responder
  // beside it — exactly how the real page keeps the guard mounted.
  function OverlayScenarioHarness() {
    const [lowerOpen, setLowerOpen] = useState(true);

    return (
      <>
        {lowerOpen ? (
          <JobFinderUnsavedChangesDialog
            confirmation={{
              title: "Leave this page?",
              description: "Your unsaved changes will be lost.",
              reasons: ["Unsaved profile or setup changes"],
            }}
            onLeaveWithoutSaving={() => {
              lowerResolveCount += 1;
              setLowerOpen(false);
            }}
            onStay={() => {
              lowerResolveCount += 1;
              setLowerOpen(false);
            }}
          />
        ) : null}
        <JobFinderWindowCloseGuard />
      </>
    );
  }

  beforeEach(() => {
    lowerResolveCount = 0;
  });

  it("defers a blocked close while another dialog owns the stack, then promotes it", async () => {
    const bridge = installCloseBridgeMock();
    applyJobFinderWindowCloseGuard({
      title: "Leave this page?",
      description: "Your unsaved changes will be lost.",
      reasons: ["Unsaved resume edits"],
    });

    render(<OverlayScenarioHarness />);
    await screen.findByRole("dialog", { name: /leave this page\?/i });

    // The parked resume-studio action dialog owns the LIFO stack: the close
    // request waits instead of stacking a second question over it.
    act(() => {
      bridge.emitCloseRequest("req_deferred");
    });

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(bridge.resolutions).toEqual([]);

    // Escape belongs to the topmost (pre-existing) dialog only.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(lowerResolveCount).toBe(1);
    });
    expect(bridge.resolutions).toEqual([]);

    // With the stack settled and the draft still unsaved, the held request
    // is promoted into the single visible dialog.
    const closeDialog = await screen.findByRole("dialog", {
      name: /close nestor\?/i,
    });
    expect(closeDialog.getAttribute("aria-modal")).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "Leave without saving" }),
    );
    await waitFor(() => {
      expect(bridge.resolutions).toEqual([
        { requestId: "req_deferred", decision: "proceed" },
      ]);
    });
  });

  it("answers a deferred close when the work was saved while waiting", async () => {
    const bridge = installCloseBridgeMock();
    applyJobFinderWindowCloseGuard({
      title: "Leave this page?",
      description: "Your unsaved changes will be lost.",
      reasons: ["Unsaved resume edits"],
    });

    render(<OverlayScenarioHarness />);
    await screen.findByRole("dialog", { name: /leave this page\?/i });

    act(() => {
      bridge.emitCloseRequest("req_saved");
    });
    expect(bridge.resolutions).toEqual([]);

    // A racing save completes while the request waits behind the overlay.
    act(() => {
      applyJobFinderWindowCloseGuard(null);
    });

    // Settling the stack must proceed instead of asking a pointless question.
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(bridge.resolutions).toEqual([
        { requestId: "req_saved", decision: "proceed" },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});

describe("JobFinderPage answers close requests in every render state", () => {
  function renderJobFinderPage() {
    const router = createMemoryRouter(
      [{ path: "/job-finder", element: <JobFinderPage /> }],
      { initialEntries: ["/job-finder"] },
    );
    render(<RouterProvider router={router} />);
  }

  it("answers close requests while the opening shell is still loading", async () => {
    const bridge = installCloseBridgeMock();
    const nestor = window.nestor as unknown as {
      ping: () => Promise<never>;
    };
    nestor.ping = () => new Promise(() => undefined);

    renderJobFinderPage();

    act(() => {
      bridge.emitCloseRequest("req_loading");
    });

    await waitFor(() => {
      expect(bridge.resolutions).toEqual([
        { requestId: "req_loading", decision: "proceed" },
      ]);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses the production brand lockup and macOS-safe header geometry while opening", () => {
    installCloseBridgeMock();
    const nestor = window.nestor as unknown as {
      ping: () => Promise<never>;
    };
    nestor.ping = () => new Promise(() => undefined);

    renderJobFinderPage();

    const openingShell = document.querySelector<HTMLElement>(
      "[data-job-finder-opening-shell]",
    );
    const header = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-header]",
    );
    const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");
    const wordmark = document.querySelector<HTMLElement>(
      "[data-desktop-brand-wordmark]",
    );
    const moduleNavigation = document.querySelector<HTMLElement>(
      "[data-desktop-module-navigation]",
    );

    expect(openingShell).not.toBeNull();
    expect(header?.className).toContain("h-14");
    expect(brand?.style.paddingInlineStart).toBe("");
    expect(
      wordmark?.contains(screen.getByRole("img", { name: "Nestor" })),
    ).toBe(true);
    expect(
      screen.getByRole("img", { name: "Nestor" }).getAttribute("class"),
    ).toContain("sm:h-[1.3rem]");
    // The opening skeleton mirrors the loaded shell header: the caption row
    // carries the brand lockup and the native window-control reserve, and the
    // module switch is the wordmark's subtitle inside the brand region — the
    // one instance on screen.
    expect(moduleNavigation).not.toBeNull();
    expect(
      brand?.querySelector(
        "[data-desktop-brand-region] [data-desktop-brand-subtitle] [data-desktop-module-navigation]",
      ),
    ).toBe(moduleNavigation);
    expect(
      document.querySelectorAll("[data-module-switch-trigger]"),
    ).toHaveLength(1);
    expect(moduleNavigation?.className).not.toContain("absolute");
    expect(brand?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(
      document.querySelector<HTMLElement>(
        "[data-desktop-header-window-control-inset]",
      ),
    ).not.toBeNull();
    expect(screen.getAllByRole("group", { name: "Nestor modules" })).toContain(
      moduleNavigation,
    );
    expect(
      screen.getByRole("navigation", { name: "Job Finder sections" }),
    ).not.toBe(moduleNavigation);
  });

  it("answers close requests on the post-ready generic error screen", async () => {
    const bridge = installCloseBridgeMock();
    const nestor = window.nestor as unknown as {
      jobFinder: Record<string, unknown>;
    };
    nestor.jobFinder.getWorkspaceBootstrap = vi.fn(() =>
      Promise.reject(new Error("workspace storage unavailable")),
    );
    nestor.jobFinder.getStartupDatabaseRecovery = vi.fn(() =>
      Promise.reject(new Error("recovery facts unavailable")),
    );

    renderJobFinderPage();
    await screen.findAllByText("Couldn't open Job Finder");

    act(() => {
      bridge.emitCloseRequest("req_error_screen");
    });

    // Exactly one proceed also proves exactly one responder is mounted: two
    // subscribers would each answer the same request.
    await waitFor(() => {
      expect(bridge.resolutions).toEqual([
        { requestId: "req_error_screen", decision: "proceed" },
      ]);
    });
  });
});

describe("controller-owned close-guard mirror lifetime", () => {
  function configureReadyBootstrap(): void {
    const nestor = window.nestor as unknown as {
      ping: () => Promise<{ ok: true; platform: "darwin" }>;
      jobFinder: Record<string, unknown>;
    };
    nestor.ping = () =>
      Promise.resolve({ ok: true as const, platform: "darwin" as const });
    const readyWorkspace = {
      hydration: { phase: "complete", deferredCollections: [] },
      activeCampaignId: "campaign_1",
      campaigns: [],
      discoveryJobs: [],
      discoverySessions: [],
      sourceAccessPrompts: [],
      reviewQueue: [],
      tailoredAssets: [],
      applicationRecords: [],
      applicationAttempts: [],
      applyRuns: [],
      applyJobResults: [],
      selectedDiscoveryJobId: null,
      selectedReviewJobId: null,
      selectedApplicationRecordId: null,
      selectedApplyRunId: null,
      settings: { appearanceTheme: "system" },
      profileSetupState: { status: "completed", reviewItems: [] },
      profileCopilotMessages: [],
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    nestor.jobFinder.getWorkspaceBootstrap = vi.fn(() =>
      Promise.resolve(readyWorkspace),
    );
  }

  it("mirrors dirtiness to main while mounted and clears protection on unmount", async () => {
    const bridge = installCloseBridgeMock();
    configureReadyBootstrap();

    let controller: ReturnType<typeof useJobFinderPageController> | null = null;
    function ControllerProbe() {
      controller = useJobFinderPageController();
      return null;
    }

    const router = createMemoryRouter(
      [{ path: "/job-finder", element: <ControllerProbe /> }],
      { initialEntries: ["/job-finder"] },
    );
    const view = render(<RouterProvider router={router} />);

    await waitFor(() => {
      expect(controller).not.toBeNull();
      expect(controller?.workspaceState.status).toBe("ready");
    });
    expect(getJobFinderWindowCloseConfirmation()).toBeNull();
    expect(bridge.guardStates).toEqual([]);

    act(() => {
      controller?.context?.onProfileSurfaceDirtyChange(true);
    });

    await waitFor(() => {
      expect(getJobFinderWindowCloseConfirmation()).toEqual({
        title: "Leave this page?",
        description: "Your unsaved changes will be lost.",
        reasons: ["Unsaved profile or setup changes"],
      });
    });
    expect(bridge.guardStates.at(-1)).toEqual({ blocked: true });

    view.unmount();

    expect(getJobFinderWindowCloseConfirmation()).toBeNull();
    expect(bridge.guardStates.at(-1)).toEqual({ blocked: false });
  });
});
