import { ResumeImportRunSchema } from "@nestor/contracts";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createTempRepository } from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";
import { readPersonalWorkspaceState } from "./personal-workspace-reader";

it("reads current personal rows without parsing job or application collections", async () => {
  const fixture = await createTempRepository("nestor-personal-read-");
  const repository = await fixture.createRepository();
  try {
    const profile = await repository.getProfile();
    await repository.saveProfile({ ...profile, currentLocation: "Lisbon" });
    const database = new DatabaseSync(fixture.filePath);
    try {
      database
        .prepare("UPDATE saved_jobs SET value = ?")
        .run("unused collection is not JSON");
    } finally {
      database.close();
    }
    const personal = readPersonalWorkspaceState(fixture.filePath, createSeed());
    expect(personal.profile.currentLocation).toBe("Lisbon");
    expect(personal).not.toHaveProperty("savedJobs");
    expect(personal).not.toHaveProperty("applicationRecords");
  } finally {
    await repository.close();
    await fixture.cleanup();
  }
});

it("reports the newest import, even when it read a different file than the saved resume", async () => {
  const fixture = await createTempRepository("nestor-personal-import-");
  const repository = await fixture.createRepository();
  try {
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
    const personal = readPersonalWorkspaceState(fixture.filePath, createSeed());
    expect(personal.latestResumeImportRun).toMatchObject({
      id: "new_failed",
      status: "failed",
    });
  } finally {
    await repository.close();
    await fixture.cleanup();
  }
});
