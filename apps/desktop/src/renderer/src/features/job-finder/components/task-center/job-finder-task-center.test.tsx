// @vitest-environment jsdom

import type {
  JobFinderRendererWorkspaceSnapshot,
  ResumeImportRun,
} from "@nestor/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JobFinderTaskCenter } from "./job-finder-task-center";

// The fixtures' imports end on 31 July; Activity shows a finished run for a day.
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date"],
    now: new Date("2026-07-31T12:00:00.000Z"),
  });
});
afterEach(() => {
  vi.useRealTimers();
});

function importRun(overrides: Partial<ResumeImportRun> = {}): ResumeImportRun {
  return {
    id: "resume_import_1",
    sourceResumeId: "resume_1",
    sourceResumeFileName: "candidate.pdf",
    status: "extracting",
    startedAt: "2026-07-31T10:00:00.000Z",
    completedAt: null,
    candidateCounts: { total: 0, autoApplied: 0, needsReview: 0, rejected: 0 },
    ...overrides,
  } as ResumeImportRun;
}

function createWorkspace(
  latestResumeImportRun: ResumeImportRun | null = importRun(),
): JobFinderRendererWorkspaceSnapshot {
  return {
    discoveryJobs: [],
    latestResumeImportRun,
    searchPreferences: {
      discovery: { targets: [{ id: "source_1", label: "Mercury careers" }] },
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("JobFinderTaskCenter", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  test("clears finished history and keeps it cleared after reopening", () => {
    const workspace = createWorkspace(
      importRun({
        status: "review_ready",
        completedAt: "2026-07-31T10:00:02.000Z",
      }),
    );
    const first = render(
      <JobFinderTaskCenter
        isResumeImportPending={false}
        workspace={workspace}
      />,
    );

    fireEvent.click(document.querySelector("summary") as HTMLElement);
    expect(
      document.querySelector('[data-task-kind="resume_import"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(
      document.querySelector('[data-task-kind="resume_import"]'),
    ).toBeNull();
    expect(screen.getByText(/Nothing is running/)).toBeTruthy();

    first.unmount();
    render(
      <JobFinderTaskCenter
        isResumeImportPending={false}
        workspace={workspace}
      />,
    );
    fireEvent.click(document.querySelector("summary") as HTMLElement);
    expect(
      document.querySelector('[data-task-kind="resume_import"]'),
    ).toBeNull();
  });

  test("closes predictably with Escape, outside interaction, and the visible close control", () => {
    render(
      <>
        <button type="button">Outside control</button>
        <JobFinderTaskCenter
          isResumeImportPending={false}
          workspace={createWorkspace()}
        />
      </>,
    );

    const details = document.querySelector("details") as HTMLDetailsElement;
    const summary = screen.getByLabelText("Activity: 1 running");

    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);

    fireEvent.click(summary);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Outside control" }),
    );
    expect(details.open).toBe(false);

    fireEvent.click(summary);
    fireEvent.pointerDown(screen.getByRole("region", { name: "Activity" }), {
      bubbles: true,
    });
    expect(details.open).toBe(true);

    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("button", { name: "Close Activity" }));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);

    const panel = screen.getByRole("region", { name: "Activity" });
    // Anchored under its own trigger and bounded at every width: as a fixed
    // bottom sheet it resolved against the header's backdrop filter and opened
    // upward over the title bar at the minimum window size.
    expect(panel.className).toContain("absolute");
    expect(panel.className).toContain("top-12");
    expect(panel.className).toContain("max-h-[min(38rem,calc(100vh-8rem))]");
    expect(panel.className).not.toContain("fixed");
    // An opaque surface, so nothing behind it ever shows through.
    expect(panel.className).toContain("surface-popover-solid");
  });

  test("shows useful progress without unavailable capability clutter", () => {
    render(
      <JobFinderTaskCenter
        isResumeImportPending={false}
        workspace={createWorkspace()}
      />,
    );

    expect(screen.getByText("Activity", { selector: "h2" })).toBeInstanceOf(
      HTMLElement,
    );
    expect(screen.getAllByText("Progress").length).toBeGreaterThan(0);
    expect(screen.queryByText("Pause")).toBeNull();
    expect(screen.queryByText("Not available")).toBeNull();
  });
});
