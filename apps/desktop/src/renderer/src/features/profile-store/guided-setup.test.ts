import { describe, expect, it } from "vitest";
import {
  CandidateProfileSchema,
  CommitProfileEditsInputSchema,
  JobSearchPreferencesSchema,
  ProfileSetupStateSchema,
} from "@nestor/contracts";
import { hasProfileEdits, nextSetupState } from "./guided-setup";

const NOW = "2026-10-26T12:00:00.000Z";

const completeProfile = CandidateProfileSchema.parse({
  id: "candidate_1",
  firstName: "Synthetic",
  lastName: "Candidate",
  fullName: "Synthetic Candidate",
  headline: "Analyst",
  currentLocation: "Berlin",
  yearsExperience: 5,
  email: "synthetic@example.test",
  baseResume: {
    id: "resume_1",
    fileName: "synthetic.pdf",
    uploadedAt: NOW,
    textContent: "Synthetic Candidate",
    extractionStatus: "ready",
  },
  workEligibility: {
    authorizedWorkCountries: ["Germany"],
    requiresVisaSponsorship: false,
    remoteEligible: true,
  },
  targetRoles: ["Data Analyst"],
  experiences: [
    {
      id: "work_1",
      companyName: "Synthetic Employer",
      title: "Analyst",
      startDate: "2020-01",
      isCurrent: true,
    },
  ],
});
const completeGoals = JobSearchPreferencesSchema.parse({
  targetRoles: ["Data Analyst"],
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
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  companyBlacklist: [],
  companyWhitelist: [],
});
// Missing the work history and target roles setup asks for.
const emptyProfile = CandidateProfileSchema.parse({
  ...completeProfile,
  targetRoles: [],
  experiences: [],
  workEligibility: {},
});

function setup(reviewItems: readonly unknown[] = []) {
  return ProfileSetupStateSchema.parse({
    status: "in_progress",
    currentStep: "essentials",
    completedAt: null,
    lastResumedAt: null,
    reviewItems,
  });
}

const criticalItem = {
  id: "review_name",
  step: "essentials",
  target: { domain: "identity", key: "fullName", recordId: null },
  label: "Full name",
  reason: "Confirm the imported name.",
  severity: "critical",
  status: "pending",
  createdAt: NOW,
} as const;

describe("nextSetupState", () => {
  // Every row that is not "finish, complete, no blocking item, at least one
  // site" stays in progress: completion is the only allowed path.
  it.each([
    [
      "finish, complete, a site, nothing pending",
      true,
      true,
      1,
      [],
      "completed",
    ],
    ["not asked to finish", false, true, 1, [], "in_progress"],
    ["profile not complete", true, false, 1, [], "in_progress"],
    ["no job site", true, true, 0, [], "in_progress"],
    [
      "a critical item still pending",
      true,
      true,
      1,
      [criticalItem],
      "in_progress",
    ],
  ] as const)("%s → %s", (_name, finish, complete, sites, items, status) => {
    const state = nextSetupState({
      current: setup([...items]),
      profile: complete ? completeProfile : emptyProfile,
      goals: completeGoals,
      enabledSites: sites,
      nextStep: "background",
      options: { finishSetup: finish },
      now: NOW,
    });
    expect(state.status).toBe(status);
    expect(state.completedAt).toBe(status === "completed" ? NOW : null);
  });

  it("saves draft-resolved review items with the step and moves on", () => {
    const state = nextSetupState({
      current: setup([criticalItem]),
      profile: emptyProfile,
      goals: completeGoals,
      enabledSites: 1,
      nextStep: "background",
      options: {
        resolvedReviewItems: [{ id: "review_name", status: "edited" }],
      },
      now: NOW,
    });
    expect(state.reviewItems[0]).toMatchObject({
      status: "edited",
      resolvedAt: NOW,
    });
    expect(state.currentStep).toBe("background");
    expect(state.reviewedSteps).toEqual(["essentials"]);
    // Saving the same step again keeps one entry.
    expect(
      nextSetupState({
        current: state,
        profile: emptyProfile,
        goals: completeGoals,
        enabledSites: 1,
        nextStep: "background",
        options: { stayOnCurrentStep: true },
        now: NOW,
      }),
    ).toMatchObject({
      currentStep: "background",
      reviewedSteps: ["essentials", "background"],
    });
  });
});

describe("hasProfileEdits", () => {
  it("sends nothing for an empty batch, and anything that changes a value", () => {
    const empty = CommitProfileEditsInputSchema.parse({});
    expect(hasProfileEdits(empty)).toBe(false);
    expect(
      hasProfileEdits(
        CommitProfileEditsInputSchema.parse({
          profile: { fields: { headline: "Analyst" } },
        }),
      ),
    ).toBe(true);
    expect(
      hasProfileEdits(
        CommitProfileEditsInputSchema.parse({
          remove: [{ collection: "experiences", id: "work_1" }],
        }),
      ),
    ).toBe(true);
  });
});
