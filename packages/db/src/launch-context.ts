import type { LaunchContext } from "@nestor/contracts";
import type { JobStore } from "./job-store/job-store";
import { createPreferencesStore } from "./job-store/preferences-store";
import { readProfileSetupState } from "./job-store/profile-workspace";

/** The first frame reads the same row stores as Profile and Settings. */
export function readLaunchContext(store: JobStore): LaunchContext {
  try {
    return {
      workspace: store.sql("SELECT id FROM profile_setup WHERE id=1").get()
        ? "read"
        : "none",
      settings: createPreferencesStore(store).settings.read(),
      profileSetupState: readProfileSetupState(store),
    };
  } catch {
    return { workspace: "unreadable", settings: null, profileSetupState: null };
  }
}
