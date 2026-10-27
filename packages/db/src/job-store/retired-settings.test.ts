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
    expect(columns.has("keep_session_alive")).toBe(true);
    expect(columns.has("discovery_only")).toBe(true);
    store
      .sql("UPDATE profile_settings SET keep_session_alive=0,discovery_only=1")
      .run();
    const settings = await repository.getSettings();
    expect(settings).not.toHaveProperty("keepSessionAlive");
    expect(settings).not.toHaveProperty("discoveryOnly");
    expect(settings.collapseSideMenuWithAssistant).toBe(true);
    expect(settings.writeResumesOnShortlist).toBe(true);
    await repository.commitSettingsUpdate((current) => ({
      ...current,
      appearanceTheme: "dark",
    }));
    expect(
      store
        .sql("SELECT keep_session_alive, discovery_only FROM profile_settings")
        .get(),
    ).toEqual({ keep_session_alive: 0, discovery_only: 1 });
  } finally {
    store.close();
  }
});
