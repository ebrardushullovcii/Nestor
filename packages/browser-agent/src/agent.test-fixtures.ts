import type { CandidateProfile, ToolCall } from "@nestor/contracts";
import type { Page } from "playwright";
import type { AgentConfig } from "./types";

export function createProfile(): CandidateProfile {
  return {
    id: "candidate_1",
    firstName: "Alex",
    lastName: "Vanguard",
    middleName: null,
    fullName: "Alex Vanguard",
    preferredDisplayName: null,
    headline: "Workflow engineer",
    summary: "Builds reliable automation.",
    currentLocation: "London, UK",
    currentCity: null,
    currentRegion: null,
    currentCountry: null,
    timeZone: null,
    yearsExperience: 8,
    email: null,
    secondaryEmail: null,
    phone: null,
    portfolioUrl: null,
    linkedinUrl: null,
    githubUrl: null,
    personalWebsiteUrl: null,
    narrative: {
      professionalStory: null,
      nextChapterSummary: null,
      careerTransitionSummary: null,
      differentiators: [],
      motivationThemes: [],
    },
    proofBank: [],
    answerBank: {
      workAuthorization: null,
      visaSponsorship: null,
      relocation: null,
      travel: null,
      noticePeriod: null,
      availability: null,
      salaryExpectations: null,
      selfIntroduction: null,
      careerTransition: null,
      customAnswers: [],
    },
    applicationIdentity: {
      preferredEmail: null,
      preferredPhone: null,
      preferredLinkIds: [],
    },
    baseResume: {
      id: "resume_1",
      fileName: "resume.txt",
      uploadedAt: "2026-03-20T10:00:00.000Z",
      storagePath: null,
      textContent: "Resume text",
      textUpdatedAt: "2026-03-20T10:00:00.000Z",
      extractionStatus: "ready",
      lastAnalyzedAt: "2026-03-20T10:01:00.000Z",
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Built-in deterministic agent fallback",
      analysisWarnings: [],
    },
    workEligibility: {
      authorizedWorkCountries: [],
      requiresVisaSponsorship: null,
      willingToRelocate: null,
      preferredRelocationRegions: [],
      willingToTravel: null,
      remoteEligible: null,
      noticePeriodDays: null,
      availableStartDate: null,
      securityClearance: null,
    },
    professionalSummary: {
      shortValueProposition: null,
      fullSummary: null,
      careerThemes: [],
      leadershipSummary: null,
      domainFocusSummary: null,
      strengths: [],
    },
    skillGroups: {
      coreSkills: [],
      tools: [],
      languagesAndFrameworks: [],
      softSkills: [],
      highlightedSkills: [],
    },
    targetRoles: ["Workflow engineer"],
    locations: ["Remote"],
    skills: ["React"],
    experiences: [],
    education: [],
    certifications: [],
    links: [],
    projects: [],
    spokenLanguages: [],
  };
}

export function createConfig(): AgentConfig {
  return {
    source: "target_site",
    maxSteps: 4,
    targetJobCount: 1,
    userProfile: createProfile(),
    searchPreferences: {
      targetRoles: ["Workflow engineer"],
      locations: ["Remote"],
    },
    startingUrls: ["https://www.linkedin.com/jobs/search/"],
    navigationPolicy: {
      allowedHostnames: ["www.linkedin.com"],
    },
    promptContext: {
      siteLabel: "Primary target",
      taskPacket: {
        phase: "search_filter_probe",
        phaseGoal: "Verify job discovery routes.",
        knownFacts: ["Start from the search route."],
        priorPhaseSummary: null,
        avoidStrategyFingerprints: [
          "access_auth_probe:target_site:access auth probe",
        ],
        successCriteria: ["Reach the site", "Collect evidence"],
        stopConditions: ["Stop when enough evidence is collected."],
        manualPrerequisiteState: null,
        strategyLabel: "Search Filter Probe",
      },
    },
  };
}

export function createPage(): Pick<
  Page,
  "goto" | "waitForTimeout" | "url" | "title" | "locator" | "evaluate"
> {
  let currentUrl = "about:blank";
  const bodyLocator = {
    innerText() {
      return Promise.resolve(
        [
          "Search by title, skill, or company",
          "Workflow Engineer",
          "Signal Systems",
          "Remote",
          "Apply",
          "Job description",
          "Build resilient automation workflows for distributed teams.",
          "Responsibilities include search, filters, routing, and job discovery.",
          "Qualifications include React, TypeScript, automation, browser tooling, and workflow design.",
          "Benefits include remote work, health coverage, learning budget, and flexible hours.",
          "Use the search filters and recommendation collections to find relevant jobs quickly.",
          "This listing is part of a reusable jobs flow with visible controls and detail pages.",
        ]
          .join("\n")
          .repeat(3),
      );
    },
  };

  return {
    goto(url: string) {
      currentUrl = url;
      return Promise.resolve(null as never);
    },
    waitForTimeout() {
      return Promise.resolve(undefined);
    },
    url() {
      return currentUrl;
    },
    title() {
      return Promise.resolve("Primary target");
    },
    locator() {
      return bodyLocator as never;
    },
    evaluate() {
      return Promise.resolve([]);
    },
  };
}

export function createToolCall(
  name: string,
  args: Record<string, unknown>,
  id: string,
): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}
