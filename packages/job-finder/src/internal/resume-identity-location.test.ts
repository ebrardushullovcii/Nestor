import { describe, expect, test } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import { findResumeDraftIdentityConflicts } from "./resume-identity";

describe("resume header location against the profile identity", () => {
  const profile = {
    ...createSeed().profile,
    currentLocation: "Berlin, Germany",
  };

  test("a location that keeps the profile's place with a note added is not a mismatch", () => {
    expect(
      findResumeDraftIdentityConflicts(profile, {
        location: "Berlin, Germany (open to remote)",
      }),
    ).toEqual([]);
  });

  test("a location that drops the profile's place still counts as a mismatch", () => {
    expect(
      findResumeDraftIdentityConflicts(profile, { location: "Munich, Germany" }),
    ).toHaveLength(1);
  });
});
