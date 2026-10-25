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
});
