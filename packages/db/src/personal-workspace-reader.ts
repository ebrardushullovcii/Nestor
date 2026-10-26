import {
  CandidateProfileSchema,
  ResumeImportRunSchema,
  ResumeImportFieldCandidateSchema,
  ResumeDocumentBundleSchema,
} from "@nestor/contracts";
import type { JobFinderRepositorySeed } from "./repository-types";
import type { JobStore } from "./job-store/job-store";
import {
  createProfileWorkspace,
  readProfileSetupState,
} from "./job-store/profile-workspace";
import { createActivityControlStore } from "./job-store/activity-control";

/** Personal row-store reads never load job/application collections or old Profile values. */
export function readPersonalWorkspaceState(
  initial: JobFinderRepositorySeed,
  store: JobStore,
) {
  const personal = createProfileWorkspace(store, initial);
  const activityControl = createActivityControlStore(store).read();
  return store.transaction(() => {
    // Read the newest import of any file, including a failed replacement file.
    const run = store
      .sql(
        "SELECT id,value FROM profile_import_runs ORDER BY started_at DESC,id DESC LIMIT 1",
      )
      .get();
    const candidates = run
      ? store
          .sql(
            "SELECT value FROM profile_import_candidates WHERE run_id=? AND resolution IN ('needs_review','abstained') ORDER BY created_at,id",
          )
          .all(run.id!)
          .map((row) =>
            ResumeImportFieldCandidateSchema.parse(
              JSON.parse(String(row.value)),
            ),
          )
      : [];
    const bundle = run
      ? store
          .sql(
            "SELECT value FROM profile_import_documents WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
          )
          .get(run.id!)
      : undefined;
    return {
      profile: CandidateProfileSchema.parse(personal.profile.read()),
      searchPreferences: personal.preferences.goals.read(),
      settings: personal.preferences.settings.read(),
      profileSetupState: readProfileSetupState(store),
      activityControl,
      latestResumeImportRun: run
        ? ResumeImportRunSchema.parse(JSON.parse(String(run.value)))
        : null,
      latestResumeImportReviewCandidates: candidates,
      latestResumeImportBundle: bundle
        ? ResumeDocumentBundleSchema.parse(JSON.parse(String(bundle.value)))
        : null,
    };
  });
}
