import type { JobStore } from "./job-store";

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
