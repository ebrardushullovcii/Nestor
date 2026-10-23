// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKeptRouteVisibility,
  KeptRouteVisibilityContext,
} from "../lib/kept-route-visibility";
import { isNewSinceVisit, useSinceLastVisit } from "./use-since-last-visit";

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("useSinceLastVisit", () => {
  it("marks nothing on a first visit and the time the window closed on the next", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T09:00:00.000Z"));
    const first = renderHook(() => useSinceLastVisit("test"));
    expect(first.result.current).toBeNull();
    vi.setSystemTime(new Date("2026-10-23T09:30:00.000Z"));
    window.dispatchEvent(new Event("pagehide"));
    first.unmount();

    const again = renderHook(() => useSinceLastVisit("test"));
    expect(again.result.current).toBe("2026-10-23T09:30:00.000Z");
  });

  it("counts a screen kept behind another one as left", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T10:00:00.000Z"));
    const visibility = createKeptRouteVisibility(false);
    const jobs = [{ firstSeenAt: "2026-10-23T10:10:00.000Z" }];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KeptRouteVisibilityContext.Provider value={visibility}>
        {children}
      </KeptRouteVisibilityContext.Provider>
    );
    const view = renderHook(() => useSinceLastVisit("kept", jobs), {
      wrapper,
    });
    vi.setSystemTime(new Date("2026-10-23T10:05:00.000Z"));
    act(() => visibility.setHidden(true));
    act(() => visibility.setHidden(false));
    expect(view.result.current).toBe("2026-10-23T10:05:00.000Z");
  });

  it("does not re-render a screen shown again when no job's mark changes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T10:00:00.000Z"));
    window.localStorage.setItem(
      "nestor.job-finder.last-visit.same",
      "2026-10-23T09:00:00.000Z",
    );
    const visibility = createKeptRouteVisibility(false);
    const jobs = [{ firstSeenAt: "2026-10-23T08:00:00.000Z" }];
    let renders = 0;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KeptRouteVisibilityContext.Provider value={visibility}>
        {children}
      </KeptRouteVisibilityContext.Provider>
    );
    const view = renderHook(
      () => {
        renders += 1;
        return useSinceLastVisit("same", jobs);
      },
      { wrapper },
    );
    const before = renders;
    vi.setSystemTime(new Date("2026-10-23T10:05:00.000Z"));
    act(() => visibility.setHidden(true));
    act(() => visibility.setHidden(false));
    expect(renders).toBe(before);
    expect(view.result.current).toBe("2026-10-23T09:00:00.000Z");
  });
});

describe("isNewSinceVisit", () => {
  it("is new only when first seen after the last visit ended", () => {
    const end = "2026-10-23T09:30:00.000Z";
    expect(
      isNewSinceVisit({ firstSeenAt: "2026-10-23T09:31:00.000Z" }, end),
    ).toBe(true);
    expect(
      isNewSinceVisit({ firstSeenAt: "2026-10-23T09:29:00.000Z" }, end),
    ).toBe(false);
    expect(
      isNewSinceVisit({ discoveredAt: "2026-10-23T10:00:00.000Z" }, end),
    ).toBe(true);
    expect(
      isNewSinceVisit({ firstSeenAt: "2026-10-23T10:00:00.000Z" }, null),
    ).toBe(false);
  });
});
