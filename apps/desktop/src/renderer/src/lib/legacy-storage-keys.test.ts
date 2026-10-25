// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import { migrateLegacyStorageKeys } from "./legacy-storage-keys";

describe("migrateLegacyStorageKeys", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("moves pre-rename preferences to their current keys", () => {
    window.localStorage.setItem("unemployed.appearance-theme", "dark");
    window.localStorage.setItem(
      "unemployed.interview-helper.last-job-finder-route",
      "/job-finder/applications",
    );
    window.localStorage.setItem("unrelated", "kept");

    migrateLegacyStorageKeys(window.localStorage);

    expect(window.localStorage.getItem("nestor.appearance-theme")).toBe("dark");
    expect(
      window.localStorage.getItem(
        "nestor.live-assistant.last-job-finder-route",
      ),
    ).toBe("/job-finder/applications");
    expect(
      window.localStorage.getItem("unemployed.appearance-theme"),
    ).toBeNull();
    expect(window.localStorage.getItem("unrelated")).toBe("kept");
  });

  test("moves Nordri preferences and prefers them over older UnEmployed ones", () => {
    window.localStorage.setItem("nordri.appearance-theme", "light");
    window.localStorage.setItem("unemployed.appearance-theme", "dark");
    window.localStorage.setItem(
      "nordri.job-finder.sidebar-collapsed.v1",
      "true",
    );

    migrateLegacyStorageKeys(window.localStorage);

    expect(window.localStorage.getItem("nestor.appearance-theme")).toBe(
      "light",
    );
    expect(
      window.localStorage.getItem("nestor.job-finder.sidebar-collapsed.v1"),
    ).toBe("true");
    expect(window.localStorage.getItem("nordri.appearance-theme")).toBeNull();
    expect(
      window.localStorage.getItem("unemployed.appearance-theme"),
    ).toBeNull();
  });

  test("keeps a value already saved under the current key", () => {
    window.localStorage.setItem("unemployed.appearance-theme", "dark");
    window.localStorage.setItem("nestor.appearance-theme", "light");

    migrateLegacyStorageKeys(window.localStorage);

    expect(window.localStorage.getItem("nestor.appearance-theme")).toBe(
      "light",
    );
    expect(
      window.localStorage.getItem("unemployed.appearance-theme"),
    ).toBeNull();
  });
});
