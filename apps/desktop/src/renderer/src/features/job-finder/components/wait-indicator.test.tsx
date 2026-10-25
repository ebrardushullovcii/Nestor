// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatResumeOperationElapsed,
  RESUME_ASSISTANT_EXPECTED_WAIT_LABEL,
  WAIT_ELAPSED_RESERVED_CHARACTERS,
  WAIT_ELAPSED_RESERVED_WIDTH,
} from "../lib/wait-state";
import { getRouteSkeletonPanes, RouteSkeleton } from "./route-skeleton";
import { WaitIndicator } from "./wait-indicator";

/** `LockedScreenLayout` measures its header; jsdom has no ResizeObserver. */
class ResizeObserverMock {
  disconnect() {}
  observe() {}
  unobserve() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverMock);

afterEach(() => {
  cleanup();
});

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function readSource(relativePath: string): string {
  return readFileSync(path.join(RENDERER_ROOT, relativePath), "utf8");
}

/**
 * PKG-06 pins the rule now; the zones adopt it as they land. Every entry is a
 * file that still renders its own wait signal (or, for the page, still paints
 * the centred card as the lazy fallback). Adoption is explicitly not this
 * package's job — PKG-05 owns the Copilot wait, the phase-B zone packages own
 * the rest — so each entry names its owner and must be deleted, not extended,
 * when that zone lands.
 */
const PENDING_ADOPTION: ReadonlyArray<{ owner: string; path: string }> = [
  // Phase B — shared chrome: the save toast's sub-second spinner and the
  // resume-import stage bar (the one legitimately determinate signal, which
  // still owns its own spinner alongside).
  {
    owner: "phase-B",
    path: "features/job-finder/components/job-finder-save-status.tsx",
  },
  {
    owner: "phase-B",
    path: "features/job-finder/components/profile/resume-import-progress.tsx",
  },
];

const SPINNER_PATTERN = /ThinkingDots|LoaderCircle|Loader2|animate-spin/;

const SCANNED_FILES = [
  "features/job-finder/components/profile/resume-import-progress.tsx",
  "features/job-finder/components/job-finder-save-status.tsx",
  "features/job-finder/components/startup-database-recovery-notice.tsx",
  "features/job-finder/screens/settings/settings-support-controls.tsx",
  "pages/job-finder-page.tsx",
];

describe("WaitIndicator", () => {
  it("renders the whole trio in every state, before the clock is even shown", () => {
    // 0s: below the 2s digit threshold. The slot still has to be there, or the
    // row moves when the clock appears.
    render(
      <WaitIndicator
        elapsedSeconds={0}
        expectationLabel={RESUME_ASSISTANT_EXPECTED_WAIT_LABEL}
        label="Assistant thinking"
      />,
    );

    const indicator = document.querySelector("[data-wait-indicator]");
    expect(indicator).not.toBeNull();
    expect(
      indicator?.querySelector(
        "[role='progressbar'][data-progress-indeterminate]",
      ),
    ).not.toBeNull();
    const elapsed = indicator?.querySelector("[data-wait-elapsed]");
    expect(elapsed).not.toBeNull();
    expect(elapsed?.getAttribute("data-wait-elapsed-visible")).toBe("false");
    expect(elapsed?.textContent).toBe("");
    expect(
      indicator?.querySelector("[data-wait-expectation]")?.textContent,
    ).toBe(RESUME_ASSISTANT_EXPECTED_WAIT_LABEL);
  });

  it("shows the clock from 2 seconds and keeps the trio while it runs", () => {
    render(
      <WaitIndicator
        elapsedSeconds={12}
        expectationLabel={RESUME_ASSISTANT_EXPECTED_WAIT_LABEL}
        label="Assistant thinking"
        longRunningMs={20_000}
        message="Working on your edit…"
      />,
    );

    const indicator = document.querySelector("[data-wait-indicator]");
    expect(indicator?.getAttribute("data-wait-long-running")).toBe("false");
    expect(indicator?.querySelector("[data-wait-elapsed]")?.textContent).toBe(
      "0:12",
    );
    expect(
      indicator?.querySelector("[data-wait-expectation]")?.textContent,
    ).toBe(RESUME_ASSISTANT_EXPECTED_WAIT_LABEL);
    expect(indicator?.querySelector("[role='progressbar']")).not.toBeNull();
    expect(indicator?.querySelector("[data-wait-escalation]")).toBeNull();
  });

  it("escalates past the threshold and offers a recovery action", () => {
    const onClick = vi.fn();
    render(
      <WaitIndicator
        elapsedSeconds={25}
        escalationAction={{ label: "Reload workspace", onClick }}
        escalationMessage="Taking longer than expected. Your saved draft is unchanged."
        expectationLabel={RESUME_ASSISTANT_EXPECTED_WAIT_LABEL}
        label="Assistant thinking"
        longRunningMs={20_000}
        message="Working on your edit…"
      />,
    );

    const indicator = document.querySelector("[data-wait-indicator]");
    expect(indicator?.getAttribute("data-wait-long-running")).toBe("true");
    // The escalation never replaces the trio: the signal, the clock and the
    // expectation all stay, so the user can still see how far past the stated
    // expectation the wait has gone.
    expect(indicator?.querySelector("[role='progressbar']")).not.toBeNull();
    expect(indicator?.querySelector("[data-wait-elapsed]")?.textContent).toBe(
      "0:25",
    );
    expect(
      indicator?.querySelector("[data-wait-expectation]")?.textContent,
    ).toBe(RESUME_ASSISTANT_EXPECTED_WAIT_LABEL);

    const escalation = indicator?.querySelector("[data-wait-escalation]");
    expect(escalation).not.toBeNull();
    const recovery = screen.getByRole("button", { name: "Reload workspace" });
    recovery.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("still escalates honestly when the caller supplies no copy of its own", () => {
    render(
      <WaitIndicator
        elapsedSeconds={45}
        expectationLabel={RESUME_ASSISTANT_EXPECTED_WAIT_LABEL}
        label="Checking the application page"
      />,
    );

    expect(
      document.querySelector("[data-wait-escalation]")?.textContent,
    ).toContain("taking longer than expected");
  });

  it("holds the elapsed slot at one width from 0s through 10m 00s", () => {
    // The counter sits on the same baseline row as the operation label. Left
    // to size itself it grew one character wider at the first minute boundary
    // and pushed that row apart mid-wait. The reservation is an inline
    // `min-width` precisely so the guard can read the reserved value back out
    // of the DOM rather than trusting a class name.
    const samples = [0, 2, 9, 59, 60, 62, 599, 600];
    const widths = new Set<string>();
    const classNames = new Set<string>();

    for (const seconds of samples) {
      cleanup();
      render(
        <WaitIndicator
          elapsedSeconds={seconds}
          expectationLabel={RESUME_ASSISTANT_EXPECTED_WAIT_LABEL}
          label="Assistant thinking"
        />,
      );
      const elapsed = document.querySelector<HTMLElement>(
        "[data-wait-elapsed]",
      );
      expect(elapsed).not.toBeNull();
      widths.add(elapsed?.style.minWidth ?? "");
      // Nothing may set an explicit width alongside the reservation, or the
      // min-width stops being the thing that decides the box.
      expect(elapsed?.style.width ?? "").toBe("");
      classNames.add(elapsed?.className ?? "");
    }

    expect([...widths]).toEqual([WAIT_ELAPSED_RESERVED_WIDTH]);
    expect(classNames.size).toBe(1);
    // `min-width: 5ch` only pins the box if the content can never exceed it.
    // `10m 00s` prints `10:00`; the widest value the clock can reach in an
    // hour-long wait is `59:59`. Both are 5 characters, and `tabular-nums`
    // gives every digit the same advance.
    for (let seconds = 0; seconds <= 3_600; seconds += 1) {
      expect(formatResumeOperationElapsed(seconds).length).toBeLessThanOrEqual(
        WAIT_ELAPSED_RESERVED_CHARACTERS,
      );
    }
    expect(formatResumeOperationElapsed(600)).toBe("10:00");
    expect([...classNames][0]).toContain("tabular-nums");
  });
});

describe("wait signal ownership", () => {
  it("renders no spinner outside WaitIndicator except in files still pending adoption", () => {
    const allowed = new Set(PENDING_ADOPTION.map((entry) => entry.path));
    const unexpected = SCANNED_FILES.filter(
      (relativePath) =>
        !allowed.has(relativePath) &&
        SPINNER_PATTERN.test(readSource(relativePath)),
    );

    expect(unexpected).toEqual([]);
  });

  it("keeps every allowlisted file real, so the list shrinks instead of rotting", () => {
    // An entry that no longer has a spinner has been adopted and must be
    // deleted from the list; an entry naming a file that has moved must be
    // repointed. Either way the list cannot quietly outlive its reason.
    const stale = PENDING_ADOPTION.filter(
      (entry) =>
        entry.path !== "pages/job-finder-page.tsx" &&
        !SPINNER_PATTERN.test(readSource(entry.path)),
    );

    expect(stale).toEqual([]);
  });
});

describe("lazy-route fallback", () => {
  it("paints the destination's own frame, not a centred card", () => {
    render(<RouteSkeleton panes={2} title="Find jobs" />);

    // The route header is in the header slot, named, before anything loads.
    expect(screen.getByRole("heading", { name: "Find jobs" })).not.toBeNull();
    const skeleton = document.querySelector("[data-route-skeleton]");
    expect(skeleton?.getAttribute("data-route-skeleton-panes")).toBe("2");
    expect(
      skeleton?.querySelectorAll("[data-route-skeleton-pane]"),
    ).toHaveLength(2);
    // The frame must never be the full-viewport centred card.
    expect(
      document.querySelector("[data-workspace-state-viewport-fill]"),
    ).toBeNull();

    cleanup();
    render(<RouteSkeleton panes={1} title="Profile" />);
    expect(
      document.querySelectorAll("[data-route-skeleton-pane]"),
    ).toHaveLength(1);
  });

  it("maps every locked destination to its loaded pane count", () => {
    // Read the pane count back out of each route's own layout rather than
    // restating it, so a route that changes shape fails here.
    const twoPaneRoutes = [
      {
        path: "/job-finder/review-queue",
        // Shortlisted lays out through the shared list and details layout.
        source: "features/job-lists/list-pane.tsx",
      },
      {
        path: "/job-finder/applications",
        // Applications lays out through the shared list and details layout.
        source: "features/job-lists/list-pane.tsx",
      },
    ];

    // The three list-and-details routes share one column split.
    for (const route of twoPaneRoutes) {
      expect(readSource(route.source)).toContain("LIST_DETAIL_COLUMNS_CLASS");
      expect(getRouteSkeletonPanes(route.path)).toBe(2);
    }

    // Profile is locked but single-column, and every scrolling route is too.
    expect(
      readSource("features/job-finder/screens/profile-screen.tsx"),
    ).not.toMatch(/xl:grid-cols-\[minmax\([^\]]*_minmax\([^\]]*\]/);
    expect(getRouteSkeletonPanes("/job-finder/profile")).toBe(1);
    expect(getRouteSkeletonPanes("/job-finder/home")).toBe(1);
    expect(getRouteSkeletonPanes("/job-finder/settings")).toBe(1);
  });

  it("resolves the Suspense fallback to a RouteSkeleton, not the centred card", () => {
    const pageSource = readSource("pages/job-finder-page.tsx");
    const isPendingAdoption = PENDING_ADOPTION.some(
      (entry) => entry.path === "pages/job-finder-page.tsx",
    );

    if (isPendingAdoption) {
      // CR-PKG06-01 is open against PKG-04. Pin the current shape so the
      // allowlist entry is provably still needed rather than decorative.
      expect(pageSource).toContain("fillAvailableViewport");
      return;
    }

    // The page hands its fallback to the kept-routes outlet, whose Suspense
    // boundaries paint it while a screen's code loads.
    const fallback = pageSource.slice(
      pageSource.indexOf("<JobFinderKeptRoutesOutlet"),
      pageSource.indexOf("readyMarker="),
    );
    expect(fallback).toContain("RouteSkeleton");
    expect(fallback).not.toContain("fillAvailableViewport");
    expect(readSource("pages/job-finder-kept-routes.tsx")).toContain(
      "<Suspense fallback={props.fallback}",
    );
  });
});
