import { describe, expect, test } from "vitest";
import {
  canNestedPaneConsumeWheel,
  getLockedHeaderSettleScrollTop,
  getLockedHeaderWheelTarget,
  getNestedPaneWheelTarget,
} from "./locked-screen-layout";

describe("canNestedPaneConsumeWheel", () => {
  test("gives the pane under the pointer first priority while it can move", () => {
    expect(
      canNestedPaneConsumeWheel({
        clientHeight: 400,
        deltaY: 120,
        scrollHeight: 1_200,
        scrollTop: 300,
      }),
    ).toBe(true);
    expect(
      canNestedPaneConsumeWheel({
        clientHeight: 400,
        deltaY: -120,
        scrollHeight: 1_200,
        scrollTop: 300,
      }),
    ).toBe(true);
  });

  test("hands wheel input back at the pane boundary", () => {
    expect(
      canNestedPaneConsumeWheel({
        clientHeight: 400,
        deltaY: 120,
        scrollHeight: 1_200,
        scrollTop: 800,
      }),
    ).toBe(false);
    expect(
      canNestedPaneConsumeWheel({
        clientHeight: 400,
        deltaY: -120,
        scrollHeight: 1_200,
        scrollTop: 0,
      }),
    ).toBe(false);
  });
});

describe("getNestedPaneWheelTarget", () => {
  test("moves the pane under the pointer without requiring focus", () => {
    expect(
      getNestedPaneWheelTarget({
        clientHeight: 400,
        deltaMode: 0,
        deltaY: 120,
        scrollHeight: 1_200,
        scrollTop: 300,
      }),
    ).toBe(420);
  });

  test("normalizes line and page wheel input and clamps to the pane", () => {
    expect(
      getNestedPaneWheelTarget({
        clientHeight: 400,
        deltaMode: 1,
        deltaY: 3,
        scrollHeight: 1_200,
        scrollTop: 300,
      }),
    ).toBe(348);
    expect(
      getNestedPaneWheelTarget({
        clientHeight: 400,
        deltaMode: 2,
        deltaY: 2,
        scrollHeight: 1_200,
        scrollTop: 300,
      }),
    ).toBe(800);
  });

  test("hands input back when the pane has reached its boundary", () => {
    expect(
      getNestedPaneWheelTarget({
        clientHeight: 400,
        deltaMode: 0,
        deltaY: 120,
        scrollHeight: 1_200,
        scrollTop: 800,
      }),
    ).toBeNull();
  });
});

describe("getLockedHeaderWheelTarget", () => {
  test("moves the wide locked layout header before a nested pane consumes downward wheel input", () => {
    expect(
      getLockedHeaderWheelTarget({
        deltaY: 120,
        scrollTop: 0,
        topHeight: 240,
        viewportWidth: 1440,
      }),
    ).toBe(120);
  });

  test("stops at the header boundary so the next wheel event reaches the nested pane", () => {
    expect(
      getLockedHeaderWheelTarget({
        deltaY: 120,
        scrollTop: 180,
        topHeight: 240,
        viewportWidth: 1440,
      }),
    ).toBe(240);
    expect(
      getLockedHeaderWheelTarget({
        deltaY: 120,
        scrollTop: 240,
        topHeight: 240,
        viewportWidth: 1440,
      }),
    ).toBeNull();
  });

  test("leaves narrow layouts alone and restores the wide header upward", () => {
    expect(
      getLockedHeaderWheelTarget({
        deltaY: 120,
        scrollTop: 0,
        topHeight: 240,
        viewportWidth: 1024,
      }),
    ).toBeNull();
    expect(
      getLockedHeaderWheelTarget({
        deltaY: -120,
        scrollTop: 120,
        topHeight: 240,
        viewportWidth: 1440,
      }),
    ).toBe(0);
    expect(
      getLockedHeaderWheelTarget({
        deltaY: -120,
        scrollTop: 0,
        topHeight: 240,
        viewportWidth: 1440,
      }),
    ).toBeNull();
  });

  test("does not consume header scroll when the outer route has no range", () => {
    expect(
      getLockedHeaderWheelTarget({
        deltaY: 120,
        maxScrollTop: 0,
        scrollTop: 0,
        topHeight: 240,
        viewportWidth: 1440,
      }),
    ).toBeNull();
  });
});

describe("getLockedHeaderSettleScrollTop", () => {
  test("never leaves the page header half-scrolled under the fixed shell", () => {
    expect(
      getLockedHeaderSettleScrollTop({
        direction: "down",
        scrollTop: 12,
        topHeight: 177,
      }),
    ).toBe(177);
    expect(
      getLockedHeaderSettleScrollTop({
        direction: "up",
        scrollTop: 160,
        topHeight: 177,
      }),
    ).toBe(0);
  });

  test("snaps an unknown-direction rest to the nearer header edge", () => {
    expect(
      getLockedHeaderSettleScrollTop({ scrollTop: 40, topHeight: 177 }),
    ).toBe(0);
    expect(
      getLockedHeaderSettleScrollTop({ scrollTop: 150, topHeight: 177 }),
    ).toBe(177);
  });

  test("leaves fully-in, fully-out, and range-less positions alone", () => {
    expect(
      getLockedHeaderSettleScrollTop({ scrollTop: 0, topHeight: 177 }),
    ).toBeNull();
    expect(
      getLockedHeaderSettleScrollTop({ scrollTop: 177, topHeight: 177 }),
    ).toBeNull();
    expect(
      getLockedHeaderSettleScrollTop({ scrollTop: 900, topHeight: 177 }),
    ).toBeNull();
    expect(
      getLockedHeaderSettleScrollTop({
        maxScrollTop: 0,
        scrollTop: 20,
        topHeight: 177,
      }),
    ).toBeNull();
    expect(
      getLockedHeaderSettleScrollTop({ scrollTop: 20, topHeight: 0 }),
    ).toBeNull();
  });

  test("snaps to the reachable boundary when the route cannot scroll a full header", () => {
    expect(
      getLockedHeaderSettleScrollTop({
        direction: "down",
        maxScrollTop: 90,
        scrollTop: 30,
        topHeight: 177,
      }),
    ).toBe(90);
  });
});
