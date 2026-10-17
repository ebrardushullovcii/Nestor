import { describe, expect, it } from "vitest";
import {
  getTestWorkspaceOpeningHoldMs,
  TEST_WORKSPACE_OPENING_HOLD_ENV,
} from "./register-job-finder-bootstrap-routes";

describe("getTestWorkspaceOpeningHoldMs", () => {
  it("ignores the opening hold unless the desktop test API is enabled", () => {
    expect(
      getTestWorkspaceOpeningHoldMs({
        [TEST_WORKSPACE_OPENING_HOLD_ENV]: "1200",
      }),
    ).toBe(0);
  });

  it("uses a bounded integer hold when the desktop test API is enabled", () => {
    expect(
      getTestWorkspaceOpeningHoldMs({
        NESTOR_ENABLE_TEST_API: "1",
        [TEST_WORKSPACE_OPENING_HOLD_ENV]: "1200",
      }),
    ).toBe(1200);
    expect(
      getTestWorkspaceOpeningHoldMs({
        NESTOR_ENABLE_TEST_API: "true",
        [TEST_WORKSPACE_OPENING_HOLD_ENV]: "9000",
      }),
    ).toBe(5000);
    expect(
      getTestWorkspaceOpeningHoldMs({
        NESTOR_ENABLE_TEST_API: "1",
        [TEST_WORKSPACE_OPENING_HOLD_ENV]: "2.5",
      }),
    ).toBe(0);
  });
});
