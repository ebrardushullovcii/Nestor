import type { JobStore } from "./job-store";
import { createProfileStore } from "./profile-store";

/** Synthetic preconditions for the isolated desktop test API; no application is sent. */
export function seedTrackerDemo(store: JobStore, ids: number[]) {
  store.transaction(() => {
    store.setStage(ids, "applied");
    const now = Date.now();
    for (const id of ids)
      store
        .sql(
          "INSERT INTO tracker (job_id, status, status_at, applied_at) VALUES (?, 'applied', ?, ?)",
        )
        .run(id, now, now);
    store.notify({
      cause: "tracker",
      stages: ["applied"],
      ids,
      searchId: null,
    });
  });
}

/**
 * Jobs approved with their original resume (no tailored PDF: the imported
 * file), as Apply requires. Synthetic preconditions for tests and the
 * isolated desktop test API.
 */
export function approveOriginalResumesForTests(store: JobStore, ids: number[]) {
  // These are fresh approvals, made after the one-time retired-facts guard.
  createProfileStore(store);
  store.transaction(() => {
    const now = Date.now();
    for (const id of ids)
      store
        .sql(
          `INSERT INTO resumes (job_id, level, state, updated_at, approved_at, pdf_path)
           VALUES (?, 'original', 'ready', ?, ?, NULL)
           ON CONFLICT(job_id) DO UPDATE SET approved_at = excluded.approved_at`,
        )
        .run(id, now, now);
    store.setStage(ids, "resume");
  });
}
