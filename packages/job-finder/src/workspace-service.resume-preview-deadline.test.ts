import type { ResumeClaimCheckInput } from "@nestor/ai-providers";
import { expect, test, vi } from "vitest";
import {
  createAiClient,
  createDocumentManager,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

test("generation preview forwards an exhausted writer budget before starting nested checks or rendering", async () => {
  const seed = createSeed();
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  const aiClient = createAiClient();
  const original = aiClient.createResumeDraft.bind(aiClient);
  const check = vi.fn<(input: ResumeClaimCheckInput) => Promise<[]>>(() =>
    Promise.resolve([]),
  );
  aiClient.checkResumeClaims = check;
  aiClient.createResumeDraft = async (input) => {
    const draft = {
      ...(await original(input)),
      summary:
        "A unique generated specialization whose preview requires nested grounding.",
    };
    await input.renderPreview!({
      draft,
      templateId: "classic_ats",
      getRemainingBudgetMs: () => 0,
    });
    return draft;
  };
  const documentManager = createDocumentManager();
  const render = vi.spyOn(documentManager, "renderResumeArtifact");
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
    documentManager,
  });
  try {
    await expect(
      workspaceService.generateResumeForBatch("job_ready", {
        shouldStop: () => false,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(check).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  } finally {
    await workspaceService.shutdown();
  }
});

test("workspace reset aborts a preview's stubborn nested claim check through the fallback signal", async () => {
  const seed = createSeed();
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  const aiClient = createAiClient();
  const original = aiClient.createResumeDraft.bind(aiClient);
  const check = vi.fn<(input: ResumeClaimCheckInput) => Promise<[]>>(
    () => new Promise(() => {}),
  );
  aiClient.checkResumeClaims = check;
  aiClient.createResumeDraft = async (input) => {
    const draft = {
      ...(await original(input)),
      summary:
        "A separate generated achievement requiring cancellation-aware grounding during preview.",
    };
    await input.renderPreview!({
      draft,
      templateId: "classic_ats",
      getRemainingBudgetMs: () => 1000,
    });
    return draft;
  };
  const documentManager = createDocumentManager();
  const render = vi.spyOn(documentManager, "renderResumeArtifact");
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
    documentManager,
  });
  const pending = workspaceService.generateResumeForBatch("job_ready", {
    shouldStop: () => false,
  });
  const settled = Promise.allSettled([pending]);
  try {
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    await workspaceService.resetWorkspace(seed);
    expect(await pending).toEqual({ jobId: "job_ready", outcome: "cancelled" });
    expect(check.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(check).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
    expect(await repository.getResumeDraftByJobId("job_ready")).toBeNull();
    expect(await repository.getTailoredAssetByJobId("job_ready")).toBeNull();
  } finally {
    await settled;
    await workspaceService.shutdown();
  }
});
