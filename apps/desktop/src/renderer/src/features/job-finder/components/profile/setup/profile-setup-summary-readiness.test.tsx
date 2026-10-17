// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  createFreshStartCandidateProfile,
  evaluateProfileSetupReadiness,
  type JobSearchPreferences,
} from "@nestor/contracts";
import {
  buildProfileSetupReadinessPresentation,
  getProfileSetupReadinessBlockerLabel,
} from "./profile-setup-screen-helpers";
import {
  formatProfileSetupFinishReadiness,
  getProfileSetupStepFooterPrimary,
} from "./profile-setup-step-footer";

type SearchPreferencesInput = (typeof JobSearchPreferencesSchema)["_input"];

function buildSearchPreferences(
  overrides: Partial<SearchPreferencesInput> = {},
): JobSearchPreferences {
  return JobSearchPreferencesSchema.parse({
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
    discovery: { historyLimit: 5, targets: [] },
    ...overrides,
  });
}

describe("guided setup readiness, stated once", () => {
  function buildReadinessLine(input: {
    draftProfile: Parameters<typeof evaluateProfileSetupReadiness>[0];
    draftSearchPreferences: JobSearchPreferences;
  }) {
    const readiness = evaluateProfileSetupReadiness(
      input.draftProfile,
      input.draftSearchPreferences,
    );
    const presentation = buildProfileSetupReadinessPresentation({
      readiness,
      reviewItems: [],
    });

    return {
      presentation,
      text: formatProfileSetupFinishReadiness({
        canFinishSetup: presentation.remainingBlockerCount === 0,
        remainingBlockerLabels: presentation.blockers.map((blocker) =>
          getProfileSetupReadinessBlockerLabel(blocker.id),
        ),
      }),
    };
  }

  it("names every blocker on a canonical fresh-start workspace", () => {
    const { presentation, text } = buildReadinessLine({
      draftProfile: createFreshStartCandidateProfile(),
      draftSearchPreferences: buildSearchPreferences(),
    });

    // Finishing needs a name with a contact, one job source, and the two
    // answers every application form asks; the rest are hints, not gates.
    expect(presentation.blockers.map((blocker) => blocker.id)).toEqual([
      "identity_contact",
      "discovery_source",
      "work_eligibility_answers",
    ]);
    expect(text).toBe(
      "Still needed to finish: Add your name and an email or phone · Add a job source · Say where you can work and whether you need visa sponsorship.",
    );
  });

  it("finishes with a name, a contact and a source even before a work mode is chosen", () => {
    // Regression for first-run QA: target role + runnable source used to read
    // "Ready to search" while the ready check still required a work mode.
    const profile = CandidateProfileSchema.parse({
      id: "candidate_qa_regression",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      yearsExperience: 10,
      email: "alex@example.com",
      phone: "+44 7700 900123",
      baseResume: {
        id: "resume_1",
        fileName: "alex.pdf",
        uploadedAt: "2026-08-01T10:00:00.000Z",
        textContent: "Alex Vanguard Senior systems designer",
        extractionStatus: "ready",
      },
      targetRoles: ["Principal Designer"],
      experiences: [
        {
          id: "experience_1",
          companyName: "Signal Systems",
          title: "Senior Product Designer",
          startDate: "2022-01",
          isCurrent: true,
        },
      ],
      workEligibility: {
        authorizedWorkCountries: ["United Kingdom"],
        requiresVisaSponsorship: false,
      },
    });
    const searchPreferencesWithoutWorkMode = buildSearchPreferences({
      targetRoles: ["Principal Designer"],
      locations: ["Remote"],
      discovery: {
        historyLimit: 5,
        targets: [
          {
            id: "source_1",
            label: "Signal Systems careers",
            startingUrl: "https://signal.example/careers",
            enabled: true,
            adapterKind: "auto",
            customInstructions: null,
            instructionStatus: "missing",
            validatedInstructionId: null,
            draftInstructionId: null,
            lastDebugRunId: null,
            lastVerifiedAt: null,
            staleReason: null,
          },
        ],
      },
    });

    const blocked = buildReadinessLine({
      draftProfile: profile,
      draftSearchPreferences: searchPreferencesWithoutWorkMode,
    });
    // The work mode is a hint on Job targets, no longer a gate.
    expect(blocked.text).toBe("Everything required is in. You can finish setup.");

    // The two eligibility answers are: without them the first application
    // stopped on "Are you authorized to work here?".
    const withoutEligibility = buildReadinessLine({
      draftProfile: CandidateProfileSchema.parse({
        ...profile,
        workEligibility: {
          ...profile.workEligibility,
          authorizedWorkCountries: [],
          requiresVisaSponsorship: null,
        },
      }),
      draftSearchPreferences: searchPreferencesWithoutWorkMode,
    });
    expect(withoutEligibility.text).toBe(
      "Still needed to finish: Say where you can work and whether you need visa sponsorship.",
    );
    // A saved answer-bank sentence answers the question too.
    const answeredInWords = buildReadinessLine({
      draftProfile: CandidateProfileSchema.parse({
        ...profile,
        workEligibility: {
          ...profile.workEligibility,
          authorizedWorkCountries: [],
          requiresVisaSponsorship: null,
        },
        answerBank: {
          ...profile.answerBank,
          workAuthorization: "Yes, I hold a UK work permit.",
          visaSponsorship: "No",
        },
      }),
      draftSearchPreferences: searchPreferencesWithoutWorkMode,
    });
    expect(answeredInWords.text).toBe(
      "Everything required is in. You can finish setup.",
    );

    const ready = buildReadinessLine({
      draftProfile: profile,
      draftSearchPreferences: {
        ...searchPreferencesWithoutWorkMode,
        workModes: ["remote"],
      },
    });
    expect(ready.text).toBe("Everything required is in. You can finish setup.");
    expect(
      getProfileSetupStepFooterPrimary({
        canFinishSetup: ready.presentation.remainingBlockerCount === 0,
        currentStep: "targeting",
        onSaveAndFinish: vi.fn(),
        onSaveAndGoToStep: vi.fn(),
      }).label,
    ).toBe("Finish setup and find jobs");
  });

  it("keeps the Mina-style readiness line aligned with the sticky footer gate", () => {
    const profile = CandidateProfileSchema.parse({
      ...createFreshStartCandidateProfile(),
      firstName: "Mina",
      lastName: "Rivera",
      fullName: "Mina Rivera",
      headline: "Customer support specialist",
      currentLocation: "Prishtina, Kosovo",
      yearsExperience: 0,
      email: "mina@example.com",
      experiences: [
        {
          id: "mina_experience",
          companyName: "Signal Systems",
          title: "Customer Support Specialist",
          startDate: "2024-01",
          isCurrent: true,
        },
      ],
    });
    const searchPreferences = buildSearchPreferences({
      targetRoles: ["Customer support specialist"],
      locations: ["Prishtina, Kosovo"],
      workModes: [],
      discovery: { historyLimit: 5, targets: [] },
    });

    const { presentation, text } = buildReadinessLine({
      draftProfile: profile,
      draftSearchPreferences: searchPreferences,
    });

    // Mina has a name and an email; her zero years of experience is a true
    // answer and no longer counts against the essentials.
    expect(presentation.blockers.map((blocker) => blocker.id)).toEqual([
      "discovery_source",
      "work_eligibility_answers",
    ]);
    expect(text).toBe(
      "Still needed to finish: Add a job source · Say where you can work and whether you need visa sponsorship.",
    );
    // One readiness system: the footer primary is gated by the same
    // presentation the line above is written from.
    expect(
      getProfileSetupStepFooterPrimary({
        canFinishSetup: presentation.remainingBlockerCount === 0,
        currentStep: "targeting",
        onSaveAndFinish: vi.fn(),
        onSaveAndGoToStep: vi.fn(),
      }).label,
    ).toBe("Save and continue to Extras");
  });
});
