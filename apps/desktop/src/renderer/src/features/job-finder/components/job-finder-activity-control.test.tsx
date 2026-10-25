import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobFinderActivityControl } from "./job-finder-activity-control";

describe("JobFinderActivityControl", () => {
  it("pauses through the typed owner callback and explains what remains usable", () => {
    const onPause = vi.fn();
    render(
      <JobFinderActivityControl
        onPause={onPause}
        onResume={vi.fn()}
        state={{
          activeApplicationCount: 1,
          activeBrowserCount: 2,
          paused: false,
          pausedAt: null,
          pending: false,
        }}
      />,
    );
    expect(screen.getByText(/3 background operations running/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onPause).toHaveBeenCalledOnce();
  });

  it("offers resume without pretending active work was cancelled", () => {
    const onResume = vi.fn();
    render(
      <JobFinderActivityControl
        onPause={vi.fn()}
        onResume={onResume}
        state={{
          activeApplicationCount: 0,
          activeBrowserCount: 0,
          paused: true,
          pausedAt: "2026-08-15T10:00:00.000Z",
          pending: false,
        }}
      />,
    );
    expect(screen.getByText(/local edits still work/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onResume).toHaveBeenCalledOnce();
  });
});
// @vitest-environment jsdom
