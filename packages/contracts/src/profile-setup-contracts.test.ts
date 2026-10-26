import { describe, expect, test } from "vitest";

import {
  ProfileSetupReviewActionSchema,
  ProfileSetupReviewActionOptionsSchema,
  ProfileSetupStateSchema,
  ProfileReviewItemSchema,
  CandidateProfileSchema,
  CandidateAnswerBankSchema,
  JobSearchPreferencesSchema,
  createFreshStartCandidateProfile,
  evaluateProfileSetupReadiness,
  deriveProfileSetupState,
  getProfileSetupLandingStep,
  getProfileSetupReadinessBlockers,
  hasProfileSetupPlaceholderValue,
  normalizeProfileSetupStep,
  profileSetupVisibleStepValues,
} from "./index";

const emptyProfessionalSummary = {
  shortValueProposition: null,
  fullSummary: null,
  careerThemes: [],
  leadershipSummary: null,
  domainFocusSummary: null,
  strengths: [],
};

const emptyNarrative = {
  professionalStory: null,
  nextChapterSummary: null,
  careerTransitionSummary: null,
  differentiators: [],
  motivationThemes: [],
};

const emptyApplicationIdentity = {
  preferredEmail: null,
  preferredPhone: null,
  preferredLinkIds: [],
};

const emptySkillGroups = {
  coreSkills: [],
  tools: [],
  languagesAndFrameworks: [],
  softSkills: [],
  highlightedSkills: [],
};

// A materially complete profile/preferences pair; only the work-mode
// preference is toggled by the canonical-rule tests below.
const completeProfileFixture = CandidateProfileSchema.parse({
  id: "candidate_1",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Senior systems designer",
  summary: "Builds resilient workflows.",
  currentLocation: "London, UK",
  yearsExperience: 10,
  email: "alex@example.com",
  phone: "+44 000 0000",
  baseResume: {
    id: "resume_1",
    fileName: "alex.pdf",
    uploadedAt: "2026-04-11T10:00:00.000Z",
    textContent: "Alex Vanguard",
    extractionStatus: "ready",
  },
  workEligibility: {
    authorizedWorkCountries: ["United Kingdom"],
    requiresVisaSponsorship: false,
    remoteEligible: true,
  },
  targetRoles: ["Principal Designer"],
  experiences: [
    {
      id: "experience_1",
      companyName: "Signal Systems",
      title: "Senior Product Designer",
      startDate: "2022-01",
      isCurrent: true,
      summary: "Owned workflow tooling.",
    },
  ],
});

const blankSearchPreferencesFixture = JobSearchPreferencesSchema.parse({
  targetRoles: [],
  jobFamilies: [],
  locations: [],
  excludedLocations: [],
  workModes: [],
  seniorityLevels: [],
  targetIndustries: [],
  targetCompanyStages: [],
  employmentTypes: [],
  minimumSalaryUsd: null,
  targetSalaryUsd: null,
  salaryCurrency: "USD",
  compensation: {
    minimum: null,
    maximum: null,
    interval: "year",
    currency: null,
    currencyStatus: "needs_clarification",
  },
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  companyBlacklist: [],
  companyWhitelist: [],
});

const completeSearchPreferencesFixture = JobSearchPreferencesSchema.parse({
  targetRoles: ["Principal Designer"],
  jobFamilies: [],
  locations: ["Remote"],
  excludedLocations: [],
  workModes: ["remote"],
  seniorityLevels: [],
  targetIndustries: [],
  targetCompanyStages: [],
  employmentTypes: [],
  minimumSalaryUsd: null,
  targetSalaryUsd: null,
  salaryCurrency: "USD",
  compensation: {
    minimum: null,
    maximum: null,
    interval: "year",
    currency: null,
    currencyStatus: "needs_clarification",
  },
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  companyBlacklist: [],
  companyWhitelist: [],
});

describe("contracts profile setup schemas", () => {
  test("parses profile setup workflow state", () => {
    const setupState = ProfileSetupStateSchema.parse({
      status: "in_progress",
      currentStep: "targeting",
      completedAt: null,
      reviewItems: [
        {
          id: "review_1",
          step: "essentials",
          target: {
            domain: "identity",
            key: "headline",
            recordId: null,
          },
          label: "Headline",
          reason: "Headline still needs confirmation after import.",
          severity: "recommended",
          status: "pending",
          proposedValue: "Senior Product Designer",
          sourceSnippet: "Senior Product Designer",
          sourceCandidateId: "candidate_import_1",
          sourceRunId: "resume_import_run_1",
          createdAt: "2026-04-11T10:00:00.000Z",
          resolvedAt: null,
        },
      ],
      lastResumedAt: "2026-04-11T10:05:00.000Z",
    });

    expect(setupState.currentStep).toBe("targeting");
    expect(setupState.reviewItems[0]?.target.domain).toBe("identity");
  });

  test("parses a profile review item", () => {
    expect(
      ProfileReviewItemSchema.parse({
        id: "review_2",
        step: "background",
        target: {
          domain: "experience",
          key: "companyName",
          recordId: "experience_1",
        },
        label: "Current role",
        reason:
          "Experience details should be confirmed before setup is complete.",
        severity: "critical",
        status: "edited",
        proposedValue: null,
        sourceSnippet: null,
        sourceCandidateId: null,
        sourceRunId: null,
        createdAt: "2026-04-11T10:00:00.000Z",
        resolvedAt: "2026-04-11T10:08:00.000Z",
      }).status,
    ).toBe("edited");
  });

  test("parses supported setup review actions", () => {
    expect(ProfileSetupReviewActionSchema.parse("confirm")).toBe("confirm");
    expect(ProfileSetupReviewActionSchema.parse("dismiss")).toBe("dismiss");
    expect(ProfileSetupReviewActionSchema.parse("clear_value")).toBe(
      "clear_value",
    );
    expect(
      ProfileSetupReviewActionOptionsSchema.parse({
        selectedConflictChoiceId: "choice_visual_scan",
      }).selectedConflictChoiceId,
    ).toBe("choice_visual_scan");
  });

  test("derives completed setup state from materially complete profile inputs", () => {
    const state = deriveProfileSetupState(
      {
        id: "candidate_1",
        firstName: "Alex",
        lastName: "Vanguard",
        middleName: null,
        fullName: "Alex Vanguard",
        preferredDisplayName: null,
        headline: "Senior systems designer",
        summary: "Builds resilient workflows.",
        currentLocation: "London, UK",
        currentCity: null,
        currentRegion: null,
        currentCountry: null,
        timeZone: null,
        yearsExperience: 10,
        email: "alex@example.com",
        secondaryEmail: null,
        phone: "+44 000 0000",
        portfolioUrl: null,
        linkedinUrl: null,
        githubUrl: null,
        personalWebsiteUrl: null,
        baseResume: {
          id: "resume_1",
          fileName: "alex.pdf",
          uploadedAt: "2026-04-11T10:00:00.000Z",
          storagePath: "/tmp/alex.pdf",
          textContent: "Alex Vanguard",
          textUpdatedAt: "2026-04-11T10:00:00.000Z",
          extractionStatus: "ready",
          lastAnalyzedAt: "2026-04-11T10:00:00.000Z",
          analysisProviderKind: null,
          analysisProviderLabel: null,
          analysisWarnings: [],
        },
        workEligibility: {
          authorizedWorkCountries: ["United Kingdom"],
          requiresVisaSponsorship: false,
          willingToRelocate: null,
          preferredRelocationRegions: [],
          willingToTravel: null,
          remoteEligible: true,
          noticePeriodDays: null,
          availableStartDate: null,
          securityClearance: null,
        },
        professionalSummary: emptyProfessionalSummary,
        narrative: emptyNarrative,
        proofBank: [],
        answerBank: CandidateAnswerBankSchema.parse({}),
        applicationIdentity: emptyApplicationIdentity,
        skillGroups: emptySkillGroups,
        targetRoles: ["Principal Designer"],
        locations: ["Remote"],
        skills: [],
        experiences: [
          {
            id: "experience_1",
            companyName: "Signal Systems",
            companyUrl: null,
            title: "Senior Product Designer",
            employmentType: null,
            location: "London, UK",
            workMode: [],
            startDate: "2022-01",
            endDate: null,
            isCurrent: true,
            isDraft: false,
            summary: "Owned workflow tooling.",
            achievements: [],
            skills: [],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
        education: [],
        certifications: [],
        links: [],
        projects: [],
        spokenLanguages: [],
      },
      {
        targetRoles: ["Principal Designer"],
        jobFamilies: [],
        locations: ["Remote"],
        excludedLocations: [],
        workModes: ["remote"],
        seniorityLevels: [],
        targetIndustries: [],
        targetCompanyStages: [],
        employmentTypes: [],
        minimumSalaryUsd: null,
        targetSalaryUsd: null,
        salaryCurrency: "USD",
        compensation: {
          minimum: null,
          maximum: null,
          interval: "year",
          currency: null,
          currencyStatus: "needs_clarification",
        },
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
        companyBlacklist: [],
        companyWhitelist: [],
      },
      { enabledSiteCount: 1, now: "2026-04-11T10:15:00.000Z" },
    );

    expect(state.status).toBe("completed");
    // Finish lives on Job targets now; there is no summary step to park on.
    expect(state.currentStep).toBe("targeting");
    expect(state.completedAt).toBe("2026-04-11T10:15:00.000Z");
  });

  test("migrates retired step ids onto the five visible guided-setup steps", () => {
    expect(normalizeProfileSetupStep("narrative")).toBe("extras");
    expect(normalizeProfileSetupStep("answers")).toBe("extras");
    expect(normalizeProfileSetupStep("ready_check")).toBe("targeting");
    expect(profileSetupVisibleStepValues).toEqual([
      "import",
      "essentials",
      "background",
      "targeting",
      "extras",
    ]);

    // A stored workspace is migrated at parse time, so nothing downstream has
    // to know a retired step id ever existed.
    const parsed = ProfileSetupStateSchema.parse({
      status: "in_progress",
      currentStep: "answers",
      completedAt: null,
      lastResumedAt: null,
      reviewItems: [
        {
          id: "review_story",
          step: "narrative",
          target: {
            domain: "narrative",
            key: "professionalStory",
            recordId: null,
          },
          label: "Professional story",
          reason: "Confirm the imported story.",
          severity: "optional",
          status: "pending",
          createdAt: "2026-04-11T10:00:00.000Z",
        },
      ],
    });

    expect(parsed.currentStep).toBe("extras");
    expect(parsed.reviewItems[0]?.step).toBe("extras");
  });

  test("keeps optional narrative and answer details outside core setup readiness", () => {
    const readiness = evaluateProfileSetupReadiness(
      completeProfileFixture,
      completeSearchPreferencesFixture,
      1,
    );

    expect(readiness.materiallyComplete).toBe(true);
    expect(readiness.hasNarrative).toBe(false);
    expect(getProfileSetupReadinessBlockers(readiness)).toEqual([]);
  });

  test("keeps setup in progress when pending critical review items remain", () => {
    const state = deriveProfileSetupState(
      {
        id: "candidate_1",
        firstName: "Alex",
        lastName: "Vanguard",
        middleName: null,
        fullName: "Alex Vanguard",
        preferredDisplayName: null,
        headline: "Senior systems designer",
        summary: "Builds resilient workflows.",
        currentLocation: "London, UK",
        currentCity: null,
        currentRegion: null,
        currentCountry: null,
        timeZone: null,
        yearsExperience: 10,
        email: "alex@example.com",
        secondaryEmail: null,
        phone: "+44 000 0000",
        portfolioUrl: null,
        linkedinUrl: null,
        githubUrl: null,
        personalWebsiteUrl: null,
        baseResume: {
          id: "resume_1",
          fileName: "alex.pdf",
          uploadedAt: "2026-04-11T10:00:00.000Z",
          storagePath: "/tmp/alex.pdf",
          textContent: "Alex Vanguard",
          textUpdatedAt: "2026-04-11T10:00:00.000Z",
          extractionStatus: "ready",
          lastAnalyzedAt: "2026-04-11T10:00:00.000Z",
          analysisProviderKind: null,
          analysisProviderLabel: null,
          analysisWarnings: [],
        },
        workEligibility: {
          authorizedWorkCountries: ["United Kingdom"],
          requiresVisaSponsorship: false,
          willingToRelocate: null,
          preferredRelocationRegions: [],
          willingToTravel: null,
          remoteEligible: true,
          noticePeriodDays: null,
          availableStartDate: null,
          securityClearance: null,
        },
        professionalSummary: emptyProfessionalSummary,
        narrative: emptyNarrative,
        proofBank: [],
        answerBank: CandidateAnswerBankSchema.parse({}),
        applicationIdentity: emptyApplicationIdentity,
        skillGroups: emptySkillGroups,
        targetRoles: ["Principal Designer"],
        locations: ["Remote"],
        skills: [],
        experiences: [
          {
            id: "experience_1",
            companyName: "Signal Systems",
            companyUrl: null,
            title: "Senior Product Designer",
            employmentType: null,
            location: "London, UK",
            workMode: [],
            startDate: "2022-01",
            endDate: null,
            isCurrent: true,
            isDraft: false,
            summary: "Owned workflow tooling.",
            achievements: [],
            skills: [],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
        education: [],
        certifications: [],
        links: [],
        projects: [],
        spokenLanguages: [],
      },
      {
        targetRoles: ["Principal Designer"],
        jobFamilies: [],
        locations: ["Remote"],
        excludedLocations: [],
        workModes: ["remote"],
        seniorityLevels: [],
        targetIndustries: [],
        targetCompanyStages: [],
        employmentTypes: [],
        minimumSalaryUsd: null,
        targetSalaryUsd: null,
        salaryCurrency: "USD",
        compensation: {
          minimum: null,
          maximum: null,
          interval: "year",
          currency: null,
          currencyStatus: "needs_clarification",
        },
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
        companyBlacklist: [],
        companyWhitelist: [],
      },
      {
        enabledSiteCount: 1,
        currentState: {
          status: "in_progress",
          currentStep: "background",
          completedAt: null,
          reviewItems: [
            {
              id: "review_1",
              step: "essentials",
              target: {
                domain: "identity",
                key: "headline",
                recordId: null,
              },
              label: "Headline",
              reason: "Confirm the imported headline before setup is complete.",
              severity: "critical",
              status: "pending",
              proposedValue: "Senior systems designer",
              sourceSnippet: "Senior systems designer",
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-11T10:00:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
        now: "2026-04-11T10:15:00.000Z",
      },
    );

    expect(state.status).toBe("in_progress");
    expect(state.currentStep).toBe("background");
    expect(state.completedAt).toBeNull();
  });

  test("keeps explicit in-progress step even when readiness becomes materially complete", () => {
    const state = deriveProfileSetupState(
      {
        id: "candidate_1",
        firstName: "Alex",
        lastName: "Vanguard",
        middleName: null,
        fullName: "Alex Vanguard",
        preferredDisplayName: null,
        headline: "Senior systems designer",
        summary: "Builds resilient workflows.",
        currentLocation: "London, UK",
        currentCity: null,
        currentRegion: null,
        currentCountry: null,
        timeZone: null,
        yearsExperience: 10,
        email: "alex@example.com",
        secondaryEmail: null,
        phone: "+44 000 0000",
        portfolioUrl: null,
        linkedinUrl: null,
        githubUrl: null,
        personalWebsiteUrl: null,
        baseResume: {
          id: "resume_1",
          fileName: "alex.pdf",
          uploadedAt: "2026-04-11T10:00:00.000Z",
          storagePath: "/tmp/alex.pdf",
          textContent: "Alex Vanguard",
          textUpdatedAt: "2026-04-11T10:00:00.000Z",
          extractionStatus: "ready",
          lastAnalyzedAt: "2026-04-11T10:00:00.000Z",
          analysisProviderKind: null,
          analysisProviderLabel: null,
          analysisWarnings: [],
        },
        workEligibility: {
          authorizedWorkCountries: ["United Kingdom"],
          requiresVisaSponsorship: false,
          willingToRelocate: null,
          preferredRelocationRegions: [],
          willingToTravel: null,
          remoteEligible: true,
          noticePeriodDays: null,
          availableStartDate: null,
          securityClearance: null,
        },
        professionalSummary: emptyProfessionalSummary,
        narrative: emptyNarrative,
        proofBank: [],
        answerBank: CandidateAnswerBankSchema.parse({}),
        applicationIdentity: emptyApplicationIdentity,
        skillGroups: emptySkillGroups,
        targetRoles: ["Principal Designer"],
        locations: ["Remote"],
        skills: [],
        experiences: [
          {
            id: "experience_1",
            companyName: "Signal Systems",
            companyUrl: null,
            title: "Senior Product Designer",
            employmentType: null,
            location: "London, UK",
            workMode: [],
            startDate: "2022-01",
            endDate: null,
            isCurrent: true,
            isDraft: false,
            summary: "Owned workflow tooling.",
            achievements: [],
            skills: [],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
        education: [],
        certifications: [],
        links: [],
        projects: [],
        spokenLanguages: [],
      },
      {
        targetRoles: ["Principal Designer"],
        jobFamilies: [],
        locations: ["Remote"],
        excludedLocations: [],
        workModes: ["remote"],
        seniorityLevels: [],
        targetIndustries: [],
        targetCompanyStages: [],
        employmentTypes: [],
        minimumSalaryUsd: null,
        targetSalaryUsd: null,
        salaryCurrency: "USD",
        compensation: {
          minimum: null,
          maximum: null,
          interval: "year",
          currency: null,
          currencyStatus: "needs_clarification",
        },
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
        companyBlacklist: [],
        companyWhitelist: [],
      },
      {
        enabledSiteCount: 1,
        currentState: {
          status: "in_progress",
          currentStep: "background",
          completedAt: null,
          reviewItems: [],
          lastResumedAt: "2026-04-11T10:20:00.000Z",
        },
        now: "2026-04-11T10:30:00.000Z",
      },
    );

    expect(state.status).toBe("in_progress");
    expect(state.currentStep).toBe("background");
    expect(state.completedAt).toBeNull();
  });

  test("completes a materially ready setup after the first search has run", () => {
    const completedAt = "2026-04-11T10:35:00.000Z";
    const state = deriveProfileSetupState(
      completeProfileFixture,
      completeSearchPreferencesFixture,
      {
        enabledSiteCount: 1,
        currentState: {
          status: "in_progress",
          currentStep: "targeting",
          completedAt: null,
          reviewItems: [],
          lastResumedAt: "2026-04-11T10:20:00.000Z",
        },
        hasRunSearch: true,
        now: completedAt,
      },
    );

    expect(state.status).toBe("completed");
    expect(state.currentStep).toBe("targeting");
    expect(state.completedAt).toBe(completedAt);
  });

  test("accepts fresh-start zero years of experience as complete core identity", () => {
    const readiness = evaluateProfileSetupReadiness(
      {
        id: "candidate_fresh_start",
        firstName: "New",
        lastName: "Candidate",
        middleName: null,
        fullName: "New Candidate",
        preferredDisplayName: null,
        headline: "Senior systems designer",
        summary: "Builds resilient workflows.",
        currentLocation: "London, UK",
        currentCity: null,
        currentRegion: null,
        currentCountry: null,
        timeZone: null,
        yearsExperience: 0,
        email: "alex@example.com",
        secondaryEmail: null,
        phone: null,
        portfolioUrl: null,
        linkedinUrl: null,
        githubUrl: null,
        personalWebsiteUrl: null,
        baseResume: {
          id: "resume_1",
          fileName: "alex.pdf",
          uploadedAt: "2026-04-11T10:00:00.000Z",
          storagePath: "/tmp/alex.pdf",
          textContent: "Alex Vanguard",
          textUpdatedAt: "2026-04-11T10:00:00.000Z",
          extractionStatus: "ready",
          lastAnalyzedAt: "2026-04-11T10:00:00.000Z",
          analysisProviderKind: null,
          analysisProviderLabel: null,
          analysisWarnings: [],
        },
        workEligibility: {
          authorizedWorkCountries: ["United Kingdom"],
          requiresVisaSponsorship: false,
          willingToRelocate: null,
          preferredRelocationRegions: [],
          willingToTravel: null,
          remoteEligible: true,
          noticePeriodDays: null,
          availableStartDate: null,
          securityClearance: null,
        },
        professionalSummary: emptyProfessionalSummary,
        narrative: emptyNarrative,
        proofBank: [],
        answerBank: CandidateAnswerBankSchema.parse({}),
        applicationIdentity: emptyApplicationIdentity,
        skillGroups: emptySkillGroups,
        targetRoles: ["Principal Designer"],
        locations: ["Remote"],
        skills: [],
        experiences: [
          {
            id: "experience_1",
            companyName: "Signal Systems",
            companyUrl: null,
            title: "Senior Product Designer",
            employmentType: null,
            location: "London, UK",
            workMode: [],
            startDate: "2022-01",
            endDate: null,
            isCurrent: true,
            isDraft: false,
            summary: "Owned workflow tooling.",
            achievements: [],
            skills: [],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
        education: [],
        certifications: [],
        links: [],
        projects: [],
        spokenLanguages: [],
      },
      {
        targetRoles: ["Principal Designer"],
        jobFamilies: [],
        locations: ["Remote"],
        excludedLocations: [],
        workModes: ["remote"],
        seniorityLevels: [],
        targetIndustries: [],
        targetCompanyStages: [],
        employmentTypes: [],
        minimumSalaryUsd: null,
        targetSalaryUsd: null,
        salaryCurrency: "USD",
        compensation: {
          minimum: null,
          maximum: null,
          interval: "year",
          currency: null,
          currencyStatus: "needs_clarification",
        },
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
        companyBlacklist: [],
        companyWhitelist: [],
      },
      0,
    );

    expect(readiness.freshStart).toBe(true);
    // Zero years is a true answer for a first job; it must not hide the
    // essentials behind a gate the person cannot see.
    expect(readiness.hasCoreIdentity).toBe(true);
    expect(readiness.hasDiscoverySource).toBe(false);
    expect(readiness.recommendedStep).toBe("targeting");
  });

  test("downgrades completed setup when new pending review items appear", () => {
    const state = deriveProfileSetupState(
      {
        id: "candidate_1",
        firstName: "Alex",
        lastName: "Vanguard",
        middleName: null,
        fullName: "Alex Vanguard",
        preferredDisplayName: null,
        headline: "Senior systems designer",
        summary: "Builds resilient workflows.",
        currentLocation: "London, UK",
        currentCity: null,
        currentRegion: null,
        currentCountry: null,
        timeZone: null,
        yearsExperience: 10,
        email: "alex@example.com",
        secondaryEmail: null,
        phone: "+44 000 0000",
        portfolioUrl: null,
        linkedinUrl: null,
        githubUrl: null,
        personalWebsiteUrl: null,
        baseResume: {
          id: "resume_1",
          fileName: "alex.pdf",
          uploadedAt: "2026-04-11T10:00:00.000Z",
          storagePath: "/tmp/alex.pdf",
          textContent: "Alex Vanguard",
          textUpdatedAt: "2026-04-11T10:00:00.000Z",
          extractionStatus: "ready",
          lastAnalyzedAt: "2026-04-11T10:00:00.000Z",
          analysisProviderKind: null,
          analysisProviderLabel: null,
          analysisWarnings: [],
        },
        workEligibility: {
          authorizedWorkCountries: ["United Kingdom"],
          requiresVisaSponsorship: false,
          willingToRelocate: null,
          preferredRelocationRegions: [],
          willingToTravel: null,
          remoteEligible: true,
          noticePeriodDays: null,
          availableStartDate: null,
          securityClearance: null,
        },
        professionalSummary: emptyProfessionalSummary,
        narrative: emptyNarrative,
        proofBank: [],
        answerBank: CandidateAnswerBankSchema.parse({}),
        applicationIdentity: emptyApplicationIdentity,
        skillGroups: emptySkillGroups,
        targetRoles: ["Principal Designer"],
        locations: ["Remote"],
        skills: [],
        experiences: [
          {
            id: "experience_1",
            companyName: "Signal Systems",
            companyUrl: null,
            title: "Senior Product Designer",
            employmentType: null,
            location: "London, UK",
            workMode: [],
            startDate: "2022-01",
            endDate: null,
            isCurrent: true,
            isDraft: false,
            summary: "Owned workflow tooling.",
            achievements: [],
            skills: [],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
        education: [],
        certifications: [],
        links: [],
        projects: [],
        spokenLanguages: [],
      },
      {
        targetRoles: ["Principal Designer"],
        jobFamilies: [],
        locations: ["Remote"],
        excludedLocations: [],
        workModes: ["remote"],
        seniorityLevels: [],
        targetIndustries: [],
        targetCompanyStages: [],
        employmentTypes: [],
        minimumSalaryUsd: null,
        targetSalaryUsd: null,
        salaryCurrency: "USD",
        compensation: {
          minimum: null,
          maximum: null,
          interval: "year",
          currency: null,
          currencyStatus: "needs_clarification",
        },
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
        companyBlacklist: [],
        companyWhitelist: [],
      },
      {
        enabledSiteCount: 0,
        currentState: {
          status: "completed",
          currentStep: "ready_check",
          completedAt: "2026-04-11T10:15:00.000Z",
          reviewItems: [
            {
              id: "review_1",
              step: "background",
              target: {
                domain: "experience",
                key: "record",
                recordId: "experience_2",
              },
              label: "Current role",
              reason: "Confirm the imported experience record.",
              severity: "critical",
              status: "pending",
              proposedValue: "Product lead",
              sourceSnippet: "Product lead at New Company",
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-11T10:20:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
        now: "2026-04-11T10:30:00.000Z",
      },
    );

    // This profile has no job source, so it is not materially complete.
    expect(state.status).toBe("in_progress");
    expect(state.currentStep).toBe("background");
    expect(state.completedAt).toBeNull();
  });

  test("keeps a finished, materially complete setup finished when a later import raises review items", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_reimport",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      baseResume: {
        id: "resume_1",
        fileName: "alex.pdf",
        uploadedAt: "2026-04-11T10:00:00.000Z",
        textContent: "Alex Vanguard",
        textUpdatedAt: "2026-04-11T10:00:00.000Z",
        extractionStatus: "ready",
      },
      workEligibility: {
        authorizedWorkCountries: ["United Kingdom"],
        requiresVisaSponsorship: false,
      },
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      experiences: [
        {
          id: "experience_1",
          companyName: "Signal Systems",
          title: "Senior Product Designer",
          startDate: "2022-01",
          isCurrent: true,
          summary: "Owned workflow tooling.",
        },
      ],
    });
    const searchPreferences = JobSearchPreferencesSchema.parse({
      ...blankSearchPreferencesFixture,
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      workModes: ["remote"],
    });
    expect(
      evaluateProfileSetupReadiness(profile, searchPreferences, 1)
        .materiallyComplete,
    ).toBe(true);

    const state = deriveProfileSetupState(profile, searchPreferences, {
      enabledSiteCount: 1,
      currentState: {
        status: "completed",
        currentStep: "targeting",
        completedAt: "2026-04-11T10:15:00.000Z",
        reviewItems: [
          {
            id: "review_1",
            step: "background",
            target: { domain: "experience", key: "record", recordId: null },
            label: "Senior Backend Engineer at Acme Payments",
            reason: "Confirm the imported experience record.",
            severity: "critical",
            status: "pending",
            proposedValue: "Senior Backend Engineer",
            sourceSnippet: null,
            sourceCandidateId: null,
            sourceRunId: null,
            createdAt: "2026-04-11T10:20:00.000Z",
            resolvedAt: null,
          },
        ],
        lastResumedAt: null,
      },
      now: "2026-04-11T10:30:00.000Z",
    });

    // Re-importing reopened a finished setup: Profile lost "Profile ready"
    // and Home asked the person to finish setting up again. The item stays
    // pending for review in Profile.
    expect(state.status).toBe("completed");
    expect(state.completedAt).toBe("2026-04-11T10:15:00.000Z");
    expect(state.reviewItems[0]?.status).toBe("pending");
  });

  test("reopens a finished setup once it is no longer materially complete", () => {
    const state = deriveProfileSetupState(
      createFreshStartCandidateProfile(),
      blankSearchPreferencesFixture,
      {
        enabledSiteCount: 0,
        currentState: {
          status: "completed",
          currentStep: "targeting",
          completedAt: "2026-04-11T10:15:00.000Z",
          reviewItems: [],
          lastResumedAt: null,
        },
        now: "2026-04-11T10:30:00.000Z",
      },
    );

    expect(state.status).not.toBe("completed");
    expect(state.completedAt).toBeNull();
  });

  test("parses the canonical fresh-start seed with no persisted placeholder facts", () => {
    const profile = createFreshStartCandidateProfile();

    expect(profile.id).toBe("candidate_fresh_start");
    expect(profile.firstName).toBeNull();
    expect(profile.lastName).toBeNull();
    expect(profile.fullName).toBeNull();
    expect(profile.headline).toBeNull();
    expect(profile.summary).toBeNull();
    expect(profile.currentLocation).toBeNull();

    // Legacy workspaces that already stored the instructional strings still
    // parse, and the shared detector recognizes them as placeholders.
    const legacy = CandidateProfileSchema.parse({
      ...profile,
      firstName: "New",
      lastName: "Candidate",
      fullName: "New Candidate",
      headline: "Import your resume to begin",
      summary:
        "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
      currentLocation: "Set your preferred location",
    });
    expect(legacy.fullName).toBe("New Candidate");
    expect(hasProfileSetupPlaceholderValue("fullName", legacy.fullName)).toBe(
      true,
    );
    expect(hasProfileSetupPlaceholderValue("headline", legacy.headline)).toBe(
      true,
    );
    expect(
      hasProfileSetupPlaceholderValue(
        "currentLocation",
        legacy.currentLocation,
      ),
    ).toBe(true);
    expect(hasProfileSetupPlaceholderValue("summary", legacy.summary)).toBe(
      true,
    );
    expect(hasProfileSetupPlaceholderValue("fullName", "Alex Vanguard")).toBe(
      false,
    );
  });

  test("reports a null-identity fresh start as not started with canonical blockers", () => {
    const readiness = evaluateProfileSetupReadiness(
      createFreshStartCandidateProfile(),
      blankSearchPreferencesFixture,
      0,
    );

    expect(readiness.freshStart).toBe(true);
    expect(readiness.hasCoreIdentity).toBe(false);
    expect(readiness.started).toBe(false);
    expect(readiness.materiallyComplete).toBe(false);
    expect(readiness.recommendedStep).toBe("import");
    // A name with a contact, one job source, and the two answers every
    // application form asks gate finishing.
    expect(getProfileSetupReadinessBlockers(readiness)).toEqual([
      { id: "identity_contact", step: "essentials" },
      { id: "discovery_source", step: "targeting" },
      { id: "work_eligibility_answers", step: "targeting" },
    ]);
  });

  test("needs both structured work-eligibility facts", () => {
    const withAnswers = (workEligibility: object) =>
      evaluateProfileSetupReadiness(
        CandidateProfileSchema.parse({
          ...completeProfileFixture,
          workEligibility: {
            ...completeProfileFixture.workEligibility,
            authorizedWorkCountries: [],
            requiresVisaSponsorship: null,
            ...workEligibility,
          },
        }),
        completeSearchPreferencesFixture,
        1,
      ).hasWorkEligibilityAnswers;

    expect(withAnswers({})).toBe(false);
    expect(withAnswers({ authorizedWorkCountries: ["Germany"] })).toBe(false);
    expect(withAnswers({ requiresVisaSponsorship: false })).toBe(false);
    expect(
      withAnswers({
        authorizedWorkCountries: ["Germany"],
        requiresVisaSponsorship: false,
      }),
    ).toBe(true);
    // "Needs sponsorship: yes" is an answer too.
    expect(
      withAnswers({
        authorizedWorkCountries: ["Germany"],
        requiresVisaSponsorship: true,
      }),
    ).toBe(true);
    // Materially complete is unchanged, so a setup finished before the
    // question existed is not reopened.
    expect(
      evaluateProfileSetupReadiness(
        CandidateProfileSchema.parse({
          ...completeProfileFixture,
          workEligibility: {
            ...completeProfileFixture.workEligibility,
            authorizedWorkCountries: [],
            requiresVisaSponsorship: null,
          },
        }),
        completeSearchPreferencesFixture,
        1,
      ).materiallyComplete,
    ).toBe(true);
  });

  test("lands an import on the first step that needs the person, not on an optional suggestion", () => {
    const importedProfile = CandidateProfileSchema.parse({
      ...completeProfileFixture,
      workEligibility: {
        ...completeProfileFixture.workEligibility,
        authorizedWorkCountries: [],
        requiresVisaSponsorship: null,
      },
    });
    const readiness = evaluateProfileSetupReadiness(
      importedProfile,
      blankSearchPreferencesFixture,
      0,
    );
    const optionalProofPoint = ProfileReviewItemSchema.parse({
      id: "review_proof_point",
      step: "extras",
      target: { domain: "proof_point", key: "claim", recordId: null },
      label: "Proof point",
      reason: "Imported proof point.",
      severity: "optional",
      status: "pending",
      createdAt: "2026-09-23T10:00:00.000Z",
    });
    const recommendedSummary = ProfileReviewItemSchema.parse({
      id: "review_summary",
      step: "essentials",
      target: { domain: "identity", key: "summary", recordId: null },
      label: "Professional summary",
      reason: "Confirm the imported summary.",
      severity: "recommended",
      status: "pending",
      createdAt: "2026-09-23T10:00:00.000Z",
    });

    // Basics is complete; Job targets owns the source and the eligibility
    // answers, so that is where the import lands.
    expect(
      getProfileSetupLandingStep(readiness, [
        optionalProofPoint,
        recommendedSummary,
      ]),
    ).toBe("targeting");

    // A critical item on an earlier step still wins.
    const criticalName = ProfileReviewItemSchema.parse({
      ...recommendedSummary,
      id: "review_name",
      target: { domain: "identity", key: "fullName", recordId: null },
      severity: "critical",
    });
    expect(getProfileSetupLandingStep(readiness, [criticalName])).toBe(
      "essentials",
    );

    // Nothing blocking at all: Job targets, which owns Finish.
    expect(
      getProfileSetupLandingStep(
        evaluateProfileSetupReadiness(
          completeProfileFixture,
          completeSearchPreferencesFixture,
          1,
        ),
        [optionalProofPoint],
      ),
    ).toBe("targeting");

    // No resume and no name yet: the import step.
    expect(
      getProfileSetupLandingStep(
        evaluateProfileSetupReadiness(
          createFreshStartCandidateProfile(),
          blankSearchPreferencesFixture,
          0,
        ),
        [],
      ),
    ).toBe("import");
  });

  test("finishes setup without a work-mode preference; the preference stays a hint", () => {
    const preferencesWithoutWorkMode = {
      ...completeSearchPreferencesFixture,
      workModes: [],
    };
    const readinessWithoutWorkMode = evaluateProfileSetupReadiness(
      completeProfileFixture,
      preferencesWithoutWorkMode,
      1,
    );

    expect(readinessWithoutWorkMode.hasWorkModePreference).toBe(false);
    expect(readinessWithoutWorkMode.materiallyComplete).toBe(true);
    expect(
      getProfileSetupReadinessBlockers(readinessWithoutWorkMode).map(
        (blocker) => blocker.id,
      ),
    ).toEqual([]);

    const readinessWithWorkMode = evaluateProfileSetupReadiness(
      completeProfileFixture,
      completeSearchPreferencesFixture,
      1,
    );
    expect(readinessWithWorkMode.hasWorkModePreference).toBe(true);
    expect(readinessWithWorkMode.materiallyComplete).toBe(true);
    expect(getProfileSetupReadinessBlockers(readinessWithWorkMode)).toEqual([]);
  });
});
