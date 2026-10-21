import { expect, test, vi } from "vitest";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";
import { createAiClient } from "./workspace-service.test-runtimes";

test("opening one resume reads targeted job rows without loading every saved job", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness();
  const all = vi.spyOn(repository, "listSavedJobs");
  const targeted = vi.spyOn(repository, "listSavedJobsByIds");
  await workspaceService.getResumeWorkspace("job_ready");
  expect(all).not.toHaveBeenCalled();
  expect(
    targeted.mock.calls.every(
      ([ids]) => ids.length === 1 && ids[0] === "job_ready",
    ),
  ).toBe(true);
});

test("opening resumes starts no full listing read", async () => {
  const seed = createSeed();
  const base = seed.savedJobs[0]!;
  seed.savedJobs = Array.from({ length: 6 }, (_, index) => ({
    ...base,
    id: `resume_${index}`,
    canonicalUrl: `https://example.test/resume_${index}`,
    matchAssessment: {
      ...base.matchAssessment,
      requirementsSource: "deterministic" as const,
    },
    planAssessments: {},
  }));
  seed.resumeDrafts = [];
  seed.tailoredAssets = [];
  const aiClient = createAiClient();
  const assess = vi.spyOn(aiClient, "assessJobFit");
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
  });
  for (const job of seed.savedJobs) {
    const workspace = await workspaceService.getResumeWorkspace(job.id);
    expect(workspace.listingCheckState ?? null).toBeNull();
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(assess).not.toHaveBeenCalled();
  await workspaceService.shutdown();
});

test("saving only job sources leaves an approved resume current", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness();
  await workspaceService.generateResume("job_ready");
  const draft = (await repository.getResumeDraftByJobId("job_ready"))!;
  await repository.upsertResumeDraft({
    ...draft,
    status: "approved",
    approvedAt: draft.updatedAt,
    approvedExportId: "synthetic_export",
  });
  const profile = await repository.getProfile();
  const preferences = await repository.getSearchPreferences();
  await workspaceService.saveProfileAndSearchPreferences(profile, {
    ...preferences,
    discovery: { ...preferences.discovery, targets: [] },
  });
  expect((await repository.getResumeDraftByJobId("job_ready"))!.status).toBe(
    "approved",
  );
});
