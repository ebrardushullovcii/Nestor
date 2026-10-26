import { DatabaseSync } from "node:sqlite";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  JobFinderSettingsSchema,
  ProfileSetupStateSchema,
  JobFinderActivityControlSchema,
  ResumeImportRunSchema,
  type JobFinderRepositoryState,
} from "@nestor/contracts";
import { getSingletonValue } from "./internal/state";

/** Read only the person's singleton rows; opening chat never opens the workspace runtime. */
export function readPersonalWorkspaceState(
  filePath: string,
  initial: Pick<
    JobFinderRepositoryState,
    | "profile"
    | "searchPreferences"
    | "settings"
    | "profileSetupState"
    | "activityControl"
  >,
) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=1000; BEGIN");
    const profile =
      getSingletonValue(database, "profile", CandidateProfileSchema) ??
      initial.profile;
    const run = database
      .prepare(
        "SELECT value FROM resume_import_runs WHERE source_resume_id = ? ORDER BY started_at DESC, id LIMIT 1",
      )
      .get(profile.baseResume.id) as { value: string } | undefined;
    const value = {
      profile,
      searchPreferences:
        getSingletonValue(
          database,
          "search_preferences",
          JobSearchPreferencesSchema,
        ) ?? initial.searchPreferences,
      settings:
        getSingletonValue(database, "settings", JobFinderSettingsSchema) ??
        initial.settings,
      profileSetupState:
        getSingletonValue(
          database,
          "profile_setup_state",
          ProfileSetupStateSchema,
        ) ?? initial.profileSetupState,
      activityControl:
        getSingletonValue(
          database,
          "activity_control",
          JobFinderActivityControlSchema,
        ) ?? initial.activityControl,
      latestResumeImportRun: run
        ? ResumeImportRunSchema.parse(JSON.parse(run.value))
        : null,
    };
    database.exec("COMMIT");
    return value;
  } finally {
    database.close();
  }
}
