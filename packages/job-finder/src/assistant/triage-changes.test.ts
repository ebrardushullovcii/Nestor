import {
  AssistantChangeReceiptSchema,
  AssistantMessagePartSchema,
  AssistantResultSetSchema,
  type AssistantChangeReceipt,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import { recordTriageChange } from "./triage-changes";
import type { AssistantToolContext, AssistantTurnSession } from "./tool-kit";
import type { AssistantHostPorts } from "./ports";
import { undoReceipt } from "./tools/profile-tools";
import { queryJobsTool, updateSourcesTool, shortlistJobsTool, removeFromShortlistTool } from "./tools/jobs-tools";

function harness() {
  const seed = createSeed();
  seed.savedJobs = seed.savedJobs.map((job) => ({
    ...job,
    status: "discovered",
  }));
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  seed.resumeExportArtifacts = [];
  seed.applicationRecords = [];
  const { workspaceService: service } = createWorkspaceServiceHarness({ seed });
  const receipts: AssistantChangeReceipt[] = [];
  const session = {
    assertCurrent: () => undefined,
    now: () => "2026-10-24T01:00:00.000Z",
    createId: () => "source_new",
    recordChange: (
      input: Parameters<AssistantTurnSession["recordChange"]>[0],
    ) => {
      const receipt = AssistantChangeReceiptSchema.parse({
        ...input,
        id: `receipt_${receipts.length}`,
        conversationId: "conversation",
        createdAt: "2026-10-24T01:00:00.000Z",
      });
      receipts.push(receipt);
      return Promise.resolve({
        receipt,
        part: AssistantMessagePartSchema.parse({
          type: "change",
          receiptId: receipt.id,
          target: receipt.target,
          summary: input.summary,
        }),
      });
    },
    getReceipt: (id: string) =>
      Promise.resolve(receipts.find((receipt) => receipt.id === id) ?? null),
    saveReceipt: (receipt: AssistantChangeReceipt) => {
      receipts[receipts.findIndex((item) => item.id === receipt.id)] = receipt;
      return Promise.resolve();
    },
  } as unknown as AssistantTurnSession;
  const ports = {
    publishWorkspaceUpdate: vi.fn(),
  } as unknown as AssistantHostPorts;
  const context: AssistantToolContext = { service, session, ports };
  return { service, session, context, receipts };
}

describe("assistant move receipts", () => {
  it("finds and shortlists a job again after moving it back, as the Find jobs button does", async () => {
    const { service, context, session } = harness();
    const id = (await service.getWorkspaceSnapshot()).discoveryJobs[0]!.id;
    const shortlist = shortlistJobsTool.input.parse({ jobIds: [id] });
    await shortlistJobsTool.execute(shortlist, context);
    await removeFromShortlistTool.execute({ jobIds: [id] }, context);
    expect((await service.getWorkspaceSnapshot()).reviewQueue.some(job => job.jobId === id)).toBe(false);
    session.createResultSet = input => Promise.resolve(AssistantResultSetSchema.parse({ ...input, id: "result", conversationId: "conversation", createdAt: "2026-10-24T00:00:00.000Z" }));
    const found = await queryJobsTool.execute(queryJobsTool.input.parse({ scope: "found", onlyIds: [id], show: false }), context);
    expect(found.data).toMatchObject({ jobs: [{ id, inShortlist: false }] });
    expect((await shortlistJobsTool.execute(shortlist, context)).summary).toContain("Shortlisted 1 job");
    expect((await service.getWorkspaceSnapshot()).reviewQueue.some(job => job.jobId === id)).toBe(true);
  });
  it("undoes a shortlist without overwriting a later profile edit", async () => {
    const { service, session, context, receipts } = harness();
    const before = await service.getWorkspaceSnapshot();
    const id = before.discoveryJobs[0]!.id;
    await service.queueJobForReview(id);
    const after = await service.getWorkspaceSnapshot();
    expect(after.reviewQueue.some((job) => job.jobId === id)).toBe(true);
    expect(
      after.discoveryJobs.find((job) => job.id === id)?.shortlistedAt ??
        after.companyJobs.find((job) => job.id === id)?.shortlistedAt,
    ).toBeTruthy();
    await recordTriageChange(session, before, after, [id], "Shortlisted job");
    await service.saveProfile({
      ...after.profile,
      headline: "Later manual headline",
    });
    const result = await undoReceipt(context, receipts[0]!.id);
    const saved = await service.getWorkspaceSnapshot();
    expect(result.receipt.status).toBe("undone");
    expect(saved.reviewQueue.some((job) => job.jobId === id)).toBe(false);
    expect(saved.profile.headline).toBe("Later manual headline");
  });

  it("restores the shortlist when undoing Hide and preserves a later conflicting move", async () => {
    const { service, session, context, receipts } = harness();
    const id = (await service.getWorkspaceSnapshot()).discoveryJobs[0]!.id;
    await service.queueJobForReview(id);
    const before = await service.getWorkspaceSnapshot();
    await service.dismissDiscoveryJob({ jobId: id, reasons: ["other"] });
    const hidden = await service.getWorkspaceSnapshot();
    await recordTriageChange(session, before, hidden, [id], "Hid job");
    await undoReceipt(context, receipts[0]!.id);
    expect(
      (await service.getWorkspaceSnapshot()).reviewQueue.some(
        (job) => job.jobId === id,
      ),
    ).toBe(true);
    const again = await service.getWorkspaceSnapshot();
    await service.dismissDiscoveryJob({ jobId: id, reasons: ["other"] });
    await recordTriageChange(
      session,
      again,
      await service.getWorkspaceSnapshot(),
      [id],
      "Hid again",
    );
    await service.restoreDismissedDiscoveryJob(id);
    const result = await undoReceipt(context, receipts[1]!.id);
    expect(result.receipt.undoConflicts.length).toBeGreaterThan(0);
    expect(
      (await service.getWorkspaceSnapshot()).dismissedDiscoveryJobs.some(
        (job) => job.id === id,
      ),
    ).toBe(false);
  });

  it("undoes only the source switch while keeping a later rename", async () => {
    const { service, context, receipts } = harness();
    const before = await service.getWorkspaceSnapshot();
    const source = before.searchPreferences.discovery.targets[0]!;
    await updateSourcesTool.execute(
      updateSourcesTool.input.parse({ disableIds: [source.id] }),
      context,
    );
    const switched = await service.getWorkspaceSnapshot();
    await service.saveSearchPreferences({
      ...switched.searchPreferences,
      discovery: {
        ...switched.searchPreferences.discovery,
        targets: switched.searchPreferences.discovery.targets.map((target) =>
          target.id === source.id
            ? { ...target, label: "Later source name" }
            : target,
        ),
      },
    });
    await undoReceipt(context, receipts[0]!.id);
    const saved = await service.getWorkspaceSnapshot();
    expect(
      saved.searchPreferences.discovery.targets.find(
        (target) => target.id === source.id,
      ),
    ).toMatchObject({ enabled: source.enabled, label: "Later source name" });
    expect(saved.searchPreferences.targetRoles).toEqual(
      before.searchPreferences.targetRoles,
    );
  });

  it("orders last shortlisted by recorded action time, not posting date", async () => {
    const { service, context, session } = harness();
    const id = (await service.getWorkspaceSnapshot()).discoveryJobs[0]!.id;
    await service.queueJobForReview(id);
    const snapshot = await service.getWorkspaceSnapshot();
    const base = snapshot.discoveryJobs[0]!;
    snapshot.discoveryJobs = [
      {
        ...base,
        id: "old",
        status: "drafting",
        postedAt: "2026-10-24T00:00:00.000Z",
        shortlistedAt: "2026-10-20T00:00:00.000Z",
      },
      {
        ...base,
        id: "new",
        status: "drafting",
        postedAt: "2026-01-01T00:00:00.000Z",
        shortlistedAt: "2026-10-23T00:00:00.000Z",
      },
      { ...base, id: "undated", status: "drafting", shortlistedAt: null },
    ];
    snapshot.companyJobs = [];
    snapshot.reviewQueue = snapshot.discoveryJobs.map((job) => ({
      ...snapshot.reviewQueue[0]!,
      jobId: job.id,
    }));
    snapshot.campaigns.find(
      (plan) => plan.id === snapshot.activeCampaignId,
    )!.jobIds = ["old", "new", "undated"];
    service.getWorkspaceProjection = () => Promise.resolve(snapshot);
    session.createResultSet = (input) =>
      Promise.resolve(
        AssistantResultSetSchema.parse({
          ...input,
          id: "result",
          conversationId: "conversation",
          createdAt: "2026-10-24T00:00:00.000Z",
        }),
      );
    const result = await queryJobsTool.execute(
      queryJobsTool.input.parse({
        scope: "shortlisted",
        sort: "shortlisted",
        show: false,
      }),
      context,
    );
    expect(result.data).toMatchObject({
      jobs: [
        { id: "new" },
        { id: "old" },
        { id: "undated", shortlistedAt: null },
      ],
    });
  });
});
