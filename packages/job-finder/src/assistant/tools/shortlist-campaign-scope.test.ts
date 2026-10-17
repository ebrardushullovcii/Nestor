import { describe, expect, it } from "vitest";
import {
  getDefaultCampaignConfiguration,
  JobSearchCampaignSchema,
} from "@nestor/contracts";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "../../workspace-service.test-support";
import type { AssistantHostPorts } from "../ports";
import type { AssistantTurnSession } from "../tool-kit";
import { queryJobsTool, removeFromShortlistTool } from "./jobs-tools";

async function world() {
  const seed = createSeed();
  seed.savedJobs = seed.savedJobs.map((job) => ({
    ...job,
    status: "drafting",
  }));
  // User-created plans have deliberate memberships; an untouched migration
  // plan adopts every saved job again until its first discovery run.
  const [activeJob, sharedJob] = seed.savedJobs;
  const campaign = JobSearchCampaignSchema.parse({
    id: "campaign_active",
    name: "Active search",
    mode: "precision",
    status: "active",
    createdAt: "2026-09-30T01:00:00.000Z",
    updatedAt: "2026-09-30T01:00:00.000Z",
    searchPreferences: seed.searchPreferences,
    jobIds: [activeJob!.id],
    history: [],
    ...getDefaultCampaignConfiguration("precision"),
    progress: { lastUpdatedAt: "2026-09-30T01:00:00.000Z" },
  });
  seed.campaigns = [
    campaign,
    {
      ...campaign,
      id: "campaign_other",
      name: "Other search",
      jobIds: [sharedJob!.id],
    },
  ];
  seed.activeCampaignId = campaign.id;
  const { workspaceService: service, repository } =
    createWorkspaceServiceHarness({ seed });
  await service.getWorkspaceSnapshot();
  await service.refreshCompanyIntelligence();
  const session = {
    assertCurrent: () => undefined,
    createResultSet: (input: { itemIds: string[] }) =>
      Promise.resolve({ id: "scope_result", itemIds: input.itemIds }),
  } as unknown as AssistantTurnSession;
  const ports = {
    publishWorkspaceUpdate: () => undefined,
  } as unknown as AssistantHostPorts;
  return {
    service,
    repository,
    session,
    ports,
    activeJob: activeJob!,
    sharedJob: sharedJob!,
  };
}

const shortlistQuery = {
  scope: "shortlisted",
  sort: "score",
  limit: 25,
  includeExcludedEmployers: false,
  show: true,
} as const;

describe("assistant queries use the active plan's shortlist", () => {
  it("leaves out the same saved job shortlisted only in another campaign", async () => {
    const context = await world();
    const snapshot = await context.service.getWorkspaceSnapshot();
    expect(snapshot.reviewQueue.map((item) => item.jobId)).toContain(
      context.sharedJob.id,
    );
    expect(
      snapshot.companyJobs.some((job) => job.id === context.sharedJob.id),
    ).toBe(true);
    const result = await queryJobsTool.execute(shortlistQuery, context);
    expect(
      (result.data as { jobs: { id: string }[] }).jobs.map((job) => job.id),
    ).toEqual([context.activeJob.id]);

    await context.service.selectCampaign("campaign_other");
    const otherResult = await queryJobsTool.execute(shortlistQuery, context);
    expect(
      (otherResult.data as { jobs: { id: string }[] }).jobs.map(
        (job) => job.id,
      ),
    ).toEqual([context.sharedJob.id]);
  });

  it("does not bring a removed job back because its global status is shortlisted", async () => {
    const context = await world();
    await removeFromShortlistTool.execute(
      { jobIds: [context.activeJob.id] },
      context,
    );
    const snapshot = await context.service.getWorkspaceSnapshot();
    expect(snapshot.reviewQueue.map((item) => item.jobId)).not.toContain(
      context.activeJob.id,
    );
    expect(
      snapshot.companyJobs.find((job) => job.id === context.activeJob.id)!
        .status,
    ).toBe("shortlisted");
    const result = await queryJobsTool.execute(shortlistQuery, context);
    expect(result.data).toMatchObject({ total: 0, jobs: [] });
  });

  it("keeps an application-only job out even while the plan still owns its record", async () => {
    const context = await world();
    const job = (await context.repository.listSavedJobs()).find(
      (entry) => entry.id === context.activeJob.id,
    )!;
    await context.repository.commitSavedJobDelta({
      upserts: [{ ...job, status: "submitted" }],
    });
    const snapshot = await context.service.getWorkspaceSnapshot();
    expect(
      snapshot.campaigns.find(
        (campaign) => campaign.id === snapshot.activeCampaignId,
      )!.jobIds,
    ).toContain(job.id);
    expect(snapshot.reviewQueue.map((item) => item.jobId)).not.toContain(
      context.activeJob.id,
    );
    const result = await queryJobsTool.execute(shortlistQuery, context);
    expect(result.data).toMatchObject({ total: 0, jobs: [] });
  });
});
