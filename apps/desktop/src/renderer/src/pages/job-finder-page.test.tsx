// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPlatformPing } from "@nestor/contracts";
import { JobFinderPage } from "./job-finder-page";

function configureWindowNestor() {
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
      profileWorkflow: { run: () => new Promise(() => undefined) },
      needsYou: { run: () => new Promise(() => undefined) },
      window: {
        getControlsState: () => new Promise(() => undefined),
        onControlsStateChange: () => () => undefined,
      },
      jobFinder: {},
    },
  });
}

function renderJobFinderPage(path: string) {
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

describe("JobFinderPage launch", () => {
  it.each([
    "/job-finder/home",
    "/job-finder/profile",
    "/job-finder/profile/setup",
    "/job-finder/settings",
  ])("opens %s", async (path) => {
    configureWindowNestor();

    renderJobFinderPage(path);

    expect(
      await screen.findByRole("navigation", { name: "Job Finder sections" }),
    ).toBeTruthy();
  });
});
