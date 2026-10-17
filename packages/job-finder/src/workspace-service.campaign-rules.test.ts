import { describe, expect, test } from "vitest";

import {
  CampaignRuleSchema,
  type CampaignRuleFunnelProjection,
  type JobSearchCampaign,
  type SaveCampaignRuleInput,
  type SaveJobSearchCampaignInput,
} from "@nestor/contracts";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";

const recordedAt = "2026-08-15T10:00:00.000Z";

function createRuleInput(
  overrides: Partial<SaveCampaignRuleInput> = {},
): SaveCampaignRuleInput {
  return {
    id: null,
    kind: "must_have",
    field: "role",
    operator: "contains",
    value: "frontend",
    numericValue: null,
    currency: null,
    enabled: true,
    effect: {
      sampleSize: 0,
      removedCount: 0,
      downgradedCount: 0,
      unknownCount: 0,
      measuredAt: null,
    },
    provenance: { source: "user", confidence: 1, note: null, recordedAt },
    ...overrides,
  };
}

function toCampaignInput(
  campaign: JobSearchCampaign,
  overrides: Partial<SaveJobSearchCampaignInput> = {},
): SaveJobSearchCampaignInput {
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    mode: campaign.mode,
    status: campaign.status,
    searchPreferences: campaign.searchPreferences,
    sourceTargetIds: campaign.sourceTargetIds,
    minimumFitScore: campaign.minimumFitScore,
    limits: campaign.limits,
    stopRules: campaign.stopRules,
    applicationPolicy: campaign.applicationPolicy,
    rules: campaign.rules,
    schedule: campaign.schedule,
    latestDigest: campaign.latestDigest,
    ...overrides,
  };
}

async function getActiveCampaign(
  harness: ReturnType<typeof createWorkspaceServiceHarness>,
): Promise<JobSearchCampaign> {
  const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
  const active = snapshot.campaigns.find(
    (campaign) => campaign.id === snapshot.activeCampaignId,
  );
  if (!active) throw new Error("Expected an active campaign fixture.");
  return active;
}

describe("workspace campaign rule CRUD", () => {
  test("saveCampaignRule creates an enabled user rule with an unmeasured effect", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const active = await getActiveCampaign(harness);

    const snapshot = await workspaceService.saveCampaignRule({
      campaignId: active.id,
      rule: createRuleInput({
        field: "role",
        operator: "contains",
        value: "frontend",
      }),
    });
    const campaign = snapshot.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    if (!campaign) throw new Error("Expected the active campaign back.");

    expect(campaign.rules).toHaveLength(1);
    const rule = campaign.rules[0];
    if (!rule) throw new Error("Expected the created rule.");
    expect(rule.id).toMatch(/^campaign_rule_/);
    expect(rule.kind).toBe("must_have");
    expect(rule.field).toBe("role");
    expect(rule.enabled).toBe(true);
    expect(rule.provenance.source).toBe("user");
    expect(rule.effect).toEqual({
      sampleSize: 0,
      removedCount: 0,
      downgradedCount: 0,
      unknownCount: 0,
      measuredAt: null,
    });
  });

  test("saveCampaignRule updates an existing rule and preserves measured history", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const measuredEffect = {
      sampleSize: 5,
      removedCount: 2,
      downgradedCount: 1,
      unknownCount: 1,
      measuredAt: "2026-08-15T11:00:00.000Z",
    };
    const seeded = CampaignRuleSchema.parse({
      id: "rule_role_frontend",
      kind: "must_have",
      field: "role",
      operator: "contains",
      value: "frontend",
      enabled: true,
      provenance: { source: "user", confidence: 1, note: null, recordedAt },
      effect: measuredEffect,
    });
    await workspaceService.saveCampaign({
      ...toCampaignInput(active, { rules: [seeded] }),
    });

    // The renderer round-trips the rule without its measured effect; the
    // service must keep the previously measured remove/downgrade counts.
    const snapshot = await workspaceService.saveCampaignRule({
      campaignId: active.id,
      rule: {
        id: "rule_role_frontend",
        kind: "must_have",
        field: "role",
        operator: "contains",
        value: "backend",
        numericValue: null,
        currency: null,
        enabled: true,
        effect: {
          sampleSize: 0,
          removedCount: 0,
          downgradedCount: 0,
          unknownCount: 0,
          measuredAt: null,
        },
        provenance: { source: "user", confidence: 1, note: null, recordedAt },
      },
    });
    const campaign = snapshot.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    const updated = campaign?.rules.find(
      (rule) => rule.id === "rule_role_frontend",
    );
    if (!updated) throw new Error("Expected the updated rule.");
    expect(updated.value).toBe("backend");
    expect(updated.effect).toEqual(measuredEffect);
  });

  test("saveCampaignRule rejects unknown campaigns and unknown rule ids", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const active = await getActiveCampaign(harness);

    await expect(
      workspaceService.saveCampaignRule({
        campaignId: "campaign_missing",
        rule: createRuleInput(),
      }),
    ).rejects.toThrow("no longer exists");

    await expect(
      workspaceService.saveCampaignRule({
        campaignId: active.id,
        rule: createRuleInput({ id: "rule_missing" }),
      }),
    ).rejects.toThrow("The campaign rule no longer exists.");
  });

  test("deleteCampaignRule removes the rule and rejects unknown ids", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const created = await workspaceService.saveCampaignRule({
      campaignId: active.id,
      rule: createRuleInput(),
    });
    const campaign = created.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    const ruleId = campaign?.rules[0]?.id;
    if (!ruleId) throw new Error("Expected a created rule id.");

    const removed = await workspaceService.deleteCampaignRule({
      campaignId: active.id,
      ruleId,
    });
    const after = removed.campaigns.find(
      (candidate) => candidate.id === active.id,
    );
    expect(after?.rules).toHaveLength(0);

    await expect(
      workspaceService.deleteCampaignRule({
        campaignId: active.id,
        ruleId: "rule_missing",
      }),
    ).rejects.toThrow("The campaign rule no longer exists.");
  });

  test("toggleCampaignRule flips enabled state and back", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const created = await workspaceService.saveCampaignRule({
      campaignId: active.id,
      rule: createRuleInput(),
    });
    const ruleId = created.campaigns.find(
      (candidate) => candidate.id === active.id,
    )?.rules[0]?.id;
    if (!ruleId) throw new Error("Expected a created rule id.");

    const disabled = await workspaceService.toggleCampaignRule({
      campaignId: active.id,
      ruleId,
      enabled: false,
    });
    expect(
      disabled.campaigns
        .find((candidate) => candidate.id === active.id)
        ?.rules.find((rule) => rule.id === ruleId)?.enabled,
    ).toBe(false);

    const enabled = await workspaceService.toggleCampaignRule({
      campaignId: active.id,
      ruleId,
      enabled: true,
    });
    expect(
      enabled.campaigns
        .find((candidate) => candidate.id === active.id)
        ?.rules.find((rule) => rule.id === ruleId)?.enabled,
    ).toBe(true);

    await expect(
      workspaceService.toggleCampaignRule({
        campaignId: active.id,
        ruleId: "rule_missing",
        enabled: false,
      }),
    ).rejects.toThrow("The campaign rule no longer exists.");
  });
});

describe("workspace campaign rule funnel projection", () => {
  test("legacy campaign without rules projects an empty truthful funnel", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    expect(active.rules).toEqual([]);

    const projection: CampaignRuleFunnelProjection =
      await workspaceService.projectCampaignRuleFunnel({
        campaignId: active.id,
      });

    expect(projection.campaignId).toBe(active.id);
    expect(projection.rules).toEqual([]);
    expect(projection.disabledRuleIds).toEqual([]);
    // The default campaign retains the two seeded saved jobs; with no rules
    // every retained job is confirmed and ranked by score.
    expect(projection.funnel).toMatchObject({
      sampleSize: 2,
      hardRemovedCount: 0,
      retainedCount: 2,
      preferDowngradedCount: 0,
      uncertainCount: 0,
      confirmedRetainedCount: 2,
      rankedJobIds: ["job_ready", "job_generating"],
    });
  });

  test("unknown evidence is reported, never fabricated", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    await workspaceService.saveCampaignRule({
      campaignId: active.id,
      rule: createRuleInput({
        field: "industry",
        operator: "equals",
        value: "Fintech",
      }),
    });

    const projection = await workspaceService.projectCampaignRuleFunnel({
      campaignId: active.id,
    });
    expect(projection.rules).toHaveLength(1);
    const [rule] = projection.rules;
    expect(rule?.id).toMatch(/^campaign_rule_/);
    // Neither seeded job carries an industry signal, so the whole sample is
    // honestly unknown instead of being guessed from prose.
    expect(rule?.effect).toMatchObject({
      sampleSize: 2,
      removedCount: 0,
      downgradedCount: 0,
      unknownCount: 2,
    });
    expect(rule?.effect.measuredAt).not.toBeNull();
    expect(projection.funnel.uncertainCount).toBe(2);
    expect(projection.funnel.hardRemovedCount).toBe(0);
  });

  test("never fabricates a funnel when the campaign retains no jobs", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const created = await workspaceService.saveCampaign({
      ...toCampaignInput(active, {
        id: null,
        name: "Empty scope",
        rules: [],
      }),
    });
    const emptyCampaign = created.campaigns.find(
      (candidate) => candidate.name === "Empty scope",
    );
    if (!emptyCampaign) throw new Error("Expected the new empty campaign.");
    expect(emptyCampaign.jobIds).toEqual([]);

    await workspaceService.saveCampaignRule({
      campaignId: emptyCampaign.id,
      rule: createRuleInput(),
    });

    const projection = await workspaceService.projectCampaignRuleFunnel({
      campaignId: emptyCampaign.id,
    });
    expect(projection.rules).toHaveLength(1);
    expect(projection.rules[0]?.effect).toEqual({
      sampleSize: 0,
      removedCount: 0,
      downgradedCount: 0,
      unknownCount: 0,
      measuredAt: null,
    });
    expect(projection.funnel).toMatchObject({
      sampleSize: 0,
      hardRemovedCount: 0,
      retainedCount: 0,
      preferDowngradedCount: 0,
      uncertainCount: 0,
      confirmedRetainedCount: 0,
      rankedJobIds: [],
    });
  });

  test("disabled rules are listed but never evaluated in the funnel", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const created = await workspaceService.saveCampaignRule({
      campaignId: active.id,
      rule: createRuleInput({
        field: "company",
        operator: "equals",
        value: "Acme Corp",
      }),
    });
    const ruleId = created.campaigns.find(
      (candidate) => candidate.id === active.id,
    )?.rules[0]?.id;
    if (!ruleId) throw new Error("Expected a created rule id.");

    await workspaceService.toggleCampaignRule({
      campaignId: active.id,
      ruleId,
      enabled: false,
    });

    const projection = await workspaceService.projectCampaignRuleFunnel({
      campaignId: active.id,
    });
    expect(projection.disabledRuleIds).toEqual([ruleId]);
    expect(projection.rules).toEqual([]);
    // The never rule is off, so Acme Corp is not hard-removed.
    expect(projection.funnel).toMatchObject({
      sampleSize: 2,
      hardRemovedCount: 0,
      retainedCount: 2,
    });
  });

  test("projection rejects an unknown campaign", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    await expect(
      workspaceService.projectCampaignRuleFunnel({
        campaignId: "campaign_missing",
      }),
    ).rejects.toThrow("no longer exists");
  });
});
