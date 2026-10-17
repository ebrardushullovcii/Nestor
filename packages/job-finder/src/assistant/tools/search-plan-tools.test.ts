import { randomUUID } from "node:crypto";
import {
  AssistantChangeReceiptSchema,
  SaveJobSearchCampaignInputSchema,
} from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import type { AssistantHostPorts } from "../ports";
import type { AssistantTurnSession } from "../tool-kit";
import {
  saveSearchPlanTool,
  listSearchPlansTool,
  undoSearchPlanChange,
} from "./search-plan-tools";

function world() {
  const { workspaceService: service } = createWorkspaceServiceHarness();
  const receipts: ReturnType<typeof AssistantChangeReceiptSchema.parse>[] = [];
  const session = {
    assertCurrent: () => undefined,
    recordChange: (
      change: Parameters<AssistantTurnSession["recordChange"]>[0],
    ) => {
      const receipt = AssistantChangeReceiptSchema.parse({
        ...change,
        id: randomUUID(),
        conversationId: "conversation",
        createdAt: new Date().toISOString(),
      });
      receipts.push(receipt);
      return Promise.resolve({
        receipt,
        part: {
          type: "change",
          receiptId: receipt.id,
          target: receipt.target,
          summary: receipt.summary,
        },
      });
    },
  } as unknown as AssistantTurnSession;
  return {
    service,
    session,
    ports: { publishWorkspaceUpdate: vi.fn() } as unknown as AssistantHostPorts,
    receipts,
  };
}
afterEach(() => vi.useRealTimers());

describe("R3-082 named search plans", () => {
  it.each([
    [
      "Columbus weekdays",
      "America/New_York",
      [1, 2, 3, 4, 5],
      "2026-10-05T13:00:00.000Z",
    ],
    [
      "Toronto weekdays",
      "America/Toronto",
      [1, 2, 3, 4, 5],
      "2026-10-05T13:00:00.000Z",
    ],
    [
      "Adjacent UX roles Seattle",
      "America/Los_Angeles",
      [2, 4],
      "2026-10-06T16:00:00.000Z",
    ],
  ])(
    "saves %s at 09:00 in the requested zone without changing another plan or apply settings",
    async (name, timeZone, daysOfWeek, nextRunAt) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
      const ctx = world();
      const before = await ctx.service.getWorkspaceSnapshot();
      const sourceIds = before.searchPreferences.discovery.targets
        .filter((source) => source.enabled)
        .map((source) => source.id);
      const result = await saveSearchPlanTool.execute(
        saveSearchPlanTool.input.parse({
          name,
          sourceIds,
          targetRoles: ["UX Designer"],
          locations: ["Seattle"],
          schedule: {
            enabled: true,
            mode: "selected_days",
            daysOfWeek,
            localStartTime: "09:00",
            timeZone,
          },
        }),
        ctx,
      );
      const after = await ctx.service.getWorkspaceSnapshot();
      expect(result.data).toMatchObject({
        name,
        sourceIds,
        schedule: {
          enabled: true,
          daysOfWeek,
          localStartTime: "09:00",
          timeZone,
          nextRunAt,
        },
      });
      expect(after.activeCampaignId).toBe(before.activeCampaignId);
      expect(
        after.campaigns.filter((plan) => plan.id === before.activeCampaignId),
      ).toEqual(
        before.campaigns.filter((plan) => plan.id === before.activeCampaignId),
      );
      expect(after.settings).toEqual(before.settings);
      expect(after.searchPreferences).toEqual(before.searchPreferences);
      expect(ctx.receipts[0]).toMatchObject({ target: "search_plan" });
      expect(result.parts?.[0]).toMatchObject({
        preview: [
          { label: "Name", after: name },
          { label: "Job sources" },
          {
            label: "Search schedule",
            after: expect.stringContaining(timeZone) as unknown,
          },
        ],
      });
      expect(JSON.stringify(result.parts?.[0])).not.toContain(
        "sourceTargetIds",
      );
      expect((await listSearchPlansTool.execute({}, ctx)).data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name,
            schedule: expect.objectContaining({
              timeZone,
              nextRunAt,
            }) as unknown,
          }),
        ]),
      );
      const undone = await undoSearchPlanChange(ctx, ctx.receipts[0]!);
      expect(undone.conflictLabels).toEqual([]);
      expect((await ctx.service.getWorkspaceSnapshot()).campaigns).toEqual(
        before.campaigns,
      );
    },
  );

  it("undoes schedule edits while preserving later name edits", async () => {
    const ctx = world();
    await saveSearchPlanTool.execute(
      saveSearchPlanTool.input.parse({
        name: "Synthetic plan",
        schedule: {
          enabled: true,
          mode: "selected_days",
          daysOfWeek: [1, 2, 3, 4, 5],
          localStartTime: "09:00",
          timeZone: "America/Toronto",
        },
      }),
      ctx,
    );
    const created = (await ctx.service.getWorkspaceSnapshot()).campaigns.find(
      (plan) => plan.name === "Synthetic plan",
    )!;
    await saveSearchPlanTool.execute(
      saveSearchPlanTool.input.parse({
        planId: created.id,
        name: created.name,
        schedule: { daysOfWeek: [2, 4], timeZone: "America/Los_Angeles" },
      }),
      ctx,
    );
    const edited = (await ctx.service.getWorkspaceSnapshot()).campaigns.find(
      (plan) => plan.id === created.id,
    )!;
    await ctx.service.saveCampaign(
      SaveJobSearchCampaignInputSchema.parse({
        ...edited,
        name: "Person's later name",
      }),
    );
    expect(
      (await undoSearchPlanChange(ctx, ctx.receipts[1]!)).conflictLabels,
    ).toEqual([]);
    const undone = (await ctx.service.getWorkspaceSnapshot()).campaigns.find(
      (plan) => plan.id === created.id,
    )!;
    expect(undone.name).toBe("Person's later name");
    expect(undone.schedule).toMatchObject({
      daysOfWeek: [1, 2, 3, 4, 5],
      timeZone: "America/Toronto",
    });
    expect(
      (await undoSearchPlanChange(ctx, ctx.receipts[0]!)).conflictLabels,
    ).not.toEqual([]);
  });

  it("rejects invalid zones, missing schedule fields and stale plan writes", async () => {
    const ctx = world();
    const before = await ctx.service.getWorkspaceSnapshot();
    await expect(
      saveSearchPlanTool.execute(
        saveSearchPlanTool.input.parse({
          name: "Bad zone",
          schedule: {
            enabled: true,
            mode: "daily",
            localStartTime: "09:00",
            timeZone: "Not/A_Zone",
          },
        }),
        ctx,
      ),
    ).rejects.toThrow("valid IANA time zone");
    await expect(
      saveSearchPlanTool.execute(
        saveSearchPlanTool.input.parse({
          name: "No time",
          schedule: { enabled: true, mode: "selected_days", daysOfWeek: [1] },
        }),
        ctx,
      ),
    ).rejects.toThrow("days, local time and time zone");
    const plan = before.campaigns[0]!;
    await expect(
      ctx.service.saveCampaign(
        SaveJobSearchCampaignInputSchema.parse({
          ...plan,
          name: "Stale",
          expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow("changed while it was being edited");
    expect(
      await ctx.service.deleteCampaign({
        campaignId: plan.id,
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
    expect((await ctx.service.getWorkspaceSnapshot()).campaigns).toEqual(
      before.campaigns,
    );
  });
});

it("does not attach a new plan's receipt to a different plan created during the save", async () => {
  const ctx = world();
  const save = ctx.service.saveCampaign.bind(ctx.service);
  vi.spyOn(ctx.service, "saveCampaign").mockImplementationOnce(
    async (input) => {
      const after = await save(input);
      const saved = after.campaigns.find((plan) => plan.name === input.name)!;
      return {
        ...after,
        campaigns: [
          { ...saved, id: "concurrent_plan", name: "Someone else's plan" },
          ...after.campaigns,
        ],
      };
    },
  );
  const result = await saveSearchPlanTool.execute(
    saveSearchPlanTool.input.parse({ name: "My synthetic plan" }),
    ctx,
  );
  expect(result.data).toMatchObject({ name: "My synthetic plan" });
  expect(ctx.receipts[0]?.targetId).not.toBe("concurrent_plan");
});

it("names the results plan and reads back Profile switches for explicitly selected off sources", async () => {
  const ctx = world();
  const before = await ctx.service.getWorkspaceSnapshot();
  const source = before.searchPreferences.discovery.targets[0]!;
  await ctx.service.saveSearchPreferences({
    ...before.searchPreferences,
    discovery: {
      ...before.searchPreferences.discovery,
      targets: before.searchPreferences.discovery.targets.map((target) =>
        target.id === source.id ? { ...target, enabled: false } : target,
      ),
    },
  });
  const result = await saveSearchPlanTool.execute(
    saveSearchPlanTool.input.parse({
      name: "Design only",
      sourceIds: [source.id],
      targetRoles: ["Designer"],
      locations: ["Berlin"],
    }),
    ctx,
  );
  expect(result.summary).toContain(
    "Results go to Design only in Find jobs and Shortlisted",
  );
  expect(result.data).toMatchObject({
    resultsPlanName: "Design only",
    profileSources: expect.arrayContaining([
      expect.objectContaining({
        id: source.id,
        enabled: false,
        searchedByPlan: true,
      }),
    ]) as unknown,
  });
  const after = await ctx.service.getWorkspaceSnapshot();
  expect(
    after.searchPreferences.discovery.targets.find(
      (target) => target.id === source.id,
    )?.enabled,
  ).toBe(false);
});

it("makes an existing inherited plan explicitly search a chosen Profile-off source", async () => {
  const ctx = world();
  const before = await ctx.service.getWorkspaceSnapshot();
  const plan = before.campaigns.find(
    (plan) => plan.id === before.activeCampaignId,
  )!;
  const source = before.searchPreferences.discovery.targets[0]!;
  await ctx.service.saveSearchPreferences({
    ...before.searchPreferences,
    discovery: {
      ...before.searchPreferences.discovery,
      targets: before.searchPreferences.discovery.targets.map((target) => ({
        ...target,
        enabled: false,
      })),
    },
  });
  await saveSearchPlanTool.execute(
    saveSearchPlanTool.input.parse({
      planId: plan.id,
      name: plan.name,
      sourceIds: [source.id],
    }),
    ctx,
  );
  const after = await ctx.service.getWorkspaceSnapshot();
  expect(after.campaigns.find((saved) => saved.id === plan.id)).toMatchObject({
    sourceSelectionMode: "selected",
    sourceTargetIds: [source.id],
  });
});
