// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LaunchContext,
} from "@nestor/contracts";
import {
  JobFinderHomeRoute,
} from "./job-finder-page-routes";

const launch = vi.hoisted(() => ({
  context: null as LaunchContext | null,
  requestLegacyWorkspace: vi.fn(),
}));
vi.mock("@renderer/features/job-finder/lib/launch-reads", () => ({
  useLaunchReads: () => ({ context: launch.context }),
}));
vi.mock("@renderer/features/job-finder/lib/legacy-workspace-demand", () => ({
  requestLegacyWorkspace: launch.requestLegacyWorkspace,
}));
vi.mock("@renderer/features/home/home-screen", () => ({
  HomeScreen: () => <p>Home</p>,
}));

afterEach(cleanup);

function renderHome(context: LaunchContext) {
  launch.context = context;
  render(
    <MemoryRouter initialEntries={["/job-finder"]}>
      <Routes>
        <Route path="/job-finder" element={<JobFinderHomeRoute />} />
        <Route path="/job-finder/profile/setup" element={<p>Setup</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

// The redirect is spent once taken, so the case that never redirects runs first.
describe("JobFinderHomeRoute", () => {
  it("waits for the old workspace when the launch read could not read it", () => {
    renderHome({
      workspace: "unreadable",
      settings: null,
      profileSetupState: null,
    });
    expect(screen.getByText("Home")).toBeTruthy();
    expect(launch.requestLegacyWorkspace).toHaveBeenCalledOnce();
  });

  it("opens guided setup on a first launch", () => {
    renderHome({ workspace: "none", settings: null, profileSetupState: null });
    expect(screen.getByText("Setup")).toBeTruthy();
  });
});


/**
 * "Check whether this step is done" is gated on the pending browser-step
 * request for the selected application, and the same request supplies the
 * in-place "Checking…" / "still blocked" text. The command it sends used to
 * run a second, run-scoped lookup and `return` silently when that matched
 * nothing, so a request left over from an earlier run for the same job left
 * the control enabled while pressing it did nothing at all. Gate, status, and
 * command now read one request.
 */
