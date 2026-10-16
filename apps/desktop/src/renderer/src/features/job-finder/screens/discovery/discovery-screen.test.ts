import { describe, expect, it } from "vitest";
import type {
  DiscoveryRunRecord,
  JobDiscoveryTarget,
  JobSearchPreferences,
  SavedJob,
} from "@nordri/contracts";
import {
  DISCOVERY_CLEAR_MISMATCH_SCORE_FLOOR,
  getDiscoveryConfiguredFilters,
  getDiscoveryInspectedJob,
  getNewestRunForCampaign,
  getDiscoveryResultVisibility,
  isDiscoveryClearMismatch,
  updateStableDiscoveryRunSnapshot,
} from "./discovery-screen";
import {
  DISCOVERY_BROWSER_BLOCKED_REASON,
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
function createSavedJob(
  id: string,
  recommendation: SavedJob["matchAssessment"]["recommendation"],
  score = 80,
  overrides: Partial<{
    company: string;
    detailQuality: "card_only" | "detail_enriched";
    firstSeenAt: string | null;
    postedAt: string | null;
    roleSuitabilityState: "exact" | "adjacent" | "unknown" | "conflict";
    title: string;
  }> = {},
): SavedJob {
  return {
    id,
    title: overrides.title ?? id,
    company: overrides.company ?? "acme",
    detailQuality: overrides.detailQuality ?? "card_only",
    postedAt: overrides.postedAt ?? null,
    firstSeenAt: overrides.firstSeenAt ?? null,
    discoveredAt: null,
    matchAssessment: {
      recommendation,
      score,
      dimensions: {
        roleSuitability: { state: overrides.roleSuitabilityState ?? "unknown" },
      },
    },
  } as unknown as SavedJob;
}

describe("active-run result stability", () => {
  it("freezes existing rows, appends arrivals, and applies rescoring only at run end", () => {
    const original = createSavedJob("original", "strong_fit", 80);
    const started = updateStableDiscoveryRunSnapshot({
      current: null,
      jobs: [original],
      runId: "run_1",
    });
    const rescored = {
      ...original,
      matchAssessment: { ...original.matchAssessment, score: 20 },
    };
    const appended = createSavedJob("appended", "strong_fit", 90);
    const running = updateStableDiscoveryRunSnapshot({
      current: started.snapshot,
      jobs: [rescored, appended],
      runId: "run_1",
    });

    expect(running.jobs.map((job) => [job.id, job.matchAssessment.score])).toEqual([
      ["original", 80],
      ["appended", 90],
    ]);

    const completed = updateStableDiscoveryRunSnapshot({
      current: running.snapshot,
      jobs: [rescored, appended],
      runId: null,
    });
    expect(completed.jobs[0]?.matchAssessment.score).toBe(20);
    expect(completed.snapshot).toBeNull();
  });

  it("shows a row's first verdict as soon as it is judged, then holds it", () => {
    const unjudged = createSavedJob("job", "review_before_applying", 0);
    const started = updateStableDiscoveryRunSnapshot({
      current: null,
      jobs: [unjudged],
      runId: "run_1",
    });
    const judged = {
      ...unjudged,
      matchAssessment: {
        ...unjudged.matchAssessment,
        score: 72,
        judgment: { score: 72 },
      },
    } as unknown as SavedJob;
    const firstVerdict = updateStableDiscoveryRunSnapshot({
      current: started.snapshot,
      jobs: [judged],
      runId: "run_1",
    });
    expect(firstVerdict.jobs[0]?.matchAssessment.score).toBe(72);

    // A rescore later in the same run (a listing read in full) waits for
    // the run to end, so rows do not jump while the search goes on.
    const rescored = {
      ...judged,
      matchAssessment: {
        ...judged.matchAssessment,
        score: 40,
        judgment: { score: 40 },
      },
    } as unknown as SavedJob;
    const held = updateStableDiscoveryRunSnapshot({
      current: firstVerdict.snapshot,
      jobs: [rescored],
      runId: "run_1",
    });
    expect(held.jobs[0]?.matchAssessment.score).toBe(72);
  });
});

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

  it("blocks only a blocked browser session, names that blocker, and trusts a recent run over a stale snapshot", () => {
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

    expect(blocked.setupReady).toBe(true);
    expect(blocked.ready).toBe(false);
    expect(blocked.blocker).toBe("browser_blocked");
    expect(blocked.reason).toBe(DISCOVERY_BROWSER_BLOCKED_REASON);
    expect(blocked.reason).not.toMatch(/enable sources/i);

    const trusted = getDiscoverySearchReadiness(
      preferences,
      { driver: "chrome_profile_agent", status: "blocked" },
      { trustRecentRun: true },
    );
    expect(trusted.ready).toBe(true);
    expect(trusted.blocker).toBeNull();

    // Setup blockers still win over the browser so the action never points
    // at the browser while a source or role is actually missing.
    const noSources = getDiscoverySearchReadiness(
      createSearchPreferences({ targetRoles: ["Engineer"] }),
      { driver: "chrome_profile_agent", status: "blocked" },
    );
    expect(noSources.blocker).toBe("no_enabled_sources");
  });
});

describe("getDiscoveryResultVisibility", () => {
  it("pools weaker and clearly mismatched bound assessments as also found while leaving provisional scores alone", () => {
    // "Bound" here means the score is a current authority *and* was earned:
    // both binding fingerprints plus at least one verified dimension. A score
    // that was never checked past the listing title is withheld, so it is not
    // banded by that number at all.
    const bind = (job: SavedJob): SavedJob =>
      ({
        ...job,
        discoveryMethod: "provider_api",
        matchAssessment: {
          ...job.matchAssessment,
          contextFingerprint: "context",
          postingFingerprint: "posting",
          dimensions: { roleSuitability: { state: "exact" } },
          judgment: {
            source: "batch",
            judgedAt: "2026-10-02T10:00:00.000Z",
            score: job.matchAssessment.score,
            recommendation: job.matchAssessment.recommendation,
          },
        },
      }) as unknown as SavedJob;
    const strong = bind(createSavedJob("strong", "strong_fit", 80));
    const weak = bind(createSavedJob("weak", "review_before_applying", 26));
    const atFloor = bind(
      createSavedJob(
        "at-floor",
        "review_before_applying",
        DISCOVERY_CLEAR_MISMATCH_SCORE_FLOOR,
      ),
    );
    const provisionalWeak = createSavedJob(
      "provisional",
      "review_before_applying",
      12,
    );

    expect(isDiscoveryClearMismatch(weak)).toBe(true);
    expect(isDiscoveryClearMismatch(atFloor)).toBe(false);
    expect(isDiscoveryClearMismatch(provisionalWeak)).toBe(false);

    const hidden = getDiscoveryResultVisibility(
      [strong, weak, atFloor, provisionalWeak],
      null,
      false,
    );
    expect(hidden.jobs.map((job) => job.id)).not.toContain("weak");
    // A bound score at the mismatch floor is still well below the saved
    // targets, so it joins the also-found pool instead of padding the
    // headline count. A provisional score is never demoted.
    expect(hidden.jobs.map((job) => job.id)).not.toContain("at-floor");
    expect(hidden.jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining(["strong", "provisional"]),
    );
    expect(hidden.hiddenAlsoFoundCount).toBe(2);
    expect(hidden.alsoFoundCount).toBe(2);

    const revealed = getDiscoveryResultVisibility(
      [strong, weak, atFloor, provisionalWeak],
      null,
      true,
    );
    expect(revealed.jobs.map((job) => job.id)).toContain("weak");
    expect(revealed.jobs.map((job) => job.id)).toContain("at-floor");
    expect(revealed.hiddenAlsoFoundCount).toBe(0);
  });

  it("hides hard conflicts by default and keeps a transparent reveal path", () => {
    const strong = createSavedJob("strong", "strong_fit");
    const mismatch = createSavedJob("mismatch", "skip");
    const review = createSavedJob("review", "review_before_applying");

    const hidden = getDiscoveryResultVisibility(
      [strong, mismatch, review],
      mismatch,
      false,
    );

    expect(hidden.jobs.map((job) => job.id)).toEqual(["review", "strong"]);
    expect(hidden.hiddenAlsoFoundCount).toBe(1);
    expect(hidden.alsoFoundCount).toBe(1);
    expect(hidden.selectedJob?.id).toBe("review");

    const revealed = getDiscoveryResultVisibility(
      [strong, mismatch, review],
      mismatch,
      true,
    );

    expect(revealed.jobs.map((job) => job.id)).toEqual([
      "review",
      "strong",
      "mismatch",
    ]);
    expect(revealed.hiddenAlsoFoundCount).toBe(0);
    expect(revealed.alsoFoundCount).toBe(1);
    expect(revealed.selectedJob?.id).toBe("mismatch");
  });

  it("returns an explicit all-hidden state without losing mismatch count", () => {
    const firstMismatch = createSavedJob("mismatch-one", "skip");
    const secondMismatch = createSavedJob("mismatch-two", "skip");

    const hidden = getDiscoveryResultVisibility(
      [firstMismatch, secondMismatch],
      firstMismatch,
      false,
    );

    expect(hidden.jobs).toEqual([]);
    expect(hidden.hiddenAlsoFoundCount).toBe(2);
    expect(hidden.alsoFoundCount).toBe(2);
    expect(hidden.selectedJob).toBeNull();
  });

  it("preserves a visible selection instead of always selecting the first job", () => {
    const strong = createSavedJob("strong", "strong_fit");
    const review = createSavedJob("review", "review_before_applying");

    const visible = getDiscoveryResultVisibility(
      [strong, review],
      review,
      false,
    );

    expect(visible.selectedJob?.id).toBe("review");
  });

  it("keeps a requested mismatch visible for contextual navigation", () => {
    const strong = createSavedJob("strong", "strong_fit");
    const mismatch = createSavedJob("mismatch", "skip");

    const visible = getDiscoveryResultVisibility(
      [strong, mismatch],
      mismatch,
      false,
      true,
    );

    expect(visible.jobs.map((job) => job.id)).toEqual(["strong", "mismatch"]);
    expect(visible.hiddenAlsoFoundCount).toBe(0);
    expect(visible.alsoFoundCount).toBe(1);
    expect(visible.selectedJob?.id).toBe("mismatch");
  });

  it("keeps only the deep-linked mismatch visible while counting the rest hidden", () => {
    const strong = createSavedJob("strong", "strong_fit", 80);
    const review = createSavedJob("review", "review_before_applying", 90);
    const selectedMismatch = createSavedJob("selected-mismatch", "skip", 95);
    const otherMismatch = createSavedJob("other-mismatch", "skip", 99);

    const visible = getDiscoveryResultVisibility(
      [strong, otherMismatch, selectedMismatch, review],
      selectedMismatch,
      false,
      true,
    );

    // Canonical Best-match order, with only the deep-linked mismatch exposed.
    expect(visible.jobs.map((job) => job.id)).toEqual([
      "review",
      "strong",
      "selected-mismatch",
    ]);
    // Truthful visibility: the hidden mismatch is not on screen, the held
    // mismatch counts as shown, and the total count stays available for the
    // reveal control.
    expect(visible.hiddenAlsoFoundCount).toBe(1);
    expect(visible.alsoFoundCount).toBe(2);
    expect(visible.selectedJob?.id).toBe("selected-mismatch");
  });

  it("keeps every mismatch hidden for a deep link into a reviewable job", () => {
    const strong = createSavedJob("strong", "strong_fit");
    const firstMismatch = createSavedJob("mismatch-one", "skip", 99);
    const secondMismatch = createSavedJob("mismatch-two", "skip", 55);

    const visible = getDiscoveryResultVisibility(
      [firstMismatch, strong, secondMismatch],
      strong,
      false,
      true,
    );

    expect(visible.jobs.map((job) => job.id)).toEqual(["strong"]);
    expect(visible.hiddenAlsoFoundCount).toBe(2);
    expect(visible.alsoFoundCount).toBe(2);
    expect(visible.selectedJob?.id).toBe("strong");
  });

  it("toggles the preserved selection between revealed and deep-linked views", () => {
    const strong = createSavedJob("strong", "strong_fit", 80);
    const review = createSavedJob("review", "review_before_applying", 90);
    const selectedMismatch = createSavedJob("selected-mismatch", "skip", 95);
    const otherMismatch = createSavedJob("other-mismatch", "skip", 99);
    const jobs = [strong, otherMismatch, selectedMismatch, review];

    const revealed = getDiscoveryResultVisibility(
      jobs,
      selectedMismatch,
      true,
      true,
    );

    expect(revealed.jobs.map((job) => job.id)).toEqual([
      "review",
      "strong",
      "other-mismatch",
      "selected-mismatch",
    ]);
    expect(revealed.hiddenAlsoFoundCount).toBe(0);
    expect(revealed.alsoFoundCount).toBe(2);
    expect(revealed.selectedJob?.id).toBe("selected-mismatch");

    const hiddenAgain = getDiscoveryResultVisibility(
      jobs,
      selectedMismatch,
      false,
      true,
    );

    expect(hiddenAgain.jobs.map((job) => job.id)).toEqual([
      "review",
      "strong",
      "selected-mismatch",
    ]);
    expect(hiddenAgain.hiddenAlsoFoundCount).toBe(1);
    expect(hiddenAgain.alsoFoundCount).toBe(2);
    expect(hiddenAgain.selectedJob?.id).toBe("selected-mismatch");
  });

  it("orders reviewable results by descending displayed fit without mutating source order", () => {
    const ninety = createSavedJob("ninety", "strong_fit", 90);
    const ninetyTwo = createSavedJob(
      "ninety-two",
      "review_before_applying",
      92,
    );
    const eightyEight = createSavedJob("eighty-eight", "strong_fit", 88);
    const sourceJobs = [ninety, ninetyTwo, eightyEight];

    const visible = getDiscoveryResultVisibility(sourceJobs, ninety, false);

    expect(visible.jobs.map((job) => job.id)).toEqual([
      "ninety-two",
      "ninety",
      "eighty-eight",
    ]);
    expect(sourceJobs.map((job) => job.id)).toEqual([
      "ninety",
      "ninety-two",
      "eighty-eight",
    ]);
    expect(visible.selectedJob?.id).toBe("ninety");
  });

  it("keeps equal-score ties stable and revealed clear mismatches after reviewable jobs", () => {
    const firstTie = createSavedJob("first-tie", "review_before_applying", 90);
    const highMismatch = createSavedJob("high-mismatch", "skip", 99);
    const secondTie = createSavedJob("second-tie", "strong_fit", 90);

    const revealed = getDiscoveryResultVisibility(
      [firstTie, highMismatch, secondTie],
      null,
      true,
    );

    expect(revealed.jobs.map((job) => job.id)).toEqual([
      "first-tie",
      "second-tie",
      "high-mismatch",
    ]);
    expect(revealed.selectedJob?.id).toBe("first-tie");
  });

  it("ranks a role-suitability conflict by score exactly like the rank audit", () => {
    const conflictHigh = createSavedJob(
      "conflict-high",
      "review_before_applying",
      90,
      { roleSuitabilityState: "conflict" },
    );
    const exactLow = createSavedJob("exact-low", "strong_fit", 80, {
      roleSuitabilityState: "exact",
    });

    const canonicalArrival = getDiscoveryResultVisibility(
      [conflictHigh, exactLow],
      null,
      false,
    );
    const reversedArrival = getDiscoveryResultVisibility(
      [exactLow, conflictHigh],
      null,
      false,
    );

    expect(canonicalArrival.jobs.map((job) => job.id)).toEqual([
      "conflict-high",
      "exact-low",
    ]);
    expect(reversedArrival.jobs.map((job) => job.id)).toEqual([
      "conflict-high",
      "exact-low",
    ]);
  });

  it("breaks equal-score ties deterministically regardless of arrival order", () => {
    const alphaTie = createSavedJob("tie-alpha", "strong_fit", 88, {
      title: "Alpha Role",
    });
    const betaTie = createSavedJob("tie-beta", "review_before_applying", 88, {
      title: "Beta Role",
    });

    const forward = getDiscoveryResultVisibility(
      [alphaTie, betaTie],
      null,
      false,
    );
    const reversed = getDiscoveryResultVisibility(
      [betaTie, alphaTie],
      null,
      false,
    );

    const expected = ["tie-alpha", "tie-beta"];
    expect(forward.jobs.map((job) => job.id)).toEqual(expected);
    expect(reversed.jobs.map((job) => job.id)).toEqual(expected);
  });

  it("orders revealed clear mismatches among themselves by descending fit", () => {
    const strong = createSavedJob("strong", "strong_fit", 70);
    const highSkip = createSavedJob("high-skip", "skip", 99);
    const lowSkip = createSavedJob("low-skip", "skip", 55);

    const revealed = getDiscoveryResultVisibility(
      [lowSkip, strong, highSkip],
      null,
      true,
    );

    expect(revealed.jobs.map((job) => job.id)).toEqual([
      "strong",
      "high-skip",
      "low-skip",
    ]);
  });

  it("keeps a campaign candidate subset in the audit's relative order", () => {
    const fullRanking = [
      createSavedJob("full-95", "strong_fit", 95),
      createSavedJob("campaign-88", "strong_fit", 88),
      createSavedJob("subset-only-91", "strong_fit", 91),
      createSavedJob("full-84", "strong_fit", 84),
      createSavedJob("campaign-skip-99", "skip", 99),
    ];
    const campaignIds = new Set(["campaign-88", "full-95", "campaign-skip-99"]);
    const campaignArrival = fullRanking.filter((job) =>
      campaignIds.has(job.id),
    );

    const visibleSubset = getDiscoveryResultVisibility(
      [...campaignArrival].reverse(),
      null,
      true,
    );
    const expectedSubset = getDiscoveryResultVisibility(fullRanking, null, true)
      .jobs.filter((job) => campaignIds.has(job.id))
      .map((job) => job.id);

    expect(visibleSubset.jobs.map((job) => job.id)).toEqual(expectedSubset);
  });

  it("holds the visible order during reading and applies new scores after the stage ends", () => {
    const previouslyFirst = createSavedJob("previously-first", "strong_fit", 70);
    const newlyHigher = createSavedJob("newly-higher", "strong_fit", 95);

    const whileReading = getDiscoveryResultVisibility(
      [newlyHigher, previouslyFirst],
      null,
      true,
      false,
      ["previously-first", "newly-higher"],
    );
    const afterReading = getDiscoveryResultVisibility(
      [newlyHigher, previouslyFirst],
      null,
      true,
    );

    expect(whileReading.jobs.map((job) => job.id)).toEqual([
      "previously-first",
      "newly-higher",
    ]);
    expect(afterReading.jobs.map((job) => job.id)).toEqual([
      "newly-higher",
      "previously-first",
    ]);
  });
});

describe("getDiscoveryInspectedJob", () => {
  const ranked = [
    createSavedJob("top", "strong_fit", 94),
    createSavedJob("middle", "strong_fit", 71),
    createSavedJob("bottom", "strong_fit", 22),
  ];

  it("inspects the job the results panel actually displays", () => {
    expect(getDiscoveryInspectedJob(ranked, "top", "bottom")?.id).toBe(
      "bottom",
    );
  });

  it("falls back to the requested selection before the first panel report", () => {
    expect(getDiscoveryInspectedJob(ranked, "middle", undefined)?.id).toBe(
      "middle",
    );
    expect(getDiscoveryInspectedJob(ranked, null, undefined)?.id).toBe("top");
  });

  it("clears the inspector when the visible page is empty", () => {
    expect(getDiscoveryInspectedJob(ranked, "top", null)).toBeNull();
  });

  it("never inspects a job outside the ranked result set", () => {
    expect(getDiscoveryInspectedJob([], "top", undefined)).toBeNull();
    expect(getDiscoveryInspectedJob(ranked, "gone", "gone")).toBeNull();
  });
});


it("refreshes shortlist status and removes missing rows while assessments remain stable during a search", () => {
  const job = createSavedJob("selected", "strong_fit", 80);
  const snapshot = updateStableDiscoveryRunSnapshot({ current: null, jobs: [job], runId: "running" }).snapshot;
  const refreshed = updateStableDiscoveryRunSnapshot({ current: snapshot, jobs: [{ ...job, status: "shortlisted" }], runId: "running" });
  expect(refreshed.jobs[0]?.status).toBe("shortlisted");
  expect(updateStableDiscoveryRunSnapshot({ current: refreshed.snapshot, jobs: [], runId: "running" }).jobs).toEqual([]);
});
