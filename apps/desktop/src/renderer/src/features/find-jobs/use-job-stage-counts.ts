import type { JobStageCounts } from "@nestor/contracts";
import { useEffect, useState } from "react";

/** How many jobs are in each stage, kept current; null until the first read. */
export function useJobStageCounts(): JobStageCounts | null {
  const [counts, setCounts] = useState<JobStageCounts | null>(null);
  useEffect(() => {
    const jobs = window.nestor?.jobs;
    if (!jobs) return undefined;
    let live = true;
    const read = () =>
      void jobs
        .run("stage_counts", {})
        .then((next) => {
          if (live) setCounts(next);
        })
        .catch(() => undefined);
    read();
    const unsubscribe = jobs.onChange(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return counts;
}
