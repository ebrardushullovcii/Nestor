import { createInMemoryJobFinderRepository } from "@nestor/db";
import {
  ApplicationRecordSchema,
  JobFinderIntelligenceSafeguardsSchema,
  type ApplicationRecord,
  type ApplicationStatus,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  createCampaign,
  ensureCampaignState,
  deriveCampaignProgress,
  deriveDashboardSummary,
} from "./campaign-dashboard";

describe("dashboard summary recommendations", () => {
  test.each([false, true])(
    "counts safeguard attention before recommending a search (paused: %s)",
    (paused) => {
      const seed = createSeed();
      const campaign = createCampaign({
        id: "campaign_idle",
        name: "Idle plan",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      });

      const summary = deriveDashboardSummary({
        safeguards: JobFinderIntelligenceSafeguardsSchema.parse({
          abnormalFailurePauses: paused
            ? [
                {
                  id: `automatic_discovery_failures:${campaign.id}`,
                  windowStartedAt: "2026-08-15T09:00:00.000Z",
                  failuresInWindow: 3,
                  sampleSize: 8,
                  failureRatePercent: 37.5,
                  failureRateThresholdPercent: 30,
                  paused: true,
                  explanation: "Review failed searches.",
                  recoveryGuidance: "Open Safeguards",
                },
              ]
            : [],
        }),
        generatedAt: "2026-08-15T10:00:00.000Z",
        campaigns: {
          notifications: [],
          activeCampaignId: campaign.id,
          campaigns: [campaign],
        },
        savedJobs: [],
        reviewQueue: [],
        applicationRecords: [],
        applyRuns: [],
        userActionRequests: [],
        discovery: seed.discovery,
      });

      expect(summary.needsYouCount).toBe(paused ? 1 : 0);
      if (paused) {
        expect(summary.recommendedNextAction.route).toBe("/job-finder/actions");
        return;
      }
      expect(summary.recommendedNextAction.label).toBe("Find jobs");
      expect(summary.recommendedNextAction.detail).toBe(
        "Run the active search plan to collect relevant openings.",
      );
      expect(summary.recommendedNextAction.detail).not.toContain("campaign");
    },
  );
});

describe("dashboard applied-day metrics follow local calendar days", () => {
  /**
   * Built from local-time components so the fixture holds in every timezone
   * without hardcoding an offset; noon anchors stay clear of DST edges. The
   * exact-local-midnight sample is the discriminating case against UTC day
   * bounds in any timezone ahead of UTC.
   */
  function appliedRecord(id: string, appliedAtLocal: string) {
    return ApplicationRecordSchema.parse({
      id,
      jobId: `job_${id}`,
      title: `Engineer ${id}`,
      company: "Example",
      status: "submitted",
      lastActionLabel: "Submitted",
      nextActionLabel: null,
      lastUpdatedAt: appliedAtLocal,
    });
  }

  test("aligns today and the rolling week with local midnight boundaries", () => {
    const seed = createSeed();
    const atLocal = (day: number, hour: number, minute: number) =>
      new Date(2026, 7, day, hour, minute, 0, 0).toISOString();
    const generatedAt = atLocal(15, 12, 0);
    const campaign = createCampaign({
      id: "campaign_default",
      name: "Default",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: generatedAt,
    });

    const summary = deriveDashboardSummary({
      generatedAt,
      campaigns: {
        notifications: [],
        activeCampaignId: campaign.id,
        campaigns: [campaign],
      },
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [
        appliedRecord("applied_at_local_midnight_today", atLocal(15, 0, 0)),
        appliedRecord("applied_this_morning", atLocal(15, 9, 30)),
        appliedRecord("applied_yesterday_late_evening", atLocal(14, 23, 59)),
        appliedRecord("applied_six_days_ago_noon", atLocal(9, 12, 0)),
        appliedRecord("applied_eight_days_ago_noon", atLocal(7, 12, 0)),
        appliedRecord("applied_tomorrow_morning", atLocal(16, 9, 0)),
      ],
      applyRuns: [],
      userActionRequests: [],
      discovery: seed.discovery,
    });

    // Local-midnight-inclusive today count; yesterday's 23:59 stays outside.
    expect(summary.applicationsAppliedToday).toBe(2);
    // Existing rolling seven-day window (Aug 9..15 local), re-anchored at
    // local midnight: eight days ago and future entries stay excluded.
    expect(summary.applicationsAppliedThisWeek).toBe(4);
  });
});

describe("ready-for-approval notification resolves once preparation begins", () => {
  function approvalRecord(lastAttemptState: string | null) {
    return ApplicationRecordSchema.parse({
      id: "application_record_approval",
      jobId: "job_approval",
      title: "Engineer job_approval",
      company: "Example",
      status: "approved",
      lastActionLabel: "Resume approved",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-15T09:45:00.000Z",
      lastAttemptState,
    });
  }

  function summaryFor(
    lastAttemptState: string | null,
    status: "approved" | "ready_for_review" = "approved",
  ) {
    const seed = createSeed();
    const campaign = createCampaign({
      id: "campaign_approval",
      name: "Approval plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });

    return deriveDashboardSummary({
      generatedAt: "2026-08-15T10:00:00.000Z",
      campaigns: {
        notifications: [],
        activeCampaignId: campaign.id,
        campaigns: [campaign],
      },
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [{ ...approvalRecord(lastAttemptState), status }],
      applyRuns: [],
      userActionRequests: [],
      discovery: seed.discovery,
    });
  }

  test("does not mistake resume approval or a ready form for pending approval", () => {
    expect(summaryFor(null).applicationsReadyForApproval).toBe(0);
    expect(summaryFor("not_started").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("ready").applicationsReadyForApproval).toBe(0);
  });

  test("counts a real resume approval request before preparation", () => {
    expect(
      summaryFor(null, "ready_for_review").applicationsReadyForApproval,
    ).toBe(1);
  });

  test("stops counting once the application was prepared", () => {
    // The live walkthrough left Home saying "1 application is ready for your
    // approval" after the resume was approved and the application had already
    // been prepared and paused for the user on the employer page.
    expect(summaryFor("paused").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("in_progress").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("failed").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("submitted").applicationsReadyForApproval).toBe(0);
    expect(summaryFor("unsupported").applicationsReadyForApproval).toBe(0);
  });

  test("drops the recommended approval step once preparation began", () => {
    expect(summaryFor(null).recommendedNextAction.label).not.toBe(
      "Review prepared applications",
    );
    expect(summaryFor("paused").recommendedNextAction.label).not.toBe(
      "Review prepared applications",
    );
  });

  test("keeps a still-preparing record out of the approval count", () => {
    const seed = createSeed();
    const campaign = createCampaign({
      id: "campaign_preparing",
      name: "Preparing plan",
      mode: "precision",
      searchPreferences: seed.searchPreferences,
      now: "2026-08-15T09:00:00.000Z",
    });
    const summary = deriveDashboardSummary({
      generatedAt: "2026-08-15T10:00:00.000Z",
      campaigns: {
        notifications: [],
        activeCampaignId: campaign.id,
        campaigns: [campaign],
      },
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [
        ApplicationRecordSchema.parse({
          id: "application_record_drafting",
          jobId: "job_drafting",
          title: "Engineer job_drafting",
          company: "Example",
          status: "drafting",
          lastActionLabel: "Preparing",
          nextActionLabel: null,
          lastUpdatedAt: "2026-08-15T09:45:00.000Z",
        }),
      ],
      applyRuns: [],
      userActionRequests: [],
      discovery: seed.discovery,
    });

    expect(summary.applicationsReadyForApproval).toBe(0);
  });
});

describe("a plan card uses the application ledger", () => {
  function record(
    id: string,
    status: ApplicationStatus,
    lastAttemptState: ApplicationRecord["lastAttemptState"] = null,
  ) {
    return ApplicationRecordSchema.parse({
      id,
      jobId: `job_${id}`,
      title: `Engineer ${id}`,
      company: "Example",
      status,
      lastActionLabel: "Staged",
      nextActionLabel: null,
      lastUpdatedAt: "2026-08-15T09:00:00.000Z",
      lastAttemptState,
    });
  }

  test("counts every application record once", () => {
    const seed = createSeed();
    const progress = deriveCampaignProgress({
      campaign: createCampaign({
        id: "campaign_default",
        name: "Default",
        mode: "precision",
        searchPreferences: seed.searchPreferences,
        now: "2026-08-15T09:00:00.000Z",
      }),
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [
        record("a", "approved", "failed"),
        record("b", "approved", "paused"),
        record("c", "approved"),
        record("d", "ready_for_review"),
        record("e", "approved", "ready"),
      ],
      applyRuns: [],
      applyJobResults: [],
      unresolvedActions: 0,
      lastRunAt: null,
      now: "2026-08-15T10:00:00.000Z",
    });

    expect(progress.applicationsPrepared).toBe(5);
  });
});

test("reading old campaigns never reconciles today's row-store goals into them", async () => {
  const seed = createSeed(),
    repo = createInMemoryJobFinderRepository(seed);
  const campaign = createCampaign({
    id: "preserved",
    name: "Preserved",
    mode: "precision",
    searchPreferences: seed.searchPreferences,
    now: "2026-10-26T00:00:00.000Z",
  });
  const state = {
    notifications: [],
    activeCampaignId: campaign.id,
    campaigns: [campaign],
  };
  await repo.saveCampaignState(state);
  const persisted = await repo.getCampaignState();
  const save = vi.spyOn(repo, "saveCampaignState");
  const current = await repo.getSearchPreferences();
  const result = await ensureCampaignState({
    repository: repo,
    searchPreferences: current,
  });
  expect(result).toEqual(persisted);
  expect(save).not.toHaveBeenCalled();
  expect(await repo.getCampaignState()).toEqual(persisted);
  await repo.close?.();
});
