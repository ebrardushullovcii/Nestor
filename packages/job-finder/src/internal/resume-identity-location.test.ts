import { describe, expect, test } from "vitest";
import { createSeed } from "../test-fixtures";
import {
  findResumeDraftIdentityConflicts,
  resolveResumeIdentity,
} from "./resume-identity";

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
      findResumeDraftIdentityConflicts(profile, {
        location: "Munich, Germany",
      }),
    ).toHaveLength(1);
  });
});

test("source identity reads beyond the old twelve-line window", () => {
  const profile = createSeed().profile;
  profile.baseResume = {
    ...profile.baseResume,
    sourceIdentity: undefined,
    textContent: [
      ...Array.from({ length: 20 }, (_, index) => `${index + 1}`),
      "Jamie Example",
      "jamie@example.test",
    ].join("\n"),
  };
  expect(
    resolveResumeIdentity(profile).mismatchReasons.some((reason) =>
      reason.includes("Jamie Example"),
    ),
  ).toBe(true);
});
