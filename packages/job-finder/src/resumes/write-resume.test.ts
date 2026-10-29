import type {
  CandidateProfile,
  ResumeDraft,
  SavedJob,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createSeed } from "../test-fixtures";
import {
  addMissingListingSkills,
  compactPercentageText,
  compressOlderRoles,
  isPlausibleAggressiveHeadline,
  isResumeHardSkill,
  orderBulletsMetricsFirst,
  stripGenericPurposeClauseTexts,
  stripRepeatedAppendedClauseTexts,
  summaryWithoutRepeatedBulletPhrases,
} from "./write-resume";

function profileWith(
  headline: string,
  titles: readonly string[],
  yearsExperience: number,
): CandidateProfile {
  const seed = createSeed().profile;
  const template = seed.experiences[0]!;
  return {
    ...seed,
    headline,
    yearsExperience,
    experiences: titles.map((title, index) => ({
      ...template,
      id: `experience_${index}`,
      title,
      isCurrent: index === 0,
    })),
  };
}

describe("aggressive headline policy", () => {
  it.each([
    ["Backend Engineer", "Principal Frontend Engineer", 12, false],
    ["Software Engineer", "Software Developer", 6, true],
    ["Lifecycle Marketing Manager", "Marketing Manager", 9, true],
    ["Instructional Designer", "Teacher", 8, true],
    ["Senior Software Engineer", "Software Engineer", 6, true],
    [
      "Senior AI Data & Analytics Engineer II",
      "Principal Frontend Engineer",
      15,
      true,
    ],
    ["Senior Software Engineer", "Software Engineer", 2, false],
    ["Engineering Manager", "Senior Software Engineer", 10, true],
    ["Director of Engineering", "Engineering Manager", 12, false],
    ["Registered Nurse", "Teacher", 10, false],
    ["Director Registered Nurse", "Teacher", 10, false],
    ["Director Data Analyst", "Data Science Student", 1, false],
    ["Junior Marketing Coordinator", "Marketing Director", 17, false],
    ["Backend Engineer", "Warehouse Operations Manager", 10, false],
  ])("%s for a %s (%i years) is %s", (target, ownTitle, years, expected) => {
    expect(
      isPlausibleAggressiveHeadline(
        target,
        profileWith(ownTitle, [ownTitle], years),
      ),
    ).toBe(expected);
  });
});

describe("repeated appended clauses", () => {
  it("keeps the first use and strips the same padding from later bullets", () => {
    expect(
      stripRepeatedAppendedClauseTexts([
        "Built internal APIs with SQL and automated tests",
        "Led the migration to a new billing platform with SQL and automated tests",
        "Improved release reliability with SQL and automated tests",
        "Mentored two engineers",
      ]),
    ).toEqual([
      "Built internal APIs with SQL and automated tests",
      "Led the migration to a new billing platform",
      "Improved release reliability",
      "Mentored two engineers",
    ]);
  });

  it("leaves a phrase alone when it appears fewer than three times", () => {
    const texts = [
      "Built internal APIs with SQL and automated tests",
      "Improved release reliability with SQL and automated tests",
      "Mentored two engineers",
    ];
    expect(stripRepeatedAppendedClauseTexts(texts)).toEqual(texts);
  });

  it("does not shorten a bullet so far that it loses its meaning", () => {
    const texts = [
      "Shipped it with SQL and automated tests",
      "Fixed it with SQL and automated tests",
      "Tuned it with SQL and automated tests",
    ];
    expect(stripRepeatedAppendedClauseTexts(texts)).toEqual(texts);
  });
});

describe("metric-first bullet order", () => {
  it("keeps a role's numbered proof above its prose, preserving order inside each group", () => {
    expect(
      orderBulletsMetricsFirst([
        { text: "Led the platform team" },
        { text: "Cut page load time by 42 percent" },
        { text: "Built a design system" },
        { text: "Mentored 6 engineers" },
      ]).map((bullet) => bullet.text),
    ).toEqual([
      "Cut page load time by 42 percent",
      "Mentored 6 engineers",
      "Led the platform team",
      "Built a design system",
    ]);
  });
});

describe("ATS skill filtering", () => {
  it.each([
    ["Terraform", true],
    ["Snowflake", true],
    ["Data Pipelines", true],
    ["REST APIs", true],
    ["ETL/ELT", true],
    ["C#", true],
    ["Go", true],
    ["AI", true],
    ["Video-Based Safety", false],
    ["Vehicle Telematics", false],
    ["Equipment Monitoring", false],
    ["Driver Workflows", false],
    ["Apps", false],
    ["Willingness to learn", false],
  ])("%s is %s", (skill, expected) => {
    expect(isResumeHardSkill(skill)).toBe(expected);
  });
});

describe("generic purpose clauses", () => {
  it("removes trailing filler that repeats the bullet's own outcome", () => {
    expect(
      stripGenericPurposeClauseTexts([
        "Cut page load time by 42 percent with code splitting and image optimization to improve performance.",
        "Built accessible component system with automated browser and accessibility tests to improve reliability of interfaces.",
        "Improved keyboard navigation and screen-reader support on three public services to improve accessibility.",
        "Worked with backend engineers on a shared API contract and test fixtures supporting APIs.",
        "Partnered with design and product to ship multi-quarter design system roadmap, collaborating across product and engineering.",
        "Delivered responsive web applications for civic and logistics clients working with a small team.",
        "Built checkout and order-tracking pages for a high-traffic retail site.",
        "Rebuilt account-management frontend around shared React components for maintainable delivery.",
        "Wrote setup notes that shortened new-project onboarding, supporting developer tools.",
      ]),
    ).toEqual([
      "Cut page load time by 42 percent with code splitting and image optimization.",
      "Built accessible component system with automated browser and accessibility tests.",
      "Improved keyboard navigation and screen-reader support on three public services.",
      "Worked with backend engineers on a shared API contract and test fixtures.",
      "Partnered with design and product to ship multi-quarter design system roadmap.",
      "Delivered responsive web applications for civic and logistics clients.",
      "Built checkout and order-tracking pages for a high-traffic retail site.",
      "Rebuilt account-management frontend around shared React components.",
      "Wrote setup notes that shortened new-project onboarding.",
    ]);
  });
});

describe("older role compression", () => {
  it("keeps one numbered bullet on roles older than 12 years and leaves recent roles alone", () => {
    const draft = {
      sections: [
        {
          kind: "experience",
          entries: [
            {
              id: "old",
              isCurrent: false,
              endDate: "2010-08",
              dateRange: "Jun 2008 – Aug 2010",
              included: true,
              bullets: [
                {
                  id: "old_1",
                  text: "Maintained client sites",
                  included: true,
                },
                {
                  id: "old_2",
                  text: "Cut load time by 30 percent",
                  included: true,
                },
                { id: "old_3", text: "Fixed layout bugs", included: true },
              ],
            },
            {
              id: "recent",
              isCurrent: false,
              endDate: "2020-08",
              dateRange: "Jun 2017 – Aug 2020",
              included: true,
              bullets: [
                { id: "new_1", text: "Rebuilt the frontend", included: true },
                { id: "new_2", text: "Mentored engineers", included: true },
                { id: "new_3", text: "Shipped design tokens", included: true },
              ],
            },
          ],
        },
      ],
    } as unknown as ResumeDraft;
    const result = compressOlderRoles(draft, new Date("2026-10-28T00:00:00Z"));
    const entries = result.sections[0]!.entries;
    expect(
      entries[0]!.bullets.filter((bullet) => bullet.included).map((b) => b.id),
    ).toEqual(["old_2"]);
    expect(
      entries[1]!.bullets.filter((bullet) => bullet.included).map((b) => b.id),
    ).toEqual(["new_1", "new_2", "new_3"]);
  });
});

describe("percentage formatting", () => {
  it("uses the percent sign", () => {
    expect(compactPercentageText("Cut by 42 percent and 3.5 percent.")).toBe(
      "Cut by 42% and 3.5%.",
    );
  });
});

describe("listing skill fallback", () => {
  it("adds multiword hard skills found in the listing prose", () => {
    const draft = {
      sections: [
        {
          id: "section_skills",
          kind: "skills",
          bullets: [],
          entries: [],
        },
      ],
    } as unknown as ResumeDraft;
    const job = {
      title: "Frontend Engineer",
      company: "Paper Orbit Studio",
      description: "Build data pipelines and developer tools.",
      keySkills: [],
      responsibilities: [],
      minimumQualifications: [],
      preferredQualifications: [],
    } as unknown as SavedJob;
    const result = addMissingListingSkills(draft, job);
    expect(result.sections[0]!.bullets.map((bullet) => bullet.text)).toEqual(
      expect.arrayContaining(["data pipelines", "developer tools"]),
    );
  });
});

describe("summary deduplication", () => {
  it("drops a later summary sentence that repeats a shown bullet", () => {
    const summary =
      "Frontend Engineer with 16 years building accessible web applications, design systems and platform tooling with TypeScript. Led React and TypeScript platform used by 18 product teams, built accessible component system with automated browser and accessibility tests, and cut page load time by 42 percent.";
    expect(
      summaryWithoutRepeatedBulletPhrases(summary, [
        "Led architecture for React and TypeScript platform used by 18 product teams.",
        "Built accessible component system with automated browser and accessibility tests.",
      ]),
    ).toBe(
      "Frontend Engineer with 16 years building accessible web applications, design systems and platform tooling with TypeScript.",
    );
  });
});

it("detects restored source prose beside translated fields without assuming a language or script", async () => {
  const { hasUntranslatedResumeSourceProse } =
    await import("../internal/resume-workspace-language");
  const { seedResumeDraft } =
    await import("../internal/resume-workspace-structure");
  const seed = createSeed();
  const profile = {
    ...seed.profile,
    summary: "Built accessible public services with measurable results.",
  };
  const draft = seedResumeDraft({
    profile,
    job: seed.savedJobs[0]!,
    templateId: seed.settings.resumeTemplateId,
  });
  draft.writtenLanguage = "German";
  expect(hasUntranslatedResumeSourceProse(draft, profile)).toBe(false);
  draft.sections[0]!.sourceRefs.push({
    id: "original",
    sourceKind: "resume",
    sourceId: `draft:${draft.id}:field:headline`,
    snippet: "Engineer",
  });
  expect(hasUntranslatedResumeSourceProse(draft, profile)).toBe(true);
  profile.summary = "";
  profile.experiences = [];
  profile.projects = [];
  expect(hasUntranslatedResumeSourceProse(draft, profile)).toBe(false);
});
