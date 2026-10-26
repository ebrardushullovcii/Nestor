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
