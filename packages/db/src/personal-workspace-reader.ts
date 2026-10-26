import { DatabaseSync } from "node:sqlite";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  JobFinderSettingsSchema,
  ProfileSetupStateSchema,
  JobFinderActivityControlSchema,
  ResumeImportRunSchema,
  ResumeImportFieldCandidateSchema,
  ResumeDocumentBundleSchema,
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
    // The newest import of any file: a failed import of a new resume must
    // read as failed, not as the earlier file's finished one.
    const run = database
      .prepare(
        "SELECT id, value FROM resume_import_runs ORDER BY started_at DESC, id DESC LIMIT 1",
      )
      .get() as { id: string; value: string } | undefined;
    // What setup review is built from: that run's open candidates and the
    // document it read them from.
    const candidates = run
      ? (
          database
            .prepare(
              "SELECT value FROM resume_import_field_candidates WHERE run_id = ? AND resolution IN ('needs_review', 'abstained')",
            )
            .all(run.id) as { value: string }[]
        ).map((row) =>
          ResumeImportFieldCandidateSchema.parse(JSON.parse(row.value)),
        )
      : [];
    const bundle = run
      ? (database
          .prepare(
            "SELECT value FROM resume_import_document_bundles WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(run.id) as { value: string } | undefined)
      : undefined;
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
      latestResumeImportReviewCandidates: candidates,
      latestResumeImportBundle: bundle
        ? ResumeDocumentBundleSchema.parse(JSON.parse(bundle.value))
        : null,
    };
    database.exec("COMMIT");
    return value;
  } finally {
    database.close();
  }
}
