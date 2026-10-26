import { describe, expect, test } from "vitest";
import {
  DISCOVERY_RUN_JOB_BUDGET_MAX,
  JobSearchPreferencesSchema,
} from "./discovery";
import {
  DEFAULT_SCALE_CAMPAIGN_DISCOVERY_RUN_JOB_BUDGET,
  getDefaultCampaignConfiguration,
  JobSearchCampaignLimitsSchema,
  JobSearchCampaignSchema,
  resolveCampaignSourceTargetIds,
} from "./job-search-campaigns";

const searchPreferences = {
  targetRoles: ["Software engineer"],
  jobFamilies: [],
  locations: ["Remote"],
  excludedLocations: [],
  workModes: ["remote" as const],
  seniorityLevels: [],
  targetIndustries: [],
  targetCompanyStages: [],
  employmentTypes: [],
  minimumSalaryUsd: null,
  targetSalaryUsd: null,
  salaryCurrency: "USD",
  compensation: {},
  approvalMode: "review_before_submit" as const,
  tailoringMode: "balanced" as const,
  companyBlacklist: [],
  companyWhitelist: [],
  discovery: {},
};

describe("JobSearchCampaignSchema", () => {
  test.each(["precision", "scale"] as const)(
    "keeps %s defaults within safe prepare-only limits",
    (mode) => {
      const now = "2026-08-15T10:00:00.000Z";
      const configuration = getDefaultCampaignConfiguration(mode);
      const campaign = JobSearchCampaignSchema.parse({
        id: `campaign_${mode}`,
        name: `${mode} search`,
        mode,
        status: "active",
        createdAt: now,
        updatedAt: now,
        searchPreferences,
        sourceTargetIds: [],
        ...configuration,
        progress: { lastUpdatedAt: now },
      });

      expect(campaign.applicationPolicy.finalSubmitAuthorized).toBe(false);
      expect(campaign.applicationPolicy.requireReviewBeforeExternalWrite).toBe(
        true,
      );
      expect(campaign.limits.retainedJobTarget).toBe(10_000);
      expect(campaign.limits.discoveryRunJobBudget).toBeNull();
    },
  );

  test("preserves the legacy explicit scale budget and its hard cap", () => {
    expect(DEFAULT_SCALE_CAMPAIGN_DISCOVERY_RUN_JOB_BUDGET).toBe(1_000);
    expect(DISCOVERY_RUN_JOB_BUDGET_MAX).toBe(2_000);
  });

  test("keeps legacy campaign limits parseable and rejects out-of-cap run budgets", () => {
    const baseLimits = {
      retainedJobTarget: 15,
      analysisConcurrency: 2,
      preparationBatchSize: 5,
      dailyPreparationLimit: 20,
    };

    // Persisted campaigns from before the field existed stay valid.
    expect(JobSearchCampaignLimitsSchema.parse(baseLimits)).toMatchObject(
      baseLimits,
    );

    expect(
      JobSearchCampaignLimitsSchema.parse({
        ...baseLimits,
        discoveryRunJobBudget: null,
      }).discoveryRunJobBudget,
    ).toBeNull();
    expect(
      JobSearchCampaignLimitsSchema.parse({
        ...baseLimits,
        discoveryRunJobBudget: DISCOVERY_RUN_JOB_BUDGET_MAX,
      }).discoveryRunJobBudget,
    ).toBe(DISCOVERY_RUN_JOB_BUDGET_MAX);

    expect(() =>
      JobSearchCampaignLimitsSchema.parse({
        ...baseLimits,
        discoveryRunJobBudget: DISCOVERY_RUN_JOB_BUDGET_MAX + 1,
      }),
    ).toThrow();
    expect(() =>
      JobSearchCampaignLimitsSchema.parse({
        ...baseLimits,
        discoveryRunJobBudget: 0,
      }),
    ).toThrow();
  });

  test("rejects an unsafe final-submit campaign policy", () => {
    const now = "2026-08-15T10:00:00.000Z";
    expect(() =>
      JobSearchCampaignSchema.parse({
        id: "campaign_unsafe",
        name: "Unsafe",
        mode: "scale",
        status: "active",
        createdAt: now,
        updatedAt: now,
        searchPreferences,
        sourceTargetIds: [],
        ...getDefaultCampaignConfiguration("scale"),
        applicationPolicy: {
          ...getDefaultCampaignConfiguration("scale").applicationPolicy,
          finalSubmitAuthorized: true,
        },
        progress: { lastUpdatedAt: now },
      }),
    ).toThrow();
  });
});

test("legacy plan selections do not derive sources from retired preference fields", () => {
  const preferences = JobSearchPreferencesSchema.parse({
    ...searchPreferences,
    discovery: {
      targets: [
        {
          id: "on",
          label: "On",
          startingUrl: "https://on.example.test",
          enabled: true,
        },
        {
          id: "off",
          label: "Off",
          startingUrl: "https://off.example.test",
          enabled: false,
        },
      ],
    },
  });
  const plan = {
    searchPreferences: preferences,
    sourceTargetIds: [] as string[],
  };
  expect(preferences.discovery.targets.map((row) => row.id)).toEqual([
    "on",
    "off",
  ]);
  expect(resolveCampaignSourceTargetIds(plan)).toEqual([]);
  expect(
    resolveCampaignSourceTargetIds({
      ...plan,
      sourceSelectionMode: "selected",
    }),
  ).toEqual([]);
  expect(
    resolveCampaignSourceTargetIds({
      ...plan,
      sourceSelectionMode: "selected",
      sourceTargetIds: ["off", "deleted"],
    }),
  ).toEqual(["off", "deleted"]);
});
