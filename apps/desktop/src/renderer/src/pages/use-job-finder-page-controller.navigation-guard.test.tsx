// @vitest-environment jsdom

import type {
  CandidateProfile,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryRouter,
  type InitialEntry,
  Link,
  Outlet,
  RouterProvider,
} from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  composeLeaveConfirmation,
  useJobFinderPageController,
} from "./use-job-finder-page-controller";
import { JobFinderUnsavedChangesDialog } from "./job-finder-unsaved-changes-dialog";
import type { JobFinderSaveState } from "./job-finder-save-state";

// The data router constructs a real fetch Request for every navigation.
// jsdom's AbortSignal fails Node's brand check inside the Request constructor,
// so hand React Router a stub with the tiny request surface it reads (url,
// method, signal).
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

function createReadyWorkspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    hydration: { phase: "complete", deferredCollections: [] },
    activeCampaignId: "campaign_1",
    campaigns: [],
    discoveryJobs: [],
    dismissedDiscoveryJobs: [],
    recentDiscoveryRuns: [],
    discoverySessions: [],
    sourceAccessPrompts: [],
    activeDiscoveryRun: null,
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
}

function configureWindowNestor(
  workspace: JobFinderRendererWorkspaceSnapshot,
  overrides?: {
    jobFinder?: Record<string, unknown>;
    setCloseGuardState?: ReturnType<typeof vi.fn>;
  },
) {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      ping: vi.fn(() =>
        Promise.resolve({ ok: true, platform: "darwin" as const }),
      ),
      jobFinder: {
        getWorkspaceBootstrap: vi.fn(() => Promise.resolve(workspace)),
        ...(overrides?.jobFinder ?? {}),
      },
      window: {
        setCloseGuardState: overrides?.setCloseGuardState ?? vi.fn(),
      },
    } as unknown as Window["nestor"],
  });
}

// Drives one real profile save through the coordinator and lets it reject, so
// the controller reaches the same `failed` state a transient IPC or database
// failure produces in the app. The profile family is the surface whose unsaved
// work keeps its own `profileSurfaceDirty` reason after a failure.
async function failOneProfileSave(
  controller: { current: MountedController | null },
  profile: Record<string, unknown> = { fullName: "Draft" },
) {
  act(() => {
    controller.current?.context?.onSaveProfile(
      profile as unknown as CandidateProfile,
    );
  });
  await waitFor(() => {
    expect(controller.current?.saveState.state).toBe("failed");
    expect(controller.current?.saveState).toMatchObject({
      surface: "profile",
    });
  });
}

// Same, for the settings surface: its sections stage drafts locally with no
// dirty flag, so a failed settings save is the only unsaved-work protection
// those drafts have.
async function failOneSettingsSave(controller: {
  current: MountedController | null;
}) {
  await act(async () => {
    await controller.current?.context?.onUpdateWorkspaceBehavior({
      discoveryOnly: true,
    });
  });
  await waitFor(() => {
    expect(controller.current?.saveState.state).toBe("failed");
    expect(controller.current?.saveState).toMatchObject({
      surface: "settings",
    });
  });
}

type MountedController = ReturnType<typeof useJobFinderPageController>;

// The probe owns the controller plus the unsaved-changes dialog exactly like
// the real shell: both live above the Outlet, so they stay mounted while the
// guarded routes swap underneath them.
function mountGuardedController(
  options: {
    initialEntries?: InitialEntry[];
    strictMode?: boolean;
  } = {},
) {
  const mounted: { current: MountedController | null } = { current: null };

  function ControllerProbe() {
    mounted.current = useJobFinderPageController();
    const controller = mounted.current;
    return (
      <div>
        <Link data-testid="link-to-other" to="/other">
          Go to other screen
        </Link>
        <Outlet />
        <JobFinderUnsavedChangesDialog
          confirmation={controller?.unsavedChangesConfirmation ?? null}
          onLeaveWithoutSaving={() => {
            controller?.resolveUnsavedChangesLeave();
          }}
          onStay={() => {
            controller?.resolveUnsavedChangesStay();
          }}
        />
      </div>
    );
  }

  const router = createMemoryRouter(
    [
      {
        element: <ControllerProbe />,
        children: [
          { path: "/guard", element: <div>Guard screen</div> },
          { path: "/other", element: <div>Other screen</div> },
          { path: "/job-finder/profile", element: <div>Profile screen</div> },
        ],
      },
    ],
    { initialEntries: options.initialEntries ?? ["/guard"] },
  );

  const tree = <RouterProvider router={router} />;

  render(options.strictMode ? <StrictMode>{tree}</StrictMode> : tree);

  return {
    router,
    get current() {
      return mounted.current;
    },
  };
}

async function waitForReady(controller: { current: MountedController | null }) {
  await waitFor(() => {
    expect(controller.current?.workspaceState.status).toBe("ready");
    expect(controller.current?.context).not.toBeNull();
  });
}

function markDirty(controller: { current: MountedController | null }) {
  act(() => {
    controller.current?.context?.onProfileSurfaceDirtyChange(true);
  });
}

async function openUnsavedChangesDialog() {
  const dialog = await screen.findByRole("dialog", {
    name: /leave this page\?/i,
  });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  return dialog;
}

async function stayOnPage() {
  fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

async function leaveWithoutSaving() {
  fireEvent.click(screen.getByRole("button", { name: "Leave without saving" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "nestor");
});

describe("composeLeaveConfirmation", () => {
  const idleSaveState: JobFinderSaveState = { state: "idle", version: 0 };

  it("returns null when nothing needs protecting", () => {
    expect(
      composeLeaveConfirmation({
        profileSurfaceDirty: false,
        resumeWorkspaceDirty: false,
        saveState: idleSaveState,
      }),
    ).toBeNull();
  });

  it("composes one confirmation naming every unsaved scope together", () => {
    const confirmation = composeLeaveConfirmation({
      profileSurfaceDirty: true,
      resumeWorkspaceDirty: true,
      saveState: {
        state: "saving",
        version: 1,
        attempt: 1,
        surface: "profile",
        label: "Profile",
        message: "Saving profile…",
        canRetry: false,
      },
    });

    expect(confirmation?.title).toContain("Leave this page?");
    expect(confirmation?.description).toContain(
      "Your unsaved changes will be lost.",
    );
    expect(confirmation?.reasons).toContain("Unsaved resume edits");
    expect(confirmation?.reasons).toContain("Unsaved profile or setup changes");
    expect(confirmation?.reasons).toContain("Profile is still saving");
  });

  it("names a failed save so the user can decide to retry first", () => {
    const confirmation = composeLeaveConfirmation({
      profileSurfaceDirty: false,
      resumeWorkspaceDirty: false,
      saveState: {
        state: "failed",
        version: 2,
        attempt: 1,
        surface: "resume",
        label: "Resume",
        message: "Saving resume…",
        canRetry: true,
      },
    });

    expect(confirmation?.reasons[0]).toContain("The last save failed");
  });
});

describe("useJobFinderPageController failed-save acknowledgement", () => {
  it("releases the navigation and window-close guards when the failed save toast is dismissed", async () => {
    // One transient save failure used to block every sidebar click and every
    // Cmd+Q for the rest of the session: nothing cleared `failed` except a
    // later successful save of that exact surface or wiping the workspace.
    const setCloseGuardState = vi.fn();
    configureWindowNestor(createReadyWorkspace(), {
      jobFinder: {
        saveProfile: vi.fn(() =>
          Promise.reject(new Error("The workspace database is unavailable.")),
        ),
      },
      setCloseGuardState,
    });
    const confirmSpy = vi.spyOn(window, "confirm");
    const harness = mountGuardedController();
    await waitForReady(harness);

    await failOneProfileSave(harness);
    expect(setCloseGuardState).toHaveBeenLastCalledWith({ blocked: true });

    act(() => {
      void harness.router.navigate("/other");
    });
    const dialog = await openUnsavedChangesDialog();
    expect(dialog.textContent).toContain("The last save failed");
    await stayOnPage();
    expect(harness.router.state.location.pathname).toBe("/guard");

    act(() => {
      harness.current?.dismissSavedStatus();
    });

    await waitFor(() => {
      expect(harness.current?.saveState.state).toBe("idle");
    });
    expect(setCloseGuardState).toHaveBeenLastCalledWith({ blocked: false });

    act(() => {
      void harness.router.navigate("/other");
    });
    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe("/other");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("keeps unsaved-draft protection after the failed save is dismissed", async () => {
    configureWindowNestor(createReadyWorkspace(), {
      jobFinder: {
        saveProfile: vi.fn(() =>
          Promise.reject(new Error("The workspace database is unavailable.")),
        ),
      },
    });
    const harness = mountGuardedController();
    await waitForReady(harness);
    markDirty(harness);

    await failOneProfileSave(harness);

    act(() => {
      harness.current?.dismissSavedStatus();
    });
    await waitFor(() => {
      expect(harness.current?.saveState.state).toBe("idle");
    });

    act(() => {
      void harness.router.navigate("/other");
    });

    // Acknowledging the failure never acknowledges the draft: the dirty form
    // is still the real protection and keeps asking.
    const dialog = await openUnsavedChangesDialog();
    expect(dialog.textContent).toContain("Unsaved profile or setup changes");
    expect(dialog.textContent).not.toContain("The last save failed");
    await stayOnPage();
    expect(harness.router.state.location.pathname).toBe("/guard");
  });

  it("still blocks on a later, different save failure after one was dismissed", async () => {
    configureWindowNestor(createReadyWorkspace(), {
      jobFinder: {
        saveProfile: vi.fn(() =>
          Promise.reject(new Error("The workspace database is unavailable.")),
        ),
      },
    });
    const harness = mountGuardedController();
    await waitForReady(harness);

    await failOneProfileSave(harness);
    act(() => {
      harness.current?.dismissSavedStatus();
    });
    await waitFor(() => {
      expect(harness.current?.saveState.state).toBe("idle");
    });

    // A different save, and therefore a different failure, is not covered by
    // the earlier acknowledgement.
    await failOneProfileSave(harness, { fullName: "Second draft" });

    act(() => {
      void harness.router.navigate("/other");
    });
    const dialog = await openUnsavedChangesDialog();
    expect(dialog.textContent).toContain("The last save failed");
    await stayOnPage();
    expect(harness.router.state.location.pathname).toBe("/guard");
  });

  it("keeps a failed settings save blocking, because its staged drafts have no dirty flag", async () => {
    // Settings sections stage their edits in local component state and feed no
    // flag into `composeLeaveConfirmation`, so this failure is the only thing
    // between those drafts and a navigation that discards them.
    configureWindowNestor(createReadyWorkspace(), {
      jobFinder: {
        updateWorkspaceBehavior: vi.fn(() =>
          Promise.reject(new Error("The workspace database is unavailable.")),
        ),
      },
    });
    const harness = mountGuardedController();
    await waitForReady(harness);

    await failOneSettingsSave(harness);

    act(() => {
      harness.current?.dismissSavedStatus();
    });
    await waitFor(() => {
      expect(harness.current?.saveState.state).toBe("failed");
    });

    act(() => {
      void harness.router.navigate("/other");
    });
    const dialog = await openUnsavedChangesDialog();
    expect(dialog.textContent).toContain("The last save failed");
    await stayOnPage();
    expect(harness.router.state.location.pathname).toBe("/guard");
  });

  it("releases a failed settings save once the user leaves without saving", async () => {
    // The one release for a settings failure: the user answered the dialog
    // that named it, and the navigation it allows unmounts the staged drafts,
    // so nothing is left to protect and the failure must stop blocking.
    const setCloseGuardState = vi.fn();
    configureWindowNestor(createReadyWorkspace(), {
      jobFinder: {
        updateWorkspaceBehavior: vi.fn(() =>
          Promise.reject(new Error("The workspace database is unavailable.")),
        ),
      },
      setCloseGuardState,
    });
    const harness = mountGuardedController();
    await waitForReady(harness);

    await failOneSettingsSave(harness);
    expect(setCloseGuardState).toHaveBeenLastCalledWith({ blocked: true });

    act(() => {
      void harness.router.navigate("/other");
    });
    await openUnsavedChangesDialog();
    await leaveWithoutSaving();
    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe("/other");
    });

    await waitFor(() => {
      expect(harness.current?.saveState.state).toBe("idle");
    });
    expect(setCloseGuardState).toHaveBeenLastCalledWith({ blocked: false });

    act(() => {
      void harness.router.navigate("/guard");
    });
    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe("/guard");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("useJobFinderPageController navigation guard", () => {
  it("lets clean navigations through without any dialog or native prompt", async () => {
    configureWindowNestor(createReadyWorkspace());
    const confirmSpy = vi.spyOn(window, "confirm");
    const harness = mountGuardedController();
    await waitForReady(harness);

    act(() => {
      void harness.router.navigate("/other");
    });

    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe("/other");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("blocks a programmatic push with the branded dialog and Stay keeps the draft and its protection", async () => {
    configureWindowNestor(createReadyWorkspace());
    const confirmSpy = vi.spyOn(window, "confirm");
    const harness = mountGuardedController();
    await waitForReady(harness);
    markDirty(harness);

    act(() => {
      void harness.router.navigate("/other");
    });

    const dialog = await openUnsavedChangesDialog();
    expect(dialog.textContent).toContain("Unsaved profile or setup changes");
    expect(dialog.textContent).toContain("Your unsaved changes will be lost.");

    await stayOnPage();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(harness.router.state.location.pathname).toBe("/guard");

    // Staying preserved the draft, so the guard must still protect it on the
    // very next attempt instead of silently letting work be lost later.
    act(() => {
      void harness.router.navigate("/other");
    });
    const dialogAgain = await openUnsavedChangesDialog();
    expect(dialogAgain.textContent).toContain(
      "Unsaved profile or setup changes",
    );
    await stayOnPage();
    expect(harness.router.state.location.pathname).toBe("/guard");
  });

  it("reaches the requested route exactly once on Leave without saving and stops prompting once the draft is discarded", async () => {
    configureWindowNestor(createReadyWorkspace());
    const confirmSpy = vi.spyOn(window, "confirm");
    const harness = mountGuardedController();
    await waitForReady(harness);
    markDirty(harness);

    act(() => {
      void harness.router.navigate("/other");
    });
    await openUnsavedChangesDialog();

    let commitsToOther = 0;
    const unsubscribe = harness.router.subscribe(() => {
      if (harness.router.state.location.pathname === "/other") {
        commitsToOther += 1;
      }
    });

    await leaveWithoutSaving();

    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe("/other");
    });
    unsubscribe();
    expect(commitsToOther).toBe(1);

    // Leaving was an explicit discard: the stale draft must not keep blocking
    // truthful navigation afterwards.
    act(() => {
      void harness.router.navigate("/guard");
    });
    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe("/guard");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("blocks a router-owned link click with the dialog instead of window.confirm", async () => {
    configureWindowNestor(createReadyWorkspace());
    const confirmSpy = vi.spyOn(window, "confirm");
    const harness = mountGuardedController();
    await waitForReady(harness);
    markDirty(harness);

    fireEvent.click(screen.getByTestId("link-to-other"));

    await openUnsavedChangesDialog();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(harness.router.state.location.pathname).toBe("/guard");

    await stayOnPage();
    expect(harness.router.state.location.pathname).toBe("/guard");
  });

  it("guards back-button history moves truthfully: Escape restores, Leave commits", async () => {
    configureWindowNestor(createReadyWorkspace());
    const confirmSpy = vi.spyOn(window, "confirm");
    const harness = mountGuardedController({
      initialEntries: ["/other", "/guard"],
    });
    await waitForReady(harness);
    markDirty(harness);

    await act(async () => {
      await Promise.resolve();
      void harness.router.navigate(-1);
    });

    await openUnsavedChangesDialog();

    // Escape resolves to staying, so closing the dialog can never discard a
    // draft by accident and the history entry stays put.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(harness.router.state.location.pathname).toBe("/guard");

    await act(async () => {
      await Promise.resolve();
      void harness.router.navigate(-1);
    });
    await openUnsavedChangesDialog();
    await leaveWithoutSaving();

    await waitFor(() => {
      expect(harness.router.state.location.pathname).toBe("/other");
    });
  });

  it("exempts hash-only fragment changes so in-page anchors never lose drafts", async () => {
    configureWindowNestor(createReadyWorkspace());
    const confirmSpy = vi.spyOn(window, "confirm");
    const harness = mountGuardedController();
    await waitForReady(harness);
    markDirty(harness);

    act(() => {
      void harness.router.navigate("/guard#section-anchor");
    });
    await waitFor(() => {
      expect(harness.router.state.location.hash).toBe("#section-anchor");
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(harness.router.state.location.pathname).toBe("/guard");
    expect(harness.router.state.location.hash).toBe("#section-anchor");
  });

  it("allows Profile tab and focus changes while preserving protection when leaving Profile", async () => {
    configureWindowNestor(createReadyWorkspace());
    const harness = mountGuardedController({
      initialEntries: ["/job-finder/profile?section=basics"],
    });
    await waitForReady(harness);
    markDirty(harness);

    await act(async () => {
      await harness.router.navigate(
        "/job-finder/profile?section=preferences&focus=target-roles",
      );
    });
    expect(harness.router.state.location.search).toBe(
      "?section=preferences&focus=target-roles",
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      await harness.router.navigate(-1);
    });
    expect(harness.router.state.location.search).toBe("?section=basics");
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      void harness.router.navigate("/other");
    });
    expect((await openUnsavedChangesDialog()).textContent).toContain(
      "Unsaved profile or setup changes",
    );
    await stayOnPage();
    expect(harness.router.state.location.pathname).toBe("/job-finder/profile");
  });

  it.each([
    [
      "/job-finder/profile?campaignId=one",
      "/job-finder/profile?campaignId=two",
    ],
    ["/guard?section=basics", "/guard?section=preferences"],
  ])("still guards other query changes from %s", async (from, to) => {
    configureWindowNestor(createReadyWorkspace());
    const harness = mountGuardedController({ initialEntries: [from] });
    await waitForReady(harness);
    markDirty(harness);

    act(() => {
      void harness.router.navigate(to);
    });
    await openUnsavedChangesDialog();
    expect(
      harness.router.state.location.pathname +
        harness.router.state.location.search,
    ).toBe(from);
  });

  it("protects full Profile drafts when a query change would return to unstarted setup", async () => {
    const workspace = createReadyWorkspace();
    workspace.profileSetupState.status = "not_started";
    configureWindowNestor(workspace);
    const harness = mountGuardedController({
      initialEntries: [
        {
          pathname: "/job-finder/profile",
          search: "?section=basics",
          state: { forceFullProfile: true },
        },
      ],
    });
    await waitForReady(harness);
    markDirty(harness);

    act(() => {
      void harness.router.navigate("/job-finder/profile?section=experience");
    });
    await openUnsavedChangesDialog();
    await stayOnPage();
    expect(harness.router.state.location.search).toBe("?section=basics");

    await act(async () => {
      await harness.router.navigate("/job-finder/profile?section=experience", {
        state: { forceFullProfile: true },
      });
    });
    expect(harness.router.state.location.search).toBe("?section=experience");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

it("protects search-plan drafts on route changes and clears protection after discard", async () => {
  configureWindowNestor(createReadyWorkspace());
  const harness = mountGuardedController();
  await waitForReady(harness);
  act(() => harness.current?.context?.onSearchPlanSurfaceDirtyChange(true));
  fireEvent.click(screen.getByTestId("link-to-other"));
  expect((await openUnsavedChangesDialog()).textContent).toContain(
    "Unsaved search-plan changes",
  );
  await stayOnPage();
  expect(harness.router.state.location.pathname).toBe("/guard");
  fireEvent.click(screen.getByTestId("link-to-other"));
  await openUnsavedChangesDialog();
  await leaveWithoutSaving();
  expect(harness.router.state.location.pathname).toBe("/other");
  await act(async () => {
    await harness.router.navigate(-1);
  });
  expect(harness.router.state.location.pathname).toBe("/guard");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("allows navigation after the search-plan editor reports a successful save", async () => {
  configureWindowNestor(createReadyWorkspace());
  const harness = mountGuardedController();
  await waitForReady(harness);
  act(() => {
    harness.current?.context?.onSearchPlanSurfaceDirtyChange(true);
    harness.current?.context?.onSearchPlanSurfaceDirtyChange(false);
  });
  fireEvent.click(screen.getByTestId("link-to-other"));
  await waitFor(() =>
    expect(harness.router.state.location.pathname).toBe("/other"),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
