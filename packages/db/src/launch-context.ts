import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  JobFinderSettingsSchema,
  ProfileSetupStateSchema,
  type LaunchContext,
} from "@nestor/contracts";

const unknown = (workspace: "none" | "unreadable"): LaunchContext => ({
  workspace,
  settings: null,
  profileSetupState: null,
});

/**
 * Reads the first frame's settings and guided-setup state straight from the
 * workspace file, read-only, without opening the workspace. A missing file is
 * a first launch; a locked file or a row that fails to parse is unreadable,
 * and opening the workspace later owns any recovery.
 */
export function readLaunchContext(filePath: string): LaunchContext {
  if (!existsSync(filePath)) return unknown("none");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filePath, { readOnly: true });
    const rows = database
      .prepare(
        "SELECT key, value FROM singleton_state WHERE key IN ('settings', 'profile_setup_state')",
      )
      .all();
    const value = (key: string): unknown => {
      const row = rows.find((entry) => entry.key === key);
      return row ? (JSON.parse(String(row.value)) as unknown) : undefined;
    };
    const settings = JobFinderSettingsSchema.safeParse(value("settings"));
    const setup = ProfileSetupStateSchema.safeParse(
      value("profile_setup_state"),
    );
    if (!settings.success && value("settings") !== undefined)
      return unknown("unreadable");
    if (!setup.success && value("profile_setup_state") !== undefined)
      return unknown("unreadable");
    return {
      workspace: "read",
      settings: settings.success ? settings.data : null,
      profileSetupState: setup.success ? setup.data : null,
    };
  } catch {
    return unknown("unreadable");
  } finally {
    database?.close();
  }
}
