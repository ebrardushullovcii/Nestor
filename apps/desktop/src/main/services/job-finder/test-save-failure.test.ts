import { afterEach, describe, expect, test } from "vitest";

import {
  armJobFinderTestSaveFailure,
  clearArmedJobFinderTestSaveFailure,
  consumeArmedJobFinderTestSaveFailure,
  getArmedJobFinderTestSaveFailureSurface,
  jobFinderSaveChannels,
} from "./test-save-failure";

const enabledEnv = { NESTOR_ENABLE_TEST_API: "1" } as NodeJS.ProcessEnv;
const disabledEnv = {} as NodeJS.ProcessEnv;

afterEach(() => {
  clearArmedJobFinderTestSaveFailure();
});

describe("job finder synthetic save failure", () => {
  test("is inert until a surface is armed", () => {
    expect(getArmedJobFinderTestSaveFailureSurface()).toBeNull();

    for (const channel of jobFinderSaveChannels) {
      expect(() =>
        consumeArmedJobFinderTestSaveFailure(channel, enabledEnv),
      ).not.toThrow();
    }
  });

  test("cannot be armed while the desktop test API is disabled", () => {
    expect(() => armJobFinderTestSaveFailure("profile", disabledEnv)).toThrow(
      /Desktop test API is disabled/,
    );
    expect(getArmedJobFinderTestSaveFailureSurface()).toBeNull();

    expect(() =>
      consumeArmedJobFinderTestSaveFailure(
        "job-finder:save-profile",
        disabledEnv,
      ),
    ).not.toThrow();
  });

  test("rejects a surface that is not one of the supported surfaces", () => {
    expect(() => armJobFinderTestSaveFailure("browser", enabledEnv)).toThrow();
    expect(() => armJobFinderTestSaveFailure(null, enabledEnv)).toThrow();
    expect(getArmedJobFinderTestSaveFailureSurface()).toBeNull();
  });

  test("fails exactly the next save on the armed surface and then clears", () => {
    armJobFinderTestSaveFailure("profile", enabledEnv);
    expect(getArmedJobFinderTestSaveFailureSurface()).toBe("profile");

    expect(() =>
      consumeArmedJobFinderTestSaveFailure(
        "job-finder:save-profile",
        enabledEnv,
      ),
    ).toThrow(/could not write the profile change/);

    // One-shot: the arm cleared itself while throwing.
    expect(getArmedJobFinderTestSaveFailureSurface()).toBeNull();
    expect(() =>
      consumeArmedJobFinderTestSaveFailure(
        "job-finder:save-profile",
        enabledEnv,
      ),
    ).not.toThrow();
  });

  test("fails only channels the armed surface owns", () => {
    armJobFinderTestSaveFailure("settings", enabledEnv);

    // A profile or resume save while `settings` is armed must be untouched,
    // and must not consume the arm.
    expect(() =>
      consumeArmedJobFinderTestSaveFailure(
        "job-finder:save-profile",
        enabledEnv,
      ),
    ).not.toThrow();
    expect(() =>
      consumeArmedJobFinderTestSaveFailure(
        "job-finder:save-resume-draft",
        enabledEnv,
      ),
    ).not.toThrow();
    expect(getArmedJobFinderTestSaveFailureSurface()).toBe("settings");

    expect(() =>
      consumeArmedJobFinderTestSaveFailure(
        "job-finder:update-appearance-theme",
        enabledEnv,
      ),
    ).toThrow(/could not write the settings change/);
    expect(getArmedJobFinderTestSaveFailureSurface()).toBeNull();
  });

  test("drops a stale arm instead of applying it without the test API", () => {
    armJobFinderTestSaveFailure("resume", enabledEnv);

    expect(() =>
      consumeArmedJobFinderTestSaveFailure(
        "job-finder:save-resume-draft",
        disabledEnv,
      ),
    ).not.toThrow();
    expect(getArmedJobFinderTestSaveFailureSurface()).toBeNull();
  });

  test("covers every protected surface with at least one owned channel", () => {
    for (const surface of [
      "profile",
      "answers",
      "settings",
      "resume",
      "campaign",
    ]) {
      armJobFinderTestSaveFailure(surface, enabledEnv);
      const failures = jobFinderSaveChannels.filter((channel) => {
        try {
          consumeArmedJobFinderTestSaveFailure(channel, enabledEnv);
          return false;
        } catch {
          return true;
        }
      });

      expect(failures).toHaveLength(1);
      expect(getArmedJobFinderTestSaveFailureSurface()).toBeNull();
    }
  });
});
