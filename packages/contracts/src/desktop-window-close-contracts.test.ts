import { describe, expect, it } from "vitest";

import {
  DesktopWindowCloseDecisionSchema,
  DesktopWindowCloseGuardStateSchema,
  DesktopWindowCloseRequestSchema,
  DesktopWindowCloseResolutionSchema,
} from "./index";

describe("desktop window close guard contracts", () => {
  it("parses the renderer-owned protection mirror as a strict boolean flag", () => {
    expect(
      DesktopWindowCloseGuardStateSchema.parse({ blocked: true }),
    ).toEqual({ blocked: true });
    expect(() =>
      DesktopWindowCloseGuardStateSchema.parse({ blocked: "yes" }),
    ).toThrow();
  });

  it("requires a non-empty request id for close requests", () => {
    const parsed = DesktopWindowCloseRequestSchema.parse({
      requestId: "window_close_1",
    });

    expect(parsed.requestId).toBe("window_close_1");
    expect(() => DesktopWindowCloseRequestSchema.parse({})).toThrow();
    expect(() =>
      DesktopWindowCloseRequestSchema.parse({ requestId: "   " }),
    ).toThrow();
  });

  it("limits close resolutions to the proceed and cancel decisions", () => {
    expect(
      DesktopWindowCloseResolutionSchema.parse({
        requestId: "window_close_1",
        decision: "cancel",
      }),
    ).toEqual({ requestId: "window_close_1", decision: "cancel" });

    expect(
      DesktopWindowCloseDecisionSchema.options,
    ).toEqual(["proceed", "cancel"]);

    expect(() =>
      DesktopWindowCloseResolutionSchema.parse({
        requestId: "window_close_1",
        decision: "destroy",
      }),
    ).toThrow();
    expect(() =>
      DesktopWindowCloseResolutionSchema.parse({ decision: "proceed" }),
    ).toThrow();
  });
});
