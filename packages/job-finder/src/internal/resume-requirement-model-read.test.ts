import { SaveJobSearchCampaignInputSchema } from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import { createWorkspaceServiceHarness } from "../workspace-service.test-harness";
import { createAiClient } from "../workspace-service.test-runtimes";
import { createSeed } from "../workspace-service.test-fixtures";

it("opens Resume Studio, also under another plan, without a full listing read", async () => {
  const seed = createSeed();
  const job = seed.savedJobs[0]!;
  job.matchAssessment = {
    ...job.matchAssessment,
    requirementsSource: "deterministic",
  };
  const ai = createAiClient();
  const assessJobFit = vi.fn((input: Parameters<typeof ai.assessJobFit>[0]) =>
    ai.assessJobFit(input),
  );
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...ai, assessJobFit },
  });

  const workspace = await workspaceService.getResumeWorkspace(job.id);
  expect(workspace.listingCheckState ?? null).toBeNull();
  await workspaceService.getResumeWorkspace(job.id);

  const snapshot = await workspaceService.getWorkspaceSnapshot();
  const plan = snapshot.campaigns.find(
    (plan) => plan.id === snapshot.activeCampaignId,
  )!;
  const saved = await workspaceService.saveCampaign(
    SaveJobSearchCampaignInputSchema.parse({
      ...plan,
      id: null,
      name: "Warehouse plan",
      searchPreferences: {
        ...plan.searchPreferences,
        targetRoles: ["Warehouse lead"],
      },
    }),
  );
  const next = saved.campaigns.find((plan) => plan.name === "Warehouse plan")!;
  await workspaceService.selectCampaign(next.id);
  await workspaceService.getResumeWorkspace(job.id);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // A full read is a long, high-effort call; it runs on Read and assess or
  // for the writer, not because a resume was opened.
  expect(assessJobFit).not.toHaveBeenCalled();
});
