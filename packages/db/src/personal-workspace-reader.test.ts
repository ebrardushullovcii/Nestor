import { ResumeImportRunSchema } from "@nestor/contracts";
import { expect, it } from "vitest";

import { openJobStore } from "./job-store/job-store";
import { createProfileStore } from "./job-store/profile-store";
import { createJobFinderRepository } from "./job-store/repository";
import { readPersonalWorkspaceState } from "./personal-workspace-reader";

it("reads the saved profile and starts empty", () => {
  const store = openJobStore(":memory:");
  try {
    expect(readPersonalWorkspaceState(store)).toMatchObject({
      profile: { headline: null, email: null },
      settings: { appearanceTheme: "system" },
      latestResumeImportRun: null,
    });
    createProfileStore(store).patch({ fields: { currentLocation: "Lisbon" } });
    const personal = readPersonalWorkspaceState(store);
    expect(personal.profile.currentLocation).toBe("Lisbon");
    expect(personal).not.toHaveProperty("savedJobs");
  } finally {
    store.close();
  }
});

it("reports the newest import, even when it read a different file than the saved resume", async () => {
  const store = openJobStore(":memory:");
  try {
    const repository = createJobFinderRepository(store);
    const profile = await repository.getProfile();
    const run = (id: string, sourceResumeId: string, startedAt: string) =>
      ResumeImportRunSchema.parse({
        id,
        sourceResumeId,
        sourceResumeFileName: `${id}.pdf`,
        status: id === "new_failed" ? "failed" : "review_ready",
        startedAt,
      });
    await repository.upsertResumeImportRun(
      run("old_done", profile.baseResume.id, "2026-10-01T09:00:00.000Z"),
    );
    // A new file failed to import, so the saved resume is still the old one.
    await repository.upsertResumeImportRun(
      run("new_failed", "resume_new_file", "2026-10-02T09:00:00.000Z"),
    );
    expect(readPersonalWorkspaceState(store).latestResumeImportRun).toMatchObject(
      { id: "new_failed", status: "failed" },
    );
  } finally {
    store.close();
  }
});
