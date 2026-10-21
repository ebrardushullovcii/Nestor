// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import {
  JobFinderHydrationGate,
  WorkspaceStateScreen,
} from "./job-finder-page-routes";

function workspace(
  phase: "bootstrap" | "complete",
): JobFinderRendererWorkspaceSnapshot {
  return {
    hydration: {
      phase,
      deferredCollections: phase === "bootstrap" ? ["discovery_jobs"] : [],
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

afterEach(() => {
  cleanup();
});

describe("WorkspaceStateScreen", () => {
  it("offers an explicit retry after the initial workspace load fails", () => {
    const onRetry = vi.fn();
    render(
      <WorkspaceStateScreen
        action={{ label: "Retry opening Job Finder", onClick: onRetry }}
        kicker="Workspace error"
        message="The saved workspace could not be read."
        title="Couldn't open Job Finder"
        tone="error"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Retry opening Job Finder" }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("centers the shared state card and its contents in the available shell", () => {
    render(
      <WorkspaceStateScreen
        fillAvailableViewport
        kicker="Job Finder"
        message="We’re opening this workspace surface."
        title="Loading screen"
      />,
    );

    const card = document.querySelector<HTMLElement>(
      "[data-workspace-state-screen]",
    );
    const outer = card?.parentElement;
    const status = screen.getByRole("status");

    expect(outer?.className).toContain("flex-1");
    expect(outer?.className).toContain("place-items-center");
    expect(outer?.className).toContain("text-center");
    expect(outer?.className).toContain("min-h-[calc(100dvh-7.25rem)]");
    expect(outer?.className).toContain(
      "xl:min-h-[calc(100dvh-3.5rem)]",
    );
    expect(outer?.dataset.workspaceStateViewportFill).toBe("true");
    expect(status.className).toContain("w-full");
    expect(status.className).toContain("justify-items-center");
    expect(
      card?.querySelector("[data-workspace-state-title]")?.textContent,
    ).toBe("Loading screen");
    expect(
      card?.querySelector("[data-workspace-state-message]")?.textContent,
    ).toBe("We’re opening this workspace surface.");
  });

  it("keeps deferred routes honest until the bootstrap becomes complete", () => {
    const { rerender } = render(
      <JobFinderHydrationGate
        collections={["discovery_jobs"]}
        workspace={workspace("bootstrap")}
      >
        <div>Loaded results</div>
      </JobFinderHydrationGate>,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Loading your workspace",
    );
    expect(screen.queryByText("Loaded results")).toBeNull();

    rerender(
      <JobFinderHydrationGate
        collections={["discovery_jobs"]}
        workspace={workspace("complete")}
      >
        <div>Loaded results</div>
      </JobFinderHydrationGate>,
    );

    expect(screen.getByText("Loaded results")).toBeTruthy();
  });
});
