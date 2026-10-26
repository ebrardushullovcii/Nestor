import type { ProfileSetupState } from "./profile-setup";
import type { JobFinderSettings } from "./workspace";

/**
 * The two facts the first frame needs: the person's
 * settings (theme, side menu) and where guided setup stands. `workspace` says
 * whether they could be read: `"none"` before a workspace exists (a first
 * launch), `"unreadable"` when the file is locked or a row is corrupt, so the
 * facts are unknown rather than empty.
 */
export interface LaunchContext {
  workspace: "none" | "read" | "unreadable";
  settings: JobFinderSettings | null;
  profileSetupState: ProfileSetupState | null;
}

export { LAUNCH_CONTEXT_CHANNEL } from "./ipc-channels";
