import { describe, expect, it } from "vitest";

import {
  deviceTimeZone,
  formatDeviceTimestamp,
  formatPlanTimestamp,
  inferProfileTimeZone,
} from "./job-finder-timestamp-format";

describe("job finder timestamp clocks", () => {
  it("uses the device zone for events and the plan zone only for schedule times", () => {
    const instant = "2026-09-12T13:00:00.000Z";
    const event = formatDeviceTimestamp(instant);
    const scheduled = formatPlanTimestamp(instant, "America/Chicago");
    const expectedEvent = new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      timeZone: deviceTimeZone(),
      timeZoneName: "short",
    }).format(new Date(instant));

    expect(event).toBe(expectedEvent);
    expect(scheduled).toBe(
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        month: "short",
        timeZone: "America/Chicago",
        timeZoneName: "short",
      }).format(new Date(instant)),
    );
  });

  it("defaults a new schedule from a recognizable profile location", () => {
    expect(
      inferProfileTimeZone({
        currentLocation: "Chicago",
        currentRegion: "Illinois",
        currentCountry: "United States",
      }),
    ).toEqual({ timeZone: "America/Chicago", source: "profile" });
    expect(
      inferProfileTimeZone({
        currentLocation: "Lisbon",
        currentCountry: "Portugal",
      }),
    ).toEqual({ timeZone: "Europe/Lisbon", source: "profile" });
    expect(inferProfileTimeZone({ currentLocation: "Philadelphia, PA" })).toEqual({
      timeZone: "America/New_York",
      source: "profile",
    });
    expect(inferProfileTimeZone({ currentLocation: "Prishtina, Kosovo" })).toEqual({
      timeZone: "Europe/Belgrade",
      source: "profile",
    });
  });
});

it("prefers an explicit profile zone over inferred city and falls back for invalid zones", () => {
  expect(
    inferProfileTimeZone({
      timeZone: "America/Los_Angeles",
      currentLocation: "Denver",
    }),
  ).toEqual({ timeZone: "America/Los_Angeles", source: "profile" });
  expect(
    inferProfileTimeZone({ timeZone: "Not/A_Zone", currentLocation: "Denver" })
      .timeZone,
  ).toBe("America/Denver");
});
