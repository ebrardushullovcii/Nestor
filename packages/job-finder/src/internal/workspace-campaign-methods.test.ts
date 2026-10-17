import { describe, expect, test, vi } from "vitest";

import {
  DISCOVERY_NO_JOB_SITES_MESSAGE,
  DiscoveryRunReportSchema,
  DiscoveryRunRecordSchema,
  JobSearchCampaignCollectionSchema,
  JobSearchCampaignScheduleSchema,
  type DiscoveryRunRecord,
} from "@nordri/contracts";

import {
  createWorkspaceCampaignMethods,
  describeCampaignRunSummary,
} from "./workspace-campaign-methods";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import { createWorkspaceServiceHarness } from "../workspace-service.test-harness";

function createRun(overrides: Record<string, unknown>): DiscoveryRunRecord {
  return DiscoveryRunRecordSchema.parse({
    id: "discovery_run_1",
    campaignId: "campaign-1",
    state: "completed",
    startedAt: "2026-07-31T11:00:00.000Z",
    completedAt: "2026-07-31T11:05:00.000Z",
    ...overrides,
  });
}

const emptyReport = DiscoveryRunReportSchema.parse({
  measuredAt: "2026-07-31T11:05:00.000Z",
});

describe("describeCampaignRunSummary", () => {
  test("says why a run that never started failed instead of printing zero counts", () => {
    const summary = describeCampaignRunSummary(
      createRun({
        state: "failed",
        summary: { warnings: [DISCOVERY_NO_JOB_SITES_MESSAGE] },
      }),
      emptyReport,
      [],
    );

    expect(summary).toBe(`Run failed: ${DISCOVERY_NO_JOB_SITES_MESSAGE}`);
    expect(summary).not.toContain("0 of 0 sources");
    expect(summary).not.toContain("found");
  });

  test("keeps the source tally when a run that planned sources failed", () => {
    const summary = describeCampaignRunSummary(
      createRun({
        state: "failed",
        targetIds: ["source-a", "source-b"],
        targetExecutions: [
          {
            targetId: "source-a",
            adapterKind: "auto",
            state: "completed",
          },
          {
            targetId: "source-b",
            adapterKind: "auto",
            state: "failed",
          },
        ],
        summary: {
          warnings: ["The browser closed before the run finished."],
        },
      }),
      emptyReport,
      [],
    );

    expect(summary).toContain("sources completed");
    expect(summary).toContain(
      "Run failed: The browser closed before the run finished.",
    );
  });

  test("still reports frozen counts for a run that did not fail", () => {
    const summary = describeCampaignRunSummary(
      createRun({
        targetIds: ["source-a"],
        targetExecutions: [
          {
            targetId: "source-a",
            adapterKind: "auto",
            state: "completed",
          },
        ],
      }),
      DiscoveryRunReportSchema.parse({
        measuredAt: "2026-07-31T11:05:00.000Z",
        found: 12,
        new: 3,
        retained: 5,
      }),
      [],
    );

    expect(summary).toBe(
      "1 of 1 sources completed. Discovery completed: 12 found · 3 new · 5 kept.",
    );
  });
});

describe("processDueScheduledCampaigns", () => {
  async function createHarness() {
    const harness = createWorkspaceServiceHarness();
    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
    const getWorkspaceSnapshot = vi.fn(() => Promise.resolve(snapshot));
    const runCampaignDiscovery = vi.fn(() => Promise.resolve(snapshot));
    const afterCampaignRun = vi.fn(() => Promise.resolve(snapshot));
    const ctx = {
      repository: harness.repository,
      withCampaignTransition: <T>(operation: () => Promise<T>) => operation(),
    } as unknown as WorkspaceServiceContext;
    const methods = createWorkspaceCampaignMethods({
      ctx,
      getWorkspaceSnapshot,
      runCampaignDiscovery,
      afterCampaignRun,
    });
    return {
      ...harness,
      methods,
      getWorkspaceSnapshot,
      runCampaignDiscovery,
      afterCampaignRun,
    };
  }

  test("an idle manual campaign tick reads no workspace snapshot or jobs", async () => {
    const { methods, repository, getWorkspaceSnapshot } = await createHarness();
    const listSavedJobs = vi.spyOn(repository, "listSavedJobs");
    const getDiscoveryState = vi.spyOn(repository, "getDiscoveryState");

    expect(
      await methods.processDueScheduledCampaigns("2026-10-13T12:00:00.000Z"),
    ).toBe(false);
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(listSavedJobs).not.toHaveBeenCalled();
    expect(getDiscoveryState).not.toHaveBeenCalled();
  });

  test("initializing a missing scheduled time reports a change without snapshot hydration", async () => {
    const {
      methods,
      repository,
      getWorkspaceSnapshot,
      runCampaignDiscovery,
      afterCampaignRun,
    } = await createHarness();
    const state = await repository.getCampaignState();
    if (!state) throw new Error("Expected a campaign collection.");
    const campaign = state.campaigns[0];
    if (!campaign) throw new Error("Expected an active campaign.");
    await repository.saveCampaignState(
      JobSearchCampaignCollectionSchema.parse({
        ...state,
        campaigns: state.campaigns.map((candidate) =>
          candidate.id === campaign.id
            ? {
                ...candidate,
                schedule: JobSearchCampaignScheduleSchema.parse({
                  mode: "daily",
                  enabled: true,
                  daysOfWeek: [],
                  localStartTime: "09:00",
                  timeZone: "UTC",
                  pauseWindows: [],
                  runFacts: { nextRunAt: null },
                }),
              }
            : candidate,
        ),
      }),
    );

    expect(
      await methods.processDueScheduledCampaigns("2026-10-13T12:00:00.000Z"),
    ).toBe(true);
    const initialized = (await repository.getCampaignState())?.campaigns.find(
      (candidate) => candidate.id === campaign.id,
    );
    expect(initialized?.schedule.runFacts.nextRunAt).not.toBeNull();
    expect(getWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(runCampaignDiscovery).not.toHaveBeenCalled();
    expect(afterCampaignRun).not.toHaveBeenCalled();
    expect(
      await methods.processDueScheduledCampaigns("2026-10-13T12:00:00.000Z"),
    ).toBe(false);
  });
});
