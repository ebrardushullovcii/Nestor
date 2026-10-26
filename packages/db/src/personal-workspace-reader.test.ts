import { openJobStore } from "./job-store/job-store";
import {
  ResumeImportRunSchema,
  createFreshStartCandidateProfile,
} from "@nestor/contracts";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createTempRepository } from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";
import { readPersonalWorkspaceState } from "./personal-workspace-reader";

it("reads current personal rows without parsing job or application collections", async () => {
  const fixture = await createTempRepository("nestor-personal-read-");
  const repository = await fixture.createRepository();
  const store = openJobStore(`${fixture.filePath}.jobs.sqlite`);
  try {
    const profile = await repository.getProfile();
    await repository.saveProfile({ ...profile, currentLocation: "Lisbon" });
    const database = new DatabaseSync(fixture.filePath);
    try {
      database
        .prepare("UPDATE saved_jobs SET value = ?")
        .run("unused collection is not JSON");
      for (const key of ["profile", "settings", "search_preferences"])
        database
          .prepare(
            "INSERT OR REPLACE INTO singleton_state(key,value) VALUES (?,?)",
          )
          .run(key, "stale singletons must never be read");
    } finally {
      database.close();
    }
    const personal = readPersonalWorkspaceState(
      fixture.filePath,
      createSeed(),
      store,
    );
    expect(personal.profile.currentLocation).toBe("Lisbon");
    expect(personal).not.toHaveProperty("savedJobs");
    expect(personal).not.toHaveProperty("applicationRecords");
  } finally {
    store.close();
    await repository.close();
    await fixture.cleanup();
  }
});

it("starts the new Profile and Settings empty instead of copying the retired singleton values", async () => {
  const fixture = await createTempRepository("nestor-no-profile-copy-");
  const repository = await fixture.createRepository();
  const store = openJobStore(":memory:");
  try {
    const legacy = new DatabaseSync(fixture.filePath);
    try {
      legacy
        .prepare(
          "INSERT OR REPLACE INTO singleton_state(key,value) VALUES (?,?)",
        )
        .run(
          "profile",
          JSON.stringify({
            ...createSeed().profile,
            headline: "Old singleton-era facts",
          }),
        );
      legacy
        .prepare(
          "INSERT OR REPLACE INTO singleton_state(key,value) VALUES (?,?)",
        )
        .run(
          "settings",
          JSON.stringify({ ...createSeed().settings, appearanceTheme: "dark" }),
        );
    } finally {
      legacy.close();
    }
    const seed = createSeed();
    const personal = readPersonalWorkspaceState(
      fixture.filePath,
      {
        ...seed,
        profile: createFreshStartCandidateProfile(),
        settings: { ...seed.settings, appearanceTheme: "system" },
      },
      store,
    );
    expect(personal.profile.headline).toBeNull();
    expect(personal.profile.email).toBeNull();
    expect(personal.settings.appearanceTheme).toBe("system");
    expect(personal.latestResumeImportRun).toBeNull();
  } finally {
    store.close();
    await repository.close();
    await fixture.cleanup();
  }
});

it("reports the newest import, even when it read a different file than the saved resume", async () => {
  const fixture = await createTempRepository("nestor-personal-import-");
  const repository = await fixture.createRepository();
  const store = openJobStore(`${fixture.filePath}.jobs.sqlite`);
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
    const personal = readPersonalWorkspaceState(
      fixture.filePath,
      createSeed(),
      store,
    );
    expect(personal.latestResumeImportRun).toMatchObject({
      id: "new_failed",
      status: "failed",
    });
  } finally {
    store.close();
    await repository.close();
    await fixture.cleanup();
  }
});
