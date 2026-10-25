import type { JobListQueryInput, JobRow } from "@nestor/contracts";

import { useStoreList } from "./use-store-list";

export type JobListFilter = Omit<JobListQueryInput, "cursor" | "limit">;

/** Jobs of one stage from `list_jobs`, kept current. */
export function useJobList(filter: JobListFilter) {
  return useStoreList<JobRow>({
    key: JSON.stringify(filter),
    load: ({ cursor, limit }) =>
      window.nestor.jobs.run("list_jobs", { ...filter, cursor, limit }),
  });
}
