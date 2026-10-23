// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeptRouteHiddenContext } from "../lib/kept-route-visibility";
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
    let hidden = false;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KeptRouteHiddenContext.Provider value={hidden}>
        {children}
      </KeptRouteHiddenContext.Provider>
    );
    const view = renderHook(() => useSinceLastVisit("kept"), { wrapper });
    vi.setSystemTime(new Date("2026-10-23T10:05:00.000Z"));
    hidden = true;
    view.rerender();
    hidden = false;
    view.rerender();
    expect(view.result.current).toBe("2026-10-23T10:05:00.000Z");
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
