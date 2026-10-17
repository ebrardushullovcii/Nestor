import { describe, expect, test } from "vitest";
import {
  filterCandidateFacingResumeKeywords,
  filterGroundedVisibleSkills,
  isSpokenLanguageResumeChrome,
  looksLikeSpokenLanguageSkillEntry,
  skillsAreEquivalent,
} from "./resume-skill-grounding";
import { createFreshStartCandidateProfile } from "@nestor/contracts";

describe("filterCandidateFacingResumeKeywords", () => {
  test("drops schema enums and employment-type tokens that no resume should echo", () => {
    expect(
      filterCandidateFacingResumeKeywords([
        "FULL_TIME",
        "PART_TIME",
        "ON_SITE",
        "Full-time",
        "Remote",
        "React",
        "TypeScript",
        "PostgreSQL",
      ]),
    ).toEqual(["React", "TypeScript", "PostgreSQL"]);
  });

  test("keeps real technologies that happen to be capitalised", () => {
    expect(
      filterCandidateFacingResumeKeywords(["AWS", "SQL", "CI/CD", "GraphQL"]),
    ).toEqual(["AWS", "SQL", "CI/CD", "GraphQL"]);
  });
});

test("treats Postgres and PostgreSQL as the same grounded skill", () => {
  const empty = createFreshStartCandidateProfile();
  const profile = {
    ...empty,
    skills: ["PostgreSQL"],
    skillGroups: {
      ...empty.skillGroups,
      coreSkills: ["PostgreSQL"],
    },
  };

  expect(filterGroundedVisibleSkills(profile, ["Postgres", "Terraform"], 8)).toEqual([
    "Postgres",
  ]);
});

test("treats Postgres and PostgreSQL as equivalent skill names", () => {
  expect(skillsAreEquivalent("Postgres", "PostgreSQL")).toBe(true);
  expect(skillsAreEquivalent("k8s", "Kubernetes")).toBe(true);
  expect(skillsAreEquivalent("Go", "Terraform")).toBe(false);
  expect(skillsAreEquivalent("C#", "C++")).toBe(false);
});

test("recognizes Europass language chrome that must not become a skill", () => {
  expect(isSpokenLanguageResumeChrome("Mother Tongue(S) — ALBANIAN")).toBe(true);
  expect(
    isSpokenLanguageResumeChrome(
      "Levels — A1 and A2: Basic user; B1 and B2: Independent user; C1 and C2: Proficient user",
    ),
  ).toBe(true);
  expect(looksLikeSpokenLanguageSkillEntry("English — C2")).toBe(true);
  expect(looksLikeSpokenLanguageSkillEntry("Albanian — Native")).toBe(true);
  expect(looksLikeSpokenLanguageSkillEntry("PostgreSQL")).toBe(false);
});
