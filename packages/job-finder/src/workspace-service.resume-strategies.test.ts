import { describe, expect, test } from "vitest";

import {
  ResumeDraftSchema,
  ResumeDocumentBundleSchema,
  ResumeValidationResultSchema,
  type SaveResumeStrategyInput,
} from "@nestor/contracts";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createAiClient } from "./workspace-service.test-runtimes";
import { createSeed } from "./workspace-service.test-fixtures";

function strategyInput(
  overrides: Partial<SaveResumeStrategyInput> = {},
): SaveResumeStrategyInput {
  return {
    id: null,
    name: "Product design",
    roleFamily: "Product Designer",
    baseResumeDocumentId: "resume_1",
    templateId: "modern_split",
    headlinePolicy: "role_family_template",
    skillsPolicy: "role_family_expanded",
    coveragePolicy: "role_family_recommended",
    tailoringStrength: "balanced",
    evidenceBoundaries: {
      allowExactClaims: true,
      allowParaphrasedClaims: false,
      maxEvidenceRefsPerBullet: 3,
      requireVerifierPass: true,
    },
    enabled: true,
    ...overrides,
  };
}

async function withDefaultCampaign(
  harness: ReturnType<typeof createWorkspaceServiceHarness>,
) {
  // The default campaign (including all saved jobs) is created lazily on the
  // first snapshot read.
  await harness.workspaceService.getWorkspaceSnapshot();
}

describe("workspace resume strategies end to end", () => {
  test("saveResumeStrategy creates a named strategy and recommendResumeStrategy matches its role family", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const created = await workspaceService.saveResumeStrategy(strategyInput());
    expect(created.intelligence.resumeStrategies).toHaveLength(1);
    const strategy = created.intelligence.resumeStrategies[0]!;
    expect(strategy.name).toBe("Product design");
    expect(strategy.roleFamily).toBe("Product Designer");
    expect(strategy.templateId).toBe("modern_split");
    expect(strategy.headlinePolicy).toBe("role_family_template");
    expect(strategy.skillsPolicy).toBe("role_family_expanded");
    expect(strategy.coveragePolicy).toBe("role_family_recommended");
    expect(strategy.tailoringStrength).toBe("balanced");
    expect(strategy.enabled).toBe(true);

    const recommendation = await workspaceService.recommendResumeStrategy({
      jobId: "job_ready",
    });
    expect(recommendation.strategyId).toBe(strategy.id);
    expect(recommendation.strategyName).toBe("Product design");
    expect(recommendation.source).toBe("role_family");
    expect(recommendation.roleFamily).toBe("Product Designer");
    expect(recommendation.campaignId).toBe("campaign_default");
    expect(recommendation.reason.length).toBeGreaterThan(0);
  });

  test("a disabled strategy is never recommended even for an exact role family", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const created = await workspaceService.saveResumeStrategy(strategyInput());
    const strategyId = created.intelligence.resumeStrategies[0]!.id;
    const disabled = await workspaceService.disableResumeStrategy(strategyId);
    expect(disabled.intelligence.resumeStrategies[0]!.enabled).toBe(false);

    const recommendation = await workspaceService.recommendResumeStrategy({
      jobId: "job_ready",
    });
    expect(recommendation.strategyId).toBeNull();
    expect(recommendation.source).toBe("none");
    expect(recommendation.reason).toBe(
      "No enabled resume approaches exist yet and no search plan fallback is set.",
    );
  });

  test("recommendResumeStrategy truthfully reports an unmatched job family while enabled approaches exist", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    await workspaceService.saveResumeStrategy(
      strategyInput({
        name: "Software engineering",
        roleFamily: "Software Engineering",
      }),
    );

    // "Senior Product Designer" derives no role family from the enabled
    // approaches, and no search plan fallback is set.
    const recommendation = await workspaceService.recommendResumeStrategy({
      jobId: "job_ready",
    });
    expect(recommendation.strategyId).toBeNull();
    expect(recommendation.source).toBe("none");
    expect(recommendation.reason).toBe(
      "No enabled approach matched this job and no search plan fallback is set.",
    );
  });

  test("the campaign default is used when no role family matches", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const created = await workspaceService.saveResumeStrategy(
      strategyInput({
        name: "Data engineering",
        roleFamily: "Data Engineering",
      }),
    );
    const strategyId = created.intelligence.resumeStrategies[0]!.id;
    await workspaceService.setCampaignResumeStrategyDefault({
      campaignId: "campaign_default",
      strategyId,
    });

    // "Senior Product Designer" does not match "Data Engineering".
    const recommendation = await workspaceService.recommendResumeStrategy({
      jobId: "job_ready",
    });
    expect(recommendation.strategyId).toBe(strategyId);
    expect(recommendation.source).toBe("campaign_default");
    expect(recommendation.campaignId).toBe("campaign_default");
    expect(recommendation.roleFamily).toBeNull();
    // The fallback reason names the approach, never the raw strategy id.
    expect(recommendation.reason).toBe(
      "No enabled approach matched this job; using search plan fallback “Data engineering”.",
    );
    expect(recommendation.reason).not.toContain(strategyId);
  });

  test("recommendResumeStrategy reports a persisted-but-disabled search plan fallback truthfully", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    await workspaceService.saveResumeStrategy(
      strategyInput({
        name: "Software engineering",
        roleFamily: "Software Engineering",
      }),
    );

    const created = await workspaceService.saveResumeStrategy(
      strategyInput({
        name: "Generalist",
        roleFamily: "General",
      }),
    );
    const generalistId = created.intelligence.resumeStrategies[1]!.id;

    // The default is set while Generalist is enabled...
    await workspaceService.setCampaignResumeStrategyDefault({
      campaignId: "campaign_default",
      strategyId: generalistId,
    });
    // ...and disabling it keeps the default persisted on the campaign.
    await workspaceService.disableResumeStrategy(generalistId);

    // "Senior Product Designer" matches no enabled approach, so the disabled
    // default cannot apply and the reason must say exactly that instead of
    // claiming that no fallback was set.
    const recommendation = await workspaceService.recommendResumeStrategy({
      jobId: "job_ready",
    });
    expect(recommendation.strategyId).toBeNull();
    expect(recommendation.source).toBe("none");
    expect(recommendation.reason).toBe(
      "No enabled approach matched this job and the configured search plan fallback “Generalist” is disabled.",
    );
    expect(recommendation.reason).not.toContain(generalistId);
  });

  test("a disabled strategy cannot become the campaign default", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const created = await workspaceService.saveResumeStrategy(strategyInput());
    const strategyId = created.intelligence.resumeStrategies[0]!.id;
    await workspaceService.disableResumeStrategy(strategyId);

    await expect(
      workspaceService.setCampaignResumeStrategyDefault({
        campaignId: "campaign_default",
        strategyId,
      }),
    ).rejects.toThrow(/disabled/);
  });

  test("recommendation enforces campaign scope", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    await expect(
      workspaceService.recommendResumeStrategy({
        jobId: "job_ready",
        campaignId: "campaign_other",
      }),
    ).rejects.toThrow(/not available/);
  });

  test("selectResumeStrategy records the inspectable reason and rejects disabled strategies", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const created = await workspaceService.saveResumeStrategy(strategyInput());
    const strategyId = created.intelligence.resumeStrategies[0]!.id;
    const reason = "User picked the product-design strategy for this posting.";

    const selected = await workspaceService.selectResumeStrategy({
      jobId: "job_ready",
      campaignId: "campaign_default",
      strategyId,
      source: "manual",
      reason,
    });
    expect(selected.intelligence.resumeStrategySelections).toHaveLength(1);
    expect(selected.intelligence.resumeStrategySelections[0]).toMatchObject({
      jobId: "job_ready",
      campaignId: "campaign_default",
      strategyId,
      source: "user",
      reason,
    });

    await workspaceService.disableResumeStrategy(strategyId);
    await expect(
      workspaceService.selectResumeStrategy({
        jobId: "job_ready",
        campaignId: "campaign_default",
        strategyId,
        source: "manual",
        reason: "Should be rejected.",
      }),
    ).rejects.toThrow(/disabled/);
  });

  test("selecting a strategy for a job outside the campaign is rejected", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const created = await workspaceService.saveResumeStrategy(strategyInput());
    const strategyId = created.intelligence.resumeStrategies[0]!.id;

    await expect(
      workspaceService.selectResumeStrategy({
        jobId: "job_ready",
        campaignId: "campaign_other",
        strategyId,
        source: "manual",
        reason: "Wrong campaign.",
      }),
    ).rejects.toThrow(/not available/);
  });

  test("reusing a strategy never approves, readies, or mutates an existing resume artifact", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    // Seed the draft first without any strategy.
    const beforeWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    expect(beforeWorkspace.draft.templateId).toBe("classic_ats");
    expect(beforeWorkspace.draft.status).not.toBe("approved");
    expect(beforeWorkspace.strategyContext?.selectedStrategyId).toBeNull();
    expect(beforeWorkspace.strategyContext?.recommendedStrategyId).toBeNull();

    const beforeAsset = (
      await workspaceService.getWorkspaceSnapshot()
    ).tailoredAssets.find((asset) => asset.jobId === "job_ready");

    const created = await workspaceService.saveResumeStrategy(strategyInput());
    const strategyId = created.intelligence.resumeStrategies[0]!.id;
    const selected = await workspaceService.selectResumeStrategy({
      jobId: "job_ready",
      campaignId: "campaign_default",
      strategyId,
      source: "manual",
      reason: "Reuse the product-design strategy.",
    });
    const afterAsset = selected.tailoredAssets.find(
      (asset) => asset.jobId === "job_ready",
    );
    // Strategy actions only touch intelligence state; the artifact is
    // untouched and never approved/readied by the reuse.
    expect(afterAsset).toEqual(beforeAsset);

    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    // The existing draft is preserved: the strategy does not silently replace
    // its template, and it stays unapproved.
    expect(workspace.draft.templateId).toBe("classic_ats");
    expect(workspace.draft.approvedAt).toBeNull();
    expect(workspace.draft.approvedExportId).toBeNull();
    expect(workspace.draft.status).not.toBe("approved");

    expect(workspace.strategyContext?.recommendedStrategyId).toBe(strategyId);
    expect(workspace.strategyContext?.recommendedStrategyName).toBe(
      "Product design",
    );
    expect(workspace.strategyContext?.recommendationSource).toBe("role_family");
    expect(workspace.strategyContext?.selectionReason).toBe(
      "Reuse the product-design strategy.",
    );
    // The strategy context is advisory and must never carry approval or
    // readiness authority.
    expect(workspace.strategyContext).not.toHaveProperty("approvedAt");
    expect(workspace.strategyContext).not.toHaveProperty("approvedExportId");
    expect(workspace.strategyContext).not.toHaveProperty("applicationReady");
    expect(workspace.strategyContext).not.toHaveProperty("current");
  });

  test("a fresh draft is seeded from the selected strategy's template but never approved", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const created = await workspaceService.saveResumeStrategy(
      strategyInput({ templateId: "technical_matrix" }),
    );
    const strategyId = created.intelligence.resumeStrategies[0]!.id;
    await workspaceService.selectResumeStrategy({
      jobId: "job_generating",
      campaignId: "campaign_default",
      strategyId,
      source: "role_family",
      reason: "Role-family match for this job.",
    });

    const workspace =
      await workspaceService.getResumeWorkspace("job_generating");
    expect(workspace.strategyContext?.selectedStrategyId).toBe(strategyId);
    expect(workspace.strategyContext?.selectionSource).toBe("rule_match");
    expect(workspace.draft.templateId).toBe("technical_matrix");
    expect(workspace.draft.approvedAt).toBeNull();
    expect(workspace.draft.approvedExportId).toBeNull();
    expect(workspace.draft.status).not.toBe("approved");
    expect(workspace.strategyContext).not.toHaveProperty("approvedAt");
  });

  test("automatic template recommendations stay editable while explicit choices stay locked", async () => {
    type DraftInput = Parameters<
      ReturnType<typeof createAiClient>["createResumeDraft"]
    >[0];
    const recommendedBaseClient = createAiClient();
    let recommendedInput!: DraftInput;
    const recommendedHarness = createWorkspaceServiceHarness({
      aiClient: {
        ...recommendedBaseClient,
        createResumeDraft(input) {
          recommendedInput = input;
          return recommendedBaseClient.createResumeDraft(input);
        },
      },
    });
    await withDefaultCampaign(recommendedHarness);
    await recommendedHarness.workspaceService.saveResumeStrategy(
      strategyInput({ templateId: "modern_split" }),
    );
    await recommendedHarness.workspaceService.generateResume("job_ready");

    expect(recommendedInput.selectedTemplateId).toBe("modern_split");
    expect(recommendedInput.templateSelectionLocked).toBe(false);

    const selectedBaseClient = createAiClient();
    let selectedInput!: DraftInput;
    const selectedHarness = createWorkspaceServiceHarness({
      aiClient: {
        ...selectedBaseClient,
        createResumeDraft(input) {
          selectedInput = input;
          return selectedBaseClient.createResumeDraft(input);
        },
      },
    });
    await withDefaultCampaign(selectedHarness);
    const created = await selectedHarness.workspaceService.saveResumeStrategy(
      strategyInput({ templateId: "technical_matrix" }),
    );
    await selectedHarness.workspaceService.selectResumeStrategy({
      jobId: "job_ready",
      campaignId: "campaign_default",
      strategyId: created.intelligence.resumeStrategies[0]!.id,
      source: "manual",
      reason: "Keep the selected technical layout.",
    });
    await selectedHarness.workspaceService.generateResume("job_ready");

    expect(selectedInput.selectedTemplateId).toBe("technical_matrix");
    expect(selectedInput.templateSelectionLocked).toBe(true);
  });

  test("a template the person changed on the draft stays locked on regeneration", async () => {
    const baseClient = createAiClient();
    type DraftInput = Parameters<typeof baseClient.createResumeDraft>[0];
    const capturedInputs: DraftInput[] = [];
    const harness = createWorkspaceServiceHarness({
      aiClient: {
        ...baseClient,
        createResumeDraft(input) {
          capturedInputs.push(input);
          return baseClient.createResumeDraft(input);
        },
      },
    });

    await harness.workspaceService.generateResume("job_ready");
    const workspace =
      await harness.workspaceService.getResumeWorkspace("job_ready");
    await harness.workspaceService.saveResumeDraft({
      ...workspace.draft,
      templateId: "technical_matrix",
    });
    await harness.workspaceService.generateResume("job_ready");

    expect(capturedInputs.at(-1)?.selectedTemplateId).toBe("technical_matrix");
    expect(capturedInputs.at(-1)?.templateSelectionLocked).toBe(true);
  });

  test("generation uses the selected base document content", async () => {
    async function generateFromBaseDocument(
      documentId: string,
      fullText: string,
    ) {
      const seed = createSeed();
      const seededJob = seed.savedJobs.find(
        (job) => job.id === "job_generating",
      );
      if (!seededJob) {
        throw new Error("Expected the generating test job in the seed.");
      }
      seededJob.keySkills = ["Postman", "Cypress"];
      seed.resumeImportDocumentBundles = [
        ResumeDocumentBundleSchema.parse({
          id: documentId,
          runId: `run_${documentId}`,
          sourceResumeId: documentId,
          sourceFileKind: "plain_text",
          primaryParserKind: "plain_text",
          createdAt: "2026-08-17T10:00:00.000Z",
          fullText,
        }),
      ];
      const fallbackClient = createAiClient();
      type DraftInput = Parameters<typeof fallbackClient.createResumeDraft>[0];
      let capturedInput!: DraftInput;
      const harness = createWorkspaceServiceHarness({
        seed,
        aiClient: {
          ...fallbackClient,
          createResumeDraft(input) {
            capturedInput = input;
            return fallbackClient.createResumeDraft(input);
          },
        },
      });
      await withDefaultCampaign(harness);
      const created = await harness.workspaceService.saveResumeStrategy(
        strategyInput({
          baseResumeDocumentId: documentId,
          skillsPolicy: "per_job_tailored",
        }),
      );
      const strategyId = created.intelligence.resumeStrategies[0]!.id;
      await harness.workspaceService.selectResumeStrategy({
        jobId: "job_generating",
        campaignId: "campaign_default",
        strategyId,
        source: "manual",
        reason: "Use the selected source document.",
      });
      await harness.workspaceService.generateResume("job_generating");
      const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
      return {
        asset: snapshot.tailoredAssets.find(
          (asset) => asset.jobId === "job_generating",
        )!,
        capturedInput,
      };
    }

    const vue = await generateFromBaseDocument(
      "document_vue",
      "Alex Vanguard\nSkills\nPostman",
    );
    const svelte = await generateFromBaseDocument(
      "document_svelte",
      "Alex Vanguard\nSkills\nCypress",
    );

    expect(vue.capturedInput.resumeText).toContain("Postman");
    expect(svelte.capturedInput.resumeText).toContain("Cypress");
    expect(vue.asset.contentText).toContain("Postman");
    expect(vue.asset.contentText).not.toContain("Cypress");
    expect(svelte.asset.contentText).toContain("Cypress");
    expect(svelte.asset.contentText).not.toContain("Postman");
  });

  test("recommendResumeStrategy returns an honest no-match with a reason when nothing applies", async () => {
    const harness = createWorkspaceServiceHarness();
    const { workspaceService } = harness;
    await withDefaultCampaign(harness);

    const recommendation = await workspaceService.recommendResumeStrategy({
      jobId: "job_ready",
    });
    expect(recommendation.strategyId).toBeNull();
    expect(recommendation.source).toBe("none");
    expect(recommendation.reason).toBe(
      "No enabled resume approaches exist yet and no search plan fallback is set.",
    );
  });

  test("reusing a strategy never clears an approval nor un-stales an approved artifact", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    await withDefaultCampaign(harness);

    // Seed an approved draft for job_ready and a stale draft for
    // job_generating directly, then reuse a strategy for both jobs.
    const readyWorkspace =
      await workspaceService.getResumeWorkspace("job_ready");
    const generatingWorkspace =
      await workspaceService.getResumeWorkspace("job_generating");
    const approvedDraft = ResumeDraftSchema.parse({
      ...readyWorkspace.draft,
      status: "approved",
      approvedAt: "2026-08-15T09:30:00.000Z",
      approvedExportId: "export_approved_1",
      staleReason: null,
    });
    const staleDraft = ResumeDraftSchema.parse({
      ...generatingWorkspace.draft,
      status: "stale",
      approvedAt: "2026-08-15T09:00:00.000Z",
      approvedExportId: "export_stale_1",
      staleReason:
        "Saved job details changed after approval and the resume needs a fresh review.",
    });
    const validation = ResumeValidationResultSchema.parse({
      id: "validation_strategy_safety_1",
      draftId: approvedDraft.id,
      issues: [],
      draftContentHash: "strategy-safety-hash",
      claimAssessments: [],
      coverageComparison: null,
      pageCount: null,
      validatedAt: "2026-08-15T09:30:00.000Z",
    });
    // Matching export artifacts must exist for the approval ids to resolve.
    // Seed them through the only supported approval path: neither repository
    // accepts an approved artifact through upsertResumeExportArtifact,
    // because only approveResumeExport demotes the job's sibling exports.
    await repository.approveResumeExport({
      draft: approvedDraft,
      exportArtifact: {
        id: "export_approved_1",
        draftId: approvedDraft.id,
        jobId: "job_ready",
        format: "pdf",
        filePath: "/tmp/approved.pdf",
        pageCount: 1,
        templateId: approvedDraft.templateId,
        exportedAt: "2026-08-15T09:30:00.000Z",
        isApproved: true,
      },
    });
    await repository.approveResumeExport({
      draft: staleDraft,
      exportArtifact: {
        id: "export_stale_1",
        draftId: staleDraft.id,
        jobId: "job_generating",
        format: "pdf",
        filePath: "/tmp/stale.pdf",
        pageCount: 1,
        templateId: staleDraft.templateId,
        exportedAt: "2026-08-15T09:00:00.000Z",
        isApproved: true,
      },
    });
    await repository.saveResumeDraftWithValidation({
      draft: approvedDraft,
      validation,
    });
    await repository.saveResumeDraftWithValidation({
      draft: staleDraft,
      validation: {
        ...validation,
        id: "validation_strategy_safety_2",
        draftId: staleDraft.id,
        issues: [
          {
            id: `issue_stale_${staleDraft.id}`,
            severity: "warning",
            category: "stale_approval",
            sectionId: null,
            entryId: null,
            bulletId: null,
            message: staleDraft.staleReason ?? "Stale approval.",
          },
        ],
      },
    });

    const created = await workspaceService.saveResumeStrategy(strategyInput());
    const strategyId = created.intelligence.resumeStrategies[0]!.id;
    await workspaceService.selectResumeStrategy({
      jobId: "job_ready",
      campaignId: "campaign_default",
      strategyId,
      source: "manual",
      reason: "Reuse on an approved job.",
    });
    await workspaceService.selectResumeStrategy({
      jobId: "job_generating",
      campaignId: "campaign_default",
      strategyId,
      source: "manual",
      reason: "Reuse on a stale job.",
    });

    const readyAfter = await workspaceService.getResumeWorkspace("job_ready");
    expect(readyAfter.draft.status).toBe("approved");
    expect(readyAfter.draft.approvedAt).toBe("2026-08-15T09:30:00.000Z");
    expect(readyAfter.draft.approvedExportId).toBe("export_approved_1");
    expect(readyAfter.strategyContext?.selectedStrategyId).toBe(strategyId);

    const generatingAfter =
      await workspaceService.getResumeWorkspace("job_generating");
    expect(generatingAfter.draft.status).toBe("stale");
    expect(generatingAfter.draft.staleReason).toContain("needs a fresh review");
    expect(generatingAfter.draft.approvedExportId).toBe("export_stale_1");
  });
});
