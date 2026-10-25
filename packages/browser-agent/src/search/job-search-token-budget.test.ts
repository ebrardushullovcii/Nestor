import { readFileSync } from "node:fs";
import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test } from "vitest";

import type { AgentConfig } from "../types";
import { buildExtractionSelectionContext } from "./job-search-agent";
import { createJobSearchPrompts } from "./job-search-prompts";

/**
 * A synthetic profile at the scale of a long-used workspace: the Lina Haddad
 * persona's resume plus ten roles, forty saved answers, projects and proof
 * points. Every value is fictional.
 */
function largeSyntheticProfile() {
  const persona = readFileSync(
    new URL(
      "../../../../apps/desktop/test-fixtures/job-finder/resume-import-personas/lina-haddad.txt",
      import.meta.url,
    ),
    "utf8",
  );
  const experiences = Array.from({ length: 10 }, (_, index) => ({
    id: `experience_${index}`,
    title: index === 0 ? "Working Student, Data Analytics" : `Data Analyst ${index}`,
    companyName: `Example Analytics ${index} GmbH`,
    location: "Berlin, Germany",
    startDate: `${2014 + index}-01`,
    endDate: index === 0 ? null : `${2015 + index}-01`,
    isCurrent: index === 0,
    summary: `Owned the weekly reporting cycle for team ${index}: gathered requirements from operations leads, modelled the data in SQL, and kept dashboards accurate while the business changed underneath them.`,
    achievements: Array.from(
      { length: 6 },
      (_, item) =>
        `Built report ${item} for team ${index} in Looker Studio and BigQuery, replacing ${item + 2} manual spreadsheets and saving about ${item + 3} hours a week.`,
    ),
    skills: ["SQL", "BigQuery", "Looker Studio", "Python", "pandas"],
  }));
  const resumeText = [
    persona,
    "Additional experience",
    ...experiences.flatMap((role) => [
      `${role.title} - ${role.companyName} - ${role.startDate} to ${role.endDate ?? "present"}`,
      role.summary,
      ...role.achievements.map((line) => `* ${line}`),
    ]),
  ].join("\n");
  return CandidateProfileSchema.parse({
    id: "candidate_large",
    firstName: "Lina",
    lastName: "Haddad",
    fullName: "Lina Haddad",
    headline: "Data analyst and data science student",
    summary:
      "Data science student who builds dependable reporting for operations teams with SQL, Python and BI tools.",
    currentLocation: "Berlin, Germany",
    currentCountry: "Germany",
    yearsExperience: 3,
    email: "lina.haddad@example.com",
    phone: "+49 151 5550 1234",
    githubUrl: "https://github.com/lina-haddad-example",
    baseResume: {
      id: "resume_large",
      fileName: "lina-haddad.txt",
      uploadedAt: "2026-09-01T09:00:00.000Z",
      textContent: resumeText,
      textUpdatedAt: "2026-09-01T09:00:00.000Z",
      extractionStatus: "ready",
    },
    workEligibility: {
      authorizedWorkCountries: ["Germany"],
      requiresVisaSponsorship: true,
      limitedWorkPermissions: [
        {
          country: "Germany",
          conditions: "Student residence permit: up to 20 hours a week.",
          requiresFutureSponsorship: true,
        },
      ],
    },
    answerBank: {
      workAuthorization:
        "German residence permit for study; EU Blue Card needed for full-time roles after graduation.",
      availability: "20 hours a week during the semester.",
      customAnswers: Array.from({ length: 40 }, (_, index) => ({
        id: `answer_${index}`,
        label: `Saved answer ${index}`,
        question: `Tell us about a time you improved a reporting process (variant ${index}).`,
        answer: `At Example Analytics ${index % 10} I replaced several manual spreadsheets with a SQL model and a dashboard, agreed definitions with the operations leads, and documented every metric so the team could trust the numbers without asking me each week. The change saved roughly ${index + 2} hours a week.`,
      })),
    },
    narrative: {
      professionalStory:
        "Moved from statistics into data science through hands-on analytics work for operations teams.",
      nextChapterSummary:
        "Looking for a data analyst or junior data scientist role in Berlin after graduation.",
      differentiators: ["Turns messy spreadsheets into trusted dashboards"],
      motivationThemes: ["forecasting", "operations analytics"],
    },
    proofBank: Array.from({ length: 10 }, (_, index) => ({
      id: `proof_${index}`,
      title: `Reporting win ${index}`,
      claim: `Replaced ${index + 2} manual spreadsheets with one SQL model and dashboard used every week by the operations team.`,
      supportingContext:
        "Agreed metric definitions with operations leads and documented them.",
    })),
    targetRoles: ["Data Analyst", "Junior Data Scientist"],
    locations: ["Berlin, Germany"],
    skills: Array.from({ length: 40 }, (_, index) => `Analytics skill ${index}`),
    experiences,
    education: [
      {
        id: "education_0",
        degree: "M.Sc.",
        fieldOfStudy: "Data Science",
        schoolName: "Technische Universität Berlin",
      },
      {
        id: "education_1",
        degree: "B.Sc.",
        fieldOfStudy: "Statistics",
        schoolName: "American University of Beirut",
      },
    ],
    projects: Array.from({ length: 6 }, (_, index) => ({
      id: `project_${index}`,
      name: `Forecasting project ${index}`,
      summary:
        "Forecast bike-sharing demand from weather data with LightGBM and a small feature pipeline in Python.",
      skills: ["Python", "LightGBM"],
    })),
  });
}

function searchConfig(siteLabel: string, startingUrl: string): AgentConfig {
  return {
    source: "target_site",
    maxSteps: 60,
    targetJobCount: 20,
    userProfile: largeSyntheticProfile(),
    searchPreferences: {
      targetRoles: ["Data Analyst", "Junior Data Scientist"],
      locations: ["Berlin, Germany"],
      workModes: ["hybrid"],
    },
    startingUrls: [startingUrl],
    navigationPolicy: { allowedHostnames: [new URL(startingUrl).hostname] },
    promptContext: {
      siteLabel,
      searchGuidance: {
        selectivity: "balanced",
        remoteCountsAsAnyLocation: true,
      },
      searchRequest: {
        intent: "Part-time analytics roles",
        freshness: "any",
        sourceIds: "all",
      },
      siteInstructions: [`On ${siteLabel}, use the search box.`],
    },
  };
}

test("a page read gets the goals, eligibility and request, not the whole profile", () => {
  const config = searchConfig("Example Board", "https://jobs.example.test/");
  const profileChars = JSON.stringify(config.userProfile).length;
  const context = buildExtractionSelectionContext(config, [
    {
      url: "https://jobs.example.test/1",
      category: "role",
      reason: "Sales role",
    },
  ]);
  const parsed = JSON.parse(context) as Record<string, unknown>;

  console.info(
    `[token budget] page-read selection context: ${context.length} chars (whole profile alone: ${profileChars})`,
  );
  expect(profileChars).toBeGreaterThan(40_000);
  expect(context.length).toBeLessThan(2_000);
  expect(parsed).toMatchObject({
    targetRoles: ["Data Analyst", "Junior Data Scientist"],
    locations: ["Berlin, Germany"],
    workModes: ["hybrid"],
    request: { intent: "Part-time analytics roles" },
    searchGuidance: { selectivity: "balanced" },
    sourceInstructions: ["On Example Board, use the search box."],
    pageDecisions: [{ url: "https://jobs.example.test/1", category: "role" }],
    person: {
      currentLocation: "Berlin, Germany",
      workEligibility: {
        authorizedWorkCountries: ["Germany"],
        requiresVisaSponsorship: true,
      },
      availability: "20 hours a week during the semester.",
    },
  });
  expect(
    (parsed.person as { workAuthorization: string }).workAuthorization,
  ).toContain("EU Blue Card");
  for (const absent of [
    "lina.haddad@example.com",
    "+49 151",
    "Saved answer 0",
    "Additional experience",
    "Built report 0",
  ]) {
    expect(context).not.toContain(absent);
  }
});

test("the search prompt leaves out the resume and role write-ups and shares one prefix across sites", () => {
  const first = createJobSearchPrompts(
    searchConfig("Example Board", "https://jobs.example.test/"),
  );
  const second = createJobSearchPrompts(
    searchConfig("Other Careers", "https://careers.other.test/"),
  );

  console.info(
    `[token budget] search system prompt: ${first.system.length} chars`,
  );
  expect(first.system.length).toBeLessThan(9_000);
  expect(first.system).not.toContain("Additional experience");
  expect(first.system).not.toContain("Built report 0");
  expect(first.system).not.toContain("Owned the weekly reporting cycle");
  // What fit needs to cast the net stays.
  expect(first.system).toContain("Data Analyst 1 · at Example Analytics 1 GmbH");
  expect(first.system).toContain("Data analyst and data science student");
  expect(first.system).toContain("EU Blue Card");
  expect(first.system).toContain('"Part-time analytics roles"');

  const marker = "\nThis site: ";
  const firstPrefix = first.system.slice(0, first.system.indexOf(marker));
  const secondPrefix = second.system.slice(0, second.system.indexOf(marker));
  expect(firstPrefix.length).toBeGreaterThan(first.system.length * 0.8);
  expect(firstPrefix).toBe(secondPrefix);
  expect(firstPrefix).not.toContain("Example Board");
  expect(first.system.slice(firstPrefix.length)).toContain(
    "This site: Example Board.",
  );
  expect(first.system.slice(firstPrefix.length)).toContain(
    "On Example Board, use the search box.",
  );
});
