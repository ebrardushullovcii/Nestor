import { expect, it } from "vitest";

import { createJobFinderRepository, openJobStore } from "./job-store";

it("reads a pre-cut settings table without exposing or changing its retired choices", async () => {
  const store = openJobStore(":memory:");
  try {
    const repository = createJobFinderRepository(store);
    await repository.getSettings();
    const columns = new Set(
      (
        store.sql("PRAGMA table_info(profile_settings)").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );
    for (const name of ["keepSessionAlive", "discoveryOnly"]) {
      if (!columns.has(name))
        store
          .sql(`ALTER TABLE profile_settings ADD COLUMN "${name}" INTEGER`)
          .run();
    }
    store
      .sql('UPDATE profile_settings SET "keepSessionAlive"=0,"discoveryOnly"=1')
      .run();
    const settings = await repository.getSettings();
    expect(settings).not.toHaveProperty("keepSessionAlive");
    expect(settings).not.toHaveProperty("discoveryOnly");
    expect(settings.collapseSideMenuWithAssistant).toBe(true);
    expect(settings.writeResumesOnShortlist).toBe(true);
  } finally {
    store.close();
  }
});
