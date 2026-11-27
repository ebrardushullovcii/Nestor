import { describe, expect, it } from "vitest";
import { resolvePanelPageBounds } from "./embedded-browser-layout";

const windowSize = { windowWidth: 1200, windowHeight: 800 };

describe("resolvePanelPageBounds", () => {
  it("rounds zoomed edges inward so the native view remains inside the panel", () => {
    expect(
      resolvePanelPageBounds({
        ...windowSize,
        viewport: { x: 10.3, y: 20.2, width: 750.2, height: 450.2 },
        zoom: 1.25,
      }),
    ).toEqual({ x: 13, y: 26, width: 937, height: 562 });
  });

  it("clips the panel when the window shrinks", () => {
    expect(
      resolvePanelPageBounds({
        ...windowSize,
        viewport: { x: 190, y: 220, width: 1150, height: 720 },
        zoom: 1,
      }),
    ).toEqual({ x: 190, y: 220, width: 1010, height: 580 });
  });

  it.each([
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 1200, y: 40, width: 300, height: 450 },
  ])("has no display bounds for %o", (viewport) => {
    expect(
      resolvePanelPageBounds({ ...windowSize, viewport, zoom: 1 }),
    ).toBeNull();
  });
});
