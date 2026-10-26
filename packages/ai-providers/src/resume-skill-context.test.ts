import { describe, expect, test } from "vitest";
import { buildResumeSkillContextFilter } from "./resume-skill-context";
import { createProfile } from "./test-fixtures";

describe("generated skill context", () => {
  test.each([
    { location: "Wellington, New Zealand" },
    { minimumQualifications: ["Must be authorized to work in New Zealand."] },
    { description: "Location: New Zealand" },
  ])("excludes a place and its fragments from job context: %j", (job) => {
    const accepts = buildResumeSkillContextFilter(job);
    for (const candidate of ["New Zealand", "New", "Zealand"]) {
      expect(accepts(candidate)).toBe(false);
    }
    expect(accepts("Terraform")).toBe(true);
  });

  test.each(["location", "eligibility"])(
    "uses profile %s context even when the job omits it",
    (source) => {
      const profile = createProfile();
      if (source === "location") profile.currentLocation = "New Zealand";
      if (source === "eligibility")
        profile.workEligibility.authorizedWorkCountries = ["New Zealand"];
      const accepts = buildResumeSkillContextFilter({}, profile);
      expect(accepts("New Zealand")).toBe(false);
      expect(accepts("Zealand")).toBe(false);
    },
  );

  test("keeps a competency independently requested beside an eligibility clause", () => {
    const accepts = buildResumeSkillContextFilter({
      location: "Go, New Zealand",
      minimumQualifications: [
        "Must be authorized to work in New Zealand and experience with Go required.",
      ],
    });
    expect(accepts("Go")).toBe(true);
    expect(accepts("Zealand")).toBe(false);
    expect(accepts("authorized to work in New Zealand")).toBe(false);
  });

  test("a repeated country in listing headers is still a place", () => {
    const accepts = buildResumeSkillContextFilter({
      location: "Remote, New Zealand",
      description: "Work across New Zealand.",
      minimumQualifications: ["Must be authorized to work in New Zealand."],
    });
    expect(accepts("New Zealand")).toBe(false);
    expect(accepts("Zealand")).toBe(false);
  });

  test("does not reject ordinary technical authorization skills", () => {
    const accepts = buildResumeSkillContextFilter({
      minimumQualifications: [
        "Experience with OAuth authorization and identity management.",
      ],
    });
    expect(accepts("OAuth authorization")).toBe(true);
  });
});
