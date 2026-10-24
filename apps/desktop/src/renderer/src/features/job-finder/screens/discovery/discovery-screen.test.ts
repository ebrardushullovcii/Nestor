import { describe, expect, it } from "vitest";
import type {
  DiscoveryRunRecord,
  JobDiscoveryTarget,
  JobSearchPreferences,
} from "@nestor/contracts";
import {
  getDiscoveryConfiguredFilters,
  getNewestRunForCampaign,
} from "./discovery-screen";
import {
  DISCOVERY_OFFLINE_RUNTIME_LABEL,
  DISCOVERY_OFFLINE_SEARCH_REASON,
  getDiscoveryRuntimeProjection,
  getDiscoverySearchReadiness,
} from "./discovery-search-readiness";

function createSearchPreferences(
  overrides: Partial<JobSearchPreferences> = {},
): JobSearchPreferences {
  return {
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
      currency: "USD",
      currencyStatus: "inherited",
    },
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    companyBlacklist: [],
    companyWhitelist: [],
    discovery: {
      historyLimit: 5,
      targets: [],
    },
    ...overrides,
  };
}
function createDiscoveryTarget(
  overrides: Partial<JobDiscoveryTarget> = {},
): JobDiscoveryTarget {
  return {
    id: "target",
    label: "Careers",
    startingUrl: "https://example.com/jobs",
    enabled: true,
    adapterKind: "auto",
    customInstructions: null,
    instructionStatus: "draft",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
    ...overrides,
  };
}

describe("getDiscoveryConfiguredFilters", () => {
  it("selects the newest run for the chosen plan and stays empty for a plan without one", () => {
    const planARun = {
      id: "run-a",
      campaignId: "plan-a",
      startedAt: "2026-09-13T08:00:00.000Z",
    } as DiscoveryRunRecord;
    const newerPlanBRun = {
      id: "run-b",
      campaignId: "plan-b",
      startedAt: "2026-09-13T09:00:00.000Z",
    } as DiscoveryRunRecord;

    expect(
      getNewestRunForCampaign([newerPlanBRun, planARun], "plan-a")?.id,
    ).toBe("run-a");
    expect(
      getNewestRunForCampaign([newerPlanBRun, planARun], "plan-c"),
    ).toBeNull();
  });

  it("counts runnable sources instead of all configured sources in the header chip", () => {
    const filters = getDiscoveryConfiguredFilters(
      createSearchPreferences({
        discovery: {
          historyLimit: 5,
          targets: [
            createDiscoveryTarget({ id: "enabled" }),
            createDiscoveryTarget({ id: "disabled", enabled: false }),
          ],
        },
      }),
    );

    expect(filters).toContain("1 enabled source");
    expect(filters).not.toContain("2 enabled sources");
  });

  it("pluralizes the enabled-source header chip for zero and many sources", () => {
    const none = getDiscoveryConfiguredFilters(
      createSearchPreferences({
        discovery: {
          historyLimit: 5,
          targets: [createDiscoveryTarget({ id: "disabled", enabled: false })],
        },
      }),
    );
    const several = getDiscoveryConfiguredFilters(
      createSearchPreferences({
        discovery: {
          historyLimit: 5,
          targets: [
            createDiscoveryTarget({ id: "first" }),
            createDiscoveryTarget({ id: "second" }),
            createDiscoveryTarget({ id: "third" }),
            createDiscoveryTarget({ id: "disabled", enabled: false }),
          ],
        },
      }),
    );

    expect(none).toContain("0 enabled sources");
    expect(several).toContain("3 enabled sources");
    expect(several).not.toContain("4 enabled sources");
  });

  it("treats job families as valid search targets for filter badges", () => {
    const filters = getDiscoveryConfiguredFilters(
      createSearchPreferences({
        jobFamilies: ["Frontend Engineering"],
      }),
    );

    expect(filters).toContain("1 search target");
    expect(filters).not.toContain("0 search targets");
  });
});

describe("getDiscoverySearchReadiness", () => {
  it("allows profile-guided searches without explicit targets and still requires a source", () => {
    const noRole = getDiscoverySearchReadiness(
      createSearchPreferences({
        discovery: {
          historyLimit: 5,
          targets: [
            {
              id: "source",
              label: "Careers",
              startingUrl: "https://example.com/careers",
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
      }),
    );
    const noSource = getDiscoverySearchReadiness(
      createSearchPreferences({ targetRoles: ["Engineer"] }),
    );

    expect(noRole.ready).toBe(true);
    expect(noRole.hasSearchRoles).toBe(false);
    expect(noRole.reason).toBeNull();
    expect(noRole.blocker).toBeNull();
    expect(noSource.ready).toBe(false);
    expect(noSource.reason).toContain("job-source URL");
  });

  it("treats a fresh workspace whose browser session was never started as agent-backed", () => {
    // A workspace that has never run discovery has no adapter session at all.
    // The only true blocker is its empty setup, so nothing here may claim the
    // search runtime is offline: the run opens the browser itself.
    const session = { driver: "uninitialized", status: "unknown" } as const;
    const runtime = getDiscoveryRuntimeProjection(session);
    const readiness = getDiscoverySearchReadiness(
      createSearchPreferences(),
      session,
    );

    expect(runtime.isOffline).toBe(false);
    expect(runtime.capability).toBe("agent_backed");
    expect(readiness.blocker).toBe("no_enabled_sources");
    expect(readiness.reason).toBe(
      "Add or enable at least one valid public job-source URL before searching.",
    );
    expect(readiness.reason).not.toContain(DISCOVERY_OFFLINE_SEARCH_REASON);
    expect(readiness.reason).not.toContain(DISCOVERY_OFFLINE_RUNTIME_LABEL);
  });

  it("keeps an uninitialized session searchable once roles and a source exist", () => {
    const readiness = getDiscoverySearchReadiness(
      createSearchPreferences({
        targetRoles: ["Engineer"],
        discovery: {
          historyLimit: 5,
          targets: [createDiscoveryTarget()],
        },
      }),
      { driver: "uninitialized", status: "unknown" },
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.blocker).toBeNull();
    expect(readiness.reason).toBeNull();
  });

  it("separates complete filters from an unavailable offline catalog runtime", () => {
    const readiness = getDiscoverySearchReadiness(
      createSearchPreferences({
        targetRoles: ["Engineer"],
        discovery: {
          historyLimit: 5,
          targets: [createDiscoveryTarget()],
        },
      }),
      { driver: "catalog_seed", status: "unknown" },
    );

    expect(readiness.setupReady).toBe(true);
    expect(readiness.sourceSearchAvailable).toBe(false);
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe(DISCOVERY_OFFLINE_SEARCH_REASON);
  });

  it("keeps a ready agent-backed runtime searchable", () => {
    const readiness = getDiscoverySearchReadiness(
      createSearchPreferences({
        targetRoles: ["Engineer"],
        discovery: {
          historyLimit: 5,
          targets: [createDiscoveryTarget()],
        },
      }),
      { driver: "chrome_profile_agent", status: "ready" },
    );

    expect(readiness.setupReady).toBe(true);
    expect(readiness.sourceSearchAvailable).toBe(true);
    expect(readiness.ready).toBe(true);
    expect(readiness.reason).toBeNull();
    expect(readiness.blocker).toBeNull();
  });

  it("keeps a closed, starting, or sign-in-pending browser searchable because the run opens it", () => {
    const preferences = createSearchPreferences({
      targetRoles: ["Engineer"],
      discovery: {
        historyLimit: 5,
        targets: [createDiscoveryTarget()],
      },
    });

    for (const status of ["unknown", "login_required"] as const) {
      const readiness = getDiscoverySearchReadiness(preferences, {
        driver: "chrome_profile_agent",
        status,
      });

      expect(readiness.sourceSearchAvailable, status).toBe(true);
      expect(readiness.ready, status).toBe(true);
      expect(readiness.reason, status).toBeNull();
      expect(readiness.blocker, status).toBeNull();
    }
  });

  it("a browser blocked on one site never disables Search", () => {
    const preferences = createSearchPreferences({
      targetRoles: ["Engineer"],
      discovery: {
        historyLimit: 5,
        targets: [createDiscoveryTarget()],
      },
    });
    const blocked = getDiscoverySearchReadiness(preferences, {
      driver: "chrome_profile_agent",
      status: "blocked",
    });

    expect(blocked.ready).toBe(true);
    expect(blocked.blocker).toBeNull();
    expect(blocked.reason).toBeNull();

    // A missing source is still the one setup step Search needs.
    const noSources = getDiscoverySearchReadiness(
      createSearchPreferences({ targetRoles: ["Engineer"] }),
      { driver: "chrome_profile_agent", status: "blocked" },
    );
    expect(noSources.blocker).toBe("no_enabled_sources");
  });
});

