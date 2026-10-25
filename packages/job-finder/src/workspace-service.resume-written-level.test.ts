import { describe, expect, test } from "vitest";
import {
  createWorkspaceServiceHarness,
  createSeed,
} from "./workspace-service.test-support";

// STAB-010: a job's level is saved before its rewrite runs. When the app
// closed mid-rewrite, Shortlisted named the new level over the old text.
describe("the level a resume was written at", () => {
  test("is kept on the resume until a rewrite at another level finishes", async () => {
    const seed = createSeed();
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? { ...job, resumeTailoringMode: "conservative" }
        : job,
    );
    const { workspaceService } = createWorkspaceServiceHarness({ seed });
    const item = async () =>
      (await workspaceService.getWorkspaceSnapshot()).reviewQueue.find(
        (entry) => entry.jobId === "job_ready",
      );

    await workspaceService.generateResume("job_ready");
    expect(await item()).toMatchObject({
      resumeTailoringMode: "conservative",
      resumeWrittenTailoringMode: "conservative",
    });

    // The level is saved and the app closes before the rewrite runs.
    await workspaceService.setJobResumeApplicationMode(
      "job_ready",
      "tailored_per_job",
      "aggressive",
    );
    expect(await item()).toMatchObject({
      resumeTailoringMode: "aggressive",
      resumeWrittenTailoringMode: "conservative",
    });

    await workspaceService.regenerateResumeDraft("job_ready");
    expect(await item()).toMatchObject({
      resumeTailoringMode: "aggressive",
      resumeWrittenTailoringMode: "aggressive",
    });
  });
});
