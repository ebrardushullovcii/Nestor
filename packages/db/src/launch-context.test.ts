import { expect, test } from "vitest";
import { openJobStore } from "./job-store/job-store";
import { createProfileWorkspace } from "./job-store/profile-workspace";
import { createPreferencesStore } from "./job-store/preferences-store";
import { readLaunchContext } from "./launch-context";

test("first launch and later scoped changes use the row stores without an old workspace", async () => {
  const store = openJobStore(":memory:");
  try {
    expect(readLaunchContext(store)).toMatchObject({
      workspace: "none",
      profileSetupState: { status: "not_started" },
    });
    const profile = createProfileWorkspace(store);
    createPreferencesStore(store).settings.patch({
      fields: { appearanceTheme: "dark" },
    });
    await profile.methods.saveProfileSetupState({
      status: "completed",
      currentStep: "ready_check",
      completedAt: "2026-10-26T00:00:00.000Z",
      lastResumedAt: null,
      reviewItems: [],
    });
    expect(readLaunchContext(store)).toMatchObject({
      workspace: "read",
      settings: { appearanceTheme: "dark" },
      profileSetupState: { status: "completed" },
    });
    store.sql("UPDATE profile_setup SET status='invalid'").run();
    expect(readLaunchContext(store)).toEqual({
      workspace: "unreadable",
      settings: null,
      profileSetupState: null,
    });
  } finally {
    store.close();
  }
});
