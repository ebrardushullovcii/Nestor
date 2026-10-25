// @vitest-environment jsdom

import type {
  AppearanceTheme,
  BrowserSessionState,
  JobFinderSettings,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import { JobFinderSettingsSchema } from "@nestor/contracts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { JobFinderPageContext } from "./job-finder-page-context";
import { JobFinderSettingsRoute } from "./job-finder-page-routes";

const globalActScope = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  globalActScope.IS_REACT_ACT_ENVIRONMENT = true;
});

type SaveHandlerProps = {
  onUpdateAppearanceTheme?: ((theme: AppearanceTheme) => unknown) | undefined;
  onUpdateApplicationDefaults?:
    | ((input: UpdateApplicationDefaultsInput) => unknown)
    | undefined;
  onUpdateWorkspaceBehavior?:
    | ((input: UpdateWorkspaceBehaviorInput) => unknown)
    | undefined;
};

// The route boundary is what this file proves: capture the props the route
// hands to SettingsScreen so each save handler can be invoked and its
// returned value inspected.
let capturedSaveHandlers: SaveHandlerProps = {};

vi.mock("@renderer/features/job-finder/screens/settings-screen", () => ({
  SettingsScreen: (props: Record<string, unknown>) => {
    capturedSaveHandlers = {
      onUpdateAppearanceTheme: props.onUpdateAppearanceTheme as
        | SaveHandlerProps["onUpdateAppearanceTheme"]
        | undefined,
      onUpdateApplicationDefaults: props.onUpdateApplicationDefaults as
        | SaveHandlerProps["onUpdateApplicationDefaults"]
        | undefined,
      onUpdateWorkspaceBehavior: props.onUpdateWorkspaceBehavior as
        | SaveHandlerProps["onUpdateWorkspaceBehavior"]
        | undefined,
    };
    return null;
  },
}));

// Prune sibling screen subtrees that the shared routes module imports but
// this Settings-boundary test never mounts.
vi.mock("@renderer/features/job-finder/screens/profile-screen", () => ({
  ProfileScreen: () => null,
}));

const browserSession = {
  source: "target_site",
  status: "idle",
  driver: "catalog_seed",
  label: "Idle",
  detail: null,
  lastCheckedAt: "2026-08-01T00:00:00.000Z",
} as unknown as BrowserSessionState;

function parseSettings(): JobFinderSettings {
  return JobFinderSettingsSchema.parse({
    allowAutoSubmitOverride: false,
    fontPreset: "inter_requisite",
    humanReviewRequired: true,
    keepSessionAlive: false,
    resumeFormat: "pdf",
    resumeTemplateId: "classic_ats",
  });
}

function renderSettingsRoute(context: JobFinderPageContext) {
  render(
    <MemoryRouter initialEntries={["/job-finder/settings"]}>
      <Routes>
        <Route element={<Outlet context={context} />} path="/job-finder">
          <Route element={<JobFinderSettingsRoute />} path="settings" />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

  // The route loads SettingsScreen lazily; the stub captures on first mount.
  return waitFor(() =>
    expect(capturedSaveHandlers.onUpdateAppearanceTheme).toBeDefined(),
  );
}

describe("JobFinderSettingsRoute scoped save wiring", () => {
  beforeEach(() => {
    capturedSaveHandlers = {};
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hands each context save handler through so callers receive its Promise<boolean>", async () => {
    const onUpdateAppearanceTheme = vi.fn<(theme: AppearanceTheme) => unknown>(
      () => Promise.resolve(false),
    );
    const onUpdateApplicationDefaults = vi.fn<
      (input: UpdateApplicationDefaultsInput) => unknown
    >(() => Promise.resolve(false));
    const onUpdateWorkspaceBehavior = vi.fn<
      (input: UpdateWorkspaceBehaviorInput) => unknown
    >(() => Promise.resolve(false));
    const context = {
      workspace: {
        availableResumeTemplates: [],
        browserSession,
        settings: parseSettings(),
      },
      isPending: () => false,
      onResetWorkspace: vi.fn(),
      onUpdateAppearanceTheme,
      onUpdateApplicationDefaults,
      onUpdateWorkspaceBehavior,
    } as unknown as JobFinderPageContext;

    await renderSettingsRoute(context);

    // Each prop must be backed by the context handler and must return the
    // handler's save outcome promise. The previous wiring wrapped every
    // handler as `(input) => { void context.on...(input); }`, which returned
    // undefined here and discarded the resolved boolean.
    const themeOutcome = capturedSaveHandlers.onUpdateAppearanceTheme?.("dark");
    expect(onUpdateAppearanceTheme).toHaveBeenCalledWith("dark");
    expect(themeOutcome).toBeInstanceOf(Promise);
    await expect(themeOutcome).resolves.toBe(false);

    const defaultsInput = {
      resumeApplicationMode: "original_resume",
      resumeTemplateId: "modern_split",
    } satisfies UpdateApplicationDefaultsInput;
    const defaultsOutcome =
      capturedSaveHandlers.onUpdateApplicationDefaults?.(defaultsInput);
    expect(onUpdateApplicationDefaults).toHaveBeenCalledWith(defaultsInput);
    expect(defaultsOutcome).toBeInstanceOf(Promise);
    await expect(defaultsOutcome).resolves.toBe(false);

    const behaviorInput = {
      keepSessionAlive: true,
      discoveryOnly: true,
    } satisfies UpdateWorkspaceBehaviorInput;
    const behaviorOutcome =
      capturedSaveHandlers.onUpdateWorkspaceBehavior?.(behaviorInput);
    expect(onUpdateWorkspaceBehavior).toHaveBeenCalledWith(behaviorInput);
    expect(behaviorOutcome).toBeInstanceOf(Promise);
    await expect(behaviorOutcome).resolves.toBe(false);
  });
});
